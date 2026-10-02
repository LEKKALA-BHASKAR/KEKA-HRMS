import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINRCompact } from "@keka/shared";
import {
  monthlySeries, annualAttrition, tenureBand, ageBand, tally, averageTenure, activeOn, pctChange,
  enps, participation, TENURE_BANDS, AGE_BANDS, type WorkforceRow,
} from "@keka/services";
import { requireAuth, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Stat, Progress, Badge } from "@/components/ui";
import { Panel, Bars, Donut, SectionTitle, EmptyState } from "@/components/keka";
import { DashboardTabs } from "../_components/dashboard";

const P = PERMISSIONS;
const PALETTE = ["#3b6fe0", "#36b8c9", "#9b7ede", "#f5b83d", "#ef6f6f", "#8bc34a", "#c9b48a", "#5f6b7a"];
const GENDER_COLOUR: Record<string, string> = { Female: "#9b7ede", Male: "#3b6fe0", Other: "#36b8c9", Undisclosed: "#c9ced6" };
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Horizontal bars with labels and counts, for distributions. */
function HBars({ rows, total, colour = "var(--brand-500)" }: { rows: Array<{ label: string; value: number }>; total: number; colour?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="stack gap-2">
      {rows.map((r) => (
        <div key={r.label} className="row gap-3">
          <div className="text-sm" style={{ width: 140, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.label}>{r.label}</div>
          <div style={{ flex: 1, background: "var(--surface-sunken)", borderRadius: 4, height: 10 }}>
            <div style={{ width: `${(r.value / max) * 100}%`, background: colour, height: 10, borderRadius: 4, minWidth: r.value ? 3 : 0 }} />
          </div>
          <div className="num text-sm" style={{ width: 70, textAlign: "right" }}>{r.value} <span className="subtle text-xs">{total ? `${Math.round((r.value / total) * 100)}%` : ""}</span></div>
        </div>
      ))}
    </div>
  );
}

function Legend({ parts }: { parts: Array<{ label: string; value: number; colour: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="stack gap-1">
      {parts.map((p) => (
        <div key={p.label} className="row gap-2 text-sm">
          <span style={{ width: 10, height: 10, borderRadius: 2, background: p.colour, display: "inline-block" }} />
          <span style={{ minWidth: 110 }}>{p.label}</span>
          <span className="num strong">{p.value}</span>
          <span className="num subtle text-xs">{total ? `${Math.round((p.value / total) * 100)}%` : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ dept?: string }> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  const sp = await searchParams;
  const seePay = canAny(viewer, [P.PAY_REGISTER_VIEW, P.PAYROLL_VIEW]);
  const scope = scopedEmployeeWhere(viewer, P.ANALYTICS_VIEW);
  const asOf = new Date();
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));

  const departments = await prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const dept = departments.find((d) => d.id === sp.dept) ?? null;
  const where = { ...scope, ...(dept ? { departmentId: dept.id } : {}) };

  const employees = await prisma.employee.findMany({
    where,
    select: {
      id: true, dateOfJoining: true, lastWorkingDay: true, status: true, gender: true, dateOfBirth: true,
      department: { select: { name: true } }, location: { select: { name: true } },
      workerType: { select: { name: true } }, exitRecord: { select: { type: true, status: true } },
    },
  });
  const ids = employees.map((e) => e.id);
  const rows: WorkforceRow[] = employees.map((e) => ({
    id: e.id, dateOfJoining: e.dateOfJoining, dateOfBirth: e.dateOfBirth,
    exited: e.status === "EXITED" || e.status === "NOTICE_PERIOD",
    // Someone on notice counts as a leaver on their last day, once it passes.
    lastWorkingDay: e.lastWorkingDay,
  }));
  const active = employees.filter((e, i) => activeOn(rows[i], today) && e.status !== "EXITED");
  const series = monthlySeries(rows, today, 12);
  const prevYearHeadcount = series[0]?.headcount ?? 0;
  const onNotice = employees.filter((e) => e.status === "NOTICE_PERIOD").length;
  const leavers12 = series.reduce((s, p) => s + p.leavers, 0);
  const joiners12 = series.reduce((s, p) => s + p.joiners, 0);

  const genderParts = tally(active, (e) => titleCase(e.gender ?? "UNDISCLOSED"))
    .map((g) => ({ ...g, colour: GENDER_COLOUR[g.label] ?? "#c9ced6" }));
  const byDept = tally(active, (e) => e.department?.name ?? "No department");
  const byLocation = tally(active, (e) => e.location?.name ?? "No location");
  const byTenure = tally(active, (e) => tenureBand(e.dateOfJoining, today), TENURE_BANDS);
  const byAge = tally(active, (e) => ageBand(e.dateOfBirth, today), AGE_BANDS).filter((b) => b.label !== "Not recorded" || b.value > 0);
  const byStatus = tally(active, (e) => titleCase(e.status)).map((s, i) => ({ ...s, colour: PALETTE[i % PALETTE.length] }));
  const byWorker = tally(active, (e) => e.workerType?.name ?? "Unassigned");

  // Gender mix per department, the diversity view.
  const deptNames = [...new Set(active.map((e) => e.department?.name ?? "No department"))].sort();
  const mix = deptNames.map((d) => {
    const people = active.filter((e) => (e.department?.name ?? "No department") === d);
    const f = people.filter((e) => e.gender === "FEMALE").length;
    return { dept: d, total: people.length, female: f, femalePct: people.length ? Math.round((f / people.length) * 100) : 0 };
  });

  // Time: the last 30 days of processed attendance, and leave taken this FY.
  const since = new Date(today.getTime() - 30 * 86_400_000);
  const fyStart = new Date(Date.UTC(today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1, 3, 1));
  const [attendance, lateCount, leaveByType, leaveByMonth] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ["status"], where: { tenantId: viewer.tenantId, employeeId: { in: ids }, date: { gte: since, lt: today } }, _count: true, _avg: { effectiveHours: true },
    }),
    prisma.attendanceRecord.count({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, date: { gte: since, lt: today }, penaltyReason: { contains: "late", mode: "insensitive" } } }),
    prisma.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { gte: fyStart } }, _sum: { totalDays: true } }),
    prisma.leaveRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { gte: fyStart } }, select: { fromDate: true, totalDays: true } }),
  ]);
  const leaveTypes = await prisma.leaveType.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } });
  const ltName = new Map(leaveTypes.map((t) => [t.id, t.name]));
  const workdays = attendance.filter((a) => !["WEEKLY_OFF", "HOLIDAY"].includes(a.status));
  const workdayCount = workdays.reduce((s, a) => s + a._count, 0);
  const presentish = workdays.filter((a) => ["PRESENT", "WORK_FROM_HOME", "ON_DUTY", "HALF_DAY"].includes(a.status)).reduce((s, a) => s + a._count, 0);
  const present = attendance.find((a) => a.status === "PRESENT");
  const leaveMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth() + i, 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleString("en", { month: "short", timeZone: "UTC" }) };
  }).filter((m) => m.key <= today.toISOString().slice(0, 7));
  const leaveTrend = leaveMonths.map((m) => ({
    label: m.label,
    value: Math.round(leaveByMonth.filter((l) => l.fromDate.toISOString().slice(0, 7) === m.key).reduce((s, l) => s + Number(l.totalDays), 0) * 10) / 10,
  }));

  // Payroll cost from finalised runs, summed over the people in scope.
  const runs = seePay
    ? await prisma.payrollRun.findMany({
        where: { tenantId: viewer.tenantId, status: "FINALIZED", type: "REGULAR" },
        orderBy: [{ year: "desc" }, { month: "desc" }], take: 6, select: { id: true, year: true, month: true },
      })
    : [];
  const runRows = runs.length
    ? await prisma.payrollRunEmployee.findMany({
        where: { runId: { in: runs.map((r) => r.id) }, employeeId: { in: ids } },
        select: { runId: true, grossEarnings: true, employerCost: true, netPay: true, employee: { select: { department: { select: { name: true } } } } },
      })
    : [];
  const costSeries = [...runs].reverse().map((r) => {
    const rr = runRows.filter((x) => x.runId === r.id);
    const gross = rr.reduce((s, x) => s + Number(x.grossEarnings), 0);
    const employer = rr.reduce((s, x) => s + Number(x.employerCost), 0);
    return {
      label: new Date(Date.UTC(r.year, r.month - 1, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" }),
      gross, employer, cost: gross + employer, net: rr.reduce((s, x) => s + Number(x.netPay), 0), heads: rr.length,
    };
  });
  const latest = costSeries.at(-1);
  const latestRunId = runs[0]?.id;
  const costByDept = latestRunId
    ? tally(runRows.filter((x) => x.runId === latestRunId), (x) => x.employee.department?.name ?? "No department").map((d) => ({
        label: d.label,
        value: Math.round(runRows.filter((x) => x.runId === latestRunId && (x.employee.department?.name ?? "No department") === d.label)
          .reduce((s, x) => s + Number(x.grossEarnings) + Number(x.employerCost), 0)),
      })).sort((a, b) => b.value - a.value)
    : [];

  // Engagement and learning at a glance.
  const lastSurvey = await prisma.survey.findFirst({
    where: { tenantId: viewer.tenantId, status: { in: ["ACTIVE", "CLOSED"] }, kind: { not: "POLL" }, questions: { some: { type: "NPS" } } },
    orderBy: { launchedAt: "desc" },
    include: { _count: { select: { participants: true } }, questions: { where: { type: "NPS" }, select: { id: true } }, responses: { select: { answers: { select: { questionId: true, score: true } } } } },
  });
  const surveyNps = lastSurvey && lastSurvey.responses.length >= lastSurvey.minGroupSize
    ? enps(lastSurvey.responses.flatMap((r) => r.answers.filter((a) => a.questionId === lastSurvey.questions[0]?.id && a.score !== null).map((a) => a.score!)))
    : null;
  const learning = await prisma.courseEnrolment.groupBy({ by: ["status"], where: { tenantId: viewer.tenantId, employeeId: { in: ids }, course: { status: "PUBLISHED" } }, _count: true });
  const learnTotal = learning.reduce((s, l) => s + l._count, 0);
  const learnDone = learning.find((l) => l.status === "COMPLETED")?._count ?? 0;

  const change = pctChange(prevYearHeadcount, active.length);

  return (
    <>
      <DashboardTabs viewer={viewer} active="summary" />
      <PageHead
        title="Workforce Insights"
        subtitle={`${dept ? dept.name : "Everyone in your scope"} · as of ${today.toISOString().slice(0, 10)}`}
        actions={
          <form className="row gap-2">
            <select name="dept" className="select" defaultValue={dept?.id ?? ""} aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn">Apply</button>
            {dept ? <Link className="btn ghost" href="/analytics/summary">Clear</Link> : null}
          </form>
        }
      />

      {employees.length === 0 ? <EmptyState title="No employees in this view" /> : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <Stat label="Headcount" value={active.length} meta={change === null ? "No figure a year ago" : `${change >= 0 ? "+" : ""}${change}% on 12 months ago (${prevYearHeadcount})`} />
            <Stat label="Joiners · 12 months" value={joiners12} meta={`${series.at(-1)?.joiners ?? 0} this month`} />
            <Stat label="Attrition · 12 months" value={`${annualAttrition(series)}%`} meta={`${leavers12} leaver${leavers12 === 1 ? "" : "s"} · ${onNotice} on notice`} tone={annualAttrition(series) > 15 ? "neg" : undefined} />
            <Stat label="Average tenure" value={`${averageTenure(rows, today)} yrs`} meta={`${byTenure.find((b) => b.label === "< 6 months")?.value ?? 0} joined in the last 6 months`} />
          </div>
          <div className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="Attendance · 30 days" value={workdayCount ? `${Math.round((presentish / workdayCount) * 100)}%` : "—"} meta={present?._avg.effectiveHours ? `${Number(present._avg.effectiveHours).toFixed(1)} h average on a present day` : "Working days marked present"} />
            <Stat label="Late marks · 30 days" value={lateCount} meta="Penalised late arrivals" />
            <Stat label="eNPS" value={surveyNps ? (surveyNps.score > 0 ? `+${surveyNps.score}` : surveyNps.score) : "—"}
              meta={lastSurvey ? <Link href={`/engage/surveys/${lastSurvey.id}`}>{lastSurvey.title} · {participation(lastSurvey._count.participants, Math.max(lastSurvey._count.participants, active.length))}% took part</Link> : "No eNPS survey yet"} />
            <Stat label="Learning completion" value={learnTotal ? `${Math.round((learnDone / learnTotal) * 100)}%` : "—"} meta={`${learnDone} of ${learnTotal} enrolments`} />
          </div>

          <SectionTitle sub="Month-end headcount and movement over the last twelve months">Headcount</SectionTitle>
          <div className="grid grid-2" style={{ marginBottom: 18 }}>
            <Panel title="Headcount trend">
              <Bars data={series.map((p) => ({ label: p.label, value: p.headcount, title: `${p.label}: ${p.headcount}` }))} height={120} rotateLabels />
            </Panel>
            <Panel title="Joiners and leavers" subtitle="Blue: joiners · red: leavers">
              <div className="row gap-2" style={{ alignItems: "stretch" }}>
                <div style={{ flex: 1 }}><Bars data={series.map((p) => ({ label: p.label, value: p.joiners, title: `${p.label}: ${p.joiners} joined` }))} height={50} /></div>
              </div>
              <div style={{ marginTop: 8 }}><Bars data={series.map((p) => ({ label: p.label, value: p.leavers, title: `${p.label}: ${p.leavers} left` }))} height={50} colour="#ef6f6f" rotateLabels /></div>
            </Panel>
          </div>

          <SectionTitle sub="Who is in the organisation today">Composition</SectionTitle>
          <div className="grid grid-3" style={{ marginBottom: 18 }}>
            <Panel title="Gender">
              <div className="row gap-4" style={{ alignItems: "center" }}>
                <Donut parts={genderParts} size={120}><div className="strong">{active.length}</div><div className="text-xs subtle">people</div></Donut>
                <Legend parts={genderParts} />
              </div>
            </Panel>
            <Panel title="Employment status">
              <div className="row gap-4" style={{ alignItems: "center" }}>
                <Donut parts={byStatus} size={120} />
                <Legend parts={byStatus} />
              </div>
            </Panel>
            <Panel title="Worker type"><HBars rows={byWorker} total={active.length} colour="#36b8c9" /></Panel>
            <Panel title="By department"><HBars rows={byDept} total={active.length} /></Panel>
            <Panel title="By location"><HBars rows={byLocation} total={active.length} colour="#9b7ede" /></Panel>
            <Panel title="Tenure"><HBars rows={byTenure} total={active.length} colour="#8bc34a" /></Panel>
            <Panel title="Age"><HBars rows={byAge} total={active.length} colour="#f5b83d" /></Panel>
            <Panel title="Gender mix by department" pad={false}>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Department</th><th className="num">People</th><th style={{ minWidth: 110 }}>Women</th></tr></thead>
                  <tbody>
                    {mix.map((m) => (
                      <tr key={m.dept}>
                        <td className="text-sm">{m.dept}</td>
                        <td className="num">{m.total}</td>
                        <td><div className="row gap-2"><div style={{ flex: 1 }}><Progress value={m.femalePct} max={100} /></div><span className="num text-xs">{m.femalePct}%</span></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <SectionTitle sub="Leave taken this financial year">Time off</SectionTitle>
          <div className="grid grid-2" style={{ marginBottom: 18 }}>
            <Panel title="Days of leave taken by month"><Bars data={leaveTrend} height={110} /></Panel>
            <Panel title="By leave type">
              {leaveByType.length === 0 ? <div className="text-sm subtle">No approved leave yet this year.</div> : (
                <HBars rows={leaveByType.map((l) => ({ label: ltName.get(l.leaveTypeId) ?? "—", value: Math.round(Number(l._sum.totalDays ?? 0) * 10) / 10 })).sort((a, b) => b.value - a.value)}
                  total={leaveByType.reduce((s, l) => s + Number(l._sum.totalDays ?? 0), 0)} colour="#9b7ede" />
              )}
            </Panel>
          </div>

          {seePay ? (
            <>
              <SectionTitle sub="From finalised payroll runs, for the people in this view">Payroll cost</SectionTitle>
              {costSeries.length === 0 ? <EmptyState title="No finalised payroll yet" /> : (
                <>
                  <div className="grid grid-4" style={{ marginBottom: 12 }}>
                    <Stat label={`Cost to company · ${latest!.label}`} value={formatINRCompact(latest!.cost)} meta="Gross pay plus employer contributions" />
                    <Stat label="Gross pay" value={formatINRCompact(latest!.gross)} meta={`${latest!.heads} people paid`} />
                    <Stat label="Net pay" value={formatINRCompact(latest!.net)} meta="Paid into bank accounts" />
                    <Stat label="Average cost per head" value={formatINRCompact(latest!.heads ? latest!.cost / latest!.heads : 0)} meta="Per month" />
                  </div>
                  <div className="grid grid-2" style={{ marginBottom: 18 }}>
                    <Panel title="Monthly cost to company">
                      <Bars data={costSeries.map((c) => ({ label: c.label, value: Math.round(c.cost), title: `${c.label}: ${formatINRCompact(c.cost)}` }))} height={120} />
                    </Panel>
                    <Panel title={`Cost by department · ${latest!.label}`}>
                      <div className="stack gap-2">
                        {costByDept.map((d) => (
                          <div key={d.label} className="row gap-3">
                            <div className="text-sm" style={{ width: 140 }}>{d.label}</div>
                            <div style={{ flex: 1 }}><Progress value={d.value} max={Math.max(1, costByDept[0]?.value ?? 1)} /></div>
                            <div className="num text-sm" style={{ width: 80, textAlign: "right" }}>{formatINRCompact(d.value)}</div>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="text-xs subtle" style={{ marginBottom: 18 }}><Badge>Payroll cost hidden</Badge> Needs payroll or pay register access.</div>
          )}
        </>
      )}
    </>
  );
}
