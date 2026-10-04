import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { encashableTypes, EDITABLE_STATUSES } from "@keka/services";
import { WEEKDAYS, weekdayRuleOf, type WeeklyOffConfig } from "@keka/time";
import { formatDate } from "@keka/shared";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import {
  LeaveRulesForm, CompOffSettingsForm, AttendanceRulesForm, WeeklyOffForm, RetireWeeklyOffButton,
  EncashOnBehalfForm, BulkMarkForm, RosterImportForm, KioskForm, KioskActions, ResetKioskPinButton,
} from "../../_time/depth-forms";

const P = PERMISSIONS;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const TABS = ["leave", "compoff", "encash", "rules", "weekly-offs", "bulk", "roster", "kiosks"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  leave: "Leave rules", compoff: "Comp off", encash: "Encash on behalf", rules: "Attendance rules",
  "weekly-offs": "Weekly offs", bulk: "Bulk mark", roster: "Roster import", kiosks: "Kiosks",
};

function allowed(viewer: Viewer, t: Tab): boolean {
  switch (t) {
    case "leave": case "compoff": return can(viewer, P.LEAVE_MANAGE);
    case "encash": return canAny(viewer, [P.LEAVE_MANAGE, P.LEAVE_APPROVE]);
    case "rules": case "bulk": case "kiosks": return can(viewer, P.ATTENDANCE_MANAGE);
    case "weekly-offs": return canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE]);
    case "roster": return can(viewer, P.SHIFT_MANAGE);
  }
}

/**
 * Time & attendance settings beyond the basic policy forms: hourly, encashment
 * and advance rules per leave type, comp-off, attendance rules per policy,
 * weekly-off patterns, encashment on an employee's behalf, bulk marking, the
 * roster import and web kiosks.
 */
export default async function TimeSettingsPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; edit?: string; emp?: string; policy?: string }>;
}) {
  const viewer = await requireViewer();
  const visible = TABS.filter((t) => allowed(viewer, t));
  if (visible.length === 0) forbidden();
  const sp = await searchParams;
  const tab: Tab = visible.includes(sp.tab as Tab) ? (sp.tab as Tab) : visible[0];

  return (
    <>
      <PageHead title="Time settings" subtitle="Leave and attendance rules, weekly offs, bulk changes and kiosks" />
      <div className="tabs">
        {visible.map((t) => (
          <Link key={t} href={`/time/settings?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{LABEL[t]}</Link>
        ))}
      </div>
      {tab === "leave" ? <LeaveRulesTab tenantId={viewer.tenantId} edit={sp.edit} /> : null}
      {tab === "compoff" ? <CompOffTab tenantId={viewer.tenantId} /> : null}
      {tab === "encash" ? <EncashTab viewer={viewer} emp={sp.emp} /> : null}
      {tab === "rules" ? <RulesTab tenantId={viewer.tenantId} policyId={sp.policy} /> : null}
      {tab === "weekly-offs" ? <WeeklyOffTab tenantId={viewer.tenantId} edit={sp.edit} /> : null}
      {tab === "bulk" ? <BulkTab viewer={viewer} /> : null}
      {tab === "roster" ? <RosterTab tenantId={viewer.tenantId} /> : null}
      {tab === "kiosks" ? <KiosksTab tenantId={viewer.tenantId} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------

async function LeaveRulesTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const types = await prisma.leaveType.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } });
  const editing = types.find((t) => t.id === edit);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    <div className="stack gap-4">
      {editing ? (
        <Card title={`${editing.name} — hourly, encashment and advance rules`} action={<Link className="btn sm" href="/time/settings?tab=leave">Close</Link>}>
          <LeaveRulesForm key={editing.id} type={{
            id: editing.id, name: editing.name, unit: editing.unit,
            hoursPerDay: n(editing.hoursPerDay), minHoursPerRequest: n(editing.minHoursPerRequest), maxHoursPerDay: n(editing.maxHoursPerDay),
            hourIncrementMinutes: editing.hourIncrementMinutes,
            allowEncashmentRequest: editing.allowEncashmentRequest, encashmentEnabled: editing.encashmentEnabled,
            encashmentMaxDaysPerYear: n(editing.encashmentMaxDaysPerYear), encashmentMinBalance: n(editing.encashmentMinBalance),
            encashmentMonths: editing.encashmentMonths, encashmentFormula: editing.encashmentFormula,
            allowAdvanceLeave: editing.allowAdvanceLeave, advanceLeaveMaxDays: n(editing.advanceLeaveMaxDays),
          }} />
        </Card>
      ) : null}
      <Card tight title="Leave types" description="Everything else about a leave type is edited under Leave → Leave types">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Type</th><th>Unit</th><th>Encashment</th><th>Advance</th><th /></tr></thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id}>
                  <td><span className="strong">{t.name}</span> <span className="mono text-xs subtle">{t.code}</span></td>
                  <td className="text-sm">{t.unit === "HOURS"
                    ? `Hours · ${n(t.hoursPerDay) ?? 8}h a day${t.maxHoursPerDay ? ` · max ${n(t.maxHoursPerDay)}h` : ""}${t.hourIncrementMinutes ? ` · ${t.hourIncrementMinutes}-min steps` : ""}`
                    : "Days"}</td>
                  <td className="text-sm">{!t.encashmentEnabled && !t.allowEncashmentRequest ? <span className="subtle">off</span> : (
                    [t.allowEncashmentRequest ? "employee requests" : "HR only",
                      t.encashmentMaxDaysPerYear !== null ? `max ${n(t.encashmentMaxDaysPerYear)}/yr` : null,
                      t.encashmentMinBalance !== null ? `keep ${n(t.encashmentMinBalance)}` : null,
                      t.encashmentMonths.length ? t.encashmentMonths.map((m) => MON[m - 1]).join(", ") : null].filter(Boolean).join(" · ")
                  )}</td>
                  <td className="text-sm">{t.allowAdvanceLeave ? `up to ${n(t.advanceLeaveMaxDays)} ${t.unit === "HOURS" ? "h" : "d"}` : <span className="subtle">off</span>}</td>
                  <td className="right"><Link className="btn sm ghost" href={`/time/settings?tab=leave&edit=${t.id}`}>Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

async function CompOffTab({ tenantId }: { tenantId: string }) {
  const [type, policies] = await Promise.all([
    prisma.leaveType.findFirst({ where: { tenantId, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } }),
    prisma.attendancePolicy.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, autoCreditCompOff: true, overtimeToCompOff: true, overtimeCompOffHoursPerDay: true } }),
  ]);
  return (
    <div className="stack gap-4">
      {!type ? (
        <Callout tone="warning">There is no compensatory-off leave type. Create one with the Comp off category under Leave → Leave types.</Callout>
      ) : (
        <Card title={`${type.name} settings`} description="How comp-off is requested, how long it lasts, and how many hours earn it">
          <CompOffSettingsForm type={{
            id: type.id, compOffRequestWindowDays: type.compOffRequestWindowDays, expiryDaysAfterCredit: type.expiryDaysAfterCredit,
            compOffHalfDayMinHours: n(type.compOffHalfDayMinHours), compOffFullDayMinHours: n(type.compOffFullDayMinHours),
          }} />
        </Card>
      )}
      <Card tight title="Overtime and comp-off by attendance policy" description="Turn overtime-to-comp-off conversion on under Attendance rules">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Policy</th><th>Worked off days</th><th>Approved overtime</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td className="strong">{p.name}</td>
                  <td className="text-sm">{p.autoCreditCompOff ? "credited automatically" : "employee requests credit"}</td>
                  <td className="text-sm">{p.overtimeToCompOff ? `converted to comp-off (${Number(p.overtimeCompOffHoursPerDay)} h = 1 day)` : "paid in payroll"}</td>
                  <td className="right"><Link className="btn sm ghost" href={`/time/settings?tab=rules&policy=${p.id}`}>Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

async function EncashTab({ viewer, emp }: { viewer: Viewer; emp?: string }) {
  const scope = can(viewer, P.LEAVE_MANAGE) ? scopedEmployeeWhere(viewer, P.LEAVE_MANAGE) : scopedEmployeeWhere(viewer, P.LEAVE_APPROVE);
  const employees = await prisma.employee.findMany({
    where: { AND: [scope, { status: { notIn: ["EXITED", "PREBOARDING"] } }, { id: { not: viewer.employee?.id ?? "__none__" } }] },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
  });
  const selected = employees.find((e) => e.id === emp);
  const types = selected ? await encashableTypes(selected.id, new Date(), { onBehalf: true }) : [];
  const recent = await prisma.leaveEncashmentRequest.findMany({
    where: { tenantId: viewer.tenantId, requestedBy: { not: null }, employeeId: { in: employees.map((e) => e.id) } },
    include: { leaveType: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } },
    orderBy: { createdAt: "desc" }, take: 20,
  });
  return (
    <div className="stack gap-4">
      <Card title="Encash leave for an employee" description="Raised requests go to approval like any encashment; approval debits the balance and pays it in the next payroll">
        <form method="get" className="row gap-2" style={{ marginBottom: 12 }}>
          <input type="hidden" name="tab" value="encash" />
          <select name="emp" className="select" defaultValue={selected?.id ?? ""} aria-label="Employee" style={{ maxWidth: 360 }}>
            <option value="">Choose an employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} — {e.displayName}</option>)}
          </select>
          <button className="btn" type="submit">Show</button>
        </form>
        {selected ? (
          <>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table className="data">
                <thead><tr><th>Leave</th><th className="num">Balance</th><th className="num">Encashable</th><th className="num">Per day</th><th>Note</th></tr></thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.leaveTypeId}>
                      <td className="strong">{t.name}</td><td className="num">{t.balance}</td><td className="num">{t.encashable}</td>
                      <td className="num">₹{t.ratePerDay.toLocaleString("en-IN")}</td><td className="text-xs muted">{t.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {types.some((t) => t.encashable > 0) ? (
              <EncashOnBehalfForm employeeId={selected.id} types={types.filter((t) => t.encashable > 0).map((t) => ({ value: t.leaveTypeId, label: t.name, encashable: t.encashable }))} />
            ) : <div className="muted text-sm">Nothing is encashable for {selected.displayName} right now.</div>}
          </>
        ) : null}
      </Card>
      <Card tight title="Raised on behalf">
        {recent.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Leave</th><th className="num">Days</th><th className="num">Amount</th><th>Raised</th><th>Status</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee.displayName} <span className="text-xs subtle">{r.employee.employeeNumber}</span></td>
                    <td>{r.leaveType.name}</td><td className="num">{Number(r.days)}</td>
                    <td className="num">{r.amount === null ? "—" : `₹${Number(r.amount).toLocaleString("en-IN")}`}</td>
                    <td className="text-sm">{formatDate(r.createdAt)}</td>
                    <td><Badge tone={r.status === "APPROVED" ? "success" : r.status === "PENDING" ? "warning" : "neutral"}>{r.status.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function RulesTab({ tenantId, policyId }: { tenantId: string; policyId?: string }) {
  const policies = await prisma.attendancePolicy.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  if (policies.length === 0) return <Empty title="No attendance policies">Create one under Attendance → Policies first.</Empty>;
  const p = policies.find((x) => x.id === policyId) ?? policies.find((x) => x.isDefault) ?? policies[0];
  return (
    <div className="stack gap-4">
      <div className="row gap-2 wrap">
        {policies.map((x) => (
          <Link key={x.id} href={`/time/settings?tab=rules&policy=${x.id}`} className={`btn sm${x.id === p.id ? " primary" : ""}`}>
            {x.name}{x.isDefault ? " (default)" : ""}
          </Link>
        ))}
      </div>
      <Card title={p.name} description="General attendance, regularisation, remote-work and overtime rules. Capture and penalties are on Attendance → Policies.">
        <AttendanceRulesForm key={p.id} policy={{
          id: p.id, name: p.name, hoursBasis: p.hoursBasis, awolEnabled: p.awolEnabled, awolAfterDays: p.awolAfterDays,
          newJoinerGraceDays: p.newJoinerGraceDays, regularisationMonthlyLimit: p.regularisationMonthlyLimit,
          regularisationCutoffDay: p.regularisationCutoffDay, wfhMonthlyLimit: p.wfhMonthlyLimit, odMonthlyLimit: p.odMonthlyLimit,
          remoteNoticeDays: p.remoteNoticeDays, remoteAllowedOnHolidays: p.remoteAllowedOnHolidays,
          remoteAllowedOnWeeklyOffs: p.remoteAllowedOnWeeklyOffs, remoteAttachmentRequired: p.remoteAttachmentRequired,
          allowHalfDayRemoteWork: p.allowHalfDayRemoteWork, allowHourlyRemoteWork: p.allowHourlyRemoteWork,
          overtimeToCompOff: p.overtimeToCompOff, overtimeCompOffHoursPerDay: Number(p.overtimeCompOffHoursPerDay),
        }} />
      </Card>
    </div>
  );
}

const ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
function describe(config: WeeklyOffConfig): string {
  const words: Record<string, string> = { ALL: "every", ALT_2_4: "2nd & 4th", ALT_1_3_5: "1st, 3rd & 5th" };
  return ORDER.flatMap((d) => {
    const r = weekdayRuleOf(config, d);
    if (r.rule === "WORKING") return [];
    const which = words[r.rule] ?? r.instances.map((i) => ["", "1st", "2nd", "3rd", "4th", "5th"][i]).join(", ");
    return [`${which} ${d.charAt(0)}${d.slice(1).toLowerCase()}${r.portion !== "FULL_DAY" ? ` (${r.portion === "FIRST_HALF" ? "first half" : "second half"})` : ""}`];
  }).join(" · ") || "none";
}

async function WeeklyOffTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const [patterns, usage] = await Promise.all([
    prisma.weeklyOffPolicy.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.employeeTimePolicy.groupBy({ by: ["weeklyOffPolicyId"], where: { effectiveTo: null, employee: { tenantId } }, _count: { _all: true } }),
  ]);
  const used = new Map(usage.map((u) => [u.weeklyOffPolicyId, u._count._all]));
  const editing = patterns.find((p) => p.id === edit);
  const rowsOf = (config: WeeklyOffConfig) => Object.fromEntries(WEEKDAYS.map((d) => [d, weekdayRuleOf(config, d)]));
  return (
    <div className="stack gap-4">
      <Card title={editing ? `Edit ${editing.name}` : "New weekly-off pattern"} action={editing ? <Link className="btn sm" href="/time/settings?tab=weekly-offs">Close</Link> : null}
        description="Which days of each week are off — including alternate Saturdays and half days">
        <WeeklyOffForm key={editing?.id ?? "new"} pattern={editing ? {
          id: editing.id, name: editing.name, isDefault: editing.isDefault, days: rowsOf(editing.config as WeeklyOffConfig),
        } : undefined} />
      </Card>
      <Card tight title="Weekly-off patterns" description="Assign a pattern to employees under Attendance → Assignments">
        {patterns.length === 0 ? <Empty title="No patterns yet">Without one, Saturdays and Sundays are off.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Pattern</th><th>Days off</th><th className="num">Employees</th><th /></tr></thead>
              <tbody>
                {patterns.map((w) => (
                  <tr key={w.id}>
                    <td><span className="strong">{w.name}</span> {w.isDefault ? <Badge tone="info">default</Badge> : null}</td>
                    <td className="text-sm">{describe(w.config as WeeklyOffConfig)}</td>
                    <td className="num">{used.get(w.id) ?? 0}</td>
                    <td className="right"><div className="row gap-2" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn sm ghost" href={`/time/settings?tab=weekly-offs&edit=${w.id}`}>Edit</Link>
                      {!w.isDefault ? <RetireWeeklyOffButton id={w.id} /> : null}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function BulkTab({ viewer }: { viewer: Viewer }) {
  const employees = await prisma.employee.findMany({
    where: { AND: [scopedEmployeeWhere(viewer, P.ATTENDANCE_MANAGE), { status: { notIn: ["EXITED", "PREBOARDING"] } }] },
    select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } }, orderBy: { employeeNumber: "asc" },
  });
  const today = new Date().toISOString().slice(0, 10);
  const recent = await prisma.auditLog.findMany({
    where: { tenantId: viewer.tenantId, entityType: "AttendanceRecord", summary: { startsWith: "Bulk marked" } },
    orderBy: { createdAt: "desc" }, take: 10, select: { id: true, createdAt: true, summary: true, actorLabel: true },
  });
  return (
    <div className="stack gap-4">
      <Card title="Mark attendance in bulk" description="Pins the status on every selected employee's days, exactly like a single-day correction. Choose Automatic to remove earlier pins.">
        <BulkMarkForm from={today} to={today}
          employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}${e.department ? ` · ${e.department.name}` : ""}` }))}
          statuses={[...EDITABLE_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) })), { value: "AUTO", label: "Automatic (clear the pin)" }]} />
      </Card>
      <Card tight title="Recent bulk changes">
        {recent.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}><td className="text-sm nowrap">{formatDate(r.createdAt)}</td><td className="text-sm">{r.summary}</td><td className="text-xs muted">{r.actorLabel}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function RosterTab({ tenantId }: { tenantId: string }) {
  const shifts = await prisma.shift.findMany({ where: { tenantId, isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true, startTime: true, endTime: true } });
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Import a roster" description="Check first; nothing is written until every row is valid. Days in the past are reprocessed.">
        <RosterImportForm />
      </Card>
      <Card tight title="Shift codes">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Code</th><th>Shift</th><th>Timing</th></tr></thead>
            <tbody>
              {shifts.map((s) => <tr key={s.code}><td className="mono">{s.code}</td><td>{s.name}</td><td className="text-sm">{s.startTime} – {s.endTime}</td></tr>)}
              <tr><td className="mono">WO</td><td>Weekly off</td><td /></tr>
              <tr><td className="mono">DEFAULT</td><td>Back to the assigned shift</td><td /></tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

async function KiosksTab({ tenantId }: { tenantId: string }) {
  const [kiosks, locations, pins] = await Promise.all([
    prisma.attendanceKiosk.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.kioskPin.findMany({
      where: { tenantId }, orderBy: { updatedAt: "desc" }, take: 50,
      include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } },
    }),
  ]);
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  return (
    <div className="stack gap-4">
      <Card title="New kiosk" description="A shared device where employees punch with their employee number and personal PIN. Open the kiosk's link on the device and unlock it with the kiosk PIN.">
        <KioskForm locations={locations.map((l) => ({ value: l.id, label: l.name }))} />
      </Card>
      <Card tight title="Kiosks">
        {kiosks.length === 0 ? <Empty title="No kiosks yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Kiosk</th><th>Link</th><th>Last punch</th><th>Status</th><th /></tr></thead>
              <tbody>
                {kiosks.map((k) => (
                  <tr key={k.id}>
                    <td><span className="strong">{k.name}</span><div className="text-xs subtle">{k.locationId ? locName.get(k.locationId) : "Any location"}</div></td>
                    <td><a className="mono text-xs" href={`/kiosk/${k.token}`} target="_blank" rel="noreferrer">/kiosk/{k.token.slice(0, 8)}…</a></td>
                    <td className="text-sm">{k.lastUsedAt ? k.lastUsedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never"}</td>
                    <td>{k.isActive ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}</td>
                    <td className="right"><KioskActions id={k.id} active={k.isActive} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card tight title="Employee kiosk PINs" description="Employees set their own PIN under Me → Attendance. Clear one if it is forgotten or locked.">
        {pins.length === 0 ? <Empty title="No one has set a PIN yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Set</th><th>Status</th><th /></tr></thead>
              <tbody>
                {pins.map((p) => (
                  <tr key={p.id}>
                    <td>{p.employee.displayName} <span className="text-xs subtle">{p.employee.employeeNumber}</span></td>
                    <td className="text-sm">{formatDate(p.updatedAt)}</td>
                    <td>{p.lockedUntil && p.lockedUntil > new Date() ? <Badge tone="danger">locked</Badge> : <Badge tone="success">active</Badge>}</td>
                    <td className="right"><ResetKioskPinButton employeeId={p.employee.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
