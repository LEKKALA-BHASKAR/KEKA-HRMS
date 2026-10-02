"use client";

import { useState } from "react";
import {
  ActionForm, InlineForm, DangerButton, Field, TextInput, SelectInput, TextArea, CheckboxInput,
  FormBanner, useForm,
} from "@/components/form";
import {
  applyLeaveAction, decideLeaveAction, cancelLeaveAction, adjustBalanceAction, runAccrualAction, runLeaveYearEndAction,
  saveLeaveType, deleteLeaveType, saveLeavePlan, assignLeavePlan,
  addHoliday, deleteHoliday, addHolidayCalendar,
  decideAttendanceRequestAction as decideAttendanceAction,
} from "@/app/actions/time";

export interface Option { value: string; label: string }

const PORTIONS: Option[] = [
  { value: "FULL_DAY", label: "Full day" },
  { value: "FIRST_HALF", label: "First half" },
  { value: "SECOND_HALF", label: "Second half" },
];

// ---------------------------------------------------------------------------
//  APPLY — with a live preview of the count and the balance it leaves
// ---------------------------------------------------------------------------

export function ApplyLeaveForm({
  types, employees, defaultEmployeeId,
}: {
  types: Array<Option & { allowHalfDay: boolean }>;
  /** Present when the viewer may apply on others' behalf. */
  employees?: Option[];
  defaultEmployeeId?: string;
}) {
  const [state, formAction, pending] = useForm(applyLeaveAction);
  const [single, setSingle] = useState(true);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction}>
      <FormBanner state={state} />
      {employees ? (
        <Field label="Employee" name="employeeId" state={state} hint="Leave blank to apply for yourself">
          <SelectInput name="employeeId" state={state} options={employees}
            defaultValue={defaultEmployeeId} placeholder="Myself" />
        </Field>
      ) : null}
      <Field label="Leave type" name="leaveTypeId" state={state} required>
        <SelectInput name="leaveTypeId" state={state} options={types} placeholder="Select…" required />
      </Field>
      <div className="grid grid-2">
        <Field label="From" name="fromDate" state={state} required>
          <TextInput name="fromDate" type="date" state={state} defaultValue={today} required />
        </Field>
        <Field label="To" name="toDate" state={state} required>
          <TextInput name="toDate" type="date" state={state} defaultValue={today} required />
        </Field>
        <Field label={single ? "Session" : "First day"} name="fromPortion" state={state}>
          <SelectInput name="fromPortion" state={state} options={PORTIONS} />
        </Field>
        <Field label="Last day" name="toPortion" state={state}>
          <SelectInput name="toPortion" state={state}
            options={PORTIONS.filter((p) => p.value !== "FIRST_HALF")} />
        </Field>
      </div>
      <label className="checkbox-row" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
        <span className="text-xs subtle">Single day — the first day&apos;s session applies</span>
      </label>
      <Field label="Reason" name="reason" state={state}>
        <TextArea name="reason" state={state} rows={2} placeholder="Optional unless the leave type requires it" />
      </Field>
      <div className="row gap-2">
        <button className="btn" type="submit" name="intent" value="preview" disabled={pending}>
          {pending ? "…" : "Check days & balance"}
        </button>
        <button className="btn primary" type="submit" name="intent" value="apply" disabled={pending}>
          {pending ? "Submitting…" : "Apply"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  DECIDE — approve outright, reject with a reason
// ---------------------------------------------------------------------------

export function DecisionForm({
  requestId, kind,
}: { requestId: string; kind: "leave" | "attendance" }) {
  const [state, formAction, pending] = useForm(kind === "leave" ? decideLeaveAction : decideAttendanceAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs" style={{ color: "var(--success)" }}>{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ minWidth: 220 }}>
      <input type="hidden" name="requestId" value={requestId} />
      {rejecting ? (
        <input className="input" name="note" placeholder="Reason for rejecting" required autoFocus />
      ) : null}
      <div className="row gap-2">
        {rejecting ? (
          <>
            <button className="btn sm danger" type="submit" name="decision" value="reject" disabled={pending}>
              {pending ? "…" : "Confirm reject"}
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setRejecting(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn sm primary" type="submit" name="decision" value="approve" disabled={pending}>
              {pending ? "…" : "Approve"}
            </button>
            <button className="btn sm" type="button" onClick={() => setRejecting(true)}>Reject</button>
          </>
        )}
      </div>
      {state.message && !state.ok ? (
        <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div>
      ) : null}
    </form>
  );
}

export function CancelLeaveButton({ requestId, label = "Cancel" }: { requestId: string; label?: string }) {
  return (
    <DangerButton action={cancelLeaveAction} hidden={{ requestId }} label={label}
      confirmLabel="Cancel this leave? Any days already deducted return to the balance." />
  );
}

// ---------------------------------------------------------------------------
//  BALANCES AND ACCRUAL
// ---------------------------------------------------------------------------

export function AdjustBalanceForm({ employeeId, types }: { employeeId: string; types: Option[] }) {
  return (
    <InlineForm action={adjustBalanceAction} submitLabel="Adjust" hidden={{ employeeId }}>
      {(state) => (
        <>
          <SelectInput name="leaveTypeId" state={state} options={types} placeholder="Leave type" required />
          <TextInput name="days" type="number" step="0.5" state={state} placeholder="± days" required />
          <TextInput name="note" state={state} placeholder="Why (recorded in the ledger)" required />
        </>
      )}
    </InlineForm>
  );
}

export function YearEndButton({ pending: count }: { pending: number }) {
  return (
    <ActionForm action={runLeaveYearEndAction} submitLabel={count ? `Close ${count} balance(s) now` : "Run year-end now"} compact>
      {() => <div className="text-sm muted">Runs every night by itself; use this after correcting a balance or changing a rule.</div>}
    </ActionForm>
  );
}

export function AccrualForm({ year, month }: { year: number; month: number }) {
  return (
    <ActionForm action={runAccrualAction} submitLabel="Run accrual">
      {(state) => (
        <div className="grid grid-2">
          <Field label="Year" name="year" state={state} required>
            <TextInput name="year" type="number" state={state} defaultValue={year} required />
          </Field>
          <Field label="Month" name="month" state={state} required hint="Credits land for this month's period">
            <TextInput name="month" type="number" min={1} max={12} state={state} defaultValue={month} required />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  LEAVE TYPE
// ---------------------------------------------------------------------------

export interface LeaveTypeValues {
  id?: string; name?: string; code?: string; category?: string; isPaid?: boolean;
  accrualFrequency?: string; annualQuota?: number | null; isUnlimited?: boolean;
  prorateOnJoining?: boolean; noAwardIfJoinAfterDay?: number | null;
  accrueDuringProbation?: boolean; maxDaysDuringProbation?: number | null;
  maxAccumulation?: number | null; allowNegativeBalance?: boolean; maxNegativeDays?: number | null;
  allowHalfDay?: boolean; allowQuarterDay?: boolean; allowBackdated?: boolean;
  priorNoticeDays?: number | null; requireComment?: boolean; attachmentAboveDays?: number | null;
  isHiddenFromEmployee?: boolean; maxConsecutiveDays?: number | null;
  maxDaysPerMonth?: number | null; minGapBetweenLeavesDays?: number | null;
  yearEndAction?: string; carryForwardMax?: number | null;
  encashmentEnabled?: boolean; encashmentFormula?: string | null;
  sandwichWeeklyOff?: boolean; sandwichHoliday?: boolean; sandwichEdges?: boolean;
  sandwichClub?: boolean; sandwichExcludeHalf?: boolean; color?: string | null;
}

const opt = (xs: string[]) => xs.map((v) => ({ value: v, label: v.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) }));

export function LeaveTypeForm({ type }: { type?: LeaveTypeValues }) {
  const t = type ?? {};
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : v);
  return (
    <ActionForm action={saveLeaveType} submitLabel={t.id ? "Save leave type" : "Create leave type"}
      hidden={t.id ? { id: t.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={t.name} required />
            </Field>
            <Field label="Code" name="code" state={state} required hint="Short, e.g. EL">
              <TextInput name="code" state={state} defaultValue={t.code} required maxLength={10} />
            </Field>
            <Field label="Category" name="category" state={state}>
              <SelectInput name="category" state={state} defaultValue={t.category ?? "REGULAR"}
                options={opt(["REGULAR", "INCIDENT", "COMP_OFF", "UNPAID", "FLOATER"])} />
            </Field>
            <Field label="Accrual" name="accrualFrequency" state={state}>
              <SelectInput name="accrualFrequency" state={state} defaultValue={t.accrualFrequency ?? "MONTHLY"}
                options={opt(["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "UPFRONT"])} />
            </Field>
            <Field label="Annual quota (days)" name="annualQuota" state={state}
              hint="For incident leave, the days granted per event">
              <TextInput name="annualQuota" type="number" step="0.5" state={state} defaultValue={num(t.annualQuota)} />
            </Field>
            <Field label="Colour" name="color" state={state}>
              <TextInput name="color" state={state} defaultValue={t.color} placeholder="#2563eb" />
            </Field>
          </div>

          <div className="text-xs strong subtle" style={{ margin: "6px 0 8px" }}>ENTITLEMENT</div>
          <div className="grid grid-3">
            <CheckboxInput name="isPaid" label="Paid leave" defaultChecked={t.isPaid ?? true}
              hint="Unpaid days become loss of pay in payroll" />
            <CheckboxInput name="isUnlimited" label="Unlimited" defaultChecked={t.isUnlimited} />
            <CheckboxInput name="prorateOnJoining" label="Prorate on joining" defaultChecked={t.prorateOnJoining ?? true} />
            <CheckboxInput name="accrueDuringProbation" label="Accrue during probation" defaultChecked={t.accrueDuringProbation ?? true} />
            <CheckboxInput name="allowNegativeBalance" label="Allow negative balance" defaultChecked={t.allowNegativeBalance} />
            <CheckboxInput name="isHiddenFromEmployee" label="Admin-applied only" defaultChecked={t.isHiddenFromEmployee}
              hint="Hidden from the employee's apply form" />
          </div>
          <div className="grid grid-3">
            <Field label="No award if joining after day" name="noAwardIfJoinAfterDay" state={state}>
              <TextInput name="noAwardIfJoinAfterDay" type="number" state={state} defaultValue={num(t.noAwardIfJoinAfterDay)} />
            </Field>
            <Field label="Max usable in probation" name="maxDaysDuringProbation" state={state}>
              <TextInput name="maxDaysDuringProbation" type="number" step="0.5" state={state} defaultValue={num(t.maxDaysDuringProbation)} />
            </Field>
            <Field label="Max accumulation" name="maxAccumulation" state={state}>
              <TextInput name="maxAccumulation" type="number" step="0.5" state={state} defaultValue={num(t.maxAccumulation)} />
            </Field>
            <Field label="Max negative days" name="maxNegativeDays" state={state}>
              <TextInput name="maxNegativeDays" type="number" step="0.5" state={state} defaultValue={num(t.maxNegativeDays)} />
            </Field>
          </div>

          <div className="text-xs strong subtle" style={{ margin: "6px 0 8px" }}>APPLYING</div>
          <div className="grid grid-3">
            <CheckboxInput name="allowHalfDay" label="Half days" defaultChecked={t.allowHalfDay ?? true} />
            <CheckboxInput name="allowQuarterDay" label="Quarter days" defaultChecked={t.allowQuarterDay} />
            <CheckboxInput name="allowBackdated" label="Back-dated requests" defaultChecked={t.allowBackdated ?? true} />
            <CheckboxInput name="requireComment" label="Reason required" defaultChecked={t.requireComment} />
          </div>
          <div className="grid grid-3">
            <Field label="Prior notice (days)" name="priorNoticeDays" state={state}>
              <TextInput name="priorNoticeDays" type="number" state={state} defaultValue={num(t.priorNoticeDays)} />
            </Field>
            <Field label="Max consecutive days" name="maxConsecutiveDays" state={state}>
              <TextInput name="maxConsecutiveDays" type="number" step="0.5" state={state} defaultValue={num(t.maxConsecutiveDays)} />
            </Field>
            <Field label="Attachment above (days)" name="attachmentAboveDays" state={state}>
              <TextInput name="attachmentAboveDays" type="number" step="0.5" state={state} defaultValue={num(t.attachmentAboveDays)} />
            </Field>
            <Field label="Max days in a month" name="maxDaysPerMonth" state={state} hint="Across all requests of this type">
              <TextInput name="maxDaysPerMonth" type="number" step="0.5" state={state} defaultValue={num(t.maxDaysPerMonth)} />
            </Field>
            <Field label="Min gap between requests (days)" name="minGapBetweenLeavesDays" state={state}>
              <TextInput name="minGapBetweenLeavesDays" type="number" state={state} defaultValue={num(t.minGapBetweenLeavesDays)} />
            </Field>
          </div>

          <div className="text-xs strong subtle" style={{ margin: "6px 0 8px" }}>SANDWICH RULE</div>
          <div className="grid grid-3">
            <CheckboxInput name="sandwichWeeklyOff" label="Count weekly-offs between leave" defaultChecked={t.sandwichWeeklyOff} />
            <CheckboxInput name="sandwichHoliday" label="Count holidays between leave" defaultChecked={t.sandwichHoliday} />
            <CheckboxInput name="sandwichEdges" label="Also at the edges" defaultChecked={t.sandwichEdges}
              hint="Off days adjoining the leave, and gaps between two requests" />
            <CheckboxInput name="sandwichClub" label="Club across leave types" defaultChecked={t.sandwichClub} />
            <CheckboxInput name="sandwichExcludeHalf" label="Ignore when a half day touches" defaultChecked={t.sandwichExcludeHalf} />
          </div>

          <div className="text-xs strong subtle" style={{ margin: "6px 0 8px" }}>YEAR END</div>
          <div className="grid grid-3">
            <Field label="At year end" name="yearEndAction" state={state}>
              <SelectInput name="yearEndAction" state={state} defaultValue={t.yearEndAction ?? "CARRY_FORWARD_ALL"}
                options={opt(["RESET", "PAY_ALL", "CARRY_FORWARD_ALL", "PAY_THEN_CARRY_FORWARD", "CARRY_FORWARD_THEN_PAY"])} />
            </Field>
            <Field label="Carry forward cap" name="carryForwardMax" state={state}>
              <TextInput name="carryForwardMax" type="number" step="0.5" state={state} defaultValue={num(t.carryForwardMax)} />
            </Field>
            <Field label="Encashment formula" name="encashmentFormula" state={state} hint="e.g. [BASIC] / 30">
              <TextInput name="encashmentFormula" state={state} defaultValue={t.encashmentFormula} />
            </Field>
          </div>
          <CheckboxInput name="encashmentEnabled" label="Encashable" defaultChecked={t.encashmentEnabled} />
        </>
      )}
    </ActionForm>
  );
}

export function DeleteLeaveTypeButton({ id }: { id: string }) {
  return <DangerButton action={deleteLeaveType} hidden={{ id }} label="Delete"
    confirmLabel="Delete this leave type? One with history is deactivated instead." />;
}

// ---------------------------------------------------------------------------
//  PLANS
// ---------------------------------------------------------------------------

export function LeavePlanForm({
  plan, types,
}: {
  plan?: { id: string; name: string; description: string | null; yearBasis: string; isDefault: boolean; typeIds: string[] };
  types: Option[];
}) {
  return (
    <ActionForm action={saveLeavePlan} submitLabel={plan ? "Save plan" : "Create plan"}
      hidden={plan ? { id: plan.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={plan?.name} required />
            </Field>
            <Field label="Leave year" name="yearBasis" state={state}>
              <SelectInput name="yearBasis" state={state} defaultValue={plan?.yearBasis ?? "FINANCIAL_APR"} options={[
                { value: "FINANCIAL_APR", label: "April to March" },
                { value: "CALENDAR_JAN", label: "January to December" },
                { value: "JOINING_DATE", label: "From each employee's joining date" },
              ]} />
            </Field>
          </div>
          <Field label="Description" name="description" state={state}>
            <TextInput name="description" state={state} defaultValue={plan?.description} />
          </Field>
          <div className="label">Leave types in this plan</div>
          <div className="grid grid-3" style={{ marginBottom: 8 }}>
            {types.map((t) => (
              <label key={t.value} className="checkbox-row">
                <input type="checkbox" name="leaveTypeIds" value={t.value}
                  defaultChecked={plan ? plan.typeIds.includes(t.value) : true} />
                <span className="text-sm">{t.label}</span>
              </label>
            ))}
          </div>
          <CheckboxInput name="isDefault" label="Default plan for new joiners" defaultChecked={plan?.isDefault} />
        </>
      )}
    </ActionForm>
  );
}

export function AssignPlanForm({ planId, employees }: { planId: string; employees: Option[] }) {
  const firstOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  return (
    <ActionForm action={assignLeavePlan} submitLabel="Assign" hidden={{ planId }} compact>
      {(state) => (
        <>
          <Field label="Employees" name="employeeIds" state={state} hint="Hold ⌘ or Ctrl to select several">
            <select name="employeeIds" multiple className="select" style={{ height: 140 }}>
              {employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </Field>
          <Field label="Effective from" name="effectiveFrom" state={state}>
            <TextInput name="effectiveFrom" type="date" state={state} defaultValue={firstOfMonth} />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  HOLIDAYS
// ---------------------------------------------------------------------------

export function AddHolidayForm({ calendarId, year }: { calendarId: string; year: number }) {
  return (
    <InlineForm action={addHoliday} submitLabel="Add holiday" hidden={{ calendarId }}>
      {(state) => (
        <>
          <TextInput name="name" state={state} placeholder="Holiday name" required />
          <TextInput name="date" type="date" state={state} required min={`${year}-01-01`} max={`${year}-12-31`} />
          <label className="checkbox-row"><input type="checkbox" name="isOptional" /><span className="text-sm">Optional</span></label>
        </>
      )}
    </InlineForm>
  );
}

export function DeleteHolidayButton({ id }: { id: string }) {
  return <DangerButton action={deleteHoliday} hidden={{ id }} label="Remove"
    confirmLabel="Remove this holiday? Attendance for the day will need reprocessing." />;
}

export function AddCalendarForm({ calendars, nextYear }: { calendars: Option[]; nextYear: number }) {
  return (
    <ActionForm action={addHolidayCalendar} submitLabel="Create calendar" compact>
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} required placeholder="India holidays" />
          </Field>
          <Field label="Year" name="year" state={state} required>
            <TextInput name="year" type="number" state={state} defaultValue={nextYear} required />
          </Field>
          <Field label="Copy holidays from" name="copyFromId" state={state}>
            <SelectInput name="copyFromId" state={state} options={calendars} placeholder="Start empty" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}
