/**
 * Hire depth, end to end through the real server actions, permission checks
 * and the generic workflow engine:
 *  - hiring SLAs, the disposition reason library, requisition intake;
 *  - recruiter tasks and their sign-off;
 *  - stage editing, entry criteria and approval-gated stages;
 *  - sourcing channels and campaigns (approved), attribution rules, public
 *    applications carrying campaign/UTM tracking, source re-attribution;
 *  - sourcing projects, saved boolean searches, tag rules, profile capture,
 *    consent and outreach cadences, agencies, import with field mapping;
 *  - talent pool settings, segments, approval, expiry, silver medallists and
 *    re-engagement;
 *  - duplicate merge, ownership transfer, workload balancing, communication
 *    history and document verification, referrals and their bonus;
 *  - interview plans (signed off), panel rules and responses, reschedules in
 *    the candidate's time zone, no-shows, cancellations, recording consent,
 *    capacity, bias prompts, weighted scores and reopening feedback;
 *  - offer clauses and language, the pre-extend checklist, versions,
 *    negotiations, compensation confirmation, revisions and withdrawal;
 *  - career content with approvals and versions, site SEO/accessibility/
 *    analytics with rollback, job SEO/translations/JSON-LD, job alerts, the
 *    talent community and the applicant portal;
 *  - hiring alerts, the exception dashboard, insights and CSV exports.
 * Everything is named "Smoke depth…" or uses @depth-smoke.test and is removed
 * at the end; company-wide settings are put back.
 */
import { signInAs, setTestHeaders, setTestSession, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import Module from "node:module";
import { unlink } from "node:fs/promises";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";

// CSS modules come out of the runtime stub without a default export; serve a
// proxy whose every class name is itself, so pages render.
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
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * DAY));
const MAIL = "@depth-smoke.test";
const HOST = "acme.localhost:3100";

async function denied(fn: () => Promise<unknown>) { try { await fn(); return false; } catch { return true; } }

async function main() {
  (globalThis as { React?: unknown }).React = await import("react");
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const ops = await import("../apps/web/src/app/actions/hire-ops");
  const src = await import("../apps/web/src/app/actions/hire-sourcing");
  const ivs = await import("../apps/web/src/app/actions/hire-interviews");
  const offers = await import("../apps/web/src/app/actions/hire-offers");
  const careers = await import("../apps/web/src/app/actions/hire-careers");
  const talent = await import("../apps/web/src/app/actions/talent-hiring");
  const portal = await import("../apps/web/src/app/careers/portal-actions");
  const apply = await import("../apps/web/src/app/careers/actions");
  const wf = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("@keka/services");
  const exportRoute = await import("../apps/web/src/app/(app)/hiring/insights/export/route");
  const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");
  const { getViewer } = await import("../apps/web/src/lib/context");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const byEmail = async (email: string) => {
    const u = await prisma.user.findFirstOrThrow({ where: { tenantId, email }, include: { employee: true } });
    return { user: u, emp: u.employee! };
  };
  const vikram = await byEmail("vikram.menon@acme.test");
  const priya = await byEmail("priya.sharma@acme.test");
  const sneha = await byEmail("sneha.reddy@acme.test");
  const meera = await byEmail("meera.krishnan@acme.test");
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId, name: "Platform Engineering" } });
  const started = new Date();
  const before = {
    depth: await prisma.hireDepthSetting.findUnique({ where: { tenantId } }),
    config: await prisma.careerSiteConfig.findUnique({ where: { tenantId } }),
    site: await prisma.careerSiteSetting.findUnique({ where: { tenantId } }),
    capacity: await prisma.interviewerCapacity.findUnique({ where: { tenantId_employeeId: { tenantId, employeeId: meera.emp.id } } }),
  };

  const cleanup = async () => {
    const reqs = await prisma.requisition.findMany({ where: { tenantId, title: { startsWith: "Smoke depth" } }, select: { id: true } });
    const jobs = await prisma.job.findMany({ where: { tenantId, OR: [{ requisitionId: { in: reqs.map((r) => r.id) } }, { title: { startsWith: "Smoke depth" } }] }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    const cands = await prisma.candidate.findMany({ where: { tenantId, email: { endsWith: MAIL } }, select: { id: true } });
    const candIds = cands.map((c) => c.id);
    const apps = await prisma.application.findMany({ where: { tenantId, OR: [{ jobId: { in: jobIds } }, { candidateId: { in: candIds } }] }, select: { id: true } });
    const appIds = apps.map((a) => a.id);
    const ivIds = (await prisma.interview.findMany({ where: { applicationId: { in: appIds } }, select: { id: true } })).map((i) => i.id);
    await prisma.workflowRequest.deleteMany({ where: { tenantId, entityType: "HIRE_REQUEST", OR: [{ createdAt: { gte: started } }, { title: { contains: "smoke depth", mode: "insensitive" } }] } });
    await prisma.recruiterTask.deleteMany({ where: { tenantId, OR: [{ createdAt: { gte: started } }, { title: { contains: "smoke depth", mode: "insensitive" } }, { applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } });
    await prisma.hireAlert.deleteMany({ where: { tenantId, OR: [{ createdAt: { gte: started } }, { entityId: { in: [...appIds, ...ivIds, ...reqs.map((r) => r.id)] } }] } });
    for (const m of [prisma.offerVersion, prisma.offerNegotiation, prisma.offerExtra, prisma.offerChecklistCheck, prisma.applicationDisposition, prisma.applicantPortalLink, prisma.applicantChangeRequest] as unknown as Array<{ deleteMany: (a: unknown) => Promise<unknown> }>) await m.deleteMany({ where: { applicationId: { in: appIds } } });
    await prisma.interviewEvent.deleteMany({ where: { interviewId: { in: ivIds } } });
    await prisma.interviewConsent.deleteMany({ where: { interviewId: { in: ivIds } } });
    await prisma.interviewPlan.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.jobPostingMeta.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.careerSiteVisit.deleteMany({ where: { tenantId, OR: [{ createdAt: { gte: started } }, { jobId: { in: jobIds } }] } });
    await prisma.jobAlertSubscription.deleteMany({ where: { tenantId, email: { endsWith: MAIL } } });
    await prisma.sourcingCampaign.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.sourcingProject.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.savedSourcingSearch.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.sourceAttributionRule.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.prospectTagRule.deleteMany({ where: { tenantId, tag: { startsWith: "smoke-depth" } } });
    await prisma.outreachCadence.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.recruitmentAgency.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.sourcingChannel.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.candidateMergeLog.deleteMany({ where: { tenantId, mergedEmail: { endsWith: MAIL } } });
    await prisma.candidateCommunication.deleteMany({ where: { candidateId: { in: candIds } } });
    await prisma.candidateDocument.deleteMany({ where: { candidateId: { in: candIds } } });
    for (const id of jobIds) await prisma.job.delete({ where: { id } }).catch(() => {});
    await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
    await prisma.requisitionIntake.deleteMany({ where: { requisitionId: { in: reqs.map((r) => r.id) } } });
    await prisma.requisition.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
    await prisma.hiringFlow.deleteMany({ where: { tenantId, name: { startsWith: "Smoke depth" } } });
    await prisma.talentPool.deleteMany({ where: { tenantId, OR: [{ name: { startsWith: "Smoke depth" } }, { createdAt: { gte: started } }] } });
    await prisma.dispositionReason.deleteMany({ where: { tenantId, label: { startsWith: "Smoke depth" } } });
    await prisma.offerClause.deleteMany({ where: { tenantId, title: { startsWith: "Smoke depth" } } });
    await prisma.interviewGuide.deleteMany({ where: { tenantId, title: { startsWith: "Smoke depth" } } });
    await prisma.questionBankItem.deleteMany({ where: { tenantId, text: { startsWith: "Smoke depth" } } });
    await prisma.careerContent.deleteMany({ where: { tenantId, title: { startsWith: "Smoke depth" } } });
    await prisma.careerSiteSnapshot.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    const files = await prisma.storedFile.findMany({ where: { tenantId, createdAt: { gte: started } } });
    for (const x of files) await unlink(path.join(STORAGE_DIR, x.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((x) => x.id) } } });
    await prisma.hireDepthSetting.deleteMany({ where: { tenantId } });
    if (before.depth) await prisma.hireDepthSetting.create({ data: before.depth as never });
    await prisma.careerSiteConfig.deleteMany({ where: { tenantId } });
    if (before.config) await prisma.careerSiteConfig.create({ data: before.config as never });
    await prisma.careerSiteSetting.deleteMany({ where: { tenantId } });
    if (before.site) await prisma.careerSiteSetting.create({ data: before.site });
    await prisma.interviewerCapacity.deleteMany({ where: { tenantId, employeeId: meera.emp.id } });
    if (before.capacity) await prisma.interviewerCapacity.create({ data: before.capacity });
    await prisma.emailOutbox.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
  };
  await cleanup();
  // Start from the defaults so the job posts straight to the careers site.
  await prisma.hireDepthSetting.deleteMany({ where: { tenantId } });

  // Every hiring request is decided by whoever the engine routed it to.
  const hireReq = (kind: string, entityId: string) => prisma.workflowRequest.findFirst({ where: { tenantId, entityType: "HIRE_REQUEST", category: kind, entityId }, orderBy: { createdAt: "desc" } });
  async function decide(requestId: string, approve = true): Promise<string> {
    for (let i = 0; i < 4; i++) {
      const tk = await prisma.workflowTask.findFirst({ where: { requestId, status: "PENDING" } });
      if (!tk) break;
      const u = await prisma.user.findUniqueOrThrow({ where: { id: tk.approverUserId } });
      await signInAs(u.email);
      const r = await wf.decideWorkflowTaskAction({}, fd({ taskId: tk.id, decision: approve ? "approve" : "reject", comment: "Smoke depth decision" }));
      if (!r.ok) return `FAILED ${r.message}`;
    }
    return (await prisma.workflowRequest.findUniqueOrThrow({ where: { id: requestId } })).status;
  }
  const approveKind = async (kind: string, entityId: string, approve = true) => {
    const r = await hireReq(kind, entityId);
    return r ? decide(r.id, approve) : "NO_REQUEST";
  };
  const approverOf = async (kind: string, entityId: string) => {
    const r = await hireReq(kind, entityId);
    const tk = r ? await prisma.workflowTask.findFirst({ where: { requestId: r.id } }) : null;
    return tk?.approverUserId ?? null;
  };

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
  const renders = async (label: string, mod: string, pathname: string, expect: string[], params: Record<string, string> = {}, sp: SP = {}) => {
    const out = await render(mod, pathname, params, sp);
    const missing = expect.filter((e) => !out.includes(e));
    check(label, !out.startsWith("ERROR") && missing.length === 0, out.startsWith("ERROR") ? out.slice(0, 240) : missing.length ? `missing ${missing.join(", ")}` : "");
    return out;
  };
  const csv = async (kind: string) => {
    const res = await exportRoute.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=${kind}&days=365`));
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  };
  let ip = 10;
  const asPublic = () => setTestHeaders({ host: HOST, "x-forwarded-for": `203.0.113.${ip++}` });
  const file = (data: Buffer, name: string, type: string) => new File([new Uint8Array(data)], name, { type });

  const flowSetup = async (jobId: string) => {
    const def = await prisma.hiringFlow.findFirstOrThrow({ where: { tenantId, isDefault: true }, include: { stages: { orderBy: { sequence: "asc" } } } });
    const flow = await prisma.hiringFlow.create({ data: { tenantId, name: "Smoke depth flow", stages: { create: def.stages.map((s) => ({ name: s.name, sequence: s.sequence, stageKind: s.stageKind, requireScorecard: s.requireScorecard })) } }, include: { stages: { orderBy: { sequence: "asc" } } } });
    await prisma.job.update({ where: { id: jobId }, data: { flowId: flow.id } });
    return flow;
  };
  const stagesOf = async (flowId: string) => prisma.hiringStage.findMany({ where: { flowId }, orderBy: { sequence: "asc" } });
  const appOf = (email: string) => prisma.application.findFirstOrThrow({ where: { tenantId, candidate: { email } }, include: { candidate: true }, orderBy: { appliedAt: "desc" } });
  const schedule = async (applicationId: string, title: string, dayOffset: number, time: string, panel: string[]) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ applicationId, title, date: inDays(dayOffset), time, durationMinutes: "60", mode: "VIDEO" })) f.set(k, v);
    for (const p of panel) f.append("panel", p);
    const r = await hiring.scheduleInterviewAction({}, f);
    const iv = await prisma.interview.findFirst({ where: { applicationId, title }, orderBy: { createdAt: "desc" } });
    return { r, iv };
  };
  const OPS = (over: Record<string, string | number | boolean> = {}) => fd({
    screenSlaHours: 48, feedbackSlaHours: 24, offerResponseSlaHours: 120, requisitionApprovalSlaHours: 48, requisitionMaxAgeDays: 60, noShowLimit: 2, consentValidityDays: 365, reactivationAfterDays: 90,
    intakeQuestions: "Smoke depth: Why is this role open?\nSmoke depth: What does success look like in 90 days?",
    offerChecklist: "Smoke depth: background check cleared\nSmoke depth: budget confirmed with finance",
    biasTerms: "rockstar, digital native", ...over,
  });

  console.log("\nHire depth\n" + "=".repeat(72));
  try {
    // ---------------------------------------------------------------------
    section("Settings: SLAs, intake, checklist, bias terms and the reason library");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot change hiring operations settings", await denied(() => ops.saveHireOpsSettingsAction({}, OPS())));
    await signInAs("priya.sharma@acme.test");
    const badOps = await ops.saveHireOpsSettingsAction({}, OPS({ noShowLimit: 50 }));
    check("Out-of-range SLAs are refused", badOps.ok === false && !!badOps.errors?.noShowLimit, badOps.message);
    const okOps = await ops.saveHireOpsSettingsAction({}, OPS());
    const cfg = await svc.hireDepthConfig(tenantId);
    check("HR saves SLAs, intake questions, the offer checklist and bias terms", okOps.ok === true && cfg.screenSlaHours === 48 && cfg.intakeQuestions.length === 2 && cfg.offerChecklist.length === 2 && cfg.biasTerms.includes("rockstar"), okOps.message);
    await ops.saveDispositionReasonAction({}, fd({ label: "Smoke depth: skills gap", kind: "REJECT" }));
    await ops.saveDispositionReasonAction({}, fd({ label: "Smoke depth: accepted another offer", kind: "WITHDRAW" }));
    const dupReason = await ops.saveDispositionReasonAction({}, fd({ label: "Smoke depth: skills gap", kind: "REJECT" }));
    const rejectReason = await prisma.dispositionReason.findFirstOrThrow({ where: { tenantId, label: "Smoke depth: skills gap" } });
    const withdrawReason = await prisma.dispositionReason.findFirstOrThrow({ where: { tenantId, label: "Smoke depth: accepted another offer" } });
    check("Rejection and withdrawal reasons go in the library (no duplicates)", dupReason.ok === false && rejectReason.kind === "REJECT" && withdrawReason.kind === "WITHDRAW");
    await renders("Hire › Settings › Operations renders", "(app)/hiring/settings/ops/page", "/hiring/settings/ops", ["Smoke depth: skills gap", "Smoke depth: budget confirmed"]);

    // ---------------------------------------------------------------------
    section("Requisition, intake questionnaire and the job");
    const raised = await hiring.raiseRequisitionAction({}, fd({
      title: "Smoke depth SRE zzdepth", departmentId: dept.id, newHire: true, newPositions: 2, currency: "INR", salaryMin: 2000000, salaryMax: 3000000, salaryFrequency: "ANNUAL",
      description: "Run the platform's reliability practice: on-call, SLOs and capacity planning.", justification: "Smoke depth",
    }));
    const req = await prisma.requisition.findFirstOrThrow({ where: { tenantId, title: "Smoke depth SRE zzdepth" } });
    check("HR raises a requisition", raised.ok === true, raised.message);
    const partial = await ops.saveRequisitionIntakeAction({}, fd({ requisitionId: req.id, a_0: "Team growth" }));
    check("The intake questionnaire needs every answer", partial.ok === false && !!partial.errors?.a_1, partial.message);
    const intake = await ops.saveRequisitionIntakeAction({}, fd({ requisitionId: req.id, a_0: "Team growth for the platform group", a_1: "Owns on-call and ships the SLO dashboard" }));
    const stored = await prisma.requisitionIntake.findUnique({ where: { requisitionId: req.id } });
    check("…and keeps the answers against the requisition", intake.ok === true && JSON.stringify(stored?.answers).includes("SLO dashboard"), intake.message);
    await renders("The intake page renders the answered questions", "(app)/hiring/requisitions/[id]/intake/page", `/hiring/requisitions/${req.id}/intake`, ["intake-form", "Owns on-call"], { id: req.id });
    await signInAs("vikram.menon@acme.test");
    await hiring.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    await signInAs("priya.sharma@acme.test");
    const opened = await hiring.openJobAction({}, fd({ requisitionId: req.id, hiringManagerId: sneha.emp.id }));
    const job = await prisma.job.findFirstOrThrow({ where: { requisitionId: req.id } });
    await prisma.job.update({ where: { id: job.id }, data: { description: "Run the platform's reliability practice: on-call, SLOs, capacity planning and incident reviews with kubernetes." } });
    check("A job opens and is live on the careers site", opened.ok === true && job.isPublished, opened.message);
    const flow = await flowSetup(job.id);
    const first = flow.stages[0]!;

    // Candidates for the rest of the suite.
    const add = (first: string, last: string, email: string, extra: Record<string, string | number> = {}) => hiring.addCandidateAction({}, fd({ jobId: job.id, firstName: first, lastName: last, email, ...extra }));
    await add("Smoke", "Depth A", `a${MAIL}`, { currentEmployer: "Acme Rival", expectedAnnualCtc: 2600000, source: "JOB_BOARD" });
    await add("Smoke", "Depth B", `b${MAIL}`, { source: "JOB_BOARD" });
    await add("Smoke", "Depth C", `c${MAIL}`, { source: "JOB_BOARD" });
    await add("Smoke", "Depth D", `d${MAIL}`, { source: "JOB_BOARD" });
    const appA = await appOf(`a${MAIL}`), appB = await appOf(`b${MAIL}`), appC = await appOf(`c${MAIL}`), appD = await appOf(`d${MAIL}`);
    check("Candidates enter the job's own flow", appA.currentStageId === first.id && appD.currentStageId === first.id);

    // ---------------------------------------------------------------------
    section("Recruiter tasks and sign-off");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create recruiting tasks", await denied(() => ops.createTaskAction({}, fd({ title: "Smoke depth: nope" }))));
    await signInAs("priya.sharma@acme.test");
    const t1 = await ops.createTaskAction({}, fd({ title: "Smoke depth: call the referees", queue: "SCREENING", priority: "HIGH", assigneeUserId: vikram.user.id, requiresSignOff: true, applicationId: appA.id, dueAt: inDays(2) }));
    const task = await prisma.recruiterTask.findFirstOrThrow({ where: { tenantId, title: "Smoke depth: call the referees" } });
    check("HR assigns a task that needs sign-off", t1.ok === true && task.assigneeUserId === vikram.user.id && task.requiresSignOff, t1.message);
    const upd = await ops.updateTaskAction({}, fd({ id: task.id, priority: "LOW" }));
    check("…and updates it", upd.ok === true && (await prisma.recruiterTask.findUniqueOrThrow({ where: { id: task.id } })).priority === "LOW", upd.message);
    await signInAs("vikram.menon@acme.test");
    const comp = await ops.completeTaskAction({}, fd({ id: task.id, outcome: "Both referees positive" }));
    check("Completing it sends it to its creator for sign-off", comp.ok === true && (await prisma.recruiterTask.findUniqueOrThrow({ where: { id: task.id } })).status === "PENDING_APPROVAL" && (await approverOf("TASK_SIGNOFF", task.id)) === priya.user.id, comp.message);
    check("…who signs it off on the workflow engine", (await approveKind("TASK_SIGNOFF", task.id)) === "APPROVED" && (await prisma.recruiterTask.findUniqueOrThrow({ where: { id: task.id } })).status === "DONE");
    await signInAs("priya.sharma@acme.test");
    await renders("Hire › Tasks lists the task", "(app)/hiring/tasks/page", "/hiring/tasks", ["task-table", "Smoke depth: call the referees"], {}, { status: "DONE", who: "all" });
    const taskCsv = await csv("tasks");
    check("The tasks report exports as CSV (audited)", taskCsv.status === 200 && taskCsv.body.includes("Smoke depth: call the referees") && (await prisma.auditLog.count({ where: { tenantId, action: "EXPORT", entityType: "HireReport", createdAt: { gte: started } } })) > 0);

    // ---------------------------------------------------------------------
    section("Stages: edit, add, reorder, delete, entry criteria and gated moves");
    const addAssess = await ops.addStageAction({}, fd({ flowId: flow.id, name: "Smoke depth: Assessment", afterSequence: first.sequence, stageKind: "ASSESSMENT" }));
    await ops.addStageAction({}, fd({ flowId: flow.id, name: "Smoke depth: Docs check", afterSequence: first.sequence, stageKind: "SCREENING" }));
    await ops.addStageAction({}, fd({ flowId: flow.id, name: "Smoke depth: Temp", stageKind: "INTERVIEW" }));
    let stages = await stagesOf(flow.id);
    const assess = stages.find((s) => s.name === "Smoke depth: Assessment")!, docs = stages.find((s) => s.name === "Smoke depth: Docs check")!, temp = stages.find((s) => s.name === "Smoke depth: Temp")!;
    check("Stages are added where asked, later ones shifted", addAssess.ok === true && docs.sequence === first.sequence + 1 && assess.sequence === first.sequence + 2, addAssess.message);
    const dupStage = await ops.addStageAction({}, fd({ flowId: flow.id, name: "smoke depth: assessment" }));
    check("…and names stay unique in a flow", dupStage.ok === false);
    const reorder = await ops.reorderStageAction({}, fd({ stageId: assess.id, dir: "up" }));
    stages = await stagesOf(flow.id);
    check("Stages can be reordered", reorder.ok === true && stages.find((s) => s.id === assess.id)!.sequence === first.sequence + 1, reorder.message);
    const del = await ops.deleteStageAction({}, fd({ stageId: temp.id }));
    check("An unused stage can be deleted", del.ok === true && !(await prisma.hiringStage.findUnique({ where: { id: temp.id } })), del.message);
    check("…but not a stage candidates went through", (await ops.deleteStageAction({}, fd({ stageId: first.id }))).ok === false);
    await ops.saveStageAction({}, fd({ stageId: assess.id, name: "Smoke depth: Assessment", stageKind: "ASSESSMENT", entryRequiresApproval: true }));
    await ops.saveStageAction({}, fd({ stageId: docs.id, name: "Smoke depth: Docs check", stageKind: "SCREENING", entryRequiresResume: true }));
    const saved = await ops.saveStageAction({}, fd({ stageId: first.id, name: first.name, stageKind: first.stageKind, staleAfterDays: 1 }));
    check("Stage settings (entry criteria, days allowed) are saved", saved.ok === true && (await prisma.hiringStage.findUniqueOrThrow({ where: { id: assess.id } })).entryRequiresApproval, saved.message);
    const gate = await ops.requestStageMoveAction({}, fd({ applicationId: appA.id, stageId: assess.id, note: "Strong screen" }));
    check("Moving into an approval-gated stage asks for approval first", gate.ok === true && (await prisma.application.findUniqueOrThrow({ where: { id: appA.id } })).currentStageId === first.id && !!(await hireReq("STAGE_MOVE", appA.id)), gate.message);
    check("…and the candidate moves once approved", (await approveKind("STAGE_MOVE", appA.id)) === "APPROVED" && (await prisma.application.findUniqueOrThrow({ where: { id: appA.id } })).currentStageId === assess.id);
    await signInAs("priya.sharma@acme.test");
    const noResume = await hiring.moveStageAction({}, fd({ applicationId: appB.id, stageId: docs.id }));
    check("A stage that needs a résumé refuses a candidate without one", noResume.ok === false && /résumé/.test(noResume.message ?? ""), noResume.message);
    await renders("Hire › Settings › Stages renders the editor", "(app)/hiring/settings/stages/page", "/hiring/settings/stages", ["stage-editor", "Smoke depth: Assessment"]);

    // ---------------------------------------------------------------------
    section("Sourcing channels, campaigns and attribution");
    const ch = await src.createChannelAction({}, fd({ name: "Smoke depth: Campus board", baseSource: "JOB_BOARD", monthlyCost: 5000, description: "Campus job board" }));
    const channel = await prisma.sourcingChannel.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: Campus board" } });
    check("A new sourcing channel waits for approval", ch.ok === true && channel.status === "PENDING_APPROVAL", ch.message);
    check("…and is active once approved", (await approveKind("CHANNEL_ACTIVATION", channel.id)) === "APPROVED" && (await prisma.sourcingChannel.findUniqueOrThrow({ where: { id: channel.id } })).status === "ACTIVE");
    await signInAs("priya.sharma@acme.test");
    const camp = await src.saveCampaignAction({}, fd({ name: "Smoke depth: Campus drive", code: "smokedepth", jobId: job.id, channelId: channel.id, budget: 50000, targetApplicants: 20, startsOn: inDays(-1), endsOn: inDays(30), description: "Campus drive" }));
    const campaign = await prisma.sourcingCampaign.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: Campus drive" } });
    check("A campaign is drafted with a tracking code", camp.ok === true && campaign.code === "SMOKEDEPTH" && campaign.status === "DRAFT", camp.message);
    const badCamp = await src.saveCampaignAction({}, fd({ name: "Smoke depth: Bad dates", startsOn: inDays(5), endsOn: inDays(1) }));
    check("…dates must be in order", badCamp.ok === false);
    await src.submitCampaignAction({}, fd({ id: campaign.id }));
    check("Launching a campaign goes through approval", (await approveKind("CAMPAIGN_LAUNCH", campaign.id)) === "APPROVED" && (await prisma.sourcingCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status === "ACTIVE");
    await signInAs("priya.sharma@acme.test");
    const pause = await src.campaignStatusAction({}, fd({ id: campaign.id, status: "PAUSED" }));
    const resume = await src.campaignStatusAction({}, fd({ id: campaign.id, status: "ACTIVE" }));
    check("A live campaign can be paused and resumed", pause.ok === true && resume.ok === true);
    const rule = await src.saveAttributionRuleAction({}, fd({ name: "Smoke depth: campus utm", matchField: "UTM_SOURCE", pattern: "smokeboard*", source: "JOB_BOARD", channelId: channel.id, priority: 1 }));
    check("An attribution rule is added", rule.ok === true, rule.message);

    // A public application with the campaign code and UTM tags.
    asPublic();
    const pub = fd({ jobId: job.id, firstName: "Smoke", lastName: "Depth Public", email: `public${MAIL}`, phone: "9876500011", totalExperienceYears: "5", consent: "on", campaign: "SMOKEDEPTH", utm_source: "smokeboard-campus", utm_campaign: "spring" });
    pub.append("resume", file(PDF, "cv.pdf", "application/pdf"));
    const applied = await apply.applyToJobAction({}, pub);
    const appP = await appOf(`public${MAIL}`);
    const profP = await prisma.candidateSourcingProfile.findUnique({ where: { candidateId: appP.candidateId } });
    check("A careers-site application is attributed to the campaign, channel and UTM source", applied.ok === true && profP?.campaignId === campaign.id && profP?.channelId === channel.id && profP?.utmSource === "smokeboard-campus" && appP.candidate.source === "JOB_BOARD", applied.message);
    check("…the application is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Application", entityId: appP.id, summary: { contains: "campaign Smoke depth: Campus drive" } } })) === 1);
    const portalMail = await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `public${MAIL}`, relatedType: "ApplicantPortal" } });
    const token = /\/careers\/status\/([A-Za-z0-9._-]+)/.exec(portalMail?.textBody ?? "")?.[1] ?? "";
    check("…and the applicant is emailed a link to follow it", !!token);
    await signInAs("priya.sharma@acme.test");
    const reattr = await src.requestReattributionAction({}, fd({ candidateId: appB.candidateId, source: "REFERRAL", reason: "Smoke depth: was actually referred by a friend" }));
    check("Correcting a candidate's source asks for approval", reattr.ok === true && appB.candidate.source === "JOB_BOARD", reattr.message);
    check("…and changes it once approved", (await approveKind("SOURCE_REATTRIBUTION", appB.candidateId)) === "APPROVED" && (await prisma.candidate.findUniqueOrThrow({ where: { id: appB.candidateId } })).source === "REFERRAL");
    await signInAs("priya.sharma@acme.test");
    await renders("Hire › Sourcing lists channels and campaigns", "(app)/hiring/sourcing/page", "/hiring/sourcing", ["Smoke depth: Campus board", "Smoke depth: Campus drive"]);
    await renders("A campaign page shows its funnel", "(app)/hiring/sourcing/campaigns/[id]/page", `/hiring/sourcing/campaigns/${campaign.id}`, ["campaign-funnel"], { id: campaign.id });
    const campCsv = await csv("campaigns"), srcCsv = await csv("sources");
    check("Campaign and source ROI reports export", campCsv.status === 200 && campCsv.body.includes("SMOKEDEPTH") && srcCsv.status === 200 && srcCsv.body.includes("Cost per hire"));

    // ---------------------------------------------------------------------
    section("Projects, searches, tags, profile capture, consent and cadences");
    const proj = await src.createProjectAction({}, fd({ name: "Smoke depth: SRE outreach", jobId: job.id, memberUserIds: vikram.user.id }));
    const project = await prisma.sourcingProject.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: SRE outreach" } });
    check("A sourcing project workspace is created with a collaborator", proj.ok === true && JSON.stringify(project.memberUserIds).includes(vikram.user.id), proj.message);
    await src.saveTagRuleAction({}, fd({ tag: "smoke-depth-k8s", field: "SKILL", value: "kubernetes" }));
    const pros = await src.addProspectAction({}, fd({ projectId: project.id, firstName: "Smoke", lastName: "Depth Prospect", email: `prospect${MAIL}`, currentTitle: "SRE", currentEmployer: "Elsewhere" }));
    const prospect = await prisma.candidate.findFirstOrThrow({ where: { tenantId, email: `prospect${MAIL}` } });
    check("A new prospect is sourced directly into the project", pros.ok === true && prospect.source === "DIRECT_SOURCING", pros.message);
    const cap = await src.captureProfileAction({}, fd({ candidateId: prospect.id, url: "https://www.linkedin.com/in/smoke-depth", profileText: "Site Reliability Engineer at Elsewhere | Bengaluru\nSkills: Kubernetes, Go, Terraform\nRuns on-call for 40 services." }));
    const capped = await prisma.candidate.findUniqueOrThrow({ where: { id: prospect.id }, include: { sourcingProfile: true } });
    check("A pasted public profile is captured (skills, link)", cap.ok === true && JSON.stringify(capped.skills).includes("kubernetes") && capped.linkedinUrl === "https://www.linkedin.com/in/smoke-depth", cap.message);
    check("…and the tag rule tags them", JSON.stringify(capped.sourcingProfile?.tags).includes("smoke-depth-k8s"));
    const entry = await prisma.sourcingProjectCandidate.findFirstOrThrow({ where: { projectId: project.id, candidateId: prospect.id } });
    await src.prospectStageAction({}, fd({ id: entry.id, stage: "CONTACTED" }));
    check("Moving a prospect along sets their engagement status", (await prisma.candidateSourcingProfile.findUniqueOrThrow({ where: { candidateId: prospect.id } })).engagementStatus === "CONTACTED");
    await src.saveSourcingProfileAction({}, fd({ candidateId: prospect.id, engagementStatus: "ENGAGED", isPassive: true, isHighPotential: true, tags: "smoke-depth-k8s, oncall", timeZone: "Asia/Kolkata" }));
    const prof = await prisma.candidateSourcingProfile.findUniqueOrThrow({ where: { candidateId: prospect.id } });
    check("Passive and high-potential prospects are flagged", prof.isPassive && prof.isHighPotential && prof.engagementStatus === "ENGAGED");
    const badQ = await src.saveSearchAction({}, fd({ name: "Smoke depth: broken", q: "kubernetes AND (go" }));
    check("A malformed boolean search is refused", badQ.ok === false, badQ.message);
    await src.saveSearchAction({}, fd({ name: "Smoke depth: k8s and go", q: "kubernetes AND (go OR rust) NOT java", isShared: true, projectId: project.id }));
    const search = await prisma.savedSourcingSearch.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: k8s and go" } });
    const ran = await src.runSavedSearchAction({}, fd({ id: search.id }));
    check("A shared boolean search runs and finds the prospect", ran.ok === true && ((await prisma.savedSourcingSearch.findUniqueOrThrow({ where: { id: search.id } })).lastCount ?? 0) >= 1, ran.message);
    await signInAs("vikram.menon@acme.test");
    check("…a colleague cannot delete someone else's search", (await src.deleteSearchAction({}, fd({ id: search.id }))).ok === false);
    await signInAs("priya.sharma@acme.test");
    await renders("The candidate search finds the prospect by boolean query", "(app)/hiring/candidates/page", "/hiring/candidates", ["candidate-table", "Depth Prospect"], {}, { q: "kubernetes AND terraform" });
    const badCad = await src.saveCadenceAction({}, fd({ name: "Smoke depth: bad", steps: "tomorrow call them" }));
    check("A cadence step that cannot be read is refused", badCad.ok === false);
    await src.saveCadenceAction({}, fd({ name: "Smoke depth: SRE cadence", steps: "Day 0: email: introduce the role\nDay 3: call: follow up\nDay 7: linkedin: last nudge" }));
    const cadence = await prisma.outreachCadence.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: SRE cadence" } });
    await src.recordConsentAction({}, fd({ candidateId: prospect.id, status: "GRANTED", source: "Replied to email" }));
    const enrolled = await src.enrollCadenceAction({}, fd({ cadenceId: cadence.id, candidateId: prospect.id }));
    const outreach = await prisma.recruiterTask.count({ where: { tenantId, candidateId: prospect.id, queue: "OUTREACH", status: "OPEN" } });
    check("Enrolling a consenting prospect queues one outreach task per step", enrolled.ok === true && outreach === 3, enrolled.message);
    const withdrawn = await src.recordConsentAction({}, fd({ candidateId: prospect.id, status: "WITHDRAWN", source: "Asked not to be contacted" }));
    check("Withdrawing consent stops the cadence and cancels its tasks", withdrawn.ok === true && (await prisma.cadenceEnrollment.findFirstOrThrow({ where: { candidateId: prospect.id } })).status === "STOPPED" && (await prisma.recruiterTask.count({ where: { tenantId, candidateId: prospect.id, status: "OPEN" } })) === 0);
    check("…and nobody can enrol or email them again", (await src.enrollCadenceAction({}, fd({ cadenceId: cadence.id, candidateId: prospect.id }))).ok === false && (await ops.emailCandidateAction({}, fd({ candidateId: prospect.id, subject: "Hi", body: "Checking in about the role." }))).ok === false);
    await renders("Sourcing rules page lists the tag and attribution rules", "(app)/hiring/sourcing/rules/page", "/hiring/sourcing/rules", ["smoke-depth-k8s", "Smoke depth: campus utm"]);
    await renders("The project workspace lists its prospects", "(app)/hiring/sourcing/projects/[id]/page", `/hiring/sourcing/projects/${project.id}`, ["prospect-table", "Depth Prospect"], { id: project.id });

    // Import with field mapping.
    const csvText = `Given,Family,Mail,Stack,Town\nSmoke,Depth Import1,import1${MAIL},kubernetes;go,Pune\nSmoke,Depth Import2,import2${MAIL},java,Chennai\n,,bad-row,,`;
    const imp = await src.importCandidatesAction({}, fd({ csv: csvText, map_firstName: "Given", map_lastName: "Family", map_email: "Mail", map_skills: "Stack", map_city: "Town", tag: "smoke-depth-import" }));
    const imported = await prisma.candidate.findMany({ where: { tenantId, email: { startsWith: "import" , endsWith: MAIL } }, include: { sourcingProfile: true } });
    check("Candidates import with a column mapping (bad rows reported, not fatal)", imp.ok === true && imported.length === 2 && imported.every((c) => JSON.stringify(c.sourcingProfile?.tags).includes("smoke-depth-import")) && /skipped/.test(imp.message ?? ""), imp.message);
    check("…mapped fields land in the right place", imported.some((c) => c.city === "Pune" && JSON.stringify(c.skills).includes("go")));

    // ---------------------------------------------------------------------
    section("Agencies");
    const ag = await src.saveAgencyAction({}, fd({ name: "Smoke depth: TalentCo", contactEmail: "desk@talentco.test", feePercent: 8.33, ownerUserId: vikram.user.id, entryStage: "Smoke depth: Assessment" }));
    const agency = await prisma.recruitmentAgency.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: TalentCo" } });
    const sub = await src.agencySubmissionAction({}, fd({ agencyId: agency.id, jobId: job.id, firstName: "Smoke", lastName: "Depth Agency", email: `agency${MAIL}` }));
    const appAg = await appOf(`agency${MAIL}`);
    check("An agency submission enters the pipeline as an agency candidate", ag.ok === true && sub.ok === true && appAg.candidate.source === "AGENCY", sub.message);
    check("…routed to the agency's owner and entry stage", appAg.ownerId === vikram.user.id && appAg.currentStageId === assess.id);

    // ---------------------------------------------------------------------
    section("Talent pools: settings, segments, approval, expiry");
    await talent.createPoolAction({}, fd({ name: "Smoke depth: SRE bench", description: "SREs" }));
    const pool = await prisma.talentPool.findFirstOrThrow({ where: { tenantId, name: "Smoke depth: SRE bench" } });
    const ps = await src.savePoolSettingsAction({}, fd({ poolId: pool.id, name: "Smoke depth: SRE bench", kind: "HIGH_POTENTIAL", memberExpiryDays: 30, requiresApproval: true, segSkills: "kubernetes", description: "SREs with kubernetes" }));
    check("A pool gets a kind, expiry, approval and a skill segment", ps.ok === true && (await prisma.talentPool.findUniqueOrThrow({ where: { id: pool.id } })).memberExpiryDays === 30, ps.message);
    const seg = await src.refreshSegmentAction({}, fd({ poolId: pool.id }));
    const segMember = await prisma.talentPoolMember.findFirst({ where: { poolId: pool.id, candidateId: prospect.id } });
    check("Refreshing the segment adds matching candidates, with an expiry", seg.ok === true && !!segMember?.expiresAt, seg.message);
    const ask = await src.requestPoolMemberAction({}, fd({ poolId: pool.id, candidateId: appA.candidateId, note: "Strong on-call" }));
    const pending = await prisma.talentPoolMember.findFirstOrThrow({ where: { poolId: pool.id, candidateId: appA.candidateId } });
    check("Adding to a restricted pool waits for approval", ask.ok === true && pending.status === "PENDING_APPROVAL", ask.message);
    check("…and is active once approved", (await approveKind("POOL_MEMBERSHIP", pending.id)) === "APPROVED" && (await prisma.talentPoolMember.findUniqueOrThrow({ where: { id: pending.id } })).status === "ACTIVE");
    await signInAs("priya.sharma@acme.test");
    await prisma.talentPoolMember.update({ where: { id: segMember!.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    await svc.runHireAlerts(tenantId);
    check("Memberships past their expiry lapse", (await prisma.talentPoolMember.findUniqueOrThrow({ where: { id: segMember!.id } })).status === "EXPIRED");
    await renders("A pool page shows its settings and members", "(app)/hiring/pools/[id]/page", `/hiring/pools/${pool.id}`, ["pool-settings", "Depth A", "high potential"], { id: pool.id });
    const arch = await src.archivePoolAction({}, fd({ poolId: pool.id }));
    check("A pool can be archived", arch.ok === true && !!(await prisma.talentPool.findUniqueOrThrow({ where: { id: pool.id } })).archivedAt);

    // ---------------------------------------------------------------------
    section("Duplicates, merge, ownership and workload");
    const d1 = await prisma.candidate.create({ data: { tenantId, email: `dupe1${MAIL}`, firstName: "Smoke", lastName: "Depth Dupe", phone: "9000000001", source: "JOB_BOARD" } });
    const d2 = await prisma.candidate.create({ data: { tenantId, email: `dupe2${MAIL}`, firstName: "Smoke", lastName: "Depth Dupe", phone: "9000000001", city: "Mysuru", source: "CAREER_PORTAL" } });
    await ops.logCommunicationAction({}, fd({ candidateId: d2.id, channel: "CALL", direction: "INBOUND", body: "Called about the SRE role" }));
    await renders("Possible duplicates are listed", "(app)/hiring/candidates/duplicates/page", "/hiring/candidates/duplicates", ["Depth Dupe"]);
    const merge = await ops.requestMergeAction({}, fd({ survivorId: d1.id, duplicateId: d2.id, note: "Same phone" }));
    check("Merging duplicates asks for approval", merge.ok === true && !!(await prisma.candidate.findUnique({ where: { id: d2.id } })), merge.message);
    check("…and once approved folds the duplicate in with a merge log", (await approveKind("CANDIDATE_MERGE", d1.id)) === "APPROVED" && !(await prisma.candidate.findUnique({ where: { id: d2.id } })) && (await prisma.candidateMergeLog.count({ where: { tenantId, survivorId: d1.id, mergedEmail: `dupe2${MAIL}` } })) === 1);
    const survivor = await prisma.candidate.findUniqueOrThrow({ where: { id: d1.id } });
    check("…keeping the duplicate's details and history", survivor.city === "Mysuru" && (await prisma.candidateCommunication.count({ where: { candidateId: d1.id } })) === 1);
    await signInAs("priya.sharma@acme.test");
    const xfer = fd({ ownerUserId: vikram.user.id });
    xfer.append("applicationIds", appC.id);
    const moved = await ops.transferOwnershipAction({}, xfer);
    check("Ownership of an application is transferred (and audited)", moved.ok === true && (await prisma.application.findUniqueOrThrow({ where: { id: appC.id } })).ownerId === vikram.user.id && (await prisma.auditLog.count({ where: { tenantId, entityType: "Application", entityId: appC.id, summary: "Ownership transferred" } })) === 1, moved.message);
    const bal = await ops.balanceWorkloadAction({}, fd({ jobId: job.id }));
    const owners = await prisma.application.groupBy({ by: ["ownerId"], where: { jobId: job.id, status: { in: ["ACTIVE", "ON_HOLD"] } }, _count: true });
    const counts = owners.map((o) => o._count);
    check("Balancing evens out the recruiters' active candidates", bal.ok === true && Math.max(...counts) - Math.min(...counts) <= 1, `${bal.message} ${JSON.stringify(counts)}`);
    await renders("Hire › Insights shows sources, stages, workload and calibration", "(app)/hiring/insights/page", "/hiring/insights", ["source-table", "stage-table", "workload-table"]);

    // ---------------------------------------------------------------------
    section("Communication history and document verification");
    const email = await ops.emailCandidateAction({}, fd({ candidateId: appB.candidateId, subject: "Smoke depth: next steps", body: "Please share your ID proof for the next step." }));
    check("Emailing a candidate queues the mail and logs it", email.ok === true && !!(await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `b${MAIL}`, subject: "Smoke depth: next steps" } })) && (await prisma.candidateCommunication.count({ where: { candidateId: appB.candidateId, channel: "EMAIL" } })) === 1, email.message);
    const up = fd({ candidateId: appB.candidateId, kind: "ID_PROOF" });
    up.append("file", file(PDF, "id.pdf", "application/pdf"));
    const uploaded = await ops.uploadCandidateDocumentAction({}, up);
    const doc = await prisma.candidateDocument.findFirstOrThrow({ where: { candidateId: appB.candidateId } });
    check("A candidate document is uploaded for verification", uploaded.ok === true && doc.status === "PENDING", uploaded.message);
    check("…the uploader cannot verify it", (await ops.verifyCandidateDocumentAction({}, fd({ id: doc.id, decision: "VERIFIED" }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    const ver = await ops.verifyCandidateDocumentAction({}, fd({ id: doc.id, decision: "VERIFIED", note: "Matches" }));
    check("…a colleague does", ver.ok === true && (await prisma.candidateDocument.findUniqueOrThrow({ where: { id: doc.id } })).status === "VERIFIED", ver.message);
    await signInAs("priya.sharma@acme.test");
    const withDoc = await hiring.moveStageAction({}, fd({ applicationId: appB.id, stageId: docs.id }));
    check("With a document on file the résumé-gated stage lets them in", withDoc.ok === true, withDoc.message);
    await renders("The candidate 360 shows the communication history", "(app)/hiring/candidates/[id]/page", `/hiring/candidates/${appB.candidateId}`, ["comm-history", "Smoke depth: next steps", "ID proof"], { id: appB.candidateId });

    // ---------------------------------------------------------------------
    section("Interview plan, panel rules and responses");
    const kit = await svc.interviewKit(job.id);
    const firstSkill = kit[0]!.skills[0]!.name;
    const badPlan = await ivs.saveInterviewPlanAction({}, fd({ jobId: job.id, rounds: "Technical | five | design" }));
    check("A round that cannot be read is refused", badPlan.ok === false);
    const plan = await ivs.saveInterviewPlanAction({}, fd({ jobId: job.id, rounds: "Screening | 30 | motivation\nTechnical | 60 | systems", skillWeights: `${firstSkill}: 4`, minPanel: 2, maxPanel: 3, requireHiringManager: true }));
    check("An interview plan with panel rules and skill weights is saved", plan.ok === true, plan.message);
    await ivs.submitInterviewPlanAction({}, fd({ jobId: job.id }));
    const planRow = await prisma.interviewPlan.findUniqueOrThrow({ where: { jobId: job.id } });
    check("…and sent to the hiring manager for sign-off", planRow.status === "PENDING_APPROVAL" && (await approverOf("INTERVIEW_PLAN", planRow.id)) === sneha.user.id);
    check("…who signs it off", (await approveKind("INTERVIEW_PLAN", planRow.id)) === "APPROVED" && (await prisma.interviewPlan.findUniqueOrThrow({ where: { id: planRow.id } })).status === "APPROVED");
    await signInAs("priya.sharma@acme.test");
    const lone = await schedule(appA.id, "Smoke depth: Technical", 1, "10:00", [meera.emp.id]);
    check("A panel that breaks the plan's rules is refused", lone.r.ok === false && /hiring manager/i.test(lone.r.message ?? ""), lone.r.message);
    const sA = await schedule(appA.id, "Smoke depth: Technical", 1, "10:00", [sneha.emp.id, meera.emp.id]);
    const ivA = sA.iv!;
    check("A panel that meets them is scheduled", sA.r.ok === true, sA.r.message);
    const addP = await ivs.addPanelistAction({}, fd({ interviewId: ivA.id, employeeId: vikram.emp.id }));
    check("A panellist can be added after scheduling", addP.ok === true && (await prisma.interviewEvent.count({ where: { interviewId: ivA.id, kind: "PANEL_ADDED" } })) === 1, addP.message);
    const fourth = await ivs.addPanelistAction({}, fd({ interviewId: ivA.id, employeeId: priya.emp.id }));
    check("…but not beyond the plan's maximum", fourth.ok === false && /at most/.test(fourth.message ?? ""), fourth.message);
    const rmHm = await ivs.removePanelistAction({}, fd({ interviewId: ivA.id, employeeId: sneha.emp.id }));
    check("Removing the hiring manager needs an explicit override", rmHm.ok === false && /override/.test(rmHm.message ?? ""), rmHm.message);
    const rmV = await ivs.removePanelistAction({}, fd({ interviewId: ivA.id, employeeId: vikram.emp.id, reason: "Not needed" }));
    check("…removing someone else is fine", rmV.ok === true, rmV.message);
    await signInAs("meera.krishnan@acme.test");
    const acc = await ivs.respondToPanelAction({}, fd({ interviewId: ivA.id, response: "ACCEPTED" }));
    check("A panellist accepts the invitation", acc.ok === true && (await prisma.interviewPanelist.findFirstOrThrow({ where: { interviewId: ivA.id, employeeId: meera.emp.id } })).response === "ACCEPTED", acc.message);
    await signInAs("sneha.reddy@acme.test");
    const decNo = await ivs.respondToPanelAction({}, fd({ interviewId: ivA.id, response: "DECLINED" }));
    const decYes = await ivs.respondToPanelAction({}, fd({ interviewId: ivA.id, response: "DECLINED", reason: "On leave that day" }));
    check("Declining needs a reason, and the owner is told", decNo.ok === false && decYes.ok === true && (await prisma.notification.count({ where: { tenantId, createdAt: { gte: started }, title: { contains: "declined Smoke depth: Technical" } } })) === 1, decYes.message);
    await signInAs("sneha.reddy@acme.test");
    const { PanelResponses } = await import("../apps/web/src/app/(app)/hiring/_parts/hire-depth-panel");
    const panelHtml = await html(React.createElement(PanelResponses, { viewer: (await getViewer())!, applicationId: appA.id }), `/hiring/applications/${appA.id}`);
    check("A panellist sees the invitation on the candidate page", panelHtml.includes("panel-responses") && panelHtml.includes("Smoke depth: Technical"));

    // ---------------------------------------------------------------------
    section("Reschedules, time zones, consent, no-shows and cancellations");
    await signInAs("priya.sharma@acme.test");
    await src.saveSourcingProfileAction({}, fd({ candidateId: appA.candidateId, timeZone: "America/New_York", engagementStatus: "ENGAGED" }));
    const noReason = await ivs.rescheduleInterviewAction({}, fd({ interviewId: ivA.id, date: inDays(6), time: "09:30", timeZone: "Asia/Kolkata" }));
    check("Rescheduling needs a reason", noReason.ok === false);
    const resched = await ivs.rescheduleInterviewAction({}, fd({ interviewId: ivA.id, date: inDays(6), time: "09:30", timeZone: "Asia/Kolkata", reason: "Hiring manager on leave" }));
    const ivA2 = await prisma.interview.findUniqueOrThrow({ where: { id: ivA.id } });
    const evt = await prisma.interviewEvent.findFirst({ where: { interviewId: ivA.id, kind: "RESCHEDULED" } });
    check("A reschedule records the reason and the old and new times", resched.ok === true && ivA2.status === "RESCHEDULED" && evt?.reason === "Hiring manager on leave" && !!evt?.fromAt && !!evt?.toAt, resched.message);
    const moveMail = await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `a${MAIL}`, subject: { contains: "has moved" } } });
    check("…the candidate is told in their own time zone", !!moveMail?.textBody.includes("America/New_York"));
    check("…and the panel must confirm again", (await prisma.interviewPanelist.findMany({ where: { interviewId: ivA.id } })).every((p) => p.response === "PENDING"));
    const notified = await ivs.notifyCandidateAction({}, fd({ interviewId: ivA.id }));
    check("Interview details can be re-sent in the candidate's time zone", notified.ok === true && /New_York/.test(notified.message ?? ""), notified.message);
    const consent = await ivs.recordInterviewConsentAction({}, fd({ interviewId: ivA.id, status: "GRANTED", method: "Email reply" }));
    check("Recording consent is recorded", consent.ok === true && (await prisma.interviewConsent.findUniqueOrThrow({ where: { interviewId: ivA.id } })).status === "GRANTED", consent.message);
    const c1 = (await schedule(appC.id, "Smoke depth: Screen 1", 2, "10:00", [sneha.emp.id, meera.emp.id])).iv!;
    const early = await ivs.markNoShowAction({}, fd({ interviewId: c1.id }));
    check("A future interview cannot be a no-show", early.ok === false);
    await prisma.interview.update({ where: { id: c1.id }, data: { scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
    const ns1 = await ivs.markNoShowAction({}, fd({ interviewId: c1.id, reason: "Did not join" }));
    check("A first no-show is recorded and the candidate asked to rebook", ns1.ok === true && (await prisma.interview.findUniqueOrThrow({ where: { id: c1.id } })).status === "NO_SHOW" && !!(await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `c${MAIL}`, subject: { contains: "We missed you" } } })), ns1.message);
    const c2 = (await schedule(appC.id, "Smoke depth: Screen 2", 2, "12:00", [sneha.emp.id, meera.emp.id])).iv!;
    await prisma.interview.update({ where: { id: c2.id }, data: { scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
    const ns2 = await ivs.markNoShowAction({}, fd({ interviewId: c2.id }));
    const appC2 = await prisma.application.findUniqueOrThrow({ where: { id: appC.id } });
    const dispC = await prisma.applicationDisposition.findUnique({ where: { applicationId: appC.id } });
    check("Reaching the no-show limit closes the application with a system reason", ns2.ok === true && appC2.status === "REJECTED" && dispC?.byWhom === "SYSTEM" && /No-show/.test(dispC.label), ns2.message);
    const b1 = (await schedule(appB.id, "Smoke depth: Screen B", 3, "10:00", [sneha.emp.id, meera.emp.id])).iv!;
    const cancel = await ivs.cancelInterviewAction({}, fd({ interviewId: b1.id, reason: "Role re-scoped" }));
    check("An interview can be cancelled with a reason", cancel.ok === true && (await prisma.interview.findUniqueOrThrow({ where: { id: b1.id } })).status === "CANCELLED" && (await prisma.interviewEvent.count({ where: { interviewId: b1.id, kind: "CANCELLED" } })) === 1, cancel.message);
    const { HireDepthPanel } = await import("../apps/web/src/app/(app)/hiring/_parts/hire-depth-panel");
    const depthHtml = await html(React.createElement(HireDepthPanel, { viewer: (await getViewer())!, applicationId: appA.id }), `/hiring/applications/${appA.id}`);
    check("The candidate page shows the interview actions and change history", depthHtml.includes("interview-actions") && depthHtml.includes("interview-events") && depthHtml.includes("Hiring manager on leave"));

    // ---------------------------------------------------------------------
    section("Capacity, guides and the question bank");
    const capBad = await ivs.saveCapacityAction({}, fd({ employeeId: meera.emp.id, maxPerWeek: 2, maxPerDay: 5 }));
    const capOk = await ivs.saveCapacityAction({}, fd({ employeeId: meera.emp.id, maxPerWeek: 2, maxPerDay: 1 }));
    check("Interviewer capacity is set (per day within per week)", capBad.ok === false && capOk.ok === true);
    const overCap = await schedule(appD.id, "Smoke depth: Over capacity", 6, "15:00", [sneha.emp.id, meera.emp.id]);
    check("Booking an interviewer past their daily limit is refused", overCap.r.ok === false && /limit 1/.test(overCap.r.message ?? "") && !overCap.iv, overCap.r.message);
    const ovf = new FormData();
    for (const [k, v] of Object.entries({ applicationId: appD.id, title: "Smoke depth: Over capacity", date: inDays(6), time: "15:00", durationMinutes: "60", mode: "VIDEO", capacityOverride: "on" })) ovf.set(k, v);
    ovf.append("panel", sneha.emp.id); ovf.append("panel", meera.emp.id);
    const forced = await hiring.scheduleInterviewAction({}, ovf);
    const forcedIv = await prisma.interview.findFirst({ where: { applicationId: appD.id, title: "Smoke depth: Over capacity" } });
    check("…unless the scheduler overrides it", forced.ok === true && !!forcedIv, forced.message);
    if (forcedIv) await ivs.cancelInterviewAction({}, fd({ interviewId: forcedIv.id, reason: "Capacity test" }));
    await ivs.saveCapacityAction({}, fd({ employeeId: meera.emp.id, maxPerWeek: 30, maxPerDay: 10 }));
    await renders("The capacity calendar lists interviewers against their limits", "(app)/hiring/interviews/capacity/page", "/hiring/interviews/capacity", ["capacity-table", meera.emp.displayName ?? "Meera"]);
    const guide = await ivs.saveGuideAction({}, fd({ title: "Smoke depth: SRE interview guide", body: "Probe incident response, SLO design and capacity planning with real examples.", roleKeyword: "SRE", departmentId: dept.id }));
    const q = await ivs.saveQuestionAction({}, fd({ text: "Smoke depth: Walk me through your worst outage.", competency: "Incident response", difficulty: "HARD", guidance: "Look for blameless learning" }));
    check("A role guide and a bank question mapped to a competency are added", guide.ok === true && q.ok === true);
    await renders("The interviewing settings list the bank", "(app)/hiring/settings/interviewing/page", "/hiring/settings/interviewing", ["question-bank", "Incident response", "Smoke depth: SRE interview guide"]);
    await renders("The job's plan page shows rounds and the matching guide", "(app)/hiring/jobs/[id]/plan/page", `/hiring/jobs/${job.id}/plan`, ["plan-rounds", "Smoke depth: SRE interview guide"], { id: job.id });

    // ---------------------------------------------------------------------
    section("Feedback: bias prompts, weighted scores, reopening");
    await prisma.interview.update({ where: { id: ivA.id }, data: { scheduledAt: new Date(Date.now() - 2 * 3_600_000) } });
    const ratings = JSON.stringify(kit.flatMap((sec) => sec.skills.map((k) => ({ section: sec.section, skill: k.name, rating: k.name === firstSkill ? 5 : 1, comment: null }))));
    const card = (notes: string, extra: Record<string, string> = {}) => fd({ interviewId: ivA.id, recommendation: "HIRE", notes, ratings, intent: "submit", ...extra });
    await signInAs("meera.krishnan@acme.test");
    const biased = await hiring.saveScorecardAction({}, card("A real rockstar on systems design and incident response."));
    check("Feedback with flagged wording is held for a second look", biased.ok === false && !!biased.errors?.biasReviewed && /rockstar/.test(biased.message ?? ""), biased.message);
    const reviewed = await hiring.saveScorecardAction({}, card("A real rockstar on systems design and incident response.", { biasReviewed: "1" }));
    const sc = await prisma.scorecard.findFirstOrThrow({ where: { interviewId: ivA.id, panelistId: meera.emp.id } });
    const n = kit.reduce((s, sec) => s + sec.skills.length, 0);
    const expected = Math.round(((5 * 4 + (n - 1)) / (4 + n - 1)) * 100) / 100;
    check("…and submitted once the interviewer confirms", reviewed.ok === true && sc.status === "SUBMITTED", reviewed.message);
    check("The score is weighted by the plan's skill weights", Number(sc.overallScore) === expected && expected > (5 + (n - 1)) / n, `${sc.overallScore} vs ${expected}`);
    const reopen = await ivs.requestScorecardReopenAction({}, fd({ scorecardId: sc.id, reason: "Smoke depth: mis-rated a skill" }));
    check("An interviewer asks to reopen submitted feedback", reopen.ok === true && !!(await hireReq("SCORECARD_REOPEN", sc.id)), reopen.message);
    check("…and can amend it once approved", (await approveKind("SCORECARD_REOPEN", sc.id)) === "APPROVED" && (await prisma.scorecard.findUniqueOrThrow({ where: { id: sc.id } })).status === "DRAFT");
    await signInAs("meera.krishnan@acme.test");
    await hiring.saveScorecardAction({}, card("Strong on systems design and incident response overall.", { biasReviewed: "1" }));
    await signInAs("priya.sharma@acme.test");
    await renders("The calibration report compares interviewers", "(app)/hiring/insights/page", "/hiring/insights", ["calibration-table"]);
    const calCsv = await csv("calibration");
    check("…and exports", calCsv.status === 200 && calCsv.body.includes(meera.emp.displayName ?? "Meera"));

    // ---------------------------------------------------------------------
    section("Offers: clauses, language, checklist, versions, negotiation, revision, withdrawal");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot add offer clauses", await denied(() => offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: x", body: "Nope nope nope" }))));
    await signInAs("priya.sharma@acme.test");
    await offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: Relocation support", kind: "CONDITIONAL", body: "Relocation support of up to one month's pay applies.", minCtc: 1000000 }));
    await offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: Senior retention", kind: "CONDITIONAL", body: "A retention bonus applies at this level.", minCtc: 9000000 }));
    await offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: Tax note", kind: "TAX_DISCLAIMER", body: "Figures are before income tax deducted at source." }));
    await offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: Wellness allowance", kind: "COMPONENT", body: "A yearly wellness allowance is included.", amount: 12000 }));
    await offers.saveOfferClauseAction({}, fd({ title: "Smoke depth: Tax note", kind: "TAX_DISCLAIMER", locale: "hi", body: "आंकड़े आयकर कटौती से पहले के हैं।" }));
    const draft = (applicationId: string, ctc: number) => hiring.draftOfferAction({}, fd({ applicationId, annualCtc: ctc, proposedJoiningDate: inDays(40), expiresOn: inDays(10), breakupMode: "STRUCTURE" }));
    const approveIfNeeded = async (applicationId: string) => {
      const o = await prisma.offer.findUniqueOrThrow({ where: { applicationId } });
      if (o.status === "PENDING_APPROVAL") { await signInAs("vikram.menon@acme.test"); await hiring.offerOpAction({}, fd({ applicationId, op: "approve" })); await signInAs("priya.sharma@acme.test"); }
    };
    const drafted = await draft(appA.id, 2500000);
    await approveIfNeeded(appA.id);
    const extraA = await prisma.offerExtra.findUniqueOrThrow({ where: { applicationId: appA.id } });
    const clauseTitles = (await prisma.offerClause.findMany({ where: { id: { in: svc.hireStringList(extraA.clauseIds) } } })).map((c) => c.title);
    check("Drafting freezes the clauses that apply (by CTC and language)", drafted.ok === true && clauseTitles.includes("Smoke depth: Relocation support") && clauseTitles.includes("Smoke depth: Tax note") && clauseTitles.includes("Smoke depth: Wellness allowance") && !clauseTitles.includes("Smoke depth: Senior retention") && extraA.locale === "en", `${drafted.message} ${clauseTitles.join(", ")}`);
    check("…and records version 1", (await prisma.offerVersion.findFirst({ where: { applicationId: appA.id, version: 1 } }))?.event === "DRAFTED");
    const hindiTax = await prisma.offerClause.findFirstOrThrow({ where: { tenantId, title: "Smoke depth: Tax note", locale: "hi" } });
    const manual = fd({ applicationId: appA.id, mode: "manual", locale: "hi" });
    manual.append("clauseIds", hindiTax.id);
    await offers.applyOfferClausesAction({}, manual);
    const hi = await prisma.offerExtra.findUniqueOrThrow({ where: { applicationId: appA.id } });
    check("The letter's language and clauses can be chosen by hand", hi.locale === "hi" && (hi.clausesHtml ?? "").includes("आयकर"));
    await offers.applyOfferClausesAction({}, fd({ applicationId: appA.id, mode: "rules", locale: "en" }));
    const preview = await svc.previewOfferLetter(tenantId, appA.id);
    check("…and the letter carries them", preview.ok === true && (preview.html ?? "").includes("Relocation support of up to one month"));
    const blocked = await hiring.offerOpAction({}, fd({ applicationId: appA.id, op: "extend" }));
    check("The offer cannot be extended until the checklist is done", blocked.ok === false && /checklist/.test(blocked.message ?? ""), blocked.message);
    for (const item of cfg.offerChecklist) await offers.tickOfferChecklistAction({}, fd({ applicationId: appA.id, item }));
    const ext = await hiring.offerOpAction({}, fd({ applicationId: appA.id, op: "extend" }));
    const offA = await prisma.offer.findUniqueOrThrow({ where: { applicationId: appA.id } });
    check("With the checklist ticked it is extended, clauses in the signed letter", ext.ok === true && offA.status === "EXTENDED" && (offA.renderedBody ?? "").includes("wellness allowance"), ext.message);
    check("…as a new version", (await prisma.offerVersion.findFirst({ where: { applicationId: appA.id, event: "EXTENDED" } })) !== null);
    const neg = await offers.logNegotiationAction({}, fd({ applicationId: appA.id, kind: "COUNTER_OFFER", requestedCtc: 2800000, competitorName: "Rival Systems", competitorCtc: 2750000, note: "Has a competing offer" }));
    const negDate = await offers.logNegotiationAction({}, fd({ applicationId: appA.id, kind: "JOINING_DATE", requestedJoiningDate: inDays(60) }));
    const negs = await prisma.offerNegotiation.findMany({ where: { applicationId: appA.id }, orderBy: { createdAt: "asc" } });
    check("A counter-offer and a joining-date request are tracked", neg.ok === true && negDate.ok === true && negs.length === 2 && Number(negs[0]!.competitorCtc) === 2750000);
    await offers.resolveNegotiationAction({}, fd({ id: negs[0]!.id, status: "AGREED", resolution: "Matched at 28L" }));
    await offers.resolveNegotiationAction({}, fd({ id: negs[1]!.id, status: "DECLINED", resolution: "Start date is fixed" }));
    check("…and resolved", (await prisma.offerNegotiation.count({ where: { applicationId: appA.id, status: { in: ["AGREED", "DECLINED"] } } })) === 2);
    const rev = await offers.requestOfferRevisionAction({}, fd({ applicationId: appA.id, annualCtc: 2800000, reason: "Smoke depth: matched the competing offer" }));
    check("A revision is requested", rev.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: appA.id } })).status === "EXTENDED", rev.message);
    check("…approved by an offer approver", (await approverOf("OFFER_REVISION", appA.id)) === vikram.user.id && (await approveKind("OFFER_REVISION", appA.id)) === "APPROVED");
    const revised = await prisma.offer.findUniqueOrThrow({ where: { applicationId: appA.id }, include: { links: true } });
    check("…which applies the new terms, revokes the old link and records a version", Number(revised.annualCtc) === 2800000 && revised.status === "APPROVED" && revised.links.every((l) => !!l.revokedAt) && (await prisma.offerVersion.findFirst({ where: { applicationId: appA.id, event: "REVISED" } })) !== null);
    await signInAs("priya.sharma@acme.test");
    const confirm = await offers.confirmCompensationAction({}, fd({ applicationId: appA.id, note: "Reviewed with payroll" }));
    check("Compensation is confirmed before joining", confirm.ok === true && !!(await prisma.offerExtra.findUniqueOrThrow({ where: { applicationId: appA.id } })).compConfirmedAt);
    await renders("The offer page shows versions, comparison and negotiations", "(app)/hiring/offers/[id]/page", `/hiring/offers/${appA.id}`, ["offer-versions", "offer-comparison", "negotiations", "band-check", "Rival Systems"], { id: appA.id });
    await draft(appB.id, 2200000);
    await approveIfNeeded(appB.id);
    const wd = await offers.withdrawOfferAction({}, fd({ applicationId: appB.id, reason: "Smoke depth: role put on hold" }));
    check("An offer is withdrawn with a reason (and a version)", wd.ok === true && (await prisma.offer.findUniqueOrThrow({ where: { applicationId: appB.id } })).status === "WITHDRAWN" && (await prisma.offerVersion.findFirst({ where: { applicationId: appB.id, event: "WITHDRAWN" } })) !== null, wd.message);
    const offCsv = await csv("offers");
    check("The offer turnaround and versions report exports", offCsv.status === 200 && offCsv.body.includes("Depth A"));

    // ---------------------------------------------------------------------
    section("Referrals and the referral bonus");
    await signInAs("meera.krishnan@acme.test");
    await hiring.referAction({}, fd({ jobId: job.id, firstName: "Smoke", lastName: "Depth Referral", email: `referral${MAIL}` }));
    const appR = await appOf(`referral${MAIL}`);
    await signInAs("priya.sharma@acme.test");
    const refUpd = await ops.updateReferralAction({}, fd({ candidateId: appR.candidateId, relationship: "Former colleague", recommendation: "Ran on-call with me for two years" }));
    check("A referral's relationship and recommendation are recorded", refUpd.ok === true && (await prisma.referralRecord.findUniqueOrThrow({ where: { candidateId: appR.candidateId } })).relationship === "Former colleague", refUpd.message);
    const tooEarly = await ops.requestReferralBonusAction({}, fd({ candidateId: appR.candidateId, amount: 50000 }));
    check("A bonus cannot be requested before an offer is accepted", tooEarly.ok === false, tooEarly.message);
    await draft(appR.id, 2400000);
    await approveIfNeeded(appR.id);
    for (const item of cfg.offerChecklist) await offers.tickOfferChecklistAction({}, fd({ applicationId: appR.id, item }));
    await hiring.offerOpAction({}, fd({ applicationId: appR.id, op: "extend" }));
    const accepted = await hiring.offerOpAction({}, fd({ applicationId: appR.id, op: "accepted" }));
    check("The referred candidate accepts an offer", accepted.ok === true, accepted.message);
    const bonus = await ops.requestReferralBonusAction({}, fd({ candidateId: appR.candidateId, amount: 50000 }));
    const rec = await prisma.referralRecord.findUniqueOrThrow({ where: { candidateId: appR.candidateId } });
    check("…then the referral bonus is requested", bonus.ok === true && rec.bonusStatus === "REQUESTED", bonus.message);
    check("…approved by an offer approver", (await approveKind("REFERRAL_BONUS", rec.id)) === "APPROVED" && (await prisma.referralRecord.findUniqueOrThrow({ where: { id: rec.id } })).bonusStatus === "APPROVED");
    check("…and the referrer is told", (await prisma.notification.count({ where: { tenantId, userId: meera.user.id, createdAt: { gte: started }, title: { contains: "referral bonus was approved" } } })) === 1);
    await signInAs("priya.sharma@acme.test");
    const paid = await ops.markReferralBonusPaidAction({}, fd({ id: rec.id }));
    check("Payroll marks it paid", paid.ok === true && (await prisma.referralRecord.findUniqueOrThrow({ where: { id: rec.id } })).bonusStatus === "PAID");
    await renders("Hire › Referrals lists it", "(app)/hiring/referrals/page", "/hiring/referrals", ["referral-table", "Depth Referral"]);
    const refCsv = await csv("referrals");
    check("…and the referrals report exports", refCsv.status === 200 && refCsv.body.includes("Former colleague"));

    // ---------------------------------------------------------------------
    section("Silver medallists and re-engagement");
    const silver = await src.captureSilverAction({}, fd({ jobId: job.id }));
    const silverPool = await prisma.talentPool.findFirst({ where: { tenantId, kind: "SILVER_MEDALIST", archivedAt: null }, include: { members: true } });
    check("A job's finalists are kept as silver medallists", silver.ok === true && !!silverPool?.members.some((m) => m.candidateId === appA.candidateId), silver.message);
    await prisma.application.update({ where: { id: appC.id }, data: { appliedAt: new Date(Date.now() - 200 * DAY) } });
    const react = await src.reactivationCampaignAction({}, fd({}));
    const rePool = await prisma.talentPool.findFirst({ where: { tenantId, kind: "REACTIVATION" }, include: { members: true } });
    check("Past candidates not contacted lately are queued for re-engagement", react.ok === true && !!rePool?.members.some((m) => m.candidateId === appC.candidateId) && (await prisma.recruiterTask.count({ where: { tenantId, candidateId: appC.candidateId, queue: "OUTREACH" } })) === 1, react.message);
    await renders("The pools page offers silver-medallist capture and re-engagement", "(app)/hiring/pools/page", "/hiring/pools", ["pool-automation", "Silver medallists"]);

    // ---------------------------------------------------------------------
    section("Careers content: approvals, versions, pages");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot edit careers content", await denied(() => careers.saveCareerContentAction({}, fd({ kind: "FAQ", title: "Smoke depth: x", body: "Nope nope nope nope" }))));
    await signInAs("priya.sharma@acme.test");
    const save = (vals: Record<string, string>, image?: File) => { const f = fd(vals); if (image) f.append("image", image); return careers.saveCareerContentAction({}, f); };
    const noAlt = await save({ kind: "STORY", title: "Smoke depth: Asha's first year", body: "How Asha grew from intern to SRE lead in a year." }, file(PNG, "asha.png", "image/png"));
    check("An image without a description is refused (accessibility)", noAlt.ok === false && !!noAlt.errors?.imageAlt, noAlt.message);
    await save({ kind: "STORY", title: "Smoke depth: Asha's first year", body: "How Asha grew from intern to SRE lead in a year.", imageAlt: "Asha at her desk", personName: "Asha", personTitle: "SRE lead" }, file(PNG, "asha.png", "image/png"));
    await save({ kind: "EVP", title: "Smoke depth: Why build with us", body: "Small teams, real ownership, and on-call that respects your sleep." });
    await save({ kind: "FAQ", title: "Smoke depth: Do you sponsor relocation?", body: "Yes — relocation support is part of every offer above the entry level." });
    await save({ kind: "DIVERSITY", title: "Smoke depth: Hiring for every background", body: "Structured interviews and diverse panels for every role." });
    await save({ kind: "RECRUITER", title: "Smoke depth: Talk to Priya", body: "Priya runs engineering hiring and answers within a day.", personName: "Priya Sharma", personTitle: "Talent partner", contactEmail: "priya@acme.test" });
    await save({ kind: "LANDING", title: "Smoke depth: Campus 2027", slug: "smoke-depth-campus", campaignCode: "SMOKEDEPTH", audience: "CAMPUS", body: "Final-year students: see our roles and apply before December. Broken: /careers/doesnotexist" });
    const blocks = await prisma.careerContent.findMany({ where: { tenantId, title: { startsWith: "Smoke depth" } } });
    check("Story, EVP, FAQ, diversity, recruiter and landing blocks are drafted", blocks.length === 6 && blocks.every((b) => b.status === "DRAFT"));
    for (const b of blocks) await careers.submitCareerContentAction({}, fd({ id: b.id }));
    check("Publishing careers content needs approval", (await prisma.careerContent.count({ where: { tenantId, title: { startsWith: "Smoke depth" }, status: "PENDING_APPROVAL" } })) === 6);
    for (const b of blocks) await approveKind("CONTENT_PUBLISH", b.id);
    check("…and approved blocks go live", (await prisma.careerContent.count({ where: { tenantId, title: { startsWith: "Smoke depth" }, status: "PUBLISHED" } })) === 6);
    await signInAs("priya.sharma@acme.test");
    const evp = blocks.find((b) => b.kind === "EVP")!;
    const edit = await careers.saveCareerContentAction({}, fd({ id: evp.id, kind: "EVP", title: "Smoke depth: Why build with us (v2)", body: "Small teams and real ownership.", note: "Shorter" }));
    const evp2 = await prisma.careerContent.findUniqueOrThrow({ where: { id: evp.id }, include: { versions: true } });
    check("Editing a live block keeps the old text as a version and needs approval again", edit.ok === true && evp2.version === 2 && evp2.status === "DRAFT" && evp2.versions.length === 1, edit.message);
    const restore = await careers.restoreCareerContentVersionAction({}, fd({ versionId: evp2.versions[0]!.id }));
    const evp3 = await prisma.careerContent.findUniqueOrThrow({ where: { id: evp.id } });
    check("An earlier version can be restored as a draft", restore.ok === true && evp3.title === "Smoke depth: Why build with us" && evp3.version === 3, restore.message);
    await renders("The content history lists its versions", "(app)/hiring/settings/careers/content/[id]/page", `/hiring/settings/careers/content/${evp.id}`, ["content-versions"], { id: evp.id });
    await careers.submitCareerContentAction({}, fd({ id: evp.id }));
    await approveKind("CONTENT_PUBLISH", evp.id);
    await signInAs("priya.sharma@acme.test");
    const badTag = await careers.saveCareerSiteConfigAction({}, fd({ analyticsTagId: "<script>", locales: "en" }));
    check("An analytics ID that is not a measurement ID is refused", badTag.ok === false);
    const site = await careers.saveCareerSiteConfigAction({}, fd({ seoTitle: "Smoke depth careers", seoDescription: "Roles at Acme", analyticsTagId: "G-SMOKE1234", locales: "en, hi", reduceMotion: true, requireAltText: true, groupByLocation: true, showRecruiterContacts: true }));
    const snaps = await prisma.careerSiteSnapshot.count({ where: { tenantId, createdAt: { gte: started } } });
    check("Site SEO, languages, accessibility and the analytics tag are saved — the old settings kept as a version", site.ok === true && snaps >= 1 && (await prisma.careerSiteConfig.findUniqueOrThrow({ where: { tenantId } })).analyticsTagId === "G-SMOKE1234", site.message);
    await renders("The site settings page checks accessibility and links", "(app)/hiring/settings/careers/site/page", "/hiring/settings/careers/site", ["broken-links", "/careers/doesnotexist"]);
    await renders("The content library lists the blocks", "(app)/hiring/settings/careers/content/page", "/hiring/settings/careers/content", ["content-table", "Smoke depth: Campus 2027"]);
    const meta = await ops.saveJobPostingMetaAction({}, fd({ jobId: job.id, seoTitle: "Smoke depth SRE — Acme", seoDescription: "Run reliability at Acme", locale: "hi", tTitle: "स्मोक डेप्थ एसआरई", tDescription: "विश्वसनीयता टीम का नेतृत्व करें।" }));
    check("A job gets its own SEO title and a Hindi translation", meta.ok === true, meta.message);

    // The public site, as a visitor sees it.
    asPublic();
    setTestSessionNone();
    const careersHtml = await renders("The careers home shows EVP, stories, recruiters and roles by location", "careers/page", "/careers", ["career-evp", "recruiter-widgets", "jobs-by-location", "Priya Sharma"], {}, { utm_source: "smoke-depth-visit" });
    void careersHtml;
    check("…and counts the visit with its UTM source", (await prisma.careerSiteVisit.count({ where: { tenantId, utmSource: "smoke-depth-visit" } })) === 1);
    const jobHtml = await renders("A job page carries JSON-LD job markup", `careers/[id]/page`, `/careers/${job.id}`, ["job-jsonld", "JobPosting"], { id: job.id });
    void jobHtml;
    await renders("…and its Hindi translation", `careers/[id]/page`, `/careers/${job.id}`, ["स्मोक डेप्थ एसआरई"], { id: job.id }, { lang: "hi" });
    const jobMeta = await (await import(`${W}/careers/[id]/page`)).generateMetadata({ params: Promise.resolve({ id: job.id }) });
    check("…and its own search title", String(jobMeta.title).includes("Smoke depth SRE — Acme"));
    await renders("The FAQ page lists published questions", "careers/faq/page", "/careers/faq", ["faq-list", "Do you sponsor relocation?"]);
    await renders("A campaign landing page links its roles with the tracking code", "careers/p/[slug]/page", "/careers/p/smoke-depth-campus", ["Campus 2027", "campaign=SMOKEDEPTH"], { slug: "smoke-depth-campus" });
    const layout = (await import(`${W}/careers/layout`)).default as (p: { children: ReactNode }) => Promise<unknown>;
    const layoutHtml = await html(await layout({ children: React.createElement("p", null, "x") }), "/careers");
    check("Every careers page has a skip link, reduced motion and the analytics tag", layoutHtml.includes("skip-link") && layoutHtml.includes("G-SMOKE1234") && layoutHtml.includes("calm"));
    await signInAs("priya.sharma@acme.test");
    const lastSnap = await prisma.careerSiteSnapshot.findFirstOrThrow({ where: { tenantId, createdAt: { gte: started } }, orderBy: { version: "asc" } });
    const rolled = await careers.restoreCareerSiteSnapshotAction({}, fd({ id: lastSnap.id }));
    check("The site can be rolled back to an earlier version", rolled.ok === true && (await prisma.careerSiteConfig.findUnique({ where: { tenantId } }))?.analyticsTagId !== "G-SMOKE1234", rolled.message);

    // ---------------------------------------------------------------------
    section("Job alerts and the talent community");
    asPublic();
    const noConsent = await portal.subscribeJobAlertAction({}, fd({ email: `alerts${MAIL}`, keywords: "zzdepth" }));
    check("A job alert needs consent", noConsent.ok === false);
    const subd = await portal.subscribeJobAlertAction({}, fd({ email: `alerts${MAIL}`, keywords: "zzdepth", consent: "on" }));
    const confirmMail = await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `alerts${MAIL}` }, orderBy: { createdAt: "desc" } });
    const alertToken = /\/careers\/alerts\/([A-Za-z0-9._-]+)/.exec(confirmMail?.textBody ?? "")?.[1] ?? "";
    check("Subscribing sends a confirmation link (double opt-in)", subd.ok === true && !!alertToken && !(await prisma.jobAlertSubscription.findFirstOrThrow({ where: { tenantId, email: `alerts${MAIL}` } })).confirmedAt);
    const conf = await portal.jobAlertLinkAction({}, fd({ token: alertToken, op: "confirm" }));
    check("…the link confirms it", conf.ok === true && !!(await prisma.jobAlertSubscription.findFirstOrThrow({ where: { tenantId, email: `alerts${MAIL}` } })).confirmedAt);
    await signInAs("priya.sharma@acme.test");
    await ops.saveHireOpsSettingsAction({}, OPS({ requirePostingApproval: true }));
    await ops.unpublishJobAction({}, fd({ jobId: job.id }));
    const post = await ops.requestJobPostingAction({}, fd({ jobId: job.id }));
    check("With posting approval on, posting a job waits for approval", post.ok === true && !(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).isPublished, post.message);
    check("…goes live once approved", (await approveKind("JOB_POSTING", job.id)) === "APPROVED" && (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).isPublished);
    check("…and emails the matching subscriber once", (await prisma.emailOutbox.count({ where: { tenantId, toAddress: `alerts${MAIL}`, subject: { contains: "New role" } } })) === 1);
    await signInAs("priya.sharma@acme.test");
    await ops.saveHireOpsSettingsAction({}, OPS());
    asPublic();
    const unsub = await portal.jobAlertLinkAction({}, fd({ token: alertToken, op: "unsubscribe" }));
    check("…and the same link unsubscribes", unsub.ok === true && !!(await prisma.jobAlertSubscription.findFirstOrThrow({ where: { tenantId, email: `alerts${MAIL}` } })).unsubscribedAt);
    const joined = await portal.joinTalentCommunityAction({}, fd({ firstName: "Smoke", lastName: "Depth Community", email: `community${MAIL}`, interests: "SRE, platform", consent: "on" }));
    const member = await prisma.candidate.findFirst({ where: { tenantId, email: `community${MAIL}` }, include: { sourcingProfile: true, talentPools: { include: { pool: true } } } });
    check("Joining the talent community records consent and adds them to the community pool", joined.ok === true && member?.sourcingProfile?.consentStatus === "GRANTED" && member.talentPools.some((m) => m.pool.kind === "COMMUNITY"), joined.message);
    await renders("The alert and community pages render", "careers/alerts/page", "/careers/alerts", ["consent"]);

    // ---------------------------------------------------------------------
    section("Applicant portal");
    await signInAs("priya.sharma@acme.test");
    const ivP = (await schedule(appP.id, "Smoke depth: Public screen", 4, "10:00", [sneha.emp.id, meera.emp.id])).iv!;
    asPublic();
    setTestSessionNone();
    await renders("The applicant sees their status by their personal link", "careers/status/[token]/page", `/careers/status/${token}`, ["applicant-status", "Smoke depth: Public screen"], { token });
    check("A made-up link shows nothing", (await portal.applicantUpdateDetailsAction({}, fd({ token: `${token}x`, phone: "9876500099" }))).ok === false);
    const upd2 = await portal.applicantUpdateDetailsAction({}, fd({ token, phone: "+91 98765 00099", city: "Pune", timeZone: "Asia/Kolkata" }));
    check("The applicant updates their contact details (audited)", upd2.ok === true && (await prisma.candidate.findUniqueOrThrow({ where: { id: appP.candidateId } })).city === "Pune" && (await prisma.auditLog.count({ where: { tenantId, entityId: appP.candidateId, summary: { contains: "applicant portal" } } })) >= 1, upd2.message);
    const ask2 = await portal.applicantChangeRequestAction({}, fd({ token, field: "EXPECTED_CTC", value: "3100000", note: "Updated expectation" }));
    const cr = await prisma.applicantChangeRequest.findFirstOrThrow({ where: { applicationId: appP.id } });
    check("Changing expected CTC goes to the hiring team for approval", ask2.ok === true && cr.status === "PENDING" && !!cr.workflowRequestId, ask2.message);
    check("…only one at a time", (await portal.applicantChangeRequestAction({}, fd({ token, field: "NOTICE_PERIOD", value: "30" }))).ok === false);
    check("…and once approved it updates the candidate and emails them", (await approveKind("APPLICANT_CHANGE", cr.id)) === "APPROVED" && Number((await prisma.candidate.findUniqueOrThrow({ where: { id: appP.candidateId } })).expectedAnnualCtc) === 3100000 && !!(await prisma.emailOutbox.findFirst({ where: { tenantId, toAddress: `public${MAIL}`, textBody: { contains: "accepted" } } })));
    asPublic();
    setTestSessionNone();
    const rc = await portal.applicantRecordingConsentAction({}, fd({ token, interviewId: ivP.id, status: "DECLINED" }));
    check("The applicant answers the recording consent question", rc.ok === true && (await prisma.interviewConsent.findUniqueOrThrow({ where: { interviewId: ivP.id } })).status === "DECLINED", rc.message);
    const noConfirm = await portal.applicantWithdrawAction({}, fd({ token, reasonId: withdrawReason.id }));
    const wdOk = await portal.applicantWithdrawAction({}, fd({ token, reasonId: withdrawReason.id, confirm: "on" }));
    const appP2 = await prisma.application.findUniqueOrThrow({ where: { id: appP.id } });
    const dispP = await prisma.applicationDisposition.findUnique({ where: { applicationId: appP.id } });
    check("Withdrawing needs a confirmation, then closes the application with the reason", noConfirm.ok === false && wdOk.ok === true && appP2.status === "WITHDRAWN" && dispP?.byWhom === "CANDIDATE" && dispP.label === "Smoke depth: accepted another offer");
    check("…and cancels their interviews", (await prisma.interview.findUniqueOrThrow({ where: { id: ivP.id } })).status === "CANCELLED");
    check("A closed application cannot be changed from the portal", (await portal.applicantUpdateDetailsAction({}, fd({ token, city: "Delhi" }))).ok === false);

    // ---------------------------------------------------------------------
    section("Dispositions, withdrawals, alerts and the exception dashboard");
    await signInAs("priya.sharma@acme.test");
    const rej = await ops.rejectWithReasonAction({}, fd({ applicationId: appB.id, reasonId: rejectReason.id, note: "No on-call experience" }));
    check("Rejecting with a library reason records the disposition", rej.ok === true && (await prisma.applicationDisposition.findUniqueOrThrow({ where: { applicationId: appB.id } })).label === "Smoke depth: skills gap", rej.message);
    const wdApp = await ops.withdrawApplicationAction({}, fd({ applicationId: appAg.id, reasonId: withdrawReason.id }));
    check("A candidate's withdrawal is recorded by the recruiter", wdApp.ok === true && (await prisma.application.findUniqueOrThrow({ where: { id: appAg.id } })).status === "WITHDRAWN");
    const dispCsv = await csv("dispositions");
    check("The rejection and withdrawal reasons report exports", dispCsv.status === 200 && dispCsv.body.includes("Smoke depth: skills gap") && dispCsv.body.includes("Smoke depth: accepted another offer"));
    // Time passes: D waits in the first stage, a requisition waits for approval, another ages, feedback and an offer answer are overdue.
    await prisma.applicationStageHistory.updateMany({ where: { applicationId: appD.id, exitedAt: null }, data: { enteredAt: new Date(Date.now() - 10 * DAY) } });
    await prisma.application.update({ where: { id: appD.id }, data: { appliedAt: new Date(Date.now() - 10 * DAY) } });
    await prisma.$executeRaw`UPDATE applications SET "updatedAt" = ${new Date(Date.now() - 10 * DAY)} WHERE id = ${appD.id}`;
    await hiring.raiseRequisitionAction({}, fd({ title: "Smoke depth backlog", departmentId: dept.id, newHire: true, newPositions: 1, currency: "INR", salaryMin: 1000000, salaryMax: 1500000, salaryFrequency: "ANNUAL", description: "Backlog role for the alert test, waiting on approval.", justification: "Smoke depth" }));
    const stuck = await prisma.requisition.findFirstOrThrow({ where: { tenantId, title: "Smoke depth backlog" } });
    await prisma.$executeRaw`UPDATE requisitions SET "updatedAt" = ${new Date(Date.now() - 5 * DAY)} WHERE id = ${stuck.id}`;
    await prisma.requisition.update({ where: { id: req.id }, data: { status: "APPROVED", approvedAt: new Date(Date.now() - 90 * DAY) } }).catch(() => {});
    await prisma.interview.update({ where: { id: ivA.id }, data: { scheduledAt: new Date(Date.now() - 3 * DAY), status: "COMPLETED" } });
    for (const item of cfg.offerChecklist) if (!(await prisma.offerChecklistCheck.findUnique({ where: { applicationId_item: { applicationId: appA.id, item } } }))) await offers.tickOfferChecklistAction({}, fd({ applicationId: appA.id, item }));
    await hiring.offerOpAction({}, fd({ applicationId: appA.id, op: "extend" }));
    await prisma.offer.update({ where: { applicationId: appA.id }, data: { extendedAt: new Date(Date.now() - 7 * DAY) } });
    const run = await ops.runHireAlertsAction({}, fd({}));
    const alerts = await prisma.hireAlert.findMany({ where: { tenantId, createdAt: { gte: started } } });
    const kinds = new Set(alerts.filter((a) => [appD.id, ivA.id, appA.id, stuck.id, req.id].includes(a.entityId)).map((a) => a.kind));
    check("The alert job raises time-in-stage, screening SLA, stalled, overdue feedback, offer-answer and requisition alerts", run.ok === true && ["STAGE_TIME", "SCREEN_SLA", "STALLED", "FEEDBACK_OVERDUE", "OFFER_RESPONSE", "REQ_APPROVAL_SLA"].every((k) => kinds.has(k)), `${run.message} ${[...kinds].join(",")}`);
    check("…requisitions past their age limit too", kinds.has("REQ_AGING") || (await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } })).status !== "APPROVED");
    check("…with a task where someone must act", (await prisma.recruiterTask.count({ where: { tenantId, sourceKey: { startsWith: "alert:" }, applicationId: appD.id } })) >= 1);
    const again = await ops.runHireAlertsAction({}, fd({}));
    check("…each only once", again.ok === true && (await prisma.hireAlert.count({ where: { tenantId, createdAt: { gte: started } } })) === alerts.length);
    await renders("The exception dashboard lists open alerts", "(app)/hiring/exceptions/page", "/hiring/exceptions", ["exception-table", "Depth D"]);
    const one = alerts.find((a) => a.entityId === appD.id)!;
    const resolved = await ops.resolveHireAlertAction({}, fd({ id: one.id }));
    check("An alert can be resolved", resolved.ok === true && !!(await prisma.hireAlert.findUniqueOrThrow({ where: { id: one.id } })).resolvedAt);
    const exCsv = await csv("exceptions"), auditCsv = await csv("audit"), visitCsv = await csv("visits"), wlCsv = await csv("workload");
    check("Exceptions, audit trail, visits and workload export as CSV", [exCsv, auditCsv, visitCsv, wlCsv].every((x) => x.status === 200) && auditCsv.body.includes("Interview plan") && visitCsv.body.includes("smoke-depth-visit"));
    const [candCsv, locCsv, ivCsv, poolCsv, postCsv, apprCsv] = await Promise.all(["candidates", "locations", "interviews", "pools", "postings", "approvals"].map(csv));
    check("The candidate database exports (source, engagement, consent)", candCsv!.status === 200 && candCsv!.body.includes(`prospect${MAIL}`) && candCsv!.body.includes("WITHDRAWN"));
    check("The talent map groups candidates by city", locCsv!.status === 200 && /Pune,\d+/.test(locCsv!.body));
    check("Interviews by role count no-shows and scores", ivCsv!.status === 200 && ivCsv!.body.includes("Smoke depth SRE zzdepth"));
    check("Talent pools report members by status", poolCsv!.status === 200 && poolCsv!.body.includes("Smoke depth: SRE bench"));
    check("Job postings report shows SEO and translations", postCsv!.status === 200 && postCsv!.body.includes("Smoke depth SRE — Acme") && postCsv!.body.includes("hi"));
    check("Hiring approvals report lists every request and how long it took", apprCsv!.status === 200 && ["STAGE_MOVE", "OFFER_REVISION", "CANDIDATE_MERGE", "INTERVIEW_PLAN", "CONTENT_PUBLISH"].every((k) => apprCsv!.body.includes(k)));
    await renders("Insights shows the talent map and interviews by role", "(app)/hiring/insights/page", "/hiring/insights", ["talent-map", "interviews-by-role", "Pune"]);
    const bad = await exportRoute.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=nope`));
    check("…an unknown report is refused", bad.status === 400);
    await signInAs("meera.krishnan@acme.test");
    const forbidden = await exportRoute.GET(new NextRequest(`http://${HOST}/hiring/insights/export?kind=audit`));
    check("…and an employee cannot export", forbidden.status === 403);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  report("Hire depth");
}

function setTestSessionNone() { setTestSession(null); }

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
