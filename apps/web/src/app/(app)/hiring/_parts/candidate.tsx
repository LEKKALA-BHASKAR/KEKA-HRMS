"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { moveStageAction, rejectApplicationAction, remindPanelistAction, addCandidateNoteAction } from "@/app/actions/hiring";
import type { ActionState } from "@/lib/forms";
import { InterviewForm, type Option } from "../forms";
import { HireDialog } from "./dialog";
import { Toast } from "./toast";
import s from "../hire.module.css";

function useToast(state: ActionState) {
  const [t, setT] = useState<ActionState | null>(null);
  const seen = useRef<ActionState | null>(null);
  useEffect(() => { if (state.message && seen.current !== state) { seen.current = state; setT(state); } }, [state]);
  return [t, () => setT(null)] as const;
}

/** "Hiring stage ▾": choosing a stage moves the candidate there at once. */
export function StageSelect({ applicationId, stages, current, disabled }: { applicationId: string; stages: Option[]; current: string | null; disabled?: boolean }) {
  const [state, action, pending] = useActionState(moveStageAction, {} as ActionState);
  const [toast, close] = useToast(state);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={action}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <select key={current ?? "none"} name="stageId" className={s.stageSelect} defaultValue={current ?? ""} disabled={disabled || pending} aria-label="Hiring stage"
        onChange={() => form.current?.requestSubmit()}>
        {stages.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {toast?.message ? <Toast message={toast.message} ok={!!toast.ok} onClose={close} /> : null}
    </form>
  );
}

/** Keka's red "Archive": reject the candidate with a reason (they are emailed). */
export function ArchiveButton({ applicationId, name }: { applicationId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(rejectApplicationAction, {} as ActionState);
  const [toast, close] = useToast(state);
  useEffect(() => { if (state.ok) setOpen(false); }, [state]);
  return (
    <>
      <button type="button" className={s.dangerOutline} onClick={() => setOpen(true)}>Archive</button>
      <HireDialog open={open} onClose={() => setOpen(false)} title={`Archive ${name}`} width={520}>
        <form action={action}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <p className="text-sm" style={{ marginBottom: 12 }}>The candidate leaves the pipeline and is sent a polite regret email. The reason stays on record.</p>
          <label className="text-sm">Reason <span className={s.req}>*</span>
            <textarea name="reason" className="textarea" rows={3} required maxLength={500} style={{ marginTop: 6 }} placeholder="e.g. Not enough distributed-systems depth for this role" />
          </label>
          {state.message && !state.ok ? <div className="callout danger" style={{ marginTop: 12 }}>{state.message}</div> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
            <button type="button" className={s.outlineBtn} onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className={s.primaryBtn} disabled={pending} style={{ background: "#d93025", borderColor: "#d93025" }}>{pending ? "Archiving…" : "Archive"}</button>
          </div>
        </form>
      </HireDialog>
      {toast?.ok ? <Toast message={toast.message!} onClose={close} /> : null}
    </>
  );
}

/** Interactions › Schedule: book an interview with a panel, in a drawer. */
export function ScheduleButton({ applicationId, employees, round }: { applicationId: string; employees: Option[]; round: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={s.primaryBtn} onClick={() => setOpen(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M9 14h2" strokeLinecap="round" /></svg>
        Schedule
      </button>
      <HireDialog open={open} onClose={() => setOpen(false)} title="Schedule interview" side width={640}>
        <InterviewForm applicationId={applicationId} employees={employees} round={round} />
      </HireDialog>
    </>
  );
}

/** "Remind" next to a panellist whose feedback is outstanding. */
export function RemindButton({ interviewId, employeeId }: { interviewId: string; employeeId: string }) {
  const [state, action, pending] = useActionState(remindPanelistAction, {} as ActionState);
  const [toast, close] = useToast(state);
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="interviewId" value={interviewId} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <button type="submit" className={s.linkBtn} disabled={pending}>{pending ? "Sending…" : "Remind"}</button>
      {toast?.message ? <Toast message={toast.message} ok={!!toast.ok} onClose={close} /> : null}
    </form>
  );
}

/** "+ Add note" — a note for the hiring team on this candidate. */
export function NoteForm({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [state, action, pending] = useActionState(addCandidateNoteAction, {} as ActionState);
  useEffect(() => { if (state.ok) { setOpen(false); setBody(""); } }, [state]);
  if (!open) return <button type="button" className={s.primaryBtn} onClick={() => setOpen(true)}>+ Add note</button>;
  return (
    <form action={action} style={{ textAlign: "left" }}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <textarea name="body" className="textarea" rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Share a note with the hiring team" autoFocus />
      {state.message && !state.ok ? <div className={s.err}>{state.message}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button type="button" className={s.outlineBtn} onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className={s.primaryBtn} disabled={pending || body.trim().length < 2}>{pending ? "Saving…" : "Add note"}</button>
      </div>
    </form>
  );
}
