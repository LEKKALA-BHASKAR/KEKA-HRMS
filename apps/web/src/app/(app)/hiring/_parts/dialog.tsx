"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import sheet from "@/components/sheet.module.css";

/**
 * A <dialog>-based modal or right-hand drawer sized for Hire's screens:
 * Keka's question generator is a wide modal, its feedback forms are drawers.
 * Content mounts only while open, so each opening starts fresh.
 */
export function HireDialog({ open, onClose, title, headExtra, width = 720, side = false, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; headExtra?: ReactNode; width?: number; side?: boolean; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { try { d.showModal(); } catch { d.setAttribute("open", ""); } }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`${sheet.dialog}${side ? ` ${sheet.side}` : ""}`}
      style={{ width: side ? `min(${width}px, 100vw)` : `min(${width}px, calc(100vw - 32px))` }}
      aria-labelledby={`${id}-t`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={sheet.frame}>
        <div className={sheet.head}>
          <h2 id={`${id}-t`} className={sheet.title} style={{ fontWeight: 450 }}>{title}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {headExtra}
            <button type="button" className={sheet.close} aria-label="Close" onClick={onClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </div>
        <div className={sheet.body}>{open ? children : null}</div>
        {open && footer ? <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, padding: "14px 22px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>{footer}</div> : null}
      </div>
    </dialog>
  );
}
