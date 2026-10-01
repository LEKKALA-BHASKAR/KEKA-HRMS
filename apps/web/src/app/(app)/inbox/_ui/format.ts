/**
 * Small formatting helpers shared by the three inbox tabs. Instants (when
 * something happened) are shown in IST; calendar dates stored as UTC
 * midnights go through `formatDate` from @keka/shared instead.
 */

const TZ = "Asia/Kolkata";
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });

const STEPS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"], [Number.POSITIVE_INFINITY, "year"],
];

/** "2 months ago", "3 hours ago", "in 2 days". */
export function relativeTime(d: Date, now: Date = new Date()): string {
  let diff = (d.getTime() - now.getTime()) / 1000;
  if (Math.abs(diff) < 45) return "just now";
  for (const [size, unit] of STEPS) {
    if (Math.abs(diff) < size) return rtf.format(Math.round(diff), unit);
    diff /= size;
  }
  return rtf.format(Math.round(diff), "year");
}

/** "06 Aug 2026 05:04 pm", in IST. */
export function formatDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

/** "29 Dec 2025", the IST calendar date of an instant. */
export function formatInstantDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}`;
}

/** "09:42 am", in IST. */
export function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true }).toLowerCase();
}

/** "WORK_FROM_HOME" → "Work from home". */
export function humanise(s: string): string {
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Case-insensitive match of a search term against any of the given strings. */
export function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

/** Only same-site paths are followed from stored links. */
export function safeInternalLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith("/") || link.startsWith("//") || link.startsWith("/\\")) return null;
  return link;
}
