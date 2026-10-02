"use client";

import { useState, type ReactNode } from "react";
import { useForm, FormBanner } from "@/components/form";
import { invoiceOpAction, creditNoteAction, chargeAction, expenseChargeAction, retainerAction } from "@/app/actions/psa-billing";
import { OpButton, RevealForm, RowForm, L, Select, Input, Msg, sm, type Opt } from "../psa-ui";

const today = () => new Date().toISOString().slice(0, 10);

/** The invoice view's actions, offered only where the status allows them. */
export function InvoiceActions({ invoiceId, status, kind, paid, converted }: { invoiceId: string; status: string; kind: string; paid: number; converted: boolean }) {
  const open = ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(status);
  const f = { invoiceId };
  return (
    <div className="row gap-2 wrap">
      {status === "DRAFT" ? <OpButton action={invoiceOpAction} fields={{ ...f, op: "markSent" }} label="Mark as sent" /> : null}
      {kind === "PROFORMA" && status !== "CANCELLED" && !converted ? <OpButton action={invoiceOpAction} fields={{ ...f, op: "convert" }} label="Convert to tax invoice" variant="primary" /> : null}
      {kind === "TAX" && open ? (
        <RevealForm action={invoiceOpAction} fields={{ ...f, op: "writeOff" }} label="Write off…" submitLabel="Write off" variant="danger">
          <L label="Date"><Input name="date" type="date" defaultValue={today()} required /></L>
          <L label="Reason" grow><Input name="reason" placeholder="Client insolvent" required /></L>
        </RevealForm>
      ) : null}
      {!["CANCELLED", "PAID", "WRITTEN_OFF"].includes(status) && paid === 0 ? (
        <RevealForm action={invoiceOpAction} fields={{ ...f, op: "cancel" }} label="Cancel…" submitLabel="Cancel invoice" variant="danger">
          <L label="Reason" grow><Input name="reason" placeholder="Raised against the wrong PO" required /></L>
        </RevealForm>
      ) : null}
    </div>
  );
}

/** Raise a credit note; from an invoice the client and invoice are fixed and it can be applied at once. */
export function CreditNoteForm({ clients, invoiceId, clientId, maxAmount }: { clients?: Opt[]; invoiceId?: string; clientId?: string; maxAmount?: number }) {
  const [state, action, pending] = useForm(creditNoteAction);
  return (
    <form action={action} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="op" value="raise" />
      {invoiceId ? <input type="hidden" name="invoiceId" value={invoiceId} /> : null}
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        {!clientId && clients ? <L label="Client"><Select name="clientId" options={clients} placeholder="Choose…" required /></L> : null}
        <L label="Amount (before tax)"><Input name="amount" type="number" step="0.01" min={0.01} max={maxAmount} required width={130} /></L>
        <L label="GST on it"><Input name="taxAmount" type="number" step="0.01" min={0} width={110} /></L>
        <L label="Date"><Input name="issueDate" type="date" defaultValue={today()} required /></L>
        <L label="Reason" grow><Input name="reason" placeholder="Discount agreed for the delayed release" required /></L>
        {invoiceId ? <label className="row gap-1 text-sm"><input type="checkbox" name="applyNow" defaultChecked /> Apply to this invoice</label> : null}
        <button className="btn sm primary" disabled={pending}>{pending ? "…" : "Raise credit note"}</button>
      </div>
    </form>
  );
}

export function CreditNoteOps({ creditNoteId, invoices }: { creditNoteId: string; invoices: Opt[] }) {
  return (
    <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      {invoices.length ? (
        <RowForm action={creditNoteAction} fields={{ op: "apply", creditNoteId }} submitLabel="Apply" variant="">
          <Select name="invoiceId" options={invoices} placeholder="To invoice…" required width={190} />
        </RowForm>
      ) : <span className="text-xs subtle">No open invoice to apply it to</span>}
      <OpButton action={creditNoteAction} fields={{ op: "void", creditNoteId }} label="Void" variant="ghost" confirmText="Void this credit note?" />
    </div>
  );
}

export function GenerateCharges({ projectId, label = "Bring charges up to date" }: { projectId?: string; label?: string }) {
  return <OpButton action={chargeAction} fields={{ op: "generate", ...(projectId ? { projectId } : {}) }} label={label} />;
}

export function AdhocChargeForm({ projects, projectId }: { projects?: Opt[]; projectId?: string }) {
  return (
    <RowForm action={chargeAction} fields={{ op: "adhoc", ...(projectId ? { projectId } : {}) }} submitLabel="Add charge">
      {!projectId && projects ? <L label="Project"><Select name="projectId" options={projects} placeholder="Choose…" required /></L> : null}
      <L label="Charge" grow><Input name="name" placeholder="Licence pass-through" required /></L>
      <L label="Amount"><Input name="amount" type="number" step="0.01" min={0.01} required width={120} /></L>
      <L label="Date"><Input name="date" type="date" defaultValue={today()} required /></L>
    </RowForm>
  );
}

/**
 * Selected unbilled charges (the checkboxes in `children`, named chargeId)
 * become a draft invoice, or a proforma.
 */
export function DraftFromCharges({ entities, children }: { entities: Array<Opt & { termDays: number | null }>; children: ReactNode }) {
  const [state, action, pending] = useForm(chargeAction);
  const [entity, setEntity] = useState(entities[0]?.value ?? "");
  const term = entities.find((e) => e.value === entity)?.termDays;
  return (
    <form action={action}>
      <input type="hidden" name="op" value="draft" />
      <div style={{ padding: "12px 16px 0" }}><FormBanner state={state} /></div>
      {children}
      <div className="row gap-2 wrap" style={{ alignItems: "end", padding: 14, borderTop: "1px solid var(--border)" }}>
        <L label="Invoice date"><Input name="invoiceDate" type="date" defaultValue={today()} required /></L>
        {entities.length ? (
          <L label="Billing entity">
            <select className="select" name="billingEntityId" value={entity} onChange={(e) => setEntity(e.target.value)} style={sm} aria-label="Billing entity">
              {entities.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </L>
        ) : null}
        <L label="Payment term (days)"><Input key={entity} name="paymentTermDays" type="number" min={0} max={365} defaultValue={term ?? 30} width={90} /></L>
        <L label="PO number"><Input name="poNumber" width={120} /></L>
        <L label="Attention"><Input name="attentionName" width={140} /></L>
        <L label="Attention email"><Input name="attentionEmail" type="email" width={180} /></L>
        <L label="Terms / notes" grow><Input name="notes" /></L>
        <label className="row gap-1 text-sm"><input type="checkbox" name="proforma" /> Proforma (a quote; nothing is due)</label>
        <button className="btn primary sm" disabled={pending}>{pending ? "Drafting…" : "Draft invoice"}</button>
      </div>
    </form>
  );
}

/** Charge an approved claim to a project, move it, or take it off. */
export function ExpenseChargeOps({ claimId, projects, currentProjectId, invoiced }: { claimId: string; projects: Opt[]; currentProjectId?: string | null; invoiced?: boolean }) {
  if (invoiced) return <span className="text-xs subtle">Invoiced</span>;
  return (
    <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
      <RowForm action={expenseChargeAction} fields={{ op: "charge", claimId }} submitLabel={currentProjectId ? "Move" : "Charge"} variant="">
        <Select name="projectId" options={projects.filter((p) => p.value !== currentProjectId)} placeholder="To project…" required width={180} />
      </RowForm>
      {currentProjectId ? <OpButton action={expenseChargeAction} fields={{ op: "uncharge", claimId }} label="Remove" variant="ghost" /> : null}
    </div>
  );
}

export function RetainerForm({ projectId, fee, from }: { projectId: string; fee: number | null; from: string | null }) {
  const [state, action, pending] = useForm(retainerAction);
  return (
    <form action={action} className="stack gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
        <L label="Fee per month (₹)"><Input name="fee" type="number" step="0.01" min={0.01} defaultValue={fee} required width={140} /></L>
        <L label="Bill from (month)"><Input name="from" type="date" defaultValue={from ?? today().slice(0, 8) + "01"} required /></L>
        <button className="btn sm primary" disabled={pending}>{pending ? "…" : fee ? "Save retainer" : "Set up retainer"}</button>
      </div>
      <Msg state={state} />
    </form>
  );
}
