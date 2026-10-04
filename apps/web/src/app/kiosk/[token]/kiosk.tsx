"use client";

import { useEffect, useRef, useState } from "react";
import { useForm, FormBanner } from "@/components/form";
import { unlockKioskAction, kioskPunchAction } from "../actions";

const IST = { timeZone: "Asia/Kolkata" } as const;

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ textAlign: "center", marginBottom: 18 }}>
      <div style={{ fontSize: 44, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {now ? now.toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
      </div>
      <div className="muted">{now ? now.toLocaleDateString("en-IN", { ...IST, weekday: "long", day: "numeric", month: "long" }) : ""}</div>
    </div>
  );
}

export function UnlockKiosk({ token }: { token: string }) {
  const [state, formAction, pending] = useForm(unlockKioskAction);
  useEffect(() => { if (state.ok) window.location.reload(); }, [state.ok]);
  return (
    <form action={formAction} className="stack gap-2">
      <FormBanner state={state} />
      <input type="hidden" name="token" value={token} />
      <label className="label" htmlFor="kiosk-pin">Kiosk PIN</label>
      <input id="kiosk-pin" className="input" name="pin" type="password" inputMode="numeric" maxLength={6} autoComplete="off" required />
      <button className="btn primary lg" type="submit" disabled={pending}>{pending ? "Checking…" : "Unlock this device"}</button>
    </form>
  );
}

export function KioskPad({ token }: { token: string }) {
  const [state, formAction, pending] = useForm(kioskPunchAction);
  const [round, setRound] = useState(0);
  const numberRef = useRef<HTMLInputElement>(null);
  // After each punch, clear the pad for the next person.
  useEffect(() => {
    if (!state.message) return;
    const t = setTimeout(() => { setRound((r) => r + 1); numberRef.current?.focus(); }, state.ok ? 2500 : 4000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <>
      <Clock />
      <form key={round} action={formAction} className="stack gap-2">
        {state.message ? <FormBanner state={state} /> : null}
        <input type="hidden" name="token" value={token} />
        <label className="label" htmlFor="employeeNumber">Employee number</label>
        <input id="employeeNumber" ref={numberRef} className="input" name="employeeNumber" autoComplete="off" autoFocus required style={{ fontSize: 20 }} />
        <label className="label" htmlFor="pin">Your PIN</label>
        <input id="pin" className="input" name="pin" type="password" inputMode="numeric" maxLength={6} autoComplete="off" required style={{ fontSize: 20 }} />
        <div className="row gap-2" style={{ marginTop: 8 }}>
          <button className="btn primary lg" style={{ flex: 1 }} type="submit" name="direction" value="in" disabled={pending}>Clock in</button>
          <button className="btn danger lg" style={{ flex: 1 }} type="submit" name="direction" value="out" disabled={pending}>Clock out</button>
        </div>
      </form>
    </>
  );
}
