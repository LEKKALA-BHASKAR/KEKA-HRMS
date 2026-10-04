"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveChecklistTemplate, completeChecklist, scheduleMaintenance, progressMaintenance, savePool, setAssetPool, reserveAsset, decideReservation,
  moveReservation, saveStockThreshold, requestDisposal, completeDisposal, reportAssetLost, startReconciliation, checkReconciliationLine, closeReconciliation,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, actorOf, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Asset operations: issue/return checklists, maintenance, shared pools and
 * bookings, stock thresholds, disposal through approval and stock-takes.
 * Asset managers (asset.item.manage) configure and approve; assigners
 * (asset.item.assign) run checklists, maintenance and hand-overs; any
 * employee books pool assets and reports a held asset lost or broken.
 */

const P = PERMISSIONS;
const PATHS = ["/assets", "/assets/operations", "/me/assets", "/me/assets/bookings"];
const ops = (v: Viewer) => canAny(v, [P.ASSET_MANAGE, P.ASSET_ASSIGN]);
async function audit(v: Viewer, entityType: string, entityId: string | null | undefined, summary: string, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" = "UPDATE") {
  await writeAudit(v, { module: "ASSET", action, entityType, entityId: entityId ?? null, summary });
}

export async function saveChecklistTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const items = str(fd, "items").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => ({ label: l.replace(/^\*\s*/, ""), required: l.startsWith("*") }));
  const r = await saveChecklistTemplate({ tenantId: v.tenantId, id: optStr(fd, "id"), kind: str(fd, "kind"), name: str(fd, "name"), categoryId: optStr(fd, "categoryId"), items, isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await audit(v, "AssetChecklistTemplate", r.id, `${str(fd, "kind")} checklist "${str(fd, "name")}" saved`);
  return result(r, PATHS);
}

export async function completeChecklistAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_ASSIGN) && !can(v, P.ASSET_MANAGE)) return DENIED;
  const kind = str(fd, "kind") === "RETURN" ? "RETURN" : "ISSUE";
  const notes: Record<string, string> = {};
  for (const [k, val] of fd.entries()) if (k.startsWith("note_") && typeof val === "string" && val.trim()) notes[k.slice(5)] = val.trim();
  const r = await completeChecklist({ actor: actorOf(v), assignmentId: str(fd, "assignmentId"), kind, done: formList(fd, "done"), notes });
  if (r.ok) await audit(v, "AssetChecklistRun", str(fd, "assignmentId"), `${kind === "ISSUE" ? "Issue" : "Return"} checklist completed`, "CREATE");
  return result(r, PATHS);
}

export async function scheduleMaintenanceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!ops(v)) return DENIED;
  const when = day(fd, "scheduledOn");
  if (!when) return no("Pick the date.");
  const r = await scheduleMaintenance({ actor: actorOf(v), assetId: str(fd, "assetId"), kind: str(fd, "kind"), title: str(fd, "title"), description: optStr(fd, "description"), scheduledOn: when, vendor: optStr(fd, "vendor"), intervalMonths: int(fd, "intervalMonths") });
  if (r.ok) await audit(v, "AssetMaintenance", r.id, `${str(fd, "kind")} scheduled: ${str(fd, "title")}`, "CREATE");
  return result(r, PATHS);
}

export async function progressMaintenanceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!ops(v)) return DENIED;
  const to = str(fd, "to") as "IN_PROGRESS" | "DONE" | "CANCELLED";
  if (!["IN_PROGRESS", "DONE", "CANCELLED"].includes(to)) return no("Pick a step.");
  const cost = money(fd, "cost");
  if (Number.isNaN(cost)) return no("Enter a valid cost.");
  const r = await progressMaintenance({ actor: actorOf(v), id: str(fd, "id"), to, cost, vendor: optStr(fd, "vendor"), note: optStr(fd, "note"), completedOn: day(fd, "completedOn") });
  if (r.ok) await audit(v, "AssetMaintenance", str(fd, "id"), `Maintenance moved to ${to}${cost ? ` (cost ₹${cost})` : ""}`);
  return result(r, PATHS);
}

/** An employee reports that an asset they hold needs repair. */
export async function reportRepairAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return DENIED;
  const a = await prisma.assetAssignment.findFirst({ where: { id: str(fd, "assignmentId"), employeeId: v.employee.id, returnedOn: null, asset: { tenantId: v.tenantId } } });
  if (!a) return no("You do not hold that asset.");
  const r = await scheduleMaintenance({ actor: actorOf(v), assetId: a.assetId, kind: "REPAIR", title: str(fd, "title"), description: optStr(fd, "description"), scheduledOn: new Date(), reportedByEmployeeId: v.employee.id });
  if (r.ok) await audit(v, "AssetMaintenance", r.id, "Employee reported an asset for repair", "CREATE");
  return result(r, PATHS);
}

export async function reportLostAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return DENIED;
  const r = await reportAssetLost({ tenantId: v.tenantId, assignmentId: str(fd, "assignmentId"), employeeId: v.employee.id, userId: v.user.id, circumstances: str(fd, "circumstances") });
  if (r.ok) await audit(v, "AssetAssignment", str(fd, "assignmentId"), "Employee reported an asset lost", "CREATE");
  return result(r, PATHS);
}

export async function savePoolAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const r = await savePool({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), description: optStr(fd, "description"), locationId: optStr(fd, "locationId"), maxDays: int(fd, "maxDays") ?? 14 });
  if (r.ok) await audit(v, "AssetPool", r.id, `Shared pool "${str(fd, "name")}" saved`);
  return result(r, PATHS);
}

export async function setAssetPoolAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const r = await setAssetPool({ tenantId: v.tenantId, assetId: str(fd, "assetId"), poolId: optStr(fd, "poolId") });
  if (r.ok) await audit(v, "Asset", str(fd, "assetId"), optStr(fd, "poolId") ? "Asset added to a shared pool" : "Asset removed from its pool");
  return result(r, PATHS);
}

/** Employees book; asset managers' own bookings and bookings they make for others are confirmed at once. */
export async function reserveAssetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const forOther = optStr(fd, "employeeId");
  if (forOther && !ops(v)) return DENIED;
  const employeeId = forOther ?? v.employee?.id;
  if (!employeeId) return no("Only employees can book assets.");
  if (forOther && !(await prisma.employee.count({ where: { id: forOther, tenantId: v.tenantId, status: { not: "EXITED" } } }))) return no("Employee not found.");
  const from = day(fd, "fromDate"), to = day(fd, "toDate");
  if (!from || !to) return no("Pick the dates.");
  const r = await reserveAsset({ tenantId: v.tenantId, assetId: str(fd, "assetId"), employeeId, userId: v.user.id, from, to, purpose: str(fd, "purpose"), autoApprove: ops(v) });
  if (r.ok) await audit(v, "AssetReservation", r.id, `Booked a pool asset ${str(fd, "fromDate")} to ${str(fd, "toDate")}`, "CREATE");
  return result(r, PATHS);
}

export async function decideReservationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!ops(v)) return DENIED;
  const decision = str(fd, "decision") === "approve" ? "APPROVED" : "REJECTED";
  const r = await decideReservation({ actor: actorOf(v), id: str(fd, "id"), decision, note: optStr(fd, "note") });
  if (r.ok) await audit(v, "AssetReservation", str(fd, "id"), `Booking ${decision.toLowerCase()}`, decision === "APPROVED" ? "APPROVE" : "REJECT");
  return result(r, PATHS);
}

export async function moveReservationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const to = str(fd, "to") as "CHECKED_OUT" | "RETURNED" | "CANCELLED";
  if (!["CHECKED_OUT", "RETURNED", "CANCELLED"].includes(to)) return no("Pick a step.");
  const asOps = ops(v);
  if (!asOps && !v.employee) return DENIED;
  const r = await moveReservation({ actor: actorOf(v), id: str(fd, "id"), to, ownEmployeeId: asOps ? null : v.employee!.id });
  if (r.ok) await audit(v, "AssetReservation", str(fd, "id"), `Booking moved to ${to}`);
  return result(r, PATHS);
}

export async function saveStockThresholdAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const min = int(fd, "minAvailable");
  if (Number.isNaN(min)) return no("Enter a whole number.");
  const r = await saveStockThreshold({ tenantId: v.tenantId, assetTypeId: str(fd, "assetTypeId"), minAvailable: min || null });
  if (r.ok) await audit(v, "AssetStockThreshold", str(fd, "assetTypeId"), r.message);
  return result(r, PATHS);
}

export async function requestDisposalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!ops(v)) return DENIED;
  const value = money(fd, "expectedValue");
  if (Number.isNaN(value)) return no("Enter a valid value.");
  const r = await requestDisposal({ actor: actorOf(v), assetId: str(fd, "assetId"), method: str(fd, "method"), reason: str(fd, "reason"), expectedValue: value });
  if (r.ok) await audit(v, "AssetDisposal", r.id, `Disposal (${str(fd, "method")}) requested`, "CREATE");
  return result(r, [...PATHS, "/inbox"]);
}

export async function completeDisposalAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const value = money(fd, "realisedValue");
  if (Number.isNaN(value)) return no("Enter a valid value.");
  const r = await completeDisposal({ actor: actorOf(v), id: str(fd, "id"), realisedValue: value, buyer: optStr(fd, "buyer") });
  if (r.ok) await audit(v, "AssetDisposal", str(fd, "id"), `Disposal completed${value !== null ? ` for ₹${value}` : ""}`);
  return result(r, PATHS);
}

export async function startReconciliationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const r = await startReconciliation({ actor: actorOf(v), name: str(fd, "name"), locationId: optStr(fd, "locationId") });
  if (r.ok) await audit(v, "AssetReconciliation", r.id, `Stock-take "${str(fd, "name")}" started`, "CREATE");
  return { ...result(r, PATHS), ...(r.id ? { values: { id: r.id } } : {}) };
}

export async function checkLineAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!ops(v)) return DENIED;
  const r = await checkReconciliationLine({ actor: actorOf(v), lineId: str(fd, "lineId"), found: str(fd, "found") === "yes", condition: optStr(fd, "condition"), location: optStr(fd, "location"), note: optStr(fd, "note") });
  return result(r, PATHS);
}

export async function closeReconciliationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ASSET_MANAGE)) return DENIED;
  const r = await closeReconciliation({ actor: actorOf(v), id: str(fd, "id"), markMissingLost: bool(fd, "markMissingLost") });
  if (r.ok) await audit(v, "AssetReconciliation", str(fd, "id"), r.message);
  return result(r, PATHS);
}
