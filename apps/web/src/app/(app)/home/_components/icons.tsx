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

// --- Keka Wall --------------------------------------------------------------
export const IconThumbUp = (p: P) => (
  <svg {...base(p)}><path d="M7 10.5v9.5H4.5a1 1 0 0 1-1-1V11.5a1 1 0 0 1 1-1z" /><path d="M7 10.5 10.6 4a1.9 1.9 0 0 1 3.4 1.6l-.9 3.4h5.1a2 2 0 0 1 2 2.4l-1.3 6.6a2 2 0 0 1-2 1.6H7" /></svg>
);
export const IconComment = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="12" rx="1.5" /><path d="M8 16.5v3.5l4-3.5" /><path d="M7.5 9h9M7.5 12h6" /></svg>
);
export const IconUserCheck = (p: P) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.3" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" /><path d="m15.5 12.5 2 2 4-4" /></svg>
);
export const IconPollBars = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="5" rx="1" /><rect x="3.5" y="14.5" width="17" height="5" rx="1" /><path d="M7 7h7M7 17h4" /></svg>
);
export const IconPostPen = (p: P) => (
  <svg {...base(p)}><path d="M12.5 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12.5A1.5 1.5 0 0 0 5.5 20h12.5a1.5 1.5 0 0 0 1.5-1.5v-7" /><path d="M17.8 3.2a1.8 1.8 0 0 1 2.6 2.6L12 14.2l-3.4.8.8-3.4z" /></svg>
);
export const IconAt = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3.6" /><path d="M15.6 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7" /></svg>
);
export const IconImage = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="m4 17 4.5-4.5 3.5 3.5 2.5-2.5L20 18" /></svg>
);
export const IconSmile = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.3a4.2 4.2 0 0 0 7 0" /><path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth="2.4" /></svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconGear = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
export const IconHouse = (p: P) => (
  <svg {...base(p)}><path d="M3.5 11 12 4l8.5 7" /><path d="M6 9.5V20h12V9.5" /></svg>
);
export const IconCase = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="7.5" width="17" height="12" rx="1.5" /><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5" /></svg>
);
export const IconClip = (p: P) => (
  <svg {...base(p)}><path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" /></svg>
);
export const IconEyeOpen = (p: P) => (
  <svg {...base(p)}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const IconWand = (p: P) => (
  <svg {...base(p)}><path d="m4 20 11-11" /><path d="m13 7 2-2 2 2-2 2z" /><path d="M18 3v2M20 7h-2M19 11v1M9 4h1" /></svg>
);
export const IconKebab = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="5.5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="18.5" r="1" fill="currentColor" /></svg>
);
