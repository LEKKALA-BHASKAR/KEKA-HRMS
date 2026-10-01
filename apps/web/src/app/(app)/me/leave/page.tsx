import Link from "next/link";
import { prisma } from "@keka/db";
import { leaveYearStart, localDateKey, tzOffsetMinutes } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";
import { Ring, Donut, Bars, EmptyState } from "@/components/keka";
import { ApplyLeaveForm, CancelLeaveButton } from "../../_time/leave-forms";
import { UrlModal, InfoTip } from "../attendance/_parts/overlay";
import {
  num, r2, keyOf, dateLabel, daysLabel, daysLower, yearEnd, shiftYears, yearLabel, colourFor, fromLedger, monthName,
} from "./_lib";
import { LeaveHistory, type HistoryRow } from "./_parts/history";
import { YearSelect } from "./_parts/year-select";
import { PolicyExplanation, EncashmentInfo, CompOffInfo, BalanceDetails, type CatalogueType } from "./_parts/modals";
import s from "./leave.module.css";

export const metadata = { title: "My Leave — Keka" };

type Params = { year?: string; apply?: string; policy?: string; encash?: string; compoff?: string; details?: string };

const TABS = [{ label: "Summary", href: "/me/leave" }];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CARD_CATEGORIES = new Set(["REGULAR", "COMP_OFF", "UNPAID"]);

/** Repeated query parameters arrive as arrays; only the first counts. */
const firstOf = (raw: Record<string, string | string[] | undefined>): Params =>
  Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Params;

export default async function MyLeavePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return (
      <>
        <SubTabs items={TABS} />
        <EmptyState title="No employee record">This login is not linked to an employee record, so there is no leave to show.</EmptyState>
      </>
    );
  }
  const sp = firstOf(await searchParams);
  const employeeId = viewer.employee.id;
  const tenantId = viewer.tenantId;
  const now = new Date();

  const planInclude = { plan: { include: { types: { include: { leaveType: true } } } } } as const;
  const [emp, current, requests] = await Promise.all([
    prisma.employee.findFirstOrThrow({
      where: { id: employeeId, tenantId },
      select: { dateOfJoining: true, location: { select: { timezone: true } } },
    }),
    prisma.leavePlanAssignment.findFirst({
      where: { employeeId, plan: { tenantId }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      orderBy: { effectiveFrom: "desc" },
      include: planInclude,
    }),
    prisma.leaveRequest.findMany({
      where: { tenantId, employeeId },
      include: { leaveType: { select: { id: true, name: true, unit: true } } },
      orderBy: [{ fromDate: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  // The same fallback the leave services use: the latest assignment, if none is current.
  const assignment = current ?? await prisma.leavePlanAssignment.findFirst({
    where: { employeeId, plan: { tenantId } }, orderBy: { effectiveFrom: "desc" }, include: planInclude,
  });
  const plan = assignment?.plan ?? null;
  const tz = tzOffsetMinutes(emp.location?.timezone ?? "Asia/Kolkata", now);
  const today = new Date(`${localDateKey(now, tz)}T00:00:00Z`);
  const local = (d: Date) => new Date(d.getTime() + tz * 60_000);

  // --- Leave year ------------------------------------------------------------
  const basis = plan?.yearBasis ?? "FINANCIAL_APR";
  const currentStart = leaveYearStart(today, basis, emp.dateOfJoining);
  const starts: Date[] = [];
  const nextStart = shiftYears(currentStart, 1);
  if (requests.some((r) => r.fromDate.getTime() >= nextStart.getTime())) starts.push(nextStart);
  for (let k = 0; k < 5; k++) {
    const st = shiftYears(currentStart, -k);
    if (k > 0 && yearEnd(st).getTime() < emp.dateOfJoining.getTime()) break;
    starts.push(st);
  }
  const ys = starts.find((st) => keyOf(st) === sp.year) ?? currentStart;
  const ye = yearEnd(ys);
  const isCurrentYear = ys.getTime() === currentStart.getTime();

  const href = (patch: Partial<Record<keyof Params, string | null>>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) q.set(k, v);
    const qs = q.toString();
    return `/me/leave${qs ? `?${qs}` : ""}`;
  };

  const inYear = (d: Date) => d.getTime() >= ys.getTime() && d.getTime() <= ye.getTime();
  const yearRequests = requests.filter((r) => inYear(r.fromDate));

  const [ledger, balances, takenDays, audits] = await Promise.all([
    prisma.leaveLedgerEntry.findMany({ where: { tenantId, employeeId, yearStart: ys }, orderBy: { createdAt: "asc" } }),
    prisma.leaveBalance.findMany({ where: { employeeId, yearStart: ys, leaveType: { tenantId } }, include: { leaveType: true } }),
    prisma.leaveRequestDay.findMany({
      where: { date: { gte: ys, lte: ye }, request: { tenantId, employeeId, status: "APPROVED" } },
      select: { date: true, dayValue: true, request: { select: { leaveTypeId: true } } },
    }),
    yearRequests.length
      ? prisma.auditLog.findMany({
          where: { tenantId, entityType: "LeaveRequest", entityId: { in: yearRequests.map((r) => r.id) } },
          select: { entityId: true, action: true, actorId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // --- Leave types: the plan's, plus any with history this year -------------
  type LT = (typeof balances)[number]["leaveType"];
  const catalogue: Array<{ t: LT; quota: number }> = plan && plan.types.length > 0
    ? plan.types.map((pt) => ({ t: pt.leaveType, quota: num(pt.quotaOverride ?? pt.leaveType.annualQuota) }))
    : (await prisma.leaveType.findMany({ where: { tenantId, isActive: true } })).map((t) => ({ t, quota: num(t.annualQuota) }));
  for (const b of balances) if (!catalogue.some((c) => c.t.id === b.leaveTypeId)) catalogue.push({ t: b.leaveType, quota: num(b.leaveType.annualQuota) });
  const missing = [...new Set([...yearRequests.map((r) => r.leaveTypeId), ...ledger.map((l) => l.leaveTypeId)])].filter((id) => !catalogue.some((c) => c.t.id === id));
  if (missing.length) {
    for (const t of await prisma.leaveType.findMany({ where: { tenantId, id: { in: missing } } })) catalogue.push({ t, quota: num(t.annualQuota) });
  }
  catalogue.sort((a, b) => a.t.name.localeCompare(b.t.name));

  const entriesBy = new Map<string, typeof ledger>();
  for (const e of ledger) entriesBy.set(e.leaveTypeId, [...(entriesBy.get(e.leaveTypeId) ?? []), e]);
  const takenBy = new Map<string, number>();
  for (const d of takenDays) takenBy.set(d.request.leaveTypeId, (takenBy.get(d.request.leaveTypeId) ?? 0) + num(d.dayValue));
  const pendingBy = new Map<string, number>();
  for (const r of yearRequests) if (r.status === "PENDING") pendingBy.set(r.leaveTypeId, (pendingBy.get(r.leaveTypeId) ?? 0) + num(r.totalDays));

  const types = catalogue.map(({ t, quota }, i) => {
    const unlimited = t.isUnlimited || t.category === "UNPAID";
    const incident = t.category === "INCIDENT";
    const entries = entriesBy.get(t.id) ?? [];
    const bal = balances.find((b) => b.leaveTypeId === t.id);
    const f = entries.length > 0 ? fromLedger(entries)
      : bal ? { credited: r2(num(bal.opening) + num(bal.accrued) + num(bal.carriedForward)), consumed: num(bal.used), available: num(bal.available), encashed: 0, lapsed: 0 }
      : { credited: 0, consumed: 0, available: 0, encashed: 0, lapsed: 0 };
    const consumed = unlimited || incident ? r2(takenBy.get(t.id) ?? 0) : f.consumed;
    const pending = r2(pendingBy.get(t.id) ?? 0);
    const activity = entries.length > 0 || !!bal || takenBy.has(t.id) || pending > 0;
    return {
      t, quota, unlimited, incident, colour: colourFor(i, t.color), entries,
      credited: f.credited, consumed, available: unlimited ? null : incident ? null : f.available, pending, activity,
    };
  });
  const visible = types.filter((x) => (x.t.isActive && !x.t.isHiddenFromEmployee) || x.activity);
  const cards = visible
    .filter((x) => (CARD_CATEGORIES.has(x.t.category) && (!x.t.isHiddenFromEmployee || x.activity)) || (x.activity && (x.credited > 0 || x.consumed > 0 || x.pending > 0)))
    .sort((a, b) => Number(a.t.category === "UNPAID") - Number(b.t.category === "UNPAID") || a.t.name.localeCompare(b.t.name));
  const others = visible.filter((x) => !cards.includes(x) && x.t.isActive && !x.t.isHiddenFromEmployee);

  const toCatalogue = (x: (typeof types)[number]): CatalogueType => ({
    id: x.t.id, name: x.t.name, code: x.t.code, colour: x.colour, quota: x.quota, unlimited: x.unlimited,
    rules: x.t, encashmentFormula: x.t.encashmentFormula, available: x.available,
  });
  const applicable = types.filter((x) => x.t.isActive && !x.t.isHiddenFromEmployee);

  // --- Stats ---------------------------------------------------------------
  const weekly = WEEK.map((label) => ({ label, value: 0 }));
  const monthly = Array.from({ length: 12 }, (_, i) => ({ label: monthName((ys.getUTCMonth() + i) % 12), value: 0 }));
  for (const d of takenDays) {
    weekly[(d.date.getUTCDay() + 6) % 7].value += num(d.dayValue);
    const idx = (d.date.getUTCFullYear() - ys.getUTCFullYear()) * 12 + d.date.getUTCMonth() - ys.getUTCMonth();
    if (idx >= 0 && idx < 12) monthly[idx].value += num(d.dayValue);
  }
  const consumedParts = types
    .filter((x) => (takenBy.get(x.t.id) ?? 0) > 0)
    .map((x) => ({ label: x.t.name, value: r2(takenBy.get(x.t.id) ?? 0), colour: x.colour }));
  const totalTaken = r2(consumedParts.reduce((a, p) => a + p.value, 0));

  // --- History ---------------------------------------------------------------
  const actorIds = [...new Set(audits.map((a) => a.actorId).filter((x): x is string => !!x))];
  // Approver, canceller and requester are employee ids recorded on the request.
  const approverIds = [...new Set(yearRequests.flatMap((r) => [r.approvedBy, r.cancelledBy, r.requestedBy]).filter((x): x is string => !!x))];
  const [actors, approvers] = await Promise.all([
    actorIds.length
      ? prisma.user.findMany({ where: { tenantId, id: { in: actorIds } }, select: { id: true, email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } } })
      : Promise.resolve([]),
    approverIds.length
      ? prisma.employee.findMany({ where: { tenantId, id: { in: approverIds } }, select: { id: true, displayName: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
  ]);
  const nameOf = (e: { displayName: string | null; firstName: string; lastName: string }) => e.displayName ?? `${e.firstName} ${e.lastName}`;
  const actorName = new Map(actors.map((u) => [u.id, u.employee ? nameOf(u.employee) : u.email]));
  const approverName = new Map(approvers.map((e) => [e.id, nameOf(e)]));
  const me = viewer.employee.displayName;
  const portionNote = (p: string) => (p === "FIRST_HALF" ? "First half" : p === "SECOND_HALF" ? "Second half" : p === "QUARTER" ? "Quarter day" : null);
  const rangeLabel = (from: Date, to: Date) => from.getTime() === to.getTime() ? dateLabel(from)
    : from.getUTCFullYear() === to.getUTCFullYear()
      ? `${dateLabel(from).slice(0, 6)} - ${dateLabel(to)}`
      : `${dateLabel(from)} - ${dateLabel(to)}`;

  const historyRows: HistoryRow[] = yearRequests.map((r) => {
    const trail = audits.filter((a) => a.entityId === r.id);
    const created = trail.find((a) => a.action === "CREATE");
    const closed = [...trail].reverse().find((a) => a.action === "UPDATE");
    const cancelledOrWithdrawn = r.status === "CANCELLED" || r.status === "WITHDRAWN";
    const by = r.status === "APPROVED" || r.status === "REJECTED"
      ? (r.approvedBy ? approverName.get(r.approvedBy) ?? null : null)
      : cancelledOrWithdrawn
        ? (r.cancelledBy ? approverName.get(r.cancelledBy) ?? null : closed?.actorId ? actorName.get(closed.actorId) ?? null : r.status === "WITHDRAWN" ? me : null)
        : null;
    const actionAt = r.status === "APPROVED" || r.status === "REJECTED" ? r.approvedAt
      : cancelledOrWithdrawn ? r.cancelledAt ?? closed?.createdAt ?? r.updatedAt : null;
    const single = r.fromDate.getTime() === r.toDate.getTime();
    const portion = single ? portionNote(r.fromPortion) : null;
    return {
      id: r.id,
      dates: rangeLabel(r.fromDate, r.toDate),
      days: `${daysLabel(num(r.totalDays), r.leaveType.unit)}${portion ? ` · ${portion}` : ""}`,
      sortKey: keyOf(r.fromDate),
      typeId: r.leaveTypeId,
      typeName: r.leaveType.name,
      requestedOn: dateLabel(local(r.createdAt)),
      status: r.status,
      statusLabel: r.status.charAt(0) + r.status.slice(1).toLowerCase(),
      by,
      requestedBy: r.requestedBy ? approverName.get(r.requestedBy) ?? me : created?.actorId ? actorName.get(created.actorId) ?? me : me,
      actionOn: actionAt ? dateLabel(local(actionAt)) : null,
      note: r.reason,
      reason: r.rejectReason,
      sandwich: num(r.sandwichDays) > 0 ? `incl. ${r2(num(r.sandwichDays))} sandwich` : null,
      cancel: r.status === "PENDING" ? "Withdraw" : r.status === "APPROVED" && r.fromDate.getTime() > today.getTime() ? "Cancel" : null,
    };
  });
  const pending = requests.filter((r) => r.status === "PENDING").sort((a, b) => a.fromDate.getTime() - b.fromDate.getTime());
  const detailsHref = Object.fromEntries(cards.map((c) => [c.t.id, href({ details: c.t.id })]));

  // --- Modal data --------------------------------------------------------------
  const detailType = sp.details ? types.find((x) => x.t.id === sp.details) : undefined;
  const compOffDays = sp.compoff
    ? await prisma.attendanceRecord.findMany({
        where: { tenantId, employeeId, date: { gte: ys, lte: new Date(Math.min(ye.getTime(), today.getTime())) }, status: { in: ["WEEKLY_OFF", "HOLIDAY"] }, effectiveHours: { gt: 0 } },
        orderBy: { date: "desc" }, select: { date: true, status: true, effectiveHours: true },
      })
    : [];

  return (
    <>
      <SubTabs items={TABS} />

      <div className={s.headRow}>
        <h2 className={s.h2}>Pending leave requests</h2>
        <YearSelect
          value={keyOf(ys)}
          options={starts.map((st) => ({ value: keyOf(st), label: yearLabel(st), href: href({ year: st.getTime() === currentStart.getTime() ? null : keyOf(st) }) }))}
        />
      </div>

      <div className={s.pendingGrid}>
        <section className={`${s.box} ${s.pendingBox}`} aria-label="Pending leave requests">
          {pending.length === 0 ? (
            <div className={s.hurray}>
              <span className={s.hurrayIcon} aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20 9.5 7.5l7 7z" /><path d="M7.2 12.8 11 16.6M5.8 16.2l2 2" /><path d="M14 4.5c.5 1.4 0 2.6-1.2 3.2" /><path d="M19.5 10c-1.4-.5-2.6 0-3.2 1.2" /><path d="M17 3.5v1.6M20.5 6.5h-1.6M15.5 8.5l1.3-1.3" />
                </svg>
              </span>
              <div>
                <div className={s.hurrayTitle}>Hurray! No pending leave requests</div>
                <div className={s.hurraySub}>Request leave on the right!</div>
              </div>
            </div>
          ) : (
            <ul className={s.pendingList}>
              {pending.map((r) => {
                const colour = types.find((x) => x.t.id === r.leaveTypeId)?.colour ?? "var(--text-subtle)";
                return (
                  <li key={r.id} className={s.pendingItem}>
                    <div>
                      <div className={s.pendingWhat}>
                        <span className={s.dotType} style={{ background: colour }} aria-hidden="true" />
                        {r.leaveType.name} · {rangeLabel(r.fromDate, r.toDate)} <span className="muted">({daysLabel(num(r.totalDays), r.leaveType.unit)})</span>
                      </div>
                      <div className={s.pendingMeta}>
                        Requested on {dateLabel(local(r.createdAt))} · awaiting approval{r.reason ? ` · “${r.reason}”` : ""}
                      </div>
                    </div>
                    <CancelLeaveButton requestId={r.id} label="Withdraw" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className={`${s.box} ${s.actionBox}`} aria-label="Leave actions">
          <Link href={href({ apply: "1" })} scroll={false} className={s.requestBtn}>Request Leave</Link>
          <Link href={href({ encash: "1" })} scroll={false} className={s.actLink}>Request Leave Encashment</Link>
          <Link href={href({ compoff: "1" })} scroll={false} className={s.actLink}>Request Credit for Compensatory Off</Link>
          <Link href={href({ policy: "1" })} scroll={false} className={s.actLink}>Leave Policy Explanation</Link>
        </aside>
      </div>

      <h2 className={`${s.h2} ${s.section}`}>My Leave Stats</h2>
      <div className={s.statsGrid}>
        <section className={`${s.box} ${s.card}`} aria-label="Weekly pattern">
          <div className={s.cardHead}>
            <h3 className={s.cardTitle}>Weekly Pattern</h3>
            <InfoTip text={`Approved leave days taken in ${yearLabel(ys)}, by day of the week.`} />
          </div>
          <Bars data={weekly.map((w) => ({ ...w, title: `${w.label}: ${r2(w.value)} day(s)` }))} height={62} colour="#8f7ad8" />
        </section>
        <section className={`${s.box} ${s.card}`} aria-label="Consumed leave types">
          <div className={s.cardHead}>
            <h3 className={s.cardTitle}>Consumed Leave Types</h3>
            <InfoTip text={`Approved leave days in ${yearLabel(ys)}, split by leave type.`} />
          </div>
          <div className={s.donutWrap}>
            <Donut parts={consumedParts} size={104} stroke={14}>
              <span style={{ fontSize: 12.5 }}>{totalTaken > 0 ? <>{totalTaken}<br />days</> : <>Leave<br />Types</>}</span>
            </Donut>
            {consumedParts.length > 0 ? (
              <ul className={s.legend}>
                {consumedParts.map((p) => (
                  <li key={p.label}><span className={s.swatch} style={{ background: p.colour }} aria-hidden="true" />{p.label} <strong>{p.value}</strong></li>
                ))}
              </ul>
            ) : null}
          </div>
          {consumedParts.length === 0 ? <div className={s.chartNote}>No leave taken in this leave year.</div> : null}
        </section>
        <section className={`${s.box} ${s.card}`} aria-label="Monthly stats">
          <div className={s.cardHead}>
            <h3 className={s.cardTitle}>Monthly Stats</h3>
            <InfoTip text={`Approved leave days per month of the leave year ${yearLabel(ys)}.`} />
          </div>
          <Bars data={monthly.map((m) => ({ ...m, title: `${m.label}: ${r2(m.value)} day(s)` }))} height={62} colour="#8f7ad8" />
        </section>
      </div>

      <h2 className={`${s.h2} ${s.section}`}>Leave Balances</h2>
      {cards.length === 0 ? (
        <div className={s.box}>
          <EmptyState title="No leave balances">You aren&apos;t on a leave plan with any balances yet. Ask HR to assign one.</EmptyState>
        </div>
      ) : (
        <div className={s.balances}>
          {cards.map((x) => {
            const unit = x.t.unit;
            const showAccrued = !x.unlimited && x.t.accrualFrequency !== "UPFRONT" && x.t.category !== "COMP_OFF";
            const noData = !x.unlimited && x.credited <= 0 && x.consumed <= 0 && (x.available ?? 0) === 0;
            const avail = x.available ?? 0;
            return (
              <section key={x.t.id} className={`${s.box} ${s.bal}`} aria-label={`${x.t.name} balance`}>
                <div className={s.balHead}>
                  <h3 className={s.balTitle}>{x.t.name}</h3>
                  <Link href={href({ details: x.t.id })} scroll={false} className={s.viewLink} aria-label={`View ${x.t.name} details`}>View details</Link>
                </div>
                <div className={s.balRing}>
                  {noData ? <span className={s.noData}>No data to display.</span> : (
                    <Ring
                      value={x.unlimited ? 1 : Math.max(0, avail)} max={x.unlimited ? 1 : Math.max(x.credited, avail, 0.0001)}
                      size={142} stroke={18}
                      colour={x.unlimited ? `color-mix(in srgb, ${x.colour} 35%, white)` : x.colour}
                      track={`color-mix(in srgb, ${x.colour} 18%, white)`}
                    >
                      <span className={s.ringText}>
                        {x.unlimited ? "∞" : r2(avail)} {unit === "HOURS" ? "Hours" : r2(avail) === 1 && !x.unlimited ? "Day" : "Days"}<br />Available
                      </span>
                    </Ring>
                  )}
                </div>
                {x.pending > 0 ? <div className={s.balPending}>{daysLower(x.pending, unit)} awaiting approval</div> : null}
                <div className={s.cells}>
                  <div className={s.cell}><div className={s.cellLabel}>Available</div><div className={s.cellValue}>{x.unlimited ? "∞" : daysLower(avail, unit)}</div></div>
                  <div className={s.cell}><div className={s.cellLabel}>Consumed</div><div className={s.cellValue}>{daysLower(x.consumed, unit)}</div></div>
                  {showAccrued ? <div className={s.cell}><div className={s.cellLabel}>Accrued so far</div><div className={s.cellValue}>{daysLower(x.credited, unit)}</div></div> : null}
                  <div className={s.cell}><div className={s.cellLabel}>Annual quota</div><div className={s.cellValue}>{x.unlimited ? "∞" : daysLower(x.quota, unit)}</div></div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className={`${s.box} ${s.others}`}>
        <span className={s.othersLabel}>Other Leave Types Available :</span>
        <span>{others.length ? others.map((x) => x.t.name).join(", ") : <span className="subtle">None</span>}</span>
      </div>

      <h2 className={`${s.h2} ${s.section}`}>Leave History</h2>
      <LeaveHistory
        rows={historyRows}
        types={types.filter((x) => x.activity || applicable.includes(x)).map((x) => ({ value: x.t.id, label: x.t.name }))}
        detailsHref={detailsHref}
      />

      {sp.apply ? (
        <UrlModal title="Request Leave" subtitle="Check the count first — weekends, holidays and the sandwich rule are applied exactly as payroll will see them." closeHref={href({ apply: null })} width={600}>
          {applicable.length === 0 ? (
            <div className="muted">No leave types are available to you. Ask HR to assign you a leave plan.</div>
          ) : (
            <ApplyLeaveForm types={applicable.map((x) => ({
              value: x.t.id,
              label: x.unlimited ? `${x.t.name}${x.t.isPaid ? "" : " (unpaid)"}`
                : x.incident ? `${x.t.name} · up to ${x.quota} per event`
                : `${x.t.name} · ${isCurrentYear ? r2(x.available ?? 0) : "—"} available`,
              allowHalfDay: x.t.allowHalfDay,
            }))} />
          )}
        </UrlModal>
      ) : null}
      {sp.policy ? (
        <UrlModal title="Leave Policy Explanation" subtitle="How each leave type in your plan works" closeHref={href({ policy: null })} width={720}>
          <PolicyExplanation
            plan={plan ? { name: plan.name, description: plan.description, yearBasis: plan.yearBasis, effectiveFrom: assignment!.effectiveFrom } : null}
            types={applicable.map(toCatalogue)}
          />
        </UrlModal>
      ) : null}
      {sp.encash ? (
        <UrlModal title="Request Leave Encashment" closeHref={href({ encash: null })} width={560}>
          <EncashmentInfo types={applicable.map(toCatalogue)} />
        </UrlModal>
      ) : null}
      {sp.compoff ? (
        <UrlModal title="Request Credit for Compensatory Off" closeHref={href({ compoff: null })} width={560}>
          <CompOffInfo
            hasCompOff={applicable.some((x) => x.t.category === "COMP_OFF")}
            worked={compOffDays.map((d) => ({ date: d.date, status: d.status, hours: num(d.effectiveHours) }))}
          />
        </UrlModal>
      ) : null}
      {detailType ? (
        <UrlModal title={`${detailType.t.name} · ${yearLabel(ys)}`} subtitle="Every credit and debit behind this balance" closeHref={href({ details: null })} width={640}>
          <BalanceDetails
            type={toCatalogue(detailType)}
            figures={{ credited: detailType.credited, consumed: detailType.consumed, available: detailType.available, pending: detailType.pending }}
            entries={detailType.entries.map((e) => ({ ...e, createdAt: local(e.createdAt) }))}
            taken={yearRequests.filter((r) => r.leaveTypeId === detailType.t.id && (r.status === "APPROVED" || r.status === "PENDING"))
              .map((r) => ({ id: r.id, dates: rangeLabel(r.fromDate, r.toDate), days: num(r.totalDays), status: r.status.charAt(0) + r.status.slice(1).toLowerCase() }))}
          />
        </UrlModal>
      ) : null}
    </>
  );
}
