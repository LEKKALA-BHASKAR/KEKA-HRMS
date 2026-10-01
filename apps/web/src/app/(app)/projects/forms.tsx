"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import {
  saveTimesheetAction, decideTimesheetAction, saveProjectAction, allocateAction, createTaskAction, taskStatusAction,
  milestoneAction, saveClientAction, invoiceAction,
} from "@/app/actions/projects";

export interface Option { value: string; label: string }
export interface SheetRow { projectId: string; taskId: string; hours: number[]; note: string }
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A week of time, one row per project and task. Hours are quarter-hour
 * precise; days after today are closed; totals update as you type.
 */
export function TimesheetGrid({ week, dates, rows: initial, projects, tasks, editable }: {
  week: string; dates: string[]; rows: SheetRow[];
  projects: Option[]; tasks: Array<Option & { projectId: string }>; editable: boolean;
}) {
  const [state, action, pending] = useForm(saveTimesheetAction);
  const blank = (): SheetRow => ({ projectId: projects.length === 1 ? projects[0].value : "", taskId: "", hours: [0, 0, 0, 0, 0, 0, 0], note: "" });
  const [rows, setRows] = useState<SheetRow[]>(initial.length ? initial : [blank()]);
  const set = (i: number, patch: Partial<SheetRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dayTotal = (d: number) => rows.reduce((s, r) => s + (r.hours[d] || 0), 0);
  const total = rows.reduce((s, r) => s + r.hours.reduce((a, b) => a + (b || 0), 0), 0);
  const future = (d: number) => dates[d] > today();
  return (
    <form action={action}>
      <input type="hidden" name="week" value={week} />
      <FormBanner state={state} />
      <div className="table-wrap">
        <table className="data timesheet">
          <thead>
            <tr>
              <th style={{ minWidth: 180 }}>Project</th><th style={{ minWidth: 150 }}>Task</th>
              {DAYS.map((d, i) => <th key={d} className="num" style={{ minWidth: 58 }}>{d}<div className="text-xs subtle">{dates[i].slice(8)}</div></th>)}
              <th className="num">Total</th><th style={{ minWidth: 140 }}>Note</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <select className="select" name={`project_${i}`} value={r.projectId} disabled={!editable} aria-label="Project"
                    onChange={(e) => set(i, { projectId: e.target.value, taskId: "" })}>
                    <option value="">Select…</option>
                    {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </td>
                <td>
                  <select className="select" name={`task_${i}`} value={r.taskId} disabled={!editable || !r.projectId} aria-label="Task"
                    onChange={(e) => set(i, { taskId: e.target.value })}>
                    <option value="">General</option>
                    {tasks.filter((t) => t.projectId === r.projectId).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </td>
                {DAYS.map((d, k) => (
                  <td key={d} className="num">
                    <input className="input num" name={`h_${i}_${k}`} type="number" min={0} max={24} step={0.25} aria-label={`${d} hours`}
                      value={r.hours[k] || ""} disabled={!editable || future(k)} style={{ width: 58, padding: "4px 6px" }}
                      onChange={(e) => set(i, { hours: r.hours.map((h, j) => (j === k ? Number(e.target.value) : h)) })} />
                  </td>
                ))}
                <td className="num strong">{r.hours.reduce((a, b) => a + (b || 0), 0) || ""}</td>
                <td><input className="input" name={`note_${i}`} value={r.note} disabled={!editable} aria-label="Note" onChange={(e) => set(i, { note: e.target.value })} /></td>
                <td>{editable && rows.length > 1 ? <button type="button" className="btn sm ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row">×</button> : null}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="strong">Day total</td>
              {DAYS.map((d, k) => <td key={d} className="num" style={{ color: dayTotal(k) > 12 ? "var(--warning)" : undefined }}>{dayTotal(k) || ""}</td>)}
              <td className="num strong">{total}</td><td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      {editable ? (
        <div className="row gap-2 wrap" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <button type="button" className="btn sm" onClick={() => setRows([...rows, blank()])} disabled={projects.length === 0}>+ Add a row</button>
          <div className="row gap-2">
            <button className="btn" name="intent" value="save" disabled={pending}>Save draft</button>
            <button className="btn primary" name="intent" value="submit" disabled={pending || total === 0}>{pending ? "Saving…" : `Submit ${total} h`}</button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

export function TimesheetDecision({ timesheetId }: { timesheetId: string }) {
  const [state, action, pending] = useForm(decideTimesheetAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="timesheetId" value={timesheetId} />
      {state.message ? <span className="text-xs neg">{state.message}</span> : null}
      {rejecting ? (
        <>
          <input className="input" name="reason" placeholder="What needs fixing" required style={{ width: 200 }} />
          <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Send back</button>
          <button type="button" className="btn sm ghost" onClick={() => setRejecting(false)}>Back</button>
        </>
      ) : (
        <>
          <button className="btn sm primary" name="decision" value="approve" disabled={pending}>{pending ? "…" : "Approve"}</button>
          <button type="button" className="btn sm" onClick={() => setRejecting(true)}>Send back</button>
        </>
      )}
    </form>
  );
}

export function TaskStatus({ taskId, status }: { taskId: string; status: string }) {
  const [state, action, pending] = useForm(taskStatusAction);
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <select className="select" name="status" defaultValue={status} aria-label="Task status" disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()} style={{ padding: "3px 6px", fontSize: 12 }}>
        {["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
      </select>
      {state.message && !state.ok ? <span className="text-xs neg">{state.message}</span> : null}
    </form>
  );
}

export interface ProjectValues {
  id?: string; name?: string; code?: string | null; clientId?: string | null; description?: string | null; billingModel?: string; status?: string;
  startDate?: string | null; endDate?: string | null; estimatedHours?: number | null; budget?: number | null; retainerFee?: number | null; projectManagerId?: string | null;
}

export function ProjectForm({ project, clients, people }: { project?: ProjectValues; clients: Option[]; people: Option[] }) {
  const [model, setModel] = useState(project?.billingModel ?? "TIME_AND_MATERIAL");
  return (
    <ActionForm action={saveProjectAction} submitLabel={project?.id ? "Save project" : "Create project"} hidden={project?.id ? { id: project.id } : undefined}>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={project?.name} required /></Field>
          <Field label="Code" name="code" state={state}><TextInput name="code" state={state} defaultValue={project?.code} placeholder="ACM-12" /></Field>
          <Field label="Billing" name="billingModel" state={state} required>
            <select className="select" name="billingModel" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="TIME_AND_MATERIAL">Time and material</option><option value="MILESTONE">Fixed — milestones</option>
              <option value="RETAINER">Monthly retainer</option><option value="NON_BILLABLE">Internal (not billed)</option>
            </select>
          </Field>
          <Field label="Client" name="clientId" state={state} required={model !== "NON_BILLABLE"}><SelectInput name="clientId" state={state} options={clients} defaultValue={project?.clientId} placeholder="None" /></Field>
          <Field label="Project manager" name="projectManagerId" state={state}><SelectInput name="projectManagerId" state={state} options={people} defaultValue={project?.projectManagerId} placeholder="None" /></Field>
          <Field label="Status" name="status" state={state}>
            <SelectInput name="status" state={state} defaultValue={project?.status ?? "ACTIVE"} options={["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"].map((s) => ({ value: s, label: s.replace("_", " ").toLowerCase() }))} />
          </Field>
          <Field label="Starts" name="startDate" state={state}><TextInput name="startDate" type="date" state={state} defaultValue={project?.startDate} /></Field>
          <Field label="Ends" name="endDate" state={state}><TextInput name="endDate" type="date" state={state} defaultValue={project?.endDate} /></Field>
          <Field label="Budget hours" name="estimatedHours" state={state} hint="Health compares hours burned with time elapsed"><TextInput name="estimatedHours" type="number" state={state} defaultValue={project?.estimatedHours} /></Field>
          <Field label="Budget (₹)" name="budget" state={state}><TextInput name="budget" type="number" state={state} defaultValue={project?.budget} /></Field>
          {model === "RETAINER" ? <Field label="Retainer per month (₹)" name="retainerFee" state={state} required><TextInput name="retainerFee" type="number" state={state} defaultValue={project?.retainerFee} required /></Field> : null}
          <div style={{ gridColumn: "1 / -1" }}><Field label="Description" name="description" state={state}><TextArea name="description" state={state} defaultValue={project?.description} rows={2} /></Field></div>
        </div>
      )}
    </ActionForm>
  );
}

export function AllocateForm({ projectId, people, billable }: { projectId: string; people: Option[]; billable: boolean }) {
  return (
    <ActionForm action={allocateAction} submitLabel="Allocate" hidden={{ projectId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Person" name="employeeId" state={state} required><SelectInput name="employeeId" state={state} options={people} placeholder="Select…" required /></Field>
          <Field label="Role on the project" name="billingRole" state={state}><TextInput name="billingRole" state={state} placeholder="Senior engineer" /></Field>
          <Field label="Allocation %" name="allocationPercent" state={state} required hint="Across all projects, at most 100%"><TextInput name="allocationPercent" type="number" state={state} defaultValue={100} min={1} max={100} required /></Field>
          <Field label="Bill rate (₹/h)" name="billRate" state={state} required={billable}><TextInput name="billRate" type="number" state={state} /></Field>
          <Field label="Cost rate (₹/h)" name="costRate" state={state}><TextInput name="costRate" type="number" state={state} /></Field>
          <div style={{ paddingTop: 22 }}><CheckboxInput name="isBillable" label="Billable time" defaultChecked={billable} /></div>
          <Field label="From" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} defaultValue={today()} required /></Field>
          <Field label="Until" name="endDate" state={state}><TextInput name="endDate" type="date" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function TaskForm({ projectId, people }: { projectId: string; people: Option[] }) {
  return (
    <ActionForm action={createTaskAction} submitLabel="Add task" hidden={{ projectId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <div style={{ gridColumn: "span 2" }}><Field label="Task" name="title" state={state} required><TextInput name="title" state={state} required /></Field></div>
          <Field label="Assignee" name="assigneeId" state={state}><SelectInput name="assigneeId" state={state} options={people} placeholder="Unassigned" /></Field>
          <Field label="Priority" name="priority" state={state}><SelectInput name="priority" state={state} defaultValue="MEDIUM" options={["LOW", "MEDIUM", "HIGH", "URGENT"].map((p) => ({ value: p, label: p.toLowerCase() }))} /></Field>
          <Field label="Estimate (h)" name="estimatedHours" state={state}><TextInput name="estimatedHours" type="number" state={state} /></Field>
          <Field label="Due" name="dueDate" state={state}><TextInput name="dueDate" type="date" state={state} /></Field>
          <CheckboxInput name="isBillable" label="Billable" defaultChecked />
        </div>
      )}
    </ActionForm>
  );
}

export function MilestoneForm({ projectId, priced }: { projectId: string; priced: boolean }) {
  const [state, action, pending] = useForm(milestoneAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="op" value="add" />
      <div className="field" style={{ flex: 2, minWidth: 180 }}><label className="label" htmlFor="ms-name">Milestone</label><input id="ms-name" className="input" name="name" required /></div>
      <div className="field"><label className="label" htmlFor="ms-due">Due</label><input id="ms-due" className="input" type="date" name="dueDate" required /></div>
      {priced ? <div className="field"><label className="label" htmlFor="ms-amt">Amount (₹)</label><input id="ms-amt" className="input num" type="number" name="amount" min={0} /></div> : null}
      <button className="btn sm primary" disabled={pending}>{pending ? "…" : "Add"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function MilestoneComplete({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const [state, action, pending] = useForm(milestoneAction);
  if (state.ok) return <span className="text-xs pos">Done</span>;
  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="milestoneId" value={milestoneId} />
      <button className="btn sm" name="op" value="complete" disabled={pending}>Mark complete</button>
    </form>
  );
}

export function ClientForm() {
  return (
    <ActionForm action={saveClientAction} submitLabel="Add client" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required /></Field>
          <Field label="Code" name="code" state={state}><TextInput name="code" state={state} /></Field>
          <Field label="Country" name="countryCode" state={state} hint="Outside India is billed as an export, zero-rated"><SelectInput name="countryCode" state={state} defaultValue="IN" options={[{ value: "IN", label: "India" }, { value: "US", label: "United States" }, { value: "GB", label: "United Kingdom" }, { value: "SG", label: "Singapore" }, { value: "AE", label: "UAE" }]} /></Field>
          <Field label="State" name="state" state={state} hint="Place of supply — same state as us is CGST + SGST"><TextInput name="state" state={state} placeholder="Karnataka" /></Field>
          <Field label="City" name="city" state={state}><TextInput name="city" state={state} /></Field>
          <Field label="GSTIN" name="gstin" state={state}><TextInput name="gstin" state={state} placeholder="29ABCDE1234F1Z5" maxLength={15} /></Field>
          <Field label="Billing contact" name="contactName" state={state}><TextInput name="contactName" state={state} /></Field>
          <Field label="Contact email" name="contactEmail" state={state} hint="Invoices are emailed here"><TextInput name="contactEmail" type="email" state={state} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function InvoiceDraftForm({ projectId, from, to }: { projectId: string; from: string; to: string }) {
  const [state, action, pending] = useForm(invoiceAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="op" value="draft" /><input type="hidden" name="projectId" value={projectId} />
      <div className="field"><label className="label" htmlFor="inv-from">Period from</label><input id="inv-from" className="input" type="date" name="from" defaultValue={from} required /></div>
      <div className="field"><label className="label" htmlFor="inv-to">to</label><input id="inv-to" className="input" type="date" name="to" defaultValue={to} required /></div>
      <button className="btn sm primary" disabled={pending}>{pending ? "Drafting…" : "Draft invoice"}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

export function InvoiceOps({ invoiceId, status, due }: { invoiceId: string; status: string; due: number }) {
  const [state, action, pending] = useForm(invoiceAction);
  return (
    <form action={action} className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {status === "DRAFT" ? <button className="btn sm primary" name="op" value="send" disabled={pending}>{pending ? "Sending…" : "Send"}</button> : null}
      {["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(status) ? (
        <>
          <input className="input num" name="amount" type="number" step="0.01" min={0.01} max={due} defaultValue={due} aria-label="Amount received" style={{ width: 120 }} />
          <input className="input" name="reference" placeholder="UTR / ref" aria-label="Payment reference" style={{ width: 110 }} />
          <button className="btn sm" name="op" value="payment" disabled={pending}>Record payment</button>
        </>
      ) : null}
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}
