"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import s from "./hd.module.css";

export interface PickerCategory { id: string; name: string; description: string | null; children: Array<{ id: string; name: string; description: string | null }> }

/**
 * "Need help regarding": a searchable list of categories with their
 * descriptions. A category with subcategories shows › and drills in; a
 * ticket is always raised against a leaf. Posts `categoryId`.
 */
export function CategoryPicker({ categories, value, onChange, invalid, name = "categoryId", placeholder = "Select a category" }: {
  categories: PickerCategory[]; value: string | null; onChange: (id: string) => void; invalid?: boolean; name?: string; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const label = useMemo(() => {
    for (const c of categories) {
      if (c.id === value) return c.name;
      const k = c.children.find((x) => x.id === value);
      if (k) return `${c.name} > ${k.name}`;
    }
    return null;
  }, [categories, value]);

  const needle = q.trim().toLowerCase();
  const current = parent ? categories.find((c) => c.id === parent) : null;
  const rows = needle
    ? categories.flatMap((c) => (c.children.length
      ? c.children.filter((k) => `${c.name} ${k.name} ${k.description ?? ""}`.toLowerCase().includes(needle)).map((k) => ({ id: k.id, name: `${c.name} > ${k.name}`, description: k.description, drill: false }))
      : `${c.name} ${c.description ?? ""}`.toLowerCase().includes(needle) ? [{ id: c.id, name: c.name, description: c.description, drill: false }] : []))
    : current
      ? current.children.map((k) => ({ id: k.id, name: k.name, description: k.description, drill: false }))
      : categories.map((c) => ({ id: c.id, name: c.name, description: c.description, drill: c.children.length > 0 }));

  return (
    <div className={s.catPicker} ref={box}>
      <input type="hidden" name={name} value={value ?? ""} />
      <button type="button" className={`${s.catBtn}${open ? ` ${s.catBtnOpen}` : ""}`} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setParent(null); setQ(""); }} style={invalid ? { borderColor: "var(--danger)" } : undefined}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label ?? placeholder}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? (
        <div className={s.catMenu} role="listbox">
          <div className={s.ddSearch}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input className="input" autoFocus placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search categories" />
          </div>
          {current && !needle ? (
            <button type="button" className={s.catBack} onClick={() => setParent(null)}>‹ {current.name}</button>
          ) : null}
          <div className={s.catList}>
            {rows.length === 0 ? <div className={s.emptySmall}>No categories match.</div> : rows.map((r) => (
              <button key={r.id} type="button" role="option" aria-selected={r.id === value} className={s.catItem}
                onClick={() => { if (r.drill) { setParent(r.id); } else { onChange(r.id); setOpen(false); } }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className={s.catName}>{r.name}</span>
                  {r.description ? <span className={s.catDesc}>{r.description}</span> : null}
                </span>
                {r.drill ? <span aria-hidden="true" style={{ color: "var(--text-subtle)", fontSize: 18 }}>›</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
