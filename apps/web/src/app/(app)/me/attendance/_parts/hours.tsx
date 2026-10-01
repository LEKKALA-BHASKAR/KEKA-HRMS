"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import s from "./parts.module.css";

/**
 * The "24 hour format" switch on Logs & Requests. Times inside the scope are
 * rendered by <Tm>, which reads the preference; it is remembered per browser.
 * Times are passed as minutes after the employee's local midnight, so no time
 * zone arithmetic happens in the browser.
 */

const KEY = "keka.attendance.h24";
const Ctx = createContext<{ h24: boolean; set: (v: boolean) => void }>({ h24: false, set: () => {} });

export function HourFormatScope({ children }: { children: ReactNode }) {
  const [h24, setH24] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem(KEY) === "1") setH24(true); } catch { /* storage unavailable */ }
  }, []);
  const set = (v: boolean) => {
    setH24(v);
    try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  return <Ctx.Provider value={{ h24, set }}>{children}</Ctx.Provider>;
}

export function HourToggle() {
  const { h24, set } = useContext(Ctx);
  return (
    <button type="button" role="switch" aria-checked={h24} className={s.switchRow} onClick={() => set(!h24)}>
      <span className={`${s.switch}${h24 ? ` ${s.switchOn}` : ""}`} aria-hidden="true"><span className={s.switchKnob} /></span>
      24 hour format
    </button>
  );
}

export function formatMinutes(m: number, h24: boolean): string {
  const total = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60), mm = String(total % 60).padStart(2, "0");
  if (h24) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** A local wall-clock time, in the viewer's chosen format. */
export function Tm({ m }: { m: number }) {
  const { h24 } = useContext(Ctx);
  return <span className="num" suppressHydrationWarning>{formatMinutes(m, h24)}</span>;
}

/**
 * The attendance visual: hour ticks across a window of the day, a bar for
 * each worked interval and markers at the shift's start and end.
 */
export function DayVisual({
  segments, open, window: [w0, w1], shift, label,
}: {
  /** Worked intervals, minutes after local midnight. */
  segments: Array<[number, number]>;
  /** An IN still open, up to now. */
  open?: [number, number] | null;
  window: [number, number];
  shift?: [number, number] | null;
  label: string;
}) {
  const { h24 } = useContext(Ctx);
  const span = Math.max(60, w1 - w0);
  const pct = (m: number) => `${(Math.max(0, Math.min(span, m - w0)) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(w1, b) - Math.max(w0, a)) / span) * 100}%`;
  const hours = Math.round(span / 60);
  const parts = segments.map(([a, b]) => `${formatMinutes(a, h24)} – ${formatMinutes(b, h24)}`);
  if (open) parts.push(`${formatMinutes(open[0], h24)} – now`);
  const text = `${label}: ${parts.length ? parts.join(", ") : "no punches"}${shift ? `. Shift ${formatMinutes(shift[0], h24)} – ${formatMinutes(shift[1], h24)}` : ""}`;
  return (
    <div className={s.visual} role="img" aria-label={text} title={text}>
      <div className={s.visualTicks} style={{ backgroundSize: `${100 / hours}% 100%` }} />
      {segments.map(([a, b], i) => (
        <div key={i} className={s.visualSeg} style={{ left: pct(a), width: width(a, b) }} />
      ))}
      {open ? <div className={`${s.visualSeg} ${s.visualOpen}`} style={{ left: pct(open[0]), width: width(open[0], open[1]) }} /> : null}
      {shift ? (
        <>
          <span className={s.visualMark} style={{ left: pct(shift[0]) }} />
          <span className={s.visualMark} style={{ left: pct(shift[1]) }} />
        </>
      ) : null}
    </div>
  );
}
