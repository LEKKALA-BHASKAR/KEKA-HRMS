import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatAssetTag } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";

/**
 * Filters shared by a screen and its CSV download (/assets/export), so the
 * file always holds exactly the rows the screen lists.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
type SP = Record<string, string | undefined>;

export const LIST_STATUSES = ["AVAILABLE", "ASSIGNED", "IN_REPAIR", "LOST", "UNAVAILABLE", "RETIRED"] as const;

/** Asset List: ?type, ?cat, ?status, ?cond, ?loc, ?warranty=expiring|expired, ?q. */
export function assetListWhere(tenantId: string, sp: SP, asOf = new Date()): Prisma.AssetWhereInput {
  const status = LIST_STATUSES.find((s) => s === sp.status);
  const soon = new Date(asOf.getTime() + 30 * DAY);
  return {
    tenantId,
    ...(sp.type ? { assetTypeId: sp.type } : sp.cat ? { assetType: { categoryId: sp.cat } } : {}),
    // Retired assets stay out of the list unless asked for.
    ...(status ? { status } : { status: { not: "RETIRED" } }),
    ...(sp.cond ? { condition: sp.cond as Prisma.AssetWhereInput["condition"] } : {}),
    ...(sp.loc ? { locationId: sp.loc } : {}),
    ...(sp.warranty === "expired" ? { warrantyExpiry: { lt: asOf } } : sp.warranty === "expiring" ? { warrantyExpiry: { gte: asOf, lte: soon } } : {}),
    ...(sp.q ? { OR: [
      { name: { contains: sp.q, mode: "insensitive" } }, { assetTag: { contains: sp.q, mode: "insensitive" } }, { serialNumber: { contains: sp.q, mode: "insensitive" } },
      { assignments: { some: { returnedOn: null, employee: { displayName: { contains: sp.q, mode: "insensitive" } } } } },
    ] } : {}),
  };
}

export const assetListInclude = {
  assetType: { include: { category: true } }, location: true,
  assignments: { where: { returnedOn: null }, take: 1, include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } } },
} satisfies Prisma.AssetInclude;

/** Damage Recovery: recovered assignments carrying a charge, ?tab=recovered for settled ones. */
export function recoveryWhere(viewer: Viewer, sp: SP): Prisma.AssetAssignmentWhereInput {
  return {
    asset: { tenantId: viewer.tenantId },
    returnedOn: { not: null }, damageCharge: { gt: 0 },
    chargeRecovered: sp.tab === "recovered",
    employee: {
      ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
      ...(sp.dept ? { departmentId: sp.dept } : {}),
      ...(sp.estatus ? { status: sp.estatus as Prisma.EmployeeWhereInput["status"] } : {}),
    },
    ...(sp.q ? { OR: [
      { asset: { OR: [{ assetTag: { contains: sp.q, mode: "insensitive" } }, { name: { contains: sp.q, mode: "insensitive" } }] } },
      { employee: { displayName: { contains: sp.q, mode: "insensitive" } } },
    ] } : {}),
  };
}

/** Summary drill-down drawers (?list=assigned|available|unavailable) with their d* filters. */
export function summaryListWhere(viewer: Viewer, list: "assigned" | "available" | "unavailable", sp: SP): Prisma.AssetWhereInput {
  const holder: Prisma.EmployeeWhereInput = {
    ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
    ...(sp.dbu ? { businessUnitId: sp.dbu } : {}), ...(sp.ddept ? { departmentId: sp.ddept } : {}),
    ...(sp.dcc ? { costCenterId: sp.dcc } : {}), ...(sp.dle ? { legalEntityId: sp.dle } : {}),
  };
  const statusWhere: Prisma.AssetWhereInput = list === "assigned" ? { status: "ASSIGNED" } : list === "available" ? { status: "AVAILABLE" } : { status: { in: ["IN_REPAIR", "LOST", "UNAVAILABLE"] } };
  return {
    tenantId: viewer.tenantId, ...statusWhere,
    ...(sp.dcat ? { assetType: { categoryId: sp.dcat } } : {}), ...(sp.dtype ? { assetTypeId: sp.dtype } : {}),
    ...(sp.dcond ? { condition: sp.dcond as Prisma.AssetWhereInput["condition"] } : {}), ...(sp.dloc ? { locationId: sp.dloc } : {}),
    ...(list === "assigned" ? { assignments: { some: { returnedOn: null, employee: holder } } } : {}),
    ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { assetTag: { contains: sp.q, mode: "insensitive" } }, ...(list === "assigned" ? [{ assignments: { some: { returnedOn: null, employee: { displayName: { contains: sp.q, mode: "insensitive" as const } } } } }] : [])] } : {}),
  };
}

/** Assigned Assets: employees holding something, ?status, ?dept, ?loc, ?q. */
export function assignedEmployeesWhere(viewer: Viewer, sp: SP): Prisma.EmployeeWhereInput {
  return {
    ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
    assetAssignments: { some: { returnedOn: null, asset: { tenantId: viewer.tenantId } } },
    ...(sp.status ? { status: sp.status as Prisma.EmployeeWhereInput["status"] } : {}),
    ...(sp.dept ? { departmentId: sp.dept } : {}),
    ...(sp.loc ? { locationId: sp.loc } : {}),
    ...(sp.q ? { OR: [
      { displayName: { contains: sp.q, mode: "insensitive" } }, { employeeNumber: { contains: sp.q, mode: "insensitive" } },
      { assetAssignments: { some: { returnedOn: null, asset: { OR: [{ assetTag: { contains: sp.q, mode: "insensitive" } }, { name: { contains: sp.q, mode: "insensitive" } }] } } } },
    ] } : {}),
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Asset Requests, pending or closed (?tab=closed, closed between ?from and ?to — the last 60 days by default). */
export function assetRequestsWhere(viewer: Viewer, sp: SP): { where: Prisma.AssetRequestWhereInput; from: string; to: string } {
  const closed = sp.tab === "closed";
  const from = sp.from ?? isoDay(new Date(Date.now() - 60 * DAY));
  const to = sp.to ?? isoDay(new Date());
  const statusIn = closed ? ["FULFILLED", "REJECTED", "CANCELLED"] : ["PENDING", "APPROVED"];
  return {
    from, to,
    where: {
      tenantId: viewer.tenantId,
      status: { in: (sp.rstatus && statusIn.includes(sp.rstatus) ? [sp.rstatus] : statusIn) as Prisma.EnumAssetRequestStatusFilter["in"] },
      employee: {
        ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
        ...(sp.dept ? { departmentId: sp.dept } : {}), ...(sp.loc ? { locationId: sp.loc } : {}),
      },
      ...(sp.rtype ? { requestType: sp.rtype as Prisma.AssetRequestWhereInput["requestType"] } : {}),
      ...(closed ? { closedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } } : {}),
      ...(sp.q ? { OR: [{ title: { contains: sp.q, mode: "insensitive" } }, { reason: { contains: sp.q, mode: "insensitive" } }, { employee: { displayName: { contains: sp.q, mode: "insensitive" } } }] } : {}),
    },
  };
}

/** Asset Acknowledgement, pending or completed (?tab=completed, acknowledged between ?from and ?to — the last 30 days by default). */
export function acknowledgementsWhere(viewer: Viewer, sp: SP): { where: Prisma.AssetAssignmentWhereInput; from: string; to: string } {
  const done = sp.tab === "completed";
  const from = sp.from ?? isoDay(new Date(Date.now() - 30 * DAY));
  const to = sp.to ?? isoDay(new Date());
  return {
    from, to,
    where: {
      asset: { tenantId: viewer.tenantId, ...(sp.q ? { OR: [{ assetTag: { contains: sp.q, mode: "insensitive" } }, { name: { contains: sp.q, mode: "insensitive" } }] } : {}) },
      employee: scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput,
      ...(sp.emp ? { employeeId: sp.emp } : {}),
      ...(sp.cond ? { conditionOut: sp.cond as Prisma.AssetAssignmentWhereInput["conditionOut"] } : {}),
      ...(done
        ? { ackStatus: "ACKNOWLEDGED", acknowledgedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } }
        : { ackStatus: "PENDING", returnedOn: null }),
    },
  };
}

/** What the Add/Edit asset form offers: active categories with their types, locations and ID series. */
export async function assetFormOptions(tenantId: string) {
  const [cats, locations, series] = await Promise.all([
    prisma.assetCategory.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, types: { where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.assetIdSeries.findMany({ where: { tenantId, isActive: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
  ]);
  return {
    categories: cats.filter((c) => c.types.length > 0),
    locations,
    series: series.map((x) => ({ id: x.id, name: x.name, preview: formatAssetTag(x, x.nextNumber), isDefault: x.isDefault })),
  };
}

export const recoveryInclude = {
  asset: { include: { assetType: true } },
  employee: { select: { id: true, displayName: true, employeeNumber: true, status: true, payGroupId: true, department: { select: { name: true } } } },
} satisfies Prisma.AssetAssignmentInclude;
