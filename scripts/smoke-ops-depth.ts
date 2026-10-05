/**
 * Ops depth (time, attendance, leave, payroll, lifecycle), end to end through
 * the real session → viewer → permission chain and the generic workflow
 * engine (default-case routing of the OPS_* entity types):
 *
 *   Controls     ops settings (cut-off on the 25th), configuration changes
 *                under approval with versions, period locks, reason
 *                catalogues, attendance certification, breaks and exceptions,
 *                early-departure rules, exception scan.
 *   Project time activity codes, work packages, templates, correction requests,
 *                project time certification, task sign-off, idle time,
 *                overtime allocation, export profiles.
 *   Leave        blackout windows, balance adjustments under approval, long
 *                absences (two-step approval, cancel), cancelling approved
 *                leave through the manager.
 *   Payroll      input validation, variance rules, close checklist, component
 *                hierarchy, recurring rules, trace, payslip release and
 *                statutory sign-off under approval, statutory exceptions.
 *   Lifecycle    HR events under approval and edits, assignments (two-step),
 *                status changes with reason codes, FTE change (rejected),
 *                confirmation rules.
 *
 * Every page and CSV export is opened by the people who should (and should
 * not) see it. Everything created is removed and every change restored.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
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

const prisma = new PrismaClient();
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;
type State = { ok?: boolean; message?: string };

function form(values: Record<string, string | string[] | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  }
  return f;
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** A weekday at least `offset` days out. */
const weekday = (offset: number) => { let d = new Date(Date.now() + offset * 86_400_000); while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() + 86_400_000); return d.toISOString().slice(0, 10); };

const OPS_MODELS = [
  "opsApprovalRequest", "opsPolicyVersion", "opsReasonCode", "opsPeriodLock", "opsAttendanceCertification", "opsAttendanceAnomaly", "opsEarlyDepartureRule", "opsDeviceStatus",
  "opsBreakLog", "opsBreakRule", "opsAlertLog", "opsTimeTemplate", "opsTimeCode", "opsWorkPackage", "opsIdleLog", "opsTimeCertification", "opsExportProfile", "opsProjectOvertimeAllocation",
  "opsLeaveBlackout", "opsAbsenceCase", "opsAssignment", "opsStatusChange", "opsConfirmationRule", "opsEmploymentStint", "opsFteConversion", "opsComponentGroup",
  "opsRecurringComponentRule", "opsVarianceReview", "opsVarianceRule", "opsPayrollCloseItem", "opsPayrollValidation", "opsStatutoryException",
] as const;
type Del = { findMany: (a: unknown) => Promise<Array<{ id: string }>>; deleteMany: (a: unknown) => Promise<unknown> };

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
  async function render(page: Page, url: string): Promise<string> {
    const u = new URL(url, "http://acme.test");
    const sp: SP = Object.fromEntries(u.searchParams.entries());
    try {
      const tree = (await resolve(await page({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) }))) as ReactNode;
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

  const TA = await import("../apps/web/src/app/actions/ops-time-attend");
  const OP = await import("../apps/web/src/app/actions/ops-projects");
  const PY = await import("../apps/web/src/app/actions/ops-payroll");
  const LC = await import("../apps/web/src/app/actions/ops-lifecycle");
  const TM = await import("../apps/web/src/app/actions/time");
  const WP = await import("../apps/web/src/app/actions/workplace");
  const WF = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("../packages/services/src/index");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { workflowSources } = await import("../apps/web/src/app/(app)/inbox/_take/workflows");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = {
    controls: await load("time/controls"), insights: await load("time/insights"), leaveControls: await load("time/leave-controls"), projectTime: await load("projects/time-controls"),
    payroll: await load("payroll/controls"), lifecycle: await load("lifecycle"), activities: await load("activities"), workflows: await load("admin/workflows"),
  };
  const route = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/export/route`)).GET as (r: NextRequest) => Promise<Response>;
  const exports = { controls: await route("time/controls"), insights: await route("time/insights"), leave: await route("time/leave-controls"), projects: await route("projects/time-controls"), payroll: await route("payroll/controls"), lifecycle: await route("lifecycle"), activities: await route("activities") };
  const csv = (fn: (r: NextRequest) => Promise<Response>, url: string) => fn(new NextRequest(`http://acme.test${url}`));

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, exec, meera, ananya, sneha, ramesh, anjali, rahul] = await Promise.all([
    user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("deepak.chauhan@acme.test"), user("meera.krishnan@acme.test"), user("ananya.ghosh@acme.test"),
    user("sneha.reddy@acme.test"), user("ramesh.iyer@acme.test"), user("anjali.desai@acme.test"), user("rahul.kapoor@acme.test"),
  ]);
  const started = new Date();
  const tag = `OD${String(Date.now()).slice(-6)}`;

  // Snapshots for cleanup.
  const before: Record<string, Set<string>> = {};
  for (const m of OPS_MODELS) before[m] = new Set((await (prisma[m] as unknown as Del).findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id));
  const settingsBefore = await prisma.opsSetting.findUnique({ where: { tenantId } });
  const policy = await prisma.attendancePolicy.findFirstOrThrow({ where: { tenantId, name: "Standard" } });
  const anjaliSheet = await prisma.timesheet.findFirst({ where: { tenantId, employeeId: anjali.employee!.id, status: "APPROVED" }, orderBy: { periodStart: "desc" } });
  const task = await prisma.task.findFirstOrThrow({ where: { tenantId, status: { not: "DONE" }, project: { projectManager: { userId: sneha.id } } } });
  const augRun = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId, year: 2026, month: 8, type: "REGULAR", status: "FINALIZED" } });
  const sepRun = await prisma.payrollRun.findFirst({ where: { tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] }, rolledBackAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }] });
  const slips = await prisma.payslip.findMany({ where: { runId: augRun.id, status: "RELEASED" }, take: 2, select: { id: true, releasedAt: true, releasedBy: true } });
  const filingsBefore = new Set((await prisma.statutoryFiling.findMany({ where: { tenantId }, select: { id: true } })).map((f) => f.id));
  const meeraStatus = meera.employee!.status;
  const cl = await prisma.leaveType.findFirstOrThrow({ where: { tenantId, code: "CL" } });
  const leaveBefore = new Set((await prisma.leaveRequest.findMany({ where: { tenantId, employeeId: meera.employee!.id }, select: { id: true } })).map((x) => x.id));
  const madeActivities: string[] = [];

  /** Decide the pending engine task on an ops request as whoever holds it (not `skip`). */
  async function decideOps(id: string | undefined, approve = true, skip?: string): Promise<State & { by?: string }> {
    if (!id) return { ok: false, message: "no request" };
    const a = await prisma.opsApprovalRequest.findUniqueOrThrow({ where: { id } });
    const t = await prisma.workflowTask.findFirst({ where: { tenantId, status: "PENDING", request: { entityType: a.kind, entityId: id, status: "PENDING" }, ...(skip ? { approverUserId: { not: skip } } : {}) }, orderBy: { createdAt: "asc" } });
    if (!t?.approverUserId) return { ok: false, message: `no pending ${a.kind} task` };
    const u = await prisma.user.findUniqueOrThrow({ where: { id: t.approverUserId } });
    await signInAs(u.email);
    const r = await WF.decideWorkflowTaskAction({}, fd({ taskId: t.id, decision: approve ? "approve" : "reject", comment: approve ? "" : "Not this time" }));
    return { ...r, by: u.email };
  }
  const ops = (id?: string) => prisma.opsApprovalRequest.findUniqueOrThrow({ where: { id: id ?? "-" } });
  const latestOps = (kind: string) => prisma.opsApprovalRequest.findFirst({ where: { tenantId, kind, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });

  console.log("\nOps depth\n" + "=".repeat(72));
  try {
    // =========================================================================
    section("Pages and permissions");
    await signInAs(meera.email);
    check("An employee cannot open Time controls", (await render(pages.controls, "/time/controls")) === "403");
    check("…nor Payroll controls", (await render(pages.payroll, "/payroll/controls")) === "403");
    check("…nor the Time controls CSV", (await csv(exports.controls, "/time/controls/export?tab=locks")).status === 403);
    check("…nor the Payroll controls CSV", (await csv(exports.payroll, "/payroll/controls/export?tab=exceptions")).status === 403);
    await signInAs("arjun.nair@acme.test");
    check("An employee (and line manager) cannot open Lifecycle", (await render(pages.lifecycle, "/lifecycle")) === "403");
    await signInAs(meera.email);
    const selfLeave = await render(pages.leaveControls, "/time/leave-controls");
    check("An employee sees only their own leave controls (absences, calendar)", ok(selfLeave) && selfLeave.includes("Long absences") && !selfLeave.includes("Blackouts &amp; peaks"));
    check("An employee cannot change ops settings", (await TA.saveOpsSettingsAction({}, fd({ section: "attendance", attendanceCutoffDay: 20 }))).ok === false);

    await signInAs(admin.email);
    for (const tab of ["settings", "changes", "versions", "locks", "certification", "reasons", "early", "breaks"]) check(`Time controls › ${tab} renders`, ok(await render(pages.controls, `/time/controls?tab=${tab}`)));
    for (const tab of ["anomalies", "reconciliation", "devices", "sources", "heatmap", "leakage", "idle", "cutoff"]) check(`Time insights › ${tab} renders`, ok(await render(pages.insights, `/time/insights?tab=${tab}`)));
    for (const tab of ["blackouts", "absences", "adjustments", "calendar", "liability", "escalation"]) check(`Leave controls › ${tab} renders`, ok(await render(pages.leaveControls, `/time/leave-controls?tab=${tab}`)));
    for (const tab of ["codes", "packages", "templates", "locks", "corrections", "certification", "signoff", "overtime", "exports", "audit"]) check(`Project time controls › ${tab} renders`, ok(await render(pages.projectTime, `/projects/time-controls?tab=${tab}`)));
    for (const r of ["budget", "clients", "skills", "targets", "profit", "decisions", "tasks"]) check(`Project time report › ${r} renders`, ok(await render(pages.projectTime, `/projects/time-controls?tab=reports&r=${r}`)));
    for (const tab of ["validation", "variance", "close", "components", "recurring", "trace", "signoff", "exceptions", "lwf", "structure", "audit", "settings"]) check(`Payroll controls › ${tab} renders`, ok(await render(pages.payroll, `/payroll/controls?tab=${tab}`)));
    for (const tab of ["movements", "assignments", "status", "rehire", "fte", "confirmation", "contracts"]) check(`Lifecycle › ${tab} renders`, ok(await render(pages.lifecycle, `/lifecycle?tab=${tab}`)));

    // =========================================================================
    section("Settings and the payroll cut-off");
    const s1 = await TA.saveOpsSettingsAction({}, fd({ section: "attendance", attendanceCutoffDay: 25, cutoffAlertDaysBefore: 3, deviceStaleMinutes: 240, deviceOfflineMinutes: 1440, sourceMismatchMinutes: 15, anomalyNotify: "on" }));
    check("An attendance administrator saves the cut-off (25th)", s1.ok === true, s1.message);
    check("…stored", (await svc.getOpsSettings(tenantId)).attendanceCutoffDay === 25);
    check("…the window ends on the 25th", svc.opsAttendanceWindow(2026, 10, 25).to.toISOString().slice(0, 10) === "2026-10-25" && svc.opsAttendanceWindow(2026, 10, 25).from.toISOString().slice(0, 10) === "2026-09-26");
    check("A bad value is refused", (await TA.saveOpsSettingsAction({}, fd({ section: "leave", leaveWithdrawalWindowDays: 500 }))).ok === false);
    check("…and the change is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "OpsSetting", createdAt: { gte: started } } })));

    // =========================================================================
    section("Configuration change under approval");
    check("Governance: attendance policy changes need approval", (await TA.saveOpsSettingsAction({}, form({ section: "governance", approvalKinds: ["ATTENDANCE_POLICY", "LEAVE_TYPE"] }))).ok === true);
    await signInAs(hr.email);
    const grace = policy.graceMinutes;
    const prop = await TA.proposeConfigChangeAction({}, fd({ kind: "ATTENDANCE_POLICY", targetId: policy.id, f_graceMinutes: grace + 5, reason: `${tag} more grace` }));
    check("An HR manager proposes more late grace", prop.ok === true, prop.message);
    const cc = await latestOps("OPS_CONFIG_CHANGE");
    check("…it waits for a second administrator", cc?.status === "PENDING");
    check("…and the policy is unchanged meanwhile", (await prisma.attendancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).graceMinutes === grace);
    check("…the same change cannot be raised twice", (await TA.proposeConfigChangeAction({}, fd({ kind: "ATTENDANCE_POLICY", targetId: policy.id, f_graceMinutes: grace + 5 }))).ok === false);
    check("Nothing-changes proposals are refused", (await TA.proposeConfigChangeAction({}, fd({ kind: "LEAVE_TYPE", targetId: cl.id, f_annualQuota: Number(cl.annualQuota) }))).ok === false);
    await signInAs(admin.email);
    const wfHtml = await render(pages.workflows, "/admin/workflows?tab=requests");
    check("It shows in Admin › Workflows requests", wfHtml.includes(`Change attendance policy`));
    const pendingTask = await prisma.workflowTask.findFirst({ where: { tenantId, status: "PENDING", request: { entityType: "OPS_CONFIG_CHANGE", entityId: cc?.id } } });
    const approverViewer = pendingTask?.approverUserId ? await viewerForUser(pendingTask.approverUserId) : null;
    const [wfSrc] = approverViewer ? await workflowSources(approverViewer) : [];
    check("…and in the approver's inbox Approvals", !!wfSrc && (await wfSrc.list()).some((x) => /attendance policy/i.test(x.title)));
    const ccOk = await decideOps(cc?.id, true, hr.id);
    check("A second administrator approves it", ccOk.ok === true, ccOk.message);
    check("…the change is applied", (await ops(cc?.id)).status === "APPLIED" && (await prisma.attendancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).graceMinutes === grace + 5);
    const ver = await prisma.opsPolicyVersion.findFirst({ where: { tenantId, kind: "ATTENDANCE_POLICY", targetId: policy.id }, orderBy: { version: "desc" } });
    check("…and versioned with the change summary", !!ver && /Late grace/.test(ver.summary));
    check("The version report lists it", (await svc.opsPolicyReport(tenantId, "ATTENDANCE_POLICY")).rows.some((r) => r.id === policy.id && r.versions >= 1));
    await signInAs(hr.email);
    const prop2 = await TA.proposeConfigChangeAction({}, fd({ kind: "ATTENDANCE_POLICY", targetId: policy.id, f_graceMinutes: grace, reason: "Back" }));
    const cc2 = await latestOps("OPS_CONFIG_CHANGE");
    const rej = await decideOps(cc2?.id, false, hr.id);
    check("A second proposal is rejected", prop2.ok === true && rej.ok === true && (await ops(cc2?.id)).status === "REJECTED", rej.message);
    check("…and nothing changes", (await prisma.attendancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).graceMinutes === grace + 5);
    await signInAs(admin.email);
    check("Turning governance off applies directly", (await TA.saveOpsSettingsAction({}, form({ section: "governance", approvalKinds: [] }))).ok === true
      && (await TA.proposeConfigChangeAction({}, fd({ kind: "ATTENDANCE_POLICY", targetId: policy.id, f_graceMinutes: grace }))).ok === true
      && (await prisma.attendancePolicy.findUniqueOrThrow({ where: { id: policy.id } })).graceMinutes === grace);
    const vcsv = await csv(exports.controls, "/time/controls/export?tab=versions&kind=ATTENDANCE_POLICY");
    check("The policy version CSV downloads and is audited", vcsv.status === 200 && (await vcsv.text()).includes("Late grace") && !!(await prisma.auditLog.findFirst({ where: { tenantId, action: "EXPORT", entityType: "OpsPolicyVersion", createdAt: { gte: started } } })));

    // =========================================================================
    section("Reason catalogues, locks and regularisation");
    check("A regularisation reason is added", (await TA.saveReasonCodeAction({}, fd({ kind: "REGULARISATION", code: `${tag}FP`, label: "Forgot to punch" }))).ok === true);
    check("…duplicates are refused", (await TA.saveReasonCodeAction({}, fd({ kind: "REGULARISATION", code: `${tag}FP`, label: "Again" }))).ok === false);
    check("A status reason is added for notice period", (await TA.saveReasonCodeAction({}, fd({ kind: "STATUS", code: `${tag}RES`, label: "Resigned", appliesTo: "NOTICE_PERIOD" }))).ok === true);
    check("…and one to confirm", (await TA.saveReasonCodeAction({}, fd({ kind: "STATUS", code: `${tag}CNF`, label: "Withdrew resignation", appliesTo: "CONFIRMED" }))).ok === true);
    check("An idle-time category is added", (await TA.saveReasonCodeAction({}, fd({ kind: "IDLE", code: `${tag}WAIT`, label: "Waiting on work" }))).ok === true);
    const lockFrom = day(-40), lockTo = day(-35);
    check("Attendance for a past week is locked", (await TA.lockPeriodAction({}, fd({ domain: "ATTENDANCE", periodStart: lockFrom, periodEnd: lockTo, reason: `${tag} payroll closed` }))).ok === true);
    check("…an overlapping lock is refused", (await TA.lockPeriodAction({}, fd({ domain: "ATTENDANCE", periodStart: day(-37), periodEnd: day(-30) }))).ok === false);
    await signInAs(meera.email);
    const lockedReq = await TM.raiseAttendanceRequestAction({}, fd({ type: "ADJUSTMENT", fromDate: day(-38), inTime: "09:30", outTime: "18:30", reason: "Forgot to punch", reasonCode: `${tag}FP` }));
    check("An employee cannot raise a request in a locked period", lockedReq.ok === false && /lock/i.test(lockedReq.message ?? ""), lockedReq.message);
    const reqOk = await TM.raiseAttendanceRequestAction({}, fd({ type: "ADJUSTMENT", fromDate: weekday(-3) > day(0) ? day(-3) : day(-3), inTime: "09:30", outTime: "18:30", reason: `${tag} forgot`, reasonCode: `${tag}FP` }));
    const ar = await prisma.attendanceRequest.findFirst({ where: { tenantId, employeeId: meera.employee!.id, reason: `${tag} forgot` } });
    check("Outside the lock a regularisation carries its reason code", reqOk.ok === true && ar?.reasonCode === `${tag}FP`, reqOk.message);
    check("…an unknown reason code is refused", (await TM.raiseAttendanceRequestAction({}, fd({ type: "ADJUSTMENT", fromDate: day(-4), inTime: "09:30", outTime: "18:30", reason: "x y z", reasonCode: "NOPE" }))).ok === false);
    check("The regularisation report counts it by reason", (await svc.regularisationReasonReport(tenantId, new Date(Date.now() - 86_400_000), new Date())).some((r) => r.code === `${tag}FP` && r.total >= 1));
    if (ar) await prisma.attendanceRequest.delete({ where: { id: ar.id } });
    await signInAs(admin.email);
    const lock = await prisma.opsPeriodLock.findFirstOrThrow({ where: { tenantId, reason: `${tag} payroll closed` } });
    check("Reopening needs a reason", (await TA.reopenPeriodAction({}, fd({ id: lock.id, reason: "" }))).ok === false);
    check("…and reopens the period", (await TA.reopenPeriodAction({}, fd({ id: lock.id, reason: "Late correction" }))).ok === true && (await prisma.opsPeriodLock.findUniqueOrThrow({ where: { id: lock.id } })).status === "REOPENED");

    // =========================================================================
    section("Exceptions, certification, early departure, breaks");
    const scan = await TA.runAnomaliesAction({}, fd({ from: day(-10), to: day(-1) }));
    check("An exception scan runs over the last days", scan.ok === true, scan.message);
    const anomaly = await prisma.opsAttendanceAnomaly.findFirst({ where: { tenantId, status: "OPEN" } });
    if (anomaly) check("…an exception is resolved with a note", (await TA.resolveAnomalyAction({}, fd({ id: anomaly.id, action: "RESOLVED", note: "Checked with the manager" }))).ok === true && (await prisma.opsAttendanceAnomaly.findUniqueOrThrow({ where: { id: anomaly.id } })).status === "RESOLVED");
    const icsv = await csv(exports.insights, `/time/insights/export?tab=anomalies&from=${day(-10)}&to=${day(-1)}`);
    check("The exceptions CSV downloads", icsv.status === 200 && (await icsv.text()).includes("Exception"));
    const rcsv = await csv(exports.insights, "/time/insights/export?tab=reconciliation");
    check("The reconciliation CSV downloads", rcsv.status === 200 && (await rcsv.text()).includes("Ready"));
    const recon = await svc.reconciliationDashboard(tenantId, 2026, 9, {});
    check("Reconciliation covers the 26 Aug – 25 Sep window", recon.from.toISOString().slice(0, 10) === "2026-08-26" && recon.to.toISOString().slice(0, 10) === "2026-09-25" && recon.rows.length > 0);
    check("Device health runs", (await TA.runDeviceHealthAction({}, fd({}))).ok === true);

    await signInAs(hr.email);
    const cert = await TA.certifyMonthAction({}, fd({ year: 2026, month: 9, note: tag }));
    check("HR certifies September's attendance for payroll", cert.ok === true, cert.message);
    const certReq = await latestOps("OPS_ATTENDANCE_CERT");
    const certOk = await decideOps(certReq?.id, true, hr.id);
    check("…payroll approves it", certOk.ok === true && (await ops(certReq?.id)).status === "APPLIED", certOk.message);
    const certRow = await prisma.opsAttendanceCertification.findFirst({ where: { tenantId, scope: "MONTH", note: tag } });
    check("…the certification is approved", certRow?.status === "APPROVED");
    await signInAs(admin.email);
    check("An early-departure rule is saved", (await TA.saveEarlyDepartureRuleAction({}, fd({ policyKey: "ALL", graceMinutes: 15, exemptPerMonth: 2, penaltyDays: 0.5 }))).ok === true);
    check("…and the report runs", Array.isArray(await svc.earlyDepartureReport(tenantId, 2026, 9)));
    check("A break type is added", (await TA.saveBreakRuleAction({}, fd({ name: `${tag} Tea`, code: `${tag}TEA`, maxMinutes: 15, maxPerDay: 2 }))).ok === true);
    const rule = await prisma.opsBreakRule.findFirstOrThrow({ where: { tenantId, code: `${tag}TEA` } });
    await signInAs(meera.email);
    check("An employee starts a break", (await TA.startBreakAction({}, fd({ ruleId: rule.id }))).ok === true);
    check("…cannot start another while on one", (await TA.startBreakAction({}, fd({ ruleId: rule.id }))).ok === false);
    check("…and ends it", (await TA.endBreakAction({}, fd({}))).ok === true);
    await signInAs(admin.email);
    const entry = await TA.saveBreakEntryAction({}, fd({ employeeId: meera.employee!.id, ruleId: rule.id, date: day(-1), start: "13:00", end: "13:40", note: "Long lunch" }));
    check("An administrator records a 40-minute break (over the 15-minute limit)", entry.ok === true, entry.message);
    const longBreak = await prisma.opsBreakLog.findFirstOrThrow({ where: { tenantId, employeeId: meera.employee!.id, ruleId: rule.id, minutes: 40 } });
    check("…it is marked exceeded", longBreak.status === "EXCEEDED");
    await signInAs(meera.email);
    check("The employee explains it", (await TA.requestBreakExceptionAction({}, fd({ breakId: longBreak.id, reason: "Client lunch ran long" }))).ok === true);
    const brk = await latestOps("OPS_BREAK_EXCEPTION");
    const brkOk = await decideOps(brk?.id);
    check("…the manager approves the exception", brkOk.ok === true && brkOk.by === ananya.email, `${brkOk.message} ${brkOk.by}`);
    check("…and the break is excused", (await prisma.opsBreakLog.findUniqueOrThrow({ where: { id: longBreak.id } })).status === "EXCEPTION_APPROVED");

    // =========================================================================
    section("Project time");
    await signInAs(admin.email);
    check("An activity code is added", (await OP.saveTimeCodeAction({}, fd({ code: `${tag}DEV`, label: "Development", billable: "yes", requiresTask: "on" }))).ok === true);
    check("A work package is added", (await OP.saveWorkPackageAction({}, fd({ projectId: task.projectId, code: `${tag}WP1`, name: "Phase 1", budgetHours: 40 }))).ok === true);
    check("…duplicate codes on a project are refused", (await OP.saveWorkPackageAction({}, fd({ projectId: task.projectId, code: `${tag}WP1`, name: "Again" }))).ok === false);
    await signInAs(meera.email);
    const proj = await prisma.project.findFirstOrThrow({ where: { id: task.projectId } });
    check("An employee saves a one-row template", (await OP.saveTimeTemplateAction({}, fd({ name: `${tag} Standard week`, projectId: proj.id, h0: 8, h1: 8, h2: 8, h3: 8, h4: 8 }))).ok === true);
    check("…an employee cannot share one with everyone", (await OP.saveTimeTemplateAction({}, fd({ name: `${tag} Shared`, shared: "on", projectId: proj.id, h0: 1 }))).ok === false);
    check("…and it is offered on the timesheet", (await svc.timeTemplatesFor(tenantId, meera.employee!.id)).some((t) => t.name === `${tag} Standard week`));
    check("Idle time is logged with a category", (await OP.logIdleTimeAction({}, fd({ date: day(-1), minutes: 45, category: `${tag}WAIT`, note: "Build server down" }))).ok === true);
    check("…an unknown category is refused", (await OP.logIdleTimeAction({}, fd({ date: day(-1), minutes: 45, category: "NOPE" }))).ok === false);
    check("…and the leakage report counts it", (await svc.timeLeakageReport(tenantId, new Date(Date.now() - 2 * 86_400_000), new Date(), [meera.employee!.id]))[0]!.idle >= 0.75);

    if (anjaliSheet) {
      await signInAs(anjali.email);
      const corr = await OP.requestTimeCorrectionAction({}, fd({ timesheetId: anjaliSheet.id, reason: `${tag} wrong project on Tuesday` }));
      check("An employee asks to correct an approved week", corr.ok === true, corr.message);
      const corrReq = await latestOps("OPS_TIME_CORRECTION");
      const corrOk = await decideOps(corrReq?.id);
      check("…their manager approves it", corrOk.ok === true && corrOk.by === rahul.email, `${corrOk.message} ${corrOk.by}`);
      check("…and the week reopens as a draft", (await prisma.timesheet.findUniqueOrThrow({ where: { id: anjaliSheet.id } })).status === "DRAFT");
    }

    await signInAs(sneha.email);
    const pc = await OP.certifyProjectTimeAction({}, fd({ projectId: proj.id, from: "2020-01-01", to: "2020-01-31", statement: "Hours are complete and accurate." }));
    check("The project manager certifies the project's time", pc.ok === true, pc.message);
    const pcReq = await latestOps("OPS_TIME_CERT");
    const pcOk = await decideOps(pcReq?.id, true, sneha.id);
    check("…the PMO approves it", pcOk.ok === true && (await prisma.opsTimeCertification.findFirstOrThrow({ where: { tenantId, approvalId: pcReq?.id } })).status === "APPROVED", pcOk.message);
    await signInAs(meera.email);
    check("Someone outside the project cannot certify it", (await OP.certifyProjectTimeAction({}, fd({ projectId: proj.id, from: "2020-02-01", to: "2020-02-28", statement: "x" }))).ok === false);

    await signInAs(admin.email);
    const ts = await OP.requestTaskSignoffAction({}, fd({ taskId: task.id, projectId: task.projectId, note: tag }));
    check("Sign-off is requested on a task", ts.ok === true, ts.message);
    const tsReq = await latestOps("OPS_TASK_SIGNOFF");
    const tsOk = await decideOps(tsReq?.id);
    check("…the project manager signs it off", tsOk.ok === true && tsOk.by === sneha.email, `${tsOk.message} ${tsOk.by}`);
    check("…and the task is done", (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status === "DONE");
    await signInAs(admin.email);
    check("Overtime is allocated to projects", (await OP.allocateOvertimeAction({}, fd({ year: 2026, month: 9 }))).ok === true);
    check("An export profile is saved", (await OP.saveExportProfileAction({}, form({ name: `${tag} Client billing`, columns: ["date", "employee", "project", "hours", "billAmount"], approvedOnly: "on" }))).ok === true);
    const prof = await prisma.opsExportProfile.findFirstOrThrow({ where: { tenantId, name: `${tag} Client billing` } });
    const pcsv = await csv(exports.projects, `/projects/time-controls/export?tab=profile&id=${prof.id}&from=2026-01-01&to=${day(0)}`);
    const ptext = await pcsv.text();
    check("…its CSV has the chosen columns", pcsv.status === 200 && ptext.split("\n")[0]!.includes("Bill amount"));
    for (const r of ["budget", "profit", "decisions", "tasks"]) check(`The ${r} report CSV downloads`, (await csv(exports.projects, `/projects/time-controls/export?tab=reports&r=${r}`)).status === 200);
    check("Timesheets are locked for a past period", (await OP.lockTimesheetsAction({}, fd({ from: "2020-03-02", to: "2020-03-29", reason: tag }))).ok === true);

    // =========================================================================
    section("Leave controls");
    await signInAs(admin.email);
    const bFrom = weekday(150), bTo = day(Math.round((Date.parse(bFrom) - Date.now()) / 86_400_000) + 3);
    check("A blackout is added", (await TA.saveLeaveBlackoutAction({}, fd({ name: `${tag} Year end`, kind: "BLACKOUT", startDate: bFrom, endDate: bTo, reason: "Close" }))).ok === true);
    check("…a peak period needs a cap", (await TA.saveLeaveBlackoutAction({}, fd({ name: `${tag} Peak`, kind: "PEAK", startDate: bFrom, endDate: bTo }))).ok === false);
    await signInAs(meera.email);
    const blocked = await TM.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: bFrom, toDate: bFrom, reason: "Trip" }));
    check("An employee cannot apply for leave in the blackout", blocked.ok === false && /closed/i.test(blocked.message ?? ""), blocked.message);
    await signInAs(admin.email);
    check("Balance adjustments need approval", (await TA.saveOpsSettingsAction({}, fd({ section: "leave", requireBalanceAdjustmentApproval: "on", requireLeaveCancellationApproval: "on", leaveCalendarVisibility: "TEAM" }))).ok === true);
    const balBefore = await prisma.leaveBalance.findFirst({ where: { employeeId: meera.employee!.id, leaveTypeId: cl.id }, orderBy: { yearStart: "desc" } });
    await signInAs(hr.email);
    const adj = await TA.requestBalanceAdjustmentAction({}, fd({ employeeId: meera.employee!.id, leaveTypeId: cl.id, days: 1, note: `${tag} credit` }));
    check("HR requests a +1 day adjustment", adj.ok === true, adj.message);
    const adjReq = await latestOps("OPS_LEAVE_ADJUSTMENT");
    check("…the balance is unchanged until approved", Number((await prisma.leaveBalance.findFirst({ where: { id: balBefore?.id ?? "-" } }))?.available ?? 0) === Number(balBefore?.available ?? 0));
    const adjOk = await decideOps(adjReq?.id, true, hr.id);
    check("…a second leave administrator approves it", adjOk.ok === true && (await ops(adjReq?.id)).status === "APPLIED", adjOk.message);
    const balAfter = await prisma.leaveBalance.findFirst({ where: { employeeId: meera.employee!.id, leaveTypeId: cl.id }, orderBy: { yearStart: "desc" } });
    check("…and the balance goes up by a day", Number(balAfter?.available ?? 0) === Number(balBefore?.available ?? 0) + 1);
    await svc.adjustBalance({ employeeId: meera.employee!.id, leaveTypeId: cl.id, days: -1, note: `${tag} reverse`, actorId: admin.id } as never).catch(() => null);

    await signInAs(meera.email);
    const lvDate = weekday(60);
    const applied = await TM.applyLeaveAction({}, fd({ leaveTypeId: cl.id, fromDate: lvDate, toDate: lvDate, reason: `${tag} family` }));
    const lv = await prisma.leaveRequest.findFirst({ where: { tenantId, employeeId: meera.employee!.id, reason: `${tag} family` } });
    check("An employee applies for a day of leave", applied.ok === true && !!lv, applied.message);
    await signInAs(ananya.email);
    check("…the manager approves it", (await TM.decideLeaveAction({}, fd({ requestId: lv?.id ?? "-", decision: "approve" }))).ok === true && (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lv!.id } })).status === "APPROVED");
    await signInAs(meera.email);
    const canc = await TM.cancelLeaveAction({}, fd({ requestId: lv!.id, reason: "Plans changed" }));
    check("Cancelling approved leave goes to the manager", canc.ok === true && /approval/i.test(canc.message ?? ""), canc.message);
    check("…the leave stays booked meanwhile", (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lv!.id } })).status === "APPROVED");
    const cReq = await latestOps("OPS_LEAVE_CANCELLATION");
    const cOk = await decideOps(cReq?.id);
    check("…the manager approves the cancellation", cOk.ok === true && cOk.by === ananya.email, `${cOk.message} ${cOk.by}`);
    check("…and the leave is cancelled", (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lv!.id } })).status === "CANCELLED");

    await signInAs(meera.email);
    const abs = await TA.requestAbsenceAction({}, fd({ kind: "SABBATICAL", startDate: day(200), expectedReturn: day(260), note: tag }));
    check("An employee requests a sabbatical", abs.ok === true, abs.message);
    check("…a short absence is refused", (await TA.requestAbsenceAction({}, fd({ kind: "PERSONAL", startDate: day(300), expectedReturn: day(305) }))).ok === false);
    const absReq = await latestOps("OPS_ABSENCE");
    const a1 = await decideOps(absReq?.id);
    check("…the manager approves (step 1)", a1.ok === true && a1.by === ananya.email, `${a1.message} ${a1.by}`);
    const a2 = await decideOps(absReq?.id);
    check("…a leave administrator approves (step 2)", a2.ok === true && (await ops(absReq?.id)).status === "APPLIED", a2.message);
    const absCase = await prisma.opsAbsenceCase.findFirstOrThrow({ where: { tenantId, employeeId: meera.employee!.id, note: tag } });
    check("…the absence is approved and has a return checklist", absCase.status === "APPROVED" && Array.isArray(absCase.checklist));
    await signInAs(hr.email);
    check("HR ticks the checklist", (await TA.tickReturnChecklistAction({}, form({ caseId: absCase.id, done: ["0", "1"] }))).ok === true);
    check("…a return before it starts is refused", (await TA.completeReturnAction({}, fd({ caseId: absCase.id, returnedOn: day(0) }))).ok === false);
    check("…and the absence is cancelled", (await TA.cancelAbsenceAction({}, fd({ caseId: absCase.id }))).ok === true && (await prisma.opsAbsenceCase.findUniqueOrThrow({ where: { id: absCase.id } })).status === "CANCELLED");
    const cal = await svc.leaveCalendarFor(tenantId, meera.employee!.id, 2026, 10);
    check("The leave calendar follows the TEAM rule", cal.rule === "TEAM");
    check("The liability forecast runs", (await svc.leaveLiabilityForecast(tenantId, 12)).forecast.length === 12);
    const lcsv = await csv(exports.leave, "/time/leave-controls/export?tab=blackouts");
    check("The blackout CSV downloads for HR", lcsv.status === 200 && (await lcsv.text()).includes(`${tag} Year end`));

    // =========================================================================
    section("Payroll controls");
    await signInAs(ramesh.email);
    if (sepRun) {
      const val = await PY.validateRunAction({}, fd({ runId: sepRun.id }));
      check("Payroll validates the open run's inputs", val.ok === true && /checked/.test(val.message ?? ""), val.message);
      check("…the result is kept", !!(await svc.latestValidation(tenantId, sepRun.id)));
    }
    await signInAs(admin.email);
    check("A blocking variance rule is added", (await PY.saveVarianceRuleAction({}, fd({ name: `${tag} Net 1%`, metric: "NET", thresholdPct: 1, severity: "BLOCK" }))).ok === true);
    check("…a component rule needs its component", (await PY.saveVarianceRuleAction({}, fd({ name: `${tag} comp`, metric: "COMPONENT", thresholdPct: 1 }))).ok === false);
    const vb = await svc.varianceBreaches(tenantId, augRun.id);
    check("Variance compares August with July", vb?.previous === "Jul 2026");
    if (vb?.rows.length) {
      await signInAs(ramesh.email);
      const row = vb.rows[0]!;
      check("…a breach is reviewed with an explanation", (await PY.reviewVarianceAction({}, fd({ runId: augRun.id, employeeId: row.employeeId, ruleId: row.ruleId, note: "Arrears paid" }))).ok === true);
    }
    await signInAs(ramesh.email);
    check("A close checklist item is ticked", (await PY.setCloseItemAction({}, fd({ runId: augRun.id, key: "JOURNAL_POSTED", done: "true", note: tag }))).ok === true && (await svc.closeChecklist(tenantId, augRun.id)).find((i) => i.key === "JOURNAL_POSTED")?.done === true);
    await signInAs(admin.email);
    check("An earnings group is added", (await PY.saveComponentGroupAction({}, form({ kind: "EARNING", name: `${tag} Fixed pay`, componentCodes: ["BASIC"] }))).ok === true);
    const grp = await prisma.opsComponentGroup.findFirstOrThrow({ where: { tenantId, name: `${tag} Fixed pay` } });
    check("…with a subgroup", (await PY.saveComponentGroupAction({}, form({ kind: "EARNING", name: `${tag} Allowances`, parentId: grp.id, componentCodes: ["HRA"] }))).ok === true);
    const h = await svc.componentHierarchy(tenantId, "EARNING", augRun.id);
    check("…the hierarchy totals August's amounts", (h.groups.find((g) => g.id === grp.id)?.total ?? 0) > 0);
    check("A recurring payment rule is added", (await PY.saveRecurringRuleAction({}, form({ name: `${tag} Internet`, type: "PAYMENT", amount: "500", frequency: "MONTHLY", startDate: "2026-01-01" }))).ok === true);
    if (sepRun) {
      const ap = await PY.applyRecurringRulesAction({}, fd({ runId: sepRun.id }));
      check("…it is applied to the open run as one-time items", ap.ok === true && (await prisma.adhocTransaction.count({ where: { sourceType: "OpsRecurringRule", year: sepRun.year, month: sepRun.month } })) > 0, ap.message);
    }
    const emp = await prisma.payrollRunEmployee.findFirstOrThrow({ where: { runId: augRun.id } });
    const tr = await svc.payrollTrace(tenantId, augRun.id, emp.employeeId);
    check("The calculation trace explains an employee's pay", !!tr && tr.steps.some((s) => s.step === "Result") && tr.steps.some((s) => s.step === "Statutory"));
    check("…and downloads as CSV", (await csv(exports.payroll, `/payroll/controls/export?tab=trace&run=${augRun.id}&emp=${emp.employeeId}`)).status === 200);

    check("Payslip release and statutory sign-off need approval", (await TA.saveOpsSettingsAction({}, fd({ section: "payroll", netPayRoundTo: 1, netPayRoundingMode: "NEAREST", negativeNetPayAction: "WARN", requirePayslipApproval: "on", requireFilingApproval: "on" }))).ok === true);
    await prisma.payslip.updateMany({ where: { id: { in: slips.map((s) => s.id) } }, data: { status: "GENERATED", releasedAt: null, releasedBy: null } });
    await signInAs(ramesh.email);
    const rel = await PY.requestPayslipReleaseAction({}, fd({ runId: augRun.id, note: tag }));
    check("Payroll asks to release the remaining payslips", rel.ok === true, rel.message);
    const relReq = await latestOps("OPS_PAYSLIP_RELEASE");
    const relOk = await decideOps(relReq?.id, true, ramesh.id);
    check("…the payroll approver approves", relOk.ok === true && relOk.by === admin.email, `${relOk.message} ${relOk.by}`);
    check("…and the payslips are released", (await prisma.payslip.count({ where: { id: { in: slips.map((s) => s.id) }, status: "RELEASED" } })) === slips.length);
    const so = await PY.requestStatutorySignoffAction({}, fd({ type: "PT_RETURN", year: 2026, month: 8, note: tag }));
    check("Payroll asks for sign-off on August's PT return", so.ok === true, so.message);
    const soReq = await latestOps("OPS_STATUTORY_SIGNOFF");
    const filing = await prisma.statutoryFiling.findUniqueOrThrow({ where: { id: soReq?.targetId ?? "-" } });
    check("…marking it filed is blocked until signed off", !!(await svc.opsFilingGate(tenantId, filing.id)));
    const soOk = await decideOps(soReq?.id, true, ramesh.id);
    check("…the approver signs it off", soOk.ok === true && !!((await prisma.statutoryFiling.findUniqueOrThrow({ where: { id: filing.id } })).meta as Record<string, unknown>)?.signedOffAt, soOk.message);
    await signInAs(admin.email);
    check("…and it can now be filed", (await svc.opsFilingGate(tenantId, filing.id)) === null);
    check("Statutory exceptions are re-checked", (await PY.refreshStatutoryExceptionsAction({}, fd({ year: 2026, month: 8 }))).ok === true);
    const ex = await prisma.opsStatutoryException.findFirst({ where: { tenantId, status: "OPEN" } });
    if (ex) check("…one is resolved with a note", (await PY.resolveStatutoryExceptionAction({}, fd({ id: ex.id, status: "RESOLVED", note: "UAN added" }))).ok === true);
    check("LWF reconciliation runs", Array.isArray((await svc.lwfReconciliation(tenantId, 2026, 6)).rows));
    const st = await prisma.salaryStructure.findFirst({ where: { payGroup: { tenantId } } });
    if (st) check("A structure is checked at a CTC", !!(await svc.validateStructureStatutory(tenantId, st.id, 240000, "KA")));
    check("The input audit CSV downloads", (await csv(exports.payroll, "/payroll/controls/export?tab=audit")).status === 200);
    await signInAs(meera.email);
    check("An employee cannot ask for payslip release", (await PY.requestPayslipReleaseAction({}, fd({ runId: augRun.id }))).ok === false);

    // =========================================================================
    section("Lifecycle");
    await signInAs(admin.email);
    check("Warnings need approval", (await TA.saveOpsSettingsAction({}, form({ section: "lifecycle", eventTypesNeedingApproval: ["WARNING"], contractAlertDays: "60, 30, 7" }))).ok === true);
    await signInAs(hr.email);
    await WP.recordHrActivity(fd({ employeeId: meera.employee!.id, type: "WARNING", title: `${tag} Late to client`, severity: "MINOR", description: "Third late arrival" }));
    const act = await prisma.hrActivity.findFirstOrThrow({ where: { tenantId, title: `${tag} Late to client` } });
    madeActivities.push(act.id);
    check("A recorded warning waits for approval", act.approvalStatus === "PENDING");
    const actsHtml = await render(pages.activities, `/activities?status=PENDING&q=${tag}`);
    check("…the activities page finds it under pending", actsHtml.includes(`${tag} Late to client`));
    const hrReq = await latestOps("OPS_HR_EVENT");
    const hrOk = await decideOps(hrReq?.id, true, hr.id);
    check("…an HR administrator approves it", hrOk.ok === true && (await prisma.hrActivity.findUniqueOrThrow({ where: { id: act.id } })).approvalStatus === "APPROVED", hrOk.message);
    await signInAs(hr.email);
    check("The event is edited", (await LC.editHrActivityAction({}, fd({ id: act.id, title: `${tag} Late to client meeting`, occurredOn: day(-1), severity: "MAJOR" }))).ok === true);
    check("…and the edit is audited with before and after", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "HrActivity", entityId: act.id, action: "UPDATE" } })));
    const acsv = await csv(exports.activities, `/activities/export?q=${tag}`);
    check("The activities CSV has it", acsv.status === 200 && (await acsv.text()).includes(`${tag} Late to client meeting`));

    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId, id: { not: meera.employee!.departmentId ?? "-" } } });
    const asg = await LC.requestAssignmentAction({}, fd({ employeeId: meera.employee!.id, kind: "TEMPORARY", hostDepartmentId: dept.id, role: "Analyst", startDate: day(30), endDate: day(90), costSharePct: 50, note: tag }));
    check("HR requests a temporary assignment", asg.ok === true, asg.message);
    check("…a secondment without a host is refused", (await LC.requestAssignmentAction({}, fd({ employeeId: meera.employee!.id, kind: "SECONDMENT", startDate: day(100), endDate: day(160) }))).ok === false);
    const asgReq = await latestOps("OPS_ASSIGNMENT");
    const g1 = await decideOps(asgReq?.id);
    check("…the manager approves (step 1)", g1.ok === true && g1.by === ananya.email, `${g1.message} ${g1.by}`);
    const g2 = await decideOps(asgReq?.id, true, hr.id);
    check("…HR approves (step 2)", g2.ok === true && (await ops(asgReq?.id)).status === "APPLIED", g2.message);
    const asgRow = await prisma.opsAssignment.findFirstOrThrow({ where: { tenantId, employeeId: meera.employee!.id, note: tag } });
    check("…the assignment is approved for its start date", asgRow.status === "APPROVED");
    await signInAs(hr.email);
    check("It is extended", (await LC.moveAssignmentAction({}, fd({ id: asgRow.id, to: "EXTEND", endDate: day(120), note: "Project slipped" }))).ok === true && (await prisma.opsAssignment.findUniqueOrThrow({ where: { id: asgRow.id } })).extensions === 1);
    check("…started", (await LC.moveAssignmentAction({}, fd({ id: asgRow.id, to: "ACTIVE" }))).ok === true);
    check("…and completed with a return note", (await LC.moveAssignmentAction({}, fd({ id: asgRow.id, to: "COMPLETED", note: "Back to the team" }))).ok === true && (await prisma.opsAssignment.findUniqueOrThrow({ where: { id: asgRow.id } })).status === "COMPLETED");

    check("A status change without a reason is refused", (await LC.changeStatusAction({}, fd({ employeeId: meera.employee!.id, toStatus: "NOTICE_PERIOD", reasonCode: "" }))).ok === false);
    check("…a reason for another status is refused", (await LC.changeStatusAction({}, fd({ employeeId: meera.employee!.id, toStatus: "NOTICE_PERIOD", reasonCode: `${tag}CNF` }))).ok === false);
    check("Meera moves to notice period with a reason", (await LC.changeStatusAction({}, fd({ employeeId: meera.employee!.id, toStatus: "NOTICE_PERIOD", reasonCode: `${tag}RES` }))).ok === true);
    check("…and back to confirmed", (await LC.changeStatusAction({}, fd({ employeeId: meera.employee!.id, toStatus: "CONFIRMED", reasonCode: `${tag}CNF` }))).ok === true);
    const scr = await svc.statusChangeReport(tenantId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    check("…the status report counts both, by reason", scr.byReason.some((r) => r.reason === "Resigned") && scr.byReason.some((r) => r.reason === "Withdrew resignation"));
    const scsv = await csv(exports.lifecycle, "/lifecycle/export?tab=status");
    check("…and the status CSV downloads", scsv.status === 200 && (await scsv.text()).includes("Withdrew resignation"));

    const fte = await LC.requestFteAction({}, fd({ employeeId: meera.employee!.id, toFte: 0.5, effectiveFrom: day(40), reason: `${tag} part-time request` }));
    check("HR asks to move an employee to half time", fte.ok === true, fte.message);
    const fteReq = await latestOps("OPS_FTE_CHANGE");
    const fteRow = await prisma.opsFteConversion.findFirstOrThrow({ where: { tenantId, approvalId: fteReq?.id } });
    check("…hours and CTC are halved in the proposal", Number(fteRow.toFte) === 0.5 && Number(fteRow.toWeeklyHours) === Number(fteRow.fromWeeklyHours) / 2);
    const fteNo = await decideOps(fteReq?.id, false, hr.id);
    check("…the compensation approver rejects it", fteNo.ok === true && (await ops(fteReq?.id)).status === "REJECTED" && (await prisma.opsFteConversion.findUniqueOrThrow({ where: { id: fteRow.id } })).status === "REJECTED", fteNo.message);

    await signInAs(admin.email);
    check("A confirmation rule is added", (await LC.saveConfirmationRuleAction({}, fd({ name: `${tag} One year`, minServiceDays: 1095, requireEvaluation: "on" }))).ok === true);
    const prob = await prisma.employee.findFirstOrThrow({ where: { tenantId, status: "PROBATION" } });
    const elig = await svc.confirmationEligibility(tenantId, prob.id);
    check("…an employee on probation is not yet eligible", elig?.eligible === false && elig.reasons.some((r) => /days of service/.test(r)));
    check("…and dependency checks block confirmation", (await svc.lifecycleDependencyIssues(tenantId, meera.employee!.id, "CONFIRMATION")).length > 0);
  } finally {
    // =========================================================================
    await prisma.workflowRequest.deleteMany({ where: { tenantId, createdAt: { gte: started }, entityType: { startsWith: "OPS_" } } });
    for (const m of [...OPS_MODELS].reverse()) {
      const keep = before[m]!;
      const all = (await (prisma[m] as unknown as Del).findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id).filter((id) => !keep.has(id));
      if (all.length) await (prisma[m] as unknown as Del).deleteMany({ where: { id: { in: all } } });
    }
    if (settingsBefore) { const { id: _i, tenantId: _t, updatedAt: _u, ...rest } = settingsBefore; await prisma.opsSetting.update({ where: { tenantId }, data: rest }); }
    else await prisma.opsSetting.deleteMany({ where: { tenantId } });
    await prisma.attendancePolicy.update({ where: { id: policy.id }, data: { graceMinutes: policy.graceMinutes } });
    if (anjaliSheet) await prisma.timesheet.update({ where: { id: anjaliSheet.id }, data: { status: anjaliSheet.status, approvedAt: anjaliSheet.approvedAt, approvedBy: anjaliSheet.approvedBy, approvalStep: anjaliSheet.approvalStep, firstApprovedBy: anjaliSheet.firstApprovedBy, rejectReason: anjaliSheet.rejectReason } });
    await prisma.task.update({ where: { id: task.id }, data: { status: task.status, completedAt: task.completedAt, progressPercent: task.progressPercent } });
    for (const s of slips) await prisma.payslip.update({ where: { id: s.id }, data: { status: "RELEASED", releasedAt: s.releasedAt, releasedBy: s.releasedBy } });
    await prisma.statutoryFiling.deleteMany({ where: { tenantId, id: { notIn: [...filingsBefore] } } });
    await prisma.adhocTransaction.deleteMany({ where: { sourceType: "OpsRecurringRule", createdAt: { gte: started } } });
    await prisma.employee.update({ where: { id: meera.employee!.id }, data: { status: meeraStatus } });
    await prisma.hrActivity.deleteMany({ where: { id: { in: madeActivities } } });
    const newLeave = (await prisma.leaveRequest.findMany({ where: { tenantId, employeeId: meera.employee!.id }, select: { id: true } })).map((x) => x.id).filter((id) => !leaveBefore.has(id));
    await prisma.leaveRequest.deleteMany({ where: { id: { in: newLeave } } });
    await prisma.attendanceRequest.deleteMany({ where: { tenantId, reason: { startsWith: tag } } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  void exec;
  report("Ops depth");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
