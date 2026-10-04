"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { buildLoanSchedule } from "@keka/payroll";
import {
  checkLoanEligibility, requestLoan, approveLoan, rejectLoan, disburseLoan, skipInstallment, forecloseLoan,
  proposeLoanRule, loanNeedsDocument, delegatorsOf,
} from "@keka/services";
import { requireAuth, requireViewer, can, viewerForUser, type Viewer } from "@/lib/context";
import { storeUpload } from "@/lib/money";
import { sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zBool, zId, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

async function loanInScope(viewer: Viewer, loanId: string, permission: (typeof P)[keyof typeof P]) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, employee: { tenantId: viewer.tenantId } },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!loan) return null;
  return canAccessEmployee(viewer, loan.employee, permission) ? loan : null;
}

const zMonth = () => z.string().optional().transform((v, ctx) => {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a payroll month" }); return null; }
  return { year: Number(m[1]), month: Number(m[2]) };
});

const applySchema = z.object({
  categoryId: zId(),
  amount: zRequiredNumber({ min: 1000, max: 10_000_000 }),
  installments: zRequiredNumber({ min: 1, max: 120 }),
  purpose: zOptional(500),
  /** "Expected Month (Payroll Month)" and "EMI Starts From (Payroll Month)", as YYYY-MM. */
  expectedMonth: zMonth(),
  startMonth: zMonth(),
  intent: z.enum(["preview", "apply"]).default("apply"),
});

export async function applyLoanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(applySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  const e = await checkLoanEligibility(viewer.employee.id, d.categoryId, d.amount, d.installments);
  if (d.intent === "preview") {
    if (!e.eligible) return { ok: false, message: e.reasons.join(" "), values };
    const now = new Date();
    const idx = now.getUTCFullYear() * 12 + now.getUTCMonth() + e.commencementMonths;
    const s = buildLoanSchedule({ principal: d.amount, installments: d.installments, interestType: e.interestType, annualRate: e.interestRate, startYear: Math.floor(idx / 12), startMonth: (idx % 12) + 1 });
    return {
      ok: true, values,
      message: `EMI ₹${s.emi.toNumber().toLocaleString("en-IN")} × ${d.installments} from ${(idx % 12) + 1}/${Math.floor(idx / 12)}` +
        (s.totalInterest.gt(0) ? `, ₹${s.totalInterest.toNumber().toLocaleString("en-IN")} interest at ${e.interestRate}% ${e.interestType.toLowerCase()}.` : ", interest-free.") +
        (e.maxAmount ? ` You can borrow up to ₹${e.maxAmount.toLocaleString("en-IN")}.` : ""),
    };
  }
  // Some loan types need a supporting document (quotation, medical estimate).
  // It is checked first and stored only once the request is accepted.
  const doc = formData.get("document");
  const hasDoc = doc instanceof File && doc.size > 0;
  if (hasDoc) {
    if (doc.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB.", errors: { document: "Too large" }, values };
    const sniff = sniffUpload(Buffer.from(await doc.arrayBuffer()), doc.type);
    if (!sniff.ok) return { ok: false, message: sniff.reason, errors: { document: sniff.reason }, values };
  } else if (await loanNeedsDocument(viewer.employee.id, d.categoryId)) {
    return { ok: false, message: "This loan type needs a supporting document. Attach it and apply again.", errors: { document: "Required" }, values };
  }
  const res = await requestLoan({
    employeeId: viewer.employee.id, categoryId: d.categoryId, amount: d.amount, installments: d.installments, purpose: d.purpose,
    expected: d.expectedMonth, start: d.startMonth,
  });
  if (!res.ok) return { ok: false, message: res.message, values };
  if (hasDoc && res.loanId) {
    const stored = await storeUpload(viewer, doc, "LoanDocument", viewer.employee.id);
    if (stored) await prisma.loan.update({ where: { id: res.loanId }, data: { documentUrl: stored.url } });
  }
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "Loan", entityId: res.loanId, summary: `Requested a loan of ₹${d.amount}`, newValue: { categoryId: d.categoryId, amount: d.amount, installments: d.installments, expected: d.expectedMonth, start: d.startMonth } });
  return done(["/finances/loans", "/payroll/loans", "/inbox"], res.message);
}

/** A loan approver who delegated loan approvals to the viewer and covers this loan. */
async function delegatedLoanApprover(viewer: Viewer, loanId: string): Promise<string | null> {
  for (const userId of await delegatorsOf(viewer.tenantId, viewer.user.id, "LOAN_REQUEST")) {
    const v = await viewerForUser(userId).catch(() => null);
    if (v && can(v, P.LOAN_APPROVE) && (await loanInScope(v, loanId, P.LOAN_APPROVE))) return userId;
  }
  return null;
}

export async function decideLoanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const loanId = String(formData.get("loanId"));
  const decision = String(formData.get("decision"));
  const note = String(formData.get("note") ?? "").trim() || null;
  const direct = can(viewer, P.LOAN_APPROVE) ? await loanInScope(viewer, loanId, P.LOAN_APPROVE) : null;
  const onBehalfOf = direct ? null : await delegatedLoanApprover(viewer, loanId);
  // Neither a loan approver nor anyone's delegate: refused like any other gated action.
  if (!onBehalfOf && !can(viewer, P.LOAN_APPROVE)) await requireAuth(P.LOAN_APPROVE);
  const loan = direct ?? (onBehalfOf ? await prisma.loan.findFirst({ where: { id: loanId, employee: { tenantId: viewer.tenantId } } }) : null);
  if (!loan) return { ok: false, message: "Loan not found." };
  if (loan.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own loan." };
  if (decision === "reject" && !note) return { ok: false, message: "Give a reason when declining.", errors: { note: "Required" } };
  const res = decision === "approve" ? await approveLoan(loanId, viewer.user.id, note) : await rejectLoan(loanId, viewer.user.id, note!);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: decision === "approve" ? "APPROVE" : "REJECT", entityType: "Loan", entityId: loanId, summary: `${res.message}${onBehalfOf ? " (as delegate)" : ""}`, newValue: { note, onBehalfOf } });
  return done(["/payroll/loans", "/inbox", "/finances/loans"], res.message);
}

export async function loanOperationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const loanId = String(formData.get("loanId"));
  const op = String(formData.get("op"));
  const loan = await loanInScope(viewer, loanId, P.LOAN_MANAGE);
  if (!loan) return { ok: false, message: "Loan not found." };
  let res: { ok: boolean; message: string };
  if (op === "disburse") res = await disburseLoan(loanId, { outsidePayroll: formData.get("outside") === "on" });
  else if (op === "skip") {
    const [y, m] = String(formData.get("period") ?? "").split("-").map(Number);
    res = y && m ? await skipInstallment(loanId, y, m) : { ok: false, message: "Pick the month to skip." };
  } else if (op === "foreclose") res = await forecloseLoan(loanId);
  else return { ok: false, message: "Unknown operation." };
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Loan", entityId: loanId, summary: `${op}: ${res.message}` });
  return done(["/payroll/loans", "/finances/loans"], res.message);
}

const categorySchema = z.object({
  id: zOptionalId(), name: zName(60), description: zOptional(200),
  code: z.string().trim().max(12).optional().transform((v) => (v ? v.toUpperCase() : null))
    .refine((v) => v === null || /^[A-Z0-9-]{2,12}$/.test(v), "Letters, digits and dashes, 2–12 characters"),
  isConcessional: zBool(), sbiBenchmarkRate: zNumber({ min: 0, max: 30 }),
  isEmergency: zBool(), emergencyMaxMonthsSalary: zNumber({ min: 0, max: 12 }),
});

export async function saveLoanCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(categorySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    if (d.code && await prisma.loanCategory.findFirst({ where: { tenantId: viewer.tenantId, code: d.code, ...(id ? { id: { not: id } } : {}) } })) {
      return { ok: false, message: `Another category already uses the code ${d.code}.`, errors: { code: "Already in use" } };
    }
    let savedId = id;
    if (id) {
      const u = await prisma.loanCategory.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
      if (!u.count) return { ok: false, message: "Category not found." };
    } else savedId = (await prisma.loanCategory.create({ data: { ...d, tenantId: viewer.tenantId } })).id;
    await writeAudit(viewer, { module: "PAYROLL", action: id ? "UPDATE" : "CREATE", entityType: "LoanCategory", entityId: savedId, summary: `Saved loan category ${d.name}${d.code ? ` (${d.code})` : ""}` });
    return done(["/payroll/loans", "/finances/loans"], `Saved ${d.name}.`);
  } catch (err) { return toErrorState(err); }
}

const ruleSchema = z.object({
  policyId: zId(), categoryId: zId(),
  interestType: z.enum(["NONE", "FLAT", "REDUCING"]),
  interestRate: zNumber({ min: 0, max: 30 }),
  maxInstallments: zRequiredNumber({ min: 1, max: 120 }),
  commencementMonths: zRequiredNumber({ min: 0, max: 12 }),
  maxAmount: zNumber({ min: 0, max: 10_000_000 }),
  maxPercentOfSalary: zNumber({ min: 0, max: 500 }),
  requiresDocuments: zBool(),
  processingFeePct: zNumber({ min: 0, max: 10 }),
  processingFeeFlat: zNumber({ min: 0, max: 100_000 }),
});

export async function saveLoanRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(ruleSchema, formData);
  if (parsed.state) return parsed.state;
  const { policyId, categoryId, ...d } = parsed.data;
  const policy = await prisma.loanPolicy.findFirst({ where: { id: policyId, tenantId: viewer.tenantId } });
  const cat = await prisma.loanCategory.findFirst({ where: { id: categoryId, tenantId: viewer.tenantId } });
  if (!policy || !cat) return { ok: false, message: "Policy or category not found." };
  if (d.interestType !== "NONE" && !d.interestRate) return { ok: false, message: "An interest-bearing loan needs a rate.", errors: { interestRate: "Required" } };
  // Changes to a policy that requires approval wait in the workflow.
  const res = await proposeLoanRule({ tenantId: viewer.tenantId, policyId, categoryId, rule: { ...d, interestRate: d.interestRate ?? null, maxAmount: d.maxAmount ?? null, maxPercentOfSalary: d.maxPercentOfSalary ?? null, processingFeePct: d.processingFeePct ?? null, processingFeeFlat: d.processingFeeFlat ?? null }, actorUserId: viewer.user.id, employeeId: viewer.employee?.id ?? null });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "LoanPolicyRule", entityId: `${policyId}:${categoryId}`, summary: `${cat.name} rule ${res.pending ? "change submitted for approval" : "saved"}`, newValue: d });
  return done(["/payroll/loans", "/inbox"], res.message);
}

const policySchema = z.object({
  id: zId(), requireProbationComplete: zBool(), blockOnNoticePeriod: zBool(), requireChangeApproval: zBool(),
  minDaysFromJoining: zNumber({ min: 0, max: 3650 }),
  minAnnualSalary: zNumber({ min: 0 }), maxAnnualSalary: zNumber({ min: 0 }),
});

export async function saveLoanPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(policySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.minAnnualSalary && d.maxAnnualSalary && d.minAnnualSalary > d.maxAnnualSalary) {
    return { ok: false, message: "The minimum salary is above the maximum.", errors: { maxAnnualSalary: "Below minimum" } };
  }
  const u = await prisma.loanPolicy.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
  if (u.count) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "LoanPolicy", entityId: id, summary: "Loan eligibility rules saved", newValue: d });
  return u.count ? done(["/payroll/loans"], "Saved the eligibility rules.") : { ok: false, message: "Policy not found." };
}
