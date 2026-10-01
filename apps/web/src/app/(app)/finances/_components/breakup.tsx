"use client";

import { Chip } from "@/components/keka";
import { DialogButton } from "./dialog";
import { fmtDate, inr2 } from "./fmt";
import s from "../finances.module.css";

interface Line { code: string; name: string; monthly: number; annual: number; varies: boolean }
export interface BreakupProps {
  annualCtc: number;
  breakup: {
    earnings: Line[]; deductions: Line[]; employer: Line[]; other: Line[];
    totals: { earnings: [number, number]; deductions: [number, number]; employer: [number, number]; other: [number, number]; net: [number, number] };
  } | null;
  versions: Array<{ id: string; date: Date; lines: string[]; current: boolean }>;
}

const money = inr2;

function Table({ head, rows, total }: { head: string; rows: Line[]; total?: { label: string; value: [number, number] } }) {
  return (
    <table className={s.brkTable}>
      <thead><tr><th scope="col">{head}</th><th scope="col">Monthly</th><th scope="col">Annually</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td>{r.name}</td>
            <td className={s.num}>{money(r.monthly)}</td>
            <td className={s.num}>{money(r.annual)}{r.varies ? " *" : ""}</td>
          </tr>
        ))}
        {total ? (
          <tr className={s.brkTotal}><td>{total.label}</td><td className={s.num}>{money(total.value[0])}</td><td className={s.num}>{money(total.value[1])}</td></tr>
        ) : null}
      </tbody>
    </table>
  );
}

/** "Salary breakup" link and its wide drawer: the component tables beside Version History. */
export function BreakupButton({ annualCtc, breakup, versions }: BreakupProps) {
  return (
    <DialogButton label="Salary breakup" title={`Salary Breakup for ${money(annualCtc)}`} size="wide" className={s.linkBtn}>
      {() => (
        <div className={s.brkLayout}>
          <div className={s.brkMain}>
            {!breakup ? (
              <p className={s.muted}>No salary structure is attached to this revision, so its split into components is not available.</p>
            ) : (
              <>
                <Table head="Earnings" rows={breakup.earnings} total={{ label: "Total Earnings", value: breakup.totals.earnings }} />
                {breakup.deductions.length ? <Table head="Deductions" rows={breakup.deductions} total={{ label: "Total Deductions", value: breakup.totals.deductions }} /> : null}
                <div className={s.brkNet}><span>Net Pay</span><span className={s.num}>{money(breakup.totals.net[0])}</span><span className={s.num}>{money(breakup.totals.net[1])}</span></div>
                {breakup.employer.length ? <Table head="Employer Contributions (part of CTC)" rows={breakup.employer} total={{ label: "Total Contributions", value: breakup.totals.employer }} /> : null}
                {breakup.other.length ? <Table head="Other (over and above CTC)" rows={breakup.other} total={{ label: "Total Other", value: breakup.totals.other }} /> : null}
                <p className={s.capHint}>Net pay is before income tax. {[...breakup.deductions, ...breakup.other].some((l) => l.varies) ? "* Varies by month — the annual figure is the exact sum of the twelve months and the monthly figure its average." : ""}</p>
              </>
            )}
          </div>
          <aside className={s.brkRail} aria-label="Version history">
            <div className={s.brkRailHead}>
              <div className={s.brkRailTitle}>Version History</div>
              <div className={s.muted} style={{ fontSize: 13.5 }}>View previous versions of salary structures</div>
            </div>
            {versions.map((v) => (
              <div key={v.id} className={`${s.brkVersion}${v.current ? ` ${s.brkVersionActive}` : ""}`}>
                <div className={s.brkVersionDate}>{fmtDate(v.date)}</div>
                {v.lines.map((l, i) => <div key={i} className={s.muted} style={{ fontSize: 13.5 }}>{l}</div>)}
                <div style={{ marginTop: 6 }}>{v.current ? <Chip kind="current">Current Version</Chip> : <Chip kind="closed">Not In Use</Chip>}</div>
              </div>
            ))}
          </aside>
        </div>
      )}
    </DialogButton>
  );
}
