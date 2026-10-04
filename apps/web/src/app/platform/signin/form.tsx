"use client";

import { useActionState } from "react";
import { platformSignIn, type PlatformState } from "@/app/actions/platform";
import s from "../platform.module.css";

export function PlatformSignInForm({ changed }: { changed: boolean }) {
  const [state, action, pending] = useActionState(platformSignIn, {} as PlatformState);
  return (
    <div className={s.signin}>
      <div className={s.signinCard}>
        <h1>BooS-HR Platform</h1>
        <p>For the BooS-HR team. Company staff sign in at their company&apos;s own address.</p>
        {changed ? <div className={s.info} style={{ marginTop: 0, marginBottom: 14 }}>Password changed. Sign in with the new one.</div> : null}
        <form action={action}>
          <div className="field">
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" className="input" autoComplete="username" required autoFocus />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" className="input" autoComplete="current-password" required />
          </div>
          <button type="submit" className="btn primary block lg" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
          {state.error ? <div className={s.error} role="alert">{state.error}</div> : null}
        </form>
      </div>
    </div>
  );
}
