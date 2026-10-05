import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { INSIGHT_CALCULATORS, METRIC_CATEGORIES, METRIC_UNITS, thresholdState } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { departmentOptions, userOptions } from "@/lib/governance";
import { runDataset } from "@/lib/insight/datasets";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { SearchBar } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import { saveMetricAction, submitMetricAction, computeMetricAction, retireMetricAction } from "@/app/actions/insight-analytics";
import { InsightsNav } from "../_nav";

export const metadata = { title: "Metric catalog" };

/**
 * Insights › Metric catalog: governed definitions of headcount, attrition,
 * absence, compensation, talent, performance, hiring and engagement
 * metrics. A definition is drafted, approved through the workflow engine,
 * versioned on change, computed nightly and alerts past its thresholds.
 */
export default async function MetricsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.ANALYTICS_VIEW)) forbidden();
  const sp = await searchParams;
  const builder = can(viewer, P.REPORT_BUILD);
  const [table, depts, users, editing] = await Promise.all([
    runDataset(viewer, "metrics", sp),
    departmentOptions(viewer.tenantId),
    userOptions(viewer.tenantId),
    sp.edit ? prisma.insightMetric.findFirst({ where: { id: sp.edit, tenantId: viewer.tenantId } }) : Promise.resolve(null),
  ]);
  const calcOpts = Object.entries(INSIGHT_CALCULATORS).map(([k, c]) => ({ value: k, label: `${c.label} (${METRIC_CATEGORIES[c.category]})` }));
  const params = (editing?.params ?? {}) as { departmentId?: string | null; months?: number | null };
  const fields = [
    { name: "name", label: "Name", required: true, defaultValue: editing?.name },
    { name: "calculator", label: "Calculation", type: "select" as const, options: calcOpts, required: true, defaultValue: editing?.calculator },
    { name: "category", label: "Category", type: "select" as const, options: Object.entries(METRIC_CATEGORIES).map(([value, label]) => ({ value, label })), defaultValue: editing?.category, hint: "Defaults to the calculation's" },
    { name: "unit", label: "Unit", type: "select" as const, options: Object.entries(METRIC_UNITS).map(([value, label]) => ({ value, label })), defaultValue: editing?.unit },
    { name: "direction", label: "Better when", type: "select" as const, options: [{ value: "UP_GOOD", label: "Higher" }, { value: "DOWN_GOOD", label: "Lower" }, { value: "NEUTRAL", label: "Neither" }], defaultValue: editing?.direction },
    { name: "departmentId", label: "Department filter", type: "select" as const, options: depts, defaultValue: params.departmentId ?? "" },
    { name: "months", label: "Window (months)", type: "number" as const, defaultValue: params.months ?? "", hint: "For rates over a period; default 12" },
    { name: "warnAt", label: "Warn at", type: "number" as const, defaultValue: editing?.warnAt === null || !editing ? "" : Number(editing.warnAt) },
    { name: "alertAt", label: "Alert at", type: "number" as const, defaultValue: editing?.alertAt === null || !editing ? "" : Number(editing.alertAt) },
    { name: "ownerUserId", label: "Owner (gets alerts)", type: "select" as const, options: users, defaultValue: editing?.ownerUserId ?? "" },
    { name: "description", label: "Definition", type: "textarea" as const, wide: true, defaultValue: editing?.description },
    { name: "formula", label: "Formula (shown in the catalog)", type: "textarea" as const, wide: true, defaultValue: editing?.formula, hint: "Defaults to the calculator's formula" },
  ];
  return (
    <>
      <PageHead title="Metric catalog" subtitle="Governed metric definitions: approved, versioned, computed and alerted" />
      <InsightsNav />
      <Card title="Definitions">
        <SearchBar action="/insights/metrics" tab="" q={sp.q}>
          <select className="select" name="category" defaultValue={sp.category ?? ""}><option value="">All categories</option>{Object.entries(METRIC_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </SearchBar>
        <InsightTableView table={table} ds="metrics" params={{ q: sp.q, category: sp.category }} extraHead="" extra={(r) => {
          const st = thresholdState(r.lastValue as number | null, r.warnAt as number | null, r.alertAt as number | null, String(r.direction));
          return (
            <div className="row gap-2 wrap">
              {st !== "OK" ? <Badge tone={st === "ALERT" ? "danger" : "warning"}>{st.toLowerCase()}</Badge> : null}
              <ActButton action={computeMetricAction} hidden={{ id: String(r.id) }} label="Compute" />
              {builder && (r.status === "DRAFT" || r.status === "REJECTED") ? <ActButton action={submitMetricAction} hidden={{ id: String(r.id) }} label="Submit" variant="primary" /> : null}
              {builder && r.status !== "PENDING_APPROVAL" && r.status !== "RETIRED" ? <a className="btn sm" href={`/insights/metrics?edit=${r.id}`}>{r.status === "APPROVED" ? "New version" : "Edit"}</a> : null}
              {builder && r.status !== "PENDING_APPROVAL" && r.status !== "RETIRED" ? <ActButton action={retireMetricAction} hidden={{ id: String(r.id) }} label="Retire" variant="ghost" confirmText="Retire this metric version?" /> : null}
            </div>
          );
        }} />
      </Card>
      {builder ? (
        <Card title={editing ? `${editing.status === "APPROVED" ? "New version of" : "Edit"} ${editing.name}` : "Define a metric"} description="Drafts go live once a report administrator approves them (Inbox › Approvals).">
          <SpecForm action={saveMetricAction} fields={fields} hidden={editing ? { id: editing.id } : undefined} submitLabel={editing ? "Save" : "Create draft"} columns={3} />
        </Card>
      ) : null}
    </>
  );
}
