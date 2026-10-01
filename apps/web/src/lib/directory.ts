import "server-only";
import type { Prisma } from "@keka/db";

/**
 * The employee directory: what every colleague in a tenant may see of every
 * other — the work-facing fields on a business card. Nothing personal
 * (birth date, phone, address), financial or statutory is in here; those
 * stay behind the employee permissions and their scopes.
 */
export function directoryWhere(tenantId: string): Prisma.EmployeeWhereInput {
  return { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } };
}

export const DIRECTORY_SELECT = {
  id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, workEmail: true, photoUrl: true,
  status: true, dateOfJoining: true, reportingManagerId: true, aboutMe: true,
  department: { select: { id: true, name: true } },
  location: { select: { id: true, name: true, city: true } },
  businessUnit: { select: { id: true, name: true } },
  legalEntity: { select: { id: true, name: true } },
  costCenter: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

export type DirectoryEntry = Prisma.EmployeeGetPayload<{ select: typeof DIRECTORY_SELECT }>;

export const nameOf = (e: { displayName: string | null; firstName: string; lastName: string }) => e.displayName ?? `${e.firstName} ${e.lastName}`;
