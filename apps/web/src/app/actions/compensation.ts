"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  saveCompTemplate, createCompPlan, updateCompPlanSettings, buildCompPlanItems, updateCompItem, skipCompItem, requestCompException,
  setPoolAmount, transferPoolBudget, startCompCalibration, createCalibrationSession, closeCalibrationSession, submitCompPlan, applyCompPlan,
  generateCompStatements, publishCompStatements, acknowledgeCompStatement, proposePayRange, setLocationDifferential, savePayEquityCohort,
  requestAllowanceChange, type MeritBand,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import {
  z, parseForm, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zBool, zId, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const paths = (planId?: string) => ["/payroll/compensation", "/payroll/compensation/ranges", "/payroll/compensation/equity", "/team/compensation", "/finances/compensation", "/inbox", ...(planId ? [`/payroll/compensation/${planId}`] : [])];

/** "1-1.99:0, 2-2.99:4, 3-3.99:8, 4-5:12" → merit bands. */
function parseMatrix(text: string): MeritBand[] | string {
  const out: MeritBand[] = [];
  for (const part of text.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)%?$/.exec(part);
    if (!m) return `Could not read "${part}". Write bands as min-max:percent, e.g. 4-5:12.`;
    out.push({ minRating: Number(m[1]), maxRating: Number(m[2]), pct: Number(m[3]) });
  }
  return out;
}

const settingsShape = {
  meritMatrix: zName(500), defaultPct: zRequiredNumber({ min: 0, max: 100 }), budgetPct: zRequiredNumber({ min: 0, max: 100 }), prorate: zBool(),
  minPct: zNumber({ min: 0, max: 100 }), maxPct: zNumber({ min: 0, max: 100 }), reasonAbovePct: zNumber({ min: 0, max: 100 }), maxPromotionPct: zNumber({ min: 0, max: 100 }),
  minTenureDays: zNumber({ min: 0, max: 3650 }), excludeProbation: zBool(), excludeNotice: zBool(), monthsSinceLastIncrease: zNumber({ min: 0, max: 36 }),
};

function settingsOf(d: { meritMatrix: string; defaultPct: number; budgetPct: number; prorate: boolean; minPct?: number | null; maxPct?: number | null; reasonAbovePct?: number | null; maxPromotionPct?: number | null; minTenureDays?: number | null; excludeProbation: boolean; excludeNotice: boolean; monthsSinceLastIncrease?: number | null }) {
  const matrix = parseMatrix(d.meritMatrix);
  if (typeof matrix === "string") return matrix;
  return {
    meritMatrix: matrix, defaultPct: d.defaultPct, budgetPct: d.budgetPct, prorate: d.prorate,
    guardrails: { minPct: d.minPct ?? null, maxPct: d.maxPct ?? null, reasonAbovePct: d.reasonAbovePct ?? null, maxPromotionPct: d.maxPromotionPct ?? null },
    eligibility: { minTenureDays: d.minTenureDays ?? null, excludeProbation: d.excludeProbation, excludeNotice: d.excludeNotice, monthsSinceLastIncrease: d.monthsSinceLastIncrease ?? null },
  };
}

// --- Templates and plans ----------------------------------------------------

const templateSchema = z.object({ id: zOptionalId(), name: zName(80), ...settingsShape });

export async function saveCompTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(templateSchema, formData);
  if (parsed.state) return parsed.state;
  const s = settingsOf(parsed.data);
  if (typeof s === "string") return { ok: false, message: s, errors: { meritMatrix: s } };
  const res = await saveCompTemplate({ tenantId: viewer.tenantId, id: parsed.data.id, name: parsed.data.name, ...s, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: parsed.data.id ? "UPDATE" : "CREATE", entityType: "CompPlanTemplate", entityId: res.id, summary: `Compensation template ${parsed.data.name} saved`, newValue: s });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const planSchema = z.object({ name: zName(80), templateId: zOptionalId(), reviewCycleId: zOptionalId(), effectiveDate: zRequiredDate(), periodStart: zRequiredDate() });

export async function createCompPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(planSchema, formData);
  if (parsed.state) return parsed.state;
  let extra = {};
  if (!parsed.data.templateId) {
    const s = parseForm(z.object(settingsShape), formData);
    if (s.state) return { ok: false, message: "Pick a template or fill in the merit matrix and budget." };
    const set = settingsOf(s.data);
    if (typeof set === "string") return { ok: false, message: set };
    extra = set;
  }
  const res = await createCompPlan({ tenantId: viewer.tenantId, ...parsed.data, ...extra, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "CompPlan", entityId: res.id, summary: `Compensation plan ${parsed.data.name} created` });
  return res.ok ? done(paths(res.id), res.message) : { ok: false, message: res.message };
}

const settingsSchema = z.object({ planId: zId(), ...settingsShape });

export async function compPlanSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(settingsSchema, formData);
  if (parsed.state) return parsed.state;
  const s = settingsOf(parsed.data);
  if (typeof s === "string") return { ok: false, message: s, errors: { meritMatrix: s } };
  const res = await updateCompPlanSettings({ tenantId: viewer.tenantId, planId: parsed.data.planId, ...s, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompPlan", entityId: parsed.data.planId, summary: "Compensation plan settings changed", newValue: s });
  return res.ok ? done(paths(parsed.data.planId), res.message) : { ok: false, message: res.message };
}

/** Plan-level steps: build, calibrate, submit, apply, statements. */
export async function compPlanOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const planId = String(formData.get("planId") ?? "");
  const op = String(formData.get("op") ?? "");
  const plan = await prisma.compPlan.findFirst({ where: { id: planId, tenantId: viewer.tenantId } });
  if (!plan) return { ok: false, message: "Plan not found." };
  let res: { ok: boolean; message: string };
  if (op === "build") res = await buildCompPlanItems(viewer.tenantId, planId, viewer.user.id);
  else if (op === "calibrate") res = await startCompCalibration(viewer.tenantId, planId, viewer.user.id);
  else if (op === "submit") res = await submitCompPlan(viewer.tenantId, planId, viewer.user.id, viewer.employee?.id ?? null);
  else if (op === "apply") {
    if (!can(viewer, P.SALARY_REVISION_APPROVE) && !can(viewer, P.SALARY_REVISE)) return { ok: false, message: "You cannot apply salary changes." };
    res = await applyCompPlan(viewer.tenantId, planId, viewer.user.id);
  } else if (op === "statements") { const n = await generateCompStatements(viewer.tenantId, planId); res = { ok: n > 0, message: n ? `${n} statement(s) ready to preview.` : "Apply the plan first." }; }
  else if (op === "publish") res = await publishCompStatements(viewer.tenantId, planId);
  else return { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: op === "apply" ? "APPROVE" : "UPDATE", entityType: "CompPlan", entityId: planId, summary: `${plan.name}: ${op} — ${res.message}` });
  return res.ok ? done(paths(planId), res.message) : { ok: false, message: res.message };
}

// --- Worksheet lines --------------------------------------------------------

const itemSchema = z.object({ itemId: zId(), meritPct: zRequiredNumber({ min: 0, max: 100 }), promotionPct: zNumber({ min: 0, max: 100 }), marketPct: zNumber({ min: 0, max: 100 }), newPayGradeId: zOptionalId(), note: zOptional(500), sessionId: zOptionalId() });

/** A manager edits their worksheet; an administrator edits any line through calibration. */
export async function updateCompItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(itemSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const item = await prisma.compPlanItem.findFirst({ where: { id: d.itemId, tenantId: viewer.tenantId }, include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!item) return { ok: false, message: "Line not found." };
  if (item.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot change your own increase." };
  const asAdmin = can(viewer, P.SALARY_REVISE) && canAccessEmployee(viewer, item.employee, P.SALARY_REVISE);
  if (!asAdmin && item.ownerEmployeeId !== viewer.employee?.id) return { ok: false, message: "This employee is not on your worksheet." };
  const res = await updateCompItem({ tenantId: viewer.tenantId, itemId: d.itemId, meritPct: d.meritPct, promotionPct: d.promotionPct ?? 0, marketPct: d.marketPct ?? 0, newPayGradeId: d.newPayGradeId, note: d.note, actorUserId: viewer.user.id, actorEmployeeId: viewer.employee?.id ?? null, asAdmin, sessionId: d.sessionId });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompPlanItem", entityId: d.itemId, summary: res.message, oldValue: { meritPct: Number(item.meritPct), promotionPct: Number(item.promotionPct), marketPct: Number(item.marketPct) }, newValue: { meritPct: d.meritPct, promotionPct: d.promotionPct, marketPct: d.marketPct } });
  return res.ok ? done(paths(item.planId), res.message) : { ok: false, message: res.message };
}

export async function compItemOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const itemId = String(formData.get("itemId") ?? "");
  const op = String(formData.get("op") ?? "");
  const item = await prisma.compPlanItem.findFirst({ where: { id: itemId, tenantId: viewer.tenantId } });
  if (!item) return { ok: false, message: "Line not found." };
  const admin = can(viewer, P.SALARY_REVISE);
  const owner = item.ownerEmployeeId === viewer.employee?.id;
  if (!admin && !owner) return { ok: false, message: "This employee is not on your worksheet." };
  const reason = String(formData.get("reason") ?? "").trim();
  let res: { ok: boolean; message: string };
  if (op === "exception") res = await requestCompException(viewer.tenantId, itemId, reason, viewer.user.id);
  else if (op === "skip" || op === "unskip") {
    if (!admin) return { ok: false, message: "Only compensation administrators leave people out." };
    res = await skipCompItem(viewer.tenantId, itemId, op === "skip", reason || null, viewer.user.id);
  } else return { ok: false, message: "Unknown action." };
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompPlanItem", entityId: itemId, summary: `${op}: ${res.message}` });
  return res.ok ? done(paths(item.planId), res.message) : { ok: false, message: res.message };
}

// --- Pools and calibration --------------------------------------------------

export async function poolAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const planId = String(formData.get("planId") ?? "");
  if (!(await prisma.compPlan.findFirst({ where: { id: planId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Plan not found." };
  let res: { ok: boolean; message: string };
  if (formData.get("op") === "transfer") {
    res = await transferPoolBudget({ tenantId: viewer.tenantId, planId, fromPoolId: String(formData.get("fromPoolId") ?? ""), toPoolId: String(formData.get("toPoolId") ?? ""), amount: Number(formData.get("amount")), reason: String(formData.get("reason") ?? ""), byUserId: viewer.user.id });
  } else {
    const amount = Number(formData.get("amount"));
    if (!Number.isFinite(amount)) return { ok: false, message: "Enter the amount." };
    res = await setPoolAmount(viewer.tenantId, String(formData.get("poolId") ?? ""), amount, viewer.user.id);
  }
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompBudgetPool", entityId: planId, summary: res.message });
  return res.ok ? done(paths(planId), res.message) : { ok: false, message: res.message };
}

const sessionSchema = z.object({ planId: zId(), name: zName(80), scheduledAt: zRequiredDate(), departmentId: zOptionalId(), notes: zOptional(1000) });

export async function calibrationSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  if (formData.get("op") === "close") {
    const id = String(formData.get("sessionId") ?? "");
    const s = await prisma.compCalibrationSession.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!s) return { ok: false, message: "Session not found." };
    const res = await closeCalibrationSession(viewer.tenantId, id, String(formData.get("notes") ?? "").trim() || null, viewer.user.id);
    if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompCalibrationSession", entityId: id, summary: res.message });
    return res.ok ? done(paths(s.planId), res.message) : { ok: false, message: res.message };
  }
  const parsed = parseForm(sessionSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await createCalibrationSession({ tenantId: viewer.tenantId, ...parsed.data, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "CompCalibrationSession", entityId: res.id, summary: res.message });
  return res.ok ? done(paths(parsed.data.planId), res.message) : { ok: false, message: res.message };
}

// --- Statements -------------------------------------------------------------

export async function acknowledgeStatementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const id = String(formData.get("statementId") ?? "");
  const res = await acknowledgeCompStatement(viewer.employee.id, id);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompStatement", entityId: id, summary: "Compensation statement acknowledged" });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

// --- Ranges, differentials, equity, allowances -----------------------------

const rangeSchema = z.object({ payGradeId: zId(), minAnnual: zRequiredNumber({ min: 1 }), midAnnual: zRequiredNumber({ min: 1 }), maxAnnual: zRequiredNumber({ min: 1 }), reason: zName(500) });

export async function proposePayRangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(rangeSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await proposePayRange({ tenantId: viewer.tenantId, ...parsed.data, requesterUserId: viewer.user.id, employeeId: viewer.employee?.id ?? null });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "PayRangeChange", entityId: parsed.data.payGradeId, summary: `Pay range change proposed: ${parsed.data.minAnnual}–${parsed.data.midAnnual}–${parsed.data.maxAnnual}`, newValue: parsed.data });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const diffSchema = z.object({ locationId: zId(), pct: zRequiredNumber({ min: -50, max: 100 }) });

export async function locationDifferentialAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(diffSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await setLocationDifferential(viewer.tenantId, parsed.data.locationId, parsed.data.pct, viewer.user.id);
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "LocationPayDifferential", entityId: parsed.data.locationId, summary: res.message });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const cohortSchema = z.object({ id: zOptionalId(), name: zName(80), departmentId: zOptionalId(), bandId: zOptionalId(), payGradeId: zOptionalId(), designationId: zOptionalId(), locationId: zOptionalId(), thresholdPct: zRequiredNumber({ min: 0, max: 100 }) });

export async function payEquityCohortAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(cohortSchema, formData);
  if (parsed.state) return parsed.state;
  const res = await savePayEquityCohort({ tenantId: viewer.tenantId, ...parsed.data, actorUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: parsed.data.id ? "UPDATE" : "CREATE", entityType: "PayEquityCohort", entityId: res.id, summary: `Pay equity cohort ${parsed.data.name} saved` });
  return res.ok ? done(paths(), res.message) : { ok: false, message: res.message };
}

const allowanceSchema = z.object({ employeeId: zId(), componentId: zId(), newMonthly: zRequiredNumber({ min: 0, max: 10_000_000 }), effectiveFrom: zRequiredDate(), reason: zName(500) });

export async function allowanceChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const parsed = parseForm(allowanceSchema, formData);
  if (parsed.state) return parsed.state;
  const emp = await prisma.employee.findFirst({ where: { id: parsed.data.employeeId, tenantId: viewer.tenantId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
  if (!emp || !canAccessEmployee(viewer, emp, P.SALARY_REVISE)) return { ok: false, message: "Employee not found." };
  if (emp.id === viewer.employee?.id) return { ok: false, message: "You cannot change your own pay." };
  const res = await requestAllowanceChange({ tenantId: viewer.tenantId, ...parsed.data, requesterUserId: viewer.user.id });
  if (res.ok) await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "AllowanceChangeRequest", entityId: emp.id, summary: `Allowance change to ₹${parsed.data.newMonthly}/month requested: ${parsed.data.reason}` });
  return res.ok ? done([...paths(), `/employees/${emp.id}`], res.message) : { ok: false, message: res.message };
}
