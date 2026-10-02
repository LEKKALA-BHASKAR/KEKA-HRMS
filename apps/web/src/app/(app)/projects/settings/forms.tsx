"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput } from "@/components/form";
import { rateCardAction, roleRateAction, billingEntityAction } from "@/app/actions/psa-billing";
import { saveTimesheetPolicyAction } from "@/app/actions/timesheet-policy";
import { OpButton, RowForm, L, Select, Input, type Opt } from "../psa-ui";

export function RateCardForm({ card, clients }: { card?: { id: string; name: string; currency: string; rateUnit: string; clientId: string | null }; clients: Opt[] }) {
  return (
    <RowForm action={rateCardAction} fields={card ? { id: card.id } : undefined} submitLabel={card ? "Save card" : "Add rate card"} variant={card ? "" : "primary"}>
      <L label="Name" grow><Input name="name" defaultValue={card?.name} placeholder="Standard 2026" required /></L>
      <L label="Client"><Select name="clientId" options={clients} defaultValue={card?.clientId} placeholder="Organisation reference" width={200} /></L>
      <L label="Currency"><Input name="currency" defaultValue={card?.currency ?? "INR"} required width={70} /></L>
      <L label="Rates are"><Select name="rateUnit" options={[{ value: "HOURLY", label: "Hourly" }, { value: "DAILY", label: "Daily" }]} defaultValue={card?.rateUnit ?? "HOURLY"} /></L>
    </RowForm>
  );
}

/** A role's rate on a card: add one, or edit/remove an existing row. */
export function RoleRateForm({ rateCardId, roles, rate }: { rateCardId: string; roles: string[]; rate?: { id: string; billingRole: string; rateCategory: string; billRate: number; suggestedCost: number | null } }) {
  return (
    <div className="row gap-2 wrap" style={{ alignItems: "end" }}>
      <RowForm action={roleRateAction} fields={{ rateCardId, ...(rate ? { rateId: rate.id } : {}) }} submitLabel={rate ? "Save" : "Add rate"} variant={rate ? "" : "primary"}>
        <L label="Billing role"><Select name="billingRole" options={roles.map((r) => ({ value: r, label: r }))} defaultValue={rate?.billingRole} placeholder="Choose…" required width={180} /></L>
        <L label="Category"><Input name="rateCategory" defaultValue={rate && rate.rateCategory !== "STANDARD" ? rate.rateCategory : ""} placeholder="Onsite" width={110} /></L>
        <L label="Bill rate"><Input name="billRate" type="number" step="0.01" min={0.01} defaultValue={rate?.billRate} required width={100} /></L>
        <L label="Suggested cost"><Input name="suggestedCost" type="number" step="0.01" min={0} defaultValue={rate?.suggestedCost} width={100} /></L>
      </RowForm>
      {rate ? <OpButton action={roleRateAction} fields={{ op: "delete", rateId: rate.id }} label="Remove" variant="ghost" confirmText={`Remove ${rate.billingRole} from this card?`} /> : null}
    </div>
  );
}

export interface EntityValues {
  invoicePrefix: string; invoiceSuffix: string | null; nextInvoiceNumber: number; proformaPrefix: string; nextProformaNumber: number;
  creditNotePrefix: string; nextCreditNoteNumber: number; defaultPaymentTermDays: number; bankDetails: string | null; footer: string | null;
}

export function BillingEntityForm({ legalEntityId, values }: { legalEntityId: string; values?: EntityValues }) {
  return (
    <ActionForm action={billingEntityAction} hidden={{ legalEntityId }} submitLabel={values ? "Save invoice settings" : "Set up for project billing"} compact>
      {(state) => (
        <div className="grid grid-4">
          <Field label="Invoice prefix" name="invoicePrefix" state={state} required><TextInput name="invoicePrefix" state={state} defaultValue={values?.invoicePrefix ?? "INV-"} required /></Field>
          <Field label="Invoice suffix" name="invoiceSuffix" state={state} hint="e.g. /26-27"><TextInput name="invoiceSuffix" state={state} defaultValue={values?.invoiceSuffix} /></Field>
          <Field label="Next invoice no." name="nextInvoiceNumber" state={state} required><TextInput name="nextInvoiceNumber" type="number" state={state} defaultValue={values?.nextInvoiceNumber ?? 1} min={1} required /></Field>
          <Field label="Payment term (days)" name="defaultPaymentTermDays" state={state} required><TextInput name="defaultPaymentTermDays" type="number" state={state} defaultValue={values?.defaultPaymentTermDays ?? 30} min={0} max={365} required /></Field>
          <Field label="Proforma prefix" name="proformaPrefix" state={state} required><TextInput name="proformaPrefix" state={state} defaultValue={values?.proformaPrefix ?? "PINV-"} required /></Field>
          <Field label="Next proforma no." name="nextProformaNumber" state={state} required><TextInput name="nextProformaNumber" type="number" state={state} defaultValue={values?.nextProformaNumber ?? 1} min={1} required /></Field>
          <Field label="Credit note prefix" name="creditNotePrefix" state={state} required><TextInput name="creditNotePrefix" state={state} defaultValue={values?.creditNotePrefix ?? "CRN-"} required /></Field>
          <Field label="Next credit note no." name="nextCreditNoteNumber" state={state} required><TextInput name="nextCreditNoteNumber" type="number" state={state} defaultValue={values?.nextCreditNoteNumber ?? 1} min={1} required /></Field>
          <div style={{ gridColumn: "span 2" }}><Field label="Bank details" name="bankDetails" state={state}><TextArea name="bankDetails" state={state} defaultValue={values?.bankDetails} rows={2} /></Field></div>
          <div style={{ gridColumn: "span 2" }}><Field label="Invoice footer" name="footer" state={state}><TextArea name="footer" state={state} defaultValue={values?.footer} rows={2} /></Field></div>
        </div>
      )}
    </ActionForm>
  );
}

export interface PolicyValues {
  minHoursPerDay: number | null; maxHoursPerDay: number; minHoursPerWeek: number | null; maxHoursPerWeek: number | null; incrementMinutes: number;
  rounding: string; approvalChain: string; autoApprove: boolean; autoApproveMaxHours: number | null; flagWeeklyHoursAbove: number;
  remindersEnabled: boolean; reminderAfterDays: number; escalationEnabled: boolean; escalateAfterDays: number;
}

export function TimesheetPolicyForm({ policy, increments, chains }: { policy: PolicyValues; increments: number[]; chains: Opt[] }) {
  const [auto, setAuto] = useState(policy.autoApprove);
  return (
    <ActionForm action={saveTimesheetPolicyAction} submitLabel="Save policy">
      {(state) => (
        <div className="stack gap-4">
          <div>
            <div className="strong text-sm" style={{ marginBottom: 8 }}>Hours</div>
            <div className="grid grid-4">
              <Field label="Most hours a day" name="maxHoursPerDay" state={state} required><TextInput name="maxHoursPerDay" type="number" step="0.25" state={state} defaultValue={policy.maxHoursPerDay} required /></Field>
              <Field label="Least hours on a day worked" name="minHoursPerDay" state={state} hint="Blank for no floor"><TextInput name="minHoursPerDay" type="number" step="0.25" state={state} defaultValue={policy.minHoursPerDay} /></Field>
              <Field label="Most hours a week" name="maxHoursPerWeek" state={state} hint="Checked on submission"><TextInput name="maxHoursPerWeek" type="number" step="0.25" state={state} defaultValue={policy.maxHoursPerWeek} /></Field>
              <Field label="Least hours a week" name="minHoursPerWeek" state={state} hint="Checked on submission"><TextInput name="minHoursPerWeek" type="number" step="0.25" state={state} defaultValue={policy.minHoursPerWeek} /></Field>
              <Field label="Log time in steps of" name="incrementMinutes" state={state}><SelectInput name="incrementMinutes" state={state} defaultValue={String(policy.incrementMinutes)} options={increments.map((m) => ({ value: String(m), label: `${m} minutes` }))} /></Field>
              <Field label="Time between steps" name="rounding" state={state}><SelectInput name="rounding" state={state} defaultValue={policy.rounding} options={[{ value: "REJECT", label: "Refuse it" }, { value: "NEAREST", label: "Round to the nearest step" }, { value: "UP", label: "Round up" }]} /></Field>
              <Field label="Warn approvers above (h/week)" name="flagWeeklyHoursAbove" state={state} required><TextInput name="flagWeeklyHoursAbove" type="number" state={state} defaultValue={policy.flagWeeklyHoursAbove} required /></Field>
            </div>
          </div>
          <div>
            <div className="strong text-sm" style={{ marginBottom: 8 }}>Approval</div>
            <div className="grid grid-3">
              <Field label="Who approves" name="approvalChain" state={state}><SelectInput name="approvalChain" state={state} defaultValue={policy.approvalChain} options={chains} /></Field>
              <div style={{ paddingTop: 22 }}><label className="checkbox-row"><input type="checkbox" name="autoApprove" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span className="text-sm">Approve automatically on submission</span></label></div>
              {auto ? <Field label="…when the week is at most (h)" name="autoApproveMaxHours" state={state} hint="Blank for any week"><TextInput name="autoApproveMaxHours" type="number" step="0.25" state={state} defaultValue={policy.autoApproveMaxHours} /></Field> : <span />}
            </div>
            <div className="hint">A project that does not require timesheet approval never holds a sheet up: a week only on such projects approves itself.</div>
          </div>
          <div>
            <div className="strong text-sm" style={{ marginBottom: 8 }}>Reminders</div>
            <div className="grid grid-4">
              <CheckboxInput name="remindersEnabled" label="Remind people who have not submitted" defaultChecked={policy.remindersEnabled} />
              <Field label="Days after the week ends" name="reminderAfterDays" state={state} required><TextInput name="reminderAfterDays" type="number" state={state} defaultValue={policy.reminderAfterDays} min={0} max={30} required /></Field>
              <CheckboxInput name="escalationEnabled" label="Then tell their line manager" defaultChecked={policy.escalationEnabled} />
              <Field label="Days after the week ends" name="escalateAfterDays" state={state} required><TextInput name="escalateAfterDays" type="number" state={state} defaultValue={policy.escalateAfterDays} min={0} max={60} required /></Field>
            </div>
            <div className="hint">Sent by the nightly timesheet-reminders job to everyone with a confirmed allocation that week; each person and week is chased once.</div>
          </div>
        </div>
      )}
    </ActionForm>
  );
}
