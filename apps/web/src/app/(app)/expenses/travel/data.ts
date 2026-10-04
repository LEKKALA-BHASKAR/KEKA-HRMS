import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import type { TripFilter } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { qDate, qStr } from "@/lib/money";

/** Whose trips the viewer sees: the travel desk sees all; others their own, their team's and those they approve for. */
export async function tripEmployeeScope(viewer: Viewer): Promise<string[] | null> {
  if (can(viewer, PERMISSIONS.TRAVEL_MANAGE)) return null;
  const ids = new Set<string>([...viewer.allReportIds]);
  if (viewer.employee) ids.add(viewer.employee.id);
  if (can(viewer, PERMISSIONS.EXPENSE_APPROVE)) {
    const scoped = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, ...(scopedEmployeeWhere(viewer, PERMISSIONS.EXPENSE_APPROVE) as Prisma.EmployeeWhereInput) }, select: { id: true } });
    for (const e of scoped) ids.add(e.id);
  }
  return [...ids];
}

export function tripFilter(sp: Record<string, string | string[] | undefined>, employeeIds: string[] | null): TripFilter {
  return { q: qStr(sp.q), status: qStr(sp.status), travelType: qStr(sp.travelType), purposeId: qStr(sp.purposeId), from: qDate(sp.from), to: qDate(sp.to), employeeIds };
}

export const TRAVEL_REPORTS = { trips: "Trips", bookings: "Bookings", settlements: "Settlements", "per-diem": "Per diem" } as const;
export type TravelReportKind = keyof typeof TRAVEL_REPORTS;
