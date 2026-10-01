"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "../hire.module.css";

export interface FilterSelect { name: string; label: string; options: Array<{ value: string; label: string }> }

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/**
 * Keka's filter strip: a row of dropdowns and a search box. Each change
 * rewrites the URL (and returns to page 1), so a filtered list can be
 * shared and survives a refresh.
 */
export function FilterBar({ selects }: { selects: FilterSelect[] }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(search.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value); else next.delete(key);
    next.delete("page");
    start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div className={s.filters} style={{ ["--cols" as string]: selects.length, opacity: pending ? 0.7 : 1 }} role="search">
      {selects.map((f) => (
        <label key={f.name} className={s.filter}>
          <span className="sr-only">{f.label}</span>
          <select aria-label={f.label} value={search.get(f.name) ?? ""} onChange={(e) => push(f.name, e.target.value)} style={search.get(f.name) ? { color: "var(--text)" } : undefined}>
            <option value="">{f.label}</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <Chevron />
        </label>
      ))}
      <label className={s.search}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" strokeLinecap="round" /></svg>
        <input
          type="search" placeholder="Search" aria-label="Search" value={q}
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => push("q", v.trim()), 350);
          }}
        />
      </label>
    </div>
  );
}
