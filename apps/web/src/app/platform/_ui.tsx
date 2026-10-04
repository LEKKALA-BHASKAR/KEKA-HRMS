"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useActionState, useState, type ReactNode } from "react";
import type { PlatformState } from "@/app/actions/platform";
import { platformSignOut } from "@/app/actions/platform";
import s from "./platform.module.css";

type Action = (prev: PlatformState, fd: FormData) => Promise<PlatformState>;

/** Top bar for every signed-in platform page. */
export function PlatformNav({ name }: { name: string }) {
  const path = usePathname();
  const link = (href: string, label: string, match = (p: string) => p === href) => (
    <Link href={href} aria-current={match(path) ? "page" : undefined}>{label}</Link>
  );
  return (
    <header className={s.top}>
      <Link href="/platform" className={s.brand}>BooS-HR<span>Platform</span></Link>
      <nav className={s.nav} aria-label="Platform">
        {link("/platform", "Companies", (p) => p === "/platform" || p.startsWith("/platform/companies"))}
        {link("/platform/team", "Platform team")}
        {link("/platform/audit", "Activity")}
        {link("/platform/account", "My account")}
      </nav>
      <div className={s.me}>
        <span>{name}</span>
        <form action={platformSignOut}><button type="submit">Sign out</button></form>
      </div>
    </header>
  );
}

/** Shows what an action returned: an error, a note, and any one-time credentials. */
export function Outcome({ state }: { state: PlatformState }) {
  if (state.error) return <div className={s.error} role="alert">{state.error}</div>;
  if (!state.ok) return null;
  return (
    <>
      {state.info && !state.credentials ? <div className={s.info} role="status">{state.info}</div> : null}
      {state.credentials ? <Credentials info={state.info} {...state.credentials} /> : null}
    </>
  );
}

function Credentials({ info, url, email, password }: { info?: string; url?: string; email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const text = [url && `Sign-in address: ${url}`, `Email: ${email}`, `Temporary password: ${password}`, "You will be asked to choose a new password when you first sign in."].filter(Boolean).join("\n");
  return (
    <div className={s.creds} role="status">
      <strong>{info ?? "Done."}</strong>
      <dl>
        {url ? <><dt>Sign-in address</dt><dd><a href={url} target="_blank" rel="noreferrer">{url}</a></dd></> : null}
        <dt>Email</dt><dd>{email}</dd>
        <dt>Temporary password</dt><dd>{password}</dd>
      </dl>
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn sm" onClick={() => { navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}); }}>
          {copied ? "Copied" : "Copy sign-in details"}
        </button>
      </div>
    </div>
  );
}

/** A form bound to a platform action, with its outcome shown underneath. */
export function ActionForm({ action, children, submit, pendingLabel, className, confirm, danger }: {
  action: Action; children: ReactNode; submit: string; pendingLabel?: string; className?: string;
  /** Ask before submitting, for actions that affect a whole company. */
  confirm?: string; danger?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as PlatformState);
  return (
    <form action={formAction} className={className} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {children}
      <div className={s.actions} style={{ marginTop: 12 }}>
        <button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={pending}>{pending ? pendingLabel ?? "Saving…" : submit}</button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

/** The subdomain field shows the address the company will use as it is typed. */
export function SubdomainField({ baseDomain }: { baseDomain: string }) {
  const [v, setV] = useState("");
  const clean = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const sub = baseDomain && clean.endsWith(`.${baseDomain}`) ? clean.slice(0, -(baseDomain.length + 1)) : clean.split(".")[0];
  return (
    <div className="field">
      <label className="label" htmlFor="subdomain">Subdomain</label>
      <div className={s.subdomainRow}>
        <input id="subdomain" name="subdomain" className="input" required placeholder="bluecloudsoftech" autoCapitalize="none" spellCheck={false}
          value={v} onChange={(e) => setV(e.target.value)} pattern="[A-Za-z0-9.\-:/]+" />
        <span className={s.subdomainSuffix}>.{baseDomain || "your-domain"}</span>
      </div>
      <div className="hint">{sub ? <>People sign in at <strong>{sub}.{baseDomain}</strong>. You can also paste the full address.</> : "Letters, digits and hyphens. You can paste the full address too."}</div>
    </div>
  );
}

export function ModulePicker({ modules, enabled }: { modules: { key: string; label: string; description: string }[]; enabled: string[] }) {
  return (
    <div className={s.modules}>
      {modules.map((m) => (
        <label key={m.key} className={s.module}>
          <input type="checkbox" name="modules" value={m.key} defaultChecked={enabled.includes(m.key)} />
          <span>
            <div className={s.moduleName}>{m.label}</div>
            <div className={s.moduleDesc}>{m.description}</div>
          </span>
        </label>
      ))}
    </div>
  );
}
