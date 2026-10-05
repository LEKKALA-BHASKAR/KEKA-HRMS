import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  loadPopulation, onBooks, trailingWindow, leaversIn, averageHeadcount, currentCtcs, quantilesOf, histogramOf, payEquity, promotionVelocity,
  cohortSurvival, engagementDriverScores, managerEffectiveness, seriesAnomalies, timeToFillDays, medianOf, inCohort, cohortFiltersOf,
  computeInsightMetric, MONTH_ABBR, type PopEmployee,
} from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import type { InsightTable } from "./export";

/**
 * People analytics: each analysis returns an InsightTable (shown on screen
 * and downloadable) computed over the people the viewer's analytics scope
 * covers. Pay figures need the pay register permission; groups under three
 * people are folded so no one is identifiable from an aggregate.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export const PEOPLE_TABS = {
  cohorts: "Attrition cohorts",
  overtime: "Overtime cost",
  compensation: "Compensation distribution",
  "pay-equity": "Pay equity",
  promotion: "Promotion velocity",
  mobility: "Internal mobility",
  learning: "Learning effectiveness",
  engagement: "Engagement drivers",
  managers: "Manager effectiveness",
  "time-to-fill": "Time to fill",
  "cost-per-hire": "Cost per hire",
  productivity: "Productivity",
  diversity: "Diversity",
  anomalies: "Anomalies",
} as const;
export type PeopleTab = keyof typeof PEOPLE_TABS;
export const isPeopleTab = (t: unknown): t is PeopleTab => typeof t === "string" && t in PEOPLE_TABS;
const PAY_TABS: PeopleTab[] = ["overtime", "compensation", "pay-equity", "cost-per-hire"];

export function peopleTabAllowed(viewer: Viewer, tab: PeopleTab): boolean {
  if (!can(viewer, P.ANALYTICS_VIEW)) return false;
  return !PAY_TABS.includes(tab) || can(viewer, P.PAY_REGISTER_VIEW);
}

export async function scopedPopulation(viewer: Viewer): Promise<PopEmployee[]> {
  return loadPopulation(scopedEmployeeWhere(viewer, P.ANALYTICS_VIEW) as never);
}

function fold<T extends { label: string; n: number }>(rows: T[], min = 3): T[] {
  return rows.filter((r) => r.n >= min);
}

export async function peopleAnalysis(viewer: Viewer, tab: PeopleTab, now = new Date()): Promise<InsightTable> {
  const pop = await scopedPopulation(viewer);
  const ids = pop.map((e) => e.id);
  const active = pop.filter((e) => onBooks(e, now));
  const year = trailingWindow(now, 12);
  switch (tab) {
    case "cohorts": {
      const rows = cohortSurvival(pop.map((e) => ({ joinedOn: e.dateOfJoining, leftOn: e.leftOn })), now);
      return {
        title: "Attrition by joining cohort",
        columns: [{ key: "cohort", label: "Joined in" }, { key: "joined", label: "Joined", format: "int" }, { key: "m3", label: "Still here at 3 months", format: "pct" }, { key: "m6", label: "At 6 months", format: "pct" }, { key: "m12", label: "At 12 months", format: "pct" }, { key: "m24", label: "At 24 months", format: "pct" }],
        rows: rows.map((c) => ({ cohort: c.cohort, joined: c.joined, m3: c.retained[0]?.percent, m6: c.retained[1]?.percent, m12: c.retained[2]?.percent, m24: c.retained[3]?.percent })),
        notes: ["Each cohort is everyone who joined in that quarter; the share still on the books N months after joining, once N months have passed."],
      };
    }
    case "overtime": {
      const rows = await prisma.overtimeEntry.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, payAction: { not: "VOID" } }, select: { employeeId: true, year: true, month: true, hours: true, amount: true } });
      const dept = new Map(pop.map((e) => [e.id, e.department]));
      const by = new Map<string, { label: string; month: string; n: Set<string>; hours: number; amount: number }>();
      for (const r of rows) {
        const month = `${r.year}-${String(r.month).padStart(2, "0")}`;
        const k = `${month}|${dept.get(r.employeeId) ?? "Unassigned"}`;
        const g = by.get(k) ?? { label: dept.get(r.employeeId) ?? "Unassigned", month, n: new Set<string>(), hours: 0, amount: 0 };
        g.n.add(r.employeeId); g.hours += Number(r.hours); g.amount += Number(r.amount);
        by.set(k, g);
      }
      return {
        title: "Overtime cost by month and department",
        columns: [{ key: "month", label: "Month" }, { key: "department", label: "Department" }, { key: "people", label: "People", format: "int" }, { key: "hours", label: "Hours", format: "num" }, { key: "amount", label: "Cost", format: "inr" }, { key: "perHead", label: "Cost per person", format: "inr" }],
        rows: [...by.values()].sort((a, b) => b.month.localeCompare(a.month) || a.label.localeCompare(b.label)).map((g) => ({ month: g.month, department: g.label, people: g.n.size, hours: r1(g.hours), amount: Math.round(g.amount), perHead: Math.round(g.amount / g.n.size) })),
      };
    }
    case "compensation": {
      const ctc = await currentCtcs(viewer.tenantId, active.map((e) => e.id), now);
      const groups = new Map<string, number[]>();
      for (const e of active) { const v = ctc.get(e.id); if (v) groups.set(e.department, [...(groups.get(e.department) ?? []), v]); }
      const all = [...ctc.values()];
      const rows = [...groups.entries()].map(([label, v]) => ({ label, n: v.length, q: quantilesOf(v)! }));
      const hist = histogramOf(all, 5);
      return {
        title: "Annual CTC distribution by department",
        columns: [{ key: "department", label: "Department" }, { key: "n", label: "People", format: "int" }, { key: "min", label: "Lowest", format: "inr" }, { key: "p25", label: "25th percentile", format: "inr" }, { key: "median", label: "Median", format: "inr" }, { key: "p75", label: "75th percentile", format: "inr" }, { key: "max", label: "Highest", format: "inr" }, { key: "spread", label: "Spread (p75 ÷ p25)", format: "num" }],
        rows: [...fold(rows).map((r) => ({ department: r.label, n: r.n, min: r.q.min, p25: r.q.p25, median: r.q.median, p75: r.q.p75, max: r.q.max, spread: r.q.p25 ? r1(r.q.p75 / r.q.p25) : null })),
          ...(all.length ? [{ department: "Everyone", ...quantilesOf(all)!, n: all.length, spread: quantilesOf(all)!.p25 ? r1(quantilesOf(all)!.p75 / quantilesOf(all)!.p25) : null }] : [])],
        notes: [`Pay bands across everyone: ${hist.map((h) => `${Math.round(h.from / 100000)}–${Math.round(h.to / 100000)} L: ${h.count}`).join(" · ")}.`, "Departments with fewer than 3 people are left out."],
      };
    }
    case "pay-equity": {
      const ctc = await currentCtcs(viewer.tenantId, active.map((e) => e.id), now);
      const eq = payEquity(active.map((e) => ({ group: e.jobTitle ?? e.band, gender: e.gender, pay: ctc.get(e.id) ?? 0 })));
      return {
        title: "Gender pay equity by role",
        columns: [{ key: "group", label: "Role / band" }, { key: "men", label: "Men", format: "int" }, { key: "women", label: "Women", format: "int" }, { key: "maleMedian", label: "Men's median", format: "inr" }, { key: "femaleMedian", label: "Women's median", format: "inr" }, { key: "gapPercent", label: "Gap", format: "pct" }],
        rows: eq.groups.filter((g) => g.men + g.women >= 2).map((g) => ({ ...g })),
        notes: [`Unadjusted median gap: ${eq.rawGapPercent ?? "—"}%. Adjusted gap (like-for-like roles, weighted by headcount): ${eq.adjustedGapPercent ?? "—"}%. A positive gap means men's median pay is higher.`],
      };
    }
    case "promotion": {
      const recs = await prisma.employeeJobRecord.findMany({ where: { employeeId: { in: ids }, reason: "PROMOTION" }, select: { employeeId: true, effectiveFrom: true } });
      const promos = new Map<string, Date[]>();
      for (const r of recs) promos.set(r.employeeId, [...(promos.get(r.employeeId) ?? []), r.effectiveFrom]);
      const groups = new Map<string, PopEmployee[]>();
      for (const e of pop) groups.set(e.department, [...(groups.get(e.department) ?? []), e]);
      const rows = [...groups.entries()].map(([label, es]) => {
        const v = promotionVelocity(es.map((e) => ({ joinedOn: e.dateOfJoining, promotions: promos.get(e.id) ?? [] })));
        const inYear = es.filter((e) => (promos.get(e.id) ?? []).some((d) => d >= year.from && d <= year.to)).length;
        return { department: label, people: es.filter((e) => onBooks(e, now)).length, promoted: v.promoted, rate: es.length ? r1((inYear / Math.max(1, es.filter((e) => onBooks(e, now)).length)) * 100) : null, toFirst: v.avgMonthsToFirst, between: v.avgMonthsBetween };
      });
      return {
        title: "Promotion velocity by department",
        columns: [{ key: "department", label: "Department" }, { key: "people", label: "Headcount", format: "int" }, { key: "promoted", label: "Ever promoted", format: "int" }, { key: "rate", label: "Promoted in last 12 months", format: "pct" }, { key: "toFirst", label: "Months to first promotion", format: "num" }, { key: "between", label: "Months between promotions", format: "num" }],
        rows,
      };
    }
    case "mobility": {
      const [moves, internal] = await Promise.all([
        prisma.employeeJobRecord.findMany({ where: { employeeId: { in: ids }, reason: { in: ["TRANSFER", "DEPARTMENT_CHANGE", "LOCATION_CHANGE", "PROMOTION"] }, effectiveFrom: { gte: year.from } }, select: { employeeId: true, reason: true } }),
        prisma.internalApplication.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids } }, select: { employeeId: true, createdAt: true, application: { select: { status: true } } } }),
      ]);
      const dept = new Map(pop.map((e) => [e.id, e.department]));
      const groups = new Map<string, { n: number; transfers: number; promotions: number; applications: number; hired: number }>();
      for (const e of active) { const g = groups.get(e.department) ?? { n: 0, transfers: 0, promotions: 0, applications: 0, hired: 0 }; g.n++; groups.set(e.department, g); }
      for (const m of moves) { const g = groups.get(dept.get(m.employeeId) ?? ""); if (g) { if (m.reason === "PROMOTION") g.promotions++; else g.transfers++; } }
      for (const a of internal) { const g = groups.get(dept.get(a.employeeId) ?? ""); if (g) { g.applications++; if (a.application.status === "HIRED") g.hired++; } }
      return {
        title: "Internal mobility in the last 12 months",
        columns: [{ key: "department", label: "Department" }, { key: "n", label: "Headcount", format: "int" }, { key: "transfers", label: "Lateral moves", format: "int" }, { key: "promotions", label: "Promotions", format: "int" }, { key: "applications", label: "Internal applications", format: "int" }, { key: "hired", label: "Internal hires", format: "int" }, { key: "rate", label: "Mobility rate", format: "pct" }],
        rows: [...groups.entries()].map(([department, g]) => ({ department, ...g, rate: g.n ? r1(((g.transfers + g.promotions + g.hired) / g.n) * 100) : null })),
      };
    }
    case "learning": {
      const en = await prisma.courseEnrolment.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids } }, select: { employeeId: true, status: true, score: true, completedAt: true, course: { select: { title: true } } } });
      const rating = new Map(pop.map((e) => [e.id, e.ratings]));
      const by = new Map<string, typeof en>();
      for (const e of en) by.set(e.course.title, [...(by.get(e.course.title) ?? []), e]);
      const rows = [...by.entries()].map(([course, list]) => {
        const done = list.filter((x) => x.status === "COMPLETED");
        const scores = done.map((x) => x.score).filter((s): s is number => s !== null);
        // Rating change around completion: the first rating after minus the last before.
        const deltas = done.flatMap((x) => {
          const rs = rating.get(x.employeeId) ?? [];
          if (!x.completedAt) return [];
          const before = rs.filter((r) => r.at <= x.completedAt!).pop(), after = rs.find((r) => r.at > x.completedAt!);
          return before && after ? [after.rating - before.rating] : [];
        });
        return { course, enrolled: list.length, completed: done.length, completion: r1((done.length / list.length) * 100), avgScore: scores.length ? r1(scores.reduce((s, x) => s + x, 0) / scores.length) : null, ratingChange: deltas.length ? Math.round((deltas.reduce((s, x) => s + x, 0) / deltas.length) * 100) / 100 : null };
      }).sort((a, b) => b.enrolled - a.enrolled);
      return {
        title: "Learning effectiveness by course",
        columns: [{ key: "course", label: "Course" }, { key: "enrolled", label: "Enrolled", format: "int" }, { key: "completed", label: "Completed", format: "int" }, { key: "completion", label: "Completion", format: "pct" }, { key: "avgScore", label: "Average assessment score", format: "num" }, { key: "ratingChange", label: "Rating change after completing", format: "num" }],
        rows,
        notes: ["Rating change compares each completer's first final rating after the course with the last one before it."],
      };
    }
    case "engagement": {
      const answers = await prisma.surveyAnswer.findMany({ where: { score: { not: null }, question: { driver: { not: null }, survey: { tenantId: viewer.tenantId } } }, select: { score: true, question: { select: { driver: true } } } });
      const rows = engagementDriverScores(answers.map((a) => ({ driver: a.question.driver, score: a.score })));
      return {
        title: "Engagement drivers",
        columns: [{ key: "driver", label: "Driver" }, { key: "responses", label: "Answers", format: "int" }, { key: "mean", label: "Average (of 5)", format: "num" }, { key: "favourable", label: "Favourable (4–5)", format: "pct" }, { key: "gap", label: "Against the overall average", format: "num" }],
        rows: rows.filter((r) => r.responses >= 3),
        notes: ["Drivers are sorted weakest first: the biggest negative gaps are where to act. Drivers with fewer than 3 answers are hidden."],
      };
    }
    case "managers": {
      const managers = [...new Set(active.map((e) => e.reportingManagerId).filter((x): x is string => !!x))];
      const since = new Date(now.getTime() - 90 * DAY);
      const [fb, meetings] = await Promise.all([
        prisma.feedback.groupBy({ by: ["fromEmployeeId"], where: { tenantId: viewer.tenantId, fromEmployeeId: { in: managers }, createdAt: { gte: since }, deletedAt: null }, _count: true }),
        prisma.meeting.findMany({ where: { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", organiserId: { in: managers }, startsAt: { gte: since } }, select: { organiserId: true } }),
      ]);
      const fbBy = new Map(fb.map((f) => [f.fromEmployeeId, f._count]));
      const name = new Map(pop.map((e) => [e.id, e.name]));
      const rows = managers.map((m) => {
        const team = pop.filter((e) => e.reportingManagerId === m);
        const teamActive = team.filter((e) => onBooks(e, now));
        const ratings = teamActive.map((e) => e.ratings[e.ratings.length - 1]?.rating).filter((x): x is number => x !== undefined);
        const eff = managerEffectiveness({ teamSize: teamActive.length, leavers12m: leaversIn(team, year).length, avgTeamRating: ratings.length ? ratings.reduce((s, x) => s + x, 0) / ratings.length : null, feedbackGiven90d: fbBy.get(m) ?? 0, oneOnOnes90d: meetings.filter((x) => x.organiserId === m).length });
        return { manager: name.get(m) ?? "—", team: teamActive.length, ...Object.fromEntries(eff.signals.map((s) => [s.label, s.value])), score: eff.score };
      }).filter((r) => r.team >= 1).sort((a, b) => b.score - a.score);
      return {
        title: "Manager effectiveness",
        columns: [{ key: "manager", label: "Manager" }, { key: "team", label: "Team", format: "int" }, { key: "Retention", label: "Retention", format: "int" }, { key: "Team performance", label: "Team performance", format: "int" }, { key: "Feedback cadence", label: "Feedback cadence", format: "int" }, { key: "1:1 cadence", label: "1:1 cadence", format: "int" }, { key: "score", label: "Index (0–100)", format: "int" }],
        rows,
        notes: ["Each signal is scaled 0–100: retention over 12 months, the team's latest ratings, feedback given and 1:1s held in the last 90 days."],
      };
    }
    case "time-to-fill": {
      const reqs = await prisma.requisition.findMany({
        where: { tenantId: viewer.tenantId, approvedAt: { not: null } },
        select: { title: true, code: true, approvedAt: true, status: true, positions: true, departmentId: true, jobs: { select: { applications: { where: { status: "HIRED" }, select: { updatedAt: true } } } } },
        orderBy: { approvedAt: "desc" }, take: 200,
      });
      const deptName = new Map((await prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
      const rows = reqs.map((r) => {
        const hires = r.jobs.flatMap((j) => j.applications.map((a) => a.updatedAt)).sort((a, b) => a.getTime() - b.getTime());
        return { requisition: `${r.code ? `${r.code} · ` : ""}${r.title}`, department: r.departmentId ? deptName.get(r.departmentId) ?? "—" : "—", approved: r.approvedAt, positions: r.positions, filled: hires.length, firstHire: hires[0] ?? null, days: hires[0] && r.approvedAt ? Math.round((hires[0].getTime() - r.approvedAt.getTime()) / DAY) : null, open: hires[0] ? null : Math.round((now.getTime() - r.approvedAt!.getTime()) / DAY) };
      });
      const med = medianOf(await timeToFillDays(viewer.tenantId, null, new Date(0)));
      return {
        title: "Time to fill by requisition",
        columns: [{ key: "requisition", label: "Requisition" }, { key: "department", label: "Department" }, { key: "approved", label: "Approved", format: "date" }, { key: "positions", label: "Positions", format: "int" }, { key: "filled", label: "Hired", format: "int" }, { key: "firstHire", label: "First hire", format: "date" }, { key: "days", label: "Days to fill", format: "int" }, { key: "open", label: "Days open (unfilled)", format: "int" }],
        rows, notes: [`Median time to fill: ${med ?? "—"} day(s), from approval to the first hire.`],
      };
    }
    case "cost-per-hire": {
      const costs = await prisma.insightHiringCost.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { month: "desc" } });
      const months = [...new Set(costs.map((c) => c.month))];
      const rows = [];
      for (const m of months) {
        const [y, mo] = m.split("-").map(Number);
        const hires = active.concat(pop.filter((e) => !onBooks(e, now))).filter((e) => e.dateOfJoining.getUTCFullYear() === y && e.dateOfJoining.getUTCMonth() + 1 === mo).length;
        const spend = costs.filter((c) => c.month === m).reduce((s, c) => s + Number(c.amount), 0);
        const by = (cat: string) => costs.filter((c) => c.month === m && c.category === cat).reduce((s, c) => s + Number(c.amount), 0);
        rows.push({ month: m, spend: Math.round(spend), agency: Math.round(by("AGENCY")), boards: Math.round(by("JOB_BOARD")), referral: Math.round(by("REFERRAL_BONUS")), other: Math.round(spend - by("AGENCY") - by("JOB_BOARD") - by("REFERRAL_BONUS")), hires, perHire: hires ? Math.round(spend / hires) : null });
      }
      return {
        title: "Cost per hire by month",
        columns: [{ key: "month", label: "Month" }, { key: "spend", label: "Recruiting spend", format: "inr" }, { key: "agency", label: "Agency", format: "inr" }, { key: "boards", label: "Job boards", format: "inr" }, { key: "referral", label: "Referral bonuses", format: "inr" }, { key: "other", label: "Other", format: "inr" }, { key: "hires", label: "Hires", format: "int" }, { key: "perHire", label: "Cost per hire", format: "inr" }],
        rows, notes: ["Spend is what HR records under Hiring costs; hires are people who joined that month."],
      };
    }
    case "productivity": {
      const since = new Date(now.getTime() - 90 * DAY);
      const [att, entries] = await Promise.all([
        prisma.attendanceRecord.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, date: { gte: since } }, select: { employeeId: true, status: true, effectiveHours: true } }),
        prisma.timeEntry.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, date: { gte: since } }, select: { employeeId: true, hours: true, isBillable: true } }),
      ]);
      const dept = new Map(pop.map((e) => [e.id, e.department]));
      const groups = new Map<string, { people: Set<string>; worked: number; hours: number; logged: number; billable: number; absent: number; days: number }>();
      const g = (id: string) => { const k = dept.get(id) ?? "Unassigned"; const x = groups.get(k) ?? { people: new Set<string>(), worked: 0, hours: 0, logged: 0, billable: 0, absent: 0, days: 0 }; groups.set(k, x); x.people.add(id); return x; };
      for (const a of att) { if (a.status === "WEEKLY_OFF" || a.status === "HOLIDAY") continue; const x = g(a.employeeId); x.days++; if (a.status === "ABSENT" || a.status === "NO_ATTENDANCE") x.absent++; if (Number(a.effectiveHours) > 0) { x.worked++; x.hours += Number(a.effectiveHours); } }
      for (const t of entries) { const x = g(t.employeeId); x.logged += Number(t.hours); if (t.isBillable) x.billable += Number(t.hours); }
      return {
        title: "Workforce productivity (last 90 days)",
        columns: [{ key: "department", label: "Department" }, { key: "people", label: "People", format: "int" }, { key: "avgHours", label: "Avg hours per worked day", format: "num" }, { key: "attendance", label: "Attendance", format: "pct" }, { key: "logged", label: "Hours logged on projects", format: "num" }, { key: "billable", label: "Billable share", format: "pct" }],
        rows: [...groups.entries()].map(([department, x]) => ({ department, people: x.people.size, avgHours: x.worked ? r1(x.hours / x.worked) : null, attendance: x.days ? r1(((x.days - x.absent) / x.days) * 100) : null, logged: r1(x.logged), billable: x.logged ? r1((x.billable / x.logged) * 100) : null })),
      };
    }
    case "diversity": {
      const groups = new Map<string, { n: number; female: number; male: number; other: number; under30: number }>();
      for (const e of active) {
        const x = groups.get(e.department) ?? { n: 0, female: 0, male: 0, other: 0, under30: 0 };
        x.n++;
        if (e.gender === "FEMALE") x.female++; else if (e.gender === "MALE") x.male++; else x.other++;
        if (e.dateOfBirth && (now.getTime() - e.dateOfBirth.getTime()) / (365.25 * DAY) < 30) x.under30++;
        groups.set(e.department, x);
      }
      const managers = new Set(active.map((e) => e.reportingManagerId).filter(Boolean));
      const mgrs = active.filter((e) => managers.has(e.id));
      const total = { n: active.length, female: active.filter((e) => e.gender === "FEMALE").length };
      return {
        title: "Workforce diversity",
        columns: [{ key: "department", label: "Department" }, { key: "n", label: "Headcount", format: "int" }, { key: "female", label: "Women", format: "pct" }, { key: "male", label: "Men", format: "pct" }, { key: "other", label: "Other / not stated", format: "pct" }, { key: "under30", label: "Under 30", format: "pct" }],
        rows: [...groups.entries()].filter(([, x]) => x.n >= 3).map(([department, x]) => ({ department, n: x.n, female: r1((x.female / x.n) * 100), male: r1((x.male / x.n) * 100), other: r1((x.other / x.n) * 100), under30: r1((x.under30 / x.n) * 100) })),
        notes: [`Women: ${total.n ? r1((total.female / total.n) * 100) : 0}% of everyone, ${mgrs.length ? r1((mgrs.filter((e) => e.gender === "FEMALE").length / mgrs.length) * 100) : 0}% of people managers. Departments under 3 people are hidden.`],
      };
    }
    case "anomalies": {
      const series: Record<string, Array<{ label: string; value: number }>> = { Joiners: [], Leavers: [], Headcount: [] };
      for (let i = 11; i >= 0; i--) {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
        const label = `${MONTH_ABBR[start.getUTCMonth()]}-${start.getUTCFullYear()}`;
        series.Joiners!.push({ label, value: pop.filter((e) => e.dateOfJoining >= start && e.dateOfJoining <= end).length });
        series.Leavers!.push({ label, value: leaversIn(pop, { from: start, to: end }).length });
        series.Headcount!.push({ label, value: Math.round(averageHeadcount(pop, { from: start, to: end })) });
      }
      const leave = await prisma.leaveRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)) } }, select: { fromDate: true, totalDays: true } });
      series["Leave days"] = series.Joiners!.map((p, i) => {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - i), 1)), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - i) + 1, 0));
        return { label: p.label, value: Math.round(leave.filter((l) => l.fromDate >= start && l.fromDate <= end).reduce((s, l) => s + Number(l.totalDays), 0)) };
      });
      const rows = Object.entries(series).flatMap(([metric, s]) => seriesAnomalies(s).map((a) => ({ metric, month: a.label, value: a.value, reason: a.reason })));
      return {
        title: "Anomalies in the last 12 months",
        columns: [{ key: "metric", label: "Measure" }, { key: "month", label: "Month" }, { key: "value", label: "Value", format: "num" }, { key: "reason", label: "Why it stands out" }],
        rows, notes: ["A month stands out when it is more than 2 standard deviations from the other months, or swings more than 50% on the month before."],
      };
    }
  }
}

/** The members of a saved cohort, with their headline facts. */
export async function cohortMembers(viewer: Viewer, cohortId: string, now = new Date()): Promise<InsightTable | null> {
  const c = await prisma.insightCohort.findFirst({ where: { id: cohortId, tenantId: viewer.tenantId, OR: [{ createdBy: viewer.user.id }, { shared: true }] } });
  if (!c) return null;
  const f = cohortFiltersOf(c.filters);
  const pop = (await scopedPopulation(viewer)).filter((e) => inCohort(e, f, now));
  const w = trailingWindow(now, 12);
  const avg = averageHeadcount(pop, w);
  const left = leaversIn(pop, w).length;
  return {
    title: `Cohort: ${c.name}`,
    columns: [{ key: "number", label: "No." }, { key: "name", label: "Name" }, { key: "department", label: "Department" }, { key: "location", label: "Location" }, { key: "gender", label: "Gender" }, { key: "joined", label: "Joined", format: "date" }, { key: "left", label: "Left", format: "date" }, { key: "rating", label: "Latest rating", format: "num" }],
    rows: pop.map((e) => ({ number: e.employeeNumber, name: e.name, department: e.department, location: e.location, gender: e.gender ?? "", joined: e.dateOfJoining, left: e.leftOn, rating: e.ratings[e.ratings.length - 1]?.rating ?? null })),
    notes: [`${pop.filter((e) => onBooks(e, now)).length} on the books; ${left} left in the last 12 months (annualised attrition ${avg ? r1((left / avg) * 100) : 0}%).`],
  };
}

/** Executive and department HR scorecards: the same measures, company-wide and per department. */
export async function scorecard(viewer: Viewer, now = new Date()): Promise<InsightTable> {
  const depts = await prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const scope = can(viewer, P.ANALYTICS_VIEW) ? depts : [];
  const calcs = ["HEADCOUNT", "NEW_HIRES", "ATTRITION_RATE", "ABSENCE_RATE", "AVERAGE_RATING", "GOALS_AT_RISK", "HIGH_RISK_SHARE", "POSITIVE_FEEDBACK_SHARE", "LEARNING_COMPLETION"];
  const row = async (label: string, departmentId: string | null) => {
    const out: Record<string, unknown> = { scope: label };
    for (const c of calcs) out[c] = await computeInsightMetric(viewer.tenantId, c, { departmentId }, now);
    return out;
  };
  const rows = [await row("Company", null)];
  for (const d of scope) rows.push(await row(d.name, d.id));
  return {
    title: "HR scorecard",
    columns: [
      { key: "scope", label: "Scope" }, { key: "HEADCOUNT", label: "Headcount", format: "int" }, { key: "NEW_HIRES", label: "Hires (12m)", format: "int" },
      { key: "ATTRITION_RATE", label: "Attrition", format: "pct" }, { key: "ABSENCE_RATE", label: "Absence", format: "pct" }, { key: "AVERAGE_RATING", label: "Avg rating", format: "num" },
      { key: "GOALS_AT_RISK", label: "Goals at risk", format: "pct" }, { key: "HIGH_RISK_SHARE", label: "High flight risk", format: "pct" },
      { key: "POSITIVE_FEEDBACK_SHARE", label: "Positive feedback", format: "pct" }, { key: "LEARNING_COMPLETION", label: "Course completion", format: "pct" },
    ],
    rows: rows.filter((r, i) => i === 0 || (r.HEADCOUNT as number) > 0),
  };
}
