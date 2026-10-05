import { forbidden } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  getOpsSettings, OPS_ANOMALY_KINDS, reconciliationDashboard, punchSourceAudit, sourceComparison, teamHeatmap, timeLeakageReport, opsNextCutoff, opsAttendanceWindow, reasonCodes,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { ymdOf } from "@/components/ops-ui";
import { runAnomaliesAction, resolveAnomalyAction, runDeviceHealthAction } from "@/app/actions/ops-time-attend";
import { logIdleTimeAction } from "@/app/actions/ops-projects";

export const metadata = { title: "Time insights" };
const TABS = { anomalies: "Exceptions", reconciliation: "Reconciliation", devices: "Devices", sources: "Punch sources", heatmap: "Heatmap", leakage: "Tracked vs scheduled", idle: "Idle time", cutoff: "Cut-off" };
type Tab = keyof typeof TABS;
const HEAT = ["var(--surface-2, #eee)", "#f6d5d5", "#f8e7b0", "#cfe8c4", "#7fc47a"];

/**
 * Time Attend › Insights: attendance exceptions, the payroll reconciliation
 * up to the cut-off (the 25th by default), device health, punch-source audit,
 * the team heatmap, tracked vs scheduled hours, idle time and cut-off status.
 * Managers see their direct reports; attendance administrators see everyone.
 */
export default async function TimeInsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  if (!canAny(v, [P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE, P.ATTENDANCE_VIEW])) forbidden();
  const all = can(v, P.ATTENDANCE_MANAGE);
  if (!all && !v.employee) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "anomalies";
  const scope: Prisma.EmployeeWhereInput = all ? {} : { reportingManagerId: v.employee!.id };
  const now = new Date();
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month!.split("-").map(Number) as [number, number] : [now.getUTCFullYear(), now.getUTCMonth() + 1] as [number, number];
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? new Date(`${sp.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? new Date(`${sp.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const t = v.tenantId;
  const range = (
    <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12, alignItems: "center" }}>
      <input type="hidden" name="tab" value={tab} />
      {["reconciliation", "heatmap"].includes(tab) ? <input className="input" type="month" name="month" defaultValue={`${ym[0]}-${String(ym[1]).padStart(2, "0")}`} style={{ width: 160 }} />
        : <><input className="input" type="date" name="from" defaultValue={ymdOf(from)} style={{ width: 160 }} /><input className="input" type="date" name="to" defaultValue={ymdOf(to)} style={{ width: 160 }} /></>}
      {tab === "heatmap" && all ? <select name="dept" className="select" defaultValue={sp.dept ?? ""} style={{ width: 200 }}><option value="">All departments</option>{(await departmentOptions(t)).map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select> : null}
      {tab === "sources" ? <select name="source" className="select" defaultValue={sp.source ?? ""} style={{ width: 160 }}><option value="">All sources</option>{["WEB", "MOBILE", "BIOMETRIC", "KIOSK", "MANUAL", "IMPORT"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select> : null}
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  const qs = new URLSearchParams(Object.entries({ tab, month: sp.month, from: sp.from, to: sp.to, dept: sp.dept, source: sp.source }).filter((e): e is [string, string] => !!e[1])).toString();
  return (
    <>
      <PageHead title="Time insights" subtitle={all ? "Everyone" : "Your direct reports"} actions={<a className="btn" href={`/time/insights/export?${qs}`}>Download CSV</a>} />
      <Tabs base="/time/insights" tabs={TABS} active={tab} />
      {tab !== "devices" && tab !== "cutoff" ? range : null}
      {tab === "anomalies" ? <Anomalies tenantId={t} scope={scope} from={from} to={to} canRun={all} status={sp.status} /> : null}
      {tab === "reconciliation" ? <Reconciliation tenantId={t} scope={scope} y={ym[0]} m={ym[1]} /> : null}
      {tab === "devices" ? <Devices tenantId={t} canRun={all} /> : null}
      {tab === "sources" ? <Sources tenantId={t} from={from} to={to} source={sp.source} /> : null}
      {tab === "heatmap" ? <Heatmap tenantId={t} scope={sp.dept && all ? { departmentId: sp.dept } : scope} y={ym[0]} m={ym[1]} /> : null}
      {tab === "leakage" ? <Leakage tenantId={t} scope={scope} from={from} to={to} /> : null}
      {tab === "idle" ? <Idle tenantId={t} scope={scope} from={from} to={to} /> : null}
      {tab === "cutoff" ? <Cutoff tenantId={t} now={now} /> : null}
    </>
  );
}

async function scopeIds(tenantId: string, scope: Prisma.EmployeeWhereInput) {
  return (await prisma.employee.findMany({ where: { ...scope, tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true } })).map((e) => e.id);
}
async function nameMap(tenantId: string, ids: string[]) {
  return new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, `${e.displayName} (${e.employeeNumber})`]));
}

async function Anomalies({ tenantId, scope, from, to, canRun, status }: { tenantId: string; scope: Prisma.EmployeeWhereInput; from: Date; to: Date; canRun: boolean; status?: string }) {
  const ids = await scopeIds(tenantId, scope);
  const st = status === "ALL" ? undefined : status || "OPEN";
  const rows = await prisma.opsAttendanceAnomaly.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: from, lte: to }, ...(st ? { status: st } : {}) }, orderBy: [{ date: "desc" }, { severity: "asc" }], take: 400 });
  const names = await nameMap(tenantId, rows.map((r) => r.employeeId));
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.kind, (by.get(r.kind) ?? 0) + 1);
  return (
    <div className="stack gap-4">
      {canRun ? <Card title="Scan for exceptions" description="Checks processed attendance for missing punches, absences without leave, late arrivals, early departures, short or excess hours and work on off days. Employees and managers are told when notices are on.">
        <SpecForm action={runAnomaliesAction} columns={3} submitLabel="Scan" fields={[{ name: "from", label: "From", type: "date", required: true, defaultValue: ymdOf(from) }, { name: "to", label: "To", type: "date", required: true, defaultValue: ymdOf(to) }, { name: "notify", label: "Notify", type: "checkbox", placeholder: "Send notices" }]} />
      </Card> : null}
      <div className="grid grid-4">{Object.entries(OPS_ANOMALY_KINDS).slice(0, 8).map(([k, l]) => <Stat key={k} label={l} value={by.get(k) ?? 0} />)}</div>
      <div className="tabs">{["OPEN", "RESOLVED", "WAIVED", "ALL"].map((s) => <a key={s} className={`tab${(st ?? "ALL") === s ? " active" : ""}`} href={`/time/insights?tab=anomalies&from=${ymdOf(from)}&to=${ymdOf(to)}&status=${s}`}>{s.toLowerCase()}</a>)}</div>
      <Card title="Exceptions" tight>
        <Table head={["Day", "Employee", "Exception", "Severity", "Detail", "Status", ""]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="nowrap text-sm">{fmtDate(r.date)}</td><td className="text-sm">{names.get(r.employeeId) ?? ""}</td><td className="text-sm">{OPS_ANOMALY_KINDS[r.kind] ?? r.kind}</td>
              <td><Pill s={r.severity} /></td><td className="text-xs">{r.detail}{r.resolution ? <div className="subtle">{r.resolution}</div> : null}</td><td><Pill s={r.status} /></td>
              <td>{r.status === "OPEN" ? <div className="row gap-1"><ActButton action={resolveAnomalyAction} hidden={{ id: r.id, action: "RESOLVED" }} label="Resolve" input={{ name: "note", placeholder: "How", required: true }} /><ActButton action={resolveAnomalyAction} hidden={{ id: r.id, action: "WAIVED", note: "Waived" }} label="Waive" variant="ghost" /></div> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Reconciliation({ tenantId, scope, y, m }: { tenantId: string; scope: Prisma.EmployeeWhereInput; y: number; m: number }) {
  const r = await reconciliationDashboard(tenantId, y, m, scope);
  return (
    <div className="stack gap-4">
      <Callout title={`Payroll window ${fmtDate(r.from)} – ${fmtDate(r.to)}`}>Attendance up to the cut-off feeds this month's payroll. An employee is ready when every day is processed and nothing is open.</Callout>
      <div className="grid grid-4">
        <Stat label="Ready for payroll" value={`${r.totals.ready} / ${r.totals.employees}`} />
        <Stat label="Open exceptions" value={r.totals.unresolved} tone={r.totals.unresolved ? "neg" : undefined} />
        <Stat label="Pending requests" value={r.totals.pending} />
        <Stat label="LOP days" value={r.totals.lop} meta={`${r.totals.unprocessed} with unprocessed days`} />
      </div>
      <Card title="By employee" tight>
        <Table head={["Employee", "Department", "Days", "Present", "Leave", "Absent", "LOP", "Payable", "Open", "Pending", "Missing", "Ready"]} empty={r.rows.length === 0}>
          {r.rows.map((x) => <tr key={x.employeeId}><td className="text-sm">{x.employee} ({x.employeeNumber})</td><td className="text-sm">{x.department}</td><td className="num">{x.days}</td><td className="num">{x.present}</td><td className="num">{x.leave}</td><td className="num">{x.absent}</td><td className="num">{x.lop}</td><td className="num">{x.payable}</td><td className="num">{x.unresolved}</td><td className="num">{x.regularisationsPending}</td><td className="num">{x.missingDays}</td><td><Pill s={x.balanced ? "READY" : "PENDING"} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Devices({ tenantId, canRun }: { tenantId: string; canRun: boolean }) {
  const [rows, s] = await Promise.all([prisma.opsDeviceStatus.findMany({ where: { tenantId }, orderBy: [{ status: "asc" }, { name: "asc" }] }), getOpsSettings(tenantId)]);
  return (
    <Card title="Device health" description={`Stale after ${s.deviceStaleMinutes} min without a punch, offline after ${s.deviceOfflineMinutes} min. Administrators are alerted when a device goes offline.`} action={canRun ? <ActButton action={runDeviceHealthAction} hidden={{}} label="Check now" /> : null} tight>
      <Table head={["Device", "Status", "Last punch", "Punches (24h)", "Since", "Checked"]} empty={rows.length === 0}>
        {rows.map((d) => <tr key={d.id}><td className="text-sm">{d.name}</td><td><Pill s={d.status} /></td><td className="text-sm">{fmtWhen(d.lastPunchAt)}</td><td className="num">{d.punches24h}</td><td className="text-sm">{fmtWhen(d.since)}</td><td className="text-sm">{fmtWhen(d.checkedAt)}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Sources({ tenantId, from, to, source }: { tenantId: string; from: Date; to: Date; source?: string }) {
  const [audit, cmp] = await Promise.all([punchSourceAudit(tenantId, from, to, { source: source || null }), sourceComparison(tenantId, from, to)]);
  return (
    <div className="stack gap-4">
      <Card title="Punches by source" tight>
        <Table head={["Source", "Status", "Punches"]} empty={audit.totals.length === 0}>
          {audit.totals.map((x) => <tr key={`${x.source}${x.status}`}><td className="text-sm">{String(x.source).toLowerCase()}</td><td><Pill s={String(x.status)} /></td><td className="num">{x.count}</td></tr>)}
        </Table>
      </Card>
      <Card title="Days punched from more than one source" description="A mismatch means the sources disagree by more than the tolerance set under Controls." tight>
        <Table head={["Day", "Employee", "Sources", "Spread (min)", "Agrees"]} empty={cmp.length === 0}>
          {cmp.slice(0, 200).map((x) => <tr key={`${x.employeeId}${x.date}`}><td className="text-sm">{x.date}</td><td className="text-sm">{x.employee}</td><td className="text-xs">{x.sources.join(", ").toLowerCase()}</td><td className="num">{x.spreadMinutes}</td><td><Pill s={x.mismatch ? "MISMATCH" : "OK"} /></td></tr>)}
        </Table>
      </Card>
      <Card title="Punch log (latest 500)" tight>
        <Table head={["When", "Employee", "Source", "Device", "Direction", "Status"]} empty={audit.rows.length === 0}>
          {audit.rows.map((x) => <tr key={x.id}><td className="text-sm nowrap">{fmtWhen(x.timestamp)}</td><td className="text-sm">{x.employee} ({x.employeeNumber})</td><td className="text-sm">{String(x.source).toLowerCase()}</td><td className="text-xs">{x.device ?? ""}</td><td className="text-sm">{x.direction === 0 ? "In" : x.direction === 1 ? "Out" : String(x.direction)}</td><td><Pill s={String(x.status)} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Heatmap({ tenantId, scope, y, m }: { tenantId: string; scope: Prisma.EmployeeWhereInput; y: number; m: number }) {
  const ids = await scopeIds(tenantId, scope);
  const h = await teamHeatmap(tenantId, ids, y, m);
  const names = await nameMap(tenantId, ids);
  return (
    <div className="stack gap-4">
      <Card title={`Attendance heatmap: ${ids.length} people`} description="Darker green means more of the team present; grey is a weekly off or holiday.">
        <div className="row gap-1 wrap">
          {h.days.map((d) => <div key={d.date} title={`${d.date}: ${d.present} present, ${d.leave} on leave, ${d.absent} absent of ${d.expected}`} style={{ width: 34, height: 34, borderRadius: 4, background: d.level < 0 ? "var(--border)" : HEAT[d.level] ?? HEAT[0], display: "grid", placeItems: "center", fontSize: 11 }}>{Number(d.date.slice(8))}</div>)}
        </div>
      </Card>
      <Card title="By person" tight>
        <Table head={["Employee", ...h.days.map((d) => d.date.slice(8))]} empty={h.perPerson.length === 0}>
          {h.perPerson.slice(0, 100).map((p) => <tr key={p.employeeId}><td className="text-sm nowrap">{names.get(p.employeeId) ?? ""}</td>{p.cells.map((c, i) => <td key={i} className="text-xs" title={c ?? ""}>{c ? c.slice(0, 2) : ""}</td>)}</tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Leakage({ tenantId, scope, from, to }: { tenantId: string; scope: Prisma.EmployeeWhereInput; from: Date; to: Date }) {
  const rows = await timeLeakageReport(tenantId, from, to, await scopeIds(tenantId, scope));
  return (
    <Card title="Tracked vs scheduled" description="Scheduled hours from shifts, attended hours from punches, logged hours from timesheets and idle time. Leakage is attended time not logged to any project." tight>
      <Table head={["Employee", "Scheduled", "Attended", "Attendance %", "Logged", "Idle", "Leakage (h)", "Leakage %", "Unexplained"]} empty={rows.length === 0}>
        {rows.map((r) => <tr key={r.employeeId}><td className="text-sm">{r.employee} ({r.employeeNumber})</td><td className="num">{r.scheduled}</td><td className="num">{r.attended}</td><td className="num">{r.attendancePct ?? "—"}</td><td className="num">{r.logged}</td><td className="num">{r.idle}</td><td className="num">{r.leakageHours}</td><td className="num">{r.leakagePct ?? "—"}</td><td className="num">{r.unexplained}</td></tr>)}
      </Table>
    </Card>
  );
}

async function Idle({ tenantId, scope, from, to }: { tenantId: string; scope: Prisma.EmployeeWhereInput; from: Date; to: Date }) {
  const ids = await scopeIds(tenantId, scope);
  const rows = await prisma.opsIdleLog.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: from, lte: to } }, orderBy: { date: "desc" }, take: 300 });
  const names = await nameMap(tenantId, rows.map((r) => r.employeeId));
  const users = await userNames(tenantId, rows.map((r) => r.createdBy));
  const cats = await reasonCodes(tenantId, "IDLE", true);
  return (
    <div className="stack gap-4">
      <Card title="Log your idle time" description="Waiting on work, system downtime, training: time at work not spent on project tasks.">
        <SpecForm action={logIdleTimeAction} columns={3} fields={[
          { name: "date", label: "Day", type: "date", required: true }, { name: "minutes", label: "Minutes", type: "number", required: true },
          { name: "category", label: "Why", type: "select", required: true, options: cats.map((c) => ({ value: c.code, label: c.label })), hint: cats.length ? undefined : "Add idle-time reasons under Controls › Reason catalogues" },
          { name: "note", label: "Note", wide: true },
        ]} />
      </Card>
      <Card title="Idle time" tight>
        <Table head={["Day", "Employee", "Minutes", "Why", "Source", "Note", "Logged by"]} empty={rows.length === 0}>
          {rows.map((r) => <tr key={r.id}><td className="text-sm">{fmtDate(r.date)}</td><td className="text-sm">{names.get(r.employeeId) ?? ""}</td><td className="num">{r.minutes}</td><td className="text-sm">{r.category.toLowerCase()}</td><td className="text-xs">{r.source.toLowerCase()}</td><td className="text-xs">{r.note ?? ""}</td><td className="text-xs">{users.get(r.createdBy) ?? ""}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Cutoff({ tenantId, now }: { tenantId: string; now: Date }) {
  const s = await getOpsSettings(tenantId);
  const next = opsNextCutoff(now, s.attendanceCutoffDay);
  const w = opsAttendanceWindow(next.date.getUTCFullYear(), next.date.getUTCMonth() + 1, s.attendanceCutoffDay);
  const alerts = await prisma.opsAlertLog.findMany({ where: { tenantId, kind: { in: ["ATTENDANCE_CUTOFF", "ATTENDANCE_CUTOFF_MANAGER", "PAYROLL_INPUT_CUTOFF"] } }, orderBy: { createdAt: "desc" }, take: 50 });
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Next cut-off" value={fmtDate(next.date)} meta={`${next.daysLeft} day(s) left`} />
        <Stat label="Window" value={`${fmtDate(w.from)} – ${fmtDate(w.to)}`} />
        <Stat label="Reminders" value={`${s.cutoffAlertDaysBefore} day(s) before`} />
      </div>
      <Callout tone={next.daysLeft <= s.cutoffAlertDaysBefore ? "warning" : "info"} title="How the cut-off works">Attendance, regularisations and leave dated after day {s.attendanceCutoffDay} are paid in the next run. The nightly job reminds people with open items and their managers, and payroll administrators about pending inputs.</Callout>
      <Card title="Cut-off reminders sent" tight>
        <Table head={["When", "Reminder", "People"]} empty={alerts.length === 0}>
          {alerts.map((a) => <tr key={a.id}><td className="text-sm">{fmtWhen(a.createdAt)}</td><td className="text-sm">{a.title}</td><td className="num">{a.userIds.length}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
