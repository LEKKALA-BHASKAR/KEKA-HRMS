import { prisma, type Prisma } from "@keka/db";
import { startOfDay } from "@keka/shared";
import { notify, startJourney, usersWithPermission } from "./lifecycle";
import {
  probationEndDate, probationDue, confirmationEffectiveDate, extensionCheck, extendedEndDate, validateEvaluation,
} from "./probation-math";

/**
 * Probation and confirmation (Keka help centre A4.4).
 *
 * Every employee whose status is PROBATION gets one EmployeeProbation from a
 * policy. Under an EVALUATION policy a review opens a set number of days
 * before the end: the reporting manager is asked for a rating and a
 * recommendation, the employee for their own view. HR then confirms, extends
 * (within the policy's limit, which opens a fresh review round) or records
 * that the employee is not confirmed. An AUTO_CONFIRM policy confirms on the
 * day after probation ends with no review.
 *
 * Confirmation is written the same way a manual confirmation is: a
 * CONFIRMATION job record, status CONFIRMED with its date, and the
 * CONFIRMATION journey.
 */

const OPEN = ["ACTIVE", "IN_REVIEW"] as const;

export async function defaultProbationPolicy(tenantId: string) {
  return (
    (await prisma.probationPolicy.findFirst({ where: { tenantId, isActive: true, isDefault: true }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.probationPolicy.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: "asc" } }))
  );
}

/**
 * Put an employee on probation under a policy, from their date of joining
 * unless told otherwise. Idempotent: an employee already carrying a probation
 * keeps it.
 */
export async function startProbation(input: { employeeId: string; policyId?: string | null; startDate?: Date }): Promise<{ ok: boolean; message: string; probationId?: string; created?: boolean }> {
  const emp = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { tenantId: true, dateOfJoining: true, probation: { select: { id: true } } } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.probation) return { ok: true, message: "Already on probation.", probationId: emp.probation.id, created: false };
  const policy = input.policyId
    ? await prisma.probationPolicy.findFirst({ where: { id: input.policyId, tenantId: emp.tenantId, isActive: true } })
    : await defaultProbationPolicy(emp.tenantId);
  if (!policy) return { ok: false, message: "Set up a probation policy first." };
  const start = startOfDay(input.startDate ?? emp.dateOfJoining);
  const end = probationEndDate(start, policy.durationDays);
  try {
    const p = await prisma.employeeProbation.create({
      data: { tenantId: emp.tenantId, employeeId: input.employeeId, policyId: policy.id, startDate: start, originalEndDate: end, endDate: end },
    });
    return { ok: true, message: `On probation until ${end.toISOString().slice(0, 10)}.`, probationId: p.id, created: true };
  } catch (err) {
    // Lost a race with another start: the unique employeeId means one probation.
    if ((err as { code?: string }).code === "P2002") {
      const p = await prisma.employeeProbation.findUniqueOrThrow({ where: { employeeId: input.employeeId } });
      return { ok: true, message: "Already on probation.", probationId: p.id, created: false };
    }
    throw err;
  }
}

/** Give every employee in PROBATION status who has none a probation under the default policy. */
export async function ensureProbations(tenantId: string): Promise<number> {
  const missing = await prisma.employee.findMany({ where: { tenantId, status: "PROBATION", probation: null }, select: { id: true } });
  let started = 0;
  for (const e of missing) if ((await startProbation({ employeeId: e.id })).created) started++;
  return started;
}

/**
 * Move an open probation to another policy. The end date is recomputed from
 * the start under the new policy, plus any extension days already granted.
 */
export async function changeProbationPolicy(probationId: string, policyId: string): Promise<{ ok: boolean; message: string }> {
  const p = await prisma.employeeProbation.findUnique({ where: { id: probationId } });
  if (!p) return { ok: false, message: "Probation not found." };
  if (!OPEN.includes(p.status as (typeof OPEN)[number])) return { ok: false, message: "This probation is already decided." };
  const policy = await prisma.probationPolicy.findFirst({ where: { id: policyId, tenantId: p.tenantId, isActive: true } });
  if (!policy) return { ok: false, message: "Choose an active policy." };
  const extended = Math.round((p.endDate.getTime() - p.originalEndDate.getTime()) / 86_400_000);
  const original = probationEndDate(p.startDate, policy.durationDays);
  const end = new Date(original.getTime() + extended * 86_400_000);
  await prisma.employeeProbation.update({ where: { id: p.id }, data: { policyId: policy.id, originalEndDate: original, endDate: end } });
  return { ok: true, message: `Moved to ${policy.name}; probation now ends ${end.toISOString().slice(0, 10)}.` };
}

/**
 * Open the review round: ask the reporting manager (and the employee, when
 * the policy wants a self review) for feedback due on the last day of
 * probation. Opening the same round twice creates nothing new.
 */
export async function openProbationReview(probationId: string, today = new Date()): Promise<{ ok: boolean; message: string; requested: number }> {
  const p = await prisma.employeeProbation.findUnique({
    where: { id: probationId },
    include: {
      policy: true,
      employee: { select: { id: true, displayName: true, userId: true, reportingManagerId: true, reportingManager: { select: { userId: true } } } },
    },
  });
  if (!p) return { ok: false, message: "Probation not found.", requested: 0 };
  if (!OPEN.includes(p.status as (typeof OPEN)[number])) return { ok: false, message: "This probation is already decided.", requested: 0 };
  const due = startOfDay(p.endDate) < startOfDay(today) ? startOfDay(today) : p.endDate;
  const rows: Prisma.ProbationEvaluationCreateManyInput[] = [];
  if (p.employee.reportingManagerId) rows.push({ probationId: p.id, round: p.round, role: "MANAGER", evaluatorId: p.employee.reportingManagerId, dueDate: due });
  if (p.policy.selfReview) rows.push({ probationId: p.id, round: p.round, role: "SELF", evaluatorId: p.employee.id, dueDate: due });

  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.probationEvaluation.createMany({ data: rows, skipDuplicates: true });
    await tx.employeeProbation.update({ where: { id: p.id }, data: { status: "IN_REVIEW", reviewOpenedAt: p.status === "IN_REVIEW" ? undefined : new Date() } });
    return r.count;
  });
  if (created > 0) {
    const name = p.employee.displayName ?? "An employee";
    await notify({
      tenantId: p.tenantId, userIds: [p.employee.reportingManager?.userId], kind: "PROBATION", email: true,
      title: `Probation review for ${name}`, body: `${name}'s probation ends ${p.endDate.toISOString().slice(0, 10)}. Share your feedback and recommendation.`,
      link: "/inbox", relatedType: "EmployeeProbation", relatedId: p.id, event: "PROBATION_REVIEW_DUE", employeeIds: [p.employeeId],
    });
    if (p.policy.selfReview) {
      await notify({
        tenantId: p.tenantId, userIds: [p.employee.userId], kind: "PROBATION",
        title: "Your probation review is open", body: `Share how your first months have gone before ${p.endDate.toISOString().slice(0, 10)}.`, link: "/inbox",
      });
    }
  }
  return {
    ok: true,
    requested: created,
    message: rows.length === 0
      ? "Review opened. There is no reporting manager or self review to ask, so HR decides directly."
      : created > 0 ? `Review opened; feedback requested from ${created} reviewer${created === 1 ? "" : "s"}.` : "The review was already open.",
  };
}

export interface SubmitEvaluationInput {
  evaluationId: string;
  evaluatorEmployeeId: string;
  rating: number | null;
  recommendation: "CONFIRM" | "EXTEND" | "NOT_CONFIRM" | null;
  strengths?: string | null;
  improvements?: string | null;
  comments?: string | null;
}

export async function submitProbationEvaluation(input: SubmitEvaluationInput): Promise<{ ok: boolean; message: string; issues: Array<{ field: string; message: string }> }> {
  const ev = await prisma.probationEvaluation.findUnique({
    where: { id: input.evaluationId },
    include: { probation: { include: { employee: { select: { displayName: true } } } } },
  });
  // The same answer for "not yours" and "does not exist", so ids cannot be probed.
  if (!ev || ev.evaluatorId !== input.evaluatorEmployeeId) return { ok: false, message: "Review not found.", issues: [] };
  if (ev.status !== "PENDING") return { ok: false, message: "This review has already been submitted or closed.", issues: [] };
  if (ev.probation.status !== "IN_REVIEW" || ev.round !== ev.probation.round) return { ok: false, message: "This review round is closed.", issues: [] };
  const issues = validateEvaluation(ev.role, { rating: input.rating, recommendation: input.recommendation, comments: input.comments ?? null });
  if (issues.length) return { ok: false, message: issues[0].message, issues };

  const res = await prisma.probationEvaluation.updateMany({
    where: { id: ev.id, status: "PENDING" },
    data: {
      status: "SUBMITTED", rating: input.rating, submittedAt: new Date(),
      recommendation: ev.role === "MANAGER" ? input.recommendation : null,
      strengths: input.strengths ?? null, improvements: input.improvements ?? null, comments: input.comments ?? null,
    },
  });
  if (res.count === 0) return { ok: false, message: "This review has already been submitted.", issues: [] };
  if (ev.role === "MANAGER") {
    await notify({
      tenantId: ev.probation.tenantId, userIds: await usersWithPermission(ev.probation.tenantId, "lifecycle.probation.manage"), kind: "PROBATION",
      title: `Probation feedback in for ${ev.probation.employee.displayName ?? "an employee"}`,
      body: `Manager recommends: ${String(input.recommendation).replace(/_/g, " ").toLowerCase()}.`, link: `/probation/${ev.probationId}`,
    });
  }
  return { ok: true, message: "Thanks, your feedback has been submitted.", issues: [] };
}

export interface DecideProbationInput {
  probationId: string;
  decision: "CONFIRM" | "EXTEND" | "NOT_CONFIRM";
  extendDays?: number | null;
  note?: string | null;
  byUserId: string | null;
  today?: Date;
}

/** Close the pending reviews of a round that has ended. */
async function closeRound(tx: Prisma.TransactionClient, probationId: string, round: number) {
  await tx.probationEvaluation.updateMany({ where: { probationId, round, status: "PENDING" }, data: { status: "SKIPPED" } });
}

export async function decideProbation(input: DecideProbationInput): Promise<{ ok: boolean; message: string; journeyTasks?: number }> {
  const today = startOfDay(input.today ?? new Date());
  const p = await prisma.employeeProbation.findUnique({
    where: { id: input.probationId },
    include: { policy: true, employee: { select: { id: true, displayName: true, userId: true, status: true, reportingManager: { select: { userId: true } } } } },
  });
  if (!p) return { ok: false, message: "Probation not found." };
  if (!OPEN.includes(p.status as (typeof OPEN)[number])) return { ok: false, message: "This probation is already decided." };
  const name = p.employee.displayName ?? "The employee";

  if (input.decision === "EXTEND") {
    const days = input.extendDays ?? p.policy.extensionDays;
    const check = extensionCheck(p.extensions, p.policy.maxExtensions, days);
    if (!check.ok) return { ok: false, message: check.message };
    const end = extendedEndDate(p.endDate, days, today);
    // Conditional on the status read above, so two deciders cannot both win.
    const won = await prisma.$transaction(async (tx) => {
      const r = await tx.employeeProbation.updateMany({
        where: { id: p.id, status: p.status, round: p.round },
        data: { endDate: end, extensions: { increment: 1 }, round: { increment: 1 }, status: "ACTIVE", reviewOpenedAt: null, decisionNote: input.note ?? null },
      });
      if (r.count === 0) return false;
      await closeRound(tx, p.id, p.round);
      return true;
    });
    if (!won) return { ok: false, message: "Someone else decided this probation first." };
    await notify({
      tenantId: p.tenantId, userIds: [p.employee.userId, p.employee.reportingManager?.userId], kind: "PROBATION", email: true,
      title: `Probation extended for ${name}`, body: `Probation now ends ${end.toISOString().slice(0, 10)}.${input.note ? ` ${input.note}` : ""}`, link: "/",
      event: "PROBATION_EXTENDED", employeeIds: [p.employeeId],
    });
    return { ok: true, message: `Extended by ${days} days to ${end.toISOString().slice(0, 10)}. A new review opens before then.` };
  }

  if (input.decision === "NOT_CONFIRM") {
    if (!input.note) return { ok: false, message: "Record why the employee is not being confirmed." };
    const won = await prisma.$transaction(async (tx) => {
      const r = await tx.employeeProbation.updateMany({
        where: { id: p.id, status: p.status, round: p.round },
        data: { status: "NOT_CONFIRMED", decision: "NOT_CONFIRM", decidedBy: input.byUserId, decidedAt: new Date(), decisionNote: input.note },
      });
      if (r.count === 0) return false;
      await closeRound(tx, p.id, p.round);
      return true;
    });
    if (!won) return { ok: false, message: "Someone else decided this probation first." };
    return { ok: true, message: `Recorded that ${name} is not confirmed. Start the exit from Exits if they are leaving.` };
  }

  // CONFIRM
  const effective = confirmationEffectiveDate(p.endDate, today);
  const won = await prisma.$transaction(async (tx) => {
    const r = await tx.employeeProbation.updateMany({
      where: { id: p.id, status: p.status, round: p.round },
      data: { status: "CONFIRMED", decision: "CONFIRM", decidedBy: input.byUserId, decidedAt: new Date(), decisionNote: input.note ?? null, confirmedOn: effective },
    });
    if (r.count === 0) return false;
    await closeRound(tx, p.id, p.round);

    // The same effective-dated record a manual confirmation writes.
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: p.employeeId } });
    const open = await tx.employeeJobRecord.findFirst({ where: { employeeId: p.employeeId, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
    if (open && open.effectiveFrom < effective) {
      await tx.employeeJobRecord.update({ where: { id: open.id }, data: { effectiveTo: new Date(effective.getTime() - 86_400_000) } });
    }
    await tx.employeeJobRecord.create({
      data: {
        employeeId: p.employeeId, effectiveFrom: effective, reason: "CONFIRMATION",
        jobTitleId: open?.jobTitleId ?? null,
        departmentId: emp.departmentId, businessUnitId: emp.businessUnitId, locationId: emp.locationId,
        legalEntityId: emp.legalEntityId, bandId: emp.bandId, payGradeId: emp.payGradeId,
        workerTypeId: emp.workerTypeId, reportingManagerId: emp.reportingManagerId,
        note: input.note ?? "Confirmed at the end of probation", createdBy: input.byUserId,
      },
    });
    // Only an employee still on probation changes status; someone already
    // serving notice keeps that status but gains the confirmation date.
    await tx.employee.update({
      where: { id: p.employeeId },
      data: { confirmationDate: effective, ...(emp.status === "PROBATION" ? { status: "CONFIRMED" as const } : {}) },
    });
    return true;
  });
  if (!won) return { ok: false, message: "Someone else decided this probation first." };

  const journey = await startJourney({ employeeId: p.employeeId, trigger: "CONFIRMATION", anchorDate: effective, createdBy: input.byUserId, sourceType: "EmployeeProbation", sourceId: p.id });
  await notify({
    tenantId: p.tenantId, userIds: [p.employee.userId, p.employee.reportingManager?.userId], kind: "PROBATION", email: true,
    title: `${name} is confirmed`, body: `Confirmed with effect from ${effective.toISOString().slice(0, 10)}.`, link: "/",
    event: "PROBATION_CONFIRMED", employeeIds: [p.employeeId],
  });
  const { fireLetterTriggers } = await import("./letter-ops");
  await fireLetterTriggers(p.tenantId, "CONFIRMED", p.employeeId, input.byUserId).catch(() => undefined);
  return {
    ok: true,
    journeyTasks: journey.created ? journey.tasks : 0,
    message: `Confirmed ${name} with effect from ${effective.toISOString().slice(0, 10)}.` + (journey.created ? ` ${journey.tasks} confirmation task(s) were created.` : ""),
  };
}

/**
 * The nightly pass: start probation for anyone missing one, open reviews that
 * are due, and confirm auto-confirm probations that have ended. Idempotent.
 */
export async function runProbationJob(tenantId: string, today = new Date()): Promise<{ started: number; reviewsOpened: number; autoConfirmed: number }> {
  const started = await ensureProbations(tenantId);
  const open = await prisma.employeeProbation.findMany({ where: { tenantId, status: "ACTIVE" }, include: { policy: true } });
  let reviewsOpened = 0, autoConfirmed = 0;
  for (const p of open) {
    const due = probationDue(p, p.policy, today);
    if (due === "OPEN_REVIEW" && (await openProbationReview(p.id, today)).ok) reviewsOpened++;
    if (due === "AUTO_CONFIRM" && (await decideProbation({ probationId: p.id, decision: "CONFIRM", byUserId: null, today, note: "Confirmed automatically at the end of probation" })).ok) autoConfirmed++;
  }
  return { started, reviewsOpened, autoConfirmed };
}
