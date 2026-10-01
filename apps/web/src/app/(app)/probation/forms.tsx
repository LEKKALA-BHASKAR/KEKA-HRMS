"use client";

import { useState } from "react";
import {
  ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, SubmitButton, useForm,
} from "@/components/form";
import {
  saveProbationPolicyAction, startProbationAction, changeProbationPolicyAction, openProbationReviewAction,
  decideProbationAction, submitProbationEvaluationAction,
} from "@/app/actions/probation";

export interface Option { value: string; label: string }

export interface PolicyValues {
  id?: string; name?: string; description?: string | null; durationDays?: number; maxExtensions?: number;
  extensionDays?: number; completion?: string; reviewLeadDays?: number; selfReview?: boolean; isDefault?: boolean;
}

export function PolicyForm({ policy }: { policy?: PolicyValues }) {
  const p = policy ?? {};
  return (
    <ActionForm action={saveProbationPolicyAction} submitLabel={p.id ? "Save policy" : "Create policy"} hidden={p.id ? { policyId: p.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={p.name} required maxLength={80} />
            </Field>
            <Field label="Ends with" name="completion" state={state}>
              <SelectInput name="completion" state={state} defaultValue={p.completion ?? "EVALUATION"} options={[
                { value: "EVALUATION", label: "A review, then HR decides" },
                { value: "AUTO_CONFIRM", label: "Automatic confirmation" },
              ]} />
            </Field>
          </div>
          <div className="grid grid-4">
            <Field label="Duration (days)" name="durationDays" state={state} required>
              <TextInput name="durationDays" type="number" state={state} defaultValue={p.durationDays ?? 90} min={1} max={730} required />
            </Field>
            <Field label="Review opens (days before end)" name="reviewLeadDays" state={state}>
              <TextInput name="reviewLeadDays" type="number" state={state} defaultValue={p.reviewLeadDays ?? 15} min={0} max={180} />
            </Field>
            <Field label="Extensions allowed" name="maxExtensions" state={state} required>
              <TextInput name="maxExtensions" type="number" state={state} defaultValue={p.maxExtensions ?? 1} min={0} max={5} required />
            </Field>
            <Field label="Extension length (days)" name="extensionDays" state={state} required>
              <TextInput name="extensionDays" type="number" state={state} defaultValue={p.extensionDays ?? 30} min={1} max={365} required />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}>
            <TextArea name="description" state={state} defaultValue={p.description} rows={2} />
          </Field>
          <div className="row gap-4 wrap">
            <CheckboxInput name="selfReview" label="Ask the employee for a self review" defaultChecked={p.selfReview ?? true} />
            <CheckboxInput name="isDefault" label="Default for new probations" defaultChecked={p.isDefault ?? false} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function StartProbationButton({ employeeId, policies }: { employeeId: string; policies: Option[] }) {
  const [state, formAction, pending] = useForm(startProbationAction);
  if (state.ok) return <span className="text-xs" style={{ color: "var(--success)" }}>{state.message}</span>;
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="employeeId" value={employeeId} />
      <select name="policyId" className="select" style={{ width: 180 }} defaultValue="">
        <option value="">Default policy</option>
        {policies.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button className="btn sm primary" type="submit" disabled={pending}>{pending ? "…" : "Start"}</button>
      {state.message ? <span className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</span> : null}
    </form>
  );
}

export function ChangePolicyForm({ probationId, policyId, policies }: { probationId: string; policyId: string; policies: Option[] }) {
  const [state, formAction, pending] = useForm(changeProbationPolicyAction);
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="probationId" value={probationId} />
      <div className="row gap-2">
        <select name="policyId" className="select" defaultValue={policyId}>
          {policies.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn sm" type="submit" disabled={pending}>{pending ? "…" : "Move"}</button>
      </div>
      {state.message ? <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}

export function OpenReviewButton({ probationId }: { probationId: string }) {
  const [state, formAction, pending] = useForm(openProbationReviewAction);
  return (
    <form action={formAction} className="stack gap-2">
      <input type="hidden" name="probationId" value={probationId} />
      <div><button className="btn sm" type="submit" disabled={pending}>{pending ? "…" : "Open review now"}</button></div>
      {state.message ? <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}

export function DecisionForm({ probationId, canExtend, extensionDays, suggested }: {
  probationId: string; canExtend: boolean; extensionDays: number; suggested: string | null;
}) {
  const [state, formAction, pending] = useForm(decideProbationAction);
  const [decision, setDecision] = useState(suggested && (suggested !== "EXTEND" || canExtend) ? suggested : "CONFIRM");
  if (state.ok) return <FormBanner state={state} />;
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <input type="hidden" name="probationId" value={probationId} />
      <div className="row gap-4 wrap" style={{ marginBottom: 10 }}>
        {[
          { v: "CONFIRM", l: "Confirm" },
          ...(canExtend ? [{ v: "EXTEND", l: "Extend probation" }] : []),
          { v: "NOT_CONFIRM", l: "Do not confirm" },
        ].map((o) => (
          <label key={o.v} className="row gap-1 text-sm">
            <input type="radio" name="decision" value={o.v} checked={decision === o.v} onChange={() => setDecision(o.v)} />
            {o.l}
          </label>
        ))}
      </div>
      {decision === "EXTEND" ? (
        <Field label="Extend by (days)" name="extendDays" state={state}>
          <TextInput name="extendDays" type="number" state={state} defaultValue={extensionDays} min={1} max={365} />
        </Field>
      ) : null}
      <Field label={decision === "NOT_CONFIRM" ? "Reason" : "Note"} name="note" state={state} required={decision === "NOT_CONFIRM"}>
        <TextArea name="note" state={state} rows={2} required={decision === "NOT_CONFIRM"} />
      </Field>
      <SubmitButton pending={pending} variant={decision === "NOT_CONFIRM" ? "danger" : "primary"}>
        {decision === "CONFIRM" ? "Confirm employee" : decision === "EXTEND" ? "Extend probation" : "Record decision"}
      </SubmitButton>
    </form>
  );
}

export function EvaluationForm({ evaluationId, role, name }: { evaluationId: string; role: "MANAGER" | "SELF"; name: string }) {
  const [state, formAction, pending] = useForm(submitProbationEvaluationAction);
  if (state.ok) return <FormBanner state={state} />;
  const self = role === "SELF";
  return (
    <form action={formAction} style={{ maxWidth: 560 }}>
      <FormBanner state={state} />
      <input type="hidden" name="evaluationId" value={evaluationId} />
      <div className="grid grid-2">
        <Field label={self ? "How has it gone? (1–5)" : `Rate ${name} (1–5)`} name="rating" state={state} required>
          <SelectInput name="rating" state={state} required placeholder="Select…" options={[
            { value: "5", label: "5 — Exceptional" }, { value: "4", label: "4 — Exceeds expectations" },
            { value: "3", label: "3 — Meets expectations" }, { value: "2", label: "2 — Needs improvement" },
            { value: "1", label: "1 — Unsatisfactory" },
          ]} />
        </Field>
        {self ? null : (
          <Field label="Recommendation" name="recommendation" state={state} required>
            <SelectInput name="recommendation" state={state} required placeholder="Select…" options={[
              { value: "CONFIRM", label: "Confirm" }, { value: "EXTEND", label: "Extend probation" }, { value: "NOT_CONFIRM", label: "Do not confirm" },
            ]} />
          </Field>
        )}
      </div>
      <Field label={self ? "What has gone well" : "Strengths"} name="strengths" state={state}>
        <TextArea name="strengths" state={state} rows={2} />
      </Field>
      <Field label={self ? "Where you would like support" : "Areas to improve"} name="improvements" state={state}>
        <TextArea name="improvements" state={state} rows={2} />
      </Field>
      <Field label="Comments" name="comments" state={state} hint={self ? undefined : "Required unless you recommend confirmation."}>
        <TextArea name="comments" state={state} rows={2} />
      </Field>
      <SubmitButton pending={pending}>Submit review</SubmitButton>
    </form>
  );
}
