import { ASSET_CONDITIONS, ASSET_CONDITION_LABEL } from "@keka/services";
import s from "./assets.module.css";

/**
 * Keka's "asset … by condition" chart: one stacked bar per asset category,
 * a segment per condition. Colours follow the condition, never its rank,
 * and were checked with the dataviz validator (adjacent pairs pass CVD and
 * normal-vision separation in light and dark). Counts are printed inside
 * each segment that has room, every segment has a hover title, and the
 * legend names every condition shown — so colour never carries meaning alone.
 */

export const CONDITION_COLOUR: Record<string, string> = {
  NEW: "#008300", GOOD: "#2a78d6", FAIR: "#1baf7a", POOR: "#eda100", DAMAGED: "#4a3aa7", UNUSABLE: "#eb6834",
};

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

export function ConditionChart({ categories, data, empty }: { categories: string[]; data: Record<string, Record<string, number>>; empty: string }) {
  const totals = categories.map((c) => ASSET_CONDITIONS.reduce((sum, k) => sum + (data[c]?.[k] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const W = 1180, H = 300, left = 56, right = 12, top = 12, bottom = 56;
  const plotW = W - left - right, plotH = H - top - bottom;
  const band = categories.length ? plotW / categories.length : plotW;
  const barW = Math.min(56, band * 0.5);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks = Array.from({ length: 6 }, (_, i) => (max / 5) * i);
  const shown = ASSET_CONDITIONS.filter((k) => categories.some((c) => (data[c]?.[k] ?? 0) > 0));
  if (categories.length === 0) return <p className="muted text-sm" style={{ padding: "30px 0", textAlign: "center" }}>{empty}</p>;
  return (
    <figure style={{ margin: 0 }}>
      <svg className={s.chartSvg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked bars by asset category and condition. ${categories.map((c, i) => `${c}: ${totals[i]}`).join(", ")}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={left - 12} y={y(t) + 4} textAnchor="end" fontSize={12.5} fill="var(--text-muted)">{Number.isInteger(t) ? t : t.toFixed(1)}</text>
          </g>
        ))}
        <text x={16} y={top + plotH / 2} transform={`rotate(-90 16 ${top + plotH / 2})`} textAnchor="middle" fontSize={13} fill="var(--text-muted)">Asset Count</text>
        {categories.map((c, i) => {
          const cx = left + band * i + band / 2;
          let acc = 0;
          const segs = ASSET_CONDITIONS.filter((k) => (data[c]?.[k] ?? 0) > 0);
          return (
            <g key={c}>
              {segs.map((k, j) => {
                const v = data[c][k];
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                const isTop = j === segs.length - 1;
                const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between stacked segments
                const yTop = y1;
                const r = isTop ? Math.min(4, h / 2) : 0;
                const path = r > 0
                  ? `M${cx - barW / 2},${yTop + h} V${yTop + r} Q${cx - barW / 2},${yTop} ${cx - barW / 2 + r},${yTop} H${cx + barW / 2 - r} Q${cx + barW / 2},${yTop} ${cx + barW / 2},${yTop + r} V${yTop + h} Z`
                  : `M${cx - barW / 2},${yTop + h} V${yTop} H${cx + barW / 2} V${yTop + h} Z`;
                return (
                  <g key={k}>
                    <path d={path} fill={CONDITION_COLOUR[k]}><title>{`${c} · ${ASSET_CONDITION_LABEL[k]}: ${v}`}</title></path>
                    {h >= 18 ? <text x={cx} y={yTop + h / 2 + 4.5} textAnchor="middle" fontSize={12.5} fill={k === "FAIR" || k === "POOR" ? "#10131a" : "#fff"} fontWeight={600} pointerEvents="none">{v}</text> : null}
                  </g>
                );
              })}
              {totals[i] === 0 ? <line x1={cx - barW / 2} x2={cx + barW / 2} y1={y(0) - 1} y2={y(0) - 1} stroke="#eda100" strokeWidth={2} /> : null}
              <text x={cx} y={top + plotH + 22} textAnchor="middle" fontSize={13.5} fill="var(--text)">{c}</text>
            </g>
          );
        })}
        <text x={left + plotW / 2} y={H - 6} textAnchor="middle" fontSize={14} fill="var(--text-muted)">Asset Category</text>
      </svg>
      <figcaption className={s.chartLegend}>
        {shown.map((k) => <span key={k}><i style={{ background: CONDITION_COLOUR[k] }} />{ASSET_CONDITION_LABEL[k]}</span>)}
      </figcaption>
    </figure>
  );
}
