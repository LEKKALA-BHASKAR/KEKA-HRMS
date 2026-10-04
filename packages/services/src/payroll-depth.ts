import { prisma } from "@keka/db";
import { renderTableReport } from "@keka/documents";
import { fyStartYear } from "@keka/shared";
import { attendanceWindowFor, calculateRun } from "./payroll-run";
import { SECTION_BY_KEY } from "./declarations";
import { adjustBalance } from "./time";
import {
  monthBounds, splitDeduction, registerLayout, registerColumns, employeeVariance, componentVariance, grossReconciliation, runIntegrity,
  journalVoucher, statutoryBonus, bonusConfigIssues, gratuityConfigIssues, parseDeclarationCsv, contractorTds, form26qCsv, quarterRange,
  projectPayroll, nextMonths, scenarioCost, minimumWageCheck, coverageExceptions, ptLwfStatus, toCsv,
  effectiveWindowOverride, applyWindowOverride,
  type PeriodLine, type BonusConfig, type RegisterColumn, type WindowOverride, type WindowView,
} from "./payroll-depth-math";

/**
 * Database side of the payroll depth features. Every function takes the
 * tenant id and scopes every read and write by it; the server actions add
 * the permission checks and the audit trail.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const n = (v: unknown) => Number(v ?? 0);
const SKIPPED = new Set(["VOID_SALARY_PROCESSING", "HOLD_SALARY_PROCESSING"]);
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const payPeriodLabel = (y: number, m: number) => `${MONTHS[m]} ${y}`;

// ---------------------------------------------------------------------------
//  Preferences (Hide My Pay, gratuity, statutory bonus)
// ---------------------------------------------------------------------------

export async function payrollPreferences(tenantId: string) {
  const p = await prisma.payrollPreference.findUnique({ where: { tenantId } });
  return {
    hideMyPayPage: p?.hideMyPayPage ?? false,
    gratuity: {
      eligibilityYears: n(p?.gratuityEligibilityYears ?? 5), daysPerYear: p?.gratuityDaysPerYear ?? 15, divisor: p?.gratuityDivisor ?? 26,
      cap: n(p?.gratuityCap ?? 2000000), wageCodes: Array.isArray(p?.gratuityWageCodes) ? (p!.gratuityWageCodes as string[]) : ["BASIC", "DA"],
    },
    bonus: {
      enabled: p?.bonusEnabled ?? true, eligibilityCeiling: n(p?.bonusEligibilityCeiling ?? 21000), calculationCeiling: n(p?.bonusCalculationCeiling ?? 7000),
      minimumWage: p?.bonusMinimumWage === null || p?.bonusMinimumWage === undefined ? null : n(p.bonusMinimumWage), percent: n(p?.bonusPercent ?? 8.33),
      minWorkingDays: p?.bonusMinWorkingDays ?? 30, wageCodes: Array.isArray(p?.bonusWageCodes) ? (p!.bonusWageCodes as string[]) : ["BASIC", "DA"],
    },
    saved: !!p,
  };
}

export async function isMyPayHidden(tenantId: string): Promise<boolean> {
  return (await prisma.payrollPreference.findUnique({ where: { tenantId }, select: { hideMyPayPage: true } }))?.hideMyPayPage ?? false;
}

export async function setHideMyPay(tenantId: string, hide: boolean, byUserId: string): Promise<Result> {
  await prisma.payrollPreference.upsert({ where: { tenantId }, create: { tenantId, hideMyPayPage: hide, updatedBy: byUserId }, update: { hideMyPayPage: hide, updatedBy: byUserId } });
  return { ok: true, message: hide ? "The My Pay page is now hidden from employees." : "Employees can see the My Pay page again." };
}

const codes = (raw: string) => [...new Set(raw.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];

export async function saveGratuitySettings(tenantId: string, input: { eligibilityYears: number; daysPerYear: number; divisor: number; cap: number; wageCodes: string }, byUserId: string): Promise<Result> {
  const issues = gratuityConfigIssues(input);
  const wage = codes(input.wageCodes);
  if (wage.length === 0) issues.push("Name at least one wage component, e.g. BASIC, DA");
  if (issues.length) return { ok: false, message: issues.join(". ") + "." };
  const data = { gratuityEligibilityYears: input.eligibilityYears, gratuityDaysPerYear: input.daysPerYear, gratuityDivisor: input.divisor, gratuityCap: input.cap, gratuityWageCodes: wage, updatedBy: byUserId };
  await prisma.payrollPreference.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  return { ok: true, message: "Gratuity settings saved; full and final settlements use them from now on." };
}

export async function saveBonusSettings(tenantId: string, input: BonusConfig & { enabled: boolean; wageCodes: string }, byUserId: string): Promise<Result> {
  const issues = bonusConfigIssues(input);
  const wage = codes(input.wageCodes);
  if (wage.length === 0) issues.push("Name at least one wage component, e.g. BASIC, DA");
  if (issues.length) return { ok: false, message: issues.join(". ") + "." };
  const data = {
    bonusEnabled: input.enabled, bonusEligibilityCeiling: input.eligibilityCeiling, bonusCalculationCeiling: input.calculationCeiling,
    bonusMinimumWage: input.minimumWage, bonusPercent: input.percent, bonusMinWorkingDays: input.minWorkingDays, bonusWageCodes: wage, updatedBy: byUserId,
  };
  await prisma.payrollPreference.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  return { ok: true, message: "Statutory bonus settings saved." };
}

// ---------------------------------------------------------------------------
//  1. Component overrides
// ---------------------------------------------------------------------------

export async function saveComponentOverride(input: { tenantId: string; employeeId: string; componentId: string; amount: number; from: string; to?: string | null; note?: string | null; byUserId: string }): Promise<Result & { id?: string }> {
  const [emp, comp] = await Promise.all([
    prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, displayName: true } }),
    prisma.salaryComponent.findFirst({ where: { id: input.componentId, tenantId: input.tenantId }, select: { id: true, name: true, type: true } }),
  ]);
  if (!emp) return { ok: false, message: "Employee not found." };
  if (!comp) return { ok: false, message: "Component not found." };
  if (comp.type === "EMPLOYER_CONTRIBUTION" || comp.type === "PERK") return { ok: false, message: "Statutory contributions and perks are not overridden here." };
  if (!(input.amount >= 0) || input.amount > 1_00_00_000) return { ok: false, message: "Enter a monthly amount between 0 and 1,00,00,000." };
  const from = monthBounds(input.from);
  if (!from) return { ok: false, message: "Choose the month it applies from." };
  const to = input.to ? monthBounds(input.to) : null;
  if (input.to && !to) return { ok: false, message: "The end month is not a month." };
  if (to && to.end < from.start) return { ok: false, message: "The end month is before the start month." };
  // A finalised month is closed: an override cannot reach back into it.
  const closed = await prisma.payrollRun.findFirst({
    where: { tenantId: input.tenantId, status: "FINALIZED", rolledBackAt: null, type: "REGULAR", periodStart: { gte: from.start }, lines: { some: { employeeId: input.employeeId } } },
    select: { year: true, month: true },
  });
  if (closed) return { ok: false, message: `${payPeriodLabel(closed.year, closed.month)} is already finalised for this employee; start the override from a later month.` };
  const row = await prisma.employeeComponentOverride.create({
    data: { tenantId: input.tenantId, employeeId: emp.id, componentId: comp.id, monthlyAmount: r2(input.amount), effectiveFrom: from.start, effectiveTo: to?.end ?? null, note: input.note || null, createdBy: input.byUserId },
  });
  await recalcOpenRuns(input.tenantId, emp.id, from.start);
  return { ok: true, id: row.id, message: `${comp.name} fixed at ₹${r2(input.amount).toLocaleString("en-IN")} a month for ${emp.displayName} from ${payPeriodLabel(from.year, from.month)}${to ? ` to ${payPeriodLabel(to.year, to.month)}` : ""}.` };
}

export async function deleteComponentOverride(tenantId: string, id: string): Promise<Result & { employeeId?: string }> {
  const row = await prisma.employeeComponentOverride.findFirst({ where: { id, tenantId }, include: { component: { select: { name: true } } } });
  if (!row) return { ok: false, message: "Override not found." };
  await prisma.employeeComponentOverride.delete({ where: { id } });
  await recalcOpenRuns(tenantId, row.employeeId, row.effectiveFrom);
  return { ok: true, employeeId: row.employeeId, message: `Removed the ${row.component.name} override.` };
}

/** Recalculate any open (not finalised) run that pays this employee from the given date. */
async function recalcOpenRuns(tenantId: string, employeeId: string, from: Date) {
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] }, periodEnd: { gte: from }, lines: { some: { employeeId } } },
    select: { id: true },
  });
  for (const r of runs) await calculateRun(r.id);
}

// ---------------------------------------------------------------------------
//  2. Run step 1: no-attendance days and payable units
// ---------------------------------------------------------------------------

async function openRun(tenantId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId }, include: { payGroup: { select: { attendanceCutoffDay: true } } } });
  if (!run) throw new Error("Payroll run not found");
  if (!["DRAFT", "IN_PROGRESS"].includes(run.status)) throw new Error("This run can no longer be edited");
  return run;
}

/**
 * Deduct an employee's no-attendance days in the run's window: from a leave
 * balance (what it cannot cover becomes LOP) or straight to loss of pay.
 * The days are marked on attendance with the reason, so processing keeps them.
 */
export async function deductNoAttendance(input: { tenantId: string; runId: string; employeeId: string; mode: "LOP" | "LEAVE"; leaveTypeId?: string | null; byUserId: string }): Promise<Result> {
  const run = await openRun(input.tenantId, input.runId);
  if (!(await prisma.payrollRunEmployee.count({ where: { runId: run.id, employeeId: input.employeeId } }))) return { ok: false, message: "That employee is not in this run." };
  const window = run.attendanceFrom && run.attendanceTo ? { from: run.attendanceFrom, to: run.attendanceTo } : await attendanceWindowFor(run);
  const days = await prisma.attendanceRecord.findMany({
    where: { tenantId: input.tenantId, employeeId: input.employeeId, date: { gte: window.from, lte: window.to }, status: "NO_ATTENDANCE" },
    orderBy: { date: "asc" }, select: { id: true, date: true },
  });
  if (days.length === 0) return { ok: false, message: "There are no no-attendance days to deduct in this run's window." };
  let leaveDays = 0;
  let leaveName = "";
  if (input.mode === "LEAVE") {
    const lt = input.leaveTypeId ? await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, tenantId: input.tenantId }, select: { id: true, name: true, isPaid: true } }) : null;
    if (!lt) return { ok: false, message: "Choose the leave type to deduct from." };
    if (!lt.isPaid) return { ok: false, message: `${lt.name} is unpaid; deduct as loss of pay instead.` };
    const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: input.employeeId, leaveTypeId: lt.id }, orderBy: { yearStart: "desc" }, select: { available: true } });
    leaveDays = splitDeduction(days.length, n(bal?.available)).leave;
    leaveName = lt.name;
    if (leaveDays > 0) {
      await adjustBalance({ employeeId: input.employeeId, leaveTypeId: lt.id, days: -leaveDays, note: `Deducted for ${leaveDays} no-attendance day(s) in ${payPeriodLabel(run.year, run.month)} payroll`, actorUserId: input.byUserId });
    }
  }
  const now = new Date();
  const whole = Math.floor(leaveDays);
  for (const [i, d] of days.entries()) {
    const asLeave = i < whole;
    await prisma.attendanceRecord.update({
      where: { id: d.id },
      data: asLeave
        ? { status: "ON_LEAVE", manualStatus: "ON_LEAVE", payableValue: 1, lopValue: 0, editedBy: input.byUserId, editedAt: now, editReason: `No attendance — deducted from ${leaveName} in payroll` }
        : { status: "ABSENT", manualStatus: "ABSENT", payableValue: 0, lopValue: 1, editedBy: input.byUserId, editedAt: now, editReason: "No attendance — deducted as loss of pay in payroll" },
    });
  }
  await calculateRun(run.id);
  const lop = days.length - whole;
  return { ok: true, message: `${days.length} no-attendance day(s) deducted: ${whole ? `${whole} from ${leaveName}` : ""}${whole && lop ? ", " : ""}${lop ? `${lop} as loss of pay` : ""}.` };
}

/** Payable units (days, hours or pieces) entered for one employee; blank goes back to attendance. */
export async function setPayableUnits(input: { tenantId: string; runId: string; employeeId: string; units: number | null }): Promise<Result> {
  const run = await openRun(input.tenantId, input.runId);
  if (input.units !== null && !(input.units >= 0 && input.units <= 10000)) return { ok: false, message: "Enter units between 0 and 10,000, or leave it blank to use attendance." };
  const u = await prisma.payrollRunEmployee.updateMany({ where: { runId: run.id, employeeId: input.employeeId }, data: { payableUnits: input.units === null ? null : r2(input.units) } });
  if (!u.count) return { ok: false, message: "That employee is not in this run." };
  await calculateRun(run.id);
  return { ok: true, message: input.units === null ? "Payable units now come from attendance." : `Payable units set to ${r2(input.units)}.` };
}

// ---------------------------------------------------------------------------
//  4. Pay register
// ---------------------------------------------------------------------------

export async function saveRegisterLayout(tenantId: string, payGroupId: string, columns: string[], showOutsideCtc: boolean): Promise<Result> {
  const pg = await prisma.payGroup.findFirst({ where: { id: payGroupId, tenantId }, select: { id: true, name: true } });
  if (!pg) return { ok: false, message: "Pay group not found." };
  const layout = registerLayout(columns);
  await prisma.payRegisterConfig.upsert({ where: { payGroupId }, create: { payGroupId, columns: layout, showOutsideCtc }, update: { columns: layout, showOutsideCtc } });
  return { ok: true, message: `Saved the ${pg.name} pay register layout (${layout.length} column groups). It applies to every month.` };
}

export interface RegisterData {
  run: { id: string; year: number; month: number; status: string; payGroupId: string; payGroupName: string };
  columns: RegisterColumn[];
  rows: Array<{ employeeId: string; payAction: string; cells: Record<string, string | number> }>;
  totals: Record<string, number>;
}

/** The register for a run in the pay group's saved layout — the page and the CSV both draw from this. */
export async function registerData(tenantId: string, runId: string): Promise<RegisterData | null> {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      payGroup: { select: { name: true, payRegisterConfig: true } },
      lines: {
        orderBy: { employee: { employeeNumber: "asc" } },
        include: {
          employee: {
            select: {
              employeeNumber: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, dateOfJoining: true,
              department: { select: { name: true } }, location: { select: { name: true, stateCode: true } },
              statutoryProfile: { select: { uan: true } }, identityDocs: { where: { type: "PAN" }, take: 1, select: { number: true } },
              bankAccounts: { where: { isPrimary: true }, take: 1, select: { accountNumber: true } },
            },
          },
          lines: { orderBy: { sequence: "asc" } },
        },
      },
    },
  });
  if (!run) return null;
  const cfg = run.payGroup.payRegisterConfig;
  const outsideCodes = cfg?.showOutsideCtc ? new Set<string>() : new Set((await prisma.salaryComponent.findMany({ where: { tenantId, isOutsideCtc: true }, select: { code: true } })).map((c) => c.code));
  const earnings = new Map<string, string>(), deductions = new Map<string, string>();
  for (const l of run.lines) for (const c of l.lines) {
    if ((c.type === "EARNING" || c.type === "REIMBURSEMENT") && !outsideCodes.has(c.code)) earnings.set(c.code, c.name);
    if (c.type === "DEDUCTION") deductions.set(c.code, c.name);
  }
  const columns = registerColumns(registerLayout(cfg?.columns), [...earnings], [...deductions]);
  const totals: Record<string, number> = {};
  const rows = run.lines.map((l) => {
    const e = l.employee;
    const cells: Record<string, string | number> = {};
    for (const c of columns) {
      let v: string | number;
      switch (c.key) {
        case "employeeNumber": v = e.employeeNumber; break;
        case "name": v = e.displayName ?? `${e.firstName} ${e.lastName}`; break;
        case "payableDays": v = n(l.payableDays); break;
        case "department": v = e.department?.name ?? ""; break;
        case "designation": v = e.jobTitleName ?? ""; break;
        case "location": v = e.location?.name ?? ""; break;
        case "state": v = e.location?.stateCode ?? ""; break;
        case "doj": v = e.dateOfJoining.toISOString().slice(0, 10); break;
        case "pan": v = e.identityDocs[0]?.number?.toUpperCase() ?? ""; break;
        case "uan": v = e.statutoryProfile?.uan ?? ""; break;
        case "bank": v = e.bankAccounts[0]?.accountNumber ?? ""; break;
        case "ctc": v = n(l.annualCtc); break;
        case "totalDays": v = l.totalDays; break;
        case "lopDays": v = n(l.lopDays); break;
        case "gross": v = n(l.grossEarnings); break;
        case "totalDeductions": v = n(l.totalDeductions); break;
        case "net": v = n(l.netPay); break;
        case "pfWage": v = n(l.pfWage); break;
        case "pfEmployee": v = n(l.pfEmployee); break;
        case "pfEmployer": v = n(l.pfEmployer); break;
        case "eps": v = n(l.epsEmployer); break;
        case "esiGross": v = n(l.esiGross); break;
        case "esiEmployee": v = n(l.esiEmployee); break;
        case "esiEmployer": v = n(l.esiEmployer); break;
        case "pt": v = n(l.professionalTax); break;
        case "lwf": v = n(l.lwfEmployee); break;
        case "tds": v = n(l.tds); break;
        case "employerCost": v = n(l.employerCost); break;
        case "payAction": v = l.payAction; break;
        default: v = c.code ? r2(l.lines.filter((x) => x.code === c.code).reduce((s, x) => s + n(x.amount), 0)) : "";
      }
      cells[c.key] = v;
      if (c.numeric && typeof v === "number" && c.key !== "ctc") totals[c.key] = r2((totals[c.key] ?? 0) + v);
    }
    return { employeeId: l.employeeId, payAction: l.payAction, cells };
  });
  return { run: { id: run.id, year: run.year, month: run.month, status: run.status, payGroupId: run.payGroupId, payGroupName: run.payGroup.name }, columns, rows, totals };
}

export function registerCsv(d: RegisterData): string {
  const month = payPeriodLabel(d.run.year, d.run.month);
  const head = ["Month", ...d.columns.map((c) => c.label)];
  const body = d.rows.map((r) => [month, ...d.columns.map((c) => (c.numeric && typeof r.cells[c.key] === "number" ? (r.cells[c.key] as number).toFixed(2) : r.cells[c.key]))]);
  const total = ["TOTAL", ...d.columns.map((c, i) => (i === 0 ? `${d.rows.length} employees` : d.totals[c.key] !== undefined ? d.totals[c.key].toFixed(2) : ""))];
  return toCsv([head, ...body, total]);
}

// ---------------------------------------------------------------------------
//  5. Variance, reconciliation, journal voucher
// ---------------------------------------------------------------------------

async function periodLines(runId: string): Promise<PeriodLine[]> {
  const rows = await prisma.payrollRunEmployee.findMany({
    where: { runId, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] } },
    include: { employee: { select: { employeeNumber: true, displayName: true, firstName: true, lastName: true, department: { select: { name: true } } } }, lines: true },
  });
  return rows.map((r) => ({
    employeeId: r.employeeId, employeeNumber: r.employee.employeeNumber, name: r.employee.displayName ?? `${r.employee.firstName} ${r.employee.lastName}`,
    department: r.employee.department?.name ?? "Unassigned",
    gross: n(r.grossEarnings), deductions: n(r.totalDeductions), net: n(r.netPay), employerCost: n(r.employerCost),
    components: r.lines.map((x) => ({ code: x.code, name: x.name, type: x.type, amount: n(x.amount) })),
  }));
}

/** The regular run of the same pay group for the month before. */
async function previousRun(run: { tenantId: string; payGroupId: string; year: number; month: number }) {
  const py = run.month === 1 ? run.year - 1 : run.year, pm = run.month === 1 ? 12 : run.month - 1;
  return prisma.payrollRun.findFirst({ where: { tenantId: run.tenantId, payGroupId: run.payGroupId, year: py, month: pm, type: "REGULAR", rolledBackAt: null }, orderBy: { sequence: "asc" } });
}

export async function varianceReport(tenantId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId }, include: { payGroup: { select: { name: true } } } });
  if (!run) return null;
  const prev = await previousRun(run);
  const [curr, before] = await Promise.all([periodLines(run.id), prev ? periodLines(prev.id) : Promise.resolve([] as PeriodLine[])]);
  const employees = employeeVariance(before, curr);
  const components = componentVariance(before, curr);
  const recon = grossReconciliation(before, curr);
  const raw = await prisma.payrollRunEmployee.findMany({ where: { runId: run.id }, include: { employee: { select: { employeeNumber: true } }, lines: { select: { type: true, amount: true } } } });
  const integrity = runIntegrity(
    { gross: n(run.totalGross), deductions: n(run.totalDeductions), net: n(run.totalNetPay) },
    raw.map((r) => ({ employeeNumber: r.employee.employeeNumber, gross: n(r.grossEarnings), deductions: n(r.totalDeductions), net: n(r.netPay), lines: r.lines.map((x) => ({ type: x.type, amount: n(x.amount) })), skipped: SKIPPED.has(r.payAction) })),
  );
  const totals = (l: PeriodLine[]) => ({ gross: r2(l.reduce((s, x) => s + x.gross, 0)), net: r2(l.reduce((s, x) => s + x.net, 0)), deductions: r2(l.reduce((s, x) => s + x.deductions, 0)), employerCost: r2(l.reduce((s, x) => s + x.employerCost, 0)), headcount: l.length });
  return {
    run: { id: run.id, year: run.year, month: run.month, status: run.status, payGroupName: run.payGroup.name },
    previous: prev ? { id: prev.id, year: prev.year, month: prev.month, status: prev.status } : null,
    currTotals: totals(curr), prevTotals: totals(before),
    employees, components, reconciliation: recon, integrity,
  };
}

export function varianceCsv(v: NonNullable<Awaited<ReturnType<typeof varianceReport>>>, kind: "employees" | "components" | "reconciliation"): string {
  const pct = (p: number | null) => (p === null ? "new" : `${(p * 100).toFixed(1)}%`);
  if (kind === "components") return toCsv([["Component", "Type", "Previous", "Current", "Change", "% change"], ...v.components.map((c) => [c.name, c.type, c.prev.toFixed(2), c.curr.toFixed(2), c.change.toFixed(2), pct(c.pct)])]);
  if (kind === "reconciliation") return toCsv([["Step", "Employees", "Amount"], ...v.reconciliation.steps.map((s) => [s.label, s.count, s.amount.toFixed(2)]), ["Unexplained difference", "", v.reconciliation.difference.toFixed(2)], [], ["Integrity check", "Employees", "Difference"], ...v.integrity.map((s) => [s.label, s.count, s.amount.toFixed(2)])]);
  return toCsv([
    ["Employee Number", "Name", "Department", "Status", "Previous gross", "Current gross", "Gross change", "Gross % change", "Previous net", "Current net", "Net change", "Net % change", "Main movements"],
    ...v.employees.map((e) => [e.employeeNumber, e.name, e.department, e.status, e.prevGross.toFixed(2), e.currGross.toFixed(2), e.grossChange.toFixed(2), pct(e.grossPct), e.prevNet.toFixed(2), e.currNet.toFixed(2), e.netChange.toFixed(2), pct(e.netPct), e.movers.slice(0, 4).map((m) => `${m.name} ${m.change >= 0 ? "+" : ""}${m.change.toFixed(0)}`).join("; ")]),
  ]);
}

/** Build the run's journal voucher, keep it as the current version, and return it as CSV. */
export async function exportJournalVoucher(tenantId: string, runId: string, opts: { byDepartment: boolean }): Promise<{ ok: true; csv: string; filename: string; balanced: boolean; version: number } | { ok: false; message: string }> {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: { payGroup: { select: { name: true } }, lines: { include: { lines: true, employee: { select: { department: { select: { name: true } } } } } } },
  });
  if (!run) return { ok: false, message: "Payroll run not found." };
  if (!["LOCKED", "FINALIZED"].includes(run.status)) return { ok: false, message: "Lock or finalise the run before exporting its journal voucher." };
  const processed = run.lines.filter((l) => !SKIPPED.has(l.payAction));
  const groups = new Map<string, Array<{ type: string; code: string; amount: number }>>();
  for (const l of processed) {
    const k = opts.byDepartment ? l.employee.department?.name ?? "Unassigned" : "All";
    const list = groups.get(k) ?? [];
    for (const x of l.lines) list.push({ type: x.type, code: x.code, amount: n(x.amount) });
    groups.set(k, list);
  }
  const mappings = await prisma.accountMapping.findMany({ where: { tenantId }, select: { componentCode: true, accountCode: true, accountName: true } });
  const jv = journalVoucher([...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([costCenter, lines]) => ({ costCenter, lines })), mappings);
  const last = await prisma.journalVoucher.findFirst({ where: { runId }, orderBy: { version: "desc" }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  await prisma.$transaction(async (tx) => {
    await tx.journalVoucher.updateMany({ where: { runId, status: { not: "ARCHIVED" } }, data: { status: "ARCHIVED" } });
    await tx.journalVoucher.create({
      data: {
        runId, status: "EXPORTED", version, totalDebit: jv.debit, totalCredit: jv.credit, isBalanced: jv.balanced, target: "XLSX", exportedAt: new Date(),
        entries: { create: jv.rows.map((r) => ({ accountCode: r.accountCode, accountName: r.accountName, narration: r.narration, debit: r.debit, credit: r.credit, costCenterId: r.costCenter === "All" ? null : r.costCenter })) },
      },
    });
  });
  const date = run.periodEnd.toISOString().slice(0, 10);
  const voucherNo = `PAY-${run.year}${String(run.month).padStart(2, "0")}-V${version}`;
  const csv = toCsv([
    ["Voucher date", "Voucher no.", "Account code", "Account name", "Cost centre", "Debit", "Credit", "Narration"],
    ...jv.rows.map((r) => [date, voucherNo, r.accountCode, r.accountName, r.costCenter, r.debit ? r.debit.toFixed(2) : "", r.credit ? r.credit.toFixed(2) : "", `${r.narration} — ${payPeriodLabel(run.year, run.month)} payroll, ${run.payGroup.name}`]),
    ["", "", "", "Total", "", jv.debit.toFixed(2), jv.credit.toFixed(2), jv.balanced ? "Balanced" : "NOT BALANCED"],
  ]);
  return { ok: true, csv, filename: `journal-voucher-${run.year}-${String(run.month).padStart(2, "0")}-v${version}.csv`, balanced: jv.balanced, version };
}

// ---------------------------------------------------------------------------
//  6. Statutory bonus report
// ---------------------------------------------------------------------------

export async function statutoryBonusReport(tenantId: string, fy: number) {
  const prefs = await payrollPreferences(tenantId);
  const wageCodes = new Set(prefs.bonus.wageCodes);
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { run: { tenantId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] }, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] } },
    include: { run: { select: { year: true, month: true } }, employee: { select: { employeeNumber: true, displayName: true, firstName: true, lastName: true, department: { select: { name: true } } } }, lines: { where: { type: "EARNING" }, select: { code: true, amount: true } } },
  });
  const by = new Map<string, typeof lines>();
  for (const l of lines) by.set(l.employeeId, [...(by.get(l.employeeId) ?? []), l]);
  const rows = [...by.values()].map((list) => {
    const e = list[0].employee;
    const months = new Map<string, { year: number; month: number; wage: number; payableDays: number }>();
    for (const l of list) {
      const k = `${l.run.year}-${l.run.month}`;
      const cur = months.get(k) ?? { year: l.run.year, month: l.run.month, wage: 0, payableDays: 0 };
      cur.wage += l.lines.filter((x) => wageCodes.has(x.code)).reduce((s, x) => s + n(x.amount), 0);
      cur.payableDays += n(l.payableDays);
      months.set(k, cur);
    }
    const res = statutoryBonus([...months.values()], prefs.bonus);
    return { employeeId: list[0].employeeId, employeeNumber: e.employeeNumber, name: e.displayName ?? `${e.firstName} ${e.lastName}`, department: e.department?.name ?? "—", ...res };
  }).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
  const eligible = rows.filter((r) => r.eligible);
  return { config: prefs.bonus, rows, totals: { employees: rows.length, eligible: eligible.length, bonusWage: r2(eligible.reduce((s, r) => s + r.bonusWage, 0)), bonus: eligible.reduce((s, r) => s + r.bonus, 0), maxBonus: eligible.reduce((s, r) => s + r.maxBonus, 0) } };
}

export function statutoryBonusCsv(rep: Awaited<ReturnType<typeof statutoryBonusReport>>, fy: number): string {
  return toCsv([
    [`Statutory bonus — accounting year ${fy}-${String((fy + 1) % 100).padStart(2, "0")} at ${rep.config.percent}%`],
    ["Employee Number", "Name", "Department", "Eligible", "Reason", "Days worked", "Eligible months", "Bonus wage", `Bonus at ${rep.config.percent}%`, "Bonus at 20%"],
    ...rep.rows.map((r) => [r.employeeNumber, r.name, r.department, r.eligible ? "Yes" : "No", r.reason ?? "", r.daysWorked, r.eligibleMonths, r.bonusWage.toFixed(2), r.bonus.toFixed(2), r.maxBonus.toFixed(2)]),
    ["Total", "", "", rep.totals.eligible, "", "", "", rep.totals.bonusWage.toFixed(2), rep.totals.bonus.toFixed(2), rep.totals.maxBonus.toFixed(2)],
  ]);
}

// ---------------------------------------------------------------------------
//  7. Tax: windows, bulk declarations, Form 12BA, contractors / 26Q
// ---------------------------------------------------------------------------

export async function taxWindowOverrides(tenantId: string, employeeId: string, fy: number): Promise<{ declaration: WindowOverride[]; proof: WindowOverride[] }> {
  const rows = await prisma.taxWindowOverride.findMany({ where: { tenantId, fyStartYear: fy, OR: [{ employeeId }, { employeeId: null }] } });
  const pick = (kind: "DECLARATION" | "PROOF") => rows.filter((r) => r.kind === kind).map((r) => ({ employeeId: r.employeeId, state: r.state, until: r.until, createdAt: r.createdAt }));
  return { declaration: pick("DECLARATION"), proof: pick("PROOF") };
}

/**
 * The employee's declaration and proof windows with the payroll team's
 * overrides applied. A locked (approved) declaration stays closed to a
 * reopening; a lock always applies.
 */
export async function withTaxWindowOverrides<W extends WindowView, T extends { declaration: W; proof: W }>(tenantId: string, employeeId: string, fy: number, windows: T, opts: { now: Date; declarationLocked: boolean }): Promise<T> {
  const ov = await taxWindowOverrides(tenantId, employeeId, fy);
  const decl = effectiveWindowOverride(ov.declaration, employeeId, opts.now);
  const proof = effectiveWindowOverride(ov.proof, employeeId, opts.now);
  return {
    ...windows,
    declaration: decl && decl.state === "OPEN" && opts.declarationLocked ? windows.declaration : applyWindowOverride(windows.declaration, decl, "investment declarations"),
    proof: applyWindowOverride(windows.proof, proof, "proof submission"),
  };
}

export async function setTaxWindow(input: { tenantId: string; fy: number; kind: "DECLARATION" | "PROOF"; state: "OPEN" | "LOCKED" | "DEFAULT"; employeeIds: string[] | null; until: Date | null; note?: string | null; byUserId: string }): Promise<Result> {
  const what = input.kind === "DECLARATION" ? "declarations" : "proof submission";
  if (input.state === "OPEN" && input.until && input.until < new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))) return { ok: false, message: "The reopen date is in the past." };
  let ids: Array<string | null> = [null];
  if (input.employeeIds) {
    const found = await prisma.employee.findMany({ where: { tenantId: input.tenantId, id: { in: input.employeeIds } }, select: { id: true } });
    if (found.length === 0) return { ok: false, message: "Choose at least one employee." };
    ids = found.map((f) => f.id);
  }
  await prisma.$transaction(async (tx) => {
    for (const id of ids) {
      await tx.taxWindowOverride.deleteMany({ where: { tenantId: input.tenantId, fyStartYear: input.fy, kind: input.kind, employeeId: id } });
      if (input.state !== "DEFAULT") {
        await tx.taxWindowOverride.create({ data: { tenantId: input.tenantId, fyStartYear: input.fy, kind: input.kind, state: input.state, employeeId: id, until: input.state === "OPEN" ? input.until : null, note: input.note || null, createdBy: input.byUserId } });
      }
    }
  });
  const who = input.employeeIds ? `${ids.length} employee(s)` : "everyone";
  return { ok: true, message: input.state === "DEFAULT" ? `${what[0].toUpperCase()}${what.slice(1)} follow the pay group's window again for ${who}.` : input.state === "LOCKED" ? `Locked ${what} for ${who}.` : `Reopened ${what} for ${who}${input.until ? ` until ${input.until.toISOString().slice(0, 10)}` : ""}.` };
}

/** Import declared amounts from a CSV: replaces each employee's line for a section and category, creating the declaration when needed. */
export async function importDeclarations(input: { tenantId: string; fy: number; csv: string; byUserId: string }): Promise<Result & { imported?: number; errors?: string[] }> {
  const parsed = parseDeclarationCsv(input.csv, new Set(SECTION_BY_KEY.keys()));
  const errors = [...parsed.errors];
  const nums = [...new Set(parsed.rows.map((r) => r.employeeNumber))];
  const emps = await prisma.employee.findMany({ where: { tenantId: input.tenantId, employeeNumber: { in: nums } }, select: { id: true, employeeNumber: true, statutoryProfile: { select: { taxRegime: true } } } });
  const byNum = new Map(emps.map((e) => [e.employeeNumber, e]));
  let imported = 0;
  const touched = new Set<string>();
  for (const r of parsed.rows) {
    const e = byNum.get(r.employeeNumber);
    if (!e) { errors.push(`Line ${r.line}: no employee ${r.employeeNumber}.`); continue; }
    const regime = e.statutoryProfile?.taxRegime ?? "NEW";
    const info = SECTION_BY_KEY.get(r.section);
    if (regime === "NEW" && info && !info.allowedInNewRegime) { errors.push(`Line ${r.line}: ${r.section} is not allowed under the new regime ${r.employeeNumber} is on.`); continue; }
    const decl = await prisma.investmentDeclaration.upsert({ where: { employeeId_fyStartYear: { employeeId: e.id, fyStartYear: input.fy } }, create: { employeeId: e.id, fyStartYear: input.fy, regime, status: "SUBMITTED", submittedAt: new Date() }, update: {} });
    if (decl.status === "LOCKED") { errors.push(`Line ${r.line}: ${r.employeeNumber}'s declaration is locked.`); continue; }
    const existing = await prisma.declarationItem.findFirst({ where: { declarationId: decl.id, section: r.section, category: r.category } });
    if (existing) await prisma.declarationItem.update({ where: { id: existing.id }, data: { declaredAmount: r.amount } });
    else await prisma.declarationItem.create({ data: { declarationId: decl.id, section: r.section, category: r.category, description: "Imported by payroll", declaredAmount: r.amount } });
    touched.add(decl.id);
    imported++;
  }
  for (const id of touched) {
    const items = await prisma.declarationItem.findMany({ where: { declarationId: id }, select: { declaredAmount: true, approvedAmount: true } });
    await prisma.investmentDeclaration.update({ where: { id }, data: { declaredTotal: items.reduce((s, i) => s + n(i.declaredAmount), 0), approvedTotal: items.reduce((s, i) => s + n(i.approvedAmount), 0), status: "SUBMITTED", submittedAt: new Date() } });
  }
  if (imported === 0) return { ok: false, message: errors[0] ?? "Nothing to import.", errors };
  return { ok: true, imported, errors, message: `Imported ${imported} declaration line(s) for ${touched.size} employee(s)${errors.length ? `; ${errors.length} line(s) skipped` : ""}.` };
}

/** Form 12BA: the year's perquisites for one employee, from finalised payslips, as a PDF. */
export async function form12baPdf(tenantId: string, employeeId: string, fy: number): Promise<{ filename: string; content: Buffer; rows: number }> {
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId },
    include: { identityDocs: { where: { type: "PAN" }, take: 1 }, payGroup: { include: { legalEntity: true, filingDetail: true } } },
  });
  if (!e) throw new Error("Employee not found.");
  const lines = await prisma.payslipLine.findMany({
    where: { type: "PERK", runEmployee: { employeeId, run: { tenantId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] } } },
    select: { code: true, name: true, amount: true },
  });
  const perks = await prisma.perk.findMany({ where: { component: { tenantId, code: { in: [...new Set(lines.map((l) => l.code))] } } }, include: { component: { select: { code: true } } } });
  const perkOf = new Map(perks.map((p) => [p.component.code, p]));
  const by = new Map<string, { name: string; value: number }>();
  for (const l of lines) { const c = by.get(l.code) ?? { name: l.name, value: 0 }; c.value += n(l.amount); by.set(l.code, c); }
  const rows = [...by].map(([code, v]) => {
    const p = perkOf.get(code);
    const taxable = p && (!p.isTaxable || p.taxBorneByEmployer) ? 0 : v.value;
    return [v.name, p?.category ?? "Other benefit", r2(v.value), 0, r2(taxable)];
  });
  const total = rows.reduce((s, r) => s + (r[2] as number), 0), taxable = rows.reduce((s, r) => s + (r[4] as number), 0);
  const tdsLines = await prisma.payrollRunEmployee.aggregate({ where: { employeeId, run: { tenantId, status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] } }, _sum: { tds: true } });
  const entity = e.payGroup?.legalEntity;
  const content = renderTableReport({
    title: "Form No. 12BA", subtitle: `Statement of particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary — FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`,
    company: entity?.legalName ?? entity?.name ?? "Employer",
    sections: [
      {
        heading: "Employer and employee",
        meta: [["Employer", entity?.legalName ?? "—"], ["TAN", e.payGroup?.filingDetail?.tan ?? "—"], ["Employee", `${e.displayName ?? `${e.firstName} ${e.lastName}`} (${e.employeeNumber})`], ["PAN", e.identityDocs[0]?.number?.toUpperCase() ?? "Not on record"], ["Designation", e.jobTitleName ?? "—"]],
        columns: [{ label: "Nature of perquisite" }, { label: "Category (Rule 3)" }, { label: "Value as per rules", numeric: true }, { label: "Recovered from employee", numeric: true }, { label: "Chargeable to tax", numeric: true }],
        rows: rows.length ? rows : [["No perquisites in the year", "", 0, 0, 0]],
        totals: ["Total", "", r2(total), 0, r2(taxable)],
      },
    ],
    notes: [`Tax deducted from salary of the employee under s.192(1): ₹${n(tdsLines._sum.tds).toLocaleString("en-IN")}.`, "Values are as carried in finalised payroll; verify against Rule 3 valuations before signing."],
  });
  return { filename: `Form12BA-${e.employeeNumber}-FY${fy}.pdf`, content, rows: rows.length };
}

export async function saveContractor(input: { tenantId: string; id?: string | null; name: string; pan: string | null; section: string; deducteeType: string; tdsRate: number; email: string | null }): Promise<Result & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Enter the contractor's name." };
  const pan = input.pan?.trim().toUpperCase() || null;
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return { ok: false, message: "That PAN is not valid (e.g. ABCDE1234F)." };
  if (!(input.tdsRate >= 0 && input.tdsRate <= 30)) return { ok: false, message: "The TDS rate must be between 0% and 30%." };
  const data = { name, pan, section: input.section, deducteeType: input.deducteeType === "OTHER" ? "OTHER" : "INDIVIDUAL", tdsRate: input.tdsRate, email: input.email?.trim() || null };
  if (input.id) {
    const u = await prisma.tdsContractor.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
    if (!u.count) return { ok: false, message: "Contractor not found." };
    return { ok: true, id: input.id, message: `Saved ${name}.` };
  }
  const c = await prisma.tdsContractor.create({ data: { tenantId: input.tenantId, ...data } });
  return { ok: true, id: c.id, message: `Added ${name}.` };
}

export async function recordContractorPayment(input: { tenantId: string; contractorId: string; paymentDate: Date; amount: number; invoiceNumber: string | null; bsrCode: string | null; challanNumber: string | null; depositDate: Date | null; note: string | null; byUserId: string }): Promise<Result & { id?: string; tds?: number }> {
  const c = await prisma.tdsContractor.findFirst({ where: { id: input.contractorId, tenantId: input.tenantId } });
  if (!c) return { ok: false, message: "Contractor not found." };
  if (!(input.amount > 0) || input.amount > 10_00_00_000) return { ok: false, message: "Enter the amount paid." };
  if (Number.isNaN(input.paymentDate.getTime())) return { ok: false, message: "Enter the date of payment." };
  if (input.bsrCode && !/^\d{7}$/.test(input.bsrCode)) return { ok: false, message: "A BSR code is 7 digits." };
  const t = contractorTds(input.amount, n(c.tdsRate), !!c.pan);
  const p = await prisma.contractorPayment.create({
    data: {
      tenantId: input.tenantId, contractorId: c.id, paymentDate: input.paymentDate, amount: r2(input.amount), section: c.section, tdsRate: t.rate, tdsAmount: t.tds,
      invoiceNumber: input.invoiceNumber || null, bsrCode: input.bsrCode || null, challanNumber: input.challanNumber || null, depositDate: input.depositDate, note: [input.note, t.note].filter(Boolean).join(" · ") || null, createdBy: input.byUserId,
    },
  });
  return { ok: true, id: p.id, tds: t.tds, message: `Recorded ₹${r2(input.amount).toLocaleString("en-IN")} to ${c.name}; TDS ₹${t.tds.toLocaleString("en-IN")} at ${t.rate}%.` };
}

export async function deleteContractorPayment(tenantId: string, id: string): Promise<Result> {
  const d = await prisma.contractorPayment.deleteMany({ where: { id, tenantId } });
  return d.count ? { ok: true, message: "Payment removed." } : { ok: false, message: "Payment not found." };
}

export async function buildForm26q(tenantId: string, fy: number, q: number) {
  const { start, end } = quarterRange(fy, q);
  const [payments, entity] = await Promise.all([
    prisma.contractorPayment.findMany({ where: { tenantId, paymentDate: { gte: start, lte: end } }, include: { contractor: { select: { name: true, pan: true } } }, orderBy: [{ paymentDate: "asc" }] }),
    prisma.legalEntity.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { legalName: true, payGroups: { select: { filingDetail: { select: { tan: true } } } } } }),
  ]);
  const tan = entity?.payGroups.map((p) => p.filingDetail?.tan).find(Boolean) ?? null;
  const built = form26qCsv({ deductor: entity?.legalName ?? "Employer", tan, fy, quarter: q }, payments.map((p) => ({
    contractor: p.contractor.name, pan: p.contractor.pan, section: p.section, paymentDate: p.paymentDate, amount: n(p.amount), tdsRate: n(p.tdsRate), tds: n(p.tdsAmount),
    bsrCode: p.bsrCode, challanNumber: p.challanNumber, depositDate: p.depositDate,
  })));
  return { ...built, filename: `form26q-FY${fy}-Q${q}.csv`, count: payments.length };
}

// ---------------------------------------------------------------------------
//  9. Budget preview and increment scenarios
// ---------------------------------------------------------------------------

async function activeSalaries(tenantId: string, at: Date) {
  const emps = await prisma.employee.findMany({
    where: { tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } },
    select: {
      id: true, departmentId: true, lastWorkingDay: true, department: { select: { name: true } },
      salaryRevisions: { where: { status: { in: ["APPLIED", "APPROVED"] } }, orderBy: { effectiveFrom: "asc" }, select: { annualCtc: true, effectiveFrom: true, status: true } },
    },
  });
  return emps.map((e) => {
    const current = [...e.salaryRevisions].reverse().find((r) => r.effectiveFrom <= at && r.status === "APPLIED") ?? [...e.salaryRevisions].reverse().find((r) => r.effectiveFrom <= at);
    return {
      employeeId: e.id, departmentId: e.departmentId, department: e.department?.name ?? "Unassigned", lastWorkingDay: e.lastWorkingDay,
      annualCtc: n(current?.annualCtc),
      upcoming: e.salaryRevisions.filter((r) => r.effectiveFrom > at).map((r) => ({ effectiveFrom: r.effectiveFrom, annualCtc: n(r.annualCtc) })),
    };
  });
}

/** Projected cost for the next months, by month and by department. */
export async function budgetPreview(tenantId: string, months = 3, today = new Date()) {
  const emps = await activeSalaries(tenantId, today);
  const ms = nextMonths(today, months);
  const total = projectPayroll(emps, ms);
  const depts = [...new Set(emps.map((e) => e.department))].sort();
  const byDept = depts.map((d) => ({ department: d, months: projectPayroll(emps.filter((e) => e.department === d), ms) }));
  const lastRun = await prisma.payrollRun.findFirst({ where: { tenantId, type: "REGULAR", rolledBackAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { year: true, month: true, totalGross: true, totalEmployerCost: true } });
  return { months: total, byDept, lastRun: lastRun ? { year: lastRun.year, month: lastRun.month, cost: r2(n(lastRun.totalGross) + n(lastRun.totalEmployerCost)) } : null, withoutSalary: emps.filter((e) => e.annualCtc === 0 && e.upcoming.length === 0).length };
}

export async function saveScenario(input: { tenantId: string; id?: string | null; name: string; defaultPercent: number; departmentPercents: Record<string, number>; effective: string; byUserId: string }): Promise<Result & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Name the scenario." };
  const eff = monthBounds(input.effective);
  if (!eff) return { ok: false, message: "Choose the month increments take effect." };
  const pcts = [input.defaultPercent, ...Object.values(input.departmentPercents)];
  if (pcts.some((p) => !(p >= -50 && p <= 100))) return { ok: false, message: "Increments must be between -50% and 100%." };
  const depts = await prisma.department.findMany({ where: { tenantId: input.tenantId, id: { in: Object.keys(input.departmentPercents) } }, select: { id: true } });
  const clean = Object.fromEntries(depts.map((d) => [d.id, input.departmentPercents[d.id]]));
  const data = { name, defaultPercent: input.defaultPercent, departmentPercents: clean, effectiveYear: eff.year, effectiveMonth: eff.month };
  if (input.id) {
    const u = await prisma.compBudgetScenario.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
    if (!u.count) return { ok: false, message: "Scenario not found." };
    return { ok: true, id: input.id, message: `Saved ${name}.` };
  }
  const s = await prisma.compBudgetScenario.create({ data: { tenantId: input.tenantId, createdBy: input.byUserId, ...data } });
  return { ok: true, id: s.id, message: `Created ${name}.` };
}

export async function scenarioReport(tenantId: string, scenarioId: string, fyStartMonth = 4) {
  const s = await prisma.compBudgetScenario.findFirst({ where: { id: scenarioId, tenantId } });
  if (!s) return null;
  const emps = (await activeSalaries(tenantId, new Date())).filter((e) => e.annualCtc > 0);
  const res = scenarioCost(emps, { defaultPercent: n(s.defaultPercent), departmentPercents: (s.departmentPercents ?? {}) as Record<string, number>, effectiveYear: s.effectiveYear, effectiveMonth: s.effectiveMonth, fyStartMonth });
  return { scenario: { id: s.id, name: s.name, defaultPercent: n(s.defaultPercent), departmentPercents: (s.departmentPercents ?? {}) as Record<string, number>, effectiveYear: s.effectiveYear, effectiveMonth: s.effectiveMonth }, ...res };
}

// ---------------------------------------------------------------------------
//  10. Compliance reports
// ---------------------------------------------------------------------------

/** The latest regular run per pay group for a month, with everything the checks need. */
async function complianceLines(tenantId: string, year: number, month: number) {
  return prisma.payrollRunEmployee.findMany({
    where: { run: { tenantId, year, month, type: "REGULAR", rolledBackAt: null }, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] } },
    include: {
      run: { select: { payGroup: { select: { id: true, pfEnabled: true, esiEnabled: true, filingDetail: { select: { pfWageCeiling: true, esiWageLimit: true } } } } } },
      employee: { select: { employeeNumber: true, displayName: true, firstName: true, lastName: true, locationId: true, location: { select: { name: true, stateCode: true } }, statutoryProfile: true } },
      lines: { where: { type: "EARNING" }, select: { code: true, fullAmount: true, amount: true } },
    },
    orderBy: { employee: { employeeNumber: "asc" } },
  });
}
const nameOf = (e: { displayName: string | null; firstName: string; lastName: string }) => e.displayName ?? `${e.firstName} ${e.lastName}`;

export async function saveMinimumWage(input: { tenantId: string; stateCode: string; category: string; monthlyAmount: number; effectiveFrom: Date }): Promise<Result> {
  const state = input.stateCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, message: "Use the two-letter state code, e.g. KA." };
  if (!(input.monthlyAmount > 0)) return { ok: false, message: "Enter the monthly minimum wage." };
  const category = ["UNSKILLED", "SEMI_SKILLED", "SKILLED", "HIGHLY_SKILLED"].includes(input.category) ? input.category : "UNSKILLED";
  await prisma.minimumWageRate.upsert({
    where: { tenantId_stateCode_category_effectiveFrom: { tenantId: input.tenantId, stateCode: state, category, effectiveFrom: input.effectiveFrom } },
    create: { tenantId: input.tenantId, stateCode: state, category, monthlyAmount: input.monthlyAmount, effectiveFrom: input.effectiveFrom },
    update: { monthlyAmount: input.monthlyAmount },
  });
  return { ok: true, message: `Minimum wage for ${state} (${category.replace("_", "-").toLowerCase()}) saved.` };
}

export async function deleteMinimumWage(tenantId: string, id: string): Promise<Result> {
  const d = await prisma.minimumWageRate.deleteMany({ where: { id, tenantId } });
  return d.count ? { ok: true, message: "Rate removed." } : { ok: false, message: "Rate not found." };
}

export interface ComplianceTable { columns: Array<{ key: string; label: string; numeric?: boolean }>; rows: Array<Record<string, string | number | boolean>>; summary: string }

export async function minimumWageReport(tenantId: string, year: number, month: number, category = "UNSKILLED"): Promise<ComplianceTable> {
  const end = new Date(Date.UTC(year, month, 0));
  const [lines, rates] = await Promise.all([
    complianceLines(tenantId, year, month),
    prisma.minimumWageRate.findMany({ where: { tenantId, category, effectiveFrom: { lte: end } }, orderBy: { effectiveFrom: "desc" } }),
  ]);
  const rateOf = new Map<string, number>();
  for (const r of rates) if (!rateOf.has(r.stateCode)) rateOf.set(r.stateCode, n(r.monthlyAmount));
  const rows = lines.map((l) => {
    const gross = r2(l.lines.reduce((s, x) => s + n(x.fullAmount), 0));
    const state = l.employee.location?.stateCode ?? "";
    const c = minimumWageCheck(gross, state ? rateOf.get(state) ?? null : null);
    return { employeeNumber: l.employee.employeeNumber, name: nameOf(l.employee), state: state || "—", gross, minimum: state && rateOf.has(state) ? rateOf.get(state)! : "", status: c.status === "OK" ? "Compliant" : c.status === "BELOW" ? "Below minimum" : "No rate for state", shortfall: c.shortfall, _flag: c.status === "BELOW" };
  });
  const below = rows.filter((r) => r._flag).length;
  return {
    columns: [{ key: "employeeNumber", label: "Employee" }, { key: "name", label: "Name" }, { key: "state", label: "State" }, { key: "gross", label: "Monthly gross (full month)", numeric: true }, { key: "minimum", label: "Minimum wage", numeric: true }, { key: "status", label: "Status" }, { key: "shortfall", label: "Shortfall", numeric: true }],
    rows, summary: lines.length ? `${below} of ${rows.length} employee(s) below the ${category.replace("_", "-").toLowerCase()} minimum wage for their state.` : "No payroll for this month yet.",
  };
}

export async function coverageReport(tenantId: string, year: number, month: number): Promise<ComplianceTable> {
  const lines = await complianceLines(tenantId, year, month);
  const rows = lines.flatMap((l) => {
    const sp = l.employee.statutoryProfile, fd = l.run.payGroup.filingDetail;
    const issues = coverageExceptions({
      pfEnabled: sp?.pfEnabled ?? true, esiEnabled: sp?.esiEnabled ?? true, uan: sp?.uan ?? null, esicNumber: sp?.esicNumber ?? null,
      pfWage: n(l.pfWage), pfEmployee: n(l.pfEmployee), esiGross: n(l.esiGross), esiEmployee: n(l.esiEmployee),
      grossFullMonth: r2(l.lines.reduce((s, x) => s + n(x.fullAmount), 0)),
      pfWageCeiling: n(fd?.pfWageCeiling ?? 15000), esiWageLimit: n(fd?.esiWageLimit ?? 21000), payGroupPf: l.run.payGroup.pfEnabled, payGroupEsi: l.run.payGroup.esiEnabled,
    });
    return issues.map((issue) => ({ employeeNumber: l.employee.employeeNumber, name: nameOf(l.employee), pfWage: n(l.pfWage), pf: n(l.pfEmployee), esiGross: n(l.esiGross), esi: n(l.esiEmployee), issue, _flag: true }));
  });
  return {
    columns: [{ key: "employeeNumber", label: "Employee" }, { key: "name", label: "Name" }, { key: "pfWage", label: "PF wage", numeric: true }, { key: "pf", label: "PF deducted", numeric: true }, { key: "esiGross", label: "ESI gross", numeric: true }, { key: "esi", label: "ESI deducted", numeric: true }, { key: "issue", label: "Exception" }],
    rows, summary: lines.length ? `${new Set(rows.map((r) => r.employeeNumber)).size} of ${lines.length} employee(s) with a PF or ESI coverage exception.` : "No payroll for this month yet.",
  };
}

export async function ptLwfReport(tenantId: string, year: number, month: number): Promise<ComplianceTable> {
  const lines = await complianceLines(tenantId, year, month);
  const end = new Date(Date.UTC(year, month, 0));
  const groupIds = [...new Set(lines.map((l) => l.run.payGroup.id))];
  const [ptStates, lwfStates, ptRegs, lwfRegs] = await Promise.all([
    prisma.ptSlab.findMany({ where: { effectiveFrom: { lte: end } }, distinct: ["stateCode"], select: { stateCode: true } }),
    prisma.lwfRule.findMany({ where: { effectiveFrom: { lte: end } }, distinct: ["stateCode"], select: { stateCode: true } }),
    prisma.ptStateRegistration.findMany({ where: { payGroupId: { in: groupIds }, isActive: true }, select: { payGroupId: true, linkedLocations: { select: { locationId: true } } } }),
    prisma.lwfStateRegistration.findMany({ where: { payGroupId: { in: groupIds }, isActive: true }, select: { payGroupId: true, linkedLocations: { select: { locationId: true } } } }),
  ]);
  const pt = new Set(ptStates.map((s) => s.stateCode)), lwf = new Set(lwfStates.map((s) => s.stateCode));
  const linked = (regs: typeof ptRegs) => new Set(regs.flatMap((r) => r.linkedLocations.map((x) => `${r.payGroupId}:${x.locationId}`)));
  const ptLinked = linked(ptRegs), lwfLinked = linked(lwfRegs);
  const rows = lines.map((l) => {
    const key = `${l.run.payGroup.id}:${l.employee.locationId}`;
    const s = ptLwfStatus({
      stateCode: l.employee.location?.stateCode ?? null, ptStates: pt, lwfStates: lwf, ptRegistered: ptLinked.has(key), lwfRegistered: lwfLinked.has(key),
      ptDeducted: n(l.professionalTax), lwfDeducted: n(l.lwfEmployee), ptEnabled: l.employee.statutoryProfile?.ptEnabled ?? true, lwfEnabled: l.employee.statutoryProfile?.lwfEnabled ?? true,
    });
    return { employeeNumber: l.employee.employeeNumber, name: nameOf(l.employee), location: l.employee.location?.name ?? "—", state: l.employee.location?.stateCode ?? "—", pt: s.pt, lwf: s.lwf, issues: s.issues.join("; "), _flag: s.issues.length > 0 };
  });
  return {
    columns: [{ key: "employeeNumber", label: "Employee" }, { key: "name", label: "Name" }, { key: "location", label: "Location" }, { key: "state", label: "State" }, { key: "pt", label: "Professional tax" }, { key: "lwf", label: "Labour welfare fund" }, { key: "issues", label: "Issues" }],
    rows, summary: lines.length ? `${rows.filter((r) => r._flag).length} of ${rows.length} employee(s) need attention.` : "No payroll for this month yet.",
  };
}

export type ComplianceKind = "min-wage" | "coverage" | "pt-lwf";
export async function complianceTable(tenantId: string, kind: ComplianceKind, year: number, month: number, category = "UNSKILLED"): Promise<ComplianceTable> {
  if (kind === "coverage") return coverageReport(tenantId, year, month);
  if (kind === "pt-lwf") return ptLwfReport(tenantId, year, month);
  return minimumWageReport(tenantId, year, month, category);
}

export function complianceCsv(t: ComplianceTable): string {
  return toCsv([t.columns.map((c) => c.label), ...t.rows.map((r) => t.columns.map((c) => (c.numeric && typeof r[c.key] === "number" ? (r[c.key] as number).toFixed(2) : r[c.key])))]);
}

export const currentFy = (d = new Date(), fyStartMonth = 4) => fyStartYear(d, fyStartMonth);
