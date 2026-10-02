import Link from "next/link";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth, can } from "@/lib/context";
import { parseFilters, filterQuery, filterOptions, filterDefs, employeeWhere, windowOf, analyticsToday } from "@/lib/analytics/filters";
import { population, attritionChart, attritionPageKpis, attritionRateTable, chartByKey, ATTRITION_VIEWS } from "@/lib/analytics/data";
import { DashboardTabs, AnalyticsPills, ChartCard, KpiCards, rangeLabel } from "../_components/dashboard";
import { FilterBar } from "../_components/filter-bar";
import { ChartView, RawFor } from "../_components/render";
import s from "../_components/analytics.module.css";

export const metadata = { title: "Attrition Analysis — Analytics" };
const P = PERMISSIONS;
const PATH = "/analytics/attrition";
const GROUPS: Array<["time" | "demo", string]> = [["time", "Over time"], ["demo", "By group"]];

/** Org › Dashboard › Analytics › Attrition Analysis: who left, when, why and from where. */
export default async function AttritionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  const sp = await searchParams;
  const f = parseFilters(sp, "12m");
  const today = analyticsToday();
  const w = windowOf(f, today);
  const view = ATTRITION_VIEWS.find((v) => v.view === sp.view)?.view ?? "overall";
  const measure = sp.m === "pct" ? "pct" : "count";
  const [opts, pop] = await Promise.all([filterOptions(viewer.tenantId), population(employeeWhere(viewer, f))]);
  // The view and measure ride along in the query so the drawer and export match the chart.
  const qs = filterQuery(f, { view: view === "overall" ? undefined : view, m: view === "overall" && measure === "pct" ? "pct" : undefined });
  const chart = attritionChart(view, pop, w, f, measure)!;
  const table = attritionRateTable(view, pop, w, f);
  const kpis = attritionPageKpis(pop, w, f);
  const raw = typeof sp.raw === "string" ? (sp.raw === chart.key ? chart : chartByKey(sp.raw, pop, w, f, { measure })) : null;
  const dimQs = filterQuery(f, {}, ["range", "from", "to"]);
  const rawBase = `${PATH}?${qs}${qs ? "&" : ""}`;
  const viewHref = (v: string) => `${PATH}?${filterQuery(f, { view: v === "overall" ? undefined : v })}`;
  const toggle = view === "overall" ? (
    <span className={s.toggle}>
      <Link href={`${PATH}?${filterQuery(f)}`} className={measure === "count" ? s.toggleOn : undefined} scroll={false}>Count</Link>
      <Link href={`${PATH}?${filterQuery(f, { m: "pct" })}`} className={measure === "pct" ? s.toggleOn : undefined} scroll={false}>%</Link>
    </span>
  ) : null;

  return (
    <>
      <DashboardTabs viewer={viewer} active="analytics" />
      <AnalyticsPills active="attrition" qs={dimQs} />
      <h1 className={s.h1}>Attrition Analysis</h1>
      <FilterBar
        filters={filterDefs(opts, ["bu", "dept", "loc", "le", "wt", "xt", "xr", "g", "perf", "ten"])}
        range={{ value: f.range, label: rangeLabel(w.from, w.to) }}
        keep={["view", "m"]}
      />
      <KpiCards kpis={kpis} rawBase={rawBase} />
      <div className={s.split}>
        <nav className={s.views} aria-label="Attrition views">
          {GROUPS.map(([g, label]) => (
            <div key={g}>
              <div className={s.viewGroup}>{label}</div>
              {ATTRITION_VIEWS.filter((v) => v.group === g).map((v) => (
                <Link key={v.view} href={viewHref(v.view)} className={`${s.viewItem}${v.view === view ? ` ${s.viewActive}` : ""}`} aria-current={v.view === view ? "page" : undefined} scroll={false}>{v.label}</Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="stack gap-3" style={{ minWidth: 0 }}>
          <ChartCard chartKey={chart.key} title={chart.title} info={chart.info} exportQs={qs} rawHref={`${rawBase}raw=${chart.key}`} insights={chart.insights} headExtra={toggle}>
            <ChartView c={chart} width={900} height={chart.kind === "donut" ? 300 : 360} color={view === "regretted" ? "#f2c744" : "#e8735a"} />
          </ChartCard>
          {table ? (
            <section className={s.card} data-rate-table={view}>
              <header className={s.cardHead}><h2 className={s.cardTitle}>Attrition rate by {chart.xLabel?.toLowerCase() ?? "group"}</h2></header>
              {table.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>{chart.xLabel ?? "Group"}</th><th className="num">Average headcount</th><th className="num">Leavers</th><th className="num">Annualised rate</th></tr></thead>
                    <tbody>
                      {table.map((r) => (
                        <tr key={r.label}><td>{r.label}</td><td className="num">{r.headcount}</td><td className="num">{r.leavers}</td><td className="num strong">{r.ratePct}%</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className={s.empty}>No data for these filters.</div>}
            </section>
          ) : null}
        </div>
      </div>
      <RawFor c={raw} sp={sp} path={PATH} qs={qs} linkPeople={can(viewer, P.EMPLOYEE_VIEW_ALL)} />
    </>
  );
}
