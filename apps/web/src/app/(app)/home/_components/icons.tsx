import type { SVGProps } from "react";

/** Line icons used only on the Home screens, drawn to match @/components/icons. */

type P = SVGProps<SVGSVGElement>;

const base = (props: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true, focusable: false as const, ...props,
});

export const IconMedal = (p: P) => (
  <svg {...base(p)}><path d="M7.5 3h3l1.5 4.2L13.5 3h3l-2.6 6.4" /><path d="M9.6 9.4 7.5 3" /><circle cx="12" cy="15" r="5.5" /><path d="m12 12.3.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2-1.45-1.4 2-.3z" /></svg>
);
export const IconCake = (p: P) => (
  <svg {...base(p)}><path d="M4 21h16" /><path d="M5 21v-6.5A1.5 1.5 0 0 1 6.5 13h11a1.5 1.5 0 0 1 1.5 1.5V21" /><path d="M5 16.5c1.2 0 1.2 1 2.33 1s1.17-1 2.33-1 1.17 1 2.34 1 1.17-1 2.33-1 1.17 1 2.34 1 1.16-1 2.33-1" /><path d="M8 13v-3M12 13v-3M16 13v-3" /><path d="M8 7.5a.9.9 0 0 0 .9-.9C8.9 5.8 8 4.8 8 4.8s-.9 1-.9 1.8a.9.9 0 0 0 .9.9zM12 7.5a.9.9 0 0 0 .9-.9c0-.8-.9-1.8-.9-1.8s-.9 1-.9 1.8a.9.9 0 0 0 .9.9zM16 7.5a.9.9 0 0 0 .9-.9c0-.8-.9-1.8-.9-1.8s-.9 1-.9 1.8a.9.9 0 0 0 .9.9z" /></svg>
);
export const IconParty = (p: P) => (
  <svg {...base(p)}><path d="M4 20 8.6 7.8l7.6 7.6z" /><path d="M7 13.5 10.5 17" /><path d="M14 4.5c.6.9.5 2-.3 2.8M18.5 9.8c-.9-.6-2-.5-2.8.3M15.5 3l.4 1.2M21 8.5l-1.2-.4M19 3.5 17.5 5" /><circle cx="20" cy="13" r=".6" /><circle cx="11" cy="3" r=".6" /></svg>
);
export const IconJoinees = (p: P) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 11.7-3.9" /><path d="M18 14v6M15 17h6" /></svg>
);
export const IconChevronLeft = (p: P) => (
  <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base(p)}><path d="m9 18 6-6-6-6" /></svg>
);
export const IconChevronUp = (p: P) => (
  <svg {...base(p)}><path d="m18 15-6-6-6 6" /></svg>
);
export const IconExternal = (p: P) => (
  <svg {...base(p)}><path d="M14 4h6v6" /><path d="M20 4 10.5 13.5" /><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></svg>
);
export const IconMail = (p: P) => (
  <svg {...base(p)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></svg>
);
export const IconDollar = (p: P) => (
  <svg {...base(p)}><path d="M12 3v18" /><path d="M16.5 7.2c-.8-1.2-2.3-1.9-4.3-1.9-2.6 0-4.3 1.3-4.3 3.2 0 4.6 8.8 2.3 8.8 7 0 2-1.9 3.3-4.6 3.3-2.1 0-3.8-.8-4.6-2.2" /></svg>
);
export const IconPlane = (p: P) => (
  <svg {...base(p)}><path d="M3 19h18" /><path d="m4.5 13.2 2.2-.9 2.6 1.6 3.4-1.4-4.6-4.3 2-.8 6.6 3.2 2.8-1.1a1.6 1.6 0 0 1 1.2 3l-12.6 5.1a2 2 0 0 1-2.2-.5z" /></svg>
);
export const IconHand = (p: P) => (
  <svg {...base(p)}><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11" /><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v7" /><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13" /><path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.6-2.2L4.4 14.6a1.5 1.5 0 0 1 2.3-1.9L8 14" /></svg>
);
export const IconTray = (p: P) => (
  <svg {...base(p)}><path d="M3 13.5 5.5 5h13l2.5 8.5V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" /></svg>
);
export const IconDoc = (p: P) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6M9 9h2" /></svg>
);
export const IconCash = (p: P) => (
  <svg {...base(p)}><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v.01M18 14.5v.01" /></svg>
);
export const IconMegaphone = (p: P) => (
  <svg {...base(p)}><path d="M3.5 10v4a1 1 0 0 0 1 1H7l7 4V5L7 9H4.5a1 1 0 0 0-1 1z" /><path d="M7 15l1.3 4.5a1 1 0 0 0 1 .5h1.2" /><path d="M17.5 9.5a3.5 3.5 0 0 1 0 5" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconCheckCircle = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.7 2.7L16.2 9.5" /></svg>
);
export const IconPin = (p: P) => (
  <svg {...base(p)}><path d="M9 4h6l-1 5 3 3v1.5H7V12l3-3z" /><path d="M12 13.5V20" /></svg>
);
