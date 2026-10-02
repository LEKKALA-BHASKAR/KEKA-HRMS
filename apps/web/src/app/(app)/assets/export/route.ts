import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import {
  ASSET_ACK_LABEL, ASSET_CONDITION_LABEL, ASSET_IMPORT_FIELDS, ASSET_REQUEST_STATUS_LABEL, ASSET_REQUEST_TYPE_LABEL, ASSET_STATUS_LABEL,
  type AssetConditionKey, type AssetStatusKey,
} from "@keka/services";
import { getViewer, can, canAny } from "@/lib/context";
import { ASSET_REPORTS } from "../_reports";
import {
  assetListWhere, assetListInclude, recoveryWhere, recoveryInclude, summaryListWhere, assignedEmployeesWhere, assetRequestsWhere, acknowledgementsWhere,
} from "../_queries";

/**
 * Every download in Org › Assets: the list behind each screen (?view= with
 * that screen's filters, through the same query the screen runs), a report
 * (?report=<key>, the rows the Reports tab shows), and the bulk-import
 * template (?view=template&mode=ADD|UPDATE&type=).
 */

const P = PERMISSIONS;
type Cell = string | number | null | undefined;
const LIMIT = 20_000;
const cond = (c: string | null | undefined) => (c ? ASSET_CONDITION_LABEL[c as AssetConditionKey] ?? c : "");
const day = (d: Date | null | undefined) => (d ? formatDate(d) : "");
const num = (v: unknown) => (v === null || v === undefined ? "" : Number(v));

function csv(head: string[], rows: Cell[][]): string {
  // Spreadsheet apps execute cells that start with = + - @; neutralise them.
  const esc = (v: Cell) => {
    const s = v === null || v === undefined ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "\ufeff" + [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!canAny(viewer, [P.ASSET_MANAGE, P.ASSET_ASSIGN])) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries()) as Record<string, string | undefined>;
  const tenantId = viewer.tenantId;
  let name: string, head: string[], rows: Cell[][];

  if (sp.report) {
    const report = ASSET_REPORTS.find((r) => r.key === sp.report);
    if (!report) return new NextResponse("Unknown report.", { status: 404 });
    if (!can(viewer, P.ASSET_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
    const data = await report.run(tenantId, new Date());
    name = report.key;
    head = data.columns.map((c) => c.label);
    rows = data.rows.map((r) => data.columns.map((c) => r[c.key]));
  } else {
    switch (sp.view) {
      case "template": {
        if (!can(viewer, P.ASSET_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
        name = sp.mode === "UPDATE" ? "asset-bulk-update" : "asset-bulk-add";
        head = ASSET_IMPORT_FIELDS.map((f) => f.label);
        if (sp.mode === "UPDATE") {
          const list = await prisma.asset.findMany({
            where: { tenantId, ...(sp.type ? { assetTypeId: sp.type } : {}) }, orderBy: { assetTag: "asc" }, take: LIMIT,
            include: { assetType: { include: { category: true } }, location: true },
          });
          rows = list.map((a) => [
            a.assetTag, a.name ?? a.assetType.name, a.location?.name, a.assetType.category.name, a.assetType.name, cond(a.condition),
            a.status === "ASSIGNED" ? "Available" : ASSET_STATUS_LABEL[a.status as AssetStatusKey], a.serialNumber,
            a.purchaseDate?.toISOString().slice(0, 10), a.warrantyExpiry?.toISOString().slice(0, 10), num(a.purchaseCost), a.vendor, a.description,
          ]);
        } else {
          const type = sp.type ? await prisma.assetType.findFirst({ where: { id: sp.type, category: { tenantId } }, include: { category: true } }) : null;
          const loc = await prisma.location.findFirst({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } });
          rows = [["AST-0001", "Example — delete this row", loc?.name ?? "Head Office", type?.category.name ?? "IT Equipment", type?.name ?? "Laptop", "New", "Available", "SN123", "2026-04-01", "2029-03-31", 85000, "Vendor name", ""]];
        }
        break;
      }
      case "list": {
        const list = await prisma.asset.findMany({ where: assetListWhere(tenantId, sp), include: assetListInclude, orderBy: { assetTag: "asc" }, take: LIMIT });
        name = "asset-list";
        head = ["Asset ID", "Asset Name", "Category", "Asset Type", "Serial Number", "Location", "Condition", "Status", "Reason", "Assigned To", "Employee Number", "Purchased On", "Warranty Expires On", "Purchase Cost", "Book Value"];
        rows = list.map((a) => [
          a.assetTag, a.name ?? a.assetType.name, a.assetType.category.name, a.assetType.name, a.serialNumber, a.location?.name, cond(a.condition),
          ASSET_STATUS_LABEL[a.status as AssetStatusKey], a.status === "AVAILABLE" || a.status === "ASSIGNED" ? "" : a.unavailableReason,
          a.assignments[0]?.employee.displayName, a.assignments[0]?.employee.employeeNumber, day(a.purchaseDate), day(a.warrantyExpiry), num(a.purchaseCost), num(a.currentValue),
        ]);
        break;
      }
      case "summary-assigned": case "summary-available": case "summary-unavailable": {
        const list = sp.view.slice(8) as "assigned" | "available" | "unavailable";
        const assets = await prisma.asset.findMany({
          where: summaryListWhere(viewer, list, sp), orderBy: { assetTag: "asc" }, take: LIMIT,
          include: { assetType: { include: { category: true } }, location: true, assignments: { where: { returnedOn: null }, take: 1, include: { employee: { select: { displayName: true, department: { select: { name: true } }, businessUnit: { select: { name: true } } } } } } },
        });
        name = `assets-${list}`;
        head = ["Asset ID", "Asset Name", "Category", "Asset Type", "Condition", ...(list === "assigned" ? ["Assigned To", "Assigned On", "Department", "Business Unit"] : ["Status"]), "Location", ...(list === "unavailable" ? ["Reason"] : [])];
        rows = assets.map((a) => {
          const h = a.assignments[0];
          return [
            a.assetTag, a.name ?? a.assetType.name, a.assetType.category.name, a.assetType.name, cond(a.condition),
            ...(list === "assigned" ? [h?.employee.displayName, day(h?.assignedOn), h?.employee.department?.name, h?.employee.businessUnit?.name] : [ASSET_STATUS_LABEL[a.status as AssetStatusKey]]),
            a.location?.name, ...(list === "unavailable" ? [a.unavailableReason] : []),
          ];
        });
        break;
      }
      case "assigned": {
        const emps = await prisma.employee.findMany({
          where: assignedEmployeesWhere(viewer, sp), orderBy: [{ firstName: "asc" }, { lastName: "asc" }], take: LIMIT,
          select: {
            displayName: true, employeeNumber: true, status: true, department: { select: { name: true } }, businessUnit: { select: { name: true } }, location: { select: { name: true } },
            assetAssignments: { where: { returnedOn: null }, orderBy: { assignedOn: "desc" }, include: { asset: { include: { assetType: true } } } },
          },
        });
        name = "assigned-assets";
        head = ["Employee", "Employee Number", "Department", "Business Unit", "Location", "Employee Status", "Assets Assigned", "Count"];
        rows = emps.map((e) => [
          e.displayName, e.employeeNumber, e.department?.name, e.businessUnit?.name, e.location?.name, e.status,
          e.assetAssignments.map((a) => `${a.asset.name ?? a.asset.assetType.name} (${a.asset.assetTag}, ${ASSET_ACK_LABEL[a.ackStatus]})`).join("; "), e.assetAssignments.length,
        ]);
        break;
      }
      case "requests": case "requests-closed": {
        const closed = sp.view === "requests-closed";
        const { where } = assetRequestsWhere(viewer, { ...sp, tab: closed ? "closed" : undefined });
        const list = await prisma.assetRequest.findMany({
          where, orderBy: closed ? { closedAt: "desc" } : { createdAt: "desc" }, take: LIMIT,
          include: { employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } }, location: { select: { name: true } } } }, category: true, assetType: true },
        });
        name = closed ? "asset-requests-closed" : "asset-requests-pending";
        head = ["Asset", "Category & Type", "Requested By", "Employee Number", "Department", "Employee Location", "Request Type", "Raised On", "Request Status", ...(closed ? ["Closed On", "Reason for Rejecting"] : [])];
        rows = list.map((r) => [
          r.title ?? r.reason, [r.category?.name, r.assetType?.name].filter(Boolean).join(" › ") || "NA", r.employee.displayName, r.employee.employeeNumber,
          r.employee.department?.name, r.employee.location?.name, ASSET_REQUEST_TYPE_LABEL[r.requestType], day(r.createdAt), ASSET_REQUEST_STATUS_LABEL[r.status],
          ...(closed ? [day(r.closedAt), r.rejectReason] : []),
        ]);
        break;
      }
      case "acks": case "acks-completed": {
        const done = sp.view === "acks-completed";
        const { where } = acknowledgementsWhere(viewer, { ...sp, tab: done ? "completed" : undefined });
        const list = await prisma.assetAssignment.findMany({
          where, orderBy: done ? { acknowledgedAt: "desc" } : { assignedOn: "desc" }, take: LIMIT,
          include: { asset: { include: { assetType: true } }, employee: { select: { displayName: true, employeeNumber: true } } },
        });
        name = done ? "asset-acknowledgements-completed" : "asset-acknowledgements-pending";
        head = ["Asset ID", "Asset Name", "Assigned To", "Employee Number", "Assigned On", "Asset Condition", done ? "Acknowledged On" : "Last Reminded", ...(done ? [] : ["Reminders"])];
        rows = list.map((a) => [
          a.asset.assetTag, a.asset.name ?? a.asset.assetType.name, a.employee.displayName, a.employee.employeeNumber, day(a.assignedOn), cond(a.conditionOut),
          done ? day(a.acknowledgedAt) : day(a.ackRemindedAt), ...(done ? [] : [a.ackRemindCount]),
        ]);
        break;
      }
      case "recovery": {
        const list = await prisma.assetAssignment.findMany({ where: recoveryWhere(viewer, sp), include: recoveryInclude, orderBy: { returnedOn: "desc" }, take: LIMIT });
        name = sp.tab === "recovered" ? "damage-recovered" : "damage-to-recover";
        head = ["Asset ID", "Asset Name", "Employee", "Employee Number", "Department", "Returned On", "Condition Out", "Condition In", "Damage Charge", "Note", "Recovered"];
        rows = list.map((r) => [
          r.asset.assetTag, r.asset.name ?? r.asset.assetType.name, r.employee.displayName, r.employee.employeeNumber, r.employee.department?.name,
          day(r.returnedOn), cond(r.conditionOut), cond(r.conditionIn), num(r.damageCharge), r.damageNote, r.chargeRecovered ? "Yes" : "No",
        ]);
        break;
      }
      default:
        return new NextResponse("Unknown download.", { status: 404 });
    }
  }

  await prisma.auditLog.create({
    data: { tenantId, module: "ASSET", action: "EXPORT", entityType: "Asset", summary: `Downloaded ${name} (${rows.length} rows)`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(csv(head, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
