"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { moveWidgetAction, removeWidgetAction } from "@/app/actions/home-widgets";
import { WIDGET_COLORS, type WidgetColor, type WidgetType } from "../_lib/widgets";
import { IconGear, IconClose } from "./icons";
import d from "../dash.module.css";

export interface QuickItem { type: WidgetType; title: string; color: WidgetColor; node: ReactNode; placeholder: boolean }

const fd = (v: Record<string, string>) => { const f = new FormData(); for (const [k, x] of Object.entries(v)) f.set(k, x); return f; };

/**
 * The Quick Access column. Viewers see the widgets; administrators get the
 * ⚙ that turns on edit mode, where each widget gains a settings button, a
 * drag grip, a remove ✕ and keyboard Move up / Move down — and the layout
 * they arrange is the one every employee sees.
 */
export function QuickAccess({ items, canEdit, editing }: { items: QuickItem[]; canEdit: boolean; editing: boolean }) {
  const router = useRouter();
  const [order, setOrder] = useState(items);
  const [drag, setDrag] = useState<WidgetType | null>(null);
  const [over, setOver] = useState<WidgetType | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => { setOrder(items); }, [items]);

  const move = (type: WidgetType, to: number) => {
    const from = order.findIndex((i) => i.type === type);
    if (from < 0 || to === from || to < 0 || to >= order.length) return;
    const next = [...order];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setOrder(next);
    start(async () => {
      const r = await moveWidgetAction({}, fd({ type, to: String(to) }));
      if (r.ok === false) { setMsg(r.message ?? "Could not move the widget."); setOrder(items); }
      router.refresh();
    });
  };
  const remove = (type: WidgetType, title: string) => {
    if (!confirm(`Remove ${title} from Quick Access for everyone?`)) return;
    start(async () => {
      const r = await removeWidgetAction({}, fd({ type }));
      setMsg(r.message ?? null);
      router.refresh();
    });
  };

  return (
    <section className={`${d.left}${editing ? ` ${d.editing}` : ""}`} aria-label="Quick Access" aria-busy={pending}>
      {editing ? (
        <>
          <h2 className={d.qaTitle}>Quick Access</h2>
          <div className={d.editRow}>
            <span>Add, remove or edit widgets. Drag to re-arrange</span>
            <Link href="/?edit=widgets&add=1" className="btn primary sm" scroll={false}>Add</Link>
            <Link href="/" className="btn primary sm" style={{ background: "var(--brand-800)" }}>Done</Link>
          </div>
          <div className={d.warn} role="note">Any changes made are applied to all employees in the organization.</div>
        </>
      ) : (
        <div className={d.qaHead}>
          <h2 className={d.qaTitle}>Quick Access</h2>
          {canEdit ? (
            <Link href="/?edit=widgets" className={d.gear} aria-label="Configure Widgets" title="Configure Widgets" scroll={false}><IconGear /></Link>
          ) : null}
        </div>
      )}
      {msg ? <div role="status" className={d.ok}>{msg}</div> : null}

      {order.map((it, i) => {
        const c = WIDGET_COLORS[it.color];
        const style = { "--w-bg": c.bg, "--w-ink": c.ink } as CSSProperties;
        return (
          <div
            key={it.type}
            className={`${d.widget}${it.placeholder ? ` ${d.placeholder}` : ""}${drag === it.type ? ` ${d.dragging}` : ""}${over === it.type && drag && drag !== it.type ? ` ${d.dropBefore}` : ""}`}
            data-color={it.color}
            style={style}
            draggable={editing}
            onDragStart={editing ? (e) => { setDrag(it.type); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.type); } : undefined}
            onDragOver={editing ? (e) => { e.preventDefault(); setOver(it.type); } : undefined}
            onDragLeave={editing ? () => setOver((o) => (o === it.type ? null : o)) : undefined}
            onDrop={editing ? (e) => { e.preventDefault(); const t = drag; setDrag(null); setOver(null); if (t) move(t, i); } : undefined}
            onDragEnd={editing ? () => { setDrag(null); setOver(null); } : undefined}
          >
            {editing ? (
              <>
                <Link href={`/?edit=widgets&widget=${it.type}`} className={`${d.ctl} ${d.ctlSettings}`} aria-label={`${it.title} settings`} title="Widget settings" scroll={false}><IconGear /></Link>
                <span className={d.grip} aria-hidden="true" title="Drag to re-arrange" style={{ color: c.ink }}><i /><i /><i /><i /><i /><i /></span>
                <span className={d.moveBtns}>
                  <button type="button" onClick={() => move(it.type, i - 1)} disabled={i === 0 || pending} aria-label={`Move ${it.title} up`}>↑</button>
                  <button type="button" onClick={() => move(it.type, i + 1)} disabled={i === order.length - 1 || pending} aria-label={`Move ${it.title} down`}>↓</button>
                </span>
                <button type="button" className={`${d.ctl} ${d.ctlRemove}`} onClick={() => remove(it.type, it.title)} disabled={pending} aria-label={`Remove ${it.title}`} title="Remove"><IconClose /></button>
              </>
            ) : null}
            {it.node}
          </div>
        );
      })}
      {order.length === 0 ? <div className={d.warn}>No widgets on Quick Access. {canEdit ? "Use Add to put some back." : null}</div> : null}
    </section>
  );
}
