"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, notify, generatePreboardingPlan, autoCompletePreboardingTasks, sendPrejoinMessage, sendDuePrejoinMessages, sendPreboardingReminders,
  parseNewHireFields, checkNewHireAnswers, PREBOARDING_KINDS, PREBOARDING_OPEN, recordAssetEvent, joinSettings, type NewHireField,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { foreignReference } from "@/lib/ownership";
import { jstr as str, jnum as num, jday as day, scopedEmployee, managesEmployee } from "@/lib/join-depth";

/**
 * Preboarding depth: preboarding templates and per-hire task plans, the
 * hire's own task submissions (with HR review through the workflow
 * engine), configurable new-hire forms, pre-joining messages with approval,
 * reminders and manager introductions, IT / access / asset provisioning
 * (with asset reservations) and the area's settings.
 */

const P = PERMISSIONS;
const PATHS = ["/onboarding/preboarding", "/me/onboarding", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });

// ---------------------------------------------------------------------------
//  Templates
// ---------------------------------------------------------------------------

export async function savePreboardingTemplateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const id = str(f, "id"), name = str(f, "name");
  if (!name) return { ok: false, message: "Name the template.", errors: { name: "Required" } };
  const data = { name: name.slice(0, 80), description: str(f, "description") || null, departmentId: str(f, "departmentId") || null, locationId: str(f, "locationId") || null, jobTitle: str(f, "jobTitle") || null, isActive: id ? f.get("isActive") === "on" : true };
  const foreign = await foreignReference(viewer.tenantId, { department: data.departmentId, location: data.locationId });
  if (foreign) return NO(foreign);
  try {
    if (id) {
      const u = await prisma.preboardingTemplate.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (!u.count) return NO("Template not found.");
    } else await prisma.preboardingTemplate.create({ data: { ...data, tenantId: viewer.tenantId } });
  } catch { return NO("A template with that name already exists."); }
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "PreboardingTemplate", entityId: id || null, summary: `${id ? "Updated" : "Created"} preboarding template ${data.name}` });
  return done(PATHS, `Saved ${data.name}.`);
}

export async function addPreboardingItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const t = await prisma.preboardingTemplate.findFirst({ where: { id: str(f, "templateId"), tenantId: viewer.tenantId }, include: { _count: { select: { items: true } } } });
  if (!t) return NO("Template not found.");
  const title = str(f, "title"), kind = str(f, "kind") || "CUSTOM";
  if (!title) return { ok: false, message: "Give the task a title.", errors: { title: "Required" } };
  if (!(PREBOARDING_KINDS as readonly string[]).includes(kind)) return NO("Pick a task type.");
  const refId = str(f, "refId") || null;
  if (refId && !(await refExists(viewer.tenantId, kind, refId))) return NO("The linked form, policy or course was not found.");
  if ((kind === "FORM" || kind === "POLICY" || kind === "TRAINING") && !refId) return NO("Link the form, policy or course this task is about.");
  const days = num(f, "daysBeforeJoining") ?? 7;
  if (Number.isNaN(days) || days < 0 || days > 90) return NO("Days before joining must be 0–90.");
  await prisma.preboardingTemplateItem.create({ data: { templateId: t.id, title: title.slice(0, 160), description: str(f, "description") || null, kind, refId, daysBeforeJoining: Math.round(days), requiresApproval: f.get("requiresApproval") === "on", sortOrder: t._count.items } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PreboardingTemplate", entityId: t.id, summary: `Added "${title}" to ${t.name}` });
  return done(PATHS, `Added "${title}".`);
}

export async function deletePreboardingItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const d = await prisma.preboardingTemplateItem.deleteMany({ where: { id: str(f, "id"), template: { tenantId: viewer.tenantId } } });
  if (!d.count) return NO("Item not found.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: "DELETE", entityType: "PreboardingTemplateItem", entityId: str(f, "id"), summary: "Removed a preboarding template item" });
  return done(PATHS, "Removed.");
}

async function refExists(tenantId: string, kind: string, refId: string): Promise<boolean> {
  if (kind === "FORM") return (await prisma.newHireForm.count({ where: { id: refId, tenantId } })) > 0;
  if (kind === "POLICY") return (await prisma.orgDocument.count({ where: { id: refId, tenantId } })) > 0;
  if (kind === "TRAINING") return (await prisma.course.count({ where: { id: refId, tenantId } })) > 0;
  return true;
}

// ---------------------------------------------------------------------------
//  Per-hire tasks
// ---------------------------------------------------------------------------

export async function generatePreboardingPlanAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.ONBOARDING_MANAGE);
  if (!emp) return NO("That hire is outside your scope.");
  if (emp.status !== "PREBOARDING") return NO(`${emp.displayName} is not preboarding.`);
  const templateId = str(f, "templateId") || null;
  if (templateId && !(await prisma.preboardingTemplate.count({ where: { id: templateId, tenantId: viewer.tenantId } }))) return NO("Template not found.");
  const res = await generatePreboardingPlan(viewer.tenantId, emp.id, { templateId, byUserId: viewer.user.id });
  if (!res.ok) return NO(res.message);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "PreboardingTask", entityId: emp.id, summary: res.message });
  return done(PATHS, res.message);
}

export async function addPreboardingTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.ONBOARDING_MANAGE);
  if (!emp) return NO("That hire is outside your scope.");
  const title = str(f, "title"), kind = str(f, "kind") || "CUSTOM", due = day(str(f, "dueDate"));
  if (!title) return { ok: false, message: "Give the task a title.", errors: { title: "Required" } };
  if (!(PREBOARDING_KINDS as readonly string[]).includes(kind)) return NO("Pick a task type.");
  if (!due) return { ok: false, message: "Pick a due date.", errors: { dueDate: "Required" } };
  const refId = str(f, "refId") || null;
  if (refId && !(await refExists(viewer.tenantId, kind, refId))) return NO("The linked form, policy or course was not found.");
  const t = await prisma.preboardingTask.create({ data: { tenantId: viewer.tenantId, employeeId: emp.id, title: title.slice(0, 160), description: str(f, "description") || null, kind, refId, dueDate: due, requiresApproval: f.get("requiresApproval") === "on" } });
  await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "LIFECYCLE", title: `New preboarding task: ${title}`, link: "/me/onboarding" });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "PreboardingTask", entityId: t.id, summary: `Added "${title}" for ${emp.displayName}` });
  return done(PATHS, `Added "${title}" for ${emp.displayName}.`);
}

/** HR maintenance of a task: waive, reopen, change the due date, remind, delete. */
export async function preboardingTaskOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const t = await prisma.preboardingTask.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!t || !(await scopedEmployee(viewer, t.employeeId, P.ONBOARDING_MANAGE))) return NO("Task not found.");
  const op = str(f, "op"), note = str(f, "note");
  if (op === "waive") {
    if (!note) return NO("Say why the task is waived.");
    if (!PREBOARDING_OPEN.includes(t.status)) return NO("Only an open task can be waived.");
    await prisma.preboardingTask.update({ where: { id: t.id }, data: { status: "WAIVED", decidedAt: new Date(), decidedBy: viewer.user.id, decisionNote: note } });
  } else if (op === "reopen") {
    if (t.status === "SUBMITTED") return NO("It is waiting for review — decide it in the inbox.");
    await prisma.preboardingTask.update({ where: { id: t.id }, data: { status: "PENDING", decidedAt: null, decisionNote: note || null } });
  } else if (op === "due") {
    const due = day(str(f, "dueDate"));
    if (!due) return NO("Pick a due date.");
    await prisma.preboardingTask.update({ where: { id: t.id }, data: { dueDate: due } });
  } else if (op === "remind") {
    await sendPrejoinMessage(viewer.tenantId, { employeeId: t.employeeId, kind: "REMINDER", subject: `Reminder: ${t.title}`, body: `Hi {{first_name}},\n\nPlease finish "${t.title}" (due ${t.dueDate.toISOString().slice(0, 10)}) in BooS-HR before you join on {{joining_date}}.`, sentBy: viewer.user.id });
    await prisma.preboardingTask.update({ where: { id: t.id }, data: { remindersSent: { increment: 1 }, lastRemindedAt: new Date() } });
  } else if (op === "delete") {
    await prisma.preboardingTask.delete({ where: { id: t.id } });
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: op === "delete" ? "DELETE" : "UPDATE", entityType: "PreboardingTask", entityId: t.id, summary: `Preboarding task "${t.title}": ${op}${note ? ` — ${note}` : ""}` });
  return done(PATHS, op === "remind" ? "Reminder sent." : op === "delete" ? "Task removed." : "Task updated.");
}

/** The hire opens a policy task's document — recorded so the acknowledgement is verified. */
export async function openPolicyTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const t = await prisma.preboardingTask.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "POLICY" } });
  if (!t) return NO("Task not found.");
  if (!t.viewedAt) await prisma.preboardingTask.update({ where: { id: t.id }, data: { viewedAt: new Date() } });
  return done(PATHS, "Opened. Read it, then confirm below.");
}

/** The hire completes (or submits for review) one of their tasks. */
export async function submitPreboardingTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const t = await prisma.preboardingTask.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
  if (!t) return NO("Task not found.");
  if (!PREBOARDING_OPEN.includes(t.status)) return NO("This task is already done or waiting for review.");
  if (t.kind === "FORM") return NO("Fill in the form to complete this task.");
  let response: Record<string, string> | null = null;
  if (t.kind === "POLICY") {
    if (!t.viewedAt) return NO("Open and read the policy first.");
    if (Date.now() - t.viewedAt.getTime() < 5_000) return NO("Take a moment to read the policy before confirming.");
    if (f.get("ack") !== "on") return NO("Tick that you have read and understood it.");
    response = { acknowledged: new Date().toISOString() };
    if (t.refId) await prisma.orgDocumentAck.upsert({ where: { documentId_employeeId: { documentId: t.refId, employeeId: viewer.employee.id } }, create: { documentId: t.refId, employeeId: viewer.employee.id }, update: {} });
  } else if (t.kind === "LOCATION") {
    const confirm = str(f, "confirm");
    if (!["YES", "CHANGE"].includes(confirm)) return NO("Confirm the joining location, or ask for a change.");
    response = { confirm, note: str(f, "note").slice(0, 500) };
    if (confirm === "CHANGE" && !response.note) return NO("Say what should change.");
  } else if (["BANK", "TAX", "BENEFITS", "EMERGENCY", "DOCUMENT", "TRAINING"].includes(t.kind)) {
    const closed = await autoCompletePreboardingTasks(viewer.tenantId, viewer.employee.id);
    const now = await prisma.preboardingTask.findUnique({ where: { id: t.id } });
    if (now?.status === "DONE") return done(PATHS, "Done — the system can see it is in place.");
    if (!t.requiresApproval) return NO(closed ? "Some tasks were verified, but not this one yet — add the details on your profile first." : "This closes itself once the details are on your profile. Add them first.");
    response = { note: str(f, "note").slice(0, 500) };
  } else {
    response = { note: str(f, "note").slice(0, 500) };
  }
  const review = t.requiresApproval || (t.kind === "LOCATION" && response?.confirm === "CHANGE");
  await prisma.preboardingTask.update({ where: { id: t.id }, data: { status: review ? "SUBMITTED" : "DONE", submittedAt: new Date(), response: response as Prisma.InputJsonValue } });
  if (review) {
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "PREBOARDING_TASK", entityId: t.id, title: `Preboarding: ${t.title} — ${viewer.employee.displayName}`, details: response?.note || null, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee.id });
    if (!wf.ok) { await prisma.preboardingTask.update({ where: { id: t.id }, data: { status: t.status } }); return NO(wf.message); }
    await prisma.preboardingTask.update({ where: { id: t.id }, data: { workflowRequestId: wf.requestId } });
  }
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PreboardingTask", entityId: t.id, summary: `${viewer.employee.displayName} ${review ? "submitted" : "completed"} "${t.title}"` });
  return done(PATHS, review ? "Submitted — HR will review it." : "Done.");
}

// ---------------------------------------------------------------------------
//  New-hire forms
// ---------------------------------------------------------------------------

export async function saveNewHireFormAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const id = str(f, "id"), name = str(f, "name");
  if (!name) return { ok: false, message: "Name the form.", errors: { name: "Required" } };
  const parsed = parseNewHireFields(String(f.get("fields") ?? ""));
  if (parsed.errors.length) return { ok: false, message: parsed.errors.join(" "), errors: { fields: parsed.errors[0]! } };
  const fields = parsed.fields as unknown as Prisma.InputJsonValue;
  try {
    if (id) {
      const cur = await prisma.newHireForm.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!cur) return NO("Form not found.");
      const changed = JSON.stringify(cur.fields) !== JSON.stringify(parsed.fields);
      await prisma.newHireForm.update({ where: { id }, data: { name: name.slice(0, 80), description: str(f, "description") || null, fields, isActive: f.get("isActive") === "on", version: changed ? cur.version + 1 : cur.version } });
    } else {
      await prisma.newHireForm.create({ data: { tenantId: viewer.tenantId, name: name.slice(0, 80), description: str(f, "description") || null, fields } });
    }
  } catch { return NO("A form with that name already exists."); }
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "NewHireForm", entityId: id || null, summary: `${id ? "Updated" : "Created"} new-hire form ${name} (${parsed.fields.length} field(s))` });
  return done(PATHS, `Saved ${name}.`);
}

export async function submitNewHireFormAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const form = await prisma.newHireForm.findFirst({ where: { id: str(f, "formId"), tenantId: viewer.tenantId, isActive: true } });
  if (!form) return NO("Form not found.");
  const taskId = str(f, "taskId") || null;
  const task = taskId ? await prisma.preboardingTask.findFirst({ where: { id: taskId, tenantId: viewer.tenantId, employeeId: viewer.employee.id, kind: "FORM", refId: form.id } }) : null;
  if (taskId && !task) return NO("Task not found.");
  if (task && !PREBOARDING_OPEN.includes(task.status)) return NO("This form is already submitted.");
  const fields = form.fields as unknown as NewHireField[];
  const answers = Object.fromEntries(fields.map((x) => [x.key, String(f.get(`f_${x.key}`) ?? "")]));
  const r = checkNewHireAnswers(fields, answers);
  if (Object.keys(r.errors).length) return { ok: false, message: "Check the highlighted answers.", errors: Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [`f_${k}`, v])) };
  const sub = await prisma.newHireFormSubmission.create({ data: { tenantId: viewer.tenantId, formId: form.id, employeeId: viewer.employee.id, taskId: task?.id ?? null, formVersion: form.version, answers: r.values } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "NEW_HIRE_FORM", entityId: sub.id, title: `${form.name} — ${viewer.employee.displayName}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee.id });
  if (!wf.ok) { await prisma.newHireFormSubmission.delete({ where: { id: sub.id } }); return NO(wf.message); }
  await prisma.newHireFormSubmission.update({ where: { id: sub.id }, data: { workflowRequestId: wf.requestId } });
  if (task) await prisma.preboardingTask.update({ where: { id: task.id }, data: { status: "SUBMITTED", submittedAt: new Date(), workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "NewHireFormSubmission", entityId: sub.id, summary: `${viewer.employee.displayName} submitted ${form.name}` });
  return done(PATHS, "Submitted — HR will review it.");
}

// ---------------------------------------------------------------------------
//  Pre-joining communication
// ---------------------------------------------------------------------------

export async function savePrejoinMessageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const id = str(f, "id"), name = str(f, "name"), subject = str(f, "subject"), body = String(f.get("body") ?? "").trim();
  const kind = str(f, "kind") || "WELCOME", days = num(f, "daysBeforeJoining") ?? 7;
  if (!name || !subject || !body) return NO("Name, subject and message are required.");
  if (!["WELCOME", "INFO", "REMINDER"].includes(kind)) return NO("Pick a message type.");
  if (Number.isNaN(days) || days < 0 || days > 120) return NO("Send it 0–120 days before joining.");
  const data = { name: name.slice(0, 80), subject: subject.slice(0, 200), body: body.slice(0, 5000), kind, daysBeforeJoining: Math.round(days) };
  try {
    if (id) {
      const cur = await prisma.prejoinMessage.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!cur) return NO("Message not found.");
      if (cur.status === "PENDING_APPROVAL") return NO("It is waiting for approval — withdraw it in your requests to edit.");
      // Editing an approved message sends it back to draft: it needs approval again.
      await prisma.prejoinMessage.update({ where: { id }, data: { ...data, status: "DRAFT" } });
    } else await prisma.prejoinMessage.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  } catch { return NO("A message with that name already exists."); }
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "PrejoinMessage", entityId: id || null, summary: `${id ? "Edited" : "Drafted"} pre-joining message ${data.name}` });
  return done(PATHS, id ? "Saved as a draft. Submit it for approval to send it again." : "Draft saved. Submit it for approval.");
}

export async function prejoinMessageOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const m = await prisma.prejoinMessage.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!m) return NO("Message not found.");
  const op = str(f, "op");
  if (op === "submit") {
    if (!["DRAFT", "REJECTED"].includes(m.status)) return NO("Only a draft can be submitted.");
    await prisma.prejoinMessage.update({ where: { id: m.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "PREJOIN_MESSAGE", entityId: m.id, title: `Pre-joining message: ${m.name}`, details: `${m.subject}\n\n${m.body}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.prejoinMessage.update({ where: { id: m.id }, data: { status: m.status } }); return NO(wf.message); }
    await prisma.prejoinMessage.update({ where: { id: m.id }, data: { workflowRequestId: wf.requestId } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PrejoinMessage", entityId: m.id, summary: `Submitted ${m.name} for approval` });
    return done(PATHS, wf.message);
  }
  if (op === "archive") {
    await prisma.prejoinMessage.update({ where: { id: m.id }, data: { status: "ARCHIVED" } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PrejoinMessage", entityId: m.id, summary: `Archived ${m.name}` });
    return done(PATHS, "Archived.");
  }
  if (op === "send") {
    if (m.status !== "ACTIVE") return NO("Only an approved message can be sent.");
    const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.ONBOARDING_MANAGE);
    if (!emp || emp.status !== "PREBOARDING") return NO("Pick a preboarding hire in your scope.");
    await sendPrejoinMessage(viewer.tenantId, { employeeId: emp.id, messageId: m.id, kind: "MANUAL", subject: m.subject, body: m.body, sentBy: viewer.user.id });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "PrejoinMessageLog", entityId: m.id, summary: `Sent ${m.name} to ${emp.displayName}` });
    return done(PATHS, `Sent to ${emp.displayName}.`);
  }
  return NO("Unknown action.");
}

/** Send scheduled messages and task reminders that are due now (the nightly job does the same). */
export async function runPrejoinDispatchAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const sent = await sendDuePrejoinMessages(viewer.tenantId);
  const reminded = await sendPreboardingReminders(viewer.tenantId);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PrejoinMessageLog", summary: `Dispatched ${sent} scheduled message(s) and ${reminded} task reminder(s)` });
  return done(PATHS, `Sent ${sent} scheduled message(s); reminded about ${reminded} task(s).`);
}

/** The hiring manager (or HR) introduces themselves to a hire before day one. */
export async function sendManagerIntroAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const hireId = str(f, "employeeId");
  const emp = await prisma.employee.findFirst({ where: { id: hireId, tenantId: viewer.tenantId }, select: { id: true, displayName: true, status: true } });
  if (!emp) return NO("Hire not found.");
  const allowed = (await managesEmployee(viewer, emp.id)) || (can(viewer, P.ONBOARDING_MANAGE) && !!(await scopedEmployee(viewer, emp.id, P.ONBOARDING_MANAGE)));
  if (!allowed) return NO("Only the hire's manager or onboarding HR can send an introduction.");
  const message = String(f.get("message") ?? "").trim();
  if (message.length < 10) return { ok: false, message: "Write a short introduction.", errors: { message: "Required" } };
  const from = viewer.employee?.displayName ?? viewer.user.email;
  await sendPrejoinMessage(viewer.tenantId, { employeeId: emp.id, kind: "INTRO", subject: `A hello from ${from}`, body: `${message.slice(0, 3000)}\n\n— ${from}`, sentBy: viewer.user.id });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "PrejoinMessageLog", entityId: emp.id, summary: `${from} sent an introduction to ${emp.displayName}` });
  return done([...PATHS, "/onboarding/people"], `Introduction sent to ${emp.displayName}.`);
}

// ---------------------------------------------------------------------------
//  Provisioning: IT accounts, access and asset reservations
// ---------------------------------------------------------------------------

export async function saveProvisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.ONBOARDING_MANAGE);
  if (!emp) return NO("That hire is outside your scope.");
  const kind = str(f, "kind"), item = str(f, "item"), team = str(f, "ownerTeam") || (kind === "ASSET" ? "ADMIN" : "IT");
  if (!["IT_ACCOUNT", "ACCESS", "ASSET", "EQUIPMENT"].includes(kind)) return NO("Pick what is needed.");
  if (!["IT", "ADMIN", "FINANCE", "HR"].includes(team)) return NO("Pick the team.");
  const assetId = str(f, "assetId") || null;
  let assetName: string | null = null;
  if (assetId) {
    if (kind !== "ASSET") return NO("Only an asset request can reserve an asset.");
    const a = await prisma.asset.findFirst({ where: { id: assetId, tenantId: viewer.tenantId }, include: { assetType: { select: { name: true } } } });
    if (!a) return NO("Asset not found.");
    if (a.status !== "AVAILABLE") return NO("That asset is not available to reserve.");
    assetName = a.name ?? a.assetType.name;
  }
  if (!item && !assetName) return { ok: false, message: "Say what is needed.", errors: { item: "Required" } };
  const neededBy = day(str(f, "neededBy")) ?? emp.dateOfJoining;
  const p = await prisma.$transaction(async (tx) => {
    if (assetId) {
      const held = await tx.asset.updateMany({ where: { id: assetId, status: "AVAILABLE" }, data: { status: "UNAVAILABLE", unavailableReason: `Reserved for ${emp.displayName} (joins ${emp.dateOfJoining.toISOString().slice(0, 10)})` } });
      if (!held.count) throw new Error("That asset was just taken.");
      await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId, kind: "STATUS_CHANGED", employeeId: emp.id, actorId: viewer.user.id, actorLabel: viewer.user.email, toValue: { status: "UNAVAILABLE", reservedFor: emp.displayName }, note: "Reserved for a new hire" });
    }
    return tx.preboardingProvision.create({ data: { tenantId: viewer.tenantId, employeeId: emp.id, kind, item: (item || assetName || "").slice(0, 160), details: str(f, "details") || null, assetId, neededBy, ownerTeam: team, status: assetId ? "RESERVED" : "REQUESTED", requestedBy: viewer.user.id } });
  }).catch((e: Error) => e);
  if (p instanceof Error) return NO(p.message);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "PreboardingProvision", entityId: p.id, summary: `${kind.replace("_", " ").toLowerCase()} for ${emp.displayName}: ${p.item}${assetId ? " (asset reserved)" : ""}` });
  return done(["/onboarding/preboarding/provisioning", ...PATHS], assetId ? `Reserved ${p.item} for ${emp.displayName}.` : `Requested ${p.item} for ${emp.displayName}.`);
}

export async function provisionOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const p = await prisma.preboardingProvision.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!p || !(await scopedEmployee(viewer, p.employeeId, P.ONBOARDING_MANAGE))) return NO("Request not found.");
  const op = str(f, "op"), note = str(f, "note") || null;
  if (["FULFILLED", "CANCELLED"].includes(p.status)) return NO("This request is closed.");
  if (op === "start") {
    await prisma.preboardingProvision.update({ where: { id: p.id }, data: { status: p.assetId ? "RESERVED" : "IN_PROGRESS", assigneeUserId: viewer.user.id, note } });
  } else if (op === "fulfil") {
    await prisma.$transaction(async (tx) => {
      if (p.assetId) {
        await tx.asset.updateMany({ where: { id: p.assetId, tenantId: viewer.tenantId }, data: { status: "ASSIGNED", unavailableReason: null } });
        await tx.assetAssignment.create({ data: { assetId: p.assetId, employeeId: p.employeeId, assignedOn: new Date(), assignedBy: viewer.employee?.id ?? null, notes: "Handed over from a preboarding reservation" } });
        await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: p.assetId, kind: "ASSIGNED", employeeId: p.employeeId, actorId: viewer.user.id, actorLabel: viewer.user.email, note: "Preboarding reservation fulfilled" });
      }
      await tx.preboardingProvision.update({ where: { id: p.id }, data: { status: "FULFILLED", fulfilledAt: new Date(), note: note ?? p.note } });
    });
  } else if (op === "cancel") {
    await prisma.$transaction(async (tx) => {
      if (p.assetId) {
        await tx.asset.updateMany({ where: { id: p.assetId, tenantId: viewer.tenantId, status: "UNAVAILABLE" }, data: { status: "AVAILABLE", unavailableReason: null } });
        await recordAssetEvent(tx, { tenantId: viewer.tenantId, assetId: p.assetId, kind: "STATUS_CHANGED", actorId: viewer.user.id, actorLabel: viewer.user.email, toValue: { status: "AVAILABLE" }, note: "Reservation released" });
      }
      await tx.preboardingProvision.update({ where: { id: p.id }, data: { status: "CANCELLED", note } });
    });
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "PreboardingProvision", entityId: p.id, summary: `${p.item}: ${op}` });
  return done(["/onboarding/preboarding/provisioning", ...PATHS], op === "fulfil" ? "Fulfilled." : op === "cancel" ? "Cancelled." : "In progress.");
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

/** Settings for this area; each group needs its own permission. */
export async function saveJoinSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const scope = str(f, "scope");
  const need = { preboarding: P.ONBOARDING_MANAGE, bgv: P.BGV_MANAGE, roster: P.SHIFT_MANAGE, holiday: P.HOLIDAY_MANAGE, overtime: P.ATTENDANCE_MANAGE }[scope];
  if (!need) return NO("Unknown settings.");
  if (!can(viewer, need)) return NO("You cannot change these settings.");
  await joinSettings(viewer.tenantId);
  const int = (k: string, min: number, max: number) => { const v = num(f, k); return v === null || Number.isNaN(v) ? undefined : Math.max(min, Math.min(max, Math.round(v))); };
  const data: Prisma.JoinSettingUpdateInput =
    scope === "preboarding" ? { preboardingReminderDays: int("preboardingReminderDays", 0, 30), preboardingReminderMax: int("preboardingReminderMax", 0, 20), journeyEscalationDays: int("journeyEscalationDays", 1, 30) }
    : scope === "bgv" ? { bgvDefaultSlaDays: int("bgvDefaultSlaDays", 1, 90), bgvConsentValidDays: int("bgvConsentValidDays", 7, 365) }
    : scope === "roster" ? { swapRequiresApproval: f.get("swapRequiresApproval") === "on", swapMinNoticeHours: int("swapMinNoticeHours", 0, 720), swapSameDepartmentOnly: f.get("swapSameDepartmentOnly") === "on", swapMaxPerMonth: int("swapMaxPerMonth", 0, 31), minRestHours: int("minRestHours", 0, 24) }
    : scope === "holiday" ? { holidayMinCount: int("holidayMinCount", 0, 60), holidayMaxCount: int("holidayMaxCount", 0, 60) }
    : { compOffReminderDays: int("compOffReminderDays", 0, 60), otAnomalyDailyMinutes: int("otAnomalyDailyMinutes", 30, 1440) };
  await prisma.joinSetting.update({ where: { tenantId: viewer.tenantId }, data });
  await writeAudit(viewer, { module: scope === "preboarding" || scope === "bgv" ? "LIFECYCLE" : "ATTENDANCE", action: "UPDATE", entityType: "JoinSetting", summary: `Updated ${scope} settings`, newValue: data });
  return done([...PATHS, "/onboarding/verification", "/attendance/roster/ops", "/time/holidays", "/time/overtime/rules"], "Settings saved.");
}
