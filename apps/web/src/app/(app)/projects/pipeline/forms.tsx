"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, useForm } from "@/components/form";
import {
  saveOpportunityAction, moveStageAction, opportunityOpAction, saveProspectAction, estimateAction, projectRequestAction,
} from "@/app/actions/psa-pipeline";
import { OpButton, RevealForm, RowForm, L, Select, Input, Msg, sm, type Opt } from "../psa-ui";

const today = () => new Date().toISOString().slice(0, 10);
const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const BILLING = [{ value: "TIME_AND_MATERIAL", label: "Time and material" }, { value: "MILESTONE", label: "Fixed — milestones" }, { value: "RETAINER", label: "Monthly retainer" }, { value: "NON_BILLABLE", label: "Not billed" }];

export interface OppValues {
  id: string; name: string; description: string | null; clientId: string | null; prospectId: string | null; sourceId: string | null; stageId: string; ownerId: string;
  billingModel: string; estimatedRevenue: number; fxRate: number; startDate: string; closeDate: string; expectedProjectStart: string; expectedProjectEnd: string | null;
}

/** Create or edit an opportunity: exactly one of a client or a prospect. */
export function OpportunityForm({ opp, clients, prospects, stages, sources, people, meId }: { opp?: OppValues; clients: Opt[]; prospects: Opt[]; stages: Opt[]; sources: Opt[]; people: Opt[]; meId?: string }) {
  const [party, setParty] = useState(opp?.prospectId ? "prospect" : "client");
  return (
    <ActionForm action={saveOpportunityAction} hidden={opp ? { id: opp.id } : undefined} submitLabel={opp ? "Save opportunity" : "Add to pipeline"}>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Opportunity" name="name" state={state} required><TextInput name="name" state={state} defaultValue={opp?.name} required /></Field>
          <Field label="For" name="party" state={state}>
            <select className="select" value={party} onChange={(e) => setParty(e.target.value)} aria-label="Client or prospect"><option value="client">An existing client</option><option value="prospect">A prospect</option></select>
          </Field>
          {party === "client"
            ? <Field label="Client" name="clientId" state={state} required><SelectInput name="clientId" state={state} options={clients} defaultValue={opp?.clientId} placeholder="Choose…" required /></Field>
            : <Field label="Prospect" name="prospectId" state={state} required><SelectInput name="prospectId" state={state} options={prospects} defaultValue={opp?.prospectId} placeholder="Choose…" required /></Field>}
          <Field label="Stage" name="stageId" state={state} required><SelectInput name="stageId" state={state} options={stages} defaultValue={opp?.stageId ?? stages[0]?.value} required /></Field>
          <Field label="Source" name="sourceId" state={state}><SelectInput name="sourceId" state={state} options={sources} defaultValue={opp?.sourceId} placeholder="None" /></Field>
          <Field label="Owner" name="ownerId" state={state} required><SelectInput name="ownerId" state={state} options={people} defaultValue={opp?.ownerId ?? meId} placeholder="Choose…" required /></Field>
          <Field label="Billing" name="billingModel" state={state}><SelectInput name="billingModel" state={state} options={BILLING} defaultValue={opp?.billingModel ?? "TIME_AND_MATERIAL"} /></Field>
          <Field label="Estimated revenue" name="estimatedRevenue" state={state} required hint="In the client's currency"><TextInput name="estimatedRevenue" type="number" state={state} defaultValue={opp?.estimatedRevenue} min={0} required /></Field>
          <Field label="FX rate to INR" name="fxRate" state={state} hint="Only for a foreign currency"><TextInput name="fxRate" type="number" step="0.000001" state={state} defaultValue={opp?.fxRate ?? ""} /></Field>
          <Field label="Opened" name="startDate" state={state} required><TextInput name="startDate" type="date" state={state} defaultValue={opp?.startDate ?? today()} required /></Field>
          <Field label="Expected close" name="closeDate" state={state} required><TextInput name="closeDate" type="date" state={state} defaultValue={opp?.closeDate ?? plus(30)} required /></Field>
          <Field label="Project starts" name="expectedProjectStart" state={state} required><TextInput name="expectedProjectStart" type="date" state={state} defaultValue={opp?.expectedProjectStart ?? plus(45)} required /></Field>
          <Field label="Project ends" name="expectedProjectEnd" state={state}><TextInput name="expectedProjectEnd" type="date" state={state} defaultValue={opp?.expectedProjectEnd} /></Field>
          <div style={{ gridColumn: "span 2" }}><Field label="Description" name="description" state={state}><TextArea name="description" state={state} defaultValue={opp?.description} rows={2} /></Field></div>
        </div>
      )}
    </ActionForm>
  );
}

/** Move to another stage; a lost stage asks why. */
export function StageMove({ id, stageId, stages }: { id: string; stageId: string; stages: Array<Opt & { kind: string }> }) {
  const [state, action, pending] = useForm(moveStageAction);
  const [to, setTo] = useState(stageId);
  const lost = stages.find((s) => s.value === to)?.kind === "LOST";
  return (
    <form action={action} className="row gap-1 wrap">
      <input type="hidden" name="id" value={id} />
      <select className="select" name="stageId" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...sm, fontSize: 12 }} aria-label="Stage" disabled={pending}>
        {stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      {lost && to !== stageId ? <input className="input" name="lostReason" placeholder="Why was it lost?" required style={{ ...sm, width: 150 }} aria-label="Lost reason" /> : null}
      {to !== stageId ? <button className="btn sm" disabled={pending}>Move</button> : null}
      <Msg state={state} />
    </form>
  );
}

export function OpportunityOps({ id, archived, won, requested }: { id: string; archived: boolean; won: boolean; requested: boolean }) {
  return (
    <div className="row gap-2 wrap">
      {won && !requested ? <OpButton action={opportunityOpAction} fields={{ id, op: "convert" }} label="Convert to project" variant="primary" /> : null}
      <OpButton action={opportunityOpAction} fields={{ id, op: archived ? "restore" : "archive" }} label={archived ? "Restore" : "Archive"} />
      <OpButton action={opportunityOpAction} fields={{ id, op: "delete" }} label="Delete" variant="ghost" confirmText="Delete this opportunity and its estimates?" />
    </div>
  );
}

export function CommentForm({ id }: { id: string }) {
  return (
    <RowForm action={opportunityOpAction} fields={{ id, op: "comment" }} submitLabel="Comment" variant="">
      <L label="Comment" grow><Input name="body" required /></L>
    </RowForm>
  );
}

export function ProspectForm({ people }: { people: Opt[] }) {
  return (
    <ActionForm action={saveProspectAction} submitLabel="Add prospect" compact>
      {(state) => (
        <div className="grid grid-4">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required /></Field>
          <Field label="Contact" name="contactName" state={state}><TextInput name="contactName" state={state} /></Field>
          <Field label="Email" name="contactEmail" state={state}><TextInput name="contactEmail" type="email" state={state} /></Field>
          <Field label="Owner" name="ownerId" state={state}><SelectInput name="ownerId" state={state} options={people} placeholder="None" /></Field>
          <Field label="City" name="city" state={state}><TextInput name="city" state={state} /></Field>
          <Field label="State" name="state" state={state}><TextInput name="state" state={state} /></Field>
          <Field label="Country" name="countryCode" state={state}><SelectInput name="countryCode" state={state} defaultValue="IN" options={[{ value: "IN", label: "India" }, { value: "US", label: "United States" }, { value: "GB", label: "United Kingdom" }, { value: "SG", label: "Singapore" }, { value: "AE", label: "UAE" }]} /></Field>
          <Field label="Currency" name="currency" state={state}><SelectInput name="currency" state={state} defaultValue="INR" options={["INR", "USD", "GBP", "SGD", "AED", "EUR"].map((c) => ({ value: c, label: c }))} /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function EstimateCreate({ opportunityId }: { opportunityId: string }) {
  return (
    <RowForm action={estimateAction} fields={{ op: "create", opportunityId }} submitLabel="Create estimate">
      <L label="Name" grow><Input name="name" placeholder="Phase 1" required /></L>
      <L label="Type"><Select name="type" options={[{ value: "TASK", label: "Task estimate" }, { value: "RESOURCE", label: "Resource estimate" }]} defaultValue="TASK" /></L>
    </RowForm>
  );
}

export function EstimateHeader({ estimateId, name, rateCardId, rateCards }: { estimateId: string; name: string; rateCardId: string | null; rateCards: Opt[] }) {
  return (
    <RowForm action={estimateAction} fields={{ op: "header", estimateId }} submitLabel="Save" variant="">
      <L label="Name"><Input name="name" defaultValue={name} required width={200} /></L>
      <L label="Rate card"><Select name="rateCardId" options={rateCards} defaultValue={rateCardId} placeholder="None" width={200} /></L>
    </RowForm>
  );
}

/** Add a line: phases, tasks and milestones on a task estimate; roles or named people on a resource estimate. */
export function EstimateLineForm({ estimateId, type, roles, people, phases }: { estimateId: string; type: string; roles: Opt[]; people: Opt[]; phases: Opt[] }) {
  const [kind, setKind] = useState(type === "RESOURCE" ? "ROLE" : "TASK");
  return (
    <RowForm action={estimateAction} fields={{ op: "line", estimateId, kind }} submitLabel="Add line">
      {type === "TASK" ? (
        <L label="Line">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={sm} aria-label="Line kind"><option value="PHASE">Phase</option><option value="TASK">Task</option><option value="MILESTONE">Milestone</option></select>
        </L>
      ) : null}
      {kind === "ROLE" ? (
        <>
          <L label="Billing role"><Select name="billingRoleId" options={roles} placeholder="Choose…" width={160} /></L>
          <L label="Or a person"><Select name="employeeId" options={people} placeholder="Unnamed" width={160} /></L>
          <L label="How many"><Input name="headcount" type="number" min={1} max={100} defaultValue={1} width={60} /></L>
          <L label="Share %"><Input name="allocationPercent" type="number" min={1} max={100} defaultValue={100} width={70} /></L>
          <L label="From"><Input name="startDate" type="date" required /></L>
          <L label="To"><Input name="endDate" type="date" required /></L>
          <L label="Bill rate"><Input name="billRate" type="number" min={0} step="0.01" placeholder="From card" width={100} /></L>
        </>
      ) : (
        <>
          <L label="Name" grow><Input name="name" required /></L>
          {kind !== "PHASE" && phases.length ? <L label="Phase"><Select name="parentId" options={phases} placeholder="None" width={140} /></L> : null}
          {kind === "TASK" ? <><L label="Hours"><Input name="hours" type="number" min={0} step="0.25" width={80} /></L><L label="Bill rate"><Input name="billRate" type="number" min={0} step="0.01" width={90} /></L><L label="Cost rate"><Input name="costRate" type="number" min={0} step="0.01" width={90} /></L></> : null}
          {kind === "MILESTONE" ? <><L label="Date"><Input name="endDate" type="date" required /></L><L label="Amount"><Input name="amount" type="number" min={0} step="0.01" width={110} /></L></> : null}
        </>
      )}
    </RowForm>
  );
}

export function EstimateOps({ estimateId, published }: { estimateId: string; published: boolean }) {
  return (
    <div className="row gap-2 wrap">
      {!published ? <OpButton action={estimateAction} fields={{ op: "publish", estimateId }} label="Publish" variant="primary" /> : null}
      <OpButton action={estimateAction} fields={{ op: "duplicate", estimateId }} label="Duplicate" />
      <OpButton action={estimateAction} fields={{ op: "delete", estimateId }} label="Delete" variant="ghost" confirmText="Delete this estimate?" />
    </div>
  );
}

export function LineDelete({ estimateId, lineId }: { estimateId: string; lineId: string }) {
  return <OpButton action={estimateAction} fields={{ op: "deleteLine", estimateId, lineId }} label="×" variant="ghost" />;
}

export interface RequestDefaults {
  name: string; clientId: string | null; billingModel: string; budget: number | null; startDate: string | null; endDate: string | null; projectManagerId?: string | null; rateCardId?: string | null;
}

/** The project form a won opportunity (or a fresh request) is raised with; a project admin can approve it at once. */
export function ProjectRequestForm({ requestId, defaults, clients, people, rateCards, canApprove }: { requestId?: string; defaults: RequestDefaults; clients: Opt[]; people: Opt[]; rateCards: Opt[]; canApprove: boolean }) {
  const [model, setModel] = useState(defaults.billingModel);
  return (
    <ActionForm action={projectRequestAction} hidden={{ op: "raise", ...(requestId ? { requestId } : {}) }} submitLabel={canApprove ? "Create project" : "Raise project request"}>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Project name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={defaults.name} required /></Field>
          <Field label="Code" name="code" state={state}><TextInput name="code" state={state} /></Field>
          <Field label="Billing" name="billingModel" state={state}>
            <select className="select" name="billingModel" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Billing">{BILLING.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select>
          </Field>
          <Field label="Client" name="clientId" state={state} hint={defaults.clientId ? undefined : "A prospect becomes a client when the project is approved"}><SelectInput name="clientId" state={state} options={clients} defaultValue={defaults.clientId} placeholder={defaults.clientId ? "None" : "From the prospect"} /></Field>
          <Field label="Project manager" name="projectManagerId" state={state}><SelectInput name="projectManagerId" state={state} options={people} defaultValue={defaults.projectManagerId} placeholder="None" /></Field>
          <Field label="Rate card" name="rateCardId" state={state}><SelectInput name="rateCardId" state={state} options={rateCards} defaultValue={defaults.rateCardId} placeholder="None" /></Field>
          <Field label="Starts" name="startDate" state={state}><TextInput name="startDate" type="date" state={state} defaultValue={defaults.startDate} /></Field>
          <Field label="Ends" name="endDate" state={state}><TextInput name="endDate" type="date" state={state} defaultValue={defaults.endDate} /></Field>
          <Field label="Budget (₹)" name="budget" state={state}><TextInput name="budget" type="number" state={state} defaultValue={defaults.budget} /></Field>
          <Field label="Budget hours" name="estimatedHours" state={state}><TextInput name="estimatedHours" type="number" state={state} /></Field>
          {model === "RETAINER" ? <Field label="Retainer per month (₹)" name="retainerFee" state={state} required><TextInput name="retainerFee" type="number" state={state} required /></Field> : null}
          <div style={{ gridColumn: "1 / -1" }}><Field label="Description" name="description" state={state}><TextArea name="description" state={state} rows={2} /></Field></div>
          {canApprove ? <div style={{ gridColumn: "1 / -1" }}><CheckboxInput name="approveNow" label="Approve it now (you are a project admin)" defaultChecked hint="Unchecked, it waits in Project requests like any other." /></div> : null}
        </div>
      )}
    </ActionForm>
  );
}

export function RequestDecision({ id }: { id: string }) {
  return (
    <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <OpButton action={projectRequestAction} fields={{ op: "approve", id }} label="Approve" variant="primary" />
      <RevealForm action={projectRequestAction} fields={{ op: "reject", id }} label="Reject…" submitLabel="Reject" variant="danger">
        <L label="Reason"><Input name="reason" required width={200} /></L>
      </RevealForm>
    </div>
  );
}
