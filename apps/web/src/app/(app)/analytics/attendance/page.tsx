import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { attendanceTrend, attendanceByPerson, bradfordFactor, isAbsence, type DayRecord } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Stat } from "@/components/ui";
import { Panel, Bars, EmptyState } from "@/components/keka";
import { HBars } from "@/components/charts";
import { DashboardTabs } from "../_components/dashboard";

export const metadata = { title: "Attendance dashboard — Analytics" };
const P = PERMISSIONS;
const DAY = 86_400_000;
const OFF = ["WEEKLY_OFF", "HOLIDAY"];
const PRESENTISH = ["PRESENT", "WORK_FROM_HOME", "ON_DUTY", "HALF_DAY"];
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Org › Dashboard › Attendance: weekly trends, absenteeism, late marks and leaderboards. */
export default async function AttendanceDashboard({ searchParams }: { searchParams: Promise<{ weeks?: string; dept?: string }> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  await requireAuth(P.ATTENDANCE_VIEW);
  const sp = await searchParams;
  const weeks = [4, 8, 12].includes(Number(sp.weeks)) ? Number(sp.weeks) : 8;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(today.getTime() - weeks * 7 * DAY);
  const departments = await prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const dept = departments.find((d) => d.id === sp.dept) ?? null;
  const people = await prisma.employee.findMany({
    where: { ...scopedEmployeeWhere(viewer, P.ATTENDANCE_VIEW), status: { notIn: ["EXITED", "PREBOARDING"] }, ...(dept ? { departmentId: dept.id } : {}) },
    select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, department: { select: { name: true } } },
  });
  const who = new Map(people.map((p) => [p.id, p]));
  const raw = await prisma.attendanceRecord.findMany({
    where: { tenantId: viewer.tenantId, employeeId: { in: people.map((p) => p.id) }, date: { gte: since, lt: today } },
    select: { employeeId: true, date: true, status: true, effectiveHours: true, penaltyReason: true, lopValue: true },
  });
  const records: DayRecord[] = raw.map((r) => ({
    employeeId: r.employeeId, date: r.date, status: r.status, effectiveHours: Number(r.effectiveHours), lop: Number(r.lopValue),
    late: !!r.penaltyReason && /late/i.test(r.penaltyReason),
  }));
  const trend = attendanceTrend(records);
  const perPerson = attendanceByPerson(records);
  const work = records.filter((r) => !OFF.includes(r.status));
  const worked = work.filter((r) => PRESENTISH.includes(r.status));
  const rate = work.length ? Math.round((worked.length / work.length) * 100) : 0;
  const late = records.filter((r) => r.late).length;
  const avgHours = worked.length ? Math.round((worked.reduce((s, r) => s + r.effectiveHours, 0) / worked.length) * 10) / 10 : 0;
  const lop = Math.round(records.reduce((s, r) => s + r.lop, 0) * 10) / 10;
  const statusMix = Object.entries(work.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})).map(([k, v]) => ({ label: titleCase(k), value: v })).sort((a, b) => b.value - a.value);
  const name = (id: string) => { const p = who.get(id); return p ? `${p.displayName ?? `${p.firstName} ${p.lastName}`} (${p.employeeNumber})` : id; };
  const byDept = [...new Set(people.map((p) => p.department?.name ?? "No department"))].map((d) => {
    const ids = new Set(people.filter((p) => (p.department?.name ?? "No department") === d).map((p) => p.id));
    const w = work.filter((r) => ids.has(r.employeeId));
    return { label: d, value: w.length ? Math.round((w.filter((r) => PRESENTISH.includes(r.status)).length / w.length) * 100) : 0 };
  }).sort((a, b) => a.value - b.value);
  const bradford = perPerson.map((p) => ({ id: p.employeeId, score: bradfordFactor(records.filter((r) => r.employeeId === p.employeeId && isAbsence(r.status)).map((r) => r.date)), absent: p.absent }))
    .filter((b) => b.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  const punctual = perPerson.filter((p) => p.workdays >= 5 && p.late === 0 && p.absent === 0).sort((a, b) => b.rate - a.rate || b.hours - a.hours).slice(0, 8);
  const mostLate = perPerson.filter((p) => p.late > 0).sort((a, b) => b.late - a.late).slice(0, 8);

  return (
    <>
      <DashboardTabs viewer={viewer} active="attendance" />
      <div className="page-head">
        <div className="page-title-group"><h1>Attendance dashboard</h1><div className="page-subtitle">{dept ? dept.name : "Everyone in your scope"}, last {weeks} weeks to yesterday</div></div>
        <form className="row gap-2 no-print">
          <select name="dept" className="select" defaultValue={dept?.id ?? ""} aria-label="Department"><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="weeks" className="select" defaultValue={String(weeks)} aria-label="Window">{[4, 8, 12].map((w) => <option key={w} value={w}>Last {w} weeks</option>)}</select>
          <button className="btn">Apply</button>
        </form>
      </div>
      {records.length === 0 ? <EmptyState title="No processed attendance in this window" /> : (
        <div className="stack gap-3">
          <div className="grid grid-4">
            <Stat label="Attendance rate" value={`${rate}%`} meta={`${worked.length} of ${work.length} working days`} tone={rate < 85 ? "neg" : undefined} />
            <Stat label="Late marks" value={late} meta={`${mostLate.length ? `${perPerson.filter((p) => p.late > 0).length} people` : "Nobody"} late at least once`} />
            <Stat label="Average hours" value={`${avgHours} h`} meta="Effective hours on days worked" />
            <Stat label="Loss of pay" value={`${lop} days`} meta={`${work.filter((r) => isAbsence(r.status)).length} absent days`} tone={lop > 0 ? "neg" : undefined} />
          </div>
          <div className="grid grid-2">
            <Panel title="Attendance rate by week"><Bars data={trend.map((t) => ({ label: t.week.slice(5), value: t.rate, title: `Week of ${t.week}: ${t.rate}%` }))} height={120} colour="#7cc47f" /></Panel>
            <Panel title="Late marks by week"><Bars data={trend.map((t) => ({ label: t.week.slice(5), value: t.late, title: `Week of ${t.week}: ${t.late}` }))} height={120} colour="#ef8f7d" /></Panel>
            <Panel title="Working days by status"><HBars rows={statusMix} color="#5b9bd5" /></Panel>
            <Panel title="Attendance rate by department" subtitle="Lowest first"><HBars rows={byDept} color="#9b87c4" max={100} format={(n) => `${n}%`} /></Panel>
          </div>
          <div className="grid grid-3">
            <Panel title="Perfect attendance" subtitle="No absences or late marks, at least 5 working days" pad={false}>
              {punctual.length ? <table className="data"><tbody>{punctual.map((p, i) => <tr key={p.employeeId}><td className="subtle">{i + 1}</td><td><Link href={`/employees/${p.employeeId}`}>{name(p.employeeId)}</Link></td><td className="num">{p.hours} h</td></tr>)}</tbody></table> : <EmptyState title="Nobody yet" />}
            </Panel>
            <Panel title="Most late marks" pad={false}>
              {mostLate.length ? <table className="data"><tbody>{mostLate.map((p) => <tr key={p.employeeId}><td><Link href={`/employees/${p.employeeId}`}>{name(p.employeeId)}</Link></td><td className="num">{p.late}</td></tr>)}</tbody></table> : <EmptyState title="No late marks" />}
            </Panel>
            <Panel title="Absence pattern (Bradford factor)" subtitle="Frequent short absences score higher than one long one" pad={false}>
              {bradford.length ? <table className="data"><tbody>{bradford.map((b) => <tr key={b.id}><td><Link href={`/employees/${b.id}`}>{name(b.id)}</Link></td><td className="num subtle">{b.absent} days</td><td className="num strong">{b.score}</td></tr>)}</tbody></table> : <EmptyState title="No absences" />}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
