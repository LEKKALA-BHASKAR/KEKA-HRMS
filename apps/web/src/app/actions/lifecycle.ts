"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  initiateExit, decideExit, withdrawExit, draftSettlement, finalizeSettlement,
  startJourney, setJourneyTask, runAutoChecks,
  updateTicket, parsePeriod, startWorkflow, snapshotJourneyTemplate,
  lifecycleDependencyIssues,
} from "@keka/services";
import * as hd from "./helpdesk";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zRequiredNumber, zDate, zRequiredDate, zBool, zId, zOptionalId,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
type Perm = (typeof P)[keyof typeof P];

async function reaches(viewer: Viewer, employeeId: string, permission: Perm): Promise<boolean> {
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

const EXIT_TYPES = ["RESIGNATION", "TERMINATION", "RETIREMENT", "ABSCONDING", "END_OF_CONTRACT", "DEATH"] as const;

// ---------------------------------------------------------------------------
//  EXITS
// ---------------------------------------------------------------------------

const exitSchema = z.object({
  employeeId: zId(),
  type: z.enum(EXIT_TYPES),
  noticeDate: zRequiredDate(),
  lastWorkingDay: zDate(),
  reasonId: zOptionalId(),
  reason: zOptional(1000),
});

export async function initiateExitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_INITIATE);
  const parsed = parseForm(exitSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.employeeId === viewer.employee?.id) {
    return { ok: false, message: "To resign yourself, use My Exit." };
  }
  if (!(await reaches(viewer, d.employeeId, P.EXIT_INITIATE))) {
    return { ok: false, message: "This employee is outside the people you can initiate exits for." };
  }
  // A manager can raise an exit; only exit managers can record one as decided.
  if (d.type !== "RESIGNATION" && !can(viewer, P.EXIT_MANAGE)) {
    return { ok: false, message: "Only HR can record a termination or other non-resignation exit.", errors: { type: "Needs exit management" } };
  }
  const blocked = await lifecycleDependencyIssues(viewer.tenantId, d.employeeId, "EXIT");
  if (blocked.length) return { ok: false, message: blocked.join(" ") };
  try {
    const res = await initiateExit({ ...d, initiatedByUserId: viewer.user.id });
    if (!res.ok) return { ok: false, message: res.message, values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) };
    await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "ExitRecord", entityId: res.exitId, summary: `Initiated ${d.type.toLowerCase()} with last working day ${res.lastWorkingDay?.toISOString().slice(0, 10)}` });
    return done(["/exits", "/inbox"], `${res.message} Last working day ${res.lastWorkingDay?.toISOString().slice(0, 10)}${res.shortfallDays ? ` — ${res.shortfallDays} day(s) short of notice` : ""}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

const resignSchema = z.object({
  lastWorkingDay: zDate(),
  reasonId: zOptionalId(),
  reason: zOptional(1000),
}).refine((d) => !!d.reasonId || !!d.reason, { message: "Tell us why you are leaving", path: ["reason"] });

export async function resignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(resignSchema, formData);
  if (parsed.state) return parsed.state;
  const today = new Date();
  const res = await initiateExit({
    employeeId: viewer.employee.id, type: "RESIGNATION",
    noticeDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
    lastWorkingDay: parsed.data.lastWorkingDay, reason: parsed.data.reason, reasonId: parsed.data.reasonId, initiatedByUserId: viewer.user.id,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "ExitRecord", entityId: res.exitId, summary: "Submitted a resignation" });
  return done(["/me/exit", "/exits", "/inbox"], `${res.message} Proposed last working day ${res.lastWorkingDay?.toISOString().slice(0, 10)}.`);
}

export async function decideExitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_APPROVE);
  const exitId = String(formData.get("exitId"));
  const decision = String(formData.get("decision")).toUpperCase() as "APPROVE" | "REJECT" | "RETAIN";
  if (!["APPROVE", "REJECT", "RETAIN"].includes(decision)) return { ok: false, message: "Unknown decision." };
  const exit = await prisma.exitRecord.findFirst({ where: { id: exitId, employee: { tenantId: viewer.tenantId } } });
  if (!exit) return { ok: false, message: "Exit not found." };
  if (exit.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own exit." };
  if (!(await reaches(viewer, exit.employeeId, P.EXIT_APPROVE))) return { ok: false, message: "This exit is outside the people you approve for." };
  const lwdRaw = String(formData.get("lastWorkingDay") ?? "");
  const res = await decideExit({
    exitId, decision, byUserId: viewer.user.id,
    lastWorkingDay: /^\d{4}-\d{2}-\d{2}$/.test(lwdRaw) ? new Date(`${lwdRaw}T00:00:00Z`) : null,
    note: String(formData.get("note") ?? "") || null,
    isRehireEligible: formData.get("isRehireEligible") === "on" ? true : formData.has("isRehireEligibleShown") ? false : null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: decision === "APPROVE" ? "APPROVE" : "REJECT", entityType: "ExitRecord", entityId: exitId, summary: `${decision.toLowerCase()} exit` });
  return done(["/exits", `/exits/${exitId}`, "/inbox"], res.message);
}

export async function withdrawExitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const exitId = String(formData.get("exitId"));
  const exit = await prisma.exitRecord.findFirst({ where: { id: exitId, employee: { tenantId: viewer.tenantId } } });
  if (!exit) return { ok: false, message: "Exit not found." };
  const own = exit.employeeId === viewer.employee?.id;
  if (own && exit.status !== "PENDING_APPROVAL") {
    return { ok: false, message: "Your resignation is already accepted. Ask HR to withdraw it." };
  }
  if (!own && !(can(viewer, P.EXIT_MANAGE) && await reaches(viewer, exit.employeeId, P.EXIT_MANAGE))) {
    return { ok: false, message: "Only HR can withdraw someone else's exit." };
  }
  const res = await withdrawExit(exitId);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "ExitRecord", entityId: exitId, summary: "Withdrew an exit" });
  return done(["/exits", `/exits/${exitId}`, "/me/exit"], res.message);
}

export async function draftSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_MANAGE);
  const employeeId = String(formData.get("employeeId"));
  if (!(await reaches(viewer, employeeId, P.FNF_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  try {
    // The month it is booked in, when chosen; otherwise the draft keeps its own.
    const period = parsePeriod(String(formData.get("period") ?? ""));
    const res = await draftSettlement(employeeId, { waiveNoticeRecovery: formData.get("waiveNoticeRecovery") === "on", settlementYear: period?.year, settlementMonth: period?.month });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "FnfSettlement", entityId: res.settlementId, summary: res.message });
    const exit = await prisma.exitRecord.findUnique({ where: { employeeId }, select: { id: true } });
    return done(["/exits", `/exits/${exit?.id}`], res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function finalizeSettlementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.FNF_APPROVE);
  const employeeId = String(formData.get("employeeId"));
  if (employeeId === viewer.employee?.id) return { ok: false, message: "You cannot finalise your own settlement." };
  if (!(await reaches(viewer, employeeId, P.FNF_APPROVE))) return { ok: false, message: "This employee is outside your scope." };
  const res = await finalizeSettlement(employeeId, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "APPROVE", entityType: "FnfSettlement", entityId: employeeId, summary: res.message });
  const exit = await prisma.exitRecord.findUnique({ where: { employeeId }, select: { id: true } });
  return done(["/exits", `/exits/${exit?.id}`, "/employees"], res.message);
}

// ---------------------------------------------------------------------------
//  JOURNEYS
// ---------------------------------------------------------------------------

/** Who may act on a journey task: HR for the journey type, or its assignee. */
async function mayActOnTask(viewer: Viewer, task: { assigneeEmployeeId: string | null; owner: string; journey: { trigger: string; employeeId: string } }) {
  if (task.assigneeEmployeeId && task.assigneeEmployeeId === viewer.employee?.id) return true;
  const perm = task.journey.trigger === "EXIT" ? P.EXIT_MANAGE : P.ONBOARDING_MANAGE;
  return can(viewer, perm) && (await reaches(viewer, task.journey.employeeId, perm));
}

export async function setTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const taskId = String(formData.get("taskId"));
  const status = String(formData.get("status")) as "DONE" | "SKIPPED" | "PENDING";
  if (!["DONE", "SKIPPED", "PENDING"].includes(status)) return { ok: false, message: "Unknown status." };
  const task = await prisma.journeyTask.findFirst({
    where: { id: taskId, journey: { tenantId: viewer.tenantId } }, include: { journey: true },
  });
  if (!task) return { ok: false, message: "Task not found." };
  if (!(await mayActOnTask(viewer, task))) return { ok: false, message: "This task belongs to someone else." };
  const base = task.journey.trigger === "EXIT" ? "/exits" : "/onboarding";
  // Tasks that need sign-off go through the workflow engine; approval marks them done.
  if (status === "DONE" && task.needsApproval && task.status === "PENDING") {
    if (task.approvalStatus === "PENDING") return { ok: false, message: "This task is already waiting for sign-off." };
    const note = String(formData.get("note") ?? "") || null;
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "JOURNEY_TASK", entityId: task.id, title: `Sign off: ${task.title}`, details: note, requesterUserId: viewer.user.id, subjectEmployeeId: task.journey.employeeId });
    if (!wf.ok) return { ok: false, message: wf.message };
    await prisma.journeyTask.update({ where: { id: task.id }, data: { workflowRequestId: wf.requestId, ...(wf.message === "Approved automatically." ? {} : { approvalStatus: "PENDING" }), ...(note ? { note } : {}) } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTask", entityId: task.id, summary: `Sent "${task.title}" for sign-off` });
    return done([base, `/onboarding/${task.journeyId}`, "/inbox", "/"], wf.message === "Approved automatically." ? "Signed off." : "Sent for sign-off.");
  }
  const res = await setJourneyTask({ taskId, status, byUserId: viewer.user.id, note: String(formData.get("note") ?? "") || null });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "JourneyTask", entityId: task.id, summary: `"${task.title}" marked ${status.toLowerCase()}` });
  return done([base, `/onboarding/${task.journeyId}`, "/inbox", "/"], res.message);
}

export async function recheckJourneyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const journeyId = String(formData.get("journeyId"));
  const j = await prisma.journey.findFirst({ where: { id: journeyId, tenantId: viewer.tenantId } });
  if (!j) return { ok: false, message: "Journey not found." };
  const perm = j.trigger === "EXIT" ? P.EXIT_MANAGE : P.ONBOARDING_MANAGE;
  if (!can(viewer, perm)) return { ok: false, message: "You cannot manage this journey." };
  const n = await runAutoChecks(journeyId);
  return done([`/onboarding/${journeyId}`, "/onboarding", "/exits"], n > 0 ? `${n} task(s) verified and closed.` : "Nothing new to verify yet.");
}

const startSchema = z.object({
  employeeId: zId(),
  trigger: z.enum(["JOINING", "CONFIRMATION", "PROMOTION", "TRANSFER", "MANUAL"]),
  anchorDate: zRequiredDate(),
  templateId: zOptionalId(),
});

export async function startJourneyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const parsed = parseForm(startSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await reaches(viewer, d.employeeId, P.ONBOARDING_MANAGE))) return { ok: false, message: "This employee is outside your scope." };
  const res = await startJourney({ ...d, templateId: d.templateId ?? undefined, createdBy: viewer.user.id });
  if (!res.journeyId) return { ok: false, message: "No active template matches. Create one for this trigger first, or pick a template." };
  if (res.created) await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "Journey", entityId: res.journeyId, summary: `Started a ${d.trigger.toLowerCase()} journey with ${res.tasks} task(s)` });
  return done(["/onboarding"], res.created ? `Started with ${res.tasks} task(s).` : "That journey already exists — opened it instead.");
}

const templateSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  description: zOptional(300),
  trigger: z.enum(["JOINING", "CONFIRMATION", "PROMOTION", "TRANSFER", "EXIT", "MANUAL"]),
  departmentId: zOptionalId(),
  locationId: zOptionalId(),
  jobTitle: zOptional(120),
  isActive: zBool(),
});

export async function saveTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const parsed = parseForm(templateSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, location: d.locationId });
  if (foreign) return { ok: false, message: foreign };
  try {
    let templateId = id;
    if (id) {
      const u = await prisma.journeyTemplate.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
      if (u.count === 0) return { ok: false, message: "Template not found." };
    } else {
      templateId = (await prisma.journeyTemplate.create({ data: { ...d, tenantId: viewer.tenantId, isActive: true } })).id;
    }
    const v = await snapshotJourneyTemplate(viewer.tenantId, templateId!, viewer.user.id, id ? "Template settings changed" : "Template created");
    await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "JourneyTemplate", entityId: templateId, summary: `${id ? "Saved" : "Created"} journey template ${d.name} (v${v})`, newValue: d });
    return done(["/onboarding", `/onboarding/templates/${templateId}`], id ? `Saved ${d.name}.` : `Created ${d.name}. Add its tasks below.`);
  } catch (err) {
    return toErrorState(err, Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])));
  }
}

const taskTemplateSchema = z.object({
  templateId: zId(),
  title: zName(160),
  owner: z.enum(["HR", "MANAGER", "EMPLOYEE", "IT", "FINANCE", "ADMIN"]),
  offsetDays: zRequiredNumber({ min: -365, max: 730 }),
  category: z.enum(["DOCUMENTS", "ASSETS", "ACCESS", "TRAINING", "MEETING", "PAYROLL", "COMPLIANCE", "OTHER"]),
  autoCheck: zOptional(40),
  isRequired: zBool(),
  needsApproval: zBool(),
});

export async function addTemplateTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const parsed = parseForm(taskTemplateSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const t = await prisma.journeyTemplate.findFirst({ where: { id: d.templateId, tenantId: viewer.tenantId }, include: { _count: { select: { tasks: true } } } });
  if (!t) return { ok: false, message: "Template not found." };
  await prisma.journeyTaskTemplate.create({ data: { ...d, sortOrder: t._count.tasks } });
  const v = await snapshotJourneyTemplate(viewer.tenantId, t.id, viewer.user.id, `Added task "${d.title}"`);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "JourneyTaskTemplate", entityId: t.id, summary: `${t.name} v${v}: added "${d.title}"` });
  return done(["/onboarding", `/onboarding/templates/${t.id}`], `Added "${d.title}". New journeys will include it; running ones are unchanged.`);
}

export async function deleteTemplateTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const id = String(formData.get("id"));
  const k = await prisma.journeyTaskTemplate.findFirst({ where: { id, template: { tenantId: viewer.tenantId } }, include: { template: { select: { id: true, name: true } } } });
  if (!k) return { ok: false, message: "Task not found." };
  await prisma.journeyTaskTemplate.delete({ where: { id } });
  const v = await snapshotJourneyTemplate(viewer.tenantId, k.template.id, viewer.user.id, `Removed task "${k.title}"`);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "DELETE", entityType: "JourneyTaskTemplate", entityId: k.template.id, summary: `${k.template.name} v${v}: removed "${k.title}"` });
  return done(["/onboarding", `/onboarding/templates/${k.template.id}`], "Removed.");
}

// ---------------------------------------------------------------------------
//  HELPDESK — the actions live in ./helpdesk; these keep the older entry
//  points (inbox reply form, scripts) working with Keka's statuses.
// ---------------------------------------------------------------------------

export async function raiseTicketAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  return hd.raiseTicketAction(prev, formData);
}

export async function replyTicketAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  return hd.replyTicketAction(prev, formData);
}

export async function rateTicketAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  return hd.rateTicketAction(prev, formData);
}

export async function saveCategoryAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  return hd.saveCategoryAction(prev, formData);
}

/**
 * The old status control. Agents move a ticket like the Update panel does
 * (RESOLVED closes, WAITING_ON_EMPLOYEE holds). The person who raised it
 * may only close their own open ticket or reopen a closed one.
 */
export async function ticketStatusAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const raw = String(formData.get("status") ?? "");
  const status = raw === "RESOLVED" ? "CLOSED" : raw === "WAITING_ON_EMPLOYEE" ? "ON_HOLD" : raw;
  const t = await prisma.helpdeskTicket.findFirst({ where: { id: ticketId, tenantId: viewer.tenantId } });
  if (!t) return { ok: false, message: "Ticket not found." };
  const own = t.employeeId === viewer.employee?.id;
  if (!own) {
    const next = new FormData();
    next.set("ticketId", ticketId);
    next.set("status", status);
    const assignee = formData.get("assigneeUserId");
    if (assignee !== null) next.set("assigneeUserId", String(assignee));
    const reason = formData.get("closingReasonId");
    if (reason) next.set("closingReasonId", String(reason));
    else if (status === "CLOSED") {
      const resolved = await prisma.helpdeskClosingReason.findFirst({ where: { tenantId: viewer.tenantId, isActive: true, name: "Resolved" } });
      if (resolved) next.set("closingReasonId", resolved.id);
    }
    return hd.updateTicketAction(prev, next);
  }
  const closed = t.status === "CLOSED" || t.status === "RESOLVED";
  if (closed && (status === "OPEN" || status === "IN_PROGRESS")) {
    const next = new FormData();
    next.set("ticketId", ticketId);
    return hd.reopenTicketAction(prev, next);
  }
  if (!closed && status === "CLOSED") {
    const res = await updateTicket({ ticketId, status: "CLOSED", byUserId: viewer.user.id, byLabel: viewer.employee?.displayName ?? viewer.user.email });
    if (!res.ok) return res;
    await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Closed their own ticket #${t.number}` });
    return done(["/helpdesk", `/me/helpdesk/${ticketId}`], "Ticket closed.");
  }
  if (closed && status === "CLOSED") return { ok: true, message: "The ticket is already closed." };
  return { ok: false, message: "Only the helpdesk team can change this ticket's status." };
}

// ---------------------------------------------------------------------------
//  NOTIFICATIONS
// ---------------------------------------------------------------------------

export async function markNotificationsReadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  await prisma.notification.updateMany({
    where: { userId: viewer.user.id, readAt: null, ...(id ? { id } : {}) },
    data: { readAt: new Date() },
  });
  return done(["/notifications", "/"], "Marked as read.");
}

