import type { ReactNode } from "react";

/**
 * Charts drawn as plain SVG on the server: bars (stacked, grouped, or with a
 * line on a second axis), an area line, a donut with its legend, and a
 * sparkline. Every chart is one <svg> with its legend inside, so the "Export
 * as PNG" menu can rasterise exactly what is on screen. Values are labelled
 * on the marks, the way Keka's analytics label them.
 */

export const CHART_COLORS = ["#5b9bd5", "#d17fc6", "#f2c744", "#5bc0d0", "#9b87c4", "#ef8f7d", "#7cc47f", "#f0a35e", "#8891a3", "#4f7ac7"];
export const GENDER_COLORS: Record<string, string> = { Female: "#d17fc6", Male: "#5b9bd5", "Non-binary": "#f2c744", "Prefer not to respond": "#a9b1bf", "Not specified": "#5bc0d0" };

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const AXIS = "#8891a3";
const GRID = "#eceff4";
const TEXT = "#3b4252";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 1.2 ? 1.2 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return nice * exp;
}
const fmt = (n: number, pct?: boolean) => {
  const s = Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}K` : `${Math.round(n * 100) / 100}`;
  return pct ? `${s}%` : s;
};
const textW = (s: string, size = 12) => s.length * size * 0.56;

function wrap(label: string, max: number): string[] {
  if (textW(label) <= max) return [label];
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textW(next) > max && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) return [...lines.slice(0, 2), `${lines.slice(2).join(" ").slice(0, Math.max(3, Math.floor(max / 6.7) - 1))}…`];
  return lines;
}

function Legend({ items, y, width }: { items: Array<{ label: string; color: string }>; y: number; width: number }) {
  const widths = items.map((i) => 16 + textW(i.label) + 18);
  const total = widths.reduce((s, w) => s + w, 0);
  let x = Math.max(8, (width - total) / 2);
  return (
    <g fontSize={12} fill={AXIS}>
      {items.map((it, i) => {
        const g = (
          <g key={it.label} transform={`translate(${x},${y})`}>
            <rect width={10} height={10} y={-9} fill={it.color} rx={1.5} />
            <text x={16} y={0}>{it.label}</text>
          </g>
        );
        x += widths[i];
        return g;
      })}
    </g>
  );
}

export interface BarDatum { label: string; value: number; segments?: Array<{ label: string; value: number }> }

/** Vertical bars with value labels; segments stack, `series` groups, `line` adds a right axis. */
export function BarChart({
  rows, width = 960, height = 320, color = "#9b87c4", yLabel, xLabel, legend, pct, series, seriesColors = ["#5bc0d0", "#ef8f7d"], line, title,
}: {
  rows: BarDatum[]; width?: number; height?: number; color?: string; yLabel?: string; xLabel?: string; legend?: string; pct?: boolean;
  series?: Array<{ label: string; values: number[] }>; seriesColors?: string[];
  line?: { label: string; values: number[]; axisLabel: string };
  title?: string;
}) {
  const segLabels = [...new Set(rows.flatMap((r) => (r.segments ?? []).map((s) => s.label)))];
  const legendItems = series
    ? series.map((s, i) => ({ label: s.label, color: seriesColors[i % seriesColors.length] }))
    : segLabels.length
      ? segLabels.map((l, i) => ({ label: l, color: GENDER_COLORS[l] ?? CHART_COLORS[i % CHART_COLORS.length] }))
      : [...(legend ? [{ label: legend, color }] : []), ...(line ? [{ label: line.label, color: "#f0a35e" }] : [])];
  const longest = Math.max(1, ...rows.map((r) => wrap(r.label, Math.max(40, (width - 120) / Math.max(1, rows.length) - 6)).length));
  const m = { top: 28, right: line ? 70 : 24, bottom: 26 + longest * 15 + (xLabel ? 22 : 0) + (legendItems.length ? 26 : 0), left: 64 };
  const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
  const maxV = series
    ? Math.max(0, ...series.flatMap((s) => s.values))
    : Math.max(0, ...rows.map((r) => (r.segments ? r.segments.reduce((s, x) => s + x.value, 0) : r.value)));
  const top = niceMax(maxV * 1.08);
  const y = (v: number) => m.top + ph - (v / top) * ph;
  const band = pw / Math.max(1, rows.length);
  const bw = Math.min(series ? 26 : 52, band * (series ? 0.32 : 0.55));
  const ticks = [0, 1, 2, 3, 4, 5].map((i) => (top / 5) * i);
  let lineTop = 1, lineMin = 0;
  if (line) {
    const lmax = Math.max(0, ...line.values), lmin = Math.min(0, ...line.values);
    lineTop = niceMax(Math.max(Math.abs(lmax), Math.abs(lmin)) * 1.1) || 1;
    lineMin = lmin < 0 ? -lineTop : 0;
  }
  const ly = (v: number) => m.top + ph - ((v - lineMin) / (lineTop - lineMin)) * ph;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={title ?? yLabel ?? "Bar chart"} style={{ display: "block", fontFamily: FONT }}>
      <rect width={width} height={height} fill="#fff" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.left} x2={m.left + pw} y1={y(t)} y2={y(t)} stroke={GRID} />
          <text x={m.left - 10} y={y(t) + 4} fontSize={12} textAnchor="end" fill={TEXT}>{fmt(t, pct)}</text>
        </g>
      ))}
      {line ? [0, 1, 2, 3, 4, 5].map((i) => {
        const v = lineMin + ((lineTop - lineMin) / 5) * i;
        return <text key={i} x={m.left + pw + 10} y={ly(v) + 4} fontSize={12} fill={TEXT}>{`${Math.round(v * 100) / 100}%`}</text>;
      }) : null}
      {yLabel ? <text transform={`translate(18 ${m.top + ph / 2}) rotate(-90)`} fontSize={13} textAnchor="middle" fill={AXIS}>{yLabel}</text> : null}
      {line ? <text transform={`translate(${width - 12} ${m.top + ph / 2}) rotate(90)`} fontSize={13} textAnchor="middle" fill={AXIS}>{line.axisLabel}</text> : null}
      <line x1={m.left} x2={m.left + pw} y1={m.top + ph} y2={m.top + ph} stroke="#cdd4e0" />
      {rows.map((r, i) => {
        const cx = m.left + band * i + band / 2;
        const lines = wrap(r.label, Math.max(40, band - 6));
        const labelEl = (
          <text x={cx} y={m.top + ph + 18} fontSize={12} textAnchor="middle" fill={TEXT}>
            {lines.map((l, j) => <tspan key={j} x={cx} dy={j === 0 ? 0 : 15}>{l}</tspan>)}
            <title>{r.label}</title>
          </text>
        );
        if (series) {
          return (
            <g key={r.label}>
              {series.map((s, j) => {
                const v = s.values[i] ?? 0;
                const x = cx - (bw * series.length) / 2 + j * bw;
                return (
                  <g key={s.label}>
                    <rect x={x + 1} y={y(v)} width={bw - 2} height={Math.max(0, m.top + ph - y(v))} fill={seriesColors[j % seriesColors.length]}><title>{`${s.label} · ${r.label}: ${v}`}</title></rect>
                    <text x={x + bw / 2} y={y(v) - 6} fontSize={11} textAnchor="middle" fill={TEXT}>{fmt(v, pct)}</text>
                  </g>
                );
              })}
              {labelEl}
            </g>
          );
        }
        if (r.segments && r.segments.length) {
          let acc = 0;
          const total = r.segments.reduce((s, x) => s + x.value, 0);
          return (
            <g key={r.label}>
              {r.segments.map((s, j) => {
                const y0 = y(acc), y1 = y(acc + s.value);
                acc += s.value;
                return s.value > 0 ? <rect key={s.label} x={cx - bw / 2} y={y1} width={bw} height={y0 - y1} fill={GENDER_COLORS[s.label] ?? CHART_COLORS[segLabels.indexOf(s.label) % CHART_COLORS.length]}><title>{`${r.label} · ${s.label}: ${s.value}`}</title></rect> : null;
              })}
              <text x={cx} y={y(total) - 7} fontSize={12} textAnchor="middle" fill={TEXT}>{fmt(total, pct)}</text>
              {labelEl}
            </g>
          );
        }
        return (
          <g key={r.label}>
            <rect x={cx - bw / 2} y={y(r.value)} width={bw} height={Math.max(r.value > 0 ? 2 : 0, m.top + ph - y(r.value))} fill={color}><title>{`${r.label}: ${fmt(r.value, pct)}`}</title></rect>
            <text x={cx} y={y(r.value) - 7} fontSize={12} textAnchor="middle" fill={TEXT}>{fmt(r.value, pct)}</text>
            {labelEl}
          </g>
        );
      })}
      {line ? (
        <g>
          <polyline fill="none" stroke="#f0a35e" strokeWidth={2} points={line.values.map((v, i) => `${m.left + band * i + band / 2},${ly(v)}`).join(" ")} />
          {line.values.map((v, i) => <circle key={i} cx={m.left + band * i + band / 2} cy={ly(v)} r={3.5} fill="#f0a35e"><title>{`${rows[i]?.label}: ${v}%`}</title></circle>)}
        </g>
      ) : null}
      {xLabel ? <text x={m.left + pw / 2} y={height - (legendItems.length ? 34 : 8)} fontSize={13} textAnchor="middle" fill={AXIS}>{xLabel}</text> : null}
      {legendItems.length ? <Legend items={legendItems} y={height - 10} width={width} /> : null}
    </svg>
  );
}

/** An area line with a labelled point per month (Keka's "Overall Attrition"). */
export function AreaChart({ points, width = 960, height = 320, color = "#e8735a", fill = "#f8cfc4", yLabel, legend, pct }: {
  points: Array<{ label: string; value: number }>; width?: number; height?: number; color?: string; fill?: string; yLabel?: string; legend?: string; pct?: boolean;
}) {
  const m = { top: 28, right: 28, bottom: 64, left: 64 };
  const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
  const top = niceMax(Math.max(0, ...points.map((p) => p.value)) * 1.15);
  const step = points.length > 1 ? pw / (points.length - 1) : 0;
  const x = (i: number) => m.left + (points.length > 1 ? step * i : pw / 2);
  const y = (v: number) => m.top + ph - (v / top) * ph;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const area = points.length ? `${path} L${x(points.length - 1)},${m.top + ph} L${x(0)},${m.top + ph} Z` : "";
  const ticks = [0, 1, 2, 3, 4, 5].map((i) => (top / 5) * i);
  const every = Math.max(1, Math.ceil(points.length / 12));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={yLabel ?? "Trend"} style={{ display: "block", fontFamily: FONT }}>
      <rect width={width} height={height} fill="#fff" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.left} x2={m.left + pw} y1={y(t)} y2={y(t)} stroke={GRID} />
          <text x={m.left - 10} y={y(t) + 4} fontSize={12} textAnchor="end" fill={TEXT}>{fmt(t, pct)}</text>
        </g>
      ))}
      {yLabel ? <text transform={`translate(18 ${m.top + ph / 2}) rotate(-90)`} fontSize={13} textAnchor="middle" fill={AXIS}>{yLabel}</text> : null}
      <path d={area} fill={fill} opacity={0.75} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} fill={color}><title>{`${p.label}: ${fmt(p.value, pct)}`}</title></circle>
          <text x={x(i)} y={y(p.value) + (i % 2 ? 18 : -9)} fontSize={12} textAnchor="middle" fill={TEXT}>{fmt(p.value, pct)}</text>
          {i % every === 0 ? <text x={x(i)} y={m.top + ph + 20} fontSize={12} textAnchor="middle" fill={TEXT}>{p.label}</text> : null}
        </g>
      ))}
      {legend ? <Legend items={[{ label: legend, color }]} y={height - 10} width={width} /> : null}
    </svg>
  );
}

/** A donut with the total in the middle, percentages on the slices and a legend beside it. */
export function DonutChart({ parts, centre, width = 640, height = 280, legendBelow }: {
  parts: Array<{ label: string; value: number; color?: string }>; centre?: string; width?: number; height?: number; legendBelow?: boolean;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const colored = parts.map((p, i) => ({ ...p, color: p.color ?? GENDER_COLORS[p.label] ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const r = legendBelow ? Math.min(100, (height - 70) / 2) : Math.min(105, height / 2 - 20), ir = r * 0.48;
  const cx = legendBelow ? width / 2 : Math.min(width * 0.3, 190), cy = legendBelow ? r + 16 : height / 2;
  let a0 = -Math.PI / 2;
  const arcs = colored.filter((p) => p.value > 0).map((p) => {
    const frac = total ? p.value / total : 0;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (a: number, rr: number) => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
    const d = frac >= 0.9999
      ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx - 0.01},${cy - r} L${cx - 0.01},${cy - ir} A${ir},${ir} 0 1 0 ${cx},${cy - ir} Z`
      : `M${pt(a0, r)} A${r},${r} 0 ${large} 1 ${pt(a1, r)} L${pt(a1, ir)} A${ir},${ir} 0 ${large} 0 ${pt(a0, ir)} Z`;
    const mid = (a0 + a1) / 2;
    const out = { d, p, frac, lx: cx + ((r + ir) / 2) * Math.cos(mid), ly: cy + ((r + ir) / 2) * Math.sin(mid) };
    a0 = a1;
    return out;
  });
  const legendX = cx + r + 60;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={colored.map((p) => `${p.label} ${p.value}`).join(", ")} style={{ display: "block", fontFamily: FONT }}>
      <rect width={width} height={height} fill="#fff" />
      {total === 0 ? <circle cx={cx} cy={cy} r={(r + ir) / 2} fill="none" stroke="#eef0f4" strokeWidth={r - ir} /> : null}
      {arcs.map((a) => (
        <g key={a.p.label}>
          <path d={a.d} fill={a.p.color} stroke="#fff" strokeWidth={1}><title>{`${a.p.label}: ${a.p.value}`}</title></path>
          {a.frac >= 0.07 ? <text x={a.lx} y={a.ly + 4} fontSize={11} textAnchor="middle" fill="#fff">{legendBelow ? a.p.value : `${Math.round(a.frac * 10000) / 100}%`}</text> : null}
        </g>
      ))}
      <circle cx={cx} cy={cy} r={ir - 2} fill="#fff" />
      <text x={cx} y={cy + 9} fontSize={26} fontWeight={500} textAnchor="middle" fill="#1e2a4a">{centre ?? String(total)}</text>
      {legendBelow
        ? <Legend items={colored.map((p) => ({ label: p.label, color: p.color }))} y={height - 12} width={width} />
        : colored.map((p, i) => {
            const rowH = Math.min(46, (height - 20) / Math.max(1, colored.length));
            const ly = (height - rowH * colored.length) / 2 + rowH * i + 16;
            return (
              <g key={p.label} transform={`translate(${legendX},${ly})`}>
                <rect width={11} height={11} y={-10} rx={2} fill={p.color} />
                <text x={20} y={0} fontSize={13} fill={TEXT}>{p.label}</text>
                <text x={20} y={18} fontSize={13} fill="#1e2a4a" fontWeight={500}>{p.value}</text>
              </g>
            );
          })}
    </svg>
  );
}

/** A small trend line for KPI cards. */
export function Sparkline({ values, width = 300, height = 64, color = "#6e56cf" }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg viewBox={`0 0 ${width} ${height}`} width="100%" aria-hidden="true" />;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) => 4 + ((width - 8) / (values.length - 1)) * i;
  const y = (v: number) => height - 6 - ((v - min) / span) * (height - 14);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const id = `spark-${values.join("-").replace(/[^0-9-]/g, "").slice(0, 24)}-${width}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" aria-hidden="true" style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${x(values.length - 1)},${height} L${x(0)},${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

/** Horizontal bars with the value at the end, for rankings. */
export function HBars({ rows, color = "#9b87c4", format = (n: number) => String(n), max }: {
  rows: Array<{ label: string; value: number; note?: ReactNode }>; color?: string; format?: (n: number) => string; max?: number;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr 56px", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span title={r.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>{r.label}</span>
          <span style={{ background: "var(--surface-sunken)", borderRadius: 4, height: 12, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${Math.max(2, (r.value / top) * 100)}%`, background: color, borderRadius: 4 }} />
          </span>
          <span style={{ textAlign: "right", fontWeight: 600 }}>{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
