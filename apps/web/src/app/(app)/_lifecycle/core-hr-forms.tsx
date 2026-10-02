"use client";

import { useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import {
  saveNotificationSettingAction, resetNotificationSettingAction, setupExitSurveyAction, submitExitSurveyAction,
  scheduleReportAction, deleteScheduledReportAction,
} from "@/app/actions/core-hr-workflows";

/**
 * Forms for the core HR workflows: one notification event's email setting,
 * the exit survey (setting it up, answering it) and report schedules.
 */

// ---------------------------------------------------------------------------
//  Notification settings
// ---------------------------------------------------------------------------

const GROUP_LABEL: Record<string, string> = { EMPLOYEE: "Employee", MANAGER: "Manager", HR: "HR" };

export function NotificationEventRow({ event, label, module, description, configurable, defaultLabel, emailEnabled, recipients, customEmails, customised }: {
  event: string; label: string; module: string; description: string; configurable: boolean; defaultLabel?: string;
  emailEnabled: boolean; recipients: string[]; customEmails: string[]; customised: boolean;
}) {
  const [state, action, pending] = useForm(saveNotificationSettingAction);
  const [resetState, reset, resetting] = useForm(resetNotificationSettingAction);
  const [on, setOn] = useState(emailEnabled);
  const message = state.message ?? resetState.message;
  return (
    <tr>
      <td style={{ minWidth: 220 }}>
        <div className="strong text-sm">{label}</div>
        <div className="text-xs subtle">{module} · {description}</div>
      </td>
      <td colSpan={3}>
        <form action={action} className="row gap-3 wrap" style={{ alignItems: "center" }}>
          <input type="hidden" name="event" value={event} />
          <label className="row gap-1 text-sm"><input type="checkbox" name="emailEnabled" checked={on} onChange={(e) => setOn(e.target.checked)} /> Email</label>
          {configurable ? (
            <span className="row gap-2 text-sm" style={{ opacity: on ? 1 : 0.5 }}>
              {["EMPLOYEE", "MANAGER", "HR"].map((g) => (
                <label key={g} className="row gap-1"><input type="checkbox" name="recipients" value={g} defaultChecked={recipients.includes(g)} disabled={!on} /> {GROUP_LABEL[g]}</label>
              ))}
            </span>
          ) : <span className="text-xs muted">{defaultLabel}</span>}
          <input className="input" name="customEmails" defaultValue={customEmails.join(", ")} placeholder="Custom addresses" disabled={!on} style={{ width: 220 }} aria-label="Custom addresses" />
          <button className="btn sm primary" disabled={pending}>{pending ? "…" : "Save"}</button>
          {customised ? <button className="btn sm ghost" type="submit" formAction={reset} disabled={resetting}>Reset</button> : null}
        </form>
        {message ? <div className={`text-xs ${state.ok || resetState.ok ? "pos" : "neg"}`} style={{ marginTop: 4 }}>{message}</div> : null}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
//  Exit survey
// ---------------------------------------------------------------------------

export function SetupExitSurveyButton() {
  const [state, action, pending] = useForm(setupExitSurveyAction);
  return (
    <form action={action}>
      <button className="btn primary" disabled={pending}>{pending ? "Setting up…" : "Set up the exit survey"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ marginTop: 6 }}>{state.message}</div> : null}
    </form>
  );
}

export interface ExitSurveyQuestion { id: string; prompt: string; type: string; options: string[]; required: boolean }

const AGREE = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

export function ExitSurveyForm({ exitId, questions }: { exitId: string; questions: ExitSurveyQuestion[] }) {
  const [state, action, pending] = useForm(submitExitSurveyAction);
  if (state.ok) return <div className="callout success"><div><div className="callout-title">{state.message}</div>Thank you for taking the time.</div></div>;
  return (
    <form action={action} className="stack gap-4">
      <input type="hidden" name="exitId" value={exitId} />
      <FormBanner state={state} />
      <div className="text-sm muted">Your answers are shared with HR with your name, and help us understand why people leave. Nothing you say affects your settlement.</div>
      {questions.map((q, i) => {
        const key = `q_${q.id}`;
        const error = state.errors?.[key];
        return (
          <fieldset key={q.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 14, borderColor: error ? "var(--danger)" : undefined }}>
            <legend className="strong text-sm" style={{ padding: "0 4px" }}>{i + 1}. {q.prompt}{q.required ? <span style={{ color: "var(--danger)" }}> *</span> : null}</legend>
            {q.type === "RATING" ? (
              <div className="row gap-2 wrap" role="radiogroup">
                {AGREE.map((l, v) => <label key={v} className="scale-opt"><input type="radio" name={key} value={v + 1} /><span>{v + 1}</span><small>{l}</small></label>)}
              </div>
            ) : q.type === "NPS" ? (
              <>
                <div className="row gap-1 wrap" role="radiogroup">
                  {Array.from({ length: 11 }, (_, v) => <label key={v} className="scale-opt nps"><input type="radio" name={key} value={v} /><span>{v}</span></label>)}
                </div>
                <div className="row text-xs subtle" style={{ justifyContent: "space-between", maxWidth: 540, marginTop: 4 }}><span>Not at all likely</span><span>Extremely likely</span></div>
              </>
            ) : q.type === "SINGLE_CHOICE" || q.type === "MULTI_CHOICE" ? (
              <div className="stack gap-1">
                {q.options.map((o, oi) => <label key={oi} className="row gap-2 text-sm"><input type={q.type === "SINGLE_CHOICE" ? "radio" : "checkbox"} name={key} value={oi} />{o}</label>)}
              </div>
            ) : (
              <textarea name={key} className="textarea" rows={3} maxLength={2000} />
            )}
            {error ? <div className="text-xs neg" style={{ marginTop: 6 }}>{error}</div> : null}
          </fieldset>
        );
      })}
      <div><button className="btn primary" disabled={pending}>{pending ? "Submitting…" : "Submit"}</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Report schedules
// ---------------------------------------------------------------------------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ScheduleReportForm({ reportKey, defaultName }: { reportKey: string; defaultName: string }) {
  const [state, action, pending] = useForm(scheduleReportAction);
  const [frequency, setFrequency] = useState("WEEKLY");
  return (
    <form action={action} className="stack gap-2" style={{ padding: 14 }}>
      <input type="hidden" name="reportKey" value={reportKey} />
      <FormBanner state={state} />
      <div className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ margin: 0 }}><span className="label">Name</span><input className="input" name="name" defaultValue={defaultName} required style={{ width: 200 }} /></label>
        <label className="field" style={{ margin: 0 }}><span className="label">Recipients</span><input className="input" name="recipients" placeholder="a@acme.test, b@acme.test" required style={{ width: 260 }} /></label>
        <label className="field" style={{ margin: 0 }}><span className="label">Every</span>
          <select className="select" name="frequency" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="DAILY">Day</option><option value="WEEKLY">Week</option><option value="MONTHLY">Month</option>
          </select>
        </label>
        {frequency === "WEEKLY" ? (
          <label className="field" style={{ margin: 0 }}><span className="label">On</span>
            <select className="select" name="dayOfWeek" defaultValue="1">{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          </label>
        ) : null}
        {frequency === "MONTHLY" ? (
          <label className="field" style={{ margin: 0 }}><span className="label">Day</span>
            <select className="select" name="dayOfMonth" defaultValue="1">{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>
          </label>
        ) : null}
        <button className="btn primary" disabled={pending}>{pending ? "Saving…" : "Schedule"}</button>
      </div>
      {state.errors?.recipients ? <div className="text-xs neg">{state.errors.recipients}</div> : null}
      <div className="hint">Sent at 9:00 IST as CSV, with the rows you can see — recipients get the same rows even if their own access is narrower.</div>
    </form>
  );
}

export function StopScheduleButton({ id }: { id: string }) {
  const [state, action, pending] = useForm(deleteScheduledReportAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button className="btn sm ghost" disabled={pending}>{pending ? "…" : "Stop"}</button>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
