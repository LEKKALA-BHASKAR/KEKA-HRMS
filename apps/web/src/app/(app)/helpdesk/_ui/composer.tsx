"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { replyTicketAction, aiDraftReplyAction } from "@/app/actions/helpdesk";
import type { ActionState } from "@/lib/forms";
import { Editor, type EditorHandle } from "./editor";
import { AttachFiles } from "./attach";
import s from "./hd.module.css";

type Then = "" | "IN_PROGRESS" | "ON_HOLD" | "CLOSED";
const THEN_LABEL: Record<Then, string> = { "": "Send", IN_PROGRESS: "Send & mark In Progress", ON_HOLD: "Send & put On Hold", CLOSED: "Send & close" };

/**
 * The reply box under a ticket's thread. Agents also get canned responses
 * ("Templates"), an AI draft, and a split Send button that can move the
 * ticket on in the same step — closing asks for a closing reason.
 */
export function Composer({ ticketId, agent, canned = [], reasons = [], onHold = false }: {
  ticketId: string; agent: boolean;
  canned?: Array<{ id: string; title: string; body: string }>;
  reasons?: Array<{ value: string; label: string }>;
  onHold?: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(replyTicketAction, {});
  const editor = useRef<EditorHandle>(null);
  const [then, setThen] = useState<Then>("");
  const [menu, setMenu] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [filter, setFilter] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [drafting, startDraft] = useTransition();
  const [aiNote, setAiNote] = useState<string | null>(null);

  useEffect(() => {
    if (state.ok) { editor.current?.set(""); setThen(""); setRound((r) => r + 1); setAiNote(null); }
  }, [state]);

  const draft = () => startDraft(async () => {
    const res = await aiDraftReplyAction(ticketId);
    if (res.ok) { editor.current?.set(res.value.reply); setAiNote("Draft added — read it through before sending."); }
    else setAiNote(res.reason);
  });

  const shown = canned.filter((c) => `${c.title} ${c.body}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const options: Then[] = ["", "IN_PROGRESS", ...(onHold ? (["ON_HOLD"] as Then[]) : []), "CLOSED"];

  return (
    <form action={action} className={s.composer}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="then" value={agent ? then : ""} />
      {agent ? (
        <div className={s.composerHead}>
          <button type="button" className={s.templatesBtn} onClick={() => setTemplates((o) => !o)} aria-expanded={templates}>
            Templates <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {templates ? (
            <div className={s.templates} role="dialog" aria-label="Canned responses">
              <div className={s.templatesHead}>
                <span>Canned responses</span>
                <button type="button" className={s.chipX} aria-label="Close" onClick={() => setTemplates(false)}>×</button>
              </div>
              <div className={s.ddSearch}><input className="input" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search responses" autoFocus /></div>
              <div className={s.templatesList}>
                {shown.length === 0 ? <div className={s.emptySmall}>{canned.length ? "Nothing matches." : "No canned responses yet. Add them in Settings."}</div> : shown.map((c) => (
                  <button key={c.id} type="button" className={s.templateItem} onClick={() => { editor.current?.insert(c.body); setTemplates(false); }}>
                    <div className={s.templateTitle}>{c.title}</div>
                    <div className={s.templatePreview}>{c.body}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <button type="button" className={s.aiBtn} onClick={draft} disabled={drafting}>{drafting ? "Drafting…" : "Draft with AI"}</button>
        </div>
      ) : null}
      {state.message && !state.ok ? <div className="callout danger" style={{ margin: 12 }}><div>{state.message}</div></div> : null}
      {aiNote ? <div className={s.hint} style={{ padding: "8px 14px 0" }}>{aiNote}</div> : null}
      <Editor ref={editor} name="body" rows={5} placeholder={agent ? "Write your reply to the employee" : "Write a reply"} invalid={!!state.errors?.body} />
      <div className={s.composerFoot}>
        <div style={{ marginRight: "auto" }}><AttachFiles key={round} compact onError={setFileError} /></div>
        {fileError || state.errors?.files ? <span className={s.err}>{fileError ?? state.errors?.files}</span> : null}
        {agent && then === "CLOSED" && reasons.length ? (
          <select name="closingReasonId" className="select" aria-label="Closing reason" defaultValue="" style={state.errors?.closingReasonId ? { borderColor: "var(--danger)" } : undefined}>
            <option value="">Closing reason…</option>
            {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        ) : null}
        {agent ? (
          <span className={s.split}>
            <button type="submit" className="btn primary" disabled={pending || !!fileError}>{pending ? "Sending…" : THEN_LABEL[then]}</button>
            <button type="button" className={`btn primary ${s.splitCaret}`} aria-label="More send options" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
            </button>
            {menu ? (
              <div className={s.splitMenu} role="menu">
                {options.map((o) => <button key={o || "send"} type="button" role="menuitem" className={s.ddOption} onClick={() => { setThen(o); setMenu(false); }}>{THEN_LABEL[o]}</button>)}
              </div>
            ) : null}
          </span>
        ) : (
          <button type="submit" className="btn primary" disabled={pending || !!fileError}>{pending ? "Sending…" : "Send"}</button>
        )}
      </div>
    </form>
  );
}
