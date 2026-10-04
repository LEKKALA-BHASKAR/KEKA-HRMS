"use client";

import { useState } from "react";
import {
  ActionForm, Field, TextInput, SelectInput, TextArea, CheckboxInput, FormBanner, DangerButton, useForm,
} from "@/components/form";
import {
  saveLeaveTypeRules, saveCompOffSettings, saveAttendanceRules, saveWeeklyOffPolicy, retireWeeklyOffPolicy,
  encashOnBehalfAction, bulkMarkAttendanceAction, importRosterAction, createKioskAction, updateKioskAction,
  setMyKioskPinAction, resetKioskPinAction, saveWorkLogAction, decideWorkLogAction,
} from "@/app/actions/time-leave-depth";

export interface Option { value: string; label: string }
const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : v);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const Section = ({ children }: { children: string }) => (
  <div className="text-xs strong subtle" style={{ margin: "12px 0 8px" }}>{children}</div>
);

// ---------------------------------------------------------------------------
//  Leave type rules
// ---------------------------------------------------------------------------

export interface LeaveRulesValues {
  id: string; name: string; unit: string;
  hoursPerDay: number | null; minHoursPerRequest: number | null; maxHoursPerDay: number | null; hourIncrementMinutes: number | null;
  allowEncashmentRequest: boolean; encashmentEnabled: boolean; encashmentMaxDaysPerYear: number | null;
  encashmentMinBalance: number | null; encashmentMonths: number[]; encashmentFormula: string | null;
  allowAdvanceLeave: boolean; advanceLeaveMaxDays: number | null;
}

export function LeaveRulesForm({ type: t }: { type: LeaveRulesValues }) {
  const [unit, setUnit] = useState(t.unit);
  return (
    <ActionForm action={saveLeaveTypeRules} submitLabel={`Save ${t.name} rules`} hidden={{ id: t.id }}>
      {(state) => (
        <>
          <Section>HOURLY LEAVE</Section>
          <div className="grid grid-3">
            <Field label="Counted in" name="unit" state={state} hint="Hours: applied by the hour on one date">
              <select id="unit" name="unit" className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="DAYS">Days</option>
                <option value="HOURS">Hours</option>
              </select>
            </Field>
            {unit === "HOURS" ? (
              <>
                <Field label="Hours in a working day" name="hoursPerDay" state={state} hint="For attendance and payroll">
                  <TextInput name="hoursPerDay" type="number" step="0.5" state={state} defaultValue={t.hoursPerDay ?? 8} />
                </Field>
                <Field label="Step (minutes)" name="hourIncrementMinutes" state={state}>
                  <TextInput name="hourIncrementMinutes" type="number" state={state} defaultValue={t.hourIncrementMinutes ?? 30} />
                </Field>
                <Field label="Minimum hours per request" name="minHoursPerRequest" state={state}>
                  <TextInput name="minHoursPerRequest" type="number" step="0.25" state={state} defaultValue={num(t.minHoursPerRequest)} />
                </Field>
                <Field label="Maximum hours on a day" name="maxHoursPerDay" state={state}>
                  <TextInput name="maxHoursPerDay" type="number" step="0.25" state={state} defaultValue={num(t.maxHoursPerDay)} />
                </Field>
              </>
            ) : null}
          </div>
          {unit === "HOURS" ? <div className="hint">Quota, balances and limits of this type are all in hours.</div> : null}

          <Section>ENCASHMENT</Section>
          <div className="grid grid-2">
            <CheckboxInput name="encashmentEnabled" label="Encashable" defaultChecked={t.encashmentEnabled}
              hint="HR and managers can encash it on an employee's behalf; paid out at exit" />
            <CheckboxInput name="allowEncashmentRequest" label="Employees may request encashment" defaultChecked={t.allowEncashmentRequest} />
          </div>
          <div className="grid grid-3">
            <Field label="Most days per leave year" name="encashmentMaxDaysPerYear" state={state}>
              <TextInput name="encashmentMaxDaysPerYear" type="number" step="0.5" state={state} defaultValue={num(t.encashmentMaxDaysPerYear)} />
            </Field>
            <Field label="Balance to keep" name="encashmentMinBalance" state={state} hint="Cannot encash below this">
              <TextInput name="encashmentMinBalance" type="number" step="0.5" state={state} defaultValue={num(t.encashmentMinBalance)} />
            </Field>
            <Field label="Rate" name="encashmentFormula" state={state} hint="[BASIC] / 30">
              <TextInput name="encashmentFormula" state={state} defaultValue={t.encashmentFormula ?? ""} placeholder="[BASIC] / 30" />
            </Field>
          </div>
          <div className="label">Open in these months <span className="hint">(none ticked = any month)</span></div>
          <div className="row gap-2 wrap" style={{ marginBottom: 8 }}>
            {MONTHS.map((m, i) => (
              <label key={m} className="checkbox-row" style={{ minWidth: 64 }}>
                <input type="checkbox" name="encashmentMonths" value={i + 1} defaultChecked={t.encashmentMonths.includes(i + 1)} />
                <span className="text-sm">{m}</span>
              </label>
            ))}
          </div>

          <Section>ADVANCE LEAVE</Section>
          <div className="grid grid-2">
            <CheckboxInput name="allowAdvanceLeave" label="Allow leave against accrual still to come"
              defaultChecked={t.allowAdvanceLeave} hint="The balance may go negative; later accruals recover it first" />
            <Field label={`Most ${unit === "HOURS" ? "hours" : "days"} in advance`} name="advanceLeaveMaxDays" state={state}
              hint="Never more than what is still due to accrue this leave year">
              <TextInput name="advanceLeaveMaxDays" type="number" step="0.5" state={state} defaultValue={num(t.advanceLeaveMaxDays)} />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Comp-off settings
// ---------------------------------------------------------------------------

export function CompOffSettingsForm({ type: t }: {
  type: { id: string; compOffRequestWindowDays: number | null; expiryDaysAfterCredit: number | null; compOffHalfDayMinHours: number | null; compOffFullDayMinHours: number | null };
}) {
  return (
    <ActionForm action={saveCompOffSettings} submitLabel="Save comp-off settings" hidden={{ id: t.id }}>
      {(state) => (
        <div className="grid grid-2">
          <Field label="Request within (days of the day worked)" name="compOffRequestWindowDays" state={state}>
            <TextInput name="compOffRequestWindowDays" type="number" state={state} defaultValue={t.compOffRequestWindowDays ?? 30} />
          </Field>
          <Field label="Credit expires after (days)" name="expiryDaysAfterCredit" state={state} hint="Empty: never expires">
            <TextInput name="expiryDaysAfterCredit" type="number" state={state} defaultValue={num(t.expiryDaysAfterCredit)} />
          </Field>
          <Field label="Hours worked for a half day" name="compOffHalfDayMinHours" state={state}
            hint="Empty: the attendance policy's half-day % of the shift">
            <TextInput name="compOffHalfDayMinHours" type="number" step="0.5" state={state} defaultValue={num(t.compOffHalfDayMinHours)} />
          </Field>
          <Field label="Hours worked for a full day" name="compOffFullDayMinHours" state={state}
            hint="Empty: the attendance policy's full-day % of the shift">
            <TextInput name="compOffFullDayMinHours" type="number" step="0.5" state={state} defaultValue={num(t.compOffFullDayMinHours)} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Attendance policy rules
// ---------------------------------------------------------------------------

export interface AttendanceRulesValues {
  id: string; name: string; hoursBasis: string; awolEnabled: boolean; awolAfterDays: number; newJoinerGraceDays: number;
  regularisationMonthlyLimit: number | null; regularisationCutoffDay: number | null;
  wfhMonthlyLimit: number | null; odMonthlyLimit: number | null; remoteNoticeDays: number | null;
  remoteAllowedOnHolidays: boolean; remoteAllowedOnWeeklyOffs: boolean; remoteAttachmentRequired: boolean;
  allowHalfDayRemoteWork: boolean; allowHourlyRemoteWork: boolean;
  overtimeToCompOff: boolean; overtimeCompOffHoursPerDay: number;
}

export function AttendanceRulesForm({ policy: p }: { policy: AttendanceRulesValues }) {
  return (
    <ActionForm action={saveAttendanceRules} submitLabel={`Save ${p.name}`} hidden={{ id: p.id }}>
      {(state) => (
        <>
          <Section>GENERAL</Section>
          <div className="grid grid-3">
            <Field label="Judge the day on" name="hoursBasis" state={state}>
              <SelectInput name="hoursBasis" state={state} defaultValue={p.hoursBasis}
                options={[{ value: "EFFECTIVE", label: "Effective hours (in–out pairs)" }, { value: "GROSS", label: "Gross hours (first in to last out)" }]} />
            </Field>
            <Field label="New-joiner grace (days)" name="newJoinerGraceDays" state={state} hint="No late or missing-punch penalties">
              <TextInput name="newJoinerGraceDays" type="number" state={state} defaultValue={p.newJoinerGraceDays} />
            </Field>
            <Field label="AWOL after (working days)" name="awolAfterDays" state={state}>
              <TextInput name="awolAfterDays" type="number" state={state} defaultValue={p.awolAfterDays} />
            </Field>
          </div>
          <CheckboxInput name="awolEnabled" label="Mark absent without leave (AWOL)" defaultChecked={p.awolEnabled}
            hint="That many consecutive working days with no attendance and no leave are each marked absent and full loss of pay" />

          <Section>REGULARISATION</Section>
          <div className="grid grid-2">
            <Field label="Corrections allowed per month" name="regularisationMonthlyLimit" state={state} hint="Adjustments and regularisations; empty = no limit">
              <TextInput name="regularisationMonthlyLimit" type="number" state={state} defaultValue={num(p.regularisationMonthlyLimit)} />
            </Field>
            <Field label="Cut-off day of the next month" name="regularisationCutoffDay" state={state} hint="After it, last month's days are closed">
              <TextInput name="regularisationCutoffDay" type="number" min={1} max={28} state={state} defaultValue={num(p.regularisationCutoffDay)} />
            </Field>
          </div>

          <Section>REMOTE WORK (WORK FROM HOME / ON DUTY)</Section>
          <div className="grid grid-3">
            <Field label="Work from home days per month" name="wfhMonthlyLimit" state={state} hint="Empty = no limit">
              <TextInput name="wfhMonthlyLimit" type="number" state={state} defaultValue={num(p.wfhMonthlyLimit)} />
            </Field>
            <Field label="On duty days per month" name="odMonthlyLimit" state={state} hint="Empty = no limit">
              <TextInput name="odMonthlyLimit" type="number" state={state} defaultValue={num(p.odMonthlyLimit)} />
            </Field>
            <Field label="Advance notice (days)" name="remoteNoticeDays" state={state}>
              <TextInput name="remoteNoticeDays" type="number" state={state} defaultValue={num(p.remoteNoticeDays)} />
            </Field>
          </div>
          <div className="grid grid-2">
            <CheckboxInput name="remoteAllowedOnHolidays" label="Allowed on holidays" defaultChecked={p.remoteAllowedOnHolidays} />
            <CheckboxInput name="remoteAllowedOnWeeklyOffs" label="Allowed on weekly offs" defaultChecked={p.remoteAllowedOnWeeklyOffs} />
            <CheckboxInput name="remoteAttachmentRequired" label="Supporting document required" defaultChecked={p.remoteAttachmentRequired} />
            <CheckboxInput name="allowHalfDayRemoteWork" label="Half-day requests allowed" defaultChecked={p.allowHalfDayRemoteWork} />
            <CheckboxInput name="allowHourlyRemoteWork" label="Hourly requests allowed" defaultChecked={p.allowHourlyRemoteWork} />
          </div>

          <Section>OVERTIME</Section>
          <div className="grid grid-2">
            <CheckboxInput name="overtimeToCompOff" label="Convert approved overtime to comp-off instead of paying it" defaultChecked={p.overtimeToCompOff} />
            <Field label="Overtime hours per comp-off day" name="overtimeCompOffHoursPerDay" state={state} hint="Credited in half days, rounded down">
              <TextInput name="overtimeCompOffHoursPerDay" type="number" step="0.5" state={state} defaultValue={p.overtimeCompOffHoursPerDay} />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Weekly-off pattern editor
// ---------------------------------------------------------------------------

const DAYS = [["MON", "Monday"], ["TUE", "Tuesday"], ["WED", "Wednesday"], ["THU", "Thursday"], ["FRI", "Friday"], ["SAT", "Saturday"], ["SUN", "Sunday"]] as const;
const RULE_OPTS = [
  { value: "WORKING", label: "Working day" },
  { value: "ALL", label: "Off every week" },
  { value: "ALT_2_4", label: "Off 2nd & 4th" },
  { value: "ALT_1_3_5", label: "Off 1st, 3rd & 5th" },
  { value: "CUSTOM", label: "Off on chosen weeks" },
];

export interface WeekdayRow { rule: string; instances: number[]; portion: string }

export function WeeklyOffForm({ pattern }: { pattern?: { id: string; name: string; isDefault: boolean; days: Record<string, WeekdayRow> } }) {
  const initial = Object.fromEntries(DAYS.map(([d]) => [d, pattern?.days[d] ?? { rule: d === "SAT" || d === "SUN" ? "ALL" : "WORKING", instances: [], portion: "FULL_DAY" }]));
  const [rows, setRows] = useState<Record<string, WeekdayRow>>(initial);
  return (
    <ActionForm action={saveWeeklyOffPolicy} submitLabel={pattern ? "Save pattern" : "Create pattern"} hidden={pattern ? { id: pattern.id } : undefined}>
      {(state) => (
        <>
          <div className="grid grid-2">
            <Field label="Name" name="name" state={state} required>
              <TextInput name="name" state={state} defaultValue={pattern?.name} placeholder="Alternate Saturdays off" required />
            </Field>
            <div style={{ paddingTop: 22 }}>
              <CheckboxInput name="isDefault" label="Default for employees with no assignment" defaultChecked={pattern?.isDefault} />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Day</th><th>Rule</th><th>Weeks of the month</th><th>Part of day</th></tr></thead>
              <tbody>
                {DAYS.map(([d, label]) => {
                  const r = rows[d];
                  return (
                    <tr key={d}>
                      <td className="strong text-sm">{label}</td>
                      <td>
                        <select name={`rule_${d}`} className="select" value={r.rule} aria-label={`${label} rule`}
                          onChange={(e) => setRows({ ...rows, [d]: { ...r, rule: e.target.value } })}>
                          {RULE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td>
                        {r.rule === "CUSTOM" ? (
                          <span className="row gap-2">
                            {[1, 2, 3, 4, 5].map((i) => (
                              <label key={i} className="checkbox-row">
                                <input type="checkbox" name={`inst_${d}`} value={i} defaultChecked={r.instances.includes(i)} />
                                <span className="text-sm">{i}</span>
                              </label>
                            ))}
                          </span>
                        ) : <span className="text-xs subtle">{r.rule === "WORKING" ? "—" : r.rule === "ALL" ? "every" : r.rule === "ALT_2_4" ? "2nd, 4th" : "1st, 3rd, 5th"}</span>}
                      </td>
                      <td>
                        <select name={`portion_${d}`} className="select" defaultValue={r.portion} disabled={r.rule === "WORKING"} aria-label={`${label} portion`}>
                          <option value="FULL_DAY">Full day</option>
                          <option value="FIRST_HALF">First half</option>
                          <option value="SECOND_HALF">Second half</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RetireWeeklyOffButton({ id }: { id: string }) {
  return <DangerButton action={retireWeeklyOffPolicy} hidden={{ id }} label="Retire" confirmLabel="Retire this weekly-off pattern?" />;
}

// ---------------------------------------------------------------------------
//  Encashment on behalf
// ---------------------------------------------------------------------------

export function EncashOnBehalfForm({ employeeId, types }: { employeeId: string; types: Array<Option & { encashable: number }> }) {
  return (
    <ActionForm action={encashOnBehalfAction} submitLabel="Raise encashment" hidden={{ employeeId }}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="Leave type" name="leaveTypeId" state={state} required>
              <SelectInput name="leaveTypeId" state={state} required placeholder="Select…"
                options={types.map((t) => ({ value: t.value, label: `${t.label} · ${t.encashable} encashable` }))} />
            </Field>
            <Field label="Days" name="days" state={state}>
              <TextInput name="days" type="number" step="0.5" state={state} />
            </Field>
            <div style={{ paddingTop: 22 }}><CheckboxInput name="all" label="Encash everything encashable" /></div>
          </div>
          <Field label="Note" name="note" state={state}>
            <TextInput name="note" state={state} placeholder="Why it is being encashed" />
          </Field>
        </>
      )}
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------
//  Bulk regularisation and roster import
// ---------------------------------------------------------------------------

export function BulkMarkForm({ employees, statuses, from, to }: { employees: Option[]; statuses: Option[]; from: string; to: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const shown = employees.filter((e) => e.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <ActionForm action={bulkMarkAttendanceAction} submitLabel={`Mark ${picked.length || ""} employee${picked.length === 1 ? "" : "s"}`}>
      {(state) => (
        <>
          <div className="grid grid-3">
            <Field label="From" name="fromDate" state={state} required>
              <TextInput name="fromDate" type="date" state={state} defaultValue={from} required />
            </Field>
            <Field label="To" name="toDate" state={state} required>
              <TextInput name="toDate" type="date" state={state} defaultValue={to} required />
            </Field>
            <Field label="Mark as" name="status" state={state} required>
              <SelectInput name="status" state={state} options={statuses} defaultValue="PRESENT" required />
            </Field>
          </div>
          <Field label="Reason" name="reason" state={state} required>
            <TextInput name="reason" state={state} placeholder="e.g. Biometric device down, all present" required />
          </Field>
          <CheckboxInput name="workingDaysOnly" label="Working days only (skip weekly offs and holidays)" defaultChecked />
          <div className="row gap-2" style={{ margin: "10px 0 6px", alignItems: "center" }}>
            <input className="input" placeholder="Filter employees" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
            <button type="button" className="btn sm" onClick={() => setPicked([...new Set([...picked, ...shown.map((e) => e.value)])])}>Select shown</button>
            <button type="button" className="btn sm ghost" onClick={() => setPicked([])}>Clear</button>
            <span className="text-xs subtle">{picked.length} selected</span>
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
            {shown.map((e) => (
              <label key={e.value} className="checkbox-row">
                <input type="checkbox" name="employeeIds" value={e.value} checked={picked.includes(e.value)}
                  onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.value] : picked.filter((x) => x !== e.value))} />
                <span className="text-sm">{e.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RosterImportForm() {
  const [state, formAction, pending] = useForm(importRosterAction);
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <Field label="CSV file" name="file" state={state} hint="Columns: employee number, date (yyyy-mm-dd), shift code. WO or OFF for a weekly off, DEFAULT to clear a day.">
        <input type="file" name="file" accept=".csv,text/csv" className="input" />
      </Field>
      <Field label="…or paste rows" name="csv" state={state}>
        <TextArea name="csv" state={state} rows={5} placeholder={"employee number,date,shift code\nACME0003,2026-10-12,GEN\nACME0003,2026-10-17,WO"} />
      </Field>
      <div className="row gap-2">
        <button className="btn" type="submit" name="intent" value="check" disabled={pending}>{pending ? "…" : "Check"}</button>
        <button className="btn primary" type="submit" name="intent" value="apply" disabled={pending}>{pending ? "Importing…" : "Import"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Kiosks and PINs
// ---------------------------------------------------------------------------

export function KioskForm({ locations }: { locations: Option[] }) {
  return (
    <ActionForm action={createKioskAction} submitLabel="Create kiosk">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required>
            <TextInput name="name" state={state} placeholder="Reception tablet" required />
          </Field>
          <Field label="Location" name="locationId" state={state}>
            <SelectInput name="locationId" state={state} options={locations} placeholder="Any location" />
          </Field>
          <Field label="Kiosk PIN" name="pin" state={state} required hint="4–6 digits, to unlock the device">
            <TextInput name="pin" type="password" state={state} required maxLength={6} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

function KioskOp({ id, op, label, children }: { id: string; op: string; label: string; children?: React.ReactNode }) {
  const [state, formAction, pending] = useForm(updateKioskAction);
  return (
    <form action={formAction} className="row gap-2" style={{ alignItems: "center" }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      {children}
      <button className="btn sm" type="submit" disabled={pending}>{pending ? "…" : label}</button>
      {state.message ? <span className="text-xs" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</span> : null}
    </form>
  );
}

export function KioskActions({ id, active }: { id: string; active: boolean }) {
  return (
    <div className="stack gap-2">
      <div className="row gap-2">
        <KioskOp id={id} op="toggle" label={active ? "Switch off" : "Switch on"} />
        <KioskOp id={id} op="rotate" label="New link" />
      </div>
      <KioskOp id={id} op="pin" label="Change PIN">
        <input className="input" name="pin" type="password" placeholder="New PIN" maxLength={6} style={{ maxWidth: 110 }} aria-label="New kiosk PIN" />
      </KioskOp>
    </div>
  );
}

export function KioskPinForm({ hasPin }: { hasPin: boolean }) {
  return (
    <ActionForm action={setMyKioskPinAction} submitLabel={hasPin ? "Change PIN" : "Set PIN"} compact>
      {(state) => (
        <div className="grid grid-2">
          <Field label="PIN" name="pin" state={state} required hint="4–6 digits">
            <TextInput name="pin" type="password" state={state} required maxLength={6} />
          </Field>
          <Field label="Repeat PIN" name="confirm" state={state} required>
            <TextInput name="confirm" type="password" state={state} required maxLength={6} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ResetKioskPinButton({ employeeId }: { employeeId: string }) {
  return <DangerButton action={resetKioskPinAction} hidden={{ employeeId }} label="Clear PIN" confirmLabel="Clear this employee's kiosk PIN? They will need to set a new one." />;
}

// ---------------------------------------------------------------------------
//  Work log
// ---------------------------------------------------------------------------

export function WorkLogForm({ weekStart, days, editable }: {
  weekStart: string;
  days: Array<{ date: string; label: string; hours: number; notes: string; future: boolean; offDay: boolean }>;
  editable: boolean;
}) {
  const [state, formAction, pending] = useForm(saveWorkLogAction);
  const [hours, setHours] = useState(days.map((d) => d.hours));
  const total = Math.round(hours.reduce((s, h) => s + (Number(h) || 0), 0) * 100) / 100;
  return (
    <form action={formAction}>
      <FormBanner state={state} />
      <input type="hidden" name="weekStart" value={weekStart} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Day</th><th className="num">Hours</th><th>Notes</th></tr></thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d.date}>
                <td className="text-sm nowrap">{d.label}{d.offDay ? <span className="text-xs subtle"> · off</span> : null}</td>
                <td className="num">
                  <input type="hidden" name="date" value={d.date} />
                  <input className="input num" type="number" name="hours" min={0} max={24} step={0.25} value={hours[i] || ""}
                    disabled={!editable || d.future} aria-label={`Hours on ${d.label}`} style={{ maxWidth: 90 }}
                    onChange={(e) => setHours(hours.map((h, j) => (j === i ? Number(e.target.value) : h)))} />
                  {!editable || d.future ? <input type="hidden" name="hours" value={hours[i] || 0} /> : null}
                </td>
                <td>
                  <input className="input" name="notes" defaultValue={d.notes} disabled={!editable} placeholder="What you worked on" aria-label={`Notes for ${d.label}`} />
                  {!editable ? <input type="hidden" name="notes" value={d.notes} /> : null}
                </td>
              </tr>
            ))}
            <tr><td className="strong">Total</td><td className="num strong">{total}</td><td /></tr>
          </tbody>
        </table>
      </div>
      {editable ? (
        <div className="row gap-2" style={{ marginTop: 10 }}>
          <button className="btn" type="submit" name="intent" value="save" disabled={pending}>{pending ? "…" : "Save draft"}</button>
          <button className="btn primary" type="submit" name="intent" value="submit" disabled={pending}>{pending ? "Submitting…" : "Submit week"}</button>
        </div>
      ) : null}
    </form>
  );
}

export function WorkLogDecision({ weekId }: { weekId: string }) {
  const [state, formAction, pending] = useForm(decideWorkLogAction);
  const [rejecting, setRejecting] = useState(false);
  if (state.ok) return <span className="text-xs" style={{ color: "var(--success)" }}>{state.message}</span>;
  return (
    <form action={formAction} className="stack gap-2" style={{ minWidth: 200 }}>
      <input type="hidden" name="weekId" value={weekId} />
      {rejecting ? <input className="input" name="note" placeholder="Why it is sent back" required autoFocus /> : null}
      <div className="row gap-2">
        {rejecting ? (
          <>
            <button className="btn sm danger" type="submit" name="decision" value="reject" disabled={pending}>Send back</button>
            <button className="btn sm ghost" type="button" onClick={() => setRejecting(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="btn sm primary" type="submit" name="decision" value="approve" disabled={pending}>Approve</button>
            <button className="btn sm" type="button" onClick={() => setRejecting(true)}>Send back</button>
          </>
        )}
      </div>
      {state.message ? <div className="text-xs" style={{ color: "var(--danger)" }}>{state.message}</div> : null}
    </form>
  );
}
