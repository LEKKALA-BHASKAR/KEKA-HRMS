"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, joinSettings, revisionHolidays, holidayCountCheck, parseHolidayCsv, syncCalendarExceptions,
  applyShutdownPeriod, applyHolidaySubstitution, type CalHoliday,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { jstr as str, jnum as num, jday as day, jlist as list } from "@/lib/join-depth";

/**
 * Holidays & calendars depth. Calendars change through versioned revisions
 * (draft → approval → publish, with a comparison against the live calendar,
 * CSV import, region and location scope, effective dating and a
 * notification campaign on publish). Also: holiday rules (weekend
 * substitution, count limits) approved before they apply, custom day types,
 * company shutdowns, the calendar exception queue and approval-gated
 * calendar assignment.
 */

const P = PERMISSIONS;
const PATHS = ["/time/holidays", "/time", "/me/leave", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });
const asJson = (h: CalHoliday[]) => h as unknown as Prisma.InputJsonValue;

async function editableRevision(tenantId: string, id: string) {
  const r = await prisma.holidayCalendarRevision.findFirst({ where: { id, tenantId } });
  return r && ["DRAFT", "REJECTED"].includes(r.status) ? r : null;
}

async function limitsFor(tenantId: string, calendarId: string | null) {
  const s = await joinSettings(tenantId);
  const rule = await prisma.holidayRule.findFirst({ where: { tenantId, kind: "COUNT_LIMIT", status: "ACTIVE", OR: [{ calendarId }, { calendarId: null }] }, orderBy: { createdAt: "desc" } });
  const c = (rule?.config ?? {}) as { min?: number; max?: number; maxOptional?: number };
  return { min: c.min ?? s.holidayMinCount, max: c.max ?? s.holidayMaxCount, maxOptional: c.maxOptional ?? null };
}

/** Start a revision: a copy of a live calendar, or a brand-new regional calendar. */
export async function createCalendarRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const calendarId = str(f, "calendarId") || null;
  const live = calendarId ? await prisma.holidayCalendar.findFirst({ where: { id: calendarId, tenantId: viewer.tenantId }, include: { holidays: { orderBy: { date: "asc" } } } }) : null;
  if (calendarId && !live) return NO("Calendar not found.");
  if (calendarId && (await prisma.holidayCalendarRevision.count({ where: { tenantId: viewer.tenantId, calendarId, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } }))) return NO("That calendar already has a draft or pending revision.");
  const name = live?.name ?? str(f, "name");
  const year = live?.year ?? num(f, "year");
  if (!name) return { ok: false, message: "Name the calendar.", errors: { name: "Required" } };
  if (!year || Number.isNaN(year) || year < 2000 || year > 2100) return { ok: false, message: "Pick the year.", errors: { year: "Required" } };
  if (!live && (await prisma.holidayCalendar.count({ where: { tenantId: viewer.tenantId, name, year } }))) return NO("A calendar with that name and year exists — revise it instead.");
  const locationIds = list(f, "locationIds");
  if (locationIds.length && (await prisma.location.count({ where: { tenantId: viewer.tenantId, id: { in: locationIds } } })) !== locationIds.length) return NO("Pick locations from the list.");
  const last = calendarId ? await prisma.holidayCalendarRevision.findFirst({ where: { tenantId: viewer.tenantId, calendarId }, orderBy: { version: "desc" } }) : null;
  const holidays: CalHoliday[] = live ? live.holidays.map((h) => ({ name: h.name, date: h.date.toISOString().slice(0, 10), isOptional: h.isOptional, dayType: h.dayType })) : [];
  const liveLocs = live && Array.isArray(live.locationIds) ? (live.locationIds as string[]) : [];
  const r = await prisma.holidayCalendarRevision.create({
    data: {
      tenantId: viewer.tenantId, calendarId, name, year, country: str(f, "country") || live?.country || null, state: str(f, "state") || live?.state || null,
      locationIds: locationIds.length ? locationIds : liveLocs, holidays: asJson(holidays), effectiveFrom: day(str(f, "effectiveFrom")),
      version: (last?.version ?? 0) + 1, note: str(f, "note") || null, createdBy: viewer.user.id,
    },
  });
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "HolidayCalendarRevision", entityId: r.id, summary: `Started ${name} ${year} v${r.version}${live ? " from the live calendar" : " (new calendar)"}` });
  return done(PATHS, "Draft started.");
}

/** Edit a draft: add / remove a holiday, import a CSV, or change its region and dating. */
export async function editCalendarRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const r = await editableRevision(viewer.tenantId, str(f, "id"));
  if (!r) return NO("Only a draft or rejected revision can be edited.");
  const op = str(f, "op");
  let hs = revisionHolidays(r.holidays);
  let msg = "Saved.";
  if (op === "add") {
    const name = str(f, "name"), date = day(str(f, "date"));
    if (!name || !date) return { ok: false, message: "Give the holiday a name and date.", errors: { name: name ? "" : "Required", date: date ? "" : "Required" } };
    if (date.getUTCFullYear() !== r.year) return NO(`The date must fall in ${r.year}.`);
    const dayType = str(f, "dayType") || null;
    if (dayType && !(await prisma.holidayDayType.count({ where: { tenantId: viewer.tenantId, code: dayType } }))) return NO("Unknown day type.");
    const iso = date.toISOString().slice(0, 10);
    if (hs.some((h) => h.date === iso && h.name === name)) return NO("That holiday is already on the list.");
    hs = [...hs, { name: name.slice(0, 80), date: iso, isOptional: str(f, "isOptional") === "on" || str(f, "isOptional") === "true", dayType }].sort((a, b) => a.date.localeCompare(b.date));
    msg = "Holiday added.";
  } else if (op === "remove") {
    const key = str(f, "key");
    const before = hs.length;
    hs = hs.filter((h) => `${h.date}|${h.name}` !== key);
    if (hs.length === before) return NO("Holiday not found.");
    msg = "Holiday removed.";
  } else if (op === "import") {
    const { rows, errors } = parseHolidayCsv(str(f, "csv"));
    if (errors.length) return NO(errors.slice(0, 5).join(" "));
    const wrong = rows.filter((h) => !h.date.startsWith(String(r.year)));
    if (wrong.length) return NO(`${wrong.length} row(s) are not in ${r.year}.`);
    const seen = new Set(hs.map((h) => `${h.date}|${h.name}`));
    const added = rows.filter((h) => !seen.has(`${h.date}|${h.name}`));
    hs = [...hs, ...added].sort((a, b) => a.date.localeCompare(b.date));
    msg = `Imported ${added.length} holiday(s)${rows.length - added.length ? `; ${rows.length - added.length} already listed` : ""}.`;
  } else if (op === "meta") {
    const locationIds = list(f, "locationIds");
    if (locationIds.length && (await prisma.location.count({ where: { tenantId: viewer.tenantId, id: { in: locationIds } } })) !== locationIds.length) return NO("Pick locations from the list.");
    await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { country: str(f, "country") || null, state: str(f, "state") || null, locationIds, effectiveFrom: day(str(f, "effectiveFrom")), note: str(f, "note") || r.note } });
    await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayCalendarRevision", entityId: r.id, summary: `${r.name} v${r.version}: region ${[str(f, "country"), str(f, "state")].filter(Boolean).join(" / ") || "none"}, ${locationIds.length} location(s)` });
    return done(PATHS, "Region and dating saved.");
  } else return NO("Unknown action.");
  await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { holidays: asJson(hs), status: "DRAFT" } });
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayCalendarRevision", entityId: r.id, summary: `${r.name} v${r.version}: ${msg}` });
  return done(PATHS, msg);
}

/** Validate the holiday count and send the revision for approval. */
export async function submitCalendarRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const r = await editableRevision(viewer.tenantId, str(f, "id"));
  if (!r) return NO("Only a draft can be submitted.");
  const hs = revisionHolidays(r.holidays);
  if (!hs.length) return NO("Add at least one holiday.");
  const problems = holidayCountCheck(hs, await limitsFor(viewer.tenantId, r.calendarId));
  if (problems.length) return NO(problems.join(" "));
  await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { status: "PENDING_APPROVAL", submittedAt: new Date() } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "HOLIDAY_CALENDAR", entityId: r.id, title: `Publish holiday calendar ${r.name} ${r.year} (v${r.version})`, details: `${hs.length} holiday(s)${r.effectiveFrom ? `, effective ${r.effectiveFrom.toISOString().slice(0, 10)}` : ""}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { status: r.status } }); return NO(wf.message); }
  await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayCalendarRevision", entityId: r.id, summary: `Submitted ${r.name} v${r.version} for approval` });
  return done(PATHS, wf.message === "Approved automatically." ? "Approved and published." : "Sent for approval.");
}

export async function withdrawCalendarRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const r = await editableRevision(viewer.tenantId, str(f, "id"));
  if (!r) return NO("Only a draft can be discarded.");
  await prisma.holidayCalendarRevision.update({ where: { id: r.id }, data: { status: "WITHDRAWN" } });
  await writeAudit(viewer, { module: "LEAVE", action: "DELETE", entityType: "HolidayCalendarRevision", entityId: r.id, summary: `Discarded ${r.name} v${r.version}` });
  return done(PATHS, "Draft discarded.");
}

// ---------------------------------------------------------------------------
//  Rules, day types, shutdowns
// ---------------------------------------------------------------------------

export async function saveHolidayRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const kind = str(f, "kind"), name = str(f, "name");
  if (!name) return { ok: false, message: "Name the rule.", errors: { name: "Required" } };
  const calendarId = str(f, "calendarId") || null;
  if (calendarId && !(await prisma.holidayCalendar.count({ where: { id: calendarId, tenantId: viewer.tenantId } }))) return NO("Calendar not found.");
  let config: Record<string, unknown>;
  if (kind === "SUBSTITUTE_WEEKEND") {
    if (!calendarId) return NO("Pick the calendar to substitute holidays in.");
    config = { direction: str(f, "direction") === "PREVIOUS" ? "PREVIOUS" : "NEXT" };
  } else if (kind === "COUNT_LIMIT") {
    const min = num(f, "min") ?? 0, max = num(f, "max") ?? 0, maxOptional = num(f, "maxOptional");
    if ([min, max].some((n) => Number.isNaN(n) || n < 0) || (max && max < min)) return NO("Check the minimum and maximum.");
    if (maxOptional !== null && (Number.isNaN(maxOptional) || maxOptional < 0)) return NO("Check the optional-holiday limit.");
    config = { min, max, maxOptional };
  } else return NO("Pick the rule type.");
  const rule = await prisma.holidayRule.create({ data: { tenantId: viewer.tenantId, name: name.slice(0, 80), kind, calendarId, config: config as Prisma.InputJsonValue, createdBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "HOLIDAY_RULE", entityId: rule.id, title: `Holiday rule: ${rule.name}`, details: `${kind.replace("_", " ").toLowerCase()} ${JSON.stringify(config)}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.holidayRule.delete({ where: { id: rule.id } }); return NO(wf.message); }
  await prisma.holidayRule.update({ where: { id: rule.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "HolidayRule", entityId: rule.id, summary: `Proposed holiday rule ${rule.name} (${kind})`, newValue: config });
  return done(PATHS, wf.message === "Approved automatically." ? "Rule active." : "Sent for approval.");
}

export async function holidayRuleOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const rule = await prisma.holidayRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!rule) return NO("Rule not found.");
  const op = str(f, "op");
  if (op === "retire") {
    if (rule.status !== "ACTIVE") return NO("Only an active rule can be retired.");
    await prisma.holidayRule.update({ where: { id: rule.id }, data: { status: "RETIRED" } });
    await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayRule", entityId: rule.id, summary: `Retired holiday rule ${rule.name}` });
    return done(PATHS, "Rule retired.");
  }
  if (op === "apply") {
    const r = await applyHolidaySubstitution(viewer.tenantId, rule.id);
    if (!r.ok) return NO(r.message);
    await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayRule", entityId: rule.id, summary: `${rule.name}: ${r.message}` });
    return done(PATHS, r.message);
  }
  return NO("Unknown action.");
}

export async function saveDayTypeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const code = str(f, "code").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 20);
  if (str(f, "op") === "toggle") {
    const t = await prisma.holidayDayType.findFirst({ where: { tenantId: viewer.tenantId, code } });
    if (!t) return NO("Day type not found.");
    await prisma.holidayDayType.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
    await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayDayType", entityId: t.id, summary: `${t.isActive ? "Retired" : "Restored"} day type ${t.name}` });
    return done(PATHS, "Updated.");
  }
  const name = str(f, "name");
  if (!code || !name) return { ok: false, message: "Give the day type a code and a name.", errors: { code: code ? "" : "Required", name: name ? "" : "Required" } };
  const color = str(f, "color");
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return NO("Colour must be like #1f6feb.");
  const t = await prisma.holidayDayType.upsert({ where: { tenantId_code: { tenantId: viewer.tenantId, code } }, create: { tenantId: viewer.tenantId, code, name: name.slice(0, 60), color: color || null, description: str(f, "description") || null }, update: { name: name.slice(0, 60), color: color || null, description: str(f, "description") || null } });
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "HolidayDayType", entityId: t.id, summary: `Saved day type ${code} — ${t.name}` });
  return done(PATHS, "Day type saved.");
}

export async function saveShutdownAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const name = str(f, "name"), from = day(str(f, "fromDate")), to = day(str(f, "toDate"));
  if (!name) return { ok: false, message: "Name the shutdown.", errors: { name: "Required" } };
  if (!from || !to || to < from) return NO("Pick the dates.");
  if ((to.getTime() - from.getTime()) / 86_400_000 > 31) return NO("A shutdown can be at most a month.");
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: str(f, "calendarId"), tenantId: viewer.tenantId } });
  if (!cal) return NO("Pick the calendar.");
  const s = await prisma.shutdownPeriod.create({ data: { tenantId: viewer.tenantId, name: name.slice(0, 80), fromDate: from, toDate: to, calendarId: cal.id, reason: str(f, "reason") || null, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "ShutdownPeriod", entityId: s.id, summary: `Planned shutdown ${s.name} on ${cal.name}` });
  return done(PATHS, "Shutdown saved. Apply it to add the days to the calendar.");
}

export async function shutdownOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const s = await prisma.shutdownPeriod.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!s) return NO("Shutdown not found.");
  const op = str(f, "op");
  if (op === "apply") {
    const r = await applyShutdownPeriod(viewer.tenantId, s.id);
    if (!r.ok) return NO(r.message);
    await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "ShutdownPeriod", entityId: s.id, summary: `${s.name}: ${r.message}` });
    return done(PATHS, r.message);
  }
  if (op === "cancel") {
    if (s.status === "CANCELLED") return NO("Already cancelled.");
    let removed = 0;
    if (s.status === "APPLIED") removed = (await prisma.holiday.deleteMany({ where: { calendarId: s.calendarId, name: s.name, dayType: "SHUTDOWN", date: { gte: s.fromDate, lte: s.toDate } } })).count;
    await prisma.shutdownPeriod.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
    await writeAudit(viewer, { module: "LEAVE", action: "DELETE", entityType: "ShutdownPeriod", entityId: s.id, summary: `Cancelled shutdown ${s.name}${removed ? `; removed ${removed} day(s) from the calendar` : ""}` });
    return done(PATHS, "Shutdown cancelled.");
  }
  return NO("Unknown action.");
}

// ---------------------------------------------------------------------------
//  Exceptions and assignment
// ---------------------------------------------------------------------------

export async function syncCalendarExceptionsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const year = num(f, "year") ?? new Date().getUTCFullYear();
  const r = await syncCalendarExceptions(viewer.tenantId, Number.isNaN(year) ? new Date().getUTCFullYear() : year);
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "CalendarException", summary: `Ran calendar checks: ${r.found} finding(s), ${r.open} open` });
  return done(PATHS, `${r.found} finding(s); ${r.open} open in the queue.`);
}

export async function calendarExceptionOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const x = await prisma.calendarException.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!x) return NO("Exception not found.");
  const op = str(f, "op");
  if (!["dismiss", "resolve", "reopen"].includes(op)) return NO("Unknown action.");
  const note = str(f, "note");
  if (op === "dismiss" && !note) return NO("Say why it can be ignored.");
  await prisma.calendarException.update({ where: { id: x.id }, data: op === "reopen" ? { status: "OPEN", resolvedAt: null, resolvedBy: null } : { status: op === "dismiss" ? "DISMISSED" : "RESOLVED", note: note || x.note, resolvedAt: new Date(), resolvedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "CalendarException", entityId: x.id, summary: `${op}: ${x.summary}${note ? ` — ${note}` : ""}` });
  return done(PATHS, "Updated.");
}

/** Assign people to a calendar from a date; applied once a time administrator approves. */
export async function proposeCalendarAssignmentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HOLIDAY_MANAGE);
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: str(f, "calendarId"), tenantId: viewer.tenantId } });
  if (!cal) return { ok: false, message: "Pick a calendar.", errors: { calendarId: "Required" } };
  let ids = list(f, "employeeIds");
  const locationId = str(f, "locationId");
  if (!ids.length && locationId) ids = (await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.HOLIDAY_MANAGE), { locationId, status: { notIn: ["EXITED"] } }] }, select: { id: true } })).map((e) => e.id);
  if (!ids.length) return NO("Pick employees or a location.");
  const n = await prisma.employee.count({ where: { AND: [scopedEmployeeWhere(viewer, P.HOLIDAY_MANAGE), { id: { in: ids } }] } });
  if (n !== ids.length) return NO("Some of those employees are outside your scope.");
  const effectiveFrom = day(str(f, "effectiveFrom")) ?? new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const summary = `Assign ${ids.length} employee(s) to ${cal.name} ${cal.year} from ${effectiveFrom.toISOString().slice(0, 10)}`;
  const c = await prisma.timeConfigChange.create({ data: { tenantId: viewer.tenantId, kind: "CALENDAR_ASSIGNMENT", targetId: cal.id, summary, payload: { calendarId: cal.id, employeeIds: ids, effectiveFrom: effectiveFrom.toISOString().slice(0, 10) }, requestedBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "TIME_CONFIG_CHANGE", entityId: c.id, title: summary, details: str(f, "reason") || null, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.timeConfigChange.delete({ where: { id: c.id } }); return NO(wf.message); }
  await prisma.timeConfigChange.update({ where: { id: c.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LEAVE", action: "CREATE", entityType: "TimeConfigChange", entityId: c.id, summary: `Proposed: ${summary}` });
  return done(PATHS, wf.message === "Approved automatically." ? "Assigned." : "Sent for approval.");
}
