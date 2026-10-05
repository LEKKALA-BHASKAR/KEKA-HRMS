import Link from "next/link";
import { prisma } from "@keka/db";
import { resolveTimePolicy, localDateKey } from "@keka/services";
import { fyStartYear } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/keka";
import { AttendanceRequestForm } from "../../_time/attendance-forms";
import {
  DAY, keyOf, fromKey, addDays, hm, clock12, dayLabel, monthShort, figures, loadDays,
  REQUEST_LABEL, type Day,
} from "./_lib";
import { ClockPanel, TodayProgress } from "./_parts/live";
import { AttendanceStats, type StatPeriod } from "./_parts/stats";
import { HourFormatScope, HourToggle } from "./_parts/hours";
import { UrlModal } from "./_parts/overlay";
import { LogTable, type RequestOption } from "./_parts/log";
import { MonthCalendar } from "./_parts/calendar";
import { RequestsPanel, type RequestRow } from "./_parts/requests";
import { PolicyDetails } from "./_parts/policy";
import { KioskPinForm } from "../../_time/depth-forms";
import { BreaksPanel } from "./_parts/breaks";
import { reasonCodes } from "@keka/services";
import s from "./attendance.module.css";

export const metadata = { title: "My Attendance — BooS-HR" };

type Params = { view?: string; range?: string; month?: string; type?: string; request?: string; date?: string; policy?: string; kiosk?: string };

const REQUEST_ALIASES: Record<string, string> = {
  WFH: "WORK_FROM_HOME", WORK_FROM_HOME: "WORK_FROM_HOME",
  OD: "ON_DUTY", ON_DUTY: "ON_DUTY",
  ADJUSTMENT: "ADJUSTMENT", ADJUST: "ADJUSTMENT",
  REGULARISATION: "REGULARISATION", REGULARIZATION: "REGULARISATION", REGULARISE: "REGULARISATION", REG: "REGULARISATION",
  PARTIAL: "PARTIAL_DAY", PARTIAL_DAY: "PARTIAL_DAY",
};

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const mKey = (d: Date) => d.toISOString().slice(0, 7);
const parseMonthKey = (k?: string) => (k && /^\d{4}-(0[1-9]|1[0-2])$/.test(k) ? new Date(`${k}-01T00:00:00Z`) : null);
const LETTER = ["M", "T", "W", "T", "F", "S", "S"];

/** Repeated query parameters arrive as arrays; only the first counts. */
const firstOf = (raw: Record<string, string | string[] | undefined>): Params =>
  Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Params;

export default async function MyAttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState title="No employee record">This login is not linked to an employee record, so there is no attendance to show.</EmptyState>;
  }
  const sp = firstOf(await searchParams);
  const employeeId = viewer.employee.id;
  const tenantId = viewer.tenantId;
  const now = new Date();

  const [policy, me] = await Promise.all([
    resolveTimePolicy(employeeId, now),
    prisma.employee.findFirstOrThrow({
      where: { id: employeeId, tenantId },
      select: { dateOfJoining: true, reportingManagerId: true },
    }),
  ]);
  const tz = policy.tzOffset;
  const todayKey = localDateKey(now, tz);
  const today = fromKey(todayKey);
  const yesterday = addDays(today, -1);
  const joined = fromKey(keyOf(me.dateOfJoining));
  const thisMonth = monthStart(today);

  // --- URL state ------------------------------------------------------------
  const view = sp.view === "calendar" || sp.view === "requests" ? sp.view : "log";
  const href = (patch: Partial<Record<keyof Params, string | null>>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) q.set(k, v);
    const qs = q.toString();
    return `/me/attendance${qs ? `?${qs}` : ""}`;
  };

  // Month pills: the previous month back to the start of the financial year
  // (or six months when the year has just begun), never before joining.
  const fyStart = new Date(Date.UTC(fyStartYear(today, viewer.tenant.fyStartMonth), viewer.tenant.fyStartMonth - 1, 1));
  const floor = fyStart.getTime() < thisMonth.getTime() ? fyStart : addMonths(thisMonth, -6);
  const pills: Date[] = [];
  for (let m = addMonths(thisMonth, -1); m.getTime() >= floor.getTime() && m.getTime() >= monthStart(joined).getTime() && pills.length < 12; m = addMonths(m, -1)) pills.push(m);
  const rangeMonth = pills.find((m) => mKey(m) === sp.range) ?? null;
  const logFrom = new Date(Math.max(rangeMonth ? rangeMonth.getTime() : addDays(today, -29).getTime(), joined.getTime()));
  const logTo = rangeMonth ? monthEnd(rangeMonth) : today;

  const calRequested = parseMonthKey(sp.month);
  const calMonth = calRequested && calRequested.getTime() <= addMonths(thisMonth, 1).getTime() && calRequested.getTime() >= monthStart(joined).getTime()
    ? calRequested : thisMonth;

  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  const sunday = addDays(monday, 6);

  // Load only the days the current view needs, plus this week.
  const ranges: Array<[Date, Date]> = [[monday, sunday]];
  if (view === "log") ranges.push([logFrom, logTo]);
  if (view === "calendar") ranges.push([calMonth, monthEnd(calMonth)]);
  const loadFrom = new Date(Math.min(...ranges.map(([a]) => a.getTime())));
  const loadTo = new Date(Math.max(...ranges.map(([, b]) => b.getTime())));

  // --- Team for the stats ---------------------------------------------------
  const active = { notIn: ["EXITED", "PREBOARDING"] as Array<"EXITED" | "PREBOARDING"> };
  const directIds = [...viewer.directReportIds];
  const team = directIds.length > 0
    ? await prisma.employee.findMany({ where: { tenantId, id: { in: directIds }, status: active }, select: { id: true } })
    : me.reportingManagerId
      ? await prisma.employee.findMany({ where: { tenantId, reportingManagerId: me.reportingManagerId, id: { not: employeeId }, status: active }, select: { id: true } })
      : [];
  const teamIds = team.map((t) => t.id);
  const teamNote = teamIds.length === 0
    ? "No team to compare with — you have no manager or reports on record."
    : directIds.length > 0
      ? `Your ${teamIds.length} direct report${teamIds.length === 1 ? "" : "s"}, combined.`
      : `${teamIds.length} colleague${teamIds.length === 1 ? "" : "s"} who share your manager, combined.`;

  const lastWeekFrom = addDays(monday, -7), lastWeekTo = addDays(monday, -1);
  const lastMonthFrom = addMonths(thisMonth, -1), lastMonthTo = addDays(thisMonth, -1);
  const statsFrom = new Date(Math.min(lastWeekFrom.getTime(), lastMonthFrom.getTime()));
  const statSelect = { date: true, status: true, firstIn: true, effectiveHours: true, remark: true } as const;

  const shiftRow = policy.defaultShiftId
    ? await prisma.shift.findFirst({ where: { id: policy.defaultShiftId, tenantId }, select: { name: true } })
    : null;

  const [days, myStatRows, teamStatRows, requestRows] = await Promise.all([
    loadDays({
      employeeId, tenantId, policy, defaultShiftName: shiftRow?.name ?? "General", from: loadFrom, to: loadTo,
      today, now,
    }),
    prisma.attendanceRecord.findMany({ where: { tenantId, employeeId, date: { gte: statsFrom, lte: yesterday } }, select: statSelect }),
    teamIds.length > 0
      ? prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: teamIds }, date: { gte: statsFrom, lte: yesterday } }, select: statSelect })
      : Promise.resolve([]),
    prisma.attendanceRequest.findMany({ where: { tenantId, employeeId }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  const period = (key: string, label: string, from: Date, to: Date): StatPeriod => ({
    key, label,
    range: to.getTime() < from.getTime() ? `${label}: no completed days yet` : `${label}: ${dayLabel(from)} – ${dayLabel(to)}`,
    me: figures(myStatRows, from, to),
    team: teamIds.length > 0 ? figures(teamStatRows, from, to) : null,
  });
  const periods = [
    period("week", "Last Week", lastWeekFrom, lastWeekTo),
    period("month", "This Month", thisMonth, yesterday),
    period("lastmonth", "Last Month", lastMonthFrom, lastMonthTo),
  ];

  // --- Today ---------------------------------------------------------------
  const todayDay = days.get(todayKey)!;
  const closedToday = todayDay.segments.reduce((sum, [a, b]) => sum + (b - a), 0);
  const dayBase = today.getTime() - tz * 60_000;
  const openSince = todayDay.open ? new Date(dayBase + todayDay.open[0] * 60_000).toISOString() : null;
  const gaps = todayDay.segments.slice(1).reduce((sum, [a], i) => sum + Math.max(0, a - todayDay.segments[i][1]), 0)
    + (todayDay.open && todayDay.segments.length ? Math.max(0, todayDay.open[0] - todayDay.segments[todayDay.segments.length - 1][1]) : 0);
  const sh = todayDay.shift;
  const todayLabel = todayDay.kind === "HOLIDAY" ? `Today (Holiday${todayDay.holidayName ? ` · ${todayDay.holidayName}` : ""})`
    : todayDay.kind === "WEEKLY_OFF" ? "Today (Weekly off)"
    : todayDay.tint === "leave" ? `Today (${todayDay.leaveName ?? "On leave"})`
    : sh.flexible ? `Today (Flexible · ${hm(sh.required)})`
    : `Today (${clock12(sh.start)} - ${clock12(sh.end)})`;

  const week = Array.from({ length: 7 }, (_, i) => days.get(keyOf(addDays(monday, i)))!);

  // --- Log -----------------------------------------------------------------
  const logDays: Day[] = [];
  for (let d = logTo; d.getTime() >= logFrom.getTime(); d = addDays(d, -1)) {
    const day = days.get(keyOf(d));
    if (day && !day.isFuture) logDays.push(day);
  }
  const shown = view === "log" ? logDays : [];
  const starts = shown.flatMap((d) => [...d.segments.map(([a]) => a), ...(d.open ? [d.open[0]] : []), ...(d.shift.flexible ? [] : [d.shift.start])]);
  const ends = shown.flatMap((d) => [...d.segments.map(([, b]) => b), ...(d.open ? [d.open[1]] : []), ...(d.shift.flexible ? [] : [d.shift.end])]);
  // A wide window, like Keka's: hour ticks either side of the working day.
  const w0 = Math.max(0, Math.floor(Math.min(sh.start, ...starts) / 60) * 60 - 180);
  const w1 = Math.min(2880, Math.max(w0 + 1080, Math.ceil(Math.max(sh.end, ...ends) / 60) * 60 + 120));

  const regWindow = policy.regularisationWindowDays;
  const optionsFor = (d: Day): RequestOption[] => {
    if (d.isFuture && d.kind !== "WORKING") return [];
    const age = Math.round((today.getTime() - d.date.getTime()) / DAY);
    const correctable = !d.isFuture && age <= regWindow;
    const off = d.kind === "WEEKLY_OFF" || d.kind === "HOLIDAY";
    const list: Array<[string, string]> = [];
    if (correctable) list.push(["ADJUSTMENT", d.punches.length ? "Correct punches (adjustment)" : "Add punches (adjustment)"]);
    if (correctable && !off && (d.flag === "warn" || d.message?.tone === "danger")) list.push(["REGULARISATION", "Regularise this day"]);
    if (!off && !d.punches.length && d.tint !== "leave") list.push(["WORK_FROM_HOME", "Work from home"]);
    if (!d.punches.length && d.tint !== "leave") list.push(["ON_DUTY", "On duty"]);
    if (!off && d.tint !== "leave") list.push(["PARTIAL_DAY", "Partial day"]);
    return list
      .filter(([type]) => !d.pendingTypes.includes(type))
      .map(([type, label]) => ({ label, href: href({ request: type, date: d.key }) }));
  };

  // --- Calendar --------------------------------------------------------------
  const calDays: Array<Day | null> = [];
  if (view === "calendar") {
    for (let d = calMonth; d.getTime() <= monthEnd(calMonth).getTime(); d = addDays(d, 1)) {
      calDays.push(d.getTime() < joined.getTime() ? null : days.get(keyOf(d)) ?? null);
    }
  }
  const calLabel = `${calMonth.toLocaleString("en-IN", { month: "long", timeZone: "UTC" })} ${calMonth.getUTCFullYear()}`;
  const prevCal = addMonths(calMonth, -1), nextCal = addMonths(calMonth, 1);

  // --- Requests ------------------------------------------------------------
  const deciderIds = [...new Set(requestRows.map((r) => r.decidedBy).filter((x): x is string => !!x))];
  const deciders = deciderIds.length
    ? await prisma.employee.findMany({ where: { tenantId, id: { in: deciderIds } }, select: { id: true, displayName: true, firstName: true, lastName: true } })
    : [];
  const deciderName = new Map(deciders.map((e) => [e.id, e.displayName ?? `${e.firstName} ${e.lastName}`]));
  const local = (d: Date) => new Date(d.getTime() + tz * 60_000);
  const localMinOf = (d: Date | null, date: Date) => (d ? (d.getTime() - (date.getTime() - tz * 60_000)) / 60_000 : null);
  const typeFilter = sp.type && REQUEST_LABEL[sp.type] ? sp.type : null;
  const counts: Record<string, number> = {};
  for (const r of requestRows) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const reqRows: RequestRow[] = requestRows.filter((r) => !typeFilter || r.type === typeFilter).map((r) => ({
    id: r.id, type: r.type, status: r.status, from: r.fromDate, to: r.toDate,
    inMin: localMinOf(r.proposedIn, r.fromDate), outMin: localMinOf(r.proposedOut, r.fromDate),
    partialMinutes: r.partialMinutes, reason: r.reason, createdAt: local(r.createdAt),
    decidedBy: r.decidedBy ? deciderName.get(r.decidedBy) ?? null : null,
    decidedAt: r.decidedAt ? local(r.decidedAt) : null, decisionNote: r.decisionNote,
  }));
  const pendingCount = requestRows.filter((r) => r.status === "PENDING").length;

  // --- Modals ----------------------------------------------------------------
  const requestType = sp.request ? REQUEST_ALIASES[sp.request.toUpperCase()] : undefined;
  const pastOnly = requestType === "ADJUSTMENT" || requestType === "REGULARISATION";
  const requestDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : keyOf(pastOnly ? yesterday : today);

  return (
    <>
      <div className={s.top}>
        <section className={s.col} aria-labelledby="att-stats">
          <h2 id="att-stats" className={s.colTitle}>Attendance Stats</h2>
          <div className={s.box}>
            <AttendanceStats
              periods={periods}
              meAvatar={<Avatar name={viewer.employee.displayName} photoUrl={viewer.employee.photoUrl} size={32} />}
              teamLabel="My Team"
              teamNote={teamNote}
            />
          </div>
        </section>

        <section className={s.col} aria-labelledby="att-timings">
          <h2 id="att-timings" className={s.colTitle}>Timings</h2>
          <div className={s.box}>
            <div className={s.week} role="list" aria-label="This week">
              {week.map((d, i) => {
                const off = d.kind === "WEEKLY_OFF" || d.kind === "HOLIDAY";
                const what = d.kind === "HOLIDAY" ? `Holiday${d.holidayName ? ` · ${d.holidayName}` : ""}`
                  : d.kind === "WEEKLY_OFF" ? "Weekly off"
                  : d.tint === "leave" ? d.leaveName ?? "On leave"
                  : d.punches.length ? `Worked ${hm(d.effectiveMin)}` : d.isFuture ? "Working day" : d.message?.text ?? "Working day";
                return (
                  <span key={d.key} role="listitem" title={`${dayLabel(d.date)} · ${what}`} aria-label={`${dayLabel(d.date)}${d.isToday ? " (today)" : ""}: ${what}`}
                    className={`${s.dot}${off ? ` ${s.dotOff}` : ""}${d.tint === "leave" && !off ? ` ${s.dotLeave}` : ""}${d.isToday ? ` ${s.dotToday}` : ""}`}>
                    {LETTER[i]}
                  </span>
                );
              })}
            </div>
            <div className={s.timingsFoot}>
              <div className={s.todayLabel} title={`${sh.name} shift`}>{todayLabel}</div>
              <TodayProgress
                requiredMinutes={todayDay.kind === "WORKING" || todayDay.kind === "HALF_WEEKLY_OFF" ? sh.required : 0}
                closedMinutes={closedToday} openSince={openSince} label="Today's worked hours against the shift"
              />
              <div className={s.timingsMeta}>
                <span>Duration: {hm(sh.end - sh.start)}</span>
                <span className={s.breakTaken} title={`Break taken today · the shift allows ${sh.breakMinutes} min`}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" /><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16" /><path d="M8 3.5v2.5M12 3.5v2.5" />
                  </svg>
                  {Math.round(gaps)} min
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={s.col} aria-labelledby="att-actions">
          <h2 id="att-actions" className={s.colTitle}>Actions</h2>
          <div className={s.box}>
            <div className={s.actions}>
              <ClockPanel
                tzOffset={tz} clockedInSince={openSince} closedMinutes={Math.round(closedToday)}
                allowed={policy.allowWebClockIn} requireComment={policy.requireClockInComment}
                requireLocation={policy.requireGeofence} requireSelfie={policy.requireSelfie}
              />
              <nav className={s.links} aria-label="Attendance actions">
                <Link href={href({ request: "WFH", date: null })} scroll={false} className={s.link}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /><rect x="9.5" y="13" width="5" height="4" rx=".6" /></svg>
                  Work From Home
                </Link>
                <Link href={href({ request: "OD", date: null })} scroll={false} className={s.link}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" /><path d="M3 12.5h18" /></svg>
                  On Duty
                </Link>
                <Link href={href({ policy: "1" })} scroll={false} className={s.link}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7M9 7h3" /></svg>
                  Attendance Policy
                </Link>
                <Link href={href({ kiosk: "1" })} scroll={false} className={s.link}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                  Kiosk PIN
                </Link>
                <Link href="/me/work-log" className={s.link}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  Work Log
                </Link>
              </nav>
            </div>
          </div>
        </section>
      </div>

      <HourFormatScope>
        <div className={s.sectionHead}>
          <h2>Logs &amp; Requests</h2>
          <HourToggle />
        </div>
        <nav className={s.tabs} aria-label="Logs and requests">
          {([["log", "Attendance Log"], ["calendar", "Calendar"], ["requests", "Attendance Requests"]] as const).map(([v, label]) => (
            <Link key={v} href={href({ view: v === "log" ? null : v, type: null })} scroll={false}
              className={`${s.tab}${view === v ? ` ${s.tabActive}` : ""}`} aria-current={view === v ? "page" : undefined}>
              {label}
              {v === "requests" && pendingCount > 0 ? <span className={s.count} title={`${pendingCount} pending`}>{pendingCount}</span> : null}
            </Link>
          ))}
        </nav>

        {view === "log" ? (
          <section className={s.panel} aria-labelledby="att-log-title">
            <div className={s.panelHead}>
              <h3 id="att-log-title" className={s.panelTitle}>
                {rangeMonth ? `${rangeMonth.toLocaleString("en-IN", { month: "long", timeZone: "UTC" })} ${rangeMonth.getUTCFullYear()}` : "Last 30 Days"}
              </h3>
              <nav className={s.pills} aria-label="Period">
                <Link href={href({ range: null })} scroll={false} className={`${s.pill}${!rangeMonth ? ` ${s.pillActive}` : ""}`} aria-current={!rangeMonth ? "true" : undefined}>
                  30 DAYS
                </Link>
                {pills.map((m) => (
                  <Link key={mKey(m)} href={href({ range: mKey(m) })} scroll={false}
                    className={`${s.pill}${rangeMonth && mKey(rangeMonth) === mKey(m) ? ` ${s.pillActive}` : ""}`}
                    aria-current={rangeMonth && mKey(rangeMonth) === mKey(m) ? "true" : undefined}
                    title={`${m.toLocaleString("en-IN", { month: "long", timeZone: "UTC" })} ${m.getUTCFullYear()}`}>
                    {monthShort(m.getUTCMonth()).toUpperCase()}
                  </Link>
                ))}
              </nav>
            </div>
            <LogTable days={logDays} window={[w0, w1]} optionsFor={optionsFor} />
          </section>
        ) : view === "calendar" ? (
          <MonthCalendar
            label={calLabel}
            days={calDays}
            firstDow={(calMonth.getUTCDay() + 6) % 7}
            prevHref={prevCal.getTime() >= monthStart(joined).getTime() ? href({ month: mKey(prevCal) }) : null}
            nextHref={nextCal.getTime() <= addMonths(thisMonth, 1).getTime() ? href({ month: mKey(nextCal) }) : null}
          />
        ) : (
          <RequestsPanel
            rows={reqRows}
            counts={counts}
            active={typeFilter}
            filterHref={(t) => href({ type: t })}
            newHref={href({ request: "ADJUSTMENT", date: null })}
          />
        )}

        {requestType ? (
          <UrlModal
            title={`Request ${REQUEST_LABEL[requestType]}`}
            subtitle={pastOnly
              ? `Corrections can go back ${regWindow} days and need your manager's approval.`
              : "Your manager approves the request; the day is then counted as attended."}
            closeHref={href({ request: null, date: null })}
            width={560}
          >
            <AttendanceRequestForm key={`${requestType}:${requestDate}`} defaultType={requestType} defaultDate={requestDate} reasons={(await reasonCodes(tenantId, "REGULARISATION", true)).map((c) => ({ value: c.code, label: c.label }))} />
          </UrlModal>
        ) : null}
      </HourFormatScope>

      <BreaksPanel tenantId={tenantId} employeeId={employeeId} />

      {sp.policy ? (
        <UrlModal title="Attendance Policy" subtitle="The rules your attendance is judged against" closeHref={href({ policy: null })} width={760}>
          <PolicyDetails tenantId={tenantId} employeeId={employeeId} policy={policy} shift={sh} year={today.getUTCFullYear()} />
        </UrlModal>
      ) : null}

      {sp.kiosk ? (
        <UrlModal title="Kiosk PIN" subtitle="Clock in at an office kiosk with your employee number and this PIN" closeHref={href({ kiosk: null })} width={480}>
          <KioskPinForm hasPin={!!(await prisma.kioskPin.findUnique({ where: { employeeId }, select: { id: true } }))} />
        </UrlModal>
      ) : null}
    </>
  );
}
