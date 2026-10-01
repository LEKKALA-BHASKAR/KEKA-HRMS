/**
 * Exits, settlement, journeys, helpdesk and notifications through the server
 * actions, with the real session → viewer → permission chain.
 *
 * The full exit runs end to end on a real employee — resignation, approval,
 * checklist, settlement, finalisation, revoked access — and is then put back
 * exactly as it was, so the suite can run again.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayUtc = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;403|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}

async function main() {
  const a = await import("../apps/web/src/app/actions/lifecycle");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const ledgerFrom = new Date();
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n }, include: { user: true } });
  const meera = await emp("ACM0009");
  const pooja = await emp("ACM0016");

  // Snapshot what the full exit will touch, to restore it afterwards.
  const poojaAssets = await prisma.assetAssignment.findMany({ where: { employeeId: pooja.id, returnedOn: null } });
  const ticketsBefore = await prisma.helpdeskTicket.count({ where: { tenantId: tenant.id } });
  const createdTickets: string[] = [];
  const createdJourneys: string[] = [];

  console.log("\nLifecycle\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------
    section("Resigning");
    await signInAs("meera.krishnan@acme.test");
    const resign = await a.resignAction({}, fd({ reason: "Moving into research.", lastWorkingDay: iso(new Date(todayUtc().getTime() + 30 * DAY)) }));
    const mx = await prisma.exitRecord.findUnique({ where: { employeeId: meera.id } });
    check("An employee can resign", resign.ok === true && mx?.status === "PENDING_APPROVAL", resign.message);
    check("…recording the notice shortfall against the policy", Number(mx?.noticeBuyoutDays) === 30, `${mx?.noticeBuyoutDays} days short`);
    const again = await a.resignAction({}, fd({ reason: "Again" }));
    check("A second resignation is refused while one is open", again.ok === false, again.message);
    check("An employee cannot open the exits admin actions",
      await denied(() => a.decideExitAction({}, fd({ exitId: mx!.id, decision: "approve" }))));

    await signInAs("sneha.reddy@acme.test");
    check("A reporting manager cannot approve a resignation (HR decides)",
      await denied(() => a.decideExitAction({}, fd({ exitId: mx!.id, decision: "approve" }))));

    await signInAs("priya.sharma@acme.test");
    const early = await a.decideExitAction({}, fd({ exitId: mx!.id, decision: "approve", lastWorkingDay: iso(new Date(todayUtc().getTime() - 2 * DAY)) }));
    check("A last working day before the notice date is refused", early.ok === false, early.message);
    const ok = await a.decideExitAction({}, fd({ exitId: mx!.id, decision: "approve", lastWorkingDay: iso(new Date(todayUtc().getTime() + 45 * DAY)), note: "Agreed 45 days" }));
    const mAfter = await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } });
    const mJourney = await prisma.journey.findFirst({ where: { employeeId: meera.id, trigger: "EXIT", status: "ACTIVE" }, include: { tasks: true } });
    check("HR approves; the employee is on notice with a last working day", ok.ok === true && mAfter.status === "NOTICE_PERIOD" && !!mAfter.lastWorkingDay, ok.message);
    check("Approval starts the exit checklist", !!mJourney && mJourney.tasks.length >= 8, `${mJourney?.tasks.length} tasks`);
    check("The approval task closed itself", mJourney?.tasks.find((t) => t.autoCheck === "EXIT_APPROVED")?.status === "DONE");

    await signInAs("meera.krishnan@acme.test");
    const selfWithdraw = await a.withdrawExitAction({}, fd({ exitId: mx!.id }));
    check("Once accepted, the employee cannot withdraw alone", selfWithdraw.ok === false, selfWithdraw.message);
    await signInAs("priya.sharma@acme.test");
    const withdrawn = await a.withdrawExitAction({}, fd({ exitId: mx!.id }));
    const mBack = await prisma.employee.findUniqueOrThrow({ where: { id: meera.id } });
    const trueUps = await prisma.leaveLedgerEntry.count({ where: { employeeId: meera.id, periodKey: { startsWith: "EXIT-TRUEUP:" } } });
    check("HR can withdraw it: active again, checklist cancelled", withdrawn.ok === true && mBack.status === "CONFIRMED" && !mBack.lastWorkingDay
      && (await prisma.journey.findUnique({ where: { id: mJourney!.id } }))?.status === "CANCELLED", withdrawn.message);
    check("…and no exit accrual true-up is left behind", trueUps === 0, `${trueUps} entries`);

    // -----------------------------------------------------------------
    section("Full and final, end to end");
    const notice = new Date(todayUtc().getTime() - 50 * DAY);
    const lwd = new Date(todayUtc().getTime() - 3 * DAY);
    const init = await a.initiateExitAction({}, fd({ employeeId: pooja.id, type: "RESIGNATION", noticeDate: iso(notice), lastWorkingDay: iso(lwd), reason: "Smoke test exit" }));
    const px = await prisma.exitRecord.findUniqueOrThrow({ where: { employeeId: pooja.id } });
    check("HR records a resignation on someone's behalf", init.ok === true && px.status === "PENDING_APPROVAL", init.message);
    await a.decideExitAction({}, fd({ exitId: px.id, decision: "approve", lastWorkingDay: iso(lwd) }));

    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot draft a settlement",
      await denied(() => a.draftSettlementAction({}, fd({ employeeId: pooja.id }))));

    await signInAs("ramesh.iyer@acme.test");
    const draft = await a.draftSettlementAction({}, fd({ employeeId: pooja.id }));
    const s1 = await prisma.fnfSettlement.findUniqueOrThrow({ where: { employeeId: pooja.id } });
    const lines1 = (s1.breakdown as { lines: Array<{ label: string; amount: number; direction: string }> }).lines;
    const shortfall = lines1.find((l) => l.label === "Notice period shortfall");
    const preview = await svc.computeSettlement(pooja.id);
    const expected = Math.round((60 - 47) * (preview.monthlyGross / 30));
    check("Payroll drafts the settlement", draft.ok === true && s1.status === "IN_REVIEW", draft.message);
    check("The notice shortfall is 13 days of gross pay", !!shortfall && Math.abs(shortfall.amount - expected) <= 1, `${shortfall?.amount} vs ${expected}`);
    const totals = lines1.reduce((s, l) => s + (l.direction === "PAY" ? l.amount : -l.amount), 0);
    check("Net equals payable minus recovered, line by line", Math.abs(totals - Number(s1.netSettlement)) < 0.01, `${totals} vs ${s1.netSettlement}`);
    const encashment = lines1.find((l) => l.label.includes("Earned Leave"));
    const exitTrue = await prisma.leaveLedgerEntry.findMany({ where: { employeeId: pooja.id, periodKey: { startsWith: "EXIT-TRUEUP:" } } });
    check("Leave accrued after the last day was trued up before encashment", exitTrue.length > 0 && !!encashment, `${exitTrue.length} true-up(s)`);

    const waived = await a.draftSettlementAction({}, fd({ employeeId: pooja.id, waiveNoticeRecovery: true }));
    const s2 = await prisma.fnfSettlement.findUniqueOrThrow({ where: { employeeId: pooja.id } });
    check("Waiving the shortfall removes the recovery", waived.ok === true && !(s2.breakdown as { lines: Array<{ label: string }> }).lines.some((l) => l.label === "Notice period shortfall")
      && Number(s2.netSettlement) - Number(s1.netSettlement) - (shortfall?.amount ?? 0) < 1);

    const blocked = await a.finalizeSettlementAction({}, fd({ employeeId: pooja.id }));
    check("Finalising waits for the required exit tasks", blocked.ok === false && /exit task/i.test(blocked.message ?? ""), blocked.message);

    // Clear the checklist the way the people involved would.
    await signInAs("priya.sharma@acme.test");
    const pj = await prisma.journey.findFirstOrThrow({ where: { employeeId: pooja.id, trigger: "EXIT", status: "ACTIVE" }, include: { tasks: true } });
    const assetTask = pj.tasks.find((t) => t.autoCheck === "ASSETS_RETURNED");
    if (poojaAssets.length > 0 && assetTask) {
      const tooSoon = await a.setTaskAction({}, fd({ taskId: assetTask.id, status: "DONE" }));
      check("A system-verified task cannot be ticked before it is true", tooSoon.ok === false, tooSoon.message);
      await prisma.assetAssignment.updateMany({ where: { id: { in: poojaAssets.map((x) => x.id) } }, data: { returnedOn: lwd, conditionIn: "GOOD" } });
    }
    const manual = pj.tasks.filter((t) => !t.autoCheck && t.status === "PENDING");
    const noReason = manual.find((t) => t.isRequired);
    if (noReason) {
      const r = await a.setTaskAction({}, fd({ taskId: noReason.id, status: "SKIPPED" }));
      check("A required task cannot be skipped without a reason", r.ok === false, r.message);
    }
    for (const t of manual) await a.setTaskAction({}, fd({ taskId: t.id, status: "DONE" }));
    await a.recheckJourneyAction({}, fd({ journeyId: pj.id }));

    await signInAs("ramesh.iyer@acme.test");
    if (poojaAssets.length > 0) {
      // Returning the assets removed a recovery, so the draft is stale.
      const stale = await a.finalizeSettlementAction({}, fd({ employeeId: pooja.id }));
      check("Finalising refuses figures that changed since the draft", stale.ok === false && /changed since the draft/.test(stale.message ?? ""), stale.message);
      await a.draftSettlementAction({}, fd({ employeeId: pooja.id, waiveNoticeRecovery: true }));
    }
    const fin = await a.finalizeSettlementAction({}, fd({ employeeId: pooja.id }));
    const pAfter = await prisma.employee.findUniqueOrThrow({ where: { id: pooja.id }, include: { user: true } });
    const pJourney = await prisma.journey.findUniqueOrThrow({ where: { id: pj.id } });
    check("Payroll finalises the settlement", fin.ok === true, fin.message);
    const fnfEntry = await prisma.ledgerEntry.findFirst({ where: { tenantId: tenant.id, sourceRefType: "FnfSettlement", status: "POSTED", createdAt: { gte: ledgerFrom } } });
    check("…and pays it out of the bank in the books", !!fnfEntry && fnfEntry.isBalanced, fnfEntry?.entryNumber ?? fin.message);
    check("The employee is exited and their login disabled", pAfter.status === "EXITED" && pAfter.user?.loginDisabled === true);
    check("The settlement task closed itself and the journey completed", pJourney.status === "COMPLETED");
    const again2 = await a.draftSettlementAction({}, fd({ employeeId: pooja.id }));
    check("A finalised settlement cannot be redrafted", again2.ok === false, again2.message);

    await signInAs("pooja.malhotra@acme.test");
    check("A revoked login is refused on its very next request", await denied(() => a.raiseTicketAction({}, fd({ subject: "x" }))));

    // -----------------------------------------------------------------
    section("Journeys");
    await signInAs("priya.sharma@acme.test");
    const promoTarget = await emp("ACM0011");
    const start = await a.startJourneyAction({}, fd({ employeeId: promoTarget.id, trigger: "PROMOTION", anchorDate: iso(todayUtc()) }));
    const pjny = await prisma.journey.findFirst({ where: { employeeId: promoTarget.id, trigger: "PROMOTION", anchorDate: todayUtc() }, include: { tasks: true } });
    if (pjny) createdJourneys.push(pjny.id);
    check("HR starts a promotion journey from the template", start.ok === true && (pjny?.tasks.length ?? 0) >= 4, start.message);
    const dup = await a.startJourneyAction({}, fd({ employeeId: promoTarget.id, trigger: "PROMOTION", anchorDate: iso(todayUtc()) }));
    check("Starting it again opens the same journey", dup.ok === true && /already exists/.test(dup.message ?? ""));
    const managerTask = pjny?.tasks.find((t) => t.owner === "MANAGER");
    check("Manager tasks are assigned to the actual manager", managerTask?.assigneeEmployeeId === promoTarget.reportingManagerId);

    await signInAs("meera.krishnan@acme.test");
    const notMine = await a.setTaskAction({}, fd({ taskId: managerTask!.id, status: "DONE" }));
    check("Someone else's task cannot be ticked", notMine.ok === false, notMine.message);
    await signInAs("sneha.reddy@acme.test"); // ACM0011's manager
    const mine = await a.setTaskAction({}, fd({ taskId: managerTask!.id, status: "DONE" }));
    check("The assignee can complete their own task", mine.ok === true, mine.message);

    // -----------------------------------------------------------------
    section("Helpdesk");
    await signInAs("meera.krishnan@acme.test");
    // Categories with subcategories take tickets only at the leaf.
    const parentCat = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Payroll & salary", parentId: null } });
    const cat = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Payslip queries", parentId: parentCat.id } });
    const atParent = await a.raiseTicketAction({}, fd({ categoryId: parentCat.id, subject: "Smoke test ticket", description: "Testing the queue" }));
    check("A category with subcategories asks for a subcategory", atParent.ok === false && /subcategory/i.test(atParent.message ?? ""), atParent.message);
    const raised = await a.raiseTicketAction({}, fd({ categoryId: cat.id, subject: "Smoke test ticket", description: "Testing the queue", priority: "HIGH" }));
    const tk = await prisma.helpdeskTicket.findFirstOrThrow({ where: { tenantId: tenant.id, subject: "Smoke test ticket" }, orderBy: { createdAt: "desc" } });
    createdTickets.push(tk.id);
    const maxBefore = await prisma.helpdeskTicket.aggregate({ where: { tenantId: tenant.id, id: { not: tk.id } }, _max: { number: true } });
    check("An employee raises a ticket with the next number", raised.ok === true && tk.number === (maxBefore._max.number ?? 1000) + 1, raised.message);
    // Targets now come from the category (first response + resolution hours, in its business hours), not the priority.
    const due = await svc.helpdeskDueDates(tenant.id, cat.id, tk.createdAt);
    check("The ticket's targets follow its category's business-hours SLA",
      Math.abs(tk.dueAt.getTime() - due.dueAt.getTime()) < 1000 && Math.abs((tk.firstResponseDueAt?.getTime() ?? 0) - due.firstResponseDueAt.getTime()) < 1000,
      `due ${tk.dueAt.toISOString()}`);
    const selfInternal = await a.replyTicketAction({}, fd({ ticketId: tk.id, body: "Adding context", isInternal: true }));
    const c1 = await prisma.helpdeskComment.findFirst({ where: { ticketId: tk.id, isSystem: false }, orderBy: { createdAt: "desc" } });
    check("An employee's reply is never an internal note", selfInternal.ok === true && c1?.isInternal === false, selfInternal.message);

    await signInAs("sneha.reddy@acme.test");
    const nosy = await a.replyTicketAction({}, fd({ ticketId: tk.id, body: "Hi" }));
    check("A non-agent cannot see someone else's ticket", nosy.ok === false, nosy.message);

    await signInAs("priya.sharma@acme.test");
    await a.replyTicketAction({}, fd({ ticketId: tk.id, body: "Internal: checking with payroll", isInternal: true }));
    const t1 = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: tk.id } });
    check("An internal note does not count as a first response", t1.firstResponseAt === null && t1.status === "OPEN");
    await a.replyTicketAction({}, fd({ ticketId: tk.id, body: "Looking into it now." }));
    const t2 = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: tk.id } });
    check("An agent's public reply records the first response and picks it up", !!t2.firstResponseAt && t2.status === "IN_PROGRESS");
    const resolved = await a.ticketStatusAction({}, fd({ ticketId: tk.id, status: "RESOLVED" }));
    const t3 = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: tk.id }, include: { closingReason: true } });
    check("The agent resolves it (closed with the Resolved reason)", resolved.ok === true && t3.status === "CLOSED" && t3.closingReason?.name === "Resolved", resolved.message);

    await signInAs("meera.krishnan@acme.test");
    const notes = await prisma.notification.findMany({ where: { userId: meera.userId!, readAt: null, link: `/me/helpdesk/${tk.id}` } });
    check("The employee is notified of the reply and the resolution", notes.length >= 2, `${notes.length} notification(s)`);
    const holdAsEmp = await a.ticketStatusAction({}, fd({ ticketId: tk.id, status: "WAITING_ON_EMPLOYEE" }));
    check("An employee can only close or reopen, nothing else", holdAsEmp.ok === false, holdAsEmp.message);
    const reopen = await a.ticketStatusAction({}, fd({ ticketId: tk.id, status: "OPEN" }));
    const t4 = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: tk.id } });
    check("The employee can reopen a recently closed ticket", reopen.ok === true && t4.status === "OPEN" && t4.reopenCount === 1, reopen.message);
    const close = await a.ticketStatusAction({}, fd({ ticketId: tk.id, status: "CLOSED" }));
    const rate = await a.rateTicketAction({}, fd({ ticketId: tk.id, rating: 5 }));
    check("The employee closes and rates it", close.ok === true && rate.ok === true, `${close.message} / ${rate.message}`);
    const after = await a.replyTicketAction({}, fd({ ticketId: tk.id, body: "One more thing" }));
    check("A closed ticket takes no more replies", after.ok === false, after.message);
    await a.markNotificationsReadAction({}, fd({}));
    check("Marking read clears only this user's notifications",
      (await prisma.notification.count({ where: { userId: meera.userId!, readAt: null } })) === 0 &&
      (await prisma.notification.count({ where: { userId: { not: meera.userId! }, readAt: null } })) > 0);

    // -----------------------------------------------------------------
    section("Email outbox");
    const queued = await prisma.emailOutbox.count({ where: { status: "QUEUED" } });
    let calls = 0;
    const res = await svc.deliverOutbox({
      async send(m) { calls++; if (m.to.startsWith("pooja")) throw new Error("Mailbox disabled"); },
    }, { limit: 500 });
    const failed = await prisma.emailOutbox.findFirst({ where: { status: "FAILED", toAddress: { startsWith: "pooja" } } });
    check("Queued mail is delivered through the transport", queued > 0 && res.sent > 0 && calls === res.examined, `${res.sent} sent, ${res.failed} failed of ${queued}`);
    check("A failed send is kept with its error for retry, not lost", !failed || (failed.attempts >= 1 && failed.lastError === "Mailbox disabled"));
  } finally {
    // -----------------------------------------------------------------
    // Put everything back.
    await purgeLedgerSince(prisma, tenant.id, ledgerFrom);
    for (const id of [meera.id, pooja.id]) {
      await prisma.journey.deleteMany({ where: { employeeId: id, trigger: "EXIT" } });
      await prisma.fnfSettlement.deleteMany({ where: { employeeId: id } });
      await prisma.exitRecord.deleteMany({ where: { employeeId: id } });
    }
    await prisma.employee.update({ where: { id: pooja.id }, data: { status: pooja.status, lastWorkingDay: null, exitInitiatedAt: null } });
    await prisma.employee.update({ where: { id: meera.id }, data: { status: meera.status, lastWorkingDay: null, exitInitiatedAt: null } });
    if (pooja.userId) await prisma.user.update({ where: { id: pooja.userId }, data: { loginDisabled: false } });
    await prisma.assetAssignment.updateMany({ where: { id: { in: poojaAssets.map((x) => x.id) } }, data: { returnedOn: null, conditionIn: null } });
    for (const id of [meera.id, pooja.id]) await svc.trueUpExitAccrual(id);
    await prisma.journey.deleteMany({ where: { id: { in: createdJourneys } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, kind: { in: ["EXIT", "JOURNEY"] }, createdAt: { gte: ledgerFrom } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: ledgerFrom } } });
    await prisma.notification.deleteMany({ where: { OR: createdTickets.flatMap((id) => [{ link: `/helpdesk/tickets/${id}` }, { link: `/me/helpdesk/${id}` }]) } });
    await prisma.helpdeskTicket.deleteMany({ where: { id: { in: createdTickets } } });
    const ticketsAfter = await prisma.helpdeskTicket.count({ where: { tenantId: tenant.id } });
    if (ticketsAfter !== ticketsBefore) console.log(`  (warning: ${ticketsAfter - ticketsBefore} ticket(s) left behind)`);
  }
  report("Lifecycle");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
