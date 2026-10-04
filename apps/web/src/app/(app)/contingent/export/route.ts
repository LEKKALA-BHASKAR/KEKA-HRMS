import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { safeCsv, REQUEST_KINDS } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { orgNames, workerRows, expiringContracts, contingentSpend, vendorScorecards, requestsOf, csvResponse } from "@/lib/workforce";

const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");

/** CSV exports of the contingent workforce: workers, assignments, vendors, rate cards, expiring contracts, spend, approvals. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.CONTINGENT_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const t = viewer.tenantId;
  const names = await orgNames(t);
  switch (sp.report) {
    case "workers": {
      const rows = await workerRows(t, sp);
      return csvResponse(viewer, "contingent-workers", safeCsv(["Code", "First name", "Last name", "Email", "Type", "Engagement", "Vendor", "Department", "Manager", "Status", "Started", "Ended", "Skills", "Payment profile"],
        rows.map((w) => [w.code, w.firstName, w.lastName, w.email ?? "", w.workerKind, w.engagementType, w.vendor?.name ?? "", names.dept.get(w.departmentId ?? "") ?? "", names.emp.get(w.managerEmployeeId ?? "") ?? "", w.status, d(w.startedAt), d(w.endedAt), w.skills.join("; "), w.paymentProfile?.status ?? ""])), rows.length, "ContingentWorker");
    }
    case "assignments": {
      const rows = await prisma.contractAssignment.findMany({ where: { tenantId: t }, include: { worker: { select: { code: true, firstName: true, lastName: true } } }, orderBy: { startDate: "desc" } });
      return csvResponse(viewer, "contract-assignments", safeCsv(["Worker", "Role", "Department", "Manager", "Start", "End", "Rate type", "Rate", "PO number", "PO amount", "SOW", "Status", "Extensions", "End reason"],
        rows.map((a) => [`${a.worker.code} ${a.worker.firstName} ${a.worker.lastName}`, a.role, names.dept.get(a.departmentId ?? "") ?? "", names.emp.get(a.managerEmployeeId ?? "") ?? "", d(a.startDate), d(a.endDate), a.rateType, Number(a.rate), a.poNumber ?? "", a.poAmount ? Number(a.poAmount) : "", a.sowReference ?? "", a.status, a.extensions, a.endReason ?? ""])), rows.length, "ContractAssignment");
    }
    case "vendors": {
      const cards = await vendorScorecards(t);
      return csvResponse(viewer, "vendors", safeCsv(["Vendor", "Status", "Active workers", "Onboarding done", "Compliant", "Missing documents", "Expired documents", "Average rating", "Score", "Grade"],
        cards.map((c) => [c.name, c.status, c.activeWorkers, `${c.checklistDone}/${c.checklistTotal}`, c.compliance.compliant ? "Yes" : "No", c.compliance.missing.join("; "), c.compliance.expired.join("; "), c.avgRating ?? "", c.score, c.grade])), cards.length, "ContingentVendor");
    }
    case "rate-cards": {
      const rows = await prisma.contractorRateCard.findMany({ where: { tenantId: t }, include: { vendor: { select: { name: true } } }, orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }] });
      return csvResponse(viewer, "rate-cards", safeCsv(["Role", "Vendor", "Rate type", "Rate", "Effective from", "Effective to"], rows.map((r) => [r.role, r.vendor?.name ?? "Generic", r.rateType, Number(r.rate), d(r.effectiveFrom), d(r.effectiveTo)])), rows.length, "ContractorRateCard");
    }
    case "expiring": {
      const rows = await expiringContracts(t, new Date(), Number(sp.days) || 30);
      return csvResponse(viewer, "expiring-contracts", safeCsv(["Worker", "Role", "End date", "Days left", "State", "Alerted"], rows.map((a) => [`${a.worker.code} ${a.worker.firstName} ${a.worker.lastName}`, a.role, d(a.endDate), a.expiry.days, a.expiry.state, d(a.alertedAt)])), rows.length, "ContractAssignment");
    }
    case "spend": {
      const rows = await contingentSpend(t);
      const vendors = new Map((await prisma.contingentVendor.findMany({ where: { tenantId: t }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
      return csvResponse(viewer, "contingent-spend", safeCsv(["Date", "Type", "Worker", "Role", "Vendor", "Department", "Amount"], rows.map((r) => [d(r.date), r.type, r.worker, r.role, r.vendorId ? vendors.get(r.vendorId) ?? "" : "Independent", names.dept.get(r.departmentId ?? "") ?? "", r.amount])), rows.length, "ContractAssignment");
    }
    case "approvals": {
      const rows = await requestsOf(t, "contingent");
      return csvResponse(viewer, "contingent-approvals", safeCsv(["Requested", "Request", "Record", "Status", "Requested by", "Decided by", "Decided", "Reason", "Note"],
        rows.map((r) => [d(r.requestedAt), REQUEST_KINDS[r.kind]?.label ?? r.kind, r.label, r.status, names.user.get(r.requestedBy) ?? "", names.user.get(r.decidedBy ?? "") ?? "", d(r.decidedAt), r.reason ?? "", r.decisionNote ?? ""])), rows.length, "WorkforceRequest");
    }
    default:
      return new NextResponse("Unknown report.", { status: 400 });
  }
}
