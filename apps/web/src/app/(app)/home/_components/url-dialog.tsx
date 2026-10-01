"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import d from "../dash.module.css";

/**
 * A modal or right-hand drawer whose open state lives in the URL
 * (`?holidays=2026`, `?wish=…`, `?edit=widgets&add=1`). The page renders it
 * only while its parameter is present; closing navigates to `closeHref`.
 * Built on <dialog>, which supplies the focus trap, Escape and inertness.
 */
export function UrlDialog({ title, closeHref, children, side, width = 640, headExtra }: {
  title: ReactNode; closeHref: string; children: ReactNode; side?: boolean; width?: number; headExtra?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) { try { el.showModal(); } catch { el.setAttribute("open", ""); } }
  }, []);
  const close = useCallback(() => {
    ref.current?.close();
    router.replace(closeHref, { scroll: false });
  }, [closeHref, router]);
  return (
    <dialog
      ref={ref}
      className={`${d.dlg}${side ? ` ${d.dlgSide}` : ""}`}
      style={{ width: `min(${width}px, ${side ? "100vw" : "calc(100vw - 32px)"})` }}
      aria-labelledby={id}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === ref.current) close(); }}
    >
      <div className={d.dlgFrame}>
        <div className={d.dlgHead}>
          <h2 id={id} className={d.dlgTitle}>{title}{headExtra}</h2>
          <button type="button" className={d.dlgClose} onClick={close} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className={d.dlgBody}>{children}</div>
      </div>
    </dialog>
  );
}
