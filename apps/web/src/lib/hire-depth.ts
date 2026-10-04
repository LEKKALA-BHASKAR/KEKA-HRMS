import "server-only";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { stageEntryProblem, startHireRequest, moveStage, usersWithPermission, panelProblems, parsePanelRules, applicableClauses, clausesToHtml, hireDepthConfig } from "@keka/services";
import { requireViewer, canAny, type Viewer } from "./context";
import { formValues, type ActionState } from "./forms";

/**
 * Shared pieces for the hire-depth actions and pages: permission guards,
 * form readers, and the gate every stage move goes through (entry
 * criteria, and stages that need an approval first).
 */

export const HP = PERMISSIONS;

/** The viewer, if they hold any of the permissions; else a 403. */
export async function requireAnyOf(perms: Permission[]): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!canAny(viewer, perms)) forbidden();
  return viewer;
}

export const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max);
export const fail = (message: string, f?: FormData, errors?: Record<string, string>): ActionState => ({ ok: false, message, errors, values: f ? formValues(f) : undefined });

/** A number from a form; null when blank, NaN when not a number. */
export function numField(f: FormData, k: string): number | null {
  const v = str(f, k, 40).replace(/,/g, "");
  if (v === "") return null;
  return Number(v);
}

/** yyyy-mm-dd (or a datetime-local) → Date, else null. */
export function dateOf(f: FormData, k: string): Date | null {
  const v = str(f, k, 40);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v.length === 16 ? `${v}:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Is this user id a login in the viewer's company? */
export async function tenantUser(viewer: Viewer, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  return (await prisma.user.count({ where: { id: userId, tenantId: viewer.tenantId } })) === 1;
}

/** Recruiters (people who can manage candidates) as select options. */
export async function recruiterOptions(viewer: Viewer): Promise<Array<{ value: string; label: string }>> {
  const ids = [...new Set([...(await usersWithPermission(viewer.tenantId, HP.CANDIDATE_MANAGE)), ...(await usersWithPermission(viewer.tenantId, HP.JOB_MANAGE))])];
  const users = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, isDeactivated: false, id: { in: ids } }, select: { id: true, email: true, employee: { select: { displayName: true } } }, orderBy: { email: "asc" } });
  return users.map((u) => ({ value: u.id, label: u.employee?.displayName ?? u.email }));
}

/** Everyone with a login, as options (assignees, owners). */
export async function userOptions(viewer: Viewer): Promise<Array<{ value: string; label: string }>> {
  const users = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, isDeactivated: false }, select: { id: true, email: true, employee: { select: { displayName: true } } }, orderBy: { email: "asc" }, take: 500 });
  return users.map((u) => ({ value: u.id, label: u.employee?.displayName ?? u.email }));
}

/**
 * Freeze the clauses that apply to this offer (by CTC, department,
 * employment type and the letter's language) into the offer's extras, so the
 * letter that is extended and signed carries exactly these.
 */
export async function resolveOfferClauses(tenantId: string, applicationId: string, opts: { locale?: string; clauseIds?: string[] } = {}): Promise<{ count: number; titles: string[] }> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { offer: true, job: { include: { requisition: { select: { departmentId: true } } } } } });
  if (!app?.offer) return { count: 0, titles: [] };
  const existing = await prisma.offerExtra.findUnique({ where: { applicationId } });
  const locale = opts.locale || existing?.locale || "en";
  const all = (await prisma.offerClause.findMany({ where: { tenantId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { title: "asc" }] })).map((c) => ({ ...c, minCtc: c.minCtc === null ? null : Number(c.minCtc), amount: c.amount === null ? null : Number(c.amount) }));
  const chosen = opts.clauseIds
    ? all.filter((c) => opts.clauseIds!.includes(c.id))
    : applicableClauses(all, { ctc: Number(app.offer.annualCtc), departmentId: app.job.departmentId ?? app.job.requisition?.departmentId ?? null, employmentType: app.job.employmentType, locale });
  const html = chosen.length ? clausesToHtml(chosen) : null;
  await prisma.offerExtra.upsert({ where: { applicationId }, create: { tenantId, applicationId, locale, clauseIds: chosen.map((c) => c.id), clausesHtml: html }, update: { locale, clauseIds: chosen.map((c) => c.id), clausesHtml: html } });
  return { count: chosen.length, titles: chosen.map((c) => c.title) };
}

/** Checklist items still unticked before an offer may be extended. */
export async function offerChecklistMissing(tenantId: string, applicationId: string): Promise<string[]> {
  const items = (await hireDepthConfig(tenantId)).offerChecklist;
  if (!items.length) return [];
  const done = new Set((await prisma.offerChecklistCheck.findMany({ where: { tenantId, applicationId }, select: { item: true } })).map((c) => c.item));
  return items.filter((i) => !done.has(i));
}

/** Panel rules from the job's interview plan, checked against a proposed panel. */
export async function panelRuleProblems(tenantId: string, jobId: string, employeeIds: string[]): Promise<string[]> {
  const plan = await prisma.interviewPlan.findFirst({ where: { tenantId, jobId } });
  if (!plan?.panelRules) return [];
  const job = await prisma.job.findFirst({ where: { id: jobId, tenantId }, include: { requisition: { select: { departmentId: true } } } });
  const panel = await prisma.employee.findMany({ where: { id: { in: employeeIds }, tenantId }, select: { id: true, departmentId: true } });
  return panelProblems(parsePanelRules(plan.panelRules), panel.map((p) => ({ employeeId: p.id, departmentId: p.departmentId })), { hiringManagerId: job?.hiringManagerId ?? null, jobDepartmentId: job?.departmentId ?? job?.requisition?.departmentId ?? null });
}

/**
 * Interviewers who would go over the interview limit set for them in Hire >
 * Interviews > Capacity (per day and per week, UTC weeks from Monday) if
 * booked at `at`. Interviewers without a limit set are not checked here.
 */
export async function capacityProblems(tenantId: string, employeeIds: string[], at: Date, excludeInterviewId?: string): Promise<string[]> {
  const caps = await prisma.interviewerCapacity.findMany({ where: { tenantId, employeeId: { in: employeeIds }, isActive: true } });
  if (!caps.length) return [];
  const names = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: caps.map((c) => c.employeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const day = new Date(at); day.setUTCHours(0, 0, 0, 0);
  const week = new Date(day); week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (const c of caps) {
    const live = (from: Date, to: Date) => ({ employeeId: c.employeeId, interview: { application: { tenantId }, status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] as Array<"SCHEDULED" | "RESCHEDULED" | "COMPLETED"> }, scheduledAt: { gte: from, lt: to }, ...(excludeInterviewId ? { id: { not: excludeInterviewId } } : {}) } });
    const [onDay, inWeek] = await Promise.all([
      prisma.interviewPanelist.count({ where: live(day, new Date(day.getTime() + 86_400_000)) }),
      prisma.interviewPanelist.count({ where: live(week, new Date(week.getTime() + 7 * 86_400_000)) }),
    ]);
    const who = names.get(c.employeeId) ?? "An interviewer";
    if (onDay + 1 > c.maxPerDay) out.push(`${who} already has ${onDay} interview(s) that day (limit ${c.maxPerDay}).`);
    else if (inWeek + 1 > c.maxPerWeek) out.push(`${who} already has ${inWeek} interview(s) that week (limit ${c.maxPerWeek}).`);
  }
  return out;
}

/** Close an application as withdrawn by the candidate, with the reason, and withdraw any open offer. */
export async function closeAsWithdrawn(tenantId: string, applicationId: string, label: string, reasonId: string | null, byWhom: string, byUserId: string | null, note: string | null): Promise<void> {
  await prisma.$transaction([
    prisma.application.update({ where: { id: applicationId }, data: { status: "WITHDRAWN", rejectedAt: new Date(), rejectReason: `Withdrawn: ${label}` } }),
    prisma.applicationStageHistory.updateMany({ where: { applicationId, exitedAt: null }, data: { exitedAt: new Date() } }),
    prisma.offer.updateMany({ where: { applicationId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "EXTENDED"] } }, data: { status: "WITHDRAWN" } }),
    prisma.applicationDisposition.upsert({ where: { applicationId }, create: { tenantId, applicationId, reasonId, kind: "WITHDRAW", label, note, byWhom, byUserId }, update: { reasonId, kind: "WITHDRAW", label, note, byWhom, byUserId } }),
  ]);
}

/**
 * Move an application to a stage through its entry criteria: a résumé or a
 * minimum score when the stage asks for one, and an approval when the stage
 * is gated (the move then happens when the request is approved).
 */
export async function gatedStageMove(viewer: Viewer, applicationId: string, stageId: string, note: string | null): Promise<{ ok: boolean; message: string; pending?: boolean }> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId: viewer.tenantId }, include: { candidate: { select: { firstName: true, lastName: true, resumeUrl: true } }, job: { include: { flow: { include: { stages: true } } } } } });
  if (!app) return { ok: false, message: "Application not found." };
  const stage = app.job.flow?.stages.find((s) => s.id === stageId);
  if (!stage) return { ok: false, message: "That stage is not part of this job's flow." };
  const current = app.job.flow?.stages.find((s) => s.id === app.currentStageId);
  const forward = !current || stage.sequence > current.sequence;
  if (forward) {
    const docs = await prisma.candidateDocument.count({ where: { candidateId: app.candidateId, tenantId: viewer.tenantId } });
    const problem = stageEntryProblem({ name: stage.name, entryMinScore: stage.entryMinScore === null ? null : Number(stage.entryMinScore), entryRequiresResume: stage.entryRequiresResume }, { averageScore: app.averageScore === null ? null : Number(app.averageScore), hasResume: !!app.candidate.resumeUrl || docs > 0 });
    if (problem) return { ok: false, message: problem };
    if (stage.entryRequiresApproval) {
      const r = await startHireRequest({
        tenantId: viewer.tenantId, kind: "STAGE_MOVE", entityId: app.id, title: `Move ${app.candidate.firstName} ${app.candidate.lastName} to ${stage.name} (${app.job.title})`,
        details: note, data: { stageId: stage.id, note, requestedBy: viewer.user.id }, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null,
      });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, pending: r.status === "PENDING", message: r.status === "PENDING" ? `${stage.name} needs an approval; the move happens once it is approved.` : `Moved to ${stage.name}.` };
    }
  }
  return moveStage({ applicationId: app.id, stageId: stage.id, byUserId: viewer.user.id, note });
}
