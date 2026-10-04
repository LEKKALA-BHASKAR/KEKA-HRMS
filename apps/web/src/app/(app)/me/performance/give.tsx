"use client";

import { useEffect, useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import type { ActionState } from "@/lib/forms";
import { givePraiseAction, giveFeedbackAction } from "@/app/actions/feedback";
import { Sheet } from "@/components/sheet";
import { PRAISE_BADGES, MESSAGE_MAX, TOPIC_MAX } from "./constants";
import s from "./performance.module.css";

export interface Colleague { id: string; name: string; meta: string }

/**
 * "Give praise" and "Give feedback", each opening its form in a dialog.
 * A manager may also write an internal note, but only about someone in
 * their reporting line; the server enforces the same rule.
 */
export function GiveButtons({ colleagues, reportIds, canPraise, allowAnonymous = false }: { colleagues: Colleague[]; reportIds: string[]; canPraise: boolean; allowAnonymous?: boolean }) {
  const [open, setOpen] = useState<"praise" | "feedback" | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const done = (message?: string) => { setOpen(null); setFlash(message ?? null); };
  return (
    <div className={s.give}>
      <div className={s.giveButtons}>
        {canPraise ? <button type="button" className="btn primary" onClick={() => { setFlash(null); setOpen("praise"); }} aria-haspopup="dialog">Give praise</button> : null}
        <button type="button" className="btn" onClick={() => { setFlash(null); setOpen("feedback"); }} aria-haspopup="dialog">Give feedback</button>
      </div>
      <div role="status" aria-live="polite" className={flash ? s.flash : undefined}>{flash}</div>
      <Sheet open={open === "praise"} onClose={() => setOpen(null)} title="Give praise" subtitle="Praise appears on their profile and on the organisation praise wall.">
        <PraiseForm colleagues={colleagues} onDone={done} />
      </Sheet>
      <Sheet open={open === "feedback"} onClose={() => setOpen(null)} title="Give feedback" subtitle="Specific, timely feedback helps most. Say what they did and the effect it had.">
        <FeedbackForm colleagues={colleagues} reportIds={reportIds} onDone={done} allowAnonymous={allowAnonymous} />
      </Sheet>
    </div>
  );
}

function useDone(state: ActionState, onDone: (m?: string) => void) {
  useEffect(() => { if (state.ok) onDone(state.message); }, [state, onDone]);
}

function ErrorText({ state, name }: { state: ActionState; name: string }) {
  const e = state.errors?.[name];
  return e ? <div className={s.error} id={`${name}-error`}>{e}</div> : null;
}

/**
 * A searchable list of colleagues as radio buttons: nothing is chosen until
 * the person picks someone, and the pick survives the filter changing.
 */
function ColleaguePicker({ name, options, state, label }: { name: string; options: Colleague[]; state: ActionState; label: string }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(() => (options.some((o) => o.id === state.values?.[name]) ? state.values![name] : ""));
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.id === picked || `${o.name} ${o.meta}`.toLowerCase().includes(needle)) : options;
  const error = !!state.errors?.[name];
  return (
    <fieldset className={s.picker} aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="label">{label}<span style={{ color: "var(--danger)" }}> *</span></legend>
      <input className="input" type="search" placeholder="Search by name, title or department" aria-label={`Search: ${label}`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={s.pickList} style={error ? { borderColor: "var(--danger)" } : undefined}>
        {shown.map((o) => (
          <label key={o.id} className={s.pickItem}>
            <input type="radio" name={name} value={o.id} required checked={picked === o.id} onChange={() => setPicked(o.id)} />
            <span className={s.pickText}><span className={s.pickName}>{o.name}</span>{o.meta ? <span className={s.pickMeta}>{o.meta}</span> : null}</span>
          </label>
        ))}
        {shown.length === 0 ? <div className={s.pickEmpty}>{options.length ? `No one matches “${q}”.` : "No colleagues to choose from."}</div> : null}
      </div>
      <ErrorText state={state} name={name} />
    </fieldset>
  );
}

function Message({ state, placeholder }: { state: ActionState; placeholder: string }) {
  const [len, setLen] = useState(state.values?.message?.length ?? 0);
  const error = !!state.errors?.message;
  return (
    <div className="field">
      <label className="label" htmlFor="message">Message<span style={{ color: "var(--danger)" }}> *</span></label>
      <textarea
        id="message" name="message" className="textarea" rows={4} required maxLength={MESSAGE_MAX} placeholder={placeholder}
        defaultValue={state.values?.message} onChange={(e) => setLen(e.target.value.length)}
        aria-invalid={error} aria-describedby={error ? "message-error" : "message-count"}
        style={error ? { borderColor: "var(--danger)" } : undefined}
      />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <ErrorText state={state} name="message" />
        <span id="message-count" className="hint" style={{ marginLeft: "auto" }}>{len}/{MESSAGE_MAX}</span>
      </div>
    </div>
  );
}

function PraiseForm({ colleagues, onDone }: { colleagues: Colleague[]; onDone: (m?: string) => void }) {
  const [state, action, pending] = useForm(givePraiseAction);
  useDone(state, onDone);
  return (
    <form action={action}>
      {!state.ok ? <FormBanner state={state} /> : null}
      <ColleaguePicker name="toEmployeeId" label="Who are you praising?" options={colleagues} state={state} />
      <fieldset className={s.badges}>
        <legend className="label">Badge</legend>
        <label className={s.badgeOption}><input type="radio" name="badge" value="" defaultChecked={!state.values?.badge} /><span>No badge</span></label>
        {PRAISE_BADGES.map((b) => (
          <label key={b} className={s.badgeOption}><input type="radio" name="badge" value={b} defaultChecked={state.values?.badge === b} /><span>{b}</span></label>
        ))}
        <ErrorText state={state} name="badge" />
      </fieldset>
      <Message state={state} placeholder="What did they do? Be specific — it means more." />
      <div className="row gap-2">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Sending…" : "Post praise"}</button>
      </div>
    </form>
  );
}

function FeedbackForm({ colleagues, reportIds, onDone, allowAnonymous }: { colleagues: Colleague[]; reportIds: string[]; onDone: (m?: string) => void; allowAnonymous?: boolean }) {
  const [state, action, pending] = useForm(giveFeedbackAction);
  const [kind, setKind] = useState<"FEEDBACK" | "INTERNAL_NOTE">(state.values?.kind === "INTERNAL_NOTE" ? "INTERNAL_NOTE" : "FEEDBACK");
  useDone(state, onDone);
  const reports = new Set(reportIds);
  const options = kind === "INTERNAL_NOTE" ? colleagues.filter((c) => reports.has(c.id)) : colleagues;
  return (
    <form action={action}>
      {!state.ok ? <FormBanner state={state} /> : null}
      {reportIds.length ? (
        <fieldset className={s.kinds}>
          <legend className="label">Type</legend>
          <label className={s.kind}>
            <input type="radio" name="kind" value="FEEDBACK" checked={kind === "FEEDBACK"} onChange={() => setKind("FEEDBACK")} />
            <span><strong>Feedback</strong><span className={s.kindHint}>Shared with the person, who is notified.</span></span>
          </label>
          <label className={s.kind}>
            <input type="radio" name="kind" value="INTERNAL_NOTE" checked={kind === "INTERNAL_NOTE"} onChange={() => setKind("INTERNAL_NOTE")} />
            <span><strong>Internal note</strong><span className={s.kindHint}>Private to you, about someone who reports to you. Never shown to them.</span></span>
          </label>
        </fieldset>
      ) : <input type="hidden" name="kind" value="FEEDBACK" />}
      <ColleaguePicker key={kind} name="aboutEmployeeId" label={kind === "INTERNAL_NOTE" ? "About which report?" : "Who is it for?"} options={options} state={state} />
      <div className="field">
        <label className="label" htmlFor="topic">Topic</label>
        <input id="topic" name="topic" className="input" maxLength={TOPIC_MAX} placeholder="A project, a skill or a behaviour" defaultValue={state.values?.topic} aria-describedby={state.errors?.topic ? "topic-error" : undefined} />
        <ErrorText state={state} name="topic" />
      </div>
      <Message state={state} placeholder={kind === "INTERNAL_NOTE" ? "What you want to remember for their next review." : "What went well, and what could be even better?"} />
      {allowAnonymous && kind === "FEEDBACK" ? <label className="checkbox-row"><input type="checkbox" name="anonymous" /><span className="text-sm">Give anonymously — your name is not shown to them</span></label> : null}
      <div className="row gap-2">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : kind === "INTERNAL_NOTE" ? "Save note" : "Send feedback"}</button>
      </div>
    </form>
  );
}
