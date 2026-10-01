"use client";

import { ActionForm, Field, TextInput, SelectInput, CheckboxInput, FormBanner, useForm } from "@/components/form";
import { saveTenantProfile, saveVisibility, saveSecurityPolicy, userSecurityAction, deliverMailNow } from "@/app/actions/settings";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ProfileForm({ name, timezone, fyStartMonth, locked }: { name: string; timezone: string; fyStartMonth: number; locked: boolean }) {
  return (
    <ActionForm action={saveTenantProfile} submitLabel="Save organisation">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Organisation name" name="name" state={state} required><TextInput name="name" state={state} defaultValue={name} required /></Field>
          <Field label="Time zone" name="timezone" state={state}>
            <SelectInput name="timezone" state={state} defaultValue={timezone} options={["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"].map((t) => ({ value: t, label: t }))} />
          </Field>
          <Field label="Financial year starts" name="fyStartMonth" state={state} hint={locked ? "Fixed — payroll is finalised in this year" : undefined}>
            <SelectInput name="fyStartMonth" state={state} defaultValue={String(fyStartMonth)} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function VisibilityForm({ v }: { v: { restrictByLegalEntity: boolean; restrictByBusinessUnit: boolean; managerReporteeOverride: boolean } }) {
  return (
    <ActionForm action={saveVisibility} submitLabel="Save visibility">
      {() => (
        <div className="stack gap-2">
          <CheckboxInput name="restrictByLegalEntity" label="People see only their own legal entity" defaultChecked={v.restrictByLegalEntity}
            hint="Roles granted without a scope still see everyone — privilege is added to visibility, not limited by it." />
          <CheckboxInput name="restrictByBusinessUnit" label="People see only their own business unit" defaultChecked={v.restrictByBusinessUnit} />
          <CheckboxInput name="managerReporteeOverride" label="Managers and their reports always see each other" defaultChecked={v.managerReporteeOverride} />
        </div>
      )}
    </ActionForm>
  );
}

export function SecurityForm({ s }: { s: { minPasswordLength: number; requireMixedCase: boolean; requireNumber: boolean; requireSymbol: boolean; passwordExpiryDays: number | null; passwordHistoryCount: number; maxFailedAttempts: number; lockoutMinutes: number; sessionHours: number; twoFactorPolicy: string } }) {
  return (
    <ActionForm action={saveSecurityPolicy} submitLabel="Save security policy">
      {(state) => (
        <>
          <div className="text-xs strong subtle" style={{ marginBottom: 8 }}>PASSWORDS</div>
          <div className="grid grid-3">
            <Field label="Minimum length" name="minPasswordLength" state={state} required><TextInput name="minPasswordLength" type="number" state={state} defaultValue={s.minPasswordLength} required /></Field>
            <Field label="Expire after (days)" name="passwordExpiryDays" state={state} hint="Blank never expires — current NIST guidance"><TextInput name="passwordExpiryDays" type="number" state={state} defaultValue={s.passwordExpiryDays ?? ""} /></Field>
            <Field label="Cannot reuse the last" name="passwordHistoryCount" state={state} required><TextInput name="passwordHistoryCount" type="number" state={state} defaultValue={s.passwordHistoryCount} required /></Field>
          </div>
          <div className="grid grid-3">
            <CheckboxInput name="requireMixedCase" label="Upper and lower case" defaultChecked={s.requireMixedCase} />
            <CheckboxInput name="requireNumber" label="A number" defaultChecked={s.requireNumber} />
            <CheckboxInput name="requireSymbol" label="A symbol" defaultChecked={s.requireSymbol} />
          </div>
          <div className="text-xs strong subtle" style={{ margin: "12px 0 8px" }}>SIGN-IN</div>
          <div className="grid grid-3">
            <Field label="Lock after failed attempts" name="maxFailedAttempts" state={state} required><TextInput name="maxFailedAttempts" type="number" state={state} defaultValue={s.maxFailedAttempts} required /></Field>
            <Field label="Lock for (minutes)" name="lockoutMinutes" state={state} required><TextInput name="lockoutMinutes" type="number" state={state} defaultValue={s.lockoutMinutes} required /></Field>
            <Field label="Session length (hours)" name="sessionHours" state={state} required><TextInput name="sessionHours" type="number" state={state} defaultValue={s.sessionHours} required /></Field>
            <Field label="Two-factor by email code" name="twoFactorPolicy" state={state}>
              <SelectInput name="twoFactorPolicy" state={state} defaultValue={s.twoFactorPolicy} options={[
                { value: "OFF", label: "Off" }, { value: "ADMINS", label: "Required for anyone with a role" }, { value: "EVERYONE", label: "Required for everyone" },
              ]} />
            </Field>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function UserSecurityForm() {
  const [state, action, pending] = useForm(userSecurityAction);
  return (
    <form action={action}>
      <FormBanner state={state} />
      <div className="row gap-2 wrap">
        <input className="input" name="email" type="email" placeholder="user@company.com" style={{ width: 260 }} />
        <button className="btn sm" name="op" value="unlock" disabled={pending}>Unlock</button>
        <button className="btn sm" name="op" value="sign-out" disabled={pending}>Sign out everywhere</button>
        <button className="btn sm" name="op" value="force-reset" disabled={pending}>Force password change</button>
        <span className="spacer" />
        <button className="btn sm danger" name="op" value="reset-all" disabled={pending}
          onClick={(e) => { if (!confirm("Sign out every user and make them all set a new password? Use this after a suspected breach.")) e.preventDefault(); }}>
          Reset everyone
        </button>
      </div>
    </form>
  );
}

export function DeliverMailButton() {
  const [state, action, pending] = useForm(deliverMailNow);
  return (
    <form action={action} className="row gap-2">
      {state.message ? <span className={`text-xs ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
      <button className="btn sm primary" disabled={pending}>{pending ? "Sending…" : "Deliver queued mail now"}</button>
    </form>
  );
}
