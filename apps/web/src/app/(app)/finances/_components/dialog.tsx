"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import s from "../finances.module.css";

type Size = "drawer" | "wide" | "full";

/**
 * My Finances' modal, on <dialog> like the shared Sheet (focus trap, Escape,
 * inert page behind) but in the three sizes Keka uses here: a right-hand
 * drawer for forms, a wide drawer for the salary breakup and a full-screen
 * page for the loan policy. Content mounts only while open.
 */
export function FinDialog({ open, onClose, title, size = "drawer", footer, children }: {
  open: boolean; onClose: () => void; title: string; size?: Size; footer?: ReactNode; children: ReactNode;
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
      className={`${s.dlg} ${s[`dlg_${size}`]}`}
      aria-labelledby={`${id}-t`}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.dlgFrame}>
        <div className={s.dlgHead}>
          <h2 id={`${id}-t`} className={s.dlgTitle}>{title}</h2>
          <button type="button" className={s.dlgClose} aria-label="Close" onClick={onClose}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M5.5 5.5l13 13M18.5 5.5l-13 13" /></svg>
          </button>
        </div>
        <div className={s.dlgBody}>{open ? children : null}</div>
        {open && footer ? <div className={s.dlgFoot}>{footer}</div> : null}
      </div>
    </dialog>
  );
}

/**
 * A trigger plus its dialog. `openParam` opens it on arrival (`?apply=1`) and
 * is dropped again on close, so a refresh does not reopen it.
 */
export function DialogButton({ label, title, size, className = "btn primary", openParam, ariaLabel, tooltip, disabled, children }: {
  label: ReactNode; title: string; size?: Size; className?: string; openParam?: string; ariaLabel?: string; tooltip?: string;
  disabled?: boolean; children: (close: () => void) => ReactNode;
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
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={ariaLabel} title={tooltip} disabled={disabled}>{label}</button>
      <FinDialog open={open} onClose={close} title={title} size={size}>{children(close)}</FinDialog>
    </>
  );
}
