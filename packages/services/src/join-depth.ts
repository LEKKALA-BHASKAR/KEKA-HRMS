import { prisma, Prisma } from "@keka/db";
import type { WeeklyOffConfig } from "@keka/time";
import { notify, usersWithPermission } from "./lifecycle";
import { employeeHolidayCalendarIds } from "./time";
import { rosterGrid, setRoster, patternSteps } from "./roster";
import { monthlyWages } from "./time-requests";
import type { StepSpec } from "./governance-math";
import {
  type JoinWorkflowType, type ReadinessItem, type CalHoliday, type OtDay, type SnapshotRow,
  pickScopedTemplate, preboardingDueDate, preboardReminderDue, renderPrejoinText, prejoinSendDue, milestonePlan,
  escalationLevelFor, mergeCalendarRevision, calendarConflicts, shutdownWorkingDays, weekendSubstitutes,
  computeOvertime, overtimeRuleFor, overtimeAnomalies, compOffExpiringSoon, PREBOARDING_OPEN, BGV_ADVERSE,
  type TemplateSnapshot,
} from "./join-depth-math";

/**
 * Joining & time depth — the database side: settings, the workflow routes
 * and effects for every approval this area raises, preboarding plans,
 * reminders and pre-joining messages, onboarding milestones, escalation and
 * template revisions, verification case events, shift swaps, roster
 * snapshots, holiday calendar publication and checks, approved time
 * configuration changes, and overtime computation and alerts.
 *
 * Starting a workflow happens in the server actions (the engine imports
 * this file for routes and effects, so this file never imports the engine).
 */

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoKey = (d: Date) => d.toISOString().slice(0, 10);
type Outcome = "APPROVED" | "REJECTED" | "WITHDRAWN";

// ---------------------------------------------------------------------------
//  Settings and audit
// ---------------------------------------------------------------------------

export async function joinSettings(tenantId: string) {
  return (await prisma.joinSetting.findUnique({ where: { tenantId } })) ?? (await prisma.joinSetting.create({ data: { tenantId } }));
}

/** Audit entry for system-side changes in this area. */
export async function joinAudit(tenantId: string, actorUserId: string | null, opts: { module?: "LIFECYCLE" | "ATTENDANCE" | "LEAVE"; action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "EXPORT"; entityType: string; entityId?: string | null; summary: string; newValue?: unknown }) {
  const actor = actorUserId ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({
    data: {
      tenantId, module: opts.module ?? "LIFECYCLE", action: opts.action, entityType: opts.entityType, entityId: opts.entityId ?? null, summary: opts.summary,
      newValue: opts.newValue === undefined ? undefined : (opts.newValue as Prisma.InputJsonValue),
      actorId: actor ? actorUserId : null, actorLabel: actor?.email ?? "system",
    },
  });
}

async function userOfEmployee(tenantId: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null;
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { userId: true } });
  return e?.userId ?? null;
}

// ---------------------------------------------------------------------------
//  Workflow routes and effects
// ---------------------------------------------------------------------------

const perm = (name: string, permission: string, order = 1): StepSpec => ({ order, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS" });
const manager = (order = 1): StepSpec => ({ order, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" });
const ONB = "lifecycle.onboarding.manage", BGV = "lifecycle.bgv.manage", SHIFT = "time.shift.manage", HOL = "time.holiday.manage", ATT = "time.attendance.manage";

/** Built-in approval routes for this area (used when no workflow definition is configured). */
export function joinBuiltInRoute(entityType: string, opts: { reviewerUserId?: string | null } = {}): StepSpec[] {
  const user = (name: string): StepSpec[] => opts.reviewerUserId ? [{ order: 1, name, approverType: "USER", approverUserId: opts.reviewerUserId, mode: "ANY", slaHours: 72, escalateTo: "ADMINS" }] : [];
  switch (entityType as JoinWorkflowType) {
    case "PREBOARDING_TASK":
    case "NEW_HIRE_FORM": return [perm("HR review", ONB)];
    case "PREJOIN_MESSAGE": return [perm("Onboarding communications review", ONB)];
    case "JOURNEY_TASK": return [perm("Onboarding sign-off", ONB)];
    case "ONBOARDING_PLAN": return [manager()];
    case "BUDDY_ASSIGNMENT": return user("Buddy accepts").length ? user("Buddy accepts") : [perm("Onboarding", ONB)];
    case "ORIENTATION_SESSION": return [perm("Onboarding scheduling", ONB)];
    case "BGV_RESULT": return [perm("Verification approver", BGV)];
    case "BGV_CHECK_ITEM": return [perm("Verification reviewer", BGV)];
    case "ROSTER_PUBLISH": return [perm("Roster approver", SHIFT)];
    case "SHIFT_SWAP": return [manager()];
    case "TIME_CONFIG_CHANGE": return [perm("Time administrator", ATT)];
    case "HOLIDAY_CALENDAR":
    case "HOLIDAY_RULE": return [perm("Holiday administrator", HOL)];
    case "OVERTIME_RULE": return [perm("Time administrator", ATT)];
    case "OVERTIME_EXCEPTION": return [manager(), perm("Time administrator", ATT, 2)];
    default: return [];
  }
}

/** Apply a finished approval to its record. Throws to leave the request in ERROR. */
export async function applyJoinEffect(req: { id: string; tenantId: string; entityType: string; entityId: string | null }, outcome: Outcome, actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  const ok = outcome === "APPROVED";
  const now = new Date();
  const back = outcome === "WITHDRAWN";
  switch (req.entityType as JoinWorkflowType) {
    case "PREBOARDING_TASK": {
      await prisma.preboardingTask.updateMany({ where: { id, tenantId: t, status: "SUBMITTED" }, data: ok ? { status: "APPROVED", decidedAt: now, decidedBy: actorUserId } : { status: back ? "PENDING" : "REJECTED", decidedAt: now, decidedBy: actorUserId } });
      const task = await prisma.preboardingTask.findFirst({ where: { id, tenantId: t } });
      if (task && !back) await notify({ tenantId: t, userIds: [await userOfEmployee(t, task.employeeId)], kind: "LIFECYCLE", title: ok ? `Approved: ${task.title}` : `Please redo: ${task.title}`, link: "/me/onboarding" });
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "PreboardingTask", entityId: id, summary: `Preboarding task ${ok ? "approved" : outcome.toLowerCase()}` });
      return;
    }
    case "NEW_HIRE_FORM": {
      await prisma.newHireFormSubmission.updateMany({ where: { id, tenantId: t, status: "SUBMITTED" }, data: { status: ok ? "APPROVED" : back ? "SUBMITTED" : "REJECTED", decidedAt: now, decidedBy: actorUserId } });
      const sub = await prisma.newHireFormSubmission.findFirst({ where: { id, tenantId: t }, include: { form: { select: { name: true } } } });
      if (sub?.taskId) await prisma.preboardingTask.updateMany({ where: { id: sub.taskId, tenantId: t }, data: { status: ok ? "APPROVED" : back ? "PENDING" : "REJECTED", decidedAt: now, decidedBy: actorUserId } });
      if (sub && !back) await notify({ tenantId: t, userIds: [await userOfEmployee(t, sub.employeeId)], kind: "LIFECYCLE", title: ok ? `${sub.form.name} accepted` : `${sub.form.name} needs changes`, link: "/me/onboarding" });
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "NewHireFormSubmission", entityId: id, summary: `New-hire form ${ok ? "approved" : outcome.toLowerCase()}` });
      return;
    }
    case "PREJOIN_MESSAGE":
      await prisma.prejoinMessage.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : back ? "DRAFT" : "REJECTED" } });
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "PrejoinMessage", entityId: id, summary: `Pre-joining message ${ok ? "approved and active" : outcome.toLowerCase()}` });
      return;
    case "JOURNEY_TASK": {
      const task = await prisma.journeyTask.findFirst({ where: { id, journey: { tenantId: t } } });
      if (!task) return;
      if (ok) {
        await prisma.journeyTask.update({ where: { id }, data: { status: "DONE", approvalStatus: "APPROVED", completedAt: now } });
        const pending = await prisma.journeyTask.count({ where: { journeyId: task.journeyId, status: "PENDING" } });
        if (pending === 0) await prisma.journey.updateMany({ where: { id: task.journeyId, status: "ACTIVE" }, data: { status: "COMPLETED", completedAt: now } });
      } else {
        await prisma.journeyTask.update({ where: { id }, data: { approvalStatus: back ? null : "REJECTED" } });
      }
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "JourneyTask", entityId: id, summary: `Onboarding task "${task.title}" ${ok ? "signed off" : outcome.toLowerCase()}` });
      return;
    }
    case "ONBOARDING_PLAN":
      await prisma.journey.updateMany({ where: { id, tenantId: t }, data: { planStatus: ok ? "APPROVED" : back ? null : "REJECTED" } });
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "Journey", entityId: id, summary: `Onboarding plan ${ok ? "approved" : outcome.toLowerCase()}` });
      return;
    case "BUDDY_ASSIGNMENT": {
      await prisma.onboardingBuddy.updateMany({ where: { id, tenantId: t, status: "PROPOSED" }, data: ok ? { status: "ACTIVE", acceptedAt: now } : { status: back ? "CANCELLED" : "DECLINED" } });
      const b = await prisma.onboardingBuddy.findFirst({ where: { id, tenantId: t } });
      if (b && ok) await notify({ tenantId: t, userIds: [await userOfEmployee(t, b.employeeId)], kind: "LIFECYCLE", title: "You have an onboarding buddy", body: "Your buddy will help you settle in.", link: "/me/onboarding" });
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "OnboardingBuddy", entityId: id, summary: `Buddy assignment ${ok ? "accepted" : outcome.toLowerCase()}` });
      return;
    }
    case "ORIENTATION_SESSION": {
      await prisma.orientationSession.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "SCHEDULED" : back ? "DRAFT" : "REJECTED" } });
      if (ok) {
        const s = await prisma.orientationSession.findFirst({ where: { id, tenantId: t }, include: { attendees: true } });
        if (s) {
          const users = await prisma.employee.findMany({ where: { tenantId: t, id: { in: s.attendees.map((a) => a.employeeId) } }, select: { userId: true } });
          await notify({ tenantId: t, userIds: users.map((u) => u.userId), kind: "LIFECYCLE", title: `You are invited: ${s.title}`, body: `${s.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC${s.location ? ` · ${s.location}` : ""}`, link: "/me/onboarding" });
        }
      }
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "OrientationSession", entityId: id, summary: `Orientation session ${ok ? "scheduled" : outcome.toLowerCase()}` });
      return;
    }
    case "BGV_RESULT": {
      const c = await prisma.bgvCheck.findFirst({ where: { id, tenantId: t }, include: { employee: { select: { displayName: true } } } });
      if (!c || !c.proposedStatus) return;
      if (ok) {
        await prisma.bgvCheck.update({ where: { id }, data: { status: c.proposedStatus, completedAt: now, proposedStatus: null } });
        if (BGV_ADVERSE.includes(c.proposedStatus) || c.proposedStatus === "FAILED") {
          const hr = await usersWithPermission(t, BGV);
          await notify({ tenantId: t, userIds: hr, kind: "LIFECYCLE", title: `Background check ${c.proposedStatus.toLowerCase()}: ${c.employee?.displayName ?? ""}`, body: c.findings, link: `/onboarding/verification/${id}` });
        }
      } else {
        await prisma.bgvCheck.update({ where: { id }, data: { proposedStatus: null } });
      }
      await bgvEvent(t, id, ok ? "RESULT_APPROVED" : "RESULT_REJECTED", ok ? `Result ${c.proposedStatus.toLowerCase()} approved — case closed` : `Proposed result ${c.proposedStatus.toLowerCase()} ${outcome.toLowerCase()}`, actorUserId);
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "BgvCheck", entityId: id, summary: `Verification result ${c.proposedStatus} ${ok ? "approved" : outcome.toLowerCase()}` });
      return;
    }
    case "BGV_CHECK_ITEM": {
      const item = await prisma.bgvCheckItem.findFirst({ where: { id, tenantId: t } });
      if (!item || item.status !== "PENDING_REVIEW") return;
      await prisma.bgvCheckItem.update({ where: { id }, data: ok ? { status: item.proposedStatus ?? "DISCREPANCY", proposedStatus: null, completedAt: now } : { status: "IN_PROGRESS", proposedStatus: null } });
      await bgvEvent(t, item.bgvCheckId, ok ? "CHECK_CONFIRMED" : "CHECK_RETURNED", `${item.checkType.toLowerCase()} check ${ok ? `confirmed as ${(item.proposedStatus ?? "").toLowerCase().replace(/_/g, " ")}` : "sent back for more work"}`, actorUserId);
      await joinAudit(t, actorUserId, { action: ok ? "APPROVE" : "REJECT", entityType: "BgvCheckItem", entityId: id, summary: `${item.checkType} check review ${outcome.toLowerCase()}` });
      return;
    }
    case "ROSTER_PUBLISH": {
      const p = await prisma.rosterPublication.findFirst({ where: { id, tenantId: t } });
      if (!p || p.status !== "PENDING_APPROVAL") return;
      if (!ok) { await prisma.rosterPublication.update({ where: { id }, data: { status: back ? "DRAFT" : "REJECTED" } }); return; }
      const snap = Array.isArray(p.snapshot) ? (p.snapshot as unknown as SnapshotRow[]) : [];
      const prev = await prisma.rosterPublication.findFirst({ where: { tenantId: t, status: "PUBLISHED", fromDate: p.fromDate, toDate: p.toDate, departmentId: p.departmentId, locationId: p.locationId }, orderBy: { version: "desc" } });
      await prisma.rosterPublication.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: now, version: (prev?.version ?? 0) + 1 } });
      const emps = await prisma.employee.findMany({ where: { tenantId: t, id: { in: [...new Set(snap.map((r) => r.employeeId))] } }, select: { userId: true } });
      await notify({ tenantId: t, userIds: emps.map((e) => e.userId), kind: "ATTENDANCE", title: `Roster published: ${p.title}`, body: `${isoKey(p.fromDate)} to ${isoKey(p.toDate)}`, link: "/me/shifts" });
      await joinAudit(t, actorUserId, { module: "ATTENDANCE", action: "APPROVE", entityType: "RosterPublication", entityId: id, summary: `Roster "${p.title}" published to ${emps.length} employee(s)` });
      return;
    }
    case "SHIFT_SWAP": {
      const s = await prisma.shiftSwapRequest.findFirst({ where: { id, tenantId: t } });
      if (!s || s.status !== "PENDING_APPROVAL") return;
      if (ok) { await applyShiftSwap(t, id); }
      else await prisma.shiftSwapRequest.update({ where: { id }, data: { status: back ? "CANCELLED" : "REJECTED", decidedAt: now } });
      await notify({ tenantId: t, userIds: [await userOfEmployee(t, s.requesterId), await userOfEmployee(t, s.counterpartId)], kind: "ATTENDANCE", title: `Shift swap ${ok ? "approved" : outcome.toLowerCase()}`, link: "/me/shifts" });
      await joinAudit(t, actorUserId, { module: "ATTENDANCE", action: ok ? "APPROVE" : "REJECT", entityType: "ShiftSwapRequest", entityId: id, summary: `Shift swap ${ok ? "approved — roster updated" : outcome.toLowerCase()}` });
      return;
    }
    case "TIME_CONFIG_CHANGE": {
      const c = await prisma.timeConfigChange.findFirst({ where: { id, tenantId: t } });
      if (!c || c.status !== "PENDING_APPROVAL") return;
      if (ok) await applyTimeConfigChange(t, id);
      else await prisma.timeConfigChange.update({ where: { id }, data: { status: back ? "WITHDRAWN" : "REJECTED" } });
      await joinAudit(t, actorUserId, { module: "ATTENDANCE", action: ok ? "APPROVE" : "REJECT", entityType: "TimeConfigChange", entityId: id, summary: `${c.summary} — ${ok ? "approved and applied" : outcome.toLowerCase()}` });
      return;
    }
    case "HOLIDAY_CALENDAR": {
      const r = await prisma.holidayCalendarRevision.findFirst({ where: { id, tenantId: t } });
      if (!r || r.status !== "PENDING_APPROVAL") return;
      if (ok) await publishCalendarRevision(t, id, actorUserId);
      else await prisma.holidayCalendarRevision.update({ where: { id }, data: { status: back ? "DRAFT" : "REJECTED" } });
      await joinAudit(t, actorUserId, { module: "LEAVE", action: ok ? "APPROVE" : "REJECT", entityType: "HolidayCalendarRevision", entityId: id, summary: `Holiday calendar ${r.name} v${r.version} ${ok ? "approved and published" : outcome.toLowerCase()}` });
      return;
    }
    case "HOLIDAY_RULE":
      await prisma.holidayRule.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : back ? "RETIRED" : "REJECTED" } });
      await joinAudit(t, actorUserId, { module: "LEAVE", action: ok ? "APPROVE" : "REJECT", entityType: "HolidayRule", entityId: id, summary: `Holiday rule ${ok ? "approved and active" : outcome.toLowerCase()}` });
      return;
    case "OVERTIME_RULE":
      await prisma.overtimeRule.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : back ? "DRAFT" : "REJECTED" } });
      await joinAudit(t, actorUserId, { module: "ATTENDANCE", action: ok ? "APPROVE" : "REJECT", entityType: "OvertimeRule", entityId: id, summary: `Overtime rule ${ok ? "approved and active" : outcome.toLowerCase()}` });
      return;
    case "OVERTIME_EXCEPTION": {
      const x = await prisma.overtimeException.findFirst({ where: { id, tenantId: t } });
      if (!x || x.status !== "PENDING") return;
      if (ok) {
        const entryId = await payOvertimeMinutes(t, x.employeeId, x.year, x.month, x.excessMinutes);
        await prisma.overtimeException.update({ where: { id }, data: { status: "APPROVED", decidedAt: now, overtimeEntryId: entryId } });
      } else await prisma.overtimeException.update({ where: { id }, data: { status: back ? "WITHDRAWN" : "REJECTED", decidedAt: now } });
      await joinAudit(t, actorUserId, { module: "ATTENDANCE", action: ok ? "APPROVE" : "REJECT", entityType: "OvertimeException", entityId: id, summary: `Overtime above the cap (${x.excessMinutes} min) ${ok ? "approved for payment" : outcome.toLowerCase()}` });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
//  Preboarding
// ---------------------------------------------------------------------------

/** What is in place for a hire's first payroll and day one. */
export async function preboardingReadiness(tenantId: string, employeeId: string): Promise<ReadinessItem[]> {
  const fy = (() => { const d = new Date(); return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; })();
  const [emp, bank, pan, decl, fbp, contacts, salary, docs] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { payGroupId: true, user: { select: { lastLoginAt: true } } } }),
    prisma.employeeBankAccount.count({ where: { employeeId } }),
    prisma.employeeIdentity.count({ where: { employeeId, type: "PAN" } }),
    prisma.investmentDeclaration.count({ where: { employeeId, fyStartYear: fy } }),
    prisma.fbpDeclaration.count({ where: { employeeId, fyStartYear: fy } }),
    prisma.emergencyContact.count({ where: { employeeId } }),
    prisma.salaryRevision.count({ where: { employeeId } }),
    prisma.employeeDocument.count({ where: { employeeId, tenantId, status: { in: ["PENDING_VERIFICATION", "VERIFIED"] } } }),
  ]);
  return [
    { key: "PORTAL", label: "Signed in to the portal", ok: !!emp?.user?.lastLoginAt },
    { key: "PAYROLL", label: "Salary and pay group set up", ok: salary > 0 && !!emp?.payGroupId },
    { key: "BANK", label: "Bank details", ok: bank > 0 },
    { key: "TAX", label: "PAN and tax regime", ok: pan > 0 && decl > 0 },
    { key: "BENEFITS", label: "Benefits (FBP) declared", ok: fbp > 0 },
    { key: "EMERGENCY", label: "Emergency contact", ok: contacts > 0 },
    { key: "DOCUMENT", label: "Documents uploaded", ok: docs > 0 },
  ];
}

/** Close tasks the system can verify from the hire's data (bank, tax, benefits, emergency contact, documents, training). */
export async function autoCompletePreboardingTasks(tenantId: string, employeeId: string): Promise<number> {
  const tasks = await prisma.preboardingTask.findMany({ where: { tenantId, employeeId, status: { in: PREBOARDING_OPEN }, requiresApproval: false, kind: { in: ["BANK", "TAX", "BENEFITS", "EMERGENCY", "DOCUMENT", "TRAINING"] } } });
  if (!tasks.length) return 0;
  const ready = new Map((await preboardingReadiness(tenantId, employeeId)).map((r) => [r.key, r.ok]));
  let n = 0;
  for (const t of tasks) {
    let ok = ready.get(t.kind) ?? false;
    if (t.kind === "TRAINING" && t.refId) ok = (await prisma.courseEnrolment.count({ where: { tenantId, employeeId, courseId: t.refId, status: "COMPLETED" } })) > 0;
    if (ok) { await prisma.preboardingTask.update({ where: { id: t.id }, data: { status: "DONE", submittedAt: new Date(), decisionNote: "Verified automatically" } }); n++; }
  }
  return n;
}

/** Create a hire's preboarding tasks from the best-matching (or a chosen) template. Idempotent per template item. */
export async function generatePreboardingPlan(tenantId: string, employeeId: string, opts: { templateId?: string | null; today?: Date; byUserId?: string | null } = {}): Promise<{ ok: boolean; message: string; created: number }> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, displayName: true, dateOfJoining: true, departmentId: true, locationId: true, jobTitleName: true, status: true, userId: true } });
  if (!emp) return { ok: false, message: "Hire not found.", created: 0 };
  const templates = await prisma.preboardingTemplate.findMany({ where: { tenantId, ...(opts.templateId ? { id: opts.templateId } : {}) }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  const tpl = opts.templateId ? templates[0] ?? null : pickScopedTemplate(templates, { departmentId: emp.departmentId, locationId: emp.locationId, jobTitle: emp.jobTitleName });
  if (!tpl) return { ok: false, message: "No preboarding template matches this hire. Create one first.", created: 0 };
  const existing = new Set((await prisma.preboardingTask.findMany({ where: { tenantId, employeeId, templateItemId: { not: null } }, select: { templateItemId: true } })).map((r) => r.templateItemId));
  const today = opts.today ?? new Date();
  let created = 0;
  for (const it of tpl.items) {
    if (existing.has(it.id)) continue;
    await prisma.preboardingTask.create({
      data: { tenantId, employeeId, templateItemId: it.id, title: it.title, description: it.description, kind: it.kind, refId: it.refId, requiresApproval: it.requiresApproval, dueDate: preboardingDueDate(emp.dateOfJoining, it.daysBeforeJoining, today) },
    });
    if (it.kind === "TRAINING" && it.refId) {
      const course = await prisma.course.findFirst({ where: { id: it.refId, tenantId }, select: { id: true } });
      if (course) await prisma.courseEnrolment.upsert({ where: { courseId_employeeId: { courseId: course.id, employeeId } }, create: { tenantId, courseId: course.id, employeeId, assignedBy: opts.byUserId ?? null, dueDate: emp.dateOfJoining }, update: {} });
    }
    created++;
  }
  if (created) await notify({ tenantId, userIds: [emp.userId], kind: "LIFECYCLE", title: "Your preboarding checklist is ready", body: `${created} thing(s) to do before you join.`, link: "/me/onboarding" });
  await autoCompletePreboardingTasks(tenantId, employeeId);
  return { ok: true, message: created ? `Added ${created} task(s) from ${tpl.name} for ${emp.displayName}.` : `${emp.displayName} already has every task from ${tpl.name}.`, created };
}

async function hireAddress(tenantId: string, employeeId: string) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { personalEmail: true, workEmail: true, user: { select: { email: true } } } });
  return e?.personalEmail ?? e?.user?.email ?? e?.workEmail ?? null;
}

async function prejoinVars(tenantId: string, employeeId: string) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { displayName: true, firstName: true, dateOfJoining: true, reportingManager: { select: { displayName: true } }, location: { select: { name: true } } } });
  return { name: e?.displayName ?? "", first_name: e?.firstName ?? "", joining_date: e ? isoKey(e.dateOfJoining) : "", manager: e?.reportingManager?.displayName ?? "", location: e?.location?.name ?? "" };
}

/** Send one pre-joining message to one hire: email to the outbox, in-app notification, and the communications log. */
export async function sendPrejoinMessage(tenantId: string, input: { employeeId: string; messageId?: string | null; kind: "SCHEDULED" | "MANUAL" | "REMINDER" | "INTRO"; subject: string; body: string; sentBy?: string | null }) {
  const vars = await prejoinVars(tenantId, input.employeeId);
  const subject = renderPrejoinText(input.subject, vars).slice(0, 200), body = renderPrejoinText(input.body, vars);
  const to = await hireAddress(tenantId, input.employeeId);
  const outbox = to ? await prisma.emailOutbox.create({ data: { tenantId, toAddress: to, subject, textBody: body, relatedType: "PrejoinMessage", relatedId: input.messageId ?? null } }) : null;
  await notify({ tenantId, userIds: [await userOfEmployee(tenantId, input.employeeId)], kind: "LIFECYCLE", title: subject, body: body.slice(0, 300), link: "/me/onboarding" });
  return prisma.prejoinMessageLog.create({ data: { tenantId, messageId: input.messageId ?? null, employeeId: input.employeeId, kind: input.kind, subject, body, toAddress: to, outboxId: outbox?.id ?? null, sentBy: input.sentBy ?? null } });
}

/** Send every active scheduled message whose window has opened, once per hire. */
export async function sendDuePrejoinMessages(tenantId: string, today = new Date()): Promise<number> {
  const msgs = await prisma.prejoinMessage.findMany({ where: { tenantId, status: "ACTIVE" } });
  if (!msgs.length) return 0;
  const hires = await prisma.employee.findMany({ where: { tenantId, status: "PREBOARDING" }, select: { id: true, dateOfJoining: true } });
  const sent = await prisma.prejoinMessageLog.findMany({ where: { tenantId, messageId: { in: msgs.map((m) => m.id) } }, select: { messageId: true, employeeId: true } });
  const done = new Set(sent.map((s) => `${s.messageId}:${s.employeeId}`));
  let n = 0;
  for (const m of msgs) for (const h of hires) {
    if (done.has(`${m.id}:${h.id}`) || !prejoinSendDue(h.dateOfJoining, m.daysBeforeJoining, today)) continue;
    await sendPrejoinMessage(tenantId, { employeeId: h.id, messageId: m.id, kind: "SCHEDULED", subject: m.subject, body: m.body });
    n++;
  }
  return n;
}

/** Remind hires about pending preboarding tasks on the configured cadence. */
export async function sendPreboardingReminders(tenantId: string, now = new Date()): Promise<number> {
  const s = await joinSettings(tenantId);
  const tasks = await prisma.preboardingTask.findMany({ where: { tenantId, status: { in: PREBOARDING_OPEN } }, orderBy: { dueDate: "asc" } });
  const hires = new Set((await prisma.employee.findMany({ where: { tenantId, status: "PREBOARDING", id: { in: [...new Set(tasks.map((t) => t.employeeId))] } }, select: { id: true } })).map((e) => e.id));
  const due = tasks.filter((t) => hires.has(t.employeeId) && preboardReminderDue(t, s.preboardingReminderDays, s.preboardingReminderMax, now));
  const byEmp = new Map<string, typeof due>();
  for (const t of due) byEmp.set(t.employeeId, [...(byEmp.get(t.employeeId) ?? []), t]);
  for (const [emp, list] of byEmp) {
    await sendPrejoinMessage(tenantId, { employeeId: emp, kind: "REMINDER", subject: "Reminder: {{first_name}}, a few things before you join", body: `Hi {{first_name}},\n\nThese are still open before you join on {{joining_date}}:\n${list.map((t) => `- ${t.title} (due ${isoKey(t.dueDate)})`).join("\n")}\n\nOpen BooS-HR to finish them.` });
    await prisma.preboardingTask.updateMany({ where: { id: { in: list.map((t) => t.id) } }, data: { remindersSent: { increment: 1 }, lastRemindedAt: now } });
  }
  return due.length;
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

/** First-week and 30/60/90-day checkpoints for a hire. */
export async function generateMilestones(tenantId: string, employeeId: string): Promise<number> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { dateOfJoining: true } });
  if (!emp) return 0;
  let n = 0;
  for (const m of milestonePlan(emp.dateOfJoining)) {
    const r = await prisma.onboardingMilestone.upsert({ where: { employeeId_kind: { employeeId, kind: m.kind } }, create: { tenantId, employeeId, kind: m.kind, dueDate: m.dueDate }, update: {} });
    if (r.createdAt.getTime() > Date.now() - 5000) n++;
  }
  return n;
}

/**
 * Escalate overdue onboarding tasks: level 1 reminds the assignee, level 2
 * tells the hire's manager, level 3 tells onboarding HR. Returns how many
 * tasks moved up a level.
 */
export async function escalateOverdueJourneyTasks(tenantId: string, today = new Date()): Promise<number> {
  const s = await joinSettings(tenantId);
  const tasks = await prisma.journeyTask.findMany({
    where: { status: "PENDING", dueDate: { lt: utcDay(today) }, journey: { tenantId, status: "ACTIVE", trigger: { not: "EXIT" } } },
    include: { journey: { select: { id: true, employee: { select: { displayName: true, reportingManagerId: true } } } } },
  });
  const hr = await usersWithPermission(tenantId, ONB);
  let n = 0;
  for (const t of tasks) {
    const level = escalationLevelFor(t.dueDate, today, s.journeyEscalationDays);
    if (level <= t.escalationLevel) continue;
    const to = level === 1 ? [await userOfEmployee(tenantId, t.assigneeEmployeeId)] : level === 2 ? [await userOfEmployee(tenantId, t.journey.employee.reportingManagerId)] : hr;
    await notify({ tenantId, userIds: to.length ? to : hr, kind: "JOURNEY", title: `${level === 1 ? "Overdue" : "Escalated"}: ${t.title}`, body: `For ${t.journey.employee.displayName}, due ${isoKey(t.dueDate)} (level ${level}).`, link: `/onboarding/${t.journey.id}` });
    await prisma.journeyTask.update({ where: { id: t.id }, data: { escalationLevel: level, escalatedAt: today } });
    n++;
  }
  return n;
}

/** Snapshot a journey template after a change and bump its version. */
export async function snapshotJourneyTemplate(tenantId: string, templateId: string, changedBy: string | null, summary: string): Promise<number | null> {
  const t = await prisma.journeyTemplate.findFirst({ where: { id: templateId, tenantId }, include: { tasks: { orderBy: [{ offsetDays: "asc" }, { sortOrder: "asc" }] } } });
  if (!t) return null;
  const last = await prisma.journeyTemplateRevision.findFirst({ where: { templateId }, orderBy: { version: "desc" } });
  const version = (last?.version ?? 0) + 1;
  const snapshot: TemplateSnapshot = {
    name: t.name, trigger: t.trigger, departmentId: t.departmentId, locationId: t.locationId, jobTitle: t.jobTitle, isActive: t.isActive,
    tasks: t.tasks.map((k) => ({ title: k.title, owner: k.owner, offsetDays: k.offsetDays, category: k.category, isRequired: k.isRequired, needsApproval: k.needsApproval })),
  };
  await prisma.journeyTemplateRevision.create({ data: { tenantId, templateId, version, snapshot: snapshot as unknown as Prisma.InputJsonValue, summary, changedBy } });
  await prisma.journeyTemplate.update({ where: { id: templateId }, data: { version } });
  return version;
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export async function bgvEvent(tenantId: string, bgvCheckId: string, kind: string, note: string | null, actorUserId: string | null) {
  await prisma.bgvCaseEvent.create({ data: { tenantId, bgvCheckId, kind, note, actorUserId } });
}

/** Escalate an adverse or overdue case to the hire's manager, department head and verification HR. */
export async function escalateBgvCase(tenantId: string, id: string, actorUserId: string | null, reason: string): Promise<{ ok: boolean; message: string }> {
  const c = await prisma.bgvCheck.findFirst({ where: { id, tenantId }, include: { employee: { select: { displayName: true, reportingManager: { select: { userId: true } }, department: { select: { head: { select: { userId: true } } } } } } } });
  if (!c) return { ok: false, message: "Case not found." };
  const level = Math.min(3, c.escalationLevel + 1);
  const hr = await usersWithPermission(tenantId, BGV);
  const to = [...hr, c.employee?.reportingManager?.userId ?? null, level >= 2 ? c.employee?.department?.head?.userId ?? null : null];
  await notify({ tenantId, userIds: to, kind: "LIFECYCLE", title: `Verification escalated (level ${level}): ${c.employee?.displayName ?? ""}`, body: reason, link: `/onboarding/verification/${id}`, email: true });
  await prisma.bgvCheck.update({ where: { id }, data: { escalationLevel: level, escalatedAt: new Date() } });
  await bgvEvent(tenantId, id, "ESCALATED", `Level ${level}: ${reason}`, actorUserId);
  return { ok: true, message: `Escalated to level ${level}.` };
}

/** Escalate open cases past their SLA, once per level. */
export async function bgvSlaSweep(tenantId: string, now = new Date()): Promise<number> {
  const late = await prisma.bgvCheck.findMany({ where: { tenantId, status: { in: ["INITIATED", "IN_PROGRESS"] }, slaDueAt: { lt: now }, escalationLevel: 0 }, select: { id: true, slaDueAt: true } });
  for (const c of late) await escalateBgvCase(tenantId, c.id, null, `SLA breached (was due ${isoKey(c.slaDueAt!)})`);
  return late.length;
}

// ---------------------------------------------------------------------------
//  Shift & roster
// ---------------------------------------------------------------------------

/** The roster as it stands (explicit or by policy), in snapshot form. */
export async function rosterSnapshot(employeeIds: string[], from: Date, to: Date): Promise<SnapshotRow[]> {
  if (!employeeIds.length) return [];
  const days = Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / DAY) + 1;
  const grid = await rosterGrid(employeeIds, utcDay(from), Math.min(days, 92));
  return [...grid.entries()].flatMap(([employeeId, cells]) => cells.map((c) => ({ employeeId, date: c.date, shiftId: c.shiftId, off: c.off })));
}

/**
 * Carry out an approved swap. Same-day swaps exchange the two shifts;
 * different days mean each works the other's shift and takes the other's
 * day off; a marketplace pick-up moves the shift to the taker.
 */
export async function applyShiftSwap(tenantId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const s = await prisma.shiftSwapRequest.findFirst({ where: { id, tenantId } });
  if (!s || !s.counterpartId) return { ok: false, message: "Swap not found or nobody has taken it." };
  const a = s.requesterId, b = s.counterpartId;
  const dA = utcDay(s.requesterDate), dB = s.counterpartDate ? utcDay(s.counterpartDate) : null;
  const cell = async (emp: string, d: Date) => (await rosterGrid([emp], d, 1)).get(emp)?.[0] ?? null;
  const val = (c: { shiftId: string | null; off: boolean } | null) => (!c || c.off || !c.shiftId ? { kind: "OFF" as const } : { kind: "SHIFT" as const, shiftId: c.shiftId });
  const aCell = await cell(a, dA);
  const writes: Array<{ employeeId: string; date: Date; value: { kind: "OFF" } | { kind: "SHIFT"; shiftId: string } }> = [];
  if (!dB) {
    writes.push({ employeeId: b, date: dA, value: val(aCell) }, { employeeId: a, date: dA, value: { kind: "OFF" } });
  } else if (dB.getTime() === dA.getTime()) {
    const bCell = await cell(b, dA);
    writes.push({ employeeId: a, date: dA, value: val(bCell) }, { employeeId: b, date: dA, value: val(aCell) });
  } else {
    const bCell = await cell(b, dB);
    writes.push({ employeeId: b, date: dA, value: val(aCell) }, { employeeId: a, date: dA, value: { kind: "OFF" } }, { employeeId: a, date: dB, value: val(bCell) }, { employeeId: b, date: dB, value: { kind: "OFF" } });
  }
  const res = await setRoster(tenantId, writes);
  if (!res.ok) throw new Error(res.message);
  await prisma.shiftSwapRequest.update({ where: { id }, data: { status: "APPROVED", decidedAt: new Date(), requesterShiftId: aCell?.shiftId ?? null } });
  return { ok: true, message: "Swap applied to the roster." };
}

/** Apply an approved workweek / shift cycle / calendar assignment change. */
export async function applyTimeConfigChange(tenantId: string, id: string): Promise<void> {
  const c = await prisma.timeConfigChange.findFirst({ where: { id, tenantId } });
  if (!c) return;
  const p = (c.payload ?? {}) as Record<string, unknown>;
  let appliedId: string | null = null;
  if (c.kind === "WORKWEEK") {
    const config = p.config as Prisma.InputJsonValue;
    if (c.targetId) {
      const cur = await prisma.weeklyOffPolicy.findFirst({ where: { id: c.targetId, tenantId } });
      if (!cur) throw new Error("That workweek no longer exists.");
      await prisma.weeklyOffPolicy.update({ where: { id: cur.id }, data: { config } });
      appliedId = cur.id;
    } else {
      appliedId = (await prisma.weeklyOffPolicy.create({ data: { tenantId, name: String(p.name ?? "Workweek"), config } })).id;
    }
  } else if (c.kind === "SHIFT_CYCLE") {
    const steps = patternSteps(p.steps);
    if (!steps.length) throw new Error("The cycle has no steps.");
    if (c.targetId) {
      const u = await prisma.rosterPattern.updateMany({ where: { id: c.targetId, tenantId }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
      if (!u.count) throw new Error("That shift cycle no longer exists.");
      appliedId = c.targetId;
    } else {
      appliedId = (await prisma.rosterPattern.create({ data: { tenantId, name: String(p.name ?? "Shift cycle"), steps: steps as unknown as Prisma.InputJsonValue } })).id;
    }
  } else if (c.kind === "CALENDAR_ASSIGNMENT") {
    const calendarId = String(p.calendarId ?? "");
    const cal = await prisma.holidayCalendar.findFirst({ where: { id: calendarId, tenantId } });
    if (!cal) throw new Error("That holiday calendar no longer exists.");
    const from = new Date(`${String(p.effectiveFrom ?? isoKey(new Date()))}T00:00:00Z`);
    const ids = (Array.isArray(p.employeeIds) ? p.employeeIds : []).map(String);
    const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
    for (const e of emps) {
      const cur = await prisma.employeeTimePolicy.findFirst({ where: { employeeId: e.id, effectiveFrom: { lte: from }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] }, orderBy: { effectiveFrom: "desc" } });
      if (cur && cur.effectiveFrom.getTime() === from.getTime()) { await prisma.employeeTimePolicy.update({ where: { id: cur.id }, data: { holidayCalendarId: cal.id } }); continue; }
      if (cur) await prisma.employeeTimePolicy.update({ where: { id: cur.id }, data: { effectiveTo: new Date(from.getTime() - DAY) } });
      await prisma.employeeTimePolicy.create({ data: { employeeId: e.id, attendancePolicyId: cur?.attendancePolicyId ?? null, shiftId: cur?.shiftId ?? null, weeklyOffPolicyId: cur?.weeklyOffPolicyId ?? null, trackAttendance: cur?.trackAttendance ?? true, holidayCalendarId: cal.id, effectiveFrom: from } });
    }
    appliedId = cal.id;
  }
  await prisma.timeConfigChange.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date(), appliedId } });
}

// ---------------------------------------------------------------------------
//  Holidays & calendars
// ---------------------------------------------------------------------------

export function revisionHolidays(json: unknown): CalHoliday[] {
  return (Array.isArray(json) ? json : []).filter((h): h is CalHoliday => !!h && typeof h === "object" && typeof (h as CalHoliday).name === "string" && /^\d{4}-\d{2}-\d{2}$/.test((h as CalHoliday).date))
    .map((h) => ({ name: h.name, date: h.date, isOptional: !!h.isOptional, dayType: h.dayType ?? null }));
}

/** Write an approved revision to its live calendar (creating it when new) and tell everyone it covers. */
export async function publishCalendarRevision(tenantId: string, revisionId: string, actorUserId: string | null): Promise<{ calendarId: string; holidays: number }> {
  const r = await prisma.holidayCalendarRevision.findFirst({ where: { id: revisionId, tenantId } });
  if (!r) throw new Error("Revision not found.");
  const wanted = revisionHolidays(r.holidays);
  const result = await prisma.$transaction(async (tx) => {
    const cal = r.calendarId
      ? await tx.holidayCalendar.update({ where: { id: r.calendarId }, data: { name: r.name, country: r.country, state: r.state, locationIds: r.locationIds.length ? r.locationIds : Prisma.DbNull } })
      : await tx.holidayCalendar.create({ data: { tenantId, name: r.name, year: r.year, country: r.country, state: r.state, locationIds: r.locationIds.length ? r.locationIds : Prisma.DbNull } });
    const live = await tx.holiday.findMany({ where: { calendarId: cal.id } });
    const finalList = mergeCalendarRevision(live.map((h) => ({ name: h.name, date: isoKey(h.date), isOptional: h.isOptional, dayType: h.dayType })), wanted, r.effectiveFrom ? isoKey(r.effectiveFrom) : null);
    const keep = new Set(finalList.map((h) => `${h.date}|${h.name}`));
    const liveKeys = new Map(live.map((h) => [`${isoKey(h.date)}|${h.name}`, h]));
    for (const h of live) if (!keep.has(`${isoKey(h.date)}|${h.name}`)) await tx.holiday.delete({ where: { id: h.id } });
    for (const h of finalList) {
      const ex = liveKeys.get(`${h.date}|${h.name}`);
      if (ex) await tx.holiday.update({ where: { id: ex.id }, data: { isOptional: h.isOptional, dayType: h.dayType ?? null } });
      else await tx.holiday.create({ data: { calendarId: cal.id, name: h.name, date: new Date(`${h.date}T00:00:00Z`), isOptional: h.isOptional, dayType: h.dayType ?? null } });
    }
    await tx.holidayCalendarRevision.update({ where: { id: r.id }, data: { status: "PUBLISHED", publishedAt: new Date(), calendarId: cal.id } });
    return { calendarId: cal.id, holidays: finalList.length };
  });
  // Notification campaign: everyone on the calendar's locations (or everyone, for an unscoped calendar).
  const emps = await prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED"] }, ...(r.locationIds.length ? { locationId: { in: r.locationIds } } : {}) }, select: { userId: true } });
  await notify({ tenantId, userIds: emps.map((e) => e.userId), kind: "LEAVE", title: `Holiday calendar published: ${r.name}`, body: `${result.holidays} holiday(s) for ${r.year}.`, link: "/time/holidays?tab=upcoming", relatedType: "HolidayCalendarRevision", relatedId: r.id });
  await joinAudit(tenantId, actorUserId, { module: "LEAVE", action: "UPDATE", entityType: "HolidayCalendar", entityId: result.calendarId, summary: `Published ${r.name} v${r.version}: ${result.holidays} holiday(s), notified ${emps.length} employee(s)` });
  return result;
}

/** The tenant's default weekly-off pattern (for calendar checks). */
export async function defaultWeeklyOff(tenantId: string): Promise<WeeklyOffConfig | null> {
  const w = await prisma.weeklyOffPolicy.findFirst({ where: { tenantId, isDefault: true, isActive: true } });
  return (w?.config as WeeklyOffConfig | undefined) ?? null;
}

/** Which calendar each active employee resolves to, and how (assigned, location, default). */
export async function calendarResolution(tenantId: string, at = new Date()) {
  const [emps, cals] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true, locationId: true, location: { select: { name: true } } }, orderBy: { employeeNumber: "asc" } }),
    prisma.holidayCalendar.findMany({ where: { tenantId }, select: { id: true, name: true, year: true, locationIds: true, isDefault: true } }),
  ]);
  const assigned = new Map((await prisma.employeeTimePolicy.findMany({ where: { employee: { tenantId }, holidayCalendarId: { not: null }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, select: { employeeId: true, holidayCalendarId: true } })).map((r) => [r.employeeId, r.holidayCalendarId!]));
  const name = new Map(cals.map((c) => [c.id, `${c.name} (${c.year})`]));
  const out = [];
  for (const e of emps) {
    const ids = await employeeHolidayCalendarIds(e.id, at);
    const how = assigned.has(e.id) ? "ASSIGNED" : cals.some((c) => Array.isArray(c.locationIds) && (c.locationIds as string[]).includes(e.locationId ?? "")) ? "LOCATION" : ids.length ? "DEFAULT" : "NONE";
    out.push({ employeeId: e.id, name: e.displayName, number: e.employeeNumber, location: e.location?.name ?? "—", how, calendars: ids.map((i) => name.get(i) ?? i) });
  }
  return out;
}

/** Refresh the calendar exception queue from the current checks. */
export async function syncCalendarExceptions(tenantId: string, year = new Date().getUTCFullYear()): Promise<{ open: number; found: number }> {
  const [cals, locations, weeklyOff, resolution] = await Promise.all([
    prisma.holidayCalendar.findMany({ where: { tenantId }, include: { holidays: true } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    defaultWeeklyOff(tenantId),
    calendarResolution(tenantId),
  ]);
  const found = calendarConflicts({
    calendars: cals.map((c) => ({ id: c.id, name: c.name, year: c.year, isDefault: c.isDefault, locationIds: Array.isArray(c.locationIds) ? (c.locationIds as string[]) : [], holidays: c.holidays.map((h) => ({ name: h.name, date: isoKey(h.date), isOptional: h.isOptional })) })),
    weeklyOff, locations, year, unassignedEmployees: resolution.filter((r) => r.how === "NONE").length,
  });
  const now = new Date();
  for (const f of found) {
    await prisma.calendarException.upsert({ where: { tenantId_key: { tenantId, key: f.key } }, create: { tenantId, key: f.key, kind: f.kind, summary: f.summary }, update: { summary: f.summary, lastSeenAt: now } });
  }
  const keys = found.map((f) => f.key);
  await prisma.calendarException.updateMany({ where: { tenantId, status: "OPEN", key: { notIn: keys } }, data: { status: "RESOLVED", resolvedAt: now, note: "No longer found by the checks" } });
  const open = await prisma.calendarException.count({ where: { tenantId, status: "OPEN" } });
  return { open, found: found.length };
}

/** Add a shutdown's working days to its calendar as holidays. */
export async function applyShutdownPeriod(tenantId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const s = await prisma.shutdownPeriod.findFirst({ where: { id, tenantId } });
  if (!s || s.status !== "DRAFT") return { ok: false, message: "Only a draft shutdown can be applied." };
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: s.calendarId, tenantId }, include: { holidays: true } });
  if (!cal) return { ok: false, message: "Calendar not found." };
  const days = shutdownWorkingDays(s.fromDate, s.toDate, await defaultWeeklyOff(tenantId), new Set(cal.holidays.map((h) => isoKey(h.date))))
    .filter((d) => d.startsWith(String(cal.year)));
  for (const d of days) await prisma.holiday.create({ data: { calendarId: cal.id, name: s.name, date: new Date(`${d}T00:00:00Z`), dayType: "SHUTDOWN", description: s.reason } });
  await prisma.shutdownPeriod.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date(), holidaysAdded: days.length } });
  return { ok: true, message: `Shutdown applied: ${days.length} working day(s) added to ${cal.name} as holidays.` };
}

/** Add substitute holidays (a SUBSTITUTE_WEEKEND rule) to a calendar. */
export async function applyHolidaySubstitution(tenantId: string, ruleId: string): Promise<{ ok: boolean; message: string; added: number }> {
  const rule = await prisma.holidayRule.findFirst({ where: { id: ruleId, tenantId, kind: "SUBSTITUTE_WEEKEND", status: "ACTIVE" } });
  if (!rule?.calendarId) return { ok: false, message: "Only an active substitution rule with a calendar can be applied.", added: 0 };
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: rule.calendarId, tenantId }, include: { holidays: true } });
  if (!cal) return { ok: false, message: "Calendar not found.", added: 0 };
  const dir = ((rule.config ?? {}) as { direction?: string }).direction === "PREVIOUS" ? "PREVIOUS" : "NEXT";
  const subs = weekendSubstitutes(cal.holidays.filter((h) => h.dayType !== "SUBSTITUTE").map((h) => ({ name: h.name, date: isoKey(h.date), isOptional: h.isOptional })), await defaultWeeklyOff(tenantId), dir);
  let added = 0;
  for (const h of subs) {
    const exists = await prisma.holiday.findFirst({ where: { calendarId: cal.id, name: h.name } });
    if (exists) continue;
    await prisma.holiday.create({ data: { calendarId: cal.id, name: h.name, date: new Date(`${h.date}T00:00:00Z`), dayType: "SUBSTITUTE" } });
    added++;
  }
  return { ok: true, message: added ? `Added ${added} substitute holiday(s) to ${cal.name}.` : "No holiday falls on a weekly off — nothing to substitute.", added };
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

const minutesOfDay = (d: Date | null) => (d ? d.getUTCHours() * 60 + d.getUTCMinutes() + 330 : null); // IST

/** A month of an employee's processed attendance as overtime input. */
export async function overtimeDays(employeeId: string, year: number, month: number): Promise<OtDay[]> {
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { tenantId: true } });
  const recs = await prisma.attendanceRecord.findMany({ where: { employeeId, date: { gte: from, lte: to } }, orderBy: { date: "asc" } });
  const holidays = new Set<string>();
  if (emp) {
    const ids = await employeeHolidayCalendarIds(employeeId, from);
    for (const h of await prisma.holiday.findMany({ where: { calendarId: { in: ids }, isOptional: false, date: { gte: from, lte: to } }, select: { date: true } })) holidays.add(isoKey(h.date));
  }
  return recs.map((r) => ({
    date: r.date,
    dayType: holidays.has(isoKey(r.date)) || r.status === "HOLIDAY" ? "HOLIDAY" : r.status === "WEEKLY_OFF" ? "WEEKLY_OFF" : "WORKDAY",
    overtimeMinutes: Math.round(Number(r.overtimeHours) * 60),
    workedMinutes: Math.round(Number(r.effectiveHours) * 60),
    outMinute: minutesOfDay(r.lastOut),
  }));
}

/** The active overtime rule covering an employee on a date (or null). */
export async function overtimeRuleForEmployee(tenantId: string, employeeId: string, at: Date) {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { bandId: true, payGradeId: true, locationId: true } });
  if (!emp) return null;
  const policy = await prisma.employeeTimePolicy.findFirst({ where: { employeeId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }, orderBy: { effectiveFrom: "desc" }, select: { shiftId: true } });
  const rules = await prisma.overtimeRule.findMany({ where: { tenantId, status: "ACTIVE" } });
  return overtimeRuleFor(rules, { bandId: emp.bandId, payGradeId: emp.payGradeId, locationId: emp.locationId, shiftId: policy?.shiftId ?? null });
}

/** The rule covering an employee and its result for a month. */
export async function employeeOvertime(tenantId: string, employeeId: string, year: number, month: number) {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { bandId: true, payGradeId: true, locationId: true } });
  if (!emp) return null;
  const policy = await prisma.employeeTimePolicy.findFirst({ where: { employeeId, OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(Date.UTC(year, month - 1, 1)) } }] }, orderBy: { effectiveFrom: "desc" }, select: { shiftId: true } });
  const rules = await prisma.overtimeRule.findMany({ where: { tenantId, status: "ACTIVE" } });
  const rule = overtimeRuleFor(rules, { bandId: emp.bandId, payGradeId: emp.payGradeId, locationId: emp.locationId, shiftId: policy?.shiftId ?? null });
  const days = await overtimeDays(employeeId, year, month);
  const result = rule ? computeOvertime(days, rule) : computeOvertime(days, { tiers: null, weeklyThresholdMinutes: null, dailyCapMinutes: null, weeklyCapMinutes: null, monthlyCapMinutes: null, minMinutes: 0 });
  return { rule, days, result };
}

/** Add approved minutes to the month's open overtime entry (creating it), priced at the hourly basic rate. */
export async function payOvertimeMinutes(tenantId: string, employeeId: string, year: number, month: number, minutes: number): Promise<string> {
  const wages = await monthlyWages(employeeId, new Date(Date.UTC(year, month - 1, 28)));
  const rate = Math.round(((wages?.basic ?? 0) * 12 / 2920) * 10_000) / 10_000;
  const hours = Math.round((minutes / 60) * 100) / 100;
  const open = await prisma.overtimeEntry.findFirst({ where: { tenantId, employeeId, year, month, payAction: "PAY", isProcessed: false } });
  const e = open
    ? await prisma.overtimeEntry.update({ where: { id: open.id }, data: { hours: Number(open.hours) + hours, amount: Math.round((Number(open.amount) + hours * Number(open.rate || rate)) * 100) / 100 } })
    : await prisma.overtimeEntry.create({ data: { tenantId, employeeId, year, month, hours, rate, amount: Math.round(hours * rate * 100) / 100 } });
  return e.id;
}

/** Threshold and anomaly alerts for a month; new ones notify time administrators. */
export async function overtimeAlertSweep(tenantId: string, year: number, month: number): Promise<number> {
  const from = new Date(Date.UTC(year, month - 1, 1)), to = new Date(Date.UTC(year, month, 0));
  const pf = new Date(Date.UTC(year, month - 2, 1)), pt = new Date(Date.UTC(year, month - 1, 0));
  const s = await joinSettings(tenantId);
  const rules = await prisma.overtimeRule.findMany({ where: { tenantId, status: "ACTIVE" } });
  const recs = await prisma.attendanceRecord.findMany({ where: { tenantId, date: { gte: pf, lte: to }, overtimeHours: { gt: 0 } }, select: { employeeId: true, date: true, overtimeHours: true } });
  const reqs = await prisma.overtimeRequest.findMany({ where: { tenantId, fromDate: { lte: to }, toDate: { gte: from }, status: { in: ["PENDING", "APPROVED"] } }, select: { employeeId: true, requestedMinutes: true } });
  const emps = await prisma.employee.findMany({ where: { tenantId, id: { in: [...new Set(recs.map((r) => r.employeeId))] } }, select: { id: true, displayName: true, bandId: true, payGradeId: true, locationId: true } });
  let created = 0;
  for (const e of emps) {
    const mine = recs.filter((r) => r.employeeId === e.id);
    const cur = mine.filter((r) => r.date >= from).map((r) => ({ date: r.date, overtimeMinutes: Math.round(Number(r.overtimeHours) * 60) }));
    const prev = mine.filter((r) => r.date < from).reduce((x, r) => x + Math.round(Number(r.overtimeHours) * 60), 0);
    const requested = reqs.filter((r) => r.employeeId === e.id).reduce((x, r) => x + r.requestedMinutes, 0);
    const found = overtimeAnomalies(cur, { dailyLimit: s.otAnomalyDailyMinutes, previousMonthMinutes: prev, requestedMinutes: requested });
    const rule = overtimeRuleFor(rules, { bandId: e.bandId, payGradeId: e.payGradeId, locationId: e.locationId, shiftId: null });
    const total = cur.reduce((x, d) => x + d.overtimeMinutes, 0);
    if (rule?.alertMonthlyMinutes && total > rule.alertMonthlyMinutes) found.push({ kind: "THRESHOLD", periodKey: `${year}-${String(month).padStart(2, "0")}`, detail: `${Math.round(total / 6) / 10} h of overtime this month, above the ${Math.round(rule.alertMonthlyMinutes / 60)} h alert threshold of ${rule.name}` });
    for (const f of found) {
      const exists = await prisma.overtimeAlert.findUnique({ where: { tenantId_employeeId_kind_periodKey: { tenantId, employeeId: e.id, kind: f.kind, periodKey: f.periodKey } } });
      if (exists) continue;
      await prisma.overtimeAlert.create({ data: { tenantId, employeeId: e.id, kind: f.kind, periodKey: f.periodKey, detail: `${e.displayName}: ${f.detail}` } });
      created++;
    }
  }
  if (created) await notify({ tenantId, userIds: await usersWithPermission(tenantId, ATT), kind: "ATTENDANCE", title: `${created} new overtime alert(s)`, link: "/time/overtime/rules?tab=alerts" });
  return created;
}

/** Remind employees about comp-off credit about to lapse, once per credit. */
export async function compOffExpiryReminders(tenantId: string, today = new Date()): Promise<number> {
  const s = await joinSettings(tenantId);
  const credits = await prisma.leaveLedgerEntry.findMany({ where: { tenantId, kind: "COMP_OFF_CREDIT", expiresOn: { gte: utcDay(today) } }, select: { id: true, employeeId: true, days: true, expiresOn: true, leaveTypeId: true } });
  const soon = compOffExpiringSoon(credits.map((c) => ({ id: c.id, employeeId: c.employeeId, days: Number(c.days), expiresOn: c.expiresOn })), today, s.compOffReminderDays);
  let n = 0;
  for (const c of soon) {
    const key = `CREDIT:${c.id}`;
    const exists = await prisma.overtimeAlert.findUnique({ where: { tenantId_employeeId_kind_periodKey: { tenantId, employeeId: c.employeeId, kind: "COMPOFF_EXPIRY", periodKey: key } } });
    if (exists) continue;
    const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: c.employeeId, leaveTypeId: credits.find((x) => x.id === c.id)!.leaveTypeId }, orderBy: { yearStart: "desc" }, select: { available: true } }).catch(() => null);
    if (bal && Number(bal.available) <= 0) continue;
    await prisma.overtimeAlert.create({ data: { tenantId, employeeId: c.employeeId, kind: "COMPOFF_EXPIRY", periodKey: key, detail: `${c.days} day(s) of comp off expire on ${isoKey(c.expiresOn!)}` } });
    await notify({ tenantId, userIds: [await userOfEmployee(tenantId, c.employeeId)], kind: "LEAVE", title: "Your comp off is about to expire", body: `${c.days} day(s) lapse on ${isoKey(c.expiresOn!)}. Apply for it before then.`, link: "/me/leave", email: true });
    n++;
  }
  return n;
}

/** The nightly sweep for this area. */
export async function runJoinDaily(tenantId: string, now = new Date()) {
  const ym = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  return {
    prejoinMessages: await sendDuePrejoinMessages(tenantId, now),
    reminders: await sendPreboardingReminders(tenantId, now),
    escalations: await escalateOverdueJourneyTasks(tenantId, now),
    bgvSla: await bgvSlaSweep(tenantId, now),
    calendarExceptions: (await syncCalendarExceptions(tenantId, ym.year)).open,
    overtimeAlerts: await overtimeAlertSweep(tenantId, ym.year, ym.month),
    compOffReminders: await compOffExpiryReminders(tenantId, now),
  };
}
