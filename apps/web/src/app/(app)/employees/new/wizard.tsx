"use client";

import { useState } from "react";
import { useForm, Field, TextInput, SelectInput, CheckboxInput, FormBanner, SubmitButton } from "@/components/form";
import { createEmployee } from "@/app/actions/employee";
import type { Option } from "@/app/(app)/org/forms";

/**
 * The four documented add-employee steps: basic details, job details, work
 * details, compensation.
 *
 * All four render inside one form and one submit, because creating the record
 * is a single transaction. Stepping is presentational — it keeps the form
 * readable without letting a half-created employee exist.
 */

const STEPS = [
  { n: 1, label: "Basic details", hint: "Who they are" },
  { n: 2, label: "Job details", hint: "Where they sit" },
  { n: 3, label: "Work details", hint: "Number, access, leave" },
  { n: 4, label: "Compensation", hint: "Pay group and CTC" },
];

export function EmployeeWizard({
  entities, businessUnits, departments, locations, costCentres, bands, grades,
  workerTypes, jobTitles, managers, payGroups, structures, numberSeries, leavePlans,
  defaultSeriesPreview,
}: {
  entities: Option[]; businessUnits: Option[]; departments: Option[]; locations: Option[];
  costCentres: Option[]; bands: Option[]; grades: Option[]; workerTypes: Option[];
  jobTitles: Option[]; managers: Option[]; payGroups: Option[];
  structures: Array<{ value: string; label: string; payGroupId: string }>;
  numberSeries: Option[]; leavePlans: Option[];
  defaultSeriesPreview: string | null;
}) {
  const [state, formAction, pending] = useForm(createEmployee);
  const [step, setStep] = useState(1);
  const [manualNumber, setManualNumber] = useState(false);
  const [withSalary, setWithSalary] = useState(true);
  const [payGroupId, setPayGroupId] = useState("");

  const visibleStructures = payGroupId
    ? structures.filter((s) => s.payGroupId === payGroupId)
    : structures;

  return (
    <form action={formAction}>
      <div className="stepper no-print" style={{ marginBottom: 18 }}>
        {STEPS.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => setStep(s.n)}
            className={`step${step === s.n ? " active" : ""}${step > s.n ? " done" : ""}`}
            style={{ background: "none", border: "none", borderRight: "1px solid var(--border)", cursor: "pointer", textAlign: "left" }}
          >
            <span className="step-num">{step > s.n ? "✓" : s.n}</span>
            <span>
              <span className="step-label">{s.label}</span>
              <span className="step-meta">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <FormBanner state={state} />

      {/* Fields stay mounted across steps so one submit carries everything. */}
      <div style={{ display: step === 1 ? "block" : "none" }}>
        <div className="card"><div className="card-body">
          <div className="grid grid-3">
            <Field label="First name" name="firstName" state={state} required>
              <TextInput name="firstName" state={state} required maxLength={60} />
            </Field>
            <Field label="Middle name" name="middleName" state={state}>
              <TextInput name="middleName" state={state} maxLength={60} />
            </Field>
            <Field label="Last name" name="lastName" state={state} required>
              <TextInput name="lastName" state={state} required maxLength={60} />
            </Field>
            <Field label="Work email" name="workEmail" state={state} required
              hint="Becomes their login if you invite them">
              <TextInput name="workEmail" state={state} type="email" required />
            </Field>
            <Field label="Personal email" name="personalEmail" state={state}>
              <TextInput name="personalEmail" state={state} type="email" />
            </Field>
            <Field label="Mobile" name="mobile" state={state}>
              <TextInput name="mobile" state={state} placeholder="+91…" maxLength={20} />
            </Field>
            <Field label="Date of birth" name="dateOfBirth" state={state}
              hint="Drives the old regime's senior-citizen slabs">
              <TextInput name="dateOfBirth" state={state} type="date" />
            </Field>
            <Field label="Gender" name="gender" state={state}
              hint="Maharashtra PT differs by gender">
              <SelectInput name="gender" state={state} placeholder="Not stated"
                options={[
                  { value: "MALE", label: "Male" }, { value: "FEMALE", label: "Female" },
                  { value: "OTHER", label: "Other" }, { value: "UNDISCLOSED", label: "Prefer not to say" },
                ]} />
            </Field>
            <Field label="Marital status" name="maritalStatus" state={state}>
              <SelectInput name="maritalStatus" state={state} placeholder="Not stated"
                options={[
                  { value: "SINGLE", label: "Single" }, { value: "MARRIED", label: "Married" },
                  { value: "DIVORCED", label: "Divorced" }, { value: "WIDOWED", label: "Widowed" },
                  { value: "UNDISCLOSED", label: "Prefer not to say" },
                ]} />
            </Field>
          </div>
        </div></div>
      </div>

      <div style={{ display: step === 2 ? "block" : "none" }}>
        <div className="card"><div className="card-body">
          <div className="grid grid-3">
            <Field label="Date of joining" name="dateOfJoining" state={state} required
              hint="Earnings prorate from this date in the joining month">
              <TextInput name="dateOfJoining" state={state} type="date" required />
            </Field>
            <Field label="Job title" name="jobTitleId" state={state}>
              <SelectInput name="jobTitleId" state={state} options={jobTitles} placeholder="Not set" />
            </Field>
            <Field label="Status" name="status" state={state} required>
              <SelectInput name="status" state={state} defaultValue="PROBATION"
                options={[
                  { value: "PROBATION", label: "Probation" },
                  { value: "CONFIRMED", label: "Confirmed" },
                  { value: "ONBOARDING", label: "Onboarding" },
                  { value: "PREBOARDING", label: "Preboarding" },
                ]} />
            </Field>
            <Field label="Legal entity" name="legalEntityId" state={state} required>
              <SelectInput name="legalEntityId" state={state} options={entities} placeholder="Select…" required />
            </Field>
            <Field label="Business unit" name="businessUnitId" state={state}>
              <SelectInput name="businessUnitId" state={state} options={businessUnits} placeholder="None" />
            </Field>
            <Field label="Department" name="departmentId" state={state}>
              <SelectInput name="departmentId" state={state} options={departments} placeholder="None" />
            </Field>
            <Field label="Location" name="locationId" state={state} required
              hint="Its state decides Professional Tax and LWF">
              <SelectInput name="locationId" state={state} options={locations} placeholder="Select…" required />
            </Field>
            <Field label="Reporting manager" name="reportingManagerId" state={state}
              hint="Grants them the implicit Reporting Manager role">
              <SelectInput name="reportingManagerId" state={state} options={managers} placeholder="None" />
            </Field>
            <Field label="Worker type" name="workerTypeId" state={state}>
              <SelectInput name="workerTypeId" state={state} options={workerTypes} placeholder="None" />
            </Field>
            <Field label="Band" name="bandId" state={state}>
              <SelectInput name="bandId" state={state} options={bands} placeholder="None" />
            </Field>
            <Field label="Pay grade" name="payGradeId" state={state}>
              <SelectInput name="payGradeId" state={state} options={grades} placeholder="None" />
            </Field>
            <Field label="Cost centre" name="costCenterId" state={state}>
              <SelectInput name="costCenterId" state={state} options={costCentres} placeholder="None" />
            </Field>
          </div>
        </div></div>
      </div>

      <div style={{ display: step === 3 ? "block" : "none" }}>
        <div className="card"><div className="card-body">
          <div className="grid grid-2">
            <div>
              <Field label="Number series" name="numberSeriesId" state={state}
                hint={defaultSeriesPreview
                  ? `The default series will issue ${defaultSeriesPreview}`
                  : "No default series configured"}>
                <SelectInput name="numberSeriesId" state={state} options={numberSeries}
                  placeholder="Use the default series" />
              </Field>

              <CheckboxInput
                name="__manualNumber" label="Enter the employee number manually"
                hint="Use this only when migrating existing records"
              />
              <div style={{ marginTop: -6, marginBottom: 10 }}>
                <label className="row gap-2 text-sm">
                  <input type="checkbox" checked={manualNumber}
                    onChange={(e) => setManualNumber(e.target.checked)} />
                  Override the series
                </label>
              </div>
              {manualNumber ? (
                <Field label="Employee number" name="employeeNumberOverride" state={state}>
                  <TextInput name="employeeNumberOverride" state={state} maxLength={30} />
                </Field>
              ) : null}

              <Field label="Attendance number" name="attendanceNumber" state={state}
                hint="Must match the biometric device roster">
                <TextInput name="attendanceNumber" state={state} maxLength={20} />
              </Field>
            </div>

            <div>
              <Field label="Leave plan" name="leavePlanId" state={state}
                hint="Balances accrue from the joining date">
                <SelectInput name="leavePlanId" state={state} options={leavePlans} placeholder="Assign later" />
              </Field>

              <CheckboxInput
                name="inviteToPortal" label="Create a portal login"
                hint="Creates the account against their work email. They will need a password reset to activate it — no email is sent yet."
              />
            </div>
          </div>
        </div></div>
      </div>

      <div style={{ display: step === 4 ? "block" : "none" }}>
        <div className="card"><div className="card-body">
          <label className="row gap-2 text-sm" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={withSalary}
              onChange={(e) => setWithSalary(e.target.checked)} />
            Set compensation now
          </label>

          {withSalary ? (
            <>
              <div className="callout info" style={{ marginBottom: 14 }}>
                <div>
                  The pay group carries every statutory registration — PF, ESI, and the
                  state-wise PT and LWF. Without one, payroll cannot process this employee.
                </div>
              </div>
              <div className="grid grid-3">
                <Field label="Pay group" name="payGroupId" state={state} required>
                  <select
                    id="payGroupId" name="payGroupId" className="select" required
                    value={payGroupId} onChange={(e) => setPayGroupId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {payGroups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                  </select>
                </Field>
                <Field label="Annual CTC" name="annualCtc" state={state} required
                  hint="Cost to company, not gross">
                  <TextInput name="annualCtc" state={state} type="number" min={0} step={1000} required />
                </Field>
                <Field label="Salary structure" name="salaryStructureId" state={state}
                  hint="Left blank, the range-based structure matching the CTC is chosen">
                  <SelectInput name="salaryStructureId" state={state}
                    options={visibleStructures.map((s) => ({ value: s.value, label: s.label }))}
                    placeholder="Match automatically by CTC" />
                </Field>
                <Field label="Tax regime" name="taxRegime" state={state} required>
                  <SelectInput name="taxRegime" state={state} defaultValue="NEW"
                    options={[
                      { value: "NEW", label: "New regime (s.115BAC)" },
                      { value: "OLD", label: "Old regime" },
                    ]} />
                </Field>
              </div>
            </>
          ) : (
            <p className="text-sm muted">
              You can add a pay group and salary later from the employee&rsquo;s Finances tab.
              Until then they will not appear in a payroll run.
            </p>
          )}
        </div></div>
      </div>

      <div className="row gap-2" style={{ marginTop: 18, justifyContent: "space-between" }}>
        <div>
          {step > 1 ? (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
        </div>
        <div className="row gap-2">
          {step < 4 ? (
            <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
              Continue
            </button>
          ) : (
            <SubmitButton pending={pending} size="lg">Create employee</SubmitButton>
          )}
        </div>
      </div>
    </form>
  );
}
