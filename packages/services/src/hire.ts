import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import {
  annualBudget, nextRequisitionCode, totalPositions, kitOf, cleanRatings, ratingsAverage, normaliseDecision, plainText,
  type SkillRating, type KitSection,
} from "./hire-math";

export * from "./hire-math";

/**
 * Hire: requisitions (raise, edit, approve or reject in bulk, archive) and
 * Keka-style interview scorecards. The approval rule is separation of duties:
 * nobody decides a requisition they raised, so when the approver who would
 * normally get it is the person raising it, it routes to the next one.
 */

type Result = { ok: boolean; message: string };
const APPROVE = "hire.requisition.approve";
const s = (n: number) => (n === 1 ? "" : "s");

// --- Approvers ---------------------------------------------------------------------

/**
 * Who a requisition goes to, in order: the tenant's default approver, the
 * head of the department's business unit (who holds approval through the
 * implicit Business Head role), then everyone with approval through an
 * explicit role. Inactive logins are skipped.
 */
export async function requisitionApproverChain(tenantId: string, departmentId: string | null): Promise<string[]> {
  const [setting, dept, explicit] = await Promise.all([
    prisma.hiringSetting.findUnique({ where: { tenantId }, select: { defaultApproverUserId: true } }),
    departmentId
      ? prisma.department.findFirst({ where: { tenantId, id: departmentId }, select: { businessUnit: { select: { head: { select: { userId: true } } } } } })
      : null,
    usersWithPermission(tenantId, APPROVE),
  ]);
  const explicitSorted = explicit.length
    ? (await prisma.user.findMany({ where: { tenantId, id: { in: explicit } }, select: { id: true }, orderBy: { email: "asc" } })).map((u) => u.id)
    : [];
  const chain = [setting?.defaultApproverUserId ?? null, dept?.businessUnit?.head?.userId ?? null, ...explicitSorted].filter((u): u is string => !!u);
  const active = new Set((await prisma.user.findMany({
    where: { tenantId, id: { in: chain }, loginDisabled: false, isDeactivated: false }, select: { id: true },
  })).map((u) => u.id));
  return [...new Set(chain)].filter((u) => active.has(u));
}

/** The first approver in the chain who is not the person raising it — never themself. */
export async function resolveRequisitionApprover(tenantId: string, opts: { raisedBy: string | null; departmentId: string | null }): Promise<string | null> {
  const chain = await requisitionApproverChain(tenantId, opts.departmentId);
  return chain.find((u) => u !== opts.raisedBy) ?? null;
}

/** Holds approval tenant-wide through an explicit role (Global Admin, Requisition Manager). */
export async function isSuperApprover(tenantId: string, userId: string): Promise<boolean> {
  return (await usersWithPermission(tenantId, APPROVE)).includes(userId);
}

export interface ApproverActor { userId: string; canApprove: boolean; superApprover: boolean }

/** Why this person may not decide this requisition; null when they may. */
export function decisionBlocker(r: { status: string; raisedBy: string | null; approverUserId: string | null; archivedAt: Date | null }, a: ApproverActor): string | null {
  if (r.archivedAt) return "it is archived";
  if (r.status !== "PENDING_APPROVAL") return `it is already ${r.status.toLowerCase().replace(/_/g, " ")}`;
  if (r.raisedBy === a.userId) return "you raised it";
  if (r.approverUserId === a.userId) return null;
  if (!a.canApprove) return "it is not pending on you";
  if (r.approverUserId && !a.superApprover) return "it is pending on another approver";
  return null;
}

/** The requisitions waiting on this person: the Pending Approvals tab, the nav badge and the Inbox. */
export function requisitionsToDecideWhere(tenantId: string, a: ApproverActor): Prisma.RequisitionWhereInput {
  const mine: Prisma.RequisitionWhereInput[] = [{ approverUserId: a.userId }];
  if (a.canApprove) mine.push(a.superApprover ? {} : { approverUserId: null });
  return {
    tenantId, status: "PENDING_APPROVAL", archivedAt: null,
    AND: [{ OR: [{ raisedBy: null }, { raisedBy: { not: a.userId } }] }, { OR: mine }],
  };
}

// --- Raise and edit ----------------------------------------------------------------

export interface RequisitionInput {
  title: string;
  jobTitleId: string | null;
  isPriority: boolean;
  departmentId: string;
  minExperienceYears: number | null;
  newHire: boolean;
  newPositions: number;
  backfills: Array<{ employeeId: string; reason: string }>;
  locationId: string | null;
  targetStartDate: Date | null;
  currency: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryFrequency: string | null;
  jobType: string;
  employmentType: string | null;
  description: string;
  justification: string | null;
  hiringManagerId: string | null;
  recruiterId: string | null;
}

function columns(input: RequisitionInput, businessUnitId: string | null) {
  const positions = totalPositions(input);
  const budget = annualBudget(input);
  return {
    title: input.title.trim(), jobTitleId: input.jobTitleId, isPriority: input.isPriority,
    departmentId: input.departmentId, businessUnitId, locationId: input.locationId,
    minExperienceYears: input.minExperienceYears,
    newPositions: input.newHire ? input.newPositions : 0, positions,
    type: (input.newHire ? "NEW_HIRE" : "BACKFILL") as "NEW_HIRE" | "BACKFILL",
    replacingEmployeeId: input.backfills[0]?.employeeId ?? null,
    currency: input.currency, salaryMin: input.salaryMin, salaryMax: input.salaryMax, salaryFrequency: input.salaryFrequency,
    minAnnualCtc: budget.minAnnualCtc, maxAnnualCtc: budget.maxAnnualCtc,
    jobType: input.jobType, employmentType: input.employmentType,
    description: input.description.trim(), justification: input.justification,
    targetStartDate: input.targetStartDate, hiringManagerId: input.hiringManagerId, recruiterId: input.recruiterId,
  };
}

async function unitOf(tenantId: string, departmentId: string): Promise<string | null> {
  return (await prisma.department.findFirst({ where: { tenantId, id: departmentId }, select: { businessUnitId: true } }))?.businessUnitId ?? null;
}

/** Raise a requisition for approval. Ids are assumed already checked to belong to the tenant. */
export async function raiseRequisition(tenantId: string, input: RequisitionInput, byUserId: string): Promise<Result & { id?: string; code?: string }> {
  const [approver, bu] = await Promise.all([
    resolveRequisitionApprover(tenantId, { raisedBy: byUserId, departmentId: input.departmentId }),
    unitOf(tenantId, input.departmentId),
  ]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const codes = (await prisma.requisition.findMany({ where: { tenantId, code: { not: null } }, select: { code: true } })).map((r) => r.code);
    const code = nextRequisitionCode(codes);
    try {
      const r = await prisma.requisition.create({
        data: {
          tenantId, code, ...columns(input, bu), status: "PENDING_APPROVAL", raisedBy: byUserId, approverUserId: approver,
          backfills: { create: input.backfills.map((b) => ({ tenantId, employeeId: b.employeeId, reason: b.reason as never })) },
        },
      });
      const approvers = approver ? [approver] : (await usersWithPermission(tenantId, APPROVE)).filter((u) => u !== byUserId);
      await notify({
        tenantId, userIds: approvers, kind: "HIRING", title: `Requisition ${code} needs your approval`,
        body: `${r.title} × ${r.positions}`, link: `/hiring/requisitions?view=pending&req=${r.id}`,
      });
      return { ok: true, message: "Requisition request saved successfully", id: r.id, code };
    } catch (e) {
      // Two people raising at once can collide on the next code; take the one after.
      if (!(e instanceof Error) || !e.message.includes("Unique constraint")) throw e;
    }
  }
  return { ok: false, message: "Could not allocate a requisition code. Try again." };
}

const LABELS: Array<[keyof ReturnType<typeof columns>, string]> = [
  ["title", "job title"], ["isPriority", "priority"], ["departmentId", "department"], ["locationId", "location"],
  ["minExperienceYears", "experience"], ["positions", "positions"], ["currency", "currency"], ["salaryMin", "min range"],
  ["salaryMax", "max range"], ["salaryFrequency", "frequency"], ["jobType", "job type"], ["employmentType", "employment type"],
  ["description", "job description"], ["justification", "additional comments"], ["targetStartDate", "target hiring date"],
  ["hiringManagerId", "hiring manager"], ["recruiterId", "recruiter"],
];
const comparable = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? "" : typeof v === "object" ? String(Number(v)) : String(v));

/**
 * Edit a requisition. While pending, its raiser or a requisition manager may;
 * once approved, only approvers (super recruiters, global admins), and never
 * below the openings already given to jobs. Editing a rejected one
 * resubmits it. Fulfilled and cancelled requisitions are history.
 */
export async function updateRequisition(tenantId: string, id: string, input: RequisitionInput, actor: { userId: string; canManage: boolean; canApprove: boolean }): Promise<Result & { changes?: string[] }> {
  const r = await prisma.requisition.findFirst({ where: { tenantId, id }, include: { jobs: { select: { openings: true } }, backfills: true } });
  if (!r) return { ok: false, message: "Requisition not found." };
  if (r.archivedAt) return { ok: false, message: "Unarchive the requisition before editing it." };
  if (r.status === "FULFILLED" || r.status === "CANCELLED") return { ok: false, message: `A ${r.status.toLowerCase()} requisition cannot be changed.` };
  if (r.status === "APPROVED" && !actor.canApprove) return { ok: false, message: "Once approved, only approvers and global admins can change a requisition." };
  if ((r.status === "PENDING_APPROVAL" || r.status === "REJECTED" || r.status === "DRAFT") && !(actor.canManage || r.raisedBy === actor.userId)) {
    return { ok: false, message: "Only the person who raised it or a requisition manager can edit it." };
  }
  const bu = await unitOf(tenantId, input.departmentId);
  const next = columns(input, bu);
  const opened = r.jobs.reduce((n, j) => n + j.openings, 0);
  if (r.status === "APPROVED" && next.positions < opened) return { ok: false, message: `Jobs already hold ${opened} opening${s(opened)}; keep at least that many positions.` };

  const changes = LABELS.filter(([k]) => comparable((r as Record<string, unknown>)[k]) !== comparable(next[k])).map(([k, label]) =>
    k === "positions" ? `positions ${r.positions}→${next.positions}` : label);
  const backfillKey = (xs: Array<{ employeeId: string; reason: string }>) => xs.map((b) => `${b.employeeId}:${b.reason}`).sort().join(",");
  if (backfillKey(r.backfills) !== backfillKey(input.backfills)) changes.push("backfills");

  const resubmit = r.status === "REJECTED";
  const reroute = resubmit || (r.status === "PENDING_APPROVAL" && r.departmentId !== input.departmentId);
  const approverUserId = reroute ? await resolveRequisitionApprover(tenantId, { raisedBy: r.raisedBy, departmentId: input.departmentId }) : r.approverUserId;
  await prisma.$transaction([
    prisma.requisitionBackfill.deleteMany({ where: { requisitionId: r.id } }),
    prisma.requisition.update({
      where: { id: r.id },
      data: {
        ...next, approverUserId,
        ...(resubmit ? { status: "PENDING_APPROVAL" as const, rejectReason: null } : {}),
        backfills: { create: input.backfills.map((b) => ({ tenantId, employeeId: b.employeeId, reason: b.reason as never })) },
      },
    }),
  ]);
  if (resubmit && approverUserId) {
    await notify({ tenantId, userIds: [approverUserId], kind: "HIRING", title: `Requisition ${r.code ?? ""} resubmitted for approval`.replace("  ", " "), body: next.title, link: `/hiring/requisitions?view=pending&req=${r.id}` });
  }
  return { ok: true, message: resubmit ? "Requisition updated and resubmitted for approval" : "Requisition updated successfully", changes };
}

// --- Decide ---------------------------------------------------------------------------

/**
 * Approve or reject several requisitions at once. Each is checked on its own:
 * ones the person may not decide are skipped with the reason, not failed.
 */
export async function decideRequisitions(opts: {
  tenantId: string; ids: string[]; approve: boolean; reason: string | null; actor: ApproverActor;
}): Promise<Result & { done: Array<{ id: string; title: string }>; skipped: Array<{ id: string; title: string; why: string }> }> {
  const ids = [...new Set(opts.ids)].slice(0, 200);
  if (ids.length === 0) return { ok: false, message: "Select at least one requisition.", done: [], skipped: [] };
  const reason = opts.reason?.trim() || null;
  if (!opts.approve && !reason) return { ok: false, message: "Give a reason when rejecting.", done: [], skipped: [] };
  if (reason && reason.length > 500) return { ok: false, message: "Keep the reason under 500 characters.", done: [], skipped: [] };
  const rows = await prisma.requisition.findMany({ where: { tenantId: opts.tenantId, id: { in: ids } } });
  const done: Array<{ id: string; title: string }> = [];
  const skipped: Array<{ id: string; title: string; why: string }> = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) { skipped.push({ id, title: "Unknown", why: "not found" }); continue; }
    const why = decisionBlocker(r, opts.actor);
    if (why) { skipped.push({ id, title: r.title, why }); continue; }
    // Conditional on still being pending, so two approvers acting at once cannot both decide it.
    const u = await prisma.requisition.updateMany({
      where: { id: r.id, status: "PENDING_APPROVAL" },
      data: opts.approve
        ? { status: "APPROVED", approvedBy: opts.actor.userId, approvedAt: new Date(), rejectReason: null }
        : { status: "REJECTED", rejectReason: reason, approvedBy: null, approvedAt: null },
    });
    if (u.count === 0) { skipped.push({ id, title: r.title, why: "someone else decided it first" }); continue; }
    done.push({ id: r.id, title: r.title });
    await notify({
      tenantId: opts.tenantId, userIds: [r.raisedBy], kind: "HIRING",
      title: `Requisition ${r.code ?? r.title} ${opts.approve ? "approved" : "rejected"}`,
      body: opts.approve ? `${r.title} can now be opened as a job.` : `${r.title}: ${reason}`,
      link: `/hiring/requisitions?req=${r.id}`,
    });
  }
  const verb = opts.approve ? "approved" : "rejected";
  const message = done.length
    ? `${done.length} requisition${s(done.length)} ${verb} successfully${skipped.length ? `; ${skipped.length} skipped` : ""}`
    : `Nothing was ${verb}: ${skipped.map((x) => `${x.title} — ${x.why}`).join("; ")}`;
  return { ok: done.length > 0, message, done, skipped };
}

/** Archive (or bring back) a requisition. One with an open job stays in play. */
export async function archiveRequisition(tenantId: string, id: string, byUserId: string, archive: boolean): Promise<Result> {
  const r = await prisma.requisition.findFirst({ where: { tenantId, id }, include: { jobs: { select: { status: true } } } });
  if (!r) return { ok: false, message: "Requisition not found." };
  if (archive) {
    if (r.archivedAt) return { ok: false, message: "It is already archived." };
    if (r.jobs.some((j) => j.status === "OPEN" || j.status === "ON_HOLD" || j.status === "DRAFT")) return { ok: false, message: "Close its job before archiving the requisition." };
    await prisma.requisition.update({ where: { id: r.id }, data: { archivedAt: new Date(), archivedBy: byUserId } });
    return { ok: true, message: "Requisition archived" };
  }
  if (!r.archivedAt) return { ok: false, message: "It is not archived." };
  await prisma.requisition.update({ where: { id: r.id }, data: { archivedAt: null, archivedBy: null } });
  return { ok: true, message: "Requisition restored" };
}

// --- Scorecards -----------------------------------------------------------------------

/** Average of the submitted scorecards across an application, stored for the pipeline cards. */
export async function recomputeApplicationScore(applicationId: string): Promise<number | null> {
  const cards = await prisma.scorecard.findMany({ where: { interview: { applicationId }, status: "SUBMITTED", overallScore: { not: null } }, select: { overallScore: true } });
  const avg = cards.length ? Math.round((cards.reduce((n, c) => n + Number(c.overallScore), 0) / cards.length) * 100) / 100 : null;
  await prisma.application.update({ where: { id: applicationId }, data: { averageScore: avg } });
  return avg;
}

export async function interviewKit(jobId: string): Promise<KitSection[]> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { scorecardTemplate: true } });
  return kitOf(job?.scorecardTemplate);
}

/**
 * Save a panellist's feedback: a draft, or a submission. Only the panel may,
 * only once the interview has started, and a submitted scorecard is final.
 * Ratings are kept only for the job's own skills; the score is their mean.
 */
export async function saveScorecard(opts: {
  interviewId: string; panelistEmployeeId: string; recommendation: string | null; notes: string | null;
  ratings: unknown; submit: boolean; aiAssisted?: boolean;
}): Promise<Result> {
  const iv = await prisma.interview.findUnique({ where: { id: opts.interviewId }, include: { panel: true, scorecards: true, application: { select: { id: true, jobId: true } } } });
  if (!iv) return { ok: false, message: "Interview not found." };
  if (!iv.panel.some((p) => p.employeeId === opts.panelistEmployeeId)) return { ok: false, message: "Only the interview panel can give feedback." };
  if (iv.status === "CANCELLED") return { ok: false, message: "This interview was cancelled." };
  if (iv.scheduledAt.getTime() > Date.now()) return { ok: false, message: "Feedback opens once the interview has started." };
  const existing = iv.scorecards.find((x) => x.panelistId === opts.panelistEmployeeId);
  if (existing?.status === "SUBMITTED") return { ok: false, message: "You have already submitted feedback." };

  const decision = normaliseDecision(opts.recommendation);
  if (opts.recommendation && (!decision || decision !== opts.recommendation)) return { ok: false, message: "Choose a recommendation." };
  const notes = opts.notes?.trim() || null;
  if (notes && notes.length > 5000) return { ok: false, message: "Keep the feedback under 5,000 characters." };
  if (opts.submit) {
    if (!decision) return { ok: false, message: "Choose a recommendation: No Hire, Not Sure, Average, Hire or Must Hire." };
    if (plainText(notes).length < 20) return { ok: false, message: "Write your feedback (at least 20 characters) before submitting." };
  }
  const kit = await interviewKit(iv.application.jobId);
  const ratings: SkillRating[] = cleanRatings(opts.ratings, kit);
  const data = {
    recommendation: decision, notes, ratings: ratings as unknown as Prisma.InputJsonValue, overallScore: ratingsAverage(ratings),
    aiAssisted: !!opts.aiAssisted || (existing?.aiAssisted ?? false),
    status: opts.submit ? "SUBMITTED" : "DRAFT",
    ...(opts.submit ? { submittedAt: new Date() } : {}),
  };
  if (existing) await prisma.scorecard.update({ where: { id: existing.id }, data });
  else await prisma.scorecard.create({ data: { ...data, interviewId: iv.id, panelistId: opts.panelistEmployeeId } });
  if (!opts.submit) return { ok: true, message: "Feedback saved as draft." };

  await recomputeApplicationScore(iv.applicationId);
  const submitted = await prisma.scorecard.count({ where: { interviewId: iv.id, status: "SUBMITTED" } });
  if (submitted >= iv.panel.length) await prisma.interview.update({ where: { id: iv.id }, data: { status: "COMPLETED" } });
  return { ok: true, message: "Feedback submitted." };
}
