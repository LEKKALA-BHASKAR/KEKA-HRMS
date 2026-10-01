import Link from "next/link";
import type { ReactNode } from "react";
import { PRIORITY_TEXT, STATUS_TEXT, STATUS_TONE, avatarColour, initials } from "./format";
import s from "./hd.module.css";

export function PriorityPill({ p }: { p: string }) {
  return <span className={`${s.prio} ${s[`prio_${p}`] ?? ""}`}>{PRIORITY_TEXT[p] ?? p}</span>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`${s.pill} ${s[`pill_${STATUS_TONE[status] ?? "open"}`]}`}>{STATUS_TEXT[status] ?? status}</span>;
}

export function Initials({ name, size = 30, photoUrl }: { name: string; size?: number; photoUrl?: string | null }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: "50%", background: avatarColour(name), color: "#fff", flexShrink: 0,
      display: "inline-grid", placeItems: "center", fontSize: Math.round(size * 0.4), fontWeight: 500,
    }}>{initials(name)}</span>
  );
}

function Chevron({ dir, double }: { dir: "left" | "right"; double?: boolean }) {
  const d = dir === "left" ? "M14.5 6 8.5 12l6 6" : "M9.5 6l6 6-6 6";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
      {double ? <path d={dir === "left" ? "M7 6v12" : "M17 6v12"} /> : null}
    </svg>
  );
}

/** "1 to 2 of 2 · |< < Page 1 of 1 > >|" */
export function Pager({ total, page, size, link }: { total: number; page: number; size: number; link: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(total, page * size);
  const step = (p: number, label: string, icon: ReactNode, off: boolean) => off
    ? <span className={s.pageBtn} aria-disabled="true" aria-label={label}>{icon}</span>
    : <Link className={s.pageBtn} href={link(p)} aria-label={label} scroll={false}>{icon}</Link>;
  return (
    <nav className={s.pager} aria-label="Pagination">
      <span>{from} to {to} of {total}</span>
      <span className={s.pagerNav}>
        {step(1, "First page", <Chevron dir="left" double />, page <= 1)}
        {step(page - 1, "Previous page", <Chevron dir="left" />, page <= 1)}
        <span>Page {page} of {pages}</span>
        {step(page + 1, "Next page", <Chevron dir="right" />, page >= pages)}
        {step(pages, "Last page", <Chevron dir="right" double />, page >= pages)}
      </span>
    </nav>
  );
}

export const pageOf = (raw: string | undefined, total: number, size: number) => {
  const pages = Math.max(1, Math.ceil(total / size));
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, pages) : 1;
};

export function BackLink({ href, children = "Back to Tickets List" }: { href: string; children?: ReactNode }) {
  return (
    <Link href={href} className={s.back}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
      {children}
    </Link>
  );
}

export const PaperclipIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.5 11.5 12.4 19.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </svg>
);

/** Attachments on a ticket or a message. */
export function Attachments({ files }: { files: Array<{ id: string; filename: string }> }) {
  if (!files.length) return null;
  return (
    <div className={s.attach}>
      {files.map((f) => <a key={f.id} href={`/files/${f.id}`} target="_blank" rel="noreferrer" className={s.fileChip}><PaperclipIcon size={14} />{f.filename}</a>)}
    </div>
  );
}
