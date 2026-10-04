import { prisma, type Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import {
  GENESIS_HASH, auditEntryHash, verifyChain, retentionCutoff, nextDueDate, isRetentionDataType,
  type AuditLike, type ChainProblem, type RetentionDataType,
} from "./governance-math";

/**
 * The effects governance decisions have once they are approved — granting a
 * role, applying a role or policy change, activating a webhook or rule,
 * purging data under a retention rule, completing a compliance item,
 * launching a policy campaign, publishing a consent purpose — plus legal
 * holds and the audit log hash chain. Nothing here starts a workflow, so the
 * workflow engine can call it without a cycle.
 */

type R = { ok: boolean; message: string };
type AuditModuleName = "SYSTEM" | "ROLE" | "AUTH" | "EMPLOYEE";

export async function govAudit(tenantId: string, actorUserId: string | null, opts: {
  module?: AuditModuleName; action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "EXPORT"; entityType: string; entityId?: string | null; summary: string; newValue?: unknown; oldValue?: unknown;
}): Promise<void> {
  const actor = actorUserId ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({
    data: {
      tenantId, module: opts.module ?? "SYSTEM", action: opts.action, entityType: opts.entityType, entityId: opts.entityId ?? null, summary: opts.summary,
      newValue: opts.newValue === undefined ? undefined : (opts.newValue as Prisma.InputJsonValue),
      oldValue: opts.oldValue === undefined ? undefined : (opts.oldValue as Prisma.InputJsonValue),
      actorId: actor ? actorUserId : null, actorLabel: actor?.email ?? "system",
    },
  });
}

export async function governanceSettings(tenantId: string) {
  return (await prisma.governanceSetting.findUnique({ where: { tenantId } })) ?? {
    tenantId, ipAllowlistEnforced: false, roleChangeApproval: false, policyChangeApproval: false, webhookApproval: false, inactiveDays: 90, failedLoginAlert: 5, reminderHours: 24,
  };
}

// ---------------------------------------------------------------------------
//  Access
// ---------------------------------------------------------------------------

/** Grant (or extend) a role, optionally until a date. Returns the assignment id. */
export async function grantRole(input: { tenantId: string; userId: string; roleId: string; expiresAt: Date | null; note: string; grantedBy: string | null }): Promise<string> {
  const role = await prisma.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId }, select: { id: true } });
  if (!role) throw new Error("The role no longer exists.");
  const user = await prisma.user.findFirst({ where: { id: input.userId, tenantId: input.tenantId }, select: { id: true } });
  if (!user) throw new Error("The user no longer exists.");
  const existing = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: input.userId, roleId: input.roleId } } });
  if (existing) {
    // A permanent grant stays permanent; a time-bound one is extended.
    const live = !existing.expiresAt || existing.expiresAt > new Date();
    const expiresAt = live && !existing.expiresAt ? null : input.expiresAt;
    await prisma.userRoleAssignment.update({ where: { id: existing.id }, data: { expiresAt, grantNote: input.note } });
    return existing.id;
  }
  const a = await prisma.userRoleAssignment.create({ data: { userId: input.userId, roleId: input.roleId, grantedBy: input.grantedBy, expiresAt: input.expiresAt, grantNote: input.note } });
  return a.id;
}

export async function applyAccessRequest(tenantId: string, accessRequestId: string, actorUserId: string | null): Promise<void> {
  const ar = await prisma.accessRequest.findFirst({ where: { id: accessRequestId, tenantId } });
  if (!ar) throw new Error("Access request not found.");
  if (ar.status !== "PENDING") return;
  const expiresAt = ar.durationDays ? new Date(Date.now() + ar.durationDays * 86_400_000) : null;
  const assignmentId = await grantRole({ tenantId, userId: ar.targetUserId, roleId: ar.roleId, expiresAt, note: `Access request${ar.durationDays ? ` (${ar.durationDays} days)` : ""}`, grantedBy: actorUserId });
  await prisma.accessRequest.update({ where: { id: ar.id }, data: { status: "APPROVED", assignmentId, expiresAt, decidedAt: new Date() } });
  const role = await prisma.role.findUnique({ where: { id: ar.roleId }, select: { name: true } });
  await govAudit(tenantId, actorUserId, { module: "ROLE", action: "APPROVE", entityType: "AccessRequest", entityId: ar.id, summary: `Access request approved: ${role?.name ?? "role"} granted${expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : ""}`, newValue: { roleId: ar.roleId, userId: ar.targetUserId, expiresAt } });
  if (ar.privileged) {
    await prisma.securityAlert.upsert({
      where: { tenantId_dedupeKey: { tenantId, dedupeKey: `PRIVILEGED_GRANT:${ar.id}` } },
      create: { tenantId, kind: "PRIVILEGED_GRANT", severity: "MEDIUM", summary: `Privileged role ${role?.name ?? ""} granted through an access request`, userId: ar.targetUserId, dedupeKey: `PRIVILEGED_GRANT:${ar.id}` },
      update: {},
    });
  }
}

export interface RoleGrantPayload { userId: string; roleId: string; scopes?: Array<{ departmentId: string | null; locationId: string | null }>; expiresAt?: string | null }
export interface RolePermissionsPayload { roleId: string; permissions: string[]; name?: string; description?: string | null }

/** Apply an approved change request (maker-checker). */
export async function applyChangeRequest(tenantId: string, id: string, actorUserId: string | null): Promise<void> {
  const cr = await prisma.changeRequest.findFirst({ where: { id, tenantId } });
  if (!cr) throw new Error("Change request not found.");
  if (cr.status !== "PENDING") return;
  const p = cr.payload as Record<string, unknown>;
  if (cr.kind === "ROLE_GRANT") {
    const g = p as unknown as RoleGrantPayload;
    const assignmentId = await grantRole({ tenantId, userId: g.userId, roleId: g.roleId, expiresAt: g.expiresAt ? new Date(g.expiresAt) : null, note: "Approved change request", grantedBy: cr.requestedBy });
    if (g.scopes) {
      await prisma.roleScope.deleteMany({ where: { assignmentId } });
      if (g.scopes.length) await prisma.roleScope.createMany({ data: g.scopes.map((s) => ({ assignmentId, departmentId: s.departmentId, locationId: s.locationId })) });
    }
  } else if (cr.kind === "ROLE_PERMISSIONS") {
    const r = p as unknown as RolePermissionsPayload;
    const role = await prisma.role.findFirst({ where: { id: r.roleId, tenantId } });
    if (!role) throw new Error("The role no longer exists.");
    if (role.isSystem) throw new Error("Built-in roles keep their permissions.");
    await prisma.$transaction([
      prisma.role.update({ where: { id: role.id }, data: { ...(r.name ? { name: r.name } : {}), ...(r.description !== undefined ? { description: r.description } : {}) } }),
      prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      prisma.rolePermission.createMany({ data: [...new Set(r.permissions)].map((permission) => ({ roleId: role.id, permission })) }),
    ]);
  } else if (cr.kind === "SECURITY_POLICY") {
    const data = p as Prisma.TenantSecuritySettingUncheckedCreateInput;
    const clean = {
      minPasswordLength: Number(data.minPasswordLength), requireMixedCase: !!data.requireMixedCase, requireNumber: !!data.requireNumber, requireSymbol: !!data.requireSymbol,
      passwordExpiryDays: data.passwordExpiryDays === null || data.passwordExpiryDays === undefined ? null : Number(data.passwordExpiryDays),
      passwordHistoryCount: Number(data.passwordHistoryCount), maxFailedAttempts: Number(data.maxFailedAttempts), lockoutMinutes: Number(data.lockoutMinutes),
      sessionHours: Number(data.sessionHours), twoFactorPolicy: data.twoFactorPolicy as "OFF" | "ADMINS" | "EVERYONE",
    };
    await prisma.tenantSecuritySetting.upsert({ where: { tenantId }, create: { tenantId, ...clean }, update: clean });
  } else throw new Error(`Unknown change kind ${cr.kind}.`);
  await prisma.changeRequest.update({ where: { id: cr.id }, data: { status: "APPLIED", appliedAt: new Date(), error: null } });
  await govAudit(tenantId, actorUserId, { module: cr.kind === "SECURITY_POLICY" ? "AUTH" : "ROLE", action: "APPROVE", entityType: "ChangeRequest", entityId: cr.id, summary: `Approved and applied: ${cr.summary}`, newValue: p });
}

/** Revoke time-bound grants past their expiry. */
export async function revokeExpiredGrants(tenantId: string, now = new Date()): Promise<{ revoked: number }> {
  const due = await prisma.userRoleAssignment.findMany({
    where: { role: { tenantId }, expiresAt: { lte: now } },
    include: { role: { select: { name: true, key: true } }, user: { select: { email: true } } },
  });
  for (const a of due) {
    await prisma.userRoleAssignment.delete({ where: { id: a.id } });
    await prisma.accessRequest.updateMany({ where: { tenantId, assignmentId: a.id, status: "APPROVED" }, data: { status: "EXPIRED" } });
    await govAudit(tenantId, null, { module: "ROLE", action: "DELETE", entityType: "UserRoleAssignment", entityId: a.id, summary: `Time-bound ${a.role.name} for ${a.user.email} expired and was revoked` });
    await notify({ tenantId, userIds: [a.userId], kind: "ACCESS", title: `Your ${a.role.name} access has expired`, link: "/me/requests?tab=access" });
  }
  return { revoked: due.length };
}

// ---------------------------------------------------------------------------
//  Legal holds and retention
// ---------------------------------------------------------------------------

/** Employees under an active hold for a data type (holds with no type cover every type), and whether the type is held tenant-wide. */
export async function activeHolds(tenantId: string, dataType: string): Promise<{ employeeIds: Set<string>; tenantWide: boolean }> {
  const holds = await prisma.legalHold.findMany({ where: { tenantId, releasedAt: null, OR: [{ dataType: null }, { dataType }] } });
  return { employeeIds: new Set(holds.map((h) => h.employeeId).filter((e): e is string => !!e)), tenantWide: holds.some((h) => !h.employeeId) };
}

export async function employeeOnHold(tenantId: string, employeeId: string): Promise<boolean> {
  return (await prisma.legalHold.count({ where: { tenantId, releasedAt: null, employeeId } })) > 0;
}

async function heldUserIds(tenantId: string, employeeIds: Set<string>): Promise<string[]> {
  if (employeeIds.size === 0) return [];
  const rows = await prisma.employee.findMany({ where: { tenantId, id: { in: [...employeeIds] } }, select: { userId: true } });
  return rows.map((r) => r.userId).filter((u): u is string => !!u);
}

/** The rows a rule would touch now, and how many legal holds keep back. */
async function retentionScope(tenantId: string, dataType: RetentionDataType, cutoff: Date) {
  const holds = await activeHolds(tenantId, dataType);
  if (dataType === "LOGIN_EVENTS") {
    const users = await heldUserIds(tenantId, holds.employeeIds);
    const base: Prisma.LoginEventWhereInput = { tenantId, createdAt: { lt: cutoff } };
    const matched = await prisma.loginEvent.count({ where: base });
    const where: Prisma.LoginEventWhereInput = holds.tenantWide ? { id: "__none__" } : { ...base, ...(users.length ? { NOT: { userId: { in: users } } } : {}) };
    const sample = (await prisma.loginEvent.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { id: true, email: true, createdAt: true } })).map((r) => `${r.email} ${r.createdAt.toISOString().slice(0, 10)}`);
    return { matched, eligible: await prisma.loginEvent.count({ where }), sample, apply: async () => (await prisma.loginEvent.deleteMany({ where })).count };
  }
  if (dataType === "NOTIFICATIONS") {
    const users = await heldUserIds(tenantId, holds.employeeIds);
    const base: Prisma.NotificationWhereInput = { tenantId, readAt: { not: null }, createdAt: { lt: cutoff } };
    const where: Prisma.NotificationWhereInput = holds.tenantWide ? { id: "__none__" } : { ...base, ...(users.length ? { NOT: { userId: { in: users } } } : {}) };
    const sample = (await prisma.notification.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { title: true } })).map((r) => r.title);
    return { matched: await prisma.notification.count({ where: base }), eligible: await prisma.notification.count({ where }), sample, apply: async () => (await prisma.notification.deleteMany({ where })).count };
  }
  if (dataType === "EMAIL_OUTBOX") {
    const base: Prisma.EmailOutboxWhereInput = { tenantId, status: "SENT", createdAt: { lt: cutoff } };
    const where: Prisma.EmailOutboxWhereInput = holds.tenantWide ? { id: "__none__" } : base;
    const sample = (await prisma.emailOutbox.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { subject: true } })).map((r) => r.subject);
    return { matched: await prisma.emailOutbox.count({ where: base }), eligible: await prisma.emailOutbox.count({ where }), sample, apply: async () => (await prisma.emailOutbox.deleteMany({ where })).count };
  }
  if (dataType === "WEBHOOK_DELIVERIES") {
    const base: Prisma.WebhookDeliveryWhereInput = { endpoint: { tenantId }, status: { not: "PENDING" }, createdAt: { lt: cutoff } };
    const where: Prisma.WebhookDeliveryWhereInput = holds.tenantWide ? { id: "__none__" } : base;
    const sample = (await prisma.webhookDelivery.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { event: true, createdAt: true } })).map((r) => `${r.event} ${r.createdAt.toISOString().slice(0, 10)}`);
    return { matched: await prisma.webhookDelivery.count({ where: base }), eligible: await prisma.webhookDelivery.count({ where }), sample, apply: async () => (await prisma.webhookDelivery.deleteMany({ where })).count };
  }
  if (dataType === "AUDIT_LOGS") {
    const base: Prisma.AuditLogWhereInput = { tenantId, createdAt: { lt: cutoff } };
    const where: Prisma.AuditLogWhereInput = holds.tenantWide ? { id: "__none__" } : { ...base, ...(holds.employeeIds.size ? { NOT: { entityId: { in: [...holds.employeeIds] } } } : {}) };
    const sample = (await prisma.auditLog.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { summary: true } })).map((r) => r.summary ?? "");
    return {
      matched: await prisma.auditLog.count({ where: base }), eligible: await prisma.auditLog.count({ where }), sample,
      apply: async () => {
        const ids = (await prisma.auditLog.findMany({ where, select: { id: true } })).map((r) => r.id);
        // A purge removes the entries and their seals together; verification starts from the oldest remaining seal.
        await prisma.auditSeal.deleteMany({ where: { tenantId, auditLogId: { in: ids } } });
        return (await prisma.auditLog.deleteMany({ where: { id: { in: ids } } })).count;
      },
    };
  }
  if (dataType === "ER_CASES") {
    // Closed cases older than the cutoff whose own retention date has passed; a hold on the subject keeps the case.
    const base: Prisma.ErCaseWhereInput = { tenantId, status: "CLOSED", closedAt: { lt: cutoff }, OR: [{ retainUntil: null }, { retainUntil: { lt: new Date() } }] };
    const where: Prisma.ErCaseWhereInput = holds.tenantWide ? { id: "__none__" } : { ...base, ...(holds.employeeIds.size ? { NOT: { subjectEmployeeId: { in: [...holds.employeeIds] } } } : {}) };
    const sample = (await prisma.erCase.findMany({ where, take: 5, orderBy: { closedAt: "asc" }, select: { number: true, closedAt: true } })).map((r) => `ER-${r.number} closed ${r.closedAt?.toISOString().slice(0, 10)}`);
    return {
      matched: await prisma.erCase.count({ where: base }), eligible: await prisma.erCase.count({ where }), sample,
      apply: async () => {
        const ids = (await prisma.erCase.findMany({ where, select: { id: true } })).map((r) => r.id);
        await prisma.storedFile.deleteMany({ where: { tenantId, relatedType: "ErEvidence", relatedId: { in: ids } } });
        return (await prisma.erCase.deleteMany({ where: { id: { in: ids } } })).count;
      },
    };
  }
  if (dataType === "DOCUMENT_VERSIONS") {
    const base: Prisma.DocumentVersionWhereInput = { tenantId, createdAt: { lt: cutoff } };
    const where: Prisma.DocumentVersionWhereInput = holds.tenantWide ? { id: "__none__" } : base;
    const sample = (await prisma.documentVersion.findMany({ where, take: 5, orderBy: { createdAt: "asc" }, select: { label: true, version: true } })).map((r) => `${r.label ?? "Document"} v${r.version}`);
    return { matched: await prisma.documentVersion.count({ where: base }), eligible: await prisma.documentVersion.count({ where }), sample, apply: async () => (await prisma.documentVersion.deleteMany({ where })).count };
  }
  // EXITED_EMPLOYEES: anonymise personal data once the retention period after the last working day has passed.
  const base: Prisma.EmployeeWhereInput = { tenantId, status: "EXITED", lastWorkingDay: { lt: cutoff }, NOT: { firstName: "Anonymised" } };
  const where: Prisma.EmployeeWhereInput = holds.tenantWide ? { id: "__none__" } : { ...base, ...(holds.employeeIds.size ? { id: { notIn: [...holds.employeeIds] } } : {}) };
  const sample = (await prisma.employee.findMany({ where, take: 5, select: { employeeNumber: true } })).map((r) => r.employeeNumber);
  return {
    matched: await prisma.employee.count({ where: base }), eligible: await prisma.employee.count({ where }), sample,
    apply: async () => {
      const emps = await prisma.employee.findMany({ where, select: { id: true, employeeNumber: true, userId: true } });
      for (const e of emps) {
        await prisma.$transaction([
          prisma.employee.update({
            where: { id: e.id },
            data: {
              firstName: "Anonymised", middleName: null, lastName: e.employeeNumber, displayName: `Anonymised ${e.employeeNumber}`,
              personalEmail: null, mobile: null, alternatePhone: null, dateOfBirth: null, photoUrl: null, aboutMe: null, professionalSummary: null,
            },
          }),
          prisma.employeeAddress.deleteMany({ where: { employeeId: e.id } }),
          ...(e.userId ? [prisma.user.update({ where: { id: e.userId }, data: { loginDisabled: true, phone: null, sessionVersion: { increment: 1 } } })] : []),
        ]);
      }
      return emps.length;
    },
  };
}

/** Dry run (counts and a sample, nothing changed) or apply a retention rule. */
export async function runRetention(tenantId: string, ruleId: string, opts: { dryRun: boolean; actorUserId: string | null; now?: Date; workflowRequestId?: string | null; runId?: string | null }): Promise<{ runId: string; matched: number; eligible: number; heldBack: number; affected: number }> {
  const rule = await prisma.retentionRule.findFirst({ where: { id: ruleId, tenantId } });
  if (!rule) throw new Error("Retention rule not found.");
  if (!isRetentionDataType(rule.dataType)) throw new Error(`Unknown data type ${rule.dataType}.`);
  const cutoff = retentionCutoff(opts.now ?? new Date(), rule.retentionDays);
  const scope = await retentionScope(tenantId, rule.dataType, cutoff);
  const heldBack = scope.matched - scope.eligible;
  const affected = opts.dryRun ? 0 : await scope.apply();
  const data = {
    dryRun: opts.dryRun, cutoff, matched: scope.matched, heldBack, affected,
    status: opts.dryRun ? "DRY_RUN" : "APPLIED", sample: scope.sample, runBy: opts.actorUserId, workflowRequestId: opts.workflowRequestId ?? null,
  };
  // An approved purge request is completed on its own row.
  const run = opts.runId
    ? await prisma.retentionRun.update({ where: { id: opts.runId }, data })
    : await prisma.retentionRun.create({ data: { tenantId, ruleId, ...data } });
  if (!opts.dryRun) {
    await govAudit(tenantId, opts.actorUserId, { action: "DELETE", entityType: "RetentionRule", entityId: rule.id, summary: `Retention ${rule.action.toLowerCase()} of ${rule.dataType}: ${affected} record(s) older than ${cutoff.toISOString().slice(0, 10)}${heldBack ? `, ${heldBack} kept for legal hold` : ""}` });
  }
  return { runId: run.id, matched: scope.matched, eligible: scope.eligible, heldBack, affected };
}

// ---------------------------------------------------------------------------
//  Compliance items, policy campaigns, consent purposes
// ---------------------------------------------------------------------------

export async function completeComplianceItem(tenantId: string, id: string, actorUserId: string | null): Promise<string | null> {
  const item = await prisma.complianceItem.findFirst({ where: { id, tenantId } });
  if (!item) throw new Error("Compliance item not found.");
  if (item.status === "COMPLETED") return null;
  await prisma.complianceItem.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await govAudit(tenantId, actorUserId, { action: "APPROVE", entityType: "ComplianceItem", entityId: id, summary: `Compliance item completed: ${item.title}` });
  const next = nextDueDate(item.frequency, item.dueOn);
  if (!next) return null;
  // Roll the obligation forward once.
  const exists = await prisma.complianceItem.findFirst({ where: { tenantId, previousId: item.id }, select: { id: true } });
  if (exists) return exists.id;
  const row = await prisma.complianceItem.create({
    data: {
      tenantId, title: item.title, description: item.description, category: item.category, regulation: item.regulation, authority: item.authority,
      frequency: item.frequency, dueOn: next, ownerUserId: item.ownerUserId, reviewerUserId: item.reviewerUserId, previousId: item.id, createdBy: item.createdBy,
    },
  });
  await notify({ tenantId, userIds: [item.ownerUserId], kind: "COMPLIANCE", title: `Next due: ${item.title} on ${next.toISOString().slice(0, 10)}`, link: "/admin/compliance?tab=checklist" });
  return row.id;
}

/** Everyone a campaign asks: active employees with a login, in its departments (or all). */
export async function campaignAudience(tenantId: string, departmentIds: string[]) {
  return prisma.employee.findMany({
    where: { tenantId, status: { not: "EXITED" }, ...(departmentIds.length ? { departmentId: { in: departmentIds } } : {}) },
    select: { id: true, userId: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, departmentId: true, department: { select: { name: true } }, reportingManager: { select: { userId: true } } },
  });
}

export async function activatePolicyCampaign(tenantId: string, campaignId: string, actorUserId: string | null): Promise<void> {
  const c = await prisma.policyCampaign.findFirst({ where: { id: campaignId, tenantId } });
  if (!c) throw new Error("Campaign not found.");
  const doc = await prisma.orgDocument.findFirst({ where: { id: c.documentId, tenantId } });
  if (!doc) throw new Error("The policy document no longer exists.");
  await prisma.orgDocument.update({ where: { id: doc.id }, data: { isPublished: true, requireAck: true } });
  await prisma.policyCampaign.update({ where: { id: c.id }, data: { status: "ACTIVE" } });
  const people = await campaignAudience(tenantId, c.departmentIds);
  await notify({ tenantId, userIds: people.map((p) => p.userId), kind: "POLICY", title: `Please read and acknowledge: ${doc.title}`, body: `Acknowledge by ${c.dueOn.toISOString().slice(0, 10)}.`, link: "/me/policies", email: true, relatedType: "PolicyCampaign", relatedId: c.id });
  await govAudit(tenantId, actorUserId, { action: "APPROVE", entityType: "PolicyCampaign", entityId: c.id, summary: `Launched acknowledgement campaign "${c.name}" to ${people.length} people` });
}

export async function publishConsentPurpose(tenantId: string, id: string, actorUserId: string | null): Promise<void> {
  const p = await prisma.consentPurpose.findFirst({ where: { id, tenantId } });
  if (!p) throw new Error("Consent purpose not found.");
  await prisma.$transaction([
    prisma.consentPurpose.updateMany({ where: { tenantId, key: p.key, status: "PUBLISHED", NOT: { id: p.id } }, data: { status: "RETIRED" } }),
    prisma.consentPurpose.update({ where: { id: p.id }, data: { status: "PUBLISHED", publishedAt: new Date() } }),
  ]);
  const users = await prisma.user.findMany({ where: { tenantId, loginDisabled: false, employee: { status: { not: "EXITED" } } }, select: { id: true } });
  await notify({ tenantId, userIds: users.map((u) => u.id), kind: "CONSENT", title: `Your consent is requested: ${p.title} (v${p.version})`, link: "/me/policies" });
  await govAudit(tenantId, actorUserId, { action: "APPROVE", entityType: "ConsentPurpose", entityId: p.id, summary: `Published consent purpose "${p.title}" v${p.version}` });
}

// ---------------------------------------------------------------------------
//  Audit log hash chain
// ---------------------------------------------------------------------------

type RawAudit = AuditLike;

/** Seal every not-yet-sealed audit entry onto the end of the tenant's chain. */
export async function sealAuditLog(tenantId: string, limit = 5000): Promise<{ sealed: number; head: string }> {
  const last = await prisma.auditSeal.findFirst({ where: { tenantId }, orderBy: { seq: "desc" } });
  const rows = await prisma.$queryRaw<RawAudit[]>`
    SELECT a."id", a."createdAt", a."module"::text AS "module", a."action"::text AS "action", a."entityType", a."entityId", a."summary",
           a."actorId", a."actorLabel", a."oldValue", a."newValue"
    FROM "audit_logs" a LEFT JOIN "audit_seals" s ON s."auditLogId" = a."id"
    WHERE a."tenantId" = ${tenantId} AND s."id" IS NULL
    ORDER BY a."createdAt" ASC, a."id" ASC
    LIMIT ${limit}`;
  let prev = last?.hash ?? GENESIS_HASH;
  let seq = last?.seq ?? 0;
  const data = rows.map((r) => {
    seq += 1;
    const hash = auditEntryHash(prev, r);
    const seal = { tenantId, seq, auditLogId: r.id, prevHash: prev, hash };
    prev = hash;
    return seal;
  });
  if (data.length) await prisma.auditSeal.createMany({ data });
  return { sealed: data.length, head: prev };
}

/** Re-hash every sealed entry; report missing, altered and broken links. */
export async function verifyAuditLog(tenantId: string): Promise<{ checked: number; problems: ChainProblem[]; unsealed: number; head: string | null }> {
  const seals = await prisma.auditSeal.findMany({ where: { tenantId }, orderBy: { seq: "asc" } });
  const rows = new Map<string, AuditLike>();
  for (let i = 0; i < seals.length; i += 2000) {
    const ids = seals.slice(i, i + 2000).map((s) => s.auditLogId);
    const logs = await prisma.auditLog.findMany({ where: { tenantId, id: { in: ids } } });
    for (const l of logs) rows.set(l.id, { ...l, module: l.module, action: l.action });
  }
  const res = verifyChain(seals, rows);
  const total = await prisma.auditLog.count({ where: { tenantId } });
  return { ...res, unsealed: Math.max(0, total - (seals.length - res.problems.filter((p) => p.problem === "MISSING").length)), head: seals.at(-1)?.hash ?? null };
}

export type { R as GovResult };
