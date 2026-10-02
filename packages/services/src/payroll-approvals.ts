import { prisma, type Prisma } from "@keka/db";
import { formatPeriod } from "@keka/shared";
import { notify } from "./lifecycle";

/**
 * Payroll maker-checker: locking a payroll and changing someone's salary can
 * each need sign-off from a chain of roles, set per pay group (Payroll
 * settings > Approval workflow). A request moves up the chain one level at a
 * time; any user holding the level's role can act. Levels whose role the
 * requester holds are skipped, since nobody signs off their own change, and
 * the requester can never approve. A rejection at any level ends it.
 *
 * This module only moves requests along; callers apply the outcome (lock the
 * run, apply the revision) when a request comes back APPROVED or REJECTED.
 */

export type ApprovalKind = "LOCK_PAYROLL" | "COMPENSATION_CHANGE" | "JOB_CHANGE";
type Payload = { chain: string[]; ruleId: string; ruleName: string; revisionId?: string; jobChangeId?: string; employeeId?: string; summary?: string };
interface Comment { level: number; userId: string; decision: "APPROVE" | "REJECT" | "SKIP" | "WITHDRAW"; comment?: string | null; at: string }

async function rolesOf(userId: string): Promise<Set<string>> {
  const rows = await prisma.userRoleAssignment.findMany({ where: { userId }, select: { roleId: true } });
  return new Set(rows.map((r) => r.roleId));
}

async function usersWithRole(tenantId: string, roleId: string): Promise<string[]> {
  const rows = await prisma.userRoleAssignment.findMany({
    where: { roleId, role: { tenantId }, user: { tenantId, loginDisabled: false, isDeactivated: false } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** The active rule for a pay group and action, when maker-checker is on. */
export async function approvalRuleFor(payGroupId: string, action: ApprovalKind) {
  const g = await prisma.payGroup.findUnique({
    where: { id: payGroupId },
    select: { approvalWorkflowEnabled: true, approvalRules: { where: { action, isActive: true }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const rule = g?.approvalWorkflowEnabled ? g.approvalRules[0] : undefined;
  const chain = Array.isArray(rule?.approverRoleIds) ? (rule!.approverRoleIds as string[]).filter(Boolean) : [];
  return rule && chain.length ? { rule, chain } : null;
}

function nextLevel(chain: string[], from: number, skip: Set<string>): number {
  for (let i = from; i < chain.length; i++) if (!skip.has(chain[i])) return i;
  return -1;
}

async function notifyLevel(tenantId: string, roleId: string, title: string, link: string) {
  const users = await usersWithRole(tenantId, roleId);
  if (users.length) await notify({ tenantId, userIds: users, kind: "PAYROLL", title, link });
}

/**
 * Open a request, or report that none is needed. When every level is one the
 * requester holds, the request is recorded as approved straight away.
 */
export async function openApproval(input: {
  tenantId: string; payGroupId: string; action: ApprovalKind; requestedBy: string; runId?: string | null;
  revisionId?: string; jobChangeId?: string; employeeId?: string; summary: string; link: string;
}): Promise<{ required: false } | { required: true; requestId: string; status: "PENDING" | "APPROVED" }> {
  const found = await approvalRuleFor(input.payGroupId, input.action);
  if (!found) return { required: false };
  const { rule, chain } = found;
  const maker = await rolesOf(input.requestedBy);
  const level = nextLevel(chain, 0, maker);
  const now = new Date().toISOString();
  const comments: Comment[] = chain.slice(0, level === -1 ? chain.length : level).map((_, i) => ({ level: i, userId: input.requestedBy, decision: "SKIP", comment: "Requester holds this role", at: now }));
  const payload: Payload = { chain, ruleId: rule.id, ruleName: rule.name, revisionId: input.revisionId, jobChangeId: input.jobChangeId, employeeId: input.employeeId, summary: input.summary };
  const req = await prisma.payrollApprovalRequest.create({
    data: {
      runId: input.runId ?? null, action: input.action, status: level === -1 ? "APPROVED" : "PENDING", currentLevel: level === -1 ? chain.length - 1 : level,
      payload: payload as unknown as Prisma.InputJsonValue, requestedBy: input.requestedBy, comments: comments as unknown as Prisma.InputJsonValue,
      resolvedAt: level === -1 ? new Date() : null,
    },
  });
  if (level !== -1) await notifyLevel(input.tenantId, chain[level], `Approval needed: ${input.summary}`, input.link);
  return { required: true, requestId: req.id, status: level === -1 ? "APPROVED" : "PENDING" };
}

/** A pending request belonging to this tenant, with its chain. */
async function loadRequest(tenantId: string, requestId: string) {
  const req = await prisma.payrollApprovalRequest.findUnique({ where: { id: requestId }, include: { run: { select: { tenantId: true, year: true, month: true } } } });
  if (!req) return null;
  const payload = (req.payload ?? {}) as Payload;
  if (req.run && req.run.tenantId !== tenantId) return null;
  if (!req.run) {
    const emp = payload.employeeId ? await prisma.employee.findFirst({ where: { id: payload.employeeId, tenantId }, select: { id: true } }) : null;
    if (!emp) return null;
  }
  return { req, payload, comments: (Array.isArray(req.comments) ? req.comments : []) as unknown as Comment[] };
}

export async function decideApproval(input: { tenantId: string; requestId: string; userId: string; approve: boolean; comment?: string | null; link: string }):
  Promise<{ ok: false; message: string } | { ok: true; message: string; outcome: "ADVANCED" | "APPROVED" | "REJECTED"; action: ApprovalKind; runId: string | null; revisionId?: string; jobChangeId?: string }> {
  const loaded = await loadRequest(input.tenantId, input.requestId);
  if (!loaded) return { ok: false, message: "That request was not found." };
  const { req, payload, comments } = loaded;
  if (req.status !== "PENDING") return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  if (req.requestedBy === input.userId) return { ok: false, message: "You raised this request, so someone else has to approve it." };
  const roleId = payload.chain[req.currentLevel];
  const mine = await rolesOf(input.userId);
  if (!mine.has(roleId)) {
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true } });
    return { ok: false, message: `This is waiting on someone with the ${role?.name ?? "next"} role.` };
  }
  if (!input.approve && !input.comment?.trim()) return { ok: false, message: "Give a reason for rejecting." };
  const now = new Date();
  const log: Comment[] = [...comments, { level: req.currentLevel, userId: input.userId, decision: input.approve ? "APPROVE" : "REJECT", comment: input.comment?.trim() || null, at: now.toISOString() }];
  const base = { action: req.action as ApprovalKind, runId: req.runId, revisionId: payload.revisionId, jobChangeId: payload.jobChangeId };
  if (!input.approve) {
    await prisma.payrollApprovalRequest.update({ where: { id: req.id }, data: { status: "REJECTED", resolvedAt: now, comments: log as unknown as Prisma.InputJsonValue } });
    await notify({ tenantId: input.tenantId, userIds: [req.requestedBy], kind: "PAYROLL", title: `Rejected: ${payload.summary ?? payload.ruleName}`, body: input.comment, link: input.link });
    return { ok: true, outcome: "REJECTED", message: "Rejected.", ...base };
  }
  const maker = await rolesOf(req.requestedBy);
  const next = nextLevel(payload.chain, req.currentLevel + 1, maker);
  if (next !== -1) {
    await prisma.payrollApprovalRequest.update({ where: { id: req.id }, data: { currentLevel: next, comments: log as unknown as Prisma.InputJsonValue } });
    await notifyLevel(input.tenantId, payload.chain[next], `Approval needed: ${payload.summary ?? payload.ruleName}`, input.link);
    return { ok: true, outcome: "ADVANCED", message: `Approved at level ${req.currentLevel + 1}; it now goes to level ${next + 1} of ${payload.chain.length}.`, ...base };
  }
  await prisma.payrollApprovalRequest.update({ where: { id: req.id }, data: { status: "APPROVED", resolvedAt: now, comments: log as unknown as Prisma.InputJsonValue } });
  await notify({ tenantId: input.tenantId, userIds: [req.requestedBy], kind: "PAYROLL", title: `Approved: ${payload.summary ?? payload.ruleName}`, link: input.link });
  return { ok: true, outcome: "APPROVED", message: "Approved by every level.", ...base };
}

export async function withdrawApprovalRequest(tenantId: string, requestId: string, userId: string): Promise<{ ok: boolean; message: string; action?: ApprovalKind; runId?: string | null; revisionId?: string; jobChangeId?: string }> {
  const loaded = await loadRequest(tenantId, requestId);
  if (!loaded) return { ok: false, message: "That request was not found." };
  const { req, payload, comments } = loaded;
  if (req.status !== "PENDING") return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  if (req.requestedBy !== userId) return { ok: false, message: "Only the person who raised it can withdraw it." };
  const log = [...comments, { level: req.currentLevel, userId, decision: "WITHDRAW", at: new Date().toISOString() }];
  await prisma.payrollApprovalRequest.update({ where: { id: req.id }, data: { status: "WITHDRAWN", resolvedAt: new Date(), comments: log as unknown as Prisma.InputJsonValue } });
  return { ok: true, message: "Withdrawn.", action: req.action as ApprovalKind, runId: req.runId, revisionId: payload.revisionId, jobChangeId: payload.jobChangeId };
}

/** Requests waiting on a role this user holds, newest first. */
export async function approvalsWaitingOn(tenantId: string, userId: string) {
  const mine = await rolesOf(userId);
  const pending = await prisma.payrollApprovalRequest.findMany({
    where: { status: "PENDING", OR: [{ run: { tenantId } }, { runId: null }] },
    include: { run: { select: { id: true, year: true, month: true, payGroup: { select: { name: true } } } } },
    orderBy: { requestedAt: "desc" },
  });
  const out = [];
  for (const r of pending) {
    const p = (r.payload ?? {}) as Payload;
    if (!r.run && !(p.employeeId && await prisma.employee.count({ where: { id: p.employeeId, tenantId } }))) continue;
    out.push({ ...r, payload: p, mine: mine.has(p.chain?.[r.currentLevel]) && r.requestedBy !== userId, label: p.summary ?? (r.run ? `Lock ${formatPeriod(r.run.year, r.run.month)} payroll` : p.ruleName) });
  }
  return out;
}
