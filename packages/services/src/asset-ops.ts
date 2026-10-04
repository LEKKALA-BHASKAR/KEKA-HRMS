import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { recordAssetEvent } from "./assets";
import { assetBookValue } from "./assets-math";
import {
  cdAddDays, cdAddMonths, cdUtcDay, parseAssetChecklistItems, checklistMissing, reservationOverlaps, stockShortfalls,
  reconciliationSummary, DISPOSAL_METHODS, MAINTENANCE_KINDS, type ChecklistItem,
} from "./cases-docs-math";

/**
 * Asset operations beyond the inventory: issue and return checklists,
 * maintenance and repairs, shared pools with reservations, stock thresholds
 * with low-stock alerts, disposal through approval, and physical
 * reconciliation (stock-take). Every step writes the asset's own history.
 */

type R = { ok: boolean; message: string };
type Actor = { tenantId: string; userId: string; label: string };
const ASSET_MANAGE = "asset.item.manage";

// ---------------------------------------------------------------------------
//  Checklists
// ---------------------------------------------------------------------------

export async function saveChecklistTemplate(input: { tenantId: string; id?: string | null; kind: string; name: string; categoryId: string | null; items: ChecklistItem[]; isActive: boolean }): Promise<R & { id?: string }> {
  if (input.kind !== "ISSUE" && input.kind !== "RETURN") return { ok: false, message: "Pick issue or return." };
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return { ok: false, message: "Name the checklist (2 to 80 characters)." };
  const items = input.items.map((i) => ({ label: i.label.trim().slice(0, 160), required: !!i.required })).filter((i) => i.label);
  if (!items.length) return { ok: false, message: "Add at least one item." };
  if (items.length > 30) return { ok: false, message: "Up to 30 items." };
  if (input.categoryId && !(await prisma.assetCategory.findFirst({ where: { id: input.categoryId, tenantId: input.tenantId } }))) return { ok: false, message: "Category not found." };
  const clash = await prisma.assetChecklistTemplate.findFirst({ where: { tenantId: input.tenantId, name, NOT: input.id ? { id: input.id } : undefined } });
  if (clash) return { ok: false, message: "Another checklist has that name." };
  if (input.id) {
    const t = await prisma.assetChecklistTemplate.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!t) return { ok: false, message: "Checklist not found." };
    await prisma.assetChecklistTemplate.update({ where: { id: t.id }, data: { kind: input.kind, name, categoryId: input.categoryId, items, isActive: input.isActive } });
    return { ok: true, id: t.id, message: "Checklist saved." };
  }
  const t = await prisma.assetChecklistTemplate.create({ data: { tenantId: input.tenantId, kind: input.kind, name, categoryId: input.categoryId, items, isActive: input.isActive } });
  return { ok: true, id: t.id, message: "Checklist created." };
}

/** The active checklist for an asset's category (category-specific beats all-category). */
export async function checklistFor(tenantId: string, kind: "ISSUE" | "RETURN", categoryId: string) {
  const ts = await prisma.assetChecklistTemplate.findMany({ where: { tenantId, kind, isActive: true, OR: [{ categoryId }, { categoryId: null }] }, orderBy: { createdAt: "asc" } });
  return ts.find((t) => t.categoryId === categoryId) ?? ts[0] ?? null;
}

/**
 * Whether recovering this assignment needs a completed return checklist
 * first. Returns the message to show, or null when recovery may go ahead.
 */
export async function returnChecklistGate(tenantId: string, assignmentId: string): Promise<string | null> {
  const a = await prisma.assetAssignment.findFirst({ where: { id: assignmentId, asset: { tenantId } }, select: { id: true, asset: { select: { assetType: { select: { categoryId: true } } } } } });
  if (!a) return null;
  const t = await checklistFor(tenantId, "RETURN", a.asset.assetType.categoryId);
  if (!t) return null;
  const run = await prisma.assetChecklistRun.findUnique({ where: { assignmentId_kind: { assignmentId: a.id, kind: "RETURN" } } });
  return run ? null : `Complete the "${t.name}" return checklist before recovering this asset.`;
}

export async function completeChecklist(input: { actor: Actor; assignmentId: string; kind: "ISSUE" | "RETURN"; done: string[]; notes: Record<string, string> }): Promise<R> {
  const t = input.actor.tenantId;
  const a = await prisma.assetAssignment.findFirst({ where: { id: input.assignmentId, asset: { tenantId: t } }, include: { asset: { include: { assetType: true } } } });
  if (!a) return { ok: false, message: "Assignment not found." };
  if (input.kind === "RETURN" && a.returnedOn) return { ok: false, message: "This asset has already been recovered." };
  const tpl = await checklistFor(t, input.kind, a.asset.assetType.categoryId);
  if (!tpl) return { ok: false, message: `No ${input.kind.toLowerCase()} checklist applies to this asset.` };
  if (await prisma.assetChecklistRun.findUnique({ where: { assignmentId_kind: { assignmentId: a.id, kind: input.kind } } })) return { ok: false, message: "This checklist is already complete." };
  const items = parseAssetChecklistItems(tpl.items).map((i, idx) => ({ ...i, done: input.done.includes(String(idx)), note: input.notes[String(idx)]?.slice(0, 300) || null }));
  const missing = checklistMissing(items);
  if (missing.length) return { ok: false, message: `Still to do: ${missing.join(", ")}.` };
  await prisma.$transaction(async (tx) => {
    await tx.assetChecklistRun.create({ data: { tenantId: t, assignmentId: a.id, assetId: a.assetId, kind: input.kind, templateId: tpl.id, items: items as unknown as Prisma.InputJsonValue, completedByUserId: input.actor.userId } });
    await recordAssetEvent(tx, { tenantId: t, assetId: a.assetId, kind: "CHECKLIST", employeeId: a.employeeId, actorId: input.actor.userId, actorLabel: input.actor.label, toValue: { kind: input.kind, checklist: tpl.name, done: items.filter((i) => i.done).length, of: items.length } });
  });
  return { ok: true, message: `${input.kind === "ISSUE" ? "Issue" : "Return"} checklist complete.` };
}

// ---------------------------------------------------------------------------
//  Maintenance
// ---------------------------------------------------------------------------

export async function scheduleMaintenance(input: { actor: Actor; assetId: string; kind: string; title: string; description?: string | null; scheduledOn: Date; vendor?: string | null; intervalMonths?: number | null; reportedByEmployeeId?: string | null }): Promise<R & { id?: string }> {
  const t = input.actor.tenantId;
  if (!(input.kind in MAINTENANCE_KINDS)) return { ok: false, message: "Pick the kind of work." };
  const title = input.title.trim();
  if (title.length < 3 || title.length > 120) return { ok: false, message: "Describe the work in a short title." };
  if (input.intervalMonths !== null && input.intervalMonths !== undefined && (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1 || input.intervalMonths > 60)) return { ok: false, message: "Repeat every 1 to 60 months." };
  const asset = await prisma.asset.findFirst({ where: { id: input.assetId, tenantId: t } });
  if (!asset) return { ok: false, message: "Asset not found." };
  if (asset.status === "RETIRED" || asset.status === "LOST") return { ok: false, message: "A retired or lost asset cannot be serviced." };
  const open = await prisma.assetMaintenance.findFirst({ where: { tenantId: t, assetId: asset.id, kind: input.kind, status: { in: ["REQUESTED", "SCHEDULED", "IN_PROGRESS"] } } });
  if (open) return { ok: false, message: `There is already open ${MAINTENANCE_KINDS[input.kind as keyof typeof MAINTENANCE_KINDS].toLowerCase()} work on this asset.` };
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.assetMaintenance.create({
      data: {
        tenantId: t, assetId: asset.id, kind: input.kind, title, description: input.description?.trim() || null, scheduledOn: cdUtcDay(input.scheduledOn),
        vendor: input.vendor?.trim() || null, intervalMonths: input.kind === "PREVENTIVE" ? input.intervalMonths ?? null : null,
        status: input.reportedByEmployeeId ? "REQUESTED" : "SCHEDULED", reportedByEmployeeId: input.reportedByEmployeeId ?? null, createdByUserId: input.actor.userId,
      },
    });
    await recordAssetEvent(tx, { tenantId: t, assetId: asset.id, kind: "MAINTENANCE", actorId: input.actor.userId, actorLabel: input.actor.label, toValue: { kind: input.kind, status: m.status, scheduledOn: m.scheduledOn.toISOString().slice(0, 10) }, note: title });
    return m;
  });
  if (input.reportedByEmployeeId) {
    const managers = await usersWithPermission(t, ASSET_MANAGE);
    await notify({ tenantId: t, userIds: managers, kind: "ASSET", title: `Repair reported: ${asset.assetTag}`, body: title, link: `/assets/maintenance` });
  }
  return { ok: true, id: m.id, message: input.reportedByEmployeeId ? "Reported; the asset team has been told." : "Maintenance scheduled." };
}

/** Move a job along: start (repairs take the asset out of service), finish (restore it, book the next visit), or cancel. */
export async function progressMaintenance(input: { actor: Actor; id: string; to: "IN_PROGRESS" | "DONE" | "CANCELLED"; cost?: number | null; vendor?: string | null; note?: string | null; completedOn?: Date | null }): Promise<R> {
  const t = input.actor.tenantId;
  const m = await prisma.assetMaintenance.findFirst({ where: { id: input.id, tenantId: t } });
  if (!m) return { ok: false, message: "Maintenance job not found." };
  const allowed: Record<string, string[]> = { REQUESTED: ["IN_PROGRESS", "CANCELLED"], SCHEDULED: ["IN_PROGRESS", "DONE", "CANCELLED"], IN_PROGRESS: ["DONE", "CANCELLED"] };
  if (!(allowed[m.status] ?? []).includes(input.to)) return { ok: false, message: `A ${m.status.toLowerCase().replace("_", " ")} job cannot move to ${input.to.toLowerCase().replace("_", " ")}.` };
  if (input.cost !== null && input.cost !== undefined && (!Number.isFinite(input.cost) || input.cost < 0)) return { ok: false, message: "Enter a cost of zero or more." };
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: m.assetId } });
  const completedOn = input.completedOn ? cdUtcDay(input.completedOn) : cdUtcDay(new Date());
  if (input.to === "DONE" && completedOn > cdUtcDay(new Date())) return { ok: false, message: "The completion date cannot be in the future." };
  let next: Date | null = null;
  await prisma.$transaction(async (tx) => {
    if (input.to === "IN_PROGRESS") {
      const takeOut = m.kind === "REPAIR" && asset.status !== "IN_REPAIR";
      await tx.assetMaintenance.update({ where: { id: m.id }, data: { status: "IN_PROGRESS", priorStatus: takeOut ? asset.status : null, vendor: input.vendor?.trim() || m.vendor } });
      if (takeOut) await tx.asset.update({ where: { id: asset.id }, data: { status: "IN_REPAIR", unavailableReason: `Repair: ${m.title}` } });
    } else {
      await tx.assetMaintenance.update({ where: { id: m.id }, data: { status: input.to, cost: input.to === "DONE" ? input.cost ?? null : m.cost, vendor: input.vendor?.trim() || m.vendor, completedOn: input.to === "DONE" ? completedOn : null, description: input.note ? `${m.description ? `${m.description}\n` : ""}${input.note.trim()}` : m.description } });
      // Put the asset back the way it was before the repair.
      if (m.priorStatus && asset.status === "IN_REPAIR") {
        await tx.asset.update({ where: { id: asset.id }, data: { status: m.priorStatus as never, unavailableReason: null, ...(input.to === "DONE" && m.kind === "REPAIR" && (asset.condition === "DAMAGED" || asset.condition === "UNUSABLE") ? { condition: "GOOD" } : {}) } });
      }
      if (input.to === "DONE" && m.kind === "PREVENTIVE" && m.intervalMonths) {
        next = cdAddMonths(completedOn, m.intervalMonths);
        await tx.assetMaintenance.create({ data: { tenantId: t, assetId: m.assetId, kind: "PREVENTIVE", title: m.title, description: null, scheduledOn: next, vendor: m.vendor, intervalMonths: m.intervalMonths, createdByUserId: input.actor.userId } });
      }
    }
    await recordAssetEvent(tx, { tenantId: t, assetId: m.assetId, kind: "MAINTENANCE", actorId: input.actor.userId, actorLabel: input.actor.label, fromValue: { status: m.status }, toValue: { status: input.to, cost: input.cost ?? null }, note: input.note?.trim() || m.title });
  });
  const nx = next as Date | null;
  return { ok: true, message: input.to === "DONE" ? `Marked done${nx ? `; next visit booked for ${nx.toISOString().slice(0, 10)}` : ""}.` : input.to === "IN_PROGRESS" ? "Work started." : "Job cancelled." };
}

/** Nightly: tell the asset team about maintenance due within a week (once per job). */
export async function runMaintenanceReminders(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.assetMaintenance.findMany({ where: { tenantId, status: "SCHEDULED", remindedAt: null, scheduledOn: { lte: cdAddDays(cdUtcDay(now), 7) } }, take: 200 });
  if (!due.length) return 0;
  const assets = new Map((await prisma.asset.findMany({ where: { id: { in: due.map((d) => d.assetId) } }, select: { id: true, assetTag: true } })).map((a) => [a.id, a.assetTag]));
  const managers = await usersWithPermission(tenantId, ASSET_MANAGE);
  await notify({ tenantId, userIds: managers, kind: "ASSET", title: `${due.length} maintenance job${due.length === 1 ? "" : "s"} due this week`, body: due.slice(0, 8).map((d) => `${assets.get(d.assetId)}: ${d.title} (${d.scheduledOn.toISOString().slice(0, 10)})`).join("\n"), link: "/assets/maintenance" });
  await prisma.assetMaintenance.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { remindedAt: now } });
  return due.length;
}

// ---------------------------------------------------------------------------
//  Pools and reservations
// ---------------------------------------------------------------------------

export async function savePool(input: { tenantId: string; id?: string | null; name: string; description?: string | null; locationId?: string | null; maxDays: number }): Promise<R & { id?: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return { ok: false, message: "Name the pool (2 to 80 characters)." };
  if (!Number.isInteger(input.maxDays) || input.maxDays < 1 || input.maxDays > 90) return { ok: false, message: "A booking may run 1 to 90 days." };
  if (input.locationId && !(await prisma.location.findFirst({ where: { id: input.locationId, tenantId: input.tenantId } }))) return { ok: false, message: "Location not found." };
  const clash = await prisma.assetPool.findFirst({ where: { tenantId: input.tenantId, name, NOT: input.id ? { id: input.id } : undefined } });
  if (clash) return { ok: false, message: "Another pool has that name." };
  const data = { name, description: input.description?.trim() || null, locationId: input.locationId || null, maxDays: input.maxDays };
  if (input.id) {
    const p = await prisma.assetPool.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!p) return { ok: false, message: "Pool not found." };
    await prisma.assetPool.update({ where: { id: p.id }, data });
    return { ok: true, id: p.id, message: "Pool saved." };
  }
  const p = await prisma.assetPool.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: p.id, message: "Pool created." };
}

export async function setAssetPool(input: { tenantId: string; assetId: string; poolId: string | null }): Promise<R> {
  const a = await prisma.asset.findFirst({ where: { id: input.assetId, tenantId: input.tenantId } });
  if (!a) return { ok: false, message: "Asset not found." };
  if (input.poolId) {
    if (!(await prisma.assetPool.findFirst({ where: { id: input.poolId, tenantId: input.tenantId } }))) return { ok: false, message: "Pool not found." };
    if (a.status === "ASSIGNED") return { ok: false, message: "Recover the asset before putting it in a shared pool." };
  } else if (await prisma.assetReservation.findFirst({ where: { tenantId: input.tenantId, assetId: a.id, status: { in: ["APPROVED", "CHECKED_OUT"] } } })) {
    return { ok: false, message: "This asset has open bookings; settle them first." };
  }
  await prisma.asset.update({ where: { id: a.id }, data: { poolId: input.poolId } });
  return { ok: true, message: input.poolId ? `${a.assetTag} is now bookable.` : `${a.assetTag} removed from its pool.` };
}

export async function reserveAsset(input: { tenantId: string; assetId: string; employeeId: string; userId: string; from: Date; to: Date; purpose: string; autoApprove: boolean }): Promise<R & { id?: string }> {
  const t = input.tenantId;
  const asset = await prisma.asset.findFirst({ where: { id: input.assetId, tenantId: t, poolId: { not: null } }, include: { pool: true, assetType: true } });
  if (!asset?.pool) return { ok: false, message: "That asset is not in a shared pool." };
  if (["RETIRED", "LOST", "UNAVAILABLE"].includes(asset.status)) return { ok: false, message: "That asset cannot be booked right now." };
  const from = cdUtcDay(input.from), to = cdUtcDay(input.to);
  if (to < from) return { ok: false, message: "The end date is before the start." };
  if (from < cdUtcDay(new Date())) return { ok: false, message: "Bookings start today or later." };
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > asset.pool.maxDays) return { ok: false, message: `Bookings from ${asset.pool.name} can run up to ${asset.pool.maxDays} days.` };
  if (input.purpose.trim().length < 3) return { ok: false, message: "Say what you need it for." };
  const r = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM assets WHERE id = ${asset.id} FOR UPDATE`;
    const existing = await tx.assetReservation.findMany({ where: { assetId: asset.id, status: { in: ["REQUESTED", "APPROVED", "CHECKED_OUT"] } }, select: { fromDate: true, toDate: true, status: true } });
    if (reservationOverlaps(existing, from, to)) return null;
    const r = await tx.assetReservation.create({ data: { tenantId: t, assetId: asset.id, employeeId: input.employeeId, fromDate: from, toDate: to, purpose: input.purpose.trim().slice(0, 300), status: input.autoApprove ? "APPROVED" : "REQUESTED", ...(input.autoApprove ? { decidedByUserId: input.userId, decidedAt: new Date() } : {}) } });
    await recordAssetEvent(tx, { tenantId: t, assetId: asset.id, kind: "RESERVED", employeeId: input.employeeId, actorId: input.userId, toValue: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), status: r.status }, note: r.purpose });
    return r;
  });
  if (!r) return { ok: false, message: "Someone has already booked it for some of those days." };
  if (!input.autoApprove) {
    const managers = await usersWithPermission(t, ASSET_MANAGE);
    await notify({ tenantId: t, userIds: managers, kind: "ASSET", title: `Booking request: ${asset.name ?? asset.assetType.name} (${asset.assetTag})`, body: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}: ${r.purpose}`, link: "/assets/pools" });
  }
  return { ok: true, id: r.id, message: input.autoApprove ? "Booked." : "Booking requested; the asset team will confirm." };
}

export async function decideReservation(input: { actor: Actor; id: string; decision: "APPROVED" | "REJECTED"; note?: string | null }): Promise<R> {
  const r = await prisma.assetReservation.findFirst({ where: { id: input.id, tenantId: input.actor.tenantId } });
  if (!r) return { ok: false, message: "Booking not found." };
  if (r.status !== "REQUESTED") return { ok: false, message: "This booking has already been decided." };
  if (input.decision === "REJECTED" && !input.note?.trim()) return { ok: false, message: "Give a reason for turning it down." };
  await prisma.assetReservation.update({ where: { id: r.id }, data: { status: input.decision, decidedByUserId: input.actor.userId, decidedAt: new Date(), decisionNote: input.note?.trim() || null } });
  const emp = await prisma.employee.findUnique({ where: { id: r.employeeId }, select: { userId: true } });
  if (emp?.userId) await notify({ tenantId: input.actor.tenantId, userIds: [emp.userId], kind: "ASSET", title: `Your booking was ${input.decision === "APPROVED" ? "confirmed" : "declined"}`, body: input.note?.trim() || null, link: "/me/assets" });
  return { ok: true, message: input.decision === "APPROVED" ? "Booking confirmed." : "Booking declined." };
}

/** Hand over (CHECKED_OUT), take back (RETURNED) or cancel a booking. */
export async function moveReservation(input: { actor: Actor; id: string; to: "CHECKED_OUT" | "RETURNED" | "CANCELLED"; ownEmployeeId?: string | null }): Promise<R> {
  const t = input.actor.tenantId;
  const r = await prisma.assetReservation.findFirst({ where: { id: input.id, tenantId: t } });
  if (!r) return { ok: false, message: "Booking not found." };
  if (input.ownEmployeeId && (r.employeeId !== input.ownEmployeeId || input.to !== "CANCELLED")) return { ok: false, message: "You can only cancel your own booking." };
  const allowed: Record<string, string[]> = { REQUESTED: ["CANCELLED"], APPROVED: ["CHECKED_OUT", "CANCELLED"], CHECKED_OUT: ["RETURNED"] };
  if (!(allowed[r.status] ?? []).includes(input.to)) return { ok: false, message: "That step is not possible for this booking." };
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: r.assetId } });
  if (input.to === "CHECKED_OUT" && asset.status !== "AVAILABLE") return { ok: false, message: "The asset is not available to hand over." };
  await prisma.$transaction(async (tx) => {
    await tx.assetReservation.update({ where: { id: r.id }, data: { status: input.to, ...(input.to === "CHECKED_OUT" ? { checkedOutAt: new Date() } : input.to === "RETURNED" ? { returnedAt: new Date() } : {}) } });
    if (input.to === "CHECKED_OUT") await tx.asset.update({ where: { id: asset.id }, data: { status: "UNAVAILABLE", unavailableReason: "Checked out on a booking" } });
    if (input.to === "RETURNED" && asset.status === "UNAVAILABLE") await tx.asset.update({ where: { id: asset.id }, data: { status: "AVAILABLE", unavailableReason: null } });
    await recordAssetEvent(tx, { tenantId: t, assetId: asset.id, kind: "RESERVED", employeeId: r.employeeId, actorId: input.actor.userId, actorLabel: input.actor.label, fromValue: { status: r.status }, toValue: { status: input.to } });
  });
  return { ok: true, message: input.to === "CHECKED_OUT" ? "Handed over." : input.to === "RETURNED" ? "Returned to the pool." : "Booking cancelled." };
}

// ---------------------------------------------------------------------------
//  Stock levels
// ---------------------------------------------------------------------------

export async function saveStockThreshold(input: { tenantId: string; assetTypeId: string; minAvailable: number | null }): Promise<R> {
  const type = await prisma.assetType.findFirst({ where: { id: input.assetTypeId, category: { tenantId: input.tenantId } } });
  if (!type) return { ok: false, message: "Asset type not found." };
  if (input.minAvailable === null) {
    await prisma.assetStockThreshold.deleteMany({ where: { tenantId: input.tenantId, assetTypeId: type.id } });
    return { ok: true, message: `No minimum for ${type.name} any more.` };
  }
  if (!Number.isInteger(input.minAvailable) || input.minAvailable < 1 || input.minAvailable > 10000) return { ok: false, message: "Minimum between 1 and 10,000." };
  await prisma.assetStockThreshold.upsert({ where: { tenantId_assetTypeId: { tenantId: input.tenantId, assetTypeId: type.id } }, create: { tenantId: input.tenantId, assetTypeId: type.id, minAvailable: input.minAvailable }, update: { minAvailable: input.minAvailable, lastAlertAt: null } });
  return { ok: true, message: `Keep at least ${input.minAvailable} ${type.name} available.` };
}

export async function stockLevels(tenantId: string) {
  const [types, counts, thresholds] = await Promise.all([
    prisma.assetType.findMany({ where: { category: { tenantId }, isActive: true }, select: { id: true, name: true, category: { select: { name: true } } }, orderBy: { name: "asc" } }),
    prisma.asset.groupBy({ by: ["assetTypeId", "status"], where: { tenantId }, _count: { _all: true } }),
    prisma.assetStockThreshold.findMany({ where: { tenantId } }),
  ]);
  const th = new Map(thresholds.map((x) => [x.assetTypeId, x]));
  return types.map((t) => {
    const by = (s: string) => counts.find((c) => c.assetTypeId === t.id && c.status === s)?._count._all ?? 0;
    const available = by("AVAILABLE"), min = th.get(t.id)?.minAvailable ?? null;
    return { assetTypeId: t.id, name: t.name, category: t.category.name, available, assigned: by("ASSIGNED"), inRepair: by("IN_REPAIR"), total: counts.filter((c) => c.assetTypeId === t.id && c.status !== "RETIRED").reduce((s, c) => s + c._count._all, 0), minAvailable: min, low: min !== null && available < min };
  });
}

/** Nightly: alert the asset team about types below their minimum (at most once a week per type). */
export async function runLowStockAlerts(tenantId: string, now = new Date()): Promise<number> {
  const thresholds = await prisma.assetStockThreshold.findMany({ where: { tenantId } });
  if (!thresholds.length) return 0;
  const avail = await prisma.asset.groupBy({ by: ["assetTypeId"], where: { tenantId, status: "AVAILABLE" }, _count: { _all: true } });
  const short = stockShortfalls(thresholds, new Map(avail.map((a) => [a.assetTypeId, a._count._all]))).filter((s) => !s.lastAlertAt || s.lastAlertAt < cdAddDays(now, -7));
  if (!short.length) return 0;
  const names = new Map((await prisma.assetType.findMany({ where: { id: { in: short.map((s) => s.assetTypeId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const managers = await usersWithPermission(tenantId, ASSET_MANAGE);
  await notify({ tenantId, userIds: managers, kind: "ASSET", title: `Low stock: ${short.map((s) => names.get(s.assetTypeId)).join(", ")}`, body: short.map((s) => `${names.get(s.assetTypeId)}: ${s.available} available, minimum ${s.minAvailable}`).join("\n"), link: "/assets/stock", email: true });
  await prisma.assetStockThreshold.updateMany({ where: { id: { in: short.map((s) => s.id) } }, data: { lastAlertAt: now } });
  return short.length;
}

// ---------------------------------------------------------------------------
//  Disposal (approved through the workflow engine)
// ---------------------------------------------------------------------------

export async function requestDisposal(input: { actor: Actor; assetId: string; method: string; reason: string; expectedValue?: number | null }): Promise<R & { id?: string }> {
  const t = input.actor.tenantId;
  if (!(input.method in DISPOSAL_METHODS)) return { ok: false, message: "Pick how it will be disposed of." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why it is being disposed of." };
  if (input.expectedValue !== null && input.expectedValue !== undefined && (!Number.isFinite(input.expectedValue) || input.expectedValue < 0)) return { ok: false, message: "Enter a value of zero or more." };
  const asset = await prisma.asset.findFirst({ where: { id: input.assetId, tenantId: t }, include: { assetType: { include: { category: true } } } });
  if (!asset) return { ok: false, message: "Asset not found." };
  if (asset.status === "ASSIGNED") return { ok: false, message: "Recover the asset before disposing of it." };
  if (asset.status === "RETIRED") return { ok: false, message: "This asset is already retired." };
  if (await prisma.assetDisposal.findFirst({ where: { tenantId: t, assetId: asset.id, status: { in: ["PENDING_APPROVAL", "APPROVED"] } } })) return { ok: false, message: "A disposal is already in progress for this asset." };
  const book = assetBookValue(asset.purchaseCost ? Number(asset.purchaseCost) : null, asset.purchaseDate, asset.assetType.category.usefulLifeMonths, new Date());
  const d = await prisma.assetDisposal.create({ data: { tenantId: t, assetId: asset.id, method: input.method, reason: input.reason.trim(), bookValue: book, expectedValue: input.expectedValue ?? null, requestedByUserId: input.actor.userId } });
  const { startWorkflow } = await import("./workflow-engine");
  const wf = await startWorkflow({
    tenantId: t, entityType: "ASSET_DISPOSAL", entityId: d.id, title: `Dispose of ${asset.assetTag} (${DISPOSAL_METHODS[input.method as keyof typeof DISPOSAL_METHODS]})`,
    details: input.reason.trim(), amount: book ?? undefined, category: asset.assetType.category.name, data: { link: "/assets/operations?tab=disposal", assetTag: asset.assetTag }, requesterUserId: input.actor.userId,
  });
  if (!wf.ok) { await prisma.assetDisposal.delete({ where: { id: d.id } }); return { ok: false, message: wf.message }; }
  await prisma.assetDisposal.updateMany({ where: { id: d.id }, data: { workflowRequestId: wf.requestId } });
  await prisma.$transaction((tx) => recordAssetEvent(tx, { tenantId: t, assetId: asset.id, kind: "DISPOSED", actorId: input.actor.userId, actorLabel: input.actor.label, toValue: { status: "PENDING_APPROVAL", method: input.method, bookValue: book }, note: input.reason.trim() }));
  const after = await prisma.assetDisposal.findUnique({ where: { id: d.id }, select: { status: true } });
  return { ok: true, id: d.id, message: after?.status === "APPROVED" ? "Disposal approved." : "Disposal sent for approval." };
}

export async function applyDisposalDecision(disposalId: string, outcome: string, actorUserId: string | null): Promise<void> {
  const d = await prisma.assetDisposal.findUnique({ where: { id: disposalId } });
  if (!d || d.status !== "PENDING_APPROVAL") return;
  const status = outcome === "APPROVED" ? "APPROVED" : outcome === "REJECTED" ? "REJECTED" : "CANCELLED";
  await prisma.$transaction(async (tx) => {
    await tx.assetDisposal.update({ where: { id: d.id }, data: { status } });
    await recordAssetEvent(tx, { tenantId: d.tenantId, assetId: d.assetId, kind: "DISPOSED", actorId: actorUserId, fromValue: { status: "PENDING_APPROVAL" }, toValue: { status } });
  });
  await notify({ tenantId: d.tenantId, userIds: [d.requestedByUserId], kind: "ASSET", title: `Disposal ${status.toLowerCase()}`, link: "/assets/disposal" });
}

export async function completeDisposal(input: { actor: Actor; id: string; realisedValue?: number | null; buyer?: string | null }): Promise<R> {
  const t = input.actor.tenantId;
  const d = await prisma.assetDisposal.findFirst({ where: { id: input.id, tenantId: t } });
  if (!d) return { ok: false, message: "Disposal not found." };
  if (d.status !== "APPROVED") return { ok: false, message: "Only an approved disposal can be completed." };
  if (d.method === "SALE" && (input.realisedValue === null || input.realisedValue === undefined)) return { ok: false, message: "Enter what it sold for." };
  if (input.realisedValue !== null && input.realisedValue !== undefined && (!Number.isFinite(input.realisedValue) || input.realisedValue < 0)) return { ok: false, message: "Enter a value of zero or more." };
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: d.assetId } });
  if (asset.status === "ASSIGNED") return { ok: false, message: "The asset has been assigned since; recover it first." };
  await prisma.$transaction(async (tx) => {
    await tx.assetDisposal.update({ where: { id: d.id }, data: { status: "COMPLETED", completedAt: new Date(), realisedValue: input.realisedValue ?? null, buyer: input.buyer?.trim() || null } });
    await tx.asset.update({ where: { id: asset.id }, data: { status: "RETIRED", currentValue: 0, poolId: null, unavailableReason: `Disposed: ${DISPOSAL_METHODS[d.method as keyof typeof DISPOSAL_METHODS]}` } });
    await tx.assetReservation.updateMany({ where: { assetId: asset.id, status: { in: ["REQUESTED", "APPROVED"] } }, data: { status: "CANCELLED", decisionNote: "Asset disposed of" } });
    await recordAssetEvent(tx, { tenantId: t, assetId: asset.id, kind: "DISPOSED", actorId: input.actor.userId, actorLabel: input.actor.label, fromValue: { status: asset.status }, toValue: { status: "RETIRED", realisedValue: input.realisedValue ?? null, buyer: input.buyer ?? null } });
  });
  return { ok: true, message: `${asset.assetTag} disposed of and retired.` };
}

// ---------------------------------------------------------------------------
//  Loss reporting
// ---------------------------------------------------------------------------

/** An employee reports an asset they hold as lost or stolen; the asset team is told. */
export async function reportAssetLost(input: { tenantId: string; assignmentId: string; employeeId: string; userId: string; circumstances: string }): Promise<R> {
  const a = await prisma.assetAssignment.findFirst({ where: { id: input.assignmentId, employeeId: input.employeeId, returnedOn: null, asset: { tenantId: input.tenantId } }, include: { asset: true } });
  if (!a) return { ok: false, message: "You do not hold that asset." };
  if (input.circumstances.trim().length < 10) return { ok: false, message: "Describe what happened." };
  if (await prisma.assetEvent.findFirst({ where: { assetId: a.assetId, kind: "LOST_REPORTED", createdAt: { gte: a.assignedOn } } })) return { ok: false, message: "You have already reported this asset lost." };
  await prisma.$transaction((tx) => recordAssetEvent(tx, { tenantId: input.tenantId, assetId: a.assetId, kind: "LOST_REPORTED", employeeId: input.employeeId, actorId: input.userId, note: input.circumstances.trim().slice(0, 1000) }));
  const managers = await usersWithPermission(input.tenantId, ASSET_MANAGE);
  await notify({ tenantId: input.tenantId, userIds: managers, kind: "ASSET", title: `Reported lost: ${a.asset.assetTag}`, body: input.circumstances.trim(), link: `/assets/${a.assetId}`, email: true });
  return { ok: true, message: "Reported. The asset team will follow up." };
}

// ---------------------------------------------------------------------------
//  Reconciliation (stock-take)
// ---------------------------------------------------------------------------

export async function startReconciliation(input: { actor: Actor; name: string; locationId: string | null }): Promise<R & { id?: string }> {
  const t = input.actor.tenantId;
  const name = input.name.trim();
  if (name.length < 3 || name.length > 120) return { ok: false, message: "Name the stock-take (3 to 120 characters)." };
  if (input.locationId && !(await prisma.location.findFirst({ where: { id: input.locationId, tenantId: t } }))) return { ok: false, message: "Location not found." };
  if (await prisma.assetReconciliation.findFirst({ where: { tenantId: t, status: "OPEN", locationId: input.locationId } })) return { ok: false, message: "A stock-take is already open for that location." };
  const assets = await prisma.asset.findMany({
    where: { tenantId: t, status: { notIn: ["RETIRED", "LOST"] }, ...(input.locationId ? { locationId: input.locationId } : {}) },
    select: { id: true, status: true, location: { select: { name: true } }, assignments: { where: { returnedOn: null }, select: { employee: { select: { displayName: true } } }, take: 1 } },
  });
  if (!assets.length) return { ok: false, message: "No assets to count there." };
  const r = await prisma.$transaction(async (tx) => {
    const r = await tx.assetReconciliation.create({ data: { tenantId: t, name, locationId: input.locationId, startedByUserId: input.actor.userId } });
    await tx.assetReconciliationLine.createMany({ data: assets.map((a) => ({ tenantId: t, reconciliationId: r.id, assetId: a.id, expectedStatus: a.status, expectedHolder: a.assignments[0]?.employee.displayName ?? null, expectedLocation: a.location?.name ?? null })) });
    return r;
  });
  return { ok: true, id: r.id, message: `Stock-take started with ${assets.length} assets to check.` };
}

export async function checkReconciliationLine(input: { actor: Actor; lineId: string; found: boolean; condition?: string | null; location?: string | null; note?: string | null }): Promise<R> {
  const l = await prisma.assetReconciliationLine.findFirst({ where: { id: input.lineId, tenantId: input.actor.tenantId }, include: { reconciliation: true } });
  if (!l) return { ok: false, message: "Line not found." };
  if (l.reconciliation.status !== "OPEN") return { ok: false, message: "This stock-take is closed." };
  await prisma.assetReconciliationLine.update({ where: { id: l.id }, data: { found: input.found, foundCondition: input.found ? input.condition || null : null, foundLocation: input.found ? input.location?.trim() || null : null, note: input.note?.trim() || null, checkedAt: new Date(), checkedByUserId: input.actor.userId } });
  return { ok: true, message: input.found ? "Marked found." : "Marked missing." };
}

/** Close: optionally mark missing assets lost and apply found conditions, record the result on each asset. */
export async function closeReconciliation(input: { actor: Actor; id: string; markMissingLost: boolean }): Promise<R & { summary?: ReturnType<typeof reconciliationSummary> }> {
  const t = input.actor.tenantId;
  const r = await prisma.assetReconciliation.findFirst({ where: { id: input.id, tenantId: t }, include: { lines: true } });
  if (!r) return { ok: false, message: "Stock-take not found." };
  if (r.status !== "OPEN") return { ok: false, message: "Already closed." };
  const summary = reconciliationSummary(r.lines);
  if (summary.unchecked > 0) return { ok: false, message: `${summary.unchecked} asset${summary.unchecked === 1 ? " is" : "s are"} still to be checked.` };
  const conditions = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED", "UNUSABLE"];
  await prisma.$transaction(async (tx) => {
    for (const l of r.lines) {
      if (l.found === false && input.markMissingLost) {
        const a = await tx.asset.findUnique({ where: { id: l.assetId }, select: { status: true } });
        if (a && a.status !== "ASSIGNED") await tx.asset.update({ where: { id: l.assetId }, data: { status: "LOST", unavailableReason: `Not found in stock-take "${r.name}"` } });
      }
      if (l.found && l.foundCondition && conditions.includes(l.foundCondition)) await tx.asset.update({ where: { id: l.assetId }, data: { condition: l.foundCondition as never } });
      await recordAssetEvent(tx, { tenantId: t, assetId: l.assetId, kind: "RECONCILED", actorId: input.actor.userId, actorLabel: input.actor.label, toValue: { found: l.found, condition: l.foundCondition, location: l.foundLocation }, note: `${r.name}${l.note ? `: ${l.note}` : ""}` });
    }
    await tx.assetReconciliation.update({ where: { id: r.id }, data: { status: "CLOSED", closedAt: new Date() } });
  });
  return { ok: true, summary, message: `Closed: ${summary.found} found, ${summary.missing} missing, ${summary.misplaced} in the wrong place.` };
}
