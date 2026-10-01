import Link from "next/link";
import { Avatar } from "@/components/avatar";
import type { TeamData } from "./_data";
import s from "./team.module.css";

/**
 * The team calendar: one row per teammate, one column per day of the month,
 * each day marked as leave, remote work, a holiday or a weekly off. The
 * header dots flag days when someone (or several people) is away or remote.
 */

const LETTERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

export function TeamCalendar({ team }: { team: TeamData }) {
  const { month, everyone, todayDate } = team;
  const todayIdx = month.days.findIndex((d) => d.getTime() === todayDate.getTime());
  const thisMonth = `${todayDate.getUTCFullYear()}-${String(todayDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const current = `${month.year}-${String(month.month).padStart(2, "0")}`;

  return (
    <section className={`${s.panel} ${s.calPanel}`} aria-label="Team calendar">
      <div className={s.calNav}>
        <Link href={`/team?month=${month.prev}`} scroll={false} className={s.calArrow} aria-label="Previous month">‹</Link>
        <strong aria-live="polite">{month.label}</strong>
        <Link href={`/team?month=${month.next}`} scroll={false} className={s.calArrow} aria-label="Next month">›</Link>
        {current !== thisMonth ? <Link href="/team" scroll={false} className={s.calToday}>Back to this month</Link> : null}
      </div>
      <div className={s.calScroll}>
        <table className={s.cal}>
          <caption className="sr-only">Team calendar for {month.label}</caption>
          <thead>
            <tr>
              <th scope="col" className={s.nameCol}><span className="sr-only">Employee</span></th>
              {month.days.map((d, i) => {
                const leave = month.leaveCount[i], remote = month.remoteCount[i];
                const notes = [leave > 1 ? `${leave} on leave` : leave === 1 ? "1 on leave" : "", remote ? `${remote} on WFH/OD` : ""].filter(Boolean).join(", ");
                return (
                  <th key={i} scope="col" className={i === todayIdx ? s.todayCol : undefined} title={notes || undefined}>
                    <span className={`${s.dayHead}${i === todayIdx ? ` ${s.dayHeadToday}` : ""}`}>
                      <span aria-label={LONG.format(d)}>{LETTERS[d.getUTCDay()]}</span>
                      <span className={s.markers} aria-label={notes || undefined}>
                        {leave > 1 ? <i className={`${s.marker} ${s.mMulti}`} /> : leave === 1 ? <i className={`${s.marker} ${s.mLeave}`} /> : null}
                        {remote > 0 ? <i className={`${s.marker} ${s.mRemote}`} /> : null}
                      </span>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {everyone.map((m) => {
              const cells = month.cells.get(m.id) ?? [];
              return (
                <tr key={m.id}>
                  <th scope="row" className={s.nameCol}>
                    <span className={s.nameCell}>
                      <Avatar name={m.name} photoUrl={m.photoUrl} size={24} />
                      <Link href={`/directory/${m.id}`}>{m.name}</Link>
                    </span>
                  </th>
                  {cells.map((c, i) => {
                    const cls = [s.num, c.mark ? s[`m_${c.mark}`] : "", c.half ? s[`h_${c.half}`] : ""].filter(Boolean).join(" ");
                    const label = `${LONG.format(month.days[i])}: ${c.label}`;
                    return (
                      <td key={i} className={`${s.cell}${i === todayIdx ? ` ${s.todayCol} ${s.isToday}` : ""}`} title={label}>
                        <span className={cls} aria-label={label}>{i + 1}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={s.legend} aria-label="Legend">
        <span><i className={`${s.swatch} ${s.m_wfh}`} />Work from home</span>
        <span><i className={`${s.swatch} ${s.m_od}`} />On duty</span>
        <span><i className={`${s.swatch} ${s.m_paid}`} />Paid leave</span>
        <span><i className={`${s.swatch} ${s.m_unpaid}`} />Unpaid leave</span>
        <span><i className={`${s.swatch} ${s.m_noatt}`} />Leave due to no attendance</span>
        <span><i className={`${s.swatch} ${s.m_woff}`} />Weekly off</span>
        <span><i className={`${s.swatch} ${s.m_hldy}`} />Holiday</span>
        <span><i className={`${s.marker} ${s.mLeave}`} />Someone on leave</span>
        <span><i className={`${s.marker} ${s.mMulti}`} />Multiple leave on a day</span>
        <span><i className={`${s.marker} ${s.mRemote}`} />Someone on WFH/OD</span>
      </div>
    </section>
  );
}
