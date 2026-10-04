"use client";

import { useState } from "react";
import { useForm } from "@/components/form";
import type { ActionState } from "@/lib/forms";

/**
 * Small declarative forms for the governance pages (workflows, security,
 * compliance): the server page describes the fields, the action does the
 * work. Field errors from the action render under their inputs.
 */

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;
export interface Option { value: string; label: string }
export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "datetime-local" | "textarea" | "select" | "checkbox" | "multiselect" | "file" | "email";
  options?: Option[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean | string[] | null;
  hint?: string;
  /** Span the whole row. */
  wide?: boolean;
  /** File inputs: accept several files. */
  multiple?: boolean;
}

function Input({ f, state }: { f: FieldSpec; state: ActionState }) {
  const echoed = state.values?.[f.name];
  const dv = echoed ?? (f.defaultValue === null || f.defaultValue === undefined || typeof f.defaultValue === "boolean" || Array.isArray(f.defaultValue) ? undefined : String(f.defaultValue));
  const err = state.errors?.[f.name];
  const style = err ? { borderColor: "var(--danger)" } : undefined;
  switch (f.type) {
    case "textarea": return <textarea id={f.name} name={f.name} className="textarea" rows={3} defaultValue={dv} required={f.required} placeholder={f.placeholder} style={style} />;
    case "select": return (
      <select id={f.name} name={f.name} className="select" defaultValue={dv ?? ""} required={f.required} style={style}>
        {!f.required || f.placeholder ? <option value="">{f.placeholder ?? "—"}</option> : null}
        {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
    case "multiselect": return (
      <div className="stack" style={{ maxHeight: 160, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
        {(f.options ?? []).map((o) => (
          <label key={o.value} className="row gap-2 text-sm"><input type="checkbox" name={f.name} value={o.value} defaultChecked={Array.isArray(f.defaultValue) && f.defaultValue.includes(o.value)} /> {o.label}</label>
        ))}
      </div>
    );
    case "checkbox": return <label className="row gap-2 text-sm"><input type="checkbox" id={f.name} name={f.name} defaultChecked={f.defaultValue === true} /> {f.placeholder ?? "Yes"}</label>;
    case "file": return <input id={f.name} name={f.name} type="file" className="input" required={f.required} multiple={f.multiple} />;
    default: return <input id={f.name} name={f.name} type={f.type ?? "text"} className={`input${f.type === "number" ? " num" : ""}`} defaultValue={dv} required={f.required} placeholder={f.placeholder} step={f.type === "number" ? "any" : undefined} style={style} />;
  }
}

/** A form from a field list. */
export function SpecForm({ action, fields, submitLabel = "Save", hidden, columns = 2 }: { action: Action; fields: FieldSpec[]; submitLabel?: string; hidden?: Record<string, string>; columns?: 1 | 2 | 3 }) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form action={formAction}>
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`} style={{ marginBottom: 12 }}><div>{state.message}</div></div> : null}
      <div className={columns === 1 ? "stack gap-2" : `grid grid-${columns}`}>
        {fields.map((f) => (
          <div key={f.name} className="field" style={f.wide && columns > 1 ? { gridColumn: "1 / -1" } : undefined}>
            <label className="label" htmlFor={f.name}>{f.label}{f.required ? <span style={{ color: "var(--danger)" }}> *</span> : null}</label>
            <Input f={f} state={state} />
            {state.errors?.[f.name] ? <div className="text-xs" style={{ color: "var(--danger)", marginTop: 4 }}>{state.errors[f.name]}</div> : f.hint ? <div className="hint">{f.hint}</div> : null}
          </div>
        ))}
      </div>
      <div className="row gap-2" style={{ marginTop: 10 }}>
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}

/** One button (optionally with a short text input) posting hidden values. */
export function ActButton({ action, hidden, label, variant, confirmText, input, formId }: {
  action: Action; hidden: Record<string, string>; label: string; variant?: "primary" | "danger" | "ghost";
  confirmText?: string; input?: { name: string; placeholder: string; required?: boolean };
  /** Lets inputs elsewhere on the page join this form (their form="..." attribute), e.g. bulk checkboxes. */
  formId?: string;
}) {
  const [state, formAction, pending] = useForm(action);
  return (
    <form id={formId} action={formAction} className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}
      onSubmit={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {input ? <input className="input" name={input.name} placeholder={input.placeholder} required={input.required} style={{ width: 200 }} /> : null}
      <button className={`btn sm ${variant ?? ""}`} type="submit" disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Workflow step designer
// ---------------------------------------------------------------------------

export interface StepRow {
  name: string; approverType: string; approverRoleId: string; approverUserId: string; approverPermission: string; mode: string;
  conditionField: string; conditionOp: string; conditionValue: string; slaHours: string; escalateTo: string; escalateUserId: string;
}
const blank: StepRow = { name: "", approverType: "REPORTING_MANAGER", approverRoleId: "", approverUserId: "", approverPermission: "", mode: "ANY", conditionField: "", conditionOp: "", conditionValue: "", slaHours: "", escalateTo: "", escalateUserId: "" };

export function WorkflowDesigner({ action, hidden, header, initialSteps, options }: {
  action: Action; hidden?: Record<string, string>; header: FieldSpec[]; initialSteps: StepRow[];
  options: { approverTypes: Option[]; roles: Option[]; users: Option[]; permissions: Option[]; conditionFields: Option[]; conditionOps: Option[]; departments: Option[]; locations: Option[] };
}) {
  const [state, formAction, pending] = useForm(action);
  const [steps, setSteps] = useState<StepRow[]>(initialSteps.length ? initialSteps : [{ ...blank, name: "Reporting manager" }]);
  const set = (i: number, patch: Partial<StepRow>) => setSteps((s) => s.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => setSteps((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const sel = (name: string, value: string, opts: Option[], onChange: (v: string) => void, placeholder = "—") => (
    <select className="select" name={name} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const condValues = (field: string) => field === "department" ? options.departments : field === "location" ? options.locations : field === "privileged" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : null;
  return (
    <form action={formAction} className="stack gap-4">
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`}><div>{state.message}</div></div> : null}
      <div className="grid grid-3">
        {header.map((f) => (
          <div key={f.name} className="field" style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
            <label className="label" htmlFor={f.name}>{f.label}{f.required ? <span style={{ color: "var(--danger)" }}> *</span> : null}</label>
            <Input f={f} state={state} />
            {f.hint ? <div className="hint">{f.hint}</div> : null}
          </div>
        ))}
      </div>
      <div className="stack gap-2" aria-label="Steps">
        <div className="text-sm"><strong>Steps</strong> <span className="muted">— run top to bottom; a step whose condition does not hold is skipped.</span></div>
        <div className="row gap-2 wrap" style={{ alignItems: "center" }} aria-hidden="true">
          <span className="badge neutral">Submitted</span>
          {steps.map((s, i) => <span key={i} className="row gap-2" style={{ alignItems: "center" }}><span className="muted">→</span><span className={`badge ${s.conditionField ? "warning" : "info"}`}>{i + 1}. {s.name || "Unnamed"}{s.mode === "ALL" ? " (all)" : ""}</span></span>)}
          <span className="muted">→</span><span className="badge success">Approved</span>
        </div>
        {steps.map((s, i) => (
          <div key={i} className="card" style={{ padding: 12 }}>
            <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong className="text-sm">Step {i + 1}</strong>
              <div className="row gap-2">
                <button type="button" className="btn sm ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="btn sm ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
                <button type="button" className="btn sm ghost" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} disabled={steps.length === 1}>Remove</button>
              </div>
            </div>
            <div className="grid grid-3">
              <div className="field"><label className="label">Name</label><input className="input" name="step_name" value={s.name} onChange={(e) => set(i, { name: e.target.value })} required /></div>
              <div className="field"><label className="label">Approver</label>{sel("step_approverType", s.approverType, options.approverTypes, (v) => set(i, { approverType: v }), "Pick…")}</div>
              <div className="field">
                <label className="label">{s.approverType === "ROLE" ? "Role" : s.approverType === "USER" ? "Person" : s.approverType === "PERMISSION" ? "Permission" : "Who"}</label>
                {s.approverType === "ROLE" ? sel("step_approverRoleId", s.approverRoleId, options.roles, (v) => set(i, { approverRoleId: v })) : <input type="hidden" name="step_approverRoleId" value="" />}
                {s.approverType === "USER" ? sel("step_approverUserId", s.approverUserId, options.users, (v) => set(i, { approverUserId: v })) : <input type="hidden" name="step_approverUserId" value="" />}
                {s.approverType === "PERMISSION" ? sel("step_approverPermission", s.approverPermission, options.permissions, (v) => set(i, { approverPermission: v })) : <input type="hidden" name="step_approverPermission" value="" />}
                {!["ROLE", "USER", "PERMISSION"].includes(s.approverType) ? <div className="hint">Resolved from the requester when the step starts.</div> : null}
              </div>
              <div className="field"><label className="label">Decision</label>{sel("step_mode", s.mode, [{ value: "ANY", label: "Any one approver (parallel-any)" }, { value: "ALL", label: "Every approver (parallel-all)" }], (v) => set(i, { mode: v || "ANY" }))}</div>
              <div className="field"><label className="label">Only when</label>
                <div className="row gap-2">
                  {sel("step_conditionField", s.conditionField, options.conditionFields, (v) => set(i, { conditionField: v, conditionValue: "" }), "Always")}
                  {s.conditionField ? sel("step_conditionOp", s.conditionOp, s.conditionField === "amount" ? options.conditionOps : options.conditionOps.filter((o) => o.value === "EQ" || o.value === "NEQ"), (v) => set(i, { conditionOp: v })) : <input type="hidden" name="step_conditionOp" value="" />}
                  {s.conditionField ? (condValues(s.conditionField)
                    ? sel("step_conditionValue", s.conditionValue, condValues(s.conditionField)!, (v) => set(i, { conditionValue: v }))
                    : <input className="input" name="step_conditionValue" value={s.conditionValue} onChange={(e) => set(i, { conditionValue: e.target.value })} placeholder={s.conditionField === "amount" ? "50000" : "value"} style={{ width: 110 }} />)
                    : <input type="hidden" name="step_conditionValue" value="" />}
                </div>
              </div>
              <div className="field"><label className="label">SLA (hours) and escalation</label>
                <div className="row gap-2">
                  <input className="input num" name="step_slaHours" value={s.slaHours} onChange={(e) => set(i, { slaHours: e.target.value })} placeholder="none" style={{ width: 80 }} />
                  {sel("step_escalateTo", s.escalateTo, [{ value: "MANAGER_OF_APPROVER", label: "Approver's manager" }, { value: "USER", label: "A person" }, { value: "ADMINS", label: "Workflow admins" }], (v) => set(i, { escalateTo: v }), "No escalation")}
                  {s.escalateTo === "USER" ? sel("step_escalateUserId", s.escalateUserId, options.users, (v) => set(i, { escalateUserId: v })) : <input type="hidden" name="step_escalateUserId" value="" />}
                </div>
              </div>
            </div>
          </div>
        ))}
        <div><button type="button" className="btn sm" onClick={() => setSteps((x) => [...x, { ...blank, name: `Step ${x.length + 1}` }])} disabled={steps.length >= 10}>+ Add step</button></div>
      </div>
      <div><button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save workflow"}</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Automation action editor
// ---------------------------------------------------------------------------

export interface ActionRow { type: string; to: string; subject: string; body: string; endpointId: string; templateId: string; dueInDays: string }
const blankAction: ActionRow = { type: "NOTIFY", to: "EMPLOYEE", subject: "", body: "", endpointId: "", templateId: "", dueInDays: "" };

export function AutomationEditor({ action, hidden, header, initialActions, options }: {
  action: Action; hidden?: Record<string, string>; header: FieldSpec[]; initialActions: ActionRow[];
  options: { types: Option[]; recipients: Option[]; endpoints: Option[]; templates: Option[] };
}) {
  const [state, formAction, pending] = useForm(action);
  const [rows, setRows] = useState<ActionRow[]>(initialActions.length ? initialActions : [blankAction]);
  const set = (i: number, patch: Partial<ActionRow>) => setRows((s) => s.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <form action={formAction} className="stack gap-4">
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {state.message ? <div className={`callout ${state.ok ? "success" : "danger"}`}><div>{state.message}</div></div> : null}
      <div className="grid grid-3">
        {header.map((f) => (
          <div key={f.name} className="field" style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
            <label className="label" htmlFor={f.name}>{f.label}{f.required ? <span style={{ color: "var(--danger)" }}> *</span> : null}</label>
            <Input f={f} state={state} />
            {f.hint ? <div className="hint">{f.hint}</div> : null}
          </div>
        ))}
      </div>
      <div className="text-sm"><strong>Then</strong> <span className="muted">— placeholders: {"{{name}} {{first_name}} {{employee_number}} {{department}} {{manager}} {{date}} {{title}}"}</span></div>
      {rows.map((r, i) => (
        <div key={i} className="card" style={{ padding: 12 }}>
          <div className="grid grid-3">
            <div className="field"><label className="label">Action</label>
              <select className="select" name="act_type" value={r.type} onChange={(e) => set(i, { type: e.target.value })}>{options.types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            <div className="field"><label className="label">{r.type === "TASK" ? "Assign to" : "To"}</label>
              {r.type === "WEBHOOK" ? <select className="select" name="act_endpointId" value={r.endpointId} onChange={(e) => set(i, { endpointId: e.target.value })}><option value="">Pick an endpoint…</option>{options.endpoints.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input type="hidden" name="act_endpointId" value="" />}
              {r.type === "LETTER" ? <select className="select" name="act_templateId" value={r.templateId} onChange={(e) => set(i, { templateId: e.target.value })}><option value="">Pick a template…</option>{options.templates.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input type="hidden" name="act_templateId" value="" />}
              {r.type !== "WEBHOOK" && r.type !== "LETTER"
                ? <input className="input" name="act_to" list="gov-recipients" value={r.to} onChange={(e) => set(i, { to: e.target.value })} placeholder="EMPLOYEE, MANAGER, HR or an email" />
                : <input type="hidden" name="act_to" value="" />}
            </div>
            <div className="field"><label className="label">Due in (days, tasks)</label><input className="input num" name="act_dueInDays" value={r.dueInDays} onChange={(e) => set(i, { dueInDays: e.target.value })} readOnly={r.type !== "TASK"} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label className="label">Subject / title</label><input className="input" name="act_subject" value={r.subject} onChange={(e) => set(i, { subject: e.target.value })} placeholder="e.g. {{name}}'s probation ends on {{date}}" /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label className="label">Message</label><textarea className="textarea" name="act_body" rows={2} value={r.body} onChange={(e) => set(i, { body: e.target.value })} /></div>
          </div>
          <button type="button" className="btn sm ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} disabled={rows.length === 1}>Remove action</button>
        </div>
      ))}
      <datalist id="gov-recipients">{options.recipients.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
      <div className="row gap-2">
        <button type="button" className="btn sm" onClick={() => setRows((x) => [...x, blankAction])} disabled={rows.length >= 6}>+ Add action</button>
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save rule"}</button>
      </div>
    </form>
  );
}
