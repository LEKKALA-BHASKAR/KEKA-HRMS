import { prisma, type Prisma } from "@keka/db";
import {
  assetAvailabilityBucket, assetBookValue, currentAssetLevel, canActOnAssetLevel, formatAssetTag, parseAssetChain, planAssetApprovals,
  type AssetConditionKey, type AssetStatusKey, type AssetLevelState,
} from "./assets-math";

export * from "./assets-math";

/**
 * Asset operations that touch the database: the ID series counter, the
 * per-asset event log, returning everything an employee holds, the approval
 * plan for a request, the summary dashboard's numbers and the count of
 * requests waiting on someone.
 */

type Tx = Prisma.TransactionClient;

export interface AssetSettingsView {
  chain: ReturnType<typeof parseAssetChain>;
  skipDuplicateApprover: boolean;
  allowEmployeeRequests: boolean;
  ackReminderDays: number | null;
  warrantyAlertDays: number;
}

export async function getAssetSettings(tenantId: string, tx: Tx = prisma): Promise<AssetSettingsView> {
  const s = await tx.assetSettings.findUnique({ where: { tenantId } });
  return {
    chain: parseAssetChain(s?.requestApprovalChain ?? ["REPORTING_MANAGER", "ASSET_MANAGER"]),
    skipDuplicateApprover: s?.skipDuplicateApprover ?? true,
    allowEmployeeRequests: s?.allowEmployeeRequests ?? true,
    ackReminderDays: s ? s.ackReminderDays : 3,
    warrantyAlertDays: s?.warrantyAlertDays ?? 30,
  };
}

/** Take the next number from a series, atomically, and format it. */
export async function nextAssetTag(tx: Tx, tenantId: string, seriesId: string): Promise<string> {
  const series = await tx.assetIdSeries.findFirst({ where: { id: seriesId, tenantId, isActive: true } });
  if (!series) throw new Error("That ID series does not exist.");
  for (let attempt = 0; attempt < 50; attempt++) {
    const bumped = await tx.assetIdSeries.update({ where: { id: series.id }, data: { nextNumber: { increment: 1 } } });
    const tag = formatAssetTag(series, bumped.nextNumber - 1);
    // A tag entered by hand may already have taken this number; skip past it.
    if (!(await tx.asset.findFirst({ where: { tenantId, assetTag: tag }, select: { id: true } }))) return tag;
  }
  throw new Error("Could not find a free number in that series.");
}

export async function recordAssetEvent(tx: Tx, e: {
  tenantId: string; assetId: string; kind: Prisma.AssetEventCreateManyInput["kind"]; employeeId?: string | null;
  actorId?: string | null; actorLabel?: string | null; fromValue?: unknown; toValue?: unknown; note?: string | null; at?: Date;
}): Promise<void> {
  await tx.assetEvent.create({
    data: {
      tenantId: e.tenantId, assetId: e.assetId, kind: e.kind, employeeId: e.employeeId ?? null,
      actorId: e.actorId ?? null, actorLabel: e.actorLabel ?? null,
      fromValue: e.fromValue === undefined ? undefined : (e.fromValue as Prisma.InputJsonValue),
      toValue: e.toValue === undefined ? undefined : (e.toValue as Prisma.InputJsonValue),
      note: e.note ?? null, ...(e.at ? { createdAt: e.at } : {}),
    },
  });
}

/**
 * Close every open assignment an employee holds and put each asset back:
 * available, or in repair if it came back damaged. Used by exits, the F&F
 * clearance and the seed, so an asset never stays "Assigned" to nobody.
 */
export async function returnAssetsForEmployee(opts: {
  tenantId: string; employeeId: string; returnedOn: Date; conditionIn?: AssetConditionKey;
  returnedBy?: string | null; actorLabel?: string | null; note?: string | null;
}, tx: Tx = prisma): Promise<number> {
  const open = await tx.assetAssignment.findMany({
    where: { employeeId: opts.employeeId, returnedOn: null, asset: { tenantId: opts.tenantId } },
    select: { id: true, assetId: true, asset: { select: { condition: true } } },
  });
  for (const a of open) {
    const cond = opts.conditionIn ?? (a.asset.condition as AssetConditionKey);
    await tx.assetAssignment.update({ where: { id: a.id }, data: { returnedOn: opts.returnedOn, conditionIn: cond, returnedBy: opts.returnedBy ?? null } });
    const broken = cond === "DAMAGED" || cond === "UNUSABLE";
    await tx.asset.update({ where: { id: a.assetId }, data: { status: broken ? "IN_REPAIR" : "AVAILABLE", condition: cond, ...(broken ? { unavailableReason: "Returned damaged" } : { unavailableReason: null }) } });
    await recordAssetEvent(tx, {
      tenantId: opts.tenantId, assetId: a.assetId, kind: "RETURNED", employeeId: opts.employeeId,
      actorId: opts.returnedBy ?? null, actorLabel: opts.actorLabel ?? null, toValue: { condition: cond }, note: opts.note ?? null, at: opts.returnedOn,
    });
  }
  return open.length;
}

/** The approval levels a new request from this employee starts with. */
export async function planRequestApprovals(tenantId: string, employeeId: string, tx: Tx = prisma) {
  const [settings, emp] = await Promise.all([
    getAssetSettings(tenantId, tx),
    tx.employee.findFirst({ where: { id: employeeId, tenantId }, select: { reportingManagerId: true } }),
  ]);
  return planAssetApprovals(settings.chain, { requesterId: employeeId, managerId: emp?.reportingManagerId ?? null });
}

export interface AssetActor { tenantId: string; employeeId: string | null; canManage: boolean; canAssign: boolean }

/**
 * Requests this person can act on now: a pending level they may decide
 * (never their own request), and — for those who assign — approved requests
 * awaiting an asset.
 */
export async function actionableAssetRequests(actor: AssetActor): Promise<Array<{ id: string; kind: "DECIDE" | "ASSIGN" }>> {
  const pending = await prisma.assetRequest.findMany({
    where: {
      tenantId: actor.tenantId, status: "PENDING",
      ...(actor.employeeId ? { NOT: { employeeId: actor.employeeId } } : {}),
      ...(actor.canManage ? {} : { approvals: { some: { approverId: actor.employeeId ?? "__none__", status: "PENDING" } } }),
    },
    select: { id: true, approvals: { select: { level: true, approverKind: true, approverId: true, status: true } } },
  });
  const out: Array<{ id: string; kind: "DECIDE" | "ASSIGN" }> = [];
  for (const r of pending) {
    const cur = currentAssetLevel(r.approvals as AssetLevelState[]);
    if (cur && canActOnAssetLevel(cur, { employeeId: actor.employeeId, canManage: actor.canManage })) out.push({ id: r.id, kind: "DECIDE" });
  }
  if (actor.canAssign) {
    const approved = await prisma.assetRequest.findMany({ where: { tenantId: actor.tenantId, status: "APPROVED" }, select: { id: true } });
    for (const r of approved) out.push({ id: r.id, kind: "ASSIGN" });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Summary dashboard
// ---------------------------------------------------------------------------

export interface AssetSummary {
  total: number; available: number; assigned: number; notAvailable: number;
  categories: string[];
  /** category → condition → count, for the availability chart. */
  availableByCondition: Record<string, Record<string, number>>;
  notAvailableByCondition: Record<string, Record<string, number>>;
  assignedByCondition: Record<string, Record<string, number>>;
}

export async function assetSummary(tenantId: string, f: { categoryId?: string | null; departmentId?: string | null; locationId?: string | null } = {}): Promise<AssetSummary> {
  const assets = await prisma.asset.findMany({
    where: { tenantId, ...(f.categoryId ? { assetType: { categoryId: f.categoryId } } : {}) },
    select: {
      status: true, condition: true, locationId: true,
      assetType: { select: { category: { select: { name: true } } } },
      assignments: { where: { returnedOn: null }, select: { employee: { select: { departmentId: true } } }, take: 1 },
    },
  });
  const cats = await prisma.assetCategory.findMany({
    where: { tenantId, isActive: true, ...(f.categoryId ? { id: f.categoryId } : {}), types: { some: {} } },
    select: { name: true }, orderBy: { name: "asc" },
  });
  const s: AssetSummary = {
    total: 0, available: 0, assigned: 0, notAvailable: 0, categories: cats.map((c) => c.name),
    availableByCondition: {}, notAvailableByCondition: {}, assignedByCondition: {},
  };
  const bump = (m: Record<string, Record<string, number>>, cat: string, cond: string) => {
    m[cat] ??= {};
    m[cat][cond] = (m[cat][cond] ?? 0) + 1;
  };
  for (const a of assets) {
    const bucket = assetAvailabilityBucket(a.status as AssetStatusKey);
    if (bucket === "RETIRED") continue;
    s.total++;
    const cat = a.assetType.category.name;
    if (bucket === "AVAILABLE") { s.available++; bump(s.availableByCondition, cat, a.condition); }
    else if (bucket === "NOT_AVAILABLE") { s.notAvailable++; bump(s.notAvailableByCondition, cat, a.condition); }
    else {
      s.assigned++;
      const dept = a.assignments[0]?.employee.departmentId ?? null;
      if ((!f.departmentId || dept === f.departmentId) && (!f.locationId || a.locationId === f.locationId)) bump(s.assignedByCondition, cat, a.condition);
    }
  }
  return s;
}

/** Recompute book values from each category's useful life, as of a date. */
export async function refreshBookValues(tenantId: string, asOf = new Date()): Promise<number> {
  const assets = await prisma.asset.findMany({
    where: { tenantId }, select: { id: true, purchaseCost: true, purchaseDate: true, currentValue: true, assetType: { select: { category: { select: { usefulLifeMonths: true } } } } },
  });
  let changed = 0;
  for (const a of assets) {
    const v = assetBookValue(a.purchaseCost === null ? null : Number(a.purchaseCost), a.purchaseDate, a.assetType.category.usefulLifeMonths, asOf);
    if (v !== (a.currentValue === null ? null : Number(a.currentValue))) {
      await prisma.asset.update({ where: { id: a.id }, data: { currentValue: v } });
      changed++;
    }
  }
  return changed;
}
