"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/sheet";
import s from "./analytics.module.css";

export interface RawDrawerRow { id: string; name: string; number: string; value: string }

/**
 * Keka's "Raw Data" drawer: the people behind a chart, searchable, paged,
 * with a download. It is opened by `?raw=<chart>` so the list is computed on
 * the server from the same filters as the chart; closing drops the parameter.
 */
export function RawDrawer({ title = "Raw Data", rows, total, filtered, page, pages, valueLabel, query, baseHref, closeHref, downloadHref, linkPeople }: {
  title?: string; rows: RawDrawerRow[]; total: number; filtered: number; page: number; pages: number; valueLabel: string;
  query: string; baseHref: string; closeHref: string; downloadHref: string; linkPeople: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(query);
  const [menu, setMenu] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const go = (extra: Record<string, string>) => {
    const u = new URL(baseHref, "http://x");
    for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
    router.replace(`${u.pathname}?${u.searchParams.toString()}`, { scroll: false });
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const pageHref = (p: number) => {
    const u = new URL(baseHref, "http://x");
    if (query) u.searchParams.set("rq", query);
    u.searchParams.set("rp", String(p));
    return `${u.pathname}?${u.searchParams.toString()}`;
  };
  return (
    <Sheet open side title={title} onClose={() => router.replace(closeHref, { scroll: false })}>
      <div className={s.rawSearch}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input value={q} placeholder="Search" aria-label="Search employees"
          onChange={(e) => { const v = e.target.value; setQ(v); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => go({ rq: v.trim(), rp: "" }), 300); }} />
      </div>
      <div className={s.rawMeta}>
        <span>{rows.length} of {filtered === total ? total : `${filtered} (filtered from ${total})`} records</span>
        <span style={{ position: "relative" }}>
          <button type="button" className={s.menuBtn} style={{ border: 0, color: "var(--brand-600)" }} aria-label="Download" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {menu ? <div className={s.menu} style={{ left: "auto", right: 0 }}><a className={s.menuItem} href={downloadHref} onClick={() => setMenu(false)}>Download Excel</a></div> : null}
        </span>
      </div>
      <table className={s.rawTable}>
        <thead><tr><th>Employee Name</th><th>{valueLabel}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{linkPeople ? <Link href={`/employees/${r.id}`}>{r.name}</Link> : r.name}</td>
              <td>{r.value}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={2} style={{ color: "var(--text-subtle)" }}>No matching records.</td></tr> : null}
        </tbody>
      </table>
      {pages > 1 ? (
        <div className={s.pager}>
          {page > 1 ? <Link href={pageHref(page - 1)} replace scroll={false}>‹ Previous</Link> : null}
          <span>Page {page} of {pages}</span>
          {page < pages ? <Link href={pageHref(page + 1)} replace scroll={false}>Next ›</Link> : null}
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" className="btn" onClick={() => router.replace(closeHref, { scroll: false })}>Close</button>
      </div>
    </Sheet>
  );
}
