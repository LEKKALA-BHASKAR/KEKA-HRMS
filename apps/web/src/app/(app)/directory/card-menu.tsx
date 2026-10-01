"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import s from "./directory.module.css";

/** The "···" menu on a directory card: View profile, Send email. */
export function CardMenu({ id, name, email }: { id: string; name: string; email: string | null }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={wrap} className={s.menuWrap} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className={s.menuBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="4" viewBox="0 0 14 4" aria-hidden="true"><circle cx="2" cy="2" r="1.4" fill="currentColor" /><circle cx="7" cy="2" r="1.4" fill="currentColor" /><circle cx="12" cy="2" r="1.4" fill="currentColor" /></svg>
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={`Actions for ${name}`} className={s.menu}>
          <Link role="menuitem" href={`/directory/${id}`} className={s.menuItem} onClick={() => setOpen(false)}>View profile</Link>
          {email ? (
            <a role="menuitem" href={`mailto:${email}`} className={s.menuItem} onClick={() => setOpen(false)}>Send email</a>
          ) : (
            <span role="menuitem" aria-disabled="true" tabIndex={-1} className={`${s.menuItem} ${s.menuItemDisabled}`}>Send email</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
