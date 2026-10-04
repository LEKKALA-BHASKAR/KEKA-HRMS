"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveWorkflowDefinition, submitGeneralRequest, decideWorkflowTask, withdrawWorkflow, retryWorkflow, createDelegation, startWorkflow,
  testAutomationRule, retryAutomationRun, runEventAutomations, runDateAutomations, govAudit,
  AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS, DATE_TRIGGERS, GENERIC_REQUEST_CATEGORIES, WORKFLOW_ENTITY_TYPES,
  type StepInput, type ValidationRule, type AutomationAction,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { formList, actionDone as done, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => { const v = str(f, k); if (v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);

// ---------------------------------------------------------------------------
//  Workflow definitions (Admin › Workflows)
// ---------------------------------------------------------------------------

function readSteps(f: FormData): StepInput[] {
  const col = (k: string) => f.getAll(`step_${k}`).map(String);
  const names = col("name");
  const pick = (k: string, i: number) => col(k)[i]?.trim() || null;
  return names.map((name, i) => ({
    name, approverType: pick("approverType", i) ?? "", approverRoleId: pick("approverRoleId", i), approverUserId: pick("approverUserId", i),
    approverPermission: pick("approverPermission", i), mode: pick("mode", i) ?? "ANY", conditionField: pick("conditionField", i), conditionOp: pick("conditionOp", i),
    conditionValue: pick("conditionValue", i), slaHours: pick("slaHours", i) ? Number(pick("slaHours", i)) : null, escalateTo: pick("escalateTo", i), escalateUserId: pick("escalateUserId", i),
  }));
}

function readValidations(f: FormData): ValidationRule[] {
  const out: ValidationRule[] = [];
  if (f.get("requireAmount") === "on") out.push({ field: "amount", op: "REQUIRED", message: "Enter an amount." });
  const max = num(f, "maxAmount");
  if (max !== null && Number.isFinite(max)) out.push({ field: "amount", op: "MAX", value: max, message: `The amount cannot exceed ${max}.` });
  const minLen = num(f, "minDetails");
  if (minLen !== null && Number.isFinite(minLen) && minLen > 0) out.push({ field: "details", op: "MIN_LENGTH", value: minLen, message: `Describe the request in at least ${minLen} characters.` });
  return out;
}

export async function saveWorkflowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const res = await saveWorkflowDefinition({
    tenantId: viewer.tenantId, actorUserId: viewer.user.id, id: str(f, "id") || null, entityType: str(f, "entityType"), name: str(f, "name"), description: str(f, "description") || null,
    matchDepartmentId: str(f, "matchDepartmentId") || null, matchLocationId: str(f, "matchLocationId") || null, priority: Number(str(f, "priority") || 0) || 0,
    isActive: f.get("isActive") === "on", validations: readValidations(f), steps: readSteps(f),
  });
  return res.ok ? done(["/admin/workflows", `/admin/workflows/${res.id}`], res.message) : { ok: false, message: res.message };
}

export async function toggleWorkflowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const def = await prisma.workflowDefinition.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, isCurrent: true } });
  if (!def) return { ok: false, message: "Workflow not found." };
  await prisma.workflowDefinition.update({ where: { id: def.id }, data: { isActive: !def.isActive } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "WorkflowDefinition", entityId: def.id, summary: `${def.isActive ? "Paused" : "Resumed"} workflow "${def.name}"` });
  return done(["/admin/workflows"], def.isActive ? "Paused; the built-in route applies until it is resumed." : "Resumed.");
}

// ---------------------------------------------------------------------------
//  Requests and decisions
// ---------------------------------------------------------------------------

export async function submitGeneralRequestAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const category = str(f, "category");
  if (!(category in GENERIC_REQUEST_CATEGORIES)) return { ok: false, message: "Pick a category.", errors: { category: "Required" } };
  const title = str(f, "title");
  if (title.length < 3) return { ok: false, message: "Give the request a title.", errors: { title: "Required" } };
  const amount = num(f, "amount");
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return { ok: false, message: "Enter a valid amount.", errors: { amount: "Invalid" } };
  const res = await submitGeneralRequest({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null, category, title, details: str(f, "details"), amount });
  if (!res.ok) return { ok: false, message: res.message };
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "WorkflowRequest", entityId: res.requestId, summary: `General request: ${title}` });
  return done(["/me/requests", "/inbox"], res.message);
}

export async function decideWorkflowTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const approve = str(f, "decision") === "approve";
  const res = await decideWorkflowTask({ tenantId: viewer.tenantId, taskId: str(f, "taskId"), userId: viewer.user.id, approve, comment: str(f, "comment") || null });
  if (!res.ok) return { ok: false, message: res.message };
  const t = await prisma.workflowTask.findFirst({ where: { id: str(f, "taskId"), tenantId: viewer.tenantId }, select: { requestId: true, request: { select: { title: true } } } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: approve ? "APPROVE" : "REJECT", entityType: "WorkflowRequest", entityId: t?.requestId, summary: `${approve ? "Approved" : "Rejected"} "${t?.request.title ?? "request"}"` });
  return done(["/inbox", "/me/requests", "/admin/workflows"], res.message);
}

export async function withdrawWorkflowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const res = await withdrawWorkflow({ tenantId: viewer.tenantId, requestId: str(f, "requestId"), userId: viewer.user.id });
  if (res.ok) await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "WorkflowRequest", entityId: str(f, "requestId"), summary: "Withdrew a request" });
  return res.ok ? done(["/me/requests", "/inbox"], res.message) : { ok: false, message: res.message };
}

export async function retryWorkflowAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const res = await retryWorkflow({ tenantId: viewer.tenantId, requestId: str(f, "requestId"), userId: viewer.user.id });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "WorkflowRequest", entityId: str(f, "requestId"), summary: `Retried a failed request: ${res.message}` });
  return res.ok ? done(["/admin/workflows"], res.message) : { ok: false, message: res.message };
}

/** Out of office: my approvals go to a colleague (an admin can set one for anyone). */
export async function createDelegationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const delegator = str(f, "delegatorUserId") || viewer.user.id;
  if (delegator !== viewer.user.id && !can(viewer, P.WORKFLOW_MANAGE)) return { ok: false, message: "You can only delegate your own approvals." };
  const startsOn = day(str(f, "startsOn")), endsOn = day(str(f, "endsOn"));
  if (!startsOn || !endsOn) return { ok: false, message: "Pick the dates.", errors: { startsOn: "Required" } };
  const res = await createDelegation({
    tenantId: viewer.tenantId, delegatorUserId: delegator, delegateUserId: str(f, "delegateUserId"), startsOn, endsOn: new Date(endsOn.getTime() + 86_399_999),
    entityTypes: formList(f, "entityTypes"), reason: str(f, "reason") || null, actorUserId: viewer.user.id, handOverPending: f.get("handOver") === "on",
  });
  return res.ok ? done(["/me/requests", "/admin/workflows"], res.message) : { ok: false, message: res.message };
}

export async function revokeDelegationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const d = await prisma.approverDelegation.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, revokedAt: null } });
  if (!d || (d.delegatorUserId !== viewer.user.id && !can(viewer, P.WORKFLOW_MANAGE))) return { ok: false, message: "Delegation not found." };
  await prisma.approverDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date() } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "ApproverDelegation", entityId: d.id, summary: "Ended an approval delegation" });
  return done(["/me/requests", "/admin/workflows"], "Delegation ended.");
}

export async function completeWorkTaskAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await prisma.workTask.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, assigneeUserId: viewer.user.id, status: "OPEN" } });
  if (!t) return { ok: false, message: "Task not found." };
  await prisma.workTask.update({ where: { id: t.id }, data: { status: "DONE", completedAt: new Date() } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "WorkTask", entityId: t.id, summary: `Completed task "${t.title}"` });
  return done(["/inbox", "/me/requests"], "Done.");
}

// ---------------------------------------------------------------------------
//  Automation and notification rules
// ---------------------------------------------------------------------------

function readActions(f: FormData): AutomationAction[] {
  const col = (k: string) => f.getAll(`act_${k}`).map((v) => String(v).trim());
  const types = col("type");
  return types.map((type, i) => ({
    type: type as AutomationAction["type"], to: col("to")[i] || undefined, subject: col("subject")[i] || undefined, body: col("body")[i] || undefined,
    endpointId: col("endpointId")[i] || undefined, templateId: col("templateId")[i] || undefined, dueInDays: col("dueInDays")[i] ? Number(col("dueInDays")[i]) : undefined,
  }));
}

export async function saveAutomationRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const name = str(f, "name"), trigger = str(f, "trigger");
  if (name.length < 3) return { ok: false, message: "Name the rule.", errors: { name: "Required" } };
  if (!(trigger in AUTOMATION_TRIGGERS)) return { ok: false, message: "Pick a trigger.", errors: { trigger: "Required" } };
  const offsetDays = Number(str(f, "offsetDays") || 0);
  if (!Number.isInteger(offsetDays) || offsetDays < -365 || offsetDays > 365) return { ok: false, message: "Days is a whole number from -365 to 365.", errors: { offsetDays: "Invalid" } };
  const actions = readActions(f);
  if (actions.length === 0) return { ok: false, message: "Add at least one action." };
  for (const [i, a] of actions.entries()) {
    if (!(a.type in AUTOMATION_ACTIONS)) return { ok: false, message: `Action ${i + 1}: pick what it does.` };
    if (a.type === "WEBHOOK") {
      if (!a.endpointId || !(await prisma.webhookEndpoint.findFirst({ where: { id: a.endpointId, tenantId: viewer.tenantId }, select: { id: true } }))) return { ok: false, message: `Action ${i + 1}: pick a webhook endpoint.` };
    } else if (a.type === "LETTER") {
      if (!a.templateId || !(await prisma.documentTemplate.findFirst({ where: { id: a.templateId, tenantId: viewer.tenantId }, select: { id: true } }))) return { ok: false, message: `Action ${i + 1}: pick a letter template.` };
      if (!["EMPLOYEE_CREATED", "EMPLOYEE_UPDATED", ...DATE_TRIGGERS].includes(trigger)) return { ok: false, message: `Action ${i + 1}: letters need an employee trigger.` };
    } else {
      if (!a.to) return { ok: false, message: `Action ${i + 1}: say who it goes to.` };
      if (!/^(EMPLOYEE|MANAGER|HR|USER:\S+)$/.test(a.to) && !(a.type === "EMAIL" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.to))) return { ok: false, message: `Action ${i + 1}: "${a.to}" is not EMPLOYEE, MANAGER, HR${a.type === "EMAIL" ? " or an email address" : ""}.` };
      if (!a.subject) return { ok: false, message: `Action ${i + 1}: write a subject.` };
    }
  }
  const entityType = str(f, "entityType");
  const data = {
    name, description: str(f, "description") || null, trigger, offsetDays: DATE_TRIGGERS.has(trigger) ? offsetDays : 0,
    departmentId: str(f, "departmentId") || null, locationId: str(f, "locationId") || null, entityType: entityType && entityType in WORKFLOW_ENTITY_TYPES ? entityType : null,
    actions: actions as unknown as object,
  };
  for (const [ref, model] of [[data.departmentId, "department"], [data.locationId, "location"]] as const) {
    if (!ref) continue;
    const ok = model === "department" ? await prisma.department.findFirst({ where: { id: ref, tenantId: viewer.tenantId } }) : await prisma.location.findFirst({ where: { id: ref, tenantId: viewer.tenantId } });
    if (!ok) return { ok: false, message: `That ${model} was not found.` };
  }
  const id = str(f, "id");
  if (id) {
    const rule = await prisma.automationRule.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!rule) return { ok: false, message: "Rule not found." };
    // A changed rule goes back through activation approval.
    await prisma.automationRule.update({ where: { id }, data: { ...data, status: "DRAFT" } });
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AutomationRule", entityId: id, summary: `Edited automation rule "${name}" (back to draft)`, oldValue: { trigger: rule.trigger, actions: rule.actions }, newValue: data });
    return done(["/admin/workflows"], "Saved as a draft. Submit it for activation.");
  }
  const rule = await prisma.automationRule.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "CREATE", entityType: "AutomationRule", entityId: rule.id, summary: `Created automation rule "${name}" (${trigger})`, newValue: data });
  return done(["/admin/workflows"], "Rule saved as a draft. Submit it for activation.");
}

export async function automationRuleOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const rule = await prisma.automationRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!rule) return { ok: false, message: "Rule not found." };
  const op = str(f, "op");
  if (op === "submit") {
    if (rule.status !== "DRAFT" && rule.status !== "PAUSED") return { ok: false, message: "Only a draft or paused rule can be submitted." };
    await prisma.automationRule.update({ where: { id: rule.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "AUTOMATION_RULE", entityId: rule.id, title: `Activate automation rule "${rule.name}"`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.automationRule.update({ where: { id: rule.id }, data: { status: rule.status } }); return { ok: false, message: wf.message }; }
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AutomationRule", entityId: rule.id, summary: `Submitted "${rule.name}" for activation` });
    const after = await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id }, select: { status: true } });
    return done(["/admin/workflows"], after.status === "ACTIVE" ? "Activated." : "Sent for activation approval.");
  }
  if (op === "pause") {
    if (rule.status !== "ACTIVE") return { ok: false, message: "Only an active rule can be paused." };
    await prisma.automationRule.update({ where: { id: rule.id }, data: { status: "PAUSED" } });
  } else if (op === "delete") {
    await prisma.automationRule.delete({ where: { id: rule.id } });
  } else if (op === "test") {
    const res = await testAutomationRule(viewer.tenantId, rule.id, str(f, "employeeId"));
    await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AutomationRule", entityId: rule.id, summary: `Test-ran "${rule.name}": ${res.message}` });
    return res.ok ? done(["/admin/workflows"], res.message) : { ok: false, message: res.message };
  } else return { ok: false, message: "Unknown action." };
  await govAudit(viewer.tenantId, viewer.user.id, { action: op === "delete" ? "DELETE" : "UPDATE", entityType: "AutomationRule", entityId: rule.id, summary: `${op === "delete" ? "Deleted" : "Paused"} automation rule "${rule.name}"` });
  return done(["/admin/workflows"], op === "delete" ? "Deleted." : "Paused.");
}

export async function retryAutomationRunAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const res = await retryAutomationRun(viewer.tenantId, str(f, "id"));
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AutomationRun", entityId: str(f, "id"), summary: `Retried an automation run: ${res.message}` });
  return res.ok ? done(["/admin/workflows"], res.message) : { ok: false, message: res.message };
}

/** Run event and date automations now, instead of waiting for the job. */
export async function runAutomationsNowAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WORKFLOW_MANAGE);
  const a = await runEventAutomations(viewer.tenantId);
  const b = await runDateAutomations(viewer.tenantId);
  await govAudit(viewer.tenantId, viewer.user.id, { action: "UPDATE", entityType: "AutomationRule", summary: `Ran automations now: ${a.fired + b.fired} fired, ${a.failed + b.failed} failed` });
  return done(["/admin/workflows"], `${a.fired + b.fired} firing(s), ${a.failed + b.failed} failed.`);
}
