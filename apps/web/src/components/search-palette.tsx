"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "./avatar";
import { IconSearch } from "./icons";

export interface QuickAction { label: string; href: string; keywords: string }
interface PersonHit { id: string; name: string; title: string | null; department: string | null; photoUrl: string | null }

/**
 * The search box in the top bar: colleagues by name, number or title, and
 * the actions this viewer can take. ⌘K (Ctrl+K) opens it from anywhere.
 */
export function SearchPalette({ actions }: { actions: QuickAction[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(true); }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (open) { setTimeout(() => input.current?.focus(), 0); } else { setQ(""); setPeople([]); setCursor(0); } }, [open]);

  // Colleagues, debounced; a stale response never overwrites a newer one.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setPeople([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { people: [] }))
        .then((d: { people: PersonHit[] }) => setPeople(d.people))
        .catch(() => {});
    }, 140);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const matched = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (term ? actions.filter((a) => `${a.label} ${a.keywords}`.toLowerCase().includes(term)) : actions).slice(0, term ? 6 : 8);
  }, [q, actions]);
  const results = useMemo(() => [
    ...people.map((p) => ({ kind: "person" as const, key: p.id, href: `/directory/${p.id}`, person: p })),
    ...matched.map((a) => ({ kind: "action" as const, key: a.href, href: a.href, action: a })),
  ], [people, matched]);
  useEffect(() => { setCursor(0); }, [results.length]);

  const go = useCallback((href: string) => { setOpen(false); router.push(href); }, [router]);

  return (
    <>
      <button type="button" className="k-search" onClick={() => setOpen(true)} aria-label="Search employees or actions">
        <IconSearch width={18} height={18} />
        <span className="k-search-text">Search employees or actions (Ex: Apply Leave)</span>
        <kbd className="k-kbd">⌘ + K</kbd>
      </button>
      {open ? (
        <div className="k-palette-scrim" onMouseDown={() => setOpen(false)}>
          <div className="k-palette" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
            <div className="k-palette-input">
              <IconSearch width={18} height={18} />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employees or actions (Ex: Apply Leave)" aria-label="Search"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
                  if (e.key === "Enter" && results[cursor]) { e.preventDefault(); go(results[cursor].href); }
                }} />
              <kbd className="k-kbd light">Esc</kbd>
            </div>
            <div className="k-palette-results" role="listbox">
              {people.length ? <div className="k-palette-group">Employees</div> : null}
              {results.map((r, i) => (
                <div key={`${r.kind}:${r.key}`}>
                  {r.kind === "action" && i === people.length ? <div className="k-palette-group">{q.trim() ? "Actions" : "Quick actions"}</div> : null}
                  <button type="button" role="option" aria-selected={i === cursor} className={`k-palette-item${i === cursor ? " active" : ""}`}
                    onMouseEnter={() => setCursor(i)} onClick={() => go(r.href)}>
                    {r.kind === "person" ? (
                      <>
                        <Avatar name={r.person.name} photoUrl={r.person.photoUrl} size={30} />
                        <span style={{ minWidth: 0 }}>
                          <span className="strong" style={{ display: "block" }}>{r.person.name}</span>
                          <span className="text-xs muted">{[r.person.title, r.person.department].filter(Boolean).join(" · ")}</span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="k-palette-action-icon">→</span>
                        <span>{r.action.label}</span>
                      </>
                    )}
                  </button>
                </div>
              ))}
              {results.length === 0 ? <div className="empty" style={{ padding: 28 }}><div className="empty-title">No matches</div>Try a name, an employee number or an action like “payslip”.</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
