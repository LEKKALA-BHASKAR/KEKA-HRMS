"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { buildLoanSchedule } from "@keka/payroll";
import {
  checkLoanEligibility, requestLoan, approveLoan, rejectLoan, disburseLoan, skipInstallment, forecloseLoan,
} from "@keka/services";
import { requireAuth, requireViewer, type Viewer } from "@/lib/context";
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

const applySchema = z.object({
  categoryId: zId(),
  amount: zRequiredNumber({ min: 1000, max: 10_000_000 }),
  installments: zRequiredNumber({ min: 1, max: 120 }),
  purpose: zOptional(500),
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
  const res = await requestLoan({ employeeId: viewer.employee.id, categoryId: d.categoryId, amount: d.amount, installments: d.installments, purpose: d.purpose });
  if (!res.ok) return { ok: false, message: res.message, values };
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "Loan", entityId: res.loanId, summary: `Requested a loan of ₹${d.amount}` });
  return done(["/me/loans", "/payroll/loans", "/inbox"], res.message);
}

export async function decideLoanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_APPROVE);
  const loanId = String(formData.get("loanId"));
  const decision = String(formData.get("decision"));
  const note = String(formData.get("note") ?? "").trim() || null;
  const loan = await loanInScope(viewer, loanId, P.LOAN_APPROVE);
  if (!loan) return { ok: false, message: "Loan not found." };
  if (loan.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own loan." };
  if (decision === "reject" && !note) return { ok: false, message: "Give a reason when declining.", errors: { note: "Required" } };
  const res = decision === "approve" ? await approveLoan(loanId, viewer.user.id, note) : await rejectLoan(loanId, viewer.user.id, note!);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: decision === "approve" ? "APPROVE" : "REJECT", entityType: "Loan", entityId: loanId, summary: res.message });
  return done(["/payroll/loans", "/inbox", "/me/loans"], res.message);
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
  return done(["/payroll/loans", "/me/loans"], res.message);
}

const categorySchema = z.object({
  id: zOptionalId(), name: zName(60), description: zOptional(200),
  isConcessional: zBool(), sbiBenchmarkRate: zNumber({ min: 0, max: 30 }),
});

export async function saveLoanCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const parsed = parseForm(categorySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    if (id) await prisma.loanCategory.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
    else await prisma.loanCategory.create({ data: { ...d, tenantId: viewer.tenantId } });
    return done(["/payroll/loans"], `Saved ${d.name}.`);
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
  await prisma.loanPolicyRule.upsert({
    where: { policyId_categoryId: { policyId, categoryId } },
    create: { policyId, categoryId, ...d },
    update: d,
  });
  return done(["/payroll/loans"], `Saved the ${cat.name} rule.`);
}

const policySchema = z.object({
  id: zId(), requireProbationComplete: zBool(), blockOnNoticePeriod: zBool(),
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
  return u.count ? done(["/payroll/loans"], "Saved the eligibility rules.") : { ok: false, message: "Policy not found." };
}
