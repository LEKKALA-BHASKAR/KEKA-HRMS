"use server";

import { prisma } from "@keka/db";
import { buildLoanSchedule } from "@keka/payroll";
import {
  submitComponentClaim, withdrawComponentClaim, withdrawLoan, checkLoanEligibility, openPayrollMonthFor, compareMonths,
} from "@keka/services";
import { requireViewer } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import {
  z, parseForm, toErrorState, writeAudit, actionDone, zId, zOptional, zRequiredNumber, zRequiredDate, type ActionState,
} from "@/lib/forms";

/**
 * My Finances actions for the signed-in employee: flexible-benefit claims and
 * loan requests. Every one acts on the viewer's own employee record; ids from
 * the form only pick among records that already belong to them.
 */

const CLAIM_PATHS = ["/finances/pay/component-claims", "/finances/pay", "/inbox"];
const LOAN_PATHS = ["/finances/loans", "/payroll/loans", "/inbox"];

async function me() {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("This login is not linked to an employee record.");
  return { viewer, employeeId: viewer.employee.id };
}

const claimSchema = z.object({
  componentId: zId(),
  amount: zRequiredNumber({ min: 1, max: 10_000_000 }),
  billDate: zRequiredDate(),
  billNumber: zOptional(40),
  note: zOptional(300),
});

export async function submitComponentClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const { viewer, employeeId } = await me();
    const parsed = parseForm(claimSchema, formData);
    if (parsed.state) return parsed.state;
    const d = parsed.data;
    const values = { componentId: d.componentId, amount: String(d.amount), billNumber: d.billNumber ?? "", note: d.note ?? "" };
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Attach the bill.", errors: { file: "Required" }, values };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB.", errors: { file: "Too large" }, values };
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok) return { ok: false, message: sniff.reason, errors: { file: sniff.reason }, values };
    // The component must be one of this employee's claimable ones before anything is stored.
    const component = await prisma.salaryComponent.findFirst({ where: { id: d.componentId, tenantId: viewer.tenantId, type: "REIMBURSEMENT" }, select: { name: true } });
    if (!component) return { ok: false, message: "This component cannot be claimed.", values };
    const stored = await saveFile({
      tenantId: viewer.tenantId, filename: file.name || `Bill-${component.name}.pdf`, mimeType: sniff.mimeType, data,
      relatedType: "ComponentClaim", employeeId, uploadedBy: viewer.user.id,
    });
    const res = await submitComponentClaim({
      employeeId, componentId: d.componentId, amount: d.amount, billDate: d.billDate,
      billNumber: d.billNumber, note: d.note, attachmentUrl: `/files/${stored.id}`,
    });
    if (!res.ok) {
      await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined);
      return { ok: false, message: res.message, errors: res.field ? { [res.field]: res.message } : undefined, values };
    }
    await prisma.storedFile.update({ where: { id: stored.id }, data: { relatedId: res.claimId } });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "CREATE", entityType: "ComponentClaim", entityId: res.claimId,
      summary: `Claimed INR ${d.amount.toLocaleString("en-IN")} against ${component.name}`,
      newValue: { componentId: d.componentId, amount: d.amount, billDate: d.billDate, fileId: stored.id },
    });
    return actionDone(CLAIM_PATHS, res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function withdrawComponentClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const { viewer, employeeId } = await me();
    const claimId = String(formData.get("claimId") ?? "");
    const res = await withdrawComponentClaim(claimId, employeeId);
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "PAYROLL", action: "DELETE", entityType: "ComponentClaim", entityId: claimId, summary: res.summary ?? "Withdrew a claim" });
    return actionDone(CLAIM_PATHS, res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function withdrawLoanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const { viewer, employeeId } = await me();
    const loanId = String(formData.get("loanId") ?? "");
    const res = await withdrawLoan(loanId, employeeId);
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: loanId, summary: res.message });
    return actionDone(LOAN_PATHS, res.message);
  } catch (err) {
    return toErrorState(err);
  }
}

export interface LoanPreview {
  ok: boolean;
  reasons: string[];
  emi: number;
  total: number;
  interest: number;
  maxAmount: number | null;
  maxInstallments: number;
  interestNote: string;
  schedule: Array<{ sequence: number; year: number; month: number; principal: number; interest: number; total: number; balance: number }>;
}

/**
 * The live figures in the Apply New Loan drawer: total repayment, EMI and the
 * schedule for what the employee has typed so far. Nothing is saved.
 */
export async function previewLoanAction(input: { categoryId: string; amount: number; installments: number; start?: string | null }): Promise<LoanPreview> {
  const { viewer, employeeId } = await me();
  const empty: LoanPreview = { ok: false, reasons: [], emi: 0, total: 0, interest: 0, maxAmount: null, maxInstallments: 0, interestNote: "", schedule: [] };
  const cat = await prisma.loanCategory.findFirst({ where: { id: String(input.categoryId ?? ""), tenantId: viewer.tenantId, isActive: true }, select: { id: true } });
  if (!cat) return empty;
  const amount = Math.round(Number(input.amount) || 0), installments = Math.floor(Number(input.installments) || 0);
  const e = await checkLoanEligibility(employeeId, cat.id, amount > 0 ? amount : undefined, installments > 0 ? installments : undefined);
  const base = { ...empty, reasons: e.reasons, maxAmount: e.maxAmount, maxInstallments: e.maxInstallments,
    interestNote: e.interestType === "NONE" || e.interestRate === 0 ? "Interest-free" : `${e.interestRate}% ${e.interestType === "FLAT" ? "flat" : "reducing balance"}` };
  if (!(amount > 0) || !(installments > 0) || installments > 120) return base;
  const m = /^(\d{4})-(\d{2})$/.exec(input.start ?? "");
  const open = await openPayrollMonthFor(employeeId);
  const start = m ? { year: Number(m[1]), month: Number(m[2]) } : open;
  if (compareMonths(start, open) < 0) return { ...base, reasons: [...base.reasons, `EMIs can start from ${open.month}/${open.year} at the earliest.`] };
  const s = buildLoanSchedule({ principal: amount, installments, interestType: e.interestType, annualRate: e.interestRate, startYear: start.year, startMonth: start.month });
  return {
    ...base,
    ok: e.eligible,
    emi: s.emi.toNumber(),
    interest: s.totalInterest.toNumber(),
    total: s.totalRepayable.toNumber(),
    schedule: s.installments.map((i) => ({
      sequence: i.sequence, year: i.year, month: i.month, principal: i.principalPart.toNumber(),
      interest: i.interestPart.toNumber(), total: i.totalAmount.toNumber(), balance: i.balanceAfter.toNumber(),
    })),
  };
}
