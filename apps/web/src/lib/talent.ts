import "server-only";
import { prisma } from "@keka/db";
import { feedbackAllowed, promotionEligibility } from "@keka/services";

/**
 * Server-side lookups shared by the talent pages and actions: the company's
 * feedback rules, the manager chain, the promotion policy and eligibility.
 * Not server actions — callers pass the viewer's own tenant.
 */

export async function feedbackRules(tenantId: string) {
  const s = await prisma.feedbackSetting.findUnique({ where: { tenantId } });
  return { allowAnonymous: s?.allowAnonymous ?? false, whoCanGive: s?.whoCanGive ?? "EVERYONE", allowRequests: s?.allowRequests ?? true };
}

/** The manager chain above an employee, nearest first (depth-capped). */
export async function managerChain(tenantId: string, employeeId: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = employeeId;
  for (let i = 0; i < 12 && cur; i++) {
    const e: { reportingManagerId: string | null } | null = await prisma.employee.findFirst({ where: { id: cur, tenantId }, select: { reportingManagerId: true } });
    cur = e?.reportingManagerId ?? null;
    if (cur && !out.includes(cur)) out.push(cur);
  }
  return out;
}

/** Why the giver may not give feedback about the subject under the company's setting, or null. */
export async function feedbackBlocker(tenantId: string, giverId: string, subjectId: string): Promise<string | null> {
  const rules = await feedbackRules(tenantId);
  const [giver, subject] = await Promise.all([
    prisma.employee.findFirst({ where: { id: giverId, tenantId }, select: { id: true, departmentId: true } }),
    prisma.employee.findFirst({ where: { id: subjectId, tenantId }, select: { id: true, departmentId: true } }),
  ]);
  if (!giver || !subject) return "That colleague was not found.";
  return feedbackAllowed(rules, giver, { ...subject, managerChain: await managerChain(tenantId, subject.id) });
}

export async function promotionPolicyOf(tenantId: string) {
  const p = await prisma.promotionPolicy.findUnique({ where: { tenantId } });
  return { minTenureMonths: p?.minTenureMonths ?? 12, minMonthsSinceLastPromotion: p?.minMonthsSinceLastPromotion ?? 12, minRating: p ? Number(p.minRating) : 4, excludeOnPip: p?.excludeOnPip ?? true, maxIncrementPercent: p ? Number(p.maxIncrementPercent) : 30 };
}

/** Eligibility of one employee for promotion, under the company's policy. */
export async function eligibilityFor(tenantId: string, employeeId: string, rating: number | null) {
  const [policy, emp, lastPromo, pip] = await Promise.all([
    promotionPolicyOf(tenantId),
    prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: { dateOfJoining: true } }),
    prisma.employeeJobRecord.findFirst({ where: { employeeId, employee: { tenantId }, reason: "PROMOTION" }, orderBy: { effectiveFrom: "desc" }, select: { effectiveFrom: true } }),
    prisma.improvementPlan.count({ where: { tenantId, employeeId, status: "ACTIVE" } }),
  ]);
  return promotionEligibility({ dateOfJoining: emp?.dateOfJoining ?? new Date(), lastPromotionAt: lastPromo?.effectiveFrom ?? null, rating, onPip: pip > 0 }, policy);
}
