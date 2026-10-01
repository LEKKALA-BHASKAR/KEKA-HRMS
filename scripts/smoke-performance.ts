/**
 * Performance through the actions: who may set and update goals, roll-ups,
 * the review sequence (self before manager), rating maths, calibration with
 * reasons, what the employee may see and when, and improvement plans.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

async function main() {
  const a = await import("../apps/web/src/app/actions/performance");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const meera = await emp("ACM0009"), sneha = await emp("ACM0005"), ananya = await emp("ACM0007"), ramesh = await emp("ACM0002");
  const started = new Date();
  const fyEnd = "2027-03-31";
  const createdCycles: string[] = [];

  console.log("\nPerformance\n" + "=".repeat(72));
  try {
    section("Goals");
    await signInAs("meera.krishnan@acme.test");
    const own = await a.saveGoalAction({}, fd({ title: "Smoke goal: write 12 design docs", level: "INDIVIDUAL", metricType: "NUMBER_INCREASE", startValue: 0, targetValue: 12, startDate: "2026-04-01", dueDate: fyEnd }));
    const g = await prisma.goal.findFirstOrThrow({ where: { title: "Smoke goal: write 12 design docs" } });
    check("An employee sets her own goal", own.ok === true && g.employeeId === meera.id, own.message);
    const forOther = await a.saveGoalAction({}, fd({ title: "Smoke goal: not mine", level: "INDIVIDUAL", employeeId: ramesh.id, metricType: "PERCENTAGE", startDate: "2026-04-01", dueDate: fyEnd }));
    check("…but not someone else's", forOther.ok === false, forOther.message);
    const company = await a.saveGoalAction({}, fd({ title: "Smoke company goal", level: "COMPANY", metricType: "PERCENTAGE", startDate: "2026-04-01", dueDate: fyEnd }));
    check("…and not a company goal", company.ok === false, company.message);
    const backwards = await a.saveGoalAction({}, fd({ title: "Smoke goal: backwards", level: "INDIVIDUAL", metricType: "NUMBER_DECREASE", startValue: 5, targetValue: 10, startDate: "2026-04-01", dueDate: fyEnd }));
    check("A ‘decrease’ whose target is higher is refused", backwards.ok === false && !!backwards.errors?.targetValue, backwards.message);

    const ci = await a.checkInAction({}, fd({ goalId: g.id, value: 6, note: "Half way" }));
    const g2 = await prisma.goal.findUniqueOrThrow({ where: { id: g.id } });
    check("A check-in moves progress to 50%", ci.ok === true && Number(g2.progressPercent) === 50, ci.message);
    check("…and records the history", (await prisma.goalCheckIn.count({ where: { goalId: g.id } })) === 1);

    await signInAs("sneha.reddy@acme.test"); // Meera's skip-level manager
    const mgr = await a.checkInAction({}, fd({ goalId: g.id, value: 7 }));
    check("Her manager's manager can update it too", mgr.ok === true, mgr.message);
    await signInAs("ramesh.iyer@acme.test");
    const stranger = await a.checkInAction({}, fd({ goalId: g.id, value: 12 }));
    check("Someone outside her line cannot", stranger.ok === false, stranger.message);

    section("Roll-up");
    await signInAs("vikram.menon@acme.test");
    await a.saveGoalAction({}, fd({ title: "Smoke parent", level: "COMPANY", metricType: "PERCENTAGE", startDate: "2026-04-01", dueDate: fyEnd, rollupMethod: "WEIGHTED" }));
    const parent = await prisma.goal.findFirstOrThrow({ where: { title: "Smoke parent" } });
    for (const [title, w, v] of [["Smoke child A", 3, 100], ["Smoke child B", 1, 0]] as const) {
      await a.saveGoalAction({}, fd({ title, level: "INDIVIDUAL", employeeId: meera.id, metricType: "PERCENTAGE", startDate: "2026-04-01", dueDate: fyEnd, parentGoalId: parent.id, weight: w }));
      const c = await prisma.goal.findFirstOrThrow({ where: { title } });
      await a.checkInAction({}, fd({ goalId: c.id, value: v }));
    }
    const p2 = await prisma.goal.findUniqueOrThrow({ where: { id: parent.id } });
    check("A weighted parent is 75% when the 3-weight child is done and the 1-weight is not", Number(p2.progressPercent) === 75, String(p2.progressPercent));
    const direct = await a.checkInAction({}, fd({ goalId: parent.id, value: 10 }));
    check("A rolled-up goal cannot be checked in directly", direct.ok === false, direct.message);

    section("A review cycle, end to end");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a cycle", await denied(() => a.createCycleAction({}, fd({ name: "x" }))));
    await signInAs("vikram.menon@acme.test");
    const bad = await a.createCycleAction({}, fd({ name: "Smoke cycle", periodStart: "2026-04-01", periodEnd: "2026-09-30", selfWeight: 30, managerWeight: 60 }));
    check("Weights that do not add to 100 are refused", bad.ok === false, bad.message);
    const made = await a.createCycleAction({}, fd({ name: "Smoke cycle", periodStart: "2026-04-01", periodEnd: "2026-09-30", selfWeight: 20, managerWeight: 80 }));
    const cycle = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke cycle" }, include: { bands: true } });
    createdCycles.push(cycle.id);
    check("A cycle is created with four target bands", made.ok === true && cycle.bands.length === 4);
    const launched = await a.cycleOpAction({}, fd({ cycleId: cycle.id, op: "launch" }));
    const review = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: cycle.id, employeeId: meera.id }, include: { responses: true } });
    check("Launching creates reviews with self and manager slots", launched.ok === true && review.status === "SELF_PENDING" && review.responses.length === 2, launched.message);
    const manager = review.responses.find((r) => r.reviewerType === "MANAGER")!;
    check("The manager slot belongs to her actual manager", manager.reviewerId === ananya.id);

    await signInAs("ananya.ghosh@acme.test");
    const early = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 4, strengths: "x", improvements: "y" }));
    check("The manager cannot review before the self review", early.ok === false && /self review/.test(early.message ?? ""), early.message);

    await signInAs("meera.krishnan@acme.test");
    const selfR = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 5, strengths: "Shipped the PDF service" }));
    check("Self review submitted", selfR.ok === true, selfR.message);
    const twice = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 1 }));
    check("…and cannot be changed afterwards", twice.ok === false, twice.message);
    const impersonate = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 5, strengths: "me", improvements: "none" }));
    check("She cannot write her manager's part", impersonate.ok === false, impersonate.message);

    await signInAs("ananya.ghosh@acme.test");
    const thin = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 3 }));
    check("A manager review needs strengths and improvements", thin.ok === false, thin.message);
    const m = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 3, strengths: "Reliable", improvements: "Scope work earlier" }));
    const r2 = await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id } });
    check("Both in: raw rating is 20%×5 + 80%×3 = 3.4, awaiting calibration", m.ok === true && Number(r2.rawRating) === 3.4 && r2.status === "PENDING_CALIBRATION", `${r2.rawRating} ${r2.status}`);

    section("Calibration");
    await signInAs("priya.sharma@acme.test");
    check("An HR manager does not calibrate — that is the Performance Admin's call",
      await denied(() => a.calibrateAction({}, fd({ reviewId: review.id, finalRating: 4 }))));
    await signInAs("vikram.menon@acme.test");
    const noReason = await a.calibrateAction({}, fd({ reviewId: review.id, finalRating: 3.8 }));
    check("Moving the rating needs a reason", noReason.ok === false, noReason.message);
    const cal = await a.calibrateAction({}, fd({ reviewId: review.id, finalRating: 3.8, reason: "Delivered beyond the team average" }));
    const r3 = await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id }, include: { band: true } });
    check("Calibrated to 3.8 lands in ‘Exceeds expectations’", cal.ok === true && r3.band?.name === "Exceeds expectations", cal.message);
    const share = await a.cycleOpAction({}, fd({ cycleId: cycle.id, op: "share" }));
    check("Results cannot be shared while reviews are open", share.ok === false && /not calibrated/.test(share.message ?? ""), share.message);
    // Calibrate the rest at their raw rating so the cycle can close.
    for (const r of await prisma.employeeReview.findMany({ where: { cycleId: cycle.id, status: { not: "CALIBRATED" } } })) {
      await prisma.employeeReview.update({ where: { id: r.id }, data: { status: "CALIBRATED", finalRating: 3 } });
    }
    const shared = await a.cycleOpAction({}, fd({ cycleId: cycle.id, op: "share" }));
    check("Once all are calibrated, results are shared", shared.ok === true, shared.message);

    await signInAs("meera.krishnan@acme.test");
    const ack = await a.acknowledgeAction({}, fd({ reviewId: review.id, comments: "Thanks" }));
    check("The employee acknowledges", ack.ok === true && (await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id } })).status === "ACKNOWLEDGED");
    await signInAs("ramesh.iyer@acme.test");
    const notHers = await a.acknowledgeAction({}, fd({ reviewId: review.id }));
    check("…nobody else can acknowledge for her", notHers.ok === false);

    section("Improvement plans");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot start a plan", await denied(() => a.createPipAction({}, fd({ employeeId: sneha.id }))));
    await signInAs("priya.sharma@acme.test");
    const short = await a.createPipAction({}, fd({ employeeId: meera.id, reason: "x", objectives: "y", startDate: "2026-10-01", endDate: "2026-10-10" }));
    check("A plan shorter than 30 days is refused", short.ok === false, short.message);
    const pip = await a.createPipAction({}, fd({ employeeId: meera.id, reason: "Smoke reason", objectives: "Smoke objectives", startDate: "2026-10-01", endDate: "2026-12-01" }));
    const plan = await prisma.improvementPlan.findFirstOrThrow({ where: { employeeId: meera.id, reason: "Smoke reason" } });
    check("A 61-day plan is started", pip.ok === true);
    const noNote = await a.closePipAction({}, fd({ id: plan.id, outcome: "SUCCESSFUL" }));
    check("Closing needs the evidence", noNote.ok === false);
    const closed = await a.closePipAction({}, fd({ id: plan.id, outcome: "SUCCESSFUL", note: "Targets met two cycles running" }));
    check("…and then closes as successful", closed.ok === true && (await prisma.improvementPlan.findUniqueOrThrow({ where: { id: plan.id } })).status === "CLOSED");
  } finally {
    await prisma.goal.deleteMany({ where: { tenantId: tenant.id, title: { startsWith: "Smoke" } } });
    await prisma.reviewCycle.deleteMany({ where: { id: { in: createdCycles } } });
    await prisma.improvementPlan.deleteMany({ where: { tenantId: tenant.id, reason: "Smoke reason" } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, kind: "PERFORMANCE", createdAt: { gte: started } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, subject: { contains: "Smoke" } } });
  }
  report("Performance");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
