"use client";

import { useState } from "react";
import { ActionForm, InlineForm, Field, TextInput, SelectInput, TextArea, FormBanner, useForm } from "@/components/form";
import {
  raiseRequisitionAction, decideRequisitionAction, openJobAction, jobStatusAction, addCandidateAction, referAction,
  moveStageAction, rejectApplicationAction, scheduleInterviewAction, scorecardAction, draftOfferAction, offerOpAction, hireAction,
} from "@/app/actions/hiring";

export interface Option { value: string; label: string }
const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export function RequisitionForm({ departments, locations, employees }: { departments: Option[]; locations: Option[]; employees: Option[] }) {
  const [type, setType] = useState("NEW_HIRE");
  return (
    <ActionForm action={raiseRequisitionAction} submitLabel="Raise for approval">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Role" name="title" state={state} required><TextInput name="title" state={state} required placeholder="Senior Backend Engineer" /></Field>
            <Field label="Type" name="type" state={state}>
              <select name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}><option value="NEW_HIRE">New position</option><option value="BACKFILL">Backfill</option></select>
            </Field>
            {type === "BACKFILL" ? <Field label="Replacing" name="replacingEmployeeId" state={state} required><SelectInput name="replacingEmployeeId" state={state} options={employees} placeholder="Select…" /></Field> : <Field label="Positions" name="positions" state={state} required><TextInput name="positions" type="number" state={state} defaultValue={1} required /></Field>}
            {type === "BACKFILL" ? <input type="hidden" name="positions" value="1" /> : null}
            <Field label="Department" name="departmentId" state={state}><SelectInput name="departmentId" state={state} options={departments} placeholder="Select…" /></Field>
            <Field label="Location" name="locationId" state={state}><SelectInput name="locationId" state={state} options={locations} placeholder="Select…" /></Field>
            <Field label="Target start" name="targetStartDate" state={state}><TextInput name="targetStartDate" type="date" state={state} defaultValue={plus(60)} /></Field>
            <Field label="Budget — min CTC" name="minAnnualCtc" state={state}><TextInput name="minAnnualCtc" type="number" state={state} /></Field>
            <Field label="Budget — max CTC" name="maxAnnualCtc" state={state} hint="Offers above this need approval"><TextInput name="maxAnnualCtc" type="number" state={state} /></Field>
          </div>
          <Field label="Why we need this role" name="justification" state={state} required><TextArea name="justification" state={state} rows={2} required /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function RequisitionDecision({ id }: { id: string }) {
  const [state, action, pending] = useForm(decideRequisitionAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="id" value={id} />
      {rejecting ? <input className="input" name="reason" placeholder="Reason" required style={{ width: 200 }} /> : null}
      <div className="row gap-2">
        {rejecting ? <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Reject</button>
          : <><button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button><button type="button" className="btn sm" onClick={() => setRejecting(true)}>Reject</button></>}
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

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
        </>
      )}
    </ActionForm>
  );
}

export function ScorecardForm({ interviewId }: { interviewId: string }) {
  const [state, action, pending] = useForm(scorecardAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="interviewId" value={interviewId} />
      <div className="row gap-3 wrap">
        <label className="text-sm">Score <select name="overallScore" className="select" style={{ width: 80 }} required defaultValue=""><option value="" disabled>–</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label className="text-sm">Recommendation <select name="recommendation" className="select" style={{ width: 150 }} required defaultValue=""><option value="" disabled>Choose…</option><option value="STRONG_YES">Strong yes</option><option value="YES">Yes</option><option value="NO">No</option><option value="STRONG_NO">Strong no</option></select></label>
      </div>
      <TextArea name="strengths" placeholder="Strengths, with evidence from the interview" rows={2} />
      <TextArea name="concerns" placeholder="Concerns" rows={2} />
      <button className="btn sm primary" disabled={pending} style={{ alignSelf: "flex-start" }}>Submit feedback</button>
    </form>
  );
}

export function OfferForm({ applicationId, managers, max }: { applicationId: string; managers: Option[]; max: number | null }) {
  return (
    <ActionForm action={draftOfferAction} submitLabel="Draft offer" hidden={{ applicationId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Annual CTC" name="annualCtc" state={state} required hint={max ? `Budget ceiling ₹${max.toLocaleString("en-IN")}` : undefined}><TextInput name="annualCtc" type="number" state={state} required /></Field>
          <Field label="Joining bonus" name="joiningBonus" state={state}><TextInput name="joiningBonus" type="number" state={state} /></Field>
          <Field label="Reports to" name="reportingManagerId" state={state}><SelectInput name="reportingManagerId" state={state} options={managers} placeholder="Hiring manager" /></Field>
          <Field label="Offer expires" name="expiresOn" state={state} required><TextInput name="expiresOn" type="date" state={state} defaultValue={plus(7)} required /></Field>
          <Field label="Joining date" name="proposedJoiningDate" state={state} required><TextInput name="proposedJoiningDate" type="date" state={state} defaultValue={plus(45)} required /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function OfferOps({ applicationId, status, canApprove }: { applicationId: string; status: string; canApprove: boolean }) {
  const [state, action, pending] = useForm(offerOpAction);
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <div className="row gap-2 wrap">
        {status === "PENDING_APPROVAL" && canApprove ? <button className="btn sm primary" name="op" value="approve" disabled={pending}>Approve above budget</button> : null}
        {status === "APPROVED" ? <button className="btn sm primary" name="op" value="extend" disabled={pending}>Extend offer (sends letter)</button> : null}
        {status === "EXTENDED" ? <><button className="btn sm primary" name="op" value="accepted" disabled={pending}>Candidate accepted</button><input className="input" name="reason" placeholder="Decline reason" style={{ width: 160 }} /><button className="btn sm" name="op" value="declined" disabled={pending}>Declined</button></> : null}
      </div>
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
