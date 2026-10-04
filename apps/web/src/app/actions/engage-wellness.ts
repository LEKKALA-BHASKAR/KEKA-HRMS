"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { startWorkflow, creditPoints, challengeProgress, isoWeekStart, notify, usersWithPermission } from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import { formList, writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Wellness & employee services: wellness programmes and challenges
 * (approval, enrolment with consent, progress logs, completion points),
 * anonymous wellbeing check-ins, the employee service catalog with
 * approval and fulfilment, and the support resource library (EAP,
 * helplines, providers, benefit services, articles).
 */

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => { const v = str(f, k); if (v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const W = "/engage/wellness";
const S = "/engage/services";

// ---------------------------------------------------------------------------
//  Wellness programmes
// ---------------------------------------------------------------------------

const CATEGORIES = ["FITNESS", "MENTAL", "NUTRITION", "SLEEP", "FINANCIAL", "SCREENING"];

export async function saveWellnessProgramAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WELLNESS_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title");
  const category = str(f, "category") || "FITNESS";
  const kind = str(f, "kind") || "CHALLENGE";
  const startsOn = day(str(f, "startsOn")), endsOn = day(str(f, "endsOn"));
  const goalValue = num(f, "goalValue"), capacity = num(f, "capacity"), pointsReward = num(f, "pointsReward") ?? 0;
  const departmentIds = formList(f, "departmentIds");
  const errors: Record<string, string> = {};
  if (!title) errors.title = "Required";
  if (!CATEGORIES.includes(category)) errors.category = "Pick one";
  if (!["PROGRAM", "CHALLENGE", "EVENT"].includes(kind)) errors.kind = "Pick one";
  if (!startsOn) errors.startsOn = "Required";
  if (!endsOn) errors.endsOn = "Required";
  if (startsOn && endsOn && endsOn < startsOn) errors.endsOn = "Before the start";
  if (kind === "CHALLENGE" && (goalValue === null || Number.isNaN(goalValue) || goalValue <= 0)) errors.goalValue = "A challenge needs a goal";
  if (capacity !== null && (Number.isNaN(capacity) || capacity < 1)) errors.capacity = "1 or more";
  if (Number.isNaN(pointsReward) || pointsReward < 0) errors.pointsReward = "0 or more";
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors };
  const foreign = await foreignReference(viewer.tenantId, { department: departmentIds });
  if (foreign) return { ok: false, message: foreign };
  const data = {
    title, description: str(f, "description") || null, category, kind, startsOn: startsOn!, endsOn: endsOn!, goalValue: goalValue === null ? null : Math.round(goalValue),
    goalUnit: str(f, "goalUnit") || null, capacity: capacity === null ? null : Math.round(capacity), departmentIds, providerName: str(f, "providerName") || null,
    pointsReward: Math.round(pointsReward), requireConsent: f.get("requireConsent") === "on",
  };
  if (id) {
    const p = await prisma.wellnessProgram.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!p) return { ok: false, message: "Programme not found." };
    if (p.status === "PENDING_APPROVAL") return { ok: false, message: "It is waiting for approval." };
    await prisma.wellnessProgram.update({ where: { id }, data });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WellnessProgram", entityId: id, summary: `Updated wellness programme "${title}"` });
    return done([W], "Programme updated.");
  }
  const p = await prisma.wellnessProgram.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WellnessProgram", entityId: p.id, summary: `Drafted wellness ${kind.toLowerCase()} "${title}"` });
  return done([W], "Drafted — submit it for approval to open enrolment.");
}

export async function wellnessProgramOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WELLNESS_MANAGE);
  const p = await prisma.wellnessProgram.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!p) return { ok: false, message: "Programme not found." };
  const op = str(f, "op");
  if (op === "submit") {
    if (!["DRAFT", "REJECTED"].includes(p.status)) return { ok: false, message: "Only a draft can be submitted." };
    await prisma.wellnessProgram.update({ where: { id: p.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "WELLNESS_PROGRAM", entityId: p.id, title: `Launch wellness ${p.kind.toLowerCase()}: ${p.title}`, details: p.description, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.wellnessProgram.update({ where: { id: p.id }, data: { status: p.status } }); return { ok: false, message: wf.message }; }
    await prisma.wellnessProgram.update({ where: { id: p.id }, data: { workflowRequestId: wf.requestId } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WellnessProgram", entityId: p.id, summary: `Submitted "${p.title}" for approval` });
    return done([W], wf.message);
  }
  if (op === "close") {
    if (p.status !== "ACTIVE") return { ok: false, message: "Only a live programme can be closed." };
    await prisma.wellnessProgram.update({ where: { id: p.id }, data: { status: "CLOSED" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WellnessProgram", entityId: p.id, summary: `Closed "${p.title}"` });
    return done([W], "Closed.");
  }
  if (op === "delete") {
    if (!["DRAFT", "REJECTED"].includes(p.status)) return { ok: false, message: "Only a draft can be deleted." };
    await prisma.wellnessProgram.delete({ where: { id: p.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "WellnessProgram", entityId: p.id, summary: `Deleted draft "${p.title}"` });
    return done([W], "Deleted.");
  }
  return { ok: false, message: "Unknown operation." };
}

export async function enrolAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can enrol." };
  const p = await prisma.wellnessProgram.findFirst({ where: { id: str(f, "programId"), tenantId: viewer.tenantId }, include: { _count: { select: { enrollments: { where: { status: { not: "WITHDRAWN" } } } } } } });
  if (!p || p.status !== "ACTIVE") return { ok: false, message: "This programme is not open for enrolment." };
  if (p.endsOn < new Date(new Date().toISOString().slice(0, 10))) return { ok: false, message: "This programme has ended." };
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { departmentId: true } });
  if (p.departmentIds.length && !p.departmentIds.includes(me.departmentId ?? "")) return { ok: false, message: "This programme is not open to your department." };
  const consent = f.get("consent") === "on";
  if (p.requireConsent && !consent) return { ok: false, message: "Tick the consent box to take part.", errors: { consent: "Required" } };
  const existing = await prisma.wellnessEnrollment.findUnique({ where: { programId_employeeId: { programId: p.id, employeeId: viewer.employee.id } } });
  if (existing && existing.status !== "WITHDRAWN") return { ok: false, message: "You are already enrolled." };
  if (p.capacity !== null && p._count.enrollments >= p.capacity) return { ok: false, message: "This programme is full." };
  const data = { status: "ENROLLED", consentAt: consent ? new Date() : null, showOnBoard: f.get("showOnBoard") === "on" };
  if (existing) await prisma.wellnessEnrollment.update({ where: { id: existing.id }, data });
  else await prisma.wellnessEnrollment.create({ data: { programId: p.id, employeeId: viewer.employee.id, ...data } });
  return done([W], `You are enrolled in ${p.title}.`);
}

export async function withdrawEnrolmentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await prisma.wellnessEnrollment.findFirst({ where: { id: str(f, "id"), employeeId: viewer.employee?.id ?? "-", program: { tenantId: viewer.tenantId } } });
  if (!e) return { ok: false, message: "Enrolment not found." };
  if (e.status !== "ENROLLED") return { ok: false, message: "Nothing to withdraw." };
  await prisma.wellnessEnrollment.update({ where: { id: e.id }, data: { status: "WITHDRAWN" } });
  return done([W], "Withdrawn. Your logged progress is kept if you re-join.");
}

export async function logProgressAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await prisma.wellnessEnrollment.findFirst({ where: { id: str(f, "enrollmentId"), employeeId: viewer.employee?.id ?? "-", program: { tenantId: viewer.tenantId } }, include: { program: true } });
  if (!e) return { ok: false, message: "Enrolment not found." };
  if (e.status === "WITHDRAWN") return { ok: false, message: "You have withdrawn from this programme." };
  if (e.program.status !== "ACTIVE") return { ok: false, message: "The programme is not live." };
  const value = num(f, "value");
  const on = day(str(f, "loggedOn")) ?? new Date(new Date().toISOString().slice(0, 10));
  if (value === null || Number.isNaN(value) || !Number.isInteger(value) || value <= 0 || value > 1_000_000) return { ok: false, message: "Log a positive whole number.", errors: { value: "Whole number" } };
  if (on < e.program.startsOn || on > e.program.endsOn) return { ok: false, message: "That date is outside the programme.", errors: { loggedOn: "Outside the programme" } };
  if (on.getTime() > Date.now()) return { ok: false, message: "You cannot log the future.", errors: { loggedOn: "In the future" } };
  await prisma.wellnessLog.create({ data: { enrollmentId: e.id, value, note: str(f, "note") || null, loggedOn: on } });
  const total = e.progress + value;
  const prog = challengeProgress(total, e.program.goalValue);
  const completedNow = prog.completed && e.status !== "COMPLETED";
  await prisma.wellnessEnrollment.update({ where: { id: e.id }, data: { progress: total, ...(completedNow ? { status: "COMPLETED", completedAt: new Date() } : {}) } });
  if (completedNow && e.program.pointsReward > 0) {
    await creditPoints(viewer.tenantId, { employeeId: e.employeeId, delta: e.program.pointsReward, source: "WELLNESS", sourceId: e.id, note: `Completed ${e.program.title}` });
  }
  return done([W], completedNow ? `Goal reached — well done!${e.program.pointsReward ? ` ${e.program.pointsReward} points added.` : ""}` : `Logged. ${prog.pct}% of the goal.`);
}

/** Anonymous weekly wellbeing check-in. */
export async function checkInAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can check in." };
  const mood = Number(str(f, "mood")), stress = Number(str(f, "stress"));
  if (!Number.isInteger(mood) || mood < 1 || mood > 5) return { ok: false, message: "Pick how you are feeling (1–5).", errors: { mood: "1–5" } };
  if (!Number.isInteger(stress) || stress < 1 || stress > 5) return { ok: false, message: "Pick your stress level (1–5).", errors: { stress: "1–5" } };
  const week = isoWeekStart(new Date());
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { departmentId: true, locationId: true } });
  const wantsSupport = f.get("wantsSupport") === "on";
  if (await prisma.wellbeingCheckInMark.findUnique({ where: { employeeId_week: { employeeId: viewer.employee.id, week } } })) return { ok: false, message: "You have already checked in this week." };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.wellbeingCheckInMark.create({ data: { tenantId: viewer.tenantId, employeeId: viewer.employee!.id, week } });
      await tx.wellbeingCheckIn.create({ data: { tenantId: viewer.tenantId, week, departmentId: me.departmentId, locationId: me.locationId, mood, stress, wantsSupport, note: str(f, "note").slice(0, 500) || null } });
    });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "You have already checked in this week." };
    throw err;
  }
  return done([W], wantsSupport ? "Thank you. Support options are listed under Support — reaching out is confidential." : "Thank you for checking in.");
}

// ---------------------------------------------------------------------------
//  Employee service catalog
// ---------------------------------------------------------------------------

const SERVICE_CATEGORIES = ["ID_CARD", "PARKING", "VISA_LETTER", "TRANSPORT", "CAFETERIA", "WORKSPACE", "ERGONOMICS", "ACCOMMODATION", "WELLNESS_APPOINTMENT", "EAP", "FACILITY", "OTHER"];

export async function saveServiceTypeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SERVICE_MANAGE);
  const id = str(f, "id");
  const name = str(f, "name");
  const category = str(f, "category") || "OTHER";
  const slaDays = num(f, "slaDays") ?? 3;
  if (!name) return { ok: false, message: "Name the service.", errors: { name: "Required" } };
  if (!SERVICE_CATEGORIES.includes(category)) return { ok: false, message: "Pick a category." };
  if (Number.isNaN(slaDays) || slaDays < 1 || slaDays > 60) return { ok: false, message: "Turnaround is 1 to 60 days.", errors: { slaDays: "1–60" } };
  const fields = str(f, "fields").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const data = { name, description: str(f, "description") || null, category, fields, requiresApproval: f.get("requiresApproval") === "on", confidential: f.get("confidential") === "on", slaDays: Math.round(slaDays) };
  try {
    if (id) {
      const res = await prisma.serviceType.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (!res.count) return { ok: false, message: "Service not found." };
    } else await prisma.serviceType.create({ data: { ...data, tenantId: viewer.tenantId } });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A service with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "ServiceType", entityId: id || name, summary: `${id ? "Updated" : "Added"} employee service "${name}"` });
  return done([S], "Service saved.");
}

export async function toggleServiceTypeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SERVICE_MANAGE);
  const t = await prisma.serviceType.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!t) return { ok: false, message: "Service not found." };
  await prisma.serviceType.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ServiceType", entityId: t.id, summary: `${t.isActive ? "Withdrew" : "Re-listed"} service "${t.name}"` });
  return done([S], t.isActive ? "Withdrawn from the catalog." : "Back in the catalog.");
}

export async function requestServiceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can raise service requests." };
  const t = await prisma.serviceType.findFirst({ where: { id: str(f, "typeId"), tenantId: viewer.tenantId, isActive: true } });
  if (!t) return { ok: false, message: "That service is not available." };
  const answers: Record<string, string> = {};
  const errors: Record<string, string> = {};
  t.fields.forEach((label, i) => { const v = str(f, `f_${i}`); if (!v) errors[`f_${i}`] = "Required"; answers[label] = v.slice(0, 500); });
  if (Object.keys(errors).length) return { ok: false, message: "Fill in every field.", errors };
  const details = str(f, "details").slice(0, 2000) || null;
  const sr = await prisma.serviceRequest.create({
    data: { tenantId: viewer.tenantId, typeId: t.id, employeeId: viewer.employee.id, requesterUserId: viewer.user.id, answers, details, status: t.requiresApproval ? "PENDING_APPROVAL" : "OPEN", dueOn: t.requiresApproval ? null : new Date(Date.now() + t.slaDays * 86_400_000) },
  });
  if (t.requiresApproval) {
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "SERVICE_REQUEST", entityId: sr.id, title: `${t.name} request`, details: t.confidential ? "Confidential request" : details, category: t.category, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee.id });
    if (!wf.ok) { await prisma.serviceRequest.delete({ where: { id: sr.id } }); return { ok: false, message: wf.message }; }
    await prisma.serviceRequest.update({ where: { id: sr.id }, data: { workflowRequestId: wf.requestId } });
  } else {
    await notify({ tenantId: viewer.tenantId, userIds: await usersWithPermission(viewer.tenantId, P.SERVICE_MANAGE), kind: "ENGAGE", title: `Service request to fulfil: ${t.name}`, link: `${S}?tab=queue` });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ServiceRequest", entityId: sr.id, summary: `Requested "${t.name}"` });
  return done([S], t.requiresApproval ? "Requested — it goes to your manager for approval first." : "Requested — the service team has it.");
}

/** Fulfilment team: pick up, fulfil or reject; the requester can cancel while it is open. */
export async function serviceRequestOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const sr = await prisma.serviceRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!sr) return { ok: false, message: "Request not found." };
  const op = str(f, "op");
  const mine = sr.requesterUserId === viewer.user.id;
  if (op === "cancel") {
    if (!mine) return { ok: false, message: "Only the requester can cancel." };
    if (!["OPEN", "IN_PROGRESS"].includes(sr.status)) return { ok: false, message: sr.status === "PENDING_APPROVAL" ? "Withdraw it from My requests while it waits for approval." : "It can no longer be cancelled." };
    await prisma.serviceRequest.update({ where: { id: sr.id }, data: { status: "CANCELLED" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ServiceRequest", entityId: sr.id, summary: "Cancelled a service request" });
    return done([S], "Cancelled.");
  }
  if (!can(viewer, P.SERVICE_MANAGE)) return { ok: false, message: "Only the service team can do that." };
  if (mine) return { ok: false, message: "You cannot fulfil your own request." };
  const note = str(f, "note");
  const owner = await prisma.employee.findFirst({ where: { id: sr.employeeId, tenantId: viewer.tenantId }, select: { userId: true } });
  if (op === "start") {
    if (sr.status !== "OPEN") return { ok: false, message: "Only an open request can be picked up." };
    await prisma.serviceRequest.update({ where: { id: sr.id }, data: { status: "IN_PROGRESS", assignedToUserId: viewer.user.id } });
  } else if (op === "fulfil") {
    if (!["OPEN", "IN_PROGRESS"].includes(sr.status)) return { ok: false, message: "Only an open request can be fulfilled." };
    if (!note) return { ok: false, message: "Note what was done (card number, slot, letter reference…)." };
    await prisma.serviceRequest.update({ where: { id: sr.id }, data: { status: "FULFILLED", fulfilledAt: new Date(), fulfilmentNote: note, assignedToUserId: sr.assignedToUserId ?? viewer.user.id } });
    await notify({ tenantId: viewer.tenantId, userIds: [owner?.userId], kind: "ENGAGE", title: "Your service request is done", body: note, link: `${S}?tab=mine`, email: true });
  } else if (op === "reject") {
    if (!["OPEN", "IN_PROGRESS"].includes(sr.status)) return { ok: false, message: "Only an open request can be declined." };
    if (!note) return { ok: false, message: "Say why it cannot be done." };
    await prisma.serviceRequest.update({ where: { id: sr.id }, data: { status: "REJECTED", fulfilmentNote: note } });
    await notify({ tenantId: viewer.tenantId, userIds: [owner?.userId], kind: "ENGAGE", title: "Your service request was declined", body: note, link: `${S}?tab=mine` });
  } else return { ok: false, message: "Unknown operation." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ServiceRequest", entityId: sr.id, summary: `Service request ${op}${note ? `: ${note}` : ""}` });
  return done([S], op === "start" ? "Picked up." : op === "fulfil" ? "Fulfilled; the employee is notified." : "Declined.");
}

export async function rateServiceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const sr = await prisma.serviceRequest.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, requesterUserId: viewer.user.id } });
  if (!sr) return { ok: false, message: "Request not found." };
  if (sr.status !== "FULFILLED") return { ok: false, message: "Rate it once it is fulfilled." };
  const rating = Number(str(f, "rating"));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, message: "Rate 1 to 5." };
  await prisma.serviceRequest.update({ where: { id: sr.id }, data: { rating, ratingComment: str(f, "comment").slice(0, 500) || null } });
  return done([S], "Thanks for the feedback.");
}

// ---------------------------------------------------------------------------
//  Support resources (EAP, helplines, providers, benefit services, articles)
// ---------------------------------------------------------------------------

export async function saveResourceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WELLNESS_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title");
  const kind = str(f, "kind") || "ARTICLE";
  const url = str(f, "url") || null;
  const email = str(f, "email") || null;
  if (!title) return { ok: false, message: "Give it a title.", errors: { title: "Required" } };
  if (!["EAP", "HELPLINE", "PROVIDER", "BENEFIT", "ARTICLE"].includes(kind)) return { ok: false, message: "Pick a kind." };
  if (url && !/^https:\/\/[^\s]+$/.test(url)) return { ok: false, message: "Links must start with https://", errors: { url: "https:// only" } };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "That email does not look right.", errors: { email: "Invalid" } };
  const data = { title, kind, description: str(f, "description") || null, url, phone: str(f, "phone") || null, email, tags: str(f, "tags").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8) };
  if (id) {
    const r = await prisma.supportResource.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!r) return { ok: false, message: "Resource not found." };
    // Editing published content sends it back through review.
    await prisma.supportResource.update({ where: { id }, data: { ...data, status: r.status === "PUBLISHED" ? "DRAFT" : r.status } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SupportResource", entityId: id, summary: `Edited support resource "${title}"${r.status === "PUBLISHED" ? " (back to draft for review)" : ""}` });
    return done([W], r.status === "PUBLISHED" ? "Saved as a draft — submit it to republish." : "Saved.");
  }
  const r = await prisma.supportResource.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "SupportResource", entityId: r.id, summary: `Drafted support resource "${title}"` });
  return done([W], "Drafted — submit it for review to publish.");
}

export async function resourceOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.WELLNESS_MANAGE);
  const r = await prisma.supportResource.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Resource not found." };
  const op = str(f, "op");
  if (op === "submit") {
    if (!["DRAFT", "REJECTED", "ARCHIVED"].includes(r.status)) return { ok: false, message: "Only a draft can be submitted." };
    await prisma.supportResource.update({ where: { id: r.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "SUPPORT_RESOURCE", entityId: r.id, title: `Publish support resource: ${r.title}`, details: r.description, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.supportResource.update({ where: { id: r.id }, data: { status: r.status } }); return { ok: false, message: wf.message }; }
    await prisma.supportResource.update({ where: { id: r.id }, data: { workflowRequestId: wf.requestId } });
    return done([W], wf.message);
  }
  if (op === "archive") {
    if (r.status !== "PUBLISHED") return { ok: false, message: "Only a published resource can be archived." };
    await prisma.supportResource.update({ where: { id: r.id }, data: { status: "ARCHIVED" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "SupportResource", entityId: r.id, summary: `Archived "${r.title}"` });
    return done([W], "Archived.");
  }
  if (op === "delete") {
    if (r.status === "PUBLISHED" || r.status === "PENDING_APPROVAL") return { ok: false, message: "Archive it first." };
    await prisma.supportResource.delete({ where: { id: r.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "SupportResource", entityId: r.id, summary: `Deleted "${r.title}"` });
    return done([W], "Deleted.");
  }
  return { ok: false, message: "Unknown operation." };
}
