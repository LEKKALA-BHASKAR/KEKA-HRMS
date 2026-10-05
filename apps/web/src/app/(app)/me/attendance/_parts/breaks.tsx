import { prisma } from "@keka/db";
import { Pill } from "@/components/gov-ui";
import { ActButton } from "@/components/gov-forms";
import { startBreakAction, endBreakAction, requestBreakExceptionAction } from "@/app/actions/ops-time-attend";

const t12 = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

/** The employee's breaks: start/end under the tenant's break types, the last week's log, and exception requests for over-long breaks. */
export async function BreaksPanel({ tenantId, employeeId }: { tenantId: string; employeeId: string }) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [rules, logs] = await Promise.all([
    prisma.opsBreakRule.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.opsBreakLog.findMany({ where: { tenantId, employeeId, startAt: { gte: since } }, include: { rule: { select: { name: true, maxMinutes: true } } }, orderBy: { startAt: "desc" }, take: 20 }),
  ]);
  if (!rules.length && !logs.length) return null;
  const open = logs.find((l) => !l.endAt);
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="att-breaks-title">
      <div className="card-head">
        <div><div className="card-title" id="att-breaks-title">Breaks</div><div className="card-desc">Start and end your breaks here. A break over its limit can be explained to your manager.</div></div>
        <div className="row gap-2 wrap">
          {open ? <ActButton action={endBreakAction} hidden={{}} label={`End ${open.rule.name.toLowerCase()} (since ${t12(open.startAt)})`} />
            : rules.map((r) => <ActButton key={r.id} action={startBreakAction} hidden={{ ruleId: r.id }} label={`Start ${r.name.toLowerCase()}`} variant="ghost" />)}
          <a className="btn sm ghost" href="/me/attendance/ics">Add attendance to calendar (.ics)</a>
        </div>
      </div>
      <div className="card-body tight">
        {logs.length === 0 ? <div className="text-sm subtle" style={{ padding: 12 }}>No breaks in the last week.</div> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Break</th><th>Start</th><th>End</th><th>Minutes</th><th>Status</th><th></th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id}><td className="text-sm">{l.rule.name} <span className="subtle text-xs">(max {l.rule.maxMinutes}m)</span></td><td className="text-sm">{l.startAt.toISOString().slice(0, 10)} {t12(l.startAt)}</td><td className="text-sm">{l.endAt ? t12(l.endAt) : "—"}</td><td className="num">{l.minutes ?? ""}</td><td><Pill s={l.status} /></td>
                <td>{l.status === "EXCEEDED" ? <ActButton action={requestBreakExceptionAction} hidden={{ breakId: l.id }} label="Explain" input={{ name: "reason", placeholder: "Why it ran over", required: true }} /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </section>
  );
}
