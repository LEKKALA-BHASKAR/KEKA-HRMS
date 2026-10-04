"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { notify, nineBox, ratingBand, reviewReady, reviewStep, ensureReadinessLevels, ensureBoxLabels } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, formList, type ActionState } from "@/lib/forms";
import { employeeOf, field, dateField, intField } from "@/lib/growth";

/**
 * Succession and talent reviews. A talent review places people on the 9-box
 * (performance × potential) and is signed off by someone other than the
 * person who submitted it. Succession plans name successors for critical
 * positions with a readiness level; nominations, readiness changes on
 * approved successors and the plans themselves each need a second person's
 * approval. Everything here is confidential to SUCCESSION_MANAGE, except
 * that the holder of a critical position may nominate their own successors.
 */

const P = PERMISSIONS;
const PATHS = ["/performance/succession", "/performance/talent-reviews"];
const NO = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ ok: false, message, ...extra });
const LEVELS = ["LOW", "MEDIUM", "HIGH"];

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string) {
  await writeAudit(viewer, { module: "EMPLOYEE", action, entityType, entityId, summary });
}

async function inScope(viewer: Viewer, employeeId: string) {
  const t = await employeeOf(viewer, employeeId);
  return t && canAccessEmployee(viewer, t, P.SUCCESSION_MANAGE) ? t : null;
}

// ---------------------------------------------------------------------------
//  Talent reviews
// ---------------------------------------------------------------------------

async function reviewOf(viewer: Viewer, id: string) {
  return prisma.talentReview.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { entries: true } });
}

export async function saveTalentReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 160);
  if (!name) return NO("Name the talent review.", { errors: { name: "Required" } });
  const departmentId = field(formData, "departmentId", 40) || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return NO("Department not found.");
  const data = { name, description: field(formData, "description") || null, departmentId, meetingAt: dateField(formData, "meetingAt"), agenda: field(formData, "agenda", 4000) || null, notes: field(formData, "notes", 8000) || null };
  const clash = await prisma.talentReview.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: name, mode: "insensitive" }, NOT: id ? { id } : undefined } });
  if (clash) return NO("There is already a talent review with that name.", { errors: { name: "Duplicate" } });
  if (id) {
    const r = await reviewOf(viewer, id);
    if (!r) return NO("Talent review not found.");
    if (r.status === "SUBMITTED" || r.status === "APPROVED") return NO("Reopen the review to change it.");
    await prisma.talentReview.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "TalentReview", id, `Updated talent review "${name}"`);
    return done([...PATHS, `/performance/talent-reviews/${id}`], "Saved.");
  }
  const r = await prisma.talentReview.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await ensureBoxLabels(viewer.tenantId);
  await audit(viewer, "CREATE", "TalentReview", r.id, `Created talent review "${name}"`);
  return { ...done(PATHS, "Talent review created — add the people to review."), values: { reviewId: r.id } };
}

/**
 * Add people — chosen, or a whole department. Their latest calibrated review
 * rating and potential rating pre-fill the grid; the panel can change both.
 */
export async function addReviewParticipantsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const r = await reviewOf(viewer, field(formData, "reviewId", 40));
  if (!r) return NO("Talent review not found.");
  if (r.status === "SUBMITTED" || r.status === "APPROVED") return NO("Reopen the review to add people.");
  let ids = [...new Set(formList(formData, "employeeIds"))];
  const deptId = field(formData, "departmentId", 40);
  if (deptId) {
    const dept = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, departmentId: deptId, status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] } }, select: { id: true } });
    ids = [...new Set([...ids, ...dept.map((d) => d.id)])];
  }
  if (ids.length === 0) return NO("Choose people or a department.");
  const fresh = ids.filter((id) => !r.entries.some((e) => e.employeeId === id));
  let added = 0;
  for (const employeeId of fresh) {
    if (!(await inScope(viewer, employeeId))) continue;
    const last = await prisma.employeeReview.findFirst({ where: { employeeId, OR: [{ finalRating: { not: null } }, { rawRating: { not: null } }] }, orderBy: { updatedAt: "desc" }, include: { cycle: { select: { ratingScale: true } } } });
    const max = Number((last?.cycle.ratingScale as { max?: number } | null)?.max ?? 5);
    const performance = ratingBand(last ? Number(last.finalRating ?? last.rawRating) : null, max);
    const potential = ratingBand(last?.potentialRating !== null && last?.potentialRating !== undefined ? Number(last.potentialRating) : null, max);
    await prisma.talentReviewEntry.create({ data: { reviewId: r.id, employeeId, performance, potential, box: nineBox(performance, potential) } });
    added++;
  }
  if (!added) return NO("Everyone chosen is already in the review or outside your scope.");
  if (r.status === "DRAFT") await prisma.talentReview.update({ where: { id: r.id }, data: { status: "IN_PROGRESS" } });
  await audit(viewer, "UPDATE", "TalentReview", r.id, `Added ${added} people to talent review "${r.name}"`);
  return done([`/performance/talent-reviews/${r.id}`], `${added} added.`);
}

export async function removeReviewParticipantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const e = await prisma.talentReviewEntry.findFirst({ where: { id: field(formData, "entryId", 40), review: { tenantId: viewer.tenantId } }, include: { review: true } });
  if (!e) return NO("Not found.");
  if (e.review.status === "SUBMITTED" || e.review.status === "APPROVED") return NO("Reopen the review to change it.");
  await prisma.talentReviewEntry.delete({ where: { id: e.id } });
  await audit(viewer, "UPDATE", "TalentReview", e.reviewId, `Removed a person from talent review "${e.review.name}"`);
  return done([`/performance/talent-reviews/${e.reviewId}`], "Removed.");
}

/** Place someone on the grid: performance and potential, each 1–3, plus risk and actions. */
export async function rateTalentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const e = await prisma.talentReviewEntry.findFirst({ where: { id: field(formData, "entryId", 40), review: { tenantId: viewer.tenantId } }, include: { review: true, employee: { select: { displayName: true } } } });
  if (!e) return NO("Not found.");
  if (e.review.status === "SUBMITTED" || e.review.status === "APPROVED") return NO("This review is locked for sign-off; reopen it to change ratings.");
  const performance = intField(formData, "performance", 1, 3), potential = intField(formData, "potential", 1, 3);
  if (performance === undefined || potential === undefined || performance === null || potential === null) return NO("Rate performance and potential from 1 (low) to 3 (high).");
  const flightRisk = field(formData, "flightRisk", 10);
  if (flightRisk && !LEVELS.includes(flightRisk)) return NO("Flight risk is low, medium or high.");
  const box = nineBox(performance, potential);
  await prisma.talentReviewEntry.update({
    where: { id: e.id },
    data: { performance, potential, box, flightRisk: flightRisk || null, retentionAction: field(formData, "retentionAction", 1000) || null, notes: field(formData, "notes", 2000) || null, ratedBy: viewer.user.id },
  });
  if (e.review.status === "DRAFT") await prisma.talentReview.update({ where: { id: e.reviewId }, data: { status: "IN_PROGRESS" } });
  await audit(viewer, "UPDATE", "TalentReviewEntry", e.id, `Placed ${e.employee.displayName} in box ${box} (performance ${performance}, potential ${potential}) in "${e.review.name}"`);
  return done([`/performance/talent-reviews/${e.reviewId}`], `Placed in box ${box}.`);
}

export async function talentReviewOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const r = await reviewOf(viewer, field(formData, "reviewId", 40));
  if (!r) return NO("Talent review not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  if (op === "submit") {
    const ready = reviewReady(r.entries);
    if (!ready.ok) return NO(r.entries.length === 0 ? "Add people first." : `Place everyone first — ${ready.unrated} still unrated.`);
  }
  // The review's own status runs DRAFT/IN_PROGRESS → SUBMITTED → APPROVED.
  const current = r.status === "IN_PROGRESS" ? "DRAFT" : r.status;
  const step = reviewStep(current, op, { actor: viewer.user.id, submittedBy: r.submittedBy, note });
  if (!step.ok) return NO(step.message);
  const next = step.next === "DRAFT" || step.next === "REJECTED" ? "IN_PROGRESS" : step.next;
  await prisma.talentReview.update({
    where: { id: r.id },
    data: {
      status: next,
      ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: new Date() } : {}),
      ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}),
    },
  });
  if ((op === "approve" || op === "reject") && r.submittedBy) await notify({ tenantId: viewer.tenantId, userIds: [r.submittedBy], kind: "PERFORMANCE", title: `Talent review ${op === "approve" ? "signed off" : "sent back"}: ${r.name}`, body: note || null, link: `/performance/talent-reviews/${r.id}` });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "TalentReview", r.id, `${op} talent review "${r.name}"${note ? `: ${note}` : ""}`);
  const msg: Record<string, string> = { submit: "Submitted for sign-off.", withdraw: "Withdrawn.", approve: "Signed off — placements are final.", reject: "Sent back for changes.", reopen: "Reopened.", archive: "Archived." };
  return done([...PATHS, `/performance/talent-reviews/${r.id}`], msg[op] ?? "Done.");
}

export async function deleteTalentReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const r = await reviewOf(viewer, field(formData, "reviewId", 40));
  if (!r) return NO("Talent review not found.");
  if (r.status === "APPROVED") return NO("A signed-off review is kept for the record.");
  await prisma.talentReview.delete({ where: { id: r.id } });
  await audit(viewer, "DELETE", "TalentReview", r.id, `Deleted talent review "${r.name}"`);
  return done(PATHS, "Deleted.");
}

/** The company's names for the nine boxes. */
export async function saveBoxLabelsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  await ensureBoxLabels(viewer.tenantId);
  const changes: string[] = [];
  for (let box = 1; box <= 9; box++) {
    const label = field(formData, `label${box}`, 60);
    if (!label) return NO(`Box ${box} needs a name.`, { errors: { [`label${box}`]: "Required" } });
    const description = field(formData, `description${box}`, 300) || null;
    await prisma.talentBoxLabel.update({ where: { tenantId_box: { tenantId: viewer.tenantId, box } }, data: { label, description } });
    changes.push(`${box}=${label}`);
  }
  await audit(viewer, "UPDATE", "TalentBoxLabel", viewer.tenantId, `Renamed the 9-box: ${changes.join(", ")}`);
  return done(PATHS, "9-box labels saved.");
}

// ---------------------------------------------------------------------------
//  Readiness levels
// ---------------------------------------------------------------------------

export async function saveReadinessLevelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  await ensureReadinessLevels(viewer.tenantId);
  const id = field(formData, "id", 40);
  const name = field(formData, "name", 80);
  const code = (field(formData, "code", 30) || name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!name || !code) return NO("Name the readiness level.", { errors: { name: "Required" } });
  const minMonths = intField(formData, "minMonths", 0, 240), maxMonths = intField(formData, "maxMonths", 0, 240), displayOrder = intField(formData, "displayOrder", 0, 100);
  if (minMonths === undefined || maxMonths === undefined || displayOrder === undefined) return NO("Months are whole numbers up to 240.");
  if (maxMonths !== null && maxMonths < (minMonths ?? 0)) return NO("The upper bound cannot be below the lower one.", { errors: { maxMonths: "Below the minimum" } });
  const data = { name, code, description: field(formData, "description", 300) || null, minMonths: minMonths ?? 0, maxMonths, displayOrder: displayOrder ?? 0, isActive: formData.get("isActive") !== "off" };
  const clash = await prisma.readinessLevel.findFirst({ where: { tenantId: viewer.tenantId, code, NOT: id ? { id } : undefined } });
  if (clash) return NO("Another level already uses that code.", { errors: { code: "Duplicate" } });
  if (id) {
    const l = await prisma.readinessLevel.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!l) return NO("Readiness level not found.");
    await prisma.readinessLevel.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "ReadinessLevel", id, `Updated readiness level "${name}"`);
    return done(PATHS, "Saved.");
  }
  const l = await prisma.readinessLevel.create({ data: { ...data, tenantId: viewer.tenantId } });
  await audit(viewer, "CREATE", "ReadinessLevel", l.id, `Added readiness level "${name}"`);
  return done(PATHS, "Readiness level added.");
}

export async function deleteReadinessLevelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const l = await prisma.readinessLevel.findFirst({ where: { id: field(formData, "id", 40), tenantId: viewer.tenantId }, include: { _count: { select: { successors: true } } } });
  if (!l) return NO("Readiness level not found.");
  if (l._count.successors) return NO(`${l._count.successors} successors use this level — deactivate it instead.`);
  await prisma.readinessLevel.delete({ where: { id: l.id } });
  await audit(viewer, "DELETE", "ReadinessLevel", l.id, `Deleted readiness level "${l.name}"`);
  return done(PATHS, "Deleted.");
}

// ---------------------------------------------------------------------------
//  Succession plans
// ---------------------------------------------------------------------------

async function planOf(viewer: Viewer, id: string) {
  return prisma.successionPlan.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { successors: { include: { readiness: true } } } });
}

export async function saveSuccessionPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const id = field(formData, "id", 40);
  const positionTitle = field(formData, "positionTitle", 160);
  if (!positionTitle) return NO("Name the critical position.", { errors: { positionTitle: "Required" } });
  const criticality = field(formData, "criticality", 10) || "HIGH", riskOfLoss = field(formData, "riskOfLoss", 10) || "MEDIUM";
  if (!LEVELS.includes(criticality) || !LEVELS.includes(riskOfLoss)) return NO("Criticality and risk are low, medium or high.");
  const incumbentId = field(formData, "incumbentId", 40) || null;
  if (incumbentId && !(await inScope(viewer, incumbentId))) return NO("That incumbent is outside your scope.");
  const departmentId = field(formData, "departmentId", 40) || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return NO("Department not found.");
  const data = { positionTitle, criticality, riskOfLoss, incumbentId, departmentId, vacancyImpact: field(formData, "vacancyImpact", 1000) || null, notes: field(formData, "notes", 4000) || null };
  const clash = await prisma.successionPlan.findFirst({ where: { tenantId: viewer.tenantId, positionTitle: { equals: positionTitle, mode: "insensitive" }, NOT: id ? { id } : undefined } });
  if (clash) return NO("That position already has a succession plan.", { errors: { positionTitle: "Duplicate" } });
  if (id) {
    const p = await planOf(viewer, id);
    if (!p) return NO("Succession plan not found.");
    if (p.status === "SUBMITTED" || p.status === "APPROVED") return NO("Reopen the plan to change it.");
    if (incumbentId && p.successors.some((s) => s.employeeId === incumbentId)) return NO("The incumbent cannot also be a successor.");
    await prisma.successionPlan.update({ where: { id }, data });
    await audit(viewer, "UPDATE", "SuccessionPlan", id, `Updated succession plan for ${positionTitle}`);
    return done([...PATHS, `/performance/succession/${id}`], "Saved.");
  }
  const p = await prisma.successionPlan.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await ensureReadinessLevels(viewer.tenantId);
  await audit(viewer, "CREATE", "SuccessionPlan", p.id, `Created succession plan for ${positionTitle}`);
  return { ...done(PATHS, "Succession plan created — nominate successors."), values: { planId: p.id } };
}

export async function successionPlanReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const p = await planOf(viewer, field(formData, "planId", 40));
  if (!p) return NO("Succession plan not found.");
  const op = field(formData, "op", 20);
  const note = field(formData, "note", 1000);
  if (op === "submit") {
    if (!p.successors.some((s) => s.status !== "DECLINED")) return NO("Name at least one successor first.");
    if (p.successors.some((s) => s.status === "NOMINATED")) return NO("Decide the open nominations first.");
  }
  const step = reviewStep(p.status, op, { actor: viewer.user.id, submittedBy: p.submittedBy, note });
  if (!step.ok) return NO(step.message);
  await prisma.successionPlan.update({
    where: { id: p.id },
    data: {
      status: step.next,
      ...(op === "submit" ? { submittedBy: viewer.user.id, submittedAt: new Date(), decisionNote: null } : {}),
      ...(op === "approve" || op === "reject" ? { decidedBy: viewer.user.id, decidedAt: new Date(), decisionNote: note || null } : {}),
    },
  });
  if ((op === "approve" || op === "reject") && p.submittedBy) await notify({ tenantId: viewer.tenantId, userIds: [p.submittedBy], kind: "PERFORMANCE", title: `Succession plan ${op === "approve" ? "approved" : "sent back"}: ${p.positionTitle}`, body: note || null, link: `/performance/succession/${p.id}` });
  await audit(viewer, op === "approve" ? "APPROVE" : op === "reject" ? "REJECT" : "UPDATE", "SuccessionPlan", p.id, `${op} succession plan for ${p.positionTitle}${note ? `: ${note}` : ""}`);
  const msg: Record<string, string> = { submit: "Submitted for approval.", withdraw: "Withdrawn.", approve: "Approved.", reject: "Sent back.", reopen: "Reopened for changes.", archive: "Archived." };
  return done([...PATHS, `/performance/succession/${p.id}`], msg[op] ?? "Done.");
}

export async function deleteSuccessionPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const p = await planOf(viewer, field(formData, "planId", 40));
  if (!p) return NO("Succession plan not found.");
  if (p.status === "APPROVED" || p.status === "SUBMITTED") return NO("Archive an approved plan instead.");
  await prisma.successionPlan.delete({ where: { id: p.id } });
  await audit(viewer, "DELETE", "SuccessionPlan", p.id, `Deleted succession plan for ${p.positionTitle}`);
  return done(PATHS, "Deleted.");
}

// ---------------------------------------------------------------------------
//  Successors
// ---------------------------------------------------------------------------

/** HR nominates; so may the person who holds the position. Someone else approves. */
export async function nominateSuccessorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const p = await planOf(viewer, field(formData, "planId", 40));
  if (!p) return NO("Succession plan not found.");
  const hr = can(viewer, P.SUCCESSION_MANAGE);
  const incumbent = !!p.incumbentId && p.incumbentId === viewer.employee?.id;
  if (!hr && !incumbent) return NO("Only HR or the position's holder can nominate successors.");
  if (p.status === "SUBMITTED" || p.status === "ARCHIVED") return NO("This plan is locked.");
  const employeeId = field(formData, "employeeId", 40);
  const t = await employeeOf(viewer, employeeId);
  if (!t || ["EXITED"].includes(t.status)) return NO("Employee not found.");
  if (employeeId === p.incumbentId) return NO("The incumbent cannot succeed themselves.");
  if (p.successors.some((s) => s.employeeId === employeeId && s.status !== "DECLINED")) return NO("Already a successor on this plan.");
  const levels = await ensureReadinessLevels(viewer.tenantId);
  const readiness = levels.find((l) => l.id === field(formData, "readinessId", 40) && l.isActive);
  if (!readiness) return NO("Choose a readiness level.", { errors: { readinessId: "Required" } });
  const rank = intField(formData, "rank", 1, 20);
  if (rank === undefined) return NO("Rank is 1 to 20.");
  const data = { readinessId: readiness.id, rank: rank ?? p.successors.length + 1, isEmergency: formData.get("isEmergency") === "on", notes: field(formData, "notes", 2000) || null, status: "NOMINATED", nominatedBy: viewer.user.id, nominatedAt: new Date(), decidedBy: null, decidedAt: null };
  const old = p.successors.find((s) => s.employeeId === employeeId);
  const s = old ? await prisma.successor.update({ where: { id: old.id }, data }) : await prisma.successor.create({ data: { ...data, planId: p.id, employeeId } });
  const reviewers = await prisma.user.findMany({ where: { tenantId: viewer.tenantId, id: { not: viewer.user.id }, roleAssignments: { some: { role: { permissions: { some: { permission: P.SUCCESSION_MANAGE } } } } } }, select: { id: true } });
  await notify({ tenantId: viewer.tenantId, userIds: reviewers.map((r) => r.id), kind: "PERFORMANCE", title: `Successor nominated for ${p.positionTitle}`, body: `${t.displayName} · ${readiness.name}`, link: `/performance/succession/${p.id}` });
  await audit(viewer, "CREATE", "Successor", s.id, `Nominated ${t.displayName} for ${p.positionTitle} (${readiness.name})`);
  return done([...PATHS, `/performance/succession/${p.id}`], "Nominated — waiting for approval.");
}

export async function decideSuccessorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const s = await prisma.successor.findFirst({ where: { id: field(formData, "successorId", 40), plan: { tenantId: viewer.tenantId } }, include: { plan: true, employee: { select: { displayName: true } } } });
  if (!s) return NO("Successor not found.");
  if (s.status !== "NOMINATED") return NO("This nomination has already been decided.");
  if (s.nominatedBy === viewer.user.id) return NO("You nominated them — someone else has to approve.");
  const decision = field(formData, "decision", 10);
  if (decision !== "approve" && decision !== "decline") return NO("Approve or decline.");
  await prisma.successor.update({ where: { id: s.id }, data: { status: decision === "approve" ? "APPROVED" : "DECLINED", decidedBy: viewer.user.id, decidedAt: new Date() } });
  if (s.nominatedBy) await notify({ tenantId: viewer.tenantId, userIds: [s.nominatedBy], kind: "PERFORMANCE", title: `Successor ${decision === "approve" ? "approved" : "declined"}: ${s.employee.displayName} for ${s.plan.positionTitle}`, link: `/performance/succession/${s.planId}` });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "Successor", s.id, `${decision === "approve" ? "Approved" : "Declined"} ${s.employee.displayName} as successor for ${s.plan.positionTitle}`);
  return done([...PATHS, `/performance/succession/${s.planId}`], decision === "approve" ? "Approved." : "Declined.");
}

/**
 * Change rank, emergency cover or readiness. On an approved successor a
 * readiness change waits for a second person; everything else applies now.
 */
export async function updateSuccessorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const s = await prisma.successor.findFirst({ where: { id: field(formData, "successorId", 40), plan: { tenantId: viewer.tenantId } }, include: { plan: true, readiness: true, employee: { select: { displayName: true } } } });
  if (!s) return NO("Successor not found.");
  if (s.plan.status === "SUBMITTED" || s.plan.status === "ARCHIVED") return NO("This plan is locked.");
  const levels = await ensureReadinessLevels(viewer.tenantId);
  const readiness = levels.find((l) => l.id === field(formData, "readinessId", 40)) ?? s.readiness;
  const rank = intField(formData, "rank", 1, 20);
  if (rank === undefined) return NO("Rank is 1 to 20.");
  const base = { rank: rank ?? s.rank, isEmergency: formData.get("isEmergency") === "on", notes: field(formData, "notes", 2000) || s.notes };
  const readinessChanged = readiness.id !== s.readinessId;
  if (readinessChanged && s.status === "APPROVED") {
    const reason = field(formData, "reason", 1000);
    if (!reason) return NO("Say why readiness changed — it goes for approval.", { errors: { reason: "Required" } });
    await prisma.successor.update({ where: { id: s.id }, data: { ...base, pendingReadinessId: readiness.id, pendingReason: reason, pendingBy: viewer.user.id } });
    await audit(viewer, "UPDATE", "Successor", s.id, `Proposed readiness ${s.readiness.name} → ${readiness.name} for ${s.employee.displayName} (${s.plan.positionTitle}): ${reason}`);
    return done([...PATHS, `/performance/succession/${s.planId}`], "Saved; the readiness change waits for approval.");
  }
  await prisma.successor.update({ where: { id: s.id }, data: { ...base, readinessId: readiness.id } });
  await audit(viewer, "UPDATE", "Successor", s.id, `Updated ${s.employee.displayName} as successor for ${s.plan.positionTitle}${readinessChanged ? ` (readiness ${readiness.name})` : ""}`);
  return done([...PATHS, `/performance/succession/${s.planId}`], "Saved.");
}

export async function decideReadinessChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const s = await prisma.successor.findFirst({ where: { id: field(formData, "successorId", 40), plan: { tenantId: viewer.tenantId } }, include: { plan: true, readiness: true, employee: { select: { displayName: true } } } });
  if (!s || !s.pendingReadinessId) return NO("No readiness change is waiting.");
  if (s.pendingBy === viewer.user.id) return NO("You proposed this change — someone else has to approve it.");
  const decision = field(formData, "decision", 10);
  if (decision !== "approve" && decision !== "decline") return NO("Approve or decline.");
  const next = await prisma.readinessLevel.findFirst({ where: { id: s.pendingReadinessId, tenantId: viewer.tenantId } });
  await prisma.successor.update({ where: { id: s.id }, data: { ...(decision === "approve" && next ? { readinessId: next.id } : {}), pendingReadinessId: null, pendingReason: null, pendingBy: null } });
  await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "Successor", s.id, `${decision === "approve" ? "Approved" : "Declined"} readiness ${s.readiness.name} → ${next?.name ?? "?"} for ${s.employee.displayName} (${s.plan.positionTitle})`);
  return done([...PATHS, `/performance/succession/${s.planId}`], decision === "approve" ? `Readiness is now ${next?.name}.` : "Change declined.");
}

export async function removeSuccessorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const s = await prisma.successor.findFirst({ where: { id: field(formData, "successorId", 40), plan: { tenantId: viewer.tenantId } }, include: { plan: true, employee: { select: { displayName: true } } } });
  if (!s) return NO("Successor not found.");
  if (s.plan.status === "SUBMITTED" || s.plan.status === "ARCHIVED") return NO("This plan is locked.");
  await prisma.successor.delete({ where: { id: s.id } });
  await audit(viewer, "DELETE", "Successor", s.id, `Removed ${s.employee.displayName} from the ${s.plan.positionTitle} plan`);
  return done([...PATHS, `/performance/succession/${s.planId}`], "Removed.");
}

/** Start a development plan for a successor, linked to the succession plan. */
export async function successorDevelopmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const s = await prisma.successor.findFirst({ where: { id: field(formData, "successorId", 40), plan: { tenantId: viewer.tenantId } }, include: { plan: true, employee: { select: { displayName: true, reportingManagerId: true, userId: true } } } });
  if (!s) return NO("Successor not found.");
  if (s.developmentPlanId && (await prisma.developmentPlan.count({ where: { id: s.developmentPlanId } }))) return NO("A development plan is already linked.");
  const start = new Date();
  const dp = await prisma.developmentPlan.create({
    data: {
      tenantId: viewer.tenantId, employeeId: s.employeeId, title: `Readiness for ${s.plan.positionTitle}`, objective: `Build the experience and skills to step into ${s.plan.positionTitle}.`,
      startDate: start, endDate: new Date(start.getTime() + 365 * 86_400_000), status: "DRAFT", managerId: s.employee.reportingManagerId, createdBy: viewer.user.id,
    },
  });
  await prisma.successor.update({ where: { id: s.id }, data: { developmentPlanId: dp.id } });
  await notify({ tenantId: viewer.tenantId, userIds: [s.employee.userId], kind: "PERFORMANCE", title: "A development plan has been started for you", link: "/me/career?tab=development" });
  await audit(viewer, "CREATE", "DevelopmentPlan", dp.id, `Started a development plan for successor ${s.employee.displayName} (${s.plan.positionTitle})`);
  return done([...PATHS, `/performance/succession/${s.planId}`, "/me/career"], "Development plan started; add its actions from Careers.");
}
