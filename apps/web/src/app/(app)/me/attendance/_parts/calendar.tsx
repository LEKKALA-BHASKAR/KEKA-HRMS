import Link from "next/link";
import { type Day, hm } from "../_lib";
import { DayChip, totals } from "./log";
import { Tm } from "./hours";
import s from "../attendance.module.css";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A month grid of the employee's days, Monday first. */
export function MonthCalendar({
  label, days, firstDow, prevHref, nextHref,
}: {
  label: string;
  /** Every day of the month, in order; null for days before joining. */
  days: Array<Day | null>;
  /** 0 = Monday. */
  firstDow: number;
  prevHref: string | null;
  nextHref: string | null;
}) {
  return (
    <section className={s.panel} aria-label={`Calendar for ${label}`}>
      <div className={s.panelHead}>
        <div className={s.calHead}>
          {prevHref
            ? <Link href={prevHref} scroll={false} className={s.calNav} aria-label="Previous month">‹</Link>
            : <span className={`${s.calNav} ${s.calNavOff}`} aria-hidden="true">‹</span>}
          <h3 className={s.panelTitle} style={{ minWidth: 150, textAlign: "center" }}>{label}</h3>
          {nextHref
            ? <Link href={nextHref} scroll={false} className={s.calNav} aria-label="Next month">›</Link>
            : <span className={`${s.calNav} ${s.calNavOff}`} aria-hidden="true">›</span>}
        </div>
      </div>
      <div className={s.calGrid}>
        {DOW.map((d) => <div key={d} className={s.calDow}>{d}</div>)}
        {Array.from({ length: firstDow }, (_, i) => <div key={`b${i}`} className={`${s.calCell} ${s.calBlank}`} />)}
        {days.map((d, i) => {
          if (!d) return <div key={`n${i}`} className={`${s.calCell} ${s.calBlank}`}><span className={s.calNum}>{i + 1}</span></div>;
          const t = totals(d);
          const worked = d.punches.length > 0;
          const first = d.punches.find((p) => p.dir === 0)?.m;
          const last = [...d.punches].reverse().find((p) => p.dir === 1)?.m;
          const tint = d.tint === "woff" ? "#f8f3ea" : d.tint === "hldy" ? "#f0f7e6" : d.tint === "leave" ? "#f3effc" : undefined;
          return (
            <div
              key={d.key}
              className={`${s.calCell}${d.isToday ? ` ${s.calToday}` : ""}${d.isFuture ? ` ${s.calFuture}` : ""}`}
              style={tint ? { background: tint } : undefined}
            >
              <div className={s.calTop}>
                <span className={s.calNum}>{d.date.getUTCDate()}</span>
                <span>{d.chips.map((c) => <DayChip key={c} kind={c} />)}</span>
              </div>
              {worked ? (
                <>
                  <div className={s.calHours}>{hm(t.effective)}</div>
                  <div className={s.calTimes}>
                    {first !== undefined ? <Tm m={first} /> : "—"} – {last !== undefined && !d.open ? <Tm m={last} /> : d.open ? "now" : "—"}
                  </div>
                </>
              ) : d.message && !(d.tint === "woff" && d.message.text === "Full day Weekly-off") ? (
                <div className={`${s.calMsg}${d.message.tone === "danger" ? ` ${s.msgDanger}` : d.message.tone === "pending" ? ` ${s.msgPending}` : ""}`} title={d.message.text}>
                  {d.message.text}
                </div>
              ) : d.isFuture && d.kind === "WORKING" ? (
                <div className={s.calMsg}>{d.shift.flexible ? `Flexible · ${hm(d.shift.required)}` : null}</div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className={s.calLegend} aria-label="Legend">
        <span><DayChip kind="woff" /> Weekly off</span>
        <span><DayChip kind="hldy" /> Holiday</span>
        <span><DayChip kind="leave" /> On leave</span>
        <span><DayChip kind="wfh" /> Work from home</span>
        <span><DayChip kind="od" /> On duty</span>
        <span><span className={s.msgDanger}>●</span> No attendance</span>
      </div>
    </section>
  );
}
