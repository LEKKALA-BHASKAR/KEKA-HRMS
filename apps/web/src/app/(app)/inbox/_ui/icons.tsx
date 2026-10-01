import type { SVGProps } from "react";

/** Inbox-only icons, drawn in the same stroke style as @/components/icons. */
type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props,
});

export const IconSend = (p: P) => (
  <svg {...base(p)}><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5z" /></svg>
);
export const IconClipboardCheck = (p: P) => (
  <svg {...base(p)}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5" /><path d="m9 13 2 2 4-4" /></svg>
);
export const IconFeedback = (p: P) => (
  <svg {...base(p)}><path d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16h-7l-4.5 4v-4H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 4z" /><path d="M8 9h8M8 12h5" /></svg>
);
