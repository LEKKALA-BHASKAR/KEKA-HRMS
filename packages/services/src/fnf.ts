import { prisma, Prisma } from "@keka/db";
import { renderFnfStatement, type FnfStatementData } from "@keka/documents";
import type { SettlementLine } from "./lifecycle";
import {
  periodLabel, validateSettlementMonth, voidBlocker, voidPlan, validateAdjustment, adjustmentStatus, adjustmentsNet, isSettled,
  type FnfEffects, type FnfReportRow,
} from "./fnf-math";

/**
 * Full and final, after the computation: the settlement statement (PDF, to
 * download or email), choosing the month it is booked in, voiding a
 * finalised settlement and undoing what finalising did, one-off adjustments
 * made after it (paid or recovered through a later payroll), and the
 * settlements report.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const rupees = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN")}`;
export const FNF_ADJUSTMENT_SOURCE = "FnfSettlement";

async function settlementOf(employeeId: string, tenantId: string) {
  return prisma.fnfSettlement.findFirst({
    where: { employeeId, employee: { tenantId } },
    include: {
      employee: {
        include: {
          exitRecord: true, department: { select: { name: true } }, identityDocs: { where: { type: "PAN" }, take: 1 },
          payGroup: { include: { legalEntity: true } }, user: { select: { email: true } },
        },
      },
    },
  });
}

/** Adjustments raised against a settlement, with the payroll they are on. */
export async function fnfAdjustments(settlementId: string) {
  const list = await prisma.adhocTransaction.findMany({ where: { sourceType: FNF_ADJUSTMENT_SOURCE, sourceId: settlementId }, orderBy: { createdAt: "asc" } });
  const runs = await prisma.payrollRun.findMany({ where: { id: { in: list.map((a) => a.runId).filter((x): x is string => !!x) } }, select: { id: true, type: true, status: true, year: true, month: true } });
  return list.map((a) => {
    const run = runs.find((r) => r.id === a.runId) ?? null;
    return {
      id: a.id, type: a.type as "PAYMENT" | "DEDUCTION", name: a.name, amount: Number(a.amount), taxable: a.taxTreatment !== "NON_TAXABLE",
      year: a.year, month: a.month, isProcessed: a.isProcessed, runId: a.runId, run, comment: a.comment, createdAt: a.createdAt,
      status: adjustmentStatus({ isProcessed: a.isProcessed, run, year: a.year, month: a.month }),
    };
  });
}

// ---------------------------------------------------------------------------
//  Statement
// ---------------------------------------------------------------------------

export async function fnfStatementData(employeeId: string, tenantId: string): Promise<{ data: FnfStatementData; settlementId: string; filename: string; status: string; email: string | null }> {
  const s = await settlementOf(employeeId, tenantId);
  if (!s) throw new Error("There is no settlement for this employee yet.");
  const e = s.employee, exit = e.exitRecord;
  if (!exit) throw new Error("There is no exit for this employee.");
  const breakdown = (s.breakdown ?? {}) as { lines?: SettlementLine[]; notes?: string[] };
  const lines = breakdown.lines ?? [];
  const adjustments = await fnfAdjustments(s.id);
  const entity = e.payGroup?.legalEntity;
  const months = Math.floor((exit.lastWorkingDay.getTime() - e.dateOfJoining.getTime()) / (30.44 * 86_400_000));
  const status = s.status === "VOIDED" ? "VOIDED" : isSettled(s.status) ? "FINALISED" : "DRAFT — FOR REVIEW, NOT FINAL";
  const period = s.settlementYear && s.settlementMonth ? periodLabel(s.settlementYear, s.settlementMonth) : periodLabel(exit.lastWorkingDay.getUTCFullYear(), exit.lastWorkingDay.getUTCMonth() + 1);
  const data: FnfStatementData = {
    company: { name: entity?.legalName ?? entity?.name ?? "Employer", address: entity ? [entity.city, entity.state].filter(Boolean).join(", ") : null },
    status, settlementPeriod: period, generatedOn: ddmmyyyy(new Date()),
    employee: {
      name: e.displayName ?? `${e.firstName} ${e.lastName}`, number: e.employeeNumber, designation: e.jobTitleName, department: e.department?.name,
      joined: ddmmyyyy(e.dateOfJoining), lastWorkingDay: ddmmyyyy(exit.lastWorkingDay), exitType: exit.type.replace(/_/g, " ").toLowerCase(),
      pan: e.identityDocs[0]?.number?.toUpperCase() ?? null, service: `${Math.floor(months / 12)} yr ${months % 12} mo`,
    },
    payable: lines.filter((l) => l.direction === "PAY").map((l) => ({ group: l.group, label: l.label, amount: l.amount, basis: l.basis })),
    recovered: lines.filter((l) => l.direction === "RECOVER").map((l) => ({ group: l.group, label: l.label, amount: l.amount, basis: l.basis })),
    totalPayable: Number(s.totalPayable), totalRecovery: Number(s.totalRecovery), net: Number(s.netSettlement),
    adjustments: adjustments.map((a) => ({ label: a.name, amount: a.amount, direction: a.type === "PAYMENT" ? "PAY" : "RECOVER", status: a.isProcessed ? "paid" : "pending" })),
    notes: breakdown.notes ?? [],
    voided: s.status === "VOIDED" && s.voidedAt ? { on: ddmmyyyy(s.voidedAt), reason: s.voidReason ?? "" } : null,
  };
  return {
    data, settlementId: s.id, status: s.status,
    filename: `FnF-Statement-${e.employeeNumber}-${(s.settlementYear ?? exit.lastWorkingDay.getUTCFullYear())}-${String(s.settlementMonth ?? exit.lastWorkingDay.getUTCMonth() + 1).padStart(2, "0")}.pdf`,
    // An exited employee cannot sign in, so the statement goes to a personal address first.
    email: e.personalEmail ?? e.workEmail ?? e.user?.email ?? null,
  };
}

export async function fnfStatementPdf(employeeId: string, tenantId: string) {
  const d = await fnfStatementData(employeeId, tenantId);
  return { ...d, content: renderFnfStatement(d.data), mimeType: "application/pdf" };
}

/** Queue the statement to the employee, with the stored PDF attached. */
export async function queueFnfStatementEmail(input: { tenantId: string; settlementId: string; to: string; employeeName: string; period: string; fileId: string; net: number }): Promise<void> {
  await prisma.emailOutbox.create({
    data: {
      tenantId: input.tenantId, toAddress: input.to, subject: `Your full and final settlement statement — ${input.period}`,
      textBody: `Dear ${input.employeeName},\n\nYour full and final settlement statement for ${input.period} is attached. ` +
        `Net ${input.net >= 0 ? "payable to you" : "recoverable from you"}: ${rupees(input.net)}.\n\n` +
        `If anything in it looks wrong, reply to HR before the payment date.\n`,
      relatedType: "FnfSettlement", relatedId: input.settlementId, attachmentFileIds: [input.fileId],
    },
  });
  await prisma.fnfSettlement.update({ where: { id: input.settlementId }, data: { statementUrl: `/files/${input.fileId}` } });
}

// ---------------------------------------------------------------------------
//  Settlement month
// ---------------------------------------------------------------------------

export async function setSettlementMonth(input: { employeeId: string; tenantId: string; year: number; month: number }): Promise<Result> {
  const s = await settlementOf(input.employeeId, input.tenantId);
  if (!s || !s.employee.exitRecord) return { ok: false, message: "Draft the settlement first." };
  if (isSettled(s.status)) return { ok: false, message: "A finalised settlement keeps its month. Void it to change it." };
  const bad = validateSettlementMonth(s.employee.exitRecord.lastWorkingDay, input.year, input.month);
  if (bad) return { ok: false, message: bad };
  await prisma.fnfSettlement.update({ where: { id: s.id }, data: { settlementYear: input.year, settlementMonth: input.month } });
  return { ok: true, message: `Settlement booked in ${periodLabel(input.year, input.month)}.` };
}

// ---------------------------------------------------------------------------
//  Void
// ---------------------------------------------------------------------------

/**
 * Void a finalised settlement: put back what finalising changed (loans,
 * recoveries, bonuses, claims, the exit and the employee's status), take it
 * out of the ledger, drop adjustments not yet paid, and reopen the exit so a
 * fresh settlement can be drafted. Sign-in stays disabled: the person has
 * still left.
 */
export async function voidSettlement(input: { employeeId: string; tenantId: string; byUserId: string; reason: string }): Promise<Result> {
  const s = await settlementOf(input.employeeId, input.tenantId);
  if (!s) return { ok: false, message: "There is no settlement for this employee." };
  const adjustments = await fnfAdjustments(s.id);
  const blocker = voidBlocker({ status: s.status, reason: input.reason, processedAdjustments: adjustments.filter((a) => a.isProcessed).length });
  if (blocker) return { ok: false, message: blocker };
  const plan = voidPlan((s.breakdown as { effects?: FnfEffects } | null)?.effects);
  const reason = input.reason.trim();
  const touchedRuns = [...new Set(adjustments.filter((a) => a.run && a.run.type === "OFF_CYCLE" && a.run.status !== "FINALIZED").map((a) => a.runId!))];

  await prisma.$transaction(async (tx) => {
    for (const i of plan.installments) {
      await tx.loanInstallment.updateMany({ where: { id: i.id, status: "PREPAID" }, data: { status: "SCHEDULED", interestPart: i.interestPart, totalAmount: i.totalAmount, deductedAt: null } });
    }
    for (const l of plan.loans) {
      await tx.loan.updateMany({ where: { id: l.id, status: "FORECLOSED" }, data: { status: l.status as never, closedAt: null } });
    }
    if (plan.assetAssignmentIds.length) await tx.assetAssignment.updateMany({ where: { id: { in: plan.assetAssignmentIds } }, data: { chargeRecovered: false } });
    // Only those the settlement itself closed, not ones a payroll since paid.
    if (plan.bonusIds.length) await tx.employeeBonus.updateMany({ where: { id: { in: plan.bonusIds }, runId: null }, data: { isProcessed: false } });
    if (plan.claimIds.length) await tx.componentClaim.updateMany({ where: { id: { in: plan.claimIds }, status: "PAID", runId: null }, data: { status: "APPROVED" } });
    await tx.adhocTransaction.deleteMany({ where: { sourceType: FNF_ADJUSTMENT_SOURCE, sourceId: s.id, isProcessed: false } });
    if (s.employee.exitRecord) await tx.exitRecord.update({ where: { id: s.employee.exitRecord.id }, data: { status: plan.exitStatus as never } });
    await tx.employee.update({ where: { id: s.employeeId }, data: { status: plan.employeeStatus as never } });
    // The settlement task reopens, and with it the exit journey.
    const journeys = await tx.journey.findMany({ where: { employeeId: s.employeeId, trigger: "EXIT", status: { in: ["ACTIVE", "COMPLETED"] } }, select: { id: true } });
    for (const j of journeys) {
      const reopened = await tx.journeyTask.updateMany({ where: { journeyId: j.id, autoCheck: "FNF_SETTLED", status: "DONE" }, data: { status: "PENDING", completedAt: null, completedBy: null, note: `Reopened: settlement voided — ${reason}` } });
      if (reopened.count) await tx.journey.updateMany({ where: { id: j.id, status: "COMPLETED" }, data: { status: "ACTIVE", completedAt: null } });
    }
    await tx.fnfSettlement.update({
      where: { id: s.id },
      data: { status: "VOIDED", voidedAt: new Date(), voidedBy: input.byUserId, voidReason: reason, statementUrl: null },
    });
  });
  const { syncLoanBalance } = await import("./loans");
  for (const l of plan.loans) await syncLoanBalance(l.id);
  const { calculateOffCycleRun } = await import("./off-cycle");
  for (const runId of touchedRuns) await calculateOffCycleRun(runId).catch(() => undefined);
  const { reverseEntry } = await import("./accounting");
  const entries = await prisma.ledgerEntry.findMany({ where: { tenantId: input.tenantId, sourceRefType: "FnfSettlement", sourceRefId: s.id, status: "POSTED" } });
  for (const en of entries) await reverseEntry({ tenantId: input.tenantId, entryId: en.id, reason: `Settlement voided: ${reason}`, byUserId: input.byUserId });
  const dropped = adjustments.filter((a) => !a.isProcessed).length;
  return {
    ok: true,
    message: `Settlement voided.${entries.length ? ` ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"} reversed.` : ""}${dropped ? ` ${dropped} pending adjustment(s) removed.` : ""}` +
      (plan.partial ? " It was finalised before effects were recorded, so loans and recoveries were left as they are — check them before redrafting." : " Loans, recoveries and claims are back as they were.") +
      " Sign-in stays disabled. Recompute to draft a fresh settlement.",
  };
}

// ---------------------------------------------------------------------------
//  Adjustments after F&F
// ---------------------------------------------------------------------------

/**
 * A one-off payment or recovery after the settlement is final — a late
 * reimbursement, a missed incentive, a recovery found later. It is an ad-hoc
 * item tied to the settlement: either put straight onto an open payroll the
 * employee is in, or left for the given month's payroll / a later off-cycle.
 */
export async function addFnfAdjustment(input: {
  employeeId: string; tenantId: string; byUserId: string;
  type: "PAYMENT" | "DEDUCTION"; name: string; amount: number; taxable: boolean; comment?: string | null;
  runId?: string | null; year?: number; month?: number;
}): Promise<Result & { adjustmentId?: string }> {
  const s = await settlementOf(input.employeeId, input.tenantId);
  if (!s || !isSettled(s.status)) return { ok: false, message: "Adjustments are made only after the settlement is finalised." };
  const bad = validateAdjustment(input);
  if (bad) return { ok: false, message: bad };
  let target: { year: number; month: number; runId: string | null; offCycle: boolean };
  if (input.runId) {
    const t = await openRunFor(input.runId, input.tenantId, input.employeeId);
    if ("error" in t) return { ok: false, message: t.error };
    target = t;
  } else {
    const year = input.year ?? s.settlementYear ?? new Date().getUTCFullYear();
    const month = input.month ?? s.settlementMonth ?? new Date().getUTCMonth() + 1;
    if (!(month >= 1 && month <= 12)) return { ok: false, message: "Choose the payroll month." };
    target = { year, month, runId: null, offCycle: false };
  }
  const a = await prisma.adhocTransaction.create({
    data: {
      employeeId: input.employeeId, type: input.type, name: input.name.trim(), amount: r2(input.amount),
      taxTreatment: input.taxable ? "TAXABLE" : "NON_TAXABLE", year: target.year, month: target.month, runId: target.runId,
      comment: input.comment?.trim() || "After full and final settlement", sourceType: FNF_ADJUSTMENT_SOURCE, sourceId: s.id, createdBy: input.byUserId,
    },
  });
  if (target.offCycle && target.runId) {
    const { calculateOffCycleRun } = await import("./off-cycle");
    await calculateOffCycleRun(target.runId);
  }
  return {
    ok: true, adjustmentId: a.id,
    message: `${input.type === "PAYMENT" ? "Payment" : "Recovery"} of ${rupees(input.amount)} added ${target.runId ? (target.offCycle ? "to the off-cycle payroll" : `to the ${periodLabel(target.year, target.month)} payroll — recalculate it to include this`) : `for ${periodLabel(target.year, target.month)}; add it to an off-cycle payroll to pay it`}.`,
  };
}

async function openRunFor(runId: string, tenantId: string, employeeId: string): Promise<{ year: number; month: number; runId: string; offCycle: boolean } | { error: string }> {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) return { error: "Payroll not found." };
  if (run.status === "FINALIZED" || run.lockedAt) return { error: "That payroll is finalised or locked." };
  if (!(await prisma.payrollRunEmployee.count({ where: { runId, employeeId } }))) {
    return { error: run.type === "OFF_CYCLE" ? "The employee is not in that off-cycle payroll." : "The employee is not in that month's payroll; use an off-cycle payroll." };
  }
  return { year: run.year, month: run.month, runId: run.id, offCycle: run.type === "OFF_CYCLE" };
}

/** Put a pending adjustment onto an open payroll the employee is in. */
export async function attachFnfAdjustment(input: { adjustmentId: string; tenantId: string; runId: string }): Promise<Result> {
  const a = await prisma.adhocTransaction.findFirst({ where: { id: input.adjustmentId, sourceType: FNF_ADJUSTMENT_SOURCE, employee: { tenantId: input.tenantId } } });
  if (!a) return { ok: false, message: "Adjustment not found." };
  if (a.isProcessed) return { ok: false, message: "That adjustment has already been paid." };
  const t = await openRunFor(input.runId, input.tenantId, a.employeeId);
  if ("error" in t) return { ok: false, message: t.error };
  const previous = a.runId;
  await prisma.adhocTransaction.update({ where: { id: a.id }, data: { runId: t.runId, year: t.year, month: t.month } });
  const { calculateOffCycleRun } = await import("./off-cycle");
  if (t.offCycle) await calculateOffCycleRun(t.runId);
  if (previous && previous !== t.runId) {
    const prev = await prisma.payrollRun.findUnique({ where: { id: previous }, select: { type: true, status: true } });
    if (prev?.type === "OFF_CYCLE" && prev.status !== "FINALIZED") await calculateOffCycleRun(previous).catch(() => undefined);
  }
  return { ok: true, message: t.offCycle ? "Added to the off-cycle payroll." : `Added to the ${periodLabel(t.year, t.month)} payroll; recalculate it to include this.` };
}

export async function removeFnfAdjustment(input: { adjustmentId: string; tenantId: string }): Promise<Result> {
  const a = await prisma.adhocTransaction.findFirst({ where: { id: input.adjustmentId, sourceType: FNF_ADJUSTMENT_SOURCE, employee: { tenantId: input.tenantId } } });
  if (!a) return { ok: false, message: "Adjustment not found." };
  if (a.isProcessed) return { ok: false, message: "That adjustment has been paid; roll back its payroll to remove it." };
  await prisma.adhocTransaction.delete({ where: { id: a.id } });
  if (a.runId) {
    const run = await prisma.payrollRun.findUnique({ where: { id: a.runId }, select: { type: true, status: true } });
    if (run?.type === "OFF_CYCLE" && run.status !== "FINALIZED") {
      const { calculateOffCycleRun } = await import("./off-cycle");
      await calculateOffCycleRun(a.runId).catch(() => undefined);
    }
  }
  return { ok: true, message: "Adjustment removed." };
}

/** Open payrolls an adjustment for this employee can go onto. */
export async function adjustmentTargets(employeeId: string, tenantId: string) {
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { employeeId, run: { tenantId, status: { not: "FINALIZED" }, lockedAt: null } },
    select: { run: { select: { id: true, type: true, year: true, month: true, sequence: true } } },
  });
  return lines.map((l) => ({ id: l.run.id, label: `${l.run.type === "OFF_CYCLE" ? `Off-cycle ${l.run.sequence}` : "Regular"} · ${periodLabel(l.run.year, l.run.month)}` }));
}

// ---------------------------------------------------------------------------
//  Report
// ---------------------------------------------------------------------------

export interface FnfReportEntry extends FnfReportRow {
  settlementId: string;
  employeeId: string;
  employeeNumber: string;
  name: string;
  department: string | null;
  exitId: string | null;
  exitType: string | null;
  lastWorkingDay: Date | null;
  settlementPeriod: string | null;
  settlementYear: number | null;
  settlementMonth: number | null;
  finalizedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  gratuity: number;
  leaveEncashment: number;
  tds: number;
  adjustmentsCount: number;
}

/**
 * Every settlement in scope, newest last working day first, filtered by
 * status and by the financial year of the settlement month.
 */
export async function fnfReport(tenantId: string, opts: { employeeWhere?: Prisma.EmployeeWhereInput; status?: string | null; fy?: number | null } = {}): Promise<FnfReportEntry[]> {
  const fyWhere: Prisma.FnfSettlementWhereInput = opts.fy
    ? { OR: [{ settlementYear: opts.fy, settlementMonth: { gte: 4 } }, { settlementYear: opts.fy + 1, settlementMonth: { lte: 3 } }] }
    : {};
  const list = await prisma.fnfSettlement.findMany({
    where: { employee: { tenantId, ...(opts.employeeWhere ?? {}) }, ...(opts.status ? { status: opts.status as never } : {}), ...fyWhere },
    include: { employee: { select: { id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true, department: { select: { name: true } }, exitRecord: { select: { id: true, type: true, lastWorkingDay: true } } } } },
  });
  const adj = await prisma.adhocTransaction.findMany({ where: { sourceType: FNF_ADJUSTMENT_SOURCE, sourceId: { in: list.map((s) => s.id) } }, select: { sourceId: true, type: true, amount: true, isProcessed: true } });
  return list.map((s): FnfReportEntry => {
    const mine = adj.filter((a) => a.sourceId === s.id).map((a) => ({ type: a.type as "PAYMENT" | "DEDUCTION", amount: Number(a.amount), isProcessed: a.isProcessed }));
    const x = s.employee.exitRecord;
    return {
      settlementId: s.id, employeeId: s.employee.id, employeeNumber: s.employee.employeeNumber, name: s.employee.displayName ?? `${s.employee.firstName} ${s.employee.lastName}`,
      department: s.employee.department?.name ?? null, exitId: x?.id ?? null, exitType: x?.type ?? null, lastWorkingDay: x?.lastWorkingDay ?? null,
      settlementYear: s.settlementYear, settlementMonth: s.settlementMonth,
      settlementPeriod: s.settlementYear && s.settlementMonth ? periodLabel(s.settlementYear, s.settlementMonth) : null,
      status: s.status, totalPayable: Number(s.totalPayable), totalRecovery: Number(s.totalRecovery), net: Number(s.netSettlement),
      gratuity: Number(s.gratuity), leaveEncashment: Number(s.leaveEncashment), tds: Number(s.tdsDeduction),
      adjustmentsNet: adjustmentsNet(mine), adjustmentsCount: mine.length,
      finalizedAt: s.finalizedAt, voidedAt: s.voidedAt, voidReason: s.voidReason,
    };
  }).sort((a, b) => (b.lastWorkingDay?.getTime() ?? 0) - (a.lastWorkingDay?.getTime() ?? 0));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function fnfReportCsv(rows: FnfReportEntry[]): string {
  const head = ["Employee no.", "Name", "Department", "Exit type", "Last working day", "Settlement month", "Status", "Total payable", "Total recovery", "Net settlement", "Gratuity", "Leave encashment", "TDS", "Adjustments (net)", "Finalised on", "Voided on", "Void reason"];
  const body = rows.map((r) => [r.employeeNumber, r.name, r.department, r.exitType, r.lastWorkingDay, r.settlementPeriod, r.status, r.totalPayable.toFixed(2), r.totalRecovery.toFixed(2), r.net.toFixed(2), r.gratuity.toFixed(2), r.leaveEncashment.toFixed(2), r.tds.toFixed(2), r.adjustmentsNet.toFixed(2), r.finalizedAt, r.voidedAt, r.voidReason]);
  return "﻿" + [head, ...body].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
