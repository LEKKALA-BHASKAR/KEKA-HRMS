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

// --- Rail icons -------------------------------------------------------------
export const IconUser = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
export const IconTeam = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="7.5" r="2.6" /><circle cx="5.5" cy="9.5" r="2.1" /><circle cx="18.5" cy="9.5" r="2.1" /><path d="M7.5 19a4.5 4.5 0 0 1 9 0" /><path d="M2 18.5a3.6 3.6 0 0 1 5.4-3.1" /><path d="M22 18.5a3.6 3.6 0 0 0-5.4-3.1" /></svg>
);
export const IconDollarCircle = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M15 8.8c-.6-.9-1.7-1.4-3-1.4-1.7 0-3 .9-3 2.2 0 3.1 6 1.6 6 4.7 0 1.3-1.3 2.3-3 2.3-1.4 0-2.6-.6-3.2-1.6" /><path d="M12 5.5v1.9M12 16.6v1.9" /></svg>
);
export const IconOrg = (p: P) => (
  <svg {...base(p)}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2" /><path d="M10 21v-3h4v3" /></svg>
);
export const IconEngage = (p: P) => (
  <svg {...base(p)}><path d="M14.5 9.5a5.5 5.5 0 1 0-10.2 2.9L3.5 15l2.8-.8A5.5 5.5 0 0 0 14.5 9.5Z" /><path d="M9.6 15.8A5.5 5.5 0 0 0 19.7 18l2.8.8-.8-2.6a5.5 5.5 0 0 0-5.2-8" /><circle cx="15.5" cy="15.5" r="1.4" /></svg>
);
export const IconTarget = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base(p)}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);
export const IconMenu = (p: P) => (
  <svg {...base(p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
);
export const IconLedger = (p: P) => (
  <svg {...base(p)}><path d="M5 3h11l3 3v15H5z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
);
export const IconUserPlus = (p: P) => (
  <svg {...base(p)}><circle cx="10" cy="8" r="4" /><path d="M2.5 21a7.5 7.5 0 0 1 15 0" /><path d="M19 7v6M16 10h6" /></svg>
);
export const IconTimer = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5" /><path d="M9.5 2.5h5" /></svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base(p)}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.3 6.3A17.2 17.2 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.6-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
);
export const IconTrophy = (p: P) => (
  <svg {...base(p)}><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" /><path d="M12 14v3M8 21h8M9.5 21l.5-4h4l.5 4" /></svg>
);
export const IconBook = (p: P) => (
  <svg {...base(p)}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8.5 7.5h7M8.5 11h5" /></svg>
);
