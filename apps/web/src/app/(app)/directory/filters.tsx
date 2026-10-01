"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { IconChevronDown, IconSearch } from "@/components/icons";
import s from "./directory.module.css";

export interface FilterDef {
  key: string;
  label: string;
  value: string;
  options: Array<{ id: string; name: string }>;
}

/**
 * The directory's filter bar: five dropdowns and a search box, all kept in
 * the URL so the page stays server-rendered and shareable. Without
 * JavaScript the form still submits as a plain GET.
 */
export function DirectoryFilters({ filters, q, filtered }: { filters: FilterDef[]; q: string; filtered: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const initial = () => Object.fromEntries(filters.map((f) => [f.key, f.value]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [text, setText] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastPushed = useRef(q);

  // The URL is the source of truth: follow it when it changes from outside
  // (back button, "clear filters"), but never fight someone who is typing.
  const signature = filters.map((f) => `${f.key}=${f.value}`).join("&");
  useEffect(() => {
    setValues(initial());
    lastPushed.current = q;
    if (document.activeElement !== searchRef.current) setText(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, q]);

  const go = (next: Record<string, string>, search: string, replace = false) => {
    const p = new URLSearchParams();
    for (const f of filters) if (next[f.key]) p.set(f.key, next[f.key]);
    if (search.trim()) p.set("q", search.trim());
    const qs = p.toString();
    const href = qs ? `/directory?${qs}` : "/directory";
    lastPushed.current = search.trim();
    startTransition(() => (replace ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false })));
  };

  // Search as you type, after a short pause.
  useEffect(() => {
    if (text.trim() === lastPushed.current) return;
    const t = setTimeout(() => go(values, text, true), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    go(values, text);
  };

  return (
    <form action="/directory" method="get" onSubmit={onSubmit} role="search" aria-label="Filter employees" aria-busy={pending}>
      <div className={s.dropdowns}>
        {filters.map((f) => {
          const id = `dir-filter-${f.key}`;
          const set = !!values[f.key];
          return (
            <div key={f.key} className={`${s.dropdown}${set ? ` ${s.dropdownSet}` : ""}`}>
              <label htmlFor={id} className={set ? s.dropdownCaption : "sr-only"}>{f.label}</label>
              <select
                id={id}
                name={f.key}
                value={values[f.key]}
                onChange={(e) => {
                  const next = { ...values, [f.key]: e.target.value };
                  setValues(next);
                  go(next, text);
                }}
              >
                <option value="">{set ? `All` : f.label}</option>
                {f.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <IconChevronDown className={s.dropdownChevron} aria-hidden="true" />
            </div>
          );
        })}
        <div className={s.dropdownFiller} aria-hidden="true" />
      </div>

      <div className={s.searchRow}>
        <IconSearch className={s.searchIcon} aria-hidden="true" />
        <label htmlFor="dir-search" className="sr-only">Search employees by name, email, title or number</label>
        <input
          ref={searchRef}
          id="dir-search"
          name="q"
          type="search"
          className={s.searchInput}
          placeholder="Search"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {pending ? <span className={s.searching} aria-hidden="true">Searching…</span> : null}
        <noscript><button type="submit" className="btn sm">Apply</button></noscript>
        {filtered ? (
          <Link href="/directory" className={s.clear} title="Clear all filters" aria-label="Clear all filters" scroll={false}>
            <ClearFilterIcon />
          </Link>
        ) : (
          <span className={`${s.clear} ${s.clearIdle}`} title="No filters applied" aria-hidden="true">
            <ClearFilterIcon />
          </span>
        )}
      </div>
    </form>
  );
}

/** A funnel with a small cross: "clear filters". */
function ClearFilterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h15l-5.8 7.2V18l-3.4 2v-8.8z" />
      <circle cx="18" cy="17" r="4" />
      <path d="m16.4 15.4 3.2 3.2M19.6 15.4l-3.2 3.2" />
    </svg>
  );
}
