/**
 * Helpdesk display helpers shared by server pages and client components:
 * Keka's labels, tones and date wording. No server imports here.
 */

export const STATUS_TEXT: Record<string, string> = {
  OPEN: "Open", IN_PROGRESS: "In Progress", ON_HOLD: "On Hold", CLOSED: "Closed", WAITING_ON_EMPLOYEE: "On Hold", RESOLVED: "Closed",
};
export const PRIORITY_TEXT: Record<string, string> = { NA: "NA", LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "High" };
/** Pill tone per normalised status: OPEN red, IN PROGRESS amber, ON HOLD grey, CLOSED green. */
export const STATUS_TONE: Record<string, "open" | "progress" | "hold" | "closed"> = {
  OPEN: "open", IN_PROGRESS: "progress", ON_HOLD: "hold", WAITING_ON_EMPLOYEE: "hold", CLOSED: "closed", RESOLVED: "closed",
};
export const PRIORITY_DOT: Record<string, string> = { LOW: "#9aa3b2", MEDIUM: "#f2b23a", HIGH: "#ef6f6f", URGENT: "#ef6f6f", NA: "transparent" };

const TZ = "Asia/Kolkata";

/** "23 Jun, 2025" */
export function day(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ }).formatToParts(x);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")}, ${get("year")}`;
}

/** "18 Aug 2025" (no comma, as in "Ticket raised on 18 Aug 2025"). */
export function dayPlain(d: Date | string | null | undefined): string {
  return day(d).replace(",", "");
}

/** "23 Jun, 2025 02:35" */
export function dayTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const x = typeof d === "string" ? new Date(d) : d;
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(x);
  return `${day(x)} ${t}`;
}

/** "Aug 12, 2025 at 12:01 PM" — Keka's thread timestamp. */
export function threadTime(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: TZ }).format(x);
  return `${date} at ${time}`;
}

/** "12th Aug 2025, 04:01 PM" — the "Please respond by…" banner. */
export function bannerTime(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const n = Number(new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: TZ }).format(x));
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  const rest = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: TZ }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: TZ }).format(x);
  return `${n}${suffix} ${rest}, ${time}`;
}

/** "a few seconds ago", "2 hours ago", "3 days ago". */
export function ago(d: Date | string, now = Date.now()): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const s = Math.max(0, Math.round((now - x.getTime()) / 1000));
  if (s < 45) return "a few seconds ago";
  if (s < 90) return "a minute ago";
  const m = Math.round(s / 60);
  if (m < 45) return `${m} minutes ago`;
  if (m < 90) return "an hour ago";
  const h = Math.round(m / 60);
  if (h < 22) return `${h} hours ago`;
  if (h < 36) return "a day ago";
  const days = Math.round(h / 24);
  if (days < 26) return `${days} days ago`;
  if (days < 45) return "a month ago";
  if (days < 320) return `${Math.round(days / 30)} months ago`;
  return days < 548 ? "a year ago" : `${Math.round(days / 365)} years ago`;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** Colour for an initials avatar, stable per name. */
export function avatarColour(name: string): string {
  const palette = ["#4fb6c9", "#7c8ce0", "#f29f67", "#5cb88a", "#d87aa8", "#8f7ad8", "#e0b84f", "#5a9bd8"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** yyyy-mm-dd in IST. */
export function isoDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** IST midnight of a yyyy-mm-dd. */
export function istMidnight(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 330 * 60_000);
}

export const DATE_PRESETS = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "14d", label: "Last 14 days", days: 14 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "3m", label: "Last 3 months", days: 91 },
  { key: "6m", label: "Last 6 months", days: 182 },
  { key: "1y", label: "Last 1 year", days: 365 },
] as const;

/** Resolve ?range=7d or ?from=…&to=… into an IST [from, to) window and its label. */
export function resolveRange(sp: { range?: string; from?: string; to?: string }, fallback: string, now = new Date()): { from: Date; to: Date; label: string; key: string; fromYmd: string; toYmd: string } {
  const todayYmd = isoDay(now);
  const tomorrow = new Date(istMidnight(todayYmd)!.getTime() + 86_400_000);
  if (sp.range === "custom" && sp.from && sp.to) {
    const f = istMidnight(sp.from), t = istMidnight(sp.to);
    if (f && t && t >= f) {
      const to = new Date(t.getTime() + 86_400_000);
      return { from: f, to, label: `${day(f).replace(",", "")} - ${day(t).replace(",", "")}`, key: "custom", fromYmd: sp.from, toYmd: sp.to };
    }
  }
  const p = DATE_PRESETS.find((x) => x.key === sp.range) ?? DATE_PRESETS.find((x) => x.key === fallback) ?? DATE_PRESETS[0];
  const from = new Date(tomorrow.getTime() - p.days * 86_400_000);
  return { from, to: tomorrow, label: `${day(from).replace(",", "")} - ${day(new Date(tomorrow.getTime() - 1)).replace(",", "")}`, key: p.key, fromYmd: isoDay(from), toYmd: todayYmd };
}
