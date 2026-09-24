"use client";

import { useActionState, useState } from "react";
import { signIn, type SignInState } from "@/app/actions/auth";

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

export function SignInForm() {
  const [state, formAction, pending] = useActionState(signIn, initial);
  const [email, setEmail] = useState("vikram.menon@acme.test");
  const [password, setPassword] = useState("Keka@2026");

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 34, height: 34, fontSize: 15 }}>K</div>
          <div>
            <div style={{ fontWeight: 650, fontSize: 16 }}>Keka</div>
            <div className="text-xs subtle">HR &amp; Payroll</div>
          </div>
        </div>

        <h2 style={{ marginBottom: 4 }}>Sign in</h2>
        <p className="muted text-sm" style={{ marginBottom: 20 }}>
          Enter your work email to continue to your organisation.
        </p>

        <form action={formAction}>
          <input type="hidden" name="subdomain" value="acme" />

          <div className="field">
            <label className="label" htmlFor="email">Work email</label>
            <input
              id="email" name="email" type="email" className="input"
              autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password" name="password" type="password" className="input"
              autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {state.error ? (
            <div className="callout danger" style={{ marginBottom: 14 }}>
              <div>{state.error}</div>
            </div>
          ) : null}

          <button className="btn primary block lg" type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="demo-accounts">
          <div className="text-xs subtle" style={{ marginBottom: 8, fontWeight: 600 }}>
            SEEDED ACCOUNTS — password Keka@2026
          </div>
          <div className="stack gap-1">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="demo-account"
                onClick={() => { setEmail(a.email); setPassword("Keka@2026"); }}
              >
                <div className="avatar sm">
                  {a.name.split(" ").map((p) => p[0]).join("")}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 550 }}>{a.name}</div>
                  <div className="text-xs subtle" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.role}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
