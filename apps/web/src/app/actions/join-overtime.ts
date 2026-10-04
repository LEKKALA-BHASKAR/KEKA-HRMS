"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, employeeOvertime, overtimeAlertSweep, compOffExpiryReminders, parseOtTiers, isHhmm, OT_DAY_TYPES,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { jstr as str, jnum as num, jlist as list, scopedEmployee, managesEmployee } from "@/lib/join-depth";

/**
 * Overtime & comp-off depth: overtime rules (eligibility by band, pay grade,
 * shift and location; multiplier tables per day type; premium windows;
 * weekly threshold; daily / weekly / monthly caps; pre- and post-approval
 * timing; alert thresholds) approved before they take effect; approval of
 * overtime above a cap; threshold and anomaly alerts; comp-off expiry
 * reminders.
 */

const P = PERMISSIONS;
const PATHS = ["/time/overtime", "/time/overtime/rules", "/me/attendance", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });
const hours = (f: FormData, k: string): number | null | "bad" => { const v = num(f, k); if (v === null) return null; return Number.isNaN(v) || v < 0 || v > 744 ? "bad" : Math.round(v * 60); };

export async function saveOvertimeRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const id = str(f, "id");
  const cur = id ? await prisma.overtimeRule.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
  if (id && !cur) return NO("Rule not found.");
  if (cur && !["DRAFT", "REJECTED"].includes(cur.status)) return NO("Only a draft can be edited — copy an active rule to change it.");
  const name = str(f, "name");
  if (!name) return { ok: false, message: "Name the rule.", errors: { name: "Required" } };
  const tiers: Record<string, unknown> = {};
  for (const d of OT_DAY_TYPES) {
    const text = str(f, `tiers_${d}`);
    if (!text && d !== "WORKDAY") continue;
    const r = parseOtTiers(text);
    if (r.error) return { ok: false, message: `${d.replace("_", " ").toLowerCase()}: ${r.error}`, errors: { [`tiers_${d}`]: r.error } };
    tiers[d] = r.tiers;
  }
  const windows = [];
  for (const part of str(f, "windows").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*[:@x]\s*(\d+(?:\.\d+)?)$/.exec(part);
    if (!m || !isHhmm(m[1]!) || !isHhmm(m[2]!) || Number(m[3]) <= 0 || Number(m[3]) > 3) return { ok: false, message: `"${part}" is not HH:MM-HH:MM:premium (e.g. 22:00-06:00:0.5).`, errors: { windows: "Format" } };
    windows.push({ start: m[1]!, end: m[2]!, multiplier: Number(m[3]) });
  }
  const wk = hours(f, "weeklyThresholdHours"), dc = hours(f, "dailyCapHours"), wc = hours(f, "weeklyCapHours"), mc = hours(f, "monthlyCapHours"), al = hours(f, "alertMonthlyHours");
  if ([wk, dc, wc, mc, al].includes("bad")) return NO("Hours must be between 0 and 744.");
  const minMinutes = num(f, "minMinutes") ?? 0, postFactoDays = num(f, "postFactoDays"), priority = num(f, "priority") ?? 0;
  if (Number.isNaN(minMinutes) || minMinutes < 0 || Number.isNaN(priority)) return NO("Check the minimum minutes and priority.");
  if (postFactoDays !== null && (Number.isNaN(postFactoDays) || postFactoDays < 0 || postFactoDays > 90)) return NO("The claim window must be 0 to 90 days.");
  const ids = async (k: string, model: "band" | "payGrade" | "shift" | "location") => {
    const v = list(f, k);
    if (!v.length) return v;
    const n = await (prisma[model] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { tenantId: viewer.tenantId, id: { in: v } } });
    if (n !== v.length) throw new Error(k);
    return v;
  };
  let bandIds: string[], payGradeIds: string[], shiftIds: string[], locationIds: string[];
  try { [bandIds, payGradeIds, shiftIds, locationIds] = [await ids("bandIds", "band"), await ids("payGradeIds", "payGrade"), await ids("shiftIds", "shift"), await ids("locationIds", "location")]; }
  catch { return NO("Pick eligibility values from the lists."); }
  const data = {
    name: name.slice(0, 80), priority: Math.round(priority), bandIds, payGradeIds, shiftIds, locationIds, tiers: tiers as Prisma.InputJsonValue, windows: windows.length ? windows : Prisma.DbNull,
    weeklyThresholdMinutes: wk as number | null, dailyCapMinutes: dc as number | null, weeklyCapMinutes: wc as number | null, monthlyCapMinutes: mc as number | null, alertMonthlyMinutes: al as number | null,
    minMinutes: Math.round(minMinutes), requirePreApproval: str(f, "requirePreApproval") === "on" || str(f, "requirePreApproval") === "true", postFactoDays: postFactoDays === null ? null : Math.round(postFactoDays),
  };
  const row = cur ? await prisma.overtimeRule.update({ where: { id: cur.id }, data: { ...data, status: "DRAFT" } }) : await prisma.overtimeRule.create({ data: { tenantId: viewer.tenantId, createdBy: viewer.user.id, ...data } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: cur ? "UPDATE" : "CREATE", entityType: "OvertimeRule", entityId: row.id, summary: `${cur ? "Edited" : "Drafted"} overtime rule ${row.name}`, newValue: { ...data, windows } });
  return done(PATHS, "Saved as a draft. Submit it for approval to put it into effect.");
}

export async function overtimeRuleOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const r = await prisma.overtimeRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return NO("Rule not found.");
  const op = str(f, "op");
  let msg = "Updated.";
  if (op === "submit") {
    if (!["DRAFT", "REJECTED"].includes(r.status)) return NO("Only a draft can be submitted.");
    await prisma.overtimeRule.update({ where: { id: r.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "OVERTIME_RULE", entityId: r.id, title: `Overtime rule: ${r.name}`, details: `Priority ${r.priority}${r.monthlyCapMinutes ? `, monthly cap ${r.monthlyCapMinutes / 60} h` : ""}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.overtimeRule.update({ where: { id: r.id }, data: { status: r.status } }); return NO(wf.message); }
    await prisma.overtimeRule.update({ where: { id: r.id }, data: { workflowRequestId: wf.requestId } });
    msg = wf.message === "Approved automatically." ? "Rule active." : "Sent for approval.";
  } else if (op === "retire") {
    if (r.status !== "ACTIVE") return NO("Only an active rule can be retired.");
    await prisma.overtimeRule.update({ where: { id: r.id }, data: { status: "RETIRED" } });
    msg = "Rule retired.";
  } else if (op === "copy") {
    const { id: _id, createdAt: _c, updatedAt: _u, workflowRequestId: _w, status: _s, tenantId: _t, ...rest } = r;
    const c = await prisma.overtimeRule.create({ data: { ...rest, tenantId: viewer.tenantId, name: `${r.name} (copy)`.slice(0, 80), tiers: r.tiers as Prisma.InputJsonValue, windows: r.windows === null ? Prisma.DbNull : (r.windows as Prisma.InputJsonValue), createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OvertimeRule", entityId: c.id, summary: `Copied overtime rule ${r.name}` });
    return done(PATHS, "Copied as a draft.");
  } else if (op === "delete") {
    if (r.status !== "DRAFT" && r.status !== "REJECTED") return NO("Only a draft can be deleted.");
    await prisma.overtimeRule.delete({ where: { id: r.id } });
    msg = "Draft deleted.";
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "ATTENDANCE", action: op === "delete" ? "DELETE" : "UPDATE", entityType: "OvertimeRule", entityId: r.id, summary: `Overtime rule ${r.name}: ${op}` });
  return done(PATHS, msg);
}

/** Ask for overtime cut by a cap to be paid anyway; the manager and a time administrator approve. */
export async function raiseOvertimeExceptionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const empId = str(f, "employeeId");
  const emp = can(viewer, P.ATTENDANCE_MANAGE) ? await scopedEmployee(viewer, empId, P.ATTENDANCE_MANAGE) : null;
  if (!emp && !(await managesEmployee(viewer, empId))) return NO("Only the manager or a time administrator can raise this.");
  const year = num(f, "year"), month = num(f, "month");
  if (!year || !month || Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) return NO("Pick the month.");
  const reason = str(f, "reason");
  if (!reason) return { ok: false, message: "Explain why the extra hours should be paid.", errors: { reason: "Required" } };
  const res = await employeeOvertime(viewer.tenantId, empId, year, month);
  if (!res?.rule) return NO("No overtime rule with caps covers this employee.");
  const already = await prisma.overtimeException.aggregate({ where: { tenantId: viewer.tenantId, employeeId: empId, year, month, status: { in: ["PENDING", "APPROVED"] } }, _sum: { excessMinutes: true } });
  const excess = res.result.excessMinutes - (already._sum.excessMinutes ?? 0);
  if (excess <= 0) return NO("Nothing above the caps is left to approve for that month.");
  const name = (await prisma.employee.findFirst({ where: { id: empId, tenantId: viewer.tenantId }, select: { displayName: true } }))?.displayName ?? "";
  const x = await prisma.overtimeException.create({ data: { tenantId: viewer.tenantId, employeeId: empId, year, month, excessMinutes: excess, reason, ruleId: res.rule.id, raisedBy: viewer.user.id } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "OVERTIME_EXCEPTION", entityId: x.id, title: `Pay ${Math.round(excess / 6) / 10} h overtime above the cap: ${name} (${year}-${String(month).padStart(2, "0")})`, details: reason, requesterUserId: viewer.user.id, subjectEmployeeId: empId });
  if (!wf.ok) { await prisma.overtimeException.delete({ where: { id: x.id } }); return NO(wf.message); }
  await prisma.overtimeException.update({ where: { id: x.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "CREATE", entityType: "OvertimeException", entityId: x.id, summary: `Raised an overtime cap exception for ${name}: ${excess} min` });
  return done(PATHS, wf.message === "Approved automatically." ? "Approved for payment." : "Sent for approval.");
}

export async function runOvertimeAlertsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const now = new Date();
  const year = num(f, "year") ?? now.getUTCFullYear(), month = num(f, "month") ?? now.getUTCMonth() + 1;
  if (Number.isNaN(year) || Number.isNaN(month)) return NO("Pick the month.");
  const n = await overtimeAlertSweep(viewer.tenantId, year, month);
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "OvertimeAlert", summary: `Ran overtime checks for ${year}-${month}: ${n} new alert(s)` });
  return done(PATHS, n ? `${n} new alert(s).` : "No new alerts.");
}

export async function overtimeAlertOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const a = await prisma.overtimeAlert.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!a) return NO("Alert not found.");
  if (a.status !== "OPEN") return NO("Already acknowledged.");
  await prisma.overtimeAlert.update({ where: { id: a.id }, data: { status: "ACKNOWLEDGED", acknowledgedBy: viewer.user.id, acknowledgedAt: new Date() } });
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "OvertimeAlert", entityId: a.id, summary: `Acknowledged: ${a.detail}` });
  return done(PATHS, "Acknowledged.");
}

export async function runCompOffRemindersAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTENDANCE_MANAGE);
  const n = await compOffExpiryReminders(viewer.tenantId);
  await writeAudit(viewer, { module: "LEAVE", action: "UPDATE", entityType: "OvertimeAlert", summary: `Sent ${n} comp-off expiry reminder(s)` });
  return done(PATHS, n ? `Reminded ${n} employee(s).` : "No comp off is about to lapse.");
}
