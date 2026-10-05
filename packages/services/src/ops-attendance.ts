import { prisma, type Prisma, type OpsApprovalRequest } from "@keka/db";
import { usersWithPermission } from "./lifecycle";
import { getOpsSettings, opsAudit, opsAlertOnce, opsRequestApproval, type OpsActor } from "./ops-core";
import {
  opsClassifyDay, opsLockIssue, opsDeviceHealth, opsSourceComparison, opsHeatLevel, opsReconcileMonth, opsEarlyDeparturePenalties,
  opsCutoffAlertDue, opsNextCutoff, opsCutoffDate, opsBreakOutcome, opsBreakStartIssue, opsDay, opsYmd, opsAddDays, OPS_ANOMALY_KINDS,
} from "./ops-math";

/**
 * Ops depth — attendance: lock periods (freeze and reopen), daily and
 * monthly certification, anomaly classification with notifications,
 * early-departure rules, device health, punch-source audit and comparison,
 * the reconciliation dashboard, the team heatmap, cut-off alerts and breaks.
 */

type Result = { ok: boolean; message: string };
const DAY = 86_400_000;
const TZ = 330;
const hhmm = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const atLocal = (day: Date, minutes: number) => new Date(opsDay(day).getTime() + (minutes - TZ) * 60_000);
const ACTIVE = { status: { notIn: ["EXITED", "PREBOARDING"] as never[] } };

// ---------------------------------------------------------------------------
//  Lock periods
// ---------------------------------------------------------------------------

export async function opsLockedPeriod(tenantId: string, domain: "ATTENDANCE" | "TIMESHEET", from: Date, to: Date = from) {
  return prisma.opsPeriodLock.findFirst({ where: { tenantId, domain, status: "LOCKED", periodStart: { lte: opsDay(to) }, periodEnd: { gte: opsDay(from) } } });
}

/** The message to show when a change would touch a locked period, or null. */
export async function opsLockMessage(tenantId: string, domain: "ATTENDANCE" | "TIMESHEET", from: Date, to: Date = from): Promise<string | null> {
  const l = await opsLockedPeriod(tenantId, domain, from, to);
  return l ? `${domain === "ATTENDANCE" ? "Attendance" : "Timesheets"} from ${opsYmd(l.periodStart)} to ${opsYmd(l.periodEnd)} ${l.status === "LOCKED" ? "are locked" : ""}${l.reason ? ` (${l.reason})` : ""}. Ask an administrator to reopen the period.` : null;
}

export async function lockOpsPeriod(input: { actor: OpsActor; domain: "ATTENDANCE" | "TIMESHEET"; periodStart: Date; periodEnd: Date; reason?: string | null }): Promise<Result & { id?: string }> {
  const t = input.actor.tenantId;
  const existing = await prisma.opsPeriodLock.findMany({ where: { tenantId: t, domain: input.domain, status: "LOCKED" } });
  const issue = opsLockIssue(opsDay(input.periodStart), opsDay(input.periodEnd), existing);
  if (issue) return { ok: false, message: issue };
  const l = await prisma.opsPeriodLock.create({ data: { tenantId: t, domain: input.domain, periodStart: opsDay(input.periodStart), periodEnd: opsDay(input.periodEnd), reason: input.reason ?? null, lockedBy: input.actor.userId } });
  await opsAudit(t, input.actor.userId, { module: input.domain === "ATTENDANCE" ? "ATTENDANCE" : "PROJECTS", action: "LOCK", entityType: "OpsPeriodLock", entityId: l.id, summary: `Locked ${input.domain.toLowerCase()} ${opsYmd(l.periodStart)} to ${opsYmd(l.periodEnd)}${input.reason ? `: ${input.reason}` : ""}` });
  return { ok: true, id: l.id, message: `Locked ${opsYmd(l.periodStart)} to ${opsYmd(l.periodEnd)}.` };
}

export async function reopenOpsPeriod(input: { actor: OpsActor; id: string; reason: string }): Promise<Result> {
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why the period is being reopened." };
  const l = await prisma.opsPeriodLock.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!l) return { ok: false, message: "Lock not found." };
  if (l.status !== "LOCKED") return { ok: false, message: "This period is already open." };
  await prisma.opsPeriodLock.update({ where: { id: l.id }, data: { status: "REOPENED", reopenedBy: input.actor.userId, reopenedAt: new Date(), reopenReason: input.reason.trim() } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: l.domain === "ATTENDANCE" ? "ATTENDANCE" : "PROJECTS", action: "UNLOCK", entityType: "OpsPeriodLock", entityId: l.id, summary: `Reopened ${l.domain.toLowerCase()} ${opsYmd(l.periodStart)} to ${opsYmd(l.periodEnd)}: ${input.reason.trim()}` });
  return { ok: true, message: "Reopened." };
}


// ---------------------------------------------------------------------------
//  Anomalies
// ---------------------------------------------------------------------------

/** Classify every employee-day in a range; new anomalies notify the employee and their manager. */
export async function runAttendanceAnomalies(tenantId: string, from: Date, to: Date, opts: { notify?: boolean; employeeIds?: string[] } = {}): Promise<{ days: number; found: number; created: number; notified: number }> {
  const settings = await getOpsSettings(tenantId);
  const records = await prisma.attendanceRecord.findMany({
    where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) }, ...(opts.employeeIds ? { employeeId: { in: opts.employeeIds } } : {}) },
    include: { logs: { where: { status: "VALID" }, select: { id: true } } },
  });
  const shifts = new Map((await prisma.shift.findMany({ where: { tenantId } })).map((s) => [s.id, s]));
  const policies = await prisma.employeeTimePolicy.findMany({ where: { employee: { tenantId } }, include: { attendancePolicy: { select: { id: true, graceMinutes: true } } }, orderBy: { effectiveFrom: "desc" } });
  const defaultPolicy = await prisma.attendancePolicy.findFirst({ where: { tenantId, isDefault: true }, select: { id: true, graceMinutes: true } });
  const rules = await prisma.opsEarlyDepartureRule.findMany({ where: { tenantId, isActive: true } });
  const policyOf = (employeeId: string, at: Date) => policies.find((p) => p.employeeId === employeeId && p.effectiveFrom <= at && (!p.effectiveTo || p.effectiveTo >= at))?.attendancePolicy ?? defaultPolicy;
  const earlyGrace = (policyId: string | null | undefined) => (rules.find((r) => r.policyKey === policyId) ?? rules.find((r) => r.policyKey === "ALL"))?.graceMinutes ?? 15;
  let found = 0, created = 0;
  const fresh = new Map<string, string[]>();
  for (const r of records) {
    const shift = r.shiftId ? shifts.get(r.shiftId) : null;
    const pol = policyOf(r.employeeId, r.date);
    const status = r.manualStatus ?? r.status;
    const start = shift && !shift.isFlexible ? atLocal(r.date, hhmm(shift.startTime)) : null;
    let end = shift && !shift.isFlexible ? atLocal(r.date, hhmm(shift.endTime)) : null;
    if (end && start && (end <= start || shift?.crossesMidnight)) end = new Date(end.getTime() + DAY);
    const shiftHours = shift ? (shift.isFlexible && shift.requiredHours ? Number(shift.requiredHours) : Math.max(0, ((end && start ? (end.getTime() - start.getTime()) / 60_000 : 0) - shift.breakMinutes) / 60)) : 0;
    const list = r.isRegularised || ["WORK_FROM_HOME", "ON_DUTY"].includes(status) ? [] : opsClassifyDay({
      status, isWorkingDay: !["WEEKLY_OFF", "HOLIDAY"].includes(status), onLeave: status === "ON_LEAVE",
      firstIn: r.firstIn, lastOut: r.lastOut, shiftStart: start, shiftEnd: end, effectiveHours: Number(r.effectiveHours), shiftHours,
      validPunches: r.logs.length, graceMinutes: pol?.graceMinutes ?? 15, earlyGraceMinutes: earlyGrace(pol?.id),
    });
    found += list.length;
    const kinds = new Set(list.map((a) => a.kind));
    // Anomalies that no longer hold (the day was regularised or reprocessed) resolve themselves.
    await prisma.opsAttendanceAnomaly.updateMany({ where: { employeeId: r.employeeId, date: r.date, status: "OPEN", kind: { notIn: [...kinds] } }, data: { status: "RESOLVED", resolvedAt: new Date(), resolution: "No longer applies after reprocessing" } });
    for (const a of list) {
      const existing = await prisma.opsAttendanceAnomaly.findUnique({ where: { employeeId_date_kind: { employeeId: r.employeeId, date: r.date, kind: a.kind } } });
      if (existing) { if (existing.status === "OPEN") await prisma.opsAttendanceAnomaly.update({ where: { id: existing.id }, data: { detail: a.detail, severity: a.severity } }); continue; }
      await prisma.opsAttendanceAnomaly.create({ data: { tenantId, employeeId: r.employeeId, date: r.date, kind: a.kind, severity: a.severity, detail: a.detail } });
      created++;
      fresh.set(r.employeeId, [...(fresh.get(r.employeeId) ?? []), `${opsYmd(r.date)} ${OPS_ANOMALY_KINDS[a.kind] ?? a.kind}`]);
    }
  }
  let notified = 0;
  if ((opts.notify ?? true) && settings.anomalyNotify && fresh.size) {
    const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...fresh.keys()] } }, select: { id: true, userId: true, displayName: true, reportingManager: { select: { userId: true } } } });
    for (const e of emps) {
      const items = fresh.get(e.id)!;
      const key = `${e.id}:${items.join("|")}`.slice(0, 400);
      if (await opsAlertOnce(tenantId, "ATTENDANCE_EXCEPTION", key, { userIds: [e.userId ?? ""], title: `Attendance exceptions to fix: ${items.length}`, body: items.slice(0, 8).join("\n"), link: "/me/attendance" })) notified++;
      if (e.reportingManager?.userId) await opsAlertOnce(tenantId, "ATTENDANCE_EXCEPTION_MANAGER", key, { userIds: [e.reportingManager.userId], title: `${e.displayName}: ${items.length} attendance exception(s)`, body: items.slice(0, 8).join("\n"), link: "/team/attendance" });
      await prisma.opsAttendanceAnomaly.updateMany({ where: { employeeId: e.id, notifiedAt: null, status: "OPEN" }, data: { notifiedAt: new Date() } });
    }
  }
  return { days: records.length, found, created, notified };
}

export async function resolveAnomaly(input: { actor: OpsActor; id: string; action: "RESOLVED" | "WAIVED"; note: string }): Promise<Result> {
  if (!input.note.trim()) return { ok: false, message: "Note how it was resolved." };
  const a = await prisma.opsAttendanceAnomaly.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!a) return { ok: false, message: "Anomaly not found." };
  if (a.status !== "OPEN") return { ok: false, message: "This is already closed." };
  if (await opsLockMessage(input.actor.tenantId, "ATTENDANCE", a.date)) return { ok: false, message: (await opsLockMessage(input.actor.tenantId, "ATTENDANCE", a.date))! };
  await prisma.opsAttendanceAnomaly.update({ where: { id: a.id }, data: { status: input.action, resolvedBy: input.actor.userId, resolvedAt: new Date(), resolution: input.note.trim() } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "ATTENDANCE", action: "UPDATE", entityType: "OpsAttendanceAnomaly", entityId: a.id, summary: `${input.action === "WAIVED" ? "Waived" : "Resolved"} ${OPS_ANOMALY_KINDS[a.kind] ?? a.kind} on ${opsYmd(a.date)}: ${input.note.trim()}` });
  return { ok: true, message: input.action === "WAIVED" ? "Waived." : "Resolved." };
}

// ---------------------------------------------------------------------------
//  Early departure
// ---------------------------------------------------------------------------

export async function saveEarlyDepartureRule(input: { tenantId: string; policyKey: string; graceMinutes: number; exemptPerMonth: number; penaltyDays: number; isActive: boolean }): Promise<Result> {
  if (input.policyKey !== "ALL" && !(await prisma.attendancePolicy.findFirst({ where: { id: input.policyKey, tenantId: input.tenantId } }))) return { ok: false, message: "Attendance policy not found." };
  if (input.graceMinutes < 0 || input.graceMinutes > 240) return { ok: false, message: "Grace is 0 to 240 minutes." };
  if (input.exemptPerMonth < 0 || input.exemptPerMonth > 31) return { ok: false, message: "Exemptions are 0 to 31 a month." };
  if (input.penaltyDays < 0 || input.penaltyDays > 1) return { ok: false, message: "The penalty is 0 to 1 day." };
  const data = { graceMinutes: input.graceMinutes, exemptPerMonth: input.exemptPerMonth, penaltyDays: input.penaltyDays, isActive: input.isActive };
  await prisma.opsEarlyDepartureRule.upsert({ where: { tenantId_policyKey: { tenantId: input.tenantId, policyKey: input.policyKey } }, create: { tenantId: input.tenantId, policyKey: input.policyKey, ...data }, update: data });
  return { ok: true, message: "Early-departure rule saved." };
}

/** Early departures in a month and the penalties the rules give them. */
export async function earlyDepartureReport(tenantId: string, year: number, month: number) {
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const rules = await prisma.opsEarlyDepartureRule.findMany({ where: { tenantId, isActive: true } });
  if (!rules.length) return [];
  const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, date: { gte: from, lte: to }, lastOut: { not: null }, shiftId: { not: null } }, select: { employeeId: true, date: true, lastOut: true, shiftId: true } });
  const shifts = new Map((await prisma.shift.findMany({ where: { tenantId } })).map((s) => [s.id, s]));
  const assign = await prisma.employeeTimePolicy.findMany({ where: { employee: { tenantId } }, orderBy: { effectiveFrom: "desc" } });
  const byEmp = new Map<string, Array<{ date: Date; minutes: number }>>();
  for (const r of recs) {
    const s = shifts.get(r.shiftId!);
    if (!s || s.isFlexible || s.crossesMidnight) continue;
    const mins = Math.round((atLocal(r.date, hhmm(s.endTime)).getTime() - r.lastOut!.getTime()) / 60_000);
    if (mins > 0) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), { date: r.date, minutes: mins }]);
  }
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...byEmp.keys()] } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
  const out = [];
  for (const [employeeId, list] of byEmp) {
    const pol = assign.find((p) => p.employeeId === employeeId && p.effectiveFrom <= to)?.attendancePolicyId ?? null;
    const rule = rules.find((r) => r.policyKey === pol) ?? rules.find((r) => r.policyKey === "ALL");
    if (!rule) continue;
    const res = opsEarlyDeparturePenalties(list, { graceMinutes: rule.graceMinutes, exemptPerMonth: rule.exemptPerMonth, penaltyDays: Number(rule.penaltyDays) });
    if (!res.length) continue;
    const e = emps.get(employeeId);
    out.push({ employeeId, employee: e?.displayName ?? "", employeeNumber: e?.employeeNumber ?? "", incidents: res.length, penaltyDays: Math.round(res.reduce((s, x) => s + x.penalty, 0) * 100) / 100, days: res });
  }
  return out.sort((a, b) => b.penaltyDays - a.penaltyDays || a.employee.localeCompare(b.employee));
}

/** Book the month's early-departure penalties as LOP adjustments (once per employee and month). */
export async function applyEarlyDeparturePenalties(input: { actor: OpsActor; year: number; month: number }): Promise<Result & { applied?: number }> {
  const t = input.actor.tenantId;
  if (await opsLockMessage(t, "ATTENDANCE", new Date(Date.UTC(input.year, input.month - 1, 1)), new Date(Date.UTC(input.year, input.month, 0)))) return { ok: false, message: "That month is locked." };
  const rows = (await earlyDepartureReport(t, input.year, input.month)).filter((r) => r.penaltyDays > 0);
  let applied = 0;
  for (const r of rows) {
    const note = `EARLY_DEPARTURE ${input.year}-${String(input.month).padStart(2, "0")}`;
    const exists = await prisma.lopAdjustment.findFirst({ where: { tenantId: t, employeeId: r.employeeId, year: input.year, month: input.month, note: { startsWith: note } } });
    if (exists) continue;
    await prisma.lopAdjustment.create({ data: { tenantId: t, employeeId: r.employeeId, year: input.year, month: input.month, days: r.penaltyDays, note: `${note}: ${r.incidents} early departure(s)`, source: "MANUAL", createdBy: input.actor.userId } });
    applied++;
  }
  await opsAudit(t, input.actor.userId, { module: "ATTENDANCE", action: "UPDATE", entityType: "LopAdjustment", summary: `Applied early-departure penalties for ${input.month}/${input.year}: ${applied} employee(s)` });
  return { ok: true, applied, message: applied ? `Booked LOP for ${applied} employee(s).` : "Nothing new to book." };
}

// ---------------------------------------------------------------------------
//  Devices and capture sources
// ---------------------------------------------------------------------------

export async function runDeviceHealth(tenantId: string, now = new Date()): Promise<{ checked: number; offline: number; alerted: number }> {
  const s = await getOpsSettings(tenantId);
  const [devices, kiosks] = await Promise.all([
    prisma.attendanceDevice.findMany({ where: { tenantId } }),
    prisma.attendanceKiosk.findMany({ where: { tenantId } }),
  ]);
  const since = new Date(now.getTime() - DAY);
  const units = [
    ...devices.map((d) => ({ key: `DEVICE:${d.id}`, id: d.id, name: `${d.name} (${d.serialNumber})`, isActive: d.isActive, createdAt: d.createdAt, source: "BIOMETRIC" as const, seen: d.lastSeenAt })),
    ...kiosks.map((k) => ({ key: `KIOSK:${k.id}`, id: k.id, name: `Kiosk: ${k.name}`, isActive: k.isActive, createdAt: k.createdAt, source: "KIOSK" as const, seen: k.lastUsedAt })),
  ];
  const admins = await usersWithPermission(tenantId, "time.attendance.manage");
  let offline = 0, alerted = 0;
  for (const u of units) {
    const [last, count] = await Promise.all([
      prisma.attendanceLog.findFirst({ where: { tenantId, deviceId: u.id }, orderBy: { timestamp: "desc" }, select: { timestamp: true } }),
      prisma.attendanceLog.count({ where: { tenantId, deviceId: u.id, timestamp: { gte: since } } }),
    ]);
    const lastPunchAt = [last?.timestamp ?? null, u.seen].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const status = opsDeviceHealth({ isActive: u.isActive, lastPunchAt, createdAt: u.createdAt }, now, s.deviceStaleMinutes, s.deviceOfflineMinutes);
    const prev = await prisma.opsDeviceStatus.findUnique({ where: { tenantId_deviceKey: { tenantId, deviceKey: u.key } } });
    await prisma.opsDeviceStatus.upsert({
      where: { tenantId_deviceKey: { tenantId, deviceKey: u.key } },
      create: { tenantId, deviceKey: u.key, name: u.name, status, lastPunchAt, punches24h: count, checkedAt: now, since: now },
      update: { name: u.name, status, lastPunchAt, punches24h: count, checkedAt: now, ...(prev?.status !== status ? { since: now } : {}) },
    });
    if (status === "OFFLINE") {
      offline++;
      if (prev?.status !== "OFFLINE" && await opsAlertOnce(tenantId, "DEVICE_OFFLINE", `${u.key}:${opsYmd(now)}`, { userIds: admins, title: `${u.name} has sent no punches since ${lastPunchAt ? lastPunchAt.toISOString().slice(0, 16).replace("T", " ") : "it was added"}`, link: "/time/insights?tab=devices" })) alerted++;
    }
  }
  return { checked: units.length, offline, alerted };
}

/** Punches by capture source over a range, for the source audit. */
export async function punchSourceAudit(tenantId: string, from: Date, to: Date, filter: { source?: string | null; employeeId?: string | null } = {}) {
  const where: Prisma.AttendanceLogWhereInput = { tenantId, timestamp: { gte: opsDay(from), lt: opsAddDays(to, 1) }, ...(filter.source ? { source: filter.source as never } : {}), ...(filter.employeeId ? { employeeId: filter.employeeId } : {}) };
  const [rows, bySource] = await Promise.all([
    prisma.attendanceLog.findMany({ where, orderBy: { timestamp: "desc" }, take: 500 }),
    prisma.attendanceLog.groupBy({ by: ["source", "status"], where, _count: true }),
  ]);
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
  const devices = new Map([...(await prisma.attendanceDevice.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((d) => [d.id, d.name] as const), ...(await prisma.attendanceKiosk.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((k) => [k.id, `Kiosk ${k.name}`] as const)]);
  return {
    totals: bySource.map((b) => ({ source: b.source, status: b.status, count: b._count })),
    rows: rows.map((r) => ({ ...r, employee: emps.get(r.employeeId)?.displayName ?? "", employeeNumber: emps.get(r.employeeId)?.employeeNumber ?? "", device: r.deviceId ? devices.get(r.deviceId) ?? r.deviceId : null })),
  };
}

/** Days where punches arrived from more than one source, and whether they agree. */
export async function sourceComparison(tenantId: string, from: Date, to: Date) {
  const s = await getOpsSettings(tenantId);
  const logs = await prisma.attendanceLog.findMany({ where: { tenantId, status: "VALID", timestamp: { gte: opsDay(from), lt: opsAddDays(to, 1) } }, select: { employeeId: true, timestamp: true, direction: true, source: true }, orderBy: { timestamp: "asc" } });
  const groups = new Map<string, typeof logs>();
  for (const l of logs) {
    const local = new Date(l.timestamp.getTime() + TZ * 60_000);
    const k = `${l.employeeId}|${opsYmd(local)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const multi = [...groups.entries()].filter(([, ls]) => new Set(ls.map((l) => l.source)).size > 1);
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(multi.map(([k]) => k.split("|")[0]!))] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  return multi.map(([k, ls]) => {
    const [employeeId, date] = k.split("|") as [string, string];
    const c = opsSourceComparison(ls, s.sourceMismatchMinutes);
    return { employeeId, employee: emps.get(employeeId) ?? "", date, sources: [...new Set(ls.map((l) => l.source))], ...c };
  }).sort((a, b) => Number(b.mismatch) - Number(a.mismatch) || b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------------------
//  Reconciliation, heatmap, cut-off alerts
// ---------------------------------------------------------------------------

/** The payroll attendance window ending at this month's cut-off. */
export function opsAttendanceWindow(year: number, month: number, cutoffDay = 25): { from: Date; to: Date } {
  const to = opsCutoffDate(year, month, cutoffDay);
  const prev = month === 1 ? opsCutoffDate(year - 1, 12, cutoffDay) : opsCutoffDate(year, month - 1, cutoffDay);
  return { from: opsAddDays(prev, 1), to };
}

export async function reconciliationDashboard(tenantId: string, year: number, month: number, scope: Prisma.EmployeeWhereInput = {}) {
  const s = await getOpsSettings(tenantId);
  const { from, to } = opsAttendanceWindow(year, month, s.attendanceCutoffDay);
  const emps = await prisma.employee.findMany({ where: { ...scope, tenantId, ...ACTIVE }, select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } }, orderBy: { displayName: "asc" } });
  const ids = emps.map((e) => e.id);
  const [records, anomalies, requests, leave] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: ids }, date: { gte: from, lte: to } }, select: { employeeId: true, date: true, status: true, manualStatus: true, payableValue: true, lopValue: true } }),
    prisma.opsAttendanceAnomaly.groupBy({ by: ["employeeId", "date"], where: { tenantId, employeeId: { in: ids }, status: "OPEN", date: { gte: from, lte: to } }, _count: true }),
    prisma.attendanceRequest.groupBy({ by: ["employeeId"], where: { tenantId, employeeId: { in: ids }, status: "PENDING", fromDate: { lte: to }, toDate: { gte: from } }, _count: true }),
    prisma.leaveRequest.groupBy({ by: ["employeeId"], where: { tenantId, employeeId: { in: ids }, status: "PENDING", fromDate: { lte: to }, toDate: { gte: from } }, _count: true }),
  ]);
  const anom = new Map(anomalies.map((a) => [`${a.employeeId}|${opsYmd(a.date)}`, a._count]));
  const req = new Map(requests.map((r) => [r.employeeId, r._count]));
  const lv = new Map(leave.map((r) => [r.employeeId, r._count]));
  const recBy = new Map<string, typeof records>();
  for (const r of records) recBy.set(r.employeeId, [...(recBy.get(r.employeeId) ?? []), r]);
  const totalDays = Math.round((to.getTime() - from.getTime()) / DAY) + 1;
  const rows = emps.map((e) => {
    const days = (recBy.get(e.id) ?? []).map((r) => ({ status: r.manualStatus ?? r.status, payableValue: Number(r.payableValue), lopValue: Number(r.lopValue), onLeave: (r.manualStatus ?? r.status) === "ON_LEAVE", anomalies: anom.get(`${e.id}|${opsYmd(r.date)}`) ?? 0 }));
    const rec = opsReconcileMonth(e.id, days, (req.get(e.id) ?? 0) + (lv.get(e.id) ?? 0));
    const missingDays = Math.max(0, totalDays - days.length);
    return { ...rec, employee: e.displayName ?? "", employeeNumber: e.employeeNumber, department: e.department?.name ?? "", missingDays, balanced: rec.balanced && missingDays === 0 };
  });
  return {
    from, to, totalDays, rows,
    totals: { employees: rows.length, ready: rows.filter((r) => r.balanced).length, unresolved: rows.reduce((s2, r) => s2 + r.unresolved, 0), pending: rows.reduce((s2, r) => s2 + r.regularisationsPending, 0), lop: Math.round(rows.reduce((s2, r) => s2 + r.lop, 0) * 100) / 100, unprocessed: rows.filter((r) => r.missingDays > 0).length },
  };
}

/** Share of a team present each day of a month (0–4 shades) for a heatmap. */
export async function teamHeatmap(tenantId: string, employeeIds: string[], year: number, month: number) {
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: employeeIds }, date: { gte: from, lte: to } }, select: { employeeId: true, date: true, status: true, manualStatus: true } });
  const days: Array<{ date: string; present: number; leave: number; absent: number; expected: number; level: number }> = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
    const d = new Date(t);
    const today = recs.filter((r) => r.date.getTime() === t);
    const st = today.map((r) => r.manualStatus ?? r.status);
    const off = st.filter((x) => x === "WEEKLY_OFF" || x === "HOLIDAY").length;
    const present = st.filter((x) => ["PRESENT", "HALF_DAY", "WORK_FROM_HOME", "ON_DUTY"].includes(x)).length;
    const leave = st.filter((x) => x === "ON_LEAVE").length;
    const expected = Math.max(0, employeeIds.length - off);
    days.push({ date: opsYmd(d), present, leave, absent: Math.max(0, expected - present - leave), expected, level: off === employeeIds.length && employeeIds.length > 0 ? -1 : opsHeatLevel(present, expected) });
  }
  const perPerson = employeeIds.map((id) => ({ employeeId: id, cells: days.map((d) => recs.find((r) => r.employeeId === id && opsYmd(r.date) === d.date)).map((r) => (r ? (r.manualStatus ?? r.status) : null)) }));
  return { days, perPerson };
}

/** Before the cut-off: remind people with open exceptions or pending requests, and their managers. */
export async function runAttendanceCutoffAlerts(tenantId: string, now = new Date()): Promise<{ due: boolean; employees: number; sent: number }> {
  const s = await getOpsSettings(tenantId);
  if (!opsCutoffAlertDue(now, s.attendanceCutoffDay, s.cutoffAlertDaysBefore)) return { due: false, employees: 0, sent: 0 };
  const cutoff = opsNextCutoff(now, s.attendanceCutoffDay);
  const { from, to } = opsAttendanceWindow(cutoff.date.getUTCFullYear(), cutoff.date.getUTCMonth() + 1, s.attendanceCutoffDay);
  const [anom, reqs] = await Promise.all([
    prisma.opsAttendanceAnomaly.groupBy({ by: ["employeeId"], where: { tenantId, status: "OPEN", date: { gte: from, lte: to } }, _count: true }),
    prisma.attendanceRequest.groupBy({ by: ["employeeId"], where: { tenantId, status: "PENDING", fromDate: { lte: to }, toDate: { gte: from } }, _count: true }),
  ]);
  const counts = new Map<string, { a: number; r: number }>();
  for (const a of anom) counts.set(a.employeeId, { a: a._count, r: 0 });
  for (const r of reqs) counts.set(r.employeeId, { a: counts.get(r.employeeId)?.a ?? 0, r: r._count });
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...counts.keys()] } }, select: { id: true, userId: true, displayName: true, reportingManager: { select: { userId: true } } } });
  let sent = 0;
  for (const e of emps) {
    const c = counts.get(e.id)!;
    const what = [c.a ? `${c.a} open exception(s)` : "", c.r ? `${c.r} request(s) awaiting a decision` : ""].filter(Boolean).join(" and ");
    if (await opsAlertOnce(tenantId, "ATTENDANCE_CUTOFF", `${opsYmd(cutoff.date)}:${e.id}`, { userIds: [e.userId ?? ""], title: `Attendance closes for payroll on ${opsYmd(cutoff.date)}: you have ${what}`, link: "/me/attendance", email: true })) sent++;
    if (e.reportingManager?.userId) await opsAlertOnce(tenantId, "ATTENDANCE_CUTOFF_MANAGER", `${opsYmd(cutoff.date)}:${e.id}`, { userIds: [e.reportingManager.userId], title: `${e.displayName} has ${what} before the ${opsYmd(cutoff.date)} cut-off`, link: "/team/attendance" });
  }
  return { due: true, employees: emps.length, sent };
}

// ---------------------------------------------------------------------------
//  Certification
// ---------------------------------------------------------------------------

async function daySummary(tenantId: string, employeeIds: string[], from: Date, to: Date) {
  const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, employeeId: { in: employeeIds }, date: { gte: opsDay(from), lte: opsDay(to) } }, select: { status: true, manualStatus: true, lopValue: true, payableValue: true } });
  const by: Record<string, number> = {};
  for (const r of recs) { const k = r.manualStatus ?? r.status; by[k] = (by[k] ?? 0) + 1; }
  const open = await prisma.opsAttendanceAnomaly.count({ where: { tenantId, employeeId: { in: employeeIds }, status: "OPEN", date: { gte: opsDay(from), lte: opsDay(to) } } });
  return { employees: employeeIds.length, records: recs.length, byStatus: by, lop: Math.round(recs.reduce((s, r) => s + Number(r.lopValue), 0) * 100) / 100, payable: Math.round(recs.reduce((s, r) => s + Number(r.payableValue), 0) * 100) / 100, openAnomalies: open };
}

/** A manager certifies their team's attendance for a day. */
export async function certifyDay(input: { actor: OpsActor; managerEmployeeId: string; date: Date; note?: string | null; allowOpen?: boolean }): Promise<Result> {
  const t = input.actor.tenantId;
  const date = opsDay(input.date);
  if (date.getTime() > opsDay(new Date()).getTime()) return { ok: false, message: "A day can be certified once it is over." };
  const team = (await prisma.employee.findMany({ where: { tenantId: t, reportingManagerId: input.managerEmployeeId, ...ACTIVE }, select: { id: true } })).map((e) => e.id);
  if (!team.length) return { ok: false, message: "You have no direct reports to certify." };
  const summary = await daySummary(t, team, date, date);
  if (summary.openAnomalies && !input.allowOpen) return { ok: false, message: `${summary.openAnomalies} exception(s) are still open on ${opsYmd(date)}. Resolve them or certify with exceptions noted.` };
  const key = `MGR:${input.managerEmployeeId}`;
  const exists = await prisma.opsAttendanceCertification.findUnique({ where: { tenantId_scope_periodStart_departmentKey: { tenantId: t, scope: "DAY", periodStart: date, departmentKey: key } } });
  if (exists) return { ok: false, message: `${opsYmd(date)} is already certified.` };
  await prisma.opsAttendanceCertification.create({ data: { tenantId: t, scope: "DAY", periodStart: date, periodEnd: date, departmentKey: key, summary, status: "CERTIFIED", note: input.note ?? null, certifiedBy: input.actor.userId } });
  await opsAudit(t, input.actor.userId, { module: "ATTENDANCE", action: "APPROVE", entityType: "OpsAttendanceCertification", summary: `Certified team attendance for ${opsYmd(date)} (${team.length} people${summary.openAnomalies ? `, ${summary.openAnomalies} open exception(s) noted` : ""})` });
  return { ok: true, message: `Certified ${opsYmd(date)} for ${team.length} people.` };
}

/** HR certifies a month's attendance summary; payroll approves it, which locks the period. */
export async function certifyMonth(input: { actor: OpsActor; year: number; month: number; departmentId?: string | null; note?: string | null }): Promise<Result & { id?: string }> {
  const t = input.actor.tenantId;
  const s = await getOpsSettings(t);
  const { from, to } = opsAttendanceWindow(input.year, input.month, s.attendanceCutoffDay);
  const key = input.departmentId || "ALL";
  if (input.departmentId && !(await prisma.department.findFirst({ where: { id: input.departmentId, tenantId: t } }))) return { ok: false, message: "Department not found." };
  const existing = await prisma.opsAttendanceCertification.findUnique({ where: { tenantId_scope_periodStart_departmentKey: { tenantId: t, scope: "MONTH", periodStart: from, departmentKey: key } } });
  if (existing && existing.status !== "REJECTED") return { ok: false, message: `This month is already ${existing.status === "APPROVED" ? "certified" : "awaiting approval"}.` };
  const team = (await prisma.employee.findMany({ where: { tenantId: t, ...ACTIVE, ...(input.departmentId ? { departmentId: input.departmentId } : {}) }, select: { id: true } })).map((e) => e.id);
  const summary = await daySummary(t, team, from, to);
  const cert = existing
    ? await prisma.opsAttendanceCertification.update({ where: { id: existing.id }, data: { summary, status: "PENDING_APPROVAL", note: input.note ?? null, certifiedBy: input.actor.userId, certifiedAt: new Date(), decidedAt: null } })
    : await prisma.opsAttendanceCertification.create({ data: { tenantId: t, scope: "MONTH", periodStart: from, periodEnd: to, departmentKey: key, summary, status: "PENDING_APPROVAL", note: input.note ?? null, certifiedBy: input.actor.userId } });
  const res = await opsRequestApproval({
    tenantId: t, entityType: "OPS_ATTENDANCE_CERT", targetId: cert.id, targetLabel: `Attendance ${opsYmd(from)} to ${opsYmd(to)}${input.departmentId ? " (department)" : ""}`,
    payload: { summary }, requestedBy: input.actor.userId, title: `Certify attendance ${opsYmd(from)} – ${opsYmd(to)}`,
    details: `${summary.employees} employees, ${summary.lop} LOP day(s), ${summary.openAnomalies} open exception(s).${input.note ? ` ${input.note}` : ""}`, link: "/time/controls?tab=certification",
  });
  if (!res.ok) {
    await prisma.opsAttendanceCertification.update({ where: { id: cert.id }, data: { status: "REJECTED", note: `Not sent: ${res.message}` } });
    return res;
  }
  await prisma.opsAttendanceCertification.update({ where: { id: cert.id }, data: { approvalId: res.id } });
  return { ...res, id: cert.id, message: res.status === "APPLIED" ? "Certified, approved and locked." : "Certified and sent to payroll for approval." };
}

export async function applyAttendanceCertDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  const cert = await prisma.opsAttendanceCertification.findFirst({ where: { id: a.targetId ?? "", tenantId: a.tenantId } });
  if (!cert) throw new Error("Certification not found.");
  if (outcome !== "APPROVED") {
    await prisma.opsAttendanceCertification.update({ where: { id: cert.id }, data: { status: "REJECTED", decidedAt: new Date() } });
    return;
  }
  await prisma.opsAttendanceCertification.update({ where: { id: cert.id }, data: { status: "APPROVED", decidedAt: new Date() } });
  if (!(await opsLockedPeriod(a.tenantId, "ATTENDANCE", cert.periodStart, cert.periodEnd))) {
    await prisma.opsPeriodLock.create({ data: { tenantId: a.tenantId, domain: "ATTENDANCE", periodStart: cert.periodStart, periodEnd: cert.periodEnd, reason: "Certified for payroll", lockedBy: actorUserId ?? a.requestedBy } });
  }
  await opsAudit(a.tenantId, actorUserId, { module: "ATTENDANCE", action: "LOCK", entityType: "OpsAttendanceCertification", entityId: cert.id, summary: `Attendance ${opsYmd(cert.periodStart)} to ${opsYmd(cert.periodEnd)} certified and locked` });
}

// ---------------------------------------------------------------------------
//  Reason codes
// ---------------------------------------------------------------------------

export const OPS_REASON_KINDS: Record<string, string> = { REGULARISATION: "Regularisation reasons", ABSENCE: "Absence reasons", STATUS: "Employee status reasons", IDLE: "Idle-time categories" };

export async function saveReasonCode(input: { tenantId: string; id?: string | null; kind: string; code: string; label: string; description?: string | null; parentId?: string | null; appliesTo?: string | null; sortOrder?: number; isActive: boolean }): Promise<Result & { id?: string }> {
  if (!(input.kind in OPS_REASON_KINDS)) return { ok: false, message: "Choose a catalogue." };
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!code || code.length > 30) return { ok: false, message: "A code is 1 to 30 letters, digits or underscores." };
  if (!input.label.trim()) return { ok: false, message: "Give the reason a label." };
  if (input.parentId) {
    const parent = await prisma.opsReasonCode.findFirst({ where: { id: input.parentId, tenantId: input.tenantId, kind: input.kind } });
    if (!parent) return { ok: false, message: "The parent reason is not in this catalogue." };
    if (parent.id === input.id || parent.parentId) return { ok: false, message: "Reasons nest one level deep." };
  }
  if (input.kind === "STATUS" && input.appliesTo && !["ACTIVE", "PROBATION", "CONFIRMED", "NOTICE_PERIOD", "EXITED", "INACTIVE", "ON_LEAVE"].includes(input.appliesTo)) return { ok: false, message: "Choose the status this reason explains." };
  const data = { kind: input.kind, code, label: input.label.trim(), description: input.description?.trim() || null, parentId: input.parentId || null, appliesTo: input.appliesTo || null, sortOrder: input.sortOrder ?? 0, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsReasonCode.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      if (!n.count) return { ok: false, message: "Reason not found." };
      return { ok: true, id: input.id, message: "Reason saved." };
    }
    const r = await prisma.opsReasonCode.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, id: r.id, message: "Reason added." };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: `${code} is already in this catalogue.` };
    throw err;
  }
}

export function reasonCodes(tenantId: string, kind: string, activeOnly = false) {
  return prisma.opsReasonCode.findMany({ where: { tenantId, kind, ...(activeOnly ? { isActive: true } : {}) }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

/** Regularisation requests by reason code, for the catalogue report. */
export async function regularisationReasonReport(tenantId: string, from: Date, to: Date) {
  const rows = await prisma.attendanceRequest.groupBy({ by: ["reasonCode", "status"], where: { tenantId, type: "ADJUSTMENT", createdAt: { gte: opsDay(from), lt: opsAddDays(to, 1) } }, _count: true });
  const codes = new Map((await reasonCodes(tenantId, "REGULARISATION")).map((c) => [c.code, c.label]));
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = r.reasonCode ?? "(none)";
    const m = by.get(k) ?? {};
    m[r.status] = (m[r.status] ?? 0) + r._count;
    by.set(k, m);
  }
  return [...by.entries()].map(([code, counts]) => ({ code, label: codes.get(code) ?? (code === "(none)" ? "No reason code" : code), counts, total: Object.values(counts).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
//  Breaks
// ---------------------------------------------------------------------------

export async function saveBreakRule(input: { tenantId: string; id?: string | null; name: string; code: string; maxMinutes: number; maxPerDay: number; isPaid: boolean; isActive: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the break." };
  const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!code) return { ok: false, message: "Give the break a code." };
  if (!(input.maxMinutes >= 1 && input.maxMinutes <= 240)) return { ok: false, message: "A break lasts 1 to 240 minutes." };
  if (!(input.maxPerDay >= 1 && input.maxPerDay <= 10)) return { ok: false, message: "Allow 1 to 10 a day." };
  const data = { name: input.name.trim(), code, maxMinutes: input.maxMinutes, maxPerDay: input.maxPerDay, isPaid: input.isPaid, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsBreakRule.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Break saved." } : { ok: false, message: "Break not found." };
    }
    await prisma.opsBreakRule.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: "Break added." };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: `${code} already exists.` };
    throw err;
  }
}

const localToday = (now: Date) => opsDay(new Date(now.getTime() + TZ * 60_000));

export async function startBreak(input: { tenantId: string; employeeId: string; ruleId: string; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const rule = await prisma.opsBreakRule.findFirst({ where: { id: input.ruleId, tenantId: input.tenantId, isActive: true } });
  if (!rule) return { ok: false, message: "Choose a break." };
  const date = localToday(now);
  if (await opsLockMessage(input.tenantId, "ATTENDANCE", date)) return { ok: false, message: "Attendance for today is locked." };
  const today = await prisma.opsBreakLog.findMany({ where: { employeeId: input.employeeId, date }, select: { ruleId: true, endAt: true } });
  const issue = opsBreakStartIssue(today, rule);
  if (issue) return { ok: false, message: issue };
  await prisma.opsBreakLog.create({ data: { tenantId: input.tenantId, employeeId: input.employeeId, date, ruleId: rule.id, startAt: now } });
  return { ok: true, message: `${rule.name} started — up to ${rule.maxMinutes} minutes.` };
}

export async function endBreak(input: { tenantId: string; employeeId: string; now?: Date; note?: string | null }): Promise<Result> {
  const now = input.now ?? new Date();
  const open = await prisma.opsBreakLog.findFirst({ where: { tenantId: input.tenantId, employeeId: input.employeeId, endAt: null }, include: { rule: true }, orderBy: { startAt: "desc" } });
  if (!open) return { ok: false, message: "You are not on a break." };
  const minutes = Math.max(0, Math.round((now.getTime() - open.startAt.getTime()) / 60_000));
  const status = opsBreakOutcome(minutes, open.rule);
  await prisma.opsBreakLog.update({ where: { id: open.id }, data: { endAt: now, minutes, status, note: input.note ?? open.note } });
  return { ok: true, message: status === "EXCEEDED" ? `Back after ${minutes} minutes — ${minutes - open.rule.maxMinutes} over the ${open.rule.maxMinutes}-minute limit. You can ask for an exception.` : `Back after ${minutes} minutes.` };
}

/** An administrator records or corrects a break. */
export async function saveBreakEntry(input: { actor: OpsActor; id?: string | null; employeeId: string; ruleId: string; startAt: Date; endAt: Date; note?: string | null }): Promise<Result> {
  const t = input.actor.tenantId;
  const [emp, rule] = await Promise.all([
    prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: t }, select: { id: true } }),
    prisma.opsBreakRule.findFirst({ where: { id: input.ruleId, tenantId: t } }),
  ]);
  if (!emp || !rule) return { ok: false, message: "Choose the employee and the break." };
  if (input.endAt <= input.startAt) return { ok: false, message: "The break ends after it starts." };
  const minutes = Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000);
  if (minutes > 12 * 60) return { ok: false, message: "A break cannot be longer than 12 hours." };
  const date = localToday(input.startAt);
  if (await opsLockMessage(t, "ATTENDANCE", date)) return { ok: false, message: (await opsLockMessage(t, "ATTENDANCE", date))! };
  const data = { employeeId: emp.id, ruleId: rule.id, date, startAt: input.startAt, endAt: input.endAt, minutes, status: opsBreakOutcome(minutes, rule), note: input.note ?? null, editedBy: input.actor.userId };
  if (input.id) {
    const before = await prisma.opsBreakLog.findFirst({ where: { id: input.id, tenantId: t } });
    if (!before) return { ok: false, message: "Break not found." };
    await prisma.opsBreakLog.update({ where: { id: before.id }, data });
    await opsAudit(t, input.actor.userId, { module: "ATTENDANCE", action: "UPDATE", entityType: "OpsBreakLog", entityId: before.id, summary: `Corrected a ${rule.name} on ${opsYmd(date)} to ${minutes} min`, oldValue: { startAt: before.startAt, endAt: before.endAt, minutes: before.minutes }, newValue: { startAt: input.startAt, endAt: input.endAt, minutes } });
    return { ok: true, message: "Break corrected." };
  }
  const b = await prisma.opsBreakLog.create({ data: { ...data, tenantId: t } });
  await opsAudit(t, input.actor.userId, { module: "ATTENDANCE", action: "CREATE", entityType: "OpsBreakLog", entityId: b.id, summary: `Recorded a ${rule.name} of ${minutes} min on ${opsYmd(date)}` });
  return { ok: true, message: "Break recorded." };
}

export async function requestBreakException(input: { actor: OpsActor; employeeId: string; breakId: string; reason: string }): Promise<Result> {
  const b = await prisma.opsBreakLog.findFirst({ where: { id: input.breakId, tenantId: input.actor.tenantId, employeeId: input.employeeId }, include: { rule: true } });
  if (!b) return { ok: false, message: "Break not found." };
  if (b.status !== "EXCEEDED") return { ok: false, message: "Only a break over its limit needs an exception." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why the break ran long." };
  const res = await opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_BREAK_EXCEPTION", targetId: b.id, targetLabel: `${b.rule.name} on ${opsYmd(b.date)} (${b.minutes} min)`, employeeId: input.employeeId,
    payload: { minutes: b.minutes, limit: b.rule.maxMinutes }, reason: input.reason.trim(), requestedBy: input.actor.userId,
    title: `Break exception: ${b.rule.name} of ${b.minutes} min on ${opsYmd(b.date)}`, link: "/team/attendance",
  });
  if (res.ok && res.status === "PENDING") await prisma.opsBreakLog.update({ where: { id: b.id }, data: { status: "EXCEPTION_PENDING", note: input.reason.trim() } });
  return res;
}

export async function applyBreakExceptionDecision(a: OpsApprovalRequest, outcome: string): Promise<void> {
  if (!a.targetId) return;
  await prisma.opsBreakLog.updateMany({ where: { id: a.targetId, tenantId: a.tenantId }, data: { status: outcome === "APPROVED" ? "EXCEPTION_APPROVED" : outcome === "REJECTED" ? "EXCEPTION_REJECTED" : "EXCEEDED" } });
}

/** Breaks over a range: per employee totals, exceeded counts. */
export async function breakReport(tenantId: string, from: Date, to: Date, employeeIds?: string[]) {
  const logs = await prisma.opsBreakLog.findMany({ where: { tenantId, date: { gte: opsDay(from), lte: opsDay(to) }, ...(employeeIds ? { employeeId: { in: employeeIds } } : {}) }, include: { rule: { select: { name: true, maxMinutes: true, isPaid: true } } }, orderBy: [{ date: "desc" }, { startAt: "desc" }] });
  const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(logs.map((l) => l.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true } })).map((e) => [e.id, e]));
  const by = new Map<string, { employeeId: string; employee: string; employeeNumber: string; breaks: number; minutes: number; exceeded: number; unpaidMinutes: number }>();
  for (const l of logs) {
    const e = emps.get(l.employeeId);
    const r = by.get(l.employeeId) ?? { employeeId: l.employeeId, employee: e?.displayName ?? "", employeeNumber: e?.employeeNumber ?? "", breaks: 0, minutes: 0, exceeded: 0, unpaidMinutes: 0 };
    r.breaks++; r.minutes += l.minutes ?? 0; if (["EXCEEDED", "EXCEPTION_PENDING", "EXCEPTION_REJECTED"].includes(l.status)) r.exceeded++;
    if (!l.rule.isPaid) r.unpaidMinutes += l.minutes ?? 0;
    by.set(l.employeeId, r);
  }
  return { logs: logs.map((l) => ({ ...l, employee: emps.get(l.employeeId)?.displayName ?? "" })), summary: [...by.values()].sort((a, b) => b.exceeded - a.exceeded || b.minutes - a.minutes) };
}
