"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, metricKeyOf, thresholdProblem, kraWeightProblem, isPeriodKey, parseCalculatedField, INSIGHT_CALCULATORS, METRIC_CATEGORIES, METRIC_UNITS,
  computeAndStoreMetric, recordKpiReading, notify, computeKpiFromMetric, refreshInsightDashboard, cohortFiltersOf, nextReportRun, cleanEmails, invalidEmails,
  type InsightWorkflowType,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, actionDone, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, DENIED, no } from "@/lib/cases-docs";
import { REPORTS } from "@/lib/reports";
import { runDataset, dashboardAccess, canOpenReport } from "@/lib/insight/datasets";
import { recordReportRun } from "@/lib/insight/export";
import { routeExternalSchedule } from "@/lib/insight/schedules";
import { savedReportFor } from "@/lib/report-builder";

/**
 * Insights › reporting and analytics: the governed metric catalog, KRAs and
 * KPIs, the dashboard builder (/storyboards), report access, export
 * profiles and approvals, filter presets, snapshots, schedule maintenance,
 * custom-report publishing, cohorts and hiring costs. Every change is
 * permission-checked and audited; approvals run on the workflow engine.
 */

const P = PERMISSIONS;
const METRIC_PATHS = ["/insights", "/insights/metrics"];
const KPI_PATHS = ["/insights/kpis", "/insights"];
const REPORT_PATHS = ["/insights/reports", "/reports", "/reports/builder"];

async function audit(v: Viewer, module: "ANALYTICS" | "REPORT" | "EMPLOYEE", action: "CREATE" | "UPDATE" | "DELETE" | "EXPORT" | "VIEW", entityType: string, entityId: string | null, summary: string) {
  await writeAudit(v, { module, action, entityType, entityId, summary });
}

/** Start an insight approval and remember the request on the record. */
async function submit(v: Viewer, type: InsightWorkflowType, entityId: string, title: string, link: string, opts: { details?: string | null; changeKind?: string | null; subjectEmployeeId?: string | null } = {}): Promise<{ ok: boolean; message: string; requestId?: string }> {
  const wf = await startWorkflow({
    tenantId: v.tenantId, entityType: type, entityId, title, details: opts.details ?? null, requesterUserId: v.user.id,
    subjectEmployeeId: opts.subjectEmployeeId ?? v.employee?.id ?? null, changeKind: opts.changeKind ?? null, data: { link },
  });
  return wf;
}

const num = (fd: FormData, k: string) => { const n = money(fd, k); return n === null || Number.isNaN(n) ? null : n; };

// ---------------------------------------------------------------------------
//  Metric catalog
// ---------------------------------------------------------------------------

/** Create a metric, or a new version of an approved one (the approved version stays in force until the new one is approved). */
export async function saveMetricAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  const calculator = str(fd, "calculator");
  const calc = INSIGHT_CALCULATORS[calculator];
  if (name.length < 2) return { ok: false, message: "Name the metric.", errors: { name: "Required" } };
  if (!calc) return { ok: false, message: "Choose how the metric is calculated.", errors: { calculator: "Required" } };
  const category = str(fd, "category") || calc.category;
  if (!(category in METRIC_CATEGORIES)) return no("Unknown category.");
  const unit = str(fd, "unit") || calc.unit;
  if (!(unit in METRIC_UNITS)) return no("Unknown unit.");
  const direction = ["UP_GOOD", "DOWN_GOOD", "NEUTRAL"].includes(str(fd, "direction")) ? str(fd, "direction") : calc.direction;
  const warnAt = num(fd, "warnAt"), alertAt = num(fd, "alertAt");
  const tp = thresholdProblem(warnAt, alertAt, direction);
  if (tp) return { ok: false, message: tp, errors: { alertAt: tp } };
  const months = int(fd, "months");
  if (months !== null && (Number.isNaN(months) || months < 1 || months > 36)) return { ok: false, message: "The window is 1–36 months.", errors: { months: "1–36" } };
  const departmentId = optStr(fd, "departmentId");
  if (departmentId && !(await prisma.department.findFirst({ where: { id: departmentId, tenantId: v.tenantId } }))) return no("Unknown department.");
  const ownerUserId = optStr(fd, "ownerUserId");
  if (ownerUserId && !(await prisma.user.findFirst({ where: { id: ownerUserId, tenantId: v.tenantId } }))) return no("Unknown owner.");
  const data = { name, category, calculator, unit, direction, warnAt, alertAt, ownerUserId, description: optStr(fd, "description"), formula: optStr(fd, "formula") ?? calc.formula, params: { departmentId, months } };
  const id = optStr(fd, "id");
  if (id) {
    const m = await prisma.insightMetric.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!m) return no("Metric not found.");
    if (m.status === "PENDING_APPROVAL") return no("This version is waiting for approval; wait for the decision or withdraw it.");
    if (m.status === "DRAFT" || m.status === "REJECTED") {
      await prisma.insightMetric.update({ where: { id }, data: { ...data, status: "DRAFT" } });
      await audit(v, "ANALYTICS", "UPDATE", "InsightMetric", id, `Metric ${name} v${m.version} edited`);
      return actionDone(METRIC_PATHS, "Saved. Submit it for approval to put it in force.");
    }
    const latest = await prisma.insightMetric.findFirst({ where: { tenantId: v.tenantId, key: m.key }, orderBy: { version: "desc" } });
    if (latest && latest.id !== m.id && latest.status !== "APPROVED" && latest.status !== "RETIRED") return no(`Version ${latest.version} is already being drafted; edit that one.`);
    const next = await prisma.insightMetric.create({ data: { tenantId: v.tenantId, key: m.key, version: (latest?.version ?? m.version) + 1, previousId: m.id, status: "DRAFT", createdBy: v.user.id, ...data } });
    await audit(v, "ANALYTICS", "CREATE", "InsightMetric", next.id, `Metric ${name} v${next.version} drafted (replaces v${m.version} once approved)`);
    return actionDone(METRIC_PATHS, `Version ${next.version} drafted. v${m.version} stays in force until it is approved.`);
  }
  const key = metricKeyOf(str(fd, "key") || name);
  if (await prisma.insightMetric.findFirst({ where: { tenantId: v.tenantId, key } })) return { ok: false, message: `A metric with the key ${key} exists; edit it to make a new version.`, errors: { name: "Exists" } };
  const m = await prisma.insightMetric.create({ data: { tenantId: v.tenantId, key, version: 1, status: "DRAFT", createdBy: v.user.id, ...data } });
  await audit(v, "ANALYTICS", "CREATE", "InsightMetric", m.id, `Metric ${name} (${key}) defined`);
  return actionDone(METRIC_PATHS, "Metric drafted. Submit it for approval to put it in force.");
}

export async function submitMetricAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const m = await prisma.insightMetric.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!m) return no("Metric not found.");
  if (m.status !== "DRAFT" && m.status !== "REJECTED") return no("Only a draft can be submitted.");
  await prisma.insightMetric.update({ where: { id: m.id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await submit(v, "INSIGHT_METRIC", m.id, `Approve metric ${m.name} v${m.version}`, "/insights/metrics", { details: m.formula });
  if (!wf.ok) { await prisma.insightMetric.update({ where: { id: m.id }, data: { status: "DRAFT" } }); return no(wf.message); }
  await prisma.insightMetric.updateMany({ where: { id: m.id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightMetric", m.id, `Metric ${m.name} v${m.version} submitted for approval`);
  return actionDone(METRIC_PATHS, wf.message);
}

export async function computeMetricAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ANALYTICS_VIEW)) return DENIED;
  const m = await prisma.insightMetric.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!m) return no("Metric not found.");
  const r = await computeAndStoreMetric(v.tenantId, m.id);
  await audit(v, "ANALYTICS", "UPDATE", "InsightMetric", m.id, `Metric ${m.name} computed: ${r.value ?? "no value"}`);
  return actionDone(METRIC_PATHS, `${m.name}: ${r.value ?? "no data"}${r.state !== "OK" ? ` (${r.state.toLowerCase()})` : ""}.`);
}

export async function retireMetricAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const m = await prisma.insightMetric.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!m) return no("Metric not found.");
  if (m.status === "PENDING_APPROVAL") return no("Wait for the approval to finish first.");
  await prisma.insightMetric.update({ where: { id: m.id }, data: { status: "RETIRED" } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightMetric", m.id, `Metric ${m.name} v${m.version} retired`);
  return actionDone(METRIC_PATHS, "Retired.");
}

// ---------------------------------------------------------------------------
//  KRAs and KPIs
// ---------------------------------------------------------------------------

export async function saveKraAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PERFORMANCE_MANAGE)) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the KRA.", errors: { name: "Required" } };
  const weight = num(fd, "weight") ?? 0;
  if (weight < 0 || weight > 100) return { ok: false, message: "Weight is 0–100.", errors: { weight: "0–100" } };
  const jobTitle = optStr(fd, "jobTitle")?.slice(0, 120) ?? null;
  const departmentId = optStr(fd, "departmentId");
  if (departmentId && !(await prisma.department.findFirst({ where: { id: departmentId, tenantId: v.tenantId } }))) return no("Unknown department.");
  const id = optStr(fd, "id");
  const prev = id ? await prisma.insightKra.findFirst({ where: { id, tenantId: v.tenantId } }) : null;
  if (id && !prev) return no("KRA not found.");
  // Weights of the role's live KRAs (latest version of each) stay within 100.
  const live = await prisma.insightKra.findMany({ where: { tenantId: v.tenantId, jobTitle, status: { in: ["APPROVED", "DRAFT", "PENDING_APPROVAL"] } }, orderBy: { version: "desc" } });
  const latestByName = new Map<string, number>();
  for (const k of live) if (!latestByName.has(k.name)) latestByName.set(k.name, Number(k.weight));
  latestByName.set(prev?.name ?? name, weight);
  const wp = kraWeightProblem([...latestByName.values()]);
  if (wp) return { ok: false, message: wp, errors: { weight: wp } };
  const data = { name, description: optStr(fd, "description"), jobTitle, departmentId, weight };
  if (prev && (prev.status === "DRAFT" || prev.status === "REJECTED")) {
    await prisma.insightKra.update({ where: { id: prev.id }, data: { ...data, status: "DRAFT" } });
    await audit(v, "EMPLOYEE", "UPDATE", "InsightKra", prev.id, `KRA ${name} v${prev.version} edited`);
    return actionDone(["/insights/kpis", "/performance/operations"], "Saved.");
  }
  if (prev?.status === "PENDING_APPROVAL") return no("This version is waiting for approval.");
  if (prev) {
    const latest = await prisma.insightKra.findFirst({ where: { tenantId: v.tenantId, name: prev.name }, orderBy: { version: "desc" } });
    const k = await prisma.insightKra.create({ data: { tenantId: v.tenantId, ...data, name: prev.name, version: (latest?.version ?? prev.version) + 1, previousId: prev.id, createdBy: v.user.id } });
    await audit(v, "EMPLOYEE", "CREATE", "InsightKra", k.id, `KRA ${prev.name} v${k.version} drafted`);
    return actionDone(["/insights/kpis", "/performance/operations"], `Version ${k.version} drafted.`);
  }
  if (await prisma.insightKra.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "A KRA with this name exists; edit it.", errors: { name: "Exists" } };
  const k = await prisma.insightKra.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  await audit(v, "EMPLOYEE", "CREATE", "InsightKra", k.id, `KRA ${name} created${jobTitle ? ` for ${jobTitle}` : ""}`);
  return actionDone(["/insights/kpis", "/performance/operations"], "KRA drafted. Submit it for approval.");
}

export async function submitKraAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PERFORMANCE_MANAGE)) return DENIED;
  const k = await prisma.insightKra.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!k) return no("KRA not found.");
  if (k.status !== "DRAFT" && k.status !== "REJECTED") return no("Only a draft can be submitted.");
  await prisma.insightKra.update({ where: { id: k.id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await submit(v, "INSIGHT_KRA", k.id, `Approve KRA ${k.name} v${k.version}`, "/insights/kpis?tab=kras", { details: k.description });
  if (!wf.ok) { await prisma.insightKra.update({ where: { id: k.id }, data: { status: "DRAFT" } }); return no(wf.message); }
  await prisma.insightKra.updateMany({ where: { id: k.id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "EMPLOYEE", "UPDATE", "InsightKra", k.id, `KRA ${k.name} v${k.version} submitted for approval`);
  return actionDone(["/insights/kpis"], wf.message);
}

const kpiManager = (v: Viewer) => canAny(v, [P.PERFORMANCE_MANAGE, P.REPORT_BUILD]);

export async function saveKpiAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!kpiManager(v)) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the KPI.", errors: { name: "Required" } };
  const calcKind = str(fd, "calcKind") === "METRIC" ? "METRIC" : "MANUAL";
  const metricKey = calcKind === "METRIC" ? optStr(fd, "metricKey") : null;
  if (calcKind === "METRIC" && (!metricKey || !(await prisma.insightMetric.findFirst({ where: { tenantId: v.tenantId, key: metricKey } })))) return { ok: false, message: "Choose the metric the KPI is calculated from.", errors: { metricKey: "Required" } };
  const kraId = optStr(fd, "kraId");
  if (kraId && !(await prisma.insightKra.findFirst({ where: { id: kraId, tenantId: v.tenantId } }))) return no("Unknown KRA.");
  const ownerEmployeeId = optStr(fd, "ownerEmployeeId");
  if (ownerEmployeeId && !(await prisma.employee.findFirst({ where: { id: ownerEmployeeId, tenantId: v.tenantId } }))) return no("Unknown owner.");
  const greenAt = num(fd, "greenAt") ?? 100, amberAt = num(fd, "amberAt") ?? 80;
  if (amberAt > greenAt) return { ok: false, message: "Amber starts below green.", errors: { amberAt: "Below green" } };
  const data = {
    name, description: optStr(fd, "description"), unit: str(fd, "unit") in METRIC_UNITS ? str(fd, "unit") : "COUNT",
    direction: str(fd, "direction") === "DOWN_GOOD" ? "DOWN_GOOD" : "UP_GOOD", calcKind, metricKey, kraId, ownerEmployeeId,
    frequency: str(fd, "frequency") === "QUARTERLY" ? "QUARTERLY" : "MONTHLY", greenAt, amberAt, isActive: fd.has("isActive") ? bool(fd, "isActive") : true,
  };
  const id = optStr(fd, "id");
  if (id) {
    const k = await prisma.insightKpi.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!k) return no("KPI not found.");
    if (name !== k.name && (await prisma.insightKpi.findFirst({ where: { tenantId: v.tenantId, name } }))) return { ok: false, message: "Another KPI has this name.", errors: { name: "Exists" } };
    await prisma.insightKpi.update({ where: { id }, data });
    await audit(v, "ANALYTICS", "UPDATE", "InsightKpi", id, `KPI ${name} updated${ownerEmployeeId !== k.ownerEmployeeId ? " (owner changed)" : ""}`);
    return actionDone(KPI_PATHS, "Saved.");
  }
  if (await prisma.insightKpi.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "A KPI with this name exists.", errors: { name: "Exists" } };
  const k = await prisma.insightKpi.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  const target = num(fd, "target");
  if (target !== null) await prisma.insightKpiTarget.create({ data: { tenantId: v.tenantId, kpiId: k.id, version: 1, target, stretch: num(fd, "stretch"), effectiveFrom: day(fd, "effectiveFrom") ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)), reason: "Initial target", createdBy: v.user.id } });
  await audit(v, "ANALYTICS", "CREATE", "InsightKpi", k.id, `KPI ${name} created (${calcKind === "METRIC" ? `from ${metricKey}` : "manual"})`);
  return actionDone(KPI_PATHS, "KPI created.");
}

/** A new target version; earlier versions stay for the periods they covered. */
export async function addKpiTargetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!kpiManager(v)) return DENIED;
  const k = await prisma.insightKpi.findFirst({ where: { id: str(fd, "kpiId"), tenantId: v.tenantId }, include: { targets: true } });
  if (!k) return no("KPI not found.");
  const target = num(fd, "target");
  if (target === null) return { ok: false, message: "Enter the target.", errors: { target: "Required" } };
  const stretch = num(fd, "stretch");
  if (stretch !== null && (k.direction === "DOWN_GOOD" ? stretch > target : stretch < target)) return { ok: false, message: "A stretch target goes beyond the target.", errors: { stretch: "Beyond the target" } };
  const effectiveFrom = day(fd, "effectiveFrom");
  if (!effectiveFrom) return { ok: false, message: "Pick when it takes effect.", errors: { effectiveFrom: "Required" } };
  const version = Math.max(0, ...k.targets.map((t) => t.version)) + 1;
  await prisma.insightKpiTarget.create({ data: { tenantId: v.tenantId, kpiId: k.id, version, target, stretch, effectiveFrom, reason: optStr(fd, "reason"), createdBy: v.user.id } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightKpi", k.id, `KPI ${k.name} target v${version}: ${target} from ${effectiveFrom.toISOString().slice(0, 10)}`);
  return actionDone(KPI_PATHS, `Target version ${version} saved.`);
}

/** Record a reading: KPI managers, or the KPI's owner. */
export async function recordKpiReadingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const k = await prisma.insightKpi.findFirst({ where: { id: str(fd, "kpiId"), tenantId: v.tenantId } });
  if (!k) return no("KPI not found.");
  if (!kpiManager(v) && (!v.employee || v.employee.id !== k.ownerEmployeeId)) return DENIED;
  const period = str(fd, "period");
  if (!isPeriodKey(period)) return { ok: false, message: "Period is YYYY-MM.", errors: { period: "YYYY-MM" } };
  const value = num(fd, "value");
  if (value === null) return { ok: false, message: "Enter the value.", errors: { value: "Required" } };
  const r = await recordKpiReading(v.tenantId, k.id, period, value, { note: optStr(fd, "note"), byUserId: v.user.id });
  if (r.ok) await audit(v, "ANALYTICS", "UPDATE", "InsightKpi", k.id, `KPI ${k.name} ${period}: ${value}${r.rag ? ` (${r.rag})` : ""}`);
  return r.ok ? actionDone(KPI_PATHS, r.message) : no(r.message);
}

export async function computeKpiAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!kpiManager(v)) return DENIED;
  const k = await prisma.insightKpi.findFirst({ where: { id: str(fd, "kpiId"), tenantId: v.tenantId } });
  if (!k) return no("KPI not found.");
  const r = await computeKpiFromMetric(v.tenantId, k.id);
  if (r.ok) await audit(v, "ANALYTICS", "UPDATE", "InsightKpi", k.id, `KPI ${k.name} computed from ${k.metricKey}`);
  return r.ok ? actionDone(KPI_PATHS, r.message) : no(r.message);
}

// ---------------------------------------------------------------------------
//  Dashboard builder (/storyboards)
// ---------------------------------------------------------------------------

async function dashboardFor(v: Viewer, id: string) {
  const d = await prisma.insightDashboard.findFirst({ where: { id, tenantId: v.tenantId }, include: { shares: true, widgets: true } });
  if (!d) return null;
  return { d, access: await dashboardAccess(v, d) };
}
const dashPaths = (id: string) => ["/storyboards", `/storyboards/${id}`];

export async function createDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.ANALYTICS_VIEW, P.REPORT_VIEW])) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the dashboard.", errors: { name: "Required" } };
  const kind = str(fd, "kind") === "KPI" ? "KPI" : "CUSTOM";
  const d = await prisma.insightDashboard.create({ data: { tenantId: v.tenantId, name, description: optStr(fd, "description"), kind, ownerUserId: v.user.id } });
  // A KPI dashboard starts with every active KPI.
  if (kind === "KPI") {
    const kpis = await prisma.insightKpi.findMany({ where: { tenantId: v.tenantId, isActive: true }, orderBy: { name: "asc" }, take: 24 });
    if (kpis.length) await prisma.insightDashboardWidget.createMany({ data: kpis.map((k, i) => ({ dashboardId: d.id, title: k.name, source: "KPI", refKey: k.id, viz: "TREND", position: i })) });
    await refreshInsightDashboard(v.tenantId, d.id);
  }
  await audit(v, "ANALYTICS", "CREATE", "InsightDashboard", d.id, `Dashboard ${name} created${kind === "KPI" ? " (KPI)" : ""}`);
  return { ...actionDone(["/storyboards"], "Dashboard created."), values: { id: d.id } };
}

export async function updateDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "id"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.edit) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the dashboard.", errors: { name: "Required" } };
  await prisma.insightDashboard.update({ where: { id: x.d.id }, data: { name, description: optStr(fd, "description") } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Dashboard ${name} edited`);
  return actionDone(dashPaths(x.d.id), "Saved.");
}

export async function deleteDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "id"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.owner) return no("Only the owner can delete a dashboard.");
  await prisma.insightDashboard.delete({ where: { id: x.d.id } });
  await audit(v, "ANALYTICS", "DELETE", "InsightDashboard", x.d.id, `Dashboard ${x.d.name} deleted`);
  return actionDone(["/storyboards"], "Deleted.");
}

export async function addWidgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "dashboardId"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.edit) return DENIED;
  const ref = str(fd, "ref");
  const [source, refKey] = [ref.split(":")[0], ref.split(":").slice(1).join(":")];
  let title = str(fd, "title").slice(0, 120);
  if (source === "METRIC") {
    const m = await prisma.insightMetric.findFirst({ where: { tenantId: v.tenantId, key: refKey, status: "APPROVED" } });
    if (!m) return { ok: false, message: "Choose an approved metric.", errors: { ref: "Required" } };
    title ||= m.name;
  } else if (source === "KPI") {
    const k = await prisma.insightKpi.findFirst({ where: { tenantId: v.tenantId, id: refKey } });
    if (!k) return { ok: false, message: "Choose a KPI.", errors: { ref: "Required" } };
    title ||= k.name;
  } else return { ok: false, message: "Choose what the widget shows.", errors: { ref: "Required" } };
  if (x.d.widgets.length >= 24) return no("A dashboard holds up to 24 widgets.");
  const w = await prisma.insightDashboardWidget.create({ data: { dashboardId: x.d.id, title, source: source!, refKey: refKey!, viz: str(fd, "viz") === "TREND" ? "TREND" : "NUMBER", roles: formList(fd, "roles").slice(0, 10), position: x.d.widgets.length } });
  await refreshInsightDashboard(v.tenantId, x.d.id);
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Widget ${title} added to ${x.d.name}`);
  return actionDone(dashPaths(x.d.id), `Widget ${w.title} added.`);
}

export async function updateWidgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const w = await prisma.insightDashboardWidget.findFirst({ where: { id: str(fd, "id"), dashboard: { tenantId: v.tenantId } } });
  if (!w) return no("Widget not found.");
  const x = await dashboardFor(v, w.dashboardId);
  if (!x?.access.edit) return DENIED;
  const move = str(fd, "move");
  if (move === "up" || move === "down") {
    const list = [...x.d.widgets].sort((a, b) => a.position - b.position);
    const i = list.findIndex((y) => y.id === w.id), j = move === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j]!, list[i]!]; await prisma.$transaction(list.map((y, k) => prisma.insightDashboardWidget.update({ where: { id: y.id }, data: { position: k } }))); }
    return actionDone(dashPaths(x.d.id), "Moved.");
  }
  await prisma.insightDashboardWidget.update({ where: { id: w.id }, data: { title: str(fd, "title").slice(0, 120) || w.title, viz: str(fd, "viz") === "TREND" ? "TREND" : str(fd, "viz") === "NUMBER" ? "NUMBER" : w.viz, roles: fd.has("rolesSet") ? formList(fd, "roles").slice(0, 10) : w.roles } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Widget ${w.title} on ${x.d.name} changed`);
  return actionDone(dashPaths(x.d.id), "Saved.");
}

export async function removeWidgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const w = await prisma.insightDashboardWidget.findFirst({ where: { id: str(fd, "id"), dashboard: { tenantId: v.tenantId } } });
  if (!w) return no("Widget not found.");
  const x = await dashboardFor(v, w.dashboardId);
  if (!x?.access.edit) return DENIED;
  await prisma.insightDashboardWidget.delete({ where: { id: w.id } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Widget ${w.title} removed from ${x.d.name}`);
  return actionDone(dashPaths(x.d.id), "Removed.");
}

export async function refreshDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "id"));
  if (!x?.access.view) return no("Dashboard not found.");
  const r = await refreshInsightDashboard(v.tenantId, x.d.id);
  return actionDone(dashPaths(x.d.id), `Refreshed in ${r.ms} ms — ${r.status.toLowerCase()}.`);
}

/** Share with a colleague, optionally until a date and with edit rights. */
export async function shareDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "dashboardId"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.owner) return no("Only the owner can share a dashboard.");
  const emp = await prisma.employee.findFirst({ where: { id: str(fd, "employeeId"), tenantId: v.tenantId }, select: { userId: true, displayName: true } });
  if (!emp?.userId) return { ok: false, message: "That person cannot sign in.", errors: { employeeId: "No login" } };
  if (emp.userId === v.user.id) return { ok: false, message: "You already own it.", errors: { employeeId: "That's you" } };
  const until = day(fd, "expiresAt");
  if (until && until.getTime() <= Date.now()) return { ok: false, message: "The expiry must be in the future.", errors: { expiresAt: "Future date" } };
  const canEdit = bool(fd, "canEdit");
  await prisma.insightDashboardShare.upsert({ where: { dashboardId_userId: { dashboardId: x.d.id, userId: emp.userId } }, create: { dashboardId: x.d.id, userId: emp.userId, canEdit, expiresAt: until }, update: { canEdit, expiresAt: until } });
  await notify({ tenantId: v.tenantId, userIds: [emp.userId], kind: "ANALYTICS", title: `${v.employee?.displayName ?? v.user.email} shared the dashboard ${x.d.name} with you`, link: `/storyboards/${x.d.id}` });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Dashboard ${x.d.name} shared with ${emp.displayName}${canEdit ? " (can edit)" : ""}${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}`);
  return actionDone(dashPaths(x.d.id), `Shared with ${emp.displayName}.`);
}

export async function unshareDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const s = await prisma.insightDashboardShare.findFirst({ where: { id: str(fd, "id"), dashboard: { tenantId: v.tenantId } }, include: { dashboard: true } });
  if (!s) return no("Share not found.");
  if (s.dashboard.ownerUserId !== v.user.id) return no("Only the owner can stop sharing.");
  await prisma.insightDashboardShare.delete({ where: { id: s.id } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", s.dashboardId, `Stopped sharing ${s.dashboard.name}`);
  return actionDone(dashPaths(s.dashboardId), "Stopped sharing.");
}

export async function addDashboardNoteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "dashboardId"));
  if (!x?.access.view) return no("Dashboard not found.");
  const body = str(fd, "body").slice(0, 2000);
  if (body.length < 2) return { ok: false, message: "Write the note.", errors: { body: "Required" } };
  const widgetId = optStr(fd, "widgetId");
  if (widgetId && !x.d.widgets.some((w) => w.id === widgetId)) return no("Unknown widget.");
  const n = await prisma.insightDashboardNote.create({ data: { dashboardId: x.d.id, widgetId, authorId: v.user.id, body } });
  await audit(v, "ANALYTICS", "CREATE", "InsightDashboardNote", n.id, `Note added on ${x.d.name}`);
  return actionDone(dashPaths(x.d.id), "Note added.");
}

export async function deleteDashboardNoteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const n = await prisma.insightDashboardNote.findFirst({ where: { id: str(fd, "id"), dashboard: { tenantId: v.tenantId }, deletedAt: null }, include: { dashboard: true } });
  if (!n) return no("Note not found.");
  if (n.authorId !== v.user.id && n.dashboard.ownerUserId !== v.user.id) return no("Only its author or the dashboard owner can delete a note.");
  await prisma.insightDashboardNote.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
  await audit(v, "ANALYTICS", "DELETE", "InsightDashboardNote", n.id, `Note deleted on ${n.dashboard.name}`);
  return actionDone(dashPaths(n.dashboardId), "Deleted.");
}

/** Publish company-wide: a report administrator approves. */
export async function publishDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "id"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.owner) return no("Only the owner can publish a dashboard.");
  if (x.d.status === "PENDING_APPROVAL" || x.d.status === "PUBLISHED") return no(x.d.status === "PUBLISHED" ? "Already published." : "Already waiting for approval.");
  if (!x.d.widgets.length) return no("Add at least one widget first.");
  await prisma.insightDashboard.update({ where: { id: x.d.id }, data: { status: "PENDING_APPROVAL" } });
  const wf = await submit(v, "INSIGHT_DASHBOARD", x.d.id, `Publish dashboard ${x.d.name} company-wide`, `/storyboards/${x.d.id}`, { details: x.d.description });
  if (!wf.ok) { await prisma.insightDashboard.update({ where: { id: x.d.id }, data: { status: "DRAFT" } }); return no(wf.message); }
  await prisma.insightDashboard.updateMany({ where: { id: x.d.id, status: "PENDING_APPROVAL" }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Dashboard ${x.d.name} submitted for publishing`);
  return actionDone(dashPaths(x.d.id), wf.message);
}

export async function unpublishDashboardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const x = await dashboardFor(v, str(fd, "id"));
  if (!x) return no("Dashboard not found.");
  if (!x.access.owner && !can(v, P.REPORT_BUILD)) return DENIED;
  await prisma.insightDashboard.update({ where: { id: x.d.id }, data: { status: "DRAFT", visibility: "PRIVATE" } });
  await audit(v, "ANALYTICS", "UPDATE", "InsightDashboard", x.d.id, `Dashboard ${x.d.name} unpublished`);
  return actionDone(dashPaths(x.d.id), "Unpublished.");
}

// ---------------------------------------------------------------------------
//  Reports: access requests, export profiles and approvals, presets, snapshots
// ---------------------------------------------------------------------------

/** Ask for time-boxed access to a standard report the viewer's role does not open. */
export async function requestReportAccessAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_VIEW)) return DENIED;
  const r = REPORTS.find((x) => x.key === str(fd, "reportKey"));
  if (!r) return { ok: false, message: "Choose a report.", errors: { reportKey: "Required" } };
  if (await canOpenReport(v, r.key)) return no("You can already open this report.");
  const days = int(fd, "days") ?? 30;
  if (Number.isNaN(days) || days < 1 || days > 90) return { ok: false, message: "Access lasts 1–90 days.", errors: { days: "1–90" } };
  const reason = str(fd, "reason").slice(0, 500);
  if (reason.length < 5) return { ok: false, message: "Say why you need it.", errors: { reason: "Required" } };
  if (await prisma.insightReportGrant.findFirst({ where: { tenantId: v.tenantId, userId: v.user.id, reportKey: r.key, status: "PENDING" } })) return no("You already asked; wait for the decision.");
  const g = await prisma.insightReportGrant.create({ data: { tenantId: v.tenantId, reportKey: r.key, title: r.title, userId: v.user.id, reason, days } });
  const wf = await submit(v, "REPORT_ACCESS", g.id, `Access to ${r.title} for ${days} day(s)`, "/insights/reports?tab=access", { details: reason });
  if (!wf.ok) { await prisma.insightReportGrant.delete({ where: { id: g.id } }); return no(wf.message); }
  await prisma.insightReportGrant.update({ where: { id: g.id }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "REPORT", "CREATE", "InsightReportGrant", g.id, `Asked for ${days}-day access to ${r.title}`);
  return actionDone(REPORT_PATHS, wf.message);
}

export async function revokeReportGrantAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const g = await prisma.insightReportGrant.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId, status: "APPROVED" } });
  if (!g) return no("Grant not found.");
  await prisma.insightReportGrant.update({ where: { id: g.id }, data: { status: "REVOKED", expiresAt: new Date() } });
  await audit(v, "REPORT", "UPDATE", "InsightReportGrant", g.id, `Access to ${g.title} revoked early`);
  return actionDone(REPORT_PATHS, "Revoked.");
}

export async function saveExportProfileAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the export.", errors: { name: "Required" } };
  const reportKey = str(fd, "reportKey");
  const sample = await runDataset(v, reportKey);
  if (!sample) return { ok: false, message: "Choose a report or dataset you can open.", errors: { reportKey: "Required" } };
  const format = ["CSV", "XLSX", "PDF"].includes(str(fd, "format")) ? str(fd, "format") : "CSV";
  const columns = str(fd, "columns").split(",").map((c) => c.trim()).filter(Boolean);
  const unknown = columns.filter((c) => !sample.columns.some((x) => x.key === c));
  if (unknown.length) return { ok: false, message: `Unknown column(s): ${unknown.join(", ")}. Available: ${sample.columns.map((c) => c.key).join(", ")}`, errors: { columns: "Unknown column" } };
  const data = { name, reportKey, format, columns, includeTotals: fd.has("includeTotals") ? bool(fd, "includeTotals") : true, sensitive: bool(fd, "sensitive"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true };
  const id = optStr(fd, "id");
  if (id) {
    const p = await prisma.insightExportProfile.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!p) return no("Export not found.");
    await prisma.insightExportProfile.update({ where: { id }, data });
    await audit(v, "REPORT", "UPDATE", "InsightExportProfile", id, `Export ${name} updated`);
    return actionDone(REPORT_PATHS, "Saved.");
  }
  if (await prisma.insightExportProfile.findFirst({ where: { tenantId: v.tenantId, name } })) return { ok: false, message: "An export with this name exists.", errors: { name: "Exists" } };
  const p = await prisma.insightExportProfile.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  await audit(v, "REPORT", "CREATE", "InsightExportProfile", p.id, `Export ${name} configured (${format}${data.sensitive ? ", sensitive" : ""})`);
  return actionDone(REPORT_PATHS, "Export configured.");
}

/** A sensitive export is downloaded only after approval. */
export async function requestExportAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_VIEW)) return DENIED;
  const p = await prisma.insightExportProfile.findFirst({ where: { id: str(fd, "profileId"), tenantId: v.tenantId, isActive: true } });
  if (!p) return no("Export not found.");
  if (!p.sensitive) return no("This export needs no approval; download it directly.");
  if (!(await runDataset(v, p.reportKey))) return no("You cannot open the report behind this export.");
  const reason = str(fd, "reason").slice(0, 500);
  if (reason.length < 5) return { ok: false, message: "Say why you need it.", errors: { reason: "Required" } };
  if (await prisma.insightExportRequest.findFirst({ where: { tenantId: v.tenantId, profileId: p.id, requesterUserId: v.user.id, status: "PENDING" } })) return no("You already asked; wait for the decision.");
  const x = await prisma.insightExportRequest.create({ data: { tenantId: v.tenantId, profileId: p.id, reason, requesterUserId: v.user.id } });
  const wf = await submit(v, "REPORT_EXPORT", x.id, `Download sensitive export ${p.name}`, "/insights/reports?tab=exports", { details: reason });
  if (!wf.ok) { await prisma.insightExportRequest.delete({ where: { id: x.id } }); return no(wf.message); }
  await prisma.insightExportRequest.update({ where: { id: x.id }, data: { workflowRequestId: wf.requestId ?? null } });
  await audit(v, "REPORT", "CREATE", "InsightExportRequest", x.id, `Asked to download ${p.name}`);
  return actionDone(REPORT_PATHS, wf.message);
}

export async function saveFilterPresetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_VIEW)) return DENIED;
  const dataset = str(fd, "dataset").slice(0, 120);
  const name = str(fd, "name").slice(0, 80);
  if (!dataset || name.length < 2) return { ok: false, message: "Name the preset.", errors: { name: "Required" } };
  let filters: Record<string, string>;
  try { filters = Object.fromEntries(new URLSearchParams(str(fd, "qs")).entries()); } catch { return no("Those filters could not be read."); }
  delete filters.tab;
  const calc = filters.calc;
  if (calc) { const pc = parseCalculatedField(calc); if (!pc.ok) return no(pc.message); }
  const shared = bool(fd, "shared") && can(v, P.REPORT_BUILD);
  const p = await prisma.insightFilterPreset.upsert({
    where: { tenantId_createdBy_dataset_name: { tenantId: v.tenantId, createdBy: v.user.id, dataset, name } },
    create: { tenantId: v.tenantId, dataset, name, filters, shared, createdBy: v.user.id }, update: { filters, shared },
  });
  await audit(v, "REPORT", "CREATE", "InsightFilterPreset", p.id, `Filter preset ${name} saved for ${dataset}`);
  return actionDone(REPORT_PATHS, "Preset saved.");
}

export async function deleteFilterPresetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const p = await prisma.insightFilterPreset.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!p) return no("Preset not found.");
  if (p.createdBy !== v.user.id && !can(v, P.REPORT_BUILD)) return DENIED;
  await prisma.insightFilterPreset.delete({ where: { id: p.id } });
  await audit(v, "REPORT", "DELETE", "InsightFilterPreset", p.id, `Filter preset ${p.name} deleted`);
  return actionDone(REPORT_PATHS, "Deleted.");
}

/** Freeze a report's rows as they are now, to compare later. */
export async function takeSnapshotAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_VIEW)) return DENIED;
  const started = Date.now();
  const key = str(fd, "reportKey");
  if (key.startsWith("snapshot:")) return no("Snapshot a live report, not a snapshot.");
  const t = await runDataset(v, key);
  if (!t) return { ok: false, message: "Choose a report you can open.", errors: { reportKey: "Required" } };
  const rows = JSON.parse(JSON.stringify(t.rows.slice(0, 5000)));
  const s = await prisma.insightReportSnapshot.create({ data: { tenantId: v.tenantId, reportKey: key, title: t.title, columns: JSON.parse(JSON.stringify(t.columns)), rows, rowCount: t.rows.length, note: optStr(fd, "note"), takenBy: v.user.id } });
  await recordReportRun(v, v.tenantId, { reportKey: key, title: t.title, trigger: "SNAPSHOT", rows: t.rows.length, startedAt: started });
  await audit(v, "REPORT", "CREATE", "InsightReportSnapshot", s.id, `Snapshot of ${t.title} (${t.rows.length} rows)`);
  return actionDone(REPORT_PATHS, `Snapshot taken: ${t.rows.length} row(s).`);
}

export async function deleteSnapshotAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const s = await prisma.insightReportSnapshot.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!s) return no("Snapshot not found.");
  if (s.takenBy !== v.user.id && !can(v, P.REPORT_BUILD)) return DENIED;
  await prisma.insightReportSnapshot.delete({ where: { id: s.id } });
  await audit(v, "REPORT", "DELETE", "InsightReportSnapshot", s.id, `Snapshot of ${s.title} deleted`);
  return actionDone(REPORT_PATHS, "Deleted.");
}

// ---------------------------------------------------------------------------
//  Scheduled reports: edit; custom reports: publish through approval
// ---------------------------------------------------------------------------

export async function updateScheduleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_VIEW)) return DENIED;
  const s = await prisma.scheduledReport.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId, NOT: { reportKey: { startsWith: "asset-" } } } });
  if (!s) return no("Schedule not found.");
  if (s.createdBy !== v.user.id && !can(v, P.ORG_SETTINGS_MANAGE)) return no("Only the person who scheduled it, or an administrator, can change it.");
  const name = str(fd, "name").slice(0, 80);
  if (name.length < 2) return { ok: false, message: "Name the schedule.", errors: { name: "Required" } };
  const raw = str(fd, "recipients");
  const bad = invalidEmails(raw);
  if (bad.length) return { ok: false, message: `Not an email address: ${bad.join(", ")}`, errors: { recipients: "Check the addresses." } };
  const emails = cleanEmails(raw);
  if (!emails.length || emails.length > 10) return { ok: false, message: "1–10 recipients.", errors: { recipients: "1–10" } };
  const frequency = (["DAILY", "WEEKLY", "MONTHLY"].includes(str(fd, "frequency")) ? str(fd, "frequency") : s.frequency) as "DAILY" | "WEEKLY" | "MONTHLY";
  const dw = int(fd, "dayOfWeek"), dm = int(fd, "dayOfMonth");
  const dayOfWeek = frequency === "WEEKLY" ? (dw !== null && !Number.isNaN(dw) && dw >= 0 && dw <= 7 ? dw : 1) : null;
  const dayOfMonth = frequency === "MONTHLY" ? (dm !== null && !Number.isNaN(dm) && dm >= 1 && dm <= 28 ? dm : 1) : null;
  const isActive = fd.has("isActive") ? bool(fd, "isActive") : s.isActive;
  await prisma.scheduledReport.update({ where: { id: s.id }, data: { name, recipients: emails, frequency, dayOfWeek, dayOfMonth, isActive, nextRunAt: nextReportRun(frequency, dayOfWeek, dayOfMonth) } });
  await audit(v, "REPORT", "UPDATE", "ScheduledReport", s.id, `Schedule ${name} changed: ${frequency.toLowerCase()} to ${emails.length} recipient(s)${isActive ? "" : ", paused"}`);
  // New outside recipients go back through approval.
  const before = (Array.isArray(s.recipients) ? s.recipients : []).map(String);
  const added = emails.filter((e) => !before.includes(e));
  if (added.length || s.approvalStatus === "REJECTED") {
    const pending = await routeExternalSchedule(v, s.id, name, s.approvalStatus === "APPROVED" ? added : emails);
    if (pending) return actionDone(REPORT_PATHS, pending);
  }
  return actionDone(REPORT_PATHS, "Schedule saved.");
}

/** Share a custom report company-wide: a report administrator approves. */
export async function requestPublishReportAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const s = await savedReportFor(v, str(fd, "id"));
  if (!s || s.createdBy !== v.user.id) return no("Only the report's author can publish it.");
  if (s.shared) return no("Already shared company-wide.");
  if (s.publishStatus === "PENDING") return no("Already waiting for approval.");
  await prisma.savedReport.update({ where: { id: s.id }, data: { publishStatus: "PENDING" } });
  const wf = await submit(v, "REPORT_PUBLISH", s.id, `Publish custom report ${s.name}`, "/insights/reports?tab=publishing", { details: s.description });
  if (!wf.ok) { await prisma.savedReport.update({ where: { id: s.id }, data: { publishStatus: null } }); return no(wf.message); }
  await prisma.savedReport.updateMany({ where: { id: s.id, publishStatus: "PENDING" }, data: { publishRequestId: wf.requestId ?? null } });
  await audit(v, "REPORT", "UPDATE", "SavedReport", s.id, `Custom report ${s.name} submitted for publishing`);
  return actionDone(REPORT_PATHS, wf.message);
}

// ---------------------------------------------------------------------------
//  People analytics: cohorts, hiring costs
// ---------------------------------------------------------------------------

export async function saveCohortAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ANALYTICS_VIEW)) return DENIED;
  const name = str(fd, "name").slice(0, 120);
  if (name.length < 2) return { ok: false, message: "Name the cohort.", errors: { name: "Required" } };
  const filters = cohortFiltersOf({
    departmentIds: formList(fd, "departmentIds"), locationIds: formList(fd, "locationIds"), genders: formList(fd, "genders"),
    joinedFrom: str(fd, "joinedFrom"), joinedTo: str(fd, "joinedTo"), minTenureYears: str(fd, "minTenureYears"), maxTenureYears: str(fd, "maxTenureYears"), includeExited: bool(fd, "includeExited"),
  });
  if (filters.joinedFrom && filters.joinedTo && filters.joinedFrom > filters.joinedTo) return { ok: false, message: "Joined-from is after joined-to.", errors: { joinedTo: "After from" } };
  const id = optStr(fd, "id");
  const data = { name, description: optStr(fd, "description"), filters: JSON.parse(JSON.stringify(filters)), shared: bool(fd, "shared") };
  if (id) {
    const c = await prisma.insightCohort.findFirst({ where: { id, tenantId: v.tenantId } });
    if (!c) return no("Cohort not found.");
    if (c.createdBy !== v.user.id) return no("Only its author can change a cohort.");
    await prisma.insightCohort.update({ where: { id }, data });
    await audit(v, "ANALYTICS", "UPDATE", "InsightCohort", id, `Cohort ${name} updated`);
    return actionDone(["/insights/people"], "Saved.");
  }
  const c = await prisma.insightCohort.create({ data: { tenantId: v.tenantId, ...data, createdBy: v.user.id } });
  await audit(v, "ANALYTICS", "CREATE", "InsightCohort", c.id, `Cohort ${name} built`);
  return { ...actionDone(["/insights/people"], "Cohort saved."), values: { id: c.id } };
}

export async function deleteCohortAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await prisma.insightCohort.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!c) return no("Cohort not found.");
  if (c.createdBy !== v.user.id) return no("Only its author can delete a cohort.");
  await prisma.insightCohort.delete({ where: { id: c.id } });
  await audit(v, "ANALYTICS", "DELETE", "InsightCohort", c.id, `Cohort ${c.name} deleted`);
  return actionDone(["/insights/people"], "Deleted.");
}

const HIRING_COST_CATEGORIES = ["AGENCY", "JOB_BOARD", "REFERRAL_BONUS", "ASSESSMENT", "TRAVEL", "OTHER"] as const;

export async function addHiringCostAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const month = str(fd, "month");
  if (!isPeriodKey(month)) return { ok: false, message: "Month is YYYY-MM.", errors: { month: "YYYY-MM" } };
  const amount = num(fd, "amount");
  if (amount === null || amount <= 0) return { ok: false, message: "Enter the amount.", errors: { amount: "Required" } };
  const category = (HIRING_COST_CATEGORIES as readonly string[]).includes(str(fd, "category")) ? str(fd, "category") : "OTHER";
  const requisitionId = optStr(fd, "requisitionId");
  if (requisitionId && !(await prisma.requisition.findFirst({ where: { id: requisitionId, tenantId: v.tenantId } }))) return no("Unknown requisition.");
  const c = await prisma.insightHiringCost.create({ data: { tenantId: v.tenantId, month, category, amount, requisitionId, note: optStr(fd, "note"), createdBy: v.user.id } });
  await audit(v, "ANALYTICS", "CREATE", "InsightHiringCost", c.id, `Hiring cost ₹${amount} (${category.toLowerCase()}) for ${month}`);
  return actionDone(["/insights/people"], "Recorded.");
}

export async function deleteHiringCostAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.REPORT_BUILD)) return DENIED;
  const c = await prisma.insightHiringCost.findFirst({ where: { id: str(fd, "id"), tenantId: v.tenantId } });
  if (!c) return no("Not found.");
  await prisma.insightHiringCost.delete({ where: { id: c.id } });
  await audit(v, "ANALYTICS", "DELETE", "InsightHiringCost", c.id, `Hiring cost for ${c.month} removed`);
  return actionDone(["/insights/people"], "Removed.");
}


