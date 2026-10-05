import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  grantLive, widgetVisible, kpiRag, targetInForce, evalCalculatedField, exceptionRows, joinRowSets, normalizeRatings, ratingTrend, performanceSummary,
  weightedCompetencyScore, scalePointsOf, describeRating, behaviourTrend, pipRisk, performanceRisk, checkInOverdue, confidenceLabel,
  loadPopulation, onBooks, currentCtcs, PERF_EXCEPTION_KINDS, INSIGHT_CALCULATORS, METRIC_CATEGORIES, type ExceptionRule, type ExceptionOp, EXCEPTION_OPS,
} from "@keka/services";
import { can, canAny, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere, scopedEmployeeIds } from "@/lib/scope";
import { REPORTS, defaultParams, type Column } from "@/lib/reports";
import type { InsightTable, InsightColumn, CellFormat } from "./export";
import { peopleAnalysis, isPeopleTab, peopleTabAllowed, cohortMembers, scorecard } from "./people";

/**
 * Every insight table by key — the on-screen tables and their downloads. A
 * dataset decides who may open it and scopes its own rows; `runDataset`
 * also applies a calculated field when one is asked for.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
type SP = Record<string, string | undefined>;
const nameOf = (e: { displayName: string | null; firstName?: string; lastName?: string } | null | undefined) => (e ? e.displayName ?? `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim() : "");
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
//  Standard reports with access grants
// ---------------------------------------------------------------------------

/** Reports the viewer can open: by role, or through a live access grant. */
export async function grantedReportKeys(viewer: Viewer, now = new Date()): Promise<Set<string>> {
  const g = await prisma.insightReportGrant.findMany({ where: { tenantId: viewer.tenantId, userId: viewer.user.id, status: "APPROVED", expiresAt: { gt: now } } });
  return new Set(g.filter((x) => grantLive(x, now)).map((x) => x.reportKey));
}

export async function canOpenReport(viewer: Viewer, key: string): Promise<boolean> {
  const r = REPORTS.find((x) => x.key === key);
  if (!r) return false;
  return can(viewer, r.permission) || (await grantedReportKeys(viewer)).has(key);
}

const fmtOf = (f: Column["format"]): CellFormat => (f === "pct" ? "pct" : (f ?? "text") as CellFormat);

/**
 * A standard report as an insight table. A grant lets the person run the
 * report with the grant's permission for its rows — scoped to the whole
 * company only if they also hold it, otherwise to what the report's own
 * scope gives them (a grant never widens anyone's employee scope).
 */
export async function standardReport(viewer: Viewer, key: string, sp: SP): Promise<InsightTable | null> {
  const r = REPORTS.find((x) => x.key === key);
  if (!r || !(await canOpenReport(viewer, key))) return null;
  const v = can(viewer, r.permission) ? viewer : { ...viewer, permissions: new Set([...viewer.permissions, r.permission]) } as Viewer;
  const res = await r.run(v, defaultParams(viewer, { fy: sp.fy, month: sp.month }));
  const rows = res.rows.map((row) => Object.fromEntries(res.columns.map((c) => [c.key, c.format === "pct" && typeof row[c.key] === "number" ? Math.round((row[c.key] as number) * 1000) / 10 : row[c.key]])));
  if (res.totals) rows.push(Object.fromEntries(res.columns.map((c) => [c.key, c.format === "pct" && typeof res.totals![c.key] === "number" ? Math.round((res.totals![c.key] as number) * 1000) / 10 : res.totals![c.key]])));
  return { title: r.title, columns: res.columns.map((c) => ({ key: c.key, label: c.label, format: fmtOf(c.format) })), rows, notes: res.notes };
}

// ---------------------------------------------------------------------------
//  Cross-module workforce rows: the base for joins, exceptions, effective dating
// ---------------------------------------------------------------------------

export const WORKFORCE_COLUMNS: InsightColumn[] = [
  { key: "number", label: "No." }, { key: "name", label: "Name" }, { key: "department", label: "Department" }, { key: "location", label: "Location" },
  { key: "jobTitle", label: "Job title" }, { key: "manager", label: "Manager" }, { key: "joined", label: "Joined", format: "date" }, { key: "left", label: "Left", format: "date" },
  { key: "tenureYears", label: "Tenure (years)", format: "num" }, { key: "rating", label: "Latest rating", format: "num" },
  { key: "goals", label: "Live goals", format: "int" }, { key: "goalsAtRisk", label: "Goals at risk", format: "int" },
  { key: "leaveDays", label: "Leave days (12m)", format: "num" }, { key: "riskBand", label: "Flight risk" },
];

/**
 * People joined across modules: core HR (directory), performance (ratings,
 * goals), time (leave) and analytics (risk); pay is added for pay-register
 * holders. `asOf` gives effective-dated membership: who was on the books
 * then, with the department and manager in force on that date.
 */
export async function workforceRows(viewer: Viewer, asOf = new Date()): Promise<{ columns: InsightColumn[]; rows: Array<Record<string, unknown>> }> {
  const pop = (await loadPopulation(scopedEmployeeWhere(viewer, P.REPORT_VIEW) as never)).filter((e) => onBooks(e, asOf));
  const ids = pop.map((e) => e.id);
  const yearAgo = new Date(asOf.getTime() - 365 * DAY);
  const [goals, leave, risk, jobs, depts, emps] = await Promise.all([
    prisma.goal.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] } }, select: { employeeId: true, status: true } }),
    prisma.leaveRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, status: "APPROVED", fromDate: { gte: yearAgo, lte: asOf } }, select: { employeeId: true, totalDays: true } }),
    prisma.attritionRiskScore.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids }, asOf: { lte: asOf } }, orderBy: { asOf: "asc" }, select: { employeeId: true, band: true } }),
    prisma.employeeJobRecord.findMany({ where: { employeeId: { in: ids }, effectiveFrom: { lte: asOf } }, orderBy: { effectiveFrom: "asc" }, select: { employeeId: true, departmentId: true, reportingManagerId: true, effectiveTo: true } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, displayName: true, firstName: true, lastName: true } }),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const empName = new Map(emps.map((e) => [e.id, nameOf(e)]));
  const riskOf = new Map<string, string>(); for (const r of risk) riskOf.set(r.employeeId, r.band);
  const jobOf = new Map<string, (typeof jobs)[number]>(); for (const j of jobs) if (!j.effectiveTo || j.effectiveTo >= asOf) jobOf.set(j.employeeId, j);
  const today = Date.now() - asOf.getTime() < DAY;
  const rows = pop.map((e) => {
    const job = today ? null : jobOf.get(e.id);
    const rating = e.ratings.filter((r) => r.at <= asOf).pop()?.rating ?? null;
    return {
      id: e.id, number: e.employeeNumber, name: e.name,
      department: job?.departmentId ? deptName.get(job.departmentId) ?? e.department : e.department, location: e.location, jobTitle: e.jobTitle ?? "",
      manager: job?.reportingManagerId ? empName.get(job.reportingManagerId) ?? e.manager : e.manager,
      joined: e.dateOfJoining, left: e.leftOn, tenureYears: Math.round(((asOf.getTime() - e.dateOfJoining.getTime()) / (365.25 * DAY)) * 10) / 10,
      rating, goals: goals.filter((g) => g.employeeId === e.id).length, goalsAtRisk: goals.filter((g) => g.employeeId === e.id && g.status !== "ON_TRACK").length,
      leaveDays: leave.filter((l) => l.employeeId === e.id).reduce((s, l) => s + Number(l.totalDays), 0), riskBand: riskOf.get(e.id) ?? "",
    } as Record<string, unknown>;
  });
  const columns = [...WORKFORCE_COLUMNS];
  if (can(viewer, P.PAY_REGISTER_VIEW)) {
    const ctc = await currentCtcs(viewer.tenantId, ids, asOf);
    const joined = joinRowSets(rows, [...ctc.entries()].map(([id, v]) => ({ id, ctc: v })), "id", "pay_");
    columns.push({ key: "pay_ctc", label: "Annual CTC", format: "inr" });
    return { columns, rows: joined };
  }
  return { columns, rows };
}

export function exceptionRulesOf(sp: SP): ExceptionRule[] {
  const out: ExceptionRule[] = [];
  for (let i = 1; i <= 3; i++) {
    const column = sp[`c${i}`], op = sp[`o${i}`];
    if (column && op && op in EXCEPTION_OPS) out.push({ column, op: op as ExceptionOp, value: sp[`v${i}`] ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  The registry
// ---------------------------------------------------------------------------

async function auditTable(viewer: Viewer, title: string, entityTypes: string[], take = 1000): Promise<InsightTable> {
  const rows = await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: { in: entityTypes } }, orderBy: { createdAt: "desc" }, take });
  return {
    title,
    columns: [{ key: "at", label: "When" }, { key: "who", label: "Who" }, { key: "action", label: "Action" }, { key: "entity", label: "Record" }, { key: "summary", label: "What happened" }],
    rows: rows.map((r) => ({ at: r.createdAt.toISOString().slice(0, 16).replace("T", " "), who: r.actorLabel ?? "system", action: r.action, entity: r.entityType, summary: r.summary ?? "" })),
  };
}

export const GOAL_AUDIT_TYPES = ["Goal", "GoalCheckIn", "InsightGoalLink", "InsightOkrCloseout", "InsightOkrSetting"];
export const PERF_AUDIT_TYPES = ["ReviewCycle", "EmployeeReview", "ReviewResponse", "PerformanceBand", "ReviewFormSection", "ReviewFormQuestion", "ReviewCycleStage", "InsightCycleTemplate", "InsightRatingScale", "InsightCalibrationNote", "InsightPerfException", "InsightReviewReopen"];
export const FEEDBACK_AUDIT_TYPES = ["Feedback", "FeedbackRequest", "FeedbackTemplate", "FeedbackSetting", "InsightFeedbackTopic", "InsightFeedbackRule", "InsightFeedbackEscalation", "InsightFeedbackFollowUp"];

const perfManager = (v: Viewer) => canAny(v, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE]);

/** Who sees which feedback (the export permission): HR its scope, managers their line, everyone their own. */
async function feedbackWhere(viewer: Viewer): Promise<Record<string, unknown>> {
  const me = viewer.employee?.id ?? "__none__";
  const or: Record<string, unknown>[] = [{ aboutEmployeeId: me }, { fromEmployeeId: me }];
  if (viewer.allReportIds.size) or.push({ aboutEmployeeId: { in: [...viewer.allReportIds] } });
  if (can(viewer, P.PERFORMANCE_MANAGE)) {
    const ids = await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE);
    or.push(ids === null ? {} : { aboutEmployeeId: { in: ids } });
  }
  return { tenantId: viewer.tenantId, deletedAt: null, OR: [{ kind: "FEEDBACK", OR: or }, { kind: "INTERNAL_NOTE", fromEmployeeId: me }] };
}

export async function feedbackTable(viewer: Viewer, sp: SP): Promise<InsightTable> {
  const q = (sp.q ?? "").trim().slice(0, 80);
  const where: Record<string, unknown> = { AND: [await feedbackWhere(viewer)] };
  if (q) (where.AND as unknown[]).push({ OR: [{ message: { contains: q, mode: "insensitive" } }, { topic: { contains: q, mode: "insensitive" } }, { tags: { has: q.toLowerCase() } }, { aboutEmployee: { displayName: { contains: q, mode: "insensitive" } } }] });
  if (sp.sentiment) (where.AND as unknown[]).push({ sentiment: sp.sentiment });
  if (sp.topicId) (where.AND as unknown[]).push({ topicId: sp.topicId });
  if (sp.about) (where.AND as unknown[]).push({ aboutEmployeeId: sp.about });
  const rows = await prisma.feedback.findMany({ where: where as never, include: { fromEmployee: { select: { displayName: true, firstName: true, lastName: true } }, aboutEmployee: { select: { displayName: true, firstName: true, lastName: true } } }, orderBy: { createdAt: "desc" }, take: 1000 });
  const topics = new Map((await prisma.insightFeedbackTopic.findMany({ where: { tenantId: viewer.tenantId } })).map((t) => [t.id, t.name]));
  const me = viewer.employee?.id;
  return {
    title: "Feedback",
    columns: [{ key: "at", label: "Date", format: "date" }, { key: "from", label: "From" }, { key: "about", label: "About" }, { key: "kind", label: "Kind" }, { key: "topic", label: "Topic" }, { key: "tags", label: "Tags" }, { key: "sentiment", label: "Sentiment" }, { key: "message", label: "Feedback" }],
    rows: rows.map((f) => ({
      id: f.id, own: f.fromEmployeeId === me, createdAt: f.createdAt, at: f.createdAt,
      from: f.isAnonymous && f.fromEmployeeId !== me ? "Anonymous" : nameOf(f.fromEmployee), about: nameOf(f.aboutEmployee),
      kind: f.kind === "INTERNAL_NOTE" ? "Internal note" : "Feedback", topic: (f.topicId ? topics.get(f.topicId) : null) ?? f.topic ?? "", tags: f.tags.join(", "),
      sentiment: f.sentiment ?? "", message: f.message, edited: !!f.editedAt,
    })),
  };
}

export async function runDataset(viewer: Viewer, key: string, sp: SP = {}): Promise<InsightTable | null> {
  const [name, arg] = [key.split(":")[0]!, key.split(":").slice(1).join(":")];
  const t = viewer.tenantId;
  const table = await (async (): Promise<InsightTable | null> => {
    switch (name) {
      case "report": return standardReport(viewer, arg, sp);
      case "metrics": {
        if (!can(viewer, P.ANALYTICS_VIEW)) return null;
        const rows = await prisma.insightMetric.findMany({ where: { tenantId: t, ...(sp.category ? { category: sp.category } : {}), ...(sp.q ? { name: { contains: sp.q, mode: "insensitive" } } : {}) }, orderBy: [{ key: "asc" }, { version: "desc" }] });
        return {
          title: "Metric catalog",
          columns: [{ key: "key", label: "Key" }, { key: "name", label: "Metric" }, { key: "category", label: "Category" }, { key: "calc", label: "Calculation" }, { key: "unit", label: "Unit" }, { key: "version", label: "Version", format: "int" }, { key: "status", label: "Status" }, { key: "warnAt", label: "Warn at", format: "num" }, { key: "alertAt", label: "Alert at", format: "num" }, { key: "lastValue", label: "Latest value", format: "num" }, { key: "lastComputedAt", label: "Computed", format: "date" }],
          rows: rows.map((m) => ({ id: m.id, key: m.key, name: m.name, category: METRIC_CATEGORIES[m.category as keyof typeof METRIC_CATEGORIES] ?? m.category, calc: INSIGHT_CALCULATORS[m.calculator]?.label ?? m.calculator, unit: m.unit, version: m.version, status: m.status, warnAt: n(m.warnAt), alertAt: n(m.alertAt), lastValue: n(m.lastValue), lastComputedAt: m.lastComputedAt, formula: m.formula, description: m.description, direction: m.direction })),
        };
      }
      case "kpis": {
        if (!canAny(viewer, [P.ANALYTICS_VIEW, P.PERFORMANCE_MANAGE])) return null;
        const kpis = await prisma.insightKpi.findMany({ where: { tenantId: t }, include: { targets: true, readings: { orderBy: { period: "desc" }, take: 1 } }, orderBy: { name: "asc" } });
        const kras = new Map((await prisma.insightKra.findMany({ where: { tenantId: t } })).map((k) => [k.id, k.name]));
        const owners = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: kpis.map((k) => k.ownerEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, firstName: true, lastName: true } })).map((e) => [e.id, nameOf(e)]));
        return {
          title: "KPI dashboard",
          columns: [{ key: "name", label: "KPI" }, { key: "kra", label: "KRA" }, { key: "owner", label: "Owner" }, { key: "calcKind", label: "Calculated" }, { key: "frequency", label: "Frequency" }, { key: "period", label: "Latest period" }, { key: "value", label: "Value", format: "num" }, { key: "target", label: "Target", format: "num" }, { key: "targetVersion", label: "Target version", format: "int" }, { key: "achievement", label: "Achievement", format: "pct" }, { key: "rag", label: "RAG" }],
          rows: kpis.map((k) => {
            const r = k.readings[0];
            const tg = r ? targetInForce(k.targets, r.period) : [...k.targets].sort((a, b) => b.version - a.version)[0];
            const judged = r && tg ? kpiRag(Number(r.value), Number(tg.target), k.direction, Number(k.greenAt), Number(k.amberAt)) : null;
            return { id: k.id, name: k.name, kra: k.kraId ? kras.get(k.kraId) ?? "" : "", owner: k.ownerEmployeeId ? owners.get(k.ownerEmployeeId) ?? "" : "", calcKind: k.calcKind === "METRIC" ? `from ${k.metricKey}` : "manual", frequency: k.frequency, period: r?.period ?? "", value: r ? Number(r.value) : null, target: tg ? Number(tg.target) : null, targetVersion: tg?.version ?? null, achievement: judged?.achievement ?? null, rag: judged?.rag ?? "", isActive: k.isActive };
          }),
        };
      }
      case "kras": {
        if (!canAny(viewer, [P.ANALYTICS_VIEW, P.PERFORMANCE_MANAGE, P.PERFORMANCE_VIEW])) return null;
        const rows = await prisma.insightKra.findMany({ where: { tenantId: t, ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { jobTitle: { contains: sp.q, mode: "insensitive" } }] } : {}), ...(sp.status ? { status: sp.status } : {}) }, orderBy: [{ name: "asc" }, { version: "desc" }] });
        const depts = new Map((await prisma.department.findMany({ where: { tenantId: t } })).map((d) => [d.id, d.name]));
        const kpiCount = await prisma.insightKpi.groupBy({ by: ["kraId"], where: { tenantId: t, kraId: { not: null } }, _count: true });
        return {
          title: "Key result areas",
          columns: [{ key: "name", label: "KRA" }, { key: "jobTitle", label: "Role" }, { key: "department", label: "Department" }, { key: "weight", label: "Weight", format: "num" }, { key: "kpis", label: "KPIs", format: "int" }, { key: "version", label: "Version", format: "int" }, { key: "status", label: "Status" }],
          rows: rows.map((k) => ({ id: k.id, name: k.name, description: k.description, jobTitle: k.jobTitle ?? "Everyone", department: k.departmentId ? depts.get(k.departmentId) ?? "" : "All", weight: Number(k.weight), kpis: kpiCount.find((c) => c.kraId === k.id)?._count ?? 0, version: k.version, status: k.status })),
        };
      }
      case "report-runs": {
        if (!can(viewer, P.REPORT_VIEW)) return null;
        const all = can(viewer, P.REPORT_BUILD);
        const rows = await prisma.insightReportRun.findMany({ where: { tenantId: t, ...(all ? {} : { userId: viewer.user.id }), ...(sp.q ? { title: { contains: sp.q, mode: "insensitive" } } : {}), ...(sp.trigger ? { trigger: sp.trigger } : {}) }, orderBy: { createdAt: "desc" }, take: 500 });
        const users = new Map((await prisma.user.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
        return {
          title: "Report execution history",
          columns: [{ key: "at", label: "When" }, { key: "title", label: "Report" }, { key: "trigger", label: "How" }, { key: "format", label: "Format" }, { key: "rows", label: "Rows", format: "int" }, { key: "durationMs", label: "Took (ms)", format: "int" }, { key: "status", label: "Result" }, { key: "who", label: "By" }],
          rows: rows.map((r) => ({ at: r.createdAt.toISOString().slice(0, 16).replace("T", " "), title: r.title, trigger: r.trigger, format: r.format ?? "", rows: r.rows, durationMs: r.durationMs, status: r.error ? `FAILED: ${r.error}` : r.status, who: r.userId ? users.get(r.userId) ?? "" : "schedule" })),
        };
      }
      case "workforce":
      case "effective":
      case "exceptions": {
        if (!can(viewer, P.REPORT_VIEW)) return null;
        const asOf = name === "effective" && sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? new Date(`${sp.asOf}T00:00:00Z`) : new Date();
        const w = await workforceRows(viewer, asOf);
        const rules = exceptionRulesOf(sp);
        const rows = name === "exceptions" ? exceptionRows(w.rows, rules, sp.mode === "ALL" ? "ALL" : "ANY") : w.rows;
        return {
          title: name === "effective" ? `Workforce as of ${asOf.toISOString().slice(0, 10)}` : name === "exceptions" ? "Exceptions only" : "Workforce across modules",
          columns: w.columns, rows,
          notes: name === "exceptions" ? [rules.length ? `Rows breaking ${sp.mode === "ALL" ? "every" : "any"} rule: ${rules.map((r) => `${r.column} ${EXCEPTION_OPS[r.op]} ${r.value ?? ""}`).join("; ")}.` : "Add a rule to list the exceptions."] : name === "effective" ? ["Who was on the books on the date, with the department and manager in force then (from job history)."] : ["Core HR joined with performance, time and analytics" + (can(viewer, P.PAY_REGISTER_VIEW) ? " and pay." : ".")],
        };
      }
      case "snapshot": {
        if (!can(viewer, P.REPORT_VIEW)) return null;
        const s = await prisma.insightReportSnapshot.findFirst({ where: { id: arg, tenantId: t } });
        if (!s) return null;
        return { title: `${s.title} — snapshot ${s.createdAt.toISOString().slice(0, 10)}`, columns: s.columns as unknown as InsightColumn[], rows: s.rows as unknown as Array<Record<string, unknown>>, notes: s.note ? [s.note] : undefined };
      }
      case "talent-risk": {
        if (!can(viewer, P.ATTRITION_RISK_VIEW)) return null;
        const ids = await scopedEmployeeIds(viewer, P.ATTRITION_RISK_VIEW);
        const latest = await prisma.attritionRiskScore.findFirst({ where: { tenantId: t }, orderBy: { asOf: "desc" }, select: { asOf: true } });
        const rows = latest ? await prisma.attritionRiskScore.findMany({ where: { tenantId: t, asOf: latest.asOf, ...(ids ? { employeeId: { in: ids } } : {}), ...(sp.band ? { band: sp.band as never } : {}) }, include: { employee: { select: { displayName: true, firstName: true, lastName: true, employeeNumber: true, department: { select: { name: true } } } } }, orderBy: { score: "desc" } }) : [];
        return {
          title: `Talent risk${latest ? ` (${latest.asOf.toISOString().slice(0, 10)})` : ""}`,
          columns: [{ key: "number", label: "No." }, { key: "name", label: "Employee" }, { key: "department", label: "Department" }, { key: "score", label: "Risk score", format: "int" }, { key: "band", label: "Band" }, { key: "coverage", label: "Signals with data", format: "int" }, { key: "drivers", label: "Top drivers" }],
          rows: rows.map((r) => ({ employeeId: r.employeeId, number: r.employee.employeeNumber, name: nameOf(r.employee), department: r.employee.department?.name ?? "", score: r.score, band: r.band, coverage: r.coverage, drivers: (Array.isArray(r.factors) ? (r.factors as Array<{ label: string; points: number }>) : []).filter((f) => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.label).join(", ") })),
          notes: latest ? undefined : ["No risk snapshot yet — recompute it from the risk page."],
        };
      }
      case "people": return isPeopleTab(arg) && peopleTabAllowed(viewer, arg) ? peopleAnalysis(viewer, arg) : null;
      case "cohort": return can(viewer, P.ANALYTICS_VIEW) ? cohortMembers(viewer, arg) : null;
      case "scorecard": return can(viewer, P.ANALYTICS_VIEW) ? scorecard(viewer) : null;
      case "dashboard": {
        const d = await prisma.insightDashboard.findFirst({ where: { id: arg, tenantId: t }, include: { widgets: { orderBy: { position: "asc" } }, shares: true } });
        const acc = d ? await dashboardAccess(viewer, d) : null;
        if (!d || !acc?.view) return null;
        const who = { roleNames: viewer.roleNames, isManager: viewer.allReportIds.size > 0, isEmployee: !!viewer.employee };
        d.widgets = acc.edit ? d.widgets : d.widgets.filter((w) => widgetVisible(w.roles, who));
        return {
          title: d.name,
          columns: [{ key: "title", label: "Widget" }, { key: "source", label: "Source" }, { key: "ref", label: "Measure" }, { key: "value", label: "Value", format: "num" }, { key: "computedAt", label: "Computed", format: "date" }, { key: "error", label: "Problem" }],
          rows: d.widgets.map((w) => ({ title: w.title, source: w.source, ref: w.refKey, value: n(w.value), computedAt: w.computedAt, error: w.error ?? "" })),
        };
      }
      // ---- Performance -------------------------------------------------------
      case "perf-data": {
        if (!perfManager(viewer)) return null;
        const cycle = await prisma.reviewCycle.findFirst({ where: { id: arg, tenantId: t }, include: { bands: true, formSections: { include: { questions: true } } } });
        if (!cycle) return null;
        const scope = await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE);
        const reviews = await prisma.employeeReview.findMany({ where: { cycleId: cycle.id, ...(scope ? { employeeId: { in: scope } } : {}) }, include: { band: true, responses: true, employee: { select: { displayName: true, firstName: true, lastName: true, employeeNumber: true, department: { select: { name: true } }, reportingManager: { select: { displayName: true, firstName: true, lastName: true } } } } }, orderBy: { employee: { employeeNumber: "asc" } } });
        const qs = cycle.formSections.flatMap((s) => s.questions.map((q) => ({ id: q.id, kind: q.kind, weight: q.weight === null ? null : Number(q.weight) })));
        const rating = (r: (typeof reviews)[number], type: string) => n(r.responses.find((x) => x.reviewerType === type && x.submittedAt)?.overallRating);
        return {
          title: `Performance data — ${cycle.name}`,
          columns: [{ key: "number", label: "No." }, { key: "name", label: "Employee" }, { key: "department", label: "Department" }, { key: "manager", label: "Manager" }, { key: "status", label: "Status" }, { key: "self", label: "Self", format: "num" }, { key: "mgr", label: "Manager rating", format: "num" }, { key: "raw", label: "Raw", format: "num" }, { key: "final", label: "Final", format: "num" }, { key: "band", label: "Band" }, { key: "potential", label: "Potential", format: "num" }, { key: "competency", label: "Weighted competency", format: "num" }, { key: "peers", label: "360 responses", format: "int" }, { key: "reason", label: "Calibration reason" }],
          rows: reviews.map((r) => {
            const mgrAnswers = (r.responses.find((x) => x.reviewerType === "MANAGER")?.answers ?? {}) as Record<string, unknown>;
            return { reviewId: r.id, number: r.employee.employeeNumber, name: nameOf(r.employee), department: r.employee.department?.name ?? "", manager: nameOf(r.employee.reportingManager), status: r.status, self: rating(r, "SELF"), mgr: rating(r, "MANAGER"), raw: n(r.rawRating), final: n(r.finalRating), band: r.band?.name ?? "", potential: n(r.potentialRating), competency: weightedCompetencyScore(qs, mgrAnswers), peers: r.responses.filter((x) => ["PEER", "SUBORDINATE", "SKIP_LEVEL"].includes(x.reviewerType) && x.submittedAt).length, reason: r.calibrationReason ?? "" };
          }),
        };
      }
      case "perf-audit": return perfManager(viewer) ? auditTable(viewer, "Performance audit history", PERF_AUDIT_TYPES) : null;
      case "perf-exceptions": {
        if (!perfManager(viewer)) return null;
        const rows = await prisma.insightPerfException.findMany({ where: { tenantId: t, ...(arg ? { cycleId: arg } : {}), ...(sp.status ? { status: sp.status } : { status: "OPEN" }) }, orderBy: { createdAt: "desc" } });
        const emps = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, firstName: true, lastName: true } })).map((e) => [e.id, nameOf(e)]));
        return {
          title: "Performance exception queue",
          columns: [{ key: "employee", label: "Employee" }, { key: "kind", label: "Exception" }, { key: "detail", label: "Detail" }, { key: "status", label: "Status" }, { key: "note", label: "Resolution" }, { key: "at", label: "Raised", format: "date" }],
          rows: rows.map((e) => ({ id: e.id, reviewId: e.reviewId, employee: emps.get(e.employeeId) ?? "", kind: PERF_EXCEPTION_KINDS[e.kind as keyof typeof PERF_EXCEPTION_KINDS] ?? e.kind, detail: e.detail, status: e.status, note: e.note ?? "", at: e.createdAt })),
        };
      }
      case "perf-trend": {
        if (!canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.PERFORMANCE_VIEW])) return null;
        const scope = await scopedEmployeeIds(viewer, P.PERFORMANCE_VIEW);
        const cycles = await prisma.reviewCycle.findMany({ where: { tenantId: t, status: { not: "CANCELLED" } }, include: { reviews: { where: { finalRating: { not: null }, ...(scope ? { employeeId: { in: scope } } : {}), ...(sp.departmentId ? { employee: { departmentId: sp.departmentId } } : {}) }, select: { finalRating: true } } } });
        return {
          title: "Performance trend across cycles",
          columns: [{ key: "cycle", label: "Cycle" }, { key: "reviews", label: "Rated", format: "int" }, { key: "average", label: "Average rating", format: "num" }, { key: "high", label: "Rated 4+", format: "int" }, { key: "low", label: "Rated under 2.5", format: "int" }],
          rows: ratingTrend(cycles.map((c) => ({ name: c.name, end: c.periodEnd, ratings: c.reviews.map((r) => Number(r.finalRating)) }))),
        };
      }
      case "perf-normalized": {
        if (!perfManager(viewer)) return null;
        const cycle = await prisma.reviewCycle.findFirst({ where: { id: arg, tenantId: t } });
        if (!cycle) return null;
        const scope = await scopedEmployeeIds(viewer, P.PERFORMANCE_CALIBRATE);
        const reviews = await prisma.employeeReview.findMany({ where: { cycleId: cycle.id, OR: [{ finalRating: { not: null } }, { rawRating: { not: null } }], ...(scope ? { employeeId: { in: scope } } : {}) }, include: { employee: { select: { displayName: true, firstName: true, lastName: true, reportingManager: { select: { displayName: true, firstName: true, lastName: true } } } } } });
        const max = (cycle.ratingScale as { max?: number } | null)?.max ?? 5;
        const norm = normalizeRatings(reviews.map((r) => ({ id: r.id, manager: nameOf(r.employee.reportingManager) || "No manager", rating: Number(r.finalRating ?? r.rawRating) })), max);
        const name = new Map(reviews.map((r) => [r.id, nameOf(r.employee)]));
        return {
          title: `Normalised ratings — ${cycle.name}`,
          columns: [{ key: "employee", label: "Employee" }, { key: "manager", label: "Manager" }, { key: "rating", label: "Rating", format: "num" }, { key: "normalized", label: "Normalised", format: "num" }, { key: "delta", label: "Change", format: "num" }],
          rows: norm.map((r) => ({ reviewId: r.id, employee: name.get(r.id) ?? "", manager: r.manager, rating: r.rating, normalized: r.normalized, delta: r.delta })),
          notes: ["Each manager's ratings are shifted and scaled to the company's mean and spread, so a lenient or a harsh rater is evened out. Use it as a guide in calibration; it changes nothing by itself."],
        };
      }
      case "summaries": {
        if (!canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.PERFORMANCE_VIEW])) return null;
        const scope = await scopedEmployeeIds(viewer, P.PERFORMANCE_VIEW);
        const q = (sp.q ?? "").trim();
        const reviews = await prisma.employeeReview.findMany({
          where: { cycle: { tenantId: t, ...(sp.cycleId ? { id: sp.cycleId } : {}) }, ...(scope ? { employeeId: { in: scope } } : {}), ...(q ? { OR: [{ employee: { displayName: { contains: q, mode: "insensitive" } } }, { managerSummary: { contains: q, mode: "insensitive" } }] } : {}) },
          include: { band: true, cycle: true, responses: true, employee: { select: { id: true, displayName: true, firstName: true, lastName: true } } }, orderBy: { updatedAt: "desc" }, take: 300,
        });
        const scales = new Map((await prisma.insightRatingScale.findMany({ where: { tenantId: t } })).map((s) => [s.id, scalePointsOf(s.points)]));
        return {
          title: "Feedback summaries",
          columns: [{ key: "employee", label: "Employee" }, { key: "cycle", label: "Cycle" }, { key: "status", label: "Status" }, { key: "final", label: "Final", format: "num" }, { key: "band", label: "Band" }, { key: "responses", label: "Responses", format: "int" }, { key: "summary", label: "Summary" }],
          rows: reviews.map((r) => {
            const final = n(r.finalRating) ?? n(r.rawRating);
            const point = r.cycle.ratingScaleId ? describeRating(scales.get(r.cycle.ratingScaleId) ?? [], final) : null;
            return {
              reviewId: r.id, employee: nameOf(r.employee), cycle: r.cycle.name, status: r.status, final, band: r.band?.name ?? "", responses: r.responses.filter((x) => x.submittedAt).length,
              summary: r.managerSummary ?? performanceSummary({ name: nameOf(r.employee), cycle: r.cycle.name, rating: final, scaleMax: (r.cycle.ratingScale as { max?: number } | null)?.max ?? 5, band: r.band?.name ?? null, ratingLabel: point?.label ?? null, goalsTotal: 0, goalsCompleted: 0, avgGoalProgress: null, strengths: r.responses.map((x) => x.strengths ?? "").filter(Boolean).slice(0, 2), improvements: r.responses.map((x) => x.improvements ?? "").filter(Boolean).slice(0, 2), peerCount: r.responses.filter((x) => x.reviewerType === "PEER" && x.submittedAt).length, competencyScore: null, previousRating: null }),
            };
          }),
        };
      }
      case "campaigns": {
        if (!perfManager(viewer)) return null;
        const q = (sp.q ?? "").trim();
        const cycles = await prisma.reviewCycle.findMany({ where: { tenantId: t, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}), ...(sp.status ? { status: sp.status as never } : {}) }, include: { reviews: { include: { responses: { select: { reviewerType: true, submittedAt: true, status: true } } } } }, orderBy: { periodStart: "desc" } });
        const setting = await prisma.feedbackSetting.findUnique({ where: { tenantId: t } });
        return {
          title: "360 campaigns",
          columns: [{ key: "name", label: "Cycle" }, { key: "status", label: "Status" }, { key: "period", label: "Period" }, { key: "reviews", label: "Reviews", format: "int" }, { key: "slots", label: "360 requests", format: "int" }, { key: "submitted", label: "Submitted", format: "int" }, { key: "rate", label: "Response rate", format: "pct" }, { key: "anonymous", label: "Anonymous" }, { key: "maxPeers", label: "Max peers", format: "int" }],
          rows: cycles.map((c) => {
            const slots = c.reviews.flatMap((r) => r.responses).filter((x) => ["PEER", "SUBORDINATE", "SKIP_LEVEL"].includes(x.reviewerType) && x.status !== "DECLINED" && x.status !== "PROPOSED");
            const done = slots.filter((x) => x.submittedAt).length;
            return { id: c.id, name: c.name, status: c.status, period: `${c.periodStart.toISOString().slice(0, 10)} – ${c.periodEnd.toISOString().slice(0, 10)}`, reviews: c.reviews.length, slots: slots.length, submitted: done, rate: slots.length ? Math.round((done / slots.length) * 1000) / 10 : null, anonymous: c.anonymousFeedback ? `yes (min ${setting?.minAnonymousResponses ?? 3})` : "no", maxPeers: c.maxPeers };
          }),
        };
      }
      case "feedback": return feedbackTable(viewer, sp);
      case "feedback-requests": {
        const me = viewer.employee?.id ?? "__none__";
        const hr = can(viewer, P.PERFORMANCE_MANAGE);
        const scope = hr ? await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE) : null;
        const q = (sp.q ?? "").trim();
        const rows = await prisma.feedbackRequest.findMany({
          where: { tenantId: t, ...(hr ? (scope ? { OR: [{ aboutEmployeeId: { in: scope } }, { requesterId: me }, { askedId: me }] } : {}) : { OR: [{ requesterId: me }, { askedId: me }, { aboutEmployeeId: { in: [...viewer.allReportIds] } }] }), ...(sp.status ? { status: sp.status } : {}), ...(q ? { OR: [{ message: { contains: q, mode: "insensitive" } }, { asked: { displayName: { contains: q, mode: "insensitive" } } }, { requester: { displayName: { contains: q, mode: "insensitive" } } }] } : {}) },
          include: { requester: { select: { displayName: true, firstName: true, lastName: true } }, asked: { select: { displayName: true, firstName: true, lastName: true } } }, orderBy: { createdAt: "desc" }, take: 500,
        });
        return {
          title: "Feedback requests",
          columns: [{ key: "at", label: "Asked", format: "date" }, { key: "requester", label: "Asked by" }, { key: "asked", label: "Asked of" }, { key: "status", label: "Status" }, { key: "due", label: "Due", format: "date" }, { key: "responded", label: "Answered", format: "date" }, { key: "message", label: "Message" }],
          rows: rows.map((r) => ({ id: r.id, mine: r.requesterId === me, at: r.createdAt, requester: nameOf(r.requester), asked: nameOf(r.asked), status: r.status, due: r.dueDate, responded: r.respondedAt, message: r.message ?? "" })),
        };
      }
      case "feedback-templates": {
        if (!can(viewer, P.PERFORMANCE_MANAGE)) return null;
        const rows = await prisma.feedbackTemplate.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } });
        const uses = await prisma.feedback.groupBy({ by: ["templateId"], where: { tenantId: t, templateId: { not: null }, deletedAt: null }, _count: true });
        const sections = await prisma.reviewFormSection.findMany({ where: { cycle: { tenantId: t }, title: { startsWith: "360: " } }, select: { title: true } });
        return {
          title: "Feedback template report",
          columns: [{ key: "name", label: "Template" }, { key: "purpose", label: "Purpose" }, { key: "status", label: "Status" }, { key: "questions", label: "Questions", format: "int" }, { key: "uses", label: "Feedback given with it", format: "int" }, { key: "cycles", label: "Review forms using it", format: "int" }, { key: "updated", label: "Updated", format: "date" }],
          rows: rows.map((x) => ({ id: x.id, name: x.name, purpose: x.purpose, status: x.status, questions: x.questions.length, uses: uses.find((u) => u.templateId === x.id)?._count ?? 0, cycles: sections.filter((s) => s.title === `360: ${x.name}`).length, updated: x.updatedAt })),
        };
      }
      case "feedback-audit": return can(viewer, P.PERFORMANCE_MANAGE) ? auditTable(viewer, "Feedback audit history", FEEDBACK_AUDIT_TYPES) : null;
      // ---- OKRs --------------------------------------------------------------
      case "okr":
      case "okr-checkins": {
        const manage = can(viewer, P.GOALS_MANAGE);
        const me = viewer.employee?.id ?? "__none__";
        const scope = manage ? await scopedEmployeeIds(viewer, P.GOALS_MANAGE) : null;
        const own = { OR: [{ employeeId: me }, { employeeId: { in: [...viewer.allReportIds] } }, { employeeId: null, visibility: "EVERYONE" }] };
        const where = { tenantId: t, ...(manage ? (scope ? { OR: [{ employeeId: { in: scope } }, { employeeId: null }] } : {}) : own), ...(sp.timeframe ? { timeframe: sp.timeframe } : {}), ...(sp.level ? { level: sp.level as never } : {}) };
        const setting = await prisma.insightOkrSetting.findUnique({ where: { tenantId: t } });
        if (name === "okr-checkins") {
          const rows = await prisma.goalCheckIn.findMany({ where: { goal: where }, include: { goal: { select: { title: true } } }, orderBy: { recordedAt: "desc" }, take: 2000 });
          const emps = new Map((await prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.recordedBy).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, firstName: true, lastName: true } })).map((e) => [e.id, nameOf(e)]));
          return {
            title: "Key result check-ins",
            columns: [{ key: "at", label: "When", format: "date" }, { key: "goal", label: "Goal / key result" }, { key: "value", label: "Value", format: "num" }, { key: "progress", label: "Progress", format: "pct" }, { key: "confidence", label: "Confidence (0–10)", format: "int" }, { key: "by", label: "By" }, { key: "note", label: "Note" }],
            rows: rows.map((c) => ({ at: c.recordedAt, goal: c.goal.title, value: Number(c.value), progress: Number(c.progressPercent), confidence: c.confidence, by: c.recordedBy ? emps.get(c.recordedBy) ?? "" : c.source, note: c.note ?? "" })),
          };
        }
        const goals = await prisma.goal.findMany({ where, include: { employee: { select: { displayName: true, firstName: true, lastName: true } }, parentGoal: { select: { title: true } }, checkIns: { orderBy: { recordedAt: "desc" }, take: 1 } }, orderBy: [{ level: "asc" }, { title: "asc" }] });
        return {
          title: "OKR export",
          columns: [{ key: "level", label: "Level" }, { key: "title", label: "Objective / key result" }, { key: "owner", label: "Owner" }, { key: "timeframe", label: "Timeframe" }, { key: "parent", label: "Aligned to" }, { key: "start", label: "Start", format: "num" }, { key: "target", label: "Target", format: "num" }, { key: "stretch", label: "Stretch", format: "num" }, { key: "current", label: "Current", format: "num" }, { key: "progress", label: "Progress", format: "pct" }, { key: "status", label: "Status" }, { key: "confidence", label: "Confidence" }, { key: "cadence", label: "Check-in cadence" }, { key: "lastCheckIn", label: "Last check-in", format: "date" }, { key: "overdue", label: "Check-in overdue" }, { key: "approval", label: "Approval" }],
          rows: goals.map((g) => {
            const cadence = g.checkInCadence ?? setting?.defaultCadence ?? "MONTHLY";
            const live = ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"].includes(g.status);
            return { id: g.id, employeeId: g.employeeId, level: g.level, title: g.title, owner: g.employee ? nameOf(g.employee) : g.level === "COMPANY" ? "Company" : "Department", timeframe: g.timeframe ?? "", parent: g.parentGoal?.title ?? "", start: Number(g.startValue), target: Number(g.targetValue), stretch: n(g.stretchValue), current: Number(g.currentValue), progress: Number(g.progressPercent), status: g.status, confidence: g.confidence === null ? "" : `${g.confidence} (${confidenceLabel(g.confidence)?.toLowerCase()})`, cadence, lastCheckIn: g.checkIns[0]?.recordedAt ?? null, overdue: live && checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, cadence, setting?.graceDays ?? 3).overdue ? "yes" : "", approval: g.approvalStatus ?? "" };
          }),
        };
      }
      case "okr-audit": return canAny(viewer, [P.GOALS_MANAGE, P.AUDIT_LOG_VIEW]) ? auditTable(viewer, "OKR audit history", GOAL_AUDIT_TYPES) : null;
      // ---- PIPs --------------------------------------------------------------
      case "pip-checkins": {
        if (!can(viewer, P.PIP_MANAGE)) return null;
        const scope = await scopedEmployeeIds(viewer, P.PIP_MANAGE);
        const rows = await prisma.pipCheckIn.findMany({ where: { pip: { tenantId: t, ...(scope ? { employeeId: { in: scope } } : {}) } }, include: { pip: { include: { employee: { select: { displayName: true, firstName: true, lastName: true } } } } }, orderBy: { heldOn: "desc" }, take: 2000 });
        return {
          title: "Improvement plan check-ins",
          columns: [{ key: "held", label: "Held", format: "date" }, { key: "employee", label: "Employee" }, { key: "progress", label: "Progress" }, { key: "notes", label: "Notes" }, { key: "ack", label: "Acknowledged", format: "date" }, { key: "comment", label: "Employee comment" }, { key: "signoff", label: "HR sign-off" }],
          rows: rows.map((c) => ({ held: c.heldOn, employee: nameOf(c.pip.employee), progress: c.progress, notes: c.notes, ack: c.acknowledgedAt, comment: c.employeeComment ?? "", signoff: c.signoffStatus ?? "" })),
        };
      }
      case "pip-register": {
        if (!can(viewer, P.PIP_MANAGE)) return null;
        const scope = await scopedEmployeeIds(viewer, P.PIP_MANAGE);
        const pips = await prisma.improvementPlan.findMany({ where: { tenantId: t, ...(scope ? { employeeId: { in: scope } } : {}) }, include: { employee: { select: { displayName: true, firstName: true, lastName: true } }, checkIns: true, milestones: true }, orderBy: { startDate: "desc" } });
        const [objs, checks, logs] = await Promise.all([
          prisma.insightPipObjective.findMany({ where: { tenantId: t, pipId: { in: pips.map((p) => p.id) } } }),
          prisma.insightPipChecklistItem.findMany({ where: { tenantId: t, pipId: { in: pips.map((p) => p.id) } } }),
          prisma.insightBehaviorLog.findMany({ where: { tenantId: t, pipId: { in: pips.map((p) => p.id) } } }),
        ]);
        return {
          title: "Improvement plan register",
          columns: [{ key: "employee", label: "Employee" }, { key: "start", label: "Start", format: "date" }, { key: "end", label: "End", format: "date" }, { key: "status", label: "Status" }, { key: "outcome", label: "Outcome" }, { key: "objectives", label: "Objectives met" }, { key: "checklist", label: "Checklist done" }, { key: "risk", label: "Risk" }, { key: "behaviour", label: "Behaviour trend" }],
          rows: pips.map((p) => {
            const o = objs.filter((x) => x.pipId === p.id), c = checks.filter((x) => x.pipId === p.id), b = behaviourTrend(logs.filter((x) => x.pipId === p.id));
            return { id: p.id, employee: nameOf(p.employee), start: p.startDate, end: p.endDate, status: p.status, outcome: p.outcome ?? p.proposedOutcome ?? "", objectives: `${o.filter((x) => x.status === "MET").length}/${o.length}`, checklist: `${c.filter((x) => x.doneAt).length}/${c.length}`, risk: p.status === "ACTIVE" ? pipRisk(p.checkIns, p.milestones.filter((m) => m.status === "MISSED").length) : "", behaviour: b.trend ? `${b.trend.toLowerCase()} (avg ${b.average})` : "" };
          }),
        };
      }
      case "perf-risk": {
        if (!canAny(viewer, [P.PIP_MANAGE, P.PERFORMANCE_MANAGE]) && viewer.allReportIds.size === 0) return null;
        const scope = canAny(viewer, [P.PIP_MANAGE, P.PERFORMANCE_MANAGE]) ? await scopedEmployeeIds(viewer, P.PIP_MANAGE) : [...viewer.allReportIds];
        const emps = await prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED", "PREBOARDING"] }, ...(scope ? { id: { in: scope } } : {}) }, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, department: { select: { name: true } } } });
        const ids = emps.map((e) => e.id);
        const since = new Date(Date.now() - 90 * DAY);
        const [reviews, goals, pips, neg] = await Promise.all([
          prisma.employeeReview.findMany({ where: { employeeId: { in: ids }, finalRating: { not: null } }, select: { employeeId: true, finalRating: true, cycle: { select: { periodEnd: true } } }, orderBy: { cycle: { periodEnd: "asc" } } }),
          prisma.goal.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] } }, select: { employeeId: true, status: true, startDate: true, checkInCadence: true, checkIns: { orderBy: { recordedAt: "desc" }, take: 1, select: { recordedAt: true } } } }),
          prisma.improvementPlan.findMany({ where: { tenantId: t, employeeId: { in: ids }, status: "ACTIVE" }, select: { employeeId: true } }),
          prisma.feedback.groupBy({ by: ["aboutEmployeeId"], where: { tenantId: t, aboutEmployeeId: { in: ids }, sentiment: "NEGATIVE", deletedAt: null, createdAt: { gte: since } }, _count: true }),
        ]);
        const rows = emps.map((e) => {
          const rs = reviews.filter((r) => r.employeeId === e.id).map((r) => Number(r.finalRating));
          const gs = goals.filter((g) => g.employeeId === e.id);
          const risk = performanceRisk({ lastRating: rs[rs.length - 1] ?? null, ratingDrop: rs.length >= 2 ? Math.round((rs[rs.length - 2]! - rs[rs.length - 1]!) * 100) / 100 : null, goals: gs.length, goalsAtRisk: gs.filter((g) => g.status !== "ON_TRACK").length, activePip: pips.some((p) => p.employeeId === e.id), negativeFeedback90d: neg.find((x) => x.aboutEmployeeId === e.id)?._count ?? 0, overdueCheckIns: gs.filter((g) => checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, g.checkInCadence ?? "MONTHLY", 3).overdue).length });
          return { employeeId: e.id, number: e.employeeNumber, name: nameOf(e), department: e.department?.name ?? "", score: risk.score, band: risk.band, reasons: risk.reasons.join("; ") };
        }).filter((r) => r.score > 0 || sp.all === "1").sort((a, b) => b.score - a.score);
        return {
          title: "Performance risk indicators",
          columns: [{ key: "number", label: "No." }, { key: "name", label: "Employee" }, { key: "department", label: "Department" }, { key: "score", label: "Risk (0–100)", format: "int" }, { key: "band", label: "Band" }, { key: "reasons", label: "Why" }],
          rows,
        };
      }
      default: return null;
    }
  })();
  if (!table) return null;
  // A calculated field, when asked for, becomes one more column.
  if (sp.calc) {
    const label = (sp.calcName ?? "Calculated").slice(0, 60) || "Calculated";
    table.columns = [...table.columns, { key: "__calc", label, format: "num" }];
    table.rows = table.rows.map((r) => ({ ...r, __calc: evalCalculatedField(sp.calc!, r) }));
  }
  return table;
}

/** Who may see, edit or manage a dashboard. */
export async function dashboardAccess(viewer: Viewer, d: { ownerUserId: string; visibility: string; status: string; shares: Array<{ userId: string; canEdit: boolean; expiresAt: Date | null }> }): Promise<{ view: boolean; edit: boolean; owner: boolean }> {
  const owner = d.ownerUserId === viewer.user.id;
  const share = d.shares.find((s) => s.userId === viewer.user.id && (!s.expiresAt || s.expiresAt > new Date()));
  // Published company-wide (after approval): everyone, with role-based widgets deciding what each sees.
  const org = d.visibility === "ORG" && d.status === "PUBLISHED";
  return { owner, view: owner || !!share || org, edit: owner || !!share?.canEdit };
}
