import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { OPS_CONFIG_KINDS, isOpsConfigKind, opsPolicyReport, earlyDepartureReport, breakReport, OPS_WORKFLOW_TYPES } from "@keka/services";
import { getViewer, canAny } from "@/lib/context";
import { opsCsv, d10, monthParam } from "@/lib/ops-export";

/** CSV downloads for Time controls: change requests, policy versions and report, locks, certifications, reason codes, early departures and breaks. */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(v, [P.ATTENDANCE_MANAGE, P.LEAVE_MANAGE, P.WORKFLOW_MANAGE, P.PAYROLL_SETTINGS])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const t = v.tenantId;
  switch (sp.get("tab") ?? "settings") {
    case "changes": {
      const rows = await prisma.opsApprovalRequest.findMany({ where: { tenantId: t, kind: "OPS_CONFIG_CHANGE" }, orderBy: { createdAt: "desc" } });
      return opsCsv(v, "ATTENDANCE", "OpsApprovalRequest", "config-change-requests", ["Raised", "Request", "Status", "Effective", "Reason", "Applied", "Error"], rows.map((r) => [d10(r.createdAt), r.targetLabel, r.status, d10(r.effectiveFrom), r.reason ?? "", d10(r.appliedAt), r.error ?? ""]));
    }
    case "versions": {
      const k = sp.get("kind") ?? "ATTENDANCE_POLICY";
      if (!isOpsConfigKind(k)) return new NextResponse("Unknown kind.", { status: 400 });
      const [report, versions] = await Promise.all([opsPolicyReport(t, k), prisma.opsPolicyVersion.findMany({ where: { tenantId: t, kind: k }, orderBy: { createdAt: "desc" } })]);
      const labels = new Map(report.rows.map((r) => [r.id, r.label]));
      const fields = OPS_CONFIG_KINDS[k].fields;
      return opsCsv(v, "ATTENDANCE", "OpsPolicyVersion", `policy-versions-${k.toLowerCase()}`, ["Target", "Version", "Effective", "Summary", "Created", ...fields.map((f) => f.label)],
        versions.map((x) => { const snap = (x.snapshot ?? {}) as Record<string, unknown>; return [labels.get(x.targetId) ?? x.targetId, x.version, d10(x.effectiveFrom), x.summary, d10(x.createdAt), ...fields.map((f) => String(snap[f.key] ?? ""))]; }));
    }
    case "locks": {
      const rows = await prisma.opsPeriodLock.findMany({ where: { tenantId: t }, orderBy: { periodStart: "desc" } });
      return opsCsv(v, "ATTENDANCE", "OpsPeriodLock", "period-locks", ["Domain", "From", "To", "Status", "Reason", "Locked", "Reopened", "Reopen reason"], rows.map((l) => [l.domain, d10(l.periodStart), d10(l.periodEnd), l.status, l.reason ?? "", d10(l.lockedAt), d10(l.reopenedAt), l.reopenReason ?? ""]));
    }
    case "certification": {
      const rows = await prisma.opsAttendanceCertification.findMany({ where: { tenantId: t }, orderBy: { certifiedAt: "desc" } });
      return opsCsv(v, "ATTENDANCE", "OpsAttendanceCertification", "attendance-certifications", ["Scope", "From", "To", "Group", "Status", "Certified", "Summary"], rows.map((r) => [r.scope, d10(r.periodStart), d10(r.periodEnd), r.departmentKey, r.status, d10(r.certifiedAt), JSON.stringify(r.summary)]));
    }
    case "reasons": {
      const rows = await prisma.opsReasonCode.findMany({ where: { tenantId: t }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] });
      return opsCsv(v, "ATTENDANCE", "OpsReasonCode", "reason-codes", ["Catalogue", "Code", "Label", "Parent", "Applies to", "Active"], rows.map((r) => [r.kind, r.code, r.label, rows.find((p) => p.id === r.parentId)?.code ?? "", r.appliesTo ?? "", r.isActive ? "Yes" : "No"]));
    }
    case "early": {
      const [y, m] = monthParam(sp.get("month"));
      const rows = await earlyDepartureReport(t, y, m);
      return opsCsv(v, "ATTENDANCE", "OpsEarlyDepartureRule", `early-departures-${y}-${m}`, ["Employee no.", "Employee", "Incidents", "Penalty days", "Days"], rows.map((r) => [r.employeeNumber, r.employee, r.incidents, r.penaltyDays, r.days.map((d) => `${d10(d.date)} ${d.minutes}m`).join("; ")]));
    }
    case "breaks": {
      const now = new Date();
      const r = await breakReport(t, new Date(now.getTime() - 30 * 86_400_000), now);
      return opsCsv(v, "ATTENDANCE", "OpsBreakLog", "breaks", ["Day", "Employee", "Break", "Start", "End", "Minutes", "Status", "Note"], r.logs.map((l) => [d10(l.date), l.employee, l.rule.name, l.startAt.toISOString(), l.endAt?.toISOString() ?? "", l.minutes ?? "", l.status, l.note ?? ""]));
    }
    default: {
      const rows = await prisma.opsApprovalRequest.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 2000 });
      return opsCsv(v, "ATTENDANCE", "OpsApprovalRequest", "ops-approval-requests", ["Raised", "Kind", "Request", "Status", "Reason", "Error"], rows.map((r) => [d10(r.createdAt), OPS_WORKFLOW_TYPES[r.kind as keyof typeof OPS_WORKFLOW_TYPES] ?? r.kind, r.targetLabel, r.status, r.reason ?? "", r.error ?? ""]));
    }
  }
}
