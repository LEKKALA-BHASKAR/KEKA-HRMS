"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import {
  startProbation, changeProbationPolicy, openProbationReview, decideProbation, submitProbationEvaluation,
  confirmationEligibility, lifecycleDependencyIssues,
} from "@keka/services";
import { requireAuth, requireViewer, type Viewer } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zRequiredNumber, zNumber, zBool, zId, zOptionalId, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/probation", "/inbox", "/"];

/** HR may act on a probation only for employees inside their probation scope, never their own. */
async function reaches(viewer: Viewer, employeeId: string): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return false;
  const t = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true },
  });
  return !!t && canAccessEmployee(viewer, t, P.PROBATION_MANAGE);
}

async function probationFor(viewer: Viewer, probationId: string) {
  const p = await prisma.employeeProbation.findFirst({ where: { id: probationId, tenantId: viewer.tenantId }, select: { id: true, employeeId: true } });
  return p && (await reaches(viewer, p.employeeId)) ? p : null;
}

// ---------------------------------------------------------------------------
//  POLICIES
// ---------------------------------------------------------------------------

const policySchema = z.object({
  policyId: zOptionalId(),
  name: zName(80),
  description: zOptional(500),
  durationDays: zRequiredNumber({ min: 1, max: 730 }),
  maxExtensions: zRequiredNumber({ min: 0, max: 5 }),
  extensionDays: zRequiredNumber({ min: 1, max: 365 }),
  completion: z.enum(["EVALUATION", "AUTO_CONFIRM"]),
  reviewLeadDays: zNumber({ min: 0, max: 180 }),
  selfReview: zBool(),
  isDefault: zBool(),
});

export async function saveProbationPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const parsed = parseForm(policySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  for (const k of ["durationDays", "maxExtensions", "extensionDays", "reviewLeadDays"] as const) {
    if (d[k] !== undefined && d[k] !== null && !Number.isInteger(d[k])) return { ok: false, message: "Use whole days.", errors: { [k]: "Whole days" } };
  }
  if (d.completion === "EVALUATION" && (d.reviewLeadDays ?? 15) >= d.durationDays) {
    return { ok: false, message: "The review must open after probation starts.", errors: { reviewLeadDays: "Shorter than the probation" } };
  }
  const data = {
    name: d.name, description: d.description ?? null, durationDays: d.durationDays, maxExtensions: d.maxExtensions,
    extensionDays: d.extensionDays, completion: d.completion, reviewLeadDays: d.reviewLeadDays ?? 15,
    selfReview: d.selfReview, isDefault: d.isDefault,
  };
  try {
    const existing = d.policyId ? await prisma.probationPolicy.findFirst({ where: { id: d.policyId, tenantId: viewer.tenantId } }) : null;
    if (d.policyId && !existing) return { ok: false, message: "Policy not found." };
    const clash = await prisma.probationPolicy.findFirst({ where: { tenantId: viewer.tenantId, name: d.name, NOT: existing ? { id: existing.id } : undefined }, select: { id: true } });
    if (clash) return { ok: false, message: "A policy with this name already exists.", errors: { name: "Already used" } };
    const saved = await prisma.$transaction(async (tx) => {
      if (d.isDefault) await tx.probationPolicy.updateMany({ where: { tenantId: viewer.tenantId, isDefault: true }, data: { isDefault: false } });
      return existing
        ? tx.probationPolicy.update({ where: { id: existing.id }, data })
        : tx.probationPolicy.create({ data: { ...data, tenantId: viewer.tenantId } });
    });
    await writeAudit(viewer, {
      module: "LIFECYCLE", action: existing ? "UPDATE" : "CREATE", entityType: "ProbationPolicy", entityId: saved.id,
      summary: `${existing ? "Updated" : "Created"} probation policy ${saved.name} (${saved.durationDays} days)`,
      oldValue: existing ?? undefined, newValue: data,
    });
    return done(PATHS, existing
      ? `Saved ${saved.name}. Probations already running keep their end dates; move them to the policy to recompute.`
      : `Created ${saved.name}.`);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: "A policy with this name already exists.", errors: { name: "Already used" } };
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  PROBATIONS
// ---------------------------------------------------------------------------

const startSchema = z.object({ employeeId: zId(), policyId: zOptionalId() });

export async function startProbationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const parsed = parseForm(startSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await reaches(viewer, d.employeeId))) return { ok: false, message: "This employee is outside the people whose probation you manage." };
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: d.employeeId }, select: { status: true, employeeNumber: true } });
  if (emp.status !== "PROBATION") return { ok: false, message: "Only an employee whose status is Probation can be put on probation." };
  const r = await startProbation({ employeeId: d.employeeId, policyId: d.policyId });
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "EmployeeProbation", entityId: r.probationId, summary: `Started probation for ${emp.employeeNumber}: ${r.message}` });
  return done(PATHS, r.message);
}

const policyChangeSchema = z.object({ probationId: zId(), policyId: zId() });

export async function changeProbationPolicyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const parsed = parseForm(policyChangeSchema, formData);
  if (parsed.state) return parsed.state;
  const p = await probationFor(viewer, parsed.data.probationId);
  if (!p) return { ok: false, message: "Probation not found." };
  const r = await changeProbationPolicy(p.id, parsed.data.policyId);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "EmployeeProbation", entityId: p.id, summary: r.message });
  return done([...PATHS, `/probation/${p.id}`], r.message);
}

const idSchema = z.object({ probationId: zId() });

export async function openProbationReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const parsed = parseForm(idSchema, formData);
  if (parsed.state) return parsed.state;
  const p = await probationFor(viewer, parsed.data.probationId);
  if (!p) return { ok: false, message: "Probation not found." };
  const r = await openProbationReview(p.id);
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "EmployeeProbation", entityId: p.id, summary: `Opened probation review: ${r.message}` });
  return done([...PATHS, `/probation/${p.id}`], r.message);
}

const decideSchema = z.object({
  probationId: zId(),
  decision: z.enum(["CONFIRM", "EXTEND", "NOT_CONFIRM"]),
  extendDays: zNumber({ min: 1, max: 365 }),
  note: zOptional(1000),
});

export async function decideProbationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROBATION_MANAGE);
  const parsed = parseForm(decideSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const p = await probationFor(viewer, d.probationId);
  if (!p) return { ok: false, message: "Probation not found." };
  if (d.decision === "NOT_CONFIRM" && !d.note) return { ok: false, message: "Record why the employee is not being confirmed.", errors: { note: "Required" } };
  // Ops depth: confirmation rules (service, LOP, late marks, warnings, evaluation) and lifecycle dependencies.
  if (d.decision === "CONFIRM") {
    const blocked = await lifecycleDependencyIssues(viewer.tenantId, p.employeeId, "CONFIRMATION");
    const elig = await confirmationEligibility(viewer.tenantId, p.employeeId);
    const reasons = [...blocked, ...(elig && !elig.eligible ? elig.reasons : [])];
    if (reasons.length) return { ok: false, message: `Not yet eligible for confirmation: ${reasons.join(" ")}` };
  }
  try {
    const r = await decideProbation({ probationId: p.id, decision: d.decision, extendDays: d.extendDays ?? null, note: d.note ?? null, byUserId: viewer.user.id });
    if (!r.ok) return { ok: false, message: r.message };
    await writeAudit(viewer, {
      module: "LIFECYCLE", action: d.decision === "NOT_CONFIRM" ? "REJECT" : "APPROVE", entityType: "EmployeeProbation", entityId: p.id,
      summary: `Probation ${d.decision.replace(/_/g, " ").toLowerCase()}: ${r.message}`,
    });
    return done([...PATHS, `/probation/${p.id}`, `/employees/${p.employeeId}`, "/onboarding"], r.message);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  REVIEWS — the manager's and the employee's own
// ---------------------------------------------------------------------------

const evaluationSchema = z.object({
  evaluationId: zId(),
  rating: zNumber({ min: 1, max: 5 }),
  recommendation: z.enum(["CONFIRM", "EXTEND", "NOT_CONFIRM"]).or(z.literal("")).optional().transform((v) => v || null),
  strengths: zOptional(2000),
  improvements: zOptional(2000),
  comments: zOptional(2000),
});

export async function submitProbationEvaluationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const parsed = parseForm(evaluationSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const values = Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
  const r = await submitProbationEvaluation({
    evaluationId: d.evaluationId, evaluatorEmployeeId: viewer.employee.id,
    rating: d.rating ?? null, recommendation: d.recommendation,
    strengths: d.strengths ?? null, improvements: d.improvements ?? null, comments: d.comments ?? null,
  });
  if (!r.ok) return { ok: false, message: r.message, errors: Object.fromEntries(r.issues.map((i) => [i.field, i.message])), values };
  return done(PATHS, r.message);
}
