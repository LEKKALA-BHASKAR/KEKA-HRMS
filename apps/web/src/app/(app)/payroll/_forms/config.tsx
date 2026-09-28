"use client";

import { useState } from "react";
import {
  ActionForm, InlineForm, DangerButton, Field, TextInput, SelectInput, CheckboxInput,
} from "@/components/form";
import {
  savePayGroup, deletePayGroup, saveFilingDetails, savePtRegistration, saveLwfRegistration,
  deleteStateRegistration, saveComponent, deleteComponent, saveStructure, cloneStructure,
  deleteStructure, saveStructureLine, removeStructureLine, saveApprovalRule,
  deleteApprovalRule, savePayslipSettings,
} from "@/app/actions/payroll-config";

export interface Option { value: string; label: string }

const d = (v: Date | string | null | undefined) =>
  v ? (typeof v === "string" ? v : v.toISOString()).slice(0, 10) : undefined;

// ---------------------------------------------------------------------------
//  PAY GROUP
// ---------------------------------------------------------------------------

export interface PayGroupValues {
  id: string; legalEntityId: string; name: string; description: string | null;
  frequency: string; payPeriodStartDay: number; payPeriodEndDay: number;
  attendanceCutoffDay: number | null; payDay: number;
  pfEnabled: boolean; esiEnabled: boolean; ptEnabled: boolean; lwfEnabled: boolean; tdsEnabled: boolean;
  declarationOpenDay: number; declarationCloseDay: number; declarationFyCutoff: string | null;
  newJoinerWindowDays: number; proofSubmissionDue: string | null; proofMandatory: boolean;
  allowLateDeclaration: boolean; allowRegimeChoice: boolean; regimeChangeCutoff: string | null;
  approvalWorkflowEnabled: boolean;
}

export function PayGroupForm({ entities, group }: { entities: Option[]; group?: PayGroupValues }) {
  return (
    <ActionForm action={savePayGroup} hidden={group ? { id: group.id } : undefined}
      submitLabel={group ? "Save pay group" : "Create pay group"}>
      {(state) => (
        <>
          <div className="stat-label" style={{ marginBottom: 8 }}>Identity &amp; schedule</div>
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={group?.name} required />
            </Field>
            <Field label="Legal entity" name="legalEntityId" state={state} required
              hint="Changing it moves every member with it">
              <SelectInput name="legalEntityId" state={state} options={entities}
                defaultValue={group?.legalEntityId} placeholder="Select…" required />
            </Field>
            <Field label="Frequency" name="frequency" state={state}>
              <SelectInput name="frequency" state={state} defaultValue={group?.frequency ?? "MONTHLY"}
                options={[
                  { value: "MONTHLY", label: "Monthly" }, { value: "SEMI_MONTHLY", label: "Semi-monthly" },
                  { value: "BI_WEEKLY", label: "Bi-weekly" }, { value: "WEEKLY", label: "Weekly" },
                ]} />
            </Field>
            <Field label="Period starts on day" name="payPeriodStartDay" state={state}>
              <TextInput name="payPeriodStartDay" state={state} type="number" min={1} max={28}
                defaultValue={group?.payPeriodStartDay ?? 1} />
            </Field>
            <Field label="Period ends on day" name="payPeriodEndDay" state={state}
              hint="0 means the last day of the month">
              <TextInput name="payPeriodEndDay" state={state} type="number" min={0} max={31}
                defaultValue={group?.payPeriodEndDay ?? 0} />
            </Field>
            <Field label="Attendance cut-off day" name="attendanceCutoffDay" state={state}
              hint="LOP after this rolls into next month">
              <TextInput name="attendanceCutoffDay" state={state} type="number" min={1} max={31}
                defaultValue={group?.attendanceCutoffDay ?? undefined} />
            </Field>
            <Field label="Pay day" name="payDay" state={state}>
              <TextInput name="payDay" state={state} type="number" min={1} max={31}
                defaultValue={group?.payDay ?? 1} />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}>
            <TextInput name="description" state={state} defaultValue={group?.description} />
          </Field>

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>Statutory heads</div>
          <div className="grid grid-3">
            <CheckboxInput name="pfEnabled" label="Provident Fund" defaultChecked={group?.pfEnabled ?? true} />
            <CheckboxInput name="esiEnabled" label="ESI" defaultChecked={group?.esiEnabled ?? true} />
            <CheckboxInput name="ptEnabled" label="Professional Tax" defaultChecked={group?.ptEnabled ?? true} />
            <CheckboxInput name="lwfEnabled" label="Labour Welfare Fund" defaultChecked={group?.lwfEnabled ?? true} />
            <CheckboxInput name="tdsEnabled" label="Income tax (TDS)" defaultChecked={group?.tdsEnabled ?? true} />
            <CheckboxInput name="approvalWorkflowEnabled" label="Maker-checker on lock"
              hint="Needs an approval rule to take effect"
              defaultChecked={group?.approvalWorkflowEnabled} />
          </div>

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>Investment declarations</div>
          <div className="grid grid-3">
            <Field label="Window opens on day" name="declarationOpenDay" state={state}>
              <TextInput name="declarationOpenDay" state={state} type="number" min={1} max={31}
                defaultValue={group?.declarationOpenDay ?? 1} />
            </Field>
            <Field label="Window closes on day" name="declarationCloseDay" state={state}>
              <TextInput name="declarationCloseDay" state={state} type="number" min={1} max={31}
                defaultValue={group?.declarationCloseDay ?? 22} />
            </Field>
            <Field label="FY cut-off" name="declarationFyCutoff" state={state}>
              <TextInput name="declarationFyCutoff" state={state} type="date" defaultValue={d(group?.declarationFyCutoff)} />
            </Field>
            <Field label="New-joiner window (days)" name="newJoinerWindowDays" state={state}>
              <TextInput name="newJoinerWindowDays" state={state} type="number" min={0} max={365}
                defaultValue={group?.newJoinerWindowDays ?? 30} />
            </Field>
            <Field label="Proof due" name="proofSubmissionDue" state={state}>
              <TextInput name="proofSubmissionDue" state={state} type="date" defaultValue={d(group?.proofSubmissionDue)} />
            </Field>
            <Field label="Regime change cut-off" name="regimeChangeCutoff" state={state}>
              <TextInput name="regimeChangeCutoff" state={state} type="date" defaultValue={d(group?.regimeChangeCutoff)} />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="proofMandatory" label="Proofs mandatory" defaultChecked={group?.proofMandatory ?? true} />
            <CheckboxInput name="allowLateDeclaration" label="Allow late declarations" defaultChecked={group?.allowLateDeclaration} />
            <CheckboxInput name="allowRegimeChoice" label="Employees choose their regime" defaultChecked={group?.allowRegimeChoice ?? true} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeletePayGroupButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deletePayGroup} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${name}? Refused if it has members or any payroll run.`} />;
}

// ---------------------------------------------------------------------------
//  FILING DETAILS
// ---------------------------------------------------------------------------

export interface FilingValues {
  pan: string | null; tan: string | null; tanCircle: string | null; citTds: string | null;
  form16SignatoryName: string | null; form16SignatoryDesignation: string | null; form16SignatoryPan: string | null;
  responsiblePersonName: string | null; responsiblePersonDesignation: string | null; responsiblePersonPan: string | null;
  pfRegistrationNumber: string | null; pfRegistrationDate: string | null; pfSignatoryName: string | null;
  pfWageCeiling: number; pfCapAtCeiling: boolean; pfEmployeeRate: number; pfEmployerRate: number;
  epsRate: number; epsWageCeiling: number; edliRate: number; pfAdminRate: number;
  esiRegistrationNumber: string | null; esiRegistrationDate: string | null; esiSignatoryName: string | null;
  esiWageLimit: number; esiEmployeeRate: number; esiEmployerRate: number;
  esiEmployerInsideCtc: boolean; esiHideEmployerOnPayslip: boolean; esiIncludeArrears: boolean;
}

export function FilingForm({ payGroupId, filing }: { payGroupId: string; filing: FilingValues | null }) {
  const f = filing;
  return (
    <ActionForm action={saveFilingDetails} hidden={{ payGroupId }} submitLabel="Save filing details">
      {(state) => (
        <>
          <div className="stat-label" style={{ marginBottom: 8 }}>Income tax</div>
          <div className="grid grid-3">
            <Field label="PAN" name="pan" state={state}><TextInput name="pan" state={state} defaultValue={f?.pan} maxLength={10} /></Field>
            <Field label="TAN" name="tan" state={state}><TextInput name="tan" state={state} defaultValue={f?.tan} maxLength={10} /></Field>
            <Field label="TAN circle" name="tanCircle" state={state}><TextInput name="tanCircle" state={state} defaultValue={f?.tanCircle} /></Field>
            <Field label="CIT (TDS)" name="citTds" state={state}><TextInput name="citTds" state={state} defaultValue={f?.citTds} /></Field>
            <Field label="Form 16 signatory" name="form16SignatoryName" state={state}><TextInput name="form16SignatoryName" state={state} defaultValue={f?.form16SignatoryName} /></Field>
            <Field label="Signatory designation" name="form16SignatoryDesignation" state={state}><TextInput name="form16SignatoryDesignation" state={state} defaultValue={f?.form16SignatoryDesignation} /></Field>
            <Field label="Signatory PAN" name="form16SignatoryPan" state={state}><TextInput name="form16SignatoryPan" state={state} defaultValue={f?.form16SignatoryPan} maxLength={10} /></Field>
            <Field label="Responsible person (24Q)" name="responsiblePersonName" state={state}><TextInput name="responsiblePersonName" state={state} defaultValue={f?.responsiblePersonName} /></Field>
            <Field label="Responsible person PAN" name="responsiblePersonPan" state={state}><TextInput name="responsiblePersonPan" state={state} defaultValue={f?.responsiblePersonPan} maxLength={10} /></Field>
          </div>

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>Provident Fund</div>
          <div className="grid grid-3">
            <Field label="Registration number" name="pfRegistrationNumber" state={state}><TextInput name="pfRegistrationNumber" state={state} defaultValue={f?.pfRegistrationNumber} /></Field>
            <Field label="Registered on" name="pfRegistrationDate" state={state}><TextInput name="pfRegistrationDate" state={state} type="date" defaultValue={d(f?.pfRegistrationDate)} /></Field>
            <Field label="Signatory" name="pfSignatoryName" state={state}><TextInput name="pfSignatoryName" state={state} defaultValue={f?.pfSignatoryName} /></Field>
            <Field label="Wage ceiling" name="pfWageCeiling" state={state} required><TextInput name="pfWageCeiling" state={state} type="number" min={0} defaultValue={f?.pfWageCeiling ?? 15000} required /></Field>
            <Field label="Employee rate %" name="pfEmployeeRate" state={state} required><TextInput name="pfEmployeeRate" state={state} type="number" step="0.01" defaultValue={f?.pfEmployeeRate ?? 12} required /></Field>
            <Field label="Employer rate %" name="pfEmployerRate" state={state} required><TextInput name="pfEmployerRate" state={state} type="number" step="0.01" defaultValue={f?.pfEmployerRate ?? 12} required /></Field>
            <Field label="EPS rate %" name="epsRate" state={state} required hint="Carved out of the employer share"><TextInput name="epsRate" state={state} type="number" step="0.01" defaultValue={f?.epsRate ?? 8.33} required /></Field>
            <Field label="EPS wage ceiling" name="epsWageCeiling" state={state} required><TextInput name="epsWageCeiling" state={state} type="number" defaultValue={f?.epsWageCeiling ?? 15000} required /></Field>
            <Field label="EDLI %" name="edliRate" state={state} required><TextInput name="edliRate" state={state} type="number" step="0.01" defaultValue={f?.edliRate ?? 0.5} required /></Field>
            <Field label="Admin charges %" name="pfAdminRate" state={state} required><TextInput name="pfAdminRate" state={state} type="number" step="0.01" defaultValue={f?.pfAdminRate ?? 0.5} required /></Field>
          </div>
          <CheckboxInput name="pfCapAtCeiling" label="Restrict PF to the wage ceiling"
            hint="Off means PF on actual basic" defaultChecked={f?.pfCapAtCeiling ?? true} />

          <div className="stat-label" style={{ margin: "10px 0 6px" }}>ESI</div>
          <div className="grid grid-3">
            <Field label="Registration number" name="esiRegistrationNumber" state={state}><TextInput name="esiRegistrationNumber" state={state} defaultValue={f?.esiRegistrationNumber} /></Field>
            <Field label="Registered on" name="esiRegistrationDate" state={state}><TextInput name="esiRegistrationDate" state={state} type="date" defaultValue={d(f?.esiRegistrationDate)} /></Field>
            <Field label="Signatory" name="esiSignatoryName" state={state}><TextInput name="esiSignatoryName" state={state} defaultValue={f?.esiSignatoryName} /></Field>
            <Field label="Wage limit" name="esiWageLimit" state={state} required><TextInput name="esiWageLimit" state={state} type="number" defaultValue={f?.esiWageLimit ?? 21000} required /></Field>
            <Field label="Employee rate %" name="esiEmployeeRate" state={state} required><TextInput name="esiEmployeeRate" state={state} type="number" step="0.01" defaultValue={f?.esiEmployeeRate ?? 0.75} required /></Field>
            <Field label="Employer rate %" name="esiEmployerRate" state={state} required><TextInput name="esiEmployerRate" state={state} type="number" step="0.01" defaultValue={f?.esiEmployerRate ?? 3.25} required /></Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="esiEmployerInsideCtc" label="Employer share inside CTC" defaultChecked={f?.esiEmployerInsideCtc} />
            <CheckboxInput name="esiHideEmployerOnPayslip" label="Hide employer share on payslip" defaultChecked={f?.esiHideEmployerOnPayslip} />
            <CheckboxInput name="esiIncludeArrears" label="Include arrears in ESI wage" defaultChecked={f?.esiIncludeArrears ?? true} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  STATE REGISTRATIONS
// ---------------------------------------------------------------------------

function LocationChecklist({
  locations, stateCode, selected,
}: { locations: Array<Option & { stateCode: string | null }>; stateCode: string; selected: string[] }) {
  const inState = locations.filter((l) => l.stateCode === stateCode);
  if (inState.length === 0) {
    return <p className="text-sm muted">No locations are in {stateCode || "this state"} yet.</p>;
  }
  return (
    <div className="stack gap-1">
      {inState.map((l) => (
        <label key={l.value} className="row gap-2 text-sm">
          <input type="checkbox" name="locationIds" value={l.value} defaultChecked={selected.includes(l.value)} />
          {l.label}
        </label>
      ))}
    </div>
  );
}

export function PtRegistrationForm({
  payGroupId, locations, states,
}: {
  payGroupId: string;
  locations: Array<Option & { stateCode: string | null }>;
  states: Option[];
}) {
  const [stateCode, setStateCode] = useState("");
  return (
    <ActionForm action={savePtRegistration} hidden={{ payGroupId }} submitLabel="Save PT registration">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="State" name="stateCode" state={state} required>
              <select id="stateCode" name="stateCode" className="select" required
                value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
                <option value="">Select…</option>
                {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="State name" name="stateName" state={state} required>
              <TextInput name="stateName" state={state} required
                defaultValue={states.find((s) => s.value === stateCode)?.label.replace(/ \(.*\)$/, "")} />
            </Field>
            <Field label="Frequency" name="frequency" state={state} required>
              <SelectInput name="frequency" state={state} defaultValue="MONTHLY" options={[
                { value: "MONTHLY", label: "Monthly" }, { value: "HALF_YEARLY", label: "Half-yearly" },
                { value: "ANNUAL", label: "Annual" },
              ]} />
            </Field>
            <Field label="Local body" name="localBodyType" state={state}
              hint="Tamil Nadu only: corporation or panchayat">
              <SelectInput name="localBodyType" state={state} placeholder="Not applicable" options={[
                { value: "CORPORATION", label: "Corporation" }, { value: "PANCHAYAT", label: "Panchayat" },
              ]} />
            </Field>
            <Field label="Establishment ID" name="establishmentId" state={state}>
              <TextInput name="establishmentId" state={state} />
            </Field>
            <Field label="Registered on" name="registrationDate" state={state}>
              <TextInput name="registrationDate" state={state} type="date" />
            </Field>
          </div>
          <div className="field">
            <div className="label">Locations that follow this registration</div>
            <LocationChecklist locations={locations} stateCode={stateCode} selected={[]} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function LwfRegistrationForm({
  payGroupId, locations, states,
}: {
  payGroupId: string;
  locations: Array<Option & { stateCode: string | null }>;
  states: Option[];
}) {
  const [stateCode, setStateCode] = useState("");
  return (
    <ActionForm action={saveLwfRegistration} hidden={{ payGroupId }} submitLabel="Save LWF registration">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="State" name="stateCode" state={state} required>
              <select id="stateCode" name="stateCode" className="select" required
                value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
                <option value="">Select…</option>
                {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="State name" name="stateName" state={state} required>
              <TextInput name="stateName" state={state} required
                defaultValue={states.find((s) => s.value === stateCode)?.label.replace(/ \(.*\)$/, "")} />
            </Field>
            <Field label="Establishment ID" name="establishmentId" state={state}>
              <TextInput name="establishmentId" state={state} />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="employerInsideCtc" label="Employer share inside CTC" />
            <CheckboxInput name="hideEmployerOnPayslip" label="Hide employer share on payslip" />
            <CheckboxInput name="prorateNewJoiners" label="Prorate for new joiners" defaultChecked />
          </div>
          <div className="field">
            <div className="label">Locations that follow this registration</div>
            <LocationChecklist locations={locations} stateCode={stateCode} selected={[]} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteRegistrationButton({ kind, id, label }: { kind: "pt" | "lwf"; id: string; label: string }) {
  return <DangerButton action={deleteStateRegistration} hidden={{ kind, id }} label="Remove"
    confirmLabel={`Remove the ${label} registration? Employees in its linked locations will stop having it deducted.`} />;
}

// ---------------------------------------------------------------------------
//  APPROVAL RULES & PAYSLIP SETTINGS
// ---------------------------------------------------------------------------

export function ApprovalRuleForm({ payGroupId, roles }: { payGroupId: string; roles: Option[] }) {
  return (
    <ActionForm action={saveApprovalRule} hidden={{ payGroupId }} submitLabel="Add rule">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Rule name" name="name" state={state} required>
              <TextInput name="name" state={state} required placeholder="Lock payroll — CFO sign-off" />
            </Field>
            <Field label="Applies to" name="action" state={state} required>
              <SelectInput name="action" state={state} options={[
                { value: "LOCK_PAYROLL", label: "Locking payroll" },
                { value: "COMPENSATION_CHANGE", label: "Compensation changes" },
              ]} />
            </Field>
          </div>
          <div className="field">
            <div className="label">Approver roles, in order</div>
            <div className="hint" style={{ marginBottom: 6 }}>
              Only explicit user roles can approve — implicit roles like Reporting Manager are excluded.
            </div>
            <div className="grid grid-3">
              {roles.map((r) => (
                <label key={r.value} className="row gap-2 text-sm">
                  <input type="checkbox" name="approverRoleIds" value={r.value} /> {r.label}
                </label>
              ))}
            </div>
            {state.errors?.approverRoleIds ? (
              <div className="text-xs" style={{ color: "var(--danger)", marginTop: 4 }}>{state.errors.approverRoleIds}</div>
            ) : null}
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteRuleButton({ id }: { id: string }) {
  return <DangerButton action={deleteApprovalRule} hidden={{ id }} label="Remove" />;
}

export function PayslipSettingsForm({ payGroupId, s }: {
  payGroupId: string;
  s: Record<string, boolean | string> | null;
}) {
  const b = (k: string, dflt = false) => (s ? Boolean(s[k]) : dflt);
  return (
    <ActionForm action={savePayslipSettings} hidden={{ payGroupId }} submitLabel="Save payslip settings">
      {(state) => (
        <>
          <Field label="Layout" name="layout" state={state}>
            <SelectInput name="layout" state={state} defaultValue={(s?.layout as string) ?? "THREE_SECTION"} options={[
              { value: "THREE_SECTION", label: "Three sections — earnings, contributions, deductions" },
              { value: "TWO_SECTION", label: "Two sections — contributions merged into deductions" },
            ]} />
          </Field>
          <div className="grid grid-3">
            <CheckboxInput name="showCompanyLogo" label="Company logo" defaultChecked={b("showCompanyLogo", true)} />
            <CheckboxInput name="showYtdTotals" label="Year-to-date totals" defaultChecked={b("showYtdTotals", true)} />
            <CheckboxInput name="showActualGross" label="Actual gross per component" defaultChecked={b("showActualGross")} />
            <CheckboxInput name="appendTaxSummary" label="Append tax computation" defaultChecked={b("appendTaxSummary")} />
            <CheckboxInput name="showEmployerContributions" label="Employer contributions" defaultChecked={b("showEmployerContributions", true)} />
            <CheckboxInput name="showLoanDetails" label="Loan details" defaultChecked={b("showLoanDetails", true)} />
            <CheckboxInput name="showLeaveSummary" label="Leave summary" defaultChecked={b("showLeaveSummary", true)} />
            <CheckboxInput name="showArrearBreakup" label="Arrear breakup" defaultChecked={b("showArrearBreakup", true)} />
            <CheckboxInput name="showOvertimeHours" label="Overtime hours" defaultChecked={b("showOvertimeHours")} />
            <CheckboxInput name="showOutsideCtcComponents" label="Outside-CTC components" defaultChecked={b("showOutsideCtcComponents")} />
            <CheckboxInput name="excludeNaFields" label="Hide empty fields" defaultChecked={b("excludeNaFields", true)} />
            <CheckboxInput name="passwordProtect" label="Password protect (PAN)" defaultChecked={b("passwordProtect", true)} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  COMPONENTS & STRUCTURES
// ---------------------------------------------------------------------------

export function ComponentForm() {
  return (
    <ActionForm action={saveComponent} submitLabel="Create component">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Code" name="code" state={state} required
              hint="Used in formulas as [CODE]">
              <TextInput name="code" state={state} required maxLength={30} placeholder="INTERNET" />
            </Field>
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} required />
            </Field>
            <Field label="Type" name="type" state={state} required>
              <SelectInput name="type" state={state} defaultValue="EARNING" options={[
                { value: "EARNING", label: "Earning" }, { value: "DEDUCTION", label: "Deduction" },
                { value: "EMPLOYER_CONTRIBUTION", label: "Employer contribution" },
                { value: "REIMBURSEMENT", label: "Reimbursement (tax-exempt)" },
                { value: "PERK", label: "Perquisite" },
              ]} />
            </Field>
            <Field label="Tax treatment" name="taxTreatment" state={state}>
              <SelectInput name="taxTreatment" state={state} defaultValue="FULLY_TAXABLE" options={[
                { value: "FULLY_TAXABLE", label: "Fully taxable" },
                { value: "PARTIALLY_EXEMPT", label: "Partially exempt" },
                { value: "FULLY_EXEMPT", label: "Fully exempt" },
              ]} />
            </Field>
            <Field label="Annual exempt limit" name="annualExemptLimit" state={state}>
              <TextInput name="annualExemptLimit" state={state} type="number" min={0} />
            </Field>
            <Field label="Tax section" name="taxSection" state={state}>
              <TextInput name="taxSection" state={state} placeholder="10(13A)" />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="isRecurring" label="Paid every cycle" defaultChecked />
            <CheckboxInput name="isLopApplicable" label="Reduced by loss of pay" defaultChecked />
            <CheckboxInput name="isArrearApplicable" label="Included in arrears" defaultChecked />
            <CheckboxInput name="affectsPfWage" label="Counts toward PF wage" />
            <CheckboxInput name="affectsEsiGross" label="Counts toward ESI gross" defaultChecked />
            <CheckboxInput name="isPartOfFbp" label="Part of the flexible benefit plan" />
            <CheckboxInput name="isOutsideCtc" label="Paid over and above CTC" />
            <CheckboxInput name="showOnPayslip" label="Shown on the payslip" defaultChecked />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteComponentButton({ id, code }: { id: string; code: string }) {
  return <DangerButton action={deleteComponent} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${code}? If it appears on past payslips it will be deactivated instead.`} />;
}

export function StructureForm({ payGroups }: { payGroups: Option[] }) {
  return (
    <ActionForm action={saveStructure} submitLabel="Create structure">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} required />
            </Field>
            <Field label="Pay group" name="payGroupId" state={state} required>
              <SelectInput name="payGroupId" state={state} options={payGroups} placeholder="Select…" required />
            </Field>
            <Field label="Type" name="type" state={state}>
              <SelectInput name="type" state={state} defaultValue="CUSTOM" options={[
                { value: "RANGE_BASED", label: "Range-based (matched by CTC)" },
                { value: "CUSTOM", label: "Custom" },
                { value: "DAILY_WAGE", label: "Daily wage" },
              ]} />
            </Field>
            <Field label="CTC from" name="minAnnualCtc" state={state}
              hint="Range-based structures must not overlap">
              <TextInput name="minAnnualCtc" state={state} type="number" min={0} step={1000} />
            </Field>
            <Field label="CTC to" name="maxAnnualCtc" state={state} hint="Blank means no upper limit">
              <TextInput name="maxAnnualCtc" state={state} type="number" min={0} step={1000} />
            </Field>
            <Field label="TDS method" name="tdsMethod" state={state}>
              <SelectInput name="tdsMethod" state={state} defaultValue="AVERAGE" options={[
                { value: "AVERAGE", label: "Spread across the year" },
                { value: "FLAT", label: "Flat per month" },
                { value: "NONE", label: "No TDS" },
              ]} />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="pfEnabled" label="PF applies" defaultChecked />
            <CheckboxInput name="esiEnabled" label="ESI applies" defaultChecked />
            <CheckboxInput name="roundComponents" label="Round to whole rupees" defaultChecked />
            <CheckboxInput name="isPartOfFbp" label="Flexible benefit plan" />
            <CheckboxInput name="isDefault" label="Default for this pay group" />
            <CheckboxInput name="isActive" label="Active" defaultChecked />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function StructureLineForm({
  structureId, components,
}: { structureId: string; components: Option[] }) {
  const [calc, setCalc] = useState("FORMULA");
  return (
    <InlineForm action={saveStructureLine} hidden={{ structureId }} submitLabel="Save line">
      {(state) => (
        <>
          <SelectInput name="componentId" state={state} options={components} placeholder="Component…" required />
          <select name="calculationType" className="select" value={calc}
            onChange={(e) => setCalc(e.target.value)} style={{ maxWidth: 140 }}>
            <option value="FORMULA">Formula</option>
            <option value="FIXED">Fixed</option>
            <option value="PERCENTAGE">Percentage</option>
            <option value="BALANCE">Balance of CTC</option>
          </select>
          {calc === "FORMULA" ? (
            <TextInput name="formula" state={state} placeholder="[CTC_MONTHLY] * 0.4" />
          ) : null}
          {calc === "FIXED" ? (
            <TextInput name="fixedAmount" state={state} type="number" min={0} placeholder="Monthly amount" />
          ) : null}
          {calc === "PERCENTAGE" ? (
            <>
              <TextInput name="percentage" state={state} type="number" step="0.01" placeholder="%" />
              <TextInput name="percentageOf" state={state} placeholder="of, e.g. BASIC" />
            </>
          ) : null}
          <TextInput name="sequence" state={state} type="number" min={0} placeholder="Seq" />
        </>
      )}
    </InlineForm>
  );
}

export function RemoveLineButton({ structureId, componentId }: { structureId: string; componentId: string }) {
  return <DangerButton action={removeStructureLine} hidden={{ structureId, componentId }} label="Remove"
    confirmLabel="Remove this component from the structure?" />;
}

export function CloneStructureButton({ id }: { id: string }) {
  return (
    <InlineForm action={cloneStructure} hidden={{ id }} submitLabel="Clone">
      {(state) => <TextInput name="name" state={state} placeholder="Name for the copy" />}
    </InlineForm>
  );
}

export function DeleteStructureButton({ id, name }: { id: string; name: string }) {
  return <DangerButton action={deleteStructure} hidden={{ id }} label="Delete"
    confirmLabel={`Delete ${name}? If salaries reference it, it is deactivated instead.`} />;
}
