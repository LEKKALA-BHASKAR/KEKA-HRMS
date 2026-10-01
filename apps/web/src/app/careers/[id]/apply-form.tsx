"use client";

import { useForm, Field, TextInput } from "@/components/form";
import { applyToJobAction } from "../actions";

export function ApplyForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useForm(applyToJobAction);
  if (state.ok) return <div className="callout success"><strong>Thanks, your application is in.</strong> {state.message}</div>;
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      {/* Left empty by people; bots tend to fill it. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, opacity: 0 }} />
      <div className="grid grid-2">
        <Field label="First name" name="firstName" state={state} required><TextInput name="firstName" state={state} required maxLength={60} /></Field>
        <Field label="Last name" name="lastName" state={state} required><TextInput name="lastName" state={state} required maxLength={60} /></Field>
      </div>
      <Field label="Email" name="email" state={state} required><TextInput name="email" type="email" state={state} required /></Field>
      <Field label="Phone" name="phone" state={state}><TextInput name="phone" state={state} maxLength={20} /></Field>
      <div className="grid grid-2">
        <Field label="Experience (years)" name="totalExperienceYears" state={state}><TextInput name="totalExperienceYears" type="number" step="0.5" state={state} /></Field>
        <Field label="Notice period (days)" name="noticePeriodDays" state={state}><TextInput name="noticePeriodDays" type="number" state={state} /></Field>
      </div>
      <Field label="Current employer" name="currentEmployer" state={state}><TextInput name="currentEmployer" state={state} maxLength={120} /></Field>
      <Field label="Résumé (PDF, up to 5 MB)" name="resume" state={state} required>
        <input className="input" type="file" name="resume" accept="application/pdf" required />
      </Field>
      <label className="row gap-2 text-xs" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" name="consent" value="on" required />
        <span>I agree that my details may be used to consider me for this and similar roles.</span>
      </label>
      <button className="btn primary" disabled={pending}>{pending ? "Sending…" : "Submit application"}</button>
      {state.message ? <div className="text-sm neg" role="alert">{state.message}</div> : null}
    </form>
  );
}
