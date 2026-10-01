"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { InfoTip } from "./overlay";
import s from "./parts.module.css";

export interface StatFigures { avgHours: number | null; onTimePct: number | null; days: number }
export interface StatPeriod { key: string; label: string; range: string; me: StatFigures; team: StatFigures | null }

const hm = (h: number) => {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}h ${total % 60}m`;
};

/**
 * Attendance Stats: the viewer against their team for a chosen period. Every
 * period is computed on the server; the dropdown only switches between them.
 */
export function AttendanceStats({
  periods, meAvatar, teamLabel, teamNote,
}: {
  periods: StatPeriod[]; meAvatar: ReactNode; teamLabel: string; teamNote: string;
}) {
  const [key, setKey] = useState(periods[0]?.key);
  const p = periods.find((x) => x.key === key) ?? periods[0];
  if (!p) return null;
  const row = (who: ReactNode, name: string, f: StatFigures | null, first: boolean, note?: string) => (
    <div className={s.statRow}>
      <div className={s.statWho}>{who}<span>{name}</span></div>
      <div className={s.statCell}>
        {first ? <div className={s.statHead}>AVG HRS / DAY</div> : null}
        <div className={s.statVal} title={note}>{f && f.avgHours !== null ? hm(f.avgHours) : "—"}</div>
      </div>
      <div className={s.statCell}>
        {first ? <div className={s.statHead}>ON TIME ARRIVAL</div> : null}
        <div className={s.statVal} title={note}>{f && f.onTimePct !== null ? `${Math.round(f.onTimePct)}%` : "—"}</div>
      </div>
    </div>
  );
  return (
    <div>
      <div className={s.statTop}>
        <label className={s.periodSelect}>
          <span className="sr-only">Period</span>
          <select value={p.key} onChange={(e) => setKey(e.target.value)}>
            {periods.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </label>
        <InfoTip text={`${p.range}. Average effective hours on days worked, and the share of arrivals within the shift's grace period. Today is not counted until it is complete.`} />
      </div>
      {row(meAvatar, "Me", p.me, true, `${p.me.days} day(s) worked`)}
      <div className={s.statDivider} />
      {row(
        <span className={s.teamIcon} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16.5 5.3a3.2 3.2 0 0 1 0 6.1" /><path d="M18 14.4A6.5 6.5 0 0 1 21.5 20" /></svg>
        </span>,
        teamLabel, p.team, false, teamNote,
      )}
      {p.team === null ? <div className={s.statNote}>{teamNote}</div> : null}
    </div>
  );
}
