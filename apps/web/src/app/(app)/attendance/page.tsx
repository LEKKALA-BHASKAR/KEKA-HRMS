import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can, canAny, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere, parseMonth, monthKey, shiftMonth } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import {
  ShiftForm, AttendancePolicyForm, AssignTimePolicyForm, ProcessAttendanceForm,
} from "../_time/attendance-forms";
import { DecisionForm } from "../_time/leave-forms";
import { AttCode, AttLegend, hours, istTime } from "../_time/attendance-view";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);
const TABS = ["today", "register", "requests", "shifts", "policies", "assign", "process"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  today: "Today", register: "Monthly register", requests: "Requests", shifts: "Shifts",
  policies: "Policies", assign: "Assignments", process: "Process",
};
const ADMIN_TABS: Tab[] = ["shifts", "policies", "assign", "process"];

export default async function AttendanceAdminPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; month?: string; status?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.ATTENDANCE_VIEW);
  if (!canAny(viewer, [P.ATTENDANCE_APPROVE, P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE])) redirect("/me/attendance");

  const sp = await searchParams;
  const manage = can(viewer, P.ATTENDANCE_MANAGE);
  const visible = TABS.filter((t) => !ADMIN_TABS.includes(t) || manage || (t === "shifts" && can(viewer, P.SHIFT_MANAGE)));
  const tab: Tab = visible.includes(sp.tab as Tab) ? (sp.tab as Tab) : "today";

  const scope = scopedEmployeeWhere(viewer, P.ATTENDANCE_VIEW);
  const pending = await prisma.attendanceRequest.count({
    where: { tenantId: viewer.tenantId, status: "PENDING", employee: scope },
  });

  return (
    <>
      <PageHead title="Attendance" subtitle="Who is in, what each day counted as, and the requests that correct it" />
      <div className="tabs">
        {visible.map((t) => (
          <Link key={t} href={`/attendance?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {LABEL[t]}{t === "requests" && pending > 0 ? ` (${pending})` : ""}
          </Link>
        ))}
      </div>
      {tab === "today" ? <TodayTab viewer={viewer} scope={scope} /> : null}
      {tab === "register" ? <RegisterTab viewer={viewer} scope={scope} month={sp.month} /> : null}
      {tab === "requests" ? <RequestsTab viewer={viewer} scope={scope} status={sp.status} /> : null}
      {tab === "shifts" ? <ShiftsTab tenantId={viewer.tenantId} edit={sp.edit} /> : null}
      {tab === "policies" ? <PoliciesTab tenantId={viewer.tenantId} edit={sp.edit} /> : null}
      {tab === "assign" ? <AssignTab tenantId={viewer.tenantId} /> : null}
      {tab === "process" ? <ProcessTab tenantId={viewer.tenantId} /> : null}
    </>
  );
}

const IST_OFFSET = 330 * 60_000;
function istToday() {
  const local = new Date(Date.now() + IST_OFFSET);
  const key = local.toISOString().slice(0, 10);
  return { key, date: new Date(`${key}T00:00:00Z`), start: new Date(new Date(`${key}T00:00:00Z`).getTime() - IST_OFFSET) };
}

async function TodayTab({ viewer, scope }: { viewer: Viewer; scope: Record<string, unknown> }) {
  const today = istToday();
  const employees = await prisma.employee.findMany({
    where: { ...scope, status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] }, dateOfJoining: { lte: today.date } },
    select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } },
    orderBy: { employeeNumber: "asc" },
  });
  const ids = employees.map((e) => e.id);
  const [logs, leave, remote, holiday, assignments] = await Promise.all([
    prisma.attendanceLog.findMany({
      where: { employeeId: { in: ids }, timestamp: { gte: today.start, lt: new Date(today.start.getTime() + 86_400_000) } },
      orderBy: { timestamp: "asc" },
    }),
    prisma.leaveRequestDay.findMany({
      where: { date: today.date, request: { employeeId: { in: ids }, status: "APPROVED" } },
      select: { portion: true, request: { select: { employeeId: true, leaveType: { select: { code: true } } } } },
    }),
    prisma.attendanceRequest.findMany({
      where: { employeeId: { in: ids }, status: "APPROVED", type: { in: ["WORK_FROM_HOME", "ON_DUTY"] }, fromDate: { lte: today.date }, toDate: { gte: today.date } },
      select: { employeeId: true, type: true },
    }),
    prisma.holiday.findFirst({ where: { date: today.date, isOptional: false, calendar: { tenantId: viewer.tenantId, isDefault: true } } }),
    prisma.employeeTimePolicy.findMany({
      where: { employeeId: { in: ids }, effectiveFrom: { lte: today.date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today.date } }] },
      select: { employeeId: true, trackAttendance: true, shiftId: true },
    }),
  ]);
  const shifts = await prisma.shift.findMany({ where: { tenantId: viewer.tenantId } });
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const defaultShift = shifts.find((s) => s.code === "GEN") ?? shifts[0];
  const policyOf = new Map(assignments.map((a) => [a.employeeId, a]));
  const logsOf = new Map<string, typeof logs>();
  for (const l of logs) logsOf.set(l.employeeId, [...(logsOf.get(l.employeeId) ?? []), l]);
  const leaveOf = new Map(leave.map((l) => [l.request.employeeId, l]));
  const remoteOf = new Map(remote.map((r) => [r.employeeId, r.type]));
  const dow = today.date.getUTCDay();
  const weekend = dow === 0 || dow === 6;

  type Row = { e: (typeof employees)[number]; state: string; tone: "success" | "warning" | "danger" | "info" | "neutral"; first?: Date; last?: Date; late?: number };
  const rows: Row[] = employees.map((e) => {
    const l = logsOf.get(e.id) ?? [];
    const first = l.find((x) => x.direction === 0)?.timestamp;
    const lastLog = l[l.length - 1];
    const tracked = policyOf.get(e.id)?.trackAttendance ?? true;
    const shift = shiftById.get(policyOf.get(e.id)?.shiftId ?? "") ?? defaultShift;
    let late: number | undefined;
    if (first && shift && !shift.isFlexible) {
      const [h, m] = shift.startTime.split(":").map(Number);
      const start = today.start.getTime() + (h * 60 + m) * 60_000;
      const mins = Math.round((first.getTime() - start) / 60_000);
      if (mins > 15) late = mins;
    }
    if (leaveOf.has(e.id)) return { e, state: `On leave (${leaveOf.get(e.id)!.request.leaveType.code}${leaveOf.get(e.id)!.portion !== "FULL_DAY" ? ", half" : ""})`, tone: "info", first };
    if (remoteOf.has(e.id)) return { e, state: remoteOf.get(e.id) === "ON_DUTY" ? "On duty" : "Working from home", tone: "info", first };
    if (holiday) return { e, state: `Holiday — ${holiday.name}`, tone: "neutral", first };
    if (weekend && l.length === 0) return { e, state: "Weekly off", tone: "neutral" };
    if (!tracked && l.length === 0) return { e, state: "Not tracked", tone: "neutral" };
    if (l.length === 0) return { e, state: "Not in yet", tone: "warning" };
    if (lastLog.direction === 0) return { e, state: "In", tone: "success", first, late };
    return { e, state: "Out", tone: "neutral", first, last: lastLog.timestamp, late };
  });

  const count = (s: (r: Row) => boolean) => rows.filter(s).length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="In now" value={String(count((r) => r.state === "In"))} meta={`of ${rows.length}`} />
        <Stat label="Not in yet" value={String(count((r) => r.state === "Not in yet"))} meta={weekend || holiday ? "off day" : "working day"} />
        <Stat label="On leave or remote" value={String(count((r) => r.tone === "info"))} meta="approved" />
        <Stat label="Late today" value={String(count((r) => (r.late ?? 0) > 0))} meta="beyond 15 min grace" />
      </div>
      <Card tight title={`Today — ${formatDate(today.date)}`}>
        {rows.length === 0 ? <Empty title="No employees in your scope" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>First in</th><th>Last out</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.e.id}>
                    <td><Person name={r.e.displayName ?? ""} meta={r.e.employeeNumber} /></td>
                    <td className="text-sm muted">{r.e.department?.name ?? "—"}</td>
                    <td><Badge tone={r.tone} dot>{r.state}</Badge></td>
                    <td className="num text-sm">{istTime(r.first)}{r.late ? <span className="text-xs neg"> +{r.late}m</span> : null}</td>
                    <td className="num text-sm">{istTime(r.last)}</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function RegisterTab({ viewer, scope, month }: { viewer: Viewer; scope: Record<string, unknown>; month?: string }) {
  const { year, month: m } = parseMonth(month, new Date(Date.now() + IST_OFFSET));
  const start = new Date(Date.UTC(year, m - 1, 1));
  const end = new Date(Date.UTC(year, m, 0));
  const days = end.getUTCDate();
  const employees = await prisma.employee.findMany({
    where: { ...scope, status: { notIn: ["PREBOARDING"] }, dateOfJoining: { lte: end } },
    select: { id: true, displayName: true, employeeNumber: true },
    orderBy: { employeeNumber: "asc" },
  });
  const records = await prisma.attendanceRecord.findMany({
    where: { tenantId: viewer.tenantId, employeeId: { in: employees.map((e) => e.id) }, date: { gte: start, lte: end } },
    select: { employeeId: true, date: true, status: true, lopValue: true, payableValue: true, penaltyReason: true, remark: true, effectiveHours: true, overtimeHours: true },
  });
  const grid = new Map<string, Map<number, (typeof records)[number]>>();
  for (const r of records) {
    const row = grid.get(r.employeeId) ?? new Map();
    row.set(r.date.getUTCDate(), r);
    grid.set(r.employeeId, row);
  }
  const prev = shiftMonth(year, m, -1), next = shiftMonth(year, m, 1);
  const label = start.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <Card tight title={`Register — ${label}`}
      description="Payable days and attendance LOP are what payroll step 1 reads. Unpaid leave is charged separately through the leave request."
      action={
        <div className="row gap-2">
          <Link className="btn sm" href={`/attendance?tab=register&month=${monthKey(prev.year, prev.month)}`}>‹ Prev</Link>
          <Link className="btn sm" href={`/attendance?tab=register&month=${monthKey(next.year, next.month)}`}>Next ›</Link>
        </div>
      }>
      {records.length === 0 ? <Empty title="No attendance processed for this month">Run it from the Process tab.</Empty> : (
        <>
          <div className="table-wrap">
            <table className="data cal-grid">
              <thead>
                <tr>
                  <th>Employee</th>
                  {Array.from({ length: days }, (_, i) => {
                    const dow = new Date(Date.UTC(year, m - 1, i + 1)).getUTCDay();
                    return <th key={i} className={`cal-day${dow === 0 || dow === 6 ? " off" : ""}`}>{i + 1}</th>;
                  })}
                  <th className="num">Payable</th><th className="num">LOP</th><th className="num">Late</th><th className="num">OT h</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const row = grid.get(e.id) ?? new Map();
                  const rs = [...row.values()];
                  const payable = rs.reduce((s, r) => s + n(r.payableValue), 0);
                  const lop = rs.reduce((s, r) => s + n(r.lopValue), 0);
                  const late = rs.filter((r) => r.remark?.includes("Late by")).length;
                  const ot = rs.reduce((s, r) => s + n(r.overtimeHours), 0);
                  return (
                    <tr key={e.id}>
                      <td className="nowrap text-sm"><Link href={`/employees/${e.id}`}>{e.displayName}</Link></td>
                      {Array.from({ length: days }, (_, i) => {
                        const r = row.get(i + 1);
                        return (
                          <td key={i} className="cal-cell">
                            {r ? <AttCode status={r.status} penalised={!!r.penaltyReason} late={!!r.remark?.includes("Late by")}
                              title={`${formatDate(r.date)}: ${r.remark ?? r.status}${n(r.lopValue) > 0 ? ` · LOP ${n(r.lopValue)}` : ""}${n(r.effectiveHours) > 0 ? ` · ${hours(r.effectiveHours)}h` : ""}`} /> : null}
                          </td>
                        );
                      })}
                      <td className="num">{rs.length ? payable.toFixed(1) : "—"}</td>
                      <td className={`num${lop > 0 ? " neg" : ""}`}>{lop > 0 ? lop.toFixed(1) : "—"}</td>
                      <td className="num">{late || "—"}</td>
                      <td className="num">{ot > 0 ? ot.toFixed(1) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: 14 }}><AttLegend /></div>
        </>
      )}
    </Card>
  );
}

async function RequestsTab({ viewer, scope, status }: { viewer: Viewer; scope: Record<string, unknown>; status?: string }) {
  const filter = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status ?? "") ? status! : "PENDING";
  const requests = await prisma.attendanceRequest.findMany({
    where: { tenantId: viewer.tenantId, status: filter as never, employee: scope },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } },
    orderBy: filter === "PENDING" ? { fromDate: "asc" } : { updatedAt: "desc" },
    take: 60,
  });
  // Viewing is wider than approving: decide only where approve scope reaches.
  const approveWhere = scopedEmployeeWhere(viewer, P.ATTENDANCE_APPROVE);
  const approvable = can(viewer, P.ATTENDANCE_APPROVE)
    ? new Set((await prisma.employee.findMany({ where: approveWhere, select: { id: true } })).map((e) => e.id))
    : new Set<string>();
  return (
    <Card tight title="Attendance requests"
      action={
        <div className="row gap-2">
          {["PENDING", "APPROVED", "REJECTED", "CANCELLED"].map((s) => (
            <Link key={s} href={`/attendance?tab=requests&status=${s}`} className={`btn sm${s === filter ? " primary" : ""}`}>{s.toLowerCase()}</Link>
          ))}
        </div>
      }>
      {requests.length === 0 ? <Empty title={filter === "PENDING" ? "Nothing waiting for a decision" : `No ${filter.toLowerCase()} requests`} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Request</th><th>Dates</th><th>Detail</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/employees/${r.employee.id}`}><Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} /></Link></td>
                  <td><Badge tone={r.type === "REGULARISATION" ? "warning" : "neutral"}>{r.type.replace(/_/g, " ").toLowerCase()}</Badge></td>
                  <td className="nowrap text-sm">{formatDate(r.fromDate)}{r.toDate.getTime() !== r.fromDate.getTime() ? ` – ${formatDate(r.toDate)}` : ""}</td>
                  <td className="text-sm num">
                    {r.proposedIn || r.proposedOut ? `${istTime(r.proposedIn)} – ${istTime(r.proposedOut)}` : r.partialMinutes ? `${r.partialMinutes} min` : "—"}
                  </td>
                  <td className="text-sm muted" style={{ maxWidth: 280 }}>{r.reason}{r.decisionNote ? <div className="text-xs">Note: {r.decisionNote}</div> : null}</td>
                  <td className="right">
                    {r.status === "PENDING" && approvable.has(r.employeeId) && r.employeeId !== viewer.employee?.id
                      ? <DecisionForm requestId={r.id} kind="attendance" />
                      : r.status === "PENDING" ? <span className="text-xs subtle">not your approval</span>
                      : <Badge tone={r.status === "APPROVED" ? "success" : r.status === "REJECTED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

async function ShiftsTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const shifts = await prisma.shift.findMany({ where: { tenantId }, orderBy: { startTime: "asc" } });
  const usage = await prisma.employeeTimePolicy.groupBy({ by: ["shiftId"], where: { effectiveTo: null }, _count: { _all: true } });
  const used = new Map(usage.map((u) => [u.shiftId, u._count._all]));
  const editing = edit ? shifts.find((s) => s.id === edit) : undefined;
  return (
    <div className="stack gap-4">
      <Card title={editing ? `Edit ${editing.name}` : "New shift"} action={editing ? <Link className="btn sm" href="/attendance?tab=shifts">Close</Link> : null}>
        {editing ? (
          <ShiftForm key={editing.id} shift={{ ...editing, requiredHours: editing.requiredHours ? n(editing.requiredHours) : null }} />
        ) : <Disclosure label="Create a shift"><ShiftForm /></Disclosure>}
      </Card>
      <Card tight title="Shifts">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Shift</th><th>Timing</th><th className="num">Break</th><th>Kind</th><th className="num">Employees</th><th /></tr></thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td><span className="row gap-2"><span className="dot" style={{ color: s.color ?? "var(--brand-500)" }} /><span className="strong">{s.name}</span><span className="mono text-xs subtle">{s.code}</span></span></td>
                  <td className="num">{s.isFlexible ? `${n(s.requiredHours)}h flexible` : `${s.startTime} – ${s.endTime}`}</td>
                  <td className="num">{s.breakMinutes}m</td>
                  <td>{s.crossesMidnight ? <Badge tone="info">night</Badge> : s.isFlexible ? <Badge>flexible</Badge> : <Badge>fixed</Badge>}</td>
                  <td className="num">{used.get(s.id) ?? 0}</td>
                  <td className="right"><Link className="btn sm ghost" href={`/attendance?tab=shifts&edit=${s.id}`}>Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function describeWeeklyOff(config: unknown): string {
  const c = (config ?? {}) as Record<string, { instances?: number[] | "ALL"; portion?: string }>;
  const parts = Object.entries(c).map(([day, v]) => {
    const which = v.instances === "ALL" || !v.instances ? "every" : v.instances.map((i) => ["", "1st", "2nd", "3rd", "4th", "5th"][i]).join(" & ");
    return `${which} ${day.charAt(0)}${day.slice(1).toLowerCase()}${v.portion && v.portion !== "FULL_DAY" ? ` (${v.portion.replace("_", " ").toLowerCase()})` : ""}`;
  });
  return parts.join(", ") || "none";
}

async function PoliciesTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const [policies, weeklyOffs] = await Promise.all([
    prisma.attendancePolicy.findMany({ where: { tenantId }, include: { _count: { select: { assignments: { where: { effectiveTo: null } } } } }, orderBy: { name: "asc" } }),
    prisma.weeklyOffPolicy.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const editing = edit ? policies.find((p) => p.id === edit) : undefined;
  return (
    <div className="stack gap-4">
      <Card title={editing ? `Edit ${editing.name}` : "New attendance policy"} action={editing ? <Link className="btn sm" href="/attendance?tab=policies">Close</Link> : null}>
        {editing ? (
          <AttendancePolicyForm key={editing.id} policy={{
            ...editing,
            ipAllowList: Array.isArray(editing.ipAllowList) ? (editing.ipAllowList as string[]).join(", ") : "",
            latePenaltyDays: n(editing.latePenaltyDays), missingPunchPenaltyDays: n(editing.missingPunchPenaltyDays),
          }} />
        ) : <Disclosure label="Create a policy"><AttendancePolicyForm /></Disclosure>}
      </Card>
      <Card tight title="Attendance policies">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Policy</th><th>Day counts as</th><th>Late</th><th>Missing punch</th><th>Capture</th><th className="num">Employees</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td><span className="strong">{p.name}</span> {p.isDefault ? <Badge tone="info">default</Badge> : null}{p.description ? <div className="text-xs subtle">{p.description}</div> : null}</td>
                  <td className="text-sm">full ≥{p.fullDayThresholdPct}% · half ≥{p.halfDayThresholdPct}%</td>
                  <td className="text-sm">{p.graceMinutes}m grace · {p.lateExemptPerMonth} free · {n(p.latePenaltyDays)} LOP</td>
                  <td className="text-sm">{p.missingPunchExemptPerMonth} free · {n(p.missingPunchPenaltyDays)} LOP</td>
                  <td className="text-xs muted">
                    {[p.allowWebClockIn ? "web" : "no web", Array.isArray(p.ipAllowList) && (p.ipAllowList as string[]).length ? "IP-restricted" : null,
                      p.overtimeEnabled ? `OT after ${p.overtimeMinMinutes}m` : null, p.noAttendanceIsLop ? "no-show = LOP" : null].filter(Boolean).join(" · ")}
                  </td>
                  <td className="num">{p._count.assignments}</td>
                  <td className="right"><Link className="btn sm ghost" href={`/attendance?tab=policies&edit=${p.id}`}>Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card tight title="Weekly-off patterns">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Pattern</th><th>Days off</th><th /></tr></thead>
            <tbody>
              {weeklyOffs.map((w) => (
                <tr key={w.id}><td className="strong">{w.name}</td><td className="text-sm">{describeWeeklyOff(w.config)}</td><td>{w.isDefault ? <Badge tone="info">default</Badge> : null}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

async function AssignTab({ tenantId }: { tenantId: string }) {
  const today = istToday().date;
  const [employees, policies, shifts, weeklyOffs, current] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
    prisma.attendancePolicy.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.shift.findMany({ where: { tenantId, isActive: true }, orderBy: { startTime: "asc" } }),
    prisma.weeklyOffPolicy.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.employeeTimePolicy.findMany({
      where: { employee: { tenantId }, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
      orderBy: { effectiveFrom: "desc" },
    }),
  ]);
  const cur = new Map<string, (typeof current)[number]>();
  for (const c of current) if (!cur.has(c.employeeId)) cur.set(c.employeeId, c);
  const pName = new Map(policies.map((p) => [p.id, p.name]));
  const sName = new Map(shifts.map((s) => [s.id, `${s.name}`]));
  const wName = new Map(weeklyOffs.map((w) => [w.id, w.name]));
  const opt = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => ({ value: x.id, label: x.name }));
  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0,1fr) 380px", alignItems: "start" }}>
      <Card tight title="Current assignments" description="Employees with no assignment fall back to the tenant defaults">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Employee</th><th>Policy</th><th>Shift</th><th>Weekly off</th><th>Tracked</th><th>Since</th></tr></thead>
            <tbody>
              {employees.map((e) => {
                const a = cur.get(e.id);
                return (
                  <tr key={e.id}>
                    <td><Person name={e.displayName ?? ""} meta={e.employeeNumber} /></td>
                    <td className="text-sm">{a?.attendancePolicyId ? pName.get(a.attendancePolicyId) : <span className="subtle">default</span>}</td>
                    <td className="text-sm">{a?.shiftId ? sName.get(a.shiftId) : <span className="subtle">default</span>}</td>
                    <td className="text-sm">{a?.weeklyOffPolicyId ? wName.get(a.weeklyOffPolicyId) : <span className="subtle">default</span>}</td>
                    <td>{a && !a.trackAttendance ? <Badge>not tracked</Badge> : <Badge tone="success">tracked</Badge>}</td>
                    <td className="text-sm muted nowrap">{a ? formatDate(a.effectiveFrom) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Assign" description="Effective-dated: the previous assignment closes the day before">
        <AssignTimePolicyForm
          employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }))}
          policies={opt(policies)} shifts={opt(shifts)} weeklyOffs={opt(weeklyOffs)} />
      </Card>
    </div>
  );
}

async function ProcessTab({ tenantId }: { tenantId: string }) {
  const today = istToday().date;
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const [latest, openRuns, summary] = await Promise.all([
    prisma.attendanceRecord.findFirst({ where: { tenantId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    prisma.payrollRun.findMany({ where: { tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] } }, select: { id: true, year: true, month: true } }),
    prisma.attendanceRecord.groupBy({
      by: ["status"], where: { tenantId, date: { gte: monthStart, lte: today } }, _count: { _all: true }, _sum: { lopValue: true },
    }),
  ]);
  const lop = summary.reduce((s, r) => s + n(r._sum.lopValue), 0);
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Process attendance" description="Re-evaluates every day in the range from punches, leave, requests and the assigned policy. Idempotent — run it as often as you like.">
        <ProcessAttendanceForm from={monthStart.toISOString().slice(0, 10)} to={today.toISOString().slice(0, 10)} />
        {openRuns.length > 0 ? (
          <div className="text-xs muted" style={{ marginTop: 10 }}>
            Open payroll run{openRuns.length > 1 ? "s" : ""}: {openRuns.map((r) => <Link key={r.id} href={`/payroll/runs/${r.id}`}>{r.month}/{r.year} </Link>)}
            — recalculate after processing so LOP flows through.
          </div>
        ) : null}
      </Card>
      <Card title="This month so far" tight>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Status</th><th className="num">Days</th><th className="num">LOP</th></tr></thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.status}><td><AttCode status={s.status} /> <span className="text-sm">{s.status.replace(/_/g, " ").toLowerCase()}</span></td><td className="num">{s._count._all}</td><td className="num">{n(s._sum.lopValue) > 0 ? n(s._sum.lopValue) : "—"}</td></tr>
              ))}
              <tr><td className="strong">Total LOP</td><td /><td className="num strong">{lop.toFixed(1)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="text-xs subtle" style={{ padding: 14 }}>Last processed {latest ? latest.updatedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never"}</div>
      </Card>
    </div>
  );
}
