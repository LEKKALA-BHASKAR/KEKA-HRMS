"use client";

import { useForm, Field, TextInput, FormBanner } from "@/components/form";
import { saveSsoAction, testSsoAction } from "@/app/actions/sso";

export interface SsoView { providerName: string; issuer: string; clientId: string; scopes: string; allowedDomains: string[]; enabled: boolean; enforced: boolean; hasSecret: boolean }

export function SsoForm({ c }: { c: SsoView | null }) {
  const [state, action, pending] = useForm(saveSsoAction);
  return (
    <form action={action} className="stack gap-3">
      <FormBanner state={state} />
      <div className="grid grid-2">
        <Field label="Identity provider" name="providerName" state={state} required hint="Shown on the button: Okta, Microsoft Entra ID, Google"><TextInput name="providerName" state={state} defaultValue={c?.providerName} /></Field>
        <Field label="Issuer URL" name="issuer" state={state} required hint="For example https://yourcompany.okta.com"><TextInput name="issuer" state={state} defaultValue={c?.issuer} placeholder="https://" /></Field>
        <Field label="Client ID" name="clientId" state={state} required><TextInput name="clientId" state={state} defaultValue={c?.clientId} /></Field>
        <Field label="Client secret" name="clientSecret" state={state} required={!c?.hasSecret} hint={c?.hasSecret ? "Stored and hidden. Leave blank to keep it." : undefined}><TextInput name="clientSecret" type="password" state={state} /></Field>
        <Field label="Scopes" name="scopes" state={state}><TextInput name="scopes" state={state} defaultValue={c?.scopes ?? "openid email profile"} /></Field>
        <Field label="Allowed email domains" name="allowedDomains" state={state} hint="Comma separated. Leave blank to allow any domain the provider vouches for."><TextInput name="allowedDomains" state={state} defaultValue={c?.allowedDomains.join(", ")} /></Field>
      </div>
      <label className="row gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={c?.enabled} /> Turn on: show &ldquo;Sign in with&nbsp;…&rdquo; on the sign-in page</label>
      <label className="row gap-2 text-sm"><input type="checkbox" name="enforced" defaultChecked={c?.enforced} /> Require it: refuse password sign-in, except for people who manage authentication</label>
      <div><button className="btn primary" disabled={pending}>Save</button></div>
    </form>
  );
}

export function TestSso() {
  const [state, action, pending] = useForm(testSsoAction);
  return (
    <form action={action} className="row gap-2">
      <button className="btn" disabled={pending}>Test connection</button>
      {state.message ? <span className={`text-sm ${state.ok ? "pos" : "neg"}`}>{state.message}</span> : null}
    </form>
  );
}
