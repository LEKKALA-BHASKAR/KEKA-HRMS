/**
 * Hiring flows that existed before but had no end-to-end test, driven through
 * the real server actions and pages:
 *  - requisitions: list, search, CSV export (audited), edit, archive/restore;
 *  - the candidate database and a job's pipeline board;
 *  - hiring flows: creating one and seeing it in settings;
 *  - jobs: editing details, holding (unpublishing) and reopening;
 *  - interviews: the list, booking links and cancelling them;
 *  - feedback: draft then submit, peers' feedback hidden until you submit,
 *    reminders, and the feedback gate on leaving a stage;
 *  - offers: redrafting after a decline or a withdrawal, the version trail,
 *    multi-level offer approval chains through Inbox › Offer approvals,
 *    pausing a chain, the offers filter, and the audit trail.
 * Everything is named "Smoke cover…" or uses @cover-smoke.test and is removed
 * at the end.
 */
import { signInAs, setTestHeaders, setTestSession, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

{
  const internal = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = internal._load;
  const classes: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : k === "default" ? classes : typeof k === "string" ? k : undefined) });
  internal._load = function cssModules(this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request.endsWith(".module.css") ? classes : prev.call(this, request, parent, isMain);
  };
}
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;

const prisma = new PrismaClient();
const DAY = 86_400_000;
const MAIL = "@cover-smoke.test";
const HOST = "acme.localhost:3100";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * DAY));
const local = (d: Date) => d.toISOString().slice(0, 16);

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const th = await import("../apps/web/src/app/actions/talent-hiring");
  const offers = await import("../apps/web/src/app/actions/hire-offers");
  const svc = await import("@keka/services");
  const reqExport = await import("../apps/web/src/app/(app)/hiring/requisitions/export/route");
  const hireExport = await import("../apps/web/src/app/(app)/hiring/insights/export/route");
  const { talentSources } = await import("../apps/web/src/app/(app)/inbox/_take/talent");
  const { getViewer } = await import("../apps/web/src/lib/context");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const byEmail = async (email: string) => {
    const u = await prisma.user.findFirstOrThrow({ where: { tenantId, email }, include: { employee: true } });
    return { user: u, emp: u.employee! };
  };
  const vikram = await byEmail("vikram.menon@acme.test");
  const sneha = await byEmail("sneha.reddy@acme.test");
  const meera = await byEmail("meera.krishnan@acme.test");
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId, name: "Platform Engineering" } });
  const started = new Date();
  const depthBefore = await prisma.hireDepthSetting.findUnique({ where: { tenantId } });

  const cleanup = async () => {
    const reqs = await prisma.requisition.findMany({ where: { tenantId, title: { startsWith: "Smoke cover" } }, select: { id: true } });
    const jobs = await prisma.job.findMany({ where: { tenantId, requisitionId: { in: reqs.map((r) => r.id) } }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    const cands = await prisma.candidate.findMany({ where: { tenantId, email: { endsWith: MAIL } }, select: { id: true } });
    const apps = await prisma.application.findMany({ where: { tenantId, OR: [{ jobId: { in: jobIds } }, { candidateId: { in: cands.map((c) => c.id) } }] }, select: { id: true } });
    const appIds = apps.map((a) => a.id);
    const ivIds = (await prisma.interview.findMany({ where: { applicationId: { in: appIds } }, select: { id: true } })).map((i) => i.id);
    await prisma.hireApprovalStep.deleteMany({ where: { tenantId, entityId: { in: [...appIds, ...reqs.map((r) => r.id)] } } });
    await prisma.hireApprovalRule.deleteMany({ where: { tenantId, name: { startsWith: "Smoke cover" } } });
    await prisma.workflowRequest.deleteMany({ where: { tenantId, entityType: "HIRE_REQUEST", createdAt: { gte: started } } });
    await prisma.hireAlert.deleteMany({ where: { tenantId, entityId: { in: [...appIds, ...ivIds, ...reqs.map((r) => r.id)] } } });
    await prisma.recruiterTask.deleteMany({ where: { tenantId, applicationId: { in: appIds } } });
    for (const m of [prisma.offerVersion, prisma.offerNegotiation, prisma.offerExtra, prisma.offerChecklistCheck, prisma.applicationDisposition, prisma.applicantPortalLink, prisma.applicantChangeRequest] as unknown as Array<{ deleteMany: (a: unknown) => Promise<unknown> }>) await m.deleteMany({ where: { applicationId: { in: appIds } } });
    await prisma.interviewEvent.deleteMany({ where: { interviewId: { in: ivIds } } });
    await prisma.interviewConsent.deleteMany({ where: { interviewId: { in: ivIds } } });
    await prisma.jobPostingMeta.deleteMany({ where: { jobId: { in: jobIds } } });
    for (const id of jobIds) await prisma.job.delete({ where: { id } }).catch(() => {});
    await prisma.candidate.deleteMany({ where: { id: { in: cands.map((c) => c.id) } } });
    await prisma.requisitionIntake.deleteMany({ where: { requisitionId: { in: reqs.map((r) => r.id) } } });
    await prisma.requisition.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
    await prisma.hiringFlow.deleteMany({ where: { tenantId, name: { startsWith: "Smoke cover" } } });
    await prisma.hireDepthSetting.deleteMany({ where: { tenantId } });
    if (depthBefore) await prisma.hireDepthSetting.create({ data: depthBefore as never });
    await prisma.emailOutbox.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
  };
  await cleanup();
  await prisma.hireDepthSetting.deleteMany({ where: { tenantId } });

  // Pages render as Next renders them: async server components resolved first.
  const React = (globalThis as unknown as { React: typeof import("react") }).React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
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
  const html = async (tree: unknown, pathname: string) => renderToStaticMarkup(
    React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(PathnameContext.Provider, { value: pathname }, (await resolve(tree)) as ReactNode))));
  const W = "../apps/web/src/app";
  const render = async (mod: string, pathname: string, params: Record<string, string> = {}, sp: SP = {}) => {
    try {
      const page = (await import(`${W}/${mod}`)).default as Page;
      return await html(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }), pathname);
    } catch (e) { return `ERROR ${(e as Error).message}`; }
  };
  const renders = async (label: string, mod: string, pathname: string, expect: string[], params: Record<string, string> = {}, sp: SP = {}, absent: string[] = []) => {
    const out = await render(mod, pathname, params, sp);
    const missing = expect.filter((e) => !out.includes(e));
    const present = absent.filter((e) => out.includes(e));
    check(label, !out.startsWith("ERROR") && missing.length === 0 && present.length === 0, out.startsWith("ERROR") ? out.slice(0, 240) : [missing.length ? `missing ${missing.join(", ")}` : "", present.length ? `should not show ${present.join(", ")}` : ""].join(" "));
    return out;
  };
  const appOf = (email: string) => prisma.application.findFirstOrThrow({ where: { tenantId, candidate: { email } }, include: { candidate: true } });
  const schedule = async (applicationId: string, title: string, panel: string[]) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ applicationId, title, date: inDays(1), time: "11:00", durationMinutes: "60", mode: "VIDEO" })) f.set(k, v);
    for (const p of panel) f.append("panel", p);
    const r = await hiring.scheduleInterviewAction({}, f);
    return { r, iv: await prisma.interview.findFirst({ where: { applicationId, title }, orderBy: { createdAt: "desc" } }) };
  };
  const REQ = (title: string, extra: Record<string, string | number | boolean> = {}) => fd({
    title, departmentId: dept.id, newHire: true, newPositions: 1, currency: "INR", salaryMin: 1800000, salaryMax: 2600000, salaryFrequency: "ANNUAL",
    description: "Builds and runs the platform's data services end to end.", justification: "Smoke cover", ...extra,
  });

  console.log("\nHiring coverage\n" + "=".repeat(72));
  try {
    // ---------------------------------------------------------------------
    section("Requisitions: list, search, export, edit, archive");
    await signInAs("priya.sharma@acme.test");
    await hiring.raiseRequisitionAction({}, REQ("Smoke cover data engineer zzcover"));
    await hiring.raiseRequisitionAction({}, REQ("Smoke cover analyst zzcover"));
    const reqA = await prisma.requisition.findFirstOrThrow({ where: { tenantId, title: "Smoke cover data engineer zzcover" } });
    const reqB = await prisma.requisition.findFirstOrThrow({ where: { tenantId, title: "Smoke cover analyst zzcover" } });
    await renders("The requisitions list finds both by search", "(app)/hiring/requisitions/page", "/hiring/requisitions", ["Smoke cover data engineer zzcover", "Smoke cover analyst zzcover"], {}, { q: "zzcover" });
    await renders("…and the search narrows the list", "(app)/hiring/requisitions/page", "/hiring/requisitions", ["Smoke cover analyst zzcover"], {}, { q: "analyst zzcover" }, ["Smoke cover data engineer zzcover"]);
    const exp = await reqExport.GET(new NextRequest(`http://${HOST}/hiring/requisitions/export?q=zzcover`));
    const expText = await exp.text();
    check("The filtered list exports as CSV", exp.status === 200 && expText.includes("Smoke cover data engineer zzcover") && expText.includes("Smoke cover analyst zzcover") && !expText.includes("Senior Backend Engineer"));
    check("…and the export is audited", (await prisma.auditLog.count({ where: { tenantId, action: "EXPORT", entityType: "Requisition", createdAt: { gte: started } } })) === 1);
    const edit = fd({ id: reqB.id });
    for (const [k, v] of REQ("Smoke cover analyst II zzcover", { newPositions: 3 }).entries()) edit.set(k, v);
    const edited = await hiring.updateRequisitionAction({}, edit);
    const reqB2 = await prisma.requisition.findUniqueOrThrow({ where: { id: reqB.id } });
    check("A pending requisition is edited by the person who raised it", edited.ok === true && reqB2.title === "Smoke cover analyst II zzcover" && reqB2.newPositions === 3, edited.message);
    check("…and the edit is audited with what changed", (await prisma.auditLog.count({ where: { tenantId, entityType: "Requisition", entityId: reqB.id, summary: { startsWith: "Edited" } } })) === 1);
    await signInAs("meera.krishnan@acme.test");
    check("An employee who did not raise it cannot edit it", (await hiring.updateRequisitionAction({}, edit)).ok === false);
    await signInAs("priya.sharma@acme.test");
    const arch = await hiring.archiveRequisitionAction({}, fd({ id: reqB.id }));
    check("A requisition is archived", arch.ok === true && !!(await prisma.requisition.findUniqueOrThrow({ where: { id: reqB.id } })).archivedAt, arch.message);
    await renders("…and shows under Archived", "(app)/hiring/requisitions/page", "/hiring/requisitions", ["Smoke cover analyst II zzcover"], {}, { view: "archived", q: "zzcover" });
    check("…where it cannot be edited", (await hiring.updateRequisitionAction({}, edit)).ok === false);
    const restore = await hiring.archiveRequisitionAction({}, fd({ id: reqB.id, archive: "0" }));
    check("…until it is restored", restore.ok === true && !(await prisma.requisition.findUniqueOrThrow({ where: { id: reqB.id } })).archivedAt, restore.message);

    // ---------------------------------------------------------------------
    section("Hiring flows");
    await signInAs("priya.sharma@acme.test");
    const short = await hiring.addHiringFlowAction({}, fd({ name: "Smoke cover flow", stages: "Applied" }));
    check("A flow needs at least two stages", short.ok === false);
    const flowRes = await hiring.addHiringFlowAction({}, fd({ name: "Smoke cover flow", stages: "Applied, Phone screen, Technical interview, Offer" }));
    const flow = await prisma.hiringFlow.findFirstOrThrow({ where: { tenantId, name: "Smoke cover flow" }, include: { stages: { orderBy: { sequence: "asc" } } } });
    check("A hiring flow is created with its stages in order", flowRes.ok === true && flow.stages.map((s) => s.name).join("|") === "Applied|Phone screen|Technical interview|Offer", flowRes.message);
    check("…interview stages need feedback to leave", flow.stages.find((s) => s.name === "Technical interview")!.requireScorecard && !flow.stages[0]!.requireScorecard);
    check("…and its creation is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "HiringFlow", entityId: flow.id } })) === 1);
    await renders("The stage settings list the new flow", "(app)/hiring/settings/stages/page", "/hiring/settings/stages", ["Smoke cover flow", "Technical interview"], {}, { flow: flow.id });

    // ---------------------------------------------------------------------
    section("Jobs: edit, hold, reopen");
    await signInAs("vikram.menon@acme.test");
    await hiring.decideRequisitionAction({}, fd({ id: reqA.id, decision: "approve" }));
    await signInAs("priya.sharma@acme.test");
    await hiring.openJobAction({}, fd({ requisitionId: reqA.id, hiringManagerId: sneha.emp.id }));
    const job = await prisma.job.findFirstOrThrow({ where: { requisitionId: reqA.id } });
    await prisma.job.update({ where: { id: job.id }, data: { flowId: flow.id } });
    const shortJd = await hiring.saveJobDetailsAction({}, fd({ jobId: job.id, description: "Too short" }));
    check("A job description must be meaningful", shortJd.ok === false);
    const jd = await hiring.saveJobDetailsAction({}, fd({ jobId: job.id, description: "Design, build and run batch and streaming pipelines for the platform zzcover.", requirements: "SQL, Python, Spark", minExperienceYears: 3 }));
    const job2 = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    check("A job's details are edited (and audited)", jd.ok === true && job2.requirements === "SQL, Python, Spark" && Number(job2.minExperienceYears) === 3 && (await prisma.auditLog.count({ where: { tenantId, entityType: "Job", entityId: job.id, summary: "Edited job details" } })) === 1, jd.message);
    const hold = await hiring.jobStatusAction({}, fd({ jobId: job.id, status: "ON_HOLD" }));
    check("Putting a job on hold takes it off the careers site", hold.ok === true && !(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).isPublished, hold.message);
    setTestHeaders({ host: HOST, "x-forwarded-for": "203.0.113.200" });
    setTestSession(null);
    await renders("…visitors no longer see it", "careers/page", "/careers", ["Senior Backend Engineer"], {}, {}, ["Smoke cover data engineer zzcover"]);
    await signInAs("priya.sharma@acme.test");
    const reopen = await hiring.jobStatusAction({}, fd({ jobId: job.id, status: "OPEN" }));
    check("Reopening publishes it again", reopen.ok === true && (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).isPublished, reopen.message);
    check("…each change audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Job", entityId: job.id, summary: { startsWith: "Job set to" } } })) === 2);
    check("A job's status cannot be set to nonsense", (await hiring.jobStatusAction({}, fd({ jobId: job.id, status: "DELETED" }))).ok === false);

    // ---------------------------------------------------------------------
    section("Candidates and the pipeline");
    for (const [first, last, email] of [["Smoke", "Cover One", `one${MAIL}`], ["Smoke", "Cover Two", `two${MAIL}`], ["Smoke", "Cover Three", `three${MAIL}`]] as const) {
      await hiring.addCandidateAction({}, fd({ jobId: job.id, firstName: first, lastName: last, email, currentTitle: "Spark engineer", currentEmployer: "Zzcoverco" }));
    }
    const a1 = await appOf(`one${MAIL}`), a2 = await appOf(`two${MAIL}`), a3 = await appOf(`three${MAIL}`);
    check("Candidates are added into the job's flow", a1.currentStageId === flow.stages[0]!.id && a3.jobId === job.id);
    await renders("The job's pipeline board shows them by stage", "(app)/hiring/jobs/[id]/page", `/hiring/jobs/${job.id}`, ["Cover One", "Cover Two", "Cover Three", "Applied"], { id: job.id });
    await renders("The candidate database finds them across jobs", "(app)/hiring/candidates/page", "/hiring/candidates", ["candidate-table", "Cover One", "Cover Three"], {}, { q: "spark AND zzcoverco" });
    await renders("…and not when the search excludes them", "(app)/hiring/candidates/page", "/hiring/candidates", [], {}, { q: "spark NOT zzcoverco" }, ["Cover One"]);
    await renders("A candidate's record shows their applications", "(app)/hiring/candidates/[id]/page", `/hiring/candidates/${a1.candidateId}`, ["Smoke cover data engineer zzcover"], { id: a1.candidateId });
    const candCsv = await hireExport.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=candidates&days=30`));
    check("The candidate database exports as CSV", candCsv.status === 200 && (await candCsv.text()).includes(`two${MAIL}`));
    check("Adding a candidate is audited", (await prisma.auditLog.count({ where: { tenantId, createdAt: { gte: started }, OR: [{ entityId: a1.id }, { entityId: a1.candidateId }] } })) >= 1);

    // ---------------------------------------------------------------------
    section("Interviews: list, booking links, feedback");
    const tech = flow.stages.find((s) => s.name === "Technical interview")!;
    const offerStage = flow.stages.find((s) => s.name === "Offer")!;
    for (const a of [a1, a2, a3]) await hiring.moveStageAction({}, fd({ applicationId: a.id, stageId: tech.id }));
    const { iv } = await schedule(a1.id, "Smoke cover: Technical", [sneha.emp.id, meera.emp.id]);
    check("An interview is scheduled with a two-person panel", !!iv && (await prisma.interviewPanelist.count({ where: { interviewId: iv.id } })) === 2);
    check("…and the scheduling is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Interview", entityId: iv!.id, action: "CREATE" } })) === 1);
    await renders("The interviews list shows it", "(app)/hiring/interviews/page", "/hiring/interviews", ["Smoke cover: Technical", "Cover One"]);
    const slot = fd({ applicationId: a2.id, title: "Smoke cover: Screen", mode: "VIDEO", durationMinutes: 30, panelIds: sneha.emp.id });
    slot.append("slots", local(new Date(Date.now() + 3 * DAY)));
    slot.append("slots", local(new Date(Date.now() + 4 * DAY)));
    const sent = await th.offerSlotsAction({}, slot);
    const slotRow = await prisma.interviewSlotOffer.findFirstOrThrow({ where: { applicationId: a2.id } });
    check("A booking link with slots is sent to a candidate", sent.ok === true && slotRow.status === "OPEN", sent.message);
    const cancelled = await th.cancelSlotOfferAction({}, fd({ id: slotRow.id, applicationId: a2.id }));
    check("…and can be cancelled", cancelled.ok === true && (await prisma.interviewSlotOffer.findUniqueOrThrow({ where: { id: slotRow.id } })).status === "CANCELLED", cancelled.message);
    check("…only once", (await th.cancelSlotOfferAction({}, fd({ id: slotRow.id, applicationId: a2.id }))).ok === false);

    // The interview has happened.
    await prisma.interview.update({ where: { id: iv!.id }, data: { scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
    const kit = await svc.interviewKit(job.id);
    const ratings = JSON.stringify(kit.flatMap((sec) => sec.skills.map((k) => ({ section: sec.section, skill: k.name, rating: 4, comment: null }))));
    const card = (notes: string, intent: string) => fd({ interviewId: iv!.id, recommendation: "HIRE", notes, ratings, intent, biasReviewed: "1" });
    const blocked = await hiring.moveStageAction({}, fd({ applicationId: a1.id, stageId: offerStage.id }));
    check("A candidate cannot leave an interview stage before the feedback is in", blocked.ok === false && (await prisma.application.findUniqueOrThrow({ where: { id: a1.id } })).currentStageId === tech.id, blocked.message);
    const remind = await hiring.remindPanelistAction({}, fd({ interviewId: iv!.id, employeeId: meera.emp.id }));
    check("The recruiter reminds a panellist whose feedback is outstanding", remind.ok === true && (await prisma.notification.count({ where: { tenantId, userId: meera.user.id, createdAt: { gte: started } } })) >= 1, remind.message);
    check("…at most once a day", (await hiring.remindPanelistAction({}, fd({ interviewId: iv!.id, employeeId: meera.emp.id }))).ok === false);
    check("…and not someone who is not on the panel", (await hiring.remindPanelistAction({}, fd({ interviewId: iv!.id, employeeId: vikram.emp.id }))).ok === false);
    await signInAs("sneha.reddy@acme.test");
    const sn = await hiring.saveScorecardAction({}, card("Sneha zzsecret: excellent on pipeline design and data modelling.", "submit"));
    check("One panellist submits", sn.ok === true, sn.message);
    await signInAs("meera.krishnan@acme.test");
    const draft = await hiring.saveScorecardAction({}, card("Meera draft: solid on SQL, need to think about Spark depth.", "draft"));
    const myCard = await prisma.scorecard.findFirstOrThrow({ where: { interviewId: iv!.id, panelistId: meera.emp.id } });
    check("Another saves a draft first", draft.ok === true && myCard.status === "DRAFT", draft.message);
    await renders("…and cannot see the first panellist's feedback until she submits hers", "(app)/hiring/applications/[id]/page", `/hiring/applications/${a1.id}`, ["Visible after you submit yours", "Continue feedback (draft)"], { id: a1.id }, { tab: "feedback" }, ["Sneha zzsecret"]);
    const sub = await hiring.saveScorecardAction({}, card("Meera final: solid on SQL and Spark; would hire for this level.", "submit"));
    check("The draft is submitted", sub.ok === true && (await prisma.scorecard.findUniqueOrThrow({ where: { id: myCard.id } })).status === "SUBMITTED", sub.message);
    await renders("…after which both are visible to her", "(app)/hiring/applications/[id]/page", `/hiring/applications/${a1.id}`, ["Sneha zzsecret", "Meera final"], { id: a1.id }, { tab: "feedback" });
    check("…a submitted card cannot be changed", (await hiring.saveScorecardAction({}, card("Meera change: actually no hire after all, on reflection.", "submit"))).ok === false);
    check("Feedback saves and submissions are audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Scorecard", entityId: iv!.id, createdAt: { gte: started } } })) === 3);
    await signInAs("priya.sharma@acme.test");
    check("No reminder once feedback is in", (await hiring.remindPanelistAction({}, fd({ interviewId: iv!.id, employeeId: meera.emp.id }))).ok === false);
    await renders("The recruiter sees the panel's timeline and scores", "(app)/hiring/applications/[id]/page", `/hiring/applications/${a1.id}`, ["Smoke cover: Technical", "Sneha zzsecret", "Average Rating"], { id: a1.id }, { tab: "feedback" });
    const moved = await hiring.moveStageAction({}, fd({ applicationId: a1.id, stageId: offerStage.id }));
    check("With the feedback in, the candidate moves on", moved.ok === true, moved.message);

    // ---------------------------------------------------------------------
    section("Offer approval chains");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot configure offer approval chains", (await th.saveApprovalRuleAction({}, fd({ kind: "OFFER", name: "Smoke cover x", approverUserIds: vikram.user.id }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    const rule = fd({ kind: "OFFER", name: "Smoke cover: platform offers", departmentId: dept.id, priority: 1 });
    rule.append("approverUserIds", sneha.user.id); rule.append("approverUserIds", vikram.user.id);
    const ruleRes = await th.saveApprovalRuleAction({}, rule);
    const ruleRow = await prisma.hireApprovalRule.findFirstOrThrow({ where: { tenantId, name: "Smoke cover: platform offers" } });
    check("HR adds a two-level offer chain for Platform Engineering", ruleRes.ok === true, ruleRes.message);
    await signInAs("priya.sharma@acme.test");
    const drafted = await hiring.draftOfferAction({}, fd({ applicationId: a1.id, annualCtc: 2400000, proposedJoiningDate: inDays(45), expiresOn: inDays(10), breakupMode: "STRUCTURE" }));
    const steps = await prisma.hireApprovalStep.findMany({ where: { tenantId, kind: "OFFER", entityId: a1.id }, orderBy: { sequence: "asc" } });
    check("A drafted offer is routed along the chain", drafted.ok === true && steps.length === 2 && steps[0]!.approverUserId === sneha.user.id && steps[0]!.status === "PENDING" && steps[1]!.status === "WAITING", `${drafted.message} ${steps.map((s) => s.status).join(",")}`);
    await renders("The offers list filters to those awaiting approval", "(app)/hiring/offers/page", "/hiring/offers", ["Cover One"], {}, { status: "PENDING_APPROVAL" });
    await signInAs("vikram.menon@acme.test");
    check("The general approve button defers to the chain", (await hiring.offerOpAction({}, fd({ applicationId: a1.id, op: "approve" }))).ok === false);
    check("…and level 2 cannot decide before level 1", (await th.decideOfferStepAction({}, fd({ applicationId: a1.id, decision: "approve" }))).ok === false);
    await signInAs("sneha.reddy@acme.test");
    const inbox1 = (await talentSources((await getViewer())!)).find((s) => s.key === "hire-approvals");
    check("It waits in the first approver's Inbox › Offer approvals", !!inbox1 && (await inbox1.list()).some((i) => i.id === a1.id));
    check("Rejecting needs a reason", (await th.decideOfferStepAction({}, fd({ applicationId: a1.id, decision: "reject" }))).ok === false);
    const l1 = await th.decideOfferStepAction({}, fd({ applicationId: a1.id, decision: "approve" }));
    check("Level 1 approves and it moves on", l1.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: a1.id } })).status === "PENDING_APPROVAL", l1.message);
    await signInAs("vikram.menon@acme.test");
    const inbox2 = (await talentSources((await getViewer())!)).find((s) => s.key === "hire-approvals");
    check("…to the second approver's inbox", !!inbox2 && (await inbox2.list()).some((i) => i.id === a1.id));
    const l2 = await th.decideOfferStepAction({}, fd({ applicationId: a1.id, decision: "approve" }));
    check("The last level approves the offer", l2.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: a1.id } })).status === "APPROVED", l2.message);
    check("Each level's decision is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Offer", entityId: a1.id, action: "APPROVE" } })) === 2);
    const pause = await th.toggleApprovalRuleAction({}, fd({ id: ruleRow.id }));
    check("The chain can be paused", pause.ok === true && !(await prisma.hireApprovalRule.findUniqueOrThrow({ where: { id: ruleRow.id } })).isActive, pause.message);
    await signInAs("priya.sharma@acme.test");
    await hiring.moveStageAction({}, fd({ applicationId: a2.id, stageId: offerStage.id, override: "on" })).catch(() => null);
    const d2 = await hiring.draftOfferAction({}, fd({ applicationId: a2.id, annualCtc: 2200000, proposedJoiningDate: inDays(45), expiresOn: inDays(10), breakupMode: "STRUCTURE" }));
    check("With it paused, offers use the standard approval", d2.ok === true && (await prisma.hireApprovalStep.count({ where: { tenantId, kind: "OFFER", entityId: a2.id } })) === 0, d2.message);
    await signInAs("vikram.menon@acme.test");
    await th.toggleApprovalRuleAction({}, fd({ id: ruleRow.id }));
    check("…and resumed", (await prisma.hireApprovalRule.findUniqueOrThrow({ where: { id: ruleRow.id } })).isActive);
    const o2 = await prisma.offer.findUniqueOrThrow({ where: { applicationId: a2.id } });
    if (o2.status === "PENDING_APPROVAL") await hiring.offerOpAction({}, fd({ applicationId: a2.id, op: "approve" }));
    const apprCsv = await hireExport.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=approvals&days=30`));
    check("The approvals report lists each chain level and how long it took", apprCsv.status === 200 && /OFFER chain \(level 2\)/.test(await apprCsv.text()));

    // ---------------------------------------------------------------------
    section("Offers: redraft after a decline or withdrawal, version trail");
    await signInAs("priya.sharma@acme.test");
    const ext = await hiring.offerOpAction({}, fd({ applicationId: a1.id, op: "extend" }));
    check("The approved offer is extended", ext.ok === true, ext.message);
    check("A redraft is refused while the offer is out", (await hiring.draftOfferAction({}, fd({ applicationId: a1.id, annualCtc: 2600000, proposedJoiningDate: inDays(45), expiresOn: inDays(10), breakupMode: "STRUCTURE" }))).ok === false);
    check("Declining needs a reason", (await hiring.offerOpAction({}, fd({ applicationId: a1.id, op: "declined" }))).ok === false);
    const dec = await hiring.offerOpAction({}, fd({ applicationId: a1.id, op: "declined", reason: "Wanted a higher base" }));
    check("The candidate declines", dec.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: a1.id } })).status === "DECLINED", dec.message);
    const redraft = await hiring.draftOfferAction({}, fd({ applicationId: a1.id, annualCtc: 2600000, proposedJoiningDate: inDays(45), expiresOn: inDays(10), breakupMode: "STRUCTURE" }));
    const o1 = await prisma.offer.findUniqueOrThrow({ where: { applicationId: a1.id } });
    check("After a decline a new offer can be drafted at new terms", redraft.ok === true && Number(o1.annualCtc) === 2600000 && ["DRAFT", "PENDING_APPROVAL"].includes(o1.status), redraft.message);
    const trail = await prisma.offerVersion.findMany({ where: { applicationId: a1.id }, orderBy: { version: "asc" } });
    check("…the old terms are kept in the version trail", trail.map((v) => v.event).join(",") === "DRAFTED,EXTENDED,DECLINED,DRAFTED" && Number(trail[0]!.annualCtc) === 2400000, trail.map((v) => v.event).join(","));
    check("…and the new offer goes through the chain again", (await prisma.hireApprovalStep.count({ where: { tenantId, kind: "OFFER", entityId: a1.id, status: "PENDING" } })) === 1);
    await renders("The offer page lists the versions", "(app)/hiring/offers/[id]/page", `/hiring/offers/${a1.id}`, ["offer-versions", "Declined", "Extended"], { id: a1.id });
    const wd = await offers.withdrawOfferAction({}, fd({ applicationId: a2.id, reason: "Smoke cover: budget moved" }));
    check("An approved offer is withdrawn", wd.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: a2.id } })).status === "WITHDRAWN", wd.message);
    const re2 = await hiring.draftOfferAction({}, fd({ applicationId: a2.id, annualCtc: 2100000, proposedJoiningDate: inDays(60), expiresOn: inDays(14), breakupMode: "STRUCTURE" }));
    check("…and redrafted later", re2.ok === true && Number((await prisma.offer.findUniqueOrThrow({ where: { applicationId: a2.id } })).annualCtc) === 2100000, re2.message);
    const offCsv = await hireExport.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=offers&days=30`));
    check("The offers report exports", offCsv.status === 200 && (await offCsv.text()).includes("Cover One"));
    check("Drafting, extending and responding are all audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Offer", entityId: a1.id, createdAt: { gte: started } } })) >= 5);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  report("Hiring coverage");
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
