import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, utcDate, fyStartYear } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere, inScope, parseMonth, monthKey, shiftMonth } from "@/lib/scope";
import { Card, Badge, Empty, Person, Stat, Callout } from "@/components/ui";
import {
  ApplyLeaveForm, AdjustBalanceForm, AccrualForm,
  LeaveTypeForm, DeleteLeaveTypeButton, LeavePlanForm, AssignPlanForm,
  AddHolidayForm, DeleteHolidayButton, AddCalendarForm, type LeaveTypeValues,
} from "./leave-forms";
import { Disclosure } from "../org/forms";

/**
 * Leave administration — balances and their ledger, leave types, plans,
 * holidays, accrual — shared by Time Attend › Leave, Time Attend › Shift /
 * Weekly Offs & Holidays and My Team › Leave. Each tab is a server component
 * that queries inside the viewer's tenant and scope.
 */

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

async function employeeMap(ids: string[]) {
  const rows = ids.length === 0 ? [] : await prisma.employee.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function BalancesTab({
  viewer, emp, manage, onlyIds, base = "/time/leave",
}: {
  viewer: Viewer; emp?: string; manage: boolean;
  /** Limit to these employees (a manager's team). */
  onlyIds?: string[]; base?: string;
}) {
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const yearStart = utcDate(fy, viewer.tenant.fyStartMonth, 1);
  const [employees, types] = await Promise.all([
    prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.LEAVE_VIEW), status: { notIn: ["EXITED", "INACTIVE"] }, ...(onlyIds ? { id: { in: onlyIds } } : {}) },
      select: { id: true, displayName: true, employeeNumber: true },
      orderBy: { employeeNumber: "asc" },
    }),
    prisma.leaveType.findMany({
      where: { tenantId: viewer.tenantId, isActive: true, category: { in: ["REGULAR", "FLOATER", "COMP_OFF"] } },
      orderBy: { name: "asc" },
    }),
  ]);
  const balances = await prisma.leaveBalance.findMany({
    where: { yearStart, employeeId: { in: employees.map((e) => e.id) } },
  });
  const bal = new Map(balances.map((b) => [`${b.employeeId}:${b.leaveTypeId}`, b]));

  const selected = emp && employees.find((e) => e.id === emp);
  const ledger = selected ? await prisma.leaveLedgerEntry.findMany({
    where: { employeeId: selected.id, yearStart },
    orderBy: [{ createdAt: "desc" }], take: 60,
  }) : [];
  const typeName = new Map(types.map((t) => [t.id, t.code]));
  const allTypes = selected ? await prisma.leaveType.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }) : [];
  allTypes.forEach((t) => typeName.set(t.id, t.code));

  return (
    <div className="stack gap-4">
      {selected ? (
        <Card title={`${selected.displayName} — ledger`} description="Every credit and debit behind this year's balances"
          action={<Link className="btn sm" href={`${base}?tab=balances`}>Back to all</Link>}>
          {manage ? (
            <div style={{ margin: "-18px -18px 14px" }}>
              <AdjustBalanceForm employeeId={selected.id} types={types.map((t) => ({ value: t.id, label: t.name }))} />
            </div>
          ) : null}
          {manage ? (
            <Disclosure label="Apply leave on their behalf" variant="default">
              <ApplyLeaveForm
                types={allTypes.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name, allowHalfDay: t.allowHalfDay }))}
                employees={[{ value: selected.id, label: selected.displayName ?? selected.employeeNumber }]}
                defaultEmployeeId={selected.id}
              />
            </Disclosure>
          ) : null}
          {ledger.length === 0 ? <Empty title="No ledger entries this year" /> : (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data">
                <thead><tr><th>When</th><th>Type</th><th>Movement</th><th className="num">Days</th><th>Reference</th></tr></thead>
                <tbody>
                  {ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="nowrap text-sm">{formatDate(l.createdAt)}</td>
                      <td className="mono text-xs">{typeName.get(l.leaveTypeId) ?? "—"}</td>
                      <td><Badge tone={n(l.days) >= 0 ? "success" : "danger"}>{l.kind.replace(/_/g, " ").toLowerCase()}</Badge></td>
                      <td className={`num ${n(l.days) >= 0 ? "pos" : "neg"}`}>{n(l.days) > 0 ? "+" : ""}{n(l.days)}</td>
                      <td className="text-xs subtle">{l.note ?? l.periodKey ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Card tight title="Available balances" description="Current leave year. Pick someone to see their ledger or adjust.">
        {employees.length === 0 ? <Empty title="No employees in your scope" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Employee</th>{types.map((t) => <th key={t.id} className="num" title={t.name}>{t.code}</th>)}<th /></tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td><Person name={e.displayName ?? ""} meta={e.employeeNumber} /></td>
                    {types.map((t) => {
                      const b = bal.get(`${e.id}:${t.id}`);
                      return (
                        <td key={t.id} className={`num${b && n(b.available) < 0 ? " neg" : ""}`}>
                          {b ? n(b.available).toFixed(1) : <span className="subtle">—</span>}
                        </td>
                      );
                    })}
                    <td className="right"><Link className="btn sm ghost" href={`${base}?tab=balances&emp=${e.id}`}>Ledger</Link></td>
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

export async function CalendarTab({ tenantId, scopeIds, month, base = "/time/leave" }: { tenantId: string; scopeIds: string[] | null; month?: string; base?: string }) {
  const { year, month: m } = parseMonth(month);
  const start = new Date(Date.UTC(year, m - 1, 1));
  const end = new Date(Date.UTC(year, m, 0));
  const days = end.getUTCDate();
  const [leaveDays, holidays] = await Promise.all([
    prisma.leaveRequestDay.findMany({
      where: { date: { gte: start, lte: end }, request: { tenantId, status: { in: ["APPROVED", "PENDING"] }, ...inScope(scopeIds) } },
      select: { date: true, portion: true, request: { select: { employeeId: true, status: true, leaveType: { select: { code: true, color: true, isPaid: true } } } } },
    }),
    prisma.holiday.findMany({ where: { calendar: { tenantId, isDefault: true }, date: { gte: start, lte: end } } }),
  ]);
  const emps = await employeeMap(leaveDays.map((d) => d.request.employeeId));
  const grid = new Map<string, Map<number, (typeof leaveDays)[number]>>();
  for (const d of leaveDays) {
    const row = grid.get(d.request.employeeId) ?? new Map();
    row.set(d.date.getUTCDate(), d);
    grid.set(d.request.employeeId, row);
  }
  const holidaySet = new Map(holidays.map((h) => [h.date.getUTCDate(), h.name]));
  const prev = shiftMonth(year, m, -1), next = shiftMonth(year, m, 1);
  const label = start.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <Card tight title={`Who is off — ${label}`}
      description="Approved leave solid, pending leave outlined. Holidays and weekends shaded."
      action={
        <div className="row gap-2">
          <Link className="btn sm" href={`${base}?tab=calendar&month=${monthKey(prev.year, prev.month)}`}>‹ Prev</Link>
          <Link className="btn sm" href={`${base}?tab=calendar&month=${monthKey(next.year, next.month)}`}>Next ›</Link>
        </div>
      }>
      {grid.size === 0 ? <Empty title="Nobody is on leave this month" /> : (
        <div className="table-wrap">
          <table className="data cal-grid">
            <thead>
              <tr>
                <th>Employee</th>
                {Array.from({ length: days }, (_, i) => {
                  const dow = new Date(Date.UTC(year, m - 1, i + 1)).getUTCDay();
                  return <th key={i} className={`cal-day${dow === 0 || dow === 6 ? " off" : ""}${holidaySet.has(i + 1) ? " hol" : ""}`}
                    title={holidaySet.get(i + 1)}>{i + 1}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {[...grid.entries()].map(([employeeId, row]) => {
                const e = emps.get(employeeId);
                return (
                  <tr key={employeeId}>
                    <td className="nowrap text-sm">{e?.displayName ?? employeeId}</td>
                    {Array.from({ length: days }, (_, i) => {
                      const d = row.get(i + 1);
                      const dow = new Date(Date.UTC(year, m - 1, i + 1)).getUTCDay();
                      const shade = dow === 0 || dow === 6 || holidaySet.has(i + 1);
                      if (!d) return <td key={i} className={`cal-cell${shade ? " off" : ""}`} />;
                      const color = d.request.leaveType.color ?? (d.request.leaveType.isPaid ? "var(--brand-500)" : "var(--danger)");
                      const pending = d.request.status === "PENDING";
                      return (
                        <td key={i} className="cal-cell" title={`${d.request.leaveType.code} ${d.portion.replace("_", " ").toLowerCase()}${pending ? " (pending)" : ""}`}>
                          <span className="cal-chip" style={{
                            background: pending ? "transparent" : color, borderColor: color,
                            color: pending ? color : "#fff", width: d.portion === "FULL_DAY" ? "100%" : "55%",
                          }}>{d.request.leaveType.code.slice(0, 2)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export async function TypesTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
  const types = await prisma.leaveType.findMany({
    where: { tenantId }, orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { requests: true, planLinks: true } } },
  });
  const editing = edit ? types.find((t) => t.id === edit) : undefined;
  const values = (t: (typeof types)[number]): LeaveTypeValues => {
    const sc = (t.sandwichConfig ?? {}) as { weeklyOff?: Record<string, boolean>; holiday?: Record<string, boolean>; clubAcrossLeaveTypes?: boolean; excludeHalfDay?: boolean };
    const dec = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      ...t, annualQuota: dec(t.annualQuota), maxDaysDuringProbation: dec(t.maxDaysDuringProbation),
      maxAccumulation: dec(t.maxAccumulation), maxNegativeDays: dec(t.maxNegativeDays),
      attachmentAboveDays: dec(t.attachmentAboveDays), maxConsecutiveDays: dec(t.maxConsecutiveDays),
      carryForwardMax: dec(t.carryForwardMax),
      sandwichWeeklyOff: !!sc.weeklyOff?.between, sandwichHoliday: !!sc.holiday?.between,
      sandwichEdges: !!(sc.weeklyOff?.before || sc.holiday?.before),
      sandwichClub: !!sc.clubAcrossLeaveTypes, sandwichExcludeHalf: !!sc.excludeHalfDay,
    };
  };

  return (
    <div className="stack gap-4">
      <Card title={editing ? `Edit ${editing.name}` : "New leave type"}
        action={editing ? <Link className="btn sm" href="/time/leave?tab=types">Close</Link> : null}>
        {editing ? <LeaveTypeForm key={editing.id} type={values(editing)} /> : (
          <Disclosure label="Create a leave type"><LeaveTypeForm /></Disclosure>
        )}
      </Card>
      <Card tight title="Leave types">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Category</th><th className="num">Quota</th><th>Accrual</th><th>Rules</th><th>Year end</th><th className="num">Requests</th><th /></tr></thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} style={t.isActive ? undefined : { opacity: 0.55 }}>
                  <td>
                    <span className="row gap-2">
                      <span className="dot" style={{ color: t.color ?? "var(--brand-500)" }} />
                      <span className="strong">{t.name}</span><span className="mono text-xs subtle">{t.code}</span>
                      {!t.isActive ? <Badge>inactive</Badge> : null}
                    </span>
                  </td>
                  <td><Badge tone={t.category === "UNPAID" ? "danger" : t.category === "INCIDENT" ? "info" : "neutral"}>{t.category.toLowerCase().replace("_", " ")}</Badge></td>
                  <td className="num">{t.isUnlimited ? "∞" : n(t.annualQuota)}</td>
                  <td className="text-sm">{t.accrualFrequency.toLowerCase().replace("_", " ")}</td>
                  <td className="text-xs muted">
                    {[t.allowHalfDay && "half-day", t.sandwichConfig && "sandwich", t.allowNegativeBalance && "negative ok",
                      t.priorNoticeDays && `${t.priorNoticeDays}d notice`, t.isHiddenFromEmployee && "admin-only",
                      t.maxConsecutiveDays && `max ${n(t.maxConsecutiveDays)} in a row`].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="text-sm">{t.yearEndAction.replace(/_/g, " ").toLowerCase()}{t.carryForwardMax ? ` (cap ${n(t.carryForwardMax)})` : ""}</td>
                  <td className="num">{t._count.requests}</td>
                  <td className="right">
                    <span className="row gap-2" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn sm ghost" href={`/time/leave?tab=types&edit=${t.id}`}>Edit</Link>
                      <DeleteLeaveTypeButton id={t.id} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export async function PlansTab({ viewer }: { viewer: Viewer }) {
  const today = new Date();
  const [plans, types, employees] = await Promise.all([
    prisma.leavePlan.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        types: { include: { leaveType: { select: { id: true, name: true, code: true } } } },
        assignments: { where: { effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] }, select: { employeeId: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.leaveType.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] } },
      select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
    }),
  ]);
  const typeOpts = types.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }));
  const empOpts = employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }));
  const assigned = new Set(plans.flatMap((p) => p.assignments.map((a) => a.employeeId)));
  const unassigned = employees.filter((e) => !assigned.has(e.id));

  return (
    <div className="stack gap-4">
      {unassigned.length > 0 ? (
        <Callout tone="warning" title={`${unassigned.length} employee(s) have no leave plan`}>
          They accrue nothing until assigned: {unassigned.slice(0, 6).map((e) => e.displayName).join(", ")}{unassigned.length > 6 ? "…" : ""}
        </Callout>
      ) : null}
      <Card title="New leave plan"><Disclosure label="Create a plan"><LeavePlanForm types={typeOpts} /></Disclosure></Card>
      {plans.map((p) => (
        <Card key={p.id} title={<span className="row gap-2">{p.name}{p.isDefault ? <Badge tone="info">default</Badge> : null}</span>}
          description={`${p.assignments.length} employee(s) · ${p.yearBasis === "FINANCIAL_APR" ? "April–March" : p.yearBasis === "CALENDAR_JAN" ? "January–December" : "anniversary"} year`}>
          <div className="row gap-2 wrap" style={{ marginBottom: 14 }}>
            {p.types.map((t) => <Badge key={t.id}>{t.leaveType.name}</Badge>)}
          </div>
          <div className="grid grid-2">
            <Disclosure label="Edit plan" variant="default">
              <LeavePlanForm types={typeOpts} plan={{ id: p.id, name: p.name, description: p.description, yearBasis: p.yearBasis, isDefault: p.isDefault, typeIds: p.types.map((t) => t.leaveTypeId) }} />
            </Disclosure>
            <Disclosure label="Assign employees" variant="default">
              <AssignPlanForm planId={p.id} employees={empOpts} />
            </Disclosure>
          </div>
        </Card>
      ))}
    </div>
  );
}

export async function HolidaysTab({ tenantId, cal, canEdit }: { tenantId: string; cal?: string; canEdit: boolean }) {
  const calendars = await prisma.holidayCalendar.findMany({
    where: { tenantId }, orderBy: [{ year: "desc" }, { name: "asc" }],
    include: { _count: { select: { holidays: true } } },
  });
  const selected = calendars.find((c) => c.id === cal) ?? calendars.find((c) => c.year === new Date().getUTCFullYear() && c.isDefault) ?? calendars[0];
  const holidays = selected ? await prisma.holiday.findMany({ where: { calendarId: selected.id }, orderBy: { date: "asc" } }) : [];
  const nextYear = Math.max(new Date().getUTCFullYear() + 1, ...calendars.map((c) => c.year + 1));

  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: "280px minmax(0,1fr)", alignItems: "start" }}>
      <Card tight title="Calendars">
        <div className="stack">
          {calendars.map((c) => (
            <Link key={c.id} href={`/time/shifts?tab=holidays&cal=${c.id}`}
              className={`nav-item${selected?.id === c.id ? " active" : ""}`} style={{ margin: 4 }}>
              <span>{c.name} {c.year}</span><span className="spacer" /><span className="text-xs subtle">{c._count.holidays}</span>
            </Link>
          ))}
        </div>
        {canEdit ? (
          <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
            <Disclosure label="New calendar" variant="default">
              <AddCalendarForm nextYear={nextYear} calendars={calendars.map((c) => ({ value: c.id, label: `${c.name} ${c.year}` }))} />
            </Disclosure>
          </div>
        ) : null}
      </Card>
      <Card tight title={selected ? `${selected.name} ${selected.year}` : "No calendar"}
        description={selected?.isDefault ? "Default calendar — applies wherever a location has no calendar of its own" : undefined}>
        {holidays.length === 0 ? <Empty title="No holidays yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th /></tr></thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={h.id} style={h.date < new Date() ? { opacity: 0.6 } : undefined}>
                    <td className="nowrap">{formatDate(h.date)}</td>
                    <td className="text-sm muted">{h.date.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" })}</td>
                    <td className="strong">{h.name}</td>
                    <td>{h.isOptional ? <Badge tone="info">optional</Badge> : <Badge tone="success">public</Badge>}</td>
                    <td className="right">{canEdit ? <DeleteHolidayButton id={h.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && selected ? <AddHolidayForm calendarId={selected.id} year={selected.year} /> : null}
      </Card>
    </div>
  );
}

export async function AccrualTab({ tenantId, fyStartMonth }: { tenantId: string; fyStartMonth: number }) {
  const now = new Date();
  const fy = fyStartYear(now, fyStartMonth);
  const periods = await prisma.leaveLedgerEntry.groupBy({
    by: ["periodKey"],
    where: { tenantId, kind: "ACCRUAL", yearStart: utcDate(fy, fyStartMonth, 1) },
    _sum: { days: true }, _count: { _all: true },
    orderBy: { periodKey: "desc" },
  });
  const [adjustments, totals] = await Promise.all([
    prisma.leaveLedgerEntry.findMany({
      where: { tenantId, kind: "ADJUSTMENT", periodKey: { startsWith: "ADJ:" } }, orderBy: { createdAt: "desc" }, take: 15,
    }),
    prisma.leaveLedgerEntry.groupBy({
      by: ["kind"], where: { tenantId, yearStart: utcDate(fy, fyStartMonth, 1) }, _sum: { days: true },
    }),
  ]);
  const emps = await employeeMap(adjustments.map((a) => a.employeeId));
  const sum = (k: string) => n(totals.find((t) => t.kind === k)?._sum.days);

  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Accrued this year" value={sum("ACCRUAL").toFixed(1)} meta="days credited" />
        <Stat label="Used" value={(-sum("USED") - sum("REVERSAL")).toFixed(1)} meta="net of cancellations" />
        <Stat label="Adjusted" value={sum("ADJUSTMENT").toFixed(1)} meta="manual corrections" />
        <Stat label="Opening" value={sum("OPENING").toFixed(1)} meta="carried in" />
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Run accrual" description="Credits every active employee's plan for one month. Safe to re-run — each credit carries a period key, so nothing is ever credited twice.">
          <AccrualForm year={now.getUTCFullYear()} month={now.getUTCMonth() + 1} />
        </Card>
        <Card tight title="Accrual periods this year">
          {periods.length === 0 ? <Empty title="No accrual has run this year" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Period</th><th className="num">Credits</th><th className="num">Days</th></tr></thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.periodKey ?? "none"}>
                      <td className="mono text-sm">{p.periodKey?.replace("ACCRUAL:", "")}</td>
                      <td className="num">{p._count._all}</td>
                      <td className="num">{n(p._sum.days).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <Card tight title="Recent manual adjustments">
        {adjustments.length === 0 ? <Empty title="No manual adjustments" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Employee</th><th className="num">Days</th><th>Note</th></tr></thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap text-sm">{formatDate(a.createdAt)}</td>
                    <td className="text-sm">{emps.get(a.employeeId)?.displayName ?? "—"}</td>
                    <td className={`num ${n(a.days) >= 0 ? "pos" : "neg"}`}>{n(a.days) > 0 ? "+" : ""}{n(a.days)}</td>
                    <td className="text-sm muted">{a.note}</td>
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
