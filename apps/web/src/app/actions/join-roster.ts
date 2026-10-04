"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, notify, joinSettings, applyShiftSwap, rosterSnapshot, setRoster, rosterGrid,
  shiftTradeEligibility, checkSplitSegments, SHIFT_TEMPLATE_LIBRARY, isHhmm, shiftWindow, restHoursBetween,
} from "@keka/services";
import { weeklyOffConfigFrom, WEEKDAYS, type Weekday, type WeekdayRule } from "@keka/time";
import { requireAuth, requireViewer, canAny, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { jstr as str, jnum as num, jday as day, jlist as list, tenantEmployee } from "@/lib/join-depth";

/**
 * Shift & roster depth: employee-to-employee shift swaps and a swap
 * marketplace (eligibility rules, peer acceptance, manager approval through
 * the workflow engine), shift preferences, open shifts with vacancy alerts
 * and bidding, minimum / maximum staffing rules, roster publication with a
 * versioned snapshot and approval, the shift template library, split
 * shifts, and approval-gated workweek and shift-cycle changes.
 */

const P = PERMISSIONS;
const PATHS = ["/attendance/roster", "/attendance/roster/ops", "/me/shifts", "/time/shifts", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
//  Shift swaps
// ---------------------------------------------------------------------------

async function cellOf(employeeId: string, d: Date) {
  return (await rosterGrid([employeeId], d, 1)).get(employeeId)?.[0] ?? null;
}

async function swapsThisMonth(tenantId: string, employeeId: string, d: Date) {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return prisma.shiftSwapRequest.count({ where: { tenantId, requesterId: employeeId, requesterDate: { gte: from, lt: to }, status: { notIn: ["CANCELLED", "DECLINED", "REJECTED"] } } });
}

async function onLeave(employeeId: string, d: Date) {
  return (await prisma.leaveRequest.count({ where: { employeeId, status: "APPROVED", fromDate: { lte: d }, toDate: { gte: d } } })) > 0;
}

/** Whether taking `cell` on date d keeps `employeeId`'s rest periods. */
async function restOk(tenantId: string, employeeId: string, d: Date, shiftId: string | null): Promise<boolean> {
  if (!shiftId) return true;
  const s = await joinSettings(tenantId);
  const shifts = new Map((await prisma.shift.findMany({ where: { tenantId } })).map((x) => [x.id, x]));
  const me = shifts.get(shiftId);
  if (!me) return true;
  const grid = (await rosterGrid([employeeId], new Date(d.getTime() - DAY), 3)).get(employeeId) ?? [];
  const w = shiftWindow(me);
  const [prev, , next] = grid;
  if (prev && !prev.off && prev.shiftId && shifts.get(prev.shiftId) && restHoursBetween({ date: new Date(`${prev.date}T00:00:00Z`), ...shiftWindow(shifts.get(prev.shiftId)!) }, { date: d, ...w }) < s.minRestHours) return false;
  if (next && !next.off && next.shiftId && shifts.get(next.shiftId) && restHoursBetween({ date: d, ...w }, { date: new Date(`${next.date}T00:00:00Z`), ...shiftWindow(shifts.get(next.shiftId)!) }) < s.minRestHours) return false;
  return true;
}

async function sendSwapForApproval(tenantId: string, swapId: string, requesterUserId: string | null, requesterEmployeeId: string, title: string, actorUserId: string): Promise<ActionState> {
  const s = await joinSettings(tenantId);
  if (!s.swapRequiresApproval) {
    await prisma.shiftSwapRequest.update({ where: { id: swapId }, data: { status: "PENDING_APPROVAL" } });
    const r = await applyShiftSwap(tenantId, swapId);
    return { ok: r.ok, message: r.ok ? "Swap applied to the roster (no approval needed)." : r.message };
  }
  await prisma.shiftSwapRequest.update({ where: { id: swapId }, data: { status: "PENDING_APPROVAL" } });
  const wf = await startWorkflow({ tenantId, entityType: "SHIFT_SWAP", entityId: swapId, title, requesterUserId: requesterUserId ?? actorUserId, subjectEmployeeId: requesterEmployeeId });
  if (!wf.ok) { await prisma.shiftSwapRequest.update({ where: { id: swapId }, data: { status: "PENDING_PEER" } }); return NO(wf.message); }
  await prisma.shiftSwapRequest.update({ where: { id: swapId }, data: { workflowRequestId: wf.requestId } });
  return { ok: true, message: wf.message === "Approved automatically." ? "Swap approved and applied." : "Sent to the manager for approval." };
}

/** Ask a colleague to swap, or post the shift to the marketplace. */
export async function requestShiftSwapAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("No employee record.");
  const date = day(str(f, "date"));
  if (!date) return { ok: false, message: "Pick the date of your shift.", errors: { date: "Required" } };
  const mine = await cellOf(me.id, date);
  if (!mine || mine.off || !mine.shiftId) return NO("You are not rostered on a shift that day.");
  const marketplace = str(f, "marketplace") === "on" || str(f, "marketplace") === "true";
  const counterpart = marketplace ? null : await tenantEmployee(viewer, str(f, "counterpartId"));
  if (!marketplace && !counterpart) return { ok: false, message: "Pick a colleague, or post it to the marketplace.", errors: { counterpartId: "Required" } };
  const cDate = !marketplace ? day(str(f, "counterpartDate")) ?? date : null;
  const s = await joinSettings(viewer.tenantId);
  const self = await prisma.employee.findFirst({ where: { id: me.id }, select: { id: true, departmentId: true, status: true } });
  const hours = (date.getTime() - Date.now()) / 3_600_000;
  let cRest = true, cLeave = false;
  if (counterpart && cDate) {
    const theirs = await cellOf(counterpart.id, cDate);
    if (cDate.getTime() !== date.getTime() && (!theirs || theirs.off || !theirs.shiftId)) return NO(`${counterpart.displayName} is not on a shift that day to swap with.`);
    cLeave = await onLeave(counterpart.id, date);
    cRest = await restOk(viewer.tenantId, counterpart.id, date, mine.shiftId);
  }
  const chk = shiftTradeEligibility({ requester: self!, counterpart: counterpart ? { id: counterpart.id, departmentId: counterpart.departmentId, status: counterpart.status } : null, settings: s, hoursUntilShift: hours, swapsThisMonth: await swapsThisMonth(viewer.tenantId, me.id, date), counterpartOnLeave: cLeave, restOk: cRest });
  if (!chk.ok) return NO(chk.reasons.join(" "));
  const sw = await prisma.shiftSwapRequest.create({ data: { tenantId: viewer.tenantId, requesterId: me.id, requesterDate: date, requesterShiftId: mine.shiftId, counterpartId: counterpart?.id ?? null, counterpartDate: cDate, isMarketplace: marketplace, reason: str(f, "reason") || null, status: marketplace ? "OPEN" : "PENDING_PEER" } });
  if (counterpart) {
    await notify({ tenantId: viewer.tenantId, userIds: [counterpart.userId], kind: "ATTENDANCE", title: `${me.displayName} asked to swap shifts with you`, body: `${iso(date)}${cDate && cDate.getTime() !== date.getTime() ? ` for your ${iso(cDate)}` : ""}`, link: "/me/shifts" });
  } else {
    const peers = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { not: me.id }, status: { notIn: ["EXITED", "PREBOARDING", "INACTIVE"] }, ...(s.swapSameDepartmentOnly ? { departmentId: self!.departmentId } : {}) }, select: { userId: true }, take: 200 });
    await notify({ tenantId: viewer.tenantId, userIds: peers.map((p) => p.userId), kind: "ATTENDANCE", title: `Shift up for grabs on ${iso(date)}`, body: `${me.displayName} posted a shift to the marketplace.`, link: "/me/shifts?tab=marketplace" });
  }
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "ShiftSwapRequest", entityId: sw.id, summary: marketplace ? `Posted the ${iso(date)} shift to the marketplace` : `Asked ${counterpart!.displayName} to swap the ${iso(date)} shift` });
  return done(PATHS, marketplace ? "Posted to the marketplace." : `Asked ${counterpart!.displayName}.`);
}

/** The colleague accepts or declines a direct swap. */
export async function respondShiftSwapAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("No employee record.");
  const sw = await prisma.shiftSwapRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, counterpartId: me.id, status: "PENDING_PEER" } });
  if (!sw) return NO("Swap request not found.");
  const requester = await tenantEmployee(viewer, sw.requesterId);
  if (!requester) return NO("Swap request not found.");
  if (str(f, "response") === "decline") {
    await prisma.shiftSwapRequest.update({ where: { id: sw.id }, data: { status: "DECLINED", peerRespondedAt: new Date() } });
    await notify({ tenantId: viewer.tenantId, userIds: requester.userId ? [requester.userId] : [], kind: "ATTENDANCE", title: `${me.displayName} declined your shift swap`, link: "/me/shifts" });
    await writeAudit(viewer, { module: "ATTENDANCE", action: "REJECT", entityType: "ShiftSwapRequest", entityId: sw.id, summary: `Declined ${requester.displayName}'s swap for ${iso(sw.requesterDate)}` });
    return done(PATHS, "Declined.");
  }
  await prisma.shiftSwapRequest.update({ where: { id: sw.id }, data: { peerRespondedAt: new Date() } });
  const r = await sendSwapForApproval(viewer.tenantId, sw.id, requester.userId, requester.id, `Shift swap: ${requester.displayName} ↔ ${me.displayName} on ${iso(sw.requesterDate)}`, viewer.user.id);
  if (!r.ok) return r;
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftSwapRequest", entityId: sw.id, summary: `Accepted ${requester.displayName}'s swap for ${iso(sw.requesterDate)}` });
  return done(PATHS, r.message ?? "Done.");
}

/** Pick up a shift from the marketplace. */
export async function claimShiftSwapAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("No employee record.");
  const sw = await prisma.shiftSwapRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "OPEN", isMarketplace: true } });
  if (!sw) return NO("That shift has already been taken.");
  const requester = await tenantEmployee(viewer, sw.requesterId);
  const self = await prisma.employee.findFirst({ where: { id: me.id }, select: { id: true, departmentId: true, status: true } });
  if (!requester || !self) return NO("Swap not found.");
  const s = await joinSettings(viewer.tenantId);
  const mine = await cellOf(me.id, sw.requesterDate);
  if (mine && !mine.off && mine.shiftId) return NO("You are already working that day.");
  const chk = shiftTradeEligibility({ requester: { id: requester.id, departmentId: requester.departmentId, status: requester.status }, counterpart: self, settings: { ...s, swapMaxPerMonth: 999 }, hoursUntilShift: (sw.requesterDate.getTime() - Date.now()) / 3_600_000, swapsThisMonth: 0, counterpartOnLeave: await onLeave(me.id, sw.requesterDate), restOk: await restOk(viewer.tenantId, me.id, sw.requesterDate, sw.requesterShiftId) });
  if (!chk.ok) return NO(chk.reasons.map((r) => r.replace("That colleague is", "You are")).join(" "));
  const u = await prisma.shiftSwapRequest.updateMany({ where: { id: sw.id, status: "OPEN" }, data: { counterpartId: me.id, status: "PENDING_PEER", peerRespondedAt: new Date() } });
  if (!u.count) return NO("That shift has already been taken.");
  const r = await sendSwapForApproval(viewer.tenantId, sw.id, requester.userId, requester.id, `Shift pick-up: ${me.displayName} takes ${requester.displayName}'s ${iso(sw.requesterDate)} shift`, viewer.user.id);
  if (!r.ok) { await prisma.shiftSwapRequest.update({ where: { id: sw.id }, data: { counterpartId: null, status: "OPEN" } }); return r; }
  await notify({ tenantId: viewer.tenantId, userIds: requester.userId ? [requester.userId] : [], kind: "ATTENDANCE", title: `${me.displayName} picked up your ${iso(sw.requesterDate)} shift`, link: "/me/shifts" });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftSwapRequest", entityId: sw.id, summary: `Picked up ${requester.displayName}'s ${iso(sw.requesterDate)} shift from the marketplace` });
  return done(PATHS, r.message ?? "Done.");
}

export async function cancelShiftSwapAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const sw = await prisma.shiftSwapRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, requesterId: viewer.employee?.id ?? "-" } });
  if (!sw) return NO("Swap request not found.");
  if (!["OPEN", "PENDING_PEER"].includes(sw.status)) return NO(sw.status === "PENDING_APPROVAL" ? "It is with your manager — withdraw it from your requests in the inbox." : "It is already closed.");
  await prisma.shiftSwapRequest.update({ where: { id: sw.id }, data: { status: "CANCELLED" } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftSwapRequest", entityId: sw.id, summary: `Cancelled the swap for ${iso(sw.requesterDate)}` });
  return done(PATHS, "Cancelled.");
}

// ---------------------------------------------------------------------------
//  Preferences and open shifts
// ---------------------------------------------------------------------------

export async function saveShiftPreferenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("No employee record.");
  const shiftIds = list(f, "preferredShiftIds");
  if (shiftIds.length && (await prisma.shift.count({ where: { tenantId: viewer.tenantId, id: { in: shiftIds } } })) !== shiftIds.length) return NO("Pick shifts from the list.");
  const avoid = list(f, "avoidWeekdays").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const maxN = num(f, "maxNightsPerWeek");
  if (maxN !== null && (Number.isNaN(maxN) || maxN < 0 || maxN > 7)) return NO("Night shifts per week must be 0 to 7.");
  const data = { preferredShiftIds: shiftIds, avoidWeekdays: avoid, maxNightsPerWeek: maxN, note: str(f, "note") || null };
  await prisma.shiftPreference.upsert({ where: { employeeId: me.id }, create: { tenantId: viewer.tenantId, employeeId: me.id, ...data }, update: data });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftPreference", entityId: me.id, summary: "Updated shift preferences", newValue: data });
  return done(PATHS, "Preferences saved. Your roster planner will see them.");
}

export async function saveOpenShiftAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const shift = await prisma.shift.findFirst({ where: { id: str(f, "shiftId"), tenantId: viewer.tenantId, isActive: true } });
  if (!shift) return { ok: false, message: "Pick a shift.", errors: { shiftId: "Required" } };
  const date = day(str(f, "date"));
  if (!date) return { ok: false, message: "Pick a date.", errors: { date: "Required" } };
  if (date.getTime() < Date.now() - DAY) return NO("That date has passed.");
  const slots = num(f, "slots") ?? 1;
  if (Number.isNaN(slots) || slots < 1 || slots > 50) return NO("Slots must be 1 to 50.");
  const departmentId = str(f, "departmentId") || null, locationId = str(f, "locationId") || null;
  const o = await prisma.openShift.create({ data: { tenantId: viewer.tenantId, shiftId: shift.id, date, slots: Math.round(slots), departmentId, locationId, note: str(f, "note") || null, createdBy: viewer.user.id } });
  // Vacancy alert to eligible people.
  const eligible = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.SHIFT_MANAGE), { status: { notIn: ["EXITED", "PREBOARDING", "INACTIVE"] } }, departmentId ? { departmentId } : {}, locationId ? { locationId } : {}] }, select: { userId: true }, take: 500 });
  await notify({ tenantId: viewer.tenantId, userIds: eligible.map((e) => e.userId), kind: "ATTENDANCE", title: `Open shift: ${shift.name} on ${iso(date)}`, body: `${o.slots} slot(s). Bid from My Shifts.`, link: "/me/shifts?tab=open" });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OpenShift", entityId: o.id, summary: `Posted ${o.slots} open ${shift.name} slot(s) on ${iso(date)}; alerted ${eligible.length}` });
  return done(PATHS, `Posted. ${eligible.length} employee(s) alerted.`);
}

export async function bidOpenShiftAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return NO("No employee record.");
  const o = await prisma.openShift.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "OPEN" } });
  if (!o) return NO("That open shift is closed.");
  const emp = await tenantEmployee(viewer, me.id);
  if ((o.departmentId && emp?.departmentId !== o.departmentId) || (o.locationId && emp?.locationId !== o.locationId)) return NO("This shift is for another team or location.");
  if (str(f, "withdraw") === "true") {
    await prisma.openShiftBid.deleteMany({ where: { openShiftId: o.id, employeeId: me.id, status: "BID" } });
    return done(PATHS, "Bid withdrawn.");
  }
  const cell = await cellOf(me.id, o.date);
  if (cell && !cell.off && cell.shiftId) return NO("You are already working that day.");
  if (!(await restOk(viewer.tenantId, me.id, o.date, o.shiftId))) return NO("Taking it would break your minimum rest period.");
  await prisma.openShiftBid.upsert({ where: { openShiftId_employeeId: { openShiftId: o.id, employeeId: me.id } }, create: { openShiftId: o.id, employeeId: me.id, note: str(f, "note") || null }, update: { note: str(f, "note") || null, status: "BID" } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OpenShiftBid", entityId: o.id, summary: `Bid for the open shift on ${iso(o.date)}` });
  return done(PATHS, "Bid placed.");
}

export async function openShiftOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const o = await prisma.openShift.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId }, include: { bids: true } });
  if (!o) return NO("Open shift not found.");
  const op = str(f, "op");
  if (op === "cancel") {
    if (o.status !== "OPEN") return NO("Already closed.");
    await prisma.openShift.update({ where: { id: o.id }, data: { status: "CANCELLED" } });
  } else if (op === "award") {
    if (o.status !== "OPEN") return NO("Already closed.");
    const bid = o.bids.find((b) => b.id === str(f, "bidId") && b.status === "BID");
    if (!bid) return NO("Bid not found.");
    const emp = await prisma.employee.findFirst({ where: { AND: [scopedEmployeeWhere(viewer, P.SHIFT_MANAGE), { id: bid.employeeId }] }, select: { id: true, userId: true, displayName: true } });
    if (!emp) return NO("That bidder is outside your scope.");
    const r = await setRoster(viewer.tenantId, [{ employeeId: emp.id, date: o.date, value: { kind: "SHIFT", shiftId: o.shiftId } }]);
    if (!r.ok) return NO(r.message);
    await prisma.openShiftBid.update({ where: { id: bid.id }, data: { status: "AWARDED", decidedAt: new Date() } });
    const awarded = o.bids.filter((b) => b.status === "AWARDED").length + 1;
    if (awarded >= o.slots) {
      await prisma.openShift.update({ where: { id: o.id }, data: { status: "FILLED" } });
      await prisma.openShiftBid.updateMany({ where: { openShiftId: o.id, status: "BID" }, data: { status: "LOST", decidedAt: new Date() } });
    }
    await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "ATTENDANCE", title: `You got the open shift on ${iso(o.date)}`, link: "/me/shifts" });
    await writeAudit(viewer, { module: "ATTENDANCE", action: "APPROVE", entityType: "OpenShift", entityId: o.id, summary: `Awarded the ${iso(o.date)} open shift to ${emp.displayName}` });
    return done(PATHS, `Awarded to ${emp.displayName}; roster updated.`);
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "OpenShift", entityId: o.id, summary: `Open shift on ${iso(o.date)}: ${op}` });
  return done(PATHS, "Updated.");
}

// ---------------------------------------------------------------------------
//  Staffing rules and roster publication
// ---------------------------------------------------------------------------

export async function saveStaffingRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const id = str(f, "id");
  if (str(f, "op") === "delete") {
    const r = await prisma.staffingRule.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!r) return NO("Rule not found.");
    await prisma.staffingRule.delete({ where: { id } });
    await writeAudit(viewer, { module: "ATTENDANCE", action: "DELETE", entityType: "StaffingRule", entityId: id, summary: `Deleted staffing rule ${r.name}` });
    return done(PATHS, "Rule deleted.");
  }
  const name = str(f, "name");
  if (!name) return { ok: false, message: "Name the rule.", errors: { name: "Required" } };
  const minStaff = num(f, "minStaff") ?? 0, maxStaff = num(f, "maxStaff");
  if (Number.isNaN(minStaff) || minStaff < 0) return NO("Minimum must be zero or more.");
  if (maxStaff !== null && (Number.isNaN(maxStaff) || maxStaff < Math.max(1, minStaff))) return NO("Maximum must be at least the minimum.");
  if (!minStaff && maxStaff === null) return NO("Set a minimum, a maximum or both.");
  const shiftId = str(f, "shiftId") || null, departmentId = str(f, "departmentId") || null, locationId = str(f, "locationId") || null;
  if (shiftId && !(await prisma.shift.count({ where: { id: shiftId, tenantId: viewer.tenantId } }))) return NO("Shift not found.");
  const weekdays = list(f, "weekdays").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const data = { name: name.slice(0, 80), shiftId, departmentId, locationId, weekdays, minStaff: Math.round(minStaff), maxStaff: maxStaff === null ? null : Math.round(maxStaff) };
  let row;
  if (id) {
    if (!(await prisma.staffingRule.count({ where: { id, tenantId: viewer.tenantId } }))) return NO("Rule not found.");
    row = await prisma.staffingRule.update({ where: { id }, data });
  } else row = await prisma.staffingRule.create({ data: { tenantId: viewer.tenantId, ...data } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: id ? "UPDATE" : "CREATE", entityType: "StaffingRule", entityId: row.id, summary: `${id ? "Updated" : "Added"} staffing rule ${row.name} (min ${row.minStaff}${row.maxStaff !== null ? `, max ${row.maxStaff}` : ""})` });
  return done(PATHS, "Staffing rule saved.");
}

/** Snapshot a range of the roster and send it for approval; on approval it is published and everyone on it is told. */
export async function submitRosterPublicationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const from = day(str(f, "fromDate")), to = day(str(f, "toDate"));
  if (!from || !to || to < from) return NO("Pick a date range.");
  if ((to.getTime() - from.getTime()) / DAY > 62) return NO("Publish at most two months at a time.");
  const departmentId = str(f, "departmentId") || null, locationId = str(f, "locationId") || null;
  const emps = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.SHIFT_MANAGE), { status: { notIn: ["EXITED"] } }, departmentId ? { departmentId } : {}, locationId ? { locationId } : {}] }, select: { id: true } });
  if (!emps.length) return NO("Nobody in that team to publish for.");
  if (await prisma.rosterPublication.count({ where: { tenantId: viewer.tenantId, status: "PENDING_APPROVAL", fromDate: from, toDate: to, departmentId, locationId } })) return NO("That roster is already waiting for approval.");
  const snapshot = await rosterSnapshot(emps.map((e) => e.id), from, to);
  const title = str(f, "title") || `Roster ${iso(from)} – ${iso(to)}`;
  const p = await prisma.rosterPublication.create({ data: { tenantId: viewer.tenantId, title: title.slice(0, 120), fromDate: from, toDate: to, departmentId, locationId, status: "PENDING_APPROVAL", snapshot: snapshot as unknown as Prisma.InputJsonValue, assignmentCount: snapshot.length, submittedBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ROSTER_PUBLISH", entityId: p.id, title: `Publish roster: ${p.title}`, details: `${emps.length} employee(s), ${snapshot.length} day(s) rostered`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.rosterPublication.delete({ where: { id: p.id } }); return NO(wf.message); }
  await prisma.rosterPublication.update({ where: { id: p.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "RosterPublication", entityId: p.id, summary: `Submitted "${p.title}" for publication (${emps.length} employee(s))` });
  return done(PATHS, wf.message === "Approved automatically." ? "Published." : "Sent for approval.");
}

// ---------------------------------------------------------------------------
//  Shift library, split shifts, workweek and shift-cycle changes
// ---------------------------------------------------------------------------

export async function addShiftFromLibraryAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const t = SHIFT_TEMPLATE_LIBRARY.find((x) => x.code === str(f, "code"));
  if (!t) return NO("Pick a template.");
  const code = (str(f, "newCode") || t.code).toUpperCase().slice(0, 12);
  if (await prisma.shift.count({ where: { tenantId: viewer.tenantId, code } })) return NO(`A shift with code ${code} already exists — give it another code.`);
  const s = await prisma.shift.create({ data: { tenantId: viewer.tenantId, code, name: t.name, startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes, crossesMidnight: t.crossesMidnight, segments: t.segments ? (t.segments as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "Shift", entityId: s.id, summary: `Added shift ${s.name} (${code}) from the template library` });
  return done(PATHS, `Added ${s.name}.`);
}

/** Set a shift's extra segments: "16:00-20:00, 21:00-22:00". Empty clears the split. */
export async function saveSplitShiftAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SHIFT_MANAGE);
  const s = await prisma.shift.findFirst({ where: { id: str(f, "shiftId"), tenantId: viewer.tenantId } });
  if (!s) return NO("Shift not found.");
  const segs = [];
  for (const part of str(f, "segments").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split("-").map((x) => x.trim());
    if (!a || !b || !isHhmm(a) || !isHhmm(b)) return { ok: false, message: `"${part}" is not a HH:MM-HH:MM segment.`, errors: { segments: "Format" } };
    segs.push({ start: a, end: b });
  }
  const err = checkSplitSegments(s, segs);
  if (err) return NO(err);
  await prisma.shift.update({ where: { id: s.id }, data: { segments: segs.length ? segs : Prisma.DbNull } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "Shift", entityId: s.id, summary: segs.length ? `Split ${s.name}: ${s.startTime}–${s.endTime} + ${segs.map((g) => `${g.start}–${g.end}`).join(", ")}` : `Removed the split from ${s.name}` });
  return done(PATHS, segs.length ? "Split shift saved." : "Split removed.");
}

const RULES: WeekdayRule[] = ["WORKING", "ALL", "ALT_2_4", "ALT_1_3_5"];

/** Propose a workweek (weekly-off pattern) or shift-cycle change; it applies once approved. */
export async function proposeTimeConfigChangeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const kind = str(f, "kind");
  const targetId = str(f, "targetId") || null;
  let payload: Record<string, unknown>, summary: string;
  if (kind === "WORKWEEK") {
    if (!canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE])) return NO("You cannot change workweeks.");
    const cur = targetId ? await prisma.weeklyOffPolicy.findFirst({ where: { id: targetId, tenantId: viewer.tenantId } }) : null;
    if (targetId && !cur) return NO("Workweek not found.");
    const name = cur?.name ?? str(f, "name");
    if (!name) return { ok: false, message: "Name the workweek.", errors: { name: "Required" } };
    const rows: Partial<Record<Weekday, { rule: WeekdayRule }>> = {};
    for (const d of WEEKDAYS) {
      const rule = (str(f, `rule_${d}`) || "WORKING") as WeekdayRule;
      if (!RULES.includes(rule)) return NO(`Check ${d}.`);
      rows[d] = { rule };
    }
    const config = weeklyOffConfigFrom(rows);
    if (!Object.keys(config).length) return NO("Mark at least one day off.");
    payload = { name, config };
    summary = `${cur ? "Change" : "Create"} workweek ${name}: off ${Object.entries(config).map(([d, v]) => `${d}${v!.instances === "ALL" ? "" : ` (${(v!.instances as number[]).join(",")})`}`).join(", ")}`;
  } else if (kind === "SHIFT_CYCLE") {
    if (!can(viewer, P.SHIFT_MANAGE)) return NO("You cannot change shift cycles.");
    const cur = targetId ? await prisma.rosterPattern.findFirst({ where: { id: targetId, tenantId: viewer.tenantId } }) : null;
    if (targetId && !cur) return NO("Shift cycle not found.");
    const name = cur?.name ?? str(f, "name");
    if (!name) return { ok: false, message: "Name the cycle.", errors: { name: "Required" } };
    const shifts = new Map((await prisma.shift.findMany({ where: { tenantId: viewer.tenantId, isActive: true } })).map((s) => [s.code.toUpperCase(), s.id]));
    const steps = [];
    for (const code of str(f, "steps").split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)) {
      if (code === "OFF") steps.push({ shiftId: null, off: true });
      else if (shifts.has(code)) steps.push({ shiftId: shifts.get(code)!, off: false });
      else return { ok: false, message: `No active shift with code ${code}.`, errors: { steps: "Unknown code" } };
    }
    if (!steps.length || steps.length > 366) return NO("List the cycle's days as shift codes or OFF.");
    payload = { name, steps };
    summary = `${cur ? "Change" : "Create"} shift cycle ${name}: ${str(f, "steps").toUpperCase()}`;
  } else if (kind === "CALENDAR_ASSIGNMENT") {
    return NO("Assign calendars from Time › Holidays.");
  } else return NO("Pick what to change.");
  if (await prisma.timeConfigChange.count({ where: { tenantId: viewer.tenantId, kind, targetId, status: "PENDING_APPROVAL" } })) return NO("A change to that is already waiting for approval.");
  const c = await prisma.timeConfigChange.create({ data: { tenantId: viewer.tenantId, kind, targetId, summary: summary.slice(0, 300), payload: payload as Prisma.InputJsonValue, requestedBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "TIME_CONFIG_CHANGE", entityId: c.id, title: summary.slice(0, 120), details: str(f, "reason") || null, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!wf.ok) { await prisma.timeConfigChange.delete({ where: { id: c.id } }); return NO(wf.message); }
  await prisma.timeConfigChange.update({ where: { id: c.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "TimeConfigChange", entityId: c.id, summary: `Proposed: ${summary}` });
  return done([...PATHS, "/time/holidays"], wf.message === "Approved automatically." ? "Approved and applied." : "Sent for approval.");
}
