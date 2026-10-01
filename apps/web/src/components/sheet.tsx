"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "./sheet.module.css";

/**
 * A modal built on <dialog>: the browser traps focus, Escape closes it and
 * the page behind is inert. `side` turns it into a right-hand drawer, the way
 * Keka opens its claim and request forms. Content mounts only while open, so
 * each opening starts with a fresh form.
 */
export function Sheet({ open, onClose, title, subtitle, side, children }: {
  open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; side?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`${s.dialog}${side ? ` ${s.side}` : ""}`}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      // A click that lands on the dialog element itself is on the backdrop.
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.frame}>
        <div className={s.head}>
          <div style={{ minWidth: 0 }}>
            <h2 id={`${id}-title`} className={s.title}>{title}</h2>
            {subtitle ? <p className={s.sub}>{subtitle}</p> : null}
          </div>
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className={s.body}>{open ? children : null}</div>
      </div>
    </dialog>
  );
}

/**
 * A button that opens a form in a sheet. `openParam` names a query parameter
 * (`?new=1`) that opens it on arrival; closing drops the parameter so a
 * refresh does not reopen it.
 */
export function SheetButton({ label, title, subtitle, side = true, openParam, className = "btn primary", children }: {
  label: ReactNode; title: string; subtitle?: ReactNode; side?: boolean; openParam?: string; className?: string; children: ReactNode;
}) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(() => !!openParam && search.get(openParam) === "1");
  const close = () => {
    setOpen(false);
    if (openParam && search.get(openParam)) {
      const next = new URLSearchParams(search.toString());
      next.delete(openParam);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">{label}</button>
      <Sheet open={open} onClose={close} title={title} subtitle={subtitle} side={side}>{children}</Sheet>
    </>
  );
}
