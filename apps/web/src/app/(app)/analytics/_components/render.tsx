import { BarChart, AreaChart, DonutChart } from "@/components/charts";
import type { ChartData } from "@/lib/analytics/data";
import { RawDrawer } from "./raw-drawer";
import { NoData } from "./dashboard";

const DONUT_COLORS: Record<string, string> = {
  Resignation: "#e8735a", Termination: "#c9ced6", Retirement: "#9b87c4", Absconding: "#f2c744", "End of contract": "#5bc0d0",
  Permanent: "#5bc0d0", Contract: "#f2c744", Intern: "#9b87c4", Consultant: "#ef8f7d", None: "#8891a3",
  Voluntary: "#e8735a", Involuntary: "#5b9bd5", Other: "#c9ced6",
};

/** Draw a chart from its data, in the size the card gives it. */
export function ChartView({ c, width = 960, height, color }: { c: ChartData; width?: number; height?: number; color?: string }) {
  const empty = c.kind === "donut" ? c.rows.every((r) => r.value === 0) : c.rows.length === 0 || (c.kind !== "area" && c.kind !== "combo" && c.rows.every((r) => r.value === 0));
  if (empty) return <NoData />;
  if (c.kind === "donut") {
    return <DonutChart width={width} height={height ?? 300} centre={c.centre}
      parts={c.rows.filter((r) => r.value > 0).map((r) => ({ label: r.label, value: r.value, color: DONUT_COLORS[r.label] }))} />;
  }
  if (c.kind === "area") return <AreaChart points={c.rows} width={width} height={height ?? 340} yLabel={c.yLabel} legend={c.legend} pct={c.pct} />;
  return (
    <BarChart rows={c.rows} width={width} height={height ?? 340} yLabel={c.yLabel} xLabel={c.xLabel} legend={c.legend} pct={c.pct}
      color={color ?? "#9b87c4"} series={c.series} line={c.line} title={c.title} />
  );
}

const PAGE = 25;

/** The Raw Data drawer for a chart, if `?raw=` names it. */
export function RawFor({ c, sp, path, qs, linkPeople }: {
  c: ChartData | null; sp: Record<string, string | string[] | undefined>; path: string; qs: string; linkPeople: boolean;
}) {
  if (!c) return null;
  const q = typeof sp.rq === "string" ? sp.rq.trim().toLowerCase() : "";
  const all = c.raw;
  const hits = q ? all.filter((r) => `${r.name} ${r.number} ${r.value}`.toLowerCase().includes(q)) : all;
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.rp) || 1));
  const base = `${path}?${qs}${qs ? "&" : ""}raw=${encodeURIComponent(c.key)}`;
  const exportQs = new URLSearchParams(qs);
  exportQs.set("key", c.key);
  exportQs.set("format", "raw");
  return (
    <RawDrawer rows={hits.slice((page - 1) * PAGE, page * PAGE)} total={all.length} filtered={hits.length} page={page} pages={pages}
      valueLabel={c.rawLabel} query={typeof sp.rq === "string" ? sp.rq : ""} baseHref={base} closeHref={`${path}${qs ? `?${qs}` : ""}`}
      downloadHref={`/analytics/export?${exportQs.toString()}`} linkPeople={linkPeople} />
  );
}
