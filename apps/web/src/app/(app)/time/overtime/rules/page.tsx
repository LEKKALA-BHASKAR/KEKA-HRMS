import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { otTierTable, otTiersText, overtimeReconciliation, employeeOvertime, joinSettings, OT_DAY_TYPES } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Stat, Badge } from "@/components/ui";
import { Tabs, Table, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty } from "@/lib/engage-depth";
import { employeeOptions, peopleIndex } from "@/lib/join-depth";
import {
  saveOvertimeRuleAction, overtimeRuleOpAction, raiseOvertimeExceptionAction, runOvertimeAlertsAction, overtimeAlertOpAction, runCompOffRemindersAction,
} from "@/app/actions/join-overtime";
import { saveJoinSettingsAction } from "@/app/actions/join-preboarding";

const P = PERMISSIONS;
const TABS = { rules: "Rules", exceptions: "Cap exceptions", alerts: "Alerts", reconcile: "Reconciliation", cost: "Cost", compoff: "Comp off", settings: "Settings", reports: "Reports" };
const h = (m: number | null | undefined) => (m === null || m === undefined ? "" : String(Math.round((m / 60) * 100) / 100));

/** Overtime rules, cap exceptions, alerts, reconciliation and cost. */
export default async function OvertimeRulesPage({ searchParams }: { searchParams: Promise<{ tab?: string; edit?: string; ym?: string; emp?: string }> }) {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const sp = await searchParams;
  const tab = sp.tab && sp.tab in TABS ? sp.tab : "rules";
  const t = viewer.tenantId;
  const now = new Date();
  const [yy, mm] = /^\d{4}-\d{2}$/.test(sp.ym ?? "") ? sp.ym!.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const year = yy!, month = mm!;
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const scope = scopedEmployeeWhere(viewer, P.ATTENDANCE_MANAGE);
  const monthPicker = (tabKey: string) => (
    <form className="row gap-2" action="/time/overtime/rules" style={{ padding: "12px 16px 0" }}>
      <input type="hidden" name="tab" value={tabKey} />
      <input className="input" type="month" name="ym" defaultValue={ym} style={{ maxWidth: 180 }} />
      <button className="btn sm" type="submit">Show</button>
    </form>
  );
  return (
    <>
      <PageHead title="Overtime rules" subtitle="Who earns overtime, at what rate, up to which caps — approved before it takes effect."
        actions={<Link className="btn" href="/time/overtime">Overtime in payroll</Link>} />
      <Tabs base="/time/overtime/rules" tabs={TABS} active={tab} />
      {tab === "rules" ? await (async () => {
        const [rules, bands, grades, shifts, locs] = await Promise.all([
          prisma.overtimeRule.findMany({ where: { tenantId: t }, orderBy: [{ status: "asc" }, { priority: "desc" }] }),
          prisma.band.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
          prisma.payGrade.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
          prisma.shift.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
          prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        ]);
        const names = new Map([...bands, ...grades, ...shifts, ...locs].map((x) => [x.id, x.name]));
        const edit = rules.find((r) => r.id === sp.edit && ["DRAFT", "REJECTED"].includes(r.status));
        const tiers = edit ? otTierTable(edit.tiers) : null;
        const o = (xs: Array<{ id: string; name: string }>) => xs.map((x) => ({ value: x.id, label: x.name }));
        const elig = (r: (typeof rules)[number]) => [["Bands", r.bandIds], ["Grades", r.payGradeIds], ["Shifts", r.shiftIds], ["Locations", r.locationIds]].filter(([, v]) => (v as string[]).length).map(([k, v]) => `${k}: ${(v as string[]).map((x) => names.get(x) ?? x).join(", ")}`).join(" · ") || "Everyone";
        return (
          <div className="stack gap-4">
            <Card tight title="Overtime rules" description="The highest-priority active rule that covers an employee applies.">
              <Table head={["Rule", "Priority", "Eligibility", "Rates", "Caps (h)", "Timing", "Status", ""]} empty={!rules.length}>
                {rules.map((r) => {
                  const tt = otTierTable(r.tiers);
                  return (
                    <tr key={r.id}>
                      <td className="text-sm strong">{r.name}</td><td className="num">{r.priority}</td><td className="text-xs">{elig(r)}</td>
                      <td className="text-xs">{OT_DAY_TYPES.map((d) => `${pretty(d)} ${otTiersText(tt[d]) || "—"}`).join(" · ")}</td>
                      <td className="text-xs">{[["day", r.dailyCapMinutes], ["week", r.weeklyCapMinutes], ["month", r.monthlyCapMinutes]].filter(([, v]) => v !== null).map(([k, v]) => `${k} ${h(v as number)}`).join(", ") || "none"}{r.weeklyThresholdMinutes !== null ? <div>weekly after {h(r.weeklyThresholdMinutes)}</div> : null}</td>
                      <td className="text-xs">{r.requirePreApproval ? "Approve in advance" : r.postFactoDays !== null ? `Claim within ${r.postFactoDays} d` : "Any time"}</td>
                      <td><Pill s={r.status} /></td>
                      <td className="right"><div className="row gap-2">
                        {["DRAFT", "REJECTED"].includes(r.status) ? <><Link className="btn sm" href={`/time/overtime/rules?edit=${r.id}`}>Edit</Link><ActButton action={overtimeRuleOpAction} hidden={{ id: r.id, op: "submit" }} label="Submit" variant="primary" /><ActButton action={overtimeRuleOpAction} hidden={{ id: r.id, op: "delete" }} label="Delete" variant="ghost" confirmText="Delete this draft?" /></> : null}
                        {r.status === "ACTIVE" ? <ActButton action={overtimeRuleOpAction} hidden={{ id: r.id, op: "retire" }} label="Retire" variant="ghost" /> : null}
                        <ActButton action={overtimeRuleOpAction} hidden={{ id: r.id, op: "copy" }} label="Copy" variant="ghost" />
                      </div></td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
            <Card title={edit ? `Edit ${edit.name}` : "New overtime rule"} description="Rates are tiers of minutes:multiplier — e.g. 120:1.5, :2 pays the first 2 hours at 1.5x and the rest at 2x. Premium windows add to the rate for overtime ending inside them (22:00-06:00:0.5).">
              <SpecForm key={edit?.id ?? "new"} action={saveOvertimeRuleAction} hidden={{ id: edit?.id ?? "" }} submitLabel="Save draft" fields={[
                { name: "name", label: "Name", required: true, defaultValue: edit?.name }, { name: "priority", label: "Priority", type: "number", defaultValue: edit?.priority ?? 0 },
                { name: "tiers_WORKDAY", label: "Working day rates", required: true, defaultValue: tiers ? otTiersText(tiers.WORKDAY) : ":1.5" },
                { name: "tiers_WEEKLY_OFF", label: "Weekly off rates", defaultValue: tiers ? otTiersText(tiers.WEEKLY_OFF) : ":2" },
                { name: "tiers_HOLIDAY", label: "Holiday rates", defaultValue: tiers ? otTiersText(tiers.HOLIDAY) : ":2" },
                { name: "windows", label: "Premium windows", defaultValue: Array.isArray(edit?.windows) ? (edit!.windows as Array<{ start: string; end: string; multiplier: number }>).map((w) => `${w.start}-${w.end}:${w.multiplier}`).join(", ") : "" },
                { name: "weeklyThresholdHours", label: "Weekly overtime after (h)", type: "number", defaultValue: h(edit?.weeklyThresholdMinutes) },
                { name: "dailyCapHours", label: "Daily cap (h)", type: "number", defaultValue: h(edit?.dailyCapMinutes) },
                { name: "weeklyCapHours", label: "Weekly cap (h)", type: "number", defaultValue: h(edit?.weeklyCapMinutes) },
                { name: "monthlyCapHours", label: "Monthly cap (h)", type: "number", defaultValue: h(edit?.monthlyCapMinutes) },
                { name: "alertMonthlyHours", label: "Alert above (h / month)", type: "number", defaultValue: h(edit?.alertMonthlyMinutes) },
                { name: "minMinutes", label: "Ignore under (min / day)", type: "number", defaultValue: edit?.minMinutes ?? 0 },
                { name: "postFactoDays", label: "Claim window (days after)", type: "number", defaultValue: edit?.postFactoDays ?? "" },
                { name: "requirePreApproval", label: "Pre-approval", type: "checkbox", placeholder: "Overtime must be approved before the day", defaultValue: edit?.requirePreApproval ? "on" : "" },
                { name: "bandIds", label: "Bands", type: "multiselect", options: o(bands), defaultValue: edit?.bandIds },
                { name: "payGradeIds", label: "Pay grades", type: "multiselect", options: o(grades), defaultValue: edit?.payGradeIds },
                { name: "shiftIds", label: "Shifts", type: "multiselect", options: o(shifts), defaultValue: edit?.shiftIds },
                { name: "locationIds", label: "Locations", type: "multiselect", options: o(locs), defaultValue: edit?.locationIds },
              ]} />
            </Card>
          </div>
        );
      })() : null}
      {tab === "exceptions" ? await (async () => {
        const emp = sp.emp ?? "";
        const opt = await employeeOptions(viewer, P.ATTENDANCE_MANAGE);
        const inScope = opt.some((o) => o.value === emp);
        const res = inScope ? await employeeOvertime(t, emp, year, month) : null;
        const rows = await prisma.overtimeException.findMany({ where: { tenantId: t, employeeId: { in: (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) } }, orderBy: { createdAt: "desc" }, take: 100 });
        const ppl = await peopleIndex(t, rows.map((r) => r.employeeId));
        return (
          <div className="stack gap-4">
            <Card title="Check an employee's month" description="Overtime cut by a cap is only paid if an exception is approved.">
              <form className="row gap-2" action="/time/overtime/rules">
                <input type="hidden" name="tab" value="exceptions" />
                <select className="input" name="emp" defaultValue={emp} style={{ maxWidth: 320 }}><option value="">Pick an employee</option>{opt.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                <input className="input" type="month" name="ym" defaultValue={ym} style={{ maxWidth: 180 }} />
                <button className="btn sm" type="submit">Calculate</button>
              </form>
              {res ? (
                <div className="stack gap-3" style={{ marginTop: 12 }}>
                  <div className="grid grid-4">
                    <Stat label="Rule" value={res.rule?.name ?? "None"} />
                    <Stat label="Payable hours" value={h(res.result.payableMinutes)} meta={`${res.result.days} day(s)`} />
                    <Stat label="Weighted hours" value={h(res.result.weightedMinutes)} meta="After multipliers" />
                    <Stat label="Above caps" value={h(res.result.excessMinutes)} tone={res.result.excessMinutes ? "neg" : undefined} />
                  </div>
                  <Table head={["Week of", "Daily OT (h)", "Weekly OT (h)", "Cut by cap (h)"]} empty={!res.result.weeks.length}>
                    {res.result.weeks.map((w) => <tr key={w.week}><td className="text-sm">{w.week}</td><td className="num">{h(w.daily)}</td><td className="num">{h(w.weekly)}</td><td className="num">{h(w.capped)}</td></tr>)}
                  </Table>
                  {res.result.excessMinutes > 0 ? <SpecForm action={raiseOvertimeExceptionAction} hidden={{ employeeId: emp, year: String(year), month: String(month) }} submitLabel="Ask to pay the excess" columns={1} fields={[{ name: "reason", label: "Why should it be paid", type: "textarea", required: true }]} /> : null}
                </div>
              ) : null}
            </Card>
            <Card tight title="Cap exceptions">
              <Table head={["Raised", "Employee", "Month", "Hours", "Reason", "Status"]} empty={!rows.length}>
                {rows.map((r) => <tr key={r.id}><td className="text-xs">{fmtDay(r.createdAt)}</td><td className="text-sm">{ppl.number(r.employeeId)} · {ppl.name(r.employeeId)}</td><td className="text-sm">{r.year}-{String(r.month).padStart(2, "0")}</td><td className="num">{h(r.excessMinutes)}</td><td className="text-sm">{r.reason}</td><td><Pill s={r.status} /></td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "alerts" ? await (async () => {
        const rows = await prisma.overtimeAlert.findMany({ where: { tenantId: t, kind: { not: "COMPOFF_EXPIRY" }, employeeId: { in: (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) } }, orderBy: [{ status: "desc" }, { createdAt: "desc" }], take: 200 });
        return (
          <Card tight title="Threshold and anomaly alerts" description="Above a rule's alert threshold, a day over the daily limit, a month more than double the last, or hours logged with no request. Checked nightly."
            action={<ActButton action={runOvertimeAlertsAction} hidden={{ year: String(year), month: String(month) }} label={`Check ${ym} now`} />}>
            {monthPicker("alerts")}
            <Table head={["Raised", "Type", "Period", "Detail", "Status", ""]} empty={!rows.length}>
              {rows.map((a) => <tr key={a.id}><td className="text-xs">{fmtTime(a.createdAt)}</td><td><Badge tone={a.kind === "THRESHOLD" ? "warning" : "danger"}>{pretty(a.kind)}</Badge></td><td className="text-xs">{a.periodKey}</td><td className="text-sm">{a.detail}</td><td><Pill s={a.status} /></td><td className="right">{a.status === "OPEN" ? <ActButton action={overtimeAlertOpAction} hidden={{ id: a.id }} label="Acknowledge" /> : null}</td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "reconcile" || tab === "cost" ? await (async () => {
        const emps = await prisma.employee.findMany({ where: scope, select: { id: true } });
        const ids = emps.map((e) => e.id);
        const [reqs, recs, entries] = await Promise.all([
          prisma.overtimeRequest.findMany({ where: { tenantId: t, employeeId: { in: ids }, fromDate: { lte: to }, toDate: { gte: from }, status: { not: "REJECTED" } }, select: { employeeId: true, requestedMinutes: true, status: true } }),
          prisma.attendanceRecord.findMany({ where: { tenantId: t, employeeId: { in: ids }, date: { gte: from, lte: to }, overtimeHours: { gt: 0 } }, select: { employeeId: true, overtimeHours: true } }),
          prisma.overtimeEntry.findMany({ where: { tenantId: t, employeeId: { in: ids }, year, month, payAction: "PAY" }, select: { employeeId: true, hours: true, amount: true, isProcessed: true } }),
        ]);
        const people = [...new Set([...reqs.map((r) => r.employeeId), ...recs.map((r) => r.employeeId), ...entries.map((e) => e.employeeId)])];
        const ppl = await peopleIndex(t, people);
        const rows = people.map((id) => {
          const requestedMinutes = reqs.filter((r) => r.employeeId === id).reduce((s, r) => s + r.requestedMinutes, 0);
          const approvedMinutes = reqs.filter((r) => r.employeeId === id && r.status === "APPROVED").reduce((s, r) => s + r.requestedMinutes, 0);
          const loggedMinutes = Math.round(recs.filter((r) => r.employeeId === id).reduce((s, r) => s + Number(r.overtimeHours) * 60, 0));
          const mine = entries.filter((e) => e.employeeId === id);
          const paidMinutes = Math.round(mine.reduce((s, e) => s + Number(e.hours) * 60, 0));
          const amount = mine.reduce((s, e) => s + Number(e.amount), 0);
          return { id, requestedMinutes, approvedMinutes, loggedMinutes, paidMinutes, amount, rec: overtimeReconciliation({ requestedMinutes, approvedMinutes, loggedMinutes, paidMinutes }) };
        });
        if (tab === "reconcile") return (
          <Card tight title={`Requested, logged and paid overtime — ${ym}`} description="Payroll hours include entries added directly, so a positive variance can be expected.">
            {monthPicker("reconcile")}
            <Table head={["Employee", "Requested (h)", "Approved (h)", "Logged (h)", "In payroll (h)", "Variance (h)", "Status"]} empty={!rows.length}>
              {rows.map((r) => <tr key={r.id}><td className="text-sm">{ppl.number(r.id)} · {ppl.name(r.id)}</td><td className="num">{h(r.requestedMinutes)}</td><td className="num">{h(r.approvedMinutes)}</td><td className="num">{h(r.loggedMinutes)}</td><td className="num">{h(r.paidMinutes)}</td><td className="num">{h(r.rec.variance)}</td><td><Badge tone={r.rec.status === "MATCHED" ? "success" : "warning"}>{pretty(r.rec.status)}</Badge></td></tr>)}
            </Table>
          </Card>
        );
        const byDept = new Map<string, { hours: number; amount: number; people: number }>();
        for (const r of rows) {
          const d = ppl.dept(r.id) || "No department";
          const cur = byDept.get(d) ?? { hours: 0, amount: 0, people: 0 };
          byDept.set(d, { hours: cur.hours + r.paidMinutes / 60, amount: cur.amount + r.amount, people: cur.people + (r.paidMinutes ? 1 : 0) });
        }
        const total = rows.reduce((s, r) => s + r.amount, 0);
        return (
          <div className="stack gap-4">
            <div className="grid grid-4">
              <Stat label="Overtime cost" value={total.toLocaleString("en-IN", { maximumFractionDigits: 0 })} meta={ym} />
              <Stat label="Hours in payroll" value={h(rows.reduce((s, r) => s + r.paidMinutes, 0))} />
              <Stat label="Hours logged" value={h(rows.reduce((s, r) => s + r.loggedMinutes, 0))} />
              <Stat label="People" value={rows.filter((r) => r.paidMinutes).length} />
            </div>
            <Card tight title={`Overtime cost by department — ${ym}`}>
              {monthPicker("cost")}
              <Table head={["Department", "People", "Hours", "Cost", "Share"]} empty={!byDept.size}>
                {[...byDept.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([d, v]) => <tr key={d}><td className="text-sm">{d}</td><td className="num">{v.people}</td><td className="num">{Math.round(v.hours * 100) / 100}</td><td className="num">{v.amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td><td className="num">{total ? Math.round((v.amount / total) * 100) : 0}%</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "compoff" ? await (async () => {
        const s = await joinSettings(t);
        const soon = new Date(now.getTime() + s.compOffReminderDays * 86_400_000);
        const ids = (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id);
        const credits = await prisma.leaveLedgerEntry.findMany({ where: { tenantId: t, employeeId: { in: ids }, kind: "COMP_OFF_CREDIT", expiresOn: { gte: new Date(now.toISOString().slice(0, 10) + "T00:00:00Z"), lte: soon } }, orderBy: { expiresOn: "asc" } });
        const sent = await prisma.overtimeAlert.findMany({ where: { tenantId: t, kind: "COMPOFF_EXPIRY", employeeId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 100 });
        const ppl = await peopleIndex(t, [...credits.map((c) => c.employeeId), ...sent.map((x) => x.employeeId)]);
        return (
          <div className="stack gap-4">
            <Card tight title={`Comp off lapsing within ${s.compOffReminderDays} days`} action={<ActButton action={runCompOffRemindersAction} hidden={{}} label="Send reminders now" />}>
              <Table head={["Employee", "Days", "Expires"]} empty={!credits.length}>
                {credits.map((c) => <tr key={c.id}><td className="text-sm">{ppl.number(c.employeeId)} · {ppl.name(c.employeeId)}</td><td className="num">{Number(c.days)}</td><td className="text-sm">{fmtDay(c.expiresOn)}</td></tr>)}
              </Table>
            </Card>
            <Card tight title="Reminders sent">
              <Table head={["Sent", "Employee", "Detail"]} empty={!sent.length}>
                {sent.map((x) => <tr key={x.id}><td className="text-xs">{fmtTime(x.createdAt)}</td><td className="text-sm">{ppl.name(x.employeeId)}</td><td className="text-sm">{x.detail}</td></tr>)}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "settings" ? await (async () => {
        const s = await joinSettings(t);
        return (
          <Card title="Overtime alerts and reminders">
            <SpecForm action={saveJoinSettingsAction} hidden={{ scope: "overtime" }} fields={[
              { name: "otAnomalyDailyMinutes", label: "Flag a day with more overtime than (min)", type: "number", defaultValue: s.otAnomalyDailyMinutes },
              { name: "compOffReminderDays", label: "Remind about comp off lapsing within (days)", type: "number", defaultValue: s.compOffReminderDays },
            ]} />
          </Card>
        );
      })() : null}
      {tab === "reports" ? (
        <Card title="Reports and exports" description="CSV downloads; each export is recorded in the audit log.">
          <div className="stack gap-2">
            {[["overtime-rules", "Overtime rules"], ["overtime-requests", "Overtime requests"], ["overtime-history", "Overtime history (payroll entries)"], ["overtime-alerts", "Overtime alerts"]].map(([k, label]) => <div key={k} className="row gap-2"><a className="btn sm" href={`/time/ops-export?kind=${k}`}>Download</a><span className="text-sm">{label}</span></div>)}
          </div>
        </Card>
      ) : null}
    </>
  );
}
