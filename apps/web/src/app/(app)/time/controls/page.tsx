import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P, type Permission } from "@keka/rbac";
import {
  getOpsSettings, OPS_CONFIG_KINDS, isOpsConfigKind, opsConfigTargets, opsConfigCurrent, opsPolicyReport, OPS_REASON_KINDS, reasonCodes,
  earlyDepartureReport, breakReport, regularisationReasonReport, opsAttendanceWindow, type OpsConfigKindKey,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton, type FieldSpec } from "@/components/gov-forms";
import { OpsRequests, monthOptions } from "@/components/ops-ui";
import {
  saveOpsSettingsAction, proposeConfigChangeAction, lockPeriodAction, reopenPeriodAction, certifyMonthAction, certifyDayAction, saveReasonCodeAction,
  saveEarlyDepartureRuleAction, applyEarlyDepartureAction, saveBreakRuleAction, saveBreakEntryAction,
} from "@/app/actions/ops-time-attend";

export const metadata = { title: "Time controls" };
const TABS = { settings: "Settings", changes: "Change approvals", versions: "Policy versions", locks: "Locks", certification: "Certification", reasons: "Reason catalogues", early: "Early departure", breaks: "Breaks" };
type Tab = keyof typeof TABS;

/**
 * Time Attend › Controls: the ops switches (cut-off on the 25th, alerts,
 * leave, payroll and lifecycle controls), configuration changes under
 * approval with versions and policy reports, attendance and timesheet locks,
 * attendance certification, reason catalogues, early departure and breaks.
 */
export default async function TimeControlsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  if (!canAny(v, [P.ATTENDANCE_MANAGE, P.LEAVE_MANAGE, P.WORKFLOW_MANAGE, P.PAYROLL_SETTINGS])) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "settings";
  const t = v.tenantId;
  return (
    <>
      <PageHead title="Time controls" subtitle="Policies under approval, locks, certification, catalogues and breaks" actions={<a className="btn" href={`/time/controls/export?tab=${tab}`}>Download CSV</a>} />
      <Tabs base="/time/controls" tabs={TABS} active={tab} />
      {tab === "settings" ? <Settings tenantId={t} perms={{ att: can(v, P.ATTENDANCE_MANAGE), time: can(v, P.PROJECT_MANAGE), leave: can(v, P.LEAVE_MANAGE), pay: can(v, P.PAYROLL_SETTINGS), life: can(v, P.HR_ACTIVITY_MANAGE), gov: can(v, P.WORKFLOW_MANAGE) }} /> : null}
      {tab === "changes" ? <Changes tenantId={t} kind={sp.kind} target={sp.target} allowed={(k) => can(v, OPS_CONFIG_KINDS[k].permission as Permission)} /> : null}
      {tab === "versions" ? <Versions tenantId={t} kind={sp.kind} /> : null}
      {tab === "locks" ? <Locks tenantId={t} /> : null}
      {tab === "certification" ? <Certification tenantId={t} canManage={can(v, P.ATTENDANCE_MANAGE)} /> : null}
      {tab === "reasons" ? <Reasons tenantId={t} kind={sp.kind} /> : null}
      {tab === "early" ? <Early tenantId={t} month={sp.month} /> : null}
      {tab === "breaks" ? <Breaks tenantId={t} /> : null}
    </>
  );
}

async function Settings({ tenantId, perms }: { tenantId: string; perms: Record<string, boolean> }) {
  const s = await getOpsSettings(tenantId);
  const kinds = Object.entries(OPS_CONFIG_KINDS).map(([k, x]) => ({ value: k, label: x.label }));
  return (
    <div className="stack gap-4">
      <Callout title="Attendance cut-off">Payroll takes attendance up to day {s.attendanceCutoffDay} of each month; anything later rolls into the next run. People with open items are reminded {s.cutoffAlertDaysBefore} day(s) before.</Callout>
      <div className="grid grid-2">
        {perms.att ? <Card title="Attendance"><SpecForm action={saveOpsSettingsAction} hidden={{ section: "attendance" }} fields={[
          { name: "attendanceCutoffDay", label: "Payroll cut-off day", type: "number", defaultValue: s.attendanceCutoffDay },
          { name: "cutoffAlertDaysBefore", label: "Remind days before", type: "number", defaultValue: s.cutoffAlertDaysBefore },
          { name: "deviceStaleMinutes", label: "Device stale after (min)", type: "number", defaultValue: s.deviceStaleMinutes },
          { name: "deviceOfflineMinutes", label: "Device offline after (min)", type: "number", defaultValue: s.deviceOfflineMinutes },
          { name: "sourceMismatchMinutes", label: "Source mismatch (min)", type: "number", defaultValue: s.sourceMismatchMinutes },
          { name: "anomalyNotify", label: "Exception notices", type: "checkbox", defaultValue: s.anomalyNotify, placeholder: "Tell employees and managers" },
        ]} /></Card> : null}
        {perms.time ? <Card title="Time tracking"><SpecForm action={saveOpsSettingsAction} hidden={{ section: "time" }} fields={[
          { name: "requireEntryComment", label: "Comments", type: "checkbox", defaultValue: s.requireEntryComment, placeholder: "Every entry needs a comment" },
          { name: "entryCommentMinLength", label: "Minimum comment length", type: "number", defaultValue: s.entryCommentMinLength },
          { name: "requireTimeCode", label: "Activity codes", type: "checkbox", defaultValue: s.requireTimeCode, placeholder: "Every entry needs a code" },
          { name: "requireAttestation", label: "Attestation", type: "checkbox", defaultValue: s.requireAttestation, placeholder: "Employees certify each week on submit" },
          { name: "timesheetCutoffDays", label: "Week closes after (days)", type: "number", defaultValue: s.timesheetCutoffDays ?? "", hint: "Blank: never" },
          { name: "taskBudgetMode", label: "Task budgets", type: "select", required: true, defaultValue: s.taskBudgetMode, options: [{ value: "OFF", label: "Off" }, { value: "WARN", label: "Warn" }, { value: "BLOCK", label: "Block" }] },
          { name: "taskBudgetTolerancePct", label: "Budget tolerance %", type: "number", defaultValue: s.taskBudgetTolerancePct },
          { name: "projectVarianceAlertPct", label: "Project variance alert %", type: "number", defaultValue: s.projectVarianceAlertPct },
          { name: "standardDailyHours", label: "Standard day (h)", type: "number", defaultValue: Number(s.standardDailyHours) },
        ]} /></Card> : null}
        {perms.leave ? <Card title="Leave"><SpecForm action={saveOpsSettingsAction} hidden={{ section: "leave" }} fields={[
          { name: "leaveWithdrawalWindowDays", label: "Withdraw approved leave until (days before)", type: "number", defaultValue: s.leaveWithdrawalWindowDays ?? "", hint: "Blank: until it starts" },
          { name: "requireLeaveCancellationApproval", label: "Cancellation", type: "checkbox", defaultValue: s.requireLeaveCancellationApproval, placeholder: "Cancelling approved leave needs the manager" },
          { name: "leaveEscalationHours", label: "Escalate after (hours)", type: "number", defaultValue: s.leaveEscalationHours ?? "", hint: "Blank: never" },
          { name: "leaveCalendarVisibility", label: "Calendar shows", type: "select", required: true, defaultValue: s.leaveCalendarVisibility, options: [{ value: "TEAM", label: "My team" }, { value: "DEPARTMENT", label: "My department" }, { value: "ORGANISATION", label: "Everyone" }, { value: "MANAGERS", label: "Managers see their reports only" }] },
          { name: "leaveCalendarHideType", label: "Leave type", type: "checkbox", defaultValue: s.leaveCalendarHideType, placeholder: "Show colleagues only \"On leave\"" },
          { name: "requireBalanceAdjustmentApproval", label: "Adjustments", type: "checkbox", defaultValue: s.requireBalanceAdjustmentApproval, placeholder: "Balance adjustments need approval" },
        ]} /></Card> : null}
        {perms.pay ? <Card title="Payroll"><SpecForm action={saveOpsSettingsAction} hidden={{ section: "payroll" }} fields={[
          { name: "netPayRoundTo", label: "Round net pay to (₹)", type: "number", defaultValue: s.netPayRoundTo, hint: "1 leaves pay as calculated" },
          { name: "netPayRoundingMode", label: "Rounding", type: "select", required: true, defaultValue: s.netPayRoundingMode, options: [{ value: "NEAREST", label: "Nearest" }, { value: "UP", label: "Up" }, { value: "DOWN", label: "Down" }] },
          { name: "negativeNetPayAction", label: "Negative net pay", type: "select", required: true, defaultValue: s.negativeNetPayAction, options: [{ value: "WARN", label: "Warn" }, { value: "BLOCK", label: "Block the lock" }] },
          { name: "requirePayslipApproval", label: "Payslips", type: "checkbox", defaultValue: s.requirePayslipApproval, placeholder: "Release needs approval" },
          { name: "requireFilingApproval", label: "Statutory returns", type: "checkbox", defaultValue: s.requireFilingApproval, placeholder: "Sign-off before marking filed" },
          { name: "requireCloseChecklist", label: "Close checklist", type: "checkbox", defaultValue: s.requireCloseChecklist, placeholder: "Required before finalising" },
        ]} /></Card> : null}
        {perms.life ? <Card title="Lifecycle"><SpecForm action={saveOpsSettingsAction} hidden={{ section: "lifecycle" }} fields={[
          { name: "eventTypesNeedingApproval", label: "HR events needing approval", type: "multiselect", defaultValue: s.eventTypesNeedingApproval, options: ["PROMOTION", "TRANSFER", "WARNING", "COMPLAINT", "WORK_TRIP", "TERMINATION", "RESIGNATION", "APPRECIATION", "SALARY_REVISION"].map((x) => ({ value: x, label: x.replace(/_/g, " ").toLowerCase() })) },
          { name: "contractAlertDays", label: "Contract alerts (days before end)", defaultValue: s.contractAlertDays.join(", ") },
        ]} /></Card> : null}
        {perms.gov ? <Card title="Changes that need approval" description="A second administrator approves these before they apply."><SpecForm action={saveOpsSettingsAction} hidden={{ section: "governance" }} fields={[
          { name: "approvalKinds", label: "Governed configuration", type: "multiselect", defaultValue: s.approvalKinds, options: kinds },
        ]} /></Card> : null}
      </div>
    </div>
  );
}

async function Changes({ tenantId, kind, target, allowed }: { tenantId: string; kind?: string; target?: string; allowed: (k: OpsConfigKindKey) => boolean }) {
  const kinds = (Object.keys(OPS_CONFIG_KINDS) as OpsConfigKindKey[]).filter(allowed);
  const k: OpsConfigKindKey | null = kind && isOpsConfigKind(kind) && allowed(kind) ? kind : kinds[0] ?? null;
  const [targets, rows] = await Promise.all([
    k ? opsConfigTargets(tenantId, k) : Promise.resolve([]),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_CONFIG_CHANGE" }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.requestedBy));
  const tgt = target && targets.some((x) => x.value === target) ? target : targets[0]?.value;
  const cur = k && tgt ? await opsConfigCurrent(tenantId, k, tgt) : null;
  const fields: FieldSpec[] = k && cur ? OPS_CONFIG_KINDS[k].fields.flatMap<FieldSpec>((f) => {
    const val = cur.values[f.key];
    if (f.type === "bool") return [{ name: `f_${f.key}`, label: f.label, type: "checkbox", defaultValue: val === true, placeholder: "Yes" }];
    if (f.type === "enum") return [{ name: `f_${f.key}`, label: f.label, type: "select", defaultValue: val === null || val === undefined ? "" : String(val), options: (f.options ?? []).map((o) => ({ value: o, label: o.replace(/_/g, " ").toLowerCase() })) }];
    return [{ name: `f_${f.key}`, label: f.label, type: f.type === "text" ? "text" : "number", defaultValue: val === null || val === undefined ? "" : String(val) }];
  }) : [];
  return (
    <div className="stack gap-4">
      <Card title="Propose a change" description="Governed kinds go to a second administrator; others apply at once (or on the effective date). Every change is versioned.">
        <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
          <input type="hidden" name="tab" value="changes" />
          <select name="kind" className="select" defaultValue={k ?? ""} style={{ width: 240 }}>{kinds.map((x) => <option key={x} value={x}>{OPS_CONFIG_KINDS[x].label}</option>)}</select>
          <select name="target" className="select" defaultValue={tgt ?? ""} style={{ width: 260 }}>{targets.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          <button className="btn sm" type="submit">Load</button>
        </form>
        {k && tgt && cur ? (
          <SpecForm action={proposeConfigChangeAction} hidden={{ kind: k, targetId: tgt, ...Object.fromEntries(OPS_CONFIG_KINDS[k].fields.filter((f) => f.type === "bool").map((f) => [`has_${f.key}`, "1"])) }} submitLabel="Propose change" columns={3}
            fields={[...fields, { name: "effectiveFrom", label: "Effective from", type: "date", hint: "Blank: today" }, { name: "reason", label: "Reason", type: "textarea", wide: true }]} />
        ) : <div className="text-sm subtle">Nothing of this kind yet.</div>}
      </Card>
      <Card title="Change requests" tight><OpsRequests rows={rows} names={names} /></Card>
    </div>
  );
}

async function Versions({ tenantId, kind }: { tenantId: string; kind?: string }) {
  const k: OpsConfigKindKey = kind && isOpsConfigKind(kind) ? kind : "ATTENDANCE_POLICY";
  const [report, versions] = await Promise.all([
    opsPolicyReport(tenantId, k),
    prisma.opsPolicyVersion.findMany({ where: { tenantId, kind: k }, orderBy: [{ createdAt: "desc" }], take: 100 }),
  ]);
  const names = await userNames(tenantId, versions.map((x) => x.createdBy));
  const labels = new Map(report.rows.map((r) => [r.id, r.label]));
  return (
    <div className="stack gap-4">
      <div className="tabs">{(Object.keys(OPS_CONFIG_KINDS) as OpsConfigKindKey[]).map((x) => <a key={x} className={`tab${x === k ? " active" : ""}`} href={`/time/controls?tab=versions&kind=${x}`}>{OPS_CONFIG_KINDS[x].label}</a>)}</div>
      <Card title={`${OPS_CONFIG_KINDS[k].label}: current values`} tight>
        <Table head={["Name", ...OPS_CONFIG_KINDS[k].fields.slice(0, 6).map((f) => f.label), "Versions", "Last changed"]} empty={report.rows.length === 0}>
          {report.rows.map((r) => (
            <tr key={r.id}><td className="strong text-sm">{r.label}</td>{OPS_CONFIG_KINDS[k].fields.slice(0, 6).map((f) => <td key={f.key} className="text-sm">{String(r.values[f.key] ?? "—")}</td>)}<td className="num">{r.versions}</td><td className="text-sm">{fmtDate(r.lastChanged)}</td></tr>
          ))}
        </Table>
      </Card>
      <Card title="Version history" tight>
        <Table head={["Target", "Version", "Effective", "Summary", "By", "When"]} empty={versions.length === 0}>
          {versions.map((x) => <tr key={x.id}><td className="text-sm">{labels.get(x.targetId) ?? x.targetId}</td><td className="num">v{x.version}</td><td className="text-sm">{fmtDate(x.effectiveFrom)}</td><td className="text-sm">{x.summary}</td><td className="text-sm">{names.get(x.createdBy ?? "") ?? "System"}</td><td className="text-sm">{fmtWhen(x.createdAt)}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Locks({ tenantId }: { tenantId: string }) {
  const locks = await prisma.opsPeriodLock.findMany({ where: { tenantId }, orderBy: { periodStart: "desc" }, take: 60 });
  const names = await userNames(tenantId, locks.flatMap((l) => [l.lockedBy, l.reopenedBy]));
  return (
    <div className="stack gap-4">
      <Card title="Lock a period" description="Locked attendance takes no punches, requests or reprocessing; locked timesheets take no edits. Reopen with a reason.">
        <SpecForm action={lockPeriodAction} submitLabel="Lock" columns={3} fields={[
          { name: "domain", label: "What", type: "select", required: true, options: [{ value: "ATTENDANCE", label: "Attendance" }, { value: "TIMESHEET", label: "Timesheets" }] },
          { name: "periodStart", label: "From", type: "date", required: true }, { name: "periodEnd", label: "To", type: "date", required: true },
          { name: "reason", label: "Reason", wide: true },
        ]} />
      </Card>
      <Card title="Locks" tight>
        <Table head={["What", "Period", "Status", "Locked by", "Reopened", ""]} empty={locks.length === 0}>
          {locks.map((l) => (
            <tr key={l.id}>
              <td className="text-sm">{l.domain === "ATTENDANCE" ? "Attendance" : "Timesheets"}</td><td className="text-sm nowrap">{fmtDate(l.periodStart)} – {fmtDate(l.periodEnd)}</td>
              <td><Pill s={l.status} /></td><td className="text-sm">{names.get(l.lockedBy) ?? "—"} · {fmtDate(l.lockedAt)}{l.reason ? <div className="text-xs subtle">{l.reason}</div> : null}</td>
              <td className="text-xs">{l.reopenedAt ? `${names.get(l.reopenedBy ?? "") ?? ""} ${fmtDate(l.reopenedAt)}: ${l.reopenReason ?? ""}` : ""}</td>
              <td>{l.status === "LOCKED" ? <ActButton action={reopenPeriodAction} hidden={{ id: l.id }} label="Reopen" input={{ name: "reason", placeholder: "Why reopen", required: true }} /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Certification({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [rows, depts, s] = await Promise.all([
    prisma.opsAttendanceCertification.findMany({ where: { tenantId }, orderBy: { certifiedAt: "desc" }, take: 60 }),
    departmentOptions(tenantId), getOpsSettings(tenantId),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.certifiedBy));
  const now = new Date();
  const w = opsAttendanceWindow(now.getUTCFullYear(), now.getUTCMonth() + 1, s.attendanceCutoffDay);
  return (
    <div className="stack gap-4">
      <div className="grid grid-2">
        <Card title="Certify a day (managers)" description="Confirm your team's attendance for a day once its exceptions are resolved.">
          <SpecForm action={certifyDayAction} columns={1} submitLabel="Certify day" fields={[{ name: "date", label: "Day", type: "date", required: true }, { name: "allowOpen", label: "Open exceptions", type: "checkbox", placeholder: "Certify with open exceptions" }, { name: "note", label: "Note" }]} />
        </Card>
        {canManage ? <Card title="Certify the month for payroll" description={`This month's window: ${fmtDate(w.from)} – ${fmtDate(w.to)} (cut-off on day ${s.attendanceCutoffDay}). Approved by payroll; approval locks the window.`}>
          <SpecForm action={certifyMonthAction} columns={2} submitLabel="Certify month" fields={[
            { name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() }, { name: "month", label: "Month", type: "select", required: true, options: monthOptions(), defaultValue: String(now.getUTCMonth() + 1) },
            { name: "departmentId", label: "Department", type: "select", options: depts, placeholder: "All departments" }, { name: "note", label: "Note" },
          ]} />
        </Card> : null}
      </div>
      <Card title="Certifications" tight>
        <Table head={["Scope", "Period", "Group", "Summary", "Status", "By"]} empty={rows.length === 0}>
          {rows.map((r) => {
            const sum = (r.summary ?? {}) as Record<string, unknown>;
            return <tr key={r.id}><td className="text-sm">{r.scope === "DAY" ? "Day" : "Month"}</td><td className="text-sm nowrap">{fmtDate(r.periodStart)}{r.scope === "MONTH" ? ` – ${fmtDate(r.periodEnd)}` : ""}</td><td className="text-xs">{r.departmentKey}</td><td className="text-xs">{Object.entries(sum).slice(0, 5).map(([k2, v2]) => `${k2}: ${String(v2)}`).join(" · ")}</td><td><Pill s={r.status} /></td><td className="text-sm">{names.get(r.certifiedBy) ?? "—"} · {fmtDate(r.certifiedAt)}</td></tr>;
          })}
        </Table>
      </Card>
    </div>
  );
}

async function Reasons({ tenantId, kind }: { tenantId: string; kind?: string }) {
  const k = kind && kind in OPS_REASON_KINDS ? kind : "REGULARISATION";
  const codes = await reasonCodes(tenantId, k);
  const now = new Date();
  const report = k === "REGULARISATION" ? await regularisationReasonReport(tenantId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)), now) : null;
  return (
    <div className="stack gap-4">
      <div className="tabs">{Object.entries(OPS_REASON_KINDS).map(([x, l]) => <a key={x} className={`tab${x === k ? " active" : ""}`} href={`/time/controls?tab=reasons&kind=${x}`}>{l}</a>)}</div>
      <Card title={`Add to ${OPS_REASON_KINDS[k]!.toLowerCase()}`}>
        <SpecForm action={saveReasonCodeAction} hidden={{ kind: k }} columns={3} fields={[
          { name: "code", label: "Code", required: true }, { name: "label", label: "Label", required: true },
          { name: "parentId", label: "Under", type: "select", options: codes.map((c) => ({ value: c.id, label: `${c.code} · ${c.label}` })), placeholder: "Top level" },
          { name: "appliesTo", label: k === "STATUS" ? "For statuses (comma separated)" : "Applies to", hint: k === "STATUS" ? "e.g. INACTIVE, NOTICE_PERIOD" : undefined },
          { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 }, { name: "description", label: "Description" },
        ]} />
      </Card>
      <Card title="Catalogue" tight>
        <Table head={["Code", "Label", "Parent", "Applies to", "Active", ""]} empty={codes.length === 0}>
          {codes.map((c) => <tr key={c.id}><td className="strong text-sm">{c.code}</td><td className="text-sm">{c.label}</td><td className="text-sm">{codes.find((p) => p.id === c.parentId)?.code ?? ""}</td><td className="text-xs">{c.appliesTo ?? ""}</td><td><Pill s={c.isActive ? "ACTIVE" : "INACTIVE"} /></td>
            <td><ActButton action={saveReasonCodeAction} hidden={{ kind: k, id: c.id, code: c.code, label: c.label, parentId: c.parentId ?? "", appliesTo: c.appliesTo ?? "", sortOrder: String(c.sortOrder), isActive: c.isActive ? "" : "on" }} label={c.isActive ? "Retire" : "Restore"} variant="ghost" /></td></tr>)}
        </Table>
      </Card>
      {report ? <Card title="Regularisations by reason (last 3 months)" tight>
        <Table head={["Reason", "Requests", "Approved", "Rejected", "Pending"]} empty={report.length === 0}>
          {report.map((r) => <tr key={r.code}><td className="text-sm">{r.label}</td><td className="num">{r.total}</td><td className="num">{r.counts.APPROVED ?? 0}</td><td className="num">{r.counts.REJECTED ?? 0}</td><td className="num">{r.counts.PENDING ?? 0}</td></tr>)}
        </Table>
      </Card> : null}
    </div>
  );
}

async function Early({ tenantId, month }: { tenantId: string; month?: string }) {
  const now = new Date();
  const [y, m] = /^\d{4}-\d{2}$/.test(month ?? "") ? month!.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const [rules, policies, report] = await Promise.all([
    prisma.opsEarlyDepartureRule.findMany({ where: { tenantId } }),
    prisma.attendancePolicy.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    earlyDepartureReport(tenantId, y!, m!),
  ]);
  return (
    <div className="stack gap-4">
      <Card title="Early departure rule" description="Leaving before the shift ends beyond the grace counts; after the free allowance each counts as LOP.">
        <SpecForm action={saveEarlyDepartureRuleAction} columns={3} fields={[
          { name: "policyKey", label: "Attendance policy", type: "select", required: true, options: [{ value: "ALL", label: "Every policy" }, ...policies.map((p) => ({ value: p.id, label: p.name }))] },
          { name: "graceMinutes", label: "Grace (minutes)", type: "number", defaultValue: 15 }, { name: "exemptPerMonth", label: "Free per month", type: "number", defaultValue: 2 },
          { name: "penaltyDays", label: "LOP days per incident", type: "number", defaultValue: 0.5 },
        ]} />
        <Table head={["Policy", "Grace", "Free / month", "LOP per incident", "Active"]} empty={rules.length === 0}>
          {rules.map((r) => <tr key={r.id}><td className="text-sm">{r.policyKey === "ALL" ? "Every policy" : policies.find((p) => p.id === r.policyKey)?.name ?? r.policyKey}</td><td className="num">{r.graceMinutes}</td><td className="num">{r.exemptPerMonth}</td><td className="num">{Number(r.penaltyDays)}</td><td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td></tr>)}
        </Table>
      </Card>
      <Card title={`Early departures, ${y}-${String(m).padStart(2, "0")}`} action={<ActButton action={applyEarlyDepartureAction} hidden={{ year: String(y), month: String(m) }} label="Book penalties as LOP" confirmText="Book this month's early-departure penalties as LOP adjustments?" />} tight>
        <Table head={["Employee", "Incidents", "Penalty days", "Days"]} empty={report.length === 0}>
          {report.map((r) => <tr key={r.employeeId}><td className="text-sm">{r.employee} ({r.employeeNumber})</td><td className="num">{r.incidents}</td><td className="num">{r.penaltyDays}</td><td className="text-xs">{r.days.map((d) => `${fmtDate(d.date)} −${d.minutes}m`).join(", ")}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Breaks({ tenantId }: { tenantId: string }) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const [rules, report, emps] = await Promise.all([
    prisma.opsBreakRule.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    breakReport(tenantId, from, now),
    prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <div className="grid grid-2">
        <Card title="Break types">
          <SpecForm action={saveBreakRuleAction} columns={2} fields={[
            { name: "name", label: "Name", required: true }, { name: "code", label: "Code", required: true },
            { name: "maxMinutes", label: "Max minutes", type: "number", required: true, defaultValue: 30 }, { name: "maxPerDay", label: "Per day", type: "number", defaultValue: 1 },
            { name: "isPaid", label: "Paid", type: "checkbox", placeholder: "Counts as worked time" },
          ]} />
          <Table head={["Break", "Max", "Per day", "Paid", "Active"]} empty={rules.length === 0}>
            {rules.map((r) => <tr key={r.id}><td className="text-sm">{r.name} ({r.code})</td><td className="num">{r.maxMinutes}m</td><td className="num">{r.maxPerDay}</td><td>{r.isPaid ? "Yes" : "No"}</td><td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td></tr>)}
          </Table>
        </Card>
        <Card title="Record or correct a break" description="Times in IST. Audited.">
          <SpecForm action={saveBreakEntryAction} columns={2} fields={[
            { name: "employeeId", label: "Employee", type: "select", required: true, options: emps.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` })) },
            { name: "ruleId", label: "Break", type: "select", required: true, options: rules.filter((r) => r.isActive).map((r) => ({ value: r.id, label: r.name })) },
            { name: "date", label: "Day", type: "date", required: true }, { name: "start", label: "Start (HH:MM)", required: true }, { name: "end", label: "End (HH:MM)", required: true }, { name: "note", label: "Note" },
          ]} />
        </Card>
      </div>
      <Card title="Breaks, last 30 days" tight>
        <Table head={["Employee", "Breaks", "Minutes", "Over limit", "Unpaid minutes"]} empty={report.summary.length === 0}>
          {report.summary.map((r) => <tr key={r.employeeId}><td className="text-sm">{r.employee} ({r.employeeNumber})</td><td className="num">{r.breaks}</td><td className="num">{r.minutes}</td><td className="num">{r.exceeded}</td><td className="num">{r.unpaidMinutes}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
