"use client";

import { useActionState, useEffect, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/forms";
import { addWidgetAction, saveWidgetSettingsAction, resetWidgetsAction } from "@/app/actions/home-widgets";
import { WIDGETS, WIDGET_COLORS, QUICK_LINKS_MAX, type WidgetColor, type WidgetType, type QuickLink } from "../_lib/widgets";
import d from "../dash.module.css";

const EMPTY: ActionState = {};

/** A static sample of each widget, for the Add Widget drawer. */
function Sample({ type }: { type: WidgetType }) {
  switch (type) {
    case "INBOX": return <div className={d.inboxRow}><span className={d.inboxNum} style={{ color: "#d6336c" }}>12</span><span className={d.inboxText}>Tasks waiting for your approval. Please click on take action for more details</span><span className={d.solid} style={{ background: "#d6336c" }}>Take Action</span></div>;
    case "PROJECT_TIME_TODAY": return <><div className={d.ptHead}><span>Client - Project - Task</span></div><div className={d.ptLine}><span>Northwind - POS Modernisation</span><span>02 Hrs 00 min</span></div><div className={d.ptFoot}><span className={d.ptTotal}>TOTAL HOURS<strong>2</strong></span><span className={d.pink}>Add Time Entry</span></div></>;
    case "QUICK_LINKS": return <div className={d.links}><a>Learning Management System</a><a>Corporate Intranet</a><a>EPF Portal</a></div>;
    case "FEEDBACK_RECEIVED": return <><div className={d.inboxRow}><span className={d.inboxNum} style={{ color: "var(--brand-500)" }}>19</span><span className={d.inboxText}>Feedbacks you have received from others.</span></div><div style={{ textAlign: "right", marginTop: 12 }}><span className={d.outline}>Request Feedback</span></div></>;
    case "ON_LEAVE_TODAY": return <div className={d.wEmptyText}><strong>Everyone is working today!</strong><span>No one is on leave today.</span></div>;
    case "WORKING_REMOTELY": return <div className={d.wEmptyText}><strong>Everyone is at office!</strong><span>No one is working remotely today.</span></div>;
    case "TIME_TODAY": return <><div className={d.timeLabel}>Current Time</div><div className={d.clock}>09:30<small>:00 AM</small></div></>;
    case "LEAVE_BALANCES": return <p className={d.wMuted} style={{ margin: 0 }}>Rings for each leave type, with Request Leave and View All Balances.</p>;
    case "HOLIDAYS": return <><div className={d.hName}>Diwali</div><div className={d.hDate}>Sun, 08 November, 2026</div></>;
    default: return <p className={d.wMuted} style={{ margin: 0 }}>Shows the items that need action.</p>;
  }
}

function Card({ type, color, children }: { type: WidgetType; color: WidgetColor; children: ReactNode }) {
  const c = WIDGET_COLORS[color];
  return (
    <div className={d.widget} data-color={color} style={{ "--w-bg": c.bg, "--w-ink": c.ink } as CSSProperties}>
      <div className={d.wHead}><h3 className={d.wTitle}>{WIDGETS.find((w) => w.type === type)!.title}</h3></div>
      {children}
    </div>
  );
}

/** "Add Widget": search, preview and add the widgets not on Quick Access yet. */
export function AddWidgetList({ present }: { present: WidgetType[] }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const available = WIDGETS.filter((w) => !present.includes(w.type)).filter((w) => w.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <input className={d.search} type="search" placeholder="Search" aria-label="Search widgets" value={q} onChange={(e) => setQ(e.target.value)} />
      {msg ? (
        <div className={d.toast} role="status" style={{ position: "absolute", top: 70, right: 18 }}>
          <span className={d.toastBar} aria-hidden="true">✓</span>
          <span className={d.toastBody}><strong>success!</strong>{msg}</span>
        </div>
      ) : null}
      {available.length === 0 ? <p className="muted">{q ? "No widget matches that search." : "Every widget is already on Quick Access."}</p> : available.map((w) => (
        <div key={w.type} className={d.addRow}>
          <div className={d.preview}>
            <Card type={w.type} color={w.color}><Sample type={w.type} /></Card>
            <div className={d.addOverlay}>
              <button
                type="button" className="btn primary" disabled={pending} aria-label={`Add ${w.title}`}
                onClick={() => start(async () => {
                  const f = new FormData(); f.set("type", w.type);
                  const r = await addWidgetAction(EMPTY, f);
                  setMsg(r.message ?? null);
                  router.refresh();
                })}
              >Add</button>
            </div>
          </div>
          <div className={d.addMeta}><h4>{w.title}</h4><p>{w.description}</p></div>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <button type="button" className="btn ghost sm" disabled={pending}
          onClick={() => { if (confirm("Reset Quick Access to the standard widgets for everyone?")) start(async () => { const r = await resetWidgetsAction(EMPTY); setMsg(r.message ?? null); router.refresh(); }); }}>
          Reset to the standard layout
        </button>
      </div>
    </>
  );
}

/** Widget settings: its colour, and for Quick Links the links themselves. */
export function WidgetSettingsForm({ type, color, links, closeHref }: { type: WidgetType; color: WidgetColor; links: QuickLink[]; closeHref: string }) {
  const [state, action, pending] = useActionState(saveWidgetSettingsAction, EMPTY);
  const [rows, setRows] = useState<QuickLink[]>(links.length ? links : [{ label: "", url: "" }]);
  const router = useRouter();
  useEffect(() => { if (state.ok) router.replace(closeHref, { scroll: false }); }, [state, closeHref, router]);
  return (
    <form action={action} className="stack gap-4">
      <input type="hidden" name="type" value={type} />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Colour</legend>
        <div className={d.swatches}>
          {(Object.keys(WIDGET_COLORS) as WidgetColor[]).map((c) => (
            <label key={c} className={d.swatch}>
              <input type="radio" name="color" value={c} defaultChecked={c === color} />
              <span style={{ background: WIDGET_COLORS[c].bg }} />
              <span>{WIDGET_COLORS[c].label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {type === "QUICK_LINKS" ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack gap-2">
          <legend className="label">Links</legend>
          <div className={d.linkGrid}><span className="text-xs muted">Name</span><span className="text-xs muted">Address (https://… or a page here, like /documents)</span></div>
          {rows.map((r, i) => (
            <div key={i} className={d.linkGrid}>
              <input className="input" name="linkLabel" aria-label={`Link ${i + 1} name`} defaultValue={r.label} maxLength={60} />
              <input className="input" name="linkUrl" aria-label={`Link ${i + 1} address`} defaultValue={r.url} maxLength={500} />
            </div>
          ))}
          {rows.length < QUICK_LINKS_MAX ? <button type="button" className={d.addOpt} onClick={() => setRows((x) => [...x, { label: "", url: "" }])}>+ Add link</button> : null}
          <span className="text-xs subtle">Leave both boxes empty to drop a link.</span>
        </fieldset>
      ) : null}
      {state.ok === false && state.message ? <div className={d.err} role="alert">{state.message}</div> : null}
      <div className="row gap-2">
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
