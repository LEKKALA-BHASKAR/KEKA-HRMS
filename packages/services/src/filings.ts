import { prisma } from "@keka/db";
import { calculateAnnualTax } from "@keka/payroll";
import {
  pfEcr, esiContribution, bankAdvice, form24qAnnexure, renderPayslip, renderForm16,
  type EcrMember, type EsiMember, type BankPayment, type Deductee, type PayslipData,
} from "@keka/documents";
import { loadStatutoryTables, ageAtFyEnd, slabsFor } from "./payroll-run";
import { previousIncomeApplies } from "./finances-math";
import { unverifiedWarnings } from "./payroll-pilot-math";

/**
 * Statutory outputs from finalised payroll: the PF ECR, the ESI contribution
 * file, the salary bank advice, Form 24Q and Form 16, and the payslip PDF.
 * Every builder reads only FINALISED runs — a filing must never be made from
 * a month that can still change.
 */

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

export interface BuiltFile { filename: string; mimeType: string; content: Buffer; issues: string[]; summary: string }

async function finalisedRun(runId: string, tenantId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId, status: "FINALIZED", rolledBackAt: null }, include: { payGroup: true } });
  if (!run) throw new Error("Filings are generated only from a finalised payroll run.");
  return run;
}

const processed = { payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] as Array<"HOLD_SALARY_PROCESSING" | "VOID_SALARY_PROCESSING"> } };

export async function buildPfEcr(runId: string, tenantId: string): Promise<BuiltFile> {
  const run = await finalisedRun(runId, tenantId);
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId, ...processed, pfEmployee: { gt: 0 } },
    include: { employee: { select: { displayName: true, firstName: true, lastName: true, statutoryProfile: { select: { uan: true } } } } },
  });
  const members: EcrMember[] = lines.map((l) => {
    const pfWage = Number(l.pfWage), eps = Number(l.epsEmployer);
    return {
      uan: l.employee.statutoryProfile?.uan ?? "", name: `${l.employee.firstName} ${l.employee.lastName}`,
      grossWages: Number(l.grossEarnings), epfWages: pfWage,
      epsWages: eps > 0 ? Math.min(pfWage, 15000) : 0, edliWages: Math.min(pfWage, 15000),
      epfContribution: Number(l.pfEmployee) + Number(l.vpf), epsContribution: eps, epfEpsDiff: Number(l.pfEmployer),
      ncpDays: Math.round(Number(l.lopDays)),
    };
  });
  const r = pfEcr(members);
  const total = members.reduce((s, m) => s + m.epfContribution + m.epsContribution + m.epfEpsDiff, 0);
  return {
    filename: `PF-ECR-${run.year}-${String(run.month).padStart(2, "0")}.txt`, mimeType: "text/plain", content: Buffer.from(r.content), issues: r.issues,
    summary: `${members.length - r.issues.length} member(s), ₹${Math.round(total).toLocaleString("en-IN")} contributions`,
  };
}

export async function buildEsiFile(runId: string, tenantId: string): Promise<BuiltFile> {
  const run = await finalisedRun(runId, tenantId);
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId, ...processed, esiGross: { gt: 0 } },
    include: { employee: { select: { displayName: true, lastWorkingDay: true, statutoryProfile: { select: { esicNumber: true } } } } },
  });
  const members: EsiMember[] = lines.map((l) => ({
    ipNumber: l.employee.statutoryProfile?.esicNumber ?? "", name: l.employee.displayName ?? "",
    days: Math.round(Number(l.payableDays)), wages: Number(l.esiGross),
    lastWorkingDay: l.employee.lastWorkingDay && l.employee.lastWorkingDay.getUTCMonth() + 1 === run.month ? ddmmyyyy(l.employee.lastWorkingDay) : null,
  }));
  const r = esiContribution(members);
  return {
    filename: `ESI-${run.year}-${String(run.month).padStart(2, "0")}.csv`, mimeType: "text/csv", content: Buffer.from("﻿" + r.content), issues: r.issues,
    summary: members.length ? `${members.length - r.issues.length} insured person(s)` : "No employees within the ESI wage limit this month",
  };
}

/**
 * The whole run's salary transfers. Payout holds are left out; salaries held
 * in earlier runs and released into this one are added. Transfers to bank
 * accounts nobody has verified are kept but flagged.
 */
export async function buildBankAdvice(runId: string, tenantId: string): Promise<BuiltFile> {
  const run = await finalisedRun(runId, tenantId);
  const employee = { select: { displayName: true, workEmail: true, bankAccounts: { where: { isPrimary: true }, take: 1 } } } as const;
  const [lines, released, held] = await Promise.all([
    prisma.payrollRunEmployee.findMany({ where: { runId, ...processed, payAction: { in: ["PROCESS_AS_SALARY"] }, netPay: { gt: 0 } }, include: { employee } }),
    prisma.salaryHold.findMany({ where: { releaseRunId: runId, status: "RELEASED" }, include: { employee } }),
    prisma.salaryHold.count({ where: { runId, status: "HELD" } }),
  ]);
  const narration = `SALARY ${MONTHS[run.month].slice(0, 3).toUpperCase()} ${run.year}`;
  const rows = [
    ...lines.map((l) => ({ e: l.employee, amount: Number(l.netPay), narration })),
    ...released.map((h) => ({ e: h.employee, amount: Number(h.amount), narration: `${narration} HOLD REL` })),
  ];
  const payments: BankPayment[] = rows.map(({ e, amount, narration }) => ({
    name: e.displayName ?? "", accountNumber: e.bankAccounts[0]?.accountNumber ?? "",
    ifsc: (e.bankAccounts[0]?.ifsc ?? "").toUpperCase(), amount, narration, email: e.workEmail,
  }));
  const r = bankAdvice(payments);
  const warnings = unverifiedWarnings(rows.map(({ e }) => ({ name: e.displayName ?? "", accountNumber: e.bankAccounts[0]?.accountNumber ?? null, verified: e.bankAccounts[0]?.isVerified ?? false })));
  return {
    filename: `Bank-Advice-${run.year}-${String(run.month).padStart(2, "0")}.csv`, mimeType: "text/csv", content: Buffer.from("﻿" + r.content), issues: [...r.issues, ...warnings],
    summary: `${payments.length - r.issues.length} transfer(s), ₹${r.total.toLocaleString("en-IN")}${released.length ? ` incl. ${released.length} released hold(s)` : ""}${held ? `; ${held} salary hold(s) left out` : ""}${warnings.length ? `; ${warnings.length} unverified account(s)` : ""}`,
  };
}

/** Quarter 1 is April–June of the financial year. */
export function quarterMonths(fy: number, q: number): Array<{ year: number; month: number }> {
  const start = 4 + (q - 1) * 3;
  return [0, 1, 2].map((i) => { const m = start + i; return m > 12 ? { year: fy + 1, month: m - 12 } : { year: fy, month: m }; });
}

export async function buildForm24q(tenantId: string, fy: number, q: number): Promise<BuiltFile> {
  const months = quarterMonths(fy, q);
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, status: "FINALIZED", rolledBackAt: null, OR: months.map((m) => ({ year: m.year, month: m.month })) },
    include: { payGroup: { select: { payDay: true } } },
  });
  if (runs.length === 0) throw new Error(`No finalised payroll in Q${q} of FY ${fy}-${String(fy + 1).slice(2)}.`);
  const missing = months.filter((m) => !runs.some((r) => r.year === m.year && r.month === m.month));
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, ...processed },
    include: { run: { select: { year: true, month: true, payGroup: { select: { payDay: true } } } }, employee: { select: { displayName: true, identityDocs: { where: { type: "PAN" }, take: 1 } } } },
    orderBy: [{ run: { year: "asc" } }, { run: { month: "asc" } }],
  });
  const deductees: Deductee[] = lines.map((l) => ({
    pan: l.employee.identityDocs[0]?.number ?? null, name: l.employee.displayName ?? "",
    paymentDate: ddmmyyyy(new Date(Date.UTC(l.run.year, l.run.month, l.run.payGroup.payDay || 1))),
    amountPaid: Number(l.grossEarnings), tds: Number(l.tds),
  }));
  const r = form24qAnnexure(deductees, `Q${q}`);
  return {
    filename: `Form24Q-FY${fy}-Q${q}.csv`, mimeType: "text/csv", content: Buffer.from("﻿" + r.content),
    issues: [...r.issues, ...missing.map((m) => `${MONTHS[m.month]} ${m.year} is not finalised and is not included`)],
    summary: `${new Set(lines.map((l) => l.employeeId)).size} employee(s), ₹${r.totals.paid.toLocaleString("en-IN")} paid, ₹${r.totals.tds.toLocaleString("en-IN")} TDS`,
  };
}

/** The data for one payslip PDF, from its finalised run line. */
export async function payslipPdf(payslipId: string): Promise<{ file: BuiltFile; password: string | null; employeeId: string; status: string }> {
  const p = await payslipData(payslipId);
  return {
    file: { filename: `Payslip-${p.employeeNumber}-${p.year}-${String(p.month).padStart(2, "0")}.pdf`, mimeType: "application/pdf", content: renderPayslip(p.data, { password: p.password ?? undefined }), issues: [], summary: p.data.period },
    password: p.password, employeeId: p.employeeId, status: p.status,
  };
}

/** What a payslip shows, assembled from its finalised run line — one page of a PDF. */
export async function payslipData(payslipId: string): Promise<{ data: PayslipData; password: string | null; employeeId: string; employeeNumber: string; status: string; year: number; month: number }> {
  const slip = await prisma.payslip.findUniqueOrThrow({
    where: { id: payslipId },
    include: {
      run: { include: { payGroup: { include: { legalEntity: true } } } },
      employee: {
        include: {
          department: { select: { name: true } }, location: { select: { name: true } }, statutoryProfile: { select: { uan: true } },
          identityDocs: { where: { type: "PAN" }, take: 1 }, bankAccounts: { where: { isPrimary: true }, take: 1 },
        },
      },
    },
  });
  const line = await prisma.payrollRunEmployee.findUniqueOrThrow({ where: { runId_employeeId: { runId: slip.runId, employeeId: slip.employeeId } }, include: { lines: { orderBy: { sequence: "asc" } } } });
  const ytd = await prisma.payrollRunEmployee.aggregate({
    where: { employeeId: slip.employeeId, run: { status: "FINALIZED", rolledBackAt: null, OR: fyFilter(slip.year, slip.month) } },
    _sum: { grossEarnings: true, tds: true, pfEmployee: true },
  });
  const e = slip.employee, acct = e.bankAccounts[0];
  const pan = e.identityDocs[0]?.number?.toUpperCase() ?? null;
  const dim = new Date(Date.UTC(slip.year, slip.month, 0)).getUTCDate();
  const entity = slip.run.payGroup.legalEntity;
  const data: PayslipData = {
    company: { name: entity?.legalName ?? entity?.name ?? "Employer", address: entity ? [entity.city, entity.state].filter(Boolean).join(", ") : null },
    period: `${MONTHS[slip.month]} ${slip.year}`,
    employee: {
      name: e.displayName ?? `${e.firstName} ${e.lastName}`, number: e.employeeNumber, designation: e.jobTitleName,
      department: e.department?.name, location: e.location?.name, joined: ddmmyyyy(e.dateOfJoining), pan,
      uan: e.statutoryProfile?.uan, bank: acct ? `${acct.bankName ?? ""} XXXX${acct.accountNumber.slice(-4)}`.trim() : null,
    },
    days: { inMonth: dim, paid: Number(line.payableDays), lop: Number(line.lopDays) },
    earnings: line.lines.filter((l) => l.type === "EARNING" && l.showOnPayslip).map((l) => ({ name: l.name, full: Number(l.fullAmount), actual: Number(l.amount) })),
    deductions: line.lines.filter((l) => l.type === "DEDUCTION" && Number(l.amount) !== 0).map((l) => ({ name: l.name, amount: Number(l.amount) })),
    employer: line.lines.filter((l) => l.type === "EMPLOYER_CONTRIBUTION" && Number(l.amount) !== 0).map((l) => ({ name: l.name, amount: Number(l.amount) })),
    netPay: Number(line.netPay),
    ytd: { gross: Number(ytd._sum.grossEarnings ?? 0), tds: Number(ytd._sum.tds ?? 0), pf: Number(ytd._sum.pfEmployee ?? 0) },
    note: pan ? undefined : "No PAN is on record, so this payslip is not password protected. Add your PAN to protect future payslips.",
  };
  return { data, password: pan, employeeId: e.id, employeeNumber: e.employeeNumber, status: slip.status, year: slip.year, month: slip.month };
}

/** Runs in the financial year up to and including (year, month). */
function fyFilter(year: number, month: number) {
  const fy = month >= 4 ? year : year - 1;
  return month >= 4
    ? [{ year: fy, month: { gte: 4, lte: month } }]
    : [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: month } }];
}

/** Form 16 Part B for one employee and financial year, from finalised runs. */
export async function form16Pdf(employeeId: string, fy: number): Promise<BuiltFile & { provisional: boolean }> {
  const e = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    include: { statutoryProfile: true, identityDocs: { where: { type: "PAN" }, take: 1 }, payGroup: { include: { legalEntity: true, filingDetail: true } } },
  });
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { employeeId, run: { status: "FINALIZED", rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] } },
    include: { run: { select: { year: true, month: true } } },
  });
  if (lines.length === 0) throw new Error("No finalised salary in this financial year.");
  const gross = lines.reduce((s, l) => s + Number(l.grossEarnings), 0);
  const pt = lines.reduce((s, l) => s + Number(l.professionalTax), 0);
  const tdsPaid = lines.reduce((s, l) => s + Number(l.tds), 0);
  const regime = (e.statutoryProfile?.taxRegime ?? "NEW") as "OLD" | "NEW";
  const tables = e.payGroupId ? await loadStatutoryTables(e.payGroupId, fy, new Date(Date.UTC(fy + 1, 2, 31))) : null;
  const config = tables?.taxConfigs.get(regime);
  const tax = config ? calculateAnnualTax({
    regime, grossSalary: gross, professionalTax: pt,
    previousEmployerIncome: (previousIncomeApplies(e.dateOfJoining, fy) && Number(e.statutoryProfile?.previousEmployerIncome ?? 0)) || undefined,
    slabs: slabsFor(tables!.taxSlabBands.get(regime), ageAtFyEnd(e.dateOfBirth, fy)), config,
  }) : null;
  const now = new Date();
  const provisional = now < new Date(Date.UTC(fy + 1, 3, 1));
  const quarters = [1, 2, 3, 4].map((q) => {
    const ms = quarterMonths(fy, q);
    const ql = lines.filter((l) => ms.some((m) => m.year === l.run.year && m.month === l.run.month));
    return { quarter: `Q${q} (${MONTHS[ms[0].month].slice(0, 3)}–${MONTHS[ms[2].month].slice(0, 3)})`, amountPaid: ql.reduce((s, l) => s + Number(l.grossEarnings), 0), tds: ql.reduce((s, l) => s + Number(l.tds), 0) };
  });
  const rows = [
    { label: "1. Gross salary — s.17(1)", amount: gross, bold: true },
    { label: "2. Less: exemptions under s.10", amount: Number(tax?.exemptions ?? 0), indent: 1 },
    { label: "3. Standard deduction — s.16(ia)", amount: Number(tax?.standardDeduction ?? 0), indent: 1 },
    { label: "4. Professional tax — s.16(iii)", amount: Number(tax?.professionalTaxDeduction ?? 0), indent: 1 },
    { label: "5. Deductions under Chapter VI-A", amount: Number(tax?.chapterViaDeductions ?? 0), indent: 1 },
    { label: "6. Total taxable income", amount: Number(tax?.taxableIncome ?? 0), bold: true },
    { label: "7. Tax on total income", amount: Number(tax?.taxBeforeRebate ?? 0), indent: 1 },
    { label: "8. Rebate under s.87A", amount: Number(tax?.rebate87A ?? 0), indent: 1 },
    { label: "9. Surcharge", amount: Number(tax?.surcharge ?? 0), indent: 1 },
    { label: "10. Health and education cess", amount: Number(tax?.cess ?? 0), indent: 1 },
    { label: "11. Tax payable", amount: Number(tax?.totalTaxLiability ?? 0), bold: true },
    { label: "12. Tax deducted at source", amount: tdsPaid, bold: true },
    { label: tdsPaid >= Number(tax?.totalTaxLiability ?? 0) ? "13. Excess deducted (refundable on filing)" : "13. Balance payable", amount: Math.abs(tdsPaid - Number(tax?.totalTaxLiability ?? 0)), indent: 1 },
  ];
  const pan = e.identityDocs[0]?.number?.toUpperCase() ?? null;
  const entity = e.payGroup?.legalEntity;
  const content = renderForm16({
    company: { name: entity?.legalName ?? entity?.name ?? "Employer", tan: e.payGroup?.filingDetail?.tan ?? null },
    employee: { name: e.displayName ?? `${e.firstName} ${e.lastName}`, pan, designation: e.jobTitleName, number: e.employeeNumber },
    fy: `${fy}-${String(fy + 1).slice(2)}`, assessmentYear: `${fy + 1}-${String(fy + 2).slice(2)}`, regime, rows, quarters, provisional,
  }, { password: pan ?? undefined });
  return {
    filename: `Form16-PartB-${e.employeeNumber}-FY${fy}.pdf`, mimeType: "application/pdf", content,
    issues: [...(pan ? [] : [`${e.displayName}: no PAN — Form 16 cannot be issued without one`]), ...(provisional ? ["Provisional: the financial year is not over"] : [])],
    summary: `Taxable ₹${Math.round(Number(tax?.taxableIncome ?? 0)).toLocaleString("en-IN")}, TDS ₹${Math.round(tdsPaid).toLocaleString("en-IN")}`,
    provisional,
  };
}
