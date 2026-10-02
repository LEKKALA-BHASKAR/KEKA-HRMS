"use client";

import { useEffect, useState } from "react";
import {
  ActionForm, DangerButton, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, useForm,
} from "@/components/form";
import {
  clockAction, raiseAttendanceRequestAction, cancelAttendanceRequestAction,
  saveShift, saveAttendancePolicy, assignTimePolicy, processAttendanceAction,
} from "@/app/actions/time";

export interface Option { value: string; label: string }

// ---------------------------------------------------------------------------
//  CLOCK IN / OUT
// ---------------------------------------------------------------------------

function useNow(): Date | null {
  // Rendered on the server without a clock, so the first paint matches.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const IST = { timeZone: "Asia/Kolkata" } as const;

export function ClockCard({
  clockedInSince, requireComment, allowed, shiftLabel, effectiveMinutesSoFar,
}: {
  /** ISO instant of the open IN punch, or null when not clocked in. */
  clockedInSince: string | null;
  requireComment: boolean;
  allowed: boolean;
  shiftLabel: string;
  /** Completed in/out pairs today, before the open slot. */
  effectiveMinutesSoFar: number;
}) {
  const [state, formAction, pending] = useForm(clockAction);
  const now = useNow();
  const inSince = clockedInSince ? new Date(clockedInSince) : null;
  const openMinutes = inSince && now ? Math.max(0, (now.getTime() - inSince.getTime()) / 60_000) : 0;
  const total = effectiveMinutesSoFar + openMinutes;
  const hm = (m: number) => `${Math.floor(m / 60)}h ${String(Math.floor(m % 60)).padStart(2, "0")}m`;

  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="clock-face">
            {now ? now.toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
          </div>
          <div className="text-sm muted">
            {now ? now.toLocaleDateString("en-IN", { ...IST, weekday: "long", day: "numeric", month: "long" }) : ""} · {shiftLabel}
          </div>
        </div>
        <div className="right">
          <div className="text-xs subtle">Worked today</div>
          <div className="strong num text-lg">{hm(total)}</div>
          {inSince ? (
            <div className="text-xs subtle">
              In since {inSince.toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit" })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="divider" />
      {allowed ? (
        <>
          {requireComment ? (
            <Field label="Comment" name="comment" state={state} required>
              <TextInput name="comment" state={state} placeholder="Where are you working from?" required />
            </Field>
          ) : null}
          <input type="hidden" name="direction" value={inSince ? "out" : "in"} />
          <button className={`btn ${inSince ? "danger" : "primary"} lg`} type="submit" disabled={pending} style={{ width: "100%" }}>
            {pending ? "Recording…" : inSince ? "Clock out" : "Clock in"}
          </button>
        </>
      ) : (
        <div className="text-sm muted">Web clock-in is turned off for your attendance policy. Use the biometric device or mobile app.</div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
//  REQUESTS
// ---------------------------------------------------------------------------

const REQUEST_TYPES: Array<Option & { hint: string }> = [
  { value: "ADJUSTMENT", label: "Attendance adjustment", hint: "Correct or add missing punches for a past day" },
  { value: "REGULARISATION", label: "Regularisation", hint: "Ask for a late-arrival or missing-punch penalty to be waived" },
  { value: "PARTIAL_DAY", label: "Partial day", hint: "Permission for a late start, early exit or mid-day absence" },
  { value: "WORK_FROM_HOME", label: "Work from home", hint: "Counted as present without office punches" },
  { value: "ON_DUTY", label: "On duty", hint: "Client visit, travel or event away from the office" },
];

export function AttendanceRequestForm({ defaultDate, defaultType }: {
  defaultDate: string;
  /** Preselects the request type (e.g. "WORK_FROM_HOME"); adjustment otherwise. */
  defaultType?: string;
}) {
  const [type, setType] = useState(
    defaultType && REQUEST_TYPES.some((t) => t.value === defaultType) ? defaultType : "ADJUSTMENT",
  );
  const meta = REQUEST_TYPES.find((t) => t.value === type)!;
  const multiDay = type === "WORK_FROM_HOME" || type === "ON_DUTY" || type === "REGULARISATION";
  return (
    <ActionForm action={raiseAttendanceRequestAction} submitLabel="Submit request">
      {(state) => (
        <>
          <Field label="Request" name="type" state={state} hint={meta.hint}>
            <select name="type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {REQUEST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-2">
            <Field label={multiDay ? "From" : "Date"} name="fromDate" state={state} required>
              <TextInput name="fromDate" type="date" state={state} defaultValue={defaultDate} required />
            </Field>
            {multiDay ? (
              <Field label="To" name="toDate" state={state}>
                <TextInput name="toDate" type="date" state={state} defaultValue={defaultDate} />
              </Field>
            ) : null}
            {type === "ADJUSTMENT" ? (
              <>
                <Field label="In time" name="inTime" state={state} hint="IST, 24-hour">
                  <TextInput name="inTime" type="time" state={state} defaultValue="09:30" />
                </Field>
                <Field label="Out time" name="outTime" state={state}>
                  <TextInput name="outTime" type="time" state={state} defaultValue="18:30" />
                </Field>
              </>
            ) : null}
            {type === "PARTIAL_DAY" ? (
              <Field label="Minutes away" name="partialMinutes" state={state} required>
                <TextInput name="partialMinutes" type="number" min={1} max={480} state={state} defaultValue={120} />
              </Field>
            ) : null}
          </div>
          <Field label="Reason" name="reason" state={state} required>
            <TextArea name="reason" state={state} rows={2} required />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

export function WithdrawRequestButton({ requestId }: { requestId: string }) {
  return <DangerButton action={cancelAttendanceRequestAction} hidden={{ requestId }} label="Withdraw"
    confirmLabel="Withdraw this request?" />;
}

// ---------------------------------------------------------------------------
//  ADMIN: SHIFTS, POLICIES, ASSIGNMENT, PROCESSING
// ---------------------------------------------------------------------------

export interface ShiftValues {
  id?: string; name?: string; code?: string; startTime?: string; endTime?: string;
  breakMinutes?: number; isFlexible?: boolean; requiredHours?: number | null;
  crossesMidnight?: boolean; color?: string | null;
}

export function ShiftForm({ shift }: { shift?: ShiftValues }) {
  const s = shift ?? {};
  return (
    <ActionForm action={saveShift} submitLabel={s.id ? "Save shift" : "Create shift"} hidden={s.id ? { id: s.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={s.name} required />
            </Field>
            <Field label="Code" name="code" state={state} required hint="Used in roster imports">
              <TextInput name="code" state={state} defaultValue={s.code} required maxLength={12} />
            </Field>
            <Field label="Colour" name="color" state={state}>
              <TextInput name="color" state={state} defaultValue={s.color} placeholder="#0f8a55" />
            </Field>
            <Field label="Starts" name="startTime" state={state} required>
              <TextInput name="startTime" type="time" state={state} defaultValue={s.startTime ?? "09:30"} required />
            </Field>
            <Field label="Ends" name="endTime" state={state} required>
              <TextInput name="endTime" type="time" state={state} defaultValue={s.endTime ?? "18:30"} required />
            </Field>
            <Field label="Break (minutes)" name="breakMinutes" state={state} required>
              <TextInput name="breakMinutes" type="number" state={state} defaultValue={s.breakMinutes ?? 60} required />
            </Field>
            <Field label="Required hours" name="requiredHours" state={state} hint="Flexible shifts only">
              <TextInput name="requiredHours" type="number" step="0.5" state={state} defaultValue={s.requiredHours ?? ""} />
            </Field>
          </div>
          <div className="grid grid-2">
            <CheckboxInput name="isFlexible" label="Flexible — count hours, not in/out times" defaultChecked={s.isFlexible} />
            <CheckboxInput name="crossesMidnight" label="Crosses midnight (night shift)" defaultChecked={s.crossesMidnight} />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export interface PolicyValues {
  id?: string; name?: string; description?: string | null;
  allowWebClockIn?: boolean; requireClockInComment?: boolean; ipAllowList?: string;
  requireGeofence?: boolean; requireSelfie?: boolean;
  fullDayThresholdPct?: number; halfDayThresholdPct?: number; graceMinutes?: number;
  lateExemptPerMonth?: number; latePenaltyDays?: number;
  missingPunchExemptPerMonth?: number; missingPunchPenaltyDays?: number;
  noAttendanceIsLop?: boolean; overtimeEnabled?: boolean; overtimeMinMinutes?: number;
  regularisationWindowDays?: number; isDefault?: boolean;
}

export function AttendancePolicyForm({ policy }: { policy?: PolicyValues }) {
  const p = policy ?? {};
  return (
    <ActionForm action={saveAttendancePolicy} submitLabel={p.id ? "Save policy" : "Create policy"} hidden={p.id ? { id: p.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={p.name} required />
            </Field>
            <Field label="Description" name="description" state={state}>
              <TextInput name="description" state={state} defaultValue={p.description} />
            </Field>
          </div>
          <div className="text-xs strong subtle" style={{ margin: "4px 0 8px" }}>CAPTURE</div>
          <div className="grid grid-2">
            <CheckboxInput name="allowWebClockIn" label="Allow web clock-in" defaultChecked={p.allowWebClockIn ?? true} />
            <CheckboxInput name="requireClockInComment" label="Require a comment on clock-in" defaultChecked={p.requireClockInComment} />
            <CheckboxInput name="requireGeofence" label="Web and mobile clock-in only inside the office geo-fence" defaultChecked={p.requireGeofence} hint="Set each location's coordinates and radius under Organisation" />
            <CheckboxInput name="requireSelfie" label="Require a selfie with each clock-in" defaultChecked={p.requireSelfie} />
          </div>
          <Field label="Allowed IP addresses" name="ipAllowList" state={state} hint="Comma or space separated. Empty allows any network.">
            <TextInput name="ipAllowList" state={state} defaultValue={p.ipAllowList} placeholder="203.0.113.10, 203.0.113.11" />
          </Field>
          <div className="text-xs strong subtle" style={{ margin: "4px 0 8px" }}>DAY CLASSIFICATION</div>
          <div className="grid grid-3">
            <Field label="Full day at (% of shift)" name="fullDayThresholdPct" state={state} required>
              <TextInput name="fullDayThresholdPct" type="number" state={state} defaultValue={p.fullDayThresholdPct ?? 90} required />
            </Field>
            <Field label="Half day at (% of shift)" name="halfDayThresholdPct" state={state} required>
              <TextInput name="halfDayThresholdPct" type="number" state={state} defaultValue={p.halfDayThresholdPct ?? 50} required />
            </Field>
            <Field label="Regularise within (days)" name="regularisationWindowDays" state={state} required>
              <TextInput name="regularisationWindowDays" type="number" state={state} defaultValue={p.regularisationWindowDays ?? 30} required />
            </Field>
          </div>
          <CheckboxInput name="noAttendanceIsLop" label="A working day with no punches and no leave is loss of pay" defaultChecked={p.noAttendanceIsLop ?? true} />
          <div className="text-xs strong subtle" style={{ margin: "10px 0 8px" }}>PENALTIES</div>
          <div className="grid grid-3">
            <Field label="Grace (minutes)" name="graceMinutes" state={state} required>
              <TextInput name="graceMinutes" type="number" state={state} defaultValue={p.graceMinutes ?? 15} required />
            </Field>
            <Field label="Late arrivals forgiven / month" name="lateExemptPerMonth" state={state} required>
              <TextInput name="lateExemptPerMonth" type="number" state={state} defaultValue={p.lateExemptPerMonth ?? 3} required />
            </Field>
            <Field label="LOP per extra late arrival" name="latePenaltyDays" state={state} required>
              <TextInput name="latePenaltyDays" type="number" step="0.25" state={state} defaultValue={p.latePenaltyDays ?? 0.5} required />
            </Field>
            <Field label="Missing punches forgiven / month" name="missingPunchExemptPerMonth" state={state} required>
              <TextInput name="missingPunchExemptPerMonth" type="number" state={state} defaultValue={p.missingPunchExemptPerMonth ?? 2} required />
            </Field>
            <Field label="LOP per extra missing punch" name="missingPunchPenaltyDays" state={state} required>
              <TextInput name="missingPunchPenaltyDays" type="number" step="0.25" state={state} defaultValue={p.missingPunchPenaltyDays ?? 0.5} required />
            </Field>
          </div>
          <div className="text-xs strong subtle" style={{ margin: "4px 0 8px" }}>OVERTIME</div>
          <div className="grid grid-2">
            <CheckboxInput name="overtimeEnabled" label="Track overtime" defaultChecked={p.overtimeEnabled} />
            <Field label="Counts after (minutes past shift)" name="overtimeMinMinutes" state={state} required>
              <TextInput name="overtimeMinMinutes" type="number" state={state} defaultValue={p.overtimeMinMinutes ?? 30} required />
            </Field>
          </div>
          <CheckboxInput name="isDefault" label="Default for employees with no assignment" defaultChecked={p.isDefault} />
        </>
      )}
    </ActionForm>
  );
}

export function AssignTimePolicyForm({
  employees, policies, shifts, weeklyOffs,
}: { employees: Option[]; policies: Option[]; shifts: Option[]; weeklyOffs: Option[] }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ActionForm action={assignTimePolicy} submitLabel="Assign">
      {(state) => (
        <>
          <Field label="Employees" name="employeeIds" state={state} hint="Hold ⌘ or Ctrl to select several">
            <select name="employeeIds" multiple className="select" style={{ height: 160 }}>
              {employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-2">
            <Field label="Attendance policy" name="attendancePolicyId" state={state}>
              <SelectInput name="attendancePolicyId" state={state} options={policies} placeholder="Tenant default" />
            </Field>
            <Field label="Shift" name="shiftId" state={state}>
              <SelectInput name="shiftId" state={state} options={shifts} placeholder="Tenant default" />
            </Field>
            <Field label="Weekly-off pattern" name="weeklyOffPolicyId" state={state}>
              <SelectInput name="weeklyOffPolicyId" state={state} options={weeklyOffs} placeholder="Tenant default" />
            </Field>
            <Field label="Effective from" name="effectiveFrom" state={state}>
              <TextInput name="effectiveFrom" type="date" state={state} defaultValue={today} />
            </Field>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" name="trackAttendance" defaultChecked />
            <span className="text-sm">Track attendance
              <div className="hint" style={{ marginTop: 1 }}>Untick for leadership and field staff — no loss of pay from missing punches</div>
            </span>
          </label>
        </>
      )}
    </ActionForm>
  );
}

export function ProcessAttendanceForm({ from, to }: { from: string; to: string }) {
  return (
    <ActionForm action={processAttendanceAction} submitLabel="Process">
      {(state) => (
        <div className="grid grid-2">
          <Field label="From" name="fromDate" state={state} required>
            <TextInput name="fromDate" type="date" state={state} defaultValue={from} required />
          </Field>
          <Field label="To" name="toDate" state={state} required hint="Days after today are never processed">
            <TextInput name="toDate" type="date" state={state} defaultValue={to} required />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}
