/**
 * Review-to-pay: a merit matrix per band turns calibrated reviews into
 * salary and bonus proposals; departing from the matrix needs a reason;
 * proposals can be skipped and restored; applying one creates the salary
 * revision (through the approval chain when there is one) and schedules
 * the bonus, and only someone who can revise salaries can do any of it.
 * The cycle is "Smoke pay"; revisions, bonuses and approvals it makes are
 * removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) { try { await fn(); return false; } catch { return true; } }

async function main() {
  const perf = await import("../apps/web/src/app/actions/performance");
  const pay = await import("../apps/web/src/app/actions/review-to-pay");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: "ACM0009" } });
  const started = new Date();
  const made = { revisions: [] as string[], bonuses: [] as string[] };
  const cleanup = async () => {
    const props = await prisma.compensationProposal.findMany({ where: { tenantId: tenant.id, cycle: { name: "Smoke pay" } } });
    const revs = [...made.revisions, ...props.map((p) => p.salaryRevisionId).filter((x): x is string => !!x)];
    const bons = [...made.bonuses, ...props.map((p) => p.bonusId).filter((x): x is string => !!x)];
    const reqs = await prisma.payrollApprovalRequest.findMany({ where: { action: "COMPENSATION_CHANGE", requestedAt: { gte: started } } });
    await prisma.payrollApprovalRequest.deleteMany({ where: { id: { in: reqs.filter((r) => revs.includes(String((r.payload as { revisionId?: string } | null)?.revisionId))).map((r) => r.id) } } });
    await prisma.salaryRevision.deleteMany({ where: { id: { in: revs } } });
    await prisma.employeeBonus.deleteMany({ where: { id: { in: bons } } });
    await prisma.reviewCycle.deleteMany({ where: { tenantId: tenant.id, name: "Smoke pay" } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, kind: { in: ["PERFORMANCE", "APPROVAL", "PAYROLL"] } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: started }, subject: { contains: "Smoke pay" } } });
  };
  await cleanup();
  try {
    section("A calibrated review");
    await signInAs("vikram.menon@acme.test");
    await perf.createCycleAction({}, fd({ name: "Smoke pay", periodStart: "2026-04-01", periodEnd: "2026-09-30", selfWeight: 20, managerWeight: 80 }));
    const cycle = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke pay" }, include: { bands: true } });
    await perf.cycleOpAction({}, fd({ cycleId: cycle.id, op: "launch" }));
    const review = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: cycle.id, employeeId: meera.id } });
    await signInAs("meera.krishnan@acme.test");
    await perf.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 4, strengths: "Shipped" }));
    await signInAs("ananya.ghosh@acme.test");
    await perf.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 4, strengths: "Reliable", improvements: "Delegate" }));
    await signInAs("vikram.menon@acme.test");
    const cal = await perf.calibrateAction({}, fd({ reviewId: review.id, finalRating: 4 }));
    check("Meera is calibrated into a band", cal.ok, cal.message);

    section("Merit matrix and proposals");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot set the merit matrix", await denied(() => pay.saveMeritMatrixAction({}, fd({ cycleId: cycle.id }))));
    await signInAs("vikram.menon@acme.test");
    const noMatrix = await pay.buildProposalsAction({}, fd({ cycleId: cycle.id }));
    check("Proposals need a matrix first", noMatrix.ok === false, noMatrix.message);
    const m = fd({ cycleId: cycle.id });
    for (const [i, b] of cycle.bands.sort((x, y) => Number(y.minRating) - Number(x.minRating)).entries()) { m.append("bandId", b.id); m.append(`inc:${b.id}`, String([15, 10, 6, 0][i])); m.append(`bonus:${b.id}`, String([10, 5, 0, 0][i])); }
    const badM = fd({ cycleId: cycle.id, bandId: cycle.bands[0]!.id, [`inc:${cycle.bands[0]!.id}`]: "150" });
    check("An increment over 100% is refused", (await pay.saveMeritMatrixAction({}, badM)).ok === false);
    const saved = await pay.saveMeritMatrixAction({}, m);
    check("The matrix is saved", saved.ok, saved.message);
    const built = await pay.buildProposalsAction({}, fd({ cycleId: cycle.id }));
    const prop = await prisma.compensationProposal.findFirstOrThrow({ where: { cycleId: cycle.id, employeeId: meera.id } });
    const ctc = Number((await prisma.salaryRevision.findFirstOrThrow({ where: { employeeId: meera.id, status: "APPLIED" }, orderBy: { effectiveFrom: "desc" } })).annualCtc);
    check("Her proposal follows the band: 10% and a 5% bonus", built.ok && prop.bandName === "Exceeds expectations" && Number(prop.proposedPercent) === 10 && Number(prop.proposedCtc) === Math.round(ctc * 1.1) && Number(prop.bonusAmount) === Math.round(ctc * 5) / 100, `${prop.bandName} ${prop.proposedPercent} ${prop.proposedCtc} ${prop.bonusAmount}`);
    const noNote = await pay.updateProposalAction({}, fd({ id: prop.id, proposedPercent: "12", bonusAmount: String(prop.bonusAmount) }));
    check("Departing from the matrix needs a reason", noNote.ok === false, noNote.message);
    const adj = await pay.updateProposalAction({}, fd({ id: prop.id, proposedPercent: "12", bonusAmount: "50000", note: "Market correction" }));
    check("With a reason it is adjusted", adj.ok && Number((await prisma.compensationProposal.findUniqueOrThrow({ where: { id: prop.id } })).proposedCtc) === Math.round(ctc * 1.12), adj.message);
    await pay.buildProposalsAction({}, fd({ cycleId: cycle.id }));
    check("Rebuilding keeps an adjusted proposal", Number((await prisma.compensationProposal.findUniqueOrThrow({ where: { id: prop.id } })).proposedPercent) === 12);
    await pay.updateProposalAction({}, fd({ id: prop.id, op: "skip" }));
    const skippedApply = await pay.applyProposalsAction({}, fd({ cycleId: cycle.id, ids: prop.id, effectiveFrom: "2027-06-01", bonusTypeId: "", payoutMonth: "2027-06" }));
    check("A skipped proposal is not applied", skippedApply.ok === false, skippedApply.message);
    await pay.updateProposalAction({}, fd({ id: prop.id, op: "restore" }));

    section("Apply");
    const noType = await pay.applyProposalsAction({}, fd({ cycleId: cycle.id, ids: prop.id, effectiveFrom: "2027-06-01", payoutMonth: "2027-06" }));
    check("Paying a bonus needs a bonus type", noType.ok === false, noType.message);
    const bonusType = await prisma.bonusType.findFirstOrThrow({ where: { tenantId: tenant.id, isActive: true } });
    const applied = await pay.applyProposalsAction({}, fd({ cycleId: cycle.id, ids: prop.id, effectiveFrom: "2027-06-01", bonusTypeId: bonusType.id, payoutMonth: "2027-06" }));
    const after = await prisma.compensationProposal.findUniqueOrThrow({ where: { id: prop.id } });
    if (after.salaryRevisionId) made.revisions.push(after.salaryRevisionId);
    if (after.bonusId) made.bonuses.push(after.bonusId);
    const rev = after.salaryRevisionId ? await prisma.salaryRevision.findUnique({ where: { id: after.salaryRevisionId } }) : null;
    check("Applying creates the salary revision", applied.ok && after.status === "APPLIED" && !!rev && Number(rev.annualCtc) === Math.round(ctc * 1.12) && ["APPLIED", "PENDING_APPROVAL"].includes(rev.status), `${applied.message} ${rev?.status}`);
    const bonus = after.bonusId ? await prisma.employeeBonus.findUnique({ where: { id: after.bonusId } }) : null;
    check("…and schedules the bonus for the payout month", !!bonus && Number(bonus.amount) === 50000 && bonus.payoutYear === 2027 && bonus.payoutMonth === 6);
    const again = await pay.applyProposalsAction({}, fd({ cycleId: cycle.id, ids: prop.id, effectiveFrom: "2027-06-01", bonusTypeId: bonusType.id, payoutMonth: "2027-06" }));
    check("An applied proposal cannot be applied twice", again.ok === false);
    const locked = await pay.updateProposalAction({}, fd({ id: prop.id, proposedPercent: "20", bonusAmount: "0", note: "x" }));
    check("…or changed", locked.ok === false);
  } finally {
    await cleanup();
  }
}

main().then(() => report("Review to pay")).catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
