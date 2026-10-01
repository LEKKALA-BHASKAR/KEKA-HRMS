"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "./hd.module.css";

export function SearchIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

/** Push a patch of query params, dropping empty ones and resetting the given page key. */
export function useQueryPatch() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (patch: Record<string, string | string[] | null | undefined>, reset: string[] = []) => {
    const q = new URLSearchParams(search.toString());
    for (const k of [...Object.keys(patch), ...reset]) q.delete(k);
    for (const [k, v] of Object.entries(patch)) {
      if (Array.isArray(v)) v.filter(Boolean).forEach((x) => q.append(k, x));
      else if (v) q.set(k, v);
    }
    const qs = q.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
}

/** The Search box and period select above a ticket table (My Tickets). */
export function ListControls({ qKey, periodKey, pageKey, q, period, periods }: {
  qKey: string; periodKey: string; pageKey: string; q: string; period: string; periods: Array<{ value: string; label: string }>;
}) {
  const patch = useQueryPatch();
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  return (
    <div className={s.toolbar}>
      <form className={s.search} role="search" onSubmit={(e) => { e.preventDefault(); patch({ [qKey]: text.trim() }, [pageKey]); }}>
        <SearchIcon />
        <input className="input" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== q && patch({ [qKey]: text.trim() }, [pageKey])} aria-label="Search tickets" />
      </form>
      <select className={`select ${s.selectBox}`} value={period} onChange={(e) => patch({ [periodKey]: e.target.value }, [pageKey])} aria-label="Period">
        {periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
    </div>
  );
}

/** A dropdown shell: a button and a floating panel that closes on outside click and Escape. */
export function Dropdown({ button, children, right, className, boxed, open: controlled, onOpenChange }: {
  button: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); right?: boolean; className?: string; boxed?: boolean;
  open?: boolean; onOpenChange?: (o: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const set = (o: boolean) => { setOwn(o); onOpenChange?.(o); };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) set(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") set(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  });
  return (
    <div className={`${s.dd}${className ? ` ${className}` : ""}`} ref={box}>
      <button type="button" className={`${s.ddBtn}${boxed ? ` ${s.ddBtnBoxed}` : ""}`} aria-expanded={open} onClick={() => set(!open)}>
        {button}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? <div className={`${s.ddMenu}${right ? ` ${s.ddMenuRight}` : ""}`}>{typeof children === "function" ? children(() => set(false)) : children}</div> : null}
    </div>
  );
}

export interface MultiOption { value: string; label: string; depth?: number }

/**
 * A multi-select with search and Select All, as on Keka's filters. Labels
 * show "CATEGORY / 18 selected" once something is picked. `onApply` gets
 * the values when the panel closes (or on each change with `live`).
 */
export function MultiSelect({ label, options, value, onApply, boxed, summary, right }: {
  label: string; options: MultiOption[]; value: string[]; onApply: (v: string[]) => void; boxed?: boolean; summary?: string; right?: boolean;
}) {
  const [sel, setSel] = useState<string[]>(value);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => setSel(value), [value]);
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const all = shown.length > 0 && shown.every((o) => sel.includes(o.value));
  const toggle = (v: string) => setSel((xs) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]));
  const changed = sel.length !== value.length || sel.some((x) => !value.includes(x));
  return (
    <Dropdown boxed={boxed} right={right} open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setQ(""); if (changed) onApply(sel); } }} button={
      value.length ? (
        <span style={{ minWidth: 0 }}><span className={s.ddLabel} style={{ display: "block" }}>{label}</span><span className={s.ddValue} style={{ display: "block" }}>{summary ?? `${value.length} selected`}</span></span>
      ) : <span className={s.ddPlaceholder}>{label}</span>
    }>
      <div className={s.ddSearch}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label}`} autoFocus />
      </div>
      <div className={s.ddList}>
        <label className={s.ddItem}>
          <input type="checkbox" checked={all} onChange={() => setSel(all ? sel.filter((x) => !shown.some((o) => o.value === x)) : [...new Set([...sel, ...shown.map((o) => o.value)])])} />
          Select All
        </label>
        {shown.map((o) => (
          <label key={o.value} className={`${s.ddItem}${o.depth ? ` ${s.ddChild}` : ""}`}>
            <input type="checkbox" checked={sel.includes(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
          </label>
        ))}
        {!shown.length ? <div className={s.emptySmall}>Nothing matches.</div> : null}
      </div>
    </Dropdown>
  );
}

const PRESETS = [
  { key: "7d", label: "Last 7 days" }, { key: "14d", label: "Last 14 days" }, { key: "30d", label: "Last 30 days" },
  { key: "3m", label: "Last 3 months" }, { key: "6m", label: "Last 6 months" }, { key: "1y", label: "Last 1 year" },
];

/** DATE RANGE: presets plus a custom from/to. */
export function DateRange({ label, rangeKey, from, to, onApply, boxed }: {
  label: string; rangeKey: string; from: string; to: string; boxed?: boolean;
  onApply: (v: { range: string; from?: string; to?: string }) => void;
}) {
  const [custom, setCustom] = useState(rangeKey === "custom");
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const fmt = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <Dropdown boxed={boxed} button={
      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10, width: "100%", justifyContent: "space-between" }}>
        <span><span className={s.ddLabel} style={{ display: "block" }}>{label}</span><span className={s.ddValue} style={{ display: "block" }}>{fmt(from)} - {fmt(to)}</span></span>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" style={{ color: "var(--text-muted)" }}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
      </span>
    }>
      {(close) => (
        <div style={{ minWidth: 220 }}>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={s.ddOption} style={rangeKey === p.key ? { background: "var(--surface-hover)" } : undefined}
              onClick={() => { setCustom(false); onApply({ range: p.key }); close(); }}>{p.label}</button>
          ))}
          <button type="button" className={s.ddOption} onClick={() => setCustom(true)}>Custom Range</button>
          {custom ? (
            <div style={{ padding: "8px 16px 4px", display: "grid", gap: 8 }}>
              <label className="text-xs muted">From <input className="input" type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} /></label>
              <label className="text-xs muted">To <input className="input" type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} /></label>
              <button type="button" className="btn primary sm" disabled={!f || !t || f > t} onClick={() => { onApply({ range: "custom", from: f, to: t }); close(); }}>Apply</button>
            </div>
          ) : null}
        </div>
      )}
    </Dropdown>
  );
}
