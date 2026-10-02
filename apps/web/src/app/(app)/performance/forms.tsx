"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, FormBanner, useForm } from "@/components/form";
import {
  saveGoalAction, checkInAction, setGoalStatusAction, createCycleAction, cycleOpAction, publishDraftGoalAction,
  submitReviewAction, calibrateAction, acknowledgeAction, createPipAction, closePipAction,
  nominatePeersAction, decideNominationAction,
} from "@/app/actions/performance";

export interface Option { value: string; label: string }
const today = () => new Date().toISOString().slice(0, 10);

export function GoalForm({ employees, parents, departments, canOrgGoals, defaultEmployeeId, fyEnd }: {
  employees: Option[]; parents: Option[]; departments: Option[]; canOrgGoals: boolean; defaultEmployeeId?: string; fyEnd: string;
}) {
  const [metric, setMetric] = useState("PERCENTAGE");
  const [level, setLevel] = useState("INDIVIDUAL");
  const numeric = metric === "NUMBER_INCREASE" || metric === "NUMBER_DECREASE" || metric === "CURRENCY";
  return (
    <ActionForm action={saveGoalAction} submitLabel="Create goal">
      {(state) => (
        <>
          <Field label="Goal" name="title" state={state} required><TextInput name="title" state={state} required placeholder="Cut p95 API latency below 300 ms" /></Field>
          <div className="grid grid-3">
            <Field label="Level" name="level" state={state}>
              <select name="level" className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="INDIVIDUAL">Individual</option>
                {canOrgGoals ? <><option value="TEAM">Team</option><option value="DEPARTMENT">Department</option><option value="COMPANY">Company</option></> : null}
              </select>
            </Field>
            {level === "INDIVIDUAL" ? (
              <Field label="Owner" name="employeeId" state={state}><SelectInput name="employeeId" state={state} options={employees} defaultValue={defaultEmployeeId} /></Field>
            ) : level === "DEPARTMENT" ? (
              <Field label="Department" name="departmentId" state={state}><SelectInput name="departmentId" state={state} options={departments} placeholder="Select…" /></Field>
            ) : <div />}
            <Field label="Aligns to" name="parentGoalId" state={state}><SelectInput name="parentGoalId" state={state} options={parents} placeholder="Nothing" /></Field>
          </div>
          <div className="grid grid-3">
            <Field label="Measured as" name="metricType" state={state}>
              <select name="metricType" className="select" value={metric} onChange={(e) => setMetric(e.target.value)}>
                <option value="PERCENTAGE">Percent complete</option><option value="COMPLETION">Done / not done</option>
                <option value="NUMBER_INCREASE">Number to increase</option><option value="NUMBER_DECREASE">Number to decrease</option><option value="CURRENCY">Amount (₹)</option>
              </select>
            </Field>
            {numeric ? <Field label="Starting value" name="startValue" state={state}><TextInput name="startValue" type="number" step="any" state={state} defaultValue={0} /></Field> : <div />}
            {numeric ? <Field label="Target" name="targetValue" state={state} required><TextInput name="targetValue" type="number" step="any" state={state} required /></Field> : <div />}
            <Field label="Starts" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} defaultValue={today()} required /></Field>
            <Field label="Due" name="dueDate" state={state} required><TextInput name="dueDate" type="date" state={state} defaultValue={fyEnd} required /></Field>
            <Field label="Weight in the parent" name="weight" state={state} hint="Only used for weighted roll-ups"><TextInput name="weight" type="number" state={state} /></Field>
            <Field label="Progress comes from" name="rollupMethod" state={state} hint="Once other goals align to this one">
              <SelectInput name="rollupMethod" state={state} defaultValue="AVERAGE" options={[
                { value: "AVERAGE", label: "Average of aligned goals" }, { value: "WEIGHTED", label: "Weighted average of aligned goals" }, { value: "MANUAL", label: "Its own measure" },
              ]} />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={2} /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function CheckIn({ goalId, metric, current }: { goalId: string; metric: string; current: number }) {
  const [state, action, pending] = useForm(checkInAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="goalId" value={goalId} />
      {metric === "COMPLETION" ? (
        <select name="value" className="select" defaultValue={String(current)} style={{ width: 110 }}><option value="0">Not done</option><option value="1">Done</option></select>
      ) : (
        <input className="input num" name="value" type="number" step="any" defaultValue={current} style={{ width: 90 }} aria-label="Current value" />
      )}
      <input className="input" name="note" placeholder="What changed?" style={{ width: 150 }} />
      <button className="btn sm" disabled={pending}>{pending ? "…" : "Check in"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ width: "100%", textAlign: "right" }}>{state.message}</div> : null}
    </form>
  );
}

export function GoalStatus({ goalId, cancelled }: { goalId: string; cancelled: boolean }) {
  const [, action, pending] = useForm(setGoalStatusAction);
  return (
    <form action={action}>
      <input type="hidden" name="goalId" value={goalId} />
      <button className="btn sm ghost" name="op" value={cancelled ? "reopen" : "cancel"} disabled={pending}>{cancelled ? "Reopen" : "Cancel"}</button>
    </form>
  );
}

export function PublishDraftGoal({ goalId }: { goalId: string }) {
  const [state, action, pending] = useForm(publishDraftGoalAction);
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="goalId" value={goalId} />
      <button className="btn sm primary" disabled={pending} style={{ alignSelf: "flex-start" }}>{pending ? "Publishing…" : "Publish this goal"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export function CycleForm() {
  return (
    <ActionForm action={createCycleAction} submitLabel="Create cycle">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Annual review 2026-27" /></Field>
          <Field label="Period starts" name="periodStart" state={state} required><TextInput name="periodStart" type="date" state={state} required /></Field>
          <Field label="Period ends" name="periodEnd" state={state} required><TextInput name="periodEnd" type="date" state={state} required /></Field>
          <Field label="Reviews close" name="reviewClosesAt" state={state}><TextInput name="reviewClosesAt" type="date" state={state} /></Field>
          <Field label="Self-review weight %" name="selfWeight" state={state} required><TextInput name="selfWeight" type="number" state={state} defaultValue={20} required /></Field>
          <Field label="Manager weight %" name="managerWeight" state={state} required><TextInput name="managerWeight" type="number" state={state} defaultValue={80} required /></Field>
          <Field label="Skip-level manager weight %" name="skipLevelWeight" state={state} hint="0 leaves them out"><TextInput name="skipLevelWeight" type="number" state={state} defaultValue={0} /></Field>
          <Field label="Peer weight %" name="peerWeight" state={state} hint="Peers are chosen by the employee, approved by their manager"><TextInput name="peerWeight" type="number" state={state} defaultValue={0} /></Field>
          <Field label="Direct report weight %" name="subordinateWeight" state={state} hint="Up to eight direct reports"><TextInput name="subordinateWeight" type="number" state={state} defaultValue={0} /></Field>
          <Field label="Peers per employee" name="maxPeers" state={state}><TextInput name="maxPeers" type="number" state={state} defaultValue={3} min={1} max={10} /></Field>
          <Field label="Peer and report feedback" name="anonymity" state={state}><SelectInput name="anonymity" state={state} defaultValue="anonymous" options={[{ value: "anonymous", label: "Anonymous" }, { value: "named", label: "Shown with names" }]} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function CycleOps({ cycleId, status }: { cycleId: string; status: string }) {
  const [state, action, pending] = useForm(cycleOpAction);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="cycleId" value={cycleId} />
      {status === "DRAFT" ? <button className="btn sm primary" name="op" value="launch" disabled={pending}>Launch</button> : null}
      {status === "IN_PROGRESS" || status === "CALIBRATION" ? <button className="btn sm primary" name="op" value="share" disabled={pending}>Share results</button> : null}
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function ReviewForm({ reviewId, reviewerType, indicators }: { reviewId: string; reviewerType: string; indicators: Array<{ id: string; name: string; category: string }> }) {
  const [state, action, pending] = useForm(submitReviewAction);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={action}>
      <FormBanner state={state} />
      <input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="reviewerType" value={reviewerType} />
      {indicators.length ? (
        <div className="stack gap-2" style={{ marginBottom: 14 }}>
          {indicators.map((i) => (
            <div key={i.id} className="row" style={{ justifyContent: "space-between", gap: 12 }}>
              <span className="text-sm">{i.name} <span className="text-xs subtle">· {i.category}</span></span>
              <select name={`indicator:${i.id}`} className="select" style={{ width: 150 }} defaultValue="">
                <option value="">Not rated</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} — {["", "Poor", "Below", "Meets", "Strong", "Exceptional"][n]}</option>)}
              </select>
            </div>
          ))}
        </div>
      ) : null}
      <Field label="Overall rating" name="overallRating" state={state} required>
        <div className="row gap-3 wrap">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="checkbox-row"><input type="radio" name="overallRating" value={n} required /><span className="text-sm">{n} · {["", "Below expectations", "Partly meets", "Meets", "Exceeds", "Outstanding"][n]}</span></label>
          ))}
        </div>
      </Field>
      <Field label={reviewerType === "SELF" ? "What went well" : reviewerType === "MANAGER" ? "Strengths" : "What they do well"} name="strengths" state={state} required={reviewerType === "MANAGER"}>
        <TextArea name="strengths" state={state} rows={4} />
      </Field>
      <Field label={reviewerType === "SELF" ? "What you would do differently" : reviewerType === "MANAGER" ? "Areas to improve" : "What they could do better"} name="improvements" state={state} required={reviewerType === "MANAGER"}>
        <TextArea name="improvements" state={state} rows={4} />
      </Field>
      <button className="btn primary" disabled={pending}>{pending ? "Submitting…" : "Submit — this cannot be edited afterwards"}</button>
    </form>
  );
}

export function CalibrateForm({ reviewId, raw }: { reviewId: string; raw: number | null }) {
  const [state, action, pending] = useForm(calibrateAction);
  const [value, setValue] = useState(raw ?? 3);
  const moved = raw !== null && Math.abs(value - raw) > 0.001;
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="reviewId" value={reviewId} />
      <input className="input num" name="finalRating" type="number" min={1} max={5} step={0.1} value={value} onChange={(e) => setValue(Number(e.target.value))} style={{ width: 70 }} />
      {moved ? <input className="input" name="reason" placeholder="Why it moved" required style={{ width: 160 }} /> : null}
      <button className="btn sm" disabled={pending}>{pending ? "…" : "Set"}</button>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ width: "100%", textAlign: "right" }}>{state.message}</div> : null}
    </form>
  );
}

export function AcknowledgeForm({ reviewId }: { reviewId: string }) {
  const [state, action, pending] = useForm(acknowledgeAction);
  if (state.ok) return <span className="text-sm pos">{state.message}</span>;
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <TextArea name="comments" placeholder="Anything you want on record about this review (optional)" rows={2} />
      <button className="btn primary sm" disabled={pending} style={{ alignSelf: "flex-start" }}>Acknowledge</button>
    </form>
  );
}

export function PipForm({ employees }: { employees: Option[] }) {
  const end = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  return (
    <ActionForm action={createPipAction} submitLabel="Start plan">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Employee" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required /></Field>
            <Field label="Starts" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} defaultValue={today()} required /></Field>
            <Field label="Ends" name="endDate" state={state} required hint="30 to 180 days"><TextInput name="endDate" type="date" state={state} defaultValue={end} required /></Field>
          </div>
          <Field label="Why" name="reason" state={state} required><TextArea name="reason" state={state} rows={2} required /></Field>
          <Field label="What success looks like" name="objectives" state={state} required><TextArea name="objectives" state={state} rows={3} required /></Field>
        </>
      )}
    </ActionForm>
  );
}

export function ClosePip({ id }: { id: string }) {
  const [state, action, pending] = useForm(closePipAction);
  return (
    <form action={action} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="id" value={id} />
      <input className="input" name="note" placeholder="Evidence for the outcome" style={{ width: 220 }} />
      <div className="row gap-2">
        <button className="btn sm" name="outcome" value="SUCCESSFUL" disabled={pending}>Successful</button>
        <button className="btn sm" name="outcome" value="EXTENDED" disabled={pending}>Extend 30 days</button>
        <button className="btn sm danger" name="outcome" value="UNSUCCESSFUL" disabled={pending}>Unsuccessful</button>
      </div>
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</div> : null}
    </form>
  );
}

export function NominatePeers({ reviewId, options, remaining, byManager }: { reviewId: string; options: Option[]; remaining: number; byManager: boolean }) {
  const [state, action, pending] = useForm(nominatePeersAction);
  const [picked, setPicked] = useState<string[]>([]);
  if (state.ok) return <div className="callout success"><div>{state.message}</div></div>;
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="reviewId" value={reviewId} />
      {picked.map((id) => <input key={id} type="hidden" name="peerIds" value={id} />)}
      <div className="row gap-2">
        <select className="select" value="" aria-label="Add a peer" onChange={(e) => { const v = e.target.value; if (v && !picked.includes(v) && picked.length < remaining) setPicked([...picked, v]); }}>
          <option value="">{picked.length < remaining ? "Add a peer…" : `Up to ${remaining} more`}</option>
          {options.filter((o) => !picked.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn primary" disabled={pending || picked.length === 0}>{byManager ? "Ask for feedback" : "Send to my manager"}</button>
      </div>
      {picked.length ? (
        <div className="row gap-1 wrap">
          {picked.map((id) => <button key={id} type="button" className="btn ghost sm" title="Remove" onClick={() => setPicked(picked.filter((p) => p !== id))}>{options.find((o) => o.value === id)?.label} ×</button>)}
        </div>
      ) : null}
    </form>
  );
}

export function DecideNomination({ reviewId, responseId }: { reviewId: string; responseId: string }) {
  const [state, action, pending] = useForm(decideNominationAction);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="row gap-1">
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="responseId" value={responseId} />
      <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
      <button className="btn sm ghost" name="decision" value="decline" disabled={pending}>Decline</button>
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}
