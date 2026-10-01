"use client";

import { useEffect, useState } from "react";
import { useForm } from "@/components/form";
import { clockAction } from "@/app/actions/time";
import s from "./parts.module.css";

/** The current instant, ticking. Null until mounted so server and client agree. */
function useNow(stepMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
const hm = (min: number) => `${Math.floor(min / 60)}h ${Math.floor(min % 60)}m`;

/** Wall-clock parts in the employee's zone, from a fixed UTC offset. */
function local(ms: number, tz: number) {
  const d = new Date(ms + tz * 60_000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth(), y: d.getUTCFullYear() };
}

/**
 * The live clock in the Actions box with the Web Clock-In / Clock-Out button,
 * posting to the shared clock action.
 */
export function ClockPanel({
  tzOffset, clockedInSince, closedMinutes, allowed, requireComment,
}: {
  tzOffset: number;
  clockedInSince: string | null;
  /** Completed in/out pairs today. */
  closedMinutes: number;
  allowed: boolean;
  requireComment: boolean;
}) {
  const now = useNow();
  const [state, formAction, pending] = useForm(clockAction);
  const since = clockedInSince ? new Date(clockedInSince).getTime() : null;
  const t = now ? local(now, tzOffset) : null;
  const worked = closedMinutes + (since && now ? Math.max(0, (now - since) / 60_000) : 0);
  const sinceL = since ? local(since, tzOffset) : null;

  return (
    <div className={s.clockWrap}>
      <div className={s.clockFace} aria-live="off">
        <span className={s.clockTime} suppressHydrationWarning>
          {t ? `${p2(t.h % 12 === 0 ? 12 : t.h % 12)}:${p2(t.m)}:${p2(t.s)}` : "--:--:--"}
        </span>
        <span className={s.clockAmPm}>{t ? (t.h < 12 ? "AM" : "PM") : ""}</span>
      </div>
      <div className={s.clockDate} suppressHydrationWarning>
        {t ? `${DAYS[t.dow]}, ${p2(t.day)} ${MONTHS[t.mon]} ${t.y}` : " "}
      </div>

      {allowed ? (
        <form action={formAction} className={s.clockForm}>
          <input type="hidden" name="direction" value={since ? "out" : "in"} />
          {requireComment ? (
            <input className="input" name="comment" required placeholder="Where are you working from?"
              aria-label="Clock-in comment" style={{ marginBottom: 8 }} />
          ) : null}
          <button type="submit" className={`${s.clockBtn}${since ? ` ${s.clockBtnOut}` : ""}`} disabled={pending}>
            {pending ? "Recording…" : since ? "Web Clock-Out" : "Web Clock-In"}
          </button>
          {since && sinceL ? (
            <div className={s.clockMeta} suppressHydrationWarning>
              In since {sinceL.h % 12 === 0 ? 12 : sinceL.h % 12}:{p2(sinceL.m)} {sinceL.h < 12 ? "AM" : "PM"} · {hm(worked)} today
            </div>
          ) : closedMinutes > 0 ? (
            <div className={s.clockMeta}>{hm(closedMinutes)} worked today</div>
          ) : null}
          {state.message ? (
            <div className={s.clockMeta} role="status" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>
              {state.message}
            </div>
          ) : null}
        </form>
      ) : (
        <div className={s.clockMeta}>Web clock-in is turned off for your attendance policy — use the biometric device or the mobile app.</div>
      )}
    </div>
  );
}

/** Today's progress against the shift, ticking while clocked in. */
export function TodayProgress({
  requiredMinutes, closedMinutes, openSince, label,
}: {
  requiredMinutes: number; closedMinutes: number; openSince: string | null; label: string;
}) {
  const now = useNow(30_000);
  const since = openSince ? new Date(openSince).getTime() : null;
  const worked = closedMinutes + (since && now ? Math.max(0, (now - since) / 60_000) : 0);
  const pct = requiredMinutes > 0 ? Math.min(100, (worked / requiredMinutes) * 100) : 0;
  return (
    <div
      className={s.progress} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={Math.round(requiredMinutes)} aria-valuenow={Math.round(worked)}
      aria-valuetext={`${hm(worked)} worked of ${hm(requiredMinutes)}`}
    >
      <div className={s.progressFill} style={{ width: `${pct}%` }} />
    </div>
  );
}
