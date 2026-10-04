"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  saveComponentOverride, deleteComponentOverride, deductNoAttendance, setPayableUnits, decideLeave, calculateRun,
  saveRegisterLayout, setHideMyPay, saveGratuitySettings, saveBonusSettings, setTaxWindow, importDeclarations,
  saveContractor, recordContractorPayment, deleteContractorPayment, saveScenario, saveMinimumWage, deleteMinimumWage,
  CONTRACTOR_SECTIONS, defaultContractorRate,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { saveFile, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { toErrorState, writeAudit, actionDone as done, formList, type ActionState } from "@/lib/forms";

/**
 * Payroll depth: component overrides, run step 1 (leave, no-attendance days,
 * payable units), the pay register layout, payroll preferences, gratuity and
 * statutory bonus settings, tax windows and imports, Form 16 Part A,
 * contractor TDS, loan policy assignment, budget scenarios and minimum wages.
 * Every action checks a permission, scopes by tenant and is audited.
 */

const P = PERMISSIONS;
type Perm = (typeof P)[keyof typeof P];
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => { const v = str(f, k); return v === "" ? NaN : Number(v.replace(/,/g, "")); };

async function reaches(viewer: Viewer, employeeId: string, permission: Perm): Promise<boolean> {
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, permission);
}

const audit = (viewer: Viewer, entityType: string, entityId: string | null, summary: string, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "LOCK" | "UNLOCK" = "UPDATE") =>
  writeAudit(viewer, { module: "PAYROLL", action, entityType, entityId, summary });

// ---------------------------------------------------------------------------
//  1. Component overrides
// ---------------------------------------------------------------------------

export async function saveComponentOverrideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const employeeId = str(formData, "employeeId");
  if (!employeeId || !(await reaches(viewer, employeeId, P.SALARY_REVISE))) return { ok: false, message: "Choose an employee within your scope.", errors: { employeeId: "Required" } };
  if (employeeId === viewer.employee?.id) return { ok: false, message: "You cannot override your own salary." };
  try {
    const res = await saveComponentOverride({
      tenantId: viewer.tenantId, employeeId, componentId: str(formData, "componentId"), amount: num(formData, "amount"),
      from: str(formData, "from"), to: str(formData, "to") || null, note: str(formData, "note") || null, byUserId: viewer.user.id,
    });
    if (!res.ok) return res;
    await audit(viewer, "EmployeeComponentOverride", res.id ?? null, res.message, "CREATE");
    return done(["/payroll/salary-overrides", `/employees/${employeeId}`, "/payroll/runs"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function deleteComponentOverrideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const id = str(formData, "id");
  const row = await prisma.employeeComponentOverride.findFirst({ where: { id, tenantId: viewer.tenantId }, select: { employeeId: true } });
  if (!row || !(await reaches(viewer, row.employeeId, P.SALARY_REVISE))) return { ok: false, message: "Override not found." };
  const res = await deleteComponentOverride(viewer.tenantId, id);
  if (!res.ok) return res;
  await audit(viewer, "EmployeeComponentOverride", id, res.message, "DELETE");
  return done(["/payroll/salary-overrides", "/payroll/runs"], res.message);
}

// ---------------------------------------------------------------------------
//  2. Run step 1
// ---------------------------------------------------------------------------

async function editableRun(viewer: Viewer, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, tenantId: viewer.tenantId } });
  if (!run || !["DRAFT", "IN_PROGRESS"].includes(run.status)) return null;
  return run;
}

/** Approve or reject a pending leave request from the run, then recalculate. */
export async function decideRunLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = str(formData, "runId"), requestId = str(formData, "requestId");
  const decision = str(formData, "decision") === "approve" ? "APPROVE" : "REJECT";
  const note = str(formData, "note") || null;
  const run = await editableRun(viewer, runId);
  if (!run) return { ok: false, message: "This run can no longer be edited." };
  const request = await prisma.leaveRequest.findFirst({ where: { id: requestId, tenantId: viewer.tenantId, status: "PENDING" }, include: { leaveType: { select: { name: true } } } });
  if (!request || !(await prisma.payrollRunEmployee.count({ where: { runId, employeeId: request.employeeId } }))) return { ok: false, message: "That request is not pending for anyone in this run." };
  if (request.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own leave." };
  if (!(await reaches(viewer, request.employeeId, P.PAYROLL_RUN))) return { ok: false, message: "This employee is outside your scope." };
  if (decision === "REJECT" && !note) return { ok: false, message: "Give a reason when rejecting.", errors: { note: "Required" } };
  try {
    const res = await decideLeave({ requestId, decision, approverEmployeeId: viewer.employee?.id, note: note ?? "Decided from the payroll run" });
    if (!res.ok) return { ok: false, message: res.message };
    await writeAudit(viewer, { module: "LEAVE", action: decision === "APPROVE" ? "APPROVE" : "REJECT", entityType: "LeaveRequest", entityId: requestId, summary: `${decision === "APPROVE" ? "Approved" : "Rejected"} ${request.leaveType.name}, ${request.totalDays} day(s), from the payroll run` });
    await calculateRun(runId);
    return done([`/payroll/runs/${runId}`, "/leave", "/inbox"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function deductNoAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = str(formData, "runId"), employeeId = str(formData, "employeeId");
  if (!(await editableRun(viewer, runId))) return { ok: false, message: "This run can no longer be edited." };
  if (!(await reaches(viewer, employeeId, P.PAYROLL_RUN))) return { ok: false, message: "This employee is outside your scope." };
  const mode = str(formData, "mode") === "LEAVE" ? "LEAVE" : "LOP";
  try {
    const res = await deductNoAttendance({ tenantId: viewer.tenantId, runId, employeeId, mode, leaveTypeId: str(formData, "leaveTypeId") || null, byUserId: viewer.user.id });
    if (!res.ok) return res;
    await audit(viewer, "PayrollRun", runId, res.message);
    return done([`/payroll/runs/${runId}`], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function setPayableUnitsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const runId = str(formData, "runId"), employeeId = str(formData, "employeeId");
  if (!(await editableRun(viewer, runId))) return { ok: false, message: "This run can no longer be edited." };
  if (!(await reaches(viewer, employeeId, P.PAYROLL_RUN))) return { ok: false, message: "This employee is outside your scope." };
  const raw = str(formData, "units");
  const units = raw === "" ? null : Number(raw);
  if (units !== null && Number.isNaN(units)) return { ok: false, message: "Enter a number of units." };
  try {
    const res = await setPayableUnits({ tenantId: viewer.tenantId, runId, employeeId, units });
    if (!res.ok) return res;
    await audit(viewer, "PayrollRun", runId, res.message);
    return done([`/payroll/runs/${runId}`], res.message);
  } catch (err) { return toErrorState(err); }
}

// ---------------------------------------------------------------------------
//  4. Pay register layout, 9. Hide My Pay, 6. gratuity and bonus settings
// ---------------------------------------------------------------------------

export async function saveRegisterLayoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const payGroupId = str(formData, "payGroupId");
  // Each chosen column carries its position: col=<key>, pos_<key>=<n>.
  const chosen = formList(formData, "col").map((k) => ({ k, pos: Number(formData.get(`pos_${k}`) ?? 999) || 999 }));
  chosen.sort((a, b) => a.pos - b.pos);
  const res = await saveRegisterLayout(viewer.tenantId, payGroupId, chosen.map((c) => c.k), formData.get("showOutsideCtc") === "on");
  if (!res.ok) return res;
  await audit(viewer, "PayRegisterConfig", payGroupId, res.message);
  return done(["/payroll/register", "/payroll/register/customise"], res.message);
}

export async function setHideMyPayAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const hide = formData.get("hideMyPayPage") === "on";
  const res = await setHideMyPay(viewer.tenantId, hide, viewer.user.id);
  await audit(viewer, "PayrollPreference", null, res.message);
  return done(["/payroll/settings", "/finances/pay", "/finances"], res.message);
}

export async function saveGratuitySettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const res = await saveGratuitySettings(viewer.tenantId, {
    eligibilityYears: num(formData, "eligibilityYears"), daysPerYear: num(formData, "daysPerYear"), divisor: num(formData, "divisor"), cap: num(formData, "cap"), wageCodes: str(formData, "wageCodes"),
  }, viewer.user.id);
  if (!res.ok) return res;
  await audit(viewer, "PayrollPreference", null, res.message);
  return done(["/payroll/settings"], res.message);
}

export async function saveBonusSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const mw = num(formData, "minimumWage");
  const res = await saveBonusSettings(viewer.tenantId, {
    enabled: formData.get("enabled") === "on", eligibilityCeiling: num(formData, "eligibilityCeiling"), calculationCeiling: num(formData, "calculationCeiling"),
    minimumWage: Number.isNaN(mw) ? null : mw, percent: num(formData, "percent"), minWorkingDays: num(formData, "minWorkingDays"), wageCodes: str(formData, "wageCodes"),
  }, viewer.user.id);
  if (!res.ok) return res;
  await audit(viewer, "PayrollPreference", null, res.message);
  return done(["/payroll/settings", "/payroll/statutory-bonus"], res.message);
}

export async function saveMinimumWageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const from = new Date(`${str(formData, "effectiveFrom")}T00:00:00Z`);
  if (Number.isNaN(from.getTime())) return { ok: false, message: "Enter the date the rate took effect." };
  const res = await saveMinimumWage({ tenantId: viewer.tenantId, stateCode: str(formData, "stateCode"), category: str(formData, "category"), monthlyAmount: num(formData, "monthlyAmount"), effectiveFrom: from });
  if (!res.ok) return res;
  await audit(viewer, "MinimumWageRate", null, res.message, "CREATE");
  return done(["/payroll/settings", "/payroll/compliance"], res.message);
}

export async function deleteMinimumWageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const res = await deleteMinimumWage(viewer.tenantId, str(formData, "id"));
  if (!res.ok) return res;
  await audit(viewer, "MinimumWageRate", str(formData, "id"), res.message, "DELETE");
  return done(["/payroll/settings", "/payroll/compliance"], res.message);
}

// ---------------------------------------------------------------------------
//  7. Tax administration
// ---------------------------------------------------------------------------

export async function setTaxWindowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TAX_DECLARATION_APPROVE);
  const kind = str(formData, "kind") === "PROOF" ? "PROOF" : "DECLARATION";
  const stateRaw = str(formData, "state");
  const state = stateRaw === "OPEN" ? "OPEN" : stateRaw === "LOCKED" ? "LOCKED" : "DEFAULT";
  const scope = str(formData, "scope");
  const fy = num(formData, "fy");
  if (!(fy > 2000 && fy < 2100)) return { ok: false, message: "Choose a financial year." };
  let employeeIds: string[] | null = null;
  if (scope === "SELECTED") {
    const ids = [...new Set(formList(formData, "employeeIds"))];
    const allowed: string[] = [];
    for (const id of ids) if (await reaches(viewer, id, P.TAX_DECLARATION_APPROVE)) allowed.push(id);
    if (allowed.length === 0) return { ok: false, message: "Choose at least one employee within your scope.", errors: { employeeIds: "Required" } };
    employeeIds = allowed;
  }
  const untilRaw = str(formData, "until");
  const until = untilRaw ? new Date(`${untilRaw}T00:00:00Z`) : null;
  if (state === "OPEN" && !until) return { ok: false, message: "Choose the date the window stays open until.", errors: { until: "Required" } };
  const res = await setTaxWindow({ tenantId: viewer.tenantId, fy, kind, state, employeeIds, until, note: str(formData, "note") || null, byUserId: viewer.user.id });
  if (!res.ok) return res;
  await audit(viewer, "TaxWindowOverride", null, res.message, state === "LOCKED" ? "LOCK" : "UNLOCK");
  return done(["/payroll/tax-admin", "/finances/tax"], res.message);
}

export async function importDeclarationsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.TAX_DECLARATION_APPROVE);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a CSV file.", errors: { file: "Required" } };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB." };
  const fy = num(formData, "fy");
  if (!(fy > 2000 && fy < 2100)) return { ok: false, message: "Choose a financial year." };
  try {
    const res = await importDeclarations({ tenantId: viewer.tenantId, fy, csv: await file.text(), byUserId: viewer.user.id });
    if (!res.ok) return { ok: false, message: [res.message, ...(res.errors ?? []).slice(1, 6)].join(" ") };
    await audit(viewer, "InvestmentDeclaration", null, `Bulk import FY${fy}: ${res.message}`, "CREATE");
    return done(["/payroll/tax-admin", "/payroll/tax-proofs"], [res.message, ...(res.errors ?? []).slice(0, 5)].join(" "));
  } catch (err) { return toErrorState(err); }
}

/** Form 16 Part A (from TRACES) uploaded per employee; the employee downloads it from Manage Tax → Forms. */
export async function uploadForm16PartAAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const employeeId = str(formData, "employeeId");
  const fy = num(formData, "fy");
  if (!(fy > 2000 && fy < 2100)) return { ok: false, message: "Choose a financial year." };
  if (!employeeId || !(await reaches(viewer, employeeId, P.PAY_REGISTER_VIEW))) return { ok: false, message: "Choose an employee within your scope.", errors: { employeeId: "Required" } };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the Part A PDF.", errors: { file: "Required" } };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "Files are limited to 10 MB." };
  const data = Buffer.from(await file.arrayBuffer());
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, message: "Part A must be a PDF.", errors: { file: "Not a PDF" } };
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { employeeNumber: true, displayName: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  await prisma.storedFile.deleteMany({ where: { tenantId: viewer.tenantId, relatedType: "Form16PartA", employeeId, relatedId: String(fy) } });
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: `Form16-PartA-${emp.employeeNumber}-FY${fy}.pdf`, mimeType: "application/pdf", data, relatedType: "Form16PartA", relatedId: String(fy), employeeId, uploadedBy: viewer.user.id });
  await audit(viewer, "StoredFile", stored.id, `Uploaded Form 16 Part A for ${emp.displayName} (FY ${fy})`, "CREATE");
  return done(["/payroll/tax-admin", "/finances/tax/forms"], `Form 16 Part A uploaded for ${emp.displayName}.`);
}

export async function saveContractorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const section = CONTRACTOR_SECTIONS[str(formData, "section")] ? str(formData, "section") : "194C";
  const deducteeType = str(formData, "deducteeType") === "OTHER" ? "OTHER" : "INDIVIDUAL";
  const rate = num(formData, "tdsRate");
  const res = await saveContractor({
    tenantId: viewer.tenantId, id: str(formData, "id") || null, name: str(formData, "name"), pan: str(formData, "pan") || null, section, deducteeType,
    tdsRate: Number.isNaN(rate) ? defaultContractorRate(section, deducteeType) : rate, email: str(formData, "email") || null,
  });
  if (!res.ok) return res;
  await audit(viewer, "TdsContractor", res.id ?? null, res.message, "CREATE");
  return done(["/payroll/filings/26q"], res.message);
}

export async function recordContractorPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const date = (k: string) => { const v = str(formData, k); return v ? new Date(`${v}T00:00:00Z`) : null; };
  const res = await recordContractorPayment({
    tenantId: viewer.tenantId, contractorId: str(formData, "contractorId"), paymentDate: date("paymentDate") ?? new Date(NaN), amount: num(formData, "amount"),
    invoiceNumber: str(formData, "invoiceNumber") || null, bsrCode: str(formData, "bsrCode") || null, challanNumber: str(formData, "challanNumber") || null, depositDate: date("depositDate"),
    note: str(formData, "note") || null, byUserId: viewer.user.id,
  });
  if (!res.ok) return res;
  await audit(viewer, "ContractorPayment", res.id ?? null, res.message, "CREATE");
  return done(["/payroll/filings/26q"], res.message);
}

export async function deleteContractorPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const res = await deleteContractorPayment(viewer.tenantId, str(formData, "id"));
  if (!res.ok) return res;
  await audit(viewer, "ContractorPayment", str(formData, "id"), res.message, "DELETE");
  return done(["/payroll/filings/26q"], res.message);
}

// ---------------------------------------------------------------------------
//  8. Loan policies
// ---------------------------------------------------------------------------

export async function createLoanPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const name = str(formData, "name");
  if (!name || name.length > 120) return { ok: false, message: "Name the policy.", errors: { name: "Required" } };
  const months = num(formData, "eligibilityMonths");
  if (!Number.isNaN(months) && !(months >= 0 && months <= 120)) return { ok: false, message: "Eligibility must be between 0 and 120 months." };
  try {
    const p = await prisma.loanPolicy.create({
      data: { tenantId: viewer.tenantId, name, description: str(formData, "description") || null, minDaysFromJoining: Number.isNaN(months) ? null : Math.round(months * 30.4375), requireProbationComplete: formData.get("requireProbationComplete") === "on" },
    });
    // Optionally copy the category rules (amount, interest, tenure) of an existing policy.
    const copyFrom = str(formData, "copyFrom");
    if (copyFrom) {
      const src = await prisma.loanPolicy.findFirst({ where: { id: copyFrom, tenantId: viewer.tenantId }, include: { rules: true } });
      if (src?.rules.length) {
        await prisma.loanPolicyRule.createMany({ data: src.rules.map(({ id: _id, policyId: _p, ...r }) => ({ ...r, policyId: p.id })) });
      }
    }
    await audit(viewer, "LoanPolicy", p.id, `Created loan policy ${name}`, "CREATE");
    return done(["/payroll/loans"], `Created ${name}. Add its category rules and assign it.`);
  } catch (err) { return toErrorState(err); }
}

export async function assignLoanPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const policy = await prisma.loanPolicy.findFirst({ where: { id: str(formData, "policyId"), tenantId: viewer.tenantId }, select: { id: true, name: true } });
  if (!policy) return { ok: false, message: "Policy not found." };
  const payGroupId = str(formData, "payGroupId") || null, employeeId = str(formData, "employeeId") || null;
  if (!payGroupId && !employeeId) return { ok: false, message: "Choose a pay group or an employee." };
  if (payGroupId && employeeId) return { ok: false, message: "Assign to a pay group or an employee, not both at once." };
  if (payGroupId && !(await prisma.payGroup.count({ where: { id: payGroupId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Pay group not found." };
  if (employeeId && !(await reaches(viewer, employeeId, P.LOAN_MANAGE))) return { ok: false, message: "Employee not found." };
  // One assignment per pay group or employee: the new one replaces the old.
  await prisma.loanPolicyAssignment.deleteMany({ where: { tenantId: viewer.tenantId, ...(employeeId ? { employeeId } : { payGroupId, employeeId: null }) } });
  const a = await prisma.loanPolicyAssignment.create({ data: { tenantId: viewer.tenantId, policyId: policy.id, payGroupId, employeeId } });
  await audit(viewer, "LoanPolicyAssignment", a.id, `Assigned loan policy ${policy.name} to ${employeeId ? "an employee" : "a pay group"}`, "CREATE");
  return done(["/payroll/loans"], `${policy.name} assigned.`);
}

export async function removeLoanPolicyAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const d = await prisma.loanPolicyAssignment.deleteMany({ where: { id: str(formData, "id"), tenantId: viewer.tenantId } });
  if (!d.count) return { ok: false, message: "Assignment not found." };
  await audit(viewer, "LoanPolicyAssignment", str(formData, "id"), "Removed a loan policy assignment", "DELETE");
  return done(["/payroll/loans"], "Assignment removed.");
}

// ---------------------------------------------------------------------------
//  9. Compensation budget scenarios
// ---------------------------------------------------------------------------

export async function saveScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const departmentPercents: Record<string, number> = {};
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("dept_") || typeof v !== "string" || v.trim() === "") continue;
    const pct = Number(v);
    if (Number.isNaN(pct)) return { ok: false, message: "Increment percentages must be numbers." };
    departmentPercents[k.slice(5)] = pct;
  }
  const def = num(formData, "defaultPercent");
  const res = await saveScenario({ tenantId: viewer.tenantId, id: str(formData, "id") || null, name: str(formData, "name"), defaultPercent: Number.isNaN(def) ? 0 : def, departmentPercents, effective: str(formData, "effective"), byUserId: viewer.user.id });
  if (!res.ok) return res;
  await audit(viewer, "CompBudgetScenario", res.id ?? null, res.message, "CREATE");
  return done(["/payroll/budget"], res.message);
}
