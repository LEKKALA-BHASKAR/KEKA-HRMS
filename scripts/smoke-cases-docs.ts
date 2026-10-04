/**
 * Cases & documents depth, end to end through the real session → viewer →
 * permission chain and the generic workflow engine:
 *
 *   Helpdesk     knowledge base (draft → approval → published → search,
 *                feedback, suggestions), SLA by priority, triage, escalation
 *                rules and manual escalation with acknowledgement, case
 *                templates with task checklists, cases logged for employees,
 *                merge, split, approvals on a case, aging report and CSV.
 *   ER           anonymous intake with a tracking code, confidential access,
 *                investigation and findings sign-off, hearing, show-cause and
 *                warning through approval, employee response, appeal to an
 *                independent reviewer, resolution approval, closure with a
 *                retention date, suspension limits, CSV register.
 *   Documents    multi-signer e-sign envelopes in signing order, decline with
 *                reason, reminders, certificate PDF, void; bulk upload by
 *                employee number with versions; confidential folder access
 *                through approval; expiry notices.
 *   Letters      numbering series, bulk generation, resend, template approval,
 *                automatic triggers, search and CSV.
 *   Assets       return checklist gating recovery, repair and maintenance,
 *                shared pool bookings with overlap checks, stock thresholds
 *                and alerts, disposal through approval, stock-take.
 *
 * Every page the features add is rendered for the people who should (and
 * should not) see it. Everything created is removed afterwards.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

// CSS modules: answer `default` with a proxy of class names (see smoke-asset-pages).
{
  const internal = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = internal._load;
  const classes: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : k === "default" ? classes : typeof k === "string" ? k : undefined) });
  internal._load = function cssModules(this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request.endsWith(".module.css") ? classes : prev.call(this, request, parent, isMain);
  };
}

const prisma = new PrismaClient();
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;
type State = { ok?: boolean; message?: string; values?: Record<string, string> };

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A form with repeated keys and files, which the bootstrap helper does not build. */
function form(values: Record<string, string | string[] | File | File[] | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one as string | Blob);
  }
  return f;
}
const pdfFile = (name: string) => new File([PDF], name, { type: "application/pdf" });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const noop = () => {};
  const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };

  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!React.isValidElement(node)) return node;
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") props[k] = React.isValidElement(v) || Array.isArray(v) ? await resolve(v) : v;
    const children = el.props?.children;
    return Array.isArray(children) ? React.cloneElement(el, props, ...((await resolve(children)) as ReactNode[])) : React.cloneElement(el, props, (await resolve(children)) as ReactNode);
  }
  /** Render a page at a URL; returns its HTML, or "redirect:<to>" / "404" / "403". */
  async function render(page: Page, url: string, params: Record<string, string> = {}): Promise<string> {
    const u = new URL(url, "http://acme.test");
    const sp: SP = Object.fromEntries(u.searchParams.entries());
    try {
      const tree = (await resolve(await page({ searchParams: Promise.resolve(sp), params: Promise.resolve(params) }))) as ReactNode;
      return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: u.pathname },
          React.createElement(SearchParamsContext.Provider, { value: u.searchParams as never }, tree))));
    } catch (err) {
      const e = err as { digest?: string; message?: string };
      const d = `${e.digest ?? ""} ${e.message ?? ""}`;
      const r = /NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(d);
      if (r) return `redirect:${r[1]}`;
      if (/HTTP_ERROR_FALLBACK;404/.test(d)) return "404";
      if (/HTTP_ERROR_FALLBACK;403/.test(d)) return "403";
      throw err;
    }
  }
  const ok = (h: string) => !/^(redirect:|404$|403$)/.test(h);

  const HD = await import("../apps/web/src/app/actions/helpdesk-ops");
  const ER = await import("../apps/web/src/app/actions/relations");
  const DO = await import("../apps/web/src/app/actions/doc-ops");
  const LT = await import("../apps/web/src/app/actions/letters");
  const AO = await import("../apps/web/src/app/actions/asset-ops");
  const AS = await import("../apps/web/src/app/actions/assets");
  const WF = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("../packages/services/src/index");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = {
    knowledge: await load("helpdesk/knowledge"), article: await load("helpdesk/knowledge/[id]"), operations: await load("helpdesk/operations"),
    ticket: await load("helpdesk/tickets/[id]"), myKnowledge: await load("me/knowledge"), myArticle: await load("me/knowledge/[id]"),
    relations: await load("relations"), erCase: await load("relations/[id]"), myCases: await load("me/cases"), mySign: await load("me/sign"),
    esign: await load("documents/esign"), envelope: await load("documents/esign/[id]"), library: await load("documents/library"), lettersAdmin: await load("documents/letters-admin"),
    assetOps: await load("assets/operations"), stockTake: await load("assets/operations/reconciliation/[id]"), bookings: await load("me/assets/bookings"),
  };
  const routes = {
    aging: (await import("../apps/web/src/app/(app)/helpdesk/operations/export/route")).GET,
    erExport: (await import("../apps/web/src/app/(app)/relations/export/route")).GET,
    certificate: (await import("../apps/web/src/app/(app)/documents/esign/[id]/certificate/route")).GET,
    libraryExport: (await import("../apps/web/src/app/(app)/documents/library/export/route")).GET,
    lettersExport: (await import("../apps/web/src/app/(app)/documents/letters-admin/export/route")).GET,
    assetExport: (await import("../apps/web/src/app/(app)/assets/operations/export/route")).GET,
  };

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, exec, meera, ananya, sneha] = await Promise.all([
    user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("deepak.chauhan@acme.test"),
    user("meera.krishnan@acme.test"), user("ananya.ghosh@acme.test"), user("sneha.reddy@acme.test"),
  ]);
  const started = new Date();
  const tag = `CD${String(Date.now()).slice(-6)}`;
  const made = {
    tickets: [] as string[], kb: [] as string[], kbCats: [] as string[], sla: [] as string[], triage: [] as string[], escRules: [] as string[], caseTpls: [] as string[],
    erCases: [] as string[], envelopes: [] as string[], docTypes: [] as string[], folders: [] as string[], templates: [] as string[], series: [] as string[], letters: [] as string[],
    assetCats: [] as string[], assets: [] as string[], pools: [] as string[], recs: [] as string[],
  };
  const settingsBefore = await prisma.letterSettings.findUnique({ where: { tenantId } });
  const triggersBefore = await prisma.letterTrigger.findMany({ where: { tenantId } });

  /** Approve (or reject) the pending engine task for a record as `who`. */
  async function decide(who: { email: string; id: string }, entityType: string, entityId: string, approve = true): Promise<State> {
    await signInAs(who.email);
    const task = await prisma.workflowTask.findFirst({ where: { tenantId, approverUserId: who.id, status: "PENDING", request: { entityType, entityId, status: "PENDING" } } });
    if (!task) return { ok: false, message: `no pending ${entityType} task for ${who.email}` };
    return WF.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: approve ? "approve" : "reject", comment: approve ? "" : "Not this time" }));
  }

  console.log("\nCases & documents\n" + "=".repeat(72));
  try {
    // =========================================================================
    section("Helpdesk · knowledge base");
    await signInAs(meera.email);
    check("An employee cannot open the knowledge base admin", (await render(pages.knowledge, "/helpdesk/knowledge")) === "403");
    check("An employee cannot write an article", (await HD.saveKbArticleAction({}, fd({ title: "Nope nope", body: "x".repeat(40) }))).ok === false);

    await signInAs(admin.email);
    check("A settings holder adds a section", (await HD.saveKbCategoryAction({}, fd({ name: `${tag} Payroll`, sortOrder: 1 }))).ok === true);
    const kbCat = await prisma.kbCategory.findFirstOrThrow({ where: { tenantId, name: `${tag} Payroll` } });
    made.kbCats.push(kbCat.id);

    await signInAs(hr.email);
    const scripted = await HD.saveKbArticleAction({}, fd({ title: "Bad article here", body: "Hello <script>alert(1)</script> and more words to pass length" }));
    check("An article with a script is refused", scripted.ok === false && /script/i.test(scripted.message ?? ""));
    const kbSaved = await HD.saveKbArticleAction({}, fd({ title: `${tag} How to download your payslip`, categoryId: kbCat.id, keywords: `payslip, ${tag.toLowerCase()}zz`, body: `Go to Finances, then Payslips, choose the month and press Download. ${tag} reference.` }));
    check("An agent saves a draft article", kbSaved.ok === true, kbSaved.message);
    const art = await prisma.kbArticle.findFirstOrThrow({ where: { tenantId, title: `${tag} How to download your payslip` } });
    made.kb.push(art.id);
    check("…kept as revision 1", (await prisma.kbArticleRevision.count({ where: { articleId: art.id } })) === 1);
    check("A draft is not visible to employees", (await svc.searchKb(tenantId, tag)).every((a) => a.id !== art.id));
    const sub = await HD.submitKbArticleAction({}, fd({ id: art.id }));
    check("The agent submits it for publication", sub.ok === true, sub.message);
    check("…it is awaiting approval", (await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } })).status === "PENDING_APPROVAL");
    check("…and cannot be edited meanwhile", (await HD.saveKbArticleAction({}, fd({ id: art.id, title: art.title, body: art.body }))).ok === false);
    check("The author has no approval task of their own", !(await prisma.workflowTask.findFirst({ where: { approverUserId: hr.id, request: { entityType: "KB_ARTICLE", entityId: art.id } } })));
    const kbOk = await decide(admin, "KB_ARTICLE", art.id);
    check("A helpdesk administrator approves it in the inbox", kbOk.ok === true, kbOk.message);
    const published = await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } });
    check("…and it is published with a review date", published.status === "PUBLISHED" && !!published.publishedAt && !!published.reviewDueOn);
    check("Search finds it by keyword", (await svc.searchKb(tenantId, `${tag.toLowerCase()}zz`)).some((a) => a.id === art.id));
    check("Search finds it by words in the body", (await svc.searchKb(tenantId, "download payslip month")).some((a) => a.id === art.id));

    await signInAs(meera.email);
    const sugg = await HD.suggestArticlesAction("how can I download my payslip for the month", null);
    check("Raising a ticket suggests the article", sugg.some((a) => a.id === art.id));
    const myKb = await render(pages.myKnowledge, `/me/knowledge?q=${tag.toLowerCase()}zz`);
    check("The employee knowledge page lists it", ok(myKb) && myKb.includes(art.title));
    const myArt = await render(pages.myArticle, `/me/knowledge/${art.id}`, { id: art.id });
    check("The employee opens the article", ok(myArt) && myArt.includes("Was this helpful?"));
    check("…and the view is counted", (await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } })).views === 1);
    check("The employee rates it not helpful", (await HD.kbFeedbackAction({}, fd({ articleId: art.id, helpful: "no", comment: "Missing the mobile app steps" }))).ok === true);
    check("…then changes to helpful (one vote per person)", (await HD.kbFeedbackAction({}, fd({ articleId: art.id, helpful: "yes" }))).ok === true);
    const rated = await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } });
    check("…counts move rather than double", rated.helpfulYes === 1 && rated.helpfulNo === 0);

    await signInAs(hr.email);
    const kbList = await render(pages.knowledge, `/helpdesk/knowledge?q=${tag}`);
    check("The agent's knowledge list shows the article", ok(kbList) && kbList.includes(art.title));
    for (const t of ["new", "categories", "insights"]) check(`Knowledge tab ${t} renders`, ok(await render(pages.knowledge, `/helpdesk/knowledge?tab=${t}`)));
    const artPage = await render(pages.article, `/helpdesk/knowledge/${art.id}`, { id: art.id });
    check("The article page shows feedback and revisions", ok(artPage) && artPage.includes("Revisions") && artPage.includes("Feedback"));
    const edit = await HD.saveKbArticleAction({}, fd({ id: art.id, title: art.title, body: `${art.body} Use the mobile app too.`, note: "Mobile steps" }));
    check("Editing a published article saves a new draft version", edit.ok === true && (await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } })).version === 2);

    await signInAs(admin.email);
    const bulk = await HD.bulkArchiveKbAction({}, form({ ids: [art.id] }));
    check("A settings holder archives in bulk", bulk.ok === true && (await prisma.kbArticle.findUniqueOrThrow({ where: { id: art.id } })).status === "ARCHIVED");

    // =========================================================================
    section("Helpdesk · rules, cases, escalation");
    const payroll = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId, name: "Payroll & salary", parentId: null } });
    const payslip = await prisma.helpdeskCategory.findFirstOrThrow({ where: { tenantId, name: "Payslip queries", parentId: payroll.id } });
    await signInAs(hr.email);
    check("An agent without settings cannot change SLA targets", (await HD.saveSlaPolicyAction({}, fd({ priority: "HIGH", firstResponseHours: 1, resolutionHours: 4 }))).ok === false);
    await signInAs(admin.email);
    const sla = await HD.saveSlaPolicyAction({}, fd({ priority: "HIGH", categoryId: payslip.id, firstResponseHours: 2, resolutionHours: 6 }));
    check("Per-priority SLA target saved", sla.ok === true, sla.message);
    const slaRow = await prisma.helpdeskSlaPolicy.findFirstOrThrow({ where: { tenantId, categoryId: payslip.id, priority: "HIGH" } });
    made.sla.push(slaRow.id);
    const tri = await HD.saveTriageRuleAction({}, fd({ name: `${tag} urgent`, keywords: `${tag.toLowerCase()}urgent`, setPriority: "HIGH", setSeverity: "S1" }));
    check("Keyword triage rule saved", tri.ok === true, tri.message);
    made.triage.push((await prisma.helpdeskTriageRule.findFirstOrThrow({ where: { tenantId, name: `${tag} urgent` } })).id);
    const esc = await HD.saveEscalationRuleAction({}, fd({ name: `${tag} unassigned`, trigger: "UNASSIGNED", afterHours: 0, level: 1, categoryId: payslip.id, escalateTo: "USER", escalateUserId: hr.id }));
    check("Escalation rule saved", esc.ok === true, esc.message);
    made.escRules.push((await prisma.helpdeskEscalationRule.findFirstOrThrow({ where: { tenantId, name: `${tag} unassigned` } })).id);
    const tpl = await HD.saveCaseTemplateAction({}, fd({ name: `${tag} Payslip correction`, categoryId: payslip.id, subject: "Payslip correction", description: "Employee reports a wrong figure on the payslip.", priority: "MEDIUM", tasks: "Pull the payslip\nCheck attendance\nConfirm with payroll" }));
    check("Case template with a task checklist saved", tpl.ok === true, tpl.message);
    const caseTpl = await prisma.helpdeskCaseTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Payslip correction` } });
    made.caseTpls.push(caseTpl.id);

    await signInAs(hr.email);
    const logged = await HD.logCaseAction({}, fd({ employeeId: meera.employee!.id, channel: "PHONE", templateId: caseTpl.id }));
    check("An agent logs a phone case for an employee from the template", logged.ok === true, logged.message);
    const t1 = await prisma.helpdeskTicket.findFirstOrThrow({ where: { tenantId, loggedByUserId: hr.id, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
    made.tickets.push(t1.id);
    check("…recorded with its channel and the template's tasks", t1.channel === "PHONE" && t1.employeeId === meera.employee!.id && (await prisma.helpdeskTicketTask.count({ where: { ticketId: t1.id } })) === 3);
    const triaged = await HD.logCaseAction({}, fd({ employeeId: meera.employee!.id, channel: "EMAIL", categoryId: payslip.id, subject: "Payslip missing", description: `My payslip is missing ${tag.toLowerCase()}urgent please help` }));
    check("A second case logged by email", triaged.ok === true, triaged.message);
    const t2 = await prisma.helpdeskTicket.findFirstOrThrow({ where: { tenantId, loggedByUserId: hr.id, createdAt: { gte: started }, NOT: { id: t1.id } }, orderBy: { createdAt: "desc" } });
    made.tickets.push(t2.id);
    check("Triage set its priority and severity from the keyword", t2.priority === "HIGH" && t2.severity === "S1", `${t2.priority} ${t2.severity}`);
    const withPolicy = await svc.helpdeskDueDates(tenantId, payslip.id, t2.createdAt, "HIGH");
    const categoryOnly = await svc.helpdeskDueDates(tenantId, payslip.id, t2.createdAt, null);
    check("…and the per-priority SLA target sets its due date", Math.abs(t2.dueAt.getTime() - withPolicy.dueAt.getTime()) < 60_000 && withPolicy.dueAt.getTime() !== categoryOnly.dueAt.getTime());

    const tasks = await prisma.helpdeskTicketTask.findMany({ where: { ticketId: t1.id }, orderBy: { sortOrder: "asc" } });
    check("A task is ticked off", (await HD.toggleTicketTaskAction({}, fd({ taskId: tasks[0]!.id }))).ok === true && !!(await prisma.helpdeskTicketTask.findUniqueOrThrow({ where: { id: tasks[0]!.id } })).doneAt);
    check("A task is added", (await HD.addTicketTaskAction({}, fd({ ticketId: t1.id, title: "Call the employee back", assigneeUserId: hr.id, dueOn: day(2) }))).ok === true);
    check("A task is removed", (await HD.deleteTicketTaskAction({}, fd({ taskId: tasks[2]!.id }))).ok === true);
    await signInAs(meera.email);
    check("The employee cannot touch case tasks", (await HD.addTicketTaskAction({}, fd({ ticketId: t1.id, title: "Mine" }))).ok === false);

    await signInAs(hr.email);
    const escalated = await HD.escalateTicketAction({}, fd({ ticketId: t1.id, reason: "Employee is upset", toUserId: admin.id }));
    check("An agent escalates a case to a named person", escalated.ok === true, escalated.message);
    const escRow = await prisma.helpdeskTicketEscalation.findFirstOrThrow({ where: { ticketId: t1.id } });
    check("…recorded at level 1 for that person", escRow.level === 1 && escRow.escalatedToUserId === admin.id);
    await signInAs(admin.email);
    check("The escalation target acknowledges it", (await HD.acknowledgeEscalationAction({}, fd({ escalationId: escRow.id }))).ok === true && !!(await prisma.helpdeskTicketEscalation.findUniqueOrThrow({ where: { id: escRow.id } })).acknowledgedAt);
    const before = await prisma.helpdeskTicketEscalation.count({ where: { ruleId: made.escRules[0] } });
    await prisma.helpdeskTicket.update({ where: { id: t2.id }, data: { assigneeUserId: null } });
    await svc.runHelpdeskEscalations(tenantId, new Date(Date.now() + 3_600_000));
    check("The nightly run escalates an unassigned case by rule", (await prisma.helpdeskTicketEscalation.count({ where: { ruleId: made.escRules[0] } })) > before);

    await signInAs(hr.email);
    const appr = await HD.requestCaseApprovalAction({}, fd({ ticketId: t1.id, summary: "One-off salary advance beyond policy", amount: "25000" }));
    check("An agent asks for a decision on the case", appr.ok === true, appr.message);
    check("…the case shows approval pending", (await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: t1.id } })).approvalStatus === "PENDING");
    check("…a helpdesk administrator approves it", (await decide(admin, "HELPDESK_CASE", t1.id)).ok === true && (await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: t1.id } })).approvalStatus === "APPROVED");

    await signInAs(hr.email);
    const split = await HD.splitTicketAction({}, fd({ ticketId: t1.id, subject: "Separate: tax query", description: "The employee also asked about TDS on the advance." }));
    check("An agent splits a separate question into a new case", split.ok === true, split.message);
    const t3 = await prisma.helpdeskTicket.findFirstOrThrow({ where: { tenantId, splitFromId: t1.id } });
    made.tickets.push(t3.id);
    check("…linked back to the original", t3.employeeId === meera.employee!.id);
    const merged = await HD.mergeTicketAction({}, fd({ ticketId: t3.id, targetNumber: String(t1.number) }));
    check("An agent merges a duplicate into another case", merged.ok === true, merged.message);
    const t3after = await prisma.helpdeskTicket.findUniqueOrThrow({ where: { id: t3.id } });
    check("…the duplicate is closed and points at the target", t3after.mergedIntoId === t1.id && t3after.status === "CLOSED");

    const tPage = await render(pages.ticket, `/helpdesk/tickets/${t1.id}`, { id: t1.id });
    check("The ticket page shows tasks, escalation and approval", ok(tPage) && tPage.includes("Call the employee back") && tPage.includes("Employee is upset") && tPage.includes("Merge"));
    for (const t of ["log", "escalations", "aging", "sla", "triage", "rules", "templates"]) check(`Operations tab ${t} renders`, ok(await render(pages.operations, `/helpdesk/operations?tab=${t}`)));
    const aging = await routes.aging();
    const agingCsv = await aging.text();
    check("Aging report downloads as CSV", aging.status === 200 && agingCsv.startsWith("Category,0-1 days"));
    await signInAs(meera.email);
    check("An employee cannot download the aging report", (await routes.aging()).status === 404);
    check("An employee cannot open helpdesk operations", (await render(pages.operations, "/helpdesk/operations")) === "403");

    // =========================================================================
    section("Employee relations · intake and access");
    await signInAs(meera.email);
    check("An employee cannot open Employee Relations", (await render(pages.relations, "/relations")) === "403");
    const anon = await ER.raiseErCaseAction({}, fd({ kind: "COMPLAINT", category: "HARASSMENT", title: `${tag} Repeated comments in the team`, description: "A colleague keeps making remarks about my accent in meetings.", anonymous: "on" }));
    check("An employee raises an anonymous complaint", anon.ok === true && !!anon.values?.trackingCode, anon.message);
    const code = anon.values!.trackingCode!;
    const anonCase = await prisma.erCase.findFirstOrThrow({ where: { tenantId, title: `${tag} Repeated comments in the team` } });
    made.erCases.push(anonCase.id);
    check("…stored without the reporter's identity", anonCase.isAnonymous && anonCase.reporterEmployeeId === null);
    check("…and its audit entry names nobody", !(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "ErCase", entityId: anonCase.id } })));
    const lookup = await render(pages.myCases, `/me/cases?code=${code}`);
    check("The tracking code finds the case", ok(lookup) && lookup.includes(anonCase.title));
    check("The reporter adds information anonymously", (await ER.anonymousInfoAction({}, fd({ code, body: "It happened again on Monday in the sprint review." }))).ok === true);
    check("A wrong code finds nothing", (await ER.anonymousInfoAction({}, fd({ code: "ZZZZZZZZ", body: "Trying to read someone else's case" }))).ok === false);

    await signInAs(exec.email);
    const disc = await ER.createErCaseAction({}, fd({ kind: "DISCIPLINARY", category: "ATTENDANCE", severity: "MEDIUM", title: `${tag} Unauthorised absences`, description: "Five unauthorised absences in September without notice.", subjectEmployeeId: ananya.employee!.id, confidential: "on" }));
    check("HR logs a confidential disciplinary case", disc.ok === true && !!disc.values?.id, disc.message);
    const caseId = disc.values!.id!;
    made.erCases.push(caseId);
    await signInAs(ananya.email);
    check("The subject cannot open the case file", ["403", "404"].includes(await render(pages.erCase, `/relations/${caseId}`, { id: caseId })));
    await signInAs(sneha.email);
    check("A manager not on the access list cannot open it", ["403", "404"].includes(await render(pages.erCase, `/relations/${caseId}`, { id: caseId })));
    await signInAs(exec.email);
    check("The owner opens it", ok(await render(pages.erCase, `/relations/${caseId}`, { id: caseId })));
    check("The owner adds the manager as a viewer", (await ER.erAccessAction({}, fd({ caseId, userId: sneha.id, role: "VIEWER" }))).ok === true);
    await signInAs(sneha.email);
    check("…who can then read it", ok(await render(pages.erCase, `/relations/${caseId}`, { id: caseId })));
    check("…but not work it", (await ER.erNoteAction({}, fd({ caseId, body: "Viewer note" }))).ok === false);

    // =========================================================================
    section("Employee relations · investigation, hearing, actions, appeal");
    await signInAs(exec.email);
    check("The case moves to review", (await ER.erMoveAction({}, fd({ caseId, to: "UNDER_REVIEW" }))).ok === true);
    check("A move outside the flow is refused", (await ER.erMoveAction({}, fd({ caseId, to: "CLOSED" }))).ok === false);
    const inv = await ER.startInvestigationAction({}, fd({ caseId, investigatorUserId: exec.id, scope: "Attendance records and manager statements", dueOn: day(10) }));
    check("An investigation starts", inv.ok === true, inv.message);
    check("An investigation task is added", (await ER.investigationTaskAction({}, fd({ caseId, title: "Pull biometric logs" }))).ok === true);
    const invTasks = await prisma.erInvestigationTask.findMany({ where: { investigation: { caseId } } });
    check("…with the standard checklist plus the added task", invTasks.length >= 2);
    check("Findings wait for open tasks", (await ER.submitFindingsAction({}, fd({ caseId, conclusion: "SUBSTANTIATED", findings: "Biometric logs confirm five absences with no leave applied." }))).ok === false);
    let closedAll = true;
    for (const t of invTasks) closedAll = (await ER.investigationTaskAction({}, fd({ taskId: t.id }))).ok === true && closedAll;
    check("The tasks are closed", closedAll);
    check("A witness statement is recorded", (await ER.witnessAction({}, fd({ caseId, employeeId: sneha.employee!.id, statement: "She did not inform me on those days.", interviewedOn: day(0) }))).ok === true);
    const ev = await ER.evidenceAction({}, form({ caseId, title: "Biometric export", file: pdfFile("biometric.pdf") }));
    check("Evidence is attached", ev.ok === true, ev.message);
    const fnd = await ER.submitFindingsAction({}, fd({ caseId, conclusion: "SUBSTANTIATED", findings: "Biometric logs confirm five absences with no leave applied.", recommendation: "Written warning" }));
    check("The investigator submits findings for sign-off", fnd.ok === true, fnd.message);
    const invRow = await prisma.erInvestigation.findFirstOrThrow({ where: { caseId } });
    check("…an ER approver accepts them", (await decide(hr, "ER_FINDINGS", invRow.id)).ok === true && (await prisma.erInvestigation.findUniqueOrThrow({ where: { id: invRow.id } })).status === "ACCEPTED");

    await signInAs(exec.email);
    check("The subject cannot sit on the hearing panel", (await ER.scheduleHearingAction({}, form({ caseId, scheduledAt: `${day(3)}T11:00`, panelUserIds: [ananya.id] }))).ok === false);
    check("A hearing is scheduled", (await ER.scheduleHearingAction({}, form({ caseId, scheduledAt: `${day(3)}T11:00`, location: "Room 4", panelUserIds: [exec.id, hr.id] }))).ok === true);
    const hearing = await prisma.erHearing.findFirstOrThrow({ where: { caseId } });
    check("…and its outcome recorded", (await ER.recordHearingAction({}, fd({ hearingId: hearing.id, status: "HELD", minutes: "Employee accepted the absences; cited family reasons.", attendees: "Panel, employee" }))).ok === true);
    check("A suspension over 90 days is refused", (await ER.proposeActionAction({}, fd({ caseId, actionType: "SUSPENSION", summary: "Suspension pending enquiry outcome", effectiveOn: day(0), suspensionFrom: day(0), suspensionTo: day(120) }))).ok === false);
    check("A final warning without an earlier written warning needs a reason", (await ER.proposeActionAction({}, fd({ caseId, actionType: "FINAL_WARNING", summary: "Final warning for repeated absence", effectiveOn: day(0) }))).ok === false);
    const sc = await ER.proposeActionAction({}, fd({ caseId, actionType: "SHOW_CAUSE", summary: "Explain the five unauthorised absences", effectiveOn: day(0) }));
    check("A show-cause notice is proposed", sc.ok === true, sc.message);
    const scAct = await prisma.erAction.findFirstOrThrow({ where: { caseId, actionType: "SHOW_CAUSE" } });
    check("…approved by an ER approver", (await decide(hr, "ER_ACTION", scAct.id)).ok === true);
    const scIssued = await prisma.erAction.findUniqueOrThrow({ where: { id: scAct.id } });
    check("…issued with a response due date", scIssued.status === "ISSUED" && !!scIssued.responseDueOn);
    await signInAs(ananya.email);
    const mine = await render(pages.myCases, "/me/cases");
    check("The employee sees the notice on their cases page", ok(mine) && mine.includes("Show-cause notice"));
    check("The employee responds", (await ER.respondToActionAction({}, fd({ actionId: scAct.id, response: "I had a family emergency and could not call in." }))).ok === true);

    await signInAs(exec.email);
    const ww = await ER.proposeActionAction({}, fd({ caseId, actionType: "WRITTEN_WARNING", summary: "Written warning for unauthorised absence", effectiveOn: day(0) }));
    check("A written warning is proposed", ww.ok === true, ww.message);
    const wwAct = await prisma.erAction.findFirstOrThrow({ where: { caseId, actionType: "WRITTEN_WARNING" } });
    check("…the proposer cannot approve it", !(await prisma.workflowTask.findFirst({ where: { approverUserId: exec.id, request: { entityType: "ER_ACTION", entityId: wwAct.id } } })));
    check("…an approver issues it", (await decide(hr, "ER_ACTION", wwAct.id)).ok === true && (await prisma.erAction.findUniqueOrThrow({ where: { id: wwAct.id } })).status === "ISSUED");
    check("…valid for the warning period", !!(await prisma.erAction.findUniqueOrThrow({ where: { id: wwAct.id } })).expiresOn);
    await signInAs(ananya.email);
    check("The employee acknowledges the warning", (await ER.acknowledgeActionAction({}, fd({ actionId: wwAct.id }))).ok === true);
    check("An appeal needs real grounds", (await ER.fileAppealAction({}, fd({ actionId: wwAct.id, grounds: "Unfair" }))).ok === false);
    check("The employee appeals", (await ER.fileAppealAction({}, fd({ actionId: wwAct.id, grounds: "The absences were caused by a documented family medical emergency." }))).ok === true);
    const appeal = await prisma.erAppeal.findFirstOrThrow({ where: { actionId: wwAct.id } });
    await signInAs(hr.email);
    check("Who approved the warning cannot review the appeal", (await ER.takeUpAppealAction({}, fd({ appealId: appeal.id }))).ok === false);
    await signInAs(admin.email);
    check("An independent approver takes it up", (await ER.takeUpAppealAction({}, fd({ appealId: appeal.id }))).ok === true);
    check("…and upholds it with reasons", (await ER.decideAppealAction({}, fd({ appealId: appeal.id, decision: "UPHELD", note: "Absences were not notified even afterwards." }))).ok === true);

    await signInAs(exec.email);
    const res = await ER.proposeResolutionAction({}, fd({ caseId, outcome: "ACTION_TAKEN", resolution: "Written warning issued and upheld on appeal; attendance to be monitored." }));
    check("A resolution is proposed", res.ok === true, res.message);
    check("…and approved", (await decide(hr, "ER_RESOLUTION", caseId)).ok === true && (await prisma.erCase.findUniqueOrThrow({ where: { id: caseId } })).status === "RESOLVED");
    check("The resolved case is closed", (await ER.closeErCaseAction({}, fd({ caseId }))).ok === true);
    const closed = await prisma.erCase.findUniqueOrThrow({ where: { id: caseId } });
    check("…with a retention date for the governance purge", closed.status === "CLOSED" && !!closed.retainUntil && closed.retainUntil > new Date());
    for (const t of ["cases", "new", "actions", "reports", "settings"]) check(`Relations tab ${t} renders`, ok(await render(pages.relations, `/relations?tab=${t}`)));
    const erCsv = await routes.erExport(new Request("http://acme.test/relations/export"));
    const erText = await erCsv.text();
    check("The case register downloads without descriptions", erCsv.status === 200 && erText.includes("Written") === false && erText.includes("ACM0007"));
    check("…and the export is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "ErCase", action: "EXPORT", createdAt: { gte: started } } })));

    // =========================================================================
    section("Documents · e-sign");
    await signInAs(meera.email);
    check("An employee cannot send envelopes", (await DO.createEnvelopeAction({}, form({ title: "Mine", file: pdfFile("x.pdf"), recipientUserId: [sneha.id] }))).ok === false);
    await signInAs(hr.email);
    const env1 = await DO.createEnvelopeAction({}, form({ title: `${tag} NDA`, message: "Please sign", file: pdfFile("nda.pdf"), recipientUserId: [meera.id, sneha.id], recipientRole: ["SIGNER", "SIGNER"], recipientOrder: ["1", "2"], sequential: "true", reminderEveryDays: "2", sendNow: "on" }));
    check("HR sends a two-signer envelope in order", env1.ok === true && !!env1.values?.id, env1.message);
    const e1 = env1.values!.id!;
    made.envelopes.push(e1);
    check("…it is out for signature", (await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: e1 } })).status === "SENT");
    await signInAs(sneha.email);
    check("The second signer must wait their turn", (await DO.signEnvelopeAction({}, fd({ id: e1, typedName: "Sneha Reddy", signature: PNG, consent: "on" }))).ok === false);
    await signInAs(meera.email);
    check("My documents-to-sign page lists it", (await render(pages.mySign, "/me/sign")).includes(`${tag} NDA`));
    check("A wrong typed name is refused", (await DO.signEnvelopeAction({}, fd({ id: e1, typedName: "Someone Else", signature: PNG, consent: "on" }))).ok === false);
    check("Signing needs consent", (await DO.signEnvelopeAction({}, fd({ id: e1, typedName: meera.employee!.displayName!, signature: PNG }))).ok === false);
    const s1 = await DO.signEnvelopeAction({}, fd({ id: e1, typedName: meera.employee!.displayName!, signature: PNG, consent: "on" }));
    check("The first signer signs", s1.ok === true, s1.message);
    await signInAs(sneha.email);
    check("Declining needs a reason", (await DO.declineEnvelopeAction({}, fd({ id: e1, reason: "" }))).ok === false);
    check("The second signer declines with a reason", (await DO.declineEnvelopeAction({}, fd({ id: e1, reason: "Clause 4 names the wrong entity" }))).ok === true);
    const declined = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: e1 } });
    check("…the envelope is declined", declined.status === "DECLINED");

    await signInAs(hr.email);
    const env2 = await DO.createEnvelopeAction({}, form({ title: `${tag} Policy acknowledgement`, file: pdfFile("policy.pdf"), recipientUserId: [meera.id, sneha.id], recipientRole: ["SIGNER", "SIGNER"], recipientOrder: ["1", "1"], sequential: "false" }));
    const e2 = env2.values!.id!;
    made.envelopes.push(e2);
    check("A draft envelope is created", env2.ok === true && (await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: e2 } })).status === "DRAFT");
    check("…then sent", (await DO.sendEnvelopeAction({}, fd({ id: e2 }))).ok === true);
    check("Pending signers are reminded", (await DO.remindEnvelopeAction({}, fd({ id: e2 }))).ok === true);
    await signInAs(sneha.email);
    check("Parallel signers sign in any order", (await DO.signEnvelopeAction({}, fd({ id: e2, typedName: sneha.employee!.displayName!, signature: PNG, consent: "on" }))).ok === true);
    await signInAs(meera.email);
    check("…and the last signature completes it", (await DO.signEnvelopeAction({}, fd({ id: e2, typedName: meera.employee!.displayName!, signature: PNG, consent: "on" }))).ok === true && (await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: e2 } })).status === "COMPLETED");
    check("A signer can download the completion certificate", (await routes.certificate(new NextRequest(`http://acme.test/documents/esign/${e2}/certificate`), { params: Promise.resolve({ id: e2 }) })).status === 200);
    await signInAs(ananya.email);
    check("Someone not on the envelope cannot", (await routes.certificate(new NextRequest(`http://acme.test/documents/esign/${e2}/certificate`), { params: Promise.resolve({ id: e2 }) })).status !== 200);
    await signInAs(hr.email);
    const cert = await routes.certificate(new NextRequest(`http://acme.test/documents/esign/${e2}/certificate`), { params: Promise.resolve({ id: e2 }) });
    check("The certificate is a PDF", cert.status === 200 && (cert.headers.get("content-type") ?? "").includes("pdf"));
    const env3 = await DO.createEnvelopeAction({}, form({ title: `${tag} Void me`, file: pdfFile("v.pdf"), recipientUserId: [meera.id], sendNow: "on" }));
    made.envelopes.push(env3.values!.id!);
    check("A sent envelope is voided with a reason", (await DO.voidEnvelopeAction({}, fd({ id: env3.values!.id!, reason: "Sent to the wrong person" }))).ok === true);
    for (const t of ["sent", "new", "mine"]) check(`E-sign tab ${t} renders`, ok(await render(pages.esign, `/documents/esign?tab=${t}`)));
    const envPage = await render(pages.envelope, `/documents/esign/${e1}`, { id: e1 });
    check("The envelope page shows the decline reason", ok(envPage) && envPage.includes("Clause 4 names the wrong entity"));

    // =========================================================================
    section("Documents · bulk upload, versions, folders, expiry");
    const folder = await prisma.documentFolder.create({ data: { tenantId, name: `${tag} Confidential`, isConfidential: true, viewRoles: [], editRoles: [] } });
    made.folders.push(folder.id);
    const dtype = await prisma.documentType.create({ data: { folderId: folder.id, name: `${tag} Medical certificate`, requireVerification: false } });
    made.docTypes.push(dtype.id);
    await signInAs(admin.email);
    const up = await DO.bulkUploadAction({}, form({ documentTypeId: dtype.id, expiresOn: day(20), files: [pdfFile("ACM0009_medical.pdf"), pdfFile("ACM0005-medical.pdf"), pdfFile("nobody.pdf")] }));
    check("Bulk upload files documents by employee number", up.ok === true && /2 of 3/.test(up.message ?? ""), up.message);
    const log = await prisma.documentBulkUpload.findFirstOrThrow({ where: { tenantId, documentTypeId: dtype.id } });
    check("…and keeps an upload log with the failure", log.matched === 2 && log.failed === 1);
    const up2 = await DO.bulkUploadAction({}, form({ documentTypeId: dtype.id, files: [pdfFile("ACM0009 renewed.pdf")] }));
    check("Re-uploading replaces the file", up2.ok === true);
    const meeraDoc = await prisma.employeeDocument.findFirstOrThrow({ where: { tenantId, employeeId: meera.employee!.id, documentTypeId: dtype.id } });
    check("…keeping the earlier file as a version", (await prisma.documentVersion.count({ where: { tenantId, documentKind: "EMPLOYEE", documentId: meeraDoc.id } })) >= 1);
    await prisma.employeeDocument.update({ where: { id: meeraDoc.id }, data: { expiresOn: new Date(Date.now() + 10 * 86_400_000), expiryNoticeStage: 0 } });
    await svc.runDocumentExpiry(tenantId, new Date());
    check("The expiry run sends a notice for a document expiring soon", (await prisma.employeeDocument.findUniqueOrThrow({ where: { id: meeraDoc.id } })).expiryNoticeStage > 0);
    await signInAs(meera.email);
    check("An employee cannot request renewals", (await DO.requestRenewalAction({}, fd({ documentId: meeraDoc.id }))).ok === false);
    await signInAs(admin.email);
    check("HR asks the employee for the renewed document", (await DO.requestRenewalAction({}, fd({ documentId: meeraDoc.id, note: "Please upload the new certificate" }))).ok === true && (await prisma.employeeDocument.findUniqueOrThrow({ where: { id: meeraDoc.id } })).status === "PENDING_ON_EMPLOYEE");
    await signInAs(exec.email);
    const fa = await DO.requestFolderAccessAction({}, fd({ folderId: folder.id, reason: "Investigating a leave dispute", days: "7" }));
    check("Access to a confidential folder is requested", fa.ok === true, fa.message);
    const access = await prisma.documentFolderAccess.findFirstOrThrow({ where: { folderId: folder.id, userId: exec.id } });
    check("…and granted through approval for a limited time", (await decide(hr, "DOCUMENT_FOLDER_ACCESS", access.id)).ok === true && (await prisma.documentFolderAccess.findUniqueOrThrow({ where: { id: access.id } })).status === "ACTIVE");
    await signInAs(admin.email);
    check("An administrator revokes it", (await DO.revokeFolderAccessAction({}, fd({ accessId: access.id }))).ok === true);
    for (const t of ["versions", "expiry", "folders", "shared", "bulk", "completeness"]) check(`Library tab ${t} renders`, ok(await render(pages.library, `/documents/library?tab=${t}`)));
    const libCsv = await routes.libraryExport(new Request("http://acme.test/documents/library/export?tab=expiry"));
    check("The expiry list downloads", libCsv.status === 200);

    // =========================================================================
    section("Letters · series, bulk, approval, triggers");
    const experience = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId, name: "Experience Letter" } });
    await signInAs(meera.email);
    check("An employee cannot create a number series", (await DO.saveLetterSeriesAction({}, fd({ name: "x", prefix: "X/" }))).ok === false);
    await signInAs(admin.email);
    const ser = await DO.saveLetterSeriesAction({}, fd({ name: `${tag} Experience`, category: "EXPERIENCE", prefix: `${tag}/EXP/{YYYY}/`, digits: "3", nextNumber: "7", yearlyReset: "on" }));
    check("A numbering series is saved", ser.ok === true, ser.message);
    const series = await prisma.letterNumberSeries.findFirstOrThrow({ where: { tenantId, name: `${tag} Experience` } });
    made.series.push(series.id);
    const bl = await DO.bulkLettersAction({}, form({ templateId: experience.id, employeeIds: [meera.employee!.id, sneha.employee!.id] }));
    check("Letters are generated in bulk", bl.ok === true && /2 of 2/.test(bl.message ?? ""), bl.message);
    const batch = await prisma.letterBatch.findFirstOrThrow({ where: { tenantId, templateId: experience.id, createdAt: { gte: started } } });
    const letters = await prisma.generatedDocument.findMany({ where: { batchId: batch.id }, orderBy: { letterNumber: "asc" } });
    made.letters.push(...letters.map((l) => l.id));
    const year = new Date().getUTCFullYear();
    check("…numbered from the series in sequence", letters.length === 2 && letters[0]!.letterNumber === `${tag}/EXP/${year}/007` && letters[1]!.letterNumber === `${tag}/EXP/${year}/008`, letters.map((l) => l.letterNumber).join(" "));
    check("A letter is resent", (await DO.resendLetterAction({}, fd({ id: letters[0]!.id }))).ok === true);

    const tplSave = await LT.saveLetterTemplateAction({}, fd({ name: `${tag} Appreciation`, category: "CUSTOM", workflow: "", body: "<p>Dear {{employee_name}},</p><p>Thank you.</p>{{#if job_title}}<p>{{job_title}}</p>{{/if}}" }));
    check("A template is saved", tplSave.ok === true, tplSave.message);
    const myTpl = await prisma.documentTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Appreciation` } });
    made.templates.push(myTpl.id);
    check("Requiring approval for templates is switched on", (await DO.saveLetterSettingsAction({}, fd({ requireTemplateApproval: "on", reviewEveryMonths: "12", maxBackdateDays: "30" }))).ok === true);
    const backdated = await LT.generateLetterAction({}, fd({ employeeId: meera.employee!.id, templateId: experience.id, issuedOn: "2020-01-01" }));
    check("A letter backdated beyond the limit is refused", backdated.ok === false, backdated.message);
    check("…an edited template drops to draft", (await LT.saveLetterTemplateAction({}, fd({ id: myTpl.id, name: `${tag} Appreciation`, category: "CUSTOM", workflow: "", body: "<p>Dear {{employee_name}},</p><p>Thank you very much.</p>" }))).ok === true && (await prisma.documentTemplate.findUniqueOrThrow({ where: { id: myTpl.id } })).approvalStatus === "DRAFT");
    check("…and cannot be used until approved", (await DO.bulkLettersAction({}, form({ templateId: myTpl.id, employeeIds: [meera.employee!.id] }))).ok === false);
    check("…it is submitted", (await DO.submitTemplateAction({}, fd({ id: myTpl.id }))).ok === true);
    check("…and approved by another template administrator", (await decide(hr, "LETTER_TEMPLATE", myTpl.id)).ok === true && (await prisma.documentTemplate.findUniqueOrThrow({ where: { id: myTpl.id } })).approvalStatus === "APPROVED");
    await signInAs(admin.email);
    check("Owner and department scope are set", (await DO.templateGovernanceAction({}, form({ id: myTpl.id, ownerUserId: hr.id }))).ok === true);
    check("The owner marks it reviewed", (await DO.reviewTemplateAction({}, fd({ id: myTpl.id }))).ok === true);
    check("An automatic letter on exit is set", (await DO.saveLetterTriggerAction({}, fd({ event: "EXIT_COMPLETED", templateId: experience.id }))).ok === true);
    const fired = await svc.fireLetterTriggers(tenantId, "EXIT_COMPLETED", sneha.employee!.id, admin.id);
    check("…firing it generates the letter", fired.generated === 1, JSON.stringify(fired));
    made.letters.push(...(await prisma.generatedDocument.findMany({ where: { employeeId: sneha.employee!.id, templateId: experience.id, issuedOn: { gte: started } }, select: { id: true } })).map((l) => l.id));
    for (const t of ["search", "bulk", "series", "triggers", "usage", "settings"]) check(`Letters admin tab ${t} renders`, ok(await render(pages.lettersAdmin, `/documents/letters-admin?tab=${t}&q=${encodeURIComponent(tag)}`)));
    const found = await render(pages.lettersAdmin, `/documents/letters-admin?tab=search&q=${encodeURIComponent(`${tag}/EXP`)}`);
    check("Letter search finds by number", found.includes(`${tag}/EXP/${year}/007`));
    const ltCsv = await routes.lettersExport(new Request(`http://acme.test/documents/letters-admin/export?q=${encodeURIComponent(tag)}`));
    check("Letter search downloads as CSV", ltCsv.status === 200 && (await ltCsv.text()).includes(`${tag}/EXP/${year}/007`));

    // =========================================================================
    section("Assets · checklists, maintenance, pools, stock, disposal, stock-take");
    const cat = await prisma.assetCategory.create({ data: { tenantId, name: `${tag} Loaners` } });
    made.assetCats.push(cat.id);
    const type = await prisma.assetType.create({ data: { categoryId: cat.id, name: `${tag} Projector` } });
    const mk = async (n: number) => (await prisma.asset.create({ data: { tenantId, assetTypeId: type.id, assetTag: `${tag}-${n}`, name: `Projector ${n}`, purchaseCost: 40000, currentValue: 30000 } })).id;
    const [a1, a2, a3] = [await mk(1), await mk(2), await mk(3)];
    made.assets.push(a1, a2, a3);
    const asg = await prisma.assetAssignment.create({ data: { assetId: a1, employeeId: meera.employee!.id, assignedOn: new Date(Date.now() - 5 * 86_400_000) } });
    await prisma.asset.update({ where: { id: a1 }, data: { status: "ASSIGNED" } });

    await signInAs(hr.email);
    check("An assigner cannot open asset operations", (await render(pages.assetOps, "/assets/operations")) === "403");
    check("An assigner cannot create checklist templates", (await AO.saveChecklistTemplateAction({}, fd({ name: "x", kind: "RETURN", items: "*a" }))).ok === false);
    await signInAs(admin.email);
    check("A return checklist is set for the category", (await AO.saveChecklistTemplateAction({}, fd({ name: `${tag} Return`, kind: "RETURN", categoryId: cat.id, items: "*Lens cap present\n*Power cable present\nCarry case" }))).ok === true);
    check("Recovery is blocked until the return checklist is done", (await AS.recoverAssetAction({}, fd({ assignmentId: asg.id, conditionIn: "GOOD" }))).ok === false);
    check("An incomplete checklist is refused", (await AO.completeChecklistAction({}, form({ assignmentId: asg.id, kind: "RETURN", done: ["0"] }))).ok === false);
    check("The checklist is completed", (await AO.completeChecklistAction({}, form({ assignmentId: asg.id, kind: "RETURN", done: ["0", "1"] }))).ok === true);
    const recovered = await AS.recoverAssetAction({}, fd({ assignmentId: asg.id, conditionIn: "GOOD" }));
    check("…then the asset is recovered", recovered.ok === true, recovered.message);

    const rep = await AO.scheduleMaintenanceAction({}, fd({ assetId: a2, kind: "REPAIR", title: "Lamp flickers", scheduledOn: day(0), vendor: "FixIt" }));
    check("A repair is logged", rep.ok === true, rep.message);
    const repRow = await prisma.assetMaintenance.findFirstOrThrow({ where: { assetId: a2 } });
    check("Starting the repair takes the asset out of service", (await AO.progressMaintenanceAction({}, fd({ id: repRow.id, to: "IN_PROGRESS" }))).ok === true && (await prisma.asset.findUniqueOrThrow({ where: { id: a2 } })).status === "IN_REPAIR");
    check("…finished with its cost", (await AO.progressMaintenanceAction({}, fd({ id: repRow.id, to: "DONE", cost: "1800" }))).ok === true);
    check("…and the asset is back in stock", (await prisma.asset.findUniqueOrThrow({ where: { id: a2 } })).status === "AVAILABLE");
    check("Preventive maintenance with an interval is scheduled", (await AO.scheduleMaintenanceAction({}, fd({ assetId: a3, kind: "PREVENTIVE", title: "Clean filters", scheduledOn: day(1), intervalMonths: "6" }))).ok === true);
    const pm = await prisma.assetMaintenance.findFirstOrThrow({ where: { assetId: a3, kind: "PREVENTIVE" } });
    await AO.progressMaintenanceAction({}, fd({ id: pm.id, to: "DONE" }));
    check("…completing it books the next visit", (await prisma.assetMaintenance.count({ where: { assetId: a3, kind: "PREVENTIVE", status: "SCHEDULED" } })) === 1);

    check("A shared pool is created", (await AO.savePoolAction({}, fd({ name: `${tag} Pool`, maxDays: "5" }))).ok === true);
    const pool = await prisma.assetPool.findFirstOrThrow({ where: { tenantId, name: `${tag} Pool` } });
    made.pools.push(pool.id);
    check("An available asset joins the pool", (await AO.setAssetPoolAction({}, fd({ assetId: a2, poolId: pool.id }))).ok === true);
    await signInAs(meera.email);
    check("Bookings longer than the pool allows are refused", (await AO.reserveAssetAction({}, fd({ assetId: a2, fromDate: day(2), toDate: day(12), purpose: "Offsite" }))).ok === false);
    check("An employee books the pool asset", (await AO.reserveAssetAction({}, fd({ assetId: a2, fromDate: day(2), toDate: day(4), purpose: "Client demo" }))).ok === true);
    const booking = await prisma.assetReservation.findFirstOrThrow({ where: { assetId: a2, employeeId: meera.employee!.id } });
    check("…awaiting approval", booking.status === "REQUESTED");
    check("My bookings page shows it", (await render(pages.bookings, "/me/assets/bookings")).includes("Client demo"));
    await signInAs(sneha.email);
    check("An employee cannot approve bookings", (await AO.decideReservationAction({}, fd({ id: booking.id, decision: "approve" }))).ok === false);
    await signInAs(hr.email);
    check("The asset team approves it", (await AO.decideReservationAction({}, fd({ id: booking.id, decision: "approve" }))).ok === true);
    await signInAs(sneha.email);
    check("Overlapping dates are refused", (await AO.reserveAssetAction({}, fd({ assetId: a2, fromDate: day(3), toDate: day(5), purpose: "Workshop" }))).ok === false);
    await signInAs(hr.email);
    check("The asset is handed over and returned", (await AO.moveReservationAction({}, fd({ id: booking.id, to: "CHECKED_OUT" }))).ok === true && (await AO.moveReservationAction({}, fd({ id: booking.id, to: "RETURNED" }))).ok === true);
    await signInAs(meera.email);
    check("An employee cannot report someone else's asset lost", (await AO.reportLostAction({}, fd({ assignmentId: asg.id, circumstances: "Left it in a cab" }))).ok === false);

    await signInAs(admin.email);
    check("A minimum stock level is set", (await AO.saveStockThresholdAction({}, fd({ assetTypeId: type.id, minAvailable: "5" }))).ok === true);
    const levels = await svc.stockLevels(tenantId);
    check("…the type shows as low", levels.find((l) => l.assetTypeId === type.id)?.low === true);
    check("…and the nightly run alerts the asset team", (await svc.runLowStockAlerts(tenantId)) >= 1);
    await signInAs(hr.email);
    const disp = await AO.requestDisposalAction({}, fd({ assetId: a3, method: "SALE", reason: "End of life, replaced by new models", expectedValue: "5000" }));
    check("A disposal is requested", disp.ok === true, disp.message);
    const dRow = await prisma.assetDisposal.findFirstOrThrow({ where: { assetId: a3 } });
    check("…an asset manager approves it", (await decide(admin, "ASSET_DISPOSAL", dRow.id)).ok === true && (await prisma.assetDisposal.findUniqueOrThrow({ where: { id: dRow.id } })).status === "APPROVED");
    await signInAs(admin.email);
    check("…the disposal is completed", (await AO.completeDisposalAction({}, fd({ id: dRow.id, realisedValue: "4200", buyer: "Scrap Co" }))).ok === true);
    check("…and the asset is retired", (await prisma.asset.findUniqueOrThrow({ where: { id: a3 } })).status === "RETIRED");

    const rec = await AO.startReconciliationAction({}, fd({ name: `${tag} Stock-take` }));
    check("A stock-take starts with a snapshot of the register", rec.ok === true && !!rec.values?.id, rec.message);
    const recId = rec.values!.id!;
    made.recs.push(recId);
    const mineLines = await prisma.assetReconciliationLine.findMany({ where: { reconciliationId: recId, assetId: { in: [a1, a2] } } });
    check("…including the new assets", mineLines.length === 2);
    check("Closing with unchecked lines is refused", (await AO.closeReconciliationAction({}, fd({ id: recId }))).ok === false);
    await prisma.assetReconciliationLine.updateMany({ where: { reconciliationId: recId, assetId: { notIn: [a1, a2] } }, data: { found: true, checkedAt: new Date() } });
    check("A line is marked found", (await AO.checkLineAction({}, fd({ lineId: mineLines[0]!.id, found: "yes", location: "Store room" }))).ok === true);
    check("A line is marked missing", (await AO.checkLineAction({}, fd({ lineId: mineLines[1]!.id, found: "no", note: "Not on the shelf" }))).ok === true);
    check("The stock-take is closed", (await AO.closeReconciliationAction({}, fd({ id: recId }))).ok === true);
    for (const t of ["checklists", "maintenance", "pools", "stock", "disposal", "reconciliation"]) check(`Asset operations tab ${t} renders`, ok(await render(pages.assetOps, `/assets/operations?tab=${t}`)));
    check("The stock-take page renders", ok(await render(pages.stockTake, `/assets/operations/reconciliation/${recId}`, { id: recId })));
    for (const t of ["stock", "maintenance", "pools", "disposal"]) {
      const r = await routes.assetExport(new Request(`http://acme.test/assets/operations/export?tab=${t}`));
      check(`Asset ${t} CSV downloads`, r.status === 200);
    }
    const recCsv = await routes.assetExport(new Request(`http://acme.test/assets/operations/export?tab=reconciliation&id=${recId}`));
    check("The reconciliation report lists the missing asset", recCsv.status === 200 && (await recCsv.text()).includes(`${tag}-2`));

    // =========================================================================
    section("Nightly job");
    const job = await svc.runCasesDocsJob(tenantId, new Date());
    check("The cases & documents job runs every step", typeof job === "object" && job !== null);
  } finally {
    const unlinkFiles = async (where: object) => {
      const files = await prisma.storedFile.findMany({ where: { tenantId, createdAt: { gte: started }, ...where } });
      for (const f of files) await unlink(path.join(process.env.STORAGE_DIR ?? path.resolve(__dirname, "../.storage"), f.storageKey)).catch(() => {});
      await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    };
    await prisma.workflowRequest.deleteMany({ where: { tenantId, createdAt: { gte: started }, entityType: { in: ["KB_ARTICLE", "HELPDESK_CASE", "ER_FINDINGS", "ER_ACTION", "ER_RESOLUTION", "DOCUMENT_FOLDER_ACCESS", "LETTER_TEMPLATE", "ASSET_DISPOSAL"] } } });
    await prisma.helpdeskTicket.deleteMany({ where: { id: { in: made.tickets } } });
    await prisma.kbArticle.deleteMany({ where: { id: { in: made.kb } } });
    await prisma.kbCategory.deleteMany({ where: { id: { in: made.kbCats } } });
    await prisma.helpdeskSlaPolicy.deleteMany({ where: { id: { in: made.sla } } });
    await prisma.helpdeskTriageRule.deleteMany({ where: { id: { in: made.triage } } });
    await prisma.helpdeskEscalationRule.deleteMany({ where: { id: { in: made.escRules } } });
    await prisma.helpdeskCaseTemplate.deleteMany({ where: { id: { in: made.caseTpls } } });
    await prisma.erCase.deleteMany({ where: { id: { in: made.erCases } } });
    await prisma.signatureEnvelope.deleteMany({ where: { id: { in: made.envelopes } } });
    await prisma.employeeDocument.deleteMany({ where: { documentTypeId: { in: made.docTypes } } });
    await prisma.documentBulkUpload.deleteMany({ where: { documentTypeId: { in: made.docTypes } } });
    await prisma.documentFolder.deleteMany({ where: { id: { in: made.folders } } });
    await prisma.generatedDocument.deleteMany({ where: { id: { in: made.letters } } });
    await prisma.letterBatch.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.documentTemplate.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.letterNumberSeries.deleteMany({ where: { id: { in: made.series } } });
    await prisma.letterTrigger.deleteMany({ where: { tenantId, id: { notIn: triggersBefore.map((t) => t.id) } } });
    if (settingsBefore) {
      const { id: _i, tenantId: _t, updatedAt: _u, createdAt: _c, ...rest } = settingsBefore as typeof settingsBefore & { createdAt?: Date };
      await prisma.letterSettings.update({ where: { tenantId }, data: rest });
    } else await prisma.letterSettings.deleteMany({ where: { tenantId } });
    await prisma.assetReconciliation.deleteMany({ where: { id: { in: made.recs } } });
    await prisma.assetReservation.deleteMany({ where: { assetId: { in: made.assets } } });
    await prisma.assetMaintenance.deleteMany({ where: { assetId: { in: made.assets } } });
    await prisma.assetDisposal.deleteMany({ where: { assetId: { in: made.assets } } });
    await prisma.assetChecklistRun.deleteMany({ where: { assetId: { in: made.assets } } });
    await prisma.assetChecklistTemplate.deleteMany({ where: { tenantId, name: { startsWith: tag } } });
    await prisma.assetStockThreshold.deleteMany({ where: { tenantId, assetTypeId: { in: (await prisma.assetType.findMany({ where: { categoryId: { in: made.assetCats } }, select: { id: true } })).map((x) => x.id) } } });
    await prisma.asset.deleteMany({ where: { id: { in: made.assets } } });
    await prisma.assetPool.deleteMany({ where: { id: { in: made.pools } } });
    await prisma.assetCategory.deleteMany({ where: { id: { in: made.assetCats } } });
    await unlinkFiles({ relatedType: { in: ["SignatureEnvelope", "ErEvidence", "EmployeeDocument", "GeneratedDocument"] } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  report("Cases & documents");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
