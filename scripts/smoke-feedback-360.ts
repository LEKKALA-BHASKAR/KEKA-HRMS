/**
 * 360 feedback: a cycle weighted across self, manager, skip-level, peers and
 * direct reports creates slots for each; the employee proposes peers (not
 * themselves, their manager, or over the limit) and their manager approves
 * or declines; peer feedback needs a comment and does not hold up the
 * review; several peers share the peer weight; calibration closes feedback
 * still outstanding. The cycle is named "Smoke 360" and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const a = await import("../apps/web/src/app/actions/performance");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: `${n}@acme.test` } } });
  const [meera, ananya, aditya, rahul] = await Promise.all([emp("meera.krishnan"), emp("ananya.ghosh"), emp("aditya.verma"), emp("rahul.kapoor")]);
  const started = new Date();
  const cleanup = async () => {
    await prisma.reviewCycle.deleteMany({ where: { tenantId: tenant.id, name: "Smoke 360" } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, kind: "PERFORMANCE", createdAt: { gte: started } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, subject: { contains: "Smoke 360" } } });
  };
  await cleanup();
  try {
    section("Cycle");
    await signInAs("vikram.menon@acme.test");
    const base = { name: "Smoke 360", periodStart: "2026-04-01", periodEnd: "2026-09-30", maxPeers: "2", anonymity: "anonymous" };
    const bad = await a.createCycleAction({}, fd({ ...base, selfWeight: 10, managerWeight: 50, skipLevelWeight: 10, peerWeight: 20, subordinateWeight: 20 }));
    check("Weights across all reviewers must add to 100", bad.ok === false && /110/.test(bad.message ?? ""), bad.message);
    const made = await a.createCycleAction({}, fd({ ...base, selfWeight: 10, managerWeight: 50, skipLevelWeight: 10, peerWeight: 20, subordinateWeight: 10 }));
    const cycle = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke 360" } });
    check("A 360 cycle keeps every weighted reviewer type", made.ok && (cycle.reviewerTypes as { type: string }[]).map((t) => t.type).join() === "SELF,MANAGER,SKIP_LEVEL,PEER,SUBORDINATE" && cycle.maxPeers === 2 && cycle.anonymousFeedback, made.message);
    const launched = await a.cycleOpAction({}, fd({ cycleId: cycle.id, op: "launch" }));
    const review = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: cycle.id, employeeId: meera.id }, include: { responses: true } });
    const types = review.responses.map((r) => r.reviewerType).sort().join();
    const ananyaRow = await prisma.employee.findUniqueOrThrow({ where: { id: ananya.id }, select: { reportingManagerId: true } });
    check("Launch adds self, manager and skip-level slots, no peers yet", launched.ok && types === (ananyaRow.reportingManagerId ? "MANAGER,SELF,SKIP_LEVEL" : "MANAGER,SELF"), types);
    const ananyaReview = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: cycle.id, employeeId: ananya.id }, include: { responses: true } });
    check("A manager's review asks their direct reports", ananyaReview.responses.some((r) => r.reviewerType === "SUBORDINATE" && r.reviewerId === meera.id));

    section("Peer nominations");
    await signInAs("meera.krishnan@acme.test");
    const selfPick = await a.nominatePeersAction({}, fd({ reviewId: review.id, peerIds: meera.id }));
    check("An employee cannot nominate themselves", selfPick.ok === false, selfPick.message);
    const mgrPick = await a.nominatePeersAction({}, fd({ reviewId: review.id, peerIds: ananya.id }));
    check("…or their manager", mgrPick.ok === false);
    const f = fd({ reviewId: review.id }); f.append("peerIds", aditya.id); f.append("peerIds", rahul.id);
    const picked = await a.nominatePeersAction({}, f);
    const proposed = await prisma.reviewResponse.findMany({ where: { reviewId: review.id, reviewerType: "PEER" } });
    check("Her picks wait for her manager", picked.ok && proposed.length === 2 && proposed.every((p) => p.status === "PROPOSED"), picked.message);
    const third = await a.nominatePeersAction({}, fd({ reviewId: review.id, peerIds: (await emp("manish.tiwari")).id }));
    check("No more than the cycle's peer limit", third.ok === false && /Up to 2/.test(third.message ?? ""), third.message);
    await signInAs("aditya.verma@acme.test");
    const early = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "PEER", overallRating: 4, strengths: "Helpful" }));
    check("A proposed peer cannot give feedback yet", early.ok === false, early.message);
    const adSlot = proposed.find((p) => p.reviewerId === aditya.id)!, raSlot = proposed.find((p) => p.reviewerId === rahul.id)!;
    const notMgr = await a.decideNominationAction({}, fd({ reviewId: review.id, responseId: adSlot.id, decision: "approve" }));
    check("Only her manager decides nominations", notMgr.ok === false);
    await signInAs("ananya.ghosh@acme.test");
    const ok1 = await a.decideNominationAction({}, fd({ reviewId: review.id, responseId: adSlot.id, decision: "approve" }));
    const no1 = await a.decideNominationAction({}, fd({ reviewId: review.id, responseId: raSlot.id, decision: "decline" }));
    check("The manager approves one peer and declines the other", ok1.ok && no1.ok);
    const asked = await prisma.notification.findFirst({ where: { userId: (await prisma.employee.findUniqueOrThrow({ where: { id: aditya.id } })).userId!, title: { contains: "Feedback requested" }, createdAt: { gte: started } } });
    check("The approved peer is asked for feedback", !!asked);

    section("Feedback and rating");
    await signInAs("aditya.verma@acme.test");
    const bare = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "PEER", overallRating: 5 }));
    check("Peer feedback needs a comment", bare.ok === false, bare.message);
    const peer = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "PEER", overallRating: 5, strengths: "Unblocks the team" }));
    const afterPeer = await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id } });
    check("Peer feedback is accepted before the self review and does not move the review on", peer.ok && afterPeer.status === "SELF_PENDING", peer.message);
    await signInAs("meera.krishnan@acme.test");
    await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 4, strengths: "Shipped" }));
    await signInAs("ananya.ghosh@acme.test");
    const mgr = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 3, strengths: "Reliable", improvements: "Delegate" }));
    const r2 = await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id } });
    // (10×4 + 50×3 + 20×5) / 80 = 3.63; the skip-level has not answered.
    check("Self and manager in: calibration, rating weighted over those who answered", mgr.ok && r2.status === "PENDING_CALIBRATION" && Number(r2.rawRating) === 3.63, `${r2.status} ${r2.rawRating}`);

    section("Calibration closes feedback");
    await signInAs("vikram.menon@acme.test");
    const cal = await a.calibrateAction({}, fd({ reviewId: review.id, finalRating: 3.63 }));
    const left = await prisma.reviewResponse.findMany({ where: { reviewId: review.id, submittedAt: null } });
    check("Outstanding feedback expires at calibration", cal.ok && left.every((l) => l.status === "EXPIRED" || l.status === "DECLINED"), cal.message);
    const skip = left.find((l) => l.reviewerType === "SKIP_LEVEL");
    if (skip) {
      const skipUser = await prisma.employee.findUniqueOrThrow({ where: { id: skip.reviewerId }, include: { user: true } });
      await signInAs(skipUser.user!.email);
      const late = await a.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SKIP_LEVEL", overallRating: 2, strengths: "Late" }));
      check("Feedback after calibration is refused", late.ok === false, late.message);
    }
  } finally {
    if (!process.env.KEEP_FIXTURES) await cleanup();
  }
}

main().then(() => report("360 feedback")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
