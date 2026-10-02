"use client";

import { useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import {
  planAllocationAction, allocationOpAction, raiseRequestAction, requestOpAction, saveBillingRoleAction, saveResourceProfileAction,
} from "@/app/actions/psa-resources";

type Opt = { value: string; label: string };
const sm = { padding: "4px 6px", fontSize: 13 } as const;

function Msg({ state }: { state: { ok?: boolean; message?: string } }) {
  return state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null;
}

/** Allocate someone to a project, hard or soft; from a request when `requestId` is set. */
export function AllocateForm({ projects, people, roles, requestId, defaults }: {
  projects: Opt[]; people: Opt[]; roles: string[]; requestId?: string;
  defaults?: { projectId?: string; employeeId?: string; billingRole?: string; allocationPercent?: number; startDate?: string; endDate?: string };
}) {
  const [state, action, pending] = useForm(planAllocationAction);
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      {requestId ? <input type="hidden" name="requestId" value={requestId} /> : null}
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        {requestId && defaults?.projectId ? <input type="hidden" name="projectId" value={defaults.projectId} /> : (
          <label className="stack gap-1"><span className="label">Project</span>
            <select className="select" name="projectId" required style={sm} defaultValue={defaults?.projectId ?? ""}><option value="">Choose…</option>{projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          </label>
        )}
        <label className="stack gap-1"><span className="label">Person</span>
          <select className="select" name="employeeId" required style={sm} defaultValue={defaults?.employeeId ?? ""}><option value="">Choose…</option>{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        </label>
        <label className="stack gap-1"><span className="label">Billing role</span>
          <select className="select" name="billingRole" required style={sm} defaultValue={defaults?.billingRole ?? ""}><option value="">Choose…</option>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </label>
        <label className="stack gap-1"><span className="label">Share %</span><input className="input num" name="allocationPercent" type="number" min={1} max={100} defaultValue={defaults?.allocationPercent ?? 100} style={{ ...sm, width: 70 }} required /></label>
        <label className="stack gap-1"><span className="label">From</span><input className="input" type="date" name="startDate" required defaultValue={defaults?.startDate} style={sm} /></label>
        <label className="stack gap-1"><span className="label">To</span><input className="input" type="date" name="endDate" defaultValue={defaults?.endDate} style={sm} /></label>
        <label className="stack gap-1"><span className="label">Bill rate/hr</span><input className="input num" name="billRate" type="number" min={0} step="0.01" style={{ ...sm, width: 90 }} /></label>
        <label className="stack gap-1"><span className="label">Kind</span>
          <select className="select" name="kind" style={sm} defaultValue="HARD"><option value="HARD">Hard (confirmed)</option><option value="SOFT">Soft (pencilled)</option></select>
        </label>
        <button className="btn primary" disabled={pending}>Allocate</button>
      </div>
    </form>
  );
}

export function AllocationOps({ id, soft }: { id: string; soft: boolean }) {
  const [state, action, pending] = useForm(allocationOpAction);
  return (
    <form action={action} className="row gap-1">
      <input type="hidden" name="id" value={id} />
      {soft ? <button className="btn ghost sm" name="op" value="confirm" disabled={pending}>Confirm</button> : null}
      <button className="btn ghost sm" name="op" value="remove" disabled={pending} onClick={(e) => { if (!confirm("Remove this allocation?")) e.preventDefault(); }}>Remove</button>
      <Msg state={state} />
    </form>
  );
}

export function RaiseRequest({ projects, roles, people }: { projects: Opt[]; roles: Opt[]; people: Opt[] }) {
  const [state, action, pending] = useForm(raiseRequestAction);
  const [type, setType] = useState("ROLE");
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        <label className="stack gap-1"><span className="label">Project</span><select className="select" name="projectId" required style={sm}><option value="">Choose…</option>{projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label className="stack gap-1"><span className="label">Ask for</span><select className="select" name="type" style={sm} value={type} onChange={(e) => setType(e.target.value)}><option value="ROLE">A role</option><option value="RESOURCE">A named person</option></select></label>
        <label className="stack gap-1"><span className="label">Billing role</span><select className="select" name="billingRoleId" required style={sm}><option value="">Choose…</option>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        {type === "RESOURCE" ? <label className="stack gap-1"><span className="label">Person</span><select className="select" name="employeeId" required style={sm}><option value="">Choose…</option>{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label> : null}
        <label className="stack gap-1"><span className="label">How many</span><input className="input num" type="number" name="count" min={1} max={50} defaultValue={1} style={{ ...sm, width: 60 }} /></label>
        <label className="stack gap-1"><span className="label">Share %</span><input className="input num" type="number" name="allocationPercent" min={1} max={100} defaultValue={100} style={{ ...sm, width: 70 }} /></label>
        <label className="stack gap-1"><span className="label">From</span><input className="input" type="date" name="startDate" required style={sm} /></label>
        <label className="stack gap-1"><span className="label">To</span><input className="input" type="date" name="endDate" style={sm} /></label>
        <label className="stack gap-1"><span className="label">Priority</span><select className="select" name="priority" defaultValue="MEDIUM" style={sm}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}</select></label>
      </div>
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        <label className="stack gap-1" style={{ flex: 1 }}><span className="label">Skills (comma separated)</span><input className="input" name="skills" style={sm} /></label>
        <label className="stack gap-1"><span className="label">Min. experience (yrs)</span><input className="input num" type="number" name="minExperienceYears" min={0} max={50} style={{ ...sm, width: 80 }} /></label>
        <label className="stack gap-1" style={{ flex: 1 }}><span className="label">Notes</span><input className="input" name="notes" style={sm} /></label>
        <button className="btn primary" disabled={pending}>Raise request</button>
      </div>
    </form>
  );
}

export function RequestOps({ id, canHire }: { id: string; canHire: boolean }) {
  const [state, action, pending] = useForm(requestOpAction);
  const [closing, setClosing] = useState(false);
  if (state.ok) return <Msg state={state} />;
  return (
    <form action={action} className="row gap-1 wrap">
      <input type="hidden" name="id" value={id} />
      {canHire ? <button className="btn ghost sm" name="op" value="hire" disabled={pending}>Send to hiring</button> : null}
      {closing ? (
        <>
          <input className="input" name="reason" placeholder="Reason" required style={{ ...sm, width: 160 }} aria-label="Reason" />
          <button className="btn danger sm" name="op" value="reject" disabled={pending}>Reject</button>
          <button className="btn sm" name="op" value="cancel" disabled={pending}>Cancel request</button>
        </>
      ) : <button type="button" className="btn ghost sm" onClick={() => setClosing(true)}>Close…</button>}
      <Msg state={state} />
    </form>
  );
}

export function BillingRoleForm({ role }: { role?: { id: string; name: string; description: string | null; isActive: boolean } }) {
  const [state, action, pending] = useForm(saveBillingRoleAction);
  return (
    <form action={action} className="row gap-2 wrap">
      {role ? <input type="hidden" name="id" value={role.id} /> : null}
      <input className="input" name="name" defaultValue={role?.name} placeholder="Role name" required style={{ ...sm, width: 180 }} aria-label="Role name" />
      <input className="input" name="description" defaultValue={role?.description ?? ""} placeholder="Description" style={{ ...sm, width: 240 }} aria-label="Description" />
      {role ? <><input type="hidden" name="isActive" value="off" /><label className="row gap-1 text-sm"><input type="checkbox" name="isActive" defaultChecked={role.isActive} /> Active</label></> : null}
      <button className="btn sm" disabled={pending}>{role ? "Save" : "Add role"}</button>
      <Msg state={state} />
    </form>
  );
}

export function ProfileForm({ employeeId, profile }: { employeeId: string; profile: { costType: string | null; costAmount: number | null; targetUtilization: number | null; capacity: number[] } }) {
  const [state, action, pending] = useForm(saveResourceProfileAction);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <form action={action} className="row gap-1 wrap" style={{ alignItems: "center" }}>
      <input type="hidden" name="employeeId" value={employeeId} />
      <select className="select" name="costType" defaultValue={profile.costType ?? ""} style={sm} aria-label="Cost type"><option value="">No cost</option><option value="HOURLY">Hourly</option><option value="MONTHLY">Monthly</option><option value="ANNUAL">Annual</option></select>
      <input className="input num" type="number" name="costAmount" min={0} step="0.01" defaultValue={profile.costAmount ?? ""} style={{ ...sm, width: 100 }} aria-label="Cost" placeholder="Cost" />
      <input className="input num" type="number" name="targetUtilization" min={0} max={100} defaultValue={profile.targetUtilization ?? ""} style={{ ...sm, width: 64 }} aria-label="Target utilisation %" placeholder="Target %" />
      {days.map((d, i) => <input key={d} className="input num" type="number" name={`cap${i}`} min={0} max={24} step="0.5" defaultValue={profile.capacity[i]} title={`${d} hours`} aria-label={`${d} hours`} style={{ ...sm, width: 46 }} />)}
      <button className="btn sm" disabled={pending}>Save</button>
      <Msg state={state} />
    </form>
  );
}
