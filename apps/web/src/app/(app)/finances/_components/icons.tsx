import type { SVGProps } from "react";

/** Stroke icons used only by My Finances, drawn to match components/icons. */

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p,
});

export const IconHistory = (p: P) => (
  <svg {...base(p)}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4.5H8" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconClip = (p: P) => (
  <svg {...base(p)}><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" /></svg>
);
export const IconTrend = (p: P) => (
  <svg {...base(p)}><path d="m3.5 16.5 6-6 4 4 7-7" /><path d="M15 7.5h5.5V13" /></svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6v.2" /></svg>
);
export const IconChevron = (p: P) => (
  <svg {...base(p)}><path d="m9 5.5 6.5 6.5L9 18.5" /></svg>
);
export const IconDown = (p: P) => (
  <svg {...base(p)}><path d="M12 4v11" /><path d="m7 10.5 5 5 5-5" /><path d="M5 20h14" /></svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}><path d="M12 15.5V4.5" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l1 13h9l1-13" /></svg>
);
export const IconDoc = (p: P) => (
  <svg {...base(p)}><path d="M6 3h8.5L19 7.5V21H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></svg>
);

/** The tricolour shown beside Indian identity documents. */
export function FlagIN({ size = 22 }: { size?: number }) {
  const h = Math.round(size * 0.7);
  return (
    <svg width={size} height={h} viewBox="0 0 30 21" role="img" aria-label="India">
      <rect width="30" height="7" fill="#ff9933" />
      <rect y="7" width="30" height="7" fill="#ffffff" />
      <rect y="14" width="30" height="7" fill="#138808" />
      <circle cx="15" cy="10.5" r="2.6" fill="none" stroke="#000080" strokeWidth="0.9" />
      <rect width="30" height="21" fill="none" stroke="rgba(0,0,0,.12)" />
    </svg>
  );
}
