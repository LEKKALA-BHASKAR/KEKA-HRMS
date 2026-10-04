"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { updateLoanRequest, planTranches, releaseTranche, adminLoanAdjustment, requestLoanAdjustment, runLoanOverdueAlerts, type LoanAdjustmentKind } from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { storeUpload } from "@/lib/money";
import { z, parseForm, toErrorState, writeAudit, actionDone as done, zOptional, zNumber, zRequiredNumber, zRequiredDate, zId, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const paths = (loanId?: string) => ["/payroll/loans", "/payroll/loans/portfolio", "/finances/loans", "/inbox", ...(loanId ? [`/payroll/loans/${loanId}`, `/finances/loans/${loanId}`] : [])];

const zMonth = () => z.string().optional().transform((v, ctx) => {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a payroll month" }); return null; }
  return { year: Number(m[1]), month: Number(m[2]) };
});

const editSchema = z.object({ loanId: zId(), amount: zRequiredNumber({ min: 1000, max: 10_000_000 }), installments: zRequiredNumber({ min: 1, max: 120 }), purpose: zOptional(500), expectedMonth: zMonth(), startMonth: zMonth() });

/** The employee changes a loan request nobody has decided yet. */
export async function updateLoanRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(editSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const loan = await prisma.loan.findFirst({ where: { id: d.loanId, employeeId: viewer.employee.id } });
  if (!loan) return { ok: false, message: "Loan request not found." };
  try {
    const doc = await storeUpload(viewer, formData.get("document"), "LoanDocument", viewer.employee.id);
    const res = await updateLoanRequest({ loanId: d.loanId, employeeId: viewer.employee.id, amount: d.amount, installments: d.installments, purpose: d.purpose, documentUrl: doc?.url ?? null, expected: d.expectedMonth, start: d.startMonth });
    if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: d.loanId, summary: `Loan request changed: ${res.message}`, oldValue: { amount: Number(loan.principal), installments: loan.installments }, newValue: { amount: d.amount, installments: d.installments } });
    return res.ok ? done(paths(d.loanId), res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

async function managedLoan(tenantId: string, viewer: Awaited<ReturnType<typeof requireAuth>>, loanId: string) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, employee: { tenantId } }, include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  return loan && canAccessEmployee(viewer, loan.employee, P.LOAN_MANAGE) ? loan : null;
}

const trancheSchema = z.object({ loanId: zId(), count: zRequiredNumber({ min: 2, max: 12 }), gapMonths: zRequiredNumber({ min: 0, max: 12 }), firstOn: zRequiredDate() });

export async function planTranchesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(trancheSchema, formData);
  if (parsed.state) return parsed.state;
  const loan = await managedLoan(viewer.tenantId, viewer, parsed.data.loanId);
  if (!loan) return { ok: false, message: "Loan not found." };
  const res = await planTranches(viewer.tenantId, loan.id, parsed.data.count, parsed.data.gapMonths, parsed.data.firstOn);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: loan.id, summary: `Disbursement schedule: ${res.message}` });
  return res.ok ? done(paths(loan.id), res.message) : { ok: false, message: res.message };
}

export async function releaseTrancheAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const id = String(formData.get("trancheId") ?? "");
  const t = await prisma.loanTranche.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!t || !(await managedLoan(viewer.tenantId, viewer, t.loanId))) return { ok: false, message: "Tranche not found." };
  const res = await releaseTranche(viewer.tenantId, id, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: t.loanId, summary: res.message });
  return res.ok ? done(paths(t.loanId), res.message) : { ok: false, message: res.message };
}

const adjSchema = z.object({
  loanId: zId(), kind: z.enum(["PREPAYMENT", "SETTLEMENT", "RESCHEDULE", "SKIP", "BALANCE"]), amount: zNumber({ min: 0 }),
  installments: zNumber({ min: 1, max: 120 }), period: zMonth(), keep: z.enum(["EMI", "TENURE"]).default("EMI"), reason: zOptional(500),
});

function details(d: z.infer<typeof adjSchema>): Record<string, unknown> {
  if (d.kind === "RESCHEDULE") return { installments: d.installments };
  if (d.kind === "SKIP") return { year: d.period?.year, month: d.period?.month };
  if (d.kind === "PREPAYMENT") return { keep: d.keep };
  return {};
}

/** The loan desk applies a prepayment, settlement, reschedule, skip or balance write-down. */
export async function adminLoanAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(adjSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const loan = await managedLoan(viewer.tenantId, viewer, d.loanId);
  if (!loan) return { ok: false, message: "Loan not found." };
  const res = await adminLoanAdjustment({ tenantId: viewer.tenantId, loanId: loan.id, kind: d.kind as LoanAdjustmentKind, amount: d.amount ?? null, details: details(d), reason: d.reason ?? "", actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: loan.id, summary: `${d.kind.toLowerCase()}: ${res.message}`, newValue: { amount: d.amount, ...details(d), reason: d.reason } });
  return res.ok ? done(paths(loan.id), res.message) : { ok: false, message: res.message };
}

/** The employee asks to prepay, settle, reschedule or skip; it goes to approval. */
export async function requestLoanAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(adjSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.kind === "BALANCE") return { ok: false, message: "Balance adjustments are made by the loan desk." };
  const loan = await prisma.loan.findFirst({ where: { id: d.loanId, employeeId: viewer.employee.id } });
  if (!loan) return { ok: false, message: "Loan not found." };
  const res = await requestLoanAdjustment({ loanId: loan.id, employeeId: viewer.employee.id, requesterUserId: viewer.user.id, kind: d.kind, amount: d.amount ?? null, details: details(d), reason: d.reason ?? "" });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "LoanAdjustment", entityId: res.id, summary: res.message });
  return res.ok ? done(paths(loan.id), res.message) : { ok: false, message: res.message };
}

export async function runLoanOverdueAlertsAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const r = await runLoanOverdueAlerts(viewer.tenantId);
  const message = r.alerted ? `Alerted ${r.loans} borrower(s) about ${r.alerted} overdue EMI(s).` : "No new overdue EMIs.";
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", summary: `Overdue check: ${message}` });
  return done(paths(), message);
}
