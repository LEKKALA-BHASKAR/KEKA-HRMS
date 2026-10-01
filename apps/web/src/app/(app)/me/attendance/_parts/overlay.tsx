"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import s from "./parts.module.css";

/**
 * A modal whose open state lives in the URL (`?apply=1`, `?request=WFH`), so
 * every modal on these pages can be linked to directly. The page renders it
 * only while its parameter is present; closing navigates to `closeHref`.
 * Built on <dialog>, which supplies the focus trap, Escape and inertness.
 */
export function UrlModal({
  title, subtitle, closeHref, children, width = 560,
}: {
  title: ReactNode; subtitle?: ReactNode; closeHref: string; children: ReactNode; width?: number;
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
      className={s.modal}
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === ref.current) close(); }}
    >
      <div className={s.modalInner}>
        <div className={s.modalHead}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className={s.modalTitle}>{title}</h2>
            {subtitle ? <div className={s.modalSub}>{subtitle}</div> : null}
          </div>
          <button type="button" className={s.modalClose} onClick={close} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className={s.modalBody}>{children}</div>
      </div>
    </dialog>
  );
}

/**
 * A small floating menu behind a trigger button — the "…" on table rows, the
 * check mark that reveals a day's punches. Positioned with `fixed` so table
 * scroll containers never clip it; closes on outside click, scroll or Escape.
 */
export function Popover({
  label, trigger, children, triggerClassName, width = 230,
}: {
  label: string; trigger: ReactNode; children: ReactNode; triggerClassName?: string; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    const below = r.bottom + 6;
    const h = panel.current?.offsetHeight ?? 0;
    const top = h && below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left });
  }, [width]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
    };
    const onScroll = (e: Event) => {
      if (panel.current && e.target instanceof Node && panel.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn} type="button" className={triggerClassName ?? s.iconBtn}
        aria-label={label} title={label} aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={panel} id={id} className={s.popover} role="dialog" aria-label={label}
          style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}

/** The horizontal "…" used on Keka rows. */
export function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" />
    </svg>
  );
}

/** An (i) that explains a figure on hover and focus. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className={s.infoTip} tabIndex={0} role="note" aria-label={text} data-tip={text}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6h.01" strokeLinecap="round" />
      </svg>
    </span>
  );
}
