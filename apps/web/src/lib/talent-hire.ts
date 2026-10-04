import "server-only";
import { prisma } from "@keka/db";
import { notify, startHireChain, decideHireStep, hireChain, candidateScore, asStringList } from "@keka/services";
import type { Viewer } from "./context";

/**
 * Multi-level approval chains wired into the requisition and offer flows,
 * and the candidate profile score. Called from the hiring actions and pages
 * with the signed-in viewer; never exposed as server actions.
 */

/** Route a newly raised (or resubmitted) requisition through its matching chain. */
export async function routeRequisitionChain(viewer: Viewer, requisitionId: string): Promise<string | null> {
  const r = await prisma.requisition.findFirst({ where: { id: requisitionId, tenantId: viewer.tenantId } });
  if (!r || r.status !== "PENDING_APPROVAL") return null;
  const amount = r.salaryMax !== null ? Number(r.salaryMax) : r.maxAnnualCtc !== null ? Number(r.maxAnnualCtc) : null;
  const chain = await startHireChain({ tenantId: viewer.tenantId, kind: "REQUISITION", entityId: r.id, departmentId: r.departmentId, amount, requesterUserId: r.raisedBy });
  if (!chain.firstApprover) return null;
  await prisma.requisition.update({ where: { id: r.id }, data: { approverUserId: chain.firstApprover } });
  await notify({ tenantId: viewer.tenantId, userIds: [chain.firstApprover], kind: "HIRING", title: `Requisition ${r.code ?? r.title} needs your approval`, body: `${r.title} × ${r.positions} · level 1 of ${chain.steps}`, link: `/hiring/requisitions?view=pending&req=${r.id}` });
  return `Routed through the “${chain.ruleName}” chain (${chain.steps} level${chain.steps === 1 ? "" : "s"}).`;
}

/**
 * Before requisitions are decided: requisitions on a chain advance level by
 * level. Returns the ids the ordinary decision should still settle (the last
 * level, or a rejection), those that moved on to the next approver, and
 * those this viewer may not decide.
 */
export async function chainRequisitionDecisions(viewer: Viewer, ids: string[], approve: boolean, reason: string | null): Promise<{ settle: string[]; advanced: string[]; blocked: Array<{ id: string; why: string }> }> {
  const settle: string[] = [], advanced: string[] = [], blocked: Array<{ id: string; why: string }> = [];
  for (const id of ids) {
    const { pending } = await hireChain(viewer.tenantId, "REQUISITION", id);
    if (!pending) { settle.push(id); continue; }
    if (pending.approverUserId !== viewer.user.id) { blocked.push({ id, why: "it is waiting on another approver in the chain" }); continue; }
    if (!approve && !reason?.trim()) { settle.push(id); continue; } // the ordinary decision refuses a reasonless rejection
    const r = await decideHireStep({ tenantId: viewer.tenantId, kind: "REQUISITION", entityId: id, userId: viewer.user.id, approve, comment: reason });
    if (!r.ok) { blocked.push({ id, why: r.message }); continue; }
    if (r.final) { settle.push(id); continue; }
    const req = await prisma.requisition.update({ where: { id }, data: { approverUserId: r.next } });
    await notify({ tenantId: viewer.tenantId, userIds: [r.next], kind: "HIRING", title: `Requisition ${req.code ?? req.title} needs your approval`, body: `${req.title} × ${req.positions} · approved at the previous level`, link: `/hiring/requisitions?view=pending&req=${req.id}` });
    advanced.push(id);
  }
  return { settle, advanced, blocked };
}

/** Route a freshly drafted offer through its matching chain: it waits for approval even within budget. */
export async function routeOfferChain(viewer: Viewer, applicationId: string): Promise<string | null> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId: viewer.tenantId }, include: { offer: true, job: true, candidate: true } });
  if (!app?.offer || !["APPROVED", "PENDING_APPROVAL"].includes(app.offer.status)) return null;
  const chain = await startHireChain({ tenantId: viewer.tenantId, kind: "OFFER", entityId: app.id, departmentId: app.job.departmentId, amount: Number(app.offer.annualCtc), requesterUserId: viewer.user.id });
  if (!chain.firstApprover) return null;
  await prisma.offer.update({ where: { id: app.offer.id }, data: { status: "PENDING_APPROVAL", approvedAt: null, approvedBy: null } });
  await notify({ tenantId: viewer.tenantId, userIds: [chain.firstApprover], kind: "APPROVAL", title: `Offer for ${app.candidate.firstName} ${app.candidate.lastName} needs your approval`, body: `${app.job.title} · ₹${Number(app.offer.annualCtc).toLocaleString("en-IN")} · level 1 of ${chain.steps}`, link: "/inbox?cat=hire-approvals" });
  return `It goes through the “${chain.ruleName}” approval chain (${chain.steps} level${chain.steps === 1 ? "" : "s"}).`;
}

/** The company's profile-score weights (defaults when none are saved). */
export async function scoreWeights(tenantId: string) {
  const c = await prisma.candidateScoreConfig.findUnique({ where: { tenantId } });
  return {
    skillsWeight: c?.skillsWeight ?? 50, experienceWeight: c?.experienceWeight ?? 30, educationWeight: c?.educationWeight ?? 20,
    skillKeywords: asStringList(c?.skillKeywords), educationKeywords: asStringList(c?.educationKeywords), idealExperienceYears: c ? Number(c.idealExperienceYears) : 5,
  };
}

export async function profileScoreFor(tenantId: string, candidate: { skills: unknown; totalExperienceYears: unknown; education: string | null }, job: { skills: unknown; minExperienceYears: unknown }) {
  const w = await scoreWeights(tenantId);
  return candidateScore(
    { skills: candidate.skills, experienceYears: candidate.totalExperienceYears === null || candidate.totalExperienceYears === undefined ? null : Number(candidate.totalExperienceYears), education: candidate.education },
    { skills: job.skills, minExperienceYears: job.minExperienceYears === null || job.minExperienceYears === undefined ? null : Number(job.minExperienceYears) }, w,
  );
}
