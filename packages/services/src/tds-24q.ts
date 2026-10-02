import { prisma } from "@keka/db";
import { challanIssues, form24qStatement, type ChallanRow, type DeducteeRow } from "./payroll-pilot-math";
import { quarterMonths, type BuiltFile } from "./filings";

/**
 * Salary TDS deposits (challans) and the quarterly Form 24Q statement built
 * from them and from finalised payroll.
 *
 * The export is a structured CSV, NOT an NSDL FVU input file. The FVU text
 * layout (FH / BH / CD / DD / SD records, caret-delimited, with dozens of
 * positional fields per record) is published by Protean as a versioned
 * specification that is not available to this code, and a file that merely
 * looks like it would be rejected by the File Validation Utility — or worse,
 * accepted with fields in the wrong places. So the CSV carries the same data
 * (deductor, challans, deductee rows booked against challans) for keying into
 * the NSDL Return Preparation Utility, whose output must then be validated
 * with the official FVU before upload.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ChallanInput {
  tenantId: string; payGroupId: string | null; year: number; month: number;
  bsrCode: string; challanNumber: string; paymentDate: Date;
  tdsAmount: number; surcharge?: number; cess?: number; interest?: number; fee?: number;
  minorHeadCode?: string | null; bankName?: string | null; byUserId: string;
}

export async function recordTdsChallan(input: ChallanInput): Promise<Result & { id?: string }> {
  const bsrCode = input.bsrCode.trim(), challanNumber = input.challanNumber.trim();
  const problems = challanIssues({ bsrCode, challanNumber, tdsAmount: input.tdsAmount });
  if (!(input.month >= 1 && input.month <= 12)) problems.push("Choose the salary month the deposit covers");
  if (Number.isNaN(input.paymentDate.getTime())) problems.push("Enter the date of deposit");
  if (problems.length) return { ok: false, message: problems.join("; ") + "." };
  if (input.payGroupId && !(await prisma.payGroup.count({ where: { id: input.payGroupId, tenantId: input.tenantId } }))) return { ok: false, message: "Pay group not found." };
  // The same counterfoil cannot be keyed twice: BSR, date and serial identify it.
  const dup = await prisma.tdsChallan.findFirst({ where: { tenantId: input.tenantId, bsrCode, challanNumber, paymentDate: input.paymentDate } });
  if (dup) return { ok: false, message: "That challan (BSR code, date and serial) is already recorded." };
  const c = await prisma.tdsChallan.create({
    data: {
      tenantId: input.tenantId, payGroupId: input.payGroupId, year: input.year, month: input.month, createdBy: input.byUserId,
      minorHeadCode: input.minorHeadCode ?? "200", challanNumber, bsrCode, bankName: input.bankName ?? null,
      deductionDate: new Date(Date.UTC(input.year, input.month, 0)), paymentDate: input.paymentDate,
      tdsAmount: r2(input.tdsAmount), surcharge: r2(input.surcharge ?? 0), cess: r2(input.cess ?? 0), interest: r2(input.interest ?? 0), fee: r2(input.fee ?? 0),
    },
  });
  return { ok: true, id: c.id, message: `Challan ${challanNumber} recorded.` };
}

export async function deleteTdsChallan(tenantId: string, id: string): Promise<Result> {
  const c = await prisma.tdsChallan.findFirst({ where: { id, tenantId }, include: { filing: { select: { status: true } } } });
  if (!c) return { ok: false, message: "Challan not found." };
  if (c.filing && ["FILED", "ACKNOWLEDGED"].includes(c.filing.status)) return { ok: false, message: "This challan is in a filed return; correct it with a revised return." };
  await prisma.tdsChallan.delete({ where: { id } });
  return { ok: true, message: "Challan removed." };
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The quarter's deductee rows and challans, reconciled. */
export async function form24qQuarter(tenantId: string, fy: number, q: number) {
  const months = quarterMonths(fy, q);
  const inQuarter = months.map((m) => ({ year: m.year, month: m.month }));
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, status: "FINALIZED", rolledBackAt: null, OR: inQuarter },
    include: { payGroup: { select: { payDay: true, filingDetail: true, legalEntity: { select: { legalName: true } } } } },
  });
  const lines = runs.length ? await prisma.payrollRunEmployee.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, payAction: { notIn: ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"] }, grossEarnings: { gt: 0 } },
    include: { employee: { select: { employeeNumber: true, displayName: true, firstName: true, lastName: true, identityDocs: { where: { type: "PAN" }, take: 1 } } } },
  }) : [];
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const deductees: DeducteeRow[] = lines.map((l) => {
    const r = runOf.get(l.runId)!;
    return {
      employeeId: l.employeeId, employeeNumber: l.employee.employeeNumber, name: l.employee.displayName ?? `${l.employee.firstName} ${l.employee.lastName}`,
      pan: l.employee.identityDocs[0]?.number ?? null, year: r.year, month: r.month,
      // Salary is credited on the pay date; regular runs default to the pay day of the next month.
      paymentDate: r.payDate ?? new Date(Date.UTC(r.year, r.month, r.payGroup.payDay || 1)),
      amountPaid: Number(l.grossEarnings), tds: Number(l.tds),
    };
  }).sort((a, b) => a.year - b.year || a.month - b.month || a.employeeNumber.localeCompare(b.employeeNumber));
  const challanRows = await prisma.tdsChallan.findMany({ where: { tenantId, OR: inQuarter }, orderBy: [{ year: "asc" }, { month: "asc" }, { paymentDate: "asc" }] });
  const challans: ChallanRow[] = challanRows.map((c) => ({
    id: c.id, year: c.year!, month: c.month!, bsrCode: c.bsrCode, challanNumber: c.challanNumber, paymentDate: c.paymentDate,
    tdsAmount: Number(c.tdsAmount), surcharge: Number(c.surcharge), cess: Number(c.cess), interest: Number(c.interest), fee: Number(c.fee),
  }));
  const statement = form24qStatement(deductees, challans);
  const missing = months.filter((m) => !runs.some((r) => r.type === "REGULAR" && r.year === m.year && r.month === m.month));
  const deductor = runs[0]?.payGroup ?? (await prisma.payGroup.findFirst({ where: { tenantId }, include: { filingDetail: true, legalEntity: { select: { legalName: true } } } }));
  const filing = deductor?.filingDetail ?? null;
  const issues = [
    ...missing.map((m) => `${MONTHS[m.month]} ${m.year} payroll is not finalised and is not included`),
    ...(filing?.tan ? [] : ["No TAN in the pay group's filing details"]),
    ...statement.issues,
  ];
  return { months, runs, challans: challanRows, statement, issues, deductor: { name: deductor?.legalEntity?.legalName ?? null, tan: filing?.tan ?? null, pan: filing?.pan ?? null, responsible: filing?.responsiblePersonName ?? null } };
}

export async function buildForm24qStatement(tenantId: string, fy: number, q: number): Promise<BuiltFile> {
  const d = await form24qQuarter(tenantId, fy, q);
  if (d.runs.length === 0 && d.challans.length === 0) throw new Error(`No finalised payroll or challans in Q${q} of FY ${fy}-${String(fy + 1).slice(2)}.`);
  const head = [
    "Record,TAN,PAN of deductor,Deductor,Financial year,Quarter,Form,Note",
    ["DEDUCTOR", d.deductor.tan ?? "", d.deductor.pan ?? "", `"${(d.deductor.name ?? "").replace(/"/g, '""')}"`, `${fy}-${String(fy + 1).slice(2)}`, `Q${q}`, "24Q",
      "Structured data for the NSDL RPU - not an FVU file. Validate the prepared return with the official FVU before upload."].join(","),
    "",
  ].join("\r\n");
  const deducted = r2(d.statement.months.reduce((s, m) => s + m.deducted, 0));
  const deposited = r2(d.statement.months.reduce((s, m) => s + m.deposited, 0));
  return {
    filename: `Form24Q-FY${fy}-Q${q}-statement.csv`, mimeType: "text/csv", content: Buffer.from("﻿" + head + "\r\n" + d.statement.csv), issues: d.issues,
    summary: `${new Set(d.statement.allocations.map((a) => a.employeeId)).size} deductee(s), ${d.challans.length} challan(s), TDS ₹${deducted.toLocaleString("en-IN")} deducted / ₹${deposited.toLocaleString("en-IN")} deposited`,
  };
}
