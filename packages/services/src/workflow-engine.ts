import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { emitEvent } from "./webhooks";
import { engageBuiltInRoute, applyEngageEffect } from "./engage-depth";
import { isEngageWorkflowType } from "./engage-depth-math";
import { fireRequestAutomations } from "./automation";
import {
  applyAccessRequest, applyChangeRequest, completeComplianceItem, activatePolicyCampaign, publishConsentPurpose,
  runRetention, govAudit,
} from "./governance-core";
import { CASES_DOCS_ROUTES, applyCasesDocsEffect } from "./cases-docs-effects";
import {
  WORKFLOW_ENTITY_TYPES, dueAtFor, finalApprovers, nextApplicableStep, pickDefinition, stepOutcome, validateWorkflowSubmission,
  type RouteContext, type StepSpec, type ValidationRule, type WorkflowEntityType,
} from "./governance-math";

/**
 * The generic workflow engine.
 *
 * A request runs on one definition version (or, when the tenant has not
 * configured one for its entity type, on a built-in route). Each step
 * resolves its approvers at the moment it starts — reporting manager,
 * manager's manager, department head, a role's holders, a named person or
 * a permission's holders — applies out-of-office delegations, never asks
 * the requester to approve their own request, and falls back to the
 * workflow administrators when nobody is left. ANY steps finish on the
 * first approval (parallel-any); ALL steps need every approver. Any
 * rejection ends the request. A step whose condition does not hold is
 * skipped. On the final outcome the entity's effect runs (grant the role,
 * activate the webhook…); if it throws, the request is left in ERROR with
 * the message, and can be retried.
 */

type R = { ok: boolean; message: string };
const WORKFLOW_ADMIN = "admin.workflow.manage";

/** Built-in routes, used when no definition is configured for the entity type. */
export function builtInRoute(entityType: WorkflowEntityType, opts: { reviewerUserId?: string | null; changeKind?: string | null } = {}): StepSpec[] {
  const perm = (name: string, permission: string): StepSpec => ({ order: 1, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS" });
  switch (entityType) {
    case "GENERIC_REQUEST": return [{ order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" }];
    case "ACCESS_REQUEST": return [
      { order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" },
      { ...perm("Security administrator", "admin.security.govern"), order: 2 },
    ];
    case "CHANGE_REQUEST": return [perm("Second administrator", opts.changeKind === "SECURITY_POLICY" ? "admin.auth.manage" : "admin.role.manage")];
    case "WEBHOOK_ENDPOINT": return [perm("Security administrator", "admin.security.govern")];
    case "AUTOMATION_RULE": return [perm("Workflow administrator", WORKFLOW_ADMIN)];
    case "COMPLIANCE_ITEM": return opts.reviewerUserId
      ? [{ order: 1, name: "Reviewer", approverType: "USER", approverUserId: opts.reviewerUserId, mode: "ANY", slaHours: 72, escalateTo: "ADMINS" }]
      : [perm("Compliance manager", "admin.compliance.manage")];
    case "RETENTION_PURGE":
    case "POLICY_PUBLISH":
    case "CONSENT_PURPOSE": return [perm("Compliance manager", "admin.compliance.manage")];
    default: {
      const r = CASES_DOCS_ROUTES[entityType as keyof typeof CASES_DOCS_ROUTES];
      return r ? [perm(r.name, r.permission)] : engageBuiltInRoute(entityType, opts);
    }
  }
}

export interface StartWorkflowInput {
  tenantId: string;
  entityType: WorkflowEntityType;
  entityId?: string | null;
  title: string;
  details?: string | null;
  amount?: number | null;
  category?: string | null;
  data?: Record<string, unknown> | null;
  requesterUserId: string;
  subjectEmployeeId?: string | null;
  privileged?: boolean;
  /** For built-in routes. */
  reviewerUserId?: string | null;
  changeKind?: string | null;
}

async function subjectContext(tenantId: string, employeeId: string | null | undefined) {
  if (!employeeId) return null;
  return prisma.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: {
      id: true, userId: true, departmentId: true, locationId: true,
      department: { select: { head: { select: { userId: true } } } },
      reportingManager: { select: { userId: true, reportingManager: { select: { userId: true } } } },
    },
  });
}

/** The definition (if any) that routes a request, and the steps it runs on. */
export async function resolveRoute(tenantId: string, entityType: WorkflowEntityType, ctx: RouteContext, opts: { reviewerUserId?: string | null; changeKind?: string | null; definitionId?: string | null } = {}) {
  const defs = opts.definitionId
    ? await prisma.workflowDefinition.findMany({ where: { id: opts.definitionId, tenantId }, include: { steps: { orderBy: { order: "asc" } } } })
    : await prisma.workflowDefinition.findMany({ where: { tenantId, entityType, isCurrent: true, isActive: true }, include: { steps: { orderBy: { order: "asc" } } } });
  const def = opts.definitionId ? defs[0] ?? null : pickDefinition(defs, ctx);
  if (def && def.steps.length > 0) return { definition: def, steps: def.steps as StepSpec[] };
  return { definition: null, steps: builtInRoute(entityType, opts) };
}

async function activeDelegations(tenantId: string, entityType: string, at: Date): Promise<Map<string, string>> {
  const rows = await prisma.approverDelegation.findMany({ where: { tenantId, revokedAt: null, startsOn: { lte: at }, endsOn: { gte: at } }, orderBy: { createdAt: "asc" } });
  const map = new Map<string, string>();
  for (const d of rows) if (d.entityTypes.length === 0 || d.entityTypes.includes(entityType)) map.set(d.delegatorUserId, d.delegateUserId);
  return map;
}

async function roleHolders(tenantId: string, roleId: string): Promise<string[]> {
  const rows = await prisma.userRoleAssignment.findMany({
    where: { roleId, role: { tenantId }, user: { loginDisabled: false, isDeactivated: false }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Candidate approvers for a step (before delegation and self-exclusion). */
export async function stepCandidates(tenantId: string, step: StepSpec, subject: Awaited<ReturnType<typeof subjectContext>>): Promise<string[]> {
  switch (step.approverType) {
    case "REPORTING_MANAGER": return [subject?.reportingManager?.userId ?? null].filter((u): u is string => !!u);
    case "SKIP_MANAGER": return [subject?.reportingManager?.reportingManager?.userId ?? null].filter((u): u is string => !!u);
    case "DEPARTMENT_HEAD": return [subject?.department?.head?.userId ?? null].filter((u): u is string => !!u);
    case "ROLE": return step.approverRoleId ? roleHolders(tenantId, step.approverRoleId) : [];
    case "USER": {
      if (!step.approverUserId) return [];
      const u = await prisma.user.findFirst({ where: { id: step.approverUserId, tenantId, loginDisabled: false }, select: { id: true } });
      return u ? [u.id] : [];
    }
    case "PERMISSION": return step.approverPermission ? usersWithPermission(tenantId, step.approverPermission) : [];
    default: return [];
  }
}

async function addEvent(tenantId: string, requestId: string, kind: string, actorUserId: string | null, note?: string | null, tx: Prisma.TransactionClient = prisma) {
  await tx.workflowEvent.create({ data: { tenantId, requestId, kind, actorUserId, note: note ?? null } });
}

async function stepsOf(req: { tenantId: string; definitionId: string | null; route: Prisma.JsonValue }): Promise<StepSpec[]> {
  if (req.definitionId) {
    const steps = await prisma.workflowStep.findMany({ where: { definitionId: req.definitionId }, orderBy: { order: "asc" } });
    if (steps.length) return steps;
  }
  return Array.isArray(req.route) ? (req.route as unknown as StepSpec[]) : [];
}

function contextOf(req: { amount: Prisma.Decimal | null; category: string | null; data: Prisma.JsonValue }, subject: { departmentId: string | null; locationId: string | null } | null): RouteContext {
  const data = (req.data ?? {}) as Record<string, unknown>;
  return { amount: req.amount === null ? null : Number(req.amount), departmentId: subject?.departmentId ?? null, locationId: subject?.locationId ?? null, privileged: !!data.privileged, category: req.category };
}

/** Start the first applicable step at or after `from`, or finish the request. */
async function advance(requestId: string, from: number, actorUserId: string | null): Promise<void> {
  const req = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (req.status !== "PENDING") return;
  const steps = await stepsOf(req);
  const subject = await subjectContext(req.tenantId, req.subjectEmployeeId);
  const ctx = contextOf(req, subject);
  let i = from;
  for (;;) {
    const idx = nextApplicableStep(steps, i, ctx);
    for (let s = i; s < (idx === -1 ? steps.length : idx); s++) await addEvent(req.tenantId, req.id, "SKIPPED", null, `Step ${s + 1} "${steps[s]!.name}" skipped: its condition does not hold`);
    if (idx === -1) { await finish(req.id, "APPROVED", actorUserId); return; }
    const step = steps[idx]!;
    const delegations = await activeDelegations(req.tenantId, req.entityType, new Date());
    let approvers = finalApprovers(await stepCandidates(req.tenantId, step, subject), req.requesterUserId, delegations);
    let note = `Step ${idx + 1} "${step.name}"`;
    if (approvers.length === 0) {
      // Nobody resolvable (no manager, everyone excluded): workflow administrators decide.
      approvers = finalApprovers(await usersWithPermission(req.tenantId, WORKFLOW_ADMIN), req.requesterUserId, delegations);
      note += " — no approver found, sent to workflow administrators";
    }
    if (approvers.length === 0) {
      await addEvent(req.tenantId, req.id, "AUTO_APPROVED", null, `${note}: nobody other than the requester can approve, so the step passed automatically`);
      i = idx + 1;
      continue;
    }
    const now = new Date();
    const dueAt = dueAtFor(step.slaHours, now);
    await prisma.$transaction(async (tx) => {
      await tx.workflowRequest.update({ where: { id: req.id }, data: { currentStep: idx } });
      await tx.workflowTask.createMany({
        data: approvers.map((a) => ({ tenantId: req.tenantId, requestId: req.id, stepOrder: idx, stepName: step.name, mode: step.mode ?? "ANY", approverUserId: a.approver, delegatedFromUserId: a.delegatedFrom, dueAt })),
      });
      await addEvent(req.tenantId, req.id, "STEP_STARTED", null, `${note}: waiting on ${approvers.length} approver(s)${(step.mode ?? "ANY") === "ALL" ? " (all must approve)" : ""}`, tx);
      for (const a of approvers.filter((x) => x.delegatedFrom)) await addEvent(req.tenantId, req.id, "DELEGATED", a.delegatedFrom, `Routed to a delegate while the approver is away`, tx);
    });
    await notify({ tenantId: req.tenantId, userIds: approvers.map((a) => a.approver), kind: "WORKFLOW", title: `Approval needed: ${req.title}`, link: `/inbox?cat=workflows`, email: true, relatedType: "WorkflowRequest", relatedId: req.id });
    return;
  }
}

/** Run the entity's effect for an outcome. */
async function applyEffect(req: { id: string; tenantId: string; entityType: string; entityId: string | null }, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  const approved = outcome === "APPROVED";
  switch (req.entityType) {
    case "GENERIC_REQUEST": return;
    case "ACCESS_REQUEST":
      if (!id) return;
      if (approved) await applyAccessRequest(t, id, actorUserId);
      else await prisma.accessRequest.updateMany({ where: { id, tenantId: t, status: "PENDING" }, data: { status: outcome, decidedAt: new Date() } });
      return;
    case "CHANGE_REQUEST":
      if (!id) return;
      if (approved) await applyChangeRequest(t, id, actorUserId);
      else await prisma.changeRequest.updateMany({ where: { id, tenantId: t, status: "PENDING" }, data: { status: outcome } });
      return;
    case "WEBHOOK_ENDPOINT":
      if (!id) return;
      await prisma.webhookEndpoint.updateMany({ where: { id, tenantId: t }, data: approved ? { approvalStatus: "APPROVED", isActive: true } : { approvalStatus: "REJECTED", isActive: false } });
      await govAudit(t, actorUserId, { action: approved ? "APPROVE" : "REJECT", entityType: "WebhookEndpoint", entityId: id, summary: `Webhook endpoint ${approved ? "approved and activated" : outcome.toLowerCase()}` });
      return;
    case "AUTOMATION_RULE":
      if (!id) return;
      await prisma.automationRule.updateMany({ where: { id, tenantId: t }, data: approved ? { status: "ACTIVE", watermark: new Date() } : { status: "DRAFT" } });
      await govAudit(t, actorUserId, { action: approved ? "APPROVE" : "REJECT", entityType: "AutomationRule", entityId: id, summary: `Automation rule ${approved ? "activated" : `returned to draft (${outcome.toLowerCase()})`}` });
      return;
    case "RETENTION_PURGE": {
      if (!id) return;
      if (approved) {
        const run = await prisma.retentionRun.findFirst({ where: { id, tenantId: t } });
        if (!run) throw new Error("Purge request not found.");
        await runRetention(t, run.ruleId, { dryRun: false, actorUserId, workflowRequestId: req.id, runId: run.id });
      } else await prisma.retentionRun.updateMany({ where: { id, tenantId: t }, data: { status: "REJECTED" } });
      return;
    }
    case "COMPLIANCE_ITEM":
      if (!id) return;
      if (approved) await completeComplianceItem(t, id, actorUserId);
      else await prisma.complianceItem.updateMany({ where: { id, tenantId: t, status: "SUBMITTED" }, data: { status: "IN_PROGRESS" } });
      return;
    case "POLICY_PUBLISH":
      if (!id) return;
      if (approved) await activatePolicyCampaign(t, id, actorUserId);
      else await prisma.policyCampaign.updateMany({ where: { id, tenantId: t }, data: { status: "REJECTED", closedAt: new Date() } });
      return;
    case "CONSENT_PURPOSE":
      if (!id) return;
      if (approved) await publishConsentPurpose(t, id, actorUserId);
      else await prisma.consentPurpose.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
      return;
    default:
      if (isEngageWorkflowType(req.entityType)) await applyEngageEffect(req, outcome, actorUserId);
      else if (id) await applyCasesDocsEffect(req, outcome, actorUserId);
      return;
  }
}

async function finish(requestId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const req = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: requestId } });
  await prisma.workflowTask.updateMany({ where: { requestId, status: "PENDING" }, data: { status: "CANCELLED" } });
  try {
    await applyEffect(req, outcome, actorUserId);
    await prisma.workflowRequest.update({ where: { id: requestId }, data: { status: outcome, decidedAt: req.decidedAt ?? new Date(), completedAt: new Date(), lastError: null } });
    await addEvent(req.tenantId, requestId, "COMPLETED", actorUserId, `Request ${outcome.toLowerCase()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.workflowRequest.update({ where: { id: requestId }, data: { status: "ERROR", decidedAt: new Date(), lastError: msg.slice(0, 1000), data: { ...((req.data ?? {}) as object), pendingOutcome: outcome } } });
    await addEvent(req.tenantId, requestId, "ERROR", actorUserId, `The ${outcome.toLowerCase()} outcome could not be applied: ${msg}`);
    return;
  }
  if (outcome !== "WITHDRAWN") {
    await notify({ tenantId: req.tenantId, userIds: [req.requesterUserId], kind: "WORKFLOW", title: `${req.title}: ${outcome === "APPROVED" ? "approved" : "rejected"}`, link: "/me/requests", email: true, relatedType: "WorkflowRequest", relatedId: req.id });
    await emitEvent(req.tenantId, "workflow.completed", { requestId: req.id, entityType: req.entityType, entityId: req.entityId, outcome, title: req.title });
    await fireRequestAutomations(req.tenantId, outcome, req);
  }
}

/** Submit a request into its workflow. */
export async function startWorkflow(input: StartWorkflowInput): Promise<R & { requestId?: string }> {
  if (!(input.entityType in WORKFLOW_ENTITY_TYPES)) return { ok: false, message: "Unknown request type." };
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Give the request a title." };
  const subject = await subjectContext(input.tenantId, input.subjectEmployeeId);
  const ctx: RouteContext = { amount: input.amount ?? null, departmentId: subject?.departmentId ?? null, locationId: subject?.locationId ?? null, privileged: !!input.privileged, category: input.category ?? null };
  const { definition, steps } = await resolveRoute(input.tenantId, input.entityType, ctx, { reviewerUserId: input.reviewerUserId, changeKind: input.changeKind });
  const problems = validateWorkflowSubmission(definition?.validations as ValidationRule[] | null, { amount: input.amount ?? null, title, details: input.details ?? null });
  if (problems.length) return { ok: false, message: problems.join(" ") };
  const req = await prisma.workflowRequest.create({
    data: {
      tenantId: input.tenantId, definitionId: definition?.id ?? null, entityType: input.entityType, entityId: input.entityId ?? null,
      category: input.category ?? null, title, details: input.details?.trim() || null, amount: input.amount ?? null,
      data: { ...(input.data ?? {}), privileged: !!input.privileged } as Prisma.InputJsonValue,
      requesterUserId: input.requesterUserId, subjectEmployeeId: subject?.id ?? null,
      route: definition ? undefined : (steps as unknown as Prisma.InputJsonValue),
    },
  });
  await addEvent(input.tenantId, req.id, "SUBMITTED", input.requesterUserId, definition ? `Routed by "${definition.name}" v${definition.version}` : "Routed by the built-in route");
  await advance(req.id, 0, input.requesterUserId);
  const after = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: req.id }, select: { status: true } });
  return { ok: true, requestId: req.id, message: after.status === "APPROVED" ? "Approved automatically." : after.status === "ERROR" ? "Submitted, but the approval could not be applied." : "Submitted for approval." };
}

/** An approver's decision on their task. */
export async function decideWorkflowTask(input: { tenantId: string; taskId: string; userId: string; approve: boolean; comment?: string | null }): Promise<R> {
  const task = await prisma.workflowTask.findFirst({ where: { id: input.taskId, tenantId: input.tenantId }, include: { request: true } });
  if (!task || task.approverUserId !== input.userId) return { ok: false, message: "That approval is not waiting on you." };
  if (task.status !== "PENDING" || task.request.status !== "PENDING") return { ok: false, message: "This has already been decided." };
  if (task.request.requesterUserId === input.userId) return { ok: false, message: "You cannot approve your own request." };
  if (!input.approve && !input.comment?.trim()) return { ok: false, message: "Say why it is rejected." };
  const res = await prisma.workflowTask.updateMany({ where: { id: task.id, status: "PENDING" }, data: { status: input.approve ? "APPROVED" : "REJECTED", decidedAt: new Date(), comment: input.comment?.trim() || null } });
  if (res.count === 0) return { ok: false, message: "This has already been decided." };
  await addEvent(input.tenantId, task.requestId, input.approve ? "APPROVED" : "REJECTED", input.userId, `${task.stepName}${input.comment?.trim() ? `: ${input.comment.trim()}` : ""}`);
  if (!input.approve) {
    await prisma.workflowRequest.update({ where: { id: task.requestId }, data: { decidedAt: new Date() } });
    await finish(task.requestId, "REJECTED", input.userId);
    return { ok: true, message: "Rejected." };
  }
  const siblings = await prisma.workflowTask.findMany({ where: { requestId: task.requestId, stepOrder: task.stepOrder }, select: { status: true } });
  const outcome = stepOutcome(task.mode, siblings.map((s) => s.status));
  if (outcome === "APPROVED") {
    await prisma.workflowTask.updateMany({ where: { requestId: task.requestId, stepOrder: task.stepOrder, status: "PENDING" }, data: { status: "CANCELLED" } });
    await advance(task.requestId, task.stepOrder + 1, input.userId);
    const after = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: task.requestId }, select: { status: true } });
    return { ok: true, message: after.status === "APPROVED" ? "Approved — the request is complete." : after.status === "ERROR" ? "Approved, but applying it failed; an administrator can retry." : "Approved — moved to the next step." };
  }
  return { ok: true, message: "Approved — waiting on the other approvers of this step." };
}

/** The requester takes a pending request back. */
export async function withdrawWorkflow(input: { tenantId: string; requestId: string; userId: string }): Promise<R> {
  const req = await prisma.workflowRequest.findFirst({ where: { id: input.requestId, tenantId: input.tenantId } });
  if (!req || req.requesterUserId !== input.userId) return { ok: false, message: "Request not found." };
  if (req.status !== "PENDING") return { ok: false, message: "Only a pending request can be withdrawn." };
  await addEvent(input.tenantId, req.id, "WITHDRAWN", input.userId, null);
  await finish(req.id, "WITHDRAWN", input.userId);
  return { ok: true, message: "Withdrawn." };
}

/** Error recovery: apply the decided outcome again. */
export async function retryWorkflow(input: { tenantId: string; requestId: string; userId: string }): Promise<R> {
  const req = await prisma.workflowRequest.findFirst({ where: { id: input.requestId, tenantId: input.tenantId } });
  if (!req) return { ok: false, message: "Request not found." };
  if (req.status !== "ERROR") return { ok: false, message: "Only a request in error can be retried." };
  const outcome = (((req.data ?? {}) as Record<string, unknown>).pendingOutcome as "APPROVED" | "REJECTED" | "WITHDRAWN" | undefined) ?? "APPROVED";
  await addEvent(input.tenantId, req.id, "RETRIED", input.userId, null);
  await finish(req.id, outcome, input.userId);
  const after = await prisma.workflowRequest.findUniqueOrThrow({ where: { id: req.id }, select: { status: true, lastError: true } });
  return after.status === "ERROR" ? { ok: false, message: `Still failing: ${after.lastError}` } : { ok: true, message: `Recovered: request ${after.status.toLowerCase()}.` };
}

/**
 * Timers: escalate tasks past their SLA (to the approver's manager, a named
 * person or the workflow administrators) and remind approvers of tasks
 * waiting longer than the tenant's reminder interval.
 */
export async function runWorkflowTimers(tenantId: string, now = new Date()): Promise<{ escalated: number; reminded: number }> {
  let escalated = 0, reminded = 0;
  const overdue = await prisma.workflowTask.findMany({ where: { tenantId, status: "PENDING", dueAt: { lte: now }, escalatedAt: null, request: { status: "PENDING" } }, include: { request: true } });
  for (const t of overdue) {
    const steps = await stepsOf(t.request);
    const step = steps[t.stepOrder];
    let targets: string[] = [];
    if (step?.escalateTo === "USER" && step.escalateUserId) targets = [step.escalateUserId];
    else if (step?.escalateTo === "MANAGER_OF_APPROVER") {
      const e = await prisma.employee.findFirst({ where: { tenantId, userId: t.approverUserId }, select: { reportingManager: { select: { userId: true } } } });
      targets = [e?.reportingManager?.userId ?? null].filter((u): u is string => !!u);
    }
    if (targets.length === 0 && step?.escalateTo) targets = await usersWithPermission(tenantId, WORKFLOW_ADMIN);
    const delegations = await activeDelegations(tenantId, t.request.entityType, now);
    const next = finalApprovers(targets, t.request.requesterUserId, delegations).filter((a) => a.approver !== t.approverUserId);
    if (next.length === 0) {
      await prisma.workflowTask.update({ where: { id: t.id }, data: { escalatedAt: now } });
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.workflowTask.update({ where: { id: t.id }, data: { status: "ESCALATED", escalatedAt: now } });
      await tx.workflowTask.createMany({ data: next.map((a) => ({ tenantId, requestId: t.requestId, stepOrder: t.stepOrder, stepName: t.stepName, mode: t.mode, approverUserId: a.approver, delegatedFromUserId: a.delegatedFrom })) });
      await addEvent(tenantId, t.requestId, "ESCALATED", null, `"${t.stepName}" passed its ${step?.slaHours ?? "?"}h SLA and was escalated to ${next.length} approver(s)`, tx);
    });
    await notify({ tenantId, userIds: next.map((a) => a.approver), kind: "WORKFLOW", title: `Escalated to you: ${t.request.title}`, link: "/inbox?cat=workflows", email: true });
    escalated++;
  }
  const settings = await prisma.governanceSetting.findUnique({ where: { tenantId }, select: { reminderHours: true } });
  const cutoff = new Date(now.getTime() - (settings?.reminderHours ?? 24) * 3_600_000);
  const stale = await prisma.workflowTask.findMany({ where: { tenantId, status: "PENDING", createdAt: { lte: cutoff }, OR: [{ remindedAt: null }, { remindedAt: { lte: cutoff } }], request: { status: "PENDING" } }, include: { request: { select: { title: true } } } });
  for (const t of stale) {
    await prisma.workflowTask.update({ where: { id: t.id }, data: { remindedAt: now } });
    await addEvent(tenantId, t.requestId, "REMINDED", null, `Reminder sent for "${t.stepName}"`);
    await notify({ tenantId, userIds: [t.approverUserId], kind: "WORKFLOW", title: `Reminder: ${t.request.title} is waiting for you`, link: "/inbox?cat=workflows", email: true });
    reminded++;
  }
  return { escalated, reminded };
}

/** Simulation: who would approve, step by step, without creating anything. */
export async function simulateWorkflow(input: { tenantId: string; entityType: WorkflowEntityType; requesterUserId: string; subjectEmployeeId?: string | null; amount?: number | null; category?: string | null; privileged?: boolean; definitionId?: string | null }) {
  const subject = await subjectContext(input.tenantId, input.subjectEmployeeId);
  const ctx: RouteContext = { amount: input.amount ?? null, departmentId: subject?.departmentId ?? null, locationId: subject?.locationId ?? null, privileged: !!input.privileged, category: input.category ?? null };
  const { definition, steps } = await resolveRoute(input.tenantId, input.entityType, ctx, { definitionId: input.definitionId });
  const delegations = await activeDelegations(input.tenantId, input.entityType, new Date());
  const out: Array<{ order: number; name: string; applies: boolean; mode: string; approvers: Array<{ userId: string; delegatedFrom: string | null }>; fallback: boolean }> = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const applies = nextApplicableStep(steps, i, ctx) === i;
    let approvers = applies ? finalApprovers(await stepCandidates(input.tenantId, s, subject), input.requesterUserId, delegations) : [];
    let fallback = false;
    if (applies && approvers.length === 0) { approvers = finalApprovers(await usersWithPermission(input.tenantId, WORKFLOW_ADMIN), input.requesterUserId, delegations); fallback = true; }
    out.push({ order: i + 1, name: s.name, applies, mode: s.mode ?? "ANY", approvers: approvers.map((a) => ({ userId: a.approver, delegatedFrom: a.delegatedFrom })), fallback });
  }
  const problems = validateWorkflowSubmission(definition?.validations as ValidationRule[] | null, { amount: input.amount ?? null, title: "simulation", details: "simulation" });
  return { definition: definition ? { id: definition.id, name: definition.name, version: definition.version } : null, steps: out, problems };
}

/** Delegate my pending approvals now, as well as future ones. */
export async function reassignPendingToDelegate(tenantId: string, delegatorUserId: string, delegateUserId: string, entityTypes: string[]): Promise<number> {
  const tasks = await prisma.workflowTask.findMany({ where: { tenantId, approverUserId: delegatorUserId, status: "PENDING", request: { status: "PENDING", ...(entityTypes.length ? { entityType: { in: entityTypes } } : {}) } }, include: { request: { select: { requesterUserId: true } } } });
  let n = 0;
  for (const t of tasks) {
    if (t.request.requesterUserId === delegateUserId) continue;
    await prisma.workflowTask.update({ where: { id: t.id }, data: { approverUserId: delegateUserId, delegatedFromUserId: delegatorUserId } });
    await addEvent(tenantId, t.requestId, "DELEGATED", delegatorUserId, "Pending approval handed to a delegate");
    n++;
  }
  if (n) await notify({ tenantId, userIds: [delegateUserId], kind: "WORKFLOW", title: `${n} approval(s) delegated to you`, link: "/inbox?cat=workflows" });
  return n;
}
