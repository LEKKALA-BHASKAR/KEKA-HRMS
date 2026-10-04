"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  verifySecondFactor, requestPasswordReset, resetPassword, changePassword,
  type SignInState, type PasswordState,
} from "@/app/actions/auth";
import { AuthLayout } from "./auth-layout";
import s from "./auth.module.css";

function Message({ state }: { state: SignInState | PasswordState }) {
  const m = state as SignInState & PasswordState;
  if (m.error) return (
    <div className={s.error} role="alert">
      {m.error}
      {m.issues?.length ? <ul>{m.issues.map((i) => <li key={i}>Use {i}</li>)}</ul> : null}
    </div>
  );
  if (m.info) return <div className={s.info} role="status">{m.info}</div>;
  return null;
}

export function VerifyForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(verifySecondFactor, {} as SignInState);
  return (
    <AuthLayout title="Check your email" subtitle={`We sent a six-digit code to ${email}. It expires in 10 minutes.`}>
      <form action={action}>
        <div className={s.field}>
          <label className={s.label} htmlFor="code">Code</label>
          <input id="code" name="code" className={`${s.control} ${s.code}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
            aria-invalid={state.error ? true : undefined} />
        </div>
        <Message state={state} />
        <button className={s.submit} disabled={pending}>{pending ? "Checking…" : "Verify and sign in"}</button>
      </form>
      <div className={s.links}><Link href="/signin">Start again</Link></div>
    </AuthLayout>
  );
}

export function ForgotForm({ hasCompany }: { hasCompany: boolean }) {
  const [state, action, pending] = useActionState(requestPasswordReset, {} as SignInState);
  return (
    <AuthLayout title="Reset your password" subtitle="We will email you a link to choose a new one.">
      <form action={action}>
        {hasCompany ? null : (
          <div className={s.field}>
            <label className={s.label} htmlFor="company">Company code</label>
            <input id="company" name="subdomain" className={s.control} autoCapitalize="none" spellCheck={false} required />
          </div>
        )}
        <div className={s.field}>
          <label className={s.label} htmlFor="email">Email</label>
          <input id="email" name="email" type="email" className={s.control} placeholder="you@company.com" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
        </div>
        <Message state={state} />
        <button className={s.submit} disabled={pending}>{pending ? "Sending…" : "Send reset link"}</button>
      </form>
      <div className={s.links}><Link href="/signin">Back to sign in</Link></div>
    </AuthLayout>
  );
}

export function ResetForm({ token, rules }: { token: string; rules: string }) {
  const [state, action, pending] = useActionState(resetPassword, {} as PasswordState);
  if (state.ok) return (
    <AuthLayout title="Password changed" subtitle="Every other session has been signed out.">
      <Link className={s.submit} href="/signin">Sign in</Link>
    </AuthLayout>
  );
  return (
    <AuthLayout title="Choose a new password" subtitle={rules}>
      <form action={action}>
        <input type="hidden" name="token" value={token} />
        <div className={s.field}><label className={s.label} htmlFor="next">New password</label><input id="next" name="next" type="password" className={s.control} autoComplete="new-password" required autoFocus /></div>
        <div className={s.field}><label className={s.label} htmlFor="confirm">Confirm</label><input id="confirm" name="confirm" type="password" className={s.control} autoComplete="new-password" required /></div>
        <Message state={state} />
        <button className={s.submit} disabled={pending}>{pending ? "Saving…" : "Set password"}</button>
      </form>
    </AuthLayout>
  );
}

export function ChangePasswordForm({ required, rules }: { required: boolean; rules: string }) {
  const [state, action, pending] = useActionState(changePassword, {} as PasswordState);
  if (state.ok) return (
    <AuthLayout title="Password changed" subtitle="Your other sessions have been signed out; this one carries on.">
      <Link className={s.submit} href="/">Continue</Link>
    </AuthLayout>
  );
  return (
    <AuthLayout title={required ? "Set a new password to continue" : "Change password"} subtitle={required ? `Your password has expired or was reset by an administrator. ${rules}` : rules}>
      <form action={action}>
        <div className={s.field}><label className={s.label} htmlFor="current">Current password</label><input id="current" name="current" type="password" className={s.control} autoComplete="current-password" required autoFocus /></div>
        <div className={s.field}><label className={s.label} htmlFor="next">New password</label><input id="next" name="next" type="password" className={s.control} autoComplete="new-password" required /></div>
        <div className={s.field}><label className={s.label} htmlFor="confirm">Confirm</label><input id="confirm" name="confirm" type="password" className={s.control} autoComplete="new-password" required /></div>
        <Message state={state} />
        <button className={s.submit} disabled={pending}>{pending ? "Saving…" : "Change password"}</button>
      </form>
      {!required ? <div className={s.links}><Link href="/">Cancel</Link></div> : null}
    </AuthLayout>
  );
}
