import type { PrismaClient } from "@prisma/client";

/**
 * Performance seed: indicators, a company → department → individual goal
 * tree with check-ins, last year's completed and shared review cycle, and a
 * mid-year cycle in progress at every stage — all through the services.
 */
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

export async function seedPerformance(prisma: PrismaClient, ctx: { tenantId: string; empIdByNumber: Map<string, string> }) {
  const svc = await import("@keka/services");
  const id = (n: string) => ctx.empIdByNumber.get(n)!;
  const t = ctx.tenantId;

  // --- Indicators -------------------------------------------------------------
  for (const [i, [cat, items]] of ([
    ["Delivery", ["Quality of work", "Ownership", "Pace and predictability"]],
    ["Collaboration", ["Communication", "Helping others succeed"]],
    ["Growth", ["Learning and craft", "Initiative"]],
  ] as const).entries()) {
    await prisma.indicatorCategory.create({
      data: { tenantId: t, name: cat, displayOrder: i, weight: [50, 30, 20][i], indicators: { create: items.map((name, k) => ({ name, displayOrder: k })) } },
    });
  }
  await prisma.goalType.createMany({ data: [{ tenantId: t, name: "OKR", defaultDurationDays: 90 }, { tenantId: t, name: "Annual objective", defaultDurationDays: 365 }] });

  // --- Goals -------------------------------------------------------------------
  const fyStart = utc(2026, 4, 1), fyEnd = utc(2027, 3, 31);
  const company = await prisma.goal.create({ data: { tenantId: t, title: "Reach ₹48 crore ARR", level: "COMPANY", metricType: "CURRENCY", rollupMethod: "MANUAL", startValue: 310000000, targetValue: 480000000, currentValue: 310000000, startDate: fyStart, dueDate: fyEnd, status: "ON_TRACK" } });
  const reliability = await prisma.goal.create({ data: { tenantId: t, title: "Platform availability at 99.95%", level: "COMPANY", metricType: "PERCENTAGE", startDate: fyStart, dueDate: fyEnd, status: "ON_TRACK", rollupMethod: "WEIGHTED" } });
  const plat = await prisma.department.findFirstOrThrow({ where: { tenantId: t, name: "Platform Engineering" } });
  const latency = await prisma.goal.create({ data: { tenantId: t, title: "Cut p95 API latency from 620 ms to 300 ms", level: "DEPARTMENT", departmentId: plat.id, metricType: "NUMBER_DECREASE", metricName: "ms", startValue: 620, targetValue: 300, currentValue: 620, startDate: fyStart, dueDate: fyEnd, status: "ON_TRACK", parentGoalId: reliability.id, weight: 60, rollupMethod: "MANUAL" } });
  const incidents = await prisma.goal.create({ data: { tenantId: t, title: "Halve sev-1 incidents (12 → 6)", level: "DEPARTMENT", departmentId: plat.id, metricType: "NUMBER_DECREASE", metricName: "incidents", startValue: 12, targetValue: 6, currentValue: 12, startDate: fyStart, dueDate: fyEnd, status: "ON_TRACK", parentGoalId: reliability.id, weight: 40, rollupMethod: "MANUAL" } });
  const individual: Array<[string, string, "PERCENTAGE" | "COMPLETION" | "NUMBER_INCREASE", number, number, string | null, Array<[number, number, string]>]> = [
    ["ACM0009", "Ship the payslip PDF service", "PERCENTAGE", 0, 100, null, [[5, 20, "Design approved"], [7, 45, "Renderer done"], [9, 70, "Encryption in review"]]],
    ["ACM0009", "Complete the AWS Solutions Architect certification", "COMPLETION", 0, 1, null, [[8, 0, "Booked the exam"]]],
    ["ACM0006", "Migrate 40 services to the new mesh", "NUMBER_INCREASE", 0, 40, latency.id, [[6, 8, "Pilot done"], [8, 22, "Batch two"]]],
    ["ACM0007", "Automate 80% of regression tests", "PERCENTAGE", 0, 100, incidents.id, [[6, 15, "Framework chosen"], [9, 22, "Slow going — flaky env"]]],
    ["ACM0008", "Close 25 enterprise deals", "NUMBER_INCREASE", 0, 25, company.id, [[6, 6, "Q1"], [9, 13, "Q2 strong"]]],
  ];
  let goals = 4, checkIns = 0;
  for (const [num, title, metric, start, target, parent, ins] of individual) {
    const g = await prisma.goal.create({ data: { tenantId: t, employeeId: id(num), title, level: "INDIVIDUAL", metricType: metric, startValue: start, targetValue: target, currentValue: start, startDate: fyStart, dueDate: fyEnd, status: "ON_TRACK", parentGoalId: parent } });
    goals++;
    for (const [month, value, note] of ins) {
      await svc.checkInGoal({ goalId: g.id, value, note, byEmployeeId: id(num) });
      await prisma.goalCheckIn.updateMany({ where: { goalId: g.id, note }, data: { recordedAt: utc(2026, month, 28) } });
      checkIns++;
    }
  }
  // Department and company progress, checked in by their owners.
  for (const [g, v] of [[latency, 455], [incidents, 9], [company, 372000000]] as const) { await svc.checkInGoal({ goalId: g.id, value: v }); checkIns++; }
  for (const g of await prisma.goal.findMany({ where: { tenantId: t } })) await svc.refreshGoal(g.id, utc(2026, 9, 30));

  // --- Review cycles -------------------------------------------------------------
  const bands = [
    { name: "Outstanding", minRating: 4.5, maxRating: 5, targetPercent: 10, color: "#0f8a55", displayOrder: 0 },
    { name: "Exceeds expectations", minRating: 3.5, maxRating: 4.5, targetPercent: 25, color: "#1266a8", displayOrder: 1 },
    { name: "Meets expectations", minRating: 2.5, maxRating: 3.5, targetPercent: 50, color: "#8891a3", displayOrder: 2 },
    { name: "Below expectations", minRating: 1, maxRating: 2.5, targetPercent: 15, color: "#c92a2a", displayOrder: 3 },
  ];
  const reviewers = [{ type: "SELF", weight: 20 }, { type: "MANAGER", weight: 80 }];
  const hr = await prisma.user.findFirstOrThrow({ where: { tenantId: t, email: "priya.sharma@acme.test" } });

  // Deterministic ratings from an employee number.
  const score = (num: string, salt: number) => [3, 4, 3, 5, 3, 4, 2, 4, 3, 3, 4, 3][(Number(num.slice(3)) * 7 + salt) % 12];

  async function runCycle(name: string, start: Date, end: Date, stage: "done" | "mid") {
    const cycle = await prisma.reviewCycle.create({ data: { tenantId: t, name, periodStart: start, periodEnd: end, reviewClosesAt: new Date(end.getTime() + 30 * 86_400_000), reviewerTypes: reviewers, ratingScale: { min: 1, max: 5 }, bands: { create: bands } } });
    await svc.launchCycle(cycle.id);
    const reviews = await prisma.employeeReview.findMany({ where: { cycleId: cycle.id }, include: { employee: { select: { employeeNumber: true } }, responses: true } });
    let i = 0;
    for (const r of reviews) {
      i++;
      const num = r.employee.employeeNumber;
      const self = r.responses.find((x) => x.reviewerType === "SELF");
      const mgr = r.responses.find((x) => x.reviewerType === "MANAGER");
      // Mid-year: a third have done nothing, a third only the self review.
      if (stage === "mid" && i % 3 === 0) continue;
      if (self) await svc.submitReviewResponse({ reviewId: r.id, reviewerEmployeeId: self.reviewerId, reviewerType: "SELF", overallRating: Math.min(5, score(num, 1) + 1), strengths: "Delivered what I committed to and helped the team when it mattered.", improvements: "Plan larger pieces of work more carefully up front." });
      if (stage === "mid" && i % 3 === 1) continue;
      if (mgr) await svc.submitReviewResponse({ reviewId: r.id, reviewerEmployeeId: mgr.reviewerId, reviewerType: "MANAGER", overallRating: score(num, 2), strengths: "Dependable delivery; raises risks early.", improvements: "Should take on more cross-team ownership." });
      if (stage === "done") {
        const after = await prisma.employeeReview.findUniqueOrThrow({ where: { id: r.id } });
        const raw = after.rawRating === null ? 3 : Number(after.rawRating);
        // Calibration nudges two outliers, with the reason recorded.
        const moved = num === "ACM0012" ? Math.max(1, raw - 0.5) : raw;
        await svc.calibrateReview({ reviewId: r.id, finalRating: moved, reason: moved !== raw ? "Normalised against peers in Quality Assurance" : null, byUserId: hr.id });
      }
    }
    if (stage === "done") {
      // Reviews with no manager (the CEO) are calibrated on the self review alone.
      for (const r of await prisma.employeeReview.findMany({ where: { cycleId: cycle.id, status: { notIn: ["CALIBRATED"] } } })) {
        await prisma.employeeReview.update({ where: { id: r.id }, data: { status: "PENDING_CALIBRATION" } });
        await svc.calibrateReview({ reviewId: r.id, finalRating: r.rawRating ? Number(r.rawRating) : 4, reason: "Board review", byUserId: hr.id });
      }
      await svc.shareCycle(cycle.id);
      await prisma.employeeReview.updateMany({ where: { cycleId: cycle.id }, data: { sharedAt: utc(2026, 5, 10) } });
      await prisma.reviewCycle.update({ where: { id: cycle.id }, data: { launchedAt: utc(2026, 4, 1) } });
    }
    return reviews.length;
  }
  const lastYear = await runCycle("Annual review 2025-26", utc(2025, 4, 1), utc(2026, 3, 31), "done");
  const mid = await runCycle("Mid-year 2026-27", utc(2026, 4, 1), utc(2026, 9, 30), "mid");

  // --- An improvement plan --------------------------------------------------------
  await prisma.improvementPlan.create({
    data: {
      tenantId: t, employeeId: id("ACM0012"), managerId: id("ACM0005"), createdBy: hr.id,
      reason: "Regression escapes rose from 2 to 9 per release over two quarters.",
      objectives: "Fewer than 3 escapes per release for two consecutive releases; own the release checklist.",
      startDate: utc(2026, 8, 15), endDate: utc(2026, 10, 15),
    },
  });

  return { goals, checkIns, reviewsLastYear: lastYear, reviewsMidYear: mid };
}
