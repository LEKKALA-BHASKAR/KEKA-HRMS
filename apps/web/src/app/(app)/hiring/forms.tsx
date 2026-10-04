"use client";

import { useState } from "react";
import { ActionForm, InlineForm, Field, TextInput, SelectInput, TextArea, FormBanner, useForm } from "@/components/form";
import {
  openJobAction, jobStatusAction, addCandidateAction, referAction,
  moveStageAction, rejectApplicationAction, scheduleInterviewAction, draftOfferAction, offerOpAction, hireAction,
} from "@/app/actions/hiring";

export interface Option { value: string; label: string }
const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export function OpenJob({ requisitionId, managers }: { requisitionId: string; managers: Option[] }) {
  return (
    <InlineForm action={openJobAction} hidden={{ requisitionId }} submitLabel="Open job">
      {(state) => <SelectInput name="hiringManagerId" state={state} options={managers} placeholder="Hiring manager" />}
    </InlineForm>
  );
}

export function JobStatus({ jobId, status }: { jobId: string; status: string }) {
  const [, action, pending] = useForm(jobStatusAction);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      {status === "OPEN" ? <button className="btn sm" name="status" value="ON_HOLD" disabled={pending}>Hold</button> : null}
      {status === "ON_HOLD" || status === "CLOSED" ? <button className="btn sm" name="status" value="OPEN" disabled={pending}>Reopen</button> : null}
      {status !== "CLOSED" && status !== "FILLED" ? <button className="btn sm ghost" name="status" value="CLOSED" disabled={pending}>Close</button> : null}
    </form>
  );
}

export function CandidateForm({ jobId }: { jobId: string }) {
  return (
    <ActionForm action={addCandidateAction} submitLabel="Add to pipeline" hidden={{ jobId }}>
      {(state) => (
        <div className="grid grid-3">
          <Field label="First name" name="firstName" state={state} required><TextInput name="firstName" state={state} required /></Field>
          <Field label="Last name" name="lastName" state={state} required><TextInput name="lastName" state={state} required /></Field>
          <Field label="Email" name="email" state={state} required><TextInput name="email" type="email" state={state} required /></Field>
          <Field label="Phone" name="phone" state={state}><TextInput name="phone" state={state} /></Field>
          <Field label="Current employer" name="currentEmployer" state={state}><TextInput name="currentEmployer" state={state} /></Field>
          <Field label="Current title" name="currentTitle" state={state}><TextInput name="currentTitle" state={state} /></Field>
          <Field label="Experience (years)" name="totalExperienceYears" state={state}><TextInput name="totalExperienceYears" type="number" step="0.5" state={state} /></Field>
          <Field label="Expected CTC" name="expectedAnnualCtc" state={state}><TextInput name="expectedAnnualCtc" type="number" state={state} /></Field>
          <Field label="Notice (days)" name="noticePeriodDays" state={state}><TextInput name="noticePeriodDays" type="number" state={state} /></Field>
          <Field label="Source" name="source" state={state}>
            <SelectInput name="source" state={state} defaultValue="DIRECT_SOURCING" options={["DIRECT_SOURCING", "JOB_BOARD", "AGENCY", "CAREER_PORTAL", "WALK_IN", "INTERNAL"].map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ReferForm({ jobs }: { jobs: Option[] }) {
  return (
    <ActionForm action={referAction} submitLabel="Refer">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Job" name="jobId" state={state} required><SelectInput name="jobId" state={state} options={jobs} placeholder="Select…" required /></Field>
          <Field label="First name" name="firstName" state={state} required><TextInput name="firstName" state={state} required /></Field>
          <Field label="Last name" name="lastName" state={state} required><TextInput name="lastName" state={state} required /></Field>
          <Field label="Email" name="email" state={state} required><TextInput name="email" type="email" state={state} required /></Field>
          <Field label="Phone" name="phone" state={state}><TextInput name="phone" state={state} /></Field>
          <Field label="Their current role" name="currentTitle" state={state}><TextInput name="currentTitle" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function MoveStage({ applicationId, stages, current }: { applicationId: string; stages: Option[]; current: string | null }) {
  const [state, action, pending] = useForm(moveStageAction);
  return (
    <form action={action} className="row gap-2 wrap">
      <input type="hidden" name="applicationId" value={applicationId} />
      <select name="stageId" className="select" defaultValue={current ?? ""} style={{ width: 180 }}>{stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      <input className="input" name="note" placeholder="Note (optional)" style={{ width: 170 }} />
      <button className="btn sm primary" disabled={pending}>Move</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ width: "100%" }}>{state.message}</span> : null}
    </form>
  );
}

export function RejectApplication({ applicationId }: { applicationId: string }) {
  const [state, action, pending] = useForm(rejectApplicationAction);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn sm ghost" style={{ color: "var(--danger)" }} onClick={() => setOpen(true)}>Reject</button>;
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input className="input" name="reason" placeholder="Why (kept on record)" required style={{ width: 220 }} />
      <button className="btn sm danger" disabled={pending}>Reject and tell them</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export function InterviewForm({ applicationId, employees, round }: { applicationId: string; employees: Option[]; round: number }) {
  return (
    <ActionForm action={scheduleInterviewAction} submitLabel="Schedule" hidden={{ applicationId }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Round" name="title" state={state} required><TextInput name="title" state={state} defaultValue={round === 1 ? "Technical screen" : round === 2 ? "System design" : "Hiring manager"} required /></Field>
            <Field label="Date" name="date" state={state} required><TextInput name="date" type="date" state={state} defaultValue={plus(2)} required /></Field>
            <Field label="Time (IST)" name="time" state={state} required><TextInput name="time" type="time" state={state} defaultValue="11:00" required /></Field>
            <Field label="Minutes" name="durationMinutes" state={state} required><TextInput name="durationMinutes" type="number" state={state} defaultValue={60} required /></Field>
            <Field label="Mode" name="mode" state={state}><SelectInput name="mode" state={state} options={[{ value: "VIDEO", label: "Video" }, { value: "PHONE", label: "Phone" }, { value: "ONSITE", label: "On site" }]} /></Field>
            <Field label="Meeting link" name="meetingUrl" state={state}><TextInput name="meetingUrl" state={state} /></Field>
          </div>
          <Field label="Panel" name="panel" state={state} hint="Hold ⌘ or Ctrl for several; the first is the lead">
            <select name="panel" multiple className="select" style={{ height: 110 }}>{employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select>
          </Field>
          <label className="row gap-2 text-sm"><input type="checkbox" name="capacityOverride" /> Book even if an interviewer is over their capacity limit</label>
        </>
      )}
    </ActionForm>
  );
}

export function OfferForm({ applicationId, managers, max, templates, structures }: { applicationId: string; managers: Option[]; max: number | null; templates: Option[]; structures: Option[] }) {
  const [mode, setMode] = useState<"STRUCTURE" | "MANUAL">("STRUCTURE");
  return (
    <ActionForm action={draftOfferAction} submitLabel="Draft offer" hidden={{ applicationId, breakupMode: mode }} compact>
      {(state) => (
        <div className="stack gap-3">
          <div className="grid grid-3">
            <Field label="Annual CTC" name="annualCtc" state={state} required hint={max ? `Budget ceiling ₹${max.toLocaleString("en-IN")}` : undefined}><TextInput name="annualCtc" type="number" state={state} required /></Field>
            <Field label="Joining bonus" name="joiningBonus" state={state}><TextInput name="joiningBonus" type="number" state={state} /></Field>
            <Field label="Reports to" name="reportingManagerId" state={state}><SelectInput name="reportingManagerId" state={state} options={managers} placeholder="Hiring manager" /></Field>
            <Field label="Offer expires" name="expiresOn" state={state} required><TextInput name="expiresOn" type="date" state={state} defaultValue={plus(7)} required /></Field>
            <Field label="Joining date" name="proposedJoiningDate" state={state} required><TextInput name="proposedJoiningDate" type="date" state={state} defaultValue={plus(45)} required /></Field>
            <Field label="Letter template" name="templateId" state={state} hint={templates.length ? "Offer templates under Documents" : "No offer template yet; the standard letter is used"}>
              <SelectInput name="templateId" state={state} options={templates} placeholder={templates.length ? "First offer template" : "Standard offer letter"} />
            </Field>
          </div>
          <div className="stack gap-2">
            <div className="row gap-3 text-sm" role="radiogroup" aria-label="Salary breakup">
              <span className="label" style={{ margin: 0 }}>Salary breakup</span>
              <label className="row gap-1"><input type="radio" name="_mode" checked={mode === "STRUCTURE"} onChange={() => setMode("STRUCTURE")} /> From a pay structure</label>
              <label className="row gap-1"><input type="radio" name="_mode" checked={mode === "MANUAL"} onChange={() => setMode("MANUAL")} /> Enter components</label>
            </div>
            {mode === "STRUCTURE" ? (
              <Field label="Salary structure" name="salaryStructureId" state={state} hint="Blank picks the structure whose CTC range fits">
                <SelectInput name="salaryStructureId" state={state} options={structures} placeholder="Structure for this CTC" />
              </Field>
            ) : (
              <Field label="Components (annual, one per line)" name="breakup" state={state} required hint="Like “Basic: 600000”. They must add up to the annual CTC.">
                <TextArea name="breakup" state={state} rows={5} placeholder={"Basic: 600000\nHRA: 240000\nSpecial allowance: 360000"} required />
              </Field>
            )}
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export function OfferOps({ applicationId, status, canApprove, linkLive }: { applicationId: string; status: string; canApprove: boolean; linkLive?: boolean }) {
  const [state, action, pending] = useForm(offerOpAction);
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="row gap-2 wrap">
        {status === "PENDING_APPROVAL" && canApprove ? <button className="btn sm primary" name="op" value="approve" disabled={pending}>Approve above budget</button> : null}
        {status === "APPROVED" ? <button className="btn sm primary" name="op" value="extend" disabled={pending}>Extend offer (emails the candidate a link)</button> : null}
        {status === "EXTENDED" ? (
          <>
            <button className="btn sm" name="op" value="resend" disabled={pending}>{linkLive ? "Resend link" : "Send a new link"}</button>
            {linkLive ? <button className="btn sm ghost" name="op" value="revoke" disabled={pending}>Revoke link</button> : null}
          </>
        ) : null}
      </div>
      {status === "EXTENDED" ? (
        <details>
          <summary className="text-xs subtle" style={{ cursor: "pointer" }}>Record the candidate&rsquo;s answer yourself</summary>
          <div className="row gap-2 wrap" style={{ marginTop: 6 }}>
            <button className="btn sm" name="op" value="accepted" disabled={pending}>Candidate accepted</button>
            <input className="input" name="reason" placeholder="Decline reason" style={{ width: 180 }} />
            <button className="btn sm" name="op" value="declined" disabled={pending}>Declined</button>
          </div>
        </details>
      ) : null}
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function HireButton({ applicationId, suggestedEmail }: { applicationId: string; suggestedEmail: string }) {
  const [state, action, pending] = useForm(hireAction);
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="text-sm">Work email <input className="input" name="workEmail" defaultValue={suggestedEmail} style={{ width: 260 }} /></label>
      <button className="btn primary" disabled={pending} style={{ alignSelf: "flex-start" }}>{pending ? "Creating employee…" : "Hire — create the employee record"}</button>
    </form>
  );
}
