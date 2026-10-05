/**
 * Insight depth, end to end through the real session → viewer → permission
 * chain and the generic workflow engine:
 *
 *   Reporting     metric catalog with versions and approval, KPIs (catalog,
 *                 owners, calculation from metrics, target versions, RAG and
 *                 threshold alerts), KRAs with approval, dashboards (builder,
 *                 role-based widgets, refresh status, notes, sharing with
 *                 expiry, company-wide publishing through approval), report
 *                 access requests with expiry, export profiles and sensitive
 *                 exports through approval, Excel and PDF downloads, filter
 *                 presets, calculated fields, exception-only and effective-
 *                 date reporting, cross-module joins, snapshots, execution
 *                 history, schedules (edit, external recipients through
 *                 approval), custom report publishing through approval.
 *   People        cohorts, analytics tabs, talent risk, hiring costs,
 *                 scorecards (executive, department, manager, personal).
 *   Performance   cycle templates, rating scales and descriptions, competency
 *                 weights, conditional sections, exception queue, calibration
 *                 notes, normalisation, trend, summaries, reminders, data
 *                 export, audit history, review reopening through approval.
 *   OKRs          goal approval (individual and organisation), audited
 *                 edits and check-ins with confidence, stretch targets,
 *                 cadence and overdue alerts, at-risk triage, links and
 *                 dependency loops, close-out through approval, snapshots,
 *                 the OKR export.
 *   Feedback      topics, tags, sentiment, quality prompts, templates in
 *                 feedback and 360 forms, edit and delete, request edit and
 *                 withdraw, escalation rules, follow-ups, digests, anonymity
 *                 threshold, 360 settings, exports.
 *   PIP           settings and eligibility, templates (PIP and coaching),
 *                 objectives, evidence upload, checklist, behaviour logs,
 *                 completion criteria, extension, escalation and check-in
 *                 sign-off through approval, outcome amendment, risk.
 *
 * Every page the features add is rendered. Everything created is removed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { unlink } from "node:fs/promises";
import path from "node:path";
import Module from "node:module";
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
type State = { ok?: boolean; message?: string; values?: Record<string, string> };

function form(values: Record<string, string | string[] | File | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one as string | Blob);
  }
  return f;
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  async function render(page: Page, url: string, params: Record<string, string> = {}): Promise<string> {
    const u = new URL(url, "http://acme.test");
    const sp: SP = Object.fromEntries(u.searchParams.entries());
    try {
      const tree = (await resolve(await page({ searchParams: Promise.resolve(sp), params: Promise.resolve(params) }))) as ReactNode;
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

  const IA = await import("../apps/web/src/app/actions/insight-analytics");
  const IP = await import("../apps/web/src/app/actions/insight-performance");
  const PF = await import("../apps/web/src/app/actions/performance");
  const FB = await import("../apps/web/src/app/actions/feedback");
  const TP = await import("../apps/web/src/app/actions/talent-performance");
  const DV = await import("../apps/web/src/app/actions/development");
  const CW = await import("../apps/web/src/app/actions/core-hr-workflows");
  const WF = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("../packages/services/src/index");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { workflowSources } = await import("../apps/web/src/app/(app)/inbox/_take/workflows");
  const { runDataset } = await import("../apps/web/src/lib/insight/datasets");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = {
    insights: await load("insights"), metrics: await load("insights/metrics"), kpis: await load("insights/kpis"), reports: await load("insights/reports"), people: await load("insights/people"),
    storyboards: await load("storyboards"), storyboard: await load("storyboards/[id]"), team: await load("team/insights"), me: await load("me/insights"),
    ops: await load("performance/operations"), okr: await load("performance/okr"), hub: await load("performance/feedback-hub"), pipOps: await load("performance/pip-ops"), plan: await load("performance/plans/[id]"),
    workflows: await load("admin/workflows"),
  };
  const insightExport = (await import("../apps/web/src/app/(app)/insights/export/route")).GET;
  const reportExport = (await import("../apps/web/src/app/(app)/reports/export/route")).GET;
  const get = (route: (r: NextRequest) => Promise<Response>, url: string) => route(new NextRequest(new URL(url, "http://acme.test")));

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, exec, meera, ananya] = await Promise.all([
    user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("deepak.chauhan@acme.test"), user("meera.krishnan@acme.test"), user("ananya.ghosh@acme.test"),
  ]);
  const emp = (name: string) => prisma.employee.findFirstOrThrow({ where: { tenantId, displayName: name } });
  const [aditya, harish, gaurav] = await Promise.all([emp("Aditya Verma"), emp("Harish Prasad"), emp("Gaurav Mishra")]);
  const started = new Date();
  const tag = `ID${String(Date.now()).slice(-6)}`;
  const made = {
    metricKeys: [] as string[], kras: [] as string[], kpis: [] as string[], dashboards: [] as string[], grants: [] as string[], profiles: [] as string[], presets: [] as string[],
    snapshots: [] as string[], schedules: [] as string[], saved: [] as string[], cohorts: [] as string[], costs: [] as string[], cycleTemplates: [] as string[], cycles: [] as string[],
    scales: [] as string[], calNotes: [] as string[], goals: [] as string[], topics: [] as string[], rules: [] as string[], feedback: [] as string[], requests: [] as string[],
    pipTemplates: [] as string[], pips: [] as string[], coaching: [] as string[], fbTemplates: [] as string[],
  };
  const before = {
    okr: await prisma.insightOkrSetting.findUnique({ where: { tenantId } }),
    pip: await prisma.insightPipSetting.findUnique({ where: { tenantId } }),
    fb: await prisma.feedbackSetting.findUnique({ where: { tenantId } }),
  };
  let reopened: { review: { id: string; status: string; finalRating: unknown; bandId: string | null; calibratedAt: Date | null; calibratedBy: string | null; sharedAt: Date | null; acknowledgedAt: Date | null; cycleId: string }; responses: Array<{ id: string; submittedAt: Date | null; status: string }>; cycleStatus: string } | null = null;

  /** Decide the pending engine task for a record as whoever it is assigned to (never the requester). */
  async function decide(entityType: string, entityId: string, approve = true): Promise<State & { approver?: string }> {
    const task = await prisma.workflowTask.findFirst({ where: { tenantId, status: "PENDING", request: { entityType, entityId, status: "PENDING" } }, orderBy: { createdAt: "asc" } });
    if (!task) return { ok: false, message: `no pending ${entityType} task` };
    const u = await prisma.user.findUniqueOrThrow({ where: { id: task.approverUserId! } });
    await signInAs(u.email);
    const r = await WF.decideWorkflowTaskAction({}, fd({ taskId: task.id, decision: approve ? "approve" : "reject", comment: approve ? "" : "Not this time" }));
    return { ...r, approver: u.email };
  }
  /** Decide every step of a request until it finishes. */
  async function decideAll(entityType: string, entityId: string, approve = true): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      const r = await decide(entityType, entityId, approve);
      if (!r.ok) break;
    }
    const req = await prisma.workflowRequest.findFirst({ where: { tenantId, entityType, entityId }, orderBy: { createdAt: "desc" } });
    return req?.status === (approve ? "APPROVED" : "REJECTED");
  }
  async function inInbox(email: string, entityType: string): Promise<boolean> {
    const u = await user(email);
    const v = await viewerForUser(u.id);
    const [src] = await workflowSources(v!);
    const tasks = await prisma.workflowTask.findMany({ where: { tenantId, approverUserId: u.id, status: "PENDING", request: { entityType, status: "PENDING" } } });
    const list = await src!.list();
    return tasks.length > 0 && tasks.every((t) => list.some((x) => x.id === t.id));
  }

  console.log("\nInsight depth\n" + "=".repeat(72));
  try {
    // =========================================================================
    section("Metric catalog (headcount, attrition, absence, compensation, talent)");
    await signInAs(meera.email);
    check("An employee cannot define a metric", (await IA.saveMetricAction({}, fd({ name: `${tag} Nope`, calculator: "HEADCOUNT" }))).ok === false);
    check("An employee cannot open the metric catalog", (await render(pages.metrics, "/insights/metrics")) === "403");
    await signInAs(hr.email);
    const calcs = ["HEADCOUNT", "ATTRITION_RATE", "ABSENCE_RATE", "AVERAGE_CTC", "HIGH_RISK_SHARE"];
    for (const c of calcs) {
      const r = await IA.saveMetricAction({}, fd({ name: `${tag} ${c}`, calculator: c, months: 12, ...(c === "ATTRITION_RATE" ? { warnAt: 10, alertAt: 20 } : {}) }));
      check(`A report builder defines the ${c.toLowerCase().replace(/_/g, " ")} metric`, r.ok === true, r.message);
      made.metricKeys.push(svc.metricKeyOf(`${tag} ${c}`));
    }
    check("Thresholds the wrong way round are refused", (await IA.saveMetricAction({}, fd({ name: `${tag} Bad`, calculator: "ATTRITION_RATE", warnAt: 20, alertAt: 10 }))).ok === false);
    check("A duplicate key is refused", (await IA.saveMetricAction({}, fd({ name: `${tag} HEADCOUNT`, calculator: "HEADCOUNT" }))).ok === false);
    const mHead = await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: made.metricKeys[0]! } });
    const mAttr = await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: made.metricKeys[1]! } });
    check("A draft is edited in place", (await IA.saveMetricAction({}, fd({ id: mHead.id, name: `${tag} HEADCOUNT`, calculator: "HEADCOUNT", description: "Everyone on the books" }))).ok === true
      && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: mHead.id } })).description === "Everyone on the books");
    for (const k of made.metricKeys) {
      const m = await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: k } });
      const s = await IA.submitMetricAction({}, fd({ id: m.id }));
      check(`Metric ${m.name} goes for approval`, s.ok === true && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: m.id } })).status === "PENDING_APPROVAL", s.message);
    }
    check("The metric approval is in the approver's inbox", await inInbox(admin.email, "INSIGHT_METRIC"));
    check("The metric approval shows on /admin/workflows", ok(await (async () => { await signInAs(admin.email); return render(pages.workflows, "/admin/workflows"); })()));
    for (const k of made.metricKeys.slice(0, 4)) {
      const m = await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: k } });
      check(`Approving ${m.name} puts it in force and computes it`, (await decideAll("INSIGHT_METRIC", m.id)) && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: m.id } })).status === "APPROVED");
    }
    const mRisk = await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: made.metricKeys[4]! } });
    check("A rejected metric is sent back", (await decideAll("INSIGHT_METRIC", mRisk.id, false)) && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: mRisk.id } })).status === "REJECTED");
    const headNow = await prisma.insightMetric.findUniqueOrThrow({ where: { id: mHead.id } });
    check("The approved headcount metric has a value", headNow.lastValue !== null && Number(headNow.lastValue) > 0, String(headNow.lastValue));
    await signInAs(hr.email);
    const v2 = await IA.saveMetricAction({}, fd({ id: mAttr.id, name: `${tag} ATTRITION_RATE`, calculator: "ATTRITION_RATE", months: 6, warnAt: 12, alertAt: 25 }));
    const mAttr2 = await prisma.insightMetric.findFirst({ where: { tenantId, key: mAttr.key, version: 2 } });
    check("Editing an approved metric drafts version 2; v1 stays in force", v2.ok === true && mAttr2?.status === "DRAFT" && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: mAttr.id } })).status === "APPROVED", v2.message);
    await IA.submitMetricAction({}, fd({ id: mAttr2!.id }));
    check("Approving v2 retires v1", (await decideAll("INSIGHT_METRIC", mAttr2!.id)) && (await prisma.insightMetric.findUniqueOrThrow({ where: { id: mAttr.id } })).status === "RETIRED");
    await signInAs(hr.email);
    check("A metric is recomputed on demand", (await IA.computeMetricAction({}, fd({ id: mHead.id }))).ok === true);
    check("A metric is retired", (await IA.retireMetricAction({}, fd({ id: (await prisma.insightMetric.findFirstOrThrow({ where: { tenantId, key: made.metricKeys[3]! } })).id }))).ok === true);
    const catalog = await runDataset((await viewerForUser(hr.id))!, "metrics", { q: tag });
    check("The metric catalog lists every version", (catalog?.rows.length ?? 0) >= 6);
    check("The metric catalog page renders", ok(await render(pages.metrics, `/insights/metrics?q=${tag}`)));
    check("The metric audit trail records definitions and approvals", (await prisma.auditLog.count({ where: { tenantId, entityType: "InsightMetric", createdAt: { gte: started } } })) >= 10);

    // =========================================================================
    section("KRAs and KPIs");
    await signInAs(hr.email);
    check("Without performance rights a KRA cannot be defined", (await IA.saveKraAction({}, fd({ name: `${tag} Delivery`, weight: 40 }))).ok === false);
    await signInAs(admin.email);
    const kraTitle = `${tag} Engineer`;
    check("A performance admin defines a KRA for a role", (await IA.saveKraAction({}, fd({ name: `${tag} Delivery`, weight: 60, jobTitle: kraTitle }))).ok === true);
    check("KRA weights over 100 for a role are refused", (await IA.saveKraAction({}, fd({ name: `${tag} Quality`, weight: 50, jobTitle: kraTitle }))).ok === false);
    check("A second KRA within 100 is accepted", (await IA.saveKraAction({}, fd({ name: `${tag} Quality`, weight: 40, jobTitle: kraTitle }))).ok === true);
    const kra = await prisma.insightKra.findFirstOrThrow({ where: { tenantId, name: `${tag} Delivery` } });
    made.kras.push(kra.id, (await prisma.insightKra.findFirstOrThrow({ where: { tenantId, name: `${tag} Quality` } })).id);
    check("A draft KRA is edited", (await IA.saveKraAction({}, fd({ id: kra.id, name: `${tag} Delivery`, weight: 55, jobTitle: kraTitle, description: "Ship on time" }))).ok === true);
    check("A KRA goes for approval", (await IA.submitKraAction({}, fd({ id: kra.id }))).ok === true);
    check("Approving the KRA makes it live", (await decideAll("INSIGHT_KRA", kra.id)) && (await prisma.insightKra.findUniqueOrThrow({ where: { id: kra.id } })).status === "APPROVED");
    await signInAs(admin.email);
    check("Editing an approved KRA drafts a new version", (await IA.saveKraAction({}, fd({ id: kra.id, name: `${tag} Delivery`, weight: 50, jobTitle: kraTitle }))).ok === true && !!(await prisma.insightKra.findFirst({ where: { tenantId, name: `${tag} Delivery`, version: 2 } })));
    made.kras.push((await prisma.insightKra.findFirstOrThrow({ where: { tenantId, name: `${tag} Delivery`, version: 2 } })).id);

    await signInAs(hr.email);
    const k1 = await IA.saveKpiAction({}, fd({ name: `${tag} Attrition KPI`, calcKind: "METRIC", metricKey: mAttr.key, direction: "DOWN_GOOD", unit: "PERCENT", frequency: "MONTHLY", target: 12, ownerEmployeeId: ananya.employee!.id, kraId: kra.id }));
    check("A KPI is calculated from an approved metric, with an owner and a KRA", k1.ok === true, k1.message);
    const k2 = await IA.saveKpiAction({}, fd({ name: `${tag} Offer acceptance`, calcKind: "MANUAL", direction: "UP_GOOD", unit: "PERCENT", frequency: "MONTHLY", target: 80, ownerEmployeeId: meera.employee!.id, greenAt: 100, amberAt: 85 }));
    check("A manual KPI is added to the catalog", k2.ok === true, k2.message);
    const kpiA = await prisma.insightKpi.findFirstOrThrow({ where: { tenantId, name: `${tag} Attrition KPI` } });
    const kpiB = await prisma.insightKpi.findFirstOrThrow({ where: { tenantId, name: `${tag} Offer acceptance` } });
    made.kpis.push(kpiA.id, kpiB.id);
    check("The metric-backed KPI computes this period", (await IA.computeKpiAction({}, fd({ kpiId: kpiA.id }))).ok === true && (await prisma.insightKpiReading.count({ where: { kpiId: kpiA.id } })) === 1);
    const lastMonth = svc.kpiPeriodOf(new Date(Date.now() - 35 * 86_400_000), "MONTHLY");
    check("A new target version takes effect from a date", (await IA.addKpiTargetAction({}, fd({ kpiId: kpiB.id, target: 90, effectiveFrom: day(0), reason: "Raised bar" }))).ok === true && (await prisma.insightKpiTarget.count({ where: { kpiId: kpiB.id } })) === 2);
    await signInAs(meera.email);
    check("The KPI owner records a reading", (await IA.recordKpiReadingAction({}, fd({ kpiId: kpiB.id, period: lastMonth, value: 60 }))).ok === true);
    check("Someone else's KPI cannot be recorded", (await IA.recordKpiReadingAction({}, fd({ kpiId: kpiA.id, period: lastMonth, value: 1 }))).ok === false);
    check("A bad period is refused", (await IA.recordKpiReadingAction({}, fd({ kpiId: kpiB.id, period: "2026-13", value: 1 }))).ok === false);
    const reading = await prisma.insightKpiReading.findFirstOrThrow({ where: { kpiId: kpiB.id, period: lastMonth } });
    check("A reading below amber is RED against the target in force", reading.rag === "RED", `${reading.rag}`);
    check("A RED KPI raises a threshold alert to its owner", (await prisma.notification.count({ where: { tenantId, createdAt: { gte: started }, title: { contains: `${tag} Offer acceptance` } } })) >= 1);
    await signInAs(hr.email);
    for (const t of ["dashboard", "configure", "kras"]) check(`KPI page tab ${t} renders`, ok(await render(pages.kpis, `/insights/kpis?tab=${t}`)));
    check("The KPI table lists RAG and owners", ((await runDataset((await viewerForUser(hr.id))!, "kpis"))?.rows ?? []).some((r) => r.name === `${tag} Offer acceptance`));
    check("The KRA register exports with versions", (await (await get(insightExport, "/insights/export?ds=kras&format=csv")).text()).includes(`${tag} Delivery`));
    const kpiCsv = await get(insightExport, "/insights/export?ds=kpis&format=xlsx");
    check("The KPI table downloads as Excel", kpiCsv.status === 200 && (kpiCsv.headers.get("content-type") ?? "").includes("spreadsheetml"));

    // =========================================================================
    section("Dashboards");
    const dRes = await IA.createDashboardAction({}, fd({ name: `${tag} People board`, description: "Monthly view" }));
    check("An analyst builds a dashboard", dRes.ok === true && !!dRes.values?.id, dRes.message);
    const dashId = dRes.values!.id!;
    made.dashboards.push(dashId);
    const kpiDash = await IA.createDashboardAction({}, fd({ name: `${tag} KPI board`, kind: "KPI" }));
    made.dashboards.push(kpiDash.values!.id!);
    check("A KPI dashboard starts with every active KPI", (await prisma.insightDashboardWidget.count({ where: { dashboardId: kpiDash.values!.id! } })) >= 2);
    check("Only an approved metric can be a widget", (await IA.addWidgetAction({}, fd({ dashboardId: dashId, ref: `METRIC:${mRisk.key}` }))).ok === false);
    check("A metric widget is added", (await IA.addWidgetAction({}, fd({ dashboardId: dashId, ref: `METRIC:${mHead.key}`, viz: "NUMBER" }))).ok === true);
    check("A KPI widget for managers only is added", (await IA.addWidgetAction({}, form({ dashboardId: dashId, ref: `KPI:${kpiB.id}`, viz: "TREND", roles: ["MANAGER"] }))).ok === true);
    const widgets = await prisma.insightDashboardWidget.findMany({ where: { dashboardId: dashId }, orderBy: { position: "asc" } });
    check("Widgets are reordered", (await IA.updateWidgetAction({}, fd({ id: widgets[1]!.id, move: "up" }))).ok === true && (await prisma.insightDashboardWidget.findUniqueOrThrow({ where: { id: widgets[1]!.id } })).position === 0);
    check("A widget's title is changed", (await IA.updateWidgetAction({}, fd({ id: widgets[0]!.id, title: `${tag} Headcount` }))).ok === true);
    check("The dashboard is renamed", (await IA.updateDashboardAction({}, fd({ id: dashId, name: `${tag} People board`, description: "Updated" }))).ok === true);
    check("Refreshing records a status and duration", (await IA.refreshDashboardAction({}, fd({ id: dashId }))).ok === true && !!(await prisma.insightDashboard.findUniqueOrThrow({ where: { id: dashId } })).refreshedAt);
    check("A note is added on a widget", (await IA.addDashboardNoteAction({}, fd({ dashboardId: dashId, widgetId: widgets[0]!.id, body: "Spike from campus hiring" }))).ok === true);
    check("The dashboard is shared with Meera until a date", (await IA.shareDashboardAction({}, fd({ dashboardId: dashId, employeeId: meera.employee!.id, expiresAt: day(10) }))).ok === true);
    check("A past expiry is refused", (await IA.shareDashboardAction({}, fd({ dashboardId: dashId, employeeId: ananya.employee!.id, expiresAt: day(-1) }))).ok === false);
    await signInAs(meera.email);
    const shared = await render(pages.storyboard, `/storyboards/${dashId}`, { id: dashId });
    check("Meera opens the shared dashboard", ok(shared));
    check("A managers-only widget is hidden from a non-manager", ok(shared) && !shared.includes(`${tag} Offer acceptance`));
    check("A viewer cannot add widgets", (await IA.addWidgetAction({}, fd({ dashboardId: dashId, ref: `METRIC:${mHead.key}` }))).ok === false);
    check("A viewer may add a note", (await IA.addDashboardNoteAction({}, fd({ dashboardId: dashId, body: "Thanks for this" }))).ok === true);
    check("A viewer cannot share", (await IA.shareDashboardAction({}, fd({ dashboardId: dashId, employeeId: ananya.employee!.id }))).ok === false);
    await prisma.insightDashboardShare.updateMany({ where: { dashboardId: dashId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    check("An expired share no longer opens the dashboard", !ok(await render(pages.storyboard, `/storyboards/${dashId}`, { id: dashId })));
    await signInAs(hr.email);
    const note = await prisma.insightDashboardNote.findFirstOrThrow({ where: { dashboardId: dashId, body: "Thanks for this" } });
    check("The owner deletes a note", (await IA.deleteDashboardNoteAction({}, fd({ id: note.id }))).ok === true);
    const share = await prisma.insightDashboardShare.findFirstOrThrow({ where: { dashboardId: dashId } });
    check("The owner stops sharing", (await IA.unshareDashboardAction({}, fd({ id: share.id }))).ok === true);
    check("Publishing company-wide goes for approval", (await IA.publishDashboardAction({}, fd({ id: dashId }))).ok === true && (await prisma.insightDashboard.findUniqueOrThrow({ where: { id: dashId } })).status === "PENDING_APPROVAL");
    check("Approval publishes it to everyone", (await decideAll("INSIGHT_DASHBOARD", dashId)) && (await prisma.insightDashboard.findUniqueOrThrow({ where: { id: dashId } })).visibility === "ORG");
    await signInAs(ananya.email);
    const pub = await render(pages.storyboard, `/storyboards/${dashId}`, { id: dashId });
    check("A manager sees the published dashboard and the managers-only widget", ok(pub) && pub.includes(`${tag} Offer acceptance`));
    await signInAs(hr.email);
    check("The owner unpublishes", (await IA.unpublishDashboardAction({}, fd({ id: dashId }))).ok === true);
    check("A widget is removed", (await IA.removeWidgetAction({}, fd({ id: widgets[0]!.id }))).ok === true);
    check("The storyboards list renders", ok(await render(pages.storyboards, "/storyboards")));
    check("A KPI dashboard page renders", ok(await render(pages.storyboard, `/storyboards/${kpiDash.values!.id}`, { id: kpiDash.values!.id! })));
    check("The dashboard downloads as Excel", (await get(insightExport, `/insights/export?ds=dashboard:${dashId}&format=xlsx`)).status === 200);
    check("Dashboard changes are audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "InsightDashboard", entityId: dashId } })) >= 6);

    // =========================================================================
    section("Reports: access, exports, presets, snapshots, history");
    await signInAs(exec.email);
    check("An HR executive cannot download payroll cost", (await get(reportExport, "/reports/export?r=payroll-summary&format=xlsx")).status === 403);
    check("Access is requested for 7 days", (await IA.requestReportAccessAction({}, fd({ reportKey: "payroll-summary", days: 7, reason: "Budget review with finance" }))).ok === true);
    const grant = await prisma.insightReportGrant.findFirstOrThrow({ where: { tenantId, userId: exec.id, reportKey: "payroll-summary", status: "PENDING" } });
    made.grants.push(grant.id);
    check("A duplicate request is refused", (await IA.requestReportAccessAction({}, fd({ reportKey: "payroll-summary", days: 7, reason: "Budget review with finance" }))).ok === false);
    check("Approval grants access with an expiry", (await decideAll("REPORT_ACCESS", grant.id)) && !!(await prisma.insightReportGrant.findUniqueOrThrow({ where: { id: grant.id } })).expiresAt);
    await signInAs(exec.email);
    const xl = await get(reportExport, "/reports/export?r=payroll-summary&format=xlsx");
    check("With the grant the report downloads as Excel", xl.status === 200 && (xl.headers.get("content-type") ?? "").includes("spreadsheetml"));
    const pdf = await get(reportExport, "/reports/export?r=headcount&format=pdf");
    check("A report downloads as PDF", pdf.status === 200 && (pdf.headers.get("content-type") ?? "") === "application/pdf" && Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString() === "%PDF-");
    await prisma.insightReportGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    check("Once the grant expires the report is closed again", (await get(reportExport, "/reports/export?r=payroll-summary&format=xlsx")).status === 403);

    await signInAs(hr.email);
    check("An export profile is configured", (await IA.saveExportProfileAction({}, fd({ name: `${tag} Workforce lite`, reportKey: "workforce", format: "XLSX", columns: "name,department,jobTitle" }))).ok === true);
    check("A sensitive export profile is configured", (await IA.saveExportProfileAction({}, fd({ name: `${tag} Workforce pay`, reportKey: "workforce", format: "CSV", columns: "name,pay_ctc", sensitive: "on" }))).ok === true);
    const prof = await prisma.insightExportProfile.findFirstOrThrow({ where: { tenantId, name: `${tag} Workforce lite` } });
    const sens = await prisma.insightExportProfile.findFirstOrThrow({ where: { tenantId, name: `${tag} Workforce pay` } });
    made.profiles.push(prof.id, sens.id);
    check("A profile is edited", (await IA.saveExportProfileAction({}, fd({ id: prof.id, name: `${tag} Workforce lite`, reportKey: "workforce", format: "XLSX", columns: "name,department" }))).ok === true);
    const lite = await get(insightExport, `/insights/export?profile=${prof.id}`);
    check("A plain profile downloads with its columns", lite.status === 200 && (lite.headers.get("content-type") ?? "").includes("spreadsheetml"));
    check("A sensitive profile needs approval first", (await get(insightExport, `/insights/export?profile=${sens.id}`)).status === 403);
    check("The sensitive export is requested", (await IA.requestExportAction({}, fd({ profileId: sens.id, reason: "Quarterly pay audit" }))).ok === true);
    const xr = await prisma.insightExportRequest.findFirstOrThrow({ where: { tenantId, profileId: sens.id } });
    check("Approval opens the export for 7 days", (await decideAll("REPORT_EXPORT", xr.id)) && (await prisma.insightExportRequest.findUniqueOrThrow({ where: { id: xr.id } })).status === "APPROVED");
    await signInAs(hr.email);
    const sensCsv = await get(insightExport, `/insights/export?profile=${sens.id}`);
    check("The approved export downloads and is marked downloaded", sensCsv.status === 200 && !!(await prisma.insightExportRequest.findUniqueOrThrow({ where: { id: xr.id } })).downloadedAt);

    check("A filter preset is saved", (await IA.saveFilterPresetAction({}, fd({ dataset: "workforce", name: `${tag} Engineering`, qs: "c1=department&o1=CONTAINS&v1=eng", shared: "on" }))).ok === true);
    const preset = await prisma.insightFilterPreset.findFirstOrThrow({ where: { tenantId, name: `${tag} Engineering` } });
    made.presets.push(preset.id);
    const hrV = (await viewerForUser(hr.id))!;
    const calc = await runDataset(hrV, "workforce", { calc: "[tenureYears] * 12", calcName: "Tenure months" });
    check("A calculated field adds a column", !!calc?.columns.some((c) => c.key === "__calc") && calc.rows.some((r) => typeof r.__calc === "number"));
    const exc = await runDataset(hrV, "exceptions", { c1: "manager", o1: "EMPTY" });
    check("Exception-only reporting lists only the rows breaking a rule", !!exc && exc.rows.every((r) => !r.manager));
    const eff = await runDataset(hrV, "effective", { asOf: "2024-01-01" });
    const now = await runDataset(hrV, "workforce", {});
    check("Effective-date reporting gives the workforce as it was", !!eff && !!now && eff.rows.length !== now.rows.length);
    check("Rows are joined across modules", !!now?.columns.some((c) => c.key === "rating") && !!now?.columns.some((c) => c.key.startsWith("pay_")));
    check("A snapshot is taken", (await IA.takeSnapshotAction({}, fd({ reportKey: "workforce", label: `${tag} Q3` }))).ok === true);
    const snap = await prisma.insightReportSnapshot.findFirstOrThrow({ where: { tenantId, takenBy: hr.id, createdAt: { gte: started } } });
    made.snapshots.push(snap.id);
    check("A snapshot opens as a report", ((await runDataset(hrV, `snapshot:${snap.id}`))?.rows.length ?? 0) === now!.rows.length);
    check("Report runs are recorded with duration", (await prisma.insightReportRun.count({ where: { tenantId, createdAt: { gte: started } } })) >= 4);
    for (const t of ["builder", "snapshots", "history", "access", "exports", "schedules", "publishing"]) check(`Report operations tab ${t} renders`, ok(await render(pages.reports, `/insights/reports?tab=${t}`)));
    check("The builder renders a preset with a calculated field", ok(await render(pages.reports, `/insights/reports?tab=builder&ds=workforce&calc=${encodeURIComponent("[tenureYears] * 12")}`)));

    section("Schedules and custom report publishing");
    const sIn = await CW.scheduleReportAction({}, fd({ reportKey: "headcount", name: `${tag} Inside`, recipients: "priya.sharma@acme.test", frequency: "WEEKLY", dayOfWeek: 1 }));
    const inside = await prisma.scheduledReport.findFirstOrThrow({ where: { tenantId, name: `${tag} Inside` } });
    made.schedules.push(inside.id);
    check("A schedule to company addresses starts at once", sIn.ok === true && inside.isActive && inside.approvalStatus !== "PENDING");
    check("The schedule is edited", (await IA.updateScheduleAction({}, fd({ id: inside.id, name: `${tag} Inside`, recipients: "priya.sharma@acme.test, deepak.chauhan@acme.test", frequency: "MONTHLY", dayOfMonth: 5 }))).ok === true
      && (await prisma.scheduledReport.findUniqueOrThrow({ where: { id: inside.id } })).frequency === "MONTHLY");
    const sOut = await CW.scheduleReportAction({}, fd({ reportKey: "headcount", name: `${tag} Outside`, recipients: "board@example.com", frequency: "WEEKLY", dayOfWeek: 1 }));
    const outside = await prisma.scheduledReport.findFirstOrThrow({ where: { tenantId, name: `${tag} Outside` } });
    made.schedules.push(outside.id);
    check("A schedule mailing outside the company waits for approval", sOut.ok === true && outside.approvalStatus === "PENDING" && !outside.isActive, sOut.message);
    check("Approval switches it on", (await decideAll("REPORT_SCHEDULE", outside.id)) && (await prisma.scheduledReport.findUniqueOrThrow({ where: { id: outside.id } })).isActive);
    await signInAs(hr.email);
    const saved = await prisma.savedReport.create({ data: { tenantId, name: `${tag} Saved`, dataset: "employees", spec: {}, createdBy: hr.id } });
    made.saved.push(saved.id);
    check("Publishing a custom report goes for approval", (await IA.requestPublishReportAction({}, fd({ id: saved.id }))).ok === true);
    check("Approval shares it company-wide", (await decideAll("REPORT_PUBLISH", saved.id)) && (await prisma.savedReport.findUniqueOrThrow({ where: { id: saved.id } })).shared);

    // =========================================================================
    section("People analytics");
    await signInAs(hr.email);
    for (const t of ["cohorts", "overtime", "compensation", "pay-equity", "promotion", "mobility", "learning", "engagement", "managers", "time-to-fill", "cost-per-hire", "productivity", "diversity", "anomalies", "talent-risk"]) {
      check(`People analytics: ${t} renders`, ok(await render(pages.people, `/insights/people?tab=${t}`)));
    }
    for (const t of ["compensation", "pay-equity", "diversity", "engagement"]) {
      const tb = await runDataset(hrV, `people:${t}`);
      check(`People analytics: ${t} has a table`, !!tb && tb.columns.length > 0);
    }
    check("A cohort is saved", (await IA.saveCohortAction({}, form({ name: `${tag} 2022 joiners`, joinedFrom: "2022-01-01", joinedTo: "2022-12-31", includeExited: "on" }))).ok === true);
    const cohort = await prisma.insightCohort.findFirstOrThrow({ where: { tenantId, name: `${tag} 2022 joiners` } });
    made.cohorts.push(cohort.id);
    const members = await runDataset(hrV, `cohort:${cohort.id}`);
    check("The cohort lists only its members", !!members && members.rows.length > 0 && members.rows.every((r) => String(r.joined instanceof Date ? r.joined.toISOString() : r.joined).startsWith("2022")));
    check("A hiring cost is recorded", (await IA.addHiringCostAction({}, fd({ month: lastMonth, amount: 50000, category: "AGENCY", note: tag }))).ok === true);
    made.costs.push((await prisma.insightHiringCost.findFirstOrThrow({ where: { tenantId, note: tag } })).id);
    check("The talent-risk table downloads", (await get(insightExport, "/insights/export?ds=talent-risk&format=csv")).status === 200);
    check("The executive scorecard renders", ok(await render(pages.insights, "/insights")));
    const card = await runDataset(hrV, "scorecard");
    check("The scorecard has a company row and one per department", (card?.rows.length ?? 0) === 1 + (await prisma.department.count({ where: { tenantId } })));
    await signInAs(meera.email);
    check("An employee cannot open people analytics", (await render(pages.people, "/insights/people")) === "403");
    check("An employee opens personal analytics", ok(await render(pages.me, "/me/insights")));
    check("An employee without reports has no team dashboard", (await render(pages.team, "/team/insights")) === "403");
    await signInAs(ananya.email);
    check("A manager opens the manager HR dashboard", ok(await render(pages.team, "/team/insights")));

    // =========================================================================
    section("Performance: templates, scales, weights, conditions");
    await signInAs(admin.email);
    const cyc = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId, name: "Annual review 2025-26" } });
    check("A cycle is saved as a template", (await IP.saveCycleTemplateAction({}, fd({ cycleId: cyc.id, name: `${tag} Annual template` }))).ok === true);
    const ctpl = await prisma.insightCycleTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Annual template` } });
    made.cycleTemplates.push(ctpl.id);
    const nc = await IP.createCycleFromTemplateAction({}, fd({ templateId: ctpl.id, name: `${tag} Cycle`, periodStart: day(30), periodEnd: day(200) }));
    check("A new cycle is created from the template", nc.ok === true && !!nc.values?.cycleId, nc.message);
    const newCycle = await prisma.reviewCycle.findUniqueOrThrow({ where: { id: nc.values!.cycleId! }, include: { formSections: { include: { questions: true } } } });
    made.cycles.push(newCycle.id);
    check("The template carries the form and bands", newCycle.formSections.length === (await prisma.reviewFormSection.count({ where: { cycleId: cyc.id } }))
      && (await prisma.performanceBand.count({ where: { cycleId: newCycle.id } })) === (await prisma.performanceBand.count({ where: { cycleId: cyc.id } })));
    check("A rating scale without a point 2 is refused", (await IP.saveRatingScaleAction({}, fd({ name: `${tag} Bad`, points: "1 | Low\n3 | High" }))).ok === false);
    check("A 1–4 rating scale with descriptions is saved", (await IP.saveRatingScaleAction({}, fd({ name: `${tag} Four`, points: "1 | Below | Misses most goals\n2 | Meets | Hits goals\n3 | Exceeds | Beyond goals\n4 | Exceptional | Role model" }))).ok === true);
    const scale = await prisma.insightRatingScale.findFirstOrThrow({ where: { tenantId, name: `${tag} Four` } });
    made.scales.push(scale.id);
    check("The scale is applied to the draft cycle", (await IP.applyRatingScaleAction({}, fd({ cycleId: newCycle.id, scaleId: scale.id }))).ok === true
      && (await prisma.reviewCycle.findUniqueOrThrow({ where: { id: newCycle.id } })).ratingScaleId === scale.id);
    let comp = newCycle.formSections.flatMap((s) => s.questions).find((q) => q.kind === "COMPETENCY") ?? null;
    if (!comp) {
      const sec = newCycle.formSections[0] ?? await prisma.reviewFormSection.create({ data: { cycleId: newCycle.id, title: `${tag} Competencies`, displayOrder: 0 } });
      comp = await prisma.reviewFormQuestion.create({ data: { sectionId: sec.id, kind: "COMPETENCY", prompt: `${tag} Ownership`, competency: "Ownership", displayOrder: 99 } });
    }
    check("A competency is weighted", (await IP.setQuestionWeightAction({}, fd({ questionId: comp.id, weight: 3 }))).ok === true && Number((await prisma.reviewFormQuestion.findUniqueOrThrow({ where: { id: comp.id } })).weight) === 3);
    const extra = await prisma.reviewFormSection.create({ data: { cycleId: newCycle.id, title: `${tag} Improvement plan`, displayOrder: 50 } });
    check("A section shows only when a competency is rated 2 or lower", (await IP.setSectionConditionAction({}, fd({ sectionId: extra.id, conditionQuestionId: comp.id, conditionOp: "LTE", conditionValue: 2 }))).ok === true
      && (await prisma.reviewFormSection.findUniqueOrThrow({ where: { id: extra.id } })).conditionOp === "LTE");
    check("A 360 feedback template is needed for the 360 form", (await IP.apply360TemplateAction({}, fd({ cycleId: newCycle.id, templateId: "nope" }))).ok === false);
    const ft = await prisma.feedbackTemplate.create({ data: { tenantId, name: `${tag} 360`, purpose: "THREE_SIXTY", questions: ["What should they keep doing?", "What should they change?"], status: "APPROVED", createdBy: admin.id } });
    made.fbTemplates.push(ft.id);
    check("An approved 360 template becomes a form section", (await IP.apply360TemplateAction({}, fd({ cycleId: newCycle.id, templateId: ft.id }))).ok === true
      && (await prisma.reviewFormSection.count({ where: { cycleId: newCycle.id, title: `360: ${ft.name}` } })) === 1);
    check("360 settings are updated", (await IP.updateCycleSettingsAction({}, fd({ cycleId: newCycle.id, name: `${tag} Cycle`, maxPeers: 4, reviewClosesAt: day(190), anonymousFeedback: "on" }))).ok === true
      && (await prisma.reviewCycle.findUniqueOrThrow({ where: { id: newCycle.id } })).maxPeers === 4);
    check("The anonymity threshold is set", (await IP.saveAnonymityThresholdAction({}, fd({ minAnonymousResponses: 4 }))).ok === true
      && (await prisma.feedbackSetting.findUniqueOrThrow({ where: { tenantId } })).minAnonymousResponses === 4);
    check("A template is switched off", (await IP.toggleCycleTemplateAction({}, fd({ id: ctpl.id }))).ok === true);

    section("Performance: exceptions, calibration, summaries, reminders, reopening");
    const mid = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId, name: "Mid-year 2026-27" } });
    check("Exceptions are refreshed for a cycle", (await IP.refreshExceptionsAction({}, fd({ cycleId: mid.id }))).ok === true);
    const ex = await prisma.insightPerfException.findFirst({ where: { tenantId, cycleId: mid.id, status: "OPEN" } });
    check("The exception queue has items", !!ex);
    if (ex) check("An exception is resolved with a note", (await IP.resolveExceptionAction({}, fd({ id: ex.id, status: "RESOLVED", note: "Spoke to the manager" }))).ok === true);
    check("A calibration note is added", (await IP.addCalibrationNoteAction({}, fd({ cycleId: cyc.id, employeeId: meera.employee!.id, body: "Strong delivery; held at 4 for consistency", tags: "consistency, delivery" }))).ok === true);
    const cn = await prisma.insightCalibrationNote.findFirstOrThrow({ where: { tenantId, cycleId: cyc.id, authorUserId: admin.id, createdAt: { gte: started } } });
    made.calNotes.push(cn.id);
    const meeraReview = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: cyc.id, employeeId: meera.employee!.id } });
    check("A summary is generated from the review's facts", (await IP.generateReviewSummaryAction({}, fd({ reviewId: meeraReview.id }))).ok === true);
    const summaryRow = (await runDataset((await viewerForUser(admin.id))!, "summaries", { q: "Meera" }))?.rows ?? [];
    check("Summaries are searchable", summaryRow.length > 0);
    check("Review reminders run", (await IP.runInsightJobAction({}, fd({ job: "reviews" }))).ok === true);
    for (const t of ["templates", "scales", "form", "data", "exceptions", "calibration", "normalization", "trend", "summaries", "reopen", "audit"]) check(`Review operations tab ${t} renders`, ok(await render(pages.ops, `/performance/operations?tab=${t}&cycleId=${cyc.id}`)));
    const perfXl = await get(insightExport, `/insights/export?ds=perf-data:${cyc.id}&format=xlsx`);
    check("Performance data exports to Excel", perfXl.status === 200);
    check("The trend across cycles has every completed cycle", ((await runDataset((await viewerForUser(admin.id))!, "perf-trend"))?.rows.length ?? 0) >= 2);
    check("Normalised ratings are computed", ((await runDataset((await viewerForUser(admin.id))!, `perf-normalized:${cyc.id}`))?.rows.length ?? 0) > 0);

    const resp = await prisma.reviewResponse.findMany({ where: { reviewId: meeraReview.id, reviewerType: "MANAGER" } });
    reopened = { review: { ...meeraReview, finalRating: meeraReview.finalRating }, responses: resp.map((r) => ({ id: r.id, submittedAt: r.submittedAt, status: r.status })), cycleStatus: cyc.status };
    await signInAs(meera.email);
    check("An employee cannot ask to reopen a review", (await IP.requestReviewReopenAction({}, fd({ reviewId: meeraReview.id, reason: "Please reopen it" }))).ok === false);
    await signInAs(ananya.email);
    check("The manager asks to reopen a shared review", (await IP.requestReviewReopenAction({}, fd({ reviewId: meeraReview.id, reason: "A project outcome was missed" }))).ok === true);
    const reo = await prisma.insightReviewReopen.findFirstOrThrow({ where: { tenantId, reviewId: meeraReview.id, status: "PENDING" } });
    check("The reopening request is in the approver's inbox", await inInbox(admin.email, "REVIEW_REOPEN"));
    check("Approval sends the review back to the manager", (await decideAll("REVIEW_REOPEN", reo.id)) && (await prisma.employeeReview.findUniqueOrThrow({ where: { id: meeraReview.id } })).status === "MANAGER_PENDING");

    // =========================================================================
    section("OKRs");
    await signInAs(admin.email);
    check("OKR settings: approval on, weekly cadence", (await IP.saveOkrSettingAction({}, fd({ requireApproval: "on", defaultCadence: "WEEKLY", graceDays: 2 }))).ok === true);
    const goalBase = { metricType: "NUMBER_INCREASE", startValue: 0, targetValue: 100, startDate: day(-60), dueDate: day(60), weight: 0 };
    await signInAs(meera.email);
    const g1 = await PF.saveGoalAction({}, fd({ ...goalBase, title: `${tag} Ship the importer`, level: "INDIVIDUAL" }));
    const goal = await prisma.goal.findFirstOrThrow({ where: { tenantId, title: `${tag} Ship the importer` } });
    made.goals.push(goal.id);
    check("A self-set goal waits for the manager's approval", g1.ok === true && goal.approvalStatus === "PENDING" && goal.status === "DRAFT", g1.message);
    check("A goal pending approval cannot be checked in", (await PF.checkInAction({}, fd({ goalId: goal.id, value: 10 }))).ok === false);
    check("The goal approval is in the manager's inbox", await inInbox(ananya.email, "GOAL_APPROVAL"));
    const gd = await decide("GOAL_APPROVAL", goal.id);
    check("The reporting manager approves it", gd.ok === true && gd.approver === ananya.email && (await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).approvalStatus === "APPROVED");
    await signInAs(meera.email);
    const g2 = await PF.saveGoalAction({}, fd({ ...goalBase, title: `${tag} Rejected goal`, level: "INDIVIDUAL" }));
    const goal2 = await prisma.goal.findFirstOrThrow({ where: { tenantId, title: `${tag} Rejected goal` } });
    made.goals.push(goal2.id);
    check("A rejected goal is sent back", g2.ok === true && (await decideAll("GOAL_APPROVAL", goal2.id, false)) && (await prisma.goal.findUniqueOrThrow({ where: { id: goal2.id } })).approvalStatus === "REJECTED");
    await signInAs(admin.email);
    const g3 = await PF.saveGoalAction({}, fd({ ...goalBase, title: `${tag} Company revenue`, level: "COMPANY" }));
    const goal3 = await prisma.goal.findFirstOrThrow({ where: { tenantId, title: `${tag} Company revenue` } });
    made.goals.push(goal3.id);
    check("An organisation OKR goes to a goal administrator", g3.ok === true && goal3.approvalStatus !== null, g3.message);
    if (goal3.approvalStatus === "PENDING") await decideAll("GOAL_APPROVAL", goal3.id);
    check("The organisation OKR is live after approval", (await prisma.goal.findUniqueOrThrow({ where: { id: goal3.id } })).approvalStatus === "APPROVED");

    await signInAs(admin.email);
    const g4 = await PF.saveGoalAction({}, fd({ ...goalBase, title: `${tag} Team throughput`, level: "TEAM" }));
    const goal4 = await prisma.goal.findFirst({ where: { tenantId, title: `${tag} Team throughput` } });
    if (goal4) made.goals.push(goal4.id);
    if (goal4?.approvalStatus === "PENDING") await decideAll("GOAL_APPROVAL", goal4.id);
    check("A team OKR goes through approval too", g4.ok === true && !!goal4 && (await prisma.goal.findUniqueOrThrow({ where: { id: goal4.id } })).approvalStatus === "APPROVED", g4.message);
    await signInAs(meera.email);
    check("A stretch target below the target is refused", (await IP.setGoalPlanAction({}, fd({ goalId: goal.id, stretchValue: 50 }))).ok === false);
    check("A stretch target and a cadence are set", (await IP.setGoalPlanAction({}, fd({ goalId: goal.id, stretchValue: 150, checkInCadence: "BIWEEKLY" }))).ok === true);
    check("Confidence outside 0–10 is refused", (await PF.checkInAction({}, fd({ goalId: goal.id, value: 40, confidence: 11 }))).ok === false);
    check("A check-in records confidence", (await PF.checkInAction({}, fd({ goalId: goal.id, value: 40, confidence: 3, note: "Blocked on API" }))).ok === true
      && (await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).confidence === 3);
    check("Check-ins are audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "GoalCheckIn", entityId: goal.id } })) >= 1);
    check("Goal edits are audited", (await PF.saveGoalAction({}, fd({ ...goalBase, id: goal.id, title: `${tag} Ship the importer`, level: "INDIVIDUAL", description: "v2" }))).ok === true
      && (await prisma.auditLog.count({ where: { tenantId, entityType: "Goal", entityId: goal.id, action: "UPDATE" } })) >= 1);
    await signInAs(ananya.email);
    check("The manager triages the low-confidence objective", (await IP.triageGoalAction({}, fd({ goalId: goal.id, riskNote: "Pair with platform team" }))).ok === true && !!(await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).riskReviewedAt);
    await signInAs(meera.email);
    check("Meera's objective supports the company OKR", (await IP.linkGoalsAction({}, fd({ fromGoalId: goal.id, toGoalId: goal3.id, kind: "SUPPORTS", note: "Cross-team" }))).ok === true);
    await signInAs(admin.email);
    check("A dependency is mapped", (await IP.linkGoalsAction({}, fd({ fromGoalId: goal3.id, toGoalId: goal.id, kind: "DEPENDS_ON" }))).ok === true);
    check("A dependency loop is refused", (await IP.linkGoalsAction({}, fd({ fromGoalId: goal.id, toGoalId: goal3.id, kind: "DEPENDS_ON" }))).ok === false);
    await prisma.goalCheckIn.updateMany({ where: { goalId: goal.id }, data: { recordedAt: new Date(Date.now() - 40 * 86_400_000) } });
    check("Overdue check-in alerts go out", (await IP.runInsightJobAction({}, fd({ job: "checkins" }))).ok === true
      && (await prisma.notification.count({ where: { tenantId, userId: meera.id, createdAt: { gte: started }, title: { contains: "check-in", mode: "insensitive" } } })) >= 1);
    const link = await prisma.insightGoalLink.findFirstOrThrow({ where: { tenantId, fromGoalId: goal3.id } });
    check("A link is removed", (await IP.unlinkGoalsAction({}, fd({ id: link.id }))).ok === true);
    check("A snapshot of the OKRs is taken", (await IP.snapshotGoalsAction({}, fd({ label: `${tag} mid-quarter` }))).ok === true && (await prisma.insightGoalSnapshot.count({ where: { tenantId, label: `${tag} mid-quarter` } })) >= 3);
    const tf = `${tag}-Q`;
    await prisma.goal.updateMany({ where: { id: { in: [goal.id, goal3.id] } }, data: { timeframe: tf } });
    check("Close-out of a timeframe goes for approval", (await IP.requestCloseoutAction({}, fd({ timeframe: tf, note: "Quarter over" }))).ok === true);
    const co = await prisma.insightOkrCloseout.findFirstOrThrow({ where: { tenantId, timeframe: tf } });
    check("Approved close-out scores and locks the goals", (await decideAll("OKR_CLOSEOUT", co.id)) && (await prisma.insightOkrCloseout.findUniqueOrThrow({ where: { id: co.id } })).status === "APPROVED"
      && !!(await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).closedOutAt, (await prisma.insightOkrCloseout.findUniqueOrThrow({ where: { id: co.id } })).status);
    await signInAs(admin.email);
    for (const t of ["goals", "checkins", "risk", "links", "approvals", "closeout", "snapshots", "settings", "audit"]) check(`OKR tab ${t} renders`, ok(await render(pages.okr, `/performance/okr?tab=${t}`)));
    check("The OKR plan form renders", ok(await render(pages.okr, `/performance/okr?tab=goals&goal=${goal3.id}`)));
    const okrXl = await get(insightExport, "/insights/export?ds=okr&format=xlsx");
    check("The OKR export package downloads", okrXl.status === 200);
    check("The OKR audit history lists goal changes", ((await runDataset((await viewerForUser(admin.id))!, "okr-audit"))?.rows.length ?? 0) >= 3);

    // =========================================================================
    section("Continuous feedback");
    await signInAs(admin.email);
    check("A feedback topic is added", (await IP.saveFeedbackTopicAction({}, fd({ name: `${tag} Delivery` }))).ok === true);
    const topic = await prisma.insightFeedbackTopic.findFirstOrThrow({ where: { tenantId, name: `${tag} Delivery` } });
    made.topics.push(topic.id);
    check("A sub-topic is added", (await IP.saveFeedbackTopicAction({}, fd({ name: `${tag} Deadlines`, parentId: topic.id }))).ok === true);
    made.topics.push((await prisma.insightFeedbackTopic.findFirstOrThrow({ where: { tenantId, name: `${tag} Deadlines` } })).id);
    check("A keyword escalation rule is added", (await IP.saveFeedbackRuleAction({}, fd({ name: `${tag} Harassment`, trigger: "KEYWORD", keyword: "harass", notify: "HR" }))).ok === true);
    check("A negative-sentiment rule notifies the manager", (await IP.saveFeedbackRuleAction({}, fd({ name: `${tag} Negative`, trigger: "NEGATIVE", notify: "MANAGER" }))).ok === true);
    made.rules.push(...(await prisma.insightFeedbackRule.findMany({ where: { tenantId, name: { startsWith: tag } } })).map((r) => r.id));
    await signInAs(meera.email);
    const weak = await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.employee!.id, kind: "FEEDBACK", message: "Good job", qualityCheck: "1" }));
    check("A vague message gets quality prompts first", weak.ok === false && /Before you send/.test(weak.message ?? ""));
    const sentAnyway = await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.employee!.id, kind: "FEEDBACK", message: `Good job ${tag}`, qualityCheck: "1", sendAnyway: true }));
    check("Send as written skips the prompts", sentAnyway.ok === true, sentAnyway.message);
    const good = await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: aditya.id, kind: "FEEDBACK", message: `${tag} In the release review the handover notes were late and full of errors, which blocked QA. Next time try sharing a draft a day earlier.`, qualityCheck: "1", topicId: topic.id, tags: "handover, qa" }));
    check("Specific feedback with a topic and tags is sent", good.ok === true, good.message);
    const fbRow = await prisma.feedback.findFirstOrThrow({ where: { tenantId, message: { contains: `${tag} In the release` } } });
    made.feedback.push(fbRow.id, (await prisma.feedback.findFirstOrThrow({ where: { tenantId, message: `Good job ${tag}` } })).id);
    check("Feedback carries the topic and tags", fbRow.topicId === topic.id && fbRow.tags.includes("handover"));
    check("Sentiment is classified", fbRow.sentiment === "NEGATIVE", `${fbRow.sentiment}`);
    check("A negative-sentiment escalation is raised", (await prisma.insightFeedbackEscalation.count({ where: { tenantId, feedbackId: fbRow.id } })) >= 1);
    const tFb = await prisma.feedbackTemplate.create({ data: { tenantId, name: `${tag} Peer`, purpose: "PEER", questions: ["What went well?", "What next?"], status: "APPROVED", createdBy: admin.id } });
    made.fbTemplates.push(tFb.id);
    check("A template's unanswered question is refused", (await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.employee!.id, kind: "FEEDBACK", templateId: tFb.id, answer_0: "The demo" }))).ok === false);
    check("Feedback is given with a template", (await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.employee!.id, kind: "FEEDBACK", templateId: tFb.id, answer_0: `${tag} the demo`, answer_1: "More tests" }))).ok === true);
    const tplFb = await prisma.feedback.findFirstOrThrow({ where: { tenantId, templateId: tFb.id } });
    made.feedback.push(tplFb.id);
    check("The author edits feedback within 48 hours", (await IP.editFeedbackAction({}, fd({ id: tplFb.id, message: `${tag} edited message`, tags: "demo" }))).ok === true && !!(await prisma.feedback.findUniqueOrThrow({ where: { id: tplFb.id } })).editedAt);
    await signInAs(ananya.email);
    check("Someone else cannot edit it", (await IP.editFeedbackAction({}, fd({ id: tplFb.id, message: "hijack" }))).ok === false);
    check("The subject's manager adds a follow-up", (await IP.addFollowUpAction({}, fd({ feedbackId: fbRow.id, title: `${tag} Agree a handover checklist`, dueDate: day(7) }))).ok === true);
    const fu = await prisma.insightFeedbackFollowUp.findFirstOrThrow({ where: { tenantId, feedbackId: fbRow.id } });
    check("A follow-up is completed", (await IP.completeFollowUpAction({}, fd({ id: fu.id }))).ok === true && (await prisma.insightFeedbackFollowUp.findUniqueOrThrow({ where: { id: fu.id } })).status === "DONE");
    await signInAs(meera.email);
    check("The author deletes their feedback", (await IP.deleteFeedbackAction({}, fd({ id: tplFb.id }))).ok === true && !!(await prisma.feedback.findUniqueOrThrow({ where: { id: tplFb.id } })).deletedAt);
    await prisma.feedback.update({ where: { id: fbRow.id }, data: { createdAt: new Date(Date.now() - 72 * 3_600_000) } });
    check("Edits after 48 hours are refused", (await IP.editFeedbackAction({}, fd({ id: fbRow.id, message: "late edit" }))).ok === false);
    const rq = await TP.requestFeedbackAction({}, fd({ askedIds: ananya.employee!.id, aboutEmployeeId: meera.employee!.id, message: `${tag} How did the demo land?`, dueDate: day(5) }));
    const req = await prisma.feedbackRequest.findFirst({ where: { tenantId, message: `${tag} How did the demo land?` } });
    if (req) made.requests.push(req.id);
    check("A feedback request is made", rq.ok === true && !!req, rq.message);
    if (req) {
      check("The requester edits the request", (await IP.updateFeedbackRequestAction({}, fd({ id: req.id, op: "edit", message: `${tag} How did the demo land, really?`, dueDate: day(9) }))).ok === true);
      check("Requests are searchable", ((await runDataset((await viewerForUser(meera.id))!, "feedback-requests", { q: tag }))?.rows.length ?? 0) === 1);
      check("The requester withdraws it", (await IP.updateFeedbackRequestAction({}, fd({ id: req.id, op: "withdraw" }))).ok === true && (await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: req.id } })).status === "WITHDRAWN");
    }
    await signInAs(admin.email);
    const esc = await prisma.insightFeedbackEscalation.findFirstOrThrow({ where: { tenantId, feedbackId: fbRow.id } });
    check("HR resolves the escalation", (await IP.resolveEscalationAction({}, fd({ id: esc.id, note: "Discussed with both" }))).ok === true);
    check("Feedback search by tag", ((await runDataset((await viewerForUser(admin.id))!, "feedback", { q: "handover" }))?.rows ?? []).some((r) => r.id === fbRow.id));
    check("Feedback filters by sentiment", ((await runDataset((await viewerForUser(admin.id))!, "feedback", { sentiment: "NEGATIVE", topicId: topic.id }))?.rows ?? []).every((r) => r.sentiment === "NEGATIVE"));
    const fbCsv = await get(insightExport, `/insights/export?ds=feedback&format=csv&q=${tag}`);
    check("Feedback exports for HR", fbCsv.status === 200 && (await fbCsv.text()).includes(tag));
    check("Feedback requests export", (await get(insightExport, "/insights/export?ds=feedback-requests&format=xlsx")).status === 200);
    check("360 campaigns are searchable", ((await runDataset((await viewerForUser(admin.id))!, "campaigns", { q: tag }))?.rows ?? []).length === 1);
    check("The 360 campaign report exports", (await get(insightExport, "/insights/export?ds=campaigns&format=pdf")).status === 200);
    check("Feedback summaries export", (await get(insightExport, "/insights/export?ds=summaries&format=csv")).status === 200);
    check("The feedback template report exports", (await get(insightExport, "/insights/export?ds=feedback-templates&format=xlsx")).status === 200);
    check("Digests go out", (await IP.runInsightJobAction({}, fd({ job: "digests" }))).ok === true);
    for (const t of ["feedback", "give", "requests", "followups", "timeline", "campaigns", "compare", "summaries", "trends", "topics", "rules", "templates", "settings", "audit"]) check(`Feedback hub tab ${t} renders`, ok(await render(pages.hub, `/performance/feedback-hub?tab=${t}`)));
    check("The campaign manager renders", ok(await render(pages.hub, `/performance/feedback-hub?tab=campaigns&cycleId=${newCycle.id}`)));
    check("A templated give form renders", ok(await render(pages.hub, `/performance/feedback-hub?tab=give&template=${tFb.id}`)));
    check("The feedback template report counts uses", ((await runDataset((await viewerForUser(admin.id))!, "feedback-templates"))?.rows ?? []).some((r) => r.name === `${tag} Peer` && r.questions === 2 && r.uses === 0));
    await signInAs(meera.email);
    check("An employee's hub hides admin tabs", (await render(pages.hub, "/performance/feedback-hub?tab=audit")).includes("Give feedback") && !(await render(pages.hub, "/performance/feedback-hub")).includes("Escalation rules"));
    check("An employee cannot export the feedback audit", (await get(insightExport, "/insights/export?ds=feedback-audit&format=csv")).status === 403);

    // =========================================================================
    section("PIPs and coaching");
    await signInAs(hr.email);
    check("PIP rules are saved", (await IP.savePipSettingAction({}, fd({ minTenureDays: 180, blockProbation: "on", blockNotice: "on", requireChecklist: "on", defaultChecklist: "HR review of evidence\n?Employee counselling offered", coachingReminderDays: 7 }))).ok === true);
    check("A PIP template with milestones is saved", (await IP.savePipTemplateAction({}, fd({ kind: "PIP", name: `${tag} Delivery PIP`, durationDays: 60, reason: "Missed delivery commitments", objectives: "Ship two features on time\nWeekly status notes", milestones: "First review @ 30\nFinal review @ 60", checklist: "HR review of evidence\nLegal sign-off" }))).ok === true);
    check("A milestone after the end is refused", (await IP.savePipTemplateAction({}, fd({ kind: "PIP", name: `${tag} Bad`, durationDays: 30, milestones: "Late @ 90" }))).ok === false);
    check("A coaching template is saved", (await IP.savePipTemplateAction({}, fd({ kind: "COACHING", name: `${tag} Stakeholder coaching`, durationDays: 90, objectives: "Run stakeholder updates", sessionEveryDays: 14 }))).ok === true);
    const pipT = await prisma.insightPipTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Delivery PIP` } });
    const coachT = await prisma.insightPipTemplate.findFirstOrThrow({ where: { tenantId, name: `${tag} Stakeholder coaching` } });
    made.pipTemplates.push(pipT.id, coachT.id);
    check("Someone on probation is not eligible", /probation/i.test((await IP.startPipFromTemplateAction({}, fd({ templateId: pipT.id, employeeId: harish.id }))).message ?? ""));
    check("Someone serving notice is not eligible", /notice/i.test((await IP.startPipFromTemplateAction({}, fd({ templateId: pipT.id, employeeId: gaurav.id }))).message ?? ""));
    const sp = await IP.startPipFromTemplateAction({}, fd({ templateId: pipT.id, employeeId: aditya.id, startDate: day(-10) }));
    check("A plan starts from the template", sp.ok === true && !!sp.values?.pipId, sp.message);
    const pipId = sp.values!.pipId!;
    made.pips.push(pipId);
    check("The template's objectives, milestones and checklist come with it",
      (await prisma.insightPipObjective.count({ where: { pipId } })) === 2 && (await prisma.pipMilestone.count({ where: { pipId } })) === 2 && (await prisma.insightPipChecklistItem.count({ where: { pipId } })) === 2);
    check("A weighted objective is added", (await IP.savePipObjectiveAction({}, fd({ pipId, title: "Zero P1 bugs", measure: "Bug tracker", target: "0", weight: 2 }))).ok === true);
    const evid = await IP.addPipEvidenceAction({}, form({ pipId, title: "Sprint report", kind: "DOCUMENT", file: new File([Buffer.from("%PDF-1.4\n%%EOF\n")], "sprint.pdf", { type: "application/pdf" }) }));
    check("Evidence is attached as a file", evid.ok === true && !!(await prisma.insightPipEvidence.findFirst({ where: { pipId, fileId: { not: null } } })), evid.message);
    check("An observation is recorded as evidence", (await IP.addPipEvidenceAction({}, fd({ pipId, title: "Stand-up", note: "Gave a clear update" }))).ok === true);
    check("A checklist item is added", (await IP.checklistItemAction({}, fd({ pipId, op: "add", label: "Optional coaching", optional: "on" }))).ok === true);
    await signInAs(ananya.email);
    check("The manager logs a behaviour", (await IP.logBehaviourAction({}, fd({ pipId, behaviour: "Status updates", rating: 2, observedOn: day(-5) }))).ok === true);
    check("A later observation shows improvement", (await IP.logBehaviourAction({}, fd({ pipId, behaviour: "Status updates", rating: 4, observedOn: day(-1) }))).ok === true);
    check("A rating outside 1–5 is refused", (await IP.logBehaviourAction({}, fd({ pipId, behaviour: "X", rating: 9 }))).ok === false);
    check("The manager records a check-in", (await DV.pipCheckInAction({}, fd({ pipId, heldOn: day(-2), progress: "AT_RISK", notes: "Two of three tasks late" }))).ok === true);
    const checkIn = await prisma.pipCheckIn.findFirstOrThrow({ where: { pipId } });
    check("Check-in sign-off goes to HR", (await IP.requestPipChangeAction({}, fd({ pipId, kind: "CHECKIN_SIGNOFF", checkInId: checkIn.id, reason: "Please confirm the at-risk call" }))).ok === true);
    const signoff = await prisma.insightPipRequest.findFirstOrThrow({ where: { pipId, kind: "CHECKIN_SIGNOFF" } });
    check("The sign-off is in HR's inbox", await inInbox(hr.email, "PIP_REQUEST") || await inInbox(admin.email, "PIP_REQUEST"));
    check("HR signs off the check-in", (await decideAll("PIP_REQUEST", signoff.id)) && (await prisma.pipCheckIn.findUniqueOrThrow({ where: { id: checkIn.id } })).signoffStatus === "APPROVED");
    await signInAs(ananya.email);
    check("An extension beyond the limit is refused", (await IP.requestPipChangeAction({}, fd({ pipId, kind: "EXTENSION", days: 200, reason: "Needs much more time" }))).ok === false);
    const endBefore = (await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pipId } })).endDate;
    check("An extension is requested", (await IP.requestPipChangeAction({}, fd({ pipId, kind: "EXTENSION", days: 21, reason: "Holiday period lost two weeks" }))).ok === true);
    const ext = await prisma.insightPipRequest.findFirstOrThrow({ where: { pipId, kind: "EXTENSION" } });
    check("Approval extends the plan", (await decideAll("PIP_REQUEST", ext.id)) && (await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pipId } })).endDate.getTime() === endBefore.getTime() + 21 * 86_400_000);
    await signInAs(ananya.email);
    check("An escalation is requested", (await IP.requestPipChangeAction({}, fd({ pipId, kind: "ESCALATION", reason: "No improvement after coaching" }))).ok === true);
    const escR = await prisma.insightPipRequest.findFirstOrThrow({ where: { pipId, kind: "ESCALATION" } });
    check("The escalation is approved by the skip manager and HR", (await decideAll("PIP_REQUEST", escR.id)) && (await prisma.insightPipEvidence.count({ where: { pipId, title: "Escalation approved" } })) === 1);
    await signInAs(hr.email);
    check("The plan cannot close with open objectives and checklist", /Not ready to close/.test((await PF.closePipAction({}, fd({ id: pipId, outcome: "SUCCESSFUL", note: "Done" }))).message ?? ""));
    for (const o of await prisma.insightPipObjective.findMany({ where: { pipId } })) await IP.savePipObjectiveAction({}, fd({ id: o.id, status: "MET" }));
    for (const m of await prisma.pipMilestone.findMany({ where: { pipId } })) await DV.pipMilestoneAction({}, fd({ milestoneId: m.id, op: "met", note: "ok" }));
    check("Milestones are marked met", (await prisma.pipMilestone.count({ where: { pipId, status: "MET" } })) === 2);
    for (const c of await prisma.insightPipChecklistItem.findMany({ where: { pipId, required: true } })) await IP.checklistItemAction({}, fd({ id: c.id, op: "done", note: "Done" }));
    const closed = await PF.closePipAction({}, fd({ id: pipId, outcome: "SUCCESSFUL", note: "All objectives met" }));
    check("With every criterion met the plan closes", closed.ok === true && (await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pipId } })).status === "CLOSED", closed.message);
    check("A closed outcome's note needs a reason to change", (await IP.editPipOutcomeAction({}, fd({ pipId, note: "All objectives met; strong finish" }))).ok === false);
    check("The outcome record is amended with a reason", (await IP.editPipOutcomeAction({}, fd({ pipId, note: "All objectives met; strong finish", reason: "Typo in the original" }))).ok === true);
    const cs = await IP.startCoachingFromTemplateAction({}, fd({ templateId: coachT.id, employeeId: meera.employee!.id, coachId: ananya.employee!.id }));
    check("Coaching is proposed from a template", cs.ok === true, cs.message);
    const coach = await prisma.coachingPlan.findFirstOrThrow({ where: { tenantId, focusArea: `${tag} Stakeholder coaching` } });
    made.coaching.push(coach.id);
    await prisma.coachingPlan.update({ where: { id: coach.id }, data: { status: "ACTIVE", startDate: new Date(Date.now() - 30 * 86_400_000) } });
    await signInAs(ananya.email);
    check("The coach logs a behaviour on the coaching plan", (await IP.logBehaviourAction({}, fd({ coachingPlanId: coach.id, behaviour: "Stakeholder updates", rating: 3 }))).ok === true);
    await signInAs(hr.email);
    check("Coaching reminders go out", (await IP.runInsightJobAction({}, fd({ job: "coaching" }))).ok === true
      && (await prisma.notification.count({ where: { tenantId, userId: ananya.id, createdAt: { gte: started }, title: { contains: "oaching" } } })) >= 1);
    for (const t of ["register", "risk", "checkins", "requests", "templates", "coaching", "settings"]) check(`PIP operations tab ${t} renders`, ok(await render(pages.pipOps, `/performance/pip-ops?tab=${t}`)));
    check("Coaching behaviours and timeline render", ok(await render(pages.pipOps, `/performance/pip-ops?tab=coaching&plan=${coach.id}`)));
    check("The plan page renders for HR", ok(await render(pages.plan, `/performance/plans/${pipId}`, { id: pipId })));
    check("The register shows weighted objectives met", ((await runDataset((await viewerForUser(hr.id))!, "pip-register"))?.rows ?? []).some((r) => r.id === pipId && r.objectives === "3/3"));
    check("Performance risk indicators list people", ((await runDataset((await viewerForUser(hr.id))!, "perf-risk", { all: "1" }))?.rows.length ?? 0) > 0);
    check("The check-in report exports", (await get(insightExport, "/insights/export?ds=pip-checkins&format=xlsx")).status === 200);
    await signInAs(meera.email);
    check("Someone else cannot open the plan", (await render(pages.plan, `/performance/plans/${pipId}`, { id: pipId })) === "404");
    check("An employee without reports cannot open PIP operations", (await render(pages.pipOps, "/performance/pip-ops")) === "403");

    section("Nightly job");
    const job = await svc.runInsightJobs(tenantId, new Date());
    check("The insight job runs every step", typeof job === "object" && job !== null);
  } finally {
    const unlinkFiles = async (where: object) => {
      const files = await prisma.storedFile.findMany({ where: { tenantId, createdAt: { gte: started }, ...where } });
      for (const f of files) await unlink(path.join(process.env.STORAGE_DIR ?? path.resolve(__dirname, "../.storage"), f.storageKey)).catch(() => {});
      await prisma.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    };
    if (reopened) {
      const r = reopened.review;
      await prisma.employeeReview.update({ where: { id: r.id }, data: { status: r.status as never, finalRating: r.finalRating as never, bandId: r.bandId, calibratedAt: r.calibratedAt, calibratedBy: r.calibratedBy, sharedAt: r.sharedAt, acknowledgedAt: r.acknowledgedAt } });
      for (const x of reopened.responses) await prisma.reviewResponse.update({ where: { id: x.id }, data: { submittedAt: x.submittedAt, status: x.status } });
      await prisma.reviewCycle.update({ where: { id: r.cycleId }, data: { status: reopened.cycleStatus as never } });
    }
    await prisma.workflowRequest.deleteMany({ where: { tenantId, createdAt: { gte: started }, entityType: { in: ["INSIGHT_METRIC", "INSIGHT_KRA", "INSIGHT_DASHBOARD", "REPORT_ACCESS", "REPORT_PUBLISH", "REPORT_SCHEDULE", "REPORT_EXPORT", "GOAL_APPROVAL", "OKR_CLOSEOUT", "REVIEW_REOPEN", "PIP_REQUEST"] } } });
    await prisma.insightReviewReopen.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.insightPerfException.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.insightCalibrationNote.deleteMany({ where: { id: { in: made.calNotes } } });
    await prisma.insightMetric.deleteMany({ where: { tenantId, key: { in: made.metricKeys } } });
    await prisma.insightKpiReading.deleteMany({ where: { kpiId: { in: made.kpis } } });
    await prisma.insightKpiTarget.deleteMany({ where: { kpiId: { in: made.kpis } } });
    await prisma.insightKpi.deleteMany({ where: { id: { in: made.kpis } } });
    await prisma.insightKra.deleteMany({ where: { id: { in: made.kras } } });
    await prisma.insightDashboard.deleteMany({ where: { id: { in: made.dashboards } } });
    await prisma.insightReportGrant.deleteMany({ where: { id: { in: made.grants } } });
    await prisma.insightExportRequest.deleteMany({ where: { profileId: { in: made.profiles } } });
    await prisma.insightExportProfile.deleteMany({ where: { id: { in: made.profiles } } });
    await prisma.insightFilterPreset.deleteMany({ where: { id: { in: made.presets } } });
    await prisma.insightReportSnapshot.deleteMany({ where: { id: { in: made.snapshots } } });
    await prisma.insightReportRun.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.scheduledReport.deleteMany({ where: { id: { in: made.schedules } } });
    await prisma.savedReport.deleteMany({ where: { id: { in: made.saved } } });
    await prisma.insightCohort.deleteMany({ where: { id: { in: made.cohorts } } });
    await prisma.insightHiringCost.deleteMany({ where: { id: { in: made.costs } } });
    await prisma.reviewCycle.deleteMany({ where: { id: { in: made.cycles } } });
    await prisma.insightCycleTemplate.deleteMany({ where: { id: { in: made.cycleTemplates } } });
    await prisma.insightRatingScale.deleteMany({ where: { id: { in: made.scales } } });
    await prisma.insightGoalLink.deleteMany({ where: { tenantId, OR: [{ fromGoalId: { in: made.goals } }, { toGoalId: { in: made.goals } }] } });
    await prisma.insightGoalSnapshot.deleteMany({ where: { tenantId, takenAt: { gte: started } } });
    await prisma.insightOkrCloseout.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.goal.deleteMany({ where: { id: { in: made.goals } } });
    await prisma.insightFeedbackEscalation.deleteMany({ where: { tenantId, OR: [{ ruleId: { in: made.rules } }, { createdAt: { gte: started } }] } });
    await prisma.insightFeedbackFollowUp.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.feedbackRequest.deleteMany({ where: { id: { in: made.requests } } });
    await prisma.feedback.deleteMany({ where: { id: { in: made.feedback } } });
    await prisma.insightFeedbackRule.deleteMany({ where: { id: { in: made.rules } } });
    await prisma.insightFeedbackTopic.deleteMany({ where: { id: { in: made.topics } } });
    await prisma.feedbackTemplate.deleteMany({ where: { id: { in: made.fbTemplates } } });
    await prisma.insightBehaviorLog.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.insightPipRequest.deleteMany({ where: { pipId: { in: made.pips } } });
    await prisma.insightPipObjective.deleteMany({ where: { pipId: { in: made.pips } } });
    await prisma.insightPipEvidence.deleteMany({ where: { pipId: { in: made.pips } } });
    await prisma.insightPipChecklistItem.deleteMany({ where: { pipId: { in: made.pips } } });
    await prisma.improvementPlan.deleteMany({ where: { id: { in: made.pips } } });
    await prisma.coachingPlan.deleteMany({ where: { id: { in: made.coaching } } });
    await prisma.insightPipTemplate.deleteMany({ where: { id: { in: made.pipTemplates } } });
    const restore = async <T extends { id: string; tenantId: string } | null>(row: T, model: { deleteMany: (a: { where: { tenantId: string } }) => Promise<unknown>; update: (a: { where: { tenantId: string }; data: Record<string, unknown> }) => Promise<unknown> }) => {
      if (!row) { await model.deleteMany({ where: { tenantId } }); return; }
      const { id: _i, tenantId: _t, updatedAt: _u, ...rest } = row as unknown as Record<string, unknown>;
      await model.update({ where: { tenantId }, data: rest });
    };
    await restore(before.okr, prisma.insightOkrSetting as never);
    await restore(before.pip, prisma.insightPipSetting as never);
    if (before.fb) await prisma.feedbackSetting.update({ where: { tenantId }, data: { minAnonymousResponses: before.fb.minAnonymousResponses } });
    else await prisma.feedbackSetting.deleteMany({ where: { tenantId } });
    await prisma.insightAlert.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.reviewResponse.updateMany({ where: { review: { cycle: { tenantId } }, remindedAt: { gte: started } }, data: { remindedAt: null } });
    await prisma.feedbackRequest.updateMany({ where: { tenantId, remindedAt: { gte: started } }, data: { remindedAt: null } });
    await unlinkFiles({ relatedType: "PipEvidence" });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  report("Insight depth");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
