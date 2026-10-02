import { prisma } from "@keka/db";
import { bankAdvice, zipFiles, type BankPayment } from "@keka/documents";
import { formatPeriod } from "@keka/shared";
import { payoutState, unverifiedWarnings, type Payable } from "./payroll-pilot-math";
import { payslipPdf, type BuiltFile } from "./filings";

/**
 * Getting a finalised run's money out: per-employee salary holds and their
 * release, payment batches with a paid / failed outcome per transfer,
 * hand-verified bank accounts, payslip release and the payslip bundle.
 *
 * A hold keeps a person's net pay out of every bank file until it is
 * released into a run — the same one, a later regular run or an off-cycle
 * run — whose bank file and batches then carry it. Releasing does not touch
 * any payslip: the pay was taxed and reported in the month it was earned.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${r2(n).toLocaleString("en-IN")}`;
const MONTHS = ["", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

async function finalisedRun(runId: string, tenantId: string) {
  return prisma.payrollRun.findFirst({ where: { id: runId, tenantId, status: "FINALIZED", rolledBackAt: null } });
}

// ---------------------------------------------------------------------------
//  Holds
// ---------------------------------------------------------------------------

/** Lines a run put on payout hold before it was finalised get a hold record. */
export async function recordPayoutHolds(runId: string, byUserId: string | null): Promise<number> {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  const held = await prisma.payrollRunEmployee.findMany({ where: { runId, payAction: "HOLD_PAYOUT", netPay: { gt: 0 } } });
  if (!held.length) return 0;
  const r = await prisma.salaryHold.createMany({
    data: held.map((l) => ({ tenantId: run.tenantId, runId, employeeId: l.employeeId, amount: l.netPay, reason: l.comment, heldBy: byUserId })),
    skipDuplicates: true,
  });
  return r.count;
}

/** Everything the run's bank transfers must cover. */
export async function payablesForRun(runId: string): Promise<Array<Payable & { label: string }>> {
  const [lines, holds] = await Promise.all([
    prisma.payrollRunEmployee.findMany({ where: { runId, payAction: "PROCESS_AS_SALARY", netPay: { gt: 0 } }, select: { employeeId: true, netPay: true } }),
    prisma.salaryHold.findMany({ where: { releaseRunId: runId, status: "RELEASED" }, include: { run: { select: { year: true, month: true } } } }),
  ]);
  return [
    ...lines.map((l) => ({ employeeId: l.employeeId, holdId: null, amount: Number(l.netPay), label: "Net pay" })),
    ...holds.map((h) => ({ employeeId: h.employeeId, holdId: h.id, amount: Number(h.amount), label: `Held salary, ${formatPeriod(h.run.year, h.run.month)}` })),
  ];
}

async function attemptsForRun(runId: string) {
  const items = await prisma.paymentBatchItem.findMany({ where: { batch: { runId } }, include: { batch: { select: { number: true } } } });
  return items.map((i) => ({ employeeId: i.employeeId, holdId: i.salaryHoldId, status: i.status, batchNumber: i.batch.number }));
}

/** Whether a person's pay in this run has gone (or is going) to the bank. */
async function inFlight(runId: string, employeeId: string, holdId: string | null): Promise<boolean> {
  const state = payoutState([{ employeeId, holdId, amount: 0 }], await attemptsForRun(runId));
  return state.pending.length + state.paid.length > 0;
}

export async function holdSalary(input: { tenantId: string; runId: string; employeeId: string; reason: string; byUserId: string }): Promise<Result> {
  const run = await finalisedRun(input.runId, input.tenantId);
  if (!run) return { ok: false, message: "Only a finalised payroll's payout can be held here; before finalising, use the hold on step 5." };
  const line = await prisma.payrollRunEmployee.findUnique({ where: { runId_employeeId: { runId: run.id, employeeId: input.employeeId } } });
  if (!line || line.payAction !== "PROCESS_AS_SALARY" || Number(line.netPay) <= 0) return { ok: false, message: "That person has no salary to pay in this run." };
  if (await inFlight(run.id, input.employeeId, null)) return { ok: false, message: "This salary is already in a payment batch. Mark the transfer failed first if it did not go through." };
  if (!input.reason.trim()) return { ok: false, message: "Say why the salary is held." };
  await prisma.$transaction([
    prisma.salaryHold.create({ data: { tenantId: input.tenantId, runId: run.id, employeeId: input.employeeId, amount: line.netPay, reason: input.reason.trim(), heldBy: input.byUserId } }),
    prisma.payrollRunEmployee.update({ where: { id: line.id }, data: { payAction: "HOLD_PAYOUT", comment: input.reason.trim() } }),
  ]);
  return { ok: true, message: `Held ${rupees(Number(line.netPay))}. It stays out of bank files until released.` };
}

/** Runs a held salary can be released into: this run, or a later one of the same pay group. */
export async function releaseTargets(holdId: string, tenantId: string) {
  const hold = await prisma.salaryHold.findFirst({ where: { id: holdId, tenantId }, include: { run: true } });
  if (!hold) return [];
  return prisma.payrollRun.findMany({
    where: {
      tenantId, payGroupId: hold.run.payGroupId, rolledBackAt: null,
      OR: [{ id: hold.runId }, { periodStart: { gt: hold.run.periodStart } }, { periodStart: hold.run.periodStart, type: "OFF_CYCLE" }],
    },
    orderBy: [{ periodStart: "asc" }, { sequence: "asc" }],
    select: { id: true, year: true, month: true, type: true, sequence: true, status: true },
  });
}

export async function releaseHold(input: { tenantId: string; holdId: string; targetRunId: string; note?: string | null; byUserId: string }): Promise<Result> {
  const hold = await prisma.salaryHold.findFirst({ where: { id: input.holdId, tenantId: input.tenantId } });
  if (!hold) return { ok: false, message: "Hold not found." };
  if (hold.status !== "HELD") return { ok: false, message: "This salary is already released." };
  const targets = await releaseTargets(hold.id, input.tenantId);
  const target = targets.find((t) => t.id === input.targetRunId);
  if (!target) return { ok: false, message: "Release into this run, a later run of the same pay group, or an off-cycle run." };
  await prisma.salaryHold.update({
    where: { id: hold.id },
    data: { status: "RELEASED", releaseRunId: target.id, releasedAt: new Date(), releasedBy: input.byUserId, releaseNote: input.note?.trim() || null },
  });
  const where = target.id === hold.runId ? "this run's" : `the ${formatPeriod(target.year, target.month)}${target.type === "OFF_CYCLE" ? ` off-cycle ${target.sequence}` : ""} run's`;
  return { ok: true, message: `Released ${rupees(Number(hold.amount))} into ${where} bank transfers.${target.status === "FINALIZED" ? "" : " It is paid once that run is finalised."}` };
}

/** Take a release back while the money has not gone to the bank. */
export async function undoRelease(input: { tenantId: string; holdId: string }): Promise<Result> {
  const hold = await prisma.salaryHold.findFirst({ where: { id: input.holdId, tenantId: input.tenantId } });
  if (!hold || hold.status !== "RELEASED" || !hold.releaseRunId) return { ok: false, message: "That salary is not released." };
  if (await inFlight(hold.releaseRunId, hold.employeeId, hold.id)) return { ok: false, message: "It is already in a payment batch." };
  await prisma.salaryHold.update({ where: { id: hold.id }, data: { status: "HELD", releaseRunId: null, releasedAt: null, releasedBy: null, releaseNote: null } });
  return { ok: true, message: "Back on hold." };
}

// ---------------------------------------------------------------------------
//  Payment batches
// ---------------------------------------------------------------------------

export async function runPayoutSummary(runId: string) {
  const payables = await payablesForRun(runId);
  const state = payoutState(payables, await attemptsForRun(runId));
  const sum = (xs: Payable[]) => r2(xs.reduce((s, p) => s + p.amount, 0));
  return {
    payables, state,
    totals: { all: sum(payables), unbatched: sum(state.unbatched), pending: sum(state.pending), paid: sum(state.paid), failed: sum(state.failed) },
  };
}

/**
 * Put payables into a new batch: those never batched (optionally only some
 * people), or those whose last transfer failed. Bank details are copied from
 * each person's primary account as it stands now.
 */
export async function createPaymentBatch(input: { tenantId: string; runId: string; mode: "UNBATCHED" | "FAILED"; employeeIds?: string[]; note?: string | null; byUserId: string }): Promise<Result & { batchId?: string }> {
  const run = await finalisedRun(input.runId, input.tenantId);
  if (!run) return { ok: false, message: "Payment batches are made from a finalised payroll." };
  const { state } = await runPayoutSummary(run.id);
  let pick = input.mode === "FAILED" ? state.failed : state.unbatched;
  if (input.employeeIds?.length) pick = pick.filter((p) => input.employeeIds!.includes(p.employeeId));
  if (pick.length === 0) return { ok: false, message: input.mode === "FAILED" ? "No failed transfers to re-batch." : "Everyone in this run is already in a batch." };
  const accounts = await prisma.employeeBankAccount.findMany({ where: { employeeId: { in: pick.map((p) => p.employeeId) }, isPrimary: true }, orderBy: { updatedAt: "desc" } });
  const accountOf = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) if (!accountOf.has(a.employeeId)) accountOf.set(a.employeeId, a);
  const last = await prisma.paymentBatch.findFirst({ where: { runId: run.id }, orderBy: { number: "desc" } });
  const batch = await prisma.paymentBatch.create({
    data: {
      tenantId: input.tenantId, runId: run.id, number: (last?.number ?? 0) + 1, note: input.note?.trim() || (input.mode === "FAILED" ? "Re-batch of failed transfers" : null), createdBy: input.byUserId,
      items: {
        create: pick.map((p) => {
          const a = accountOf.get(p.employeeId);
          return { employeeId: p.employeeId, salaryHoldId: p.holdId, amount: p.amount, bankName: a?.bankName ?? null, accountNumber: a?.accountNumber ?? null, ifsc: a?.ifsc?.toUpperCase() ?? null, accountVerified: a?.isVerified ?? false };
        }),
      },
    },
  });
  const unverified = pick.filter((p) => !accountOf.get(p.employeeId)?.isVerified).length;
  return {
    ok: true, batchId: batch.id,
    message: `Batch ${batch.number}: ${pick.length} transfer(s), ${rupees(pick.reduce((s, p) => s + p.amount, 0))}.${unverified ? ` ${unverified} to unverified account(s) — check them before upload.` : ""}`,
  };
}

/** Record the bank's outcome for transfers still pending. */
export async function markPaymentItems(input: { tenantId: string; batchId: string; itemIds: string[]; status: "PAID" | "FAILED"; reference?: string | null; failureReason?: string | null; byUserId: string }): Promise<Result> {
  const batch = await prisma.paymentBatch.findFirst({ where: { id: input.batchId, tenantId: input.tenantId } });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (input.status === "FAILED" && !input.failureReason?.trim()) return { ok: false, message: "Give the bank's reason for the failure." };
  const r = await prisma.paymentBatchItem.updateMany({
    where: { batchId: batch.id, id: { in: input.itemIds }, status: "PENDING" },
    data: { status: input.status, reference: input.reference?.trim() || null, failureReason: input.status === "FAILED" ? input.failureReason!.trim() : null, markedAt: new Date(), markedBy: input.byUserId },
  });
  if (r.count === 0) return { ok: false, message: "None of those transfers is pending." };
  const open = await prisma.paymentBatchItem.count({ where: { batchId: batch.id, status: "PENDING" } });
  if (open === 0) await prisma.paymentBatch.update({ where: { id: batch.id }, data: { status: "CLOSED", closedAt: new Date() } });
  return { ok: true, message: `${r.count} transfer(s) marked ${input.status.toLowerCase()}.${open === 0 ? " Batch closed." : ""}` };
}

/** Delete a batch nobody has recorded an outcome against (made by mistake). */
export async function deletePaymentBatch(input: { tenantId: string; batchId: string }): Promise<Result> {
  const batch = await prisma.paymentBatch.findFirst({ where: { id: input.batchId, tenantId: input.tenantId }, include: { items: { select: { status: true } } } });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (batch.items.some((i) => i.status !== "PENDING")) return { ok: false, message: "Outcomes are recorded against this batch; it cannot be deleted." };
  await prisma.paymentBatch.delete({ where: { id: batch.id } });
  return { ok: true, message: `Batch ${batch.number} deleted.` };
}

/** One batch as a bank upload file, warning about unverified accounts. */
export async function buildBatchBankFile(batchId: string, tenantId: string): Promise<BuiltFile> {
  const batch = await prisma.paymentBatch.findFirst({
    where: { id: batchId, tenantId },
    include: { run: true, items: { include: { employee: { select: { displayName: true, firstName: true, lastName: true, workEmail: true } } } } },
  });
  if (!batch) throw new Error("Batch not found.");
  const narration = `SALARY ${MONTHS[batch.run.month]} ${batch.run.year}`;
  const items = batch.items.filter((i) => i.status !== "FAILED");
  const name = (i: (typeof items)[number]) => i.employee.displayName ?? `${i.employee.firstName} ${i.employee.lastName}`;
  const payments: BankPayment[] = items.map((i) => ({ name: name(i), accountNumber: i.accountNumber ?? "", ifsc: i.ifsc ?? "", amount: Number(i.amount), narration: i.salaryHoldId ? `${narration} HOLD REL` : narration, email: i.employee.workEmail }));
  const r = bankAdvice(payments);
  const warnings = unverifiedWarnings(items.map((i) => ({ name: name(i), accountNumber: i.accountNumber, verified: i.accountVerified })));
  return {
    filename: `Bank-${batch.run.year}-${String(batch.run.month).padStart(2, "0")}-batch-${batch.number}.csv`, mimeType: "text/csv",
    content: Buffer.from("﻿" + r.content), issues: [...r.issues, ...warnings],
    summary: `${payments.length - r.issues.length} transfer(s), ${rupees(r.total)}${warnings.length ? `, ${warnings.length} unverified account(s)` : ""}`,
  };
}

export async function setBankAccountVerified(input: { tenantId: string; accountId: string; verified: boolean; byUserId: string }): Promise<Result> {
  const acct = await prisma.employeeBankAccount.findFirst({ where: { id: input.accountId, employee: { tenantId: input.tenantId } }, include: { employee: { select: { displayName: true } } } });
  if (!acct) return { ok: false, message: "Bank account not found." };
  await prisma.employeeBankAccount.update({
    where: { id: acct.id },
    data: input.verified ? { isVerified: true, verifiedAt: new Date(), verifiedBy: input.byUserId } : { isVerified: false, verifiedAt: null, verifiedBy: null },
  });
  return { ok: true, message: `${acct.employee.displayName}'s account XXXX${acct.accountNumber.slice(-4)} ${input.verified ? "marked verified" : "marked unverified"}.` };
}

// ---------------------------------------------------------------------------
//  Payslips
// ---------------------------------------------------------------------------

/** Release one person's payslip to them, or withhold it (status HELD). */
export async function setPayslipRelease(input: { tenantId: string; runId: string; employeeId: string; release: boolean; byUserId: string }): Promise<Result> {
  const run = await finalisedRun(input.runId, input.tenantId);
  if (!run) return { ok: false, message: "Payslips are released from a finalised payroll." };
  const slip = await prisma.payslip.findFirst({ where: { runId: run.id, employeeId: input.employeeId, isSegregated: false } });
  if (!slip) return { ok: false, message: "That person has no payslip in this run." };
  await prisma.payslip.update({
    where: { id: slip.id },
    data: input.release ? { status: "RELEASED", releasedAt: new Date(), releasedBy: input.byUserId, heldAt: null } : { status: "HELD", heldAt: new Date(), releasedAt: null, releasedBy: null },
  });
  return { ok: true, message: input.release ? "Payslip released to the employee." : "Payslip withheld; the employee cannot see it until it is released." };
}

/** Every payslip of a run (or of the given people) as one ZIP of PDFs. */
export async function payslipZip(runId: string, tenantId: string, employeeIds?: string[]): Promise<BuiltFile & { count: number }> {
  const run = await finalisedRun(runId, tenantId);
  if (!run) throw new Error("Payslips are bundled from a finalised payroll.");
  const slips = await prisma.payslip.findMany({
    where: { runId, isSegregated: false, ...(employeeIds ? { employeeId: { in: employeeIds } } : {}) },
    orderBy: { employee: { employeeNumber: "asc" } }, select: { id: true },
  });
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const issues: string[] = [];
  for (const s of slips) {
    const { file, password } = await payslipPdf(s.id);
    files.push({ name: file.filename, data: file.content });
    if (!password) issues.push(`${file.filename}: no PAN on record, so the PDF is not password protected`);
  }
  const label = `${run.year}-${String(run.month).padStart(2, "0")}${run.type === "OFF_CYCLE" ? `-offcycle-${run.sequence}` : ""}`;
  return { filename: `Payslips-${label}.zip`, mimeType: "application/zip", content: zipFiles(files), issues, summary: `${files.length} payslip(s)`, count: files.length };
}

