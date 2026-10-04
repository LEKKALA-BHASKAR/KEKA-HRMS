"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { signIn, type SignInState } from "@/app/actions/auth";
import { IconChevronDown, IconEye, IconEyeOff } from "@/components/icons";
import { AuthLayout } from "./auth-layout";
import s from "./auth.module.css";

const DEMO_PASSWORD = "Keka@2026";
const DEMO_ACCOUNTS = [
  { email: "vikram.menon@acme.test", name: "Vikram Menon", role: "Global Admin" },
  { email: "ramesh.iyer@acme.test", name: "Ramesh Iyer", role: "Payroll Admin" },
  { email: "priya.sharma@acme.test", name: "Priya Sharma", role: "HR Manager" },
  { email: "deepak.chauhan@acme.test", name: "Deepak Chauhan", role: "HR Executive · scoped to 2 departments" },
  { email: "manish.tiwari@acme.test", name: "Manish Tiwari", role: "Finance Controller · custom role" },
  { email: "sneha.reddy@acme.test", name: "Sneha Reddy", role: "No explicit role · implicit Reporting Manager" },
  { email: "meera.krishnan@acme.test", name: "Meera Krishnan", role: "No role · self-service only" },
];

const initial: SignInState = {};

/**
 * Sign-in in two steps, as Keka does it: email first, then password.
 *
 * Step one never talks to the server. Asking the server "does this email
 * exist?" before the password would hand out a list of valid accounts, so
 * the email is only checked for shape here and both values go to the same
 * `signIn` action together — whose answers are already the same whether or
 * not the account exists (lockout included). Two-factor still redirects to
 * /signin/verify from inside the action.
 */
export function SignInForm({ product = "BooS-HR", next, sso, ssoError }: { product?: string; next?: string; sso?: { name: string; required: boolean } | null; ssoError?: string | null }) {
  const [state, formAction, pending] = useActionState(signIn, initial);
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const firstRender = useRef(true);
  // An error belongs to the attempt that caused it: hide it once the email changes.
  const [dismissed, setDismissed] = useState<SignInState | null>(null);
  const error = state !== dismissed ? state.error : undefined;

  // Move focus with the step, so the keyboard never has to hunt for it.
  useEffect(() => {
    if (step === "password") passwordRef.current?.focus();
    else if (!firstRender.current) { emailRef.current?.focus(); emailRef.current?.select(); }
    firstRender.current = false;
  }, [step]);

  // After a failed attempt, put the cursor back in the password, ready to retype.
  useEffect(() => {
    if (error && step === "password") passwordRef.current?.select();
  }, [state, error, step]);

  const toPassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = email.trim();
    if (!emailRef.current?.checkValidity() || !value) { emailRef.current?.reportValidity(); return; }
    setEmail(value);
    setStep("password");
  };

  const changeEmail = () => {
    setDismissed(state);
    setReveal(false);
    setStep("email");
  };

  const pickDemo = (address: string) => {
    setEmail(address);
    setPassword(DEMO_PASSWORD);
    setReveal(false);
    if (step === "password") passwordRef.current?.focus();
    else setStep("password");
  };

  return (
    <AuthLayout title={`Login to ${product}`}>
      <p className="sr-only" aria-live="polite">
        {step === "password" ? `Enter the password for ${email}.` : ""}
      </p>

      {ssoError ? <div className={s.error} role="alert" style={{ marginBottom: 14 }}>{ssoError}</div> : null}
      {sso ? (
        <div style={{ marginBottom: 18 }}>
          <a className={s.submit} style={{ display: "block", textAlign: "center", textDecoration: "none" }}
            href={`/auth/sso/start?${new URLSearchParams({ ...(next ? { next } : {}), ...(email ? { email } : {}) }).toString()}`}>
            Sign in with {sso.name}
          </a>
          <div className="text-xs" style={{ textAlign: "center", marginTop: 10, color: "var(--text-subtle)" }}>
            {sso.required ? "Your company signs in through its identity provider. Passwords work only for administrators." : "or use your password"}
          </div>
        </div>
      ) : null}
      {step === "email" ? (
        <form onSubmit={toPassword}>
          <div className={s.field}>
            <label className={s.label} htmlFor="signin-email">Email</label>
            <input
              ref={emailRef}
              id="signin-email"
              name="email"
              type="email"
              className={s.control}
              placeholder="you@company.com"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button className={s.submit} type="submit">Continue</button>
        </form>
      ) : (
        <form action={formAction}>
          <input type="hidden" name="subdomain" value="acme" />
          {next ? <input type="hidden" name="next" value={next} /> : null}
          {/* The username travels with the password, and password managers see the pair. */}
          <input type="email" name="email" value={email} autoComplete="username" readOnly hidden />

          <div className={s.who}>
            <span className={s.whoAvatar} aria-hidden="true">{email.charAt(0) || "?"}</span>
            <span className={s.whoEmail} title={email}>
              <span className="sr-only">Signing in as </span>{email}
            </span>
            <button type="button" className={s.linkBtn} onClick={changeEmail} aria-label={`Change email address (currently ${email})`}>
              Change
            </button>
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="signin-password">Password</label>
            <div className={s.passwordWrap}>
              <input
                ref={passwordRef}
                id="signin-password"
                name="password"
                type={reveal ? "text" : "password"}
                className={s.control}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "signin-error" : undefined}
              />
              <button
                type="button"
                className={s.reveal}
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "Hide password" : "Show password"}
                aria-pressed={reveal}
                aria-controls="signin-password"
              >
                {reveal ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
              </button>
            </div>
          </div>

          <div className={s.forgot}>
            <Link href="/signin/forgot">Forgot password?</Link>
          </div>

          {error ? (
            <div id="signin-error" className={s.error} role="alert">{error}</div>
          ) : null}

          <button className={s.submit} type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      <details className={s.demo}>
        <summary>
          <span>Demo accounts <span className={s.demoHint}>· password {DEMO_PASSWORD}</span></span>
          <IconChevronDown aria-hidden="true" />
        </summary>
        <div className={s.demoList}>
          {DEMO_ACCOUNTS.map((a) => (
            <button key={a.email} type="button" className={s.demoItem} onClick={() => pickDemo(a.email)}>
              <span className={s.demoAvatar} aria-hidden="true">{a.name.split(" ").map((p) => p[0]).join("")}</span>
              <span className={s.demoText}>
                <span className={s.demoName}>{a.name}</span>
                <span className={s.demoRole}>{a.role}</span>
              </span>
            </button>
          ))}
        </div>
      </details>
    </AuthLayout>
  );
}
