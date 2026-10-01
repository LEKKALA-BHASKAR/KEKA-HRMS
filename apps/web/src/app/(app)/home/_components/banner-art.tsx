/**
 * The abstract, brush-stroked banner behind "Welcome …!" — blue waves and
 * short swirling strokes along a flow field, drawn as SVG from the brand
 * tokens. Seeded, so every render (server or client) draws the same picture.
 */

const W = 1600;
const H = 260;

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const field = (x: number, y: number) =>
  Math.sin(x / 210 + y / 95) * 1.25 + Math.cos(y / 48 - x / 330) * 0.75 + Math.sin(x / 70) * 0.18;

const INKS = ["#ffffff", "var(--brand-100)", "var(--brand-200)", "var(--brand-300)", "var(--brand-400)", "var(--brand-900)", "var(--brand-800)"];

function strokes(seed: number, count: number) {
  const r = rng(seed);
  const out: Array<{ d: string; ink: string; w: number; o: number }> = [];
  for (let i = 0; i < count; i++) {
    let x = r() * W, y = r() * H;
    const steps = 3 + Math.floor(r() * 5);
    const step = 6 + r() * 11;
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    for (let k = 0; k < steps; k++) {
      const a = field(x, y);
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    const ink = INKS[Math.floor(r() * INKS.length)];
    const dark = ink.includes("800") || ink.includes("900");
    out.push({ d, ink, w: 2.5 + r() * 6, o: dark ? 0.16 + r() * 0.22 : 0.08 + r() * 0.2 });
  }
  return out;
}

const STROKES = strokes(20261001, 480);

export function BannerArt({ id, className }: { id: string; className?: string }) {
  const g = (n: string) => `${id}-${n}`;
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={g("sky")} x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" style={{ stopColor: "var(--brand-800)" }} />
          <stop offset="0.38" style={{ stopColor: "var(--brand-600)" }} />
          <stop offset="0.72" style={{ stopColor: "var(--brand-500)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-300)" }} />
        </linearGradient>
        <linearGradient id={g("scrim")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a1a4a" stopOpacity="0.5" />
          <stop offset="0.5" stopColor="#0a1a4a" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={g("glow")} cx="0.78" cy="0.3" r="0.45">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${g("sky")})`} />
      <rect width={W} height={H} fill={`url(#${g("glow")})`} />
      {/* Broad waves */}
      <path d="M0 190 C 180 120 330 250 520 175 S 860 70 1040 150 S 1380 240 1600 120 V260 H0Z" style={{ fill: "var(--brand-700)" }} opacity="0.55" />
      <path d="M0 120 C 160 60 300 170 470 120 S 760 20 960 90 S 1300 200 1600 60 V0 H0Z" style={{ fill: "var(--brand-400)" }} opacity="0.35" />
      <path d="M220 260 C 360 170 520 230 640 160 S 900 110 1010 200 S 1240 230 1340 260Z" style={{ fill: "var(--brand-300)" }} opacity="0.4" />
      <path d="M760 0 C 840 60 940 30 1010 80 S 1160 150 1240 90 S 1400 10 1480 0Z" style={{ fill: "var(--brand-200)" }} opacity="0.35" />
      <path d="M1120 260 C 1180 200 1290 210 1350 160 S 1500 130 1600 170 V260Z" style={{ fill: "var(--brand-900)" }} opacity="0.35" />
      {/* Brush strokes */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {STROKES.map((s, i) => (
          <path key={i} d={s.d} style={{ stroke: s.ink }} strokeWidth={s.w.toFixed(1)} opacity={s.o.toFixed(2)} />
        ))}
      </g>
      <rect width={W} height={H} fill={`url(#${g("scrim")})`} />
    </svg>
  );
}

/** Line art for the Holidays card: a calendar page and a lit diya, in the brand's light blues. */
export function HolidayArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 240 170" preserveAspectRatio="xMaxYMid meet" fill="none" aria-hidden="true" focusable="false">
      <circle cx="166" cy="80" r="70" fill="currentColor" opacity="0.12" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="116" y="34" width="92" height="86" rx="9" style={{ fill: "var(--surface)" }} />
        <path d="M116 58h92" />
        <path d="M138 26v16M186 26v16" />
        {[0, 1, 2, 3].map((c) => [0, 1, 2].map((r) => (
          <circle key={`${c}-${r}`} cx={132 + c * 20} cy={74 + r * 15} r={c === 2 && r === 1 ? 5 : 1.6}
            style={c === 2 && r === 1 ? { fill: "var(--brand-500)", stroke: "var(--brand-500)" } : { fill: "currentColor" }} />
        )))}
        <path d="M62 132c0 14 13 22 30 22s30-8 30-22H62z" style={{ fill: "var(--brand-50)" }} />
        <path d="M56 132h72" />
        <path d="M92 126c-6-6-5-13 0-22 5 9 6 16 0 22z" style={{ fill: "#f5b83d", stroke: "#e5a32a" }} />
        <path d="M70 102l-4-6M114 102l4-6M92 92v-8" opacity="0.7" />
      </g>
      <g fill="currentColor">
        <path d="M222 112l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" />
        <path d="M40 60l1.8 4.2 4.2 1.8-4.2 1.8L40 72l-1.8-4.2L34 66l4.2-1.8z" opacity="0.8" />
      </g>
    </svg>
  );
}
