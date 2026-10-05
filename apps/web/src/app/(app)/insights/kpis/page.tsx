import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { METRIC_UNITS, kpiPeriodOf } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, employeeOptions } from "@/lib/governance";
import { runDataset } from "@/lib/insight/datasets";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, SearchBar } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import { saveKpiAction, addKpiTargetAction, recordKpiReadingAction, computeKpiAction, saveKraAction, submitKraAction } from "@/app/actions/insight-analytics";
import { InsightsNav } from "../_nav";

export const metadata = { title: "KPIs & KRAs" };
const TABS = { dashboard: "KPI dashboard", configure: "Configure KPIs", kras: "KRAs" };
type Tab = keyof typeof TABS;
const RAG_TONE = { GREEN: "success", AMBER: "warning", RED: "danger" } as const;

/**
 * Insights › KPIs & KRAs: the KPI catalog with owners, calculation (manual
 * or from an approved metric), versioned targets and RAG thresholds; the
 * KPI dashboard of the latest readings; and the KRA catalog per role,
 * approved through the workflow engine.
 */
export default async function KpisPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  const kpiOwner = viewer.employee ? (await prisma.insightKpi.count({ where: { tenantId: viewer.tenantId, ownerEmployeeId: viewer.employee.id } })) > 0 : false;
  if (!canAny(viewer, [P.ANALYTICS_VIEW, P.PERFORMANCE_MANAGE, P.PERFORMANCE_VIEW]) && !kpiOwner) forbidden();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "dashboard";
  const manage = canAny(viewer, [P.PERFORMANCE_MANAGE, P.REPORT_BUILD]);
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="KPIs & KRAs" subtitle="Key result areas, KPI definitions, owners, targets and readings" actions={<a className="btn" href="/storyboards?kind=KPI">KPI dashboards</a>} />
      <InsightsNav />
      <Tabs base="/insights/kpis" tabs={TABS} active={tab} />
      {tab === "dashboard" ? await (async () => {
        const table = await runDataset(viewer, "kpis", sp);
        const kpis = await prisma.insightKpi.findMany({ where: { tenantId: t, isActive: true, ...(manage ? {} : { ownerEmployeeId: viewer.employee?.id ?? "__none__" }) }, orderBy: { name: "asc" } });
        return (
          <>
            <Card title="Latest readings">
              <InsightTableView table={table} ds="kpis" extraHead="" extra={(r) => (
                <div className="row gap-2">
                  {r.rag ? <Badge tone={RAG_TONE[r.rag as keyof typeof RAG_TONE] ?? "neutral"}>{String(r.rag).toLowerCase()}</Badge> : null}
                  {manage && String(r.calcKind).startsWith("from") ? <ActButton action={computeKpiAction} hidden={{ kpiId: String(r.id) }} label="Compute" /> : null}
                </div>
              )} />
            </Card>
            {kpis.length ? (
              <Card title="Record a reading" description="Owners record their own KPIs; a red reading alerts the owner.">
                <SpecForm action={recordKpiReadingAction} columns={3} submitLabel="Record" fields={[
                  { name: "kpiId", label: "KPI", type: "select", options: kpis.map((k) => ({ value: k.id, label: k.name })), required: true },
                  { name: "period", label: "Period (YYYY-MM)", required: true, defaultValue: kpiPeriodOf(new Date(), "MONTHLY") },
                  { name: "value", label: "Value", type: "number", required: true },
                  { name: "note", label: "Note", wide: true },
                ]} />
              </Card>
            ) : null}
          </>
        );
      })() : null}
      {tab === "configure" ? await (async () => {
        if (!manage) return <Card><div className="muted">Configuring KPIs needs performance or report administration.</div></Card>;
        const [kpis, kras, metrics, emps] = await Promise.all([
          prisma.insightKpi.findMany({ where: { tenantId: t }, include: { targets: { orderBy: { version: "desc" } } }, orderBy: { name: "asc" } }),
          prisma.insightKra.findMany({ where: { tenantId: t, status: { in: ["APPROVED", "DRAFT", "PENDING_APPROVAL"] } }, orderBy: { name: "asc" } }),
          prisma.insightMetric.findMany({ where: { tenantId: t, status: "APPROVED" }, orderBy: { name: "asc" } }),
          employeeOptions(t),
        ]);
        const editing = sp.edit ? kpis.find((k) => k.id === sp.edit) : undefined;
        return (
          <>
            <Card title="KPI catalog">
              {kpis.length ? (
                <div className="table-wrap"><table className="data">
                  <thead><tr><th>KPI</th><th>Owner</th><th>Calculated</th><th>Thresholds</th><th>Targets (versions)</th><th /></tr></thead>
                  <tbody>{kpis.map((k) => (
                    <tr key={k.id}>
                      <td><strong>{k.name}</strong>{k.isActive ? null : <> <Badge>inactive</Badge></>}<div className="text-xs muted">{k.description}</div></td>
                      <td className="text-sm">{emps.find((e) => e.value === k.ownerEmployeeId)?.label ?? "—"}</td>
                      <td className="text-sm">{k.calcKind === "METRIC" ? `from ${k.metricKey}` : "manual"} · {k.frequency.toLowerCase()}</td>
                      <td className="text-sm">green ≥ {Number(k.greenAt)}%, amber ≥ {Number(k.amberAt)}%</td>
                      <td className="text-xs">{k.targets.map((tg) => <div key={tg.id}>v{tg.version}: {Number(tg.target)}{tg.stretch !== null ? ` (stretch ${Number(tg.stretch)})` : ""} from {tg.effectiveFrom.toISOString().slice(0, 10)}{tg.reason ? ` — ${tg.reason}` : ""}</div>)}</td>
                      <td><a className="btn sm" href={`/insights/kpis?tab=configure&edit=${k.id}`}>Edit</a></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <div className="muted">No KPIs yet.</div>}
            </Card>
            <Card title={editing ? `Edit ${editing.name}` : "Define a KPI"}>
              <SpecForm action={saveKpiAction} columns={3} hidden={editing ? { id: editing.id } : undefined} fields={[
                { name: "name", label: "Name", required: true, defaultValue: editing?.name },
                { name: "kraId", label: "KRA", type: "select", options: kras.map((k) => ({ value: k.id, label: `${k.name} v${k.version}` })), defaultValue: editing?.kraId ?? "" },
                { name: "ownerEmployeeId", label: "Owner", type: "select", options: emps, defaultValue: editing?.ownerEmployeeId ?? "" },
                { name: "calcKind", label: "Calculation", type: "select", options: [{ value: "MANUAL", label: "Recorded by hand" }, { value: "METRIC", label: "From an approved metric" }], defaultValue: editing?.calcKind ?? "MANUAL", required: true },
                { name: "metricKey", label: "Metric", type: "select", options: metrics.map((m) => ({ value: m.key, label: m.name })), defaultValue: editing?.metricKey ?? "" },
                { name: "frequency", label: "Frequency", type: "select", options: [{ value: "MONTHLY", label: "Monthly" }, { value: "QUARTERLY", label: "Quarterly" }], defaultValue: editing?.frequency ?? "MONTHLY", required: true },
                { name: "unit", label: "Unit", type: "select", options: Object.entries(METRIC_UNITS).map(([value, label]) => ({ value, label })), defaultValue: editing?.unit ?? "COUNT" },
                { name: "direction", label: "Better when", type: "select", options: [{ value: "UP_GOOD", label: "Higher" }, { value: "DOWN_GOOD", label: "Lower" }], defaultValue: editing?.direction ?? "UP_GOOD", required: true },
                { name: "greenAt", label: "Green at (% of target)", type: "number", defaultValue: editing ? Number(editing.greenAt) : 100 },
                { name: "amberAt", label: "Amber at (% of target)", type: "number", defaultValue: editing ? Number(editing.amberAt) : 80 },
                ...(editing ? [{ name: "isActive", label: "Active", type: "checkbox" as const, defaultValue: editing.isActive }] : [{ name: "target", label: "First target", type: "number" as const }, { name: "effectiveFrom", label: "Target from", type: "date" as const }]),
                { name: "description", label: "Definition", type: "textarea", wide: true, defaultValue: editing?.description },
              ]} />
            </Card>
            {kpis.length ? (
              <Card title="New target version" description="Earlier versions stay in force for the periods they covered.">
                <SpecForm action={addKpiTargetAction} columns={3} submitLabel="Add version" fields={[
                  { name: "kpiId", label: "KPI", type: "select", options: kpis.map((k) => ({ value: k.id, label: k.name })), required: true, defaultValue: editing?.id },
                  { name: "target", label: "Target", type: "number", required: true },
                  { name: "stretch", label: "Stretch target", type: "number" },
                  { name: "effectiveFrom", label: "Effective from", type: "date", required: true },
                  { name: "reason", label: "Why it changes", wide: true },
                ]} />
              </Card>
            ) : null}
          </>
        );
      })() : null}
      {tab === "kras" ? await (async () => {
        const [table, depts] = await Promise.all([runDataset(viewer, "kras", sp), departmentOptions(t)]);
        const editing = sp.edit ? await prisma.insightKra.findFirst({ where: { id: sp.edit, tenantId: t } }) : null;
        const admin = can(viewer, P.PERFORMANCE_MANAGE);
        return (
          <>
            <Card title="Key result areas" description="Per role; weights of a role's KRAs add up to at most 100. Approved KRAs are what reviews rate against.">
              <SearchBar action="/insights/kpis" tab="kras" q={sp.q}>
                <select className="select" name="status" defaultValue={sp.status ?? ""}><option value="">Any status</option>{["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "RETIRED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}</select>
              </SearchBar>
              <InsightTableView table={table} ds="kras" params={{ q: sp.q, status: sp.status }} extraHead="" extra={(r) => admin ? (
                <div className="row gap-2">
                  {r.status === "DRAFT" || r.status === "REJECTED" ? <ActButton action={submitKraAction} hidden={{ id: String(r.id) }} label="Submit" variant="primary" /> : null}
                  {r.status !== "PENDING_APPROVAL" && r.status !== "RETIRED" ? <a className="btn sm" href={`/insights/kpis?tab=kras&edit=${r.id}`}>{r.status === "APPROVED" ? "New version" : "Edit"}</a> : null}
                </div>
              ) : null} />
            </Card>
            {admin ? (
              <Card title={editing ? `Edit ${editing.name}` : "Add a KRA"}>
                <SpecForm action={saveKraAction} columns={3} hidden={editing ? { id: editing.id } : undefined} fields={[
                  { name: "name", label: "Name", required: true, defaultValue: editing?.name },
                  { name: "jobTitle", label: "Role (job title)", defaultValue: editing?.jobTitle, hint: "Blank for everyone" },
                  { name: "departmentId", label: "Department", type: "select", options: depts, defaultValue: editing?.departmentId ?? "" },
                  { name: "weight", label: "Weight (%)", type: "number", defaultValue: editing ? Number(editing.weight) : 0 },
                  { name: "description", label: "What good looks like", type: "textarea", wide: true, defaultValue: editing?.description },
                ]} />
              </Card>
            ) : null}
          </>
        );
      })() : null}
    </>
  );
}
