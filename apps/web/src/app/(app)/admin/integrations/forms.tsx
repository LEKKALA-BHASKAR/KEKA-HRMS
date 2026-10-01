"use client";

import { useState } from "react";
import { useForm, ActionForm, Field, TextInput, SelectInput } from "@/components/form";
import { createApiKeyAction, revokeApiKeyAction, saveDeviceAction, toggleDeviceAction } from "@/app/actions/integrations";

export function CreateKey({ scopes }: { scopes: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useForm(createApiKeyAction);
  const [copied, setCopied] = useState(false);
  const key = (state as { key?: string }).key;
  if (state.ok && key) {
    return (
      <div className="stack gap-2">
        <div className="text-sm"><strong>{state.message}</strong></div>
        <code className="mono" style={{ wordBreak: "break-all", padding: 8, background: "var(--surface-2, #f4f4f5)", borderRadius: 6 }}>{key}</code>
        <div className="row gap-2">
          <button type="button" className="btn sm" onClick={() => { void navigator.clipboard?.writeText(key); setCopied(true); }}>{copied ? "Copied" : "Copy key"}</button>
          <a className="btn sm ghost" href="/admin/integrations">Done</a>
        </div>
      </div>
    );
  }
  return (
    <form action={formAction} className="stack gap-2">
      <Field label="Name" name="name" state={state} required hint="What uses it, e.g. Gate biometric bridge">
        <TextInput name="name" state={state} required />
      </Field>
      <Field label="Allowed to" name="scopes" state={state} required>
        <div className="stack">{scopes.map((s) => <label key={s.value} className="row gap-2 text-sm"><input type="checkbox" name="scopes" value={s.value} defaultChecked={s.value === "attendance:write"} /> {s.label}</label>)}</div>
      </Field>
      <Field label="Expires after (days)" name="expiresInDays" state={state} hint="0 never expires">
        <TextInput name="expiresInDays" type="number" state={state} defaultValue={365} min={0} />
      </Field>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <button className="btn primary" disabled={pending}>{pending ? "Creating…" : "Create key"}</button>
        {state.message && !state.ok ? <span className="text-sm neg">{state.message}</span> : null}
      </div>
    </form>
  );
}

export function RevokeKey({ id }: { id: string }) {
  const [state, formAction, pending] = useForm(revokeApiKeyAction);
  if (state.ok) return <span className="text-xs pos">Revoked</span>;
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button className="btn sm ghost" disabled={pending}>Revoke</button>
      {state.message ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}

export function DeviceForm({ locations }: { locations: { value: string; label: string }[] }) {
  return (
    <ActionForm action={saveDeviceAction} submitLabel="Register device">
      {(state) => (
        <div className="grid grid-3">
          <Field label="Name" name="name" state={state} required><TextInput name="name" state={state} required placeholder="Main gate" /></Field>
          <Field label="Serial number" name="serialNumber" state={state} required hint="As the device reports it"><TextInput name="serialNumber" state={state} required /></Field>
          <Field label="Location" name="locationId" state={state}><SelectInput name="locationId" state={state} options={locations} placeholder="Any" /></Field>
        </div>
      )}
    </ActionForm>
  );
}

export function ToggleDevice({ id, active }: { id: string; active: boolean }) {
  const [state, formAction, pending] = useForm(toggleDeviceAction);
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <button className="btn sm ghost" disabled={pending}>{active ? "Switch off" : "Switch on"}</button>
      {state.message && !state.ok ? <div className="text-xs neg">{state.message}</div> : null}
    </form>
  );
}
