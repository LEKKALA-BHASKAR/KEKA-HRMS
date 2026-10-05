import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { cohortFiltersOf } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { departmentOptions, locationOptions, fmtDate } from "@/lib/governance";
import { runDataset } from "@/lib/insight/datasets";
import { PEOPLE_TABS, peopleTabAllowed, isPeopleTab } from "@/lib/insight/people";
import { PageHead, Card } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Table } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import { saveCohortAction, deleteCohortAction, addHiringCostAction, deleteHiringCostAction } from "@/app/actions/insight-analytics";
import { recomputeRiskAction } from "@/app/actions/analytics";
import { InsightsNav } from "../_nav";

export const metadata = { title: "People analytics" };
type SP = Record<string, string | undefined>;

/**
 * Insights › People analytics: attrition cohorts and a cohort builder,
 * overtime cost, compensation distribution, pay equity, promotion velocity,
 * internal mobility, learning effectiveness, engagement drivers, manager
 * effectiveness, time to fill, cost per hire, productivity, diversity,
 * anomalies and talent risk. Every table downloads as CSV, Excel or PDF.
 */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  if (!can(viewer, P.ANALYTICS_VIEW)) forbidden();
  const sp = await searchParams;
  const tabs: Array<[string, string]> = [...Object.entries(PEOPLE_TABS).filter(([k]) => isPeopleTab(k) && peopleTabAllowed(viewer, k)), ["builder", "Cohort builder"], ...(can(viewer, P.ATTRITION_RISK_VIEW) ? [["talent-risk", "Talent risk"] as [string, string]] : [])];
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : "cohorts";
  return (
    <>
      <PageHead title="People analytics" subtitle="Workforce analyses over the people your role covers" />
      <InsightsNav />
      <div className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        {tabs.map(([k, label]) => <Link key={k} href={`/insights/people?tab=${k}`} className={`btn sm${k === tab ? " primary" : ""}`}>{label}</Link>)}
      </div>
      {tab === "builder" ? <Cohorts viewer={viewer} sp={sp} /> : tab === "talent-risk" ? <TalentRisk viewer={viewer} sp={sp} /> : (
        <>
          <Card><InsightTableView table={await runDataset(viewer, `people:${tab}`)} ds={`people:${tab}`} /></Card>
          {tab === "cost-per-hire" && can(viewer, P.REPORT_BUILD) ? <HiringCosts viewer={viewer} /> : null}
        </>
      )}
    </>
  );
}

async function TalentRisk({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const table = await runDataset(viewer, "talent-risk", sp);
  return (
    <Card title="Talent risk" description="Flight-risk scores from the attrition model, with the signals behind each." action={<ActButton action={recomputeRiskAction} hidden={{}} label="Recompute now" />}>
      <form method="get" action="/insights/people" className="row gap-2" style={{ marginBottom: 10 }}>
        <input type="hidden" name="tab" value="talent-risk" />
        <select className="select" name="band" defaultValue={sp.band ?? ""}><option value="">All bands</option>{["HIGH", "MEDIUM", "LOW"].map((b) => <option key={b} value={b}>{b.toLowerCase()}</option>)}</select>
        <button className="btn sm" type="submit">Filter</button>
      </form>
      <InsightTableView table={table} ds="talent-risk" params={{ band: sp.band }} />
    </Card>
  );
}

async function Cohorts({ viewer, sp }: { viewer: Viewer; sp: SP }) {
  const [cohorts, depts, locs] = await Promise.all([
    prisma.insightCohort.findMany({ where: { tenantId: viewer.tenantId, OR: [{ createdBy: viewer.user.id }, { shared: true }] }, orderBy: { name: "asc" } }),
    departmentOptions(viewer.tenantId), locationOptions(viewer.tenantId),
  ]);
  const open = sp.cohort ? cohorts.find((c) => c.id === sp.cohort) : undefined;
  const editing = sp.edit ? cohorts.find((c) => c.id === sp.edit && c.createdBy === viewer.user.id) : undefined;
  const f = editing ? cohortFiltersOf(editing.filters) : null;
  return (
    <>
      <Card title="Saved cohorts">
        <Table head={["Cohort", "Filters", "Shared", ""]} empty={!cohorts.length}>
          {cohorts.map((c) => {
            const cf = cohortFiltersOf(c.filters);
            const desc = [cf.departmentIds?.length ? `${cf.departmentIds.length} department(s)` : "", cf.locationIds?.length ? `${cf.locationIds.length} location(s)` : "", cf.genders?.length ? cf.genders.join("/").toLowerCase() : "", cf.joinedFrom || cf.joinedTo ? `joined ${cf.joinedFrom ?? "…"}–${cf.joinedTo ?? "…"}` : "", cf.minTenureYears !== null || cf.maxTenureYears !== null ? `tenure ${cf.minTenureYears ?? 0}–${cf.maxTenureYears ?? "∞"}y` : "", cf.includeExited ? "incl. leavers" : ""].filter(Boolean).join(", ");
            return (
              <tr key={c.id}>
                <td><strong>{c.name}</strong><div className="text-xs muted">{c.description}</div></td><td className="text-sm">{desc || "everyone"}</td><td>{c.shared ? "yes" : "no"}</td>
                <td className="row gap-2"><Link className="btn sm" href={`/insights/people?tab=builder&cohort=${c.id}`}>Open</Link>
                  {c.createdBy === viewer.user.id ? <><Link className="btn sm" href={`/insights/people?tab=builder&edit=${c.id}`}>Edit</Link><ActButton action={deleteCohortAction} hidden={{ id: c.id }} label="Delete" variant="ghost" confirmText="Delete this cohort?" /></> : null}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
      {open ? <Card><InsightTableView table={await runDataset(viewer, `cohort:${open.id}`)} ds={`cohort:${open.id}`} /></Card> : null}
      <Card title={editing ? `Edit ${editing.name}` : "Build a cohort"} description="A named group of people by department, location, gender, joining dates and tenure, to analyse and export.">
        <SpecForm action={saveCohortAction} columns={3} hidden={editing ? { id: editing.id } : undefined} fields={[
          { name: "name", label: "Name", required: true, defaultValue: editing?.name },
          { name: "description", label: "Description", defaultValue: editing?.description },
          { name: "shared", label: "Share with analytics users", type: "checkbox", defaultValue: editing?.shared ?? false },
          { name: "departmentIds", label: "Departments", type: "multiselect", options: depts, defaultValue: f?.departmentIds ?? [] },
          { name: "locationIds", label: "Locations", type: "multiselect", options: locs, defaultValue: f?.locationIds ?? [] },
          { name: "genders", label: "Gender", type: "multiselect", options: [{ value: "FEMALE", label: "Female" }, { value: "MALE", label: "Male" }, { value: "OTHER", label: "Other" }], defaultValue: f?.genders ?? [] },
          { name: "joinedFrom", label: "Joined from", type: "date", defaultValue: f?.joinedFrom ?? "" },
          { name: "joinedTo", label: "Joined to", type: "date", defaultValue: f?.joinedTo ?? "" },
          { name: "includeExited", label: "Include leavers", type: "checkbox", defaultValue: f?.includeExited ?? false },
          { name: "minTenureYears", label: "Min tenure (years)", type: "number", defaultValue: f?.minTenureYears ?? "" },
          { name: "maxTenureYears", label: "Max tenure (years)", type: "number", defaultValue: f?.maxTenureYears ?? "" },
        ]} />
      </Card>
    </>
  );
}

async function HiringCosts({ viewer }: { viewer: Viewer }) {
  const [costs, reqs] = await Promise.all([
    prisma.insightHiringCost.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { month: "desc" }, take: 100 }),
    prisma.requisition.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return (
    <Card title="Hiring costs" description="Recruiting spend the cost-per-hire analysis divides by hires.">
      <Table head={["Month", "Category", "Amount", "Requisition", "Note", ""]} empty={!costs.length}>
        {costs.map((c) => <tr key={c.id}><td>{c.month}</td><td>{c.category.replace(/_/g, " ").toLowerCase()}</td><td className="num">₹{Number(c.amount).toLocaleString("en-IN")}</td><td className="text-sm">{reqs.find((r) => r.id === c.requisitionId)?.title ?? "—"}</td><td className="text-sm">{c.note}</td><td><ActButton action={deleteHiringCostAction} hidden={{ id: c.id }} label="Remove" variant="ghost" /></td></tr>)}
      </Table>
      <SpecForm action={addHiringCostAction} columns={3} submitLabel="Record" fields={[
        { name: "month", label: "Month (YYYY-MM)", required: true, defaultValue: new Date().toISOString().slice(0, 7) },
        { name: "category", label: "Category", type: "select", options: ["AGENCY", "JOB_BOARD", "REFERRAL_BONUS", "ASSESSMENT", "TRAVEL", "OTHER"].map((v) => ({ value: v, label: v.replace(/_/g, " ").toLowerCase() })), required: true },
        { name: "amount", label: "Amount (₹)", type: "number", required: true },
        { name: "requisitionId", label: "Requisition", type: "select", options: reqs.map((r) => ({ value: r.id, label: r.title })) },
        { name: "note", label: "Note", wide: true },
      ]} />
      <div className="hint">Recorded {fmtDate(costs[0]?.createdAt)} last.</div>
    </Card>
  );
}
