"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import d from "../dash.module.css";

export interface PickPerson { id: string; name: string; title: string | null; number: string; photoUrl: string | null }

/**
 * "Search Employee": type a name and pick from the directory. Each row shows
 * the person's title and employee number, as Keka's does. In multi mode the
 * chosen people become chips (and hidden inputs named `name`); in single
 * mode `onPick` receives the person and the box clears.
 */
export function EmployeePicker({ people, name, multiple, max = 10, onPick, placeholder = "Search Employee", autoFocus, initial = [] }: {
  people: PickPerson[]; name?: string; multiple?: boolean; max?: number; onPick?: (p: PickPerson) => void;
  placeholder?: string; autoFocus?: boolean; initial?: string[];
}) {
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<PickPerson[]>(() => people.filter((p) => initial.includes(p.id)));
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return people
      .filter((p) => !chosen.some((c) => c.id === p.id))
      .filter((p) => p.name.toLowerCase().includes(t) || p.number.toLowerCase().includes(t))
      .slice(0, 8);
  }, [q, people, chosen]);

  const pick = (p: PickPerson) => {
    if (multiple) {
      if (chosen.length >= max) return;
      setChosen((c) => [...c, p]);
    }
    onPick?.(p);
    setQ(""); setActive(0); setOpen(false);
    input.current?.focus();
  };

  return (
    <div className={d.picker}>
      <div className={d.chips}>
        {chosen.map((c) => (
          <span key={c.id} className={d.chip}>
            <Avatar name={c.name} photoUrl={c.photoUrl} size={22} />
            {c.name}
            <button type="button" aria-label={`Remove ${c.name}`} onClick={() => setChosen((x) => x.filter((y) => y.id !== c.id))}>×</button>
            {name ? <input type="hidden" name={name} value={c.id} /> : null}
          </span>
        ))}
        <input
          ref={input}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${id}-${matches[active].id}` : undefined}
          aria-label={placeholder}
          placeholder={chosen.length && multiple ? "" : placeholder}
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === "Enter" && matches[active]) { e.preventDefault(); pick(matches[active]); }
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Backspace" && !q && multiple && chosen.length) setChosen((c) => c.slice(0, -1));
          }}
        />
      </div>
      {open && matches.length > 0 ? (
        <ul id={`${id}-list`} role="listbox" className={d.options}>
          {matches.map((p, i) => (
            <li
              key={p.id}
              id={`${id}-${p.id}`}
              role="option"
              aria-selected={i === active}
              className={d.option}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar name={p.name} photoUrl={p.photoUrl} size={36} />
              <span>
                <span className={d.optName} style={{ display: "block" }}>{p.name}</span>
                <span className={d.optMeta} style={{ display: "block" }}>{p.title ?? "—"}</span>
                <span className={d.optMeta} style={{ display: "block" }}>Employee Number: {p.number}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
