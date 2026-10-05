/**
 * Ops coverage: the remaining time, leave, payroll and lifecycle flows that
 * the depth suite does not walk: my breaks and the attendance calendar file,
 * manager day certification and team heatmap, punch-source audit, early
 * departure LOP booking, the absence lifecycle through the nightly sweep and
 * return to work, blackout and template removal, timesheet reopening, rehire
 * of a leaver with eligibility overrides and the employment timeline, job
 * record correction, contract milestone alerts and the nightly ops sweep's
 * idempotency. Everything is restored afterwards.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import Module from "node:module";
import { unlink } from "node:fs/promises";
import path from "node:path";
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
  const svc = await import("../packages/services/src/index");
  const WF = await import("../apps/web/src/app/actions/workflows");
  const { STORAGE_DIR } = await import("../apps/web/src/lib/storage");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = { myAttendance: await load("me/attendance"), insights: await load("time/insights"), leaveControls: await load("time/leave-controls"), lifecycle: await load("lifecycle"), projectTime: await load("projects/time-controls") };
  const ics = (await import("../apps/web/src/app/(app)/me/attendance/ics/route")).GET as () => Promise<Response>;
  const lifeCsv = (await import("../apps/web/src/app/(app)/lifecycle/export/route")).GET as (r: NextRequest) => Promise<Response>;
  const leaveCsv = (await import("../apps/web/src/app/(app)/time/leave-controls/export/route")).GET as (r: NextRequest) => Promise<Response>;
  const insightsCsv = (await import("../apps/web/src/app/(app)/time/insights/export/route")).GET as (r: NextRequest) => Promise<Response>;
  const csv = (fn: (r: NextRequest) => Promise<Response>, url: string) => fn(new NextRequest(`http://acme.test${url}`));

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, meera, ananya, anjali] = await Promise.all([user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("meera.krishnan@acme.test"), user("ananya.ghosh@acme.test"), user("anjali.desai@acme.test")]);
  const started = new Date();
  const tag = `OC${String(Date.now()).slice(-6)}`;

  const exited = await prisma.employee.findFirstOrThrow({ where: { tenantId, status: "EXITED", userId: null, exitRecord: { isRehireEligible: true } }, include: { exitRecord: true } });
  const barred = await prisma.employee.findFirstOrThrow({ where: { tenantId, status: "EXITED", exitRecord: { isRehireEligible: false } }, include: { exitRecord: true } });
  const snapEmp = (e: typeof exited) => ({ status: e.status, dateOfJoining: e.dateOfJoining, lastWorkingDay: e.lastWorkingDay, exitInitiatedAt: e.exitInitiatedAt, confirmationDate: e.confirmationDate, isRehireEligible: e.isRehireEligible });
  const exitedSnap = snapEmp(exited), barredSnap = snapEmp(barred);
  const anjaliSheet = await prisma.timesheet.findFirst({ where: { tenantId, employeeId: anjali.employee!.id, status: "APPROVED" }, orderBy: { periodStart: "desc" } });
  const jobRec = await (async () => {
    for (const r of await prisma.employeeJobRecord.findMany({ where: { employee: { tenantId } }, orderBy: { effectiveFrom: "desc" }, take: 200 })) {
      if (await prisma.employeeJobRecord.findFirst({ where: { employeeId: r.employeeId, effectiveFrom: { lt: r.effectiveFrom } } })) return r;
    }
    return null;
  })();
  const jobPrev = jobRec ? await prisma.employeeJobRecord.findFirst({ where: { employeeId: jobRec.employeeId, effectiveFrom: { lt: jobRec.effectiveFrom } }, orderBy: { effectiveFrom: "desc" } }) : null;
  const settingsBefore = await prisma.opsSetting.findUnique({ where: { tenantId } });
  const meeraStatus = meera.employee!.status;
  const made = { stints: [] as string[], statusChanges: [] as string[] };
  const filingsBefore = new Set((await prisma.statutoryFiling.findMany({ where: { tenantId }, select: { id: true } })).map((f) => f.id));
  const before: Record<string, Set<string>> = {};
  for (const m of OPS_MODELS) before[m] = new Set((await (prisma[m] as unknown as Del).findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id));

  console.log("\nOps coverage\n" + "=".repeat(72));
  try {
    // =========================================================================
    section("My attendance: breaks and the calendar file");
    await signInAs(admin.email);
    check("A break type is added", (await TA.saveBreakRuleAction({}, fd({ name: `${tag} Lunch`, code: `${tag}L`, maxMinutes: 45, maxPerDay: 1, paid: "on" }))).ok === true);
    await signInAs(meera.email);
    const me = await render(pages.myAttendance, "/me/attendance");
    check("My attendance offers the break panel", ok(me) && me.toLowerCase().includes(`start ${tag.toLowerCase()} lunch`));
    check("…and the calendar download", me.includes("/me/attendance/ics"));
    const cal = await ics();
    const body = await cal.text();
    check("The .ics file is a calendar of my days", cal.status === 200 && body.startsWith("BEGIN:VCALENDAR") && body.includes("BEGIN:VEVENT"));
    check("…and the download is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, action: "EXPORT", entityType: "AttendanceRecord", entityId: meera.employee!.id, createdAt: { gte: started } } })));

    // =========================================================================
    section("Manager views and day certification");
    await signInAs(ananya.email);
    const heat = await render(pages.insights, "/time/insights?tab=heatmap");
    check("A manager sees the team heatmap", ok(heat) && heat.includes("Meera"));
    const tc = await svc.teamHeatmap(tenantId, [meera.employee!.id], 2026, 9);
    check("…with a cell for every day of the month", tc.days.length === 30);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const cd = await TA.certifyDayAction({}, fd({ date: yesterday, note: tag, allowOpen: "on" }));
    check("The manager certifies yesterday for the team", cd.ok === true, cd.message);
    check("…recorded as a day certification", !!(await prisma.opsAttendanceCertification.findFirst({ where: { tenantId, scope: "DAY", note: tag } })));
    check("…a second certification of the same day is refused", (await TA.certifyDayAction({}, fd({ date: yesterday, note: tag, allowOpen: "on" }))).ok === false);
    await signInAs(meera.email);
    check("An employee cannot certify days", (await TA.certifyDayAction({}, fd({ date: yesterday }))).ok === false);
    await signInAs(admin.email);
    const from = new Date(Date.now() - 30 * 86_400_000), to = new Date();
    check("The punch source audit totals by source", typeof (await svc.punchSourceAudit(tenantId, from, to)).totals === "object");
    check("Source comparison runs", Array.isArray(await svc.sourceComparison(tenantId, from, to)));
    const scsv = await csv(insightsCsv, "/time/insights/export?tab=sources");
    check("…and the punch sources CSV downloads", scsv.status === 200);
    check("Early-departure rules book LOP once", (await TA.saveEarlyDepartureRuleAction({}, fd({ policyKey: "ALL", graceMinutes: 0, exemptPerMonth: 0, penaltyDays: 0.5 }))).ok === true
      && (await TA.applyEarlyDepartureAction({}, fd({ year: 2026, month: 9 }))).ok === true
      && /Nothing new/.test((await TA.applyEarlyDepartureAction({}, fd({ year: 2026, month: 9 }))).message ?? ""));

    // =========================================================================
    section("Leave: absence return to work and blackout removal");
    const absence = await prisma.opsAbsenceCase.create({ data: { tenantId, employeeId: meera.employee!.id, kind: "MEDICAL", startDate: new Date(Date.now() - 10 * 86_400_000), expectedReturn: new Date(Date.now() - 2 * 86_400_000), status: "APPROVED", checklist: [{ item: "Laptop returned to user", done: false }], note: tag, createdBy: admin.id } });
    const sweep = await svc.runAbsenceTransitions(tenantId);
    check("The nightly sweep starts an approved absence", sweep.started >= 1 && (await prisma.opsAbsenceCase.findUniqueOrThrow({ where: { id: absence.id } })).status === "ON_LEAVE");
    check("…and sets the employee inactive", (await prisma.employee.findUniqueOrThrow({ where: { id: meera.employee!.id } })).status === "INACTIVE");
    check("…an overdue return alerts leave administrators once", sweep.overdue >= 1 && (await svc.runAbsenceTransitions(tenantId)).overdue === 0);
    await signInAs(hr.email);
    const early = await TA.completeReturnAction({}, fd({ caseId: absence.id, returnedOn: day(0) }));
    check("A return without fitness certificate and checklist is blocked", early.ok === false, early.message);
    check("HR records fitness for work", (await TA.certifyReturnAction({}, fd({ caseId: absence.id, fitForWork: "yes", restrictions: "No travel for 2 weeks", note: tag }))).ok === true);
    check("…ticks the checklist", (await TA.tickReturnChecklistAction({}, form({ caseId: absence.id, done: ["0"] }))).ok === true);
    const back = await TA.completeReturnAction({}, fd({ caseId: absence.id, returnedOn: day(0) }));
    check("…and records the return", back.ok === true && (await prisma.opsAbsenceCase.findUniqueOrThrow({ where: { id: absence.id } })).status === "RETURNED", back.message);
    check("…the employee's status is restored", (await prisma.employee.findUniqueOrThrow({ where: { id: meera.employee!.id } })).status === meeraStatus);
    const blk = await TA.saveLeaveBlackoutAction({}, fd({ name: `${tag} Audit`, kind: "PEAK", startDate: day(200), endDate: day(205), maxConcurrentPct: 20 }));
    const blkRow = await prisma.opsLeaveBlackout.findFirstOrThrow({ where: { tenantId, name: `${tag} Audit` } });
    check("A peak period is added and removed", blk.ok === true && (await TA.deleteLeaveBlackoutAction({}, fd({ id: blkRow.id }))).ok === true && !(await prisma.opsLeaveBlackout.findUnique({ where: { id: blkRow.id } })));
    const lcsv = await csv(leaveCsv, "/time/leave-controls/export?tab=liability");
    check("The leave liability CSV downloads", lcsv.status === 200);
    await signInAs(meera.email);
    const mine = await render(pages.leaveControls, "/time/leave-controls?tab=absences");
    check("The employee sees the absence on their own page", ok(mine) && mine.includes("Returned"));

    // =========================================================================
    section("Project time: reopen, templates, groups");
    await signInAs(admin.email);
    if (anjaliSheet) {
      check("Reopening needs a reason", (await OP.reopenTimesheetAction({}, fd({ timesheetId: anjaliSheet.id, reason: "" }))).ok === false);
      check("An approved week is reopened", (await OP.reopenTimesheetAction({}, fd({ timesheetId: anjaliSheet.id, reason: `${tag} wrong code` }))).ok === true && (await prisma.timesheet.findUniqueOrThrow({ where: { id: anjaliSheet.id } })).status === "DRAFT");
    }
    const anyProject = await prisma.project.findFirstOrThrow({ where: { tenantId } });
    check("A shared template is saved", (await OP.saveTimeTemplateAction({}, fd({ name: `${tag} Shared`, shared: "on", projectId: anyProject.id, h0: 4 }))).ok === true);
    const tpl = await prisma.opsTimeTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Shared` } });
    check("…and deleted", (await OP.deleteTimeTemplateAction({}, fd({ id: tpl.id }))).ok === true && !(await prisma.opsTimeTemplate.findUnique({ where: { id: tpl.id } })));
    check("A component group is added", (await PY.saveComponentGroupAction({}, form({ kind: "DEDUCTION", name: `${tag} Statutory`, componentCodes: ["PF_EMPLOYEE", "VPF"] }))).ok === true);
    const grp = await prisma.opsComponentGroup.findFirstOrThrow({ where: { tenantId, name: `${tag} Statutory` } });
    check("…and deleted", (await PY.deleteComponentGroupAction({}, fd({ id: grp.id }))).ok === true && !(await prisma.opsComponentGroup.findUnique({ where: { id: grp.id } })));

    // =========================================================================
    section("Lifecycle: rehire, job record corrections, contracts");
    await signInAs(hr.email);
    check("Only someone who has exited can be rehired", (await LC.rehireAction({}, fd({ employeeId: meera.employee!.id, joinDate: day(10) }))).ok === false);
    check("Someone barred at exit needs an override", (await LC.rehireAction({}, fd({ employeeId: barred.id, joinDate: day(10) }))).ok === false);
    check("HR marks them eligible after review", (await LC.setRehireEligibilityAction({}, fd({ employeeId: barred.id, eligible: "yes", note: tag }))).ok === true && (await prisma.employee.findUniqueOrThrow({ where: { id: barred.id } })).isRehireEligible === true);
    check("The eligibility list shows it", (await svc.rehireEligibilityList(tenantId, "ELIGIBLE")).some((r: { id?: string; employeeId?: string }) => (r.id ?? r.employeeId) === barred.id));
    const lwd = exited.exitRecord?.lastWorkingDay ?? exited.lastWorkingDay;
    if (lwd) check("A join date before the last day is refused", (await LC.rehireAction({}, fd({ employeeId: exited.id, joinDate: lwd.toISOString().slice(0, 10) }))).ok === false);
    const rh = await LC.rehireAction({}, fd({ employeeId: exited.id, joinDate: day(15), note: tag }));
    check(`An eligible leaver (${exited.displayName}) is rehired`, rh.ok === true, rh.message);
    const tl = await svc.employmentTimeline(tenantId, exited.id);
    check("…the timeline shows both stints", (tl?.stints.length ?? 0) === 2 && tl!.stints[0]!.endDate !== null);
    check("…and they are onboarding again", (await prisma.employee.findUniqueOrThrow({ where: { id: exited.id } })).status === "ONBOARDING");
    const life = await render(pages.lifecycle, `/lifecycle?tab=rehire&emp=${exited.id}`);
    check("The rehire tab shows the timeline", ok(life) && life.includes(exited.displayName));
    if (jobRec) {
      check("A job record date outside its neighbours is refused", (await LC.correctJobRecordAction({}, fd({ recordId: jobRec.id, effectiveFrom: "1990-01-01" }))).ok === false);
      const fix = await LC.correctJobRecordAction({}, fd({ recordId: jobRec.id, effectiveFrom: jobRec.effectiveFrom.toISOString().slice(0, 10), note: `${tag} note` }));
      check("A job record is corrected and audited", fix.ok === true && !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "EmployeeJobRecord", entityId: jobRec.id, createdAt: { gte: started } } })), fix.message);
    }
    const contract = await prisma.employeeContract.create({ data: { tenantId, employeeId: meera.employee!.id, contractNumber: `${tag}-C`, startDate: new Date("2026-01-01"), endDate: new Date(Date.now() + 29 * 86_400_000), status: "ACTIVE" } });
    await signInAs(admin.email);
    check("Contract alerts at 60, 30 and 7 days", (await TA.saveOpsSettingsAction({}, form({ section: "lifecycle", contractAlertDays: "60, 30, 7" }))).ok === true);
    const ca = await svc.runContractAlerts(tenantId);
    check("A contract ending in 29 days triggers its milestone alert", ca.sent >= 1 && !!(await prisma.opsAlertLog.findFirst({ where: { tenantId, kind: "CONTRACT_MILESTONE", dedupeKey: { startsWith: `${contract.id}:` } } })));
    check("…once only", (await svc.runContractAlerts(tenantId)).sent === 0);
    check("The renewal board lists it", (await svc.contractRenewalBoard(tenantId, 60)).some((r: { id?: string }) => r.id === contract.id));
    const ccsv = await csv(lifeCsv, "/lifecycle/export?tab=contracts");
    check("…and the contracts CSV has it", ccsv.status === 200 && (await ccsv.text()).includes(`${tag}-C`));

    // =========================================================================
    section("Movements: pending changes edited, reports, effective-dated configuration");
    await signInAs(hr.email);
    const dept2 = await prisma.department.findFirstOrThrow({ where: { tenantId, id: { not: meera.employee!.departmentId ?? "-" } } });
    const jc = await prisma.jobChange.create({ data: { tenantId, employeeId: meera.employee!.id, effectiveFrom: new Date(Date.now() + 20 * 86_400_000), reason: "TRANSFER", departmentId: dept2.id, note: tag, status: "SCHEDULED", requestedBy: hr.id } });
    const moves = await render(pages.lifecycle, "/lifecycle?tab=movements&kind=TRANSFER");
    check("A scheduled transfer is listed as pending on the movements tab", ok(moves) && moves.includes("Meera"));
    const ed = await LC.editJobChangeAction({}, fd({ id: jc.id, effectiveFrom: day(25), note: `${tag} moved`, departmentId: dept2.id }));
    check("…its date is edited before it applies", ed.ok === true && (await prisma.jobChange.findUniqueOrThrow({ where: { id: jc.id } })).effectiveFrom.toISOString().slice(0, 10) === day(25), ed.message);
    check("…the edit is audited with before and after", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "JobChange", entityId: jc.id, oldValue: { not: undefined } } })));
    check("…a manager change to themselves is refused", (await LC.editJobChangeAction({}, fd({ id: jc.id, effectiveFrom: day(25), reportingManagerId: meera.employee!.id }))).ok === false);
    await prisma.jobChange.update({ where: { id: jc.id }, data: { status: "APPLIED" } });
    check("…an applied change is corrected on its record instead", (await LC.editJobChangeAction({}, fd({ id: jc.id, effectiveFrom: day(26) }))).ok === false);
    await prisma.jobChange.delete({ where: { id: jc.id } });
    for (const k of ["PROMOTION", "TRANSFER", "DESIGNATION"]) {
      const m = await csv(lifeCsv, `/lifecycle/export?tab=movements&kind=${k}&from=2000-01-01&to=${day(0)}`);
      check(`The ${k.toLowerCase()} report downloads as CSV`, m.status === 200 && (await m.text()).includes("From department"));
    }
    check("…and each download is audited", (await prisma.auditLog.count({ where: { tenantId, action: "EXPORT", entityType: "EmployeeJobRecord", createdAt: { gte: started } } })) >= 3);
    await signInAs(admin.email);
    await TA.saveOpsSettingsAction({}, form({ section: "governance", approvalKinds: [] }));
    const plan = await prisma.leavePlan.findFirstOrThrow({ where: { tenantId } });
    const sched = await TA.proposeConfigChangeAction({}, fd({ kind: "LEAVE_POLICY", targetId: plan.id, f_description: `${tag} effective next week`, effectiveFrom: day(7), reason: tag }));
    check("A leave plan change is dated a week ahead", sched.ok === true && /Scheduled/.test(sched.message ?? ""), sched.message);
    check("…the plan is unchanged today", (await prisma.leavePlan.findUniqueOrThrow({ where: { id: plan.id } })).description === plan.description);
    check("…the nightly sweep applies it on the day", (await svc.applyDueConfigChanges(tenantId, new Date(Date.now() + 8 * 86_400_000))) === 1
      && (await prisma.leavePlan.findUniqueOrThrow({ where: { id: plan.id } })).description === `${tag} effective next week`);
    const pv = await prisma.opsPolicyVersion.findFirst({ where: { tenantId, kind: "LEAVE_POLICY", targetId: plan.id }, orderBy: { version: "desc" } });
    check("…and the version records its effective date", pv?.effectiveFrom.toISOString().slice(0, 10) === day(7));
    await prisma.leavePlan.update({ where: { id: plan.id }, data: { description: plan.description } });

    // =========================================================================
    section("Every governed configuration kind goes through approval");
    await signInAs(admin.email);
    const kinds = Object.keys(svc.OPS_CONFIG_KINDS) as Array<keyof typeof svc.OPS_CONFIG_KINDS>;
    check("Governance is turned on for every kind", (await TA.saveOpsSettingsAction({}, form({ section: "governance", approvalKinds: kinds as string[] }))).ok === true);
    for (const kind of kinds) {
      await signInAs(admin.email);
      const target = (await svc.opsConfigTargets(tenantId, kind))[0];
      const spec = (svc.OPS_CONFIG_KINDS[kind].fields as ReadonlyArray<{ key: string; type: string; min?: number; max?: number }>).find((f) => ["int", "decimal", "text"].includes(f.type));
      if (!target || !spec) { check(`${kind}: has a target and an editable field`, false); continue; }
      const cur = await svc.opsConfigCurrent(tenantId, kind, target.value);
      const was = cur?.values[spec.key];
      const next = spec.type === "text" ? `${tag} ${kind}` : String(Number(was ?? 0) >= (spec.max ?? 1e9) ? Number(was) - 1 : Number(was ?? 0) + 1);
      const pr = await TA.proposeConfigChangeAction({}, fd({ kind, targetId: target.value, [`f_${spec.key}`]: next, reason: tag }));
      const req = await prisma.opsApprovalRequest.findFirst({ where: { tenantId, kind: "OPS_CONFIG_CHANGE", targetId: target.value, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
      check(`${kind}: a change waits for approval`, pr.ok === true && req?.status === "PENDING", pr.message);
      const t = await prisma.workflowTask.findFirst({ where: { tenantId, status: "PENDING", approverUserId: { not: admin.id }, request: { entityType: "OPS_CONFIG_CHANGE", entityId: req?.id ?? "-" } } });
      if (!t?.approverUserId) { check(`${kind}: a second approver holds it`, false); continue; }
      const u = await prisma.user.findUniqueOrThrow({ where: { id: t.approverUserId } });
      await signInAs(u.email);
      const dr = await WF.decideWorkflowTaskAction({}, fd({ taskId: t.id, decision: "reject", comment: "Not now" }));
      const after = await svc.opsConfigCurrent(tenantId, kind, target.value);
      check(`${kind}: rejected by ${u.email}, nothing changes`, dr.ok === true && (await prisma.opsApprovalRequest.findUniqueOrThrow({ where: { id: req!.id } })).status === "REJECTED" && String(after?.values[spec.key] ?? "") === String(was ?? ""), dr.message);
    }
    await signInAs(admin.email);
    await TA.saveOpsSettingsAction({}, form({ section: "governance", approvalKinds: [] }));

    // =========================================================================
    section("Statutory sign-off for EPF and ESIC, absence reasons, tax regime");
    await signInAs(admin.email);
    check("Statutory filings need sign-off", (await TA.saveOpsSettingsAction({}, fd({ section: "payroll", netPayRoundTo: 1, netPayRoundingMode: "NEAREST", negativeNetPayAction: "WARN", requireFilingApproval: "on" }))).ok === true);
    const ramesh = await user("ramesh.iyer@acme.test");
    const FL = await import("../apps/web/src/app/actions/filings");
    const julRun = await prisma.payrollRun.findFirstOrThrow({ where: { tenantId, year: 2026, month: 7, type: "REGULAR", status: "FINALIZED" } });
    for (const [type, approve] of [["PF_ECR", true], ["ESI_ECR", false]] as const) {
      await signInAs(admin.email);
      const gen = await FL.generateMonthlyFiling({}, fd({ runId: julRun.id, kind: type }));
      const filing = await prisma.statutoryFiling.findFirst({ where: { tenantId, type, month: 7, createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
      check(`${type}: July's return is generated`, !!filing, gen.message);
      await signInAs(ramesh.email);
      const so = await PY.requestStatutorySignoffAction({}, fd({ filingId: filing?.id ?? "-", note: tag }));
      const req = await prisma.opsApprovalRequest.findFirst({ where: { tenantId, kind: "OPS_STATUTORY_SIGNOFF", createdAt: { gte: started } }, orderBy: { createdAt: "desc" } });
      check(`${type}: payroll asks for sign-off on July`, so.ok === true && req?.status === "PENDING", so.message);
      const fid = req?.targetId ?? "-";
      check(`${type}: filing is blocked until signed off`, !!(await svc.opsFilingGate(tenantId, fid)));
      const t = await prisma.workflowTask.findFirst({ where: { tenantId, status: "PENDING", approverUserId: { not: ramesh.id }, request: { entityType: "OPS_STATUTORY_SIGNOFF", entityId: req?.id ?? "-" } } });
      const u = t?.approverUserId ? await prisma.user.findUniqueOrThrow({ where: { id: t.approverUserId } }) : null;
      if (!t || !u) { check(`${type}: an approver holds it`, false); continue; }
      await signInAs(u.email);
      const dr = await WF.decideWorkflowTaskAction({}, fd({ taskId: t.id, decision: approve ? "approve" : "reject", comment: approve ? "" : "Challan amount differs" }));
      const gate = await svc.opsFilingGate(tenantId, fid);
      check(`${type}: ${approve ? "signed off and fileable" : "rejected and still blocked"}`, dr.ok === true && (approve ? gate === null : !!gate), `${dr.message} ${gate ?? ""}`);
    }
    await signInAs(admin.email);
    check("An absence reason is added to the taxonomy", (await TA.saveReasonCodeAction({}, fd({ kind: "ABSENCE", code: `${tag}CARE`, label: "Caring for family" }))).ok === true);
    check("…and offered for absences only", (await svc.reasonCodes(tenantId, "ABSENCE", true)).some((r) => r.code === `${tag}CARE`) && !(await svc.reasonCodes(tenantId, "REGULARISATION", true)).some((r) => r.code === `${tag}CARE`));
    await signInAs(meera.email);
    const ab = await TA.requestAbsenceAction({}, fd({ kind: "PERSONAL", reasonCode: `${tag}CARE`, startDate: day(220), expectedReturn: day(280), note: `${tag} care` }));
    check("An absence is requested with that reason", ab.ok === true && (await prisma.opsAbsenceCase.findFirst({ where: { tenantId, note: `${tag} care` } }))?.reasonCode === `${tag}CARE`, ab.message);
    check("…an unknown reason is refused", (await TA.requestAbsenceAction({}, fd({ kind: "PERSONAL", reasonCode: "NOPE", startDate: day(300), expectedReturn: day(360) }))).ok === false);
    const TX = await import("../apps/web/src/app/actions/tax");
    const prof = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId: meera.employee!.id } });
    const decls = await prisma.investmentDeclaration.findMany({ where: { employeeId: meera.employee!.id }, select: { id: true, regime: true } });
    const regimeNow = prof?.taxRegime ?? "NEW", to2 = regimeNow === "NEW" ? "OLD" : "NEW";
    const sw = await TX.switchRegimeAction({}, fd({ regime: to2 }));
    if (sw.ok) {
      check(`An employee switches to the ${to2.toLowerCase()} tax regime`, (await prisma.employeeStatutoryProfile.findUniqueOrThrow({ where: { employeeId: meera.employee!.id } })).taxRegime === to2, sw.message);
      check("…and the switch is audited", !!(await prisma.auditLog.findFirst({ where: { tenantId, entityType: "InvestmentDeclaration", summary: { startsWith: "Switched tax regime" }, createdAt: { gte: started } } })));
    } else check("The regime switch explains why it is closed", /window|locked|closed|declar/i.test(sw.message ?? ""), sw.message);
    check("…a made-up regime is refused", (await TX.switchRegimeAction({}, fd({ regime: "FLAT" }))).ok === false);
    if (prof) await prisma.employeeStatutoryProfile.update({ where: { employeeId: meera.employee!.id }, data: { taxRegime: prof.taxRegime } });
    else await prisma.employeeStatutoryProfile.deleteMany({ where: { employeeId: meera.employee!.id } });
    for (const d of decls) await prisma.investmentDeclaration.update({ where: { id: d.id }, data: { regime: d.regime } });
    await prisma.investmentDeclaration.deleteMany({ where: { employeeId: meera.employee!.id, id: { notIn: decls.map((d) => d.id) } } });

    // =========================================================================
    section("Settings enforced where work is entered");
    await signInAs(admin.email);
    check("Time standards are set (comments of 10+ characters, 3-day edit window, attestation)", (await TA.saveOpsSettingsAction({}, fd({ section: "time", requireEntryComment: "on", entryCommentMinLength: 10, requireAttestation: "on", timesheetCutoffDays: 3, taskBudgetMode: "OFF", taskBudgetTolerancePct: 10, projectVarianceAlertPct: 20, standardDailyHours: 8 }))).ok === true);
    const anyProj = await prisma.project.findFirstOrThrow({ where: { tenantId } });
    const monday = (offsetWeeks: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7); return d; };
    const thisWeek = monday(0);
    const g1 = await svc.opsTimesheetGate({ tenantId, employeeId: meera.employee!.id, week: thisWeek, sheetId: null, entries: [{ projectId: anyProj.id, hours: 8, description: "fix", date: thisWeek }], submit: true, attested: false });
    check("…a short comment is refused", g1.issues.some((i) => /comment/i.test(i)), g1.issues.join(" | "));
    check("…and so is submitting without attesting", g1.issues.some((i) => /true record/i.test(i)));
    const g2 = await svc.opsTimesheetGate({ tenantId, employeeId: meera.employee!.id, week: monday(-3), sheetId: null, entries: [{ projectId: anyProj.id, hours: 8, description: "Checkout flow review", date: monday(-3) }], submit: false });
    check("…a week three weeks back is past the edit window", g2.issues.some((i) => /week of/i.test(i)), g2.issues.join(" | "));
    const g3 = await svc.opsTimesheetGate({ tenantId, employeeId: meera.employee!.id, week: thisWeek, sheetId: null, entries: [{ projectId: anyProj.id, hours: 8, description: "Checkout flow review", date: thisWeek }], submit: true, attested: true });
    check("…while a proper entry passes", g3.issues.length === 0, g3.issues.join(" | "));
    check("Leave withdrawal closes 2 days before the start", (await TA.saveOpsSettingsAction({}, fd({ section: "leave", leaveWithdrawalWindowDays: 2, requireLeaveCancellationApproval: "on", leaveEscalationHours: 48, leaveCalendarVisibility: "DEPARTMENT" }))).ok === true);
    check("…leave tomorrow can no longer be withdrawn", (await svc.leaveCancelRoute(tenantId, { status: "APPROVED", fromDate: new Date(Date.now() + 86_400_000) })) === "CLOSED");
    check("…leave in a month goes to approval", (await svc.leaveCancelRoute(tenantId, { status: "APPROVED", fromDate: new Date(Date.now() + 30 * 86_400_000) })) === "APPROVAL");
    check("…a pending request is withdrawn directly", (await svc.leaveCancelRoute(tenantId, { status: "PENDING", fromDate: new Date(Date.now() + 86_400_000) })) === "DIRECT");
    check("Payroll rounding and negative-pay controls are saved", (await TA.saveOpsSettingsAction({}, fd({ section: "payroll", netPayRoundTo: 10, netPayRoundingMode: "UP", negativeNetPayAction: "BLOCK" }))).ok === true
      && (await svc.getOpsSettings(tenantId)).netPayRoundTo === 10 && (await svc.getOpsSettings(tenantId)).negativeNetPayAction === "BLOCK");
    check("…an unknown rounding mode is refused", (await TA.saveOpsSettingsAction({}, fd({ section: "payroll", netPayRoundTo: 10, netPayRoundingMode: "SIDEWAYS" }))).ok === false);

    // =========================================================================
    section("Nightly sweep");
    const j1 = await svc.runOpsJob(tenantId);
    check("The ops sweep runs every step", ["configChangesApplied", "anomaliesFound", "attendanceCutoffNotices", "leaveEscalations", "payrollCutoffNotices", "contractAlerts"].every((k) => typeof j1[k] === "number"));
    const j2 = await svc.runOpsJob(tenantId);
    check("…and a rerun sends nothing new", j2.contractAlerts === 0 && j2.attendanceCutoffNotices === 0 && j2.payrollCutoffNotices === 0 && j2.anomalyNotices === 0);
    void pages.projectTime;
  } finally {
    // =========================================================================
    await signInAs(admin.email).catch(() => null);
    for (const [e, s] of [[exited, exitedSnap], [barred, barredSnap]] as const) {
      await prisma.employee.update({ where: { id: e.id }, data: s });
      if (e.exitRecord && !(await prisma.exitRecord.findUnique({ where: { id: e.exitRecord.id } }))) await prisma.exitRecord.create({ data: e.exitRecord as never });
      else if (e.exitRecord) await prisma.exitRecord.update({ where: { id: e.exitRecord.id }, data: { isRehireEligible: e.exitRecord.isRehireEligible } });
      await prisma.opsEmploymentStint.deleteMany({ where: { employeeId: e.id } });
    }
    await prisma.employee.update({ where: { id: meera.employee!.id }, data: { status: meeraStatus } });
    if (anjaliSheet) await prisma.timesheet.update({ where: { id: anjaliSheet.id }, data: { status: anjaliSheet.status, approvedAt: anjaliSheet.approvedAt, approvedBy: anjaliSheet.approvedBy, approvalStep: anjaliSheet.approvalStep, firstApprovedBy: anjaliSheet.firstApprovedBy, rejectReason: anjaliSheet.rejectReason } });
    if (jobRec) await prisma.employeeJobRecord.update({ where: { id: jobRec.id }, data: { note: jobRec.note, effectiveFrom: jobRec.effectiveFrom } });
    if (jobPrev) await prisma.employeeJobRecord.update({ where: { id: jobPrev.id }, data: { effectiveTo: jobPrev.effectiveTo } });
    await prisma.employeeContract.deleteMany({ where: { tenantId, contractNumber: `${tag}-C` } });
    await prisma.lopAdjustment.deleteMany({ where: { tenantId, note: { startsWith: "EARLY_DEPARTURE" }, createdAt: { gte: started } } });
    for (const m of [...OPS_MODELS].reverse()) {
      const keep = before[m]!;
      const ids = (await (prisma[m] as unknown as Del).findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id).filter((id) => !keep.has(id));
      if (ids.length) await (prisma[m] as unknown as Del).deleteMany({ where: { id: { in: ids } } });
    }
    const files = await prisma.storedFile.findMany({ where: { tenantId, createdAt: { gte: started } } });
    for (const f of files) await unlink(path.join(STORAGE_DIR, f.storageKey)).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await prisma.statutoryFiling.deleteMany({ where: { tenantId, id: { notIn: [...filingsBefore] } } });
    await prisma.workflowRequest.deleteMany({ where: { tenantId, createdAt: { gte: started }, entityType: { startsWith: "OPS_" } } });
    if (settingsBefore) { const { id: _i, tenantId: _t, updatedAt: _u, ...rest } = settingsBefore; await prisma.opsSetting.update({ where: { tenantId }, data: rest }); }
    else await prisma.opsSetting.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  void made;
  report("Ops coverage");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
