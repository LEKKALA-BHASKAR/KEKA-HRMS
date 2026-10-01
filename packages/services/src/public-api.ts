import { prisma, type Prisma } from "@keka/db";

/**
 * Read models for /api/v1. They return directory-level fields only: no
 * salary, bank, identity or personal contact details, whatever the key.
 * Lists page with an opaque cursor (the last id) in id order, so a client
 * walking the list never sees a row twice or misses one inserted behind it.
 */

export const API_MAX_PAGE = 200;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const pageSize = (n: unknown) => Math.min(API_MAX_PAGE, Math.max(1, Number.parseInt(String(n ?? ""), 10) || 50));

const EMPLOYEE_SELECT = {
  id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, workEmail: true, status: true,
  dateOfJoining: true, lastWorkingDay: true, jobTitleName: true, reportingManagerId: true,
  department: { select: { id: true, name: true } }, location: { select: { id: true, name: true } }, legalEntity: { select: { id: true, legalName: true } },
} satisfies Prisma.EmployeeSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;
const employeeOut = (e: EmployeeRow) => ({
  id: e.id, employeeNumber: e.employeeNumber, displayName: e.displayName, firstName: e.firstName, lastName: e.lastName,
  workEmail: e.workEmail, status: e.status, jobTitle: e.jobTitleName, dateOfJoining: day(e.dateOfJoining), lastWorkingDay: day(e.lastWorkingDay),
  reportingManagerId: e.reportingManagerId, department: e.department, location: e.location,
  legalEntity: e.legalEntity ? { id: e.legalEntity.id, name: e.legalEntity.legalName } : null,
});

export async function apiListEmployees(tenantId: string, q: { cursor?: string | null; limit?: unknown; status?: string | null; updatedSince?: string | null }) {
  const take = pageSize(q.limit);
  const since = q.updatedSince ? new Date(q.updatedSince) : null;
  if (since && Number.isNaN(since.getTime())) return { ok: false as const, message: "updatedSince must be an ISO date." };
  const statuses = q.status ? q.status.split(",").map((s) => s.trim().toUpperCase()) : null;
  const rows = await prisma.employee.findMany({
    where: { tenantId, ...(statuses ? { status: { in: statuses as never } } : { status: { not: "PREBOARDING" } }), ...(since ? { updatedAt: { gte: since } } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
    select: EMPLOYEE_SELECT, orderBy: { id: "asc" }, take: take + 1,
  });
  const more = rows.length > take;
  const page = rows.slice(0, take);
  return { ok: true as const, data: page.map(employeeOut), nextCursor: more ? page[page.length - 1]!.id : null };
}

export async function apiGetEmployee(tenantId: string, idOrNumber: string) {
  const e = await prisma.employee.findFirst({ where: { tenantId, OR: [{ id: idOrNumber }, { employeeNumber: idOrNumber }] }, select: EMPLOYEE_SELECT });
  return e ? employeeOut(e) : null;
}

export async function apiListPayrollRuns(tenantId: string, q: { year?: unknown }) {
  const year = q.year ? Number(q.year) : null;
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, status: "FINALIZED", ...(year ? { year } : {}) },
    select: { id: true, year: true, month: true, type: true, employeeCount: true, totalGross: true, totalDeductions: true, totalNetPay: true, totalEmployerCost: true, payGroup: { select: { id: true, name: true } } },
    orderBy: [{ year: "desc" }, { month: "desc" }], take: 120,
  });
  return runs.map((r) => ({
    id: r.id, year: r.year, month: r.month, type: r.type, payGroup: r.payGroup, employees: r.employeeCount,
    gross: Number(r.totalGross), deductions: Number(r.totalDeductions), netPay: Number(r.totalNetPay), employerCost: Number(r.totalEmployerCost),
  }));
}

export async function apiListLeave(tenantId: string, q: { from?: string | null; to?: string | null; status?: string | null; cursor?: string | null; limit?: unknown }) {
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : null, to = q.to ? new Date(`${q.to}T00:00:00Z`) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return { ok: false as const, message: "from and to must be YYYY-MM-DD." };
  const status = (q.status ?? "APPROVED").toUpperCase();
  if (!["APPROVED", "PENDING"].includes(status)) return { ok: false as const, message: "status is APPROVED or PENDING." };
  const take = pageSize(q.limit);
  const rows = await prisma.leaveRequest.findMany({
    where: { tenantId, status: status as never, ...(to ? { fromDate: { lte: to } } : {}), ...(from ? { toDate: { gte: from } } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
    select: { id: true, employeeId: true, fromDate: true, toDate: true, totalDays: true, status: true, leaveType: { select: { name: true, isPaid: true } } },
    orderBy: { id: "asc" }, take: take + 1,
  });
  const more = rows.length > take;
  const page = rows.slice(0, take);
  const numbers = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(page.map((r) => r.employeeId))] } }, select: { id: true, employeeNumber: true } })).map((e) => [e.id, e.employeeNumber]));
  // The reason stays private; clients learn who is away, not why.
  return {
    ok: true as const,
    data: page.map((r) => ({ id: r.id, employeeId: r.employeeId, employeeNumber: numbers.get(r.employeeId) ?? null, leaveType: r.leaveType.name, paid: r.leaveType.isPaid, fromDate: day(r.fromDate), toDate: day(r.toDate), days: Number(r.totalDays), status: r.status })),
    nextCursor: more ? page[page.length - 1]!.id : null,
  };
}
