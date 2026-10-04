"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, creditPoints, pointsBalanceOf, programEligibility, redemptionCheck, notify,
} from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import { formList, writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Recognition & rewards: programmes (budgets, eligibility, approval),
 * award categories, badges, spot-award nominations decided by the
 * workflow panel, the points ledger, the reward catalog, redemptions with
 * approval and fulfilment, and award revocation.
 */

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => { const v = str(f, k); if (v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
const R = "/engage/rewards";
const PATHS = [R, "/awards"];
const KINDS = ["PEER", "MANAGER", "SPOT", "ANNIVERSARY", "TEAM"];

// ---------------------------------------------------------------------------
//  Programmes
// ---------------------------------------------------------------------------

export async function saveProgramAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const id = str(f, "id");
  const name = str(f, "name");
  const kind = str(f, "kind") || "SPOT";
  const startsOn = day(str(f, "startsOn"));
  const endsOn = day(str(f, "endsOn"));
  const pointsPerAward = num(f, "pointsPerAward") ?? 0;
  const budgetPoints = num(f, "budgetPoints");
  const budgetAmount = num(f, "budgetAmount");
  const minTenureDays = num(f, "minTenureDays") ?? 0;
  const cooldownDays = num(f, "cooldownDays") ?? 0;
  const awardTypeId = str(f, "awardTypeId") || null;
  const departmentIds = formList(f, "departmentIds");
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Required";
  if (!KINDS.includes(kind)) errors.kind = "Pick a kind";
  if (!startsOn) errors.startsOn = "Required";
  if (endsOn && startsOn && endsOn < startsOn) errors.endsOn = "Before the start";
  for (const [k, v] of Object.entries({ pointsPerAward, budgetPoints, budgetAmount, minTenureDays, cooldownDays })) if (v !== null && (Number.isNaN(v) || v < 0)) errors[k] = "Zero or more";
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors };
  const foreign = await foreignReference(viewer.tenantId, { department: departmentIds });
  if (foreign) return { ok: false, message: foreign };
  if (awardTypeId && !(await prisma.awardType.count({ where: { id: awardTypeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Award type not found." };
  const data = {
    name, description: str(f, "description") || null, kind, awardTypeId, pointsPerAward: Math.round(pointsPerAward), budgetPoints: budgetPoints === null ? null : Math.round(budgetPoints),
    budgetAmount, startsOn: startsOn!, endsOn, departmentIds, minTenureDays: Math.round(minTenureDays), cooldownDays: Math.round(cooldownDays),
  };
  try {
    if (id) {
      const p = await prisma.recognitionProgram.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!p) return { ok: false, message: "Programme not found." };
      if (p.status === "PENDING_APPROVAL") return { ok: false, message: "It is waiting for approval; withdraw the request to edit it." };
      // Budgets and eligibility of a live programme can change; it stays live.
      await prisma.recognitionProgram.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecognitionProgram", entityId: id, summary: `Updated programme "${name}"`, oldValue: { budgetPoints: p.budgetPoints, pointsPerAward: p.pointsPerAward, departmentIds: p.departmentIds }, newValue: { budgetPoints: data.budgetPoints, pointsPerAward: data.pointsPerAward, departmentIds } });
      return done(PATHS, "Programme updated.");
    }
    const p = await prisma.recognitionProgram.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "RecognitionProgram", entityId: p.id, summary: `Drafted recognition programme "${name}"` });
    return done(PATHS, "Programme drafted — submit it for approval to launch it.");
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A programme with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
}

export async function programOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const p = await prisma.recognitionProgram.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!p) return { ok: false, message: "Programme not found." };
  const op = str(f, "op");
  if (op === "submit") {
    if (!["DRAFT", "REJECTED"].includes(p.status)) return { ok: false, message: "Only a draft can be submitted." };
    await prisma.recognitionProgram.update({ where: { id: p.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "RECOGNITION_PROGRAM", entityId: p.id, title: `Launch recognition programme: ${p.name}`, details: p.description, amount: p.budgetAmount === null ? null : Number(p.budgetAmount), requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.recognitionProgram.update({ where: { id: p.id }, data: { status: p.status } }); return { ok: false, message: wf.message }; }
    await prisma.recognitionProgram.update({ where: { id: p.id }, data: { workflowRequestId: wf.requestId } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecognitionProgram", entityId: p.id, summary: `Submitted "${p.name}" for approval` });
    return done(PATHS, wf.message);
  }
  if (op === "close") {
    if (p.status !== "ACTIVE") return { ok: false, message: "Only an active programme can be closed." };
    await prisma.recognitionProgram.update({ where: { id: p.id }, data: { status: "CLOSED", endsOn: p.endsOn ?? new Date() } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RecognitionProgram", entityId: p.id, summary: `Closed "${p.name}"` });
    return done(PATHS, "Programme closed.");
  }
  if (op === "delete") {
    if (p.status !== "DRAFT" && p.status !== "REJECTED") return { ok: false, message: "Only a draft can be deleted; close a live programme instead." };
    await prisma.recognitionProgram.delete({ where: { id: p.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "RecognitionProgram", entityId: p.id, summary: `Deleted draft programme "${p.name}"` });
    return done(PATHS, "Draft deleted.");
  }
  if (op === "duplicate") {
    // Programmes double as templates: copy the rules into a new draft for the next period.
    let name = `${p.name} (copy)`;
    for (let i = 2; await prisma.recognitionProgram.count({ where: { tenantId: viewer.tenantId, name } }); i++) name = `${p.name} (copy ${i})`;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const copy = await prisma.recognitionProgram.create({ data: {
      tenantId: viewer.tenantId, name, description: p.description, kind: p.kind, awardTypeId: p.awardTypeId, pointsPerAward: p.pointsPerAward, budgetPoints: p.budgetPoints,
      budgetAmount: p.budgetAmount, startsOn: today, endsOn: null, departmentIds: p.departmentIds, minTenureDays: p.minTenureDays, cooldownDays: p.cooldownDays, createdBy: viewer.user.id,
    } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "RecognitionProgram", entityId: copy.id, summary: `Created "${name}" from "${p.name}"` });
    return { ...done(PATHS, `Copied to a new draft "${name}".`), values: { programId: copy.id } };
  }
  return { ok: false, message: "Unknown operation." };
}

// ---------------------------------------------------------------------------
//  Award categories and badges
// ---------------------------------------------------------------------------

export async function saveAwardTypeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const id = str(f, "id");
  const name = str(f, "name");
  const cadence = str(f, "cadence") || "SPOT";
  const cash = num(f, "cashAmount");
  const points = num(f, "points");
  if (!name) return { ok: false, message: "Name the award.", errors: { name: "Required" } };
  if (!["MONTHLY", "QUARTERLY", "ANNUAL", "SPOT"].includes(cadence)) return { ok: false, message: "Pick a cadence." };
  if ((cash !== null && (Number.isNaN(cash) || cash < 0)) || (points !== null && (Number.isNaN(points) || points < 0))) return { ok: false, message: "Amounts must be zero or more." };
  const data = { name, description: str(f, "description") || null, cadence: cadence as "SPOT", cashAmount: cash, points: points === null ? null : Math.round(points), isActive: f.get("isActive") !== "off" };
  try {
    if (id) {
      const res = await prisma.awardType.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (!res.count) return { ok: false, message: "Award type not found." };
    } else await prisma.awardType.create({ data: { ...data, tenantId: viewer.tenantId } });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "An award with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "AwardType", entityId: id || name, summary: `${id ? "Updated" : "Created"} award category "${name}"` });
  return done(PATHS, "Award category saved.");
}

export async function toggleAwardTypeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const t = await prisma.awardType.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!t) return { ok: false, message: "Award type not found." };
  await prisma.awardType.update({ where: { id: t.id }, data: { isActive: !t.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "AwardType", entityId: t.id, summary: `${t.isActive ? "Retired" : "Reactivated"} award "${t.name}"` });
  return done(PATHS, t.isActive ? "Retired." : "Reactivated.");
}

export async function saveBadgeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const id = str(f, "id");
  const name = str(f, "name");
  if (!name) return { ok: false, message: "Name the badge.", errors: { name: "Required" } };
  const color = str(f, "color") || "#F5B83D";
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, message: "Colour must look like #F5B83D.", errors: { color: "Hex colour" } };
  const data = { name, description: str(f, "description") || null, icon: str(f, "icon") || "star", color, position: Math.round(num(f, "position") ?? 0) || 0 };
  try {
    if (id) {
      const res = await prisma.praiseBadge.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (!res.count) return { ok: false, message: "Badge not found." };
    } else await prisma.praiseBadge.create({ data: { ...data, tenantId: viewer.tenantId } });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A badge with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "PraiseBadge", entityId: id || name, summary: `${id ? "Updated" : "Created"} praise badge "${name}"` });
  return done([...PATHS, "/"], "Badge saved.");
}

export async function toggleBadgeAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const b = await prisma.praiseBadge.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!b) return { ok: false, message: "Badge not found." };
  await prisma.praiseBadge.update({ where: { id: b.id }, data: { isActive: !b.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "PraiseBadge", entityId: b.id, summary: `${b.isActive ? "Hid" : "Restored"} badge "${b.name}"` });
  return done([...PATHS, "/"], b.isActive ? "Badge hidden from the picker." : "Badge restored.");
}

// ---------------------------------------------------------------------------
//  Nominations (spot awards and programme awards)
// ---------------------------------------------------------------------------

export async function nominateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_VIEW);
  if (!viewer.employee) return { ok: false, message: "Only employees can nominate." };
  const nomineeId = str(f, "nomineeId");
  const citation = str(f, "citation");
  const programId = str(f, "programId") || null;
  let awardTypeId = str(f, "awardTypeId") || null;
  if (!nomineeId) return { ok: false, message: "Who are you nominating?", errors: { nomineeId: "Required" } };
  if (nomineeId === viewer.employee.id) return { ok: false, message: "You cannot nominate yourself.", errors: { nomineeId: "Not yourself" } };
  if (citation.length < 20) return { ok: false, message: "Say what they did, in at least 20 characters.", errors: { citation: "Too short" } };
  const nominee = await prisma.employee.findFirst({ where: { id: nomineeId, tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, select: { id: true, displayName: true, departmentId: true, dateOfJoining: true } });
  if (!nominee) return { ok: false, message: "That colleague is not available.", errors: { nomineeId: "Not found" } };
  const program = programId ? await prisma.recognitionProgram.findFirst({ where: { id: programId, tenantId: viewer.tenantId } }) : null;
  if (programId && !program) return { ok: false, message: "Programme not found." };
  if (program) {
    awardTypeId = awardTypeId ?? program.awardTypeId;
    const last = await prisma.employeeAward.findFirst({ where: { tenantId: viewer.tenantId, programId: program.id, employeeId: nominee.id, revokedAt: null }, orderBy: { awardedOn: "desc" }, select: { awardedOn: true } });
    const elig = programEligibility(program, nominee, new Date(), last?.awardedOn);
    if (!elig.ok) return { ok: false, message: elig.reason };
  }
  const type = awardTypeId ? await prisma.awardType.findFirst({ where: { id: awardTypeId, tenantId: viewer.tenantId, isActive: true } }) : null;
  if (!type) return { ok: false, message: "Pick an award.", errors: { awardTypeId: "Required" } };
  const open = await prisma.awardNomination.count({ where: { tenantId: viewer.tenantId, nomineeId: nominee.id, awardTypeId: type.id, status: "PENDING" } });
  if (open) return { ok: false, message: `${nominee.displayName} already has a pending nomination for ${type.name}.` };
  const n = await prisma.awardNomination.create({ data: { tenantId: viewer.tenantId, programId: program?.id ?? null, awardTypeId: type.id, nomineeId: nominee.id, nominatorId: viewer.employee.id, nominatorUserId: viewer.user.id, citation } });
  const wf = await startWorkflow({
    tenantId: viewer.tenantId, entityType: "AWARD_NOMINATION", entityId: n.id, title: `Nomination: ${type.name} for ${nominee.displayName}`, details: citation,
    amount: type.cashAmount === null ? null : Number(type.cashAmount), requesterUserId: viewer.user.id, subjectEmployeeId: nominee.id,
  });
  if (!wf.ok) { await prisma.awardNomination.delete({ where: { id: n.id } }); return { ok: false, message: wf.message }; }
  await prisma.awardNomination.update({ where: { id: n.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "AwardNomination", entityId: n.id, summary: `Nominated ${nominee.displayName} for "${type.name}"` });
  return done(PATHS, wf.message === "Approved automatically." ? "Approved automatically — the award is granted." : "Nomination sent to the nominee's manager and the awards panel.");
}

/** Revoke a granted award: unpublished, its points reversed. A cash award already paid cannot be revoked here. */
export async function revokeAwardAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const reason = str(f, "reason");
  if (reason.length < 5) return { ok: false, message: "Give the reason for revoking it.", errors: { reason: "Required" } };
  const a = await prisma.employeeAward.findFirst({ where: { id: str(f, "awardId"), tenantId: viewer.tenantId }, include: { awardType: true, employee: { select: { displayName: true } } } });
  if (!a) return { ok: false, message: "Award not found." };
  if (a.revokedAt) return { ok: false, message: "Already revoked." };
  if (a.paidInRunId) return { ok: false, message: "Its cash was pushed to payroll; recover it with a payroll deduction before revoking." };
  await prisma.employeeAward.update({ where: { id: a.id }, data: { revokedAt: new Date(), revokeReason: reason, isPublished: false } });
  const earned = await prisma.rewardPointEntry.findFirst({ where: { tenantId: viewer.tenantId, source: "AWARD", sourceId: a.id } });
  if (earned) await creditPoints(viewer.tenantId, { employeeId: a.employeeId, delta: -earned.delta, source: "REVOKE", sourceId: a.id, programId: earned.programId, note: `Revoked: ${reason}`, createdBy: viewer.user.id });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "EmployeeAward", entityId: a.id, summary: `Revoked "${a.awardType.name}" from ${a.employee.displayName}: ${reason}` });
  return done(PATHS, "Award revoked and its points reversed.");
}

/** Edit a granted award's citation or period. */
export async function updateAwardAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const a = await prisma.employeeAward.findFirst({ where: { id: str(f, "awardId"), tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Award not found." };
  const citation = str(f, "citation") || null;
  const period = str(f, "period") || a.period;
  await prisma.employeeAward.update({ where: { id: a.id }, data: { citation, period } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeAward", entityId: a.id, summary: "Edited an award's citation", oldValue: { citation: a.citation, period: a.period }, newValue: { citation, period } });
  return done(PATHS, "Award updated.");
}

// ---------------------------------------------------------------------------
//  Points, catalog and redemptions
// ---------------------------------------------------------------------------

export async function adjustPointsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const delta = num(f, "delta");
  const note = str(f, "note");
  const e = await prisma.employee.findFirst({ where: { id: str(f, "employeeId"), tenantId: viewer.tenantId }, select: { id: true, userId: true, displayName: true } });
  if (!e) return { ok: false, message: "Pick an employee.", errors: { employeeId: "Required" } };
  if (delta === null || Number.isNaN(delta) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return { ok: false, message: "Enter a whole number of points, positive or negative.", errors: { delta: "Whole number" } };
  if (!note) return { ok: false, message: "Say why.", errors: { note: "Required" } };
  if (delta < 0 && (await pointsBalanceOf(viewer.tenantId, e.id)) + delta < 0) return { ok: false, message: "That would take the balance below zero." };
  await creditPoints(viewer.tenantId, { employeeId: e.id, delta, source: "ADJUSTMENT", sourceId: `${Date.now()}-${viewer.user.id}`, note, createdBy: viewer.user.id });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RewardPoints", entityId: e.id, summary: `Adjusted ${e.displayName}'s points by ${delta > 0 ? "+" : ""}${delta}: ${note}` });
  await notify({ tenantId: viewer.tenantId, userIds: [e.userId], kind: "ENGAGE", title: `${delta > 0 ? `${delta} reward points added` : `${-delta} reward points deducted`}`, body: note, link: R });
  return done(PATHS, "Points adjusted.");
}

export async function saveRewardItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const id = str(f, "id");
  const name = str(f, "name");
  const cost = num(f, "pointsCost");
  const stock = num(f, "stock");
  const category = str(f, "category") || "VOUCHER";
  if (!name) return { ok: false, message: "Name the reward.", errors: { name: "Required" } };
  if (cost === null || Number.isNaN(cost) || !Number.isInteger(cost) || cost < 1) return { ok: false, message: "Cost is a whole number of points.", errors: { pointsCost: "1 or more" } };
  if (stock !== null && (Number.isNaN(stock) || !Number.isInteger(stock) || stock < 0)) return { ok: false, message: "Stock is a whole number (blank = unlimited).", errors: { stock: "0 or more" } };
  if (!["VOUCHER", "MERCHANDISE", "EXPERIENCE", "CHARITY", "TIME_OFF"].includes(category)) return { ok: false, message: "Pick a category." };
  const data = { name, description: str(f, "description") || null, category, pointsCost: cost, stock };
  try {
    if (id) {
      const res = await prisma.rewardItem.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (!res.count) return { ok: false, message: "Reward not found." };
    } else await prisma.rewardItem.create({ data: { ...data, tenantId: viewer.tenantId } });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A reward with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: id ? "UPDATE" : "CREATE", entityType: "RewardItem", entityId: id || name, summary: `${id ? "Updated" : "Added"} reward "${name}" at ${cost} points${stock === null ? "" : `, stock ${stock}`}` });
  return done(PATHS, "Reward saved.");
}

export async function toggleRewardItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const i = await prisma.rewardItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!i) return { ok: false, message: "Reward not found." };
  await prisma.rewardItem.update({ where: { id: i.id }, data: { isActive: !i.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RewardItem", entityId: i.id, summary: `${i.isActive ? "Withdrew" : "Re-listed"} reward "${i.name}"` });
  return done(PATHS, i.isActive ? "Withdrawn from the catalog." : "Back in the catalog.");
}

/** Redeem points: they are held (debited) at once and refunded if the request is rejected or withdrawn. */
export async function redeemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can redeem points." };
  const item = await prisma.rewardItem.findFirst({ where: { id: str(f, "itemId"), tenantId: viewer.tenantId } });
  if (!item) return { ok: false, message: "Reward not found." };
  const quantity = Number(str(f, "quantity") || "1");
  const balance = await pointsBalanceOf(viewer.tenantId, viewer.employee.id);
  const problem = redemptionCheck({ balance, cost: item.pointsCost, quantity, stock: item.stock, active: item.isActive });
  if (problem) return { ok: false, message: problem };
  const points = item.pointsCost * quantity;
  const r = await prisma.rewardRedemption.create({ data: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, itemId: item.id, itemName: item.name, points, quantity, deliveryNote: str(f, "deliveryNote") || null } });
  await creditPoints(viewer.tenantId, { employeeId: viewer.employee.id, delta: -points, source: "REDEMPTION", sourceId: r.id, note: `Redeemed ${quantity} × ${item.name}`, createdBy: viewer.user.id });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "REWARD_REDEMPTION", entityId: r.id, title: `Redeem ${quantity} × ${item.name} (${points} points)`, details: r.deliveryNote, amount: points, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee.id });
  if (!wf.ok) {
    await prisma.rewardPointEntry.deleteMany({ where: { tenantId: viewer.tenantId, source: "REDEMPTION", sourceId: r.id } });
    await prisma.rewardRedemption.delete({ where: { id: r.id } });
    return { ok: false, message: wf.message };
  }
  await prisma.rewardRedemption.update({ where: { id: r.id }, data: { workflowRequestId: wf.requestId } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "RewardRedemption", entityId: r.id, summary: `Requested ${quantity} × ${item.name} for ${points} points` });
  return done(PATHS, `Requested. ${points} points are held until it is approved.`);
}

export async function fulfilRedemptionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const r = await prisma.rewardRedemption.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Redemption not found." };
  if (r.status !== "APPROVED") return { ok: false, message: "Only an approved redemption can be fulfilled." };
  const note = str(f, "note");
  if (!note) return { ok: false, message: "Record how it was fulfilled (voucher code, courier ref…)." };
  await prisma.rewardRedemption.update({ where: { id: r.id }, data: { status: "FULFILLED", fulfilledAt: new Date(), fulfilledBy: viewer.user.id, fulfilmentNote: note } });
  const emp = await prisma.employee.findFirst({ where: { id: r.employeeId, tenantId: viewer.tenantId }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: [emp?.userId], kind: "ENGAGE", title: `Your reward is on its way: ${r.itemName}`, body: note, link: `${R}?tab=wallet`, email: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "RewardRedemption", entityId: r.id, summary: `Fulfilled ${r.quantity} × ${r.itemName}: ${note}` });
  return done(PATHS, "Marked fulfilled; the employee is notified.");
}
