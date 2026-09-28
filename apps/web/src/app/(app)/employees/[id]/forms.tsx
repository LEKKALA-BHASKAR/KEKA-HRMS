"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  ActionForm, InlineForm, DangerButton, Field, TextInput, SelectInput, CheckboxInput,
} from "@/components/form";
import {
  updatePersonalDetails, recordJobChange, reviseSalary, saveAddress, saveIdentity,
  saveEmployeeBank, addEducation, addExperience, addDependent, addEmergencyContact,
  deleteSubRecord, inviteToPortal, setLoginAccess, saveStatutoryProfile,
} from "@/app/actions/employee";

export interface Option { value: string; label: string }

export function EditToggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className={`btn sm${open ? "" : " primary"}`} onClick={() => setOpen((v) => !v)}>
        {open ? "Close" : label}
      </button>
      {open ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </div>
  );
}

const GENDERS: Option[] = [
  { value: "MALE", label: "Male" }, { value: "FEMALE", label: "Female" },
  { value: "OTHER", label: "Other" }, { value: "UNDISCLOSED", label: "Prefer not to say" },
];
const MARITAL: Option[] = [
  { value: "SINGLE", label: "Single" }, { value: "MARRIED", label: "Married" },
  { value: "DIVORCED", label: "Divorced" }, { value: "WIDOWED", label: "Widowed" },
  { value: "UNDISCLOSED", label: "Prefer not to say" },
];
const BLOOD: Option[] = ["A_POS","A_NEG","B_POS","B_NEG","AB_POS","AB_NEG","O_POS","O_NEG","UNKNOWN"]
  .map((v) => ({ value: v, label: v.replace("_POS", "+").replace("_NEG", "−").replace("UNKNOWN", "Unknown") }));

export function PersonalForm({ employee }: {
  employee: {
    id: string; firstName: string; middleName: string | null; lastName: string;
    displayName: string | null; workEmail: string | null; personalEmail: string | null;
    mobile: string | null; alternatePhone: string | null; dateOfBirth: string | null;
    gender: string | null; maritalStatus: string | null; bloodGroup: string | null;
    nationality: string | null;
  };
}) {
  return (
    <ActionForm action={updatePersonalDetails} hidden={{ employeeId: employee.id }} submitLabel="Save details">
      {(state) => (
        <div className="grid grid-3">
          <Field label="First name" name="firstName" state={state} required>
            <TextInput name="firstName" state={state} defaultValue={employee.firstName} required />
          </Field>
          <Field label="Middle name" name="middleName" state={state}>
            <TextInput name="middleName" state={state} defaultValue={employee.middleName} />
          </Field>
          <Field label="Last name" name="lastName" state={state} required>
            <TextInput name="lastName" state={state} defaultValue={employee.lastName} required />
          </Field>
          <Field label="Display name" name="displayName" state={state}>
            <TextInput name="displayName" state={state} defaultValue={employee.displayName} />
          </Field>
          <Field label="Work email" name="workEmail" state={state}>
            <TextInput name="workEmail" state={state} type="email" defaultValue={employee.workEmail} />
          </Field>
          <Field label="Personal email" name="personalEmail" state={state}>
            <TextInput name="personalEmail" state={state} type="email" defaultValue={employee.personalEmail} />
          </Field>
          <Field label="Mobile" name="mobile" state={state}>
            <TextInput name="mobile" state={state} defaultValue={employee.mobile} />
          </Field>
          <Field label="Alternate phone" name="alternatePhone" state={state}>
            <TextInput name="alternatePhone" state={state} defaultValue={employee.alternatePhone} />
          </Field>
          <Field label="Date of birth" name="dateOfBirth" state={state}>
            <TextInput name="dateOfBirth" state={state} type="date" defaultValue={employee.dateOfBirth?.slice(0, 10)} />
          </Field>
          <Field label="Gender" name="gender" state={state}>
            <SelectInput name="gender" state={state} options={GENDERS} defaultValue={employee.gender} placeholder="Not stated" />
          </Field>
          <Field label="Marital status" name="maritalStatus" state={state}>
            <SelectInput name="maritalStatus" state={state} options={MARITAL} defaultValue={employee.maritalStatus} placeholder="Not stated" />
          </Field>
          <Field label="Blood group" name="bloodGroup" state={state}>
            <SelectInput name="bloodGroup" state={state} options={BLOOD} defaultValue={employee.bloodGroup} placeholder="Not stated" />
          </Field>
          <Field label="Nationality" name="nationality" state={state}>
            <TextInput name="nationality" state={state} defaultValue={employee.nationality} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

const JOB_REASONS: Option[] = [
  { value: "PROMOTION", label: "Promotion" },
  { value: "TRANSFER", label: "Transfer" },
  { value: "DEPARTMENT_CHANGE", label: "Department change" },
  { value: "LOCATION_CHANGE", label: "Location change" },
  { value: "MANAGER_CHANGE", label: "Manager change" },
  { value: "CONFIRMATION", label: "Confirmation (ends probation)" },
  { value: "DEMOTION", label: "Demotion" },
  { value: "WORKER_TYPE_CHANGE", label: "Worker type change" },
];

export function JobChangeForm({
  employeeId, jobTitles, departments, businessUnits, locations, bands, grades, workerTypes, managers,
}: {
  employeeId: string; jobTitles: Option[]; departments: Option[]; businessUnits: Option[];
  locations: Option[]; bands: Option[]; grades: Option[]; workerTypes: Option[]; managers: Option[];
}) {
  return (
    <ActionForm action={recordJobChange} hidden={{ employeeId }} submitLabel="Record change">
      {(state) => (
        <>
          <div className="callout info" style={{ marginBottom: 14 }}>
            <div>
              Only the fields you change are updated; everything else carries over from the
              current record. The previous job row is closed the day before this one starts.
            </div>
          </div>
          <div className="grid grid-3">
            <Field label="Effective from" name="effectiveFrom" state={state} required>
              <TextInput name="effectiveFrom" state={state} type="date" required />
            </Field>
            <Field label="Reason" name="reason" state={state} required>
              <SelectInput name="reason" state={state} options={JOB_REASONS} required />
            </Field>
            <Field label="New job title" name="jobTitleId" state={state}>
              <SelectInput name="jobTitleId" state={state} options={jobTitles} placeholder="Unchanged" />
            </Field>
            <Field label="New department" name="departmentId" state={state}>
              <SelectInput name="departmentId" state={state} options={departments} placeholder="Unchanged" />
            </Field>
            <Field label="New business unit" name="businessUnitId" state={state}>
              <SelectInput name="businessUnitId" state={state} options={businessUnits} placeholder="Unchanged" />
            </Field>
            <Field label="New location" name="locationId" state={state}
              hint="A new state changes PT and LWF">
              <SelectInput name="locationId" state={state} options={locations} placeholder="Unchanged" />
            </Field>
            <Field label="New reporting manager" name="reportingManagerId" state={state}>
              <SelectInput name="reportingManagerId" state={state} options={managers} placeholder="Unchanged" />
            </Field>
            <Field label="New band" name="bandId" state={state}>
              <SelectInput name="bandId" state={state} options={bands} placeholder="Unchanged" />
            </Field>
            <Field label="New pay grade" name="payGradeId" state={state}>
              <SelectInput name="payGradeId" state={state} options={grades} placeholder="Unchanged" />
            </Field>
            <Field label="New worker type" name="workerTypeId" state={state}>
              <SelectInput name="workerTypeId" state={state} options={workerTypes} placeholder="Unchanged" />
            </Field>
          </div>
          <Field label="Note" name="note" state={state}>
            <TextInput name="note" state={state} placeholder="Why the change was made" />
          </Field>
          <CheckboxInput name="logActivity" label="Also record it on the HR activity timeline" defaultChecked />
        </>
      )}
    </ActionForm>
  );
}

export function SalaryRevisionForm({
  employeeId, structures, currentCtc,
}: { employeeId: string; structures: Option[]; currentCtc: number | null }) {
  return (
    <ActionForm action={reviseSalary} hidden={{ employeeId }} submitLabel="Save revision">
      {(state) => (
        <>
          <div className="callout warning" style={{ marginBottom: 14 }}>
            <div>
              A revision effective before a finalised payroll run does not change that month —
              it raises arrears for every closed month since, which are paid in step 5 of the
              next run.
            </div>
          </div>
          <div className="grid grid-3">
            <Field label="Effective from" name="effectiveFrom" state={state} required>
              <TextInput name="effectiveFrom" state={state} type="date" required />
            </Field>
            <Field label="New annual CTC" name="annualCtc" state={state} required
              hint={currentCtc ? `Currently ₹${currentCtc.toLocaleString("en-IN")}` : undefined}>
              <TextInput name="annualCtc" state={state} type="number" min={1} step={1000} required />
            </Field>
            <Field label="Salary structure" name="structureId" state={state}
              hint="Blank matches a range-based structure by CTC">
              <SelectInput name="structureId" state={state} options={structures} placeholder="Match automatically" />
            </Field>
          </div>
          <Field label="Reason" name="reason" state={state}>
            <TextInput name="reason" state={state} placeholder="Annual increment, promotion, market correction…" />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function StatutoryForm({ employeeId, profile }: {
  employeeId: string;
  profile: {
    pfEnabled: boolean; uan: string | null; pfAccountNumber: string | null;
    vpfAmount: number | null; vpfPercent: number | null; epsApplicable: boolean;
    esiEnabled: boolean; esicNumber: string | null; ptEnabled: boolean; lwfEnabled: boolean;
    taxRegime: string; flatTdsAmount: number | null; tdsDisabled: boolean;
    previousEmployerIncome: number | null; previousEmployerTds: number | null;
  } | null;
}) {
  return (
    <ActionForm action={saveStatutoryProfile} hidden={{ employeeId }} submitLabel="Save statutory profile">
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Tax regime" name="taxRegime" state={state} required>
              <SelectInput name="taxRegime" state={state} defaultValue={profile?.taxRegime ?? "NEW"}
                options={[{ value: "NEW", label: "New regime (s.115BAC)" }, { value: "OLD", label: "Old regime" }]} />
            </Field>
            <Field label="UAN" name="uan" state={state}>
              <TextInput name="uan" state={state} defaultValue={profile?.uan} maxLength={20} />
            </Field>
            <Field label="PF account" name="pfAccountNumber" state={state}>
              <TextInput name="pfAccountNumber" state={state} defaultValue={profile?.pfAccountNumber} />
            </Field>
            <Field label="VPF amount / month" name="vpfAmount" state={state}
              hint="Voluntary PF on top of 12%">
              <TextInput name="vpfAmount" state={state} type="number" min={0} defaultValue={profile?.vpfAmount} />
            </Field>
            <Field label="or VPF % of PF wage" name="vpfPercent" state={state}>
              <TextInput name="vpfPercent" state={state} type="number" min={0} max={100} step="0.5" defaultValue={profile?.vpfPercent} />
            </Field>
            <Field label="ESIC number" name="esicNumber" state={state}>
              <TextInput name="esicNumber" state={state} defaultValue={profile?.esicNumber} />
            </Field>
            <Field label="Flat TDS / month" name="flatTdsAmount" state={state}
              hint="For contractors — bypasses the annual projection">
              <TextInput name="flatTdsAmount" state={state} type="number" min={0} defaultValue={profile?.flatTdsAmount} />
            </Field>
            <Field label="Previous employer income (this FY)" name="previousEmployerIncome" state={state}>
              <TextInput name="previousEmployerIncome" state={state} type="number" min={0} defaultValue={profile?.previousEmployerIncome} />
            </Field>
            <Field label="Previous employer TDS (this FY)" name="previousEmployerTds" state={state}>
              <TextInput name="previousEmployerTds" state={state} type="number" min={0} defaultValue={profile?.previousEmployerTds} />
            </Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="pfEnabled" label="PF applies" defaultChecked={profile?.pfEnabled ?? true} />
            <CheckboxInput name="epsApplicable" label="EPS applies"
              hint="Off for those who joined above the ceiling after Sept 2014"
              defaultChecked={profile?.epsApplicable ?? true} />
            <CheckboxInput name="esiEnabled" label="ESI applies"
              hint="Still gated by the ₹21,000 wage limit"
              defaultChecked={profile?.esiEnabled ?? true} />
            <CheckboxInput name="ptEnabled" label="Professional Tax applies" defaultChecked={profile?.ptEnabled ?? true} />
            <CheckboxInput name="lwfEnabled" label="LWF applies" defaultChecked={profile?.lwfEnabled ?? true} />
            <CheckboxInput name="tdsDisabled" label="Disable TDS entirely" defaultChecked={profile?.tdsDisabled} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AddressForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={saveAddress} hidden={{ employeeId }} submitLabel="Save address">
      {(state) => (
        <>
          <SelectInput name="type" state={state} options={[
            { value: "CURRENT", label: "Current" }, { value: "PERMANENT", label: "Permanent" },
            { value: "EMERGENCY", label: "Emergency" },
          ]} />
          <TextInput name="line1" state={state} placeholder="Address line 1" required />
          <TextInput name="city" state={state} placeholder="City" />
          <TextInput name="state" state={state} placeholder="State" />
          <TextInput name="postalCode" state={state} placeholder="PIN" maxLength={12} />
        </>
      )}
    </InlineForm>
  );
}

export function IdentityForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={saveIdentity} hidden={{ employeeId }} submitLabel="Save ID">
      {(state) => (
        <>
          <SelectInput name="type" state={state} options={[
            { value: "PAN", label: "PAN" }, { value: "AADHAAR", label: "Aadhaar" },
            { value: "PASSPORT", label: "Passport" }, { value: "VOTER_ID", label: "Voter ID" },
            { value: "DRIVING_LICENCE", label: "Driving licence" },
            { value: "UAN", label: "UAN" }, { value: "ESIC_NUMBER", label: "ESIC number" },
          ]} />
          <TextInput name="number" state={state} placeholder="Number" required maxLength={30} />
          <TextInput name="nameOnDoc" state={state} placeholder="Name as on document" />
          <TextInput name="expiryDate" state={state} type="date" />
        </>
      )}
    </InlineForm>
  );
}

export function BankForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={saveEmployeeBank} hidden={{ employeeId }} submitLabel="Add account">
      {(state) => (
        <>
          <TextInput name="bankName" state={state} placeholder="Bank" required />
          <TextInput name="accountNumber" state={state} placeholder="Account number" required />
          <TextInput name="ifsc" state={state} placeholder="IFSC" required maxLength={11} />
          <TextInput name="branch" state={state} placeholder="Branch" />
          <label className="row gap-1 text-sm nowrap"><input type="checkbox" name="isPrimary" defaultChecked /> Primary</label>
        </>
      )}
    </InlineForm>
  );
}

export function EducationForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={addEducation} hidden={{ employeeId }} submitLabel="Add">
      {(state) => (
        <>
          <TextInput name="institution" state={state} placeholder="Institution" required />
          <TextInput name="degree" state={state} placeholder="Degree" />
          <TextInput name="specialization" state={state} placeholder="Specialisation" />
          <TextInput name="fromYear" state={state} type="number" placeholder="From" min={1950} max={2100} />
          <TextInput name="toYear" state={state} type="number" placeholder="To" min={1950} max={2100} />
        </>
      )}
    </InlineForm>
  );
}

export function ExperienceForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={addExperience} hidden={{ employeeId }} submitLabel="Add">
      {(state) => (
        <>
          <TextInput name="companyName" state={state} placeholder="Company" required />
          <TextInput name="jobTitle" state={state} placeholder="Title" />
          <TextInput name="fromDate" state={state} type="date" />
          <TextInput name="toDate" state={state} type="date" />
        </>
      )}
    </InlineForm>
  );
}

export function DependentForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={addDependent} hidden={{ employeeId }} submitLabel="Add">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name" required />
          <TextInput name="relationship" state={state} placeholder="Relationship" required />
          <TextInput name="dateOfBirth" state={state} type="date" />
          <label className="row gap-1 text-sm nowrap"><input type="checkbox" name="isNominee" /> Nominee</label>
        </>
      )}
    </InlineForm>
  );
}

export function EmergencyForm({ employeeId }: { employeeId: string }) {
  return (
    <InlineForm action={addEmergencyContact} hidden={{ employeeId }} submitLabel="Add">
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Name" required />
          <TextInput name="relationship" state={state} placeholder="Relationship" required />
          <TextInput name="phone" state={state} placeholder="Phone" required />
          <label className="row gap-1 text-sm nowrap"><input type="checkbox" name="isPrimary" /> Primary</label>
        </>
      )}
    </InlineForm>
  );
}

export function RemoveSubRecord({
  kind, id, employeeId,
}: { kind: string; id: string; employeeId: string }) {
  return <DangerButton action={deleteSubRecord} hidden={{ kind, id, employeeId }} label="Remove"
    confirmLabel="Remove this record?" />;
}

export function AccessControls({
  employeeId, hasLogin, loginDisabled, isDeactivated, email,
}: {
  employeeId: string; hasLogin: boolean; loginDisabled: boolean; isDeactivated: boolean; email: string | null;
}) {
  if (!hasLogin) {
    return (
      <ActionForm action={inviteToPortal} hidden={{ employeeId }} submitLabel="Create portal login" compact>
        {() => (
          <p className="text-sm muted" style={{ marginBottom: 6 }}>
            No login yet. Creating one uses {email ?? "their work email"}.
          </p>
        )}
      </ActionForm>
    );
  }
  return (
    <div className="stack gap-2">
      <ActionForm action={setLoginAccess}
        hidden={{ employeeId, mode: loginDisabled ? "enable" : "disable" }}
        submitLabel={loginDisabled ? "Re-enable login" : "Disable login"} compact>
        {() => (
          <p className="text-sm muted" style={{ marginBottom: 6 }}>
            {loginDisabled
              ? "Login is disabled."
              : "Disabling takes effect immediately, with no grace period."}
          </p>
        )}
      </ActionForm>
      <ActionForm action={setLoginAccess}
        hidden={{ employeeId, mode: isDeactivated ? "reactivate" : "deactivate" }}
        submitLabel={isDeactivated ? "Reactivate account" : "Deactivate account"} compact>
        {() => (
          <p className="text-sm muted" style={{ marginBottom: 6 }}>
            For a sabbatical or extended leave — distinct from an exit.
          </p>
        )}
      </ActionForm>
    </div>
  );
}
