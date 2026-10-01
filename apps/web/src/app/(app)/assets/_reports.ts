import "server-only";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import {
  assetWarrantyStatus, ASSET_CONDITION_LABEL, ASSET_STATUS_LABEL, ASSET_ACK_LABEL, ASSET_REQUEST_STATUS_LABEL, ASSET_REQUEST_TYPE_LABEL,
  type AssetConditionKey, type AssetStatusKey,
} from "@keka/services";

/**
 * Asset reports. Each one returns its columns and rows; the page renders
 * them and /assets/export streams the same rows as CSV, so a report on
 * screen and its download never disagree. Scheduled reports refer to these
 * keys (ScheduledReport.reportKey).
 */

export interface AssetReportColumn { key: string; label: string; money?: boolean }
export interface AssetReportDef {
  key: string;
  title: string;
  description: string;
  run(tenantId: string, asOf: Date): Promise<{ columns: AssetReportColumn[]; rows: Array<Record<string, string | number | null>> }>;
}

const DAY = 86_400_000;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const inventory: AssetReportDef = {
  key: "asset-inventory", title: "Asset inventory",
  description: "Every asset with its category, type, location, condition, status, current holder, warranty and book value.",
  async run(tenantId) {
    const rows = await prisma.asset.findMany({
      where: { tenantId }, orderBy: { assetTag: "asc" },
      include: { assetType: { include: { category: true } }, location: true, assignments: { where: { returnedOn: null }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, take: 1 } },
    });
    return {
      columns: [
        { key: "tag", label: "Asset ID" }, { key: "name", label: "Asset Name" }, { key: "category", label: "Category" }, { key: "type", label: "Asset Type" },
        { key: "location", label: "Location" }, { key: "condition", label: "Condition" }, { key: "status", label: "Status" }, { key: "holder", label: "Assigned To" },
        { key: "purchased", label: "Purchased On" }, { key: "warranty", label: "Warranty Expires On" }, { key: "cost", label: "Purchase Cost", money: true }, { key: "book", label: "Book Value", money: true },
      ],
      rows: rows.map((a) => ({
        tag: a.assetTag, name: a.name ?? a.assetType.name, category: a.assetType.category.name, type: a.assetType.name, location: a.location?.name ?? null,
        condition: ASSET_CONDITION_LABEL[a.condition as AssetConditionKey], status: ASSET_STATUS_LABEL[a.status as AssetStatusKey],
        holder: a.assignments[0] ? `${a.assignments[0].employee.displayName} (${a.assignments[0].employee.employeeNumber})` : null,
        purchased: a.purchaseDate ? formatDate(a.purchaseDate) : null, warranty: a.warrantyExpiry ? formatDate(a.warrantyExpiry) : null,
        cost: n(a.purchaseCost), book: n(a.currentValue),
      })),
    };
  },
};

const history: AssetReportDef = {
  key: "asset-assignment-history", title: "Asset assignment history",
  description: "Every laptop, phone and chair ever assigned — who had it, from when to when, the condition out and in, and the acknowledgement.",
  async run(tenantId) {
    const rows = await prisma.assetAssignment.findMany({
      where: { asset: { tenantId } }, orderBy: { assignedOn: "desc" },
      include: { asset: { include: { assetType: true } }, employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } } } } },
    });
    return {
      columns: [
        { key: "tag", label: "Asset ID" }, { key: "name", label: "Asset Name" }, { key: "employee", label: "Employee" }, { key: "department", label: "Department" },
        { key: "assigned", label: "Assigned On" }, { key: "returned", label: "Returned On" }, { key: "out", label: "Condition Out" }, { key: "in", label: "Condition In" },
        { key: "ack", label: "Acknowledgement" }, { key: "charge", label: "Damage Charge", money: true },
      ],
      rows: rows.map((a) => ({
        tag: a.asset.assetTag, name: a.asset.name ?? a.asset.assetType.name, employee: `${a.employee.displayName} (${a.employee.employeeNumber})`, department: a.employee.department?.name ?? null,
        assigned: formatDate(a.assignedOn), returned: a.returnedOn ? formatDate(a.returnedOn) : "In use",
        out: ASSET_CONDITION_LABEL[a.conditionOut as AssetConditionKey], in: a.conditionIn ? ASSET_CONDITION_LABEL[a.conditionIn as AssetConditionKey] : null,
        ack: ASSET_ACK_LABEL[a.ackStatus], charge: n(a.damageCharge),
      })),
    };
  },
};

const requests: AssetReportDef = {
  key: "asset-requests", title: "Asset requests",
  description: "Requests raised, by type and status, with the days each took from raising to closing.",
  async run(tenantId, asOf) {
    const rows = await prisma.assetRequest.findMany({
      where: { tenantId }, orderBy: { createdAt: "desc" },
      include: { employee: { select: { displayName: true, employeeNumber: true } }, category: true, assetType: true },
    });
    return {
      columns: [
        { key: "asset", label: "Asset" }, { key: "employee", label: "Requested By" }, { key: "type", label: "Request Type" }, { key: "categoryType", label: "Category & Type" },
        { key: "raised", label: "Raised On" }, { key: "status", label: "Request Status" }, { key: "closed", label: "Closed On" }, { key: "days", label: "Days Open" },
      ],
      rows: rows.map((r) => ({
        asset: r.title ?? r.reason, employee: `${r.employee.displayName} (${r.employee.employeeNumber})`, type: ASSET_REQUEST_TYPE_LABEL[r.requestType],
        categoryType: [r.category?.name, r.assetType?.name].filter(Boolean).join(" › ") || "NA",
        raised: formatDate(r.createdAt), status: ASSET_REQUEST_STATUS_LABEL[r.status], closed: r.closedAt ? formatDate(r.closedAt) : null,
        days: Math.max(0, Math.round(((r.closedAt ?? asOf).getTime() - r.createdAt.getTime()) / DAY)),
      })),
    };
  },
};

const warranty: AssetReportDef = {
  key: "asset-warranty", title: "Warranty expiry",
  description: "Assets whose warranty has expired or ends in the next 90 days, soonest first.",
  async run(tenantId, asOf) {
    const rows = await prisma.asset.findMany({
      where: { tenantId, status: { not: "RETIRED" }, warrantyExpiry: { not: null, lte: new Date(asOf.getTime() + 90 * DAY) } }, orderBy: { warrantyExpiry: "asc" },
      include: { assetType: { include: { category: true } }, location: true },
    });
    return {
      columns: [
        { key: "tag", label: "Asset ID" }, { key: "name", label: "Asset Name" }, { key: "type", label: "Asset Type" }, { key: "location", label: "Location" },
        { key: "expiry", label: "Warranty Expires On" }, { key: "state", label: "Warranty Status" }, { key: "vendor", label: "Vendor" },
      ],
      rows: rows.map((a) => ({
        tag: a.assetTag, name: a.name ?? a.assetType.name, type: a.assetType.name, location: a.location?.name ?? null,
        expiry: formatDate(a.warrantyExpiry), state: assetWarrantyStatus(a.warrantyExpiry, asOf, 90) === "EXPIRED" ? "Expired" : "Expiring", vendor: a.vendor,
      })),
    };
  },
};

const notAvailable: AssetReportDef = {
  key: "asset-not-available", title: "Assets not available",
  description: "Assets in repair, lost or held back, with the reason and since when.",
  async run(tenantId) {
    const rows = await prisma.asset.findMany({
      where: { tenantId, status: { in: ["IN_REPAIR", "LOST", "UNAVAILABLE"] } }, orderBy: { updatedAt: "desc" },
      include: { assetType: true, location: true },
    });
    return {
      columns: [
        { key: "tag", label: "Asset ID" }, { key: "name", label: "Asset Name" }, { key: "type", label: "Asset Type" }, { key: "status", label: "Status" },
        { key: "reason", label: "Reason" }, { key: "condition", label: "Condition" }, { key: "location", label: "Location" }, { key: "since", label: "Since" },
      ],
      rows: rows.map((a) => ({
        tag: a.assetTag, name: a.name ?? a.assetType.name, type: a.assetType.name, status: ASSET_STATUS_LABEL[a.status as AssetStatusKey], reason: a.unavailableReason,
        condition: ASSET_CONDITION_LABEL[a.condition as AssetConditionKey], location: a.location?.name ?? null, since: formatDate(a.updatedAt),
      })),
    };
  },
};

export const ASSET_REPORTS: AssetReportDef[] = [inventory, history, requests, warranty, notAvailable];
