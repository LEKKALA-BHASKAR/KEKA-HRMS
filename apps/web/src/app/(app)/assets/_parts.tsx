import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate } from "@keka/shared";
import { ASSET_CONDITION_LABEL, type AssetConditionKey } from "@keka/services";
import { IconDownload, IconSearch } from "@/components/icons";
import s from "./assets.module.css";

/**
 * Server-rendered building blocks shared by the asset screens: type icons,
 * Keka's boxed filter cells, the list toolbar, pagination, the yellow strip,
 * the empty state and timelines.
 */

export const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
//  Type icons
// ---------------------------------------------------------------------------

export function AssetIcon({ icon, size = 22 }: { icon: string | null | undefined; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (icon) {
    case "phone": return <svg {...p} style={{ color: "#c86dd7" }}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></svg>;
    case "tablet": return <svg {...p}><rect x="4.5" y="2.5" width="15" height="19" rx="2" /><path d="M11 18.5h2" /></svg>;
    case "chair": return <svg {...p} style={{ color: "#c98500" }}><path d="M7 3h10v8H7z" /><path d="M5 11h14v3H5z" /><path d="M8 14v7M16 14v7M12 14v4" /></svg>;
    case "card": return <svg {...p} style={{ color: "#1baf7a" }}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M6 16c.6-1.5 1.7-2 3-2s2.4.5 3 2M14 10h4M14 13h3" /></svg>;
    case "network": return <svg {...p}><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 17h.01M11 17h.01M12 14V9M8 6.5a6 6 0 0 1 8 0M5.5 4a9.5 9.5 0 0 1 13 0" /></svg>;
    case "headset": return <svg {...p}><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></svg>;
    case "monitor": case "desktop": return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6M12 16v4" /></svg>;
    case "laptop": return <svg {...p}><rect x="4.5" y="5" width="15" height="10" rx="1.2" /><path d="M2.5 18.5h19" /><path d="M9 15.5h6" /></svg>;
    default: return <svg {...p}><path d="M21 8 12 3 3 8l9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
  }
}

// ---------------------------------------------------------------------------
//  Filter cells (used inside the client FilterForm)
// ---------------------------------------------------------------------------

export function FSelect({ name, label, value, options, all }: { name: string; label: string; value?: string | null; options: Array<{ value: string; label: string }>; all?: string }) {
  const chosen = !!value && options.some((o) => o.value === value);
  return (
    <div className={s.fcell}>
      {chosen ? <label htmlFor={`f-${name}`}>{label}</label> : null}
      <select id={`f-${name}`} name={name} defaultValue={chosen ? value! : ""} className={chosen ? undefined : s.placeholder} aria-label={label}>
        <option value="">{all ?? label}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function FDate({ name, label, value }: { name: string; label: string; value?: string | null }) {
  return (
    <div className={`${s.fcell} ${s.date}`}>
      <label htmlFor={`f-${name}`}>{label}</label>
      <input id={`f-${name}`} type="date" name={name} defaultValue={value ?? ""} aria-label={label} />
    </div>
  );
}

export function FSearch({ value, clearHref, placeholder = "Search", hidden }: { value?: string | null; clearHref?: string | null; placeholder?: string; hidden?: Record<string, string | undefined> }) {
  return (
    <div className={s.fsearch}>
      <IconSearch width={18} height={18} />
      <input type="search" name="q" defaultValue={value ?? ""} placeholder={placeholder} aria-label="Search" />
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {clearHref ? (
        <Link href={clearHref} className={s.fclear} aria-label="Clear filters" title="Clear filters" scroll={false}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 4h15l-6 7v6l-3 2v-8z" /><circle cx="18" cy="17" r="3.5" /><path d="m16.6 15.6 2.8 2.8M19.4 15.6l-2.8 2.8" /></svg>
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Toolbar, pager, banners
// ---------------------------------------------------------------------------

export function Toolbar({ total, exportHref, left }: { total: number; exportHref?: string; left?: ReactNode }) {
  return (
    <div className={s.toolbar}>
      {left}
      {left ? <span style={{ flex: 1 }} /> : null}
      <span className={s.total}>Total: {total}</span>
      {exportHref ? <a href={exportHref} className={s.iconBtn} aria-label="Download as CSV" title="Download"><IconDownload width={18} height={18} /></a> : null}
    </div>
  );
}

/** "1 to 25 of 41 · Page 1 of 2" with first/previous/next/last. */
export function Pager({ total, page, href }: { total: number; page: number; href: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1, to = Math.min(total, page * PAGE_SIZE);
  const nav = (p: number, label: string, glyph: string) => (p >= 1 && p <= pages && p !== page
    ? <Link href={href(p)} aria-label={label} scroll={false}>{glyph}</Link>
    : <span className={s.off} aria-hidden="true">{glyph}</span>);
  return (
    <div className={s.pager}>
      <span>{from} to {to} of {total}</span>
      <span className={s.pagerNav}>
        {nav(1, "First page", "«")}{nav(page - 1, "Previous page", "‹")}
        <span style={{ margin: "0 10px" }}>Page {total === 0 ? 0 : page} of {total === 0 ? 0 : pages}</span>
        {nav(page + 1, "Next page", "›")}{nav(pages, "Last page", "»")}
      </span>
    </div>
  );
}

export function pageOf(raw: string | undefined, total: number): number {
  const n = Number(raw);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
}

export function Yellow({ children }: { children: ReactNode }) {
  return <div className={s.yellow} role="note">{children}</div>;
}

export function EmptyList({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyTitle}>{title}</div>
      <svg className={s.emptyArt} width="110" height="96" viewBox="0 0 110 96" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="14" y="6" width="58" height="76" rx="5" fill="var(--surface-sunken)" />
        <path d="M26 24h34M26 36h34M26 48h22" strokeLinecap="round" />
        <circle cx="76" cy="62" r="20" fill="var(--surface)" />
        <path d="m67 62 7 7 12-13" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children ? <div className={s.emptyText}>{children}</div> : null}
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className={s.pageHead}>
      <div>
        <h1 className={s.pageTitle}>{title}</h1>
        {sub ? <p className={s.pageSub}>{sub}</p> : null}
      </div>
      {right ? <div className="row gap-2" style={{ alignItems: "center" }}>{right}</div> : null}
    </div>
  );
}

export function Segments({ items }: { items: Array<{ label: string; href: string; on: boolean }> }) {
  return (
    <nav className={s.segments} aria-label="Views">
      {items.map((i) => <Link key={i.href} href={i.href} className={i.on ? s.on : undefined} aria-current={i.on ? "page" : undefined}>{i.label}</Link>)}
    </nav>
  );
}

// ---------------------------------------------------------------------------
//  Small values
// ---------------------------------------------------------------------------

export const condLabel = (c: string | null | undefined) => (c ? ASSET_CONDITION_LABEL[c as AssetConditionKey] ?? c : "—");

export function AckText({ status }: { status: string }) {
  const tone = status === "PENDING" ? "#f08c2e" : status === "ACKNOWLEDGED" ? "#5cb85c" : "#b7bcc6";
  const label = status === "PENDING" ? "Pending" : status === "ACKNOWLEDGED" ? "Acknowledged" : "Not Applicable";
  return <span className={s.dotBadge}><i style={{ background: tone }} />{label}</span>;
}

export function StatusText({ status }: { status: string }) {
  const tone: Record<string, string> = { AVAILABLE: "#5cb85c", ASSIGNED: "var(--brand-500)", IN_REPAIR: "#f08c2e", LOST: "#ef5350", UNAVAILABLE: "#9aa1ad", RETIRED: "#c4c8d0" };
  const label: Record<string, string> = { AVAILABLE: "Available", ASSIGNED: "Assigned", IN_REPAIR: "In repair", LOST: "Lost", UNAVAILABLE: "Not Available", RETIRED: "Retired" };
  return <span className={s.dotBadge}><i style={{ background: tone[status] ?? "#9aa1ad" }} />{label[status] ?? status}</span>;
}

export interface TimelineEntry { text: ReactNode; at: Date; tone?: "ok" | "grey" | "red"; note?: string | null }

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="muted text-sm">Nothing recorded yet.</p>;
  return (
    <div className={s.timeline}>
      {entries.map((e, i) => (
        <div key={i} className={s.tlRow}>
          <svg className={`${s.tick}${e.tone === "grey" ? ` ${s.grey}` : e.tone === "red" ? ` ${s.red}` : ""}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />{e.tone === "red" ? <path d="m9 9 6 6M15 9l-6 6" strokeLinecap="round" /> : <path d="m8 12 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
          <div>
            <span>{e.text}</span><span className={s.at}>{dateTime(e.at)}</span>
            {e.note ? <span className={s.tlNote}>{e.note}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "14 Aug 2025 04:38 pm" in IST. */
export function dateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")} ${g("month")} ${g("year")} ${g("hour")}:${g("minute")} ${g("dayPeriod").toLowerCase()}`;
}

export const fmt = (d: Date | null | undefined) => formatDate(d ?? null);

/** Build a query string from the current filters plus overrides; empty values drop out. */
export function qs(base: Record<string, string | undefined | null>, over: Record<string, string | undefined | null> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v);
  const s2 = p.toString();
  return s2 ? `?${s2}` : "";
}
