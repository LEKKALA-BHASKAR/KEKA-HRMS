import type { PrismaClient } from "@prisma/client";

/**
 * Probation policies and the two employees still on probation: Swati, whose
 * probation ended in September with her review in and the manager
 * recommending confirmation (waiting on HR), and Harish, part-way through
 * his and on track.
 */
export async function seedProbation(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const { tenantId } = ctx;
  const id = (n: string) => ctx.empIdByNumber.get(n)!;

  await prisma.probationPolicy.createMany({
    data: [
      {
        tenantId, name: "Standard probation", isDefault: true, durationDays: 90, maxExtensions: 1, extensionDays: 30,
        completion: "EVALUATION", reviewLeadDays: 15, selfReview: true,
        description: "Three months for most roles. The manager reviews before the end; HR confirms or extends once.",
      },
      {
        tenantId, name: "Leadership probation", durationDays: 180, maxExtensions: 2, extensionDays: 45,
        completion: "EVALUATION", reviewLeadDays: 30, selfReview: true,
        description: "Six months for people managers and senior hires, with up to two extensions.",
      },
      {
        tenantId, name: "Interns and trainees", durationDays: 60, maxExtensions: 0, extensionDays: 30,
        completion: "AUTO_CONFIRM", reviewLeadDays: 0, selfReview: false,
        description: "Confirmed automatically at the end of the training period.",
      },
    ],
  });

  const svc = await import("@keka/services");
  const started = await svc.ensureProbations(tenantId);

  // Swati: ended 12 Sep, review opened on time, both reviews in.
  const swati = await prisma.employeeProbation.findUnique({ where: { employeeId: id("ACM0024") } });
  let reviews = 0;
  if (swati) {
    await svc.openProbationReview(swati.id, new Date(Date.UTC(2026, 7, 28)));
    await prisma.employeeProbation.update({ where: { id: swati.id }, data: { reviewOpenedAt: new Date(Date.UTC(2026, 7, 28, 4, 30)) } });
    const evs = await prisma.probationEvaluation.findMany({ where: { probationId: swati.id } });
    for (const ev of evs) {
      const r = await svc.submitProbationEvaluation(ev.role === "MANAGER"
        ? {
            evaluationId: ev.id, evaluatorEmployeeId: ev.evaluatorId, rating: 4, recommendation: "CONFIRM",
            strengths: "Picked up the deployment pipeline quickly and owns the on-call runbook.",
            improvements: "Write design notes before starting larger changes.",
            comments: "Ready to confirm.",
          }
        : {
            evaluationId: ev.id, evaluatorEmployeeId: ev.evaluatorId, rating: 4, recommendation: null,
            strengths: "Shipped the metrics migration and joined the on-call rotation.",
            improvements: "More context on the older billing services would help.",
          });
      if (r.ok) reviews++;
    }
    // Notifications from seeding are noise in the demo inbox.
    await prisma.notification.deleteMany({ where: { tenantId, kind: "PROBATION" } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId, relatedType: "EmployeeProbation" } });
  }
  return { policies: 3, started, reviews };
}
