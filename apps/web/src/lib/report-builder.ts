import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { runSpec, validateSpec, parseSpec, MAX_REPORT_ROWS, type FieldDef, type ReportSpec, type EngineResult } from "@keka/services";
import { can, type Viewer } from "./context";
import { scopedEmployeeWhere, scopedEmployeeIds, inScope } from "./scope";

/**
 * Datasets the custom report builder can read. Each one names the permission
 * that unlocks it, the fields a report may use, and a loader that fetches
 * rows through the viewer's own scope for that permission. Specs only pick
 * from these fields; the engine filters, groups and totals in memory, so a
 * saved report can never ask the database for anything a dataset does not
 * already hand over.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const yrs = (from: Date) => Math.round(((Date.now() - from.getTime()) / (365.25 * DAY)) * 10) / 10;

export interface Dataset {
  key: string;
  title: string;
  description: string;
  permission: Permission;
  /** Whether the from/to window applies, and to what. */
  window: string | null;
  fields: FieldDef[];
  load(viewer: Viewer, spec: ReportSpec): Promise<Array<Record<string, unknown>>>;
}

const window = (spec: ReportSpec, defaultDays: number) => {
  const to = spec.to ? new Date(`${spec.to}T00:00:00Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const from = spec.from ? new Date(`${spec.from}T00:00:00Z`) : new Date(to.getTime() - defaultDays * DAY);
  return { from, to };
};

const ORG_FIELDS: FieldDef[] = [
  { key: "employeeNumber", label: "Employee number", type: "text" },
  { key: "name", label: "Name", type: "text" },
  { key: "department", label: "Department", type: "text" },
  { key: "location", label: "Location", type: "text" },
  { key: "legalEntity", label: "Legal entity", type: "text" },
];
const ORG_SELECT = {
  id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true,
  department: { select: { name: true } }, location: { select: { name: true } }, legalEntity: { select: { name: true } },
} as const;
type OrgRow = { id: string; employeeNumber: string; displayName: string | null; firstName: string; lastName: string; department: { name: string } | null; location: { name: string } | null; legalEntity: { name: string } | null };
const org = (e: OrgRow) => ({
  employeeNumber: e.employeeNumber, name: e.displayName ?? `${e.firstName} ${e.lastName}`,
  department: e.department?.name ?? null, location: e.location?.name ?? null, legalEntity: e.legalEntity?.name ?? null,
});
async function orgMap(viewer: Viewer, ids: string[]) {
  const emps = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: [...new Set(ids)] } }, select: ORG_SELECT });
  return new Map(emps.map((e) => [e.id, org(e)]));
}

const employees: Dataset = {
  key: "employees", title: "Employees", permission: P.EMPLOYEE_VIEW, window: null,
  description: "One row per employee you can see, with job, organisation and tenure. Personal contact and identity details are not included.",
  fields: [
    ...ORG_FIELDS,
    { key: "status", label: "Status", type: "text" },
    { key: "jobTitle", label: "Job title", type: "text" },
    { key: "businessUnit", label: "Business unit", type: "text" },
    { key: "costCenter", label: "Cost centre", type: "text" },
    { key: "band", label: "Band", type: "text" },
    { key: "workerType", label: "Worker type", type: "text" },
    { key: "gender", label: "Gender", type: "text" },
    { key: "manager", label: "Reporting manager", type: "text" },
    { key: "dateOfJoining", label: "Date of joining", type: "date", format: "date" },
    { key: "confirmationDate", label: "Confirmation date", type: "date", format: "date" },
    { key: "lastWorkingDay", label: "Last working day", type: "date", format: "date" },
    { key: "tenureYears", label: "Tenure (years)", type: "number", format: "num" },
    { key: "directReports", label: "Direct reports", type: "number", format: "int" },
  ],
  async load(viewer) {
    const rows = await prisma.employee.findMany({
      where: scopedEmployeeWhere(viewer, P.EMPLOYEE_VIEW), take: MAX_REPORT_ROWS + 1, orderBy: { employeeNumber: "asc" },
      select: {
        ...ORG_SELECT, status: true, jobTitleName: true, gender: true, dateOfJoining: true, confirmationDate: true, lastWorkingDay: true,
        businessUnit: { select: { name: true } }, costCenter: { select: { name: true } }, band: { select: { name: true } }, workerType: { select: { name: true } },
        reportingManager: { select: { displayName: true, firstName: true, lastName: true } }, _count: { select: { directReports: true } },
      },
    });
    return rows.map((e) => ({
      ...org(e), status: e.status, jobTitle: e.jobTitleName, businessUnit: e.businessUnit?.name ?? null, costCenter: e.costCenter?.name ?? null,
      band: e.band?.name ?? null, workerType: e.workerType?.name ?? null, gender: e.gender,
      manager: e.reportingManager ? e.reportingManager.displayName ?? `${e.reportingManager.firstName} ${e.reportingManager.lastName}` : null,
      dateOfJoining: d(e.dateOfJoining), confirmationDate: d(e.confirmationDate), lastWorkingDay: d(e.lastWorkingDay),
      tenureYears: yrs(e.dateOfJoining), directReports: e._count.directReports,
    }));
  },
};

const leave: Dataset = {
  key: "leave", title: "Leave requests", permission: P.LEAVE_VIEW, window: "leave start date",
  description: "Leave requests starting in the date window, for the people you can see. Reasons are not included.",
  fields: [
    ...ORG_FIELDS,
    { key: "leaveType", label: "Leave type", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "fromDate", label: "From", type: "date", format: "date" },
    { key: "toDate", label: "To", type: "date", format: "date" },
    { key: "month", label: "Month", type: "text" },
    { key: "days", label: "Days", type: "number", format: "num" },
    { key: "appliedOn", label: "Applied on", type: "date", format: "date" },
  ],
  async load(viewer, spec) {
    const { from, to } = window(spec, 90);
    const ids = await scopedEmployeeIds(viewer, P.LEAVE_VIEW);
    const rows = await prisma.leaveRequest.findMany({
      where: { tenantId: viewer.tenantId, ...inScope(ids), fromDate: { gte: from, lte: to } }, take: MAX_REPORT_ROWS + 1, orderBy: { fromDate: "asc" },
      select: { employeeId: true, status: true, fromDate: true, toDate: true, totalDays: true, createdAt: true, leaveType: { select: { name: true } } },
    });
    const who = await orgMap(viewer, rows.map((r) => r.employeeId));
    return rows.filter((r) => who.has(r.employeeId)).map((r) => ({
      ...who.get(r.employeeId)!, leaveType: r.leaveType.name, status: r.status, fromDate: d(r.fromDate), toDate: d(r.toDate),
      month: d(r.fromDate)!.slice(0, 7), days: n(r.totalDays), appliedOn: d(r.createdAt),
    }));
  },
};

const attendance: Dataset = {
  key: "attendance", title: "Attendance days", permission: P.ATTENDANCE_VIEW, window: "attendance date",
  description: "One row per person per day in the date window (31 days at most), with status, hours and loss of pay.",
  fields: [
    ...ORG_FIELDS,
    { key: "date", label: "Date", type: "date", format: "date" },
    { key: "status", label: "Status", type: "text" },
    { key: "effectiveHours", label: "Effective hours", type: "number", format: "num" },
    { key: "overtimeHours", label: "Overtime hours", type: "number", format: "num" },
    { key: "payable", label: "Payable day", type: "number", format: "num" },
    { key: "lop", label: "Loss of pay", type: "number", format: "num" },
    { key: "regularised", label: "Regularised", type: "bool" },
  ],
  async load(viewer, spec) {
    const w = window(spec, 6);
    const from = w.to.getTime() - w.from.getTime() > 30 * DAY ? new Date(w.to.getTime() - 30 * DAY) : w.from;
    const ids = await scopedEmployeeIds(viewer, P.ATTENDANCE_VIEW);
    const rows = await prisma.attendanceRecord.findMany({
      where: { tenantId: viewer.tenantId, ...inScope(ids), date: { gte: from, lte: w.to } }, take: MAX_REPORT_ROWS + 1, orderBy: [{ date: "asc" }],
      select: { employeeId: true, date: true, status: true, effectiveHours: true, overtimeHours: true, payableValue: true, lopValue: true, isRegularised: true },
    });
    const who = await orgMap(viewer, rows.map((r) => r.employeeId));
    return rows.filter((r) => who.has(r.employeeId)).map((r) => ({
      ...who.get(r.employeeId)!, date: d(r.date), status: r.status, effectiveHours: n(r.effectiveHours), overtimeHours: n(r.overtimeHours),
      payable: n(r.payableValue), lop: n(r.lopValue), regularised: r.isRegularised,
    }));
  },
};

const payroll: Dataset = {
  key: "payroll", title: "Payroll lines", permission: P.PAY_REGISTER_VIEW, window: "pay month",
  description: "One row per person per payroll run whose month falls in the date window (24 months at most), with earnings, deductions and statutory amounts.",
  fields: [
    ...ORG_FIELDS,
    { key: "payGroup", label: "Pay group", type: "text" },
    { key: "month", label: "Pay month", type: "text" },
    { key: "runType", label: "Run type", type: "text" },
    { key: "runStatus", label: "Run status", type: "text" },
    { key: "payableDays", label: "Payable days", type: "number", format: "num" },
    { key: "lopDays", label: "LOP days", type: "number", format: "num" },
    { key: "gross", label: "Gross earnings", type: "number", format: "inr" },
    { key: "deductions", label: "Total deductions", type: "number", format: "inr" },
    { key: "netPay", label: "Net pay", type: "number", format: "inr" },
    { key: "employerCost", label: "Employer cost", type: "number", format: "inr" },
    { key: "pfEmployee", label: "PF (employee)", type: "number", format: "inr" },
    { key: "pfEmployer", label: "PF (employer)", type: "number", format: "inr" },
    { key: "esiEmployee", label: "ESI (employee)", type: "number", format: "inr" },
    { key: "professionalTax", label: "Professional tax", type: "number", format: "inr" },
    { key: "tds", label: "TDS", type: "number", format: "inr" },
  ],
  async load(viewer, spec) {
    const { from, to } = window(spec, 365);
    // Whole months in the window, newest 24 at most.
    const months: Array<{ year: number; month: number }> = [];
    for (let y = to.getUTCFullYear(), m = to.getUTCMonth() + 1; months.length < 24 && y * 12 + m >= from.getUTCFullYear() * 12 + from.getUTCMonth() + 1; m === 1 ? (y--, m = 12) : m--) months.push({ year: y, month: m });
    const rows = await prisma.payrollRunEmployee.findMany({
      where: { employee: scopedEmployeeWhere(viewer, P.PAY_REGISTER_VIEW), run: { tenantId: viewer.tenantId, OR: months } },
      take: MAX_REPORT_ROWS + 1, orderBy: [{ run: { year: "asc" } }, { run: { month: "asc" } }],
      select: {
        payableDays: true, lopDays: true, grossEarnings: true, totalDeductions: true, netPay: true, employerCost: true,
        pfEmployee: true, pfEmployer: true, esiEmployee: true, professionalTax: true, tds: true,
        run: { select: { year: true, month: true, type: true, status: true, payGroup: { select: { name: true } } } },
        employee: { select: ORG_SELECT },
      },
    });
    return rows.map((r) => ({
      ...org(r.employee), payGroup: r.run.payGroup.name, month: `${r.run.year}-${String(r.run.month).padStart(2, "0")}`, runType: r.run.type, runStatus: r.run.status,
      payableDays: n(r.payableDays), lopDays: n(r.lopDays), gross: n(r.grossEarnings), deductions: n(r.totalDeductions), netPay: n(r.netPay), employerCost: n(r.employerCost),
      pfEmployee: n(r.pfEmployee), pfEmployer: n(r.pfEmployer), esiEmployee: n(r.esiEmployee), professionalTax: n(r.professionalTax), tds: n(r.tds),
    }));
  },
};

export const DATASETS: Dataset[] = [employees, leave, attendance, payroll];

export const datasetFor = (key: string) => DATASETS.find((d) => d.key === key) ?? null;
export const datasetsFor = (viewer: Viewer) => DATASETS.filter((d) => can(viewer, d.permission));

export type BuilderResult = (EngineResult & { ok: true; dataset: Dataset; capped: boolean }) | { ok: false; errors: string[] };

/** Validate, load through scope, and evaluate. */
export async function runCustomReport(viewer: Viewer, spec: ReportSpec): Promise<BuilderResult> {
  const ds = datasetFor(spec.dataset);
  if (!ds) return { ok: false, errors: ["Choose what the report is about."] };
  if (!can(viewer, ds.permission)) return { ok: false, errors: [`You cannot read ${ds.title.toLowerCase()}.`] };
  const errors = validateSpec(spec, ds.fields);
  if (errors.length) return { ok: false, errors };
  const rows = await ds.load(viewer, spec);
  const res = runSpec(rows.slice(0, MAX_REPORT_ROWS), spec, ds.fields);
  return { ...res, ok: true, dataset: ds, capped: rows.length > MAX_REPORT_ROWS };
}

/** Reports the viewer may open: their own, plus shared ones over datasets they can read. */
export async function savedReportsFor(viewer: Viewer) {
  const readable = datasetsFor(viewer).map((d) => d.key);
  return prisma.savedReport.findMany({
    where: { tenantId: viewer.tenantId, OR: [{ createdBy: viewer.user.id }, { shared: true, dataset: { in: readable } }] },
    orderBy: { updatedAt: "desc" },
  });
}

export async function savedReportFor(viewer: Viewer, id: string) {
  const r = await prisma.savedReport.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!r) return null;
  if (r.createdBy === viewer.user.id) return r;
  const ds = datasetFor(r.dataset);
  return r.shared && ds && can(viewer, ds.permission) ? r : null;
}

export function specOf(row: { dataset: string; spec: unknown }): ReportSpec {
  return parseSpec({ ...(row.spec && typeof row.spec === "object" ? row.spec : {}), dataset: row.dataset });
}

/** A spec from the URL (an unsaved run), else the saved one, else a starter for the dataset. */
export function resolveSpec(raw: string | undefined, saved: { dataset: string; spec: unknown } | null, datasetKey: string | undefined): ReportSpec {
  if (raw) { try { return parseSpec(JSON.parse(raw)); } catch { /* fall through */ } }
  if (saved) return specOf(saved);
  const ds = datasetFor(datasetKey ?? "") ?? DATASETS[0]!;
  return { dataset: ds.key, columns: ds.fields.slice(0, 5).map((f) => f.key), filters: [], aggregates: [], groupBy: null, sort: null, from: null, to: null };
}
