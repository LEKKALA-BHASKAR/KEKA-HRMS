"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveBenefitPlan, submitBenefitPlan, renewBenefitPlan, retireBenefitPlan, createEnrollmentWindow, announceWindow, remindWindow, closeWindow,
  enrollInBenefit, waiveBenefit, endBenefitCoverage, runCoverageEndProcessing, requestDependentChange, verifyDependent, reportLifeEvent,
  requestBenefitException, pushBenefitDeductions, reconcileCarrierFile, BENEFIT_TYPES, DEPENDENT_RELATIONS,
} from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { storeUpload } from "@/lib/money";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zBool, zId, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/payroll/benefits", "/payroll/benefits/enrolment", "/payroll/benefits/reports", "/finances/benefits", "/inbox", "/admin/workflows"];

// --- Plans ------------------------------------------------------------------

const types = Object.keys(BENEFIT_TYPES) as [keyof typeof BENEFIT_TYPES, ...(keyof typeof BENEFIT_TYPES)[]];
const planSchema = z.object({
  id: zOptionalId(), code: zName(20), name: zName(80), type: z.enum(types), provider: zOptional(80), description: zOptional(500),
  coverageAmount: zNumber({ min: 0 }), monthlyPremium: zRequiredNumber({ min: 0, max: 1_000_000 }),
  factorSpouse: zNumber({ min: 1, max: 10 }), factorFamily: zNumber({ min: 1, max: 10 }),
  employerRule: z.enum(["FLAT", "PERCENT_OF_PREMIUM", "MATCH_PERCENT_OF_BASIC"]), employerValue: zRequiredNumber({ min: 0, max: 1_000_000 }), employerCap: zNumber({ min: 0 }),
  minTenureDays: zNumber({ min: 0, max: 3650 }), excludeProbation: zBool(), waitingPeriodDays: zRequiredNumber({ min: 0, max: 365 }),
  maxDependents: zRequiredNumber({ min: 0, max: 10 }), childMaxAge: zNumber({ min: 0, max: 30 }), requiresDependentProof: zBool(),
  deductionName: zOptional(60), planYearStart: zDate(), planYearEnd: zDate(), renewalDate: zDate(),
});

export async function saveBenefitPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const parsed = parseForm(planSchema, formData);
  if (parsed.state) return parsed.state;
  const { factorSpouse, factorFamily, minTenureDays, excludeProbation, ...d } = parsed.data;
  const allowedRelations = formList(formData, "allowedRelations").filter((r) => (DEPENDENT_RELATIONS as readonly string[]).includes(r));
  const bandIds = formList(formData, "bandIds"), locationIds = formList(formData, "locationIds"), workerTypeIds = formList(formData, "workerTypeIds");
  const [b, l, w] = await Promise.all([
    prisma.band.count({ where: { tenantId: viewer.tenantId, id: { in: bandIds } } }),
    prisma.location.count({ where: { tenantId: viewer.tenantId, id: { in: locationIds } } }),
    prisma.workerType.count({ where: { tenantId: viewer.tenantId, id: { in: workerTypeIds } } }),
  ]);
  if (b !== bandIds.length || l !== locationIds.length || w !== workerTypeIds.length) return { ok: false, message: "Unknown band, location or worker type." };
  try {
    const res = await saveBenefitPlan({
      tenantId: viewer.tenantId, ...d, allowedRelations, actorUserId: viewer.user.id,
      tierFactors: { EMPLOYEE: 1, EMPLOYEE_SPOUSE: factorSpouse ?? 1.8, FAMILY: factorFamily ?? 2.6 },
      eligibility: { minTenureDays: minTenureDays ?? null, excludeProbation, bandIds, locationIds, workerTypeIds },
    });
    if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: d.id ? "UPDATE" : "CREATE", entityType: "BenefitPlan", entityId: res.id, summary: `Saved benefit plan ${d.name} (${d.code})`, newValue: { ...parsed.data, allowedRelations, bandIds, locationIds, workerTypeIds } });
    return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function benefitPlanOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const plan = await prisma.benefitPlan.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Plan not found." };
  const date = (k: string) => { const v = String(formData.get(k) ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null; };
  let res: { ok: boolean; message: string };
  if (op === "submit") res = await submitBenefitPlan(viewer.tenantId, id, viewer.user.id, viewer.employee?.id ?? null);
  else if (op === "renew") {
    const s = date("planYearStart"), e = date("planYearEnd");
    const pct = Number(formData.get("premiumChangePct") ?? 0);
    if (!s || !e || e <= s) return { ok: false, message: "Enter the new plan year." };
    if (!Number.isFinite(pct) || pct < -50 || pct > 200) return { ok: false, message: "Premium change: -50% to +200%." };
    res = await renewBenefitPlan(viewer.tenantId, id, { premiumChangePct: pct, planYearStart: s, planYearEnd: e, actorUserId: viewer.user.id });
  } else if (op === "retire") res = await retireBenefitPlan(viewer.tenantId, id, date("endOn") ?? new Date());
  else return { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: op === "retire" ? "DELETE" : "UPDATE", entityType: "BenefitPlan", entityId: id, summary: `${plan.name}: ${op} — ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Windows ----------------------------------------------------------------

const windowSchema = z.object({ name: zName(80), kind: z.enum(["OPEN", "NEW_HIRE", "LIFE_EVENT"]).default("OPEN"), opensOn: zRequiredDate(), closesOn: zRequiredDate(), employeeId: zOptionalId() });

export async function createEnrollmentWindowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const parsed = parseForm(windowSchema, formData);
  if (parsed.state) return parsed.state;
  if (parsed.data.employeeId && !(await prisma.employee.findFirst({ where: { id: parsed.data.employeeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Employee not found." };
  const res = await createEnrollmentWindow({ tenantId: viewer.tenantId, ...parsed.data, planIds: formList(formData, "planIds"), actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitEnrollmentWindow", entityId: res.id, summary: res.message });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function windowOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const res = op === "announce" ? await announceWindow(viewer.tenantId, id) : op === "remind" ? await remindWindow(viewer.tenantId, id) : op === "close" ? await closeWindow(viewer.tenantId, id) : { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "BenefitEnrollmentWindow", entityId: id, summary: `${op}: ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Enrolment (employee) ---------------------------------------------------

const enrolSchema = z.object({ planId: zId(), tier: z.enum(["EMPLOYEE", "EMPLOYEE_SPOUSE", "FAMILY"]).default("EMPLOYEE"), contributionPct: zNumber({ min: 0, max: 50 }), intent: z.enum(["enrol", "waive"]).default("enrol") });

export async function enrollBenefitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(enrolSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const plan = await prisma.benefitPlan.findFirst({ where: { id: d.planId, tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Plan not found." };
  const res = d.intent === "waive"
    ? await waiveBenefit(viewer.employee.id, plan.id)
    : await enrollInBenefit({ employeeId: viewer.employee.id, planId: plan.id, tier: d.tier, dependentIds: formList(formData, "dependentIds"), contributionPct: d.contributionPct, requesterUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitEnrollment", entityId: (res as { id?: string }).id ?? null, summary: `${plan.name}: ${d.intent === "waive" ? "waived" : `enrolment requested (${d.tier})`}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function endCoverageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const id = String(formData.get("enrollmentId") ?? "");
  const v = String(formData.get("endOn") ?? "");
  const endOn = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date();
  const reason = String(formData.get("reason") ?? "").trim() || "Ended by benefits administrator";
  const res = await endBenefitCoverage(viewer.tenantId, id, endOn, reason);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "BenefitEnrollment", entityId: id, summary: `Cover ended: ${reason}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

export async function runCoverageEndAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const r = await runCoverageEndProcessing(viewer.tenantId);
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "BenefitEnrollment", summary: `Coverage-end processing: ${r.ended} enrolment(s) ended` });
  return done(PATHS, r.ended ? `Ended cover for ${r.ended} enrolment(s) (leavers and finished plan years).` : "Nothing to end.");
}

// --- Dependents, life events, exceptions -----------------------------------

const depSchema = z.object({ action: z.enum(["ADD", "UPDATE", "REMOVE"]), dependentId: zOptionalId(), name: zOptional(120), relationship: zOptional(30), dateOfBirth: zDate() });

export async function dependentRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(depSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    const proof = await storeUpload(viewer, formData.get("proof"), "DependentProof", viewer.employee.id);
    let name = d.name ?? "", relationship = d.relationship ?? "";
    if (d.action === "REMOVE" && d.dependentId) {
      const dep = await prisma.dependent.findFirst({ where: { id: d.dependentId, employeeId: viewer.employee.id } });
      if (dep) { name = dep.name; relationship = dep.relationship; }
    }
    const res = await requestDependentChange({ employeeId: viewer.employee.id, requesterUserId: viewer.user.id, action: d.action, dependentId: d.dependentId, name, relationship, dateOfBirth: d.dateOfBirth, proofUrl: proof?.url ?? null });
    if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "DependentRequest", entityId: res.id, summary: `Dependent ${d.action.toLowerCase()} requested: ${name}` });
    return res.ok ? done([...PATHS, "/me/profile"], res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function verifyDependentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const id = String(formData.get("dependentId") ?? "");
  const dep = await prisma.dependent.findFirst({ where: { id, employee: { tenantId: viewer.tenantId } } });
  if (!dep) return { ok: false, message: "Dependent not found." };
  try {
    const proof = await storeUpload(viewer, formData.get("proof"), "DependentProof", dep.employeeId);
    const res = await verifyDependent(viewer.tenantId, id, proof?.url ?? null, viewer.user.id);
    if (res.ok) await writeAudit(viewer, { module: "EMPLOYEE", action: "APPROVE", entityType: "Dependent", entityId: id, summary: res.message });
    return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

const lifeSchema = z.object({ kind: z.enum(["MARRIAGE", "BIRTH", "ADOPTION", "DIVORCE", "DEATH_OF_DEPENDENT", "OTHER"]), eventDate: zRequiredDate(), notes: zOptional(500) });

export async function lifeEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(lifeSchema, formData);
  if (parsed.state) return parsed.state;
  try {
    const proof = await storeUpload(viewer, formData.get("proof"), "LifeEventProof", viewer.employee.id);
    const res = await reportLifeEvent({ employeeId: viewer.employee.id, requesterUserId: viewer.user.id, ...parsed.data, proofUrl: proof?.url ?? null });
    if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitLifeEvent", entityId: res.id, summary: `Life event reported: ${parsed.data.kind}` });
    return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function benefitExceptionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const planId = String(formData.get("planId") ?? "");
  if (!(await prisma.benefitPlan.findFirst({ where: { id: planId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Plan not found." };
  const res = await requestBenefitException({ employeeId: viewer.employee.id, planId, reason: String(formData.get("reason") ?? ""), requesterUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitEligibilityException", entityId: planId, summary: "Eligibility exception requested" });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}

// --- Payroll and carrier ----------------------------------------------------

const pushSchema = z.object({ year: zRequiredNumber({ min: 2000, max: 2100 }), month: zRequiredNumber({ min: 1, max: 12 }) });

export async function pushBenefitDeductionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const parsed = parseForm(pushSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await pushBenefitDeductions(viewer.tenantId, parsed.data.year, parsed.data.month, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitDeduction", summary: res.message });
  return res.ok ? done([...PATHS, "/payroll"], res.message) : { ok: false, message: res.message };
}

export async function reconcileCarrierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BENEFIT_MANAGE);
  const planId = String(formData.get("planId") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the insurer's member file (CSV)." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, message: "The file is limited to 5 MB." };
  const res = await reconcileCarrierFile(viewer.tenantId, planId, await file.text(), viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "BenefitCarrierFile", entityId: planId, summary: `Carrier reconciliation: ${res.message}` });
  return res.ok ? done(PATHS, res.message) : { ok: false, message: res.message };
}
