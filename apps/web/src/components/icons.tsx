import type { SVGProps } from "react";

/** Inline stroke icons — no icon-library dependency, no runtime cost. */

type P = SVGProps<SVGSVGElement>;

const base = (props: P) => ({
  width: 18, height: 18, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  ...props,
});

export const IconHome = (p: P) => (
  <svg {...base(p)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></svg>
);
export const IconUsers = (p: P) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16.5 5.3a3.2 3.2 0 0 1 0 6.1" /><path d="M18 14.4A6.5 6.5 0 0 1 21.5 20" /></svg>
);
export const IconBuilding = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="3" width="9" height="18" rx="1.5" /><path d="M12.5 8h6a1.5 1.5 0 0 1 1.5 1.5V21" /><path d="M6.5 7h3M6.5 11h3M6.5 15h3M15.5 12h2M15.5 16h2" /></svg>
);
export const IconWallet = (p: P) => (
  <svg {...base(p)}><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3" /><rect x="3" y="7.5" width="18" height="12" rx="2.5" /><circle cx="16.5" cy="13.5" r="1.3" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M10 8.5 15.5 12 10 15.5z" /></svg>
);
export const IconReceipt = (p: P) => (
  <svg {...base(p)}><path d="M5 3h14v18l-2.3-1.6-2.3 1.6-2.4-1.6L9.6 21l-2.3-1.6L5 21z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);
export const IconChart = (p: P) => (
  <svg {...base(p)}><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7.5" y="12" width="3" height="5" rx="1" /><rect x="13" y="8" width="3" height="9" rx="1" /><rect x="18" y="5" width="3" height="12" rx="1" /></svg>
);
export const IconShield = (p: P) => (
  <svg {...base(p)}><path d="M12 3 5 6v6c0 4.4 2.9 7.8 7 9 4.1-1.2 7-4.6 7-9V6z" /><path d="m9.3 12 1.9 1.9 3.6-3.7" /></svg>
);
export const IconCalendar = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></svg>
);
export const IconFile = (p: P) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1z" /></svg>
);
export const IconBriefcase = (p: P) => (
  <svg {...base(p)}><rect x="2.5" y="7" width="19" height="13" rx="2" /><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M2.5 12.5h19" /></svg>
);
export const IconLogout = (p: P) => (
  <svg {...base(p)}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 16 5-4-5-4" /><path d="M21 12H9" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}><path d="m5 13 4.5 4.5L19 7" /></svg>
);
export const IconAlert = (p: P) => (
  <svg {...base(p)}><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}><path d="M12 3v12" /><path d="m7.5 11 4.5 4 4.5-4" /><path d="M4 19h16" /></svg>
);
export const IconLock = (p: P) => (
  <svg {...base(p)}><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></svg>
);
export const IconInbox = (p: P) => (
  <svg {...base(p)}><path d="M3.5 13h4l1.5 3h6l1.5-3h4" /><path d="M5.7 5h12.6a2 2 0 0 1 1.9 1.4L22 13v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5L3.8 6.4A2 2 0 0 1 5.7 5z" /></svg>
);
export const IconHeadset = (p: P) => (
  <svg {...base(p)}><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="2.5" y="13.5" width="4.5" height="6" rx="1.7" /><rect x="17" y="13.5" width="4.5" height="6" rx="1.7" /><path d="M19 19.5v.5a2.5 2.5 0 0 1-2.5 2.5H13" /></svg>
);
export const IconBox = (p: P) => (
  <svg {...base(p)}><path d="m12 2.5 8.5 4.7v9.6L12 21.5l-8.5-4.7V7.2z" /><path d="M3.5 7.2 12 12l8.5-4.8M12 12v9.5" /></svg>
);
