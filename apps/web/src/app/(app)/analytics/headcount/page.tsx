import { PERMISSIONS } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { parseFilters, filterQuery, filterOptions, filterDefs, employeeWhere, headcountAsOf, analyticsToday } from "@/lib/analytics/filters";
import { population, headcountChart, HEADCOUNT_CHARTS } from "@/lib/analytics/data";
import { DashboardTabs, AnalyticsPills, ChartCard, rangeLabel } from "../_components/dashboard";
import { FilterBar } from "../_components/filter-bar";
import { ChartView, RawFor } from "../_components/render";
import s from "../_components/analytics.module.css";

export const metadata = { title: "Headcount by Demographics — Analytics" };
const P = PERMISSIONS;

/** Org › Dashboard › Analytics › Headcount by Demographics (Keka i4r/03). */
export default async function HeadcountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  const sp = await searchParams;
  const f = parseFilters(sp, "12m");
  const today = analyticsToday();
  const asOf = headcountAsOf(sp, f, today);
  const chosen = !!(sp.range || (sp.from && sp.to));
  const [opts, pop] = await Promise.all([filterOptions(viewer.tenantId), population(employeeWhere(viewer, f))]);
  const qs = chosen ? filterQuery(f) : filterQuery(f, {}, ["range"]);
  const charts = HEADCOUNT_CHARTS.map((c) => headcountChart(c.key, pop, { from: asOf, to: asOf })!);
  const raw = typeof sp.raw === "string" ? charts.find((c) => c.key === sp.raw) ?? null : null;
  const dimQs = filterQuery(f, {}, ["range", "from", "to"]);

  return (
    <>
      <DashboardTabs viewer={viewer} active="analytics" />
      <AnalyticsPills active="headcount" qs={dimQs} />
      <h1 className={s.h1}>Headcount Distribution by Demographics</h1>
      <FilterBar
        filters={filterDefs(opts, ["bu", "dept", "loc", "cc", "le", "wt"])}
        range={{ value: chosen ? f.range : "", label: chosen ? `As of ${rangeLabel(asOf, asOf).split(" - ")[0]}` : "Date Range" }}
      />
      <div className={s.grid2}>
        {charts.map((c) => (
          <ChartCard key={c.key} chartKey={c.key} title={c.title} info={c.info} exportQs={qs}
            rawHref={`/analytics/headcount?${qs}${qs ? "&" : ""}raw=${c.key}`}>
            <ChartView c={c} width={c.kind === "donut" ? 640 : 680} height={c.kind === "donut" ? 300 : 330} color={c.key === "hc-department" ? "#5bc0d0" : c.key === "hc-age" ? "#f2c744" : c.key === "hc-tenure" ? "#7cc47f" : "#9b87c4"} />
          </ChartCard>
        ))}
      </div>
      <RawFor c={raw} sp={sp} path="/analytics/headcount" qs={qs} linkPeople={can(viewer, P.EMPLOYEE_VIEW_ALL)} />
    </>
  );
}
