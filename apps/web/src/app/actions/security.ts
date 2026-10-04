"use server";

import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  requestAccess, grantTemporaryAccess, revokeAccessRequestGrant, createAccessReview, decideAccessReviewItem, closeAccessReview,
  bulkDisableAccounts, addIpRule, securityScan, govAudit, ipAllowed, accountHygiene, withdrawWorkflow,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { formList, actionDone as done, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const PATHS = ["/admin/security", "/me/requests"];

// ---------------------------------------------------------------------------
//  Access requests (employee self-service) and time-bound access
// ---------------------------------------------------------------------------

export async function requestAccessAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const raw = str(f, "durationDays");
  const durationDays = raw === "" || raw === "0" ? null : Number(raw);
  if (durationDays !== null && !Number.isInteger(durationDays)) return { ok: false, message: "Duration is a whole number of days.", errors: { durationDays: "Invalid" } };
  const res = await requestAccess({ tenantId: viewer.tenantId, requesterUserId: viewer.user.id, roleId: str(f, "roleId"), justification: str(f, "justification"), durationDays });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function withdrawAccessRequestAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ar = await prisma.accessRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, requesterUserId: viewer.user.id, status: "PENDING" } });
  if (!ar?.workflowRequestId) return { ok: false, message: "Request not found." };
  const res = await withdrawWorkflow({ tenantId: viewer.tenantId, requestId: ar.workflowRequestId, userId: viewer.user.id });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function grantTemporaryAccessAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const res = await grantTemporaryAccess({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, userId: str(f, "userId"), roleId: str(f, "roleId"), days: Number(str(f, "days")), reason: str(f, "reason") });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function revokeAccessGrantAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const res = await revokeAccessRequestGrant({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, accessRequestId: str(f, "id") });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

/** End a time-bound grant early. */
export async function endTemporaryGrantAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const a = await prisma.userRoleAssignment.findFirst({ where: { id: str(f, "id"), role: { tenantId: viewer.tenantId }, expiresAt: { not: null } }, include: { role: true, user: { select: { email: true } } } });
  if (!a) return { ok: false, message: "Time-bound grant not found." };
  await prisma.userRoleAssignment.delete({ where: { id: a.id } });
  await prisma.accessRequest.updateMany({ where: { tenantId: viewer.tenantId, assignmentId: a.id, status: "APPROVED" }, data: { status: "REVOKED", revokedAt: new Date() } });
  await govAudit(viewer.tenantId, viewer.user.id, { module: "ROLE", action: "DELETE", entityType: "UserRoleAssignment", entityId: a.id, summary: `Ended ${a.role.name} for ${a.user.email} early` });
  return done(PATHS, "Ended.");
}

// ---------------------------------------------------------------------------
//  Access reviews
// ---------------------------------------------------------------------------

export async function createAccessReviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const dueOn = day(str(f, "dueOn"));
  if (!dueOn) return { ok: false, message: "Pick a due date.", errors: { dueOn: "Required" } };
  const mode = str(f, "reviewerMode") === "MANAGER" ? "MANAGER" : "USER";
  const res = await createAccessReview({
    tenantId: viewer.tenantId, actorUserId: viewer.user.id, name: str(f, "name"), reviewerMode: mode, reviewerUserId: str(f, "reviewerUserId") || null,
    roleIds: formList(f, "roleIds"), dueOn, closeAction: str(f, "closeAction") === "REVOKE" ? "REVOKE" : "KEEP",
  });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

/** Reviewers (anyone assigned an item) confirm or revoke. */
export async function decideAccessReviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const decision = str(f, "decision") === "REVOKED" ? "REVOKED" : "CONFIRMED";
  const res = await decideAccessReviewItem({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, itemId: str(f, "itemId"), decision, note: str(f, "note") || null, asAdmin: can(viewer, P.SECURITY_GOVERN) });
  return res.ok ? done([...PATHS, "/inbox"], res.message) : { ok: false, message: res.message };
}

export async function closeAccessReviewAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const res = await closeAccessReview({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, campaignId: str(f, "id") });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// ---------------------------------------------------------------------------
//  Account hygiene
// ---------------------------------------------------------------------------

export async function bulkDisableAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  let ids = formList(f, "userIds");
  const which = str(f, "which");
  if (which === "inactive" || which === "orphan") {
    const rows = await accountHygiene(viewer.tenantId);
    ids = rows.filter((r) => (which === "inactive" ? r.inactive : !!r.orphan)).map((r) => r.userId);
  }
  const res = await bulkDisableAccounts({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, userIds: ids, reason: which === "orphan" ? "orphan accounts" : which === "inactive" ? "inactive accounts" : "selected accounts" });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// ---------------------------------------------------------------------------
//  IP allowlist and governance settings
// ---------------------------------------------------------------------------

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null;
}

export async function addIpRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const res = await addIpRule({ tenantId: viewer.tenantId, actorUserId: viewer.user.id, cidr: str(f, "cidr"), label: str(f, "label") || null });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message, errors: { cidr: "Invalid" } };
}

export async function removeIpRuleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const rule = await prisma.ipAllowRule.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!rule) return { ok: false, message: "Not found." };
  const s = await prisma.governanceSetting.findUnique({ where: { tenantId: viewer.tenantId } });
  if (s?.ipAllowlistEnforced && (await prisma.ipAllowRule.count({ where: { tenantId: viewer.tenantId } })) <= 1) return { ok: false, message: "Switch enforcement off before removing the last range." };
  await prisma.ipAllowRule.delete({ where: { id: rule.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { module: "AUTH", action: "DELETE", entityType: "IpAllowRule", entityId: rule.cidr, summary: `Removed ${rule.cidr} from the sign-in allowlist` });
  return done(PATHS, `Removed ${rule.cidr}.`);
}

export async function saveGovernanceSettingsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AUTH_SETTINGS_MANAGE);
  const ipAllowlistEnforced = f.get("ipAllowlistEnforced") === "on";
  const inactiveDays = Number(str(f, "inactiveDays") || 90), failedLoginAlert = Number(str(f, "failedLoginAlert") || 5), reminderHours = Number(str(f, "reminderHours") || 24);
  if (!Number.isInteger(inactiveDays) || inactiveDays < 7 || inactiveDays > 730) return { ok: false, message: "Inactive after 7–730 days.", errors: { inactiveDays: "Invalid" } };
  if (!Number.isInteger(failedLoginAlert) || failedLoginAlert < 2 || failedLoginAlert > 100) return { ok: false, message: "Alert after 2–100 failures.", errors: { failedLoginAlert: "Invalid" } };
  if (!Number.isInteger(reminderHours) || reminderHours < 1 || reminderHours > 336) return { ok: false, message: "Remind after 1–336 hours.", errors: { reminderHours: "Invalid" } };
  if (ipAllowlistEnforced) {
    const rules = (await prisma.ipAllowRule.findMany({ where: { tenantId: viewer.tenantId }, select: { cidr: true } })).map((r) => r.cidr);
    if (rules.length === 0) return { ok: false, message: "Add at least one address range before enforcing the allowlist." };
    const ip = await clientIp();
    // Refuse a change that would lock out the administrator making it.
    if (ip && !ipAllowed(ip, rules, true)) return { ok: false, message: `Your address (${ip}) is not on the list; add it first so you are not locked out.` };
  }
  const data = {
    ipAllowlistEnforced, roleChangeApproval: f.get("roleChangeApproval") === "on", policyChangeApproval: f.get("policyChangeApproval") === "on", webhookApproval: f.get("webhookApproval") === "on",
    inactiveDays, failedLoginAlert, reminderHours,
  };
  const before = await prisma.governanceSetting.findUnique({ where: { tenantId: viewer.tenantId } });
  await prisma.governanceSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await govAudit(viewer.tenantId, viewer.user.id, { module: "AUTH", action: "UPDATE", entityType: "GovernanceSetting", entityId: viewer.tenantId, summary: `Governance settings: IP allowlist ${ipAllowlistEnforced ? "enforced" : "off"}, role change approval ${data.roleChangeApproval ? "on" : "off"}, policy change approval ${data.policyChangeApproval ? "on" : "off"}`, oldValue: before ?? undefined, newValue: data });
  return done(PATHS, "Saved.");
}

export async function acknowledgeAlertAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const ids = str(f, "id") === "all" ? (await prisma.securityAlert.findMany({ where: { tenantId: viewer.tenantId, status: "OPEN" }, select: { id: true } })).map((a) => a.id) : [str(f, "id")];
  const r = await prisma.securityAlert.updateMany({ where: { tenantId: viewer.tenantId, id: { in: ids }, status: "OPEN" }, data: { status: "ACKNOWLEDGED", acknowledgedBy: viewer.user.id } });
  await govAudit(viewer.tenantId, viewer.user.id, { module: "AUTH", action: "UPDATE", entityType: "SecurityAlert", summary: `Acknowledged ${r.count} security alert(s)` });
  return done(PATHS, `Acknowledged ${r.count}.`);
}

export async function scanSecurityNowAction(_prev: ActionState, _f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SECURITY_GOVERN);
  const r = await securityScan(viewer.tenantId);
  return done(PATHS, `${r.raised} new alert(s).`);
}
