import "server-only";
import { prisma } from "@keka/db";
import { pipEligibility, pipCompletionProblems } from "@keka/services";

/**
 * Improvement-plan rules from PIP settings: who is eligible for a plan, the
 * compliance checklist each plan starts with, and what must be true before a
 * plan closes. Companies that have not configured PIP settings keep the
 * built-in guard rules only.
 */

export async function pipEligibilityProblems(tenantId: string, employeeId: string, today = new Date()): Promise<string[]> {
  const s = await prisma.insightPipSetting.findUnique({ where: { tenantId } });
  if (!s) return [];
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { dateOfJoining: true, status: true } });
  if (!e) return ["Employee not found."];
  const last = await prisma.employeeReview.findFirst({ where: { employeeId, finalRating: { not: null }, cycle: { tenantId } }, orderBy: { cycle: { periodEnd: "desc" } }, select: { finalRating: true } });
  const active = (await prisma.improvementPlan.count({ where: { tenantId, employeeId, status: "ACTIVE" } })) > 0;
  return pipEligibility({ dateOfJoining: e.dateOfJoining, status: e.status, lastRating: last?.finalRating === null || !last ? null : Number(last.finalRating), activePip: active },
    { minTenureDays: s.minTenureDays, maxRating: s.maxRating === null ? null : Number(s.maxRating), blockProbation: s.blockProbation, blockNotice: s.blockNotice }, today);
}

/** A new plan's checklist: the template's, else the company default. */
export async function seedPipChecklist(tenantId: string, pipId: string, items: string[] | null): Promise<number> {
  let list = items;
  if (!list?.length) list = (await prisma.insightPipSetting.findUnique({ where: { tenantId } }))?.defaultChecklist ?? [];
  const clean = [...new Set(list.map((l) => l.trim()).filter(Boolean))].slice(0, 20);
  if (!clean.length) return 0;
  await prisma.insightPipChecklistItem.createMany({ data: clean.map((label, i) => ({ tenantId, pipId, label: label.replace(/^\?\s*/, "").slice(0, 200), required: !label.startsWith("?"), position: i })) });
  return clean.length;
}

/** Why a plan cannot close yet; empty when it can. Plans without objectives or a checklist keep the old rules. */
export async function pipClosingProblems(tenantId: string, pipId: string, outcome: string): Promise<string[]> {
  const [objectives, checklist, milestones, checkIns, setting] = await Promise.all([
    prisma.insightPipObjective.findMany({ where: { tenantId, pipId } }),
    prisma.insightPipChecklistItem.findMany({ where: { tenantId, pipId } }),
    prisma.pipMilestone.findMany({ where: { pipId } }),
    prisma.pipCheckIn.count({ where: { pipId } }),
    prisma.insightPipSetting.findUnique({ where: { tenantId } }),
  ]);
  if (!objectives.length && !checklist.length) return [];
  return pipCompletionProblems({ objectives, checklist, milestones, checkIns, requireChecklist: setting?.requireChecklist ?? true, outcome });
}
