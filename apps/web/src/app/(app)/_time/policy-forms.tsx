"use client";

import { ActionForm, InlineForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm } from "@/components/form";
import {
  saveApprovalChainAction, runAutoApproveAction, setOptionalQuotaAction, optionalHolidayAction, grantCompOffAction,
  editAttendanceDayAction, importLopAction, generateShiftAllowanceAction, saveShiftAllowanceAction, saveTimePolicyDepthAction,
} from "@/app/actions/leave-policy";

export interface Option { value: string; label: string }

const ROLE_OPTIONS: Option[] = [
  { value: "REPORTING_MANAGER", label: "Reporting manager" },
  { value: "SKIP_LEVEL_MANAGER", label: "Manager's manager" },
  { value: "DEPARTMENT_HEAD", label: "Department head" },
  { value: "HR", label: "HR (anyone managing leave)" },
  { value: "ANY", label: "Any approver" },
];

// ---------------------------------------------------------------------------
//  Approval chain
// ---------------------------------------------------------------------------

export function ApprovalChainForm({
  target, id, chain,
}: {
  target: "plan" | "type"; id: string;
  chain: { levels: string[]; skipSamePerson: boolean; autoApproveAfterDays: number | null } | null;
}) {
  const levels = chain?.levels ?? [];
  return (
    <ActionForm action={saveApprovalChainAction} submitLabel="Save chain" hidden={{ target, id }} compact>
      {(state) => (
        <>
          <div className="grid grid-3">
            {[0, 1, 2].map((i) => (
              <Field key={i} label={`Level ${i + 1}`} name={`level${i}`} state={state}>
                <select name="levels" className="select" defaultValue={levels[i] ?? ""}>
                  <option value="">{i === 0 ? (target === "type" ? "Use the plan's chain" : "Single decision (default)") : "—"}</option>
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="grid grid-2">
            <Field label="Auto-approve after (days)" name="autoApproveAfterDays" state={state} hint="Blank: wait for a decision">
              <TextInput name="autoApproveAfterDays" type="number" min={0} state={state} defaultValue={chain?.autoApproveAfterDays ?? ""} />
            </Field>
            <CheckboxInput name="skipSamePerson" label="Skip a level its approver already cleared" defaultChecked={chain?.skipSamePerson ?? true}
              hint="e.g. the manager is also the department head, or HR approves first" />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function AutoApproveButton() {
  return (
    <ActionForm action={runAutoApproveAction} submitLabel="Run auto-approval now" compact>
      {() => <div className="text-sm muted">Runs nightly. Approves chained requests that waited past their window.</div>}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Optional holidays
// ---------------------------------------------------------------------------

export function OptionalQuotaForm({ calendarId, quota }: { calendarId: string; quota: number }) {
  return (
    <InlineForm action={setOptionalQuotaAction} submitLabel="Save quota" hidden={{ calendarId }}>
      {(state) => (
        <>
          <span className="text-sm muted">Optional holidays each employee may pick</span>
          <TextInput name="quota" type="number" min={0} max={30} state={state} defaultValue={quota} required />
        </>
      )}
    </InlineForm>
  );
}

export function OptionalHolidayButton({ holidayId, picked, employeeId }: { holidayId: string; picked: boolean; employeeId?: string }) {
  const [state, formAction, pending] = useForm(optionalHolidayAction);
  return (
    <form action={formAction} className="stack gap-1" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="holidayId" value={holidayId} />
      {employeeId ? <input type="hidden" name="employeeId" value={employeeId} /> : null}
      <button className={`btn sm${picked ? "" : " primary"}`} type="submit" name="intent" value={picked ? "remove" : "pick"} disabled={pending}>
        {pending ? "…" : picked ? "Remove" : "Pick"}
      </button>
      {state.message ? <span className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)", maxWidth: 260, textAlign: "right" }}>{state.message}</span> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Comp-off grant
// ---------------------------------------------------------------------------

export function GrantCompOffForm({ employees }: { employees: Option[] }) {
  return (
    <ActionForm action={grantCompOffAction} submitLabel="Grant comp-off">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Employee" name="employeeId" state={state} required>
              <SelectInput name="employeeId" state={state} options={employees} placeholder="Select…" required />
            </Field>
            <Field label="Days" name="days" state={state} required hint="Half days allowed">
              <TextInput name="days" type="number" step="0.5" min={0.5} max={10} state={state} defaultValue={1} required />
            </Field>
            <Field label="Worked on" name="workedOn" state={state} hint="Optional, for the record">
              <TextInput name="workedOn" type="date" state={state} />
            </Field>
            <Field label="Expires on" name="expiresOn" state={state} hint="Blank: the comp-off type's expiry">
              <TextInput name="expiresOn" type="date" state={state} />
            </Field>
          </div>
          <Field label="Reason" name="note" state={state} required>
            <TextInput name="note" state={state} placeholder="Weekend release support" required />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Attendance: day edit, LOP import, shift allowance, policy flags
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: Option[] = [
  { value: "", label: "Keep as calculated" },
  { value: "AUTO", label: "Clear a pinned status" },
  ...["PRESENT", "ABSENT", "HALF_DAY", "ON_DUTY", "WORK_FROM_HOME", "WEEKLY_OFF", "HOLIDAY", "NO_ATTENDANCE"].map((v) => ({
    value: v, label: v.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()),
  })),
];

export function EditDayForm({ employees, defaultEmployeeId, defaultDate }: { employees: Option[]; defaultEmployeeId?: string; defaultDate?: string }) {
  return (
    <ActionForm action={editAttendanceDayAction} submitLabel="Save day">
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Employee" name="employeeId" state={state} required>
              <SelectInput name="employeeId" state={state} options={employees} defaultValue={defaultEmployeeId} placeholder="Select…" required />
            </Field>
            <Field label="Date" name="date" state={state} required>
              <TextInput name="date" type="date" state={state} defaultValue={defaultDate} required />
            </Field>
            <Field label="In" name="firstIn" state={state} hint="Replaces the day's punches">
              <TextInput name="firstIn" type="time" state={state} />
            </Field>
            <Field label="Out" name="lastOut" state={state}>
              <TextInput name="lastOut" type="time" state={state} />
            </Field>
          </div>
          <Field label="Status" name="status" state={state} hint="A pinned status survives reprocessing until cleared">
            <SelectInput name="status" state={state} options={STATUS_OPTIONS} />
          </Field>
          <Field label="Reason" name="reason" state={state} required>
            <TextInput name="reason" state={state} placeholder="Biometric device was down" required />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function LopImportForm() {
  const [state, formAction, pending] = useForm(importLopAction);
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <Field label="CSV file" name="file" state={state} hint="Columns: Employee Number, Month (YYYY-MM), LOP Days, Note">
        <input type="file" name="file" accept=".csv,text/csv" className="input" />
      </Field>
      <Field label="…or paste rows" name="csv" state={state}>
        <TextArea name="csv" state={state} rows={4} placeholder={"Employee Number,Month,LOP Days,Note\nACME0007,2026-10,1.5,Unauthorised absence"} />
      </Field>
      <div className="row gap-2">
        <button className="btn" type="submit" name="intent" value="check" disabled={pending}>{pending ? "…" : "Check file"}</button>
        <button className="btn primary" type="submit" name="intent" value="import" disabled={pending}>{pending ? "Importing…" : "Import"}</button>
      </div>
    </form>
  );
}

export function ShiftAllowanceRunForm({ year, month }: { year: number; month: number }) {
  return (
    <ActionForm action={generateShiftAllowanceAction} submitLabel="Create allowance entries" compact>
      {(state) => (
        <div className="grid grid-2">
          <Field label="Year" name="year" state={state} required>
            <TextInput name="year" type="number" state={state} defaultValue={year} required />
          </Field>
          <Field label="Month" name="month" state={state} required>
            <TextInput name="month" type="number" min={1} max={12} state={state} defaultValue={month} required />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ShiftAllowanceRateForm({ shiftId, code, perDay }: { shiftId: string; code: string | null; perDay: number | null }) {
  return (
    <InlineForm action={saveShiftAllowanceAction} submitLabel="Save" hidden={{ shiftId }}>
      {(state) => (
        <>
          <TextInput name="allowanceCode" state={state} defaultValue={code} placeholder="Code, e.g. NSA" maxLength={20} />
          <TextInput name="allowancePerDay" type="number" step="0.01" min={0} state={state} defaultValue={perDay ?? ""} placeholder="₹ per day" />
        </>
      )}
    </InlineForm>
  );
}

export function TimePolicyDepthForm({ policy }: {
  policy: { id: string; autoCreditCompOff: boolean; overtimeMultiplier: number; overtimeOffDayMultiplier: number; overtimeRoundingMinutes: number };
}) {
  return (
    <ActionForm action={saveTimePolicyDepthAction} submitLabel="Save" hidden={{ policyId: policy.id }} compact>
      {(state) => (
        <>
          <CheckboxInput name="autoCreditCompOff" label="Credit comp-off automatically for worked weekly offs and holidays"
            defaultChecked={policy.autoCreditCompOff} hint="Otherwise employees request it" />
          <div className="grid grid-3">
            <Field label="Overtime multiplier" name="overtimeMultiplier" state={state}>
              <TextInput name="overtimeMultiplier" type="number" step="0.25" state={state} defaultValue={policy.overtimeMultiplier} required />
            </Field>
            <Field label="On weekly offs / holidays" name="overtimeOffDayMultiplier" state={state}>
              <TextInput name="overtimeOffDayMultiplier" type="number" step="0.25" state={state} defaultValue={policy.overtimeOffDayMultiplier} required />
            </Field>
            <Field label="Round down to (minutes)" name="overtimeRoundingMinutes" state={state} hint="0 = exact">
              <TextInput name="overtimeRoundingMinutes" type="number" min={0} state={state} defaultValue={policy.overtimeRoundingMinutes} required />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}
