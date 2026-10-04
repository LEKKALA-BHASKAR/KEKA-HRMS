import { prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { scheduleInterview } from "./recruitment";
import { newOfferToken, hashOfferToken, offerTokenSigned } from "./offers-math";
import { appBaseUrl } from "./offers";
import { pickApprovalRule, chainApprovers, cleanSlots, type ApprovalRuleShape } from "./talent-math";

export * from "./talent-math";

/**
 * Talent depth — database pieces: multi-level approval chains for
 * requisitions and offers, and candidate self-scheduling by tokenised link.
 */

type R = { ok: boolean; message: string };
export type HireChainKind = "REQUISITION" | "OFFER";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

export function ruleShape(r: { id: string; departmentId: string | null; minAmount: unknown; approverUserIds: unknown; priority: number; isActive: boolean }): ApprovalRuleShape {
  return {
    id: r.id, departmentId: r.departmentId, minAmount: r.minAmount === null || r.minAmount === undefined ? null : Number(r.minAmount),
    approverUserIds: Array.isArray(r.approverUserIds) ? (r.approverUserIds as unknown[]).map(String) : [], priority: r.priority, isActive: r.isActive,
  };
}

/**
 * Start (or restart) the approval chain for a requisition or offer. The first
 * matching rule decides who approves, in order; open steps from an earlier
 * chain are cancelled. Returns the first approver, or null when no rule
 * matches and the module's ordinary approval applies.
 */
export async function startHireChain(opts: { tenantId: string; kind: HireChainKind; entityId: string; departmentId: string | null; amount: number | null; requesterUserId: string | null }): Promise<{ firstApprover: string | null; steps: number; ruleName?: string }> {
  const rules = (await prisma.hireApprovalRule.findMany({ where: { tenantId: opts.tenantId, kind: opts.kind, isActive: true } })).map((r) => ({ ...ruleShape(r), name: r.name }));
  const rule = pickApprovalRule(rules, { departmentId: opts.departmentId, amount: opts.amount });
  await prisma.hireApprovalStep.updateMany({ where: { tenantId: opts.tenantId, kind: opts.kind, entityId: opts.entityId, status: { in: ["WAITING", "PENDING"] } }, data: { status: "CANCELLED" } });
  if (!rule) return { firstApprover: null, steps: 0 };
  const wanted = chainApprovers(rule.approverUserIds, opts.requesterUserId);
  const active = new Set((await prisma.user.findMany({ where: { tenantId: opts.tenantId, id: { in: wanted }, loginDisabled: false, isDeactivated: false }, select: { id: true } })).map((u) => u.id));
  const approvers = wanted.filter((u) => active.has(u));
  if (approvers.length === 0) return { firstApprover: null, steps: 0 };
  const round = await prisma.hireApprovalStep.count({ where: { tenantId: opts.tenantId, kind: opts.kind, entityId: opts.entityId } });
  await prisma.hireApprovalStep.createMany({
    data: approvers.map((approverUserId, i) => ({
      tenantId: opts.tenantId, kind: opts.kind, entityId: opts.entityId, ruleId: rule.id,
      sequence: round + i + 1, approverUserId, status: i === 0 ? "PENDING" : "WAITING",
    })),
  });
  return { firstApprover: approvers[0], steps: approvers.length, ruleName: rule.name };
}

/** The live chain for an entity: its steps in order, and the one waiting now. */
export async function hireChain(tenantId: string, kind: HireChainKind, entityId: string) {
  const steps = await prisma.hireApprovalStep.findMany({ where: { tenantId, kind, entityId, status: { not: "CANCELLED" } }, orderBy: { sequence: "asc" } });
  return { steps, pending: steps.find((s) => s.status === "PENDING") ?? null };
}

/**
 * Record one approver's decision. `final` is true when this decision settles
 * the chain (the last approval, or any rejection); otherwise `next` is the
 * approver now waited on. `handled` is false when the entity has no chain.
 */
export async function decideHireStep(opts: { tenantId: string; kind: HireChainKind; entityId: string; userId: string; approve: boolean; comment?: string | null }): Promise<R & { handled: boolean; final?: boolean; next?: string | null }> {
  const { pending } = await hireChain(opts.tenantId, opts.kind, opts.entityId);
  if (!pending) return { handled: false, ok: true, message: "" };
  if (pending.approverUserId !== opts.userId) return { handled: true, ok: false, message: "it is waiting on another approver in the chain" };
  const u = await prisma.hireApprovalStep.updateMany({
    where: { id: pending.id, status: "PENDING" },
    data: { status: opts.approve ? "APPROVED" : "REJECTED", decidedAt: new Date(), comment: opts.comment?.trim().slice(0, 500) || null },
  });
  if (u.count === 0) return { handled: true, ok: false, message: "someone else decided it first" };
  if (!opts.approve) {
    await prisma.hireApprovalStep.updateMany({ where: { tenantId: opts.tenantId, kind: opts.kind, entityId: opts.entityId, status: "WAITING" }, data: { status: "CANCELLED" } });
    return { handled: true, ok: true, final: true, message: "Rejected." };
  }
  const next = await prisma.hireApprovalStep.findFirst({ where: { tenantId: opts.tenantId, kind: opts.kind, entityId: opts.entityId, status: "WAITING" }, orderBy: { sequence: "asc" } });
  if (!next) return { handled: true, ok: true, final: true, message: "Approved." };
  await prisma.hireApprovalStep.update({ where: { id: next.id }, data: { status: "PENDING" } });
  return { handled: true, ok: true, final: false, next: next.approverUserId, message: "Approved; sent to the next approver." };
}

/** After a decision settles a chain outside decideHireStep (e.g. a cancelled requisition). */
export async function cancelHireChain(tenantId: string, kind: HireChainKind, entityId: string): Promise<void> {
  await prisma.hireApprovalStep.updateMany({ where: { tenantId, kind, entityId, status: { in: ["WAITING", "PENDING"] } }, data: { status: "CANCELLED" } });
}

// ---------------------------------------------------------------------------
//  Candidate self-scheduling
// ---------------------------------------------------------------------------

export async function offerInterviewSlots(opts: {
  tenantId: string; applicationId: string; title: string; mode: string; durationMinutes: number; meetingUrl?: string | null;
  panelIds: string[]; slots: string[]; byUserId: string; baseUrl?: string; now?: Date;
}): Promise<R & { url?: string; id?: string }> {
  const app = await prisma.application.findFirst({ where: { id: opts.applicationId, tenantId: opts.tenantId }, include: { candidate: true, job: true } });
  if (!app) return { ok: false, message: "Application not found." };
  if (app.status !== "ACTIVE") return { ok: false, message: "Interviews are scheduled only for active applications." };
  const panel = [...new Set(opts.panelIds.filter(Boolean))];
  if (panel.length === 0) return { ok: false, message: "Add at least one interviewer." };
  if ((await prisma.employee.count({ where: { tenantId: opts.tenantId, id: { in: panel } } })) !== panel.length) return { ok: false, message: "An interviewer was not found." };
  if (!(opts.durationMinutes >= 15 && opts.durationMinutes <= 240)) return { ok: false, message: "Interviews run 15 to 240 minutes." };
  const { slots, error } = cleanSlots(opts.slots, opts.now);
  if (error) return { ok: false, message: error };
  const { token, hash } = newOfferToken(secret());
  const expiresAt = new Date(slots[slots.length - 1].getTime());
  await prisma.interviewSlotOffer.updateMany({ where: { applicationId: app.id, status: "OPEN" }, data: { status: "CANCELLED" } });
  const row = await prisma.interviewSlotOffer.create({
    data: {
      tenantId: opts.tenantId, applicationId: app.id, tokenHash: hash, title: opts.title.slice(0, 120), mode: opts.mode, durationMinutes: opts.durationMinutes,
      meetingUrl: opts.meetingUrl ?? null, panelIds: panel, slots: slots.map((s) => s.toISOString()), expiresAt, createdBy: opts.byUserId,
    },
  });
  const url = `${(opts.baseUrl ?? appBaseUrl()).replace(/\/+$/, "")}/schedule/${token}`;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: opts.tenantId }, select: { name: true } });
  await prisma.emailOutbox.create({
    data: {
      tenantId: opts.tenantId, toAddress: app.candidate.email, subject: `Pick a time for your ${app.job.title} interview at ${tenant.name}`,
      textBody: `Dear ${app.candidate.firstName},\n\nPlease pick a time that suits you for "${opts.title}" (${opts.durationMinutes} minutes):\n\n${url}\n\nThe link is personal to you.\n\nTalent Acquisition, ${tenant.name}`,
      relatedType: "InterviewSlotOffer", relatedId: row.id,
    },
  });
  return { ok: true, message: `Sent ${app.candidate.firstName} ${slots.length} slot(s) to choose from.`, url, id: row.id };
}

export interface PublicSlotOffer { id: string; company: string; candidate: string; job: string; title: string; durationMinutes: number; mode: string; status: string; slots: string[]; chosenSlot: string | null }

/** What the candidate's link shows: only this offer's slots. Null for a bad or unknown token. */
export async function openSlotOffer(token: string): Promise<PublicSlotOffer | null> {
  if (!offerTokenSigned(token, secret())) return null;
  const row = await prisma.interviewSlotOffer.findUnique({ where: { tokenHash: hashOfferToken(token) }, include: { application: { include: { candidate: true, job: true } }, tenant: { select: { name: true } } } });
  if (!row) return null;
  const now = Date.now();
  const slots = (Array.isArray(row.slots) ? (row.slots as string[]) : []).filter((s) => new Date(s).getTime() > now);
  return {
    id: row.id, company: row.tenant.name, candidate: row.application.candidate.firstName, job: row.application.job.title, title: row.title,
    durationMinutes: row.durationMinutes, mode: row.mode, status: row.status === "OPEN" && slots.length === 0 ? "EXPIRED" : row.status, slots, chosenSlot: row.chosenSlot?.toISOString() ?? null,
  };
}

/** The candidate picks a slot: the interview is scheduled with the panel, exactly once. */
export async function bookSlot(token: string, slot: string): Promise<R> {
  if (!offerTokenSigned(token, secret())) return { ok: false, message: "This link is not valid." };
  const row = await prisma.interviewSlotOffer.findUnique({ where: { tokenHash: hashOfferToken(token) }, include: { application: { include: { candidate: true, job: true } } } });
  if (!row) return { ok: false, message: "This link is not valid." };
  if (row.status !== "OPEN") return { ok: false, message: row.status === "BOOKED" ? "You have already picked a time." : "These slots are no longer available." };
  const offered = Array.isArray(row.slots) ? (row.slots as string[]) : [];
  const chosen = offered.find((s) => s === slot);
  if (!chosen) return { ok: false, message: "Pick one of the offered times." };
  const at = new Date(chosen);
  if (at.getTime() < Date.now() + 15 * 60_000) return { ok: false, message: "That time is too soon now; pick a later one." };
  // Claim the offer first, so two clicks cannot book two interviews.
  const claim = await prisma.interviewSlotOffer.updateMany({ where: { id: row.id, status: "OPEN" }, data: { status: "BOOKED", chosenSlot: at } });
  if (claim.count === 0) return { ok: false, message: "You have already picked a time." };
  const r = await scheduleInterview({ applicationId: row.applicationId, title: row.title, scheduledAt: at, durationMinutes: row.durationMinutes, mode: row.mode, meetingUrl: row.meetingUrl, panel: (row.panelIds as string[]) ?? [] });
  if (!r.ok) {
    await prisma.interviewSlotOffer.update({ where: { id: row.id }, data: { status: "OPEN", chosenSlot: null } });
    return { ok: false, message: `That time is no longer free (${r.message}) Please pick another.` };
  }
  await prisma.interviewSlotOffer.update({ where: { id: row.id }, data: { interviewId: r.interviewId } });
  if (row.createdBy) await notify({ tenantId: row.tenantId, userIds: [row.createdBy], kind: "HIRING", title: `${row.application.candidate.firstName} ${row.application.candidate.lastName} picked an interview time`, body: `${row.title}: ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`, link: `/hiring/applications/${row.applicationId}` });
  return { ok: true, message: `Booked for ${at.toISOString().slice(0, 16).replace("T", " ")} UTC. You will hear from the team with the details.` };
}
