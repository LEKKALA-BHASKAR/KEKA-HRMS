"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm } from "@/components/form";
import { clockAction } from "@/app/actions/time";
import { IconChevronDown } from "@/components/icons";
import d from "../dash.module.css";

const parts = (date: Date) => {
  const s = date.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase();
  const m = /^(\d{2}:\d{2}):(\d{2})\s*(AM|PM)$/.exec(s.replace(/ /g, " "));
  return m ? { hm: m[1], sec: m[2], ampm: m[3] } : { hm: s, sec: "", ampm: "" };
};

/** Keka's "CURRENT TIME" — hours and minutes large, seconds and AM/PM small. */
export function LiveTime({ initialIso }: { initialIso: string }) {
  const [now, setNow] = useState(() => new Date(initialIso));
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  const p = parts(now);
  return <time className={d.clock} dateTime={now.toISOString()}>{p.hm}<small>:{p.sec} {p.ampm}</small></time>;
}

/**
 * Web Clock-In / Clock-out with Keka's "Other" menu (Remote Clock-In, Work
 * From Home, On Duty). Clocking out asks once more, showing time since the
 * last clock-in. Punches go through Me → Attendance's own action.
 */
export function ClockControls({ clockedIn, sinceIso }: { clockedIn: boolean; sinceIso: string | null }) {
  const [state, action, pending] = useForm(clockAction);
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  useEffect(() => { if (state.ok) setConfirm(false); }, [state]);

  const since = sinceIso ? Math.max(0, Date.now() - new Date(sinceIso).getTime()) : 0;
  const sinceLabel = `${Math.floor(since / 3_600_000)}h${since % 3_600_000 >= 60_000 ? ` ${Math.floor((since % 3_600_000) / 60_000)}m` : ""}`;

  return (
    <div className={d.timeBtns} ref={menuRef}>
      {clockedIn && confirm ? (
        <form action={action} style={{ display: "contents" }}>
          <input type="hidden" name="direction" value="out" />
          <button type="submit" className={`${d.wBtn} ${d.out}`} disabled={pending}>{pending ? "Recording…" : "Clock-out"}</button>
          <button type="button" className={d.wBtn} onClick={() => setConfirm(false)} disabled={pending}>Cancel</button>
          <span className={d.since}><strong>{sinceLabel}:</strong> Since Last Login</span>
        </form>
      ) : (
        <>
          {clockedIn ? (
            <button type="button" className={`${d.wBtn} ${d.out}`} onClick={() => setConfirm(true)}>Clock-out</button>
          ) : (
            <form action={action} style={{ display: "contents" }}>
              <input type="hidden" name="direction" value="in" />
              <button type="submit" className={d.wBtn} disabled={pending}>{pending ? "Recording…" : "Web Clock-In"}</button>
            </form>
          )}
          <button type="button" className={d.wBtn} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            Other <IconChevronDown width={14} height={14} />
          </button>
          {menu ? (
            <div className={d.menu} role="menu">
              <form action={action} onSubmit={() => setMenu(false)}>
                <input type="hidden" name="direction" value={clockedIn ? "out" : "in"} />
                <input type="hidden" name="mode" value="remote" />
                <button type="submit" role="menuitem">{clockedIn ? "Remote Clock-Out" : "Remote Clock-In"}</button>
              </form>
              <Link role="menuitem" href="/me/attendance?request=WFH">Work From Home</Link>
              <Link role="menuitem" href="/me/attendance?request=OD">On Duty</Link>
            </div>
          ) : null}
        </>
      )}
      {state.message ? <div role={state.ok ? "status" : "alert"} className={d.formNote}>{state.message}</div> : null}
    </div>
  );
}
