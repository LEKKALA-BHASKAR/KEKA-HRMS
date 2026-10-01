"use client";

import { useEffect, useState } from "react";
import { useForm } from "@/components/form";
import { clockAction } from "@/app/actions/time";
import s from "../home.module.css";

const fmt = (d: Date) =>
  d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase();

/** The current time in India, ticking. Starts from the server's render so hydration matches. */
export function LiveClock({ initial }: { initial: string }) {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    const tick = () => setNow(fmt(new Date()));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, []);
  return <time className={s.clockValue}>{now}</time>;
}

/** Web clock-in / clock-out, through the same action as Me → Attendance. */
export function ClockButton({ direction }: { direction: "in" | "out" }) {
  const [state, action, pending] = useForm(clockAction);
  return (
    <form action={action} className={s.clockForm}>
      <input type="hidden" name="direction" value={direction} />
      <button type="submit" className={`btn ${direction === "in" ? "primary" : ""} lg`} disabled={pending}>
        {pending ? "Recording…" : direction === "in" ? "Web Clock-In" : "Web Clock-Out"}
      </button>
      {state.message ? (
        <div role={state.ok ? "status" : "alert"} className={`${s.formMsg} ${state.ok ? s.ok : s.err}`}>{state.message}</div>
      ) : null}
    </form>
  );
}
