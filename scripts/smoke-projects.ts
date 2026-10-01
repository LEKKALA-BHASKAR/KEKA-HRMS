/**
 * Projects, timesheets and billing through the actions, as the people who use
 * them: an admin sets a project up, its manager staffs it, an engineer logs
 * time, the manager sends it back and then approves it, and finance bills the
 * approved hours to the client with the right GST and records the payment.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { purgeLedgerSince } from "./_ledger";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function attempt<T extends { ok?: boolean; message?: string }>(fn: () => Promise<T>): Promise<T | { ok: false; message: string }> {
  try { return await fn(); } catch (e) { return { ok: false, message: String((e as { digest?: string }).digest ?? e) }; }
}

function sheet(week: string, rows: Array<{ projectId: string; taskId?: string; hours: number[]; note?: string }>, intent: "save" | "submit") {
  const f = new FormData();
  f.set("week", week); f.set("intent", intent);
  rows.forEach((r, i) => {
    f.set(`project_${i}`, r.projectId); f.set(`task_${i}`, r.taskId ?? ""); f.set(`note_${i}`, r.note ?? "");
    r.hours.forEach((h, k) => f.set(`h_${i}_${k}`, h ? String(h) : ""));
  });
  return f;
}

async function main() {
  const a = await import("../apps/web/src/app/actions/projects");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const [sneha, rahul, meera] = await Promise.all([emp("ACM0005"), emp("ACM0015"), emp("ACM0009")]);
  const northwind = await prisma.client.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Northwind Retail" } });
  const pos = await prisma.project.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Northwind POS Modernisation" }, include: { tasks: true } });
  const thisWeek = svc.weekStart(new Date());
  const week = iso(new Date(thisWeek.getTime() - 14 * DAY));
  const started = new Date();

  // Leftovers from an interrupted run.
  const stale = await prisma.project.findMany({ where: { tenantId: tenant.id, name: "Smoke project" }, select: { id: true } });
  await prisma.invoice.deleteMany({ where: { projectId: { in: stale.map((s) => s.id) } } });
  await prisma.project.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  await prisma.timesheet.deleteMany({ where: { employeeId: rahul.id } });

  console.log("\nProjects & time\n" + "=".repeat(72));
  let projectId = "";
  try {
    section("Setting up a project");
    await signInAs("vikram.menon@acme.test");
    const base = { name: "Smoke project", billingModel: "TIME_AND_MATERIAL", status: "ACTIVE", startDate: iso(new Date(Date.now() - 60 * DAY)), projectManagerId: sneha.id };
    const noClient = await a.saveProjectAction({}, fd(base));
    check("A billable project needs a client", noClient.ok === false && /client/.test(noClient.message ?? ""), noClient.message);
    const noFee = await a.saveProjectAction({}, fd({ ...base, billingModel: "RETAINER", clientId: northwind.id }));
    check("A retainer needs its fee", noFee.ok === false && /fee/.test(noFee.message ?? ""), noFee.message);
    const made = await a.saveProjectAction({}, fd({ ...base, clientId: northwind.id }));
    const project = await prisma.project.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke project" } });
    projectId = project.id;
    check("An admin creates a client project", made.ok === true, made.message);

    await signInAs("meera.krishnan@acme.test");
    const notPm = await a.allocateAction({}, fd({ projectId, employeeId: rahul.id, allocationPercent: 60, billRate: 2000, isBillable: "on", startDate: iso(new Date(Date.now() - 60 * DAY)) }));
    check("Someone who is not its manager cannot staff it", notPm.ok === false, notPm.message);

    await signInAs("sneha.reddy@acme.test");
    const noRate = await a.allocateAction({}, fd({ projectId, employeeId: rahul.id, allocationPercent: 60, isBillable: "on", startDate: iso(new Date(Date.now() - 60 * DAY)) }));
    check("A billable allocation needs a bill rate", noRate.ok === false && /rate/.test(noRate.message ?? ""), noRate.message);
    const over = await a.allocateAction({}, fd({ projectId, employeeId: meera.id, allocationPercent: 10, billRate: 2000, isBillable: "on", startDate: iso(new Date(Date.now() - 60 * DAY)) }));
    check("Nobody is planned past 100% across projects", over.ok === false && /110%/.test(over.message ?? ""), over.message);
    const staffed = await a.allocateAction({}, fd({ projectId, employeeId: rahul.id, billingRole: "Consultant", allocationPercent: 60, billRate: 2000, costRate: 800, isBillable: "on", startDate: iso(new Date(Date.now() - 60 * DAY)) }));
    check("The project manager staffs it, with rates", staffed.ok === true, staffed.message);
    const added = await a.createTaskAction({}, fd({ projectId, title: "Smoke task", assigneeId: rahul.id, estimatedHours: 50, isBillable: "on" }));
    const task = await prisma.task.findFirstOrThrow({ where: { projectId, title: "Smoke task" } });
    check("The project manager adds a task", added.ok === true, added.message);

    await signInAs("arjun.nair@acme.test"); // a line manager, but not on this project
    const lineMgr = await a.createTaskAction({}, fd({ projectId, title: "Smoke intruder task" }));
    check("Managing a team does not open someone else's project", lineMgr.ok === false, lineMgr.message);
    const moveOther = await a.taskStatusAction({}, fd({ taskId: task.id, status: "DONE" }));
    check("…nor move tasks of people outside their line", moveOther.ok === false, moveOther.message);

    section("Logging time");
    await signInAs("rahul.kapoor@acme.test");
    const notAllocated = await a.saveTimesheetAction({}, sheet(week, [{ projectId: pos.id, hours: [8, 0, 0, 0, 0, 0, 0] }], "save"));
    check("Time on a project you are not on is refused", notAllocated.ok === false && /not allocated/.test(notAllocated.message ?? ""), notAllocated.message);
    const otherTask = await a.saveTimesheetAction({}, sheet(week, [{ projectId, taskId: pos.tasks[0].id, hours: [8, 0, 0, 0, 0, 0, 0] }], "save"));
    check("A task from another project is refused", otherTask.ok === false && /task/.test(otherTask.message ?? ""), otherTask.message);
    const fraction = await a.saveTimesheetAction({}, sheet(week, [{ projectId, hours: [7.1, 0, 0, 0, 0, 0, 0] }], "save"));
    check("Hours are logged in quarter hours", fraction.ok === false && /quarter/.test(fraction.message ?? ""), fraction.message);
    const ahead = await a.saveTimesheetAction({}, sheet(iso(new Date(thisWeek.getTime() + 7 * DAY)), [{ projectId, hours: [8, 0, 0, 0, 0, 0, 0] }], "save"));
    check("Time cannot be logged ahead", ahead.ok === false && /yet/.test(ahead.message ?? ""), ahead.message);
    const draft = await a.saveTimesheetAction({}, sheet(week, [{ projectId, taskId: task.id, hours: [8, 8, 8, 8, 6, 0, 0], note: "Discovery" }], "save"));
    check("A draft week saves", draft.ok === true && /38 h saved \(38 billable\)/.test(draft.message ?? ""), draft.message);
    const sent = await a.saveTimesheetAction({}, sheet(week, [{ projectId, taskId: task.id, hours: [8, 8, 8, 8, 8, 0, 0], note: "Discovery" }], "submit"));
    const ts = await prisma.timesheet.findFirstOrThrow({ where: { employeeId: rahul.id, periodStart: new Date(`${week}T00:00:00Z`) }, include: { entries: true } });
    check("…and is submitted, replacing the draft entries", sent.ok === true && ts.status === "SUBMITTED" && ts.entries.length === 5 && Number(ts.totalHours) === 40, sent.message);
    check("Each entry carries the allocation's rates", ts.entries.every((e) => Number(e.billRate) === 2000 && Number(e.costRate) === 800 && e.isBillable));
    check("The task's logged hours follow", Number((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).loggedHours) === 40);
    const userOf = async (e: { userId: string | null }) => e.userId!;
    const told = async (e: { userId: string | null }) => (await prisma.notification.count({ where: { userId: await userOf(e), kind: "TIMESHEET", createdAt: { gte: started } } })) > 0;
    check("The project manager and the line manager both hear about it", (await told(sneha)) && (await told(await emp("ACM0001"))));
    const edit = await a.saveTimesheetAction({}, sheet(week, [{ projectId, hours: [1, 0, 0, 0, 0, 0, 0] }], "save"));
    check("A submitted week is locked", edit.ok === false && /submitted/.test(edit.message ?? ""), edit.message);
    const own = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "approve" }));
    check("Nobody approves their own time", own.ok === false, own.message);

    section("Approving time");
    await signInAs("kavya.bhat@acme.test"); // heads another department, manages another project
    const wrongPm = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "approve" }));
    check("Another project's manager cannot approve it", wrongPm.ok === false, wrongPm.message);
    await signInAs("sneha.reddy@acme.test");
    const noReason = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "reject" }));
    check("Sending back needs a reason", noReason.ok === false && /fix/.test(noReason.message ?? ""), noReason.message);
    const back = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "reject", reason: "Friday was a holiday" }));
    check("The project manager sends it back", back.ok === true && (await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id } })).status === "REJECTED", back.message);
    await signInAs("rahul.kapoor@acme.test");
    const fixed = await a.saveTimesheetAction({}, sheet(week, [{ projectId, taskId: task.id, hours: [8, 8, 8, 8, 0, 0, 0] }], "submit"));
    check("A sent-back week can be corrected and resubmitted", fixed.ok === true && /32 h submitted/.test(fixed.message ?? ""), fixed.message);
    await signInAs("sneha.reddy@acme.test");
    const approved = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "approve" }));
    check("…and approved by the project manager", approved.ok === true && (await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id } })).status === "APPROVED", approved.message);
    const again = await a.decideTimesheetAction({}, fd({ timesheetId: ts.id, decision: "approve" }));
    check("An approved week cannot be decided twice", again.ok === false, again.message);

    section("Billing the client");
    await signInAs("meera.krishnan@acme.test");
    const noRight = await attempt(() => a.invoiceAction({}, fd({ op: "draft", projectId, from: week, to: iso(new Date(new Date(`${week}T00:00:00Z`).getTime() + 6 * DAY)) })));
    check("Only finance can raise invoices", noRight.ok === false, noRight.message);
    await signInAs("vikram.menon@acme.test");
    const to = iso(new Date(new Date(`${week}T00:00:00Z`).getTime() + 6 * DAY));
    const drafted = await a.invoiceAction({}, fd({ op: "draft", projectId, from: week, to }));
    const inv = await prisma.invoice.findFirstOrThrow({ where: { projectId }, include: { lines: true } });
    check("Approved billable hours become an invoice: 32 h × ₹2,000", drafted.ok === true && Number(inv.subtotal) === 64000 && inv.lines.length === 1 && Number(inv.lines[0].quantity) === 32, drafted.message);
    check("Same-state client: CGST 9% + SGST 9%", Number(inv.taxTotal) === 11520 && Number(inv.total) === 75520 && /CGST/.test(inv.notes ?? ""), inv.notes ?? "");
    check("The hours are marked invoiced", (await prisma.timeEntry.count({ where: { projectId, isInvoiced: true, invoiceId: inv.id } })) === 4);
    const twice = await a.invoiceAction({}, fd({ op: "draft", projectId, from: week, to }));
    check("The same hours are never billed twice", twice.ok === false && /Nothing to bill/.test(twice.message ?? ""), twice.message);
    const send = await a.invoiceAction({}, fd({ op: "send", invoiceId: inv.id }));
    const sentInv = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const file = sentInv.fileUrl ? await prisma.storedFile.findUnique({ where: { id: sentInv.fileUrl.replace("/files/", "") } }) : null;
    check("Sending files a PDF and emails the client", send.ok === true && sentInv.status === "SENT" && file?.mimeType === "application/pdf"
      && (await prisma.emailOutbox.count({ where: { relatedType: "Invoice", relatedId: inv.id, toAddress: northwind.contactEmail! } })) === 1, send.message);
    const posting = await prisma.ledgerEntry.findFirst({ where: { tenantId: tenant.id, sourceRefType: "Invoice", sourceRefId: inv.id }, include: { lines: { include: { account: true } } } });
    const leg = (code: string) => posting?.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0) ?? 0;
    check("…and books it: receivable, revenue and output GST", !!posting && leg("1200") === 75520 && leg("4100") === -64000 && leg("2300") === -5760 && leg("2310") === -5760, posting?.entryNumber);
    const tooMuch = await a.invoiceAction({}, fd({ op: "payment", invoiceId: inv.id, amount: 80000 }));
    check("A payment above what is due is refused", tooMuch.ok === false, tooMuch.message);
    const part = await a.invoiceAction({}, fd({ op: "payment", invoiceId: inv.id, amount: 50000, reference: "UTR 1" }));
    check("A part payment leaves the balance due", part.ok === true && Number((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).amountDue) === 25520, part.message);
    const rest = await a.invoiceAction({}, fd({ op: "payment", invoiceId: inv.id, amount: 25520, reference: "UTR 2" }));
    check("…and the rest settles it", rest.ok === true && (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status === "PAID", rest.message);
    const receipts = await prisma.ledgerEntry.count({ where: { tenantId: tenant.id, sourceRefType: "InvoicePayment", sourceRefId: { in: (await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } })).map((x) => x.id) } } });
    check("Each receipt is banked against the receivable", receipts === 2);

    section("Tasks, milestones and health");
    await signInAs("rahul.kapoor@acme.test");
    const mine = await a.taskStatusAction({}, fd({ taskId: task.id, status: "IN_PROGRESS" }));
    check("An assignee moves their own task", mine.ok === true, mine.message);
    await signInAs("meera.krishnan@acme.test");
    const notMine = await a.taskStatusAction({}, fd({ taskId: task.id, status: "DONE" }));
    check("…but not someone else's", notMine.ok === false, notMine.message);
    await signInAs("sneha.reddy@acme.test");
    await a.milestoneAction({}, fd({ projectId, op: "add", name: "Smoke milestone", dueDate: iso(new Date(Date.now() - 3 * DAY)) }));
    check("A missed milestone turns the project red", (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).health === "RED");
    const ms = await prisma.milestone.findFirstOrThrow({ where: { projectId } });
    await a.milestoneAction({}, fd({ projectId, op: "complete", milestoneId: ms.id }));
    check("Completing it clears the flag", (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).health === "GREEN");
  } finally {
    await purgeLedgerSince(prisma, tenant.id, started);
    await prisma.invoice.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.timesheet.deleteMany({ where: { employeeId: rahul.id } });
    await prisma.emailOutbox.deleteMany({ where: { relatedType: "Invoice", createdAt: { gte: started } } });
  }
  report("Projects & time");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
