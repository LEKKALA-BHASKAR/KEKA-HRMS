"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Sheet } from "@/components/sheet";
import type { ActionState } from "@/lib/forms";
import s from "./assets.module.css";

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Client pieces of the asset screens: the third-row tabs, auto-submitting
 * filter bars, kebab menus whose items open modal forms, URL-driven drawers
 * and full-screen overlays. Forms submit without React's automatic reset,
 * so a refused submit keeps what the user typed.
 */

// ---------------------------------------------------------------------------
//  Submitting an ActionState action without resetting the form
// ---------------------------------------------------------------------------

export function useAct(action: Act, onOk?: (st: ActionState) => void) {
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const router = useRouter();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const r = await action({}, fd);
      setState(r);
      if (r.ok) { onOk?.(r); router.refresh(); }
    });
  };
  return { state, submit, pending, setState };
}

export function Banner({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 14 }} role={state.ok ? "status" : "alert"}>{state.message}</div>;
}

// ---------------------------------------------------------------------------
//  Tabs
// ---------------------------------------------------------------------------

export function AssetTabs({ items }: { items: Array<{ label: string; href: string; count?: number }> }) {
  const pathname = usePathname();
  const specific = items.filter((i) => i.href !== "/assets").sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  // The asset detail and the import wizard belong to the Asset List.
  const active = specific?.href ?? (pathname === "/assets" ? "/assets" : "/assets/list");
  return (
    <div className="k-subtabs" role="tablist">
      {items.map((it) => (
        <Link key={it.href} href={it.href} role="tab" aria-selected={it.href === active} className={`k-subtab${it.href === active ? " active" : ""}`}>
          {it.label}{it.count ? <span className="k-tab-count">{it.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Filter bar: selects and dates submit on change, search on Enter
// ---------------------------------------------------------------------------

export function FilterForm({ children, solo, action }: { children: ReactNode; solo?: boolean; action?: string }) {
  return (
    <form method="get" action={action} className={`${s.filters}${solo ? ` ${s.solo}` : ""}`}
      onChange={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "SELECT" || (t as HTMLInputElement).type === "date") (e.currentTarget as HTMLFormElement).requestSubmit();
      }}>
      {children}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Kebab menu with links, one-click actions and modal forms
// ---------------------------------------------------------------------------

export type MenuItem =
  | { kind: "link"; label: string; href: string; icon?: IconKey }
  | { kind: "act"; label: string; icon?: IconKey; action: Act; hidden: Record<string, string>; confirm?: string }
  | { kind: "modal"; label: string; icon?: IconKey; title: string; action: Act; hidden: Record<string, string>; submitLabel: string; body: ReactNode; danger?: boolean }
  | { kind: "divider" };

type IconKey = "history" | "recover" | "unavailable" | "condition" | "edit" | "assign" | "view" | "bell" | "trash" | "available" | "cancel";

const MENU_ICON: Record<IconKey, ReactNode> = {
  history: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></svg>,
  recover: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>,
  unavailable: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>,
  available: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>,
  condition: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="3" y="5" width="14" height="10" rx="1.5" /><path d="M7 19h6" /><circle cx="18.5" cy="15.5" r="2.5" /></svg>,
  edit: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>,
  assign: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="9" cy="8" r="3.5" /><path d="M3 20c.8-3.4 3.2-5 6-5s5.2 1.6 6 5" /><path d="M18 8v6M15 11h6" /></svg>,
  view: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  bell: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>,
  trash: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>,
  cancel: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>,
};

export function Kebab({ items, label = "Actions", horizontal }: { items: MenuItem[]; label?: string; horizontal?: boolean }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [modal, setModal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const toggle = () => {
    if (!open && ref.current) setUp(ref.current.getBoundingClientRect().bottom > window.innerHeight - 280);
    setOpen((v) => !v);
  };
  const run = (it: Extract<MenuItem, { kind: "act" }>) => {
    if (it.confirm && !window.confirm(it.confirm)) return;
    setOpen(false);
    start(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(it.hidden)) fd.set(k, v);
      const r = await it.action({}, fd);
      if (!r.ok) setError(r.message ?? "That did not work."); else { setError(null); router.refresh(); }
    });
  };
  const current = modal === null ? null : items[modal];
  return (
    <div className={s.menuWrap} ref={ref}>
      <button type="button" className={s.kebab} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle} disabled={pending}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={horizontal ? { transform: "rotate(90deg)" } : undefined}><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>
      </button>
      {open ? (
        <div className={`${s.menu}${up ? ` ${s.up}` : ""}`} role="menu">
          {items.map((it, i) => {
            if (it.kind === "divider") return <hr key={i} />;
            const icon = it.icon ? MENU_ICON[it.icon] : null;
            if (it.kind === "link") return <Link key={i} role="menuitem" href={it.href} scroll={false} onClick={() => setOpen(false)}>{icon}{it.label}</Link>;
            if (it.kind === "act") return <button key={i} role="menuitem" type="button" onClick={() => run(it)}>{icon}{it.label}</button>;
            return <button key={i} role="menuitem" type="button" onClick={() => { setOpen(false); setModal(i); }}>{icon}{it.label}</button>;
          })}
        </div>
      ) : null}
      {error ? <div className="text-xs" role="alert" style={{ color: "var(--danger)", position: "absolute", right: 0, top: "100%", width: 240, textAlign: "right", zIndex: 30 }}>{error}</div> : null}
      {current && current.kind === "modal" ? (
        <ModalForm title={current.title} action={current.action} hidden={current.hidden} submitLabel={current.submitLabel} danger={current.danger} onClose={() => setModal(null)}>
          {current.body}
        </ModalForm>
      ) : null}
    </div>
  );
}

/** A centred modal holding one form; closes and refreshes when it succeeds. */
export function ModalForm({ title, action, hidden, submitLabel, children, onClose, danger, side, onOk }: {
  title: string; action: Act; hidden?: Record<string, string>; submitLabel: string; children: ReactNode; onClose: () => void; danger?: boolean; side?: boolean; onOk?: (st: ActionState) => void;
}) {
  const { state, submit, pending } = useAct(action, (st) => { onOk?.(st); onClose(); });
  return (
    <Sheet open onClose={onClose} title={title} side={side}>
      <form onSubmit={submit}>
        {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Banner state={state.ok ? {} : state} />
        <div className="stack gap-3">{children}</div>
        <div className="row gap-2" style={{ justifyContent: "flex-end", marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Sheet>
  );
}

/** A button that opens a ModalForm. */
export function ModalButton({ label, className = "btn primary", ...rest }: {
  label: ReactNode; className?: string; title: string; action: Act; hidden?: Record<string, string>; submitLabel: string; children: ReactNode; danger?: boolean; side?: boolean; navigateTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { navigateTo, ...modal } = rest;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog"
        title={typeof label === "string" ? undefined : modal.title} aria-label={typeof label === "string" ? undefined : modal.title}>{label}</button>
      {open ? <ModalForm {...modal} onClose={() => setOpen(false)} onOk={(st) => { if (navigateTo) router.push(navigateTo.replace("{id}", st.values?.id ?? "")); }} /> : null}
    </>
  );
}

/** A small form that runs one action from a button (approve, mark available…). */
export function ActButton({ action, hidden, children, className = "btn sm", title, confirm, next }: {
  action: Act; hidden: Record<string, string>; children: ReactNode; className?: string; title?: string; confirm?: string; next?: string;
}) {
  const router = useRouter();
  const { state, submit, pending } = useAct(action, () => { if (next) router.push(next, { scroll: false }); });
  return (
    <form onSubmit={(e) => { if (confirm && !window.confirm(confirm)) { e.preventDefault(); return; } submit(e); }} style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={className} title={title} aria-label={title} disabled={pending}>{children}</button>
      {state.message && !state.ok ? <span className="text-xs" role="alert" style={{ color: "var(--danger)", marginTop: 4, maxWidth: 220 }}>{state.message}</span> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  URL-driven drawers and full-screen overlays
// ---------------------------------------------------------------------------

export function UrlSheet({ title, subtitle, closeHref, side = true, children }: { title: string; subtitle?: ReactNode; closeHref: string; side?: boolean; children: ReactNode }) {
  const router = useRouter();
  return <Sheet open title={title} subtitle={subtitle} side={side} onClose={() => router.push(closeHref, { scroll: false })}>{children}</Sheet>;
}

export function FullScreen({ title, closeHref, center, right, children }: { title: string; closeHref: string; center?: ReactNode; right?: ReactNode; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") router.push(closeHref, { scroll: false }); };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [closeHref, router]);
  return (
    <div className={s.full} role="dialog" aria-modal="true" aria-label={title}>
      <div className={s.fullHead}>
        <div className={s.fullTitle}>{title}</div>
        {center}
        <div className="row gap-2" style={{ alignItems: "center" }}>
          {right}
          <Link href={closeHref} scroll={false} className={s.iconBtn} aria-label="Close" style={{ width: 36, height: 36 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </Link>
        </div>
      </div>
      <div className={s.fullBody}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Pending acknowledgements: select rows, then Remind
// ---------------------------------------------------------------------------

export function RemindForm({ action, toolbarRight, children }: { action: Act; toolbarRight: ReactNode; children: ReactNode }) {
  const [count, setCount] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const { state, submit, pending } = useAct(action, () => { setCount(0); formRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => { c.checked = false; }); });
  const recount = () => setCount(formRef.current?.querySelectorAll('input[name="ids"]:checked').length ?? 0);
  return (
    <form ref={formRef} onSubmit={submit} onChange={(e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.all !== undefined) formRef.current?.querySelectorAll<HTMLInputElement>('input[name="ids"]').forEach((c) => { c.checked = t.checked; });
      recount();
    }}>
      <div className={s.toolbar} style={{ justifyContent: "flex-start" }}>
        <span className={s.iconBtn} aria-hidden="true" style={{ cursor: "default" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 4v13M7 12l5 5 5-5" /><path d="M5 20h6" /></svg>
        </span>
        <button type="submit" className="btn primary" disabled={count === 0 || pending} style={{ opacity: count === 0 ? 0.55 : 1 }}>{pending ? "Sending…" : count ? `Remind (${count})` : "Remind"}</button>
        {state.message ? <span className="text-sm" role={state.ok ? "status" : "alert"} style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</span> : null}
        <span className={s.spacer} style={{ flex: 1 }} />
        {toolbarRight}
      </div>
      {children}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  A file input that submits an ActionState action and navigates on success
// ---------------------------------------------------------------------------

export function UploadForm({ action, hidden, next, accept, label, children }: { action: Act; hidden: Record<string, string>; next: string; accept: string; label: string; children?: ReactNode }) {
  const router = useRouter();
  const { state, submit, pending } = useAct(action, (st) => router.push(next.replace("{id}", st.values?.id ?? "")));
  return (
    <form onSubmit={submit} className="stack gap-2">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Banner state={state.ok ? {} : state} />
      <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
        <input type="file" name="file" accept={accept} required className="input" style={{ maxWidth: 320 }} aria-label="File" />
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Uploading…" : label}</button>
        {children}
      </div>
    </form>
  );
}

/** A plain ActionState form whose body is server-rendered; navigates on success. */
export function StepForm({ action, hidden, next, submitLabel, children, secondary }: { action: Act; hidden: Record<string, string>; next?: string; submitLabel: string; children: ReactNode; secondary?: ReactNode }) {
  const router = useRouter();
  const { state, submit, pending } = useAct(action, (st) => { if (next) router.push(next.replace("{id}", st.values?.id ?? "")); });
  return (
    <form onSubmit={submit}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Banner state={state} />
      {children}
      <div className="row gap-2" style={{ marginTop: 18 }}>
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Working…" : submitLabel}</button>
        {secondary}
      </div>
    </form>
  );
}
