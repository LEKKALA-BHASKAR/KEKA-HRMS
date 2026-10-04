"use client";

import { useState } from "react";
import { ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import {
  applyLoanAction, decideLoanAction, loanOperationAction, saveLoanCategoryAction, saveLoanRuleAction, saveLoanPolicyAction,
} from "@/app/actions/loans";

export interface Option { value: string; label: string }

export function ApplyLoanForm({ categories }: { categories: Option[] }) {
  const [state, formAction, pending] = useForm(applyLoanAction);
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <Field label="Loan type" name="categoryId" state={state} required>
        <SelectInput name="categoryId" state={state} options={categories} placeholder="Select…" required />
      </Field>
      <div className="grid grid-2">
        <Field label="Amount (₹)" name="amount" state={state} required>
          <TextInput name="amount" type="number" step="1000" state={state} required />
        </Field>
        <Field label="Repay over (months)" name="installments" state={state} required>
          <TextInput name="installments" type="number" state={state} defaultValue={12} required />
        </Field>
      </div>
      <Field label="Purpose" name="purpose" state={state}>
        <TextArea name="purpose" state={state} rows={2} />
      </Field>
      <Field label="Supporting document" name="document" state={state} hint="Required for some loan types (quotation, medical estimate)">
        <input type="file" name="document" accept="application/pdf,image/png,image/jpeg" className="text-xs" />
      </Field>
      <div className="row gap-2">
        <button className="btn" name="intent" value="preview" disabled={pending}>Check EMI & eligibility</button>
        <button className="btn primary" name="intent" value="apply" disabled={pending}>{pending ? "Submitting…" : "Apply"}</button>
      </div>
    </form>
  );
}

export function LoanDecision({ loanId }: { loanId: string }) {
  const [state, formAction, pending] = useForm(decideLoanAction);
  const [declining, setDeclining] = useState(false);
  if (state.ok) return <span className="text-xs pos">{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="loanId" value={loanId} />
      {declining ? <input className="input" name="note" placeholder="Reason" required autoFocus style={{ width: 220 }} /> : null}
      <div className="row gap-2">
        {declining ? (
          <>
            <button className="btn sm danger" name="decision" value="reject" disabled={pending}>Decline</button>
            <button type="button" className="btn sm ghost" onClick={() => setDeclining(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn sm primary" name="decision" value="approve" disabled={pending}>Approve</button>
            <button type="button" className="btn sm" onClick={() => setDeclining(true)}>Decline</button>
          </>
        )}
      </div>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function LoanOps({ loanId, status, upcoming }: { loanId: string; status: string; upcoming: Option[] }) {
  const [state, formAction, pending] = useForm(loanOperationAction);
  return (
    <form action={formAction} className="stack gap-2" style={{ alignItems: "flex-end" }}
      onSubmit={(e) => {
        const op = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
        if (op === "foreclose" && !confirm("Foreclose this loan? The remaining principal is treated as repaid outside payroll.")) e.preventDefault();
      }}>
      <input type="hidden" name="loanId" value={loanId} />
      {status === "APPROVED" ? (
        <div className="row gap-2">
          <label className="checkbox-row"><input type="checkbox" name="outside" /><span className="text-xs">Paid outside payroll</span></label>
          <button className="btn sm primary" name="op" value="disburse" disabled={pending}>Disburse</button>
        </div>
      ) : (
        <div className="row gap-2">
          {upcoming.length ? (
            <>
              <select name="period" className="select" style={{ width: 120 }}>{upcoming.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>
              <button className="btn sm" name="op" value="skip" disabled={pending}>Skip EMI</button>
            </>
          ) : null}
          <button className="btn sm ghost" name="op" value="foreclose" disabled={pending} style={{ color: "var(--danger)" }}>Foreclose</button>
        </div>
      )}
      {state.message ? <div className={`text-xs ${state.ok ? "pos" : "neg"}`} style={{ maxWidth: 300, textAlign: "right" }}>{state.message}</div> : null}
    </form>
  );
}

export function LoanCategoryForm({ category }: { category?: { id: string; name: string; code?: string | null; description: string | null; isConcessional: boolean; sbiBenchmarkRate: number | null; isEmergency?: boolean; emergencyMaxMonthsSalary?: number | null } }) {
  return (
    <ActionForm action={saveLoanCategoryAction} submitLabel={category ? "Save" : "Add category"} hidden={category ? { id: category.id } : undefined} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={category?.name} required /></Field>
          <Field label="Code" name="code" state={state} hint="Shown beside the name, e.g. PL001"><TextInput name="code" state={state} defaultValue={category?.code ?? ""} maxLength={12} /></Field>
          <Field label="Description" name="description" state={state}><TextInput name="description" state={state} defaultValue={category?.description ?? ""} maxLength={200} /></Field>
          <Field label="SBI benchmark rate (%)" name="sbiBenchmarkRate" state={state} hint="For the perquisite on concessional loans">
            <TextInput name="sbiBenchmarkRate" type="number" step="0.05" state={state} defaultValue={category?.sbiBenchmarkRate ?? ""} />
          </Field>
          <div style={{ paddingTop: 22 }}><CheckboxInput name="isConcessional" label="Concessional (below market rate)" defaultChecked={category?.isConcessional} /></div>
          <Field label="Emergency cap (months of gross)" name="emergencyMaxMonthsSalary" state={state} hint="Emergency advances skip the probation and service waits">
            <TextInput name="emergencyMaxMonthsSalary" type="number" step="0.5" state={state} defaultValue={category?.emergencyMaxMonthsSalary ?? ""} />
          </Field>
          <div style={{ paddingTop: 22 }}><CheckboxInput name="isEmergency" label="Emergency salary advance" defaultChecked={category?.isEmergency} /></div>
        </div>
      )}
    </ActionForm>
  );
}

export function LoanRuleForm({ policyId, categoryId, rule }: { policyId: string; categoryId: string; rule?: { interestType: string; interestRate: number | null; maxInstallments: number; commencementMonths: number; maxAmount: number | null; maxPercentOfSalary: number | null; requiresDocuments?: boolean; processingFeePct?: number | null; processingFeeFlat?: number | null } }) {
  return (
    <ActionForm action={saveLoanRuleAction} submitLabel="Save rule" hidden={{ policyId, categoryId }} compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Interest" name="interestType" state={state}>
            <SelectInput name="interestType" state={state} defaultValue={rule?.interestType ?? "NONE"} options={[{ value: "NONE", label: "Interest-free" }, { value: "FLAT", label: "Flat" }, { value: "REDUCING", label: "Reducing balance" }]} />
          </Field>
          <Field label="Rate (% a year)" name="interestRate" state={state}><TextInput name="interestRate" type="number" step="0.05" state={state} defaultValue={rule?.interestRate ?? ""} /></Field>
          <Field label="Max months" name="maxInstallments" state={state} required><TextInput name="maxInstallments" type="number" state={state} defaultValue={rule?.maxInstallments ?? 12} required /></Field>
          <Field label="EMIs start after (months)" name="commencementMonths" state={state} required><TextInput name="commencementMonths" type="number" state={state} defaultValue={rule?.commencementMonths ?? 1} required /></Field>
          <Field label="Max amount (₹)" name="maxAmount" state={state}><TextInput name="maxAmount" type="number" state={state} defaultValue={rule?.maxAmount ?? ""} /></Field>
          <Field label="Max % of annual CTC" name="maxPercentOfSalary" state={state}><TextInput name="maxPercentOfSalary" type="number" step="1" state={state} defaultValue={rule?.maxPercentOfSalary ?? ""} /></Field>
          <Field label="Processing fee (% of principal)" name="processingFeePct" state={state}><TextInput name="processingFeePct" type="number" step="0.05" state={state} defaultValue={rule?.processingFeePct ?? ""} /></Field>
          <Field label="Processing fee, flat (₹)" name="processingFeeFlat" state={state} hint="Recovered once, in the disbursal month"><TextInput name="processingFeeFlat" type="number" state={state} defaultValue={rule?.processingFeeFlat ?? ""} /></Field>
          <div style={{ paddingTop: 22 }}><CheckboxInput name="requiresDocuments" label="Supporting document required" defaultChecked={rule?.requiresDocuments} /></div>
        </div>
      )}
    </ActionForm>
  );
}

export function LoanPolicyForm({ policy }: { policy: { id: string; requireProbationComplete: boolean; blockOnNoticePeriod: boolean; minDaysFromJoining: number | null; minAnnualSalary: number | null; maxAnnualSalary: number | null; requireChangeApproval?: boolean } }) {
  return (
    <ActionForm action={saveLoanPolicyAction} submitLabel="Save eligibility" hidden={{ id: policy.id }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Days after joining" name="minDaysFromJoining" state={state}><TextInput name="minDaysFromJoining" type="number" state={state} defaultValue={policy.minDaysFromJoining ?? ""} /></Field>
            <Field label="Min annual CTC" name="minAnnualSalary" state={state}><TextInput name="minAnnualSalary" type="number" state={state} defaultValue={policy.minAnnualSalary ?? ""} /></Field>
            <Field label="Max annual CTC" name="maxAnnualSalary" state={state}><TextInput name="maxAnnualSalary" type="number" state={state} defaultValue={policy.maxAnnualSalary ?? ""} /></Field>
          </div>
          <div className="grid grid-2">
            <CheckboxInput name="requireProbationComplete" label="Only after probation" defaultChecked={policy.requireProbationComplete} />
            <CheckboxInput name="blockOnNoticePeriod" label="Not during notice period" defaultChecked={policy.blockOnNoticePeriod} />
            <CheckboxInput name="requireChangeApproval" label="Rule changes need approval (workflow)" defaultChecked={policy.requireChangeApproval} />
          </div>
        </>
      )}
    </ActionForm>
  );
}
