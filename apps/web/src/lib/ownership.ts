import "server-only";
import { prisma } from "@keka/db";

/**
 * Every id a form submits is untrusted. Before an action stores a reference
 * to another record, confirm that record belongs to the viewer's tenant —
 * otherwise a guessed id would link rows across tenants.
 */
type Ref = string | null | undefined | Array<string | null | undefined>;
type Kind = "employee" | "department" | "location" | "legalEntity" | "jobTitle" | "client" | "project" | "leaveType" | "shift" | "attendancePolicy" | "weeklyOffPolicy"
  | "businessUnit" | "costCenter" | "band" | "payGrade" | "workerType" | "payGroup" | "salaryStructure" | "leavePlan" | "numberSeries" | "user";

const counters: Record<Kind, (tenantId: string, ids: string[]) => Promise<number>> = {
  employee: (t, ids) => prisma.employee.count({ where: { tenantId: t, id: { in: ids } } }),
  department: (t, ids) => prisma.department.count({ where: { tenantId: t, id: { in: ids } } }),
  location: (t, ids) => prisma.location.count({ where: { tenantId: t, id: { in: ids } } }),
  legalEntity: (t, ids) => prisma.legalEntity.count({ where: { tenantId: t, id: { in: ids } } }),
  jobTitle: (t, ids) => prisma.jobTitle.count({ where: { tenantId: t, id: { in: ids } } }),
  client: (t, ids) => prisma.client.count({ where: { tenantId: t, id: { in: ids } } }),
  project: (t, ids) => prisma.project.count({ where: { tenantId: t, id: { in: ids } } }),
  leaveType: (t, ids) => prisma.leaveType.count({ where: { tenantId: t, id: { in: ids } } }),
  shift: (t, ids) => prisma.shift.count({ where: { tenantId: t, id: { in: ids } } }),
  attendancePolicy: (t, ids) => prisma.attendancePolicy.count({ where: { tenantId: t, id: { in: ids } } }),
  weeklyOffPolicy: (t, ids) => prisma.weeklyOffPolicy.count({ where: { tenantId: t, id: { in: ids } } }),
  businessUnit: (t, ids) => prisma.businessUnit.count({ where: { tenantId: t, id: { in: ids } } }),
  costCenter: (t, ids) => prisma.costCenter.count({ where: { tenantId: t, id: { in: ids } } }),
  band: (t, ids) => prisma.band.count({ where: { tenantId: t, id: { in: ids } } }),
  payGrade: (t, ids) => prisma.payGrade.count({ where: { tenantId: t, id: { in: ids } } }),
  workerType: (t, ids) => prisma.workerType.count({ where: { tenantId: t, id: { in: ids } } }),
  payGroup: (t, ids) => prisma.payGroup.count({ where: { tenantId: t, id: { in: ids } } }),
  salaryStructure: (t, ids) => prisma.salaryStructure.count({ where: { payGroup: { tenantId: t }, id: { in: ids } } }),
  leavePlan: (t, ids) => prisma.leavePlan.count({ where: { tenantId: t, id: { in: ids } } }),
  numberSeries: (t, ids) => prisma.employeeNumberSeries.count({ where: { tenantId: t, id: { in: ids } } }),
  user: (t, ids) => prisma.user.count({ where: { tenantId: t, id: { in: ids } } }),
};

/** Null when every referenced record is the tenant's; otherwise a message. */
export async function foreignReference(tenantId: string, refs: Partial<Record<Kind, Ref>>): Promise<string | null> {
  for (const [kind, ref] of Object.entries(refs) as Array<[Kind, Ref]>) {
    const ids = [...new Set((Array.isArray(ref) ? ref : [ref]).filter((x): x is string => !!x))];
    if (ids.length === 0) continue;
    if ((await counters[kind](tenantId, ids)) !== ids.length) return `A selected ${kind.replace(/([A-Z])/g, " $1").toLowerCase()} was not found.`;
  }
  return null;
}
