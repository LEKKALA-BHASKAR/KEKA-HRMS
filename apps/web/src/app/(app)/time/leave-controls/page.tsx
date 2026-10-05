import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { getOpsSettings, leaveCalendarFor, leaveLiabilityForecast, reasonCodes, OPS_ABSENCE_KINDS, opsReturnBlockers } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions, locationOptions, employeeOptions, userNames, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat, Callout } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { OpsRequests } from "@/components/ops-ui";
import {
  saveLeaveBlackoutAction, deleteLeaveBlackoutAction, requestBalanceAdjustmentAction, requestAbsenceAction, certifyReturnAction, tickReturnChecklistAction,
  completeReturnAction, cancelAbsenceAction,
} from "@/app/actions/ops-time-attend";

export const metadata = { title: "Leave controls" };
const ADMIN_TABS = { blackouts: "Blackouts & peaks", absences: "Long absences", adjustments: "Balance adjustments", calendar: "Leave calendar", liability: "Liability forecast", escalation: "Escalations" };
const SELF_TABS = { absences: "Long absences", calendar: "Leave calendar" };
type Tab = keyof typeof ADMIN_TABS;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Time Attend › Leave controls: blackout and peak periods, long absences with
 * return-to-work, balance adjustments under approval, the leave calendar under
 * the tenant's visibility rule, the liability forecast and escalations.
 */
export default async function LeaveControlsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  const admin = can(v, P.LEAVE_MANAGE);
  if (!admin && !v.employee) forbidden();
  const tabs = admin ? ADMIN_TABS : SELF_TABS;
  const sp = await searchParams;
  const tab: Tab = (sp.tab ?? "") in tabs ? (sp.tab as Tab) : admin ? "blackouts" : "absences";
  const t = v.tenantId;
  const now = new Date();
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month!.split("-").map(Number) as [number, number] : [now.getUTCFullYear(), now.getUTCMonth() + 1] as [number, number];
  return (
    <>
      <PageHead title="Leave controls" subtitle="Blackouts, long absences, adjustments, the calendar and the liability" actions={admin ? <a className="btn" href={`/time/leave-controls/export?tab=${tab}`}>Download CSV</a> : null} />
      <Tabs base="/time/leave-controls" tabs={tabs} active={tab} />
      {tab === "blackouts" && admin ? <Blackouts tenantId={t} /> : null}
      {tab === "absences" ? <Absences tenantId={t} admin={admin} selfId={v.employee?.id ?? null} focus={sp.case} /> : null}
      {tab === "adjustments" && admin ? <Adjustments tenantId={t} /> : null}
      {tab === "calendar" ? <Calendar tenantId={t} employeeId={v.employee?.id ?? null} y={ym[0]} m={ym[1]} seeAll={admin || canAny(v, [P.LEAVE_VIEW])} /> : null}
      {tab === "liability" && admin ? <Liability tenantId={t} /> : null}
      {tab === "escalation" && admin ? <Escalation tenantId={t} /> : null}
    </>
  );
}

async function Blackouts({ tenantId }: { tenantId: string }) {
  const [rows, depts, locs, types] = await Promise.all([
    prisma.opsLeaveBlackout.findMany({ where: { tenantId }, orderBy: { startDate: "desc" } }),
    departmentOptions(tenantId), locationOptions(tenantId),
    prisma.leaveType.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const dn = new Map(depts.map((d) => [d.value, d.label])), ln = new Map(locs.map((d) => [d.value, d.label])), tn = new Map(types.map((x) => [x.id, x.name]));
  return (
    <div className="stack gap-4">
      <Card title="Add a blackout or peak period" description="A blackout refuses leave in the window; a peak period caps how many people (or what share of the group) may be away on the same day. Applies when employees apply for themselves.">
        <SpecForm action={saveLeaveBlackoutAction} columns={3} fields={[
          { name: "name", label: "Name", required: true }, { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "BLACKOUT", label: "Blackout" }, { value: "PEAK", label: "Peak period (cap)" }] },
          { name: "reason", label: "Reason" },
          { name: "startDate", label: "From", type: "date", required: true }, { name: "endDate", label: "To", type: "date", required: true },
          { name: "departmentId", label: "Department", type: "select", options: depts, placeholder: "Everyone" }, { name: "locationId", label: "Location", type: "select", options: locs, placeholder: "Every location" },
          { name: "maxConcurrent", label: "Max away at once", type: "number" }, { name: "maxConcurrentPct", label: "Or max share away (%)", type: "number" },
          { name: "leaveTypeIds", label: "Leave types (none ticked: all)", type: "multiselect", options: types.map((x) => ({ value: x.id, label: x.name })), wide: true },
        ]} />
      </Card>
      <Card title="Periods" tight>
        <Table head={["Name", "Kind", "Window", "Applies to", "Cap", "Leave types", "Active", ""]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-sm strong">{r.name}{r.reason ? <div className="text-xs subtle">{r.reason}</div> : null}</td><td><Pill s={r.kind} /></td>
              <td className="text-sm nowrap">{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</td>
              <td className="text-sm">{[r.departmentId ? dn.get(r.departmentId) : null, r.locationId ? ln.get(r.locationId) : null].filter(Boolean).join(" · ") || "Everyone"}</td>
              <td className="text-sm">{r.maxConcurrent ? `${r.maxConcurrent} people` : r.maxConcurrentPct ? `${r.maxConcurrentPct}%` : "—"}</td>
              <td className="text-xs">{r.leaveTypeIds.length ? r.leaveTypeIds.map((x) => tn.get(x) ?? x).join(", ") : "All"}</td>
              <td><Pill s={r.isActive ? "ACTIVE" : "INACTIVE"} /></td>
              <td><ActButton action={deleteLeaveBlackoutAction} hidden={{ id: r.id }} label="Remove" variant="ghost" confirmText="Remove this period?" /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Absences({ tenantId, admin, selfId, focus }: { tenantId: string; admin: boolean; selfId: string | null; focus?: string }) {
  const [rows, emps, reasons] = await Promise.all([
    prisma.opsAbsenceCase.findMany({ where: { tenantId, ...(admin ? {} : { employeeId: selfId ?? "-" }) }, orderBy: [{ createdAt: "desc" }], take: 200 }),
    admin ? employeeOptions(tenantId) : Promise.resolve([]),
    reasonCodes(tenantId, "ABSENCE", true),
  ]);
  const names = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, `${e.displayName} (${e.employeeNumber})`]));
  const open = rows.filter((r) => ["REQUESTED", "APPROVED", "ON_LEAVE"].includes(r.status));
  const sel = rows.find((r) => r.id === focus) ?? (admin ? open.find((r) => r.status === "ON_LEAVE") : undefined);
  const checklist = sel ? ((Array.isArray(sel.checklist) ? sel.checklist : []) as Array<{ item: string; done: boolean; at?: string }>) : [];
  return (
    <div className="stack gap-4">
      <Card title="Request a leave of absence" description="Sabbaticals, medical, parental or personal leave of 14 days or more. The manager and HR approve; on the start date the employee becomes inactive until they return.">
        <SpecForm action={requestAbsenceAction} columns={3} fields={[
          ...(admin ? [{ name: "employeeId", label: "Employee", type: "select" as const, options: emps, placeholder: "Myself" }] : []),
          { name: "kind", label: "Kind", type: "select", required: true, options: Object.entries(OPS_ABSENCE_KINDS).map(([value, label]) => ({ value, label })) },
          { name: "reasonCode", label: "Reason", type: "select", options: reasons.map((r) => ({ value: r.code, label: r.label })) },
          { name: "startDate", label: "From", type: "date", required: true }, { name: "expectedReturn", label: "Expected return", type: "date", required: true },
          { name: "rtwRequired", label: "Return to work", type: "checkbox", defaultValue: true, placeholder: "Fitness-to-work certificate needed" },
          { name: "note", label: "Note", wide: true },
        ]} />
      </Card>
      {sel && admin ? (
        <Card title={`Return to work: ${names.get(sel.employeeId) ?? ""}`} description={`${OPS_ABSENCE_KINDS[sel.kind] ?? sel.kind}, ${fmtDate(sel.startDate)} – ${fmtDate(sel.expectedReturn)}. ${opsReturnBlockers({ rtwRequired: sel.rtwRequired, rtwCertifiedAt: sel.rtwCertifiedAt, fitForWork: sel.fitForWork, checklist }).join(" ") || "Ready to return."}`}>
          <div className="grid grid-3">
            <div><div className="strong text-sm" style={{ marginBottom: 6 }}>Certificate</div>
              {sel.rtwCertifiedAt ? <div className="text-sm">{sel.fitForWork ? "Fit for work" : "Not fit"} · {fmtDate(sel.rtwCertifiedAt)}{sel.restrictions ? <div className="text-xs">Restrictions: {sel.restrictions}</div> : null}</div> : null}
              <SpecForm action={certifyReturnAction} hidden={{ caseId: sel.id }} columns={1} submitLabel="Certify" fields={[{ name: "fitForWork", label: "Outcome", type: "select", required: true, options: [{ value: "yes", label: "Fit for work" }, { value: "no", label: "Not yet fit" }] }, { name: "restrictions", label: "Restrictions" }, { name: "note", label: "Note" }]} />
            </div>
            <div><div className="strong text-sm" style={{ marginBottom: 6 }}>Checklist</div>
              <SpecForm action={tickReturnChecklistAction} hidden={{ caseId: sel.id }} columns={1} submitLabel="Save checklist" fields={[{ name: "done", label: "Done", type: "multiselect", defaultValue: checklist.map((c, i) => (c.done ? String(i) : "")).filter(Boolean), options: checklist.map((c, i) => ({ value: String(i), label: c.item })) }]} />
            </div>
            <div><div className="strong text-sm" style={{ marginBottom: 6 }}>Return</div>
              {sel.status === "ON_LEAVE" ? <SpecForm action={completeReturnAction} hidden={{ caseId: sel.id }} columns={1} submitLabel="Mark returned" fields={[{ name: "returnedOn", label: "Returned on", type: "date", required: true }]} /> : <div className="text-sm subtle">Status: {sel.status.toLowerCase().replace(/_/g, " ")}</div>}
            </div>
          </div>
        </Card>
      ) : null}
      <Card title="Absences" tight>
        <Table head={["Employee", "Kind", "From", "Expected return", "Returned", "Status", ""]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-sm">{names.get(r.employeeId) ?? ""}</td><td className="text-sm">{OPS_ABSENCE_KINDS[r.kind] ?? r.kind}{r.reasonCode ? <div className="text-xs subtle">{r.reasonCode}</div> : null}</td>
              <td className="text-sm">{fmtDate(r.startDate)}</td><td className="text-sm">{fmtDate(r.expectedReturn)}</td><td className="text-sm">{fmtDate(r.actualReturn)}</td><td><Pill s={r.status} /></td>
              <td className="row gap-1">{admin ? <a className="btn sm ghost" href={`/time/leave-controls?tab=absences&case=${r.id}`}>Open</a> : null}{["REQUESTED", "APPROVED"].includes(r.status) ? <ActButton action={cancelAbsenceAction} hidden={{ caseId: r.id }} label="Cancel" variant="ghost" confirmText="Cancel this absence?" /> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Adjustments({ tenantId }: { tenantId: string }) {
  const [emps, types, rows, s] = await Promise.all([
    employeeOptions(tenantId),
    prisma.leaveType.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_LEAVE_ADJUSTMENT" }, orderBy: { createdAt: "desc" }, take: 100 }),
    getOpsSettings(tenantId),
  ]);
  const names = await userNames(tenantId, rows.map((r) => r.requestedBy));
  return (
    <div className="stack gap-4">
      <Card title="Adjust a balance" description={s.requireBalanceAdjustmentApproval ? "Adjustments go to a second leave administrator before they post." : "Adjustments post at once (turn on approval under Time controls › Settings)."}>
        <SpecForm action={requestBalanceAdjustmentAction} columns={3} fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, options: emps }, { name: "leaveTypeId", label: "Leave type", type: "select", required: true, options: types.map((x) => ({ value: x.id, label: x.name })) },
          { name: "days", label: "Days (+ credit, − debit)", type: "number", required: true }, { name: "note", label: "Reason", required: true, wide: true },
        ]} />
      </Card>
      <Card title="Adjustment requests" tight><OpsRequests rows={rows} names={names} /></Card>
    </div>
  );
}

async function Calendar({ tenantId, employeeId, y, m, seeAll }: { tenantId: string; employeeId: string | null; y: number; m: number; seeAll: boolean }) {
  if (!employeeId && !seeAll) return null;
  const me = employeeId ?? (await prisma.employee.findFirst({ where: { tenantId }, select: { id: true } }))?.id ?? "";
  const cal = await leaveCalendarFor(tenantId, me, y, m, { seeAll });
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`, next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const people = [...new Set(cal.entries.map((e) => e.employee))].sort();
  return (
    <div className="stack gap-4">
      <div className="row gap-2"><a className="btn sm" href={`/time/leave-controls?tab=calendar&month=${prev}`}>Previous</a><span className="strong">{y}-{String(m).padStart(2, "0")}</span><a className="btn sm" href={`/time/leave-controls?tab=calendar&month=${next}`}>Next</a>
        <span className="text-xs subtle">Showing: {seeAll ? "everyone (administrator)" : cal.rule.toLowerCase()}{cal.hideType && !seeAll ? "; colleagues' leave types hidden" : ""}</span></div>
      <Card title="Who is away" tight>
        <Table head={["Employee", ...Array.from({ length: days }, (_, i) => String(i + 1))]} empty={people.length === 0}>
          {people.map((p) => (
            <tr key={p}><td className="text-sm nowrap">{p}</td>
              {Array.from({ length: days }, (_, i) => {
                const d = Date.UTC(y, m - 1, i + 1);
                const e = cal.entries.find((x) => x.employee === p && x.from.getTime() <= d && x.to.getTime() >= d);
                return <td key={i} title={e ? `${e.type} (${e.status.toLowerCase()})` : ""} style={{ background: e ? (e.color ?? "var(--accent-soft, #dbe7ff)") : undefined, opacity: e?.status === "PENDING" ? 0.5 : 1 }} />;
              })}
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Entries" tight>
        <Table head={["Employee", "Type", "From", "To", "Days", "Status"]} empty={cal.entries.length === 0}>
          {cal.entries.map((e) => <tr key={e.id}><td className="text-sm">{e.employee}</td><td className="text-sm">{e.type}</td><td className="text-sm">{fmtDate(e.from)}</td><td className="text-sm">{fmtDate(e.to)}</td><td className="num">{e.days}</td><td><Pill s={e.status} /></td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Liability({ tenantId }: { tenantId: string }) {
  const f = await leaveLiabilityForecast(tenantId, 12);
  const max = Math.max(1, ...f.forecast.map((x) => x.value), f.today);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Encashable liability today" value={inr(f.today)} />
        <Stat label="In 12 months" value={inr(f.forecast[f.forecast.length - 1]?.value ?? f.today)} meta="With accruals, caps and no leave taken" />
        <Stat label="Leave types" value={f.byType.length} />
      </div>
      <Card title="Forecast">
        <div className="row gap-1" style={{ alignItems: "flex-end", height: 140 }}>
          {f.forecast.map((x) => <div key={x.month} title={`${x.month}: ${inr(x.value)}`} style={{ flex: 1, height: `${Math.max(2, (x.value / max) * 130)}px`, background: "var(--accent, #4a6cf7)", borderRadius: 3 }} />)}
        </div>
        <div className="row gap-1 text-xs subtle">{f.forecast.map((x) => <div key={x.month} style={{ flex: 1, textAlign: "center" }}>{x.month.slice(5)}</div>)}</div>
      </Card>
      <div className="grid grid-2">
        <Card title="By leave type" tight>
          <Table head={["Leave type", "Encashable", "People", "Days held", "Today", "In 12 months"]} empty={f.byType.length === 0}>
            {f.byType.map((x) => <tr key={x.leaveTypeId}><td className="text-sm">{x.leaveType}</td><td>{x.encashable ? "Yes" : "No"}</td><td className="num">{x.employees}</td><td className="num">{x.days}</td><td className="num">{inr(x.today)}</td><td className="num">{inr(x.inTwelve)}</td></tr>)}
          </Table>
        </Card>
        <Card title="By department (encashable, today)" tight>
          <Table head={["Department", "Liability"]} empty={f.byDepartment.length === 0}>
            {f.byDepartment.map((x) => <tr key={x.department}><td className="text-sm">{x.department}</td><td className="num">{inr(x.value)}</td></tr>)}
          </Table>
        </Card>
      </div>
    </div>
  );
}

async function Escalation({ tenantId }: { tenantId: string }) {
  const s = await getOpsSettings(tenantId);
  const cutoff = s.leaveEscalationHours ? new Date(Date.now() - s.leaveEscalationHours * 3_600_000) : null;
  const [pending, alerts] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { tenantId, status: "PENDING", ...(cutoff ? { createdAt: { lte: cutoff } } : {}) }, include: { leaveType: { select: { name: true } } }, orderBy: { createdAt: "asc" }, take: 200 }),
    prisma.opsAlertLog.findMany({ where: { tenantId, kind: "LEAVE_ESCALATION" }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: pending.map((p) => p.employeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return (
    <div className="stack gap-4">
      <Callout title="Escalation rule">{s.leaveEscalationHours ? `Leave pending for more than ${s.leaveEscalationHours} hours goes to the approver's manager and leave administrators (nightly).` : "Escalation is off. Set the hours under Time controls › Settings › Leave."}</Callout>
      <Card title={cutoff ? `Waiting longer than ${s.leaveEscalationHours} hours` : "All pending requests"} tight>
        <Table head={["Employee", "Leave type", "Dates", "Raised", "Waiting (h)"]} empty={pending.length === 0}>
          {pending.map((p) => <tr key={p.id}><td className="text-sm">{names.get(p.employeeId) ?? ""}</td><td className="text-sm">{p.leaveType.name}</td><td className="text-sm nowrap">{fmtDate(p.fromDate)} – {fmtDate(p.toDate)}</td><td className="text-sm">{fmtWhen(p.createdAt)}</td><td className="num">{Math.round((Date.now() - p.createdAt.getTime()) / 3_600_000)}</td></tr>)}
        </Table>
      </Card>
      <Card title="Escalations sent" tight>
        <Table head={["When", "What", "People"]} empty={alerts.length === 0}>
          {alerts.map((a) => <tr key={a.id}><td className="text-sm">{fmtWhen(a.createdAt)}</td><td className="text-sm">{a.title}</td><td className="num">{a.userIds.length}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
