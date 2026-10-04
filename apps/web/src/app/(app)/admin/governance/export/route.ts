import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { safeCsv, accountHygiene, mfaReport, policyCampaignStatus, verifyAuditLog, complianceStatus, seededSample, govAudit } from "@keka/services";
import { getViewer, can } from "@/lib/context";

type Sheet = { name: string; head: string[]; rows: Array<Array<string | number | null>> };
type Ctx = { tenantId: string; q: URLSearchParams };
const P = PERMISSIONS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "");

async function names(tenantId: string, ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { tenantId, id: { in: list } }, select: { id: true, email: true } }) : [];
  const m = new Map(users.map((u) => [u.id, u.email]));
  return (id: string | null | undefined) => (id ? m.get(id) ?? id : "");
}

/** Each report: who may download it and how it is built. Every query is scoped to the viewer's tenant. */
const REPORTS: Record<string, { perm: Permission | Permission[]; build: (c: Ctx) => Promise<Sheet | null> }> = {
  "workflow-requests": { perm: P.WORKFLOW_MANAGE, build: async ({ tenantId, q }) => {
    const rows = await prisma.workflowRequest.findMany({ where: { tenantId, ...(q.get("status") ? { status: q.get("status")! } : {}) }, orderBy: { createdAt: "desc" }, take: 20_000, include: { definition: { select: { name: true, version: true } } } });
    const n = await names(tenantId, rows.map((r) => r.requesterUserId));
    return { name: "workflow-requests", head: ["Submitted", "Type", "Title", "Category", "Amount", "Requested by", "Route", "Status", "Decided", "Completed", "Hours to decide"],
      rows: rows.map((r) => [iso(r.createdAt), r.entityType, r.title, r.category ?? "", r.amount === null ? "" : Number(r.amount), n(r.requesterUserId), r.definition ? `${r.definition.name} v${r.definition.version}` : "Built-in", r.status, iso(r.decidedAt), iso(r.completedAt), r.decidedAt ? Math.round((r.decidedAt.getTime() - r.createdAt.getTime()) / 36e5) : ""]) };
  } },
  "workflow-events": { perm: P.WORKFLOW_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.workflowEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50_000, include: { request: { select: { title: true, entityType: true } } } });
    const n = await names(tenantId, rows.map((r) => r.actorUserId));
    return { name: "workflow-history", head: ["When", "Request", "Type", "Event", "By", "Note"], rows: rows.map((r) => [iso(r.createdAt), r.request.title, r.request.entityType, r.kind, r.actorUserId ? n(r.actorUserId) : "system", r.note ?? ""]) };
  } },
  "automation-runs": { perm: P.WORKFLOW_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.automationRun.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50_000, include: { rule: { select: { name: true, trigger: true } } } });
    return { name: "automation-runs", head: ["When", "Rule", "Trigger", "Subject", "Subject id", "Status", "Actions run", "Error"], rows: rows.map((r) => [iso(r.createdAt), r.rule.name, r.rule.trigger, r.subjectType, r.subjectId, r.status, r.actionsRun, r.error ?? ""]) };
  } },
  "access-requests": { perm: P.SECURITY_GOVERN, build: async ({ tenantId, q }) => {
    const rows = await prisma.accessRequest.findMany({ where: { tenantId, ...(q.get("status") ? { status: q.get("status")! } : {}) }, orderBy: { createdAt: "desc" }, take: 20_000 });
    const roles = new Map((await prisma.role.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const n = await names(tenantId, rows.flatMap((r) => [r.requesterUserId, r.targetUserId]));
    return { name: "access-requests", head: ["Requested", "For", "Requested by", "Role", "Privileged", "Days", "Justification", "Status", "Decided", "Expires", "Revoked"],
      rows: rows.map((r) => [iso(r.createdAt), n(r.targetUserId), n(r.requesterUserId), roles.get(r.roleId) ?? r.roleId, r.privileged ? "Yes" : "No", r.durationDays ?? "Permanent", r.justification, r.status, iso(r.decidedAt), iso(r.expiresAt), iso(r.revokedAt)]) };
  } },
  "role-grants": { perm: P.SECURITY_GOVERN, build: async ({ tenantId }) => {
    const rows = await prisma.userRoleAssignment.findMany({ where: { role: { tenantId } }, include: { role: { select: { name: true, isSystem: true } }, user: { select: { email: true, loginDisabled: true } } }, orderBy: { grantedAt: "desc" } });
    return { name: "role-grants", head: ["Login", "Role", "System role", "Granted", "Expires", "Note", "Login disabled"], rows: rows.map((r) => [r.user.email, r.role.name, r.role.isSystem ? "Yes" : "No", iso(r.grantedAt), iso(r.expiresAt) || "Permanent", r.grantNote ?? "", r.user.loginDisabled ? "Yes" : "No"]) };
  } },
  accounts: { perm: P.SECURITY_GOVERN, build: async ({ tenantId }) => {
    const rows = await accountHygiene(tenantId);
    return { name: "accounts", head: ["Login", "Name", "Last sign-in", "Created", "Roles", "Inactive", "Orphan reason", "Login disabled"], rows: rows.map((r) => [r.email, r.name ?? "", iso(r.lastLoginAt), iso(r.createdAt), r.roleCount, r.inactive ? "Yes" : "No", r.orphan ?? "", r.loginDisabled ? "Yes" : "No"]) };
  } },
  mfa: { perm: P.SECURITY_GOVERN, build: async ({ tenantId }) => {
    const r = await mfaReport(tenantId);
    return { name: "mfa", head: ["Login", "Name", "Holds roles", "2FA required", "Method", "Last second factor", "Last sign-in", "Gap"], rows: r.rows.map((x) => [x.email, x.name ?? "", x.admin ? "Yes" : "No", x.required ? "Yes" : "No", x.method, iso(x.lastSecondFactor), iso(x.lastLoginAt), x.gap ? "Yes" : ""]) };
  } },
  "security-alerts": { perm: P.SECURITY_GOVERN, build: async ({ tenantId }) => {
    const rows = await prisma.securityAlert.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20_000 });
    const n = await names(tenantId, rows.map((r) => r.acknowledgedBy));
    return { name: "security-alerts", head: ["When", "Kind", "Severity", "Summary", "Status", "Acknowledged by"], rows: rows.map((r) => [iso(r.createdAt), r.kind, r.severity, r.summary, r.status, n(r.acknowledgedBy)]) };
  } },
  "sign-ins": { perm: P.SECURITY_GOVERN, build: async ({ tenantId }) => {
    const rows = await prisma.loginEvent.findMany({ where: { tenantId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 50_000 });
    return { name: "sign-ins", head: ["When", "Email", "IP address", "Success", "Outcome", "User agent"], rows: rows.map((r) => [iso(r.createdAt), r.email, r.ipAddress ?? "", r.success ? "Yes" : "No", r.outcome, r.userAgent ?? ""]) };
  } },
  "access-review": { perm: P.SECURITY_GOVERN, build: async ({ tenantId, q }) => {
    const c = await prisma.accessReviewCampaign.findFirst({ where: { tenantId, id: q.get("id") ?? "" }, include: { items: true } });
    if (!c) return null;
    const n = await names(tenantId, c.items.flatMap((i) => [i.userId, i.reviewerUserId, i.decidedBy]));
    return { name: `access-review-${c.name.replace(/[^\w-]+/g, "-").slice(0, 40)}`, head: ["Person", "Role", "Reviewer", "Decision", "Decided by", "Decided", "Note"], rows: c.items.map((i) => [n(i.userId), i.roleName, n(i.reviewerUserId), i.decision, n(i.decidedBy), iso(i.decidedAt), i.note ?? ""]) };
  } },
  consents: { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId }) => {
    const rows = await prisma.consentRecord.findMany({ where: { tenantId }, include: { purpose: { select: { title: true, version: true } } }, orderBy: { recordedAt: "desc" } });
    const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, employeeNumber: true, firstName: true, lastName: true } })).map((e) => [e.id, e]));
    return { name: "consent-records", head: ["Employee no.", "Name", "Purpose", "Purpose version", "Consented to version", "Decision", "Recorded", "Withdrawn", "IP address"],
      rows: rows.map((r) => { const e = emps.get(r.employeeId); return [e?.employeeNumber ?? "", e ? `${e.firstName} ${e.lastName}` : "", r.purpose.title, r.purpose.version, r.version, r.decision, iso(r.recordedAt), iso(r.withdrawnAt), r.ipAddress ?? ""]; }) };
  } },
  "compliance-items": { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId, q }) => {
    const now = new Date();
    const items = (await prisma.complianceItem.findMany({ where: { tenantId }, orderBy: { dueOn: "asc" } })).map((i) => ({ ...i, s: complianceStatus(i.status, i.dueOn, now) })).filter((i) => !q.get("status") || i.s === q.get("status"));
    const n = await names(tenantId, items.flatMap((i) => [i.ownerUserId, i.reviewerUserId]));
    return { name: "compliance-items", head: ["Obligation", "Category", "Regulation", "Authority", "Frequency", "Due", "Owner", "Reviewer", "Status", "Evidence files", "Submitted", "Completed", "Exception"],
      rows: items.map((i) => [i.title, i.category, i.regulation ?? "", i.authority ?? "", i.frequency, iso(i.dueOn).slice(0, 10), n(i.ownerUserId), n(i.reviewerUserId), i.s, i.evidenceFileIds.length, iso(i.submittedAt), iso(i.completedAt), i.exceptionReason ?? ""]) };
  } },
  "policy-acks": { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId, q }) => {
    const s = await policyCampaignStatus(tenantId, q.get("id") ?? "");
    if (!s) return null;
    return { name: `policy-acks-${s.campaign.name.replace(/[^\w-]+/g, "-").slice(0, 40)}`, head: ["Employee no.", "Name", "Department", "Acknowledged"], rows: s.rows.map((r) => [r.employeeNumber, r.name, r.department, r.acknowledgedAt ? iso(r.acknowledgedAt) : "Pending"]) };
  } },
  "retention-runs": { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId }) => {
    const rows = await prisma.retentionRun.findMany({ where: { tenantId }, include: { rule: { select: { dataType: true, retentionDays: true } } }, orderBy: { createdAt: "desc" } });
    const n = await names(tenantId, rows.map((r) => r.runBy));
    return { name: "retention-runs", head: ["When", "Data", "Keep (days)", "Dry run", "Cutoff", "Matched", "Held for legal hold", "Changed", "Status", "Run by", "Error"],
      rows: rows.map((r) => [iso(r.createdAt), r.rule.dataType, r.rule.retentionDays, r.dryRun ? "Yes" : "No", iso(r.cutoff).slice(0, 10), r.matched, r.heldBack, r.affected, r.status, r.runBy ? n(r.runBy) : "nightly job", r.error ?? ""]) };
  } },
  findings: { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId }) => {
    const rows = await prisma.auditFinding.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    const n = await names(tenantId, rows.map((r) => r.ownerUserId));
    return { name: "audit-findings", head: ["Logged", "Finding", "Severity", "Source", "Owner", "Due", "Status", "Corrective action", "Escalated", "Closed", "Closure note"],
      rows: rows.map((r) => [iso(r.createdAt), r.title, r.severity, r.source, n(r.ownerUserId), iso(r.dueOn).slice(0, 10), r.status, r.correctiveAction ?? "", iso(r.escalatedAt), iso(r.closedAt), r.closureNote ?? ""]) };
  } },
  "audit-integrity": { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId }) => {
    const v = await verifyAuditLog(tenantId);
    return { name: "audit-integrity", head: ["Checked", "Unsealed", "Head hash", "Seal", "Audit entry", "Problem"],
      rows: v.problems.length ? v.problems.map((p) => [v.checked, v.unsealed, v.head ?? "", p.seq, p.auditLogId, p.problem]) : [[v.checked, v.unsealed, v.head ?? "", "", "", "None: chain intact"]] };
  } },
  "audit-sample": { perm: P.COMPLIANCE_VIEW, build: async ({ tenantId, q }) => {
    const seed = (q.get("seed") ?? "").slice(0, 40) || new Date().toISOString().slice(0, 10);
    const pool = await prisma.auditLog.findMany({ where: { tenantId, createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 2000 });
    return { name: `audit-sample-${seed}`, head: ["When", "Module", "Action", "Entity", "Entity id", "Summary", "By"], rows: seededSample(pool, 25, seed).map((a) => [iso(a.createdAt), a.module, a.action, a.entityType, a.entityId ?? "", a.summary ?? "", a.actorLabel ?? ""]) };
  } },
};

/** CSV downloads for the workflow, security and compliance pages. Each download is audited. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const key = req.nextUrl.searchParams.get("report") ?? "";
  const report = REPORTS[key];
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  const perms = Array.isArray(report.perm) ? report.perm : [report.perm];
  if (!perms.some((p) => can(viewer, p))) return new NextResponse("Forbidden.", { status: 403 });
  const sheet = await report.build({ tenantId: viewer.tenantId, q: req.nextUrl.searchParams });
  if (!sheet) return new NextResponse("Not found.", { status: 404 });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "EXPORT", entityType: "Report", entityId: key, summary: `Exported ${sheet.rows.length} row(s) of ${sheet.name}` });
  const csv = safeCsv(sheet.head, sheet.rows.map((r) => r.map((c) => (c === null ? "" : c))));
  return new NextResponse("﻿" + csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${sheet.name}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
