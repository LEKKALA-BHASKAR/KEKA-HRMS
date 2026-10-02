"use client";

import { useState } from "react";
import {
  ActionForm, InlineForm, DangerButton, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm,
} from "@/components/form";
import {
  initiateExitAction, resignAction, decideExitAction, withdrawExitAction,
  draftSettlementAction, finalizeSettlementAction,
  setTaskAction, recheckJourneyAction, startJourneyAction, saveTemplateAction,
  addTemplateTaskAction, deleteTemplateTaskAction,
  raiseTicketAction, replyTicketAction, ticketStatusAction, rateTicketAction, saveCategoryAction,
  markNotificationsReadAction,
} from "@/app/actions/lifecycle";

export interface Option { value: string; label: string }

const label = (v: string) => v.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const opts = (xs: readonly string[]) => xs.map((v) => ({ value: v, label: label(v) }));
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
//  EXITS
// ---------------------------------------------------------------------------

export function InitiateExitForm({ employees, canRecordAll, reasons = [] }: { employees: Option[]; canRecordAll: boolean; reasons?: Option[] }) {
  const types = canRecordAll
    ? ["RESIGNATION", "TERMINATION", "RETIREMENT", "END_OF_CONTRACT", "ABSCONDING", "DEATH"] as const
    : ["RESIGNATION"] as const;
  return (
    <ActionForm action={initiateExitAction} submitLabel="Initiate exit">
      {(state) => (
        <>
          <Field label="Employee" name="employeeId" state={state} required>
            <SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required />
          </Field>
          <div className="grid grid-3">
            <Field label="Type" name="type" state={state}>
              <SelectInput name="type" state={state} options={opts(types)} />
            </Field>
            <Field label="Notice given on" name="noticeDate" state={state} required>
              <TextInput name="noticeDate" type="date" state={state} defaultValue={today()} required />
            </Field>
            <Field label="Last working day" name="lastWorkingDay" state={state} hint="Blank uses the notice policy">
              <TextInput name="lastWorkingDay" type="date" state={state} />
            </Field>
          </div>
          {reasons.length ? (
            <Field label="Reason" name="reasonId" state={state}>
              <SelectInput name="reasonId" state={state} options={reasons} placeholder="Select…" />
            </Field>
          ) : null}
          <Field label={reasons.length ? "Comments" : "Reason"} name="reason" state={state}>
            <TextArea name="reason" state={state} rows={2} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function ResignForm({ policyLwd, noticeDays, reasons = [] }: { policyLwd: string; noticeDays: number; reasons?: Option[] }) {
  return (
    <ActionForm action={resignAction} submitLabel="Submit resignation">
      {(state) => (
        <>
          <Field label="Proposed last working day" name="lastWorkingDay" state={state}
            hint={`Your notice period is ${noticeDays} days, ending ${policyLwd}. An earlier date may mean a notice recovery.`}>
            <TextInput name="lastWorkingDay" type="date" state={state} defaultValue={policyLwd} />
          </Field>
          {reasons.length ? (
            <Field label="Main reason" name="reasonId" state={state} required>
              <SelectInput name="reasonId" state={state} options={reasons} placeholder="Select…" required />
            </Field>
          ) : null}
          <Field label={reasons.length ? "Anything you'd like to add" : "Reason"} name="reason" state={state} required={!reasons.length}>
            <TextArea name="reason" state={state} rows={3} required={!reasons.length} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function ExitDecisionForm({ exitId, lastWorkingDay }: { exitId: string; lastWorkingDay: string }) {
  const [state, formAction, pending] = useForm(decideExitAction);
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <input type="hidden" name="exitId" value={exitId} />
      <input type="hidden" name="isRehireEligibleShown" value="1" />
      <div className="grid grid-2">
        <Field label="Last working day" name="lastWorkingDay" state={state}>
          <TextInput name="lastWorkingDay" type="date" state={state} defaultValue={lastWorkingDay} />
        </Field>
        <div style={{ paddingTop: 22 }}>
          <CheckboxInput name="isRehireEligible" label="Eligible for rehire" defaultChecked />
        </div>
      </div>
      <Field label="Discussion note" name="note" state={state}>
        <TextArea name="note" state={state} rows={2} placeholder="Outcome of the conversation with the employee" />
      </Field>
      <div className="row gap-2">
        <button className="btn primary" name="decision" value="approve" disabled={pending}>Accept</button>
        <button className="btn" name="decision" value="retain" disabled={pending}>Retained</button>
        <button className="btn danger" name="decision" value="reject" disabled={pending}>Reject</button>
      </div>
    </form>
  );
}

export function WithdrawExitButton({ exitId }: { exitId: string }) {
  return <DangerButton action={withdrawExitAction} hidden={{ exitId }} label="Withdraw exit"
    confirmLabel="Withdraw this exit? The employee becomes active again and the exit checklist is cancelled." />;
}

export function DraftSettlementForm({ employeeId, drafted, waived }: { employeeId: string; drafted: boolean; waived: boolean }) {
  return (
    <ActionForm action={draftSettlementAction} hidden={{ employeeId }} submitLabel={drafted ? "Recompute" : "Compute settlement"} compact>
      {() => <CheckboxInput name="waiveNoticeRecovery" label="Waive any notice-period shortfall recovery" defaultChecked={waived} />}
    </ActionForm>
  );
}

export function FinalizeSettlementButton({ employeeId }: { employeeId: string }) {
  const [state, formAction, pending] = useForm(finalizeSettlementAction);
  return (
    <form action={formAction} onSubmit={(e) => {
      if (!confirm("Finalise this settlement? Recoveries are marked settled, the employee is marked exited and their login is disabled.")) e.preventDefault();
    }}>
      <FormBanner state={state} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <button className="btn primary" disabled={pending}>{pending ? "Finalising…" : "Finalise settlement"}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  JOURNEY TASKS
// ---------------------------------------------------------------------------

export function TaskControls({ taskId, status, required, auto }: { taskId: string; status: string; required: boolean; auto: boolean }) {
  const [state, formAction, pending] = useForm(setTaskAction);
  const [skipping, setSkipping] = useState(false);
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="taskId" value={taskId} />
      {status === "PENDING" ? (
        skipping ? (
          <div className="row gap-2">
            <input className="input" name="note" placeholder={required ? "Why it does not apply" : "Note (optional)"} required={required} autoFocus style={{ width: 200 }} />
            <button className="btn sm" name="status" value="SKIPPED" disabled={pending}>Skip</button>
            <button className="btn sm ghost" type="button" onClick={() => setSkipping(false)}>Back</button>
          </div>
        ) : (
          <div className="row gap-2">
            <button className="btn sm primary" name="status" value="DONE" disabled={pending} title={auto ? "Closes only once the system can verify it" : undefined}>
              {pending ? "…" : auto ? "Verify" : "Done"}
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setSkipping(true)}>Skip</button>
          </div>
        )
      ) : (
        <button className="btn sm ghost" name="status" value="PENDING" disabled={pending}>Reopen</button>
      )}
      {state.message ? (
        <div className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", maxWidth: 280, textAlign: "right" }}>{state.message}</div>
      ) : null}
    </form>
  );
}

export function RecheckButton({ journeyId }: { journeyId: string }) {
  const [state, formAction, pending] = useForm(recheckJourneyAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="journeyId" value={journeyId} />
      {state.message ? <span className="text-xs muted">{state.message}</span> : null}
      <button className="btn sm" disabled={pending}>{pending ? "Checking…" : "Re-run system checks"}</button>
    </form>
  );
}

export function StartJourneyForm({ employees, templates }: { employees: Option[]; templates: Option[] }) {
  return (
    <ActionForm action={startJourneyAction} submitLabel="Start">
      {(state) => (
        <div className="grid grid-2">
          <Field label="Employee" name="employeeId" state={state} required>
            <SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required />
          </Field>
          <Field label="Because of" name="trigger" state={state}>
            <SelectInput name="trigger" state={state} options={opts(["JOINING", "CONFIRMATION", "PROMOTION", "TRANSFER", "MANUAL"])} />
          </Field>
          <Field label="Anchor date" name="anchorDate" state={state} required hint="Joining date or the change's effective date">
            <TextInput name="anchorDate" type="date" state={state} defaultValue={today()} required />
          </Field>
          <Field label="Template" name="templateId" state={state}>
            <SelectInput name="templateId" state={state} options={templates} placeholder="Best match for the trigger" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function TemplateForm({ template, departments, locations }: {
  template?: { id: string; name: string; description: string | null; trigger: string; departmentId: string | null; locationId: string | null; isActive: boolean };
  departments: Option[]; locations: Option[];
}) {
  return (
    <ActionForm action={saveTemplateAction} submitLabel={template ? "Save template" : "Create template"} hidden={template ? { id: template.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={template?.name} required />
            </Field>
            <Field label="Starts on" name="trigger" state={state}>
              <SelectInput name="trigger" state={state} defaultValue={template?.trigger ?? "JOINING"}
                options={opts(["JOINING", "CONFIRMATION", "PROMOTION", "TRANSFER", "EXIT", "MANUAL"])} />
            </Field>
            <Field label="Only for department" name="departmentId" state={state}>
              <SelectInput name="departmentId" state={state} options={departments} defaultValue={template?.departmentId} placeholder="Any" />
            </Field>
            <Field label="Only for location" name="locationId" state={state}>
              <SelectInput name="locationId" state={state} options={locations} defaultValue={template?.locationId} placeholder="Any" />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}>
            <TextInput name="description" state={state} defaultValue={template?.description} />
          </Field>
          {template ? <CheckboxInput name="isActive" label="Active" defaultChecked={template.isActive} /> : null}
        </>
      )}
    </ActionForm>
  );
}

export function AddTemplateTaskForm({ templateId, autoChecks }: { templateId: string; autoChecks: string[] }) {
  return (
    <InlineForm action={addTemplateTaskAction} hidden={{ templateId }} submitLabel="Add task">
      {(state) => (
        <>
          <TextInput name="title" state={state} placeholder="Task" required />
          <SelectInput name="owner" state={state} options={opts(["HR", "MANAGER", "EMPLOYEE", "IT", "FINANCE", "ADMIN"])} />
          <TextInput name="offsetDays" type="number" state={state} defaultValue={0} placeholder="Day ±" />
          <SelectInput name="category" state={state} options={opts(["DOCUMENTS", "ASSETS", "ACCESS", "TRAINING", "MEETING", "PAYROLL", "COMPLIANCE", "OTHER"])} defaultValue="OTHER" />
          <SelectInput name="autoCheck" state={state} options={autoChecks.map((c) => ({ value: c, label: label(c) }))} placeholder="Manual" />
          <label className="checkbox-row"><input type="checkbox" name="isRequired" defaultChecked /><span className="text-sm">Required</span></label>
        </>
      )}
    </InlineForm>
  );
}

export function DeleteTemplateTaskButton({ id }: { id: string }) {
  return <DangerButton action={deleteTemplateTaskAction} hidden={{ id }} label="Remove" confirmLabel="Remove this task from the template?" />;
}

// ---------------------------------------------------------------------------
//  HELPDESK
// ---------------------------------------------------------------------------

export function RaiseTicketForm({ categories }: { categories: Option[] }) {
  return (
    <ActionForm action={raiseTicketAction} submitLabel="Raise ticket">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Category" name="categoryId" state={state} required>
              <SelectInput name="categoryId" state={state} options={categories} placeholder="Select…" required />
            </Field>
            <Field label="Priority" name="priority" state={state}>
              <SelectInput name="priority" state={state} options={opts(["LOW", "MEDIUM", "HIGH", "URGENT"])} defaultValue="MEDIUM" />
            </Field>
          </div>
          <Field label="Subject" name="subject" state={state} required>
            <TextInput name="subject" state={state} required maxLength={160} />
          </Field>
          <Field label="Details" name="description" state={state} required>
            <TextArea name="description" state={state} rows={4} required />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function ReplyForm({ ticketId, asAgent }: { ticketId: string; asAgent: boolean }) {
  const [state, formAction, pending] = useForm(replyTicketAction);
  return (
    <form action={formAction} key={state.ok ? Date.now() : "reply"}>
      <FormBanner state={state} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <TextArea name="body" state={state} rows={3} placeholder={asAgent ? "Reply to the employee, or add an internal note" : "Add a reply"} />
      <div className="row gap-2" style={{ marginTop: 8 }}>
        <button className="btn primary sm" disabled={pending}>{pending ? "Sending…" : "Send"}</button>
        {asAgent ? <label className="checkbox-row"><input type="checkbox" name="isInternal" /><span className="text-sm">Internal note — not visible to the employee</span></label> : null}
      </div>
    </form>
  );
}

export function TicketStatusControls({ ticketId, status, assigneeUserId, agents }: { ticketId: string; status: string; assigneeUserId: string | null; agents: Option[] }) {
  const [state, formAction, pending] = useForm(ticketStatusAction);
  return (
    <form action={formAction} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <Field label="Status" name="status">
        <SelectInput name="status" options={opts(["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE", "RESOLVED", "CLOSED"])} defaultValue={status} />
      </Field>
      <Field label="Assigned to" name="assigneeUserId">
        <SelectInput name="assigneeUserId" options={agents} defaultValue={assigneeUserId} placeholder="Unassigned" />
      </Field>
      <button className="btn sm primary" disabled={pending}>{pending ? "Saving…" : "Update"}</button>
    </form>
  );
}

export function EmployeeTicketControls({ ticketId }: { ticketId: string }) {
  const [state, formAction, pending] = useForm(ticketStatusAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />
      <button className="btn sm primary" name="status" value="CLOSED" disabled={pending}>Close — it&apos;s fixed</button>
      <button className="btn sm" name="status" value="IN_PROGRESS" disabled={pending}>Reopen</button>
      {state.message ? <span className="text-xs muted">{state.message}</span> : null}
    </form>
  );
}

export function RateTicket({ ticketId, current }: { ticketId: string; current: number | null }) {
  const [state, formAction, pending] = useForm(rateTicketAction);
  return (
    <form action={formAction} className="row gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />
      <span className="text-sm muted">How did we do?</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={`btn sm${(current ?? 0) >= n ? " primary" : ""}`} name="rating" value={n} disabled={pending} aria-label={`${n} of 5`}>★</button>
      ))}
      {state.message ? <span className="text-xs muted">{state.message}</span> : null}
    </form>
  );
}

export function CategoryForm({ agents, category }: { agents: Option[]; category?: { id: string; name: string; description: string | null; slaHours: number; defaultAssigneeUserId: string | null; isActive: boolean } }) {
  return (
    <ActionForm action={saveCategoryAction} submitLabel={category ? "Save" : "Add category"} hidden={category ? { id: category.id } : undefined} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} defaultValue={category?.name} required />
          </Field>
          <Field label="Resolve within (hours)" name="slaHours" state={state} required>
            <TextInput name="slaHours" type="number" state={state} defaultValue={category?.slaHours ?? 48} required />
          </Field>
          <Field label="Default agent" name="defaultAssigneeUserId" state={state}>
            <SelectInput name="defaultAssigneeUserId" state={state} options={agents} defaultValue={category?.defaultAssigneeUserId} placeholder="Unassigned" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function MarkReadButton({ id, label: text = "Mark all read" }: { id?: string; label?: string }) {
  const [, formAction, pending] = useForm(markNotificationsReadAction);
  return (
    <form action={formAction}>
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <button className="btn sm ghost" disabled={pending}>{text}</button>
    </form>
  );
}
