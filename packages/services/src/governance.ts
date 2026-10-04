import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { startWorkflow, runWorkflowTimers, reassignPendingToDelegate } from "./workflow-engine";
import { runEventAutomations, runDateAutomations } from "./automation";
import {
  govAudit, governanceSettings, revokeExpiredGrants, runRetention, sealAuditLog, campaignAudience,
} from "./governance-core";
import {
  APPROVER_TYPES, CONDITION_FIELDS, CONDITION_OPS, WORKFLOW_ENTITY_TYPES, isInactive, orphanReason, ipAllowed, normaliseCidr,
  type AccountLike, type ValidationRule,
} from "./governance-math";

/**
 * Governance operations the app's actions call: workflow definitions
 * (versioned), general requests, delegations; access requests, access
 * reviews, account hygiene, change approvals, security alerts and the IP
 * allowlist; retention purges, consent, compliance items, policy campaigns,
 * findings; and the governance job.
 */

type R = { ok: boolean; message: string };

/** Permissions that make a role privileged: requests for it carry the flag (and can be routed on it). */
export const PRIVILEGED_PERMISSIONS = ["admin.role.manage", "admin.auth.manage", "admin.security.govern", "payroll.run.execute", "payroll.run.approve", "employee.financials.manage", "admin.apikey.manage"];

// ---------------------------------------------------------------------------
//  Workflow definitions
// ---------------------------------------------------------------------------

export interface StepInput {
  name: string; approverType: string; approverRoleId?: string | null; approverUserId?: string | null; approverPermission?: string | null;
  mode?: string; conditionField?: string | null; conditionOp?: string | null; conditionValue?: string | null;
  slaHours?: number | null; escalateTo?: string | null; escalateUserId?: string | null;
}

export interface DefinitionInput {
  tenantId: string; actorUserId: string; id?: string | null;
  entityType: string; name: string; description?: string | null;
  matchDepartmentId?: string | null; matchLocationId?: string | null; priority?: number; isActive?: boolean;
  validations?: ValidationRule[]; steps: StepInput[];
}

function checkSteps(steps: StepInput[]): string | null {
  if (steps.length === 0) return "Add at least one step.";
  if (steps.length > 10) return "A workflow can have up to 10 steps.";
  for (const [i, s] of steps.entries()) {
    const n = `Step ${i + 1}`;
    if (!s.name.trim()) return `${n}: name it.`;
    if (!(s.approverType in APPROVER_TYPES)) return `${n}: pick who approves.`;
    if (s.approverType === "ROLE" && !s.approverRoleId) return `${n}: pick the role.`;
    if (s.approverType === "USER" && !s.approverUserId) return `${n}: pick the person.`;
    if (s.approverType === "PERMISSION" && !s.approverPermission) return `${n}: pick the permission.`;
    if (s.mode && !["ANY", "ALL"].includes(s.mode)) return `${n}: mode is ANY or ALL.`;
    if (s.conditionField) {
      if (!(s.conditionField in CONDITION_FIELDS) || !s.conditionOp || !(s.conditionOp in CONDITION_OPS)) return `${n}: the condition is incomplete.`;
      if (s.conditionField === "amount" && !Number.isFinite(Number(s.conditionValue))) return `${n}: the amount condition needs a number.`;
      if (s.conditionField !== "amount" && !["EQ", "NEQ"].includes(s.conditionOp)) return `${n}: use "is" or "is not" for that condition.`;
    }
    if (s.slaHours !== null && s.slaHours !== undefined && (s.slaHours < 1 || s.slaHours > 720)) return `${n}: SLA is 1–720 hours.`;
    if (s.escalateTo && !["MANAGER_OF_APPROVER", "USER", "ADMINS"].includes(s.escalateTo)) return `${n}: unknown escalation.`;
    if (s.escalateTo === "USER" && !s.escalateUserId) return `${n}: pick who it escalates to.`;
  }
  return null;
}

const stepRows = (steps: StepInput[]) => steps.map((s, i) => ({
  order: i + 1, name: s.name.trim(), approverType: s.approverType, approverRoleId: s.approverRoleId || null, approverUserId: s.approverUserId || null,
  approverPermission: s.approverPermission || null, mode: s.mode || "ANY", conditionField: s.conditionField || null, conditionOp: s.conditionField ? s.conditionOp || null : null,
  conditionValue: s.conditionField ? s.conditionValue ?? null : null, slaHours: s.slaHours ?? null, escalateTo: s.escalateTo || null, escalateUserId: s.escalateTo === "USER" ? s.escalateUserId || null : null,
}));

/**
 * Create a definition, or change one. A version that has ever routed a
 * request is never edited: the change becomes a new version and the old
 * one is retired, so requests already running keep their steps.
 */
export async function saveWorkflowDefinition(input: DefinitionInput): Promise<R & { id?: string; version?: number; newVersion?: boolean }> {
  if (!(input.entityType in WORKFLOW_ENTITY_TYPES)) return { ok: false, message: "Pick what the workflow approves." };
  const name = input.name.trim();
  if (name.length < 2) return { ok: false, message: "Name the workflow." };
  const bad = checkSteps(input.steps);
  if (bad) return { ok: false, message: bad };
  for (const [ref, model] of [[input.matchDepartmentId, "department"], [input.matchLocationId, "location"]] as const) {
    if (!ref) continue;
    const found = model === "department"
      ? await prisma.department.findFirst({ where: { id: ref, tenantId: input.tenantId }, select: { id: true } })
      : await prisma.location.findFirst({ where: { id: ref, tenantId: input.tenantId }, select: { id: true } });
    if (!found) return { ok: false, message: `That ${model} was not found.` };
  }
  const roleIds = input.steps.map((s) => s.approverRoleId).filter((r): r is string => !!r);
  if (roleIds.length && (await prisma.role.count({ where: { id: { in: roleIds }, tenantId: input.tenantId } })) !== new Set(roleIds).size) return { ok: false, message: "A role in the steps was not found." };
  const userIds = input.steps.flatMap((s) => [s.approverUserId, s.escalateUserId]).filter((u): u is string => !!u);
  if (userIds.length && (await prisma.user.count({ where: { id: { in: userIds }, tenantId: input.tenantId } })) !== new Set(userIds).size) return { ok: false, message: "A person in the steps was not found." };
  const header = {
    entityType: input.entityType, name, description: input.description?.trim() || null, matchDepartmentId: input.matchDepartmentId || null,
    matchLocationId: input.matchLocationId || null, priority: input.priority ?? 0, isActive: input.isActive ?? true,
    validations: (input.validations ?? []) as unknown as Prisma.InputJsonValue,
  };
  if (!input.id) {
    const def = await prisma.workflowDefinition.create({ data: { tenantId: input.tenantId, family: "", ...header, createdBy: input.actorUserId, steps: { create: stepRows(input.steps) } } });
    await prisma.workflowDefinition.update({ where: { id: def.id }, data: { family: def.id } });
    await govAudit(input.tenantId, input.actorUserId, { action: "CREATE", entityType: "WorkflowDefinition", entityId: def.id, summary: `Created workflow "${name}" for ${input.entityType} with ${input.steps.length} step(s)` });
    return { ok: true, id: def.id, version: 1, message: `Created "${name}".` };
  }
  const cur = await prisma.workflowDefinition.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!cur) return { ok: false, message: "Workflow not found." };
  if (!cur.isCurrent) return { ok: false, message: "That is an old version; edit the current one." };
  if (cur.entityType !== input.entityType) return { ok: false, message: "A workflow's request type cannot change; create a new workflow instead." };
  const used = (await prisma.workflowRequest.count({ where: { definitionId: cur.id } })) > 0;
  if (!used) {
    await prisma.$transaction([
      prisma.workflowStep.deleteMany({ where: { definitionId: cur.id } }),
      prisma.workflowDefinition.update({ where: { id: cur.id }, data: { ...header, steps: { create: stepRows(input.steps) } } }),
    ]);
    await govAudit(input.tenantId, input.actorUserId, { action: "UPDATE", entityType: "WorkflowDefinition", entityId: cur.id, summary: `Edited workflow "${name}" v${cur.version} (not yet used)` });
    return { ok: true, id: cur.id, version: cur.version, newVersion: false, message: `Saved "${name}" v${cur.version}.` };
  }
  const next = await prisma.$transaction(async (tx) => {
    await tx.workflowDefinition.update({ where: { id: cur.id }, data: { isCurrent: false, supersededAt: new Date() } });
    return tx.workflowDefinition.create({ data: { tenantId: input.tenantId, family: cur.family, version: cur.version + 1, ...header, createdBy: input.actorUserId, steps: { create: stepRows(input.steps) } } });
  });
  await govAudit(input.tenantId, input.actorUserId, { action: "UPDATE", entityType: "WorkflowDefinition", entityId: next.id, summary: `Published workflow "${name}" v${next.version}; v${cur.version} keeps its running requests`, oldValue: { version: cur.version }, newValue: { version: next.version } });
  return { ok: true, id: next.id, version: next.version, newVersion: true, message: `Saved as version ${next.version}. Requests already running stay on version ${cur.version}.` };
}

/** Employee self-service: a general request routed through the engine. */
export async function submitGeneralRequest(input: { tenantId: string; userId: string; employeeId: string | null; category: string; title: string; details: string; amount: number | null }): Promise<R & { requestId?: string }> {
  if (input.details.trim().length < 5) return { ok: false, message: "Describe what you need." };
  return startWorkflow({
    tenantId: input.tenantId, entityType: "GENERIC_REQUEST", title: input.title, details: input.details, amount: input.amount, category: input.category,
    requesterUserId: input.userId, subjectEmployeeId: input.employeeId,
  });
}

export async function createDelegation(input: { tenantId: string; delegatorUserId: string; delegateUserId: string; startsOn: Date; endsOn: Date; entityTypes: string[]; reason: string | null; actorUserId: string; handOverPending: boolean }): Promise<R & { moved?: number }> {
  if (input.delegatorUserId === input.delegateUserId) return { ok: false, message: "Pick someone other than the person away." };
  if (input.endsOn < input.startsOn) return { ok: false, message: "The end date is before the start." };
  if ((input.endsOn.getTime() - input.startsOn.getTime()) / 86_400_000 > 180) return { ok: false, message: "Delegate for up to 180 days at a time." };
  const [a, b] = await Promise.all([
    prisma.user.findFirst({ where: { id: input.delegatorUserId, tenantId: input.tenantId }, select: { id: true } }),
    prisma.user.findFirst({ where: { id: input.delegateUserId, tenantId: input.tenantId, loginDisabled: false }, select: { id: true, email: true } }),
  ]);
  if (!a || !b) return { ok: false, message: "That person was not found." };
  const types = input.entityTypes.filter((t) => t in WORKFLOW_ENTITY_TYPES);
  const d = await prisma.approverDelegation.create({ data: { tenantId: input.tenantId, delegatorUserId: a.id, delegateUserId: b.id, startsOn: input.startsOn, endsOn: input.endsOn, entityTypes: types, reason: input.reason } });
  const now = new Date();
  const moved = input.handOverPending && input.startsOn <= now && input.endsOn >= now ? await reassignPendingToDelegate(input.tenantId, a.id, b.id, types) : 0;
  await govAudit(input.tenantId, input.actorUserId, { action: "CREATE", entityType: "ApproverDelegation", entityId: d.id, summary: `Approvals delegated to ${b.email} from ${input.startsOn.toISOString().slice(0, 10)} to ${input.endsOn.toISOString().slice(0, 10)}${moved ? `; ${moved} pending handed over` : ""}` });
  return { ok: true, moved, message: `Delegation saved${moved ? `; ${moved} pending approval(s) handed over` : ""}.` };
}

// ---------------------------------------------------------------------------
//  Access requests, reviews, hygiene, changes
// ---------------------------------------------------------------------------

export async function isPrivilegedRole(tenantId: string, roleId: string): Promise<boolean> {
  const role = await prisma.role.findFirst({ where: { id: roleId, tenantId }, include: { permissions: { select: { permission: true } } } });
  return !!role && (role.key === "GLOBAL_ADMIN" || role.permissions.some((p) => PRIVILEGED_PERMISSIONS.includes(p.permission)));
}

export async function requestAccess(input: { tenantId: string; requesterUserId: string; targetUserId?: string | null; roleId: string; justification: string; durationDays: number | null }): Promise<R & { id?: string }> {
  const target = input.targetUserId || input.requesterUserId;
  if (input.justification.trim().length < 10) return { ok: false, message: "Explain why the access is needed (10 characters or more)." };
  if (input.durationDays !== null && (input.durationDays < 1 || input.durationDays > 365)) return { ok: false, message: "Ask for 1–365 days, or leave it permanent." };
  const role = await prisma.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId }, select: { id: true, name: true } });
  if (!role) return { ok: false, message: "Role not found." };
  const user = await prisma.user.findFirst({ where: { id: target, tenantId: input.tenantId }, select: { id: true, employee: { select: { id: true } } } });
  if (!user) return { ok: false, message: "Person not found." };
  const held = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: target, roleId: role.id } } });
  if (held && !held.expiresAt) return { ok: false, message: `Already holds ${role.name}.` };
  if (await prisma.accessRequest.count({ where: { tenantId: input.tenantId, targetUserId: target, roleId: role.id, status: "PENDING" } })) return { ok: false, message: `A request for ${role.name} is already waiting.` };
  const privileged = await isPrivilegedRole(input.tenantId, role.id);
  const ar = await prisma.accessRequest.create({ data: { tenantId: input.tenantId, requesterUserId: input.requesterUserId, targetUserId: target, roleId: role.id, justification: input.justification.trim(), durationDays: input.durationDays, privileged } });
  const wf = await startWorkflow({
    tenantId: input.tenantId, entityType: "ACCESS_REQUEST", entityId: ar.id, title: `Access: ${role.name}${input.durationDays ? ` for ${input.durationDays} days` : ""}`,
    details: input.justification.trim(), requesterUserId: input.requesterUserId, subjectEmployeeId: user.employee?.id ?? null, privileged, data: { roleId: role.id, targetUserId: target },
  });
  if (!wf.ok) { await prisma.accessRequest.delete({ where: { id: ar.id } }); return wf; }
  await prisma.accessRequest.update({ where: { id: ar.id }, data: { workflowRequestId: wf.requestId } });
  await govAudit(input.tenantId, input.requesterUserId, { module: "ROLE", action: "CREATE", entityType: "AccessRequest", entityId: ar.id, summary: `Requested ${role.name}${privileged ? " (privileged)" : ""}${input.durationDays ? ` for ${input.durationDays} days` : ""}` });
  return { ok: true, id: ar.id, message: wf.message === "Submitted for approval." ? `Requested ${role.name}; it is waiting for approval.` : wf.message };
}

/** Grant a role for a limited time (temporary elevated access), by an administrator. */
export async function grantTemporaryAccess(input: { tenantId: string; actorUserId: string; userId: string; roleId: string; days: number; reason: string }): Promise<R> {
  if (input.days < 1 || input.days > 90) return { ok: false, message: "Temporary access lasts 1–90 days." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Give a reason." };
  const [role, user] = await Promise.all([
    prisma.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId }, select: { id: true, name: true } }),
    prisma.user.findFirst({ where: { id: input.userId, tenantId: input.tenantId }, select: { id: true, email: true } }),
  ]);
  if (!role || !user) return { ok: false, message: "Role or person not found." };
  const held = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: user.id, roleId: role.id } } });
  if (held && !held.expiresAt) return { ok: false, message: `${user.email} already holds ${role.name} permanently.` };
  const expiresAt = new Date(Date.now() + input.days * 86_400_000);
  if (held) await prisma.userRoleAssignment.update({ where: { id: held.id }, data: { expiresAt, grantNote: `Temporary: ${input.reason.trim()}` } });
  else await prisma.userRoleAssignment.create({ data: { userId: user.id, roleId: role.id, grantedBy: input.actorUserId, expiresAt, grantNote: `Temporary: ${input.reason.trim()}` } });
  await govAudit(input.tenantId, input.actorUserId, { module: "ROLE", action: "CREATE", entityType: "UserRoleAssignment", entityId: user.id, summary: `Temporary ${role.name} for ${user.email} until ${expiresAt.toISOString().slice(0, 10)}: ${input.reason.trim()}` });
  await notify({ tenantId: input.tenantId, userIds: [user.id], kind: "ACCESS", title: `You have ${role.name} until ${expiresAt.toISOString().slice(0, 10)}`, link: "/me/requests?tab=access" });
  return { ok: true, message: `${user.email} holds ${role.name} until ${expiresAt.toISOString().slice(0, 10)}.` };
}

export async function revokeAccessRequestGrant(input: { tenantId: string; actorUserId: string; accessRequestId: string }): Promise<R> {
  const ar = await prisma.accessRequest.findFirst({ where: { id: input.accessRequestId, tenantId: input.tenantId, status: "APPROVED" } });
  if (!ar) return { ok: false, message: "No active grant for that request." };
  if (ar.assignmentId) await prisma.userRoleAssignment.deleteMany({ where: { id: ar.assignmentId } });
  await prisma.accessRequest.update({ where: { id: ar.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  await govAudit(input.tenantId, input.actorUserId, { module: "ROLE", action: "DELETE", entityType: "AccessRequest", entityId: ar.id, summary: "Revoked access granted through an access request" });
  return { ok: true, message: "Access revoked." };
}

async function unscopedGlobalAdmins(tenantId: string) {
  return prisma.userRoleAssignment.count({ where: { role: { tenantId, key: "GLOBAL_ADMIN" }, scopes: { none: {} }, user: { loginDisabled: false, isDeactivated: false }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
}

/** Remove a grant unless it is the last unscoped Global Admin. */
async function revokeAssignment(tenantId: string, assignmentId: string): Promise<R> {
  const a = await prisma.userRoleAssignment.findFirst({ where: { id: assignmentId, role: { tenantId } }, include: { role: true, scopes: true } });
  if (!a) return { ok: true, message: "Already removed." };
  if (a.role.key === "GLOBAL_ADMIN" && a.scopes.length === 0 && (await unscopedGlobalAdmins(tenantId)) <= 1) return { ok: false, message: "This is the last unscoped Global Admin; it cannot be revoked." };
  await prisma.userRoleAssignment.delete({ where: { id: a.id } });
  return { ok: true, message: "Revoked." };
}

export async function createAccessReview(input: { tenantId: string; actorUserId: string; name: string; reviewerMode: "MANAGER" | "USER"; reviewerUserId: string | null; roleIds: string[]; dueOn: Date; closeAction: "KEEP" | "REVOKE" }): Promise<R & { id?: string; items?: number }> {
  if (input.name.trim().length < 3) return { ok: false, message: "Name the review." };
  if (input.reviewerMode === "USER" && !input.reviewerUserId) return { ok: false, message: "Pick the reviewer." };
  if (input.reviewerUserId && !(await prisma.user.findFirst({ where: { id: input.reviewerUserId, tenantId: input.tenantId }, select: { id: true } }))) return { ok: false, message: "Reviewer not found." };
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { role: { tenantId: input.tenantId }, ...(input.roleIds.length ? { roleId: { in: input.roleIds } } : {}) },
    include: { role: { select: { name: true } }, user: { select: { id: true, employee: { select: { reportingManager: { select: { userId: true } } } } } } },
  });
  if (assignments.length === 0) return { ok: false, message: "No role grants match; nothing to review." };
  const fallback = input.reviewerUserId ?? input.actorUserId;
  const c = await prisma.accessReviewCampaign.create({
    data: {
      tenantId: input.tenantId, name: input.name.trim(), reviewerMode: input.reviewerMode, reviewerUserId: input.reviewerUserId, roleIds: input.roleIds, dueOn: input.dueOn, closeAction: input.closeAction, createdBy: input.actorUserId,
      items: {
        create: assignments.map((a) => {
          let reviewer = input.reviewerMode === "MANAGER" ? a.user.employee?.reportingManager?.userId ?? fallback : fallback;
          // Nobody certifies their own access.
          if (reviewer === a.userId) reviewer = reviewer === input.actorUserId ? (input.reviewerUserId && input.reviewerUserId !== a.userId ? input.reviewerUserId : input.actorUserId) : input.actorUserId;
          return { tenantId: input.tenantId, userId: a.userId, roleId: a.roleId, roleName: a.role.name, assignmentId: a.id, reviewerUserId: reviewer };
        }),
      },
    },
    include: { items: { select: { reviewerUserId: true } } },
  });
  await notify({ tenantId: input.tenantId, userIds: [...new Set(c.items.map((i) => i.reviewerUserId))], kind: "ACCESS_REVIEW", title: `Access review: ${c.name}`, body: `Confirm or revoke each person's roles by ${input.dueOn.toISOString().slice(0, 10)}.`, link: `/admin/security?tab=reviews&id=${c.id}`, email: true });
  await govAudit(input.tenantId, input.actorUserId, { module: "ROLE", action: "CREATE", entityType: "AccessReviewCampaign", entityId: c.id, summary: `Started access review "${c.name}" over ${c.items.length} grant(s)` });
  return { ok: true, id: c.id, items: c.items.length, message: `Review started over ${c.items.length} grant(s).` };
}

export async function decideAccessReviewItem(input: { tenantId: string; actorUserId: string; itemId: string; decision: "CONFIRMED" | "REVOKED"; note: string | null; asAdmin: boolean }): Promise<R> {
  const item = await prisma.accessReviewItem.findFirst({ where: { id: input.itemId, tenantId: input.tenantId }, include: { campaign: true } });
  if (!item) return { ok: false, message: "Review item not found." };
  if (item.campaign.status !== "ACTIVE") return { ok: false, message: "This review is closed." };
  if (item.reviewerUserId !== input.actorUserId && !input.asAdmin) return { ok: false, message: "This item is not yours to review." };
  if (item.userId === input.actorUserId) return { ok: false, message: "You cannot certify your own access." };
  if (input.decision === "REVOKED") {
    const r = await revokeAssignment(input.tenantId, item.assignmentId);
    if (!r.ok) return r;
    await notify({ tenantId: input.tenantId, userIds: [item.userId], kind: "ACCESS", title: `Your ${item.roleName} access was removed in an access review`, link: "/me/requests?tab=access" });
  }
  await prisma.accessReviewItem.update({ where: { id: item.id }, data: { decision: input.decision, note: input.note, decidedAt: new Date(), decidedBy: input.actorUserId } });
  await govAudit(input.tenantId, input.actorUserId, { module: "ROLE", action: input.decision === "REVOKED" ? "DELETE" : "APPROVE", entityType: "AccessReviewItem", entityId: item.id, summary: `Access review "${item.campaign.name}": ${input.decision === "REVOKED" ? "revoked" : "confirmed"} ${item.roleName}` });
  return { ok: true, message: input.decision === "REVOKED" ? `Revoked ${item.roleName}.` : `Confirmed ${item.roleName}.` };
}

export async function closeAccessReview(input: { tenantId: string; actorUserId: string | null; campaignId: string }): Promise<R & { revoked?: number }> {
  const c = await prisma.accessReviewCampaign.findFirst({ where: { id: input.campaignId, tenantId: input.tenantId }, include: { items: { where: { decision: "PENDING" } } } });
  if (!c) return { ok: false, message: "Review not found." };
  if (c.status !== "ACTIVE") return { ok: false, message: "Already closed." };
  let revoked = 0;
  for (const it of c.items) {
    if (c.closeAction === "REVOKE") {
      const r = await revokeAssignment(input.tenantId, it.assignmentId);
      if (r.ok) { revoked++; await prisma.accessReviewItem.update({ where: { id: it.id }, data: { decision: "REVOKED", note: "Not reviewed by the due date", decidedAt: new Date() } }); }
    }
  }
  await prisma.accessReviewCampaign.update({ where: { id: c.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await govAudit(input.tenantId, input.actorUserId, { module: "ROLE", action: "UPDATE", entityType: "AccessReviewCampaign", entityId: c.id, summary: `Closed access review "${c.name}"; ${c.items.length} undecided${revoked ? `, ${revoked} revoked` : ""}` });
  return { ok: true, revoked, message: `Closed${revoked ? `; ${revoked} undecided grant(s) revoked` : ""}.` };
}

/** Every login with inactivity and orphan flags. */
export async function accountHygiene(tenantId: string, now = new Date()) {
  const s = await governanceSettings(tenantId);
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, email: true, loginDisabled: true, isDeactivated: true, lastLoginAt: true, createdAt: true, twoFactor: true, employee: { select: { id: true, status: true, displayName: true } }, _count: { select: { roleAssignments: true } } },
    orderBy: { email: "asc" },
  });
  return users.map((u) => {
    const a: AccountLike = { userId: u.id, email: u.email, loginDisabled: u.loginDisabled, isDeactivated: u.isDeactivated, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, employeeStatus: u.employee?.status ?? null, roleCount: u._count.roleAssignments };
    return { ...a, name: u.employee?.displayName ?? null, twoFactor: u.twoFactor, inactive: isInactive(a, now, s.inactiveDays), orphan: orphanReason(a), inactiveDays: s.inactiveDays };
  });
}

export async function bulkDisableAccounts(input: { tenantId: string; actorUserId: string; userIds: string[]; reason: string }): Promise<R & { disabled?: number }> {
  const ids = [...new Set(input.userIds)].filter((u) => u !== input.actorUserId);
  if (ids.length === 0) return { ok: false, message: "Pick at least one account (not your own)." };
  const r = await prisma.user.updateMany({ where: { tenantId: input.tenantId, id: { in: ids }, loginDisabled: false }, data: { loginDisabled: true, sessionVersion: { increment: 1 } } });
  await govAudit(input.tenantId, input.actorUserId, { module: "AUTH", action: "UPDATE", entityType: "User", summary: `Disabled ${r.count} login(s): ${input.reason}`, newValue: { userIds: ids } });
  return { ok: true, disabled: r.count, message: `Disabled ${r.count} login(s); they are signed out.` };
}

/** Maker-checker for a role grant, a role's permissions or the security policy. */
export async function requestChange(input: { tenantId: string; requestedBy: string; kind: "ROLE_GRANT" | "ROLE_PERMISSIONS" | "SECURITY_POLICY"; summary: string; payload: Record<string, unknown> }): Promise<R & { id?: string }> {
  const cr = await prisma.changeRequest.create({ data: { tenantId: input.tenantId, kind: input.kind, summary: input.summary, payload: input.payload as Prisma.InputJsonValue, requestedBy: input.requestedBy } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "CHANGE_REQUEST", entityId: cr.id, title: input.summary, requesterUserId: input.requestedBy, changeKind: input.kind, privileged: true });
  if (!wf.ok) { await prisma.changeRequest.delete({ where: { id: cr.id } }); return wf; }
  await prisma.changeRequest.update({ where: { id: cr.id }, data: { workflowRequestId: wf.requestId } });
  await govAudit(input.tenantId, input.requestedBy, { module: input.kind === "SECURITY_POLICY" ? "AUTH" : "ROLE", action: "CREATE", entityType: "ChangeRequest", entityId: cr.id, summary: `Proposed: ${input.summary}`, newValue: input.payload });
  return { ok: true, id: cr.id, message: "Sent to a second administrator for approval. It applies once approved." };
}

export async function signInIpAllowed(tenantId: string, ip: string | null): Promise<boolean> {
  const s = await governanceSettings(tenantId);
  if (!s.ipAllowlistEnforced) return true;
  const rules = await prisma.ipAllowRule.findMany({ where: { tenantId }, select: { cidr: true } });
  return ipAllowed(ip, rules.map((r) => r.cidr), true);
}

export async function addIpRule(input: { tenantId: string; actorUserId: string; cidr: string; label: string | null }): Promise<R> {
  const cidr = normaliseCidr(input.cidr);
  if (!cidr) return { ok: false, message: "Enter an IP address or CIDR range, e.g. 203.0.113.0/24." };
  if (await prisma.ipAllowRule.findFirst({ where: { tenantId: input.tenantId, cidr } })) return { ok: false, message: "That range is already on the list." };
  await prisma.ipAllowRule.create({ data: { tenantId: input.tenantId, cidr, label: input.label, createdBy: input.actorUserId } });
  await govAudit(input.tenantId, input.actorUserId, { module: "AUTH", action: "CREATE", entityType: "IpAllowRule", entityId: cidr, summary: `Allowed sign-in from ${cidr}${input.label ? ` (${input.label})` : ""}` });
  return { ok: true, message: `Added ${cidr}.` };
}

/** Raise alerts from the sign-in log: repeated failures and blocked addresses. */
export async function securityScan(tenantId: string, now = new Date()): Promise<{ raised: number }> {
  const s = await governanceSettings(tenantId);
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const fails = await prisma.loginEvent.groupBy({ by: ["email"], where: { tenantId, success: false, outcome: { in: ["BAD_CREDENTIALS", "OTP_FAILED", "LOCKED"] }, createdAt: { gte: hourAgo } }, _count: { _all: true } });
  let raised = 0;
  const hourKey = now.toISOString().slice(0, 13);
  for (const f of fails.filter((x) => x._count._all >= s.failedLoginAlert)) {
    const user = await prisma.user.findFirst({ where: { tenantId, email: f.email }, select: { id: true } });
    const r = await prisma.securityAlert.createMany({ data: [{ tenantId, kind: "FAILED_LOGINS", severity: f._count._all >= s.failedLoginAlert * 2 ? "HIGH" : "MEDIUM", summary: `${f._count._all} failed sign-ins for ${f.email} in the last hour`, userId: user?.id ?? null, dedupeKey: `FAILED_LOGINS:${f.email}:${hourKey}` }], skipDuplicates: true });
    raised += r.count;
  }
  const blocked = await prisma.loginEvent.findMany({ where: { tenantId, outcome: "IP_BLOCKED", createdAt: { gte: new Date(now.getTime() - 86_400_000) } }, select: { id: true, email: true, ipAddress: true, userId: true } });
  for (const b of blocked) {
    const r = await prisma.securityAlert.createMany({ data: [{ tenantId, kind: "IP_BLOCKED", severity: "MEDIUM", summary: `Sign-in for ${b.email} refused from ${b.ipAddress ?? "an unknown address"} (not on the allowlist)`, userId: b.userId, dedupeKey: `IP_BLOCKED:${b.id}` }], skipDuplicates: true });
    raised += r.count;
  }
  if (raised) await notify({ tenantId, userIds: await usersWithPermission(tenantId, "admin.security.govern"), kind: "SECURITY", title: `${raised} new security alert(s)`, link: "/admin/security?tab=alerts", email: true });
  return { raised };
}

/** Second-factor coverage per login, against the tenant's 2FA policy. */
export async function mfaReport(tenantId: string) {
  const policy = (await prisma.tenantSecuritySetting.findUnique({ where: { tenantId }, select: { twoFactorPolicy: true } }))?.twoFactorPolicy ?? "OFF";
  const users = await prisma.user.findMany({ where: { tenantId, loginDisabled: false }, select: { id: true, email: true, lastLoginAt: true, twoFactor: true, _count: { select: { roleAssignments: true } }, employee: { select: { displayName: true } } }, orderBy: { email: "asc" } });
  const since = new Date(Date.now() - 90 * 86_400_000);
  const otp = await prisma.loginEvent.groupBy({ by: ["userId"], where: { tenantId, outcome: "OTP_SENT", createdAt: { gte: since } }, _max: { createdAt: true } });
  const lastOtp = new Map(otp.map((o) => [o.userId, o._max.createdAt]));
  const rows = users.map((u) => {
    const admin = u._count.roleAssignments > 0;
    const required = policy === "EVERYONE" || (policy === "ADMINS" && admin);
    return { userId: u.id, email: u.email, name: u.employee?.displayName ?? null, admin, required, method: required ? "Email code" : u.twoFactor === "NONE" ? "None" : u.twoFactor, lastSecondFactor: lastOtp.get(u.id) ?? null, lastLoginAt: u.lastLoginAt, gap: admin && !required };
  });
  return { policy, rows, required: rows.filter((r) => r.required).length, adminsWithout: rows.filter((r) => r.gap).length };
}

// ---------------------------------------------------------------------------
//  Compliance
// ---------------------------------------------------------------------------

/** Ask for an approved purge: needs a dry run first, so the approver sees what goes. */
export async function requestRetentionPurge(input: { tenantId: string; actorUserId: string; ruleId: string }): Promise<R & { runId?: string }> {
  const rule = await prisma.retentionRule.findFirst({ where: { id: input.ruleId, tenantId: input.tenantId } });
  if (!rule) return { ok: false, message: "Rule not found." };
  const lastDry = await prisma.retentionRun.findFirst({ where: { ruleId: rule.id, status: "DRY_RUN", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, orderBy: { createdAt: "desc" } });
  if (!lastDry) return { ok: false, message: "Run a dry run first (within the last 7 days) so the approver can see what would be removed." };
  if (await prisma.retentionRun.count({ where: { ruleId: rule.id, status: "PENDING_APPROVAL" } })) return { ok: false, message: "A purge for this rule is already waiting for approval." };
  const run = await prisma.retentionRun.create({ data: { tenantId: input.tenantId, ruleId: rule.id, dryRun: false, cutoff: lastDry.cutoff, matched: lastDry.matched, heldBack: lastDry.heldBack, status: "PENDING_APPROVAL", sample: lastDry.sample ?? undefined, runBy: input.actorUserId } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "RETENTION_PURGE", entityId: run.id, title: `Purge ${rule.dataType} older than ${rule.retentionDays} days (${lastDry.matched - lastDry.heldBack} record(s))`, requesterUserId: input.actorUserId, amount: lastDry.matched - lastDry.heldBack });
  if (!wf.ok) { await prisma.retentionRun.delete({ where: { id: run.id } }); return wf; }
  await prisma.retentionRun.update({ where: { id: run.id }, data: { workflowRequestId: wf.requestId } }).catch(() => undefined);
  return { ok: true, runId: run.id, message: wf.message === "Submitted for approval." ? "Purge sent for approval." : wf.message };
}

export async function recordConsent(input: { tenantId: string; employeeId: string; purposeId: string; decision: "GRANTED" | "DECLINED" | "WITHDRAWN"; ip: string | null; actorUserId: string }): Promise<R> {
  const p = await prisma.consentPurpose.findFirst({ where: { id: input.purposeId, tenantId: input.tenantId, status: "PUBLISHED" } });
  if (!p) return { ok: false, message: "That consent request is not open." };
  if (p.mandatory && input.decision !== "GRANTED") return { ok: false, message: "This processing is required for your employment; contact HR if you object." };
  const existing = await prisma.consentRecord.findUnique({ where: { purposeId_employeeId: { purposeId: p.id, employeeId: input.employeeId } } });
  if (input.decision === "WITHDRAWN" && existing?.decision !== "GRANTED") return { ok: false, message: "There is no consent to withdraw." };
  const data = { decision: input.decision, version: p.version, ipAddress: input.ip, recordedAt: new Date(), withdrawnAt: input.decision === "WITHDRAWN" ? new Date() : null };
  await prisma.consentRecord.upsert({ where: { purposeId_employeeId: { purposeId: p.id, employeeId: input.employeeId } }, create: { tenantId: input.tenantId, purposeId: p.id, employeeId: input.employeeId, ...data }, update: data });
  await govAudit(input.tenantId, input.actorUserId, { module: "EMPLOYEE", action: input.decision === "GRANTED" ? "APPROVE" : "UPDATE", entityType: "ConsentRecord", entityId: input.employeeId, summary: `Consent ${input.decision.toLowerCase()}: ${p.title} v${p.version}`, oldValue: existing ? { decision: existing.decision, version: existing.version } : undefined });
  return { ok: true, message: input.decision === "GRANTED" ? "Thank you; your consent is recorded." : input.decision === "WITHDRAWN" ? "Your consent is withdrawn." : "Recorded that you decline." };
}

export async function submitComplianceItem(input: { tenantId: string; actorUserId: string; itemId: string; notes: string | null }): Promise<R> {
  const item = await prisma.complianceItem.findFirst({ where: { id: input.itemId, tenantId: input.tenantId } });
  if (!item) return { ok: false, message: "Item not found." };
  if (!["OPEN", "IN_PROGRESS"].includes(item.status)) return { ok: false, message: "Only open work can be submitted." };
  if (item.evidenceFileIds.length === 0) return { ok: false, message: "Attach evidence before submitting for review." };
  await prisma.complianceItem.update({ where: { id: item.id }, data: { status: "SUBMITTED", submittedAt: new Date(), notes: input.notes ?? item.notes } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "COMPLIANCE_ITEM", entityId: item.id, title: `Sign off: ${item.title} (due ${item.dueOn.toISOString().slice(0, 10)})`, details: input.notes, requesterUserId: input.actorUserId, reviewerUserId: item.reviewerUserId });
  if (!wf.ok) { await prisma.complianceItem.update({ where: { id: item.id }, data: { status: item.status, submittedAt: null } }); return wf; }
  await prisma.complianceItem.update({ where: { id: item.id }, data: { workflowRequestId: wf.requestId } });
  await govAudit(input.tenantId, input.actorUserId, { action: "UPDATE", entityType: "ComplianceItem", entityId: item.id, summary: `Submitted "${item.title}" for sign-off with ${item.evidenceFileIds.length} evidence file(s)` });
  const after = await prisma.complianceItem.findUnique({ where: { id: item.id }, select: { status: true } });
  return { ok: true, message: after?.status === "COMPLETED" ? "Signed off." : "Submitted for sign-off." };
}

export async function launchPolicyCampaign(input: { tenantId: string; actorUserId: string; documentId: string; name: string; dueOn: Date; departmentIds: string[] }): Promise<R & { id?: string }> {
  const doc = await prisma.orgDocument.findFirst({ where: { id: input.documentId, tenantId: input.tenantId } });
  if (!doc) return { ok: false, message: "Policy document not found." };
  if (input.dueOn.getTime() < Date.now() - 86_400_000) return { ok: false, message: "The due date is in the past." };
  if (await prisma.policyCampaign.count({ where: { tenantId: input.tenantId, documentId: doc.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } } })) return { ok: false, message: "This policy already has an open campaign." };
  const c = await prisma.policyCampaign.create({ data: { tenantId: input.tenantId, documentId: doc.id, name: input.name.trim() || doc.title, dueOn: input.dueOn, departmentIds: input.departmentIds, status: "PENDING_APPROVAL", createdBy: input.actorUserId } });
  const wf = await startWorkflow({ tenantId: input.tenantId, entityType: "POLICY_PUBLISH", entityId: c.id, title: `Launch acknowledgement: ${doc.title}${doc.version ? ` (${doc.version})` : ""}`, requesterUserId: input.actorUserId });
  if (!wf.ok) { await prisma.policyCampaign.delete({ where: { id: c.id } }); return wf; }
  await prisma.policyCampaign.update({ where: { id: c.id }, data: { workflowRequestId: wf.requestId } });
  await govAudit(input.tenantId, input.actorUserId, { action: "CREATE", entityType: "PolicyCampaign", entityId: c.id, summary: `Proposed acknowledgement campaign for "${doc.title}"` });
  const after = await prisma.policyCampaign.findUnique({ where: { id: c.id }, select: { status: true } });
  return { ok: true, id: c.id, message: after?.status === "ACTIVE" ? "Campaign launched." : "Campaign sent for approval; it launches once approved." };
}

/** Who has and has not acknowledged a campaign's policy. */
export async function policyCampaignStatus(tenantId: string, campaignId: string) {
  const c = await prisma.policyCampaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!c) return null;
  const people = await campaignAudience(tenantId, c.departmentIds);
  const acks = await prisma.orgDocumentAck.findMany({ where: { documentId: c.documentId, employeeId: { in: people.map((p) => p.id) } }, select: { employeeId: true, acknowledgedAt: true } });
  const at = new Map(acks.map((a) => [a.employeeId, a.acknowledgedAt]));
  const rows = people.map((p) => ({ employeeId: p.id, name: p.displayName ?? `${p.firstName} ${p.lastName}`, employeeNumber: p.employeeNumber, department: p.department?.name ?? "", acknowledgedAt: at.get(p.id) ?? null, userId: p.userId, managerUserId: p.reportingManager?.userId ?? null }));
  return { campaign: c, rows, acknowledged: rows.filter((r) => r.acknowledgedAt).length, total: rows.length };
}

export async function remindPolicyCampaigns(tenantId: string, now = new Date()): Promise<{ reminded: number; closed: number }> {
  const camps = await prisma.policyCampaign.findMany({ where: { tenantId, status: "ACTIVE" } });
  let reminded = 0, closed = 0;
  for (const c of camps) {
    const st = await policyCampaignStatus(tenantId, c.id);
    if (!st) continue;
    const pending = st.rows.filter((r) => !r.acknowledgedAt);
    if (pending.length === 0) { await prisma.policyCampaign.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: now } }); closed++; continue; }
    if (c.lastRemindedAt && now.getTime() - c.lastRemindedAt.getTime() < 3 * 86_400_000) continue;
    const overdue = now > c.dueOn;
    await notify({ tenantId, userIds: pending.map((p) => p.userId), kind: "POLICY", title: `${overdue ? "Overdue" : "Reminder"}: acknowledge ${c.name}`, link: "/me/policies", email: true });
    if (overdue) await notify({ tenantId, userIds: [...new Set(pending.map((p) => p.managerUserId))], kind: "POLICY", title: `Your team has not acknowledged ${c.name}`, link: "/team" });
    await prisma.policyCampaign.update({ where: { id: c.id }, data: { lastRemindedAt: now } });
    reminded += pending.length;
  }
  return { reminded, closed };
}

export async function escalateFindings(tenantId: string, now = new Date()): Promise<{ escalated: number }> {
  const due = await prisma.auditFinding.findMany({ where: { tenantId, status: { not: "CLOSED" }, dueOn: { lt: now }, escalatedAt: null } });
  for (const f of due) {
    const owner = await prisma.employee.findFirst({ where: { tenantId, userId: f.ownerUserId }, select: { reportingManager: { select: { userId: true } } } });
    await prisma.auditFinding.update({ where: { id: f.id }, data: { escalatedAt: now } });
    await notify({ tenantId, userIds: [f.ownerUserId, owner?.reportingManager?.userId ?? null, ...(await usersWithPermission(tenantId, "admin.compliance.manage"))], kind: "COMPLIANCE", title: `Overdue ${f.severity.toLowerCase()} finding: ${f.title}`, link: "/admin/compliance?tab=findings", email: true });
    await govAudit(tenantId, null, { action: "UPDATE", entityType: "AuditFinding", entityId: f.id, summary: `Finding "${f.title}" passed its due date and was escalated` });
  }
  return { escalated: due.length };
}

/** Owners of compliance items that just became overdue hear about it once. */
async function notifyOverdueCompliance(tenantId: string, now: Date): Promise<number> {
  const items = await prisma.complianceItem.findMany({ where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueOn: { lt: now, gte: new Date(now.getTime() - 86_400_000) } } });
  for (const i of items) await notify({ tenantId, userIds: [i.ownerUserId], kind: "COMPLIANCE", title: `Overdue: ${i.title}`, link: "/admin/compliance?tab=checklist", email: true });
  return items.length;
}

/** Retention nightly: auto-apply rules apply; the rest get a fresh dry-run report. */
export async function runRetentionJob(tenantId: string, now = new Date()): Promise<{ applied: number; dryRuns: number; affected: number }> {
  const rules = await prisma.retentionRule.findMany({ where: { tenantId, isActive: true } });
  let applied = 0, dryRuns = 0, affected = 0;
  for (const r of rules) {
    const res = await runRetention(tenantId, r.id, { dryRun: !r.autoApply, actorUserId: null, now });
    if (r.autoApply) { applied++; affected += res.affected; } else dryRuns++;
  }
  return { applied, dryRuns, affected };
}

/** The governance job: everything time-driven, idempotent. */
export async function runGovernanceJob(tenantId: string, now = new Date()) {
  const grants = await revokeExpiredGrants(tenantId, now);
  const timers = await runWorkflowTimers(tenantId, now);
  const events = await runEventAutomations(tenantId, now);
  const dates = await runDateAutomations(tenantId, now);
  const retention = await runRetentionJob(tenantId, now);
  const seal = await sealAuditLog(tenantId);
  const alerts = await securityScan(tenantId, now);
  const policies = await remindPolicyCampaigns(tenantId, now);
  const findings = await escalateFindings(tenantId, now);
  const overdue = await notifyOverdueCompliance(tenantId, now);
  const reviews = await prisma.accessReviewCampaign.findMany({ where: { tenantId, status: "ACTIVE", dueOn: { lt: now } }, select: { id: true } });
  for (const r of reviews) await closeAccessReview({ tenantId, actorUserId: null, campaignId: r.id });
  return {
    expiredGrants: grants.revoked, escalated: timers.escalated, reminded: timers.reminded, automationsFired: events.fired + dates.fired, automationsFailed: events.failed + dates.failed,
    retentionApplied: retention.applied, retentionAffected: retention.affected, sealed: seal.sealed, alerts: alerts.raised, policyReminders: policies.reminded,
    findingsEscalated: findings.escalated, complianceOverdue: overdue, reviewsClosed: reviews.length,
  };
}
