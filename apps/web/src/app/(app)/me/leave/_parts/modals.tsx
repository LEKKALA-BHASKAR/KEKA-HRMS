import { describeRules, dateLabel, daysLower, KIND_LABEL, num, r2, type TypeRules } from "../_lib";
import s from "../leave.module.css";
import { CompOffClaim, WithdrawButton, EncashForm } from "./timeoff-forms";

export interface CatalogueType {
  id: string; name: string; code: string; colour: string; quota: number; unlimited: boolean;
  rules: TypeRules; encashmentFormula: string | null; available: number | null;
}

const BASIS: Record<string, string> = {
  CALENDAR_JAN: "January to December",
  FINANCIAL_APR: "April to March",
  JOINING_DATE: "From your joining anniversary",
};

/** "Leave Policy Explanation": the plan and every rule of each type in it. */
export function PolicyExplanation({ plan, types }: {
  plan: { name: string; description: string | null; yearBasis: string; effectiveFrom: Date } | null;
  types: CatalogueType[];
}) {
  return (
    <>
      {plan ? (
        <div style={{ marginBottom: 14 }}>
          <div className="strong">{plan.name}</div>
          {plan.description ? <div className="muted text-sm">{plan.description}</div> : null}
          <div className="muted text-sm">Leave year: {BASIS[plan.yearBasis] ?? plan.yearBasis} · on this plan since {dateLabel(plan.effectiveFrom)}</div>
        </div>
      ) : (
        <div className="callout info" style={{ marginBottom: 14 }}>You are not on a leave plan yet, so these are your organisation&apos;s leave types. Ask HR to assign a plan.</div>
      )}
      {types.length === 0 ? <div className="muted">No leave types are available to you.</div> : (
        <div className={s.policyTypes}>
          {types.map((t) => (
            <section key={t.id} className={s.policyType} aria-label={t.name}>
              <h3>
                <span className={s.dotType} style={{ background: t.colour, margin: 0 }} aria-hidden="true" />
                {t.name} <span className={s.tag}>{t.code}</span>
                {!t.rules.isPaid ? <span className={s.tag}>Unpaid</span> : null}
              </h3>
              <ul>{describeRules(t.rules, t.quota).map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

const STATUS_TONE: Record<string, string> = { PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };
const statusBadge = (st: string) => <span className={`badge ${STATUS_TONE[st] ?? "neutral"}`}>{st.charAt(0) + st.slice(1).toLowerCase()}</span>;

export interface EncashableType { id: string; name: string; encashable: number; perDay: number; formula: string | null }
export interface EncashmentRow { id: string; type: string; days: number; amount: number; status: string; raisedOn: Date; note: string | null }

/** Encashment while in service: sell back part of a balance, paid in the next payroll. */
export function EncashmentInfo({ types, history }: { types: EncashableType[]; history: EncashmentRow[] }) {
  return (
    <>
      {types.length === 0 ? (
        <div className="muted" style={{ marginBottom: 14 }}>None of your leave types are encashable under your plan. Encashable balances are otherwise paid out in your full &amp; final settlement.</div>
      ) : (
        <>
          <div className="text-sm muted" style={{ marginBottom: 12 }}>
            Days you encash come off your balance once HR approves, and the amount is paid with your next salary.
            Encashment while in service is fully taxable. Days held by pending leave cannot be encashed.
          </div>
          <EncashForm types={types.map((t) => ({ id: t.id, name: t.name, encashable: t.encashable, perDay: t.perDay }))} />
          <table className={s.mini} style={{ marginTop: 14 }}>
            <thead><tr><th>Encashable leave</th><th className={s.r}>Available to encash</th><th>Rate</th></tr></thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id}><td>{t.name}</td><td className={s.r}>{daysLower(t.encashable)}</td><td className="muted">{rateOf(t.formula)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {history.length ? (
        <>
          <div className="label" style={{ marginTop: 16 }}>Your encashment requests</div>
          <table className={s.mini}>
            <thead><tr><th>Raised</th><th>Leave</th><th className={s.r}>Days</th><th className={s.r}>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{dateLabel(h.raisedOn)}</td><td>{h.type}</td><td className={s.r}>{h.days}</td>
                  <td className={s.r}>₹{h.amount.toLocaleString("en-IN")}</td>
                  <td>{statusBadge(h.status)}{h.note ? <div className="text-xs muted">{h.note}</div> : null}</td>
                  <td>{h.status === "PENDING" ? <WithdrawButton kind="encash" requestId={h.id} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

export interface CompOffRow { id: string; workedOn: Date; days: number; status: string; dayType: string; expiresOn: Date | null; note: string | null }

/** Comp-off credit: the off days you worked, each claimable once, and your claims. */
export function CompOffInfo({ worked, hasCompOff, history }: {
  worked: Array<{ date: Date; key: string; status: string; hours: number; claimable: boolean; maxDays: 1 | 0.5; claimed: string | null }>;
  hasCompOff: boolean;
  history: CompOffRow[];
}) {
  return (
    <>
      {!hasCompOff ? (
        <div className="callout warning" style={{ marginBottom: 16 }}>
          <div>Your leave plan doesn&apos;t include Compensatory Off, so working on an off day isn&apos;t credited as leave. Ask HR if you think it should be.</div>
        </div>
      ) : (
        <div className="text-sm muted" style={{ marginBottom: 12 }}>
          Worked on a weekly off or a holiday? Claim it within 30 days. Your manager approves it, the day is credited
          to Compensatory Off, and it must be used before it expires.
        </div>
      )}
      <div className="label">Off days you worked this leave year</div>
      {worked.length === 0 ? (
        <div className="muted text-sm">None — you haven&apos;t punched in on a weekly off or holiday this leave year.</div>
      ) : (
        <table className={s.mini}>
          <thead><tr><th>Date</th><th>Day</th><th className={s.r}>Hours worked</th><th /></tr></thead>
          <tbody>
            {worked.map((w) => (
              <tr key={w.key}>
                <td>{dateLabel(w.date)}</td>
                <td>{w.status === "HOLIDAY" ? "Holiday" : "Weekly off"}</td>
                <td className={s.r}>{Math.floor(w.hours)}h {Math.round((w.hours % 1) * 60)}m</td>
                <td>{w.claimed ? statusBadge(w.claimed) : hasCompOff && w.claimable ? <CompOffClaim date={w.key} maxDays={w.maxDays} /> : <span className="text-xs muted">{hasCompOff ? "Outside the 30-day window" : ""}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history.length ? (
        <>
          <div className="label" style={{ marginTop: 16 }}>Your comp-off claims</div>
          <table className={s.mini}>
            <thead><tr><th>Worked on</th><th className={s.r}>Days</th><th>Status</th><th>Use by</th><th /></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{dateLabel(h.workedOn)} <span className="text-xs muted">· {h.dayType.toLowerCase()}</span></td>
                  <td className={s.r}>{h.days}</td>
                  <td>{statusBadge(h.status)}{h.note ? <div className="text-xs muted">{h.note}</div> : null}</td>
                  <td>{h.status === "APPROVED" && h.expiresOn ? dateLabel(h.expiresOn) : "—"}</td>
                  <td>{h.status === "PENDING" ? <WithdrawButton kind="compoff" requestId={h.id} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** " for Apr 2026" from an accrual's idempotency key ("ACCRUAL:2026-04"). */
function periodOf(key: string | null): string {
  const m = /^ACCRUAL:(\d{4})-(\d{2})$/.exec(key ?? "");
  if (m) return ` for ${MON[Number(m[2]) - 1]} ${m[1]}`;
  const y = /^ACCRUAL:(\d{4})-Y$/.exec(key ?? "");
  return y ? ` for the year` : "";
}
/** "2026-08-17 to 2026-08-21" → "17 Aug – 21 Aug 2026" */
function friendlyNote(note: string): string {
  return note.replace(/(\d{4})-(\d{2})-(\d{2}) to (\d{4})-(\d{2})-(\d{2})/, (_m, y1, m1, d1, y2, m2, d2) =>
    `${d1} ${MON[Number(m1) - 1]}${y1 === y2 ? "" : ` ${y1}`} – ${d2} ${MON[Number(m2) - 1]} ${y2}`);
}
/** "[BASIC] / 30" → "Basic ÷ 30" */
function rateOf(formula: string | null): string {
  const m = /^\s*\[(\w+)\]\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(formula ?? "");
  const code = m?.[1] ?? "BASIC";
  return `${code.charAt(0) + code.slice(1).toLowerCase()} ÷ ${m?.[2] ?? 30} per day`;
}

/** "View details": every ledger movement behind a balance, with a running total. */
export function BalanceDetails({ type, figures, entries, taken }: {
  type: CatalogueType;
  figures: { credited: number; consumed: number; available: number | null; pending: number };
  entries: Array<{ id: string; createdAt: Date; kind: string; days: unknown; note: string | null; periodKey: string | null }>;
  taken: Array<{ id: string; dates: string; days: number; status: string }>;
}) {
  let running = 0;
  const unit = type.rules.unit;
  return (
    <>
      <div className={s.summary}>
        <div><div className={s.cellLabel}>Available</div><div className={s.cellValue}>{figures.available === null ? "∞" : daysLower(figures.available, unit)}</div></div>
        <div><div className={s.cellLabel}>Consumed</div><div className={s.cellValue}>{daysLower(figures.consumed, unit)}</div></div>
        <div><div className={s.cellLabel}>Credited</div><div className={s.cellValue}>{type.unlimited ? "∞" : daysLower(figures.credited, unit)}</div></div>
        <div><div className={s.cellLabel}>Pending</div><div className={s.cellValue}>{daysLower(figures.pending, unit)}</div></div>
      </div>
      {type.unlimited || entries.length === 0 ? (
        taken.length === 0 ? (
          <div className="muted text-sm">{type.unlimited ? "No days taken this leave year." : "No credits or debits this leave year yet."}</div>
        ) : (
          <table className={s.mini}>
            <thead><tr><th>Leave</th><th>Status</th><th className={s.r}>Days</th></tr></thead>
            <tbody>
              {taken.map((t) => (
                <tr key={t.id}><td>{t.dates}</td><td>{t.status}</td><td className={s.r}>{r2(t.days)}</td></tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <table className={s.mini}>
          <thead><tr><th>Date</th><th>Movement</th><th className={s.r}>Days</th><th className={s.r}>Balance</th></tr></thead>
          <tbody>
            {entries.map((e) => {
              running = r2(running + num(e.days));
              const d = num(e.days);
              return (
                <tr key={e.id}>
                  <td className="nowrap">{dateLabel(e.createdAt)}</td>
                  <td>
                    {KIND_LABEL[e.kind] ?? e.kind}{periodOf(e.periodKey)}
                    {e.note && e.kind !== "ACCRUAL" ? <div className="text-xs subtle">{friendlyNote(e.note)}</div> : null}
                  </td>
                  <td className={`${s.r} ${d >= 0 ? s.pos : s.neg}`}>{d > 0 ? "+" : ""}{r2(d)}</td>
                  <td className={s.r}>{running}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
