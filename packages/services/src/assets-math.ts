/**
 * Pure asset rules — no database. ID series formatting, acknowledgement,
 * availability buckets, warranty status, straight-line book value, the
 * request approval chain, and CSV parsing/validation for the bulk import.
 */

// ---------------------------------------------------------------------------
//  Vocabulary
// ---------------------------------------------------------------------------

export type AssetStatusKey = "AVAILABLE" | "ASSIGNED" | "IN_REPAIR" | "RETIRED" | "LOST" | "UNAVAILABLE";
export type AssetConditionKey = "NEW" | "GOOD" | "FAIR" | "POOR" | "DAMAGED" | "UNUSABLE";

export const ASSET_CONDITIONS: AssetConditionKey[] = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED", "UNUSABLE"];
export const NOT_AVAILABLE_STATUSES: AssetStatusKey[] = ["IN_REPAIR", "LOST", "UNAVAILABLE"];
export const ASSET_ICON_KEYS = ["laptop", "desktop", "monitor", "phone", "tablet", "chair", "card", "network", "headset", "other"] as const;

export const ASSET_CONDITION_LABEL: Record<AssetConditionKey, string> = {
  NEW: "New", GOOD: "Good", FAIR: "Fair", POOR: "Poor", DAMAGED: "Damaged", UNUSABLE: "Unusable",
};
export const ASSET_STATUS_LABEL: Record<AssetStatusKey, string> = {
  AVAILABLE: "Available", ASSIGNED: "Assigned", IN_REPAIR: "In repair", LOST: "Lost", UNAVAILABLE: "Not available", RETIRED: "Retired",
};
export const ASSET_REQUEST_TYPE_LABEL: Record<string, string> = {
  NEW_ASSET: "New asset request", REPLACEMENT: "Asset replacement request", RETURN: "Asset return request",
};
export const ASSET_REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending", APPROVED: "Approved. Assignment pending", FULFILLED: "Assigned", REJECTED: "Rejected", CANCELLED: "Cancelled",
};
export const ASSET_ACK_LABEL: Record<string, string> = {
  NOT_APPLICABLE: "Not Applicable", PENDING: "Pending", ACKNOWLEDGED: "Acknowledged",
};

/** Keka groups the six statuses into three buckets, plus retired (out of the count). */
export function assetAvailabilityBucket(status: AssetStatusKey): "AVAILABLE" | "ASSIGNED" | "NOT_AVAILABLE" | "RETIRED" {
  if (status === "AVAILABLE" || status === "ASSIGNED" || status === "RETIRED") return status;
  return "NOT_AVAILABLE";
}

/** What an assignment's acknowledgement starts as, from the type's setting. */
export function assetInitialAckStatus(requireAck: boolean): "PENDING" | "NOT_APPLICABLE" {
  return requireAck ? "PENDING" : "NOT_APPLICABLE";
}

// ---------------------------------------------------------------------------
//  ID series
// ---------------------------------------------------------------------------

export function formatAssetTag(series: { prefix: string; digits: number; suffix: string }, n: number): string {
  return `${series.prefix}${String(n).padStart(Math.max(1, series.digits), "0")}${series.suffix}`;
}

// ---------------------------------------------------------------------------
//  Warranty and book value
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export type AssetWarrantyStatus = "ACTIVE" | "EXPIRING" | "EXPIRED" | "NONE";

/** Expiring = within `alertDays` of `asOf`, counting the expiry day as covered. */
export function assetWarrantyStatus(expiry: Date | null | undefined, asOf: Date, alertDays = 30): AssetWarrantyStatus {
  if (!expiry) return "NONE";
  const end = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  if (end < today) return "EXPIRED";
  if (end - today <= alertDays * DAY) return "EXPIRING";
  return "ACTIVE";
}

/** Whole months from one date to another, never negative. */
export function assetMonthsOwned(from: Date, to: Date): number {
  const m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) - (to.getUTCDate() < from.getUTCDate() ? 1 : 0);
  return Math.max(0, m);
}

/**
 * Straight-line book value: cost × (1 − months owned / useful life), floored
 * at zero and rounded to the rupee. No life means no depreciation.
 */
export function assetBookValue(cost: number | null | undefined, purchasedOn: Date | null | undefined, usefulLifeMonths: number | null | undefined, asOf: Date): number | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return null;
  if (!purchasedOn || !usefulLifeMonths || usefulLifeMonths <= 0) return Math.round(cost);
  const owned = assetMonthsOwned(purchasedOn, asOf);
  return Math.max(0, Math.round(cost * (1 - Math.min(1, owned / usefulLifeMonths))));
}

// ---------------------------------------------------------------------------
//  Request approvals
// ---------------------------------------------------------------------------

export type AssetApproverKind = "REPORTING_MANAGER" | "ASSET_MANAGER" | `EMPLOYEE:${string}`;

export interface AssetPlannedLevel { level: number; approverKind: string; approverId: string | null }

/** Read the stored chain defensively: unknown entries are dropped. */
export function parseAssetChain(raw: unknown): AssetApproverKind[] {
  if (!Array.isArray(raw)) return ["REPORTING_MANAGER", "ASSET_MANAGER"];
  return raw.filter((k): k is AssetApproverKind => typeof k === "string" && (k === "REPORTING_MANAGER" || k === "ASSET_MANAGER" || /^EMPLOYEE:[\w-]+$/.test(k)));
}

/**
 * Resolve the configured chain for one requester. A reporting-manager level
 * is dropped when there is no manager; a level whose named approver is the
 * requester is dropped too, since nobody approves their own request.
 */
export function planAssetApprovals(chain: AssetApproverKind[], who: { requesterId: string; managerId: string | null }): AssetPlannedLevel[] {
  const out: AssetPlannedLevel[] = [];
  for (const kind of chain) {
    let approverKind: string = kind;
    let approverId: string | null = null;
    if (kind === "REPORTING_MANAGER") {
      if (!who.managerId || who.managerId === who.requesterId) continue;
      approverId = who.managerId;
    } else if (kind.startsWith("EMPLOYEE:")) {
      approverId = kind.slice("EMPLOYEE:".length);
      approverKind = "EMPLOYEE";
      if (approverId === who.requesterId) continue;
    }
    out.push({ level: out.length + 1, approverKind, approverId });
  }
  return out;
}

export interface AssetLevelState { level: number; approverKind: string; approverId: string | null; status: "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED" }
export interface ApprovalActor { employeeId: string | null; canManage: boolean }

/** The level now waiting, or null when none is. */
export function currentAssetLevel(levels: AssetLevelState[]): AssetLevelState | null {
  return [...levels].sort((a, b) => a.level - b.level).find((l) => l.status === "PENDING") ?? null;
}

/** May this actor decide the given level? Asset managers may act on any level. */
export function canActOnAssetLevel(level: AssetLevelState, actor: ApprovalActor): boolean {
  if (actor.canManage) return true;
  if (level.approverKind === "ASSET_MANAGER") return false;
  return !!actor.employeeId && level.approverId === actor.employeeId;
}

/**
 * Apply one decision to the chain. Approving the current level skips any
 * later level the same person could also decide ("Skipped due to already
 * approved"); rejecting closes the request. Returns the new statuses by
 * level and the request's outcome.
 */
export function decideAssetLevels(
  levels: AssetLevelState[], actor: ApprovalActor, decision: "approve" | "reject", skipDuplicate: boolean,
): { ok: true; updates: Array<{ level: number; status: AssetLevelState["status"] }>; outcome: "PENDING" | "APPROVED" | "REJECTED"; nextLevel: number | null } | { ok: false; reason: string } {
  const current = currentAssetLevel(levels);
  if (!current) return { ok: false, reason: "This request has no approval waiting." };
  if (!canActOnAssetLevel(current, actor)) return { ok: false, reason: "This request is waiting on someone else." };
  if (decision === "reject") {
    return { ok: true, updates: [{ level: current.level, status: "REJECTED" }], outcome: "REJECTED", nextLevel: null };
  }
  const updates: Array<{ level: number; status: AssetLevelState["status"] }> = [{ level: current.level, status: "APPROVED" }];
  const later = levels.filter((l) => l.level > current.level && l.status === "PENDING").sort((a, b) => a.level - b.level);
  let next: AssetLevelState | null = null;
  for (const l of later) {
    const sameApprover = (actor.employeeId && l.approverId === actor.employeeId) || (l.approverKind === "ASSET_MANAGER" && actor.canManage);
    if (skipDuplicate && sameApprover && !next) { updates.push({ level: l.level, status: "SKIPPED" }); continue; }
    next = next ?? l;
  }
  return next ? { ok: true, updates, outcome: "PENDING", nextLevel: next.level } : { ok: true, updates, outcome: "APPROVED", nextLevel: null };
}

// ---------------------------------------------------------------------------
//  Bulk import
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 CSV: quoted fields, escaped quotes, CRLF or LF. */
export function parseAssetCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}

export const ASSET_IMPORT_FIELDS = [
  { key: "assetTag", label: "Asset ID", required: true },
  { key: "name", label: "Asset Name", required: true },
  { key: "location", label: "Asset Location", required: true },
  { key: "category", label: "Asset Category", required: true },
  { key: "type", label: "Asset Type", required: true },
  { key: "condition", label: "Asset Condition", required: true },
  { key: "status", label: "Asset Status", required: true },
  { key: "serialNumber", label: "Serial Number", required: false },
  { key: "purchaseDate", label: "Purchased On", required: false },
  { key: "warrantyExpiry", label: "Warranty Expires On", required: false },
  { key: "purchaseCost", label: "Purchase Cost", required: false },
  { key: "vendor", label: "Vendor", required: false },
  { key: "description", label: "Description", required: false },
] as const;
export type AssetImportFieldKey = (typeof ASSET_IMPORT_FIELDS)[number]["key"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Map file headers to fields by name, the way Keka pre-fills "Map Columns". */
export function autoMapAssetHeaders(headers: string[]): Record<string, AssetImportFieldKey | ""> {
  const out: Record<string, AssetImportFieldKey | ""> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const n = norm(h);
    const hit = ASSET_IMPORT_FIELDS.find((f) => !used.has(f.key) && (norm(f.label) === n || norm(f.key) === n || norm(f.label).replace(/^asset/, "") === n));
    out[h] = hit ? hit.key : "";
    if (hit) used.add(hit.key);
  }
  return out;
}

export interface AssetImportRefs {
  locations: Map<string, string>;                     // lower(name) → id
  categories: Map<string, { id: string; types: Map<string, string> }>; // lower(cat) → {id, lower(type) → typeId}
  existingTags: Set<string>;                          // lower(tag)
}
export interface AssetImportRow {
  row: number; assetTag: string; name: string; locationId: string; assetTypeId: string;
  condition: AssetConditionKey; status: AssetStatusKey;
  serialNumber: string | null; purchaseDate: Date | null; warrantyExpiry: Date | null; purchaseCost: number | null; vendor: string | null; description: string | null;
}
export interface AssetImportIssue { row: number; field: string; message: string }

const CONDITION_BY_LABEL = new Map(ASSET_CONDITIONS.map((c) => [norm(ASSET_CONDITION_LABEL[c]), c]));
const STATUS_IMPORTABLE: Record<string, AssetStatusKey> = {
  available: "AVAILABLE", inrepair: "IN_REPAIR", lost: "LOST", notavailable: "UNAVAILABLE", unavailable: "UNAVAILABLE", retired: "RETIRED",
};

/** Parse "2026-09-14", "14/09/2026" or "14 Sep 2026" as a UTC date. */
export function parseAssetImportDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
    if (mon >= 0) return validDate(+m[3], mon + 1, +m[1]);
  }
  return null;
}
function validDate(y: number, mo: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

/**
 * Validate mapped rows against the tenant's reference data. ADD needs a new,
 * unique Asset ID; UPDATE needs an existing one. Rows are numbered as in the
 * file (header = row 1).
 */
export function validateAssetImport(
  rows: string[][], headers: string[], mapping: Record<string, string>, refs: AssetImportRefs, mode: "ADD" | "UPDATE", restrictTypeId?: string | null,
): { valid: AssetImportRow[]; issues: AssetImportIssue[] } {
  const col = new Map<string, number>();
  headers.forEach((h, i) => { const f = mapping[h]; if (f) col.set(f, i); });
  const issues: AssetImportIssue[] = [];
  for (const f of ASSET_IMPORT_FIELDS) if (f.required && !col.has(f.key)) issues.push({ row: 1, field: f.label, message: `Map a column to ${f.label}.` });
  if (issues.length) return { valid: [], issues };

  const valid: AssetImportRow[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const get = (k: AssetImportFieldKey) => (col.has(k) ? (r[col.get(k)!] ?? "").trim() : "");
    const bad = (field: string, message: string) => issues.push({ row: rowNo, field, message });
    const before = issues.length;

    const tag = get("assetTag");
    if (!tag) bad("Asset ID", "Asset ID is required.");
    else if (seen.has(tag.toLowerCase())) bad("Asset ID", `${tag} appears more than once in the file.`);
    else if (mode === "ADD" && refs.existingTags.has(tag.toLowerCase())) bad("Asset ID", `${tag} already exists. Use Bulk Update to change it.`);
    else if (mode === "UPDATE" && !refs.existingTags.has(tag.toLowerCase())) bad("Asset ID", `${tag} does not exist. Use Bulk Add to create it.`);
    seen.add(tag.toLowerCase());

    const name = get("name");
    if (!name) bad("Asset Name", "Asset Name is required.");
    const loc = refs.locations.get(get("location").toLowerCase());
    if (!loc) bad("Asset Location", `"${get("location")}" is not a location in the system.`);
    const cat = refs.categories.get(get("category").toLowerCase());
    let typeId: string | undefined;
    if (!cat) bad("Asset Category", `"${get("category")}" is not an asset category.`);
    else {
      typeId = cat.types.get(get("type").toLowerCase());
      if (!typeId) bad("Asset Type", `"${get("type")}" is not a type in ${get("category")}.`);
      else if (restrictTypeId && typeId !== restrictTypeId) bad("Asset Type", "This import is limited to one asset type.");
    }
    const condition = CONDITION_BY_LABEL.get(norm(get("condition")));
    if (!condition) bad("Asset Condition", `"${get("condition")}" is not a condition (Good, Fair, Poor…).`);
    const status = STATUS_IMPORTABLE[norm(get("status"))];
    if (!status) bad("Asset Status", `"${get("status")}" is not an importable status (Available, In repair, Lost, Not available, Retired).`);

    const pd = get("purchaseDate"), we = get("warrantyExpiry"), pc = get("purchaseCost");
    const purchaseDate = pd ? parseAssetImportDate(pd) : null;
    if (pd && !purchaseDate) bad("Purchased On", `"${pd}" is not a date.`);
    const warrantyExpiry = we ? parseAssetImportDate(we) : null;
    if (we && !warrantyExpiry) bad("Warranty Expires On", `"${we}" is not a date.`);
    const cost = pc ? Number(pc.replace(/[,₹\s]/g, "")) : null;
    if (pc && (cost === null || !Number.isFinite(cost) || cost < 0)) bad("Purchase Cost", `"${pc}" is not an amount.`);

    if (issues.length === before) {
      valid.push({
        row: rowNo, assetTag: tag, name, locationId: loc!, assetTypeId: typeId!, condition: condition!, status: status!,
        serialNumber: get("serialNumber") || null, purchaseDate, warrantyExpiry, purchaseCost: cost, vendor: get("vendor") || null, description: get("description") || null,
      });
    }
  });
  return { valid, issues };
}

/** Quote a value for CSV output. */
export function assetCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function assetCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(assetCsvCell).join(",")).join("\r\n") + "\r\n";
}
