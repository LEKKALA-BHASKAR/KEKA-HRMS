import Link from "next/link";
import { IconAlert } from "@/components/icons";
import { type Day, type Chip, dayLabel, hm } from "../_lib";
import { DayVisual, Tm } from "./hours";
import { Popover, MoreIcon } from "./overlay";
import s from "../attendance.module.css";
import ps from "./parts.module.css";

export const CHIP_LABEL: Record<Chip, string> = { woff: "W-OFF", hldy: "HLDY", leave: "LEAVE", wfh: "WFH", od: "OD" };

export function DayChip({ kind }: { kind: Chip }) {
  return <span className={`${s.chip} ${s[`chip_${kind}`]}`}>{CHIP_LABEL[kind]}</span>;
}

const SOURCE: Record<string, string> = {
  WEB: "Web clock", MOBILE: "Mobile", BIOMETRIC: "Biometric", KIOSK: "Kiosk", API: "Device API", MANUAL: "Adjustment",
};

/** Totals for a row, counting an open slot today up to now. */
export function totals(d: Day) {
  const openMin = d.open ? d.open[1] - d.open[0] : 0;
  const effective = d.effectiveMin + openMin;
  const firstStart = d.segments[0]?.[0] ?? d.open?.[0];
  const gross = d.open && firstStart !== undefined ? d.open[1] - firstStart : d.grossMin;
  return { effective, gross, breakMin: Math.max(0, gross - effective) };
}

export interface RequestOption { label: string; href: string }

/**
 * The Attendance Log table: one row per day, newest first. Days with punches
 * show the visual and hours; everything else collapses to a message row.
 */
export function LogTable({
  days, window, optionsFor,
}: {
  days: Day[];
  window: [number, number];
  optionsFor: (d: Day) => RequestOption[];
}) {
  if (days.length === 0) {
    return (
      <div className={s.empty}>
        <div className={s.emptyTitle}>No days to show</div>
        <div>There is no attendance for this period — it may be before you joined.</div>
      </div>
    );
  }
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" className={s.thCenter}>Attendance visual</th>
            <th scope="col">Effective hours</th>
            <th scope="col">Break taken</th>
            <th scope="col">Gross hours</th>
            <th scope="col" className={s.thCenter}>Log</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const options = optionsFor(d);
            const rowClass = d.tint === "woff" ? s.rowWoff : d.tint === "hldy" ? s.rowHldy : d.tint === "leave" ? s.rowLeave : undefined;
            const worked = d.punches.length > 0;
            const t = totals(d);
            const ratio = d.shift.required > 0 ? Math.min(1, t.effective / d.shift.required) : 0;
            return (
              <tr key={d.key} className={rowClass}>
                <th scope="row" className={s.dateCell}>
                  <span>{dayLabel(d.date)}</span>
                  {d.isToday ? <span className={s.today}>TODAY</span> : null}
                  {d.chips.map((c) => <DayChip key={c} kind={c} />)}
                </th>
                {worked ? (
                  <>
                    <td className={s.visualCell}>
                      <DayVisual
                        segments={d.segments} open={d.open} window={window}
                        shift={d.shift.flexible ? null : [d.shift.start, d.shift.end]}
                        label={dayLabel(d.date)}
                      />
                    </td>
                    <td>
                      <span className={s.eff} title={d.shift.required > 0 ? `${Math.round(ratio * 100)}% of ${hm(d.shift.required)} required` : undefined}>
                        <span className={s.pie} style={{ background: `conic-gradient(#2aa5bd ${ratio * 360}deg, #d9eff4 0)` }} aria-hidden="true" />
                        <span className={s.num}>{hm(t.effective)}{d.open ? <span className="subtle"> +</span> : null}</span>
                      </span>
                    </td>
                    <td className={s.num}>{hm(t.breakMin)}</td>
                    <td className={s.num}>{hm(t.gross)}</td>
                  </>
                ) : (
                  <td colSpan={4} className={`${s.msgCell}${d.message?.tone === "muted" ? ` ${s.msgMuted}` : d.message?.tone === "danger" ? ` ${s.msgDanger}` : ""}`}>
                    {d.message?.text ?? ""}
                  </td>
                )}
                <td className={s.logCell}>
                  {worked ? (
                    <Popover
                      label={`Punches on ${dayLabel(d.date)}`}
                      width={250}
                      trigger={d.flag === "warn"
                        ? <span className={s.warn}><IconAlert width={19} height={19} /></span>
                        : <span className={s.ok}><CheckCircle /></span>}
                    >
                      <div className={ps.menuLabel}>Punches · {dayLabel(d.date)}</div>
                      <ul className={ps.punchList}>
                        {d.punches.map((p, i) => (
                          <li key={i}>
                            <span className={`${ps.punchDir} ${p.dir === 0 ? ps.punchIn : ps.punchOut}`}>{p.dir === 0 ? "IN" : "OUT"}</span>
                            <Tm m={p.m} />
                            <span className="subtle text-xs">{SOURCE[p.source] ?? p.source}</span>
                          </li>
                        ))}
                        {d.open ? <li><span /><span className="subtle">still clocked in</span><span /></li> : null}
                      </ul>
                      {d.note ? <div className={ps.menuText}>{d.note}</div> : null}
                      {options.length > 0 ? (
                        <>
                          <div className={ps.menuDivider} />
                          <div className={ps.menuLabel}>Raise a request</div>
                          {options.map((o) => <Link key={o.href} href={o.href} scroll={false} className={ps.menuItem}>{o.label}</Link>)}
                        </>
                      ) : null}
                    </Popover>
                  ) : options.length > 0 ? (
                    <Popover label={`Requests for ${dayLabel(d.date)}`} trigger={<MoreIcon />} width={220}>
                      {d.note && d.message?.tone === "danger" ? <div className={ps.menuText}>{d.note}</div> : null}
                      <div className={ps.menuLabel}>Raise a request</div>
                      {options.map((o) => <Link key={o.href} href={o.href} scroll={false} className={ps.menuItem}>{o.label}</Link>)}
                    </Popover>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CheckCircle() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.7 2.7L16.2 9.5" />
    </svg>
  );
}
