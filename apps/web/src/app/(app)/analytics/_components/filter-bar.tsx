"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "./analytics.module.css";

export interface FilterDef {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  /** Offer "Unassigned" (value "none"). */
  unassigned?: boolean;
}

const Chevron = () => (
  <svg className={s.chev} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOut]);
}

/** Push a new query string, dropping the raw-data drawer and paging. */
function useQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return {
    search,
    set(mut: (u: URLSearchParams) => void) {
      const u = new URLSearchParams(search.toString());
      for (const k of ["raw", "rq", "rp"]) u.delete(k);
      mut(u);
      const qs = u.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
  };
}

function MultiSelect({ def }: { def: FilterDef }) {
  const { search, set } = useQuery();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const selected = useMemo(() => (search.get(def.key) ?? "").split(",").filter(Boolean), [search, def.key]);
  const all = [...(def.unassigned ? [{ value: "none", label: "Unassigned" }] : []), ...def.options];
  const shown = all.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const write = (vals: string[]) => set((u) => { if (vals.length) u.set(def.key, vals.join(",")); else u.delete(def.key); });
  const toggle = (v: string) => write(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const allOn = all.length > 0 && all.every((o) => selected.includes(o.value));
  const names = all.filter((o) => selected.includes(o.value)).map((o) => o.label);
  return (
    <div className={s.fcell} ref={ref}>
      <button type="button" className={`${s.fbtn}${selected.length ? ` ${s.fbtnOn}` : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
        {selected.length ? (
          <span style={{ minWidth: 0 }}>
            <span className={s.fsmall}>{def.label}<span className={s.fcount}>{selected.length}</span></span>
            <span className={s.fval} title={names.join(", ")}>{names.join(", ")}</span>
          </span>
        ) : <span>{def.label}</span>}
        <Chevron />
      </button>
      {open ? (
        <div className={s.panel} role="listbox" aria-label={def.label} aria-multiselectable="true">
          <div className={s.panelSearch}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label={`Search ${def.label}`} autoFocus />
          </div>
          {!q ? (
            <label className={s.check}>
              <input type="checkbox" checked={allOn} onChange={() => write(allOn ? [] : all.map((o) => o.value))} /> Select All
            </label>
          ) : null}
          {shown.map((o) => (
            <label key={o.value} className={s.check}>
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
            </label>
          ))}
          {shown.length === 0 ? <div className={s.check} style={{ color: "var(--text-subtle)" }}>No matches</div> : null}
        </div>
      ) : null}
    </div>
  );
}

const RANGE_LABEL: Record<string, string> = { "3m": "3 Months", "6m": "6 Months", "9m": "9 Months", "12m": "12 Months" };

function DateRange({ value, label, ranges }: { value: string; label: string; ranges: string[] }) {
  const { search, set } = useQuery();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(value === "custom");
  const [from, setFrom] = useState(search.get("from") ?? "");
  const [to, setTo] = useState(search.get("to") ?? "");
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  return (
    <div className={s.fcell} ref={ref}>
      <button type="button" className={`${s.fbtn} ${s.fbtnOn}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ minWidth: 0 }}>
          <span className={s.fsmall}>Date Range</span>
          <span className={s.fval} title={label}>{label}</span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={s.chev} aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></svg>
      </button>
      {open ? (
        <div className={s.menu} style={{ minWidth: 220 }}>
          {ranges.map((r) => (
            <button key={r} type="button" className={`${s.menuItem}${value === r ? ` ${s.menuActive}` : ""}`}
              onClick={() => { setOpen(false); set((u) => { u.set("range", r); u.delete("from"); u.delete("to"); }); }}>
              {RANGE_LABEL[r]}
            </button>
          ))}
          <button type="button" className={`${s.menuItem}${value === "custom" ? ` ${s.menuActive}` : ""}`} onClick={() => setCustom(true)}>Custom Range</button>
          {custom ? (
            <form className={s.custom} onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) { setOpen(false); set((u) => { u.delete("range"); u.set("from", from); u.set("to", to); }); } }}>
              <label>From<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
              <label>To<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
              <button className="btn sm primary" type="submit" disabled={!from || !to || from > to}>Apply</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Keka's filter grid: one multi-select per dimension, a date range, and a clear-all funnel. */
export function FilterBar({ filters, range, ranges = ["3m", "6m", "9m", "12m"], keep = [], className, columns }: {
  filters: FilterDef[];
  range?: { value: string; label: string } | null;
  ranges?: string[];
  /** Params that survive "clear filters" (e.g. the selected view). */
  keep?: string[];
  className?: string;
  columns?: number;
}) {
  const { search, set } = useQuery();
  const active = [...filters.map((f) => f.key), "range", "from", "to"].some((k) => search.get(k));
  const cells = [...filters.slice(0, 5).map((f) => <MultiSelect key={f.key} def={f} />), range ? <DateRange key="range" value={range.value} label={range.label} ranges={ranges} /> : null, ...filters.slice(5).map((f) => <MultiSelect key={f.key} def={f} />)].filter(Boolean);
  return (
    <div className={`${s.filters}${className ? ` ${className}` : ""}`} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {cells}
      <div className={s.fcell} style={{ borderRight: 0, gridColumn: "auto / -1", minHeight: 52 }}>
        <button type="button" className={s.clear} title="Clear filters" aria-label="Clear filters" disabled={!active}
          onClick={() => set((u) => { for (const k of [...u.keys()]) if (!keep.includes(k)) u.delete(k); })}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z" /><circle cx="18" cy="18" r="4" fill="var(--surface)" /><path d="m16.5 16.5 3 3M19.5 16.5l-3 3" /></svg>
        </button>
      </div>
    </div>
  );
}

/** A compact select that writes one query parameter (storyboard header). */
export function ParamSelect({ param, value, options, placeholder }: { param: string; value: string; options: Array<{ value: string; label: string }>; placeholder: string }) {
  const { set } = useQuery();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div className={s.sbSelect} ref={ref}>
      <button type="button" className={s.sbSelectBtn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ color: current ? "var(--text)" : undefined }}>{current?.label ?? placeholder}</span>
        <Chevron />
      </button>
      {open ? (
        <div className={s.menu} style={{ minWidth: "100%" }}>
          {placeholder && !options.some((o) => o.value === "") ? (
            <button type="button" className={`${s.menuItem}${!value ? ` ${s.menuActive}` : ""}`} onClick={() => { setOpen(false); set((u) => u.delete(param)); }}>All</button>
          ) : null}
          {options.map((o) => (
            <button key={o.value} type="button" className={`${s.menuItem}${o.value === value ? ` ${s.menuActive}` : ""}`}
              onClick={() => { setOpen(false); set((u) => { if (o.value) u.set(param, o.value); else u.delete(param); }); }}>{o.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Group-by select on a storyboard widget. */
export function GroupBySelect({ param, value, options }: { param: string; value: string; options: Array<{ value: string; label: string }> }) {
  const { set } = useQuery();
  return (
    <label className={s.groupBy}>
      Group By
      <select value={value} onChange={(e) => set((u) => { if (e.target.value) u.set(param, e.target.value); else u.delete(param); })} aria-label="Group by">
        <option value="">Select</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
