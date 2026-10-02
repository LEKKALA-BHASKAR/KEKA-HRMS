import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { leaveYearStart } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Avatar } from "@/components/avatar";
import { Donut, Bars, Chip } from "@/components/keka";
import s from "./time.module.css";

/**
 * Time Attend › Dashboard: Attendance Summary (today's snapshot), Attendance
 * Analytics (hours, overtime and shortfall leaderboards), Leave Summary and
 * Leave Analytics. Everything is computed from processed attendance, punches,
 * approved requests and leave days, inside the viewer's attendance or leave
 * view scope.
 */

const P = PERMISSIONS;
const IST = 330 * 60_000;
const DAY = 86_400_000;
const n = (v: unknown) => Number(v ?? 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const name = (e: { displayName: string | null; firstName: string; lastName: string }) => e.displayName ?? `${e.firstName} ${e.lastName}`;

function istToday() {
  const key = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const date = new Date(`${key}T00:00:00Z`);
  return { key, date, start: new Date(date.getTime() - IST) };
}
const clock = (d: Date | null | undefined) => {
  if (!d) return "—";
  const l = new Date(d.getTime() + IST);
  const h = l.getUTCHours();
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(l.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

// ---------------------------------------------------------------------------
//  Attendance Summary
// ---------------------------------------------------------------------------

export type SnapshotKey = "all" | "ontime" | "late" | "wfh" | "od" | "remote" | "notin" | "leave" | "off";
export const SNAPSHOT: Array<{ key: SnapshotKey; label: string; colour: string }> = [
  { key: "all", label: "Total Employees", colour: "var(--brand-500)" },
  { key: "ontime", label: "Early / On Time Arrivals", colour: "#4caf50" },
  { key: "late", label: "Late Arrivals", colour: "#ef5350" },
  { key: "wfh", label: "Work From Home", colour: "#4fc3d9" },
  { key: "od", label: "On Duty", colour: "#f5b83d" },
  { key: "remote", label: "Remote Clock-In", colour: "#9b7ede" },
  { key: "notin", label: "Not In Yet", colour: "#90a4ae" },
  { key: "leave", label: "On Leave", colour: "#7e57c2" },
  { key: "off", label: "Holiday / Weekly Off", colour: "#c9b48a" },
];

export async function AttendanceSummary({ viewer, view, href }: { viewer: Viewer; view?: string; href: (view: string) => string }) {
  const today = istToday();
  const employees = await prisma.employee.findMany({
    where: { ...scopedEmployeeWhere(viewer, P.ATTENDANCE_VIEW), status: { notIn: ["EXITED", "PREBOARDING"] }, dateOfJoining: { lte: today.date } },
    select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, photoUrl: true, department: { select: { name: true } }, location: { select: { name: true } } },
    orderBy: { employeeNumber: "asc" },
  });
  const ids = employees.map((e) => e.id);
  const [logs, leave, requests, holiday, assignments, overrides, shifts] = await Promise.all([
    prisma.attendanceLog.findMany({
      where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: { not: "REJECTED" }, timestamp: { gte: today.start, lt: new Date(today.start.getTime() + DAY) } },
      orderBy: { timestamp: "asc" }, select: { employeeId: true, direction: true, timestamp: true, source: true },
    }),
    prisma.leaveRequestDay.findMany({
      where: { date: today.date, isSandwich: false, request: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED" } },
      select: { portion: true, request: { select: { employeeId: true, leaveType: { select: { name: true } } } } },
    }),
    prisma.attendanceRequest.findMany({
      where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: { in: ["APPROVED", "PENDING"] }, type: { in: ["WORK_FROM_HOME", "ON_DUTY", "REMOTE_CLOCK_IN"] }, fromDate: { lte: today.date }, toDate: { gte: today.date } },
      select: { employeeId: true, type: true, status: true },
    }),
    prisma.holiday.findFirst({ where: { date: today.date, isOptional: false, calendar: { tenantId: viewer.tenantId, isDefault: true } } }),
    prisma.employeeTimePolicy.findMany({
      where: { employeeId: { in: ids }, effectiveFrom: { lte: today.date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today.date } }] },
      select: { employeeId: true, shiftId: true, attendancePolicy: { select: { graceMinutes: true } } },
    }),
    prisma.shiftAssignment.findMany({ where: { employeeId: { in: ids }, date: today.date }, select: { employeeId: true, shiftId: true, weeklyOffCode: true } }),
    prisma.shift.findMany({ where: { tenantId: viewer.tenantId } }),
  ]);
  const shiftById = new Map(shifts.map((x) => [x.id, x]));
  const defShift = shifts.find((x) => x.code === "GEN") ?? shifts[0];
  const policyOf = new Map(assignments.map((a) => [a.employeeId, a]));
  const overrideOf = new Map(overrides.map((o) => [o.employeeId, o]));
  const dow = today.date.getUTCDay();

  type Row = { e: (typeof employees)[number]; keys: SnapshotKey[]; state: string; chip: string; first: Date | null; last: Date | null; lateBy: number };
  const rows: Row[] = employees.map((e) => {
    const mine = logs.filter((l) => l.employeeId === e.id);
    const first = mine.find((l) => l.direction === 0)?.timestamp ?? null;
    const lastLog = mine[mine.length - 1];
    const ov = overrideOf.get(e.id);
    const shift = shiftById.get(ov?.shiftId ?? policyOf.get(e.id)?.shiftId ?? "") ?? defShift;
    const grace = policyOf.get(e.id)?.attendancePolicy?.graceMinutes ?? 15;
    let lateBy = 0;
    if (first && shift && !shift.isFlexible) {
      const [h, m] = shift.startTime.split(":").map(Number);
      lateBy = Math.round((first.getTime() - (today.start.getTime() + (h * 60 + m) * 60_000)) / 60_000);
    }
    const keys: SnapshotKey[] = ["all"];
    const lv = leave.find((l) => l.request.employeeId === e.id);
    const req = requests.filter((r) => r.employeeId === e.id);
    const off = ov?.weeklyOffCode === "WO" || !!holiday || ((dow === 0 || dow === 6) && !ov);
    let state = "Not in yet", chip = "not-in-yet";
    if (lv) { keys.push("leave"); state = `${lv.request.leaveType.name}${lv.portion !== "FULL_DAY" ? " (half day)" : ""}`; chip = "leave"; }
    if (req.some((r) => r.type === "WORK_FROM_HOME" && r.status === "APPROVED")) { keys.push("wfh"); state = "Work from home"; chip = "wfh"; }
    if (req.some((r) => r.type === "ON_DUTY" && r.status === "APPROVED")) { keys.push("od"); state = "On duty"; chip = "on-duty"; }
    if (req.some((r) => r.type === "REMOTE_CLOCK_IN") || mine.some((l) => l.source === "REMOTE")) keys.push("remote");
    if (first) {
      keys.push(lateBy > grace ? "late" : "ontime");
      if (!lv) { state = lastLog.direction === 0 ? "In" : "Out"; chip = lastLog.direction === 0 ? "in" : "out"; }
    } else if (off && !lv) {
      keys.push("off"); state = holiday ? `Holiday · ${holiday.name}` : "Weekly off"; chip = holiday ? "hldy" : "woff";
    } else if (!lv && !keys.includes("wfh") && !keys.includes("od")) {
      keys.push("notin");
    }
    return { e, keys, state, chip, first, last: lastLog && lastLog.direction === 1 ? lastLog.timestamp : null, lateBy };
  });

  const count = (k: SnapshotKey) => rows.filter((r) => r.keys.includes(k)).length;
  const active = (SNAPSHOT.find((t) => t.key === view)?.key ?? "all") as SnapshotKey;
  const shown = rows.filter((r) => r.keys.includes(active));
  return (
    <>
      <h2 className="k-section-title" style={{ margin: "4px 0 12px" }}><span style={{ fontSize: 18, fontWeight: 500 }}>Today&apos;s Snapshot · {formatDate(today.date)}</span></h2>
      <div className={s.tiles}>
        {SNAPSHOT.map((t) => (
          <Link key={t.key} href={href(t.key)} scroll={false} className={`${s.tile}${t.key === active ? ` ${s.tileActive}` : ""}`}
            style={{ ["--tile" as string]: t.colour }} aria-current={t.key === active ? "true" : undefined}>
            <span className={s.tileLabel}>{t.label}</span>
            <span className={s.tileValue}>{count(t.key)}</span>
          </Link>
        ))}
      </div>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>{SNAPSHOT.find((t) => t.key === active)!.label}</h2><span className={s.cardMeta}>{shown.length} employee{shown.length === 1 ? "" : "s"}</span></div>
        {shown.length === 0 ? <div className={s.emptyBar}>Nobody in this group today.</div> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Status</th><th>First in</th><th>Last out</th><th>Arrival</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.e.id}>
                    <td><span className={s.person}><Avatar name={name(r.e)} photoUrl={r.e.photoUrl} size={30} /><span><span className={s.personName}>{name(r.e)}</span><span className={s.personMeta}>{r.e.employeeNumber}</span></span></span></td>
                    <td>{r.e.department?.name ?? "—"}</td>
                    <td>{r.e.location?.name ?? "—"}</td>
                    <td><Chip kind={r.chip}>{r.state}</Chip></td>
                    <td className={s.nowrap}>{clock(r.first)}</td>
                    <td className={s.nowrap}>{clock(r.last)}</td>
                    <td className={s.nowrap}>{r.first ? (r.keys.includes("late") ? <span className="neg">{Math.floor(r.lateBy / 60)}:{String(r.lateBy % 60).padStart(2, "0")} late</span> : "On time") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Attendance Analytics
// ---------------------------------------------------------------------------

function Leaderboard({ title, unit, rows }: { title: string; unit: string; rows: Array<{ id: string; label: string; meta?: string; value: number; photoUrl?: string | null }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2 className={s.cardTitle}>{title}</h2></div>
      {rows.length === 0 ? <div className={s.emptyBar}>No data for this period.</div> : (
        <ol className={s.boardList}>
          {rows.map((r) => (
            <li key={r.id}>
              {r.photoUrl !== undefined ? <Avatar name={r.label} photoUrl={r.photoUrl} size={28} /> : null}
              <span className="grow">
                <span className={s.personName}>{r.label}</span>
                {r.meta ? <span className={s.personMeta}>{r.meta}</span> : null}
                <span className={s.bar}><span style={{ width: `${(r.value / max) * 100}%` }} /></span>
              </span>
              <span className={s.boardVal}>{r1(r.value)} {unit}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export async function AttendanceAnalytics({ viewer, period, by, dept, loc, bu }: {
  viewer: Viewer; period: "week" | "month"; by: "employee" | "department" | "location"; dept?: string; loc?: string; bu?: string;
}) {
  const today = istToday();
  const to = new Date(today.date.getTime() - DAY);
  const from = new Date(to.getTime() - (period === "week" ? 6 : 29) * DAY);
  const employees = await prisma.employee.findMany({
    where: {
      ...scopedEmployeeWhere(viewer, P.ATTENDANCE_VIEW), status: { notIn: ["EXITED", "PREBOARDING"] },
      ...(dept ? { departmentId: dept } : {}), ...(loc ? { locationId: loc } : {}), ...(bu ? { businessUnitId: bu } : {}),
    },
    select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, photoUrl: true, department: { select: { name: true } }, location: { select: { name: true } } },
  });
  const records = await prisma.attendanceRecord.findMany({
    where: { tenantId: viewer.tenantId, employeeId: { in: employees.map((e) => e.id) }, date: { gte: from, lte: to } },
    select: { employeeId: true, status: true, effectiveHours: true, overtimeHours: true },
  });
  const per = new Map<string, { hours: number; days: number; ot: number; short: number }>();
  for (const r of records) {
    const v = per.get(r.employeeId) ?? { hours: 0, days: 0, ot: 0, short: 0 };
    const eff = n(r.effectiveHours);
    if (eff > 0) { v.hours += eff; v.days++; }
    v.ot += n(r.overtimeHours);
    if (["PRESENT", "HALF_DAY", "ABSENT"].includes(r.status) && eff > 0) v.short += Math.max(0, 8 - eff);
    per.set(r.employeeId, v);
  }
  const group = (e: (typeof employees)[number]) => by === "department" ? e.department?.name ?? "No department" : by === "location" ? e.location?.name ?? "No location" : e.id;
  const keys = [...new Set(employees.map(group))];
  const agg = (key: string, f: (v: { hours: number; days: number; ot: number; short: number }) => number, avg = false) => {
    const members = employees.filter((e) => group(e) === key);
    const vals = members.map((m) => per.get(m.id)).filter((v): v is NonNullable<typeof v> => !!v);
    const total = vals.reduce((sum, v) => sum + f(v), 0);
    return avg ? (vals.length ? total / vals.length : 0) : total;
  };
  const rowsFor = (f: (v: { hours: number; days: number; ot: number; short: number }) => number, avg = false) => keys.map((k) => {
    const e = employees.find((x) => x.id === k);
    return { id: k, label: e ? name(e) : k, meta: e ? `${e.employeeNumber} · ${e.department?.name ?? ""}` : undefined, photoUrl: e ? e.photoUrl : undefined, value: agg(k, f, avg) };
  }).filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  return (
    <>
      <p className="muted text-sm" style={{ margin: "0 0 14px" }}>{formatDate(from)} – {formatDate(to)} · {employees.length} employees</p>
      <div className={s.board}>
        <Leaderboard title="Most Hours Worked" unit="h/day" rows={rowsFor((v) => (v.days ? v.hours / v.days : 0), by !== "employee")} />
        <Leaderboard title="Overtime Hours" unit="h" rows={rowsFor((v) => v.ot)} />
        <Leaderboard title="Work Hours Shortage" unit="h" rows={rowsFor((v) => v.short)} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Leave Summary and Analytics
// ---------------------------------------------------------------------------

export async function LeaveSummary({ viewer }: { viewer: Viewer }) {
  const today = istToday();
  const weekEnd = new Date(today.date.getTime() + 6 * DAY);
  const soon = new Date(today.date.getTime() + 14 * DAY);
  const scope = await prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.LEAVE_VIEW), status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, firstName: true, lastName: true, photoUrl: true, employeeNumber: true } });
  const ids = scope.map((e) => e.id);
  const byId = new Map(scope.map((e) => [e.id, e]));
  const [todayDays, weekDays, pending, upcoming] = await Promise.all([
    prisma.leaveRequestDay.findMany({ where: { date: today.date, isSandwich: false, request: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED" } }, select: { portion: true, request: { select: { employeeId: true, leaveType: { select: { name: true } } } } } }),
    prisma.leaveRequestDay.findMany({ where: { date: { gte: today.date, lte: weekEnd }, isSandwich: false, request: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED" } }, select: { request: { select: { employeeId: true } } } }),
    prisma.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "PENDING" }, _count: { _all: true }, _sum: { totalDays: true } }),
    prisma.leaveRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { gt: today.date, lte: soon } }, include: { leaveType: { select: { name: true } } }, orderBy: { fromDate: "asc" }, take: 12 }),
  ]);
  const types = await prisma.leaveType.findMany({ where: { tenantId: viewer.tenantId, id: { in: pending.map((p) => p.leaveTypeId) } }, select: { id: true, name: true } });
  const weekPeople = [...new Set(weekDays.map((d) => d.request.employeeId))];
  const person = (id: string) => byId.get(id);
  return (
    <div className={s.board}>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>On leave today</h2><span className={s.cardMeta}>{todayDays.length}</span></div>
        {todayDays.length === 0 ? <div className={s.emptyBar}>Everyone is working today!</div> : (
          <ul className={s.boardList}>{todayDays.map((d) => { const p = person(d.request.employeeId)!; return (
            <li key={d.request.employeeId}><Avatar name={name(p)} photoUrl={p.photoUrl} size={28} /><span className="grow"><span className={s.personName}>{name(p)}</span><span className={s.personMeta}>{d.request.leaveType.name}{d.portion !== "FULL_DAY" ? " · half day" : ""}</span></span></li>
          ); })}</ul>
        )}
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>On leave this week</h2><span className={s.cardMeta}>{weekPeople.length}</span></div>
        {weekPeople.length === 0 ? <div className={s.emptyBar}>No approved leave this week.</div> : (
          <ul className={s.boardList}>{weekPeople.map((id) => { const p = person(id)!; return (
            <li key={id}><Avatar name={name(p)} photoUrl={p.photoUrl} size={28} /><span className="grow"><span className={s.personName}>{name(p)}</span><span className={s.personMeta}>{p.employeeNumber}</span></span><span className={s.boardVal}>{weekDays.filter((d) => d.request.employeeId === id).length} d</span></li>
          ); })}</ul>
        )}
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Pending leave requests</h2><Link className="link text-sm" href="/time/approvals?cat=leave">View all</Link></div>
        {pending.length === 0 ? <div className={s.emptyBar}>No leave awaiting a decision.</div> : (
          <ul className={s.boardList}>{pending.map((p) => (
            <li key={p.leaveTypeId}><span className="grow">{types.find((t) => t.id === p.leaveTypeId)?.name ?? "Leave"}</span><span className={s.boardVal}>{p._count._all} request{p._count._all === 1 ? "" : "s"} · {n(p._sum.totalDays)} d</span></li>
          ))}</ul>
        )}
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Upcoming leave · next 14 days</h2></div>
        {upcoming.length === 0 ? <div className={s.emptyBar}>No approved leave coming up.</div> : (
          <ul className={s.boardList}>{upcoming.map((r) => { const p = person(r.employeeId); return p ? (
            <li key={r.id}><Avatar name={name(p)} photoUrl={p.photoUrl} size={28} /><span className="grow"><span className={s.personName}>{name(p)}</span><span className={s.personMeta}>{r.leaveType.name} · {formatDate(r.fromDate)}{r.toDate.getTime() !== r.fromDate.getTime() ? ` – ${formatDate(r.toDate)}` : ""}</span></span><span className={s.boardVal}>{n(r.totalDays)} d</span></li>
          ) : null; })}</ul>
        )}
      </section>
    </div>
  );
}

const PALETTE = ["#7e57c2", "#4fc3d9", "#8bc34a", "#f5b83d", "#ef6f6f", "#c9b48a", "#5c6bc0", "#26a69a"];

export async function LeaveAnalytics({ viewer }: { viewer: Viewer }) {
  const today = istToday();
  const ys = leaveYearStart(today.date, "FINANCIAL_APR");
  const scope = await prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.LEAVE_VIEW) }, select: { id: true, department: { select: { name: true } } } });
  const ids = scope.map((e) => e.id);
  const deptOf = new Map(scope.map((e) => [e.id, e.department?.name ?? "No department"]));
  const days = await prisma.leaveRequestDay.findMany({
    where: { date: { gte: ys, lte: today.date }, isSandwich: false, request: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED" } },
    select: { date: true, dayValue: true, request: { select: { id: true, employeeId: true, createdAt: true, fromDate: true, leaveType: { select: { name: true, color: true } } } } },
  });
  const byType = new Map<string, { v: number; colour: string | null }>();
  const byDept = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const requests = new Map<string, { createdAt: Date; fromDate: Date }>();
  for (const d of days) {
    const v = n(d.dayValue);
    const t = byType.get(d.request.leaveType.name) ?? { v: 0, colour: d.request.leaveType.color };
    t.v += v; byType.set(d.request.leaveType.name, t);
    const dept = deptOf.get(d.request.employeeId) ?? "—";
    byDept.set(dept, (byDept.get(dept) ?? 0) + v);
    const m = d.date.toISOString().slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + v);
    requests.set(d.request.id, { createdAt: d.request.createdAt, fromDate: d.request.fromDate });
  }
  const total = [...byType.values()].reduce((sum, t) => sum + t.v, 0);
  // Unplanned: applied on the day the leave began, or after it.
  const unplanned = [...requests.values()].filter((r) => r.createdAt.getTime() >= r.fromDate.getTime() - IST).length;
  const parts = [...byType.entries()].map(([label, t], i) => ({ label, value: r1(t.v), colour: t.colour ?? PALETTE[i % PALETTE.length] }));
  const months: Array<{ label: string; value: number }> = [];
  for (let d = new Date(ys); d.getTime() <= today.date.getTime(); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const k = d.toISOString().slice(0, 7);
    months.push({ label: d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }), value: r1(byMonth.get(k) ?? 0) });
  }
  return (
    <div className={s.board}>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Leave consumed by type</h2><span className={s.cardMeta}>{r1(total)} days this leave year</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "0 20px 20px" }}>
          <Donut parts={parts} size={140}><b>{r1(total)}</b><span>days</span></Donut>
          <ul className={s.boardList} style={{ padding: 0, flex: 1 }}>
            {parts.map((p) => <li key={p.label}><span style={{ width: 10, height: 10, borderRadius: 2, background: p.colour }} /><span className="grow">{p.label}</span><span className={s.boardVal}>{p.value}</span></li>)}
          </ul>
        </div>
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Leave by department</h2></div>
        <div style={{ padding: "0 20px 20px" }}><Bars data={[...byDept.entries()].map(([label, value]) => ({ label: label.split(" ")[0], value: r1(value), title: `${label}: ${r1(value)} days` }))} height={120} rotateLabels /></div>
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Monthly trend</h2></div>
        <div style={{ padding: "0 20px 20px" }}><Bars data={months} height={120} /></div>
      </section>
      <section className={s.card}>
        <div className={s.cardHead}><h2 className={s.cardTitle}>Unplanned leave</h2></div>
        <div style={{ padding: "0 20px 20px" }}>
          <div className={s.tileValue}>{requests.size ? Math.round((unplanned / requests.size) * 100) : 0}%</div>
          <p className="muted text-sm">{unplanned} of {requests.size} approved requests were applied on or after the first day of leave.</p>
        </div>
      </section>
    </div>
  );
}
