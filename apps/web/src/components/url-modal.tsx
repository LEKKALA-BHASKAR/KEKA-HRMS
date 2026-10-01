"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import s from "./url-modal.module.css";

/**
 * A modal whose open state lives in the URL (`?new=1`, `?req=<id>`), so it
 * can be linked to and survives a refresh. The page renders it only while
 * its parameter is present; closing navigates to `closeHref`. Built on
 * <dialog>, which supplies the focus trap, Escape and inertness.
 *
 * `full` makes it a full-screen page-like modal, the way Keka opens
 * "Create Requisition" and "View Requisition".
 */
export function UrlModal({
  title, subtitle, closeHref, children, width = 560, full = false,
}: {
  title: ReactNode; subtitle?: ReactNode; closeHref: string; children: ReactNode; width?: number; full?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      try { d.showModal(); } catch { d.setAttribute("open", ""); }
    }
  }, []);

  const close = useCallback(() => {
    ref.current?.close();
    router.replace(closeHref, { scroll: false });
  }, [closeHref, router]);

  return (
    <dialog
      ref={ref}
      className={`${s.modal}${full ? ` ${s.full}` : ""}`}
      style={full ? undefined : { width: `min(${width}px, calc(100vw - 32px))` }}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (!full && e.target === ref.current) close(); }}
    >
      <div className={s.inner}>
        <div className={s.head}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className={s.title}>{title}</h2>
            {subtitle ? <div className={s.sub}>{subtitle}</div> : null}
          </div>
          <button type="button" className={s.close} onClick={close} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className={s.body}>{children}</div>
      </div>
    </dialog>
  );
}
