/**
 * The helpdesk screens through the real session → viewer → permission
 * chain: who may open which page (employee, agent, scoped category head,
 * settings admin), that every page renders, that every helpdesk link points
 * at a page that exists, and a ticket's life through the actions the pages
 * call — raise, reply, note, update, follow, bulk close, rate, reopen — plus
 * create / edit / delete on each settings tab.
 *
 * Everything it creates it removes, so it can run against the seeded
 * database as often as you like.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const APP = path.resolve(__dirname, "../apps/web/src/app/(app)");

type Outcome = { kind: "ok"; html: string } | { kind: "denied" } | { kind: "notfound" } | { kind: "redirect"; to: string };

async function main() {
  // tsx compiles JSX in classic mode; pages expect React in scope.
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {}, hmrRefresh() {} };
  const hd = await import("../apps/web/src/app/actions/helpdesk");
  const { getViewer, can } = await import("../apps/web/src/lib/context");
  const { PERMISSIONS } = await import("@keka/rbac");

  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as (props: unknown) => Promise<unknown>;
  const pages = {
    summary: await load("helpdesk"),
    tickets: await load("helpdesk/tickets"),
    ticket: await load("helpdesk/tickets/[id]"),
    legacy: await load("helpdesk/[id]"),
    reports: await load("helpdesk/reports"),
    settings: await load("helpdesk/settings"),
    categories: await load("helpdesk/settings/categories"),
    hours: await load("helpdesk/settings/business-hours"),
    canned: await load("helpdesk/settings/canned-responses"),
    reasons: await load("helpdesk/settings/closing-reasons"),
    mine: await load("me/helpdesk"),
    myTicket: await load("me/helpdesk/[id]"),
  };

  /** Render a page the way the app router would, with its router, path and query in context. */
  const hrefs = new Set<string>();
  async function open(page: keyof typeof pages, url: string, params: Record<string, string> = {}): Promise<Outcome> {
    const u = new URL(url, "http://acme.test");
    const sp: Record<string, string | string[]> = {};
    for (const k of new Set(u.searchParams.keys())) { const all = u.searchParams.getAll(k); sp[k] = all.length > 1 ? all : all[0]; }
    try {
      const node = await pages[page]({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) });
      const html = renderToStaticMarkup(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: u.pathname },
            React.createElement(SearchParamsContext.Provider, { value: u.searchParams as never }, node as never))));
      for (const m of html.matchAll(/href="([^"]+)"/g)) hrefs.add(m[1].replace(/&amp;/g, "&"));
      return { kind: "ok", html };
    } catch (err) {
      const e = err as { digest?: string; message?: string };
      const d = `${e.digest ?? ""} ${e.message ?? ""}`;
      if (/HTTP_ERROR_FALLBACK;403/.test(d)) return { kind: "denied" };
      if (/HTTP_ERROR_FALLBACK;404/.test(d)) return { kind: "notfound" };
      if (/NEXT_REDIRECT/.test(d)) return { kind: "redirect", to: (e.digest ?? "").split(";")[2] ?? "" };
      throw err;
    }
  }
  const ok = (o: Outcome) => o.kind === "ok";
  const has = (o: Outcome, text: string) => o.kind === "ok" && o.html.includes(text);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } }, include: { reportingManager: { include: { user: true } } } });
  const payroll = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Payroll & salary", parentId: null } });
  const payslip = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Payslip queries", parentId: payroll.id } });
  const taxCat = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Tax & TDS", parentId: payroll.id } });
  const reason = await prisma.helpdeskClosingReason.findFirstOrThrow({ where: { tenantId: tenant.id, isActive: true, name: "Resolved" } });

  const created = { tickets: [] as string[], reasons: [] as string[], canned: [] as string[], hours: [] as string[], categories: [] as string[] };
  console.log("\nHelpdesk pages\n" + "=".repeat(72));

  try {
    // -----------------------------------------------------------------
    section("Employee");
    await signInAs("meera.krishnan@acme.test");
    const noCategory = await hd.raiseTicketAction({}, fd({ subject: "Smoke helpdesk ticket", description: "Payslip line looks wrong" }));
    check("Raising needs a category", noCategory.ok === false && !!noCategory.errors?.categoryId, noCategory.message);
    const parentOnly = await hd.raiseTicketAction({}, fd({ categoryId: payroll.id, subject: "Smoke helpdesk ticket", description: "Payslip line looks wrong" }));
    check("A category with subcategories asks for one", parentOnly.ok === false, parentOnly.message);
    const raised = await hd.raiseTicketAction({}, fd({ categoryId: payslip.id, subject: "Smoke helpdesk ticket", description: "My **September** payslip shows the wrong HRA." }));
    const ticketId = raised.values?.ticketId ?? "";
    if (ticketId) created.tickets.push(ticketId);
    const ticket = await prisma.helpdeskTicket.findUnique({ where: { id: ticketId } });
    check("An employee raises a ticket", raised.ok === true && !!ticket, raised.message);
    const n = `#${ticket?.number}`;

    const mine = await open("mine", "/me/helpdesk");
    check("Me › Helpdesk lists the new ticket", has(mine, "Smoke helpdesk ticket") && has(mine, "+ New Ticket"));
    check("…with Open and Closed segments", has(mine, "Open Tickets") && has(mine, "Closed Tickets"));
    check("Searching My Tickets narrows the list", has(await open("mine", `/me/helpdesk?q=${encodeURIComponent(n)}`), "Smoke helpdesk ticket") && !has(await open("mine", "/me/helpdesk?q=zz-no-such-ticket"), "Smoke helpdesk ticket"));
    check("The employee's /helpdesk shows My Tickets, not the agent summary", has(await open("summary", "/helpdesk"), "My Tickets") && !has(await open("summary", "/helpdesk"), "Analysis"));
    const own = await open("myTicket", `/me/helpdesk/${ticketId}?raised=1`, { id: ticketId });
    check("The employee's ticket page renders the thread (markdown, not raw)", has(own, "added successfully") && has(own, "<strong>September</strong>"));
    check("The legacy /helpdesk/<id> link sends the raiser to their view", (await open("legacy", `/helpdesk/${ticketId}`, { id: ticketId })).kind === "redirect");
    check("Opening the agent view of one's own ticket redirects to one's own view", (await open("ticket", `/helpdesk/tickets/${ticketId}`, { id: ticketId })).kind === "redirect");
    check("An employee cannot open the ticket queue", (await open("tickets", "/helpdesk/tickets")).kind === "denied");
    check("…or the reports", (await open("reports", "/helpdesk/reports")).kind === "denied");
    for (const p of ["categories", "hours", "canned", "reasons", "settings"] as const) {
      check(`…or settings (${p})`, (await open(p, `/helpdesk/settings/${p}`)).kind === "denied");
    }
    const other = await prisma.helpdeskTicket.findFirst({ where: { tenantId: tenant.id, employeeId: { not: meera.id }, followers: { none: { userId: meera.userId! } } } });
    check("…or someone else's ticket", !!other && (await open("myTicket", `/me/helpdesk/${other!.id}`, { id: other!.id })).kind === "notfound");
    const sneaky = await hd.addNoteAction({}, fd({ ticketId, body: "I am not an agent" }));
    check("An employee cannot add an internal note, even on their own ticket", sneaky.ok === false, sneaky.message);
    check("…nor use settings actions", await (async () => { try { await hd.saveClosingReasonAction({}, fd({ name: "Smoke nope" })); return false; } catch { return true; } })());

    // -----------------------------------------------------------------
    section("Agent (HELPDESK_MANAGE)");
    await signInAs("priya.sharma@acme.test");
    const priya = (await getViewer())!;
    check("Priya manages tickets but not settings", can(priya, PERMISSIONS.HELPDESK_MANAGE) && !can(priya, PERMISSIONS.HELPDESK_SETTINGS));
    const summary = await open("summary", "/helpdesk");
    check("The Summary renders with the Helpdesk tabs", has(summary, "Analysis") && has(summary, 'href="/helpdesk/tickets"') && has(summary, 'href="/helpdesk/reports"'));
    check("…and no Settings tab without the permission", !has(summary, 'href="/helpdesk/settings/categories"'));
    check("The Summary accepts a period", ok(await open("summary", "/helpdesk?period=7d")) && ok(await open("summary", "/helpdesk?period=1y")));
    const queue = await open("tickets", "/helpdesk/tickets");
    check("The queue lists the new ticket and links to the agent view", has(queue, n) && has(queue, `/helpdesk/tickets/${ticketId}`));
    check("Search by number finds it", has(await open("tickets", `/helpdesk/tickets?q=${encodeURIComponent(n)}`), "Smoke helpdesk ticket"));
    check("A priority filter that excludes it hides it", !has(await open("tickets", `/helpdesk/tickets?priority=HIGH&q=${encodeURIComponent(n)}`), "Smoke helpdesk ticket"));
    check("Category, status, assignee and escalation filters render", ok(await open("tickets", `/helpdesk/tickets?cat=${payroll.id}&status=OPEN&status=IN_PROGRESS&assignee=none&esc=RESOLUTION&overdue=1`)));
    check("The category filter includes subcategories", has(await open("tickets", `/helpdesk/tickets?cat=${payroll.id}&q=${encodeURIComponent(n)}`), "Smoke helpdesk ticket"));
    check("The Closed segment renders", has(await open("tickets", "/helpdesk/tickets?tab=closed"), "Closed Tickets"));
    const detail = await open("ticket", `/helpdesk/tickets/${ticketId}`, { id: ticketId });
    check("The agent ticket page renders details, followers and notes", has(detail, "Ticket details") && has(detail, "Followers") && has(detail, "Notes"));
    check("…with canned responses in the reply box", has(detail, "Templates") && has(detail, "Please respond by"));
    check("The legacy /helpdesk/<id> link sends an agent to the agent view", (await open("legacy", `/helpdesk/${ticketId}`, { id: ticketId })).kind === "redirect");
    check("Reports render", has(await open("reports", "/helpdesk/reports"), "First response SLA met"));
    check("…with a custom range, a category and a detailed report", has(await open("reports", `/helpdesk/reports?range=custom&from=2026-01-01&to=2026-12-31&cat=${payroll.id}&report=by-category`), "Ticket Aggregates by Category"));
    for (const r of ["all-tickets", "avg-first-response", "avg-resolution", "closed-tickets", "monthly-trends", "on-hold-by-category", "by-assignee"]) {
      if (!ok(await open("reports", `/helpdesk/reports?range=1y&report=${r}`))) check(`Detailed report ${r} renders`, false);
    }
    check("Settings stay closed to an agent without HELPDESK_SETTINGS", (await open("categories", "/helpdesk/settings/categories")).kind === "denied");

    const reply = await hd.replyTicketAction({}, fd({ ticketId, body: "Thanks — checking with payroll.", then: "" }));
    const afterReply = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    check("An agent reply records the first response and moves the ticket to In Progress", reply.ok === true && !!afterReply.firstResponseAt && afterReply.status === "IN_PROGRESS", reply.message);
    const note = await hd.addNoteAction({}, fd({ ticketId, body: "Smoke internal note: HRA master is stale" }));
    check("An agent adds an internal note", note.ok === true, note.message);
    const upd = await hd.updateTicketAction({}, fd({ ticketId, priority: "HIGH", status: "IN_PROGRESS", categoryId: taxCat.id, assigneeUserId: priya.user.id }));
    const afterUpd = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    check("Update changes priority, category and assignee together", upd.ok === true && afterUpd.priority === "HIGH" && afterUpd.categoryId === taxCat.id && afterUpd.assigneeUserId === priya.user.id, upd.message);
    const noReason = await hd.updateTicketAction({}, fd({ ticketId, status: "CLOSED" }));
    check("Closing from the details panel asks for a closing reason", noReason.ok === false && /reason/i.test(noReason.message ?? ""), noReason.message);

    const managerUser = meera.reportingManager?.user;
    const follow = await hd.addFollowerAction({}, fd({ ticketId, role: "REPORTING_MANAGER" }));
    const follower = await prisma.helpdeskTicketFollower.findFirst({ where: { ticketId } });
    check("A follower can be added by role (reporting manager)", follow.ok === true && !!follower && follower.userId === managerUser?.id, follow.message);
    const detail2 = await open("ticket", `/helpdesk/tickets/${ticketId}`, { id: ticketId });
    check("The agent view shows the note, the follower and the new category", has(detail2, "Smoke internal note") && has(detail2, meera.reportingManager?.displayName ?? "§") && has(detail2, "Tax &amp; TDS"));

    // -----------------------------------------------------------------
    section("Follower and raiser views");
    if (managerUser) {
      await signInAs(managerUser.email);
      const mgr = (await getViewer())!;
      const mgrIsAgent = can(mgr, PERMISSIONS.HELPDESK_MANAGE);
      const view = await open("myTicket", `/me/helpdesk/${ticketId}`, { id: ticketId });
      if (mgrIsAgent) check("A follower who is also an agent is sent to the agent view", view.kind === "redirect");
      else {
        check("The follower reads the ticket", has(view, "Smoke helpdesk ticket") && has(view, "You are following this ticket"));
        check("…without internal notes", !has(view, "Smoke internal note"));
        check("…and it is listed under Following", has(await open("mine", "/me/helpdesk?tab=following"), "Smoke helpdesk ticket"));
        const fReply = await hd.replyTicketAction({}, fd({ ticketId, body: "Following up", then: "" }));
        check("A follower cannot reply", fReply.ok === false, fReply.message);
      }
    }
    await signInAs("meera.krishnan@acme.test");
    const ownAfter = await open("myTicket", `/me/helpdesk/${ticketId}`, { id: ticketId });
    check("The raiser sees the agent's reply and the history lines, never the note", has(ownAfter, "checking with payroll") && has(ownAfter, "Priority changed to High") && !has(ownAfter, "Smoke internal note"));
    const empReply = await hd.replyTicketAction({}, fd({ ticketId, body: "Thank you", then: "CLOSED" }));
    const afterEmp = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    check("The raiser replies, and cannot close the ticket through the agent's send option", empReply.ok === true && afterEmp.status === "IN_PROGRESS", empReply.message);

    // -----------------------------------------------------------------
    section("Bulk actions, rating and reopening");
    await signInAs("priya.sharma@acme.test");
    const unfollow = await hd.removeFollowerAction({}, fd({ ticketId, followerId: follower?.id ?? "" }));
    check("A follower can be removed", unfollow.ok === true && (await prisma.helpdeskTicketFollower.count({ where: { ticketId } })) === 0, unfollow.message);
    const bulkNoReason = await hd.bulkTicketAction({}, (() => { const f = fd({ op: "close" }); f.append("ids", ticketId); return f; })());
    check("Bulk close asks for a closing reason", bulkNoReason.ok === false && /reason/i.test(bulkNoReason.message ?? ""), bulkNoReason.message);
    const bulkForeign = await hd.bulkTicketAction({}, (() => { const f = fd({ op: "close", closingReasonId: reason.id }); f.append("ids", ticketId); f.append("ids", "not-a-ticket"); return f; })());
    check("Bulk refuses ids outside the queue", bulkForeign.ok === false, bulkForeign.message);
    const bulk = await hd.bulkTicketAction({}, (() => { const f = fd({ op: "close", closingReasonId: reason.id }); f.append("ids", ticketId); return f; })());
    const closed = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } });
    check("Bulk close closes with the reason", bulk.ok === true && closed.status === "CLOSED" && closed.closingReasonId === reason.id, bulk.message);
    check("The closed ticket moves to the Closed segment", has(await open("tickets", `/helpdesk/tickets?tab=closed&q=${encodeURIComponent(n)}`), "Smoke helpdesk ticket"));
    check("The closed ticket's agent view offers no reply box", !has(await open("ticket", `/helpdesk/tickets/${ticketId}`, { id: ticketId }), "Templates"));

    await signInAs("meera.krishnan@acme.test");
    const closedView = await open("myTicket", `/me/helpdesk/${ticketId}`, { id: ticketId });
    check("The raiser sees the close, a reopen button and the rating", has(closedView, "Reopen ticket") && has(closedView, "How was the support?"));
    const rate = await hd.rateTicketAction({}, fd({ ticketId, rating: 5 }));
    check("The raiser rates the closed ticket", rate.ok === true && (await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } })).satisfaction === 5, rate.message);
    const reopen = await hd.reopenTicketAction({}, fd({ ticketId }));
    check("…and reopens it", reopen.ok === true && (await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: ticketId } })).status === "OPEN", reopen.message);

    // -----------------------------------------------------------------
    section("Scoped category head");
    const heads = [...new Set((await prisma.helpdeskCategory.findMany({ where: { tenantId: tenant.id, defaultAssigneeUserId: { not: null } }, select: { defaultAssigneeUserId: true } })).map((c) => c.defaultAssigneeUserId!))];
    let head: { email: string; userId: string } | null = null;
    for (const id of heads) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id } });
      if (u.loginDisabled || u.id === meera.userId) continue;
      await signInAs(u.email);
      const v = (await getViewer())!;
      if (!can(v, PERMISSIONS.HELPDESK_MANAGE) && !can(v, PERMISSIONS.HELPDESK_SETTINGS)) { head = { email: u.email, userId: u.id }; break; }
    }
    if (!head) check("A category head without HELPDESK_MANAGE exists in the seed", false);
    else {
      await signInAs(head.email);
      const scope = await prisma.helpdeskCategory.findMany({ where: { tenantId: tenant.id, OR: [{ defaultAssigneeUserId: head.userId }, { agents: { some: { userId: head.userId } } }] }, select: { id: true } });
      const scopeIds = new Set(scope.map((c) => c.id));
      const children = await prisma.helpdeskCategory.findMany({ where: { tenantId: tenant.id, parentId: { in: [...scopeIds] } }, select: { id: true } });
      for (const c of children) scopeIds.add(c.id);
      const outside = await prisma.helpdeskTicket.findFirst({ where: { tenantId: tenant.id, categoryId: { notIn: [...scopeIds] }, employee: { userId: { not: head.userId } } } });
      check("A category head opens the queue without HELPDESK_MANAGE", has(await open("tickets", "/helpdesk/tickets"), "Open Tickets"));
      check("…and the summary and reports", has(await open("summary", "/helpdesk"), "Analysis") && ok(await open("reports", "/helpdesk/reports")));
      check("…but not a ticket outside their categories", !!outside && (await open("ticket", `/helpdesk/tickets/${outside!.id}`, { id: outside!.id })).kind === "notfound");
      const outsideNote = outside ? await hd.addNoteAction({}, fd({ ticketId: outside.id, body: "Smoke out of scope" })) : { ok: true };
      check("…nor act on it", outsideNote.ok === false);
      check("…nor open settings", (await open("categories", "/helpdesk/settings/categories")).kind === "denied");
    }

    // -----------------------------------------------------------------
    section("Settings (admin)");
    await signInAs("vikram.menon@acme.test");
    const admin = await open("summary", "/helpdesk");
    check("An admin sees the Settings tab", has(admin, 'href="/helpdesk/settings/categories"'));
    check("/helpdesk/settings opens the first tab", (await open("settings", "/helpdesk/settings")).kind === "redirect");
    for (const [p, text] of [["categories", "Payroll &amp; salary"], ["hours", "Default 24x7"], ["canned", "Canned Responses"], ["reasons", "Duplicate ticket"]] as const) {
      check(`The ${p} tab renders`, has(await open(p, `/helpdesk/settings/${p}`), text));
    }

    // Closing reasons
    const r1 = await hd.saveClosingReasonAction({}, fd({ name: "Smoke reason", description: "From the smoke test" }));
    const rRow = await prisma.helpdeskClosingReason.findFirst({ where: { tenantId: tenant.id, name: "Smoke reason" } });
    if (rRow) created.reasons.push(rRow.id);
    check("Add a closing reason", r1.ok === true && !!rRow, r1.message);
    check("…it appears on the tab", has(await open("reasons", "/helpdesk/settings/closing-reasons"), "Smoke reason"));
    check("Duplicate names are refused", (await hd.saveClosingReasonAction({}, fd({ name: "Smoke reason" }))).ok === false);
    const rEdit = await hd.saveClosingReasonAction({}, fd({ id: rRow?.id, name: "Smoke reason (edited)" }));
    const rOff = await hd.setClosingReasonActiveAction({}, fd({ id: rRow?.id, active: "false" }));
    const rDel = await hd.deleteClosingReasonAction({}, fd({ id: rRow?.id }));
    check("Edit, deactivate and delete it", rEdit.ok && rOff.ok && rDel.ok && !(await prisma.helpdeskClosingReason.findUnique({ where: { id: rRow?.id ?? "" } })), `${rEdit.message} / ${rOff.message} / ${rDel.message}`);
    check("A reason used on tickets cannot be deleted", (await hd.deleteClosingReasonAction({}, fd({ id: reason.id }))).ok === false);

    // Canned responses
    const c1 = await hd.saveCannedResponseAction({}, fd({ title: "Smoke canned", body: "Hi, we are on it." }));
    const cRow = await prisma.helpdeskCannedResponse.findFirst({ where: { tenantId: tenant.id, title: "Smoke canned" } });
    if (cRow) created.canned.push(cRow.id);
    check("Add a canned response", c1.ok === true && !!cRow, c1.message);
    check("…it appears on the tab", has(await open("canned", "/helpdesk/settings/canned-responses"), "Smoke canned"));
    const { loadTicket } = await import("../apps/web/src/app/(app)/helpdesk/_ui/ticket-data");
    check("…and among the Templates an agent can insert", !!(await loadTicket((await getViewer())!, ticketId, true)).agentData?.canned.some((c) => c.title === "Smoke canned"));
    const cEdit = await hd.saveCannedResponseAction({}, fd({ id: cRow?.id, title: "Smoke canned", body: "Hi, sorted now." }));
    const cDel = await hd.deleteCannedResponseAction({}, fd({ id: cRow?.id }));
    check("Edit and delete it", cEdit.ok && cDel.ok && !(await prisma.helpdeskCannedResponse.findUnique({ where: { id: cRow?.id ?? "" } })), `${cEdit.message} / ${cDel.message}`);

    // Business hours
    const badHours = await hd.saveBusinessHoursAction({}, fd({ name: "Smoke hours", timezone: "Asia/Kolkata", day_1: true, from_1: "18:00", to_1: "09:00" }));
    check("Business hours need a start before the end", badHours.ok === false, badHours.message);
    const h1 = await hd.saveBusinessHoursAction({}, fd({ name: "Smoke hours", timezone: "Asia/Kolkata", observeHolidays: true, day_1: true, from_1: "09:00", to_1: "18:00", day_2: true, from_2: "09:00", to_2: "18:00" }));
    const hId = h1.values?.id ?? "";
    if (hId) created.hours.push(hId);
    check("Add business hours", h1.ok === true && !!hId, h1.message);
    check("…the tab shows them selected", has(await open("hours", `/helpdesk/settings/business-hours?id=${hId}`), "Mon 09:00–18:00"));
    check("…and the New form renders", has(await open("hours", "/helpdesk/settings/business-hours?id=new"), "New business hours"));
    const dup = await hd.duplicateBusinessHoursAction({}, fd({ id: hId }));
    if (dup.values?.id) created.hours.push(dup.values.id);
    check("Duplicate them", dup.ok === true && !!dup.values?.id, dup.message);
    const defaults = await prisma.helpdeskBusinessHours.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } });
    check("The default hours cannot be deleted", (await hd.deleteBusinessHoursAction({}, fd({ id: defaults.id }))).ok === false);

    // Categories
    const catBad = await hd.saveCategoryAction({}, fd({ name: "Smoke category", slaHours: 24, firstResponseHours: 48 }));
    check("A first-response target beyond the resolution target is refused", catBad.ok === false && !!catBad.errors?.firstResponseHours, catBad.message);
    const catForm = fd({
      name: "Smoke category", description: "Created by the smoke test", audienceType: "ALL", businessHoursId: hId, firstResponseHours: 4, slaHours: 24,
      assignMode: "HEAD", defaultAssigneeUserId: priya.user.id, enableOnHold: true, split: "yes", sub_0_name: "Smoke sub A", sub_1_name: "Smoke sub B",
    });
    catForm.append("agentUserIds", priya.user.id);
    const cat = await hd.saveCategoryAction({}, catForm);
    const catId = cat.values?.id ?? "";
    if (catId) created.categories.push(catId);
    const subs = await prisma.helpdeskCategory.findMany({ where: { parentId: catId } });
    check("Add a category with two subcategories and an agent", cat.ok === true && subs.length === 2 && (await prisma.helpdeskCategoryAgent.count({ where: { categoryId: catId } })) === 1, cat.message);
    check("…it appears on the tab", has(await open("categories", "/helpdesk/settings/categories"), "Smoke category"));
    check("…and its hours list it under Used in", has(await open("hours", `/helpdesk/settings/business-hours?id=${hId}`), "Smoke category"));
    check("Hours in use cannot be deleted", (await hd.deleteBusinessHoursAction({}, fd({ id: hId }))).ok === false);
    const subA = subs.find((x) => x.name === "Smoke sub A")!;
    const edit = await hd.saveCategoryAction({}, fd({ id: catId, name: "Smoke category", audienceType: "ALL", firstResponseHours: 4, slaHours: 24, assignMode: "HEAD", split: "yes", sub_0_id: subA.id, sub_0_name: "Smoke sub A" }));
    check("Editing can drop a subcategory", edit.ok === true && (await prisma.helpdeskCategory.count({ where: { parentId: catId } })) === 1, edit.message);
    const off = await hd.setCategoryActiveAction({}, fd({ id: catId, active: "false" }));
    check("Deactivate a category (and its subcategories)", off.ok === true && (await prisma.helpdeskCategory.count({ where: { OR: [{ id: catId }, { parentId: catId }], isActive: true } })) === 0, off.message);
    const del = await hd.deleteCategoryAction({}, fd({ id: catId }));
    check("Delete an unused category", del.ok === true && !(await prisma.helpdeskCategory.findUnique({ where: { id: catId } })), del.message);
    check("A category with tickets cannot be deleted", (await hd.deleteCategoryAction({}, fd({ id: payroll.id }))).ok === false);
    for (const id of [...created.hours].reverse()) {
      const r = await hd.deleteBusinessHoursAction({}, fd({ id }));
      if (!r.ok) check(`Delete business hours ${id}`, false, r.message);
    }
    check("Delete unused business hours", (await prisma.helpdeskBusinessHours.count({ where: { id: { in: created.hours } } })) === 0);

    // -----------------------------------------------------------------
    section("Links");
    const routes: RegExp[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
        else if (e.name === "page.tsx" || e.name === "route.ts") routes.push(new RegExp(`^${rel.replace(/\[[^\]]+\]/g, "[^/]+")}/?$`));
      }
    };
    walk(path.join(APP, "helpdesk"), "/helpdesk");
    walk(path.join(APP, "me/helpdesk"), "/me/helpdesk");
    const exists = (href: string) => routes.some((r) => r.test(href.split(/[?#]/)[0]));
    const rendered = [...hrefs].filter((h) => /^\/(me\/)?helpdesk/.test(h));
    const broken = rendered.filter((h) => !exists(h));
    check(`Every helpdesk link on the rendered pages exists (${rendered.length} checked)`, broken.length === 0, broken.slice(0, 5).join(", "));
    // Links written in source: hrefs, notification links, redirects.
    const sources: string[] = [];
    const collect = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") collect(p); } else if (/\.(tsx?|ts)$/.test(e.name)) sources.push(p);
      }
    };
    collect(path.resolve(__dirname, "../apps/web/src"));
    collect(path.resolve(__dirname, "../packages/services/src"));
    const missing = new Set<string>();
    for (const f of sources) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/["'`](\/(?:me\/)?helpdesk(?:\/[^"'`?#\s]*)?)/g)) {
        const href = m[1].replace(/\$\{[^}]+\}/g, "x");
        if (!exists(href)) missing.add(`${href} (${path.relative(path.resolve(__dirname, ".."), f)})`);
      }
    }
    check("Every helpdesk path written in the code has a page", missing.size === 0, [...missing].slice(0, 5).join(", "));
  } finally {
    if (created.tickets.length) {
      await prisma.notification.deleteMany({ where: { OR: created.tickets.flatMap((id) => [{ link: `/helpdesk/tickets/${id}` }, { link: `/me/helpdesk/${id}` }]) } });
      await prisma.helpdeskTicket.deleteMany({ where: { id: { in: created.tickets } } });
    }
    await prisma.helpdeskClosingReason.deleteMany({ where: { id: { in: created.reasons } } });
    await prisma.helpdeskCannedResponse.deleteMany({ where: { id: { in: created.canned } } });
    await prisma.helpdeskCategory.deleteMany({ where: { OR: [{ id: { in: created.categories } }, { parentId: { in: created.categories } }] } });
    await prisma.helpdeskBusinessHours.deleteMany({ where: { id: { in: created.hours } } });
    await prisma.$disconnect();
  }
  report("Helpdesk pages");
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => { console.error(err); process.exit(1); });
