import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, utcDate, fyStartYear } from "@keka/shared";
import { requireAuth, can, canAny } from "@/lib/context";
import { runLeaveYearEnd } from "@keka/services";
import { scopedEmployeeIds, scopedEmployeeWhere, inScope, parseMonth, monthKey, shiftMonth } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Callout } from "@/components/ui";
import {
  ApplyLeaveForm, DecisionForm, CancelLeaveButton, AdjustBalanceForm, AccrualForm, YearEndButton,
  LeaveTypeForm, DeleteLeaveTypeButton, LeavePlanForm, AssignPlanForm,
  AddHolidayForm, DeleteHolidayButton, AddCalendarForm, type LeaveTypeValues,
} from "../_time/leave-forms";
import { Disclosure } from "../org/forms";
import { ApprovalsTab, CompOffTab, OptionalHolidayQuota, optionalPickCounts } from "./_depth";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);
const TABS = ["requests", "balances", "calendar", "types", "plans", "approvals", "compoff", "holidays", "accrual", "yearend"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  requests: "Requests", balances: "Balances", calendar: "Team calendar", types: "Leave types",
  plans: "Leave plans", approvals: "Approval chains", compoff: "Comp off", holidays: "Holidays", accrual: "Accrual & ledger", yearend: "Year end",
};

export default async function LeaveAdminPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; status?: string; emp?: string; month?: string; edit?: string; cal?: string }> }) {
  const viewer = await requireAuth(P.LEAVE_VIEW);
  // Every employee can view their own leave; this hub is for those who act on others'.
  if (!canAny(viewer, [P.LEAVE_APPROVE, P.LEAVE_MANAGE, P.HOLIDAY_MANAGE])) redirect("/me/leave");

  const sp = await searchParams;
  const manage = can(viewer, P.LEAVE_MANAGE);
  const visible = TABS.filter((t) => manage || !["types", "plans", "approvals", "accrual", "yearend"].includes(t));
  const tab: Tab = visible.includes(sp.tab as Tab) ? (sp.tab as Tab) : "requests";

  const scopeIds = await scopedEmployeeIds(viewer, P.LEAVE_VIEW);
  const pendingCount = await prisma.leaveRequest.count({
    where: { tenantId: viewer.tenantId, status: "PENDING", ...inScope(scopeIds) },
  });

  return (
    <>
      <PageHead
        title="Leave"
        subtitle={manage ? "Requests, balances, policies and the accrual ledger" : "Leave requests from the people you approve for"}
      />
      <div className="tabs">
        {visible.map((t) => (
          <Link key={t} href={`/leave?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {LABEL[t]}{t === "requests" && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </Link>
        ))}
      </div>

      {tab === "requests" ? <RequestsTab viewerId={viewer.employee?.id} tenantId={viewer.tenantId} scopeIds={scopeIds}
        status={sp.status} approveIds={can(viewer, P.LEAVE_APPROVE) ? await scopedEmployeeIds(viewer, P.LEAVE_APPROVE) : []}
        manage={manage} /> : null}
      {tab === "balances" ? <BalancesTab viewer={viewer} scopeIds={scopeIds} emp={sp.emp} manage={manage} /> : null}
      {tab === "calendar" ? <CalendarTab tenantId={viewer.tenantId} scopeIds={scopeIds} month={sp.month} /> : null}
      {tab === "types" ? <TypesTab tenantId={viewer.tenantId} edit={sp.edit} /> : null}
      {tab === "plans" ? <PlansTab viewer={viewer} /> : null}
      {tab === "approvals" ? <ApprovalsTab tenantId={viewer.tenantId} /> : null}
      {tab === "compoff" ? <CompOffTab viewer={viewer} /> : null}
      {tab === "holidays" ? <HolidaysTab tenantId={viewer.tenantId} cal={sp.cal} canEdit={can(viewer, P.HOLIDAY_MANAGE)} /> : null}
      {tab === "accrual" ? <AccrualTab tenantId={viewer.tenantId} fyStartMonth={viewer.tenant.fyStartMonth} /> : null}
      {tab === "yearend" ? <YearEndTab tenantId={viewer.tenantId} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------

async function employeeMap(ids: string[]) {
  const rows = ids.length === 0 ? [] : await prisma.employee.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function RequestsTab({
  viewerId, tenantId, scopeIds, status, approveIds, manage,
}: {
  viewerId?: string; tenantId: string; scopeIds: string[] | null; status?: string;
  /** Who this viewer may approve for; null means anyone. Viewing is wider than approving. */
  approveIds: string[] | null; manage: boolean;
}) {
  const approvable = approveIds === null ? null : new Set(approveIds);
  const canDecide = (employeeId: string) =>
    employeeId !== viewerId && (approvable === null || approvable.has(employeeId));
  const filter = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status ?? "") ? status! : "PENDING";
  const requests = await prisma.leaveRequest.findMany({
    where: { tenantId, status: filter as never, ...inScope(scopeIds) },
    include: { leaveType: { select: { name: true, code: true, isPaid: true, color: true } } },
    orderBy: filter === "PENDING" ? { fromDate: "asc" } : { updatedAt: "desc" },
    take: 60,
  });
  const emps = await employeeMap(requests.map((r) => r.employeeId));

  // Who else is off on each pending request's dates — the approver's real question.
  const overlaps = new Map<string, number>();
  if (filter === "PENDING" && requests.length > 0) {
    const days = await prisma.leaveRequestDay.findMany({
      where: {
        request: { tenantId, status: "APPROVED", ...inScope(scopeIds) },
        date: { gte: requests[0].fromDate, lte: requests.reduce((m, r) => (r.toDate > m ? r.toDate : m), requests[0].toDate) },
      },
      select: { date: true, request: { select: { employeeId: true } } },
    });
    for (const r of requests) {
      const others = new Set(days
        .filter((d) => d.date >= r.fromDate && d.date <= r.toDate && d.request.employeeId !== r.employeeId)
        .map((d) => d.request.employeeId));
      overlaps.set(r.id, others.size);
    }
  }

  const tone = (s: string) => s === "APPROVED" ? "success" : s === "REJECTED" ? "danger" : s === "PENDING" ? "warning" : "neutral";

  return (
    <Card tight title={`${filter.charAt(0)}${filter.slice(1).toLowerCase()} requests`}
      action={
        <div className="row gap-2">
          {["PENDING", "APPROVED", "REJECTED", "CANCELLED"].map((s) => (
            <Link key={s} href={`/leave?tab=requests&status=${s}`} className={`btn sm${s === filter ? " primary" : ""}`}>
              {s.toLowerCase()}
            </Link>
          ))}
        </div>
      }>
      {requests.length === 0 ? (
        <Empty title={filter === "PENDING" ? "No leave waiting for a decision" : `No ${filter.toLowerCase()} requests`} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Employee</th><th>Leave</th><th>Dates</th><th className="num">Days</th><th>Reason</th>
                {filter === "PENDING" ? <th>Team off</th> : <th>Status</th>}<th /></tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const e = emps.get(r.employeeId);
                const started = r.fromDate.getTime() <= Date.now();
                return (
                  <tr key={r.id}>
                    <td>{e ? <Link href={`/employees/${e.id}`}><Person name={e.displayName ?? ""} meta={`${e.employeeNumber} · ${e.department?.name ?? ""}`} /></Link> : "—"}</td>
                    <td>
                      <span className="row gap-2">
                        {r.leaveType.name}
                        {!r.leaveType.isPaid ? <Badge tone="danger">LOP</Badge> : null}
                      </span>
                    </td>
                    <td className="nowrap text-sm">
                      {formatDate(r.fromDate)}{r.toDate.getTime() !== r.fromDate.getTime() ? ` – ${formatDate(r.toDate)}` : ""}
                      {r.fromPortion !== "FULL_DAY" ? <div className="text-xs subtle">{r.fromPortion.replace("_", " ").toLowerCase()}</div> : null}
                    </td>
                    <td className="num">
                      {n(r.totalDays).toFixed(1)}
                      {n(r.sandwichDays) > 0 ? <div className="text-xs" style={{ color: "var(--warning)" }}>+{n(r.sandwichDays)} sandwich</div> : null}
                      {r.status === "PENDING" && Array.isArray(r.approvalSteps) && r.approvalSteps.length > 1
                        ? <div className="text-xs subtle">level {r.approvalLevel + 1} of {r.approvalSteps.length}</div> : null}
                    </td>
                    <td className="text-sm muted" style={{ maxWidth: 260 }}>{r.reason ?? "—"}{r.rejectReason ? <div className="text-xs neg">Rejected: {r.rejectReason}</div> : null}</td>
                    {filter === "PENDING" ? (
                      <td>{(overlaps.get(r.id) ?? 0) > 0 ? <Badge tone="warning">{overlaps.get(r.id)} also off</Badge> : <span className="text-xs subtle">none</span>}</td>
                    ) : (
                      <td><Badge tone={tone(r.status)}>{r.status.toLowerCase()}</Badge></td>
                    )}
                    <td className="right">
                      {r.status === "PENDING" && canDecide(r.employeeId) ? <DecisionForm requestId={r.id} kind="leave" />
                        : r.status === "PENDING" ? <span className="text-xs subtle">{r.employeeId === viewerId ? "your own" : "not your approval"}</span> : null}
                      {r.status === "APPROVED" && manage ? <CancelLeaveButton requestId={r.id} label={started ? "Cancel (reprocesses)" : "Cancel"} /> : null}
                    </td>
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

async function BalancesTab({
  viewer, scopeIds, emp, manage,
}: {
  viewer: Awaited<ReturnType<typeof requireAuth>>; scopeIds: string[] | null; emp?: string; manage: boolean;
}) {
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const yearStart = utcDate(fy, viewer.tenant.fyStartMonth, 1);
  const [employees, types] = await Promise.all([
    prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.LEAVE_VIEW), status: { notIn: ["EXITED", "INACTIVE"] } },
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
          action={<Link className="btn sm" href="/leave?tab=balances">Back to all</Link>}>
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
                    <td className="right"><Link className="btn sm ghost" href={`/leave?tab=balances&emp=${e.id}`}>Ledger</Link></td>
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

async function CalendarTab({ tenantId, scopeIds, month }: { tenantId: string; scopeIds: string[] | null; month?: string }) {
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
          <Link className="btn sm" href={`/leave?tab=calendar&month=${monthKey(prev.year, prev.month)}`}>‹ Prev</Link>
          <Link className="btn sm" href={`/leave?tab=calendar&month=${monthKey(next.year, next.month)}`}>Next ›</Link>
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

async function TypesTab({ tenantId, edit }: { tenantId: string; edit?: string }) {
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
      maxDaysPerMonth: dec(t.maxDaysPerMonth),
      carryForwardMax: dec(t.carryForwardMax),
      sandwichWeeklyOff: !!sc.weeklyOff?.between, sandwichHoliday: !!sc.holiday?.between,
      sandwichEdges: !!(sc.weeklyOff?.before || sc.holiday?.before),
      sandwichClub: !!sc.clubAcrossLeaveTypes, sandwichExcludeHalf: !!sc.excludeHalfDay,
    };
  };

  return (
    <div className="stack gap-4">
      <Card title={editing ? `Edit ${editing.name}` : "New leave type"}
        action={editing ? <Link className="btn sm" href="/leave?tab=types">Close</Link> : null}>
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
                      t.maxConsecutiveDays && `max ${n(t.maxConsecutiveDays)} in a row`,
                      t.maxDaysPerMonth && `max ${n(t.maxDaysPerMonth)}/month`, t.minGapBetweenLeavesDays && `${t.minGapBetweenLeavesDays}d gap`,
                      t.approvalChain && "approval chain"].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="text-sm">{t.yearEndAction.replace(/_/g, " ").toLowerCase()}{t.carryForwardMax ? ` (cap ${n(t.carryForwardMax)})` : ""}</td>
                  <td className="num">{t._count.requests}</td>
                  <td className="right">
                    <span className="row gap-2" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn sm ghost" href={`/leave?tab=types&edit=${t.id}`}>Edit</Link>
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

async function PlansTab({ viewer }: { viewer: Awaited<ReturnType<typeof requireAuth>> }) {
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

async function HolidaysTab({ tenantId, cal, canEdit }: { tenantId: string; cal?: string; canEdit: boolean }) {
  const calendars = await prisma.holidayCalendar.findMany({
    where: { tenantId }, orderBy: [{ year: "desc" }, { name: "asc" }],
    include: { _count: { select: { holidays: true } } },
  });
  const selected = calendars.find((c) => c.id === cal) ?? calendars.find((c) => c.year === new Date().getUTCFullYear() && c.isDefault) ?? calendars[0];
  const holidays = selected ? await prisma.holiday.findMany({ where: { calendarId: selected.id }, orderBy: { date: "asc" } }) : [];
  const picks = selected ? await optionalPickCounts(selected.id) : new Map<string, number>();
  const nextYear = Math.max(new Date().getUTCFullYear() + 1, ...calendars.map((c) => c.year + 1));

  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: "280px minmax(0,1fr)", alignItems: "start" }}>
      <Card tight title="Calendars">
        <div className="stack">
          {calendars.map((c) => (
            <Link key={c.id} href={`/leave?tab=holidays&cal=${c.id}`}
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
                    <td>{h.isOptional ? <><Badge tone="info">optional</Badge> <span className="text-xs subtle">{picks.get(h.id) ?? 0} picked</span></> : <Badge tone="success">public</Badge>}</td>
                    <td className="right">{canEdit ? <DeleteHolidayButton id={h.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && selected ? <AddHolidayForm calendarId={selected.id} year={selected.year} /> : null}
        {selected ? <OptionalHolidayQuota calendarId={selected.id} quota={selected.optionalHolidayQuota} canEdit={canEdit} /> : null}
      </Card>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  RESET: "Lapses", PAY_ALL: "Paid out", CARRY_FORWARD_ALL: "Carries forward",
  PAY_THEN_CARRY_FORWARD: "Paid out, then carried", CARRY_FORWARD_THEN_PAY: "Carried, then paid out",
};

async function YearEndTab({ tenantId }: { tenantId: string }) {
  // A dry run: exactly what the nightly job would post today.
  const [preview, types, recent] = await Promise.all([
    runLeaveYearEnd({ tenantId, apply: false }),
    prisma.leaveType.findMany({ where: { tenantId, isUnlimited: false, category: { not: "COMP_OFF" } }, orderBy: { name: "asc" } }),
    prisma.leaveLedgerEntry.groupBy({ by: ["kind"], where: { tenantId, periodKey: { startsWith: "YEAREND:" }, createdAt: { gte: new Date(Date.now() - 400 * 86_400_000) } }, _sum: { days: true }, _count: { _all: true } }),
  ]);
  const emps = preview.rows.length;
  const tot = (f: (r: (typeof preview.rows)[number]) => number) => Math.round(preview.rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
  const done = (k: string) => Math.abs(n(recent.find((r) => r.kind === k)?._sum.days));
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Balances to close" value={String(emps)} meta="leave years that have ended" />
        <Stat label="Would carry forward" value={tot((r) => Math.max(0, r.carry)).toFixed(1)} meta="days" />
        <Stat label="Would pay out" value={tot((r) => r.pay).toFixed(1)} meta={`₹${tot((r) => r.amount).toLocaleString("en-IN")} through payroll`} />
        <Stat label="Would lapse" value={(tot((r) => r.lapse) + preview.expiredDays).toFixed(1)} meta={preview.expired ? `incl. ${preview.expiredDays} expired carry-forward` : "days"} />
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Close ended leave years" description="Each leave type's year-end rule decides what happens to unused days. Carried days land in the new year's balance, payouts are added to the next open payroll as taxable leave encashment, and every movement is on the ledger.">
          <YearEndButton pending={emps} />
        </Card>
        <Card tight title="Year-end rule by leave type">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Leave type</th><th>At year end</th><th className="num">Carry cap</th><th className="num">Pay cap</th><th className="num">Carried days expire</th></tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className="strong">{t.name}</td>
                    <td>{ACTION_LABEL[t.yearEndAction] ?? t.yearEndAction}{t.yearEndAction.includes("PAY") && !t.encashmentEnabled ? <div className="text-xs subtle">encashment off, so nothing is paid</div> : null}</td>
                    <td className="num">{t.carryForwardMax === null ? "—" : n(t.carryForwardMax)}</td>
                    <td className="num">{t.encashmentMaxDaysPerYear === null ? "—" : n(t.encashmentMaxDaysPerYear)}</td>
                    <td className="num">{t.carryForwardExpiryDays ? `after ${t.carryForwardExpiryDays} days` : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Card tight title="What closing would do" description={recent.length ? `Closed in the last year: ${done("ENCASHMENT")} day(s) paid out and ${done("LAPSE")} lapsed.` : "Nothing has been closed yet."}>
        {preview.rows.length === 0 ? <Empty title="Every ended leave year is already closed" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Leave type</th><th>Year</th><th className="num">Unused</th><th className="num">Carry</th><th className="num">Pay</th><th className="num">Lapse</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r) => (
                  <tr key={`${r.employeeId}:${r.leaveTypeId}:${r.yearStart.toISOString()}`}>
                    <td>{r.employeeName} <span className="subtle text-xs">{r.employeeNumber}</span></td>
                    <td>{r.leaveType}</td>
                    <td className="nowrap">{formatDate(r.yearStart)} – {formatDate(new Date(r.nextYear.getTime() - 86_400_000))}</td>
                    <td className="num">{r.available}</td>
                    <td className="num">{r.carry || "—"}</td>
                    <td className="num">{r.pay || "—"}</td>
                    <td className="num">{r.lapse || "—"}</td>
                    <td className="num">{r.amount ? `₹${r.amount.toLocaleString("en-IN")}` : "—"}</td>
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

async function AccrualTab({ tenantId, fyStartMonth }: { tenantId: string; fyStartMonth: number }) {
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
