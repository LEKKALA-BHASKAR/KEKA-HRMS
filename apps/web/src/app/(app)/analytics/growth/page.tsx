import { PERMISSIONS } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { parseFilters, filterQuery, filterOptions, filterDefs, employeeWhere, windowOf, analyticsToday } from "@/lib/analytics/filters";
import { population, growthPage, chartByKey } from "@/lib/analytics/data";
import { DashboardTabs, AnalyticsPills, ChartCard, KpiCards, rangeLabel } from "../_components/dashboard";
import { FilterBar } from "../_components/filter-bar";
import { ChartView, RawFor } from "../_components/render";
import s from "../_components/analytics.module.css";

export const metadata = { title: "Growth & Retention — Analytics" };
const P = PERMISSIONS;
const PATH = "/analytics/growth";
const COLOR: Record<string, string> = { "gr-retention": "#7cc47f", "gr-tenure": "#7cc47f" };

/** Org › Dashboard › Analytics › Growth & Retention: headcount over time, movement and who stays. */
export default async function GrowthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  const sp = await searchParams;
  const f = parseFilters(sp, "12m");
  const today = analyticsToday();
  const w = windowOf(f, today);
  const [opts, pop] = await Promise.all([filterOptions(viewer.tenantId), population(employeeWhere(viewer, f))]);
  const qs = filterQuery(f);
  const { kpis, charts } = growthPage(pop, w, today);
  // The KPI links open lists that are not charts of their own (retained, leavers).
  const raw = typeof sp.raw === "string" ? charts.find((c) => c.key === sp.raw) ?? chartByKey(sp.raw, pop, w, f, { today }) : null;
  const dimQs = filterQuery(f, {}, ["range", "from", "to"]);
  const rawBase = `${PATH}?${qs}${qs ? "&" : ""}`;

  return (
    <>
      <DashboardTabs viewer={viewer} active="analytics" />
      <AnalyticsPills active="growth" qs={dimQs} />
      <h1 className={s.h1}>Growth & Retention</h1>
      <FilterBar
        filters={filterDefs(opts, ["bu", "dept", "loc", "cc", "le", "wt"])}
        range={{ value: f.range, label: rangeLabel(w.from, w.to) }}
      />
      <KpiCards kpis={kpis} rawBase={rawBase} />
      <div className={s.grid2}>
        {charts.map((c) => (
          <ChartCard key={c.key} chartKey={c.key} title={c.title} info={c.info} exportQs={qs} rawHref={`${rawBase}raw=${c.key}`} insights={c.insights}>
            <ChartView c={c} width={680} height={330} color={COLOR[c.key]} />
          </ChartCard>
        ))}
      </div>
      <RawFor c={raw} sp={sp} path={PATH} qs={qs} linkPeople={can(viewer, P.EMPLOYEE_VIEW_ALL)} />
    </>
  );
}
