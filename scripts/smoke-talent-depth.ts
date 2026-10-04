/**
 * Talent depth (Performance and Hire parity), end to end through the real
 * server actions and permission checks:
 *  - goal timeframes, the goal library and team goals;
 *  - a review form, stage dates and manually mapped participants on a cycle,
 *    potential on calibration and editable bands;
 *  - feedback settings, feedback requests and anonymity;
 *  - a manager's salary recommendation and its Inbox approval;
 *  - growth plan templates and plans;
 *  - talent pools, internal applications, résumé upload and inline preview,
 *    candidate fields and the profile score, the scorecard library;
 *  - candidate self-scheduling through a tokenised link;
 *  - a multi-level requisition approval chain;
 *  - the career site's branding and voluntary EEO self-identification;
 *  - and that none of it reaches another company's records.
 * Everything it creates is named "Smoke talent…" or uses @talent-smoke.test
 * and is removed at the end; company-wide settings are put back.
 */
import { signInAs, setTestHeaders, setTestSession, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

// CSS modules come out of the runtime stub without a default export; serve a
// proxy whose every class name is itself, so pages render.
{
  const internal = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = internal._load;
  const classes: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : k === "default" ? classes : typeof k === "string" ? k : undefined) });
  internal._load = function cssModules(this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request.endsWith(".module.css") ? classes : prev.call(this, request, parent, isMain);
  };
}
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;

const prisma = new PrismaClient();
const DAY = 86_400_000;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const local = (d: Date) => d.toISOString().slice(0, 16);

async function denied(fn: () => Promise<unknown>) { try { await fn(); return false; } catch { return true; } }
async function refused(fn: () => Promise<{ ok?: boolean } | unknown>) {
  try { const r = (await fn()) as { ok?: boolean }; return r?.ok !== true; } catch { return true; }
}

async function main() {
  // The Inbox source renders JSX with the classic runtime.
  (globalThis as { React?: unknown }).React = await import("react");
  const tp = await import("../apps/web/src/app/actions/talent-performance");
  const th = await import("../apps/web/src/app/actions/talent-hiring");
  const perf = await import("../apps/web/src/app/actions/performance");
  const fb = await import("../apps/web/src/app/actions/feedback");
  const hiring = await import("../apps/web/src/app/actions/hiring");
  const careers = await import("../apps/web/src/app/careers/actions");
  const sched = await import("../apps/web/src/app/schedule/actions");
  const svc = await import("@keka/services");
  const { getViewer } = await import("../apps/web/src/lib/context");
  const { talentSources } = await import("../apps/web/src/app/(app)/inbox/_take/talent");
  const { profileScoreFor } = await import("../apps/web/src/lib/talent-hire");
  const filesRoute = await import("../apps/web/src/app/files/[id]/route");
  const assetRoute = await import("../apps/web/src/app/careers/asset/[id]/route");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const byEmail = async (email: string) => {
    const u = await prisma.user.findFirstOrThrow({ where: { tenantId, email }, include: { employee: true } });
    return { user: u, emp: u.employee! };
  };
  const meera = await byEmail("meera.krishnan@acme.test");
  const ananya = await byEmail("ananya.ghosh@acme.test");
  const sneha = await byEmail("sneha.reddy@acme.test");
  const vikram = await byEmail("vikram.menon@acme.test");
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId, name: "Platform Engineering" } });
  const started = new Date();

  // Company-wide singletons this suite changes, to put back afterwards.
  const before = {
    feedback: await prisma.feedbackSetting.findUnique({ where: { tenantId } }),
    policy: await prisma.promotionPolicy.findUnique({ where: { tenantId } }),
    score: await prisma.candidateScoreConfig.findUnique({ where: { tenantId } }),
    career: await prisma.careerSiteSetting.findUnique({ where: { tenantId } }),
  };
  const made = { jobs: [] as Array<{ id: string; allowInternal: boolean; scorecardTemplate: unknown }>, interviews: [] as string[], internalApps: [] as string[], files: [] as string[] };
  let rivalId: string | null = null;

  const cleanup = async () => {
    await prisma.goal.deleteMany({ where: { tenantId, title: { startsWith: "Smoke talent" } } });
    await prisma.goalTemplate.deleteMany({ where: { tenantId, title: { startsWith: "Smoke talent" } } });
    await prisma.goalTimeframe.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    await prisma.reviewCycle.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    await prisma.feedbackRequest.deleteMany({ where: { tenantId, message: { startsWith: "Smoke talent" } } });
    await prisma.feedback.deleteMany({ where: { tenantId, message: { startsWith: "Smoke talent" } } });
    await prisma.growthPlan.deleteMany({ where: { tenantId, title: { startsWith: "Smoke talent" } } });
    await prisma.growthPlanTemplate.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    await prisma.talentPool.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    await prisma.scorecardTemplate.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    await prisma.customFieldDefinition.deleteMany({ where: { tenantId, entity: "CANDIDATE", label: { startsWith: "Smoke talent" } } });
    await prisma.interviewSlotOffer.deleteMany({ where: { tenantId, title: { startsWith: "Smoke talent" } } });
    await prisma.interview.deleteMany({ where: { id: { in: made.interviews } } });
    await prisma.application.deleteMany({ where: { id: { in: made.internalApps } } });
    const reqs = await prisma.requisition.findMany({ where: { tenantId, title: { startsWith: "Smoke talent" } }, select: { id: true } });
    await prisma.hireApprovalStep.deleteMany({ where: { tenantId, entityId: { in: [...reqs.map((r) => r.id), "smoke-talent-entity"] } } });
    await prisma.requisition.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
    await prisma.hireApprovalRule.deleteMany({ where: { tenantId, name: { startsWith: "Smoke talent" } } });
    const cands = await prisma.candidate.findMany({ where: { tenantId, email: { endsWith: "@talent-smoke.test" } }, select: { id: true } });
    await prisma.storedFile.deleteMany({ where: { tenantId, OR: [{ id: { in: made.files } }, { relatedType: "CandidateResume", relatedId: { in: cands.map((c) => c.id) } }] } });
    await prisma.candidate.deleteMany({ where: { id: { in: cands.map((c) => c.id) } } });
    for (const j of made.jobs) await prisma.job.update({ where: { id: j.id }, data: { allowInternal: j.allowInternal, scorecardTemplate: (j.scorecardTemplate ?? undefined) as never } });
    await prisma.feedbackSetting.deleteMany({ where: { tenantId } });
    if (before.feedback) await prisma.feedbackSetting.create({ data: before.feedback });
    await prisma.promotionPolicy.deleteMany({ where: { tenantId } });
    if (before.policy) await prisma.promotionPolicy.create({ data: before.policy });
    await prisma.candidateScoreConfig.deleteMany({ where: { tenantId } });
    if (before.score) await prisma.candidateScoreConfig.create({ data: { ...before.score, skillKeywords: before.score.skillKeywords ?? undefined, educationKeywords: before.score.educationKeywords ?? undefined } as never });
    await prisma.careerSiteSetting.deleteMany({ where: { tenantId } });
    if (before.career) await prisma.careerSiteSetting.create({ data: before.career });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.emailOutbox.deleteMany({ where: { tenantId, createdAt: { gte: started }, relatedType: "InterviewSlotOffer" } });
    await prisma.tenant.deleteMany({ where: { subdomain: "rival-talent-smoke" } });
  };
  await cleanup();

  console.log("\nTalent depth\n" + "=".repeat(72));
  try {
    // ---------------------------------------------------------------------
    section("Goal timeframes, the goal library and team goals");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot add goal timeframes", await denied(() => tp.saveTimeframeAction({}, fd({ name: "Smoke talent Q", startDate: "2027-01-01", endDate: "2027-03-31" }))));
    check("…nor library templates", await denied(() => tp.saveGoalTemplateAction({}, fd({ title: "Smoke talent t" }))));
    await signInAs("vikram.menon@acme.test");
    const badTf = await tp.saveTimeframeAction({}, fd({ name: "Smoke talent bad", kind: "CUSTOM", startDate: "2027-03-31", endDate: "2027-01-01" }));
    check("A timeframe that ends before it starts is refused", badTf.ok === false, badTf.message);
    const tfRes = await tp.saveTimeframeAction({}, fd({ name: "Smoke talent Q1 2027", kind: "QUARTER", startDate: "2027-01-01", endDate: "2027-03-31" }));
    const tf = await prisma.goalTimeframe.findFirst({ where: { tenantId, name: "Smoke talent Q1 2027" } });
    check("HR adds a goal timeframe", tfRes.ok === true && !!tf, tfRes.message);
    const tplRes = await tp.saveGoalTemplateAction({}, fd({ title: "Smoke talent: cut p95 latency", metricType: "NUMBER_DECREASE", metricName: "ms", startValue: 800, targetValue: 300, tags: "Reliability, SRE" }));
    const tpl = await prisma.goalTemplate.findFirst({ where: { tenantId, title: "Smoke talent: cut p95 latency" } });
    check("…and a library template", tplRes.ok === true && !!tpl && Number(tpl.targetValue) === 300, tplRes.message);
    const team = fd({ templateId: tpl!.id, timeframeId: tf!.id });
    team.append("employeeIds", meera.emp.id); team.append("employeeIds", ananya.emp.id);
    const assigned = await tp.assignGoalAction({}, team);
    const goals = await prisma.goal.findMany({ where: { tenantId, templateId: tpl!.id } });
    check("Assigning a template to two people makes a team goal", assigned.ok === true && goals.length === 2 && goals.every((g) => g.level === "TEAM" && g.teamGoalId && g.teamGoalId === goals[0].teamGoalId), assigned.message);
    check("…dated by the timeframe", goals.every((g) => iso(g.startDate!) === "2027-01-01" && iso(g.dueDate!) === "2027-03-31" && g.timeframe === "Smoke talent Q1 2027"));
    await signInAs("meera.krishnan@acme.test");
    const outOfScope = fd({ title: "Smoke talent: not mine", startDate: "2027-01-01", dueDate: "2027-03-31", targetValue: 100 });
    outOfScope.append("employeeIds", vikram.emp.id);
    check("An employee cannot set goals for someone outside their team", (await tp.assignGoalAction({}, outOfScope)).ok === false);

    // ---------------------------------------------------------------------
    section("Review form, stage dates and participants");
    await signInAs("vikram.menon@acme.test");
    await perf.createCycleAction({}, fd({ name: "Smoke talent cycle", periodStart: "2026-04-01", periodEnd: "2026-09-30", selfWeight: 30, managerWeight: 70 }));
    const cycle = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId, name: "Smoke talent cycle" } });
    await tp.saveFormSectionAction({}, fd({ cycleId: cycle.id, title: "Delivery" }));
    const sec = await prisma.reviewFormSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
    const q = fd({ cycleId: cycle.id, sectionId: sec.id, kind: "RATING", prompt: "Quality of delivery", isRequired: true });
    q.append("appliesTo", "SELF");
    const qRes = await tp.saveFormQuestionAction({}, q);
    const question = await prisma.reviewFormQuestion.findFirstOrThrow({ where: { sectionId: sec.id } });
    check("A form section and a required self-review question are added", qRes.ok === true && question.isRequired, qRes.message);
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const d = (n: number) => iso(new Date(today.getTime() + n * DAY));
    const badStages = await tp.saveStageDatesAction({}, fd({ cycleId: cycle.id, selfStartsAt: d(5), managerStartsAt: d(1) }));
    check("Stage dates out of order are refused", badStages.ok === false, badStages.message);
    const stages = await tp.saveStageDatesAction({}, fd({ cycleId: cycle.id, selfStartsAt: d(-1), selfEndsAt: d(5), managerStartsAt: d(-1), managerEndsAt: d(6), calibrationStartsAt: d(0), calibrationEndsAt: d(8), publishOn: d(9) }));
    check("Stage dates in order are saved", stages.ok === true, stages.message);
    const part = fd({ cycleId: cycle.id });
    part.append("employeeIds", meera.emp.id);
    const mapped = await tp.addParticipantsAction({}, part);
    check("Meera is mapped into the cycle by hand", mapped.ok === true, mapped.message);
    await perf.cycleOpAction({}, fd({ cycleId: cycle.id, op: "launch" }));
    const reviews = await prisma.employeeReview.findMany({ where: { cycleId: cycle.id } });
    check("Launching creates reviews for the mapped people only", reviews.length === 1 && reviews[0].employeeId === meera.emp.id, `${reviews.length} review(s)`);
    check("The form is fixed once launched", (await tp.saveFormSectionAction({}, fd({ cycleId: cycle.id, title: "Late" }))).ok === false);
    const review = reviews[0];
    await signInAs("meera.krishnan@acme.test");
    const noAnswer = await perf.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 4, strengths: "Shipped" }));
    check("A self review without the required form answer is refused", noAnswer.ok === false, noAnswer.message);
    const self = await perf.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "SELF", overallRating: 4, strengths: "Shipped", [`q:${question.id}`]: 4 }));
    const resp = await prisma.reviewResponse.findFirst({ where: { reviewId: review.id, reviewerType: "SELF" } });
    check("With it, the self review is submitted and the answer kept", self.ok === true && JSON.stringify(resp?.answers ?? {}).includes(question.id), self.message);
    await signInAs("ananya.ghosh@acme.test");
    const mgr = await perf.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "MANAGER", overallRating: 4, strengths: "Reliable", improvements: "Delegate" }));
    check("Her manager reviews (the self-only question does not apply)", mgr.ok === true, mgr.message);
    await signInAs("vikram.menon@acme.test");
    const cal = await perf.calibrateAction({}, fd({ reviewId: review.id, finalRating: 4, potentialRating: 5 }));
    const calibrated = await prisma.employeeReview.findUniqueOrThrow({ where: { id: review.id } });
    check("Calibration records potential for the 9-box", cal.ok === true && Number(calibrated.potentialRating) === 5, cal.message);
    check("…placing her in the Star box", svc.nineBoxCell(Number(calibrated.finalRating), Number(calibrated.potentialRating)).label === "Star");
    const bands = await prisma.performanceBand.findMany({ where: { cycleId: cycle.id }, orderBy: { minRating: "asc" } });
    const bf = fd({ cycleId: cycle.id });
    bf.set(`max:${bands[0].id}`, String(Number(bands[0].maxRating) + 0.5));
    check("Overlapping bands are refused", (await tp.saveBandsAction({}, bf)).ok === false);
    const rename = await tp.saveBandsAction({}, fd({ cycleId: cycle.id, [`name:${bands[0].id}`]: "Smoke needs support" }));
    check("Bands can be edited, and calibrated reviews re-banded", rename.ok === true && (await prisma.performanceBand.findUniqueOrThrow({ where: { id: bands[0].id } })).name === "Smoke needs support", rename.message);
    const share = await perf.cycleOpAction({}, fd({ cycleId: cycle.id, op: "share" }));
    check("Results cannot be shared before the publish date", share.ok === false, share.message);

    // ---------------------------------------------------------------------
    section("Salary recommendation and the Salary increments inbox");
    await signInAs("meera.krishnan@acme.test");
    check("Only the reviewing manager may recommend", (await tp.recommendSalaryAction({}, fd({ reviewId: review.id, incrementPercent: 50, justification: "x" }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    const pol = await tp.savePromotionPolicyAction({}, fd({ minTenureMonths: 12, minMonthsSinceLastPromotion: 12, minRating: 4, maxIncrementPercent: 25, excludeOnPip: true }));
    check("HR sets the promotion policy", pol.ok === true, pol.message);
    await signInAs("ananya.ghosh@acme.test");
    const tooMuch = await tp.recommendSalaryAction({}, fd({ reviewId: review.id, incrementPercent: 40, justification: "Smoke talent" }));
    check("An increment above the policy cap is refused", tooMuch.ok === false, tooMuch.message);
    const rec = await tp.recommendSalaryAction({}, fd({ reviewId: review.id, incrementPercent: 8, justification: "Smoke talent: strong half" }));
    const row = await prisma.salaryRecommendation.findUnique({ where: { reviewId: review.id } });
    check("The manager recommends 8%", rec.ok === true && row?.status === "PENDING" && Number(row.incrementPercent) === 8, rec.message);
    await signInAs("vikram.menon@acme.test");
    const vv = (await getViewer())!;
    const src = (await talentSources(vv)).find((s) => s.key === "salary-increments");
    const items = src ? await src.list() : [];
    check("It waits in Inbox › Salary increments for someone who revises salaries", !!src && items.some((i) => i.id === row!.id));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot decide recommendations", await denied(() => tp.decideRecommendationAction({}, fd({ id: row!.id, decision: "approve" }))));
    await signInAs("vikram.menon@acme.test");
    check("Rejecting needs a reason", (await tp.decideRecommendationAction({}, fd({ id: row!.id, decision: "reject" }))).ok === false);
    const dec = await tp.decideRecommendationAction({}, fd({ id: row!.id, decision: "approve" }));
    check("HR approves it", dec.ok === true && (await prisma.salaryRecommendation.findUniqueOrThrow({ where: { id: row!.id } })).status === "APPROVED", dec.message);

    // ---------------------------------------------------------------------
    section("Feedback settings and requests");
    const colleague = await prisma.employee.findFirstOrThrow({ where: { tenantId, departmentId: meera.emp.departmentId, id: { notIn: [meera.emp.id, ananya.emp.id] }, status: { notIn: ["EXITED", "PREBOARDING"] }, userId: { not: null } }, include: { user: true } });
    const chainIds: string[] = [];
    for (let at: string | null = meera.emp.reportingManagerId; at && !chainIds.includes(at); at = (await prisma.employee.findUnique({ where: { id: at }, select: { reportingManagerId: true } }))?.reportingManagerId ?? null) chainIds.push(at);
    const outsider = await prisma.employee.findFirst({ where: { tenantId, departmentId: { not: meera.emp.departmentId }, id: { notIn: [meera.emp.id, ...chainIds] }, status: { notIn: ["EXITED", "PREBOARDING"] } } });
    const fs = await tp.saveFeedbackSettingsAction({}, fd({ whoCanGive: "SAME_DEPARTMENT", allowAnonymous: false, allowRequests: true }));
    check("HR limits feedback to the same department, without anonymity", fs.ok === true, fs.message);
    await signInAs("meera.krishnan@acme.test");
    if (outsider) {
      const ask = fd({ message: "Smoke talent: x" }); ask.append("askedIds", outsider.id);
      check("Asking someone from another department is refused", (await tp.requestFeedbackAction({}, ask)).ok === false);
      const give = await fb.giveFeedbackAction({}, fd({ aboutEmployeeId: outsider.id, kind: "FEEDBACK", topic: "x", message: "Smoke talent: across" }));
      check("…as is giving them feedback", give.ok === false, give.message);
    }
    const ask = fd({ message: "Smoke talent: how was the launch?" }); ask.append("askedIds", colleague.id);
    const asked = await tp.requestFeedbackAction({}, ask);
    const fr = await prisma.feedbackRequest.findFirst({ where: { tenantId, requesterId: meera.emp.id, askedId: colleague.id, status: "PENDING" } });
    check("Meera asks a colleague for feedback", asked.ok === true && !!fr, asked.message);
    await signInAs(colleague.user!.email);
    const anon = await tp.answerFeedbackRequestAction({}, fd({ id: fr!.id, message: "Smoke talent: great", anonymous: true }));
    check("Answering anonymously is refused when the company does not allow it", anon.ok === false, anon.message);
    const ans = await tp.answerFeedbackRequestAction({}, fd({ id: fr!.id, message: "Smoke talent: great launch" }));
    const answered = await prisma.feedbackRequest.findUniqueOrThrow({ where: { id: fr!.id } });
    check("The colleague answers; the request is marked given", ans.ok === true && answered.status === "GIVEN" && !!answered.feedbackId, ans.message);
    check("…and cannot answer twice", (await tp.answerFeedbackRequestAction({}, fd({ id: fr!.id, message: "again" }))).ok === false);

    // ---------------------------------------------------------------------
    section("Growth plans");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot add growth templates", (await tp.saveGrowthTemplateAction({}, fd({ name: "Smoke talent g", items: "x" }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    check("Badly formed items are refused", (await tp.saveGrowthTemplateAction({}, fd({ name: "Smoke talent bad", items: "Lead | DANCE" }))).ok === false);
    const gt = await tp.saveGrowthTemplateAction({}, fd({ name: "Smoke talent: senior engineer", items: "System design course | COURSE | 30\nLead an incident review | MILESTONE | 60" }));
    const gtpl = await prisma.growthPlanTemplate.findFirstOrThrow({ where: { tenantId, name: "Smoke talent: senior engineer" } });
    check("HR adds a growth plan template", gt.ok === true, gt.message);
    const gp = await tp.startGrowthPlanAction({}, fd({ templateId: gtpl.id, employeeId: meera.emp.id, title: "Smoke talent: Meera to senior" }));
    const plan = await prisma.growthPlan.findFirstOrThrow({ where: { tenantId, title: "Smoke talent: Meera to senior" }, include: { items: { orderBy: { displayOrder: "asc" } } } });
    check("A plan is started for Meera with dated items", gp.ok === true && plan.items.length === 2 && !!plan.items[0].dueDate, gp.message);
    await signInAs("meera.krishnan@acme.test");
    await tp.toggleGrowthItemAction({}, fd({ id: plan.items[0].id }));
    const last = await tp.toggleGrowthItemAction({}, fd({ id: plan.items[1].id }));
    check("Ticking off every item completes the plan", last.ok === true && (await prisma.growthPlan.findUniqueOrThrow({ where: { id: plan.id } })).status === "COMPLETED", last.message);

    // ---------------------------------------------------------------------
    section("Talent pools, internal applications and the candidate profile");
    const app = await prisma.application.findFirstOrThrow({ where: { tenantId, status: "ACTIVE" }, include: { candidate: true, job: true } });
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create talent pools", await denied(() => th.createPoolAction({}, fd({ name: "Smoke talent pool" }))));
    await signInAs("priya.sharma@acme.test");
    await th.createPoolAction({}, fd({ name: "Smoke talent: silver medallists" }));
    const pool = await prisma.talentPool.findFirstOrThrow({ where: { tenantId, name: "Smoke talent: silver medallists" } });
    const added = await th.addToPoolAction({}, fd({ poolId: pool.id, candidateId: app.candidateId, note: "Strong" }));
    check("A candidate is saved to a pool", added.ok === true, added.message);
    check("…only once", (await th.addToPoolAction({}, fd({ poolId: pool.id, candidateId: app.candidateId }))).ok === false);
    const otherJob = await prisma.job.findFirst({ where: { tenantId, status: "OPEN", id: { not: app.jobId }, applications: { none: { candidateId: app.candidateId } } } });
    if (otherJob) {
      const moved = await th.poolToJobAction({}, fd({ candidateId: app.candidateId, jobId: otherJob.id }));
      const newApp = await prisma.application.findFirst({ where: { jobId: otherJob.id, candidateId: app.candidateId } });
      if (newApp) made.internalApps.push(newApp.id);
      check("A pooled candidate is put forward for another open job", moved.ok === true && !!newApp, moved.message);
    }
    made.jobs.push({ id: app.jobId, allowInternal: app.job.allowInternal, scorecardTemplate: app.job.scorecardTemplate });
    await prisma.job.update({ where: { id: app.jobId }, data: { allowInternal: false } });
    await signInAs("meera.krishnan@acme.test");
    check("Internal applications need a job open to them", (await th.applyInternallyAction({}, fd({ jobId: app.jobId }))).ok === false);
    await prisma.job.update({ where: { id: app.jobId }, data: { allowInternal: true } });
    const applied = await th.applyInternallyAction({}, fd({ jobId: app.jobId, note: "Smoke talent" }));
    const ia = await prisma.internalApplication.findFirst({ where: { tenantId, employeeId: meera.emp.id, application: { jobId: app.jobId } }, include: { application: { include: { candidate: true } } } });
    if (ia) made.internalApps.push(ia.applicationId);
    check("Meera applies from the internal job board", applied.ok === true && ia?.application.candidate.source === "INTERNAL", applied.message);
    check("…once", (await th.applyInternallyAction({}, fd({ jobId: app.jobId }))).ok === false);
    if (ia) await prisma.candidate.update({ where: { id: ia.application.candidateId }, data: { email: `meera.internal@talent-smoke.test` } });

    await signInAs("priya.sharma@acme.test");
    const notPdf = fd({ candidateId: app.candidateId, applicationId: app.id });
    notPdf.append("resume", new File([new Uint8Array(Buffer.from("not a pdf"))], "cv.pdf", { type: "application/pdf" }));
    check("A résumé that is not a PDF is refused", (await th.uploadResumeAction({}, notPdf)).ok === false);
    const prevResume = app.candidate.resumeUrl;
    const up = fd({ candidateId: app.candidateId, applicationId: app.id });
    up.append("resume", new File([new Uint8Array(PDF)], "cv.pdf", { type: "application/pdf" }));
    const upRes = await th.uploadResumeAction({}, up);
    const withResume = await prisma.candidate.findUniqueOrThrow({ where: { id: app.candidateId } });
    const fileId = withResume.resumeUrl?.split("/").pop() ?? "";
    made.files.push(fileId);
    check("A PDF résumé is uploaded to the candidate", upRes.ok === true && !!withResume.resumeUrl?.startsWith("/files/"), upRes.message);
    const inline = await filesRoute.GET(new NextRequest(`http://acme.localhost:3100/files/${fileId}?inline=1`), { params: Promise.resolve({ id: fileId }) });
    const attach = await filesRoute.GET(new NextRequest(`http://acme.localhost:3100/files/${fileId}`), { params: Promise.resolve({ id: fileId }) });
    check("…previewed inline, downloaded otherwise", inline.status === 200 && /^inline/.test(inline.headers.get("content-disposition") ?? "") && /^attachment/.test(attach.headers.get("content-disposition") ?? ""));
    await signInAs("meera.krishnan@acme.test");
    const peek = await filesRoute.GET(new NextRequest(`http://acme.localhost:3100/files/${fileId}?inline=1`), { params: Promise.resolve({ id: fileId }) });
    check("…but never to someone without candidate rights", peek.status === 404);
    await prisma.candidate.update({ where: { id: app.candidateId }, data: { resumeUrl: prevResume } });

    await signInAs("vikram.menon@acme.test");
    const cf = await th.saveCandidateFieldAction({}, fd({ label: "Smoke talent: relocate", type: "DROPDOWN", options: "Yes, No", isMandatory: true }));
    const def = await prisma.customFieldDefinition.findFirstOrThrow({ where: { tenantId, entity: "CANDIDATE", label: "Smoke talent: relocate" } });
    check("HR adds a mandatory candidate field", cf.ok === true, cf.message);
    const prevProfile = { education: app.candidate.education, skills: app.candidate.skills, totalExperienceYears: app.candidate.totalExperienceYears };
    check("Saving a profile without it is refused", (await th.saveCandidateProfileAction({}, fd({ candidateId: app.candidateId, applicationId: app.id, education: "B.Tech" }))).ok === false);
    const prof = await th.saveCandidateProfileAction({}, fd({ candidateId: app.candidateId, applicationId: app.id, education: "B.Tech Computer Science", skills: "Kubernetes, Go, Terraform", totalExperienceYears: 6, [`cf_${def.id}`]: "Yes" }));
    const val = await prisma.customFieldValue.findUnique({ where: { definitionId_ownerId: { definitionId: def.id, ownerId: app.candidateId } } });
    check("Education, skills and the custom field are saved", prof.ok === true && val?.value === "Yes", prof.message);
    const badWeights = await th.saveScoreConfigAction({}, fd({ skillsWeight: 50, experienceWeight: 50, educationWeight: 50, idealExperienceYears: 5 }));
    check("Profile score weights must add up to 100", badWeights.ok === false, badWeights.message);
    const sc = await th.saveScoreConfigAction({}, fd({ skillsWeight: 40, experienceWeight: 40, educationWeight: 20, idealExperienceYears: 5, skillKeywords: "kubernetes, go", educationKeywords: "computer science" }));
    const cand = await prisma.candidate.findUniqueOrThrow({ where: { id: app.candidateId } });
    const score = await profileScoreFor(tenantId, cand, { skills: [], minExperienceYears: 4 });
    check("The profile score follows the company's weights", sc.ok === true && score.score === 100, `${sc.message} → ${score.score}`);
    await prisma.candidate.update({ where: { id: app.candidateId }, data: { education: prevProfile.education, skills: (prevProfile.skills ?? undefined) as never, totalExperienceYears: prevProfile.totalExperienceYears } });

    const lib = await th.saveScorecardLibraryAction({}, fd({ name: "Smoke talent: SRE", kit: "Reliability: Incident response, Capacity planning\nSoft Skills: Communication" }));
    const libRow = await prisma.scorecardTemplate.findFirstOrThrow({ where: { tenantId, name: "Smoke talent: SRE" } });
    check("A scorecard joins the library", lib.ok === true, lib.message);
    const applied2 = await th.applyScorecardToJobAction({}, fd({ templateId: libRow.id, jobId: app.jobId }));
    const kit = svc.kitOf((await prisma.job.findUniqueOrThrow({ where: { id: app.jobId } })).scorecardTemplate);
    check("…and is applied to a job's interview kit", applied2.ok === true && kit.some((k) => k.section === "Reliability"), applied2.message);

    // ---------------------------------------------------------------------
    section("Candidate self-scheduling");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot send booking links", await denied(() => th.offerSlotsAction({}, fd({ applicationId: app.id }))));
    await signInAs("priya.sharma@acme.test");
    const s1 = new Date(Math.ceil((Date.now() + 3 * DAY) / 3_600_000) * 3_600_000 + 17 * 60_000), s2 = new Date(s1.getTime() + DAY);
    const tooSoon = fd({ applicationId: app.id, title: "Smoke talent interview", durationMinutes: 45, slots: local(new Date(Date.now() + 5 * 60_000)), panelIds: sneha.emp.id });
    check("Slots must be in the future", (await th.offerSlotsAction({}, tooSoon)).ok === false);
    const offer = fd({ applicationId: app.id, title: "Smoke talent interview", mode: "VIDEO", durationMinutes: 45, panelIds: sneha.emp.id });
    offer.append("slots", local(s1)); offer.append("slots", local(s2));
    const sent = await th.offerSlotsAction({}, offer);
    const url = sent.values?.url ?? "";
    const token = url.split("/schedule/")[1] ?? "";
    const mail = await prisma.emailOutbox.findFirst({ where: { tenantId, relatedType: "InterviewSlotOffer", createdAt: { gte: started } } });
    check("The candidate is emailed a personal booking link", sent.ok === true && !!token && !!mail?.textBody?.includes(url), sent.message);
    check("A wrong token shows nothing", (await svc.openSlotOffer(token.slice(0, -2) + "xx")) === null);
    const view = await svc.openSlotOffer(token);
    check("The link shows only this invitation's times", view?.status === "OPEN" && view.slots.length === 2 && view.job === app.job.title);
    setTestSession(null);
    setTestHeaders({ "x-forwarded-for": "203.0.113.77" });
    check("Booking a time that was not offered is refused", (await sched.bookSlotAction({}, fd({ token, slot: new Date(s1.getTime() + 3_600_000).toISOString() }))).ok === false);
    const booked = await sched.bookSlotAction({}, fd({ token, slot: s1.toISOString() }));
    const slotRow = await prisma.interviewSlotOffer.findFirstOrThrow({ where: { tenantId, applicationId: app.id, title: "Smoke talent interview" } });
    if (slotRow.interviewId) made.interviews.push(slotRow.interviewId);
    const iv = slotRow.interviewId ? await prisma.interview.findUnique({ where: { id: slotRow.interviewId }, include: { panel: true } }) : null;
    check("Signed out, the candidate books a slot and the interview is scheduled with the panel", booked.ok === true && slotRow.status === "BOOKED" && iv?.scheduledAt.getTime() === s1.getTime() && iv.panel.some((p) => p.employeeId === sneha.emp.id), booked.message);
    check("…exactly once", (await sched.bookSlotAction({}, fd({ token, slot: s2.toISOString() }))).ok === false);

    // ---------------------------------------------------------------------
    section("Multi-level requisition approval");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot set approval chains", (await th.saveApprovalRuleAction({}, fd({ kind: "REQUISITION", name: "Smoke talent x", approverUserIds: vikram.user.id }))).ok === false);
    await signInAs("vikram.menon@acme.test");
    const rule = fd({ kind: "REQUISITION", name: "Smoke talent: platform chain", departmentId: dept.id, priority: 1 });
    rule.append("approverUserIds", sneha.user.id); rule.append("approverUserIds", vikram.user.id);
    const ruleRes = await th.saveApprovalRuleAction({}, rule);
    check("HR adds a two-level chain for Platform Engineering", ruleRes.ok === true, ruleRes.message);
    await signInAs("priya.sharma@acme.test");
    await hiring.raiseRequisitionAction({}, fd({ title: "Smoke talent SRE", departmentId: dept.id, newHire: true, newPositions: 1, currency: "INR", salaryMin: 2000000, salaryMax: 3000000, salaryFrequency: "ANNUAL", description: "Reliability engineering for the platform team.", justification: "Smoke talent" }));
    const req = await prisma.requisition.findFirstOrThrow({ where: { tenantId, title: "Smoke talent SRE" } });
    const steps = await prisma.hireApprovalStep.findMany({ where: { tenantId, kind: "REQUISITION", entityId: req.id }, orderBy: { sequence: "asc" } });
    check("The requisition is routed to the first approver in the chain", req.approverUserId === sneha.user.id && steps.length === 2 && steps[0].status === "PENDING" && steps[1].status === "WAITING");
    await signInAs("vikram.menon@acme.test");
    const early = await hiring.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    check("The second approver cannot jump the queue", early.ok === false && (await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } })).status === "PENDING_APPROVAL", early.message);
    await signInAs("sneha.reddy@acme.test");
    const lvl1 = await hiring.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    const mid = await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } });
    check("Level 1 approves; it moves to level 2", lvl1.ok === true && mid.status === "PENDING_APPROVAL" && mid.approverUserId === vikram.user.id, lvl1.message);
    await signInAs("vikram.menon@acme.test");
    const lvl2 = await hiring.decideRequisitionAction({}, fd({ id: req.id, decision: "approve" }));
    check("The last level approves it", lvl2.ok === true && (await prisma.requisition.findUniqueOrThrow({ where: { id: req.id } })).status === "APPROVED", lvl2.message);
    const offerChain = await svc.startHireChain({ tenantId, kind: "OFFER", entityId: "smoke-talent-entity", departmentId: dept.id, amount: 100, requesterUserId: null });
    check("With no offer chain configured, offers keep the existing approval", offerChain.firstApprover === null);

    // ---------------------------------------------------------------------
    section("Career site and EEO");
    const badColour = await th.saveCareerSiteAction({}, fd({ primaryColor: "red", accentColor: "#0f8a55" }));
    check("Colours must be hex", badColour.ok === false, badColour.message);
    const site = await th.saveCareerSiteAction({}, fd({ headline: "Smoke talent: build with us", about: "We make HR software.", primaryColor: "#aa3366", accentColor: "#0f8a55", embedEnabled: true, collectEeo: true }));
    check("HR brands the career site and turns on EEO self-identification", site.ok === true && (await prisma.careerSiteSetting.findUniqueOrThrow({ where: { tenantId } })).collectEeo, site.message);
    const pub = await prisma.job.findFirstOrThrow({ where: { tenantId, status: "OPEN", isPublished: true, OR: [{ closesAt: null }, { closesAt: { gte: new Date() } }] } });
    setTestSession(null);
    setTestHeaders({ host: "acme.localhost:3100", "x-forwarded-for": "203.0.113.90" });
    const af = fd({ jobId: pub.id, firstName: "Eeo", lastName: "Smoke", email: "eeo@talent-smoke.test", consent: "on", eeo_gender: "Female", eeo_ethnicity: "Not a real option" });
    af.append("resume", new File([new Uint8Array(PDF)], "cv.pdf", { type: "application/pdf" }));
    const ap = await careers.applyToJobAction({}, af);
    const eeoCand = await prisma.candidate.findFirst({ where: { tenantId, email: "eeo@talent-smoke.test" }, include: { eeo: true } });
    check("An applicant's voluntary answers are stored apart from the application", ap.ok === true && eeoCand?.eeo?.gender === "Female" && eeoCand.eeo.declined === false, ap.message);
    check("…and only the offered values are kept", eeoCand?.eeo?.ethnicity === null);
    const leak = await assetRoute.GET(new NextRequest(`http://acme.localhost:3100/careers/asset/${fileId}`), { params: Promise.resolve({ id: fileId }) });
    check("The public asset route never serves other stored files", leak.status === 404);

    // ---------------------------------------------------------------------
    section("Another company's records stay out of reach");
    const rival = await prisma.tenant.create({ data: { subdomain: "rival-talent-smoke", name: "Rival Talent" } });
    rivalId = rival.id;
    const rCand = await prisma.candidate.create({ data: { tenantId: rival.id, firstName: "Rival", lastName: "Cand", email: "r@rival.test" } });
    const rPool = await prisma.talentPool.create({ data: { tenantId: rival.id, name: "Rival pool", members: { create: [{ candidateId: rCand.id }] } }, include: { members: true } });
    const rTpl = await prisma.scorecardTemplate.create({ data: { tenantId: rival.id, name: "Rival kit", kit: [{ section: "X", skills: [{ name: "Y" }] }] } });
    const rRule = await prisma.hireApprovalRule.create({ data: { tenantId: rival.id, kind: "OFFER", name: "Rival chain", approverUserIds: [] } });
    const rTf = await prisma.goalTimeframe.create({ data: { tenantId: rival.id, name: "Rival FY", kind: "YEAR", startDate: new Date("2027-01-01"), endDate: new Date("2027-12-31") } });
    await signInAs("vikram.menon@acme.test");
    check("Acme cannot remove a rival pool member", await refused(() => th.removeFromPoolAction({}, fd({ id: rPool.members[0].id }))));
    check("…save a candidate to a rival pool", await refused(() => th.addToPoolAction({}, fd({ poolId: rPool.id, candidateId: app.candidateId }))));
    check("…touch a rival candidate", await refused(() => th.saveCandidateProfileAction({}, fd({ candidateId: rCand.id, applicationId: "x", education: "hack" }))));
    check("…apply a rival scorecard", await refused(() => th.applyScorecardToJobAction({}, fd({ templateId: rTpl.id, jobId: app.jobId }))));
    check("…pause a rival approval chain", await refused(() => th.toggleApprovalRuleAction({}, fd({ id: rRule.id }))));
    check("…use a rival goal timeframe", await refused(() => tp.toggleTimeframeAction({}, fd({ id: rTf.id }))));
    check("…or decide an unknown recommendation", await refused(() => tp.decideRecommendationAction({}, fd({ id: rPool.id, decision: "approve" }))));
    const rAfter = await prisma.hireApprovalRule.findUniqueOrThrow({ where: { id: rRule.id } });
    check("The rival's records are unchanged", rAfter.isActive && (await prisma.talentPoolMember.count({ where: { poolId: rPool.id } })) === 1 && (await prisma.candidate.findUniqueOrThrow({ where: { id: rCand.id } })).education === null);

    // ---------------------------------------------------------------------
    section("Every new page renders");
    const React = (globalThis as unknown as { React: typeof import("react") }).React;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
    const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
    const noop = () => {};
    const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };
    async function resolve(node: unknown): Promise<unknown> {
      if (Array.isArray(node)) return Promise.all(node.map(resolve));
      if (!React.isValidElement(node)) return node;
      const el = node as ReactElement<Record<string, unknown>>;
      if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(el.props ?? {})) if (k !== "children") props[k] = React.isValidElement(v) || Array.isArray(v) ? await resolve(v) : v;
      const children = el.props?.children;
      return Array.isArray(children) ? React.cloneElement(el, props, ...((await resolve(children)) as ReactNode[])) : React.cloneElement(el, props, (await resolve(children)) as ReactNode);
    }
    const html = async (tree: unknown, pathname: string) => renderToStaticMarkup(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
          React.createElement(PathnameContext.Provider, { value: pathname }, (await resolve(tree)) as ReactNode))));
    const render = async (mod: string, pathname: string, params: Record<string, string> = {}, sp: SP = {}) => {
      try {
        const page = (await import(mod)).default as Page;
        return await html(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(sp) }), pathname);
      } catch (e) { return `ERROR ${(e as Error).message}`; }
    };
    const W = "../apps/web/src/app";
    await signInAs("vikram.menon@acme.test");
    setTestHeaders({ host: "acme.localhost:3100" });
    const pagesToRender: Array<[string, string, Record<string, string>, SP, string]> = [
      [`${W}/(app)/performance/goals/library/page`, "/performance/goals/library", {}, {}, "Smoke talent: cut p95 latency"],
      [`${W}/(app)/performance/cycles/[id]/setup/page`, `/performance/cycles/${cycle.id}/setup`, { id: cycle.id }, {}, "Quality of delivery"],
      [`${W}/(app)/performance/cycles/[id]/page`, `/performance/cycles/${cycle.id}`, { id: cycle.id }, {}, "Star"],
      [`${W}/(app)/performance/reviews/[id]/page`, `/performance/reviews/${review.id}`, { id: review.id }, {}, "Quality of delivery"],
      [`${W}/(app)/performance/settings/page`, "/performance/settings", {}, {}, "anonymous"],
      [`${W}/(app)/performance/analytics/page`, "/performance/analytics", {}, {}, ""],
      [`${W}/(app)/performance/growth/page`, "/performance/growth", {}, {}, "Smoke talent: senior engineer"],
      [`${W}/(app)/performance/one-on-ones/log/page`, "/performance/one-on-ones/log", {}, {}, ""],
      [`${W}/(app)/hiring/pools/page`, "/hiring/pools", {}, { q: "a" }, "Smoke talent: silver medallists"],
      [`${W}/(app)/hiring/pools/[id]/page`, `/hiring/pools/${pool.id}`, { id: pool.id }, {}, app.candidate.firstName],
      [`${W}/(app)/hiring/reports/page`, "/hiring/reports", {}, {}, "Panel member activity"],
      [`${W}/(app)/hiring/settings/approvals/page`, "/hiring/settings/approvals", {}, {}, "Smoke talent: platform chain"],
      [`${W}/(app)/hiring/settings/talent/page`, "/hiring/settings/talent", {}, {}, "Smoke talent: SRE"],
      [`${W}/(app)/hiring/settings/careers/page`, "/hiring/settings/careers", {}, {}, "/embed/careers.js"],
      [`${W}/(app)/hiring/jobs/[id]/page`, `/hiring/jobs/${app.jobId}`, { id: app.jobId }, { tab: "scorecard" }, "Reliability"],
      [`${W}/careers/page`, "/careers", {}, {}, "Smoke talent: build with us"],
      [`${W}/embed/careers/page`, "/embed/careers", {}, {}, pub.title],
      [`${W}/schedule/[token]/page`, `/schedule/${token}`, { token }, {}, "You are booked"],
    ];
    for (const [mod, pathname, params, sp, expect] of pagesToRender) {
      const out = await render(mod, pathname, params, sp);
      check(`${pathname.replace(/[a-z0-9]{20,}/g, ":id")} renders`, !out.startsWith("ERROR") && out.includes(expect), out.startsWith("ERROR") ? out.slice(0, 200) : expect && !out.includes(expect) ? `missing “${expect}”` : "");
    }
    const { TalentPanel } = await import("../apps/web/src/app/(app)/hiring/_parts/talent-panel");
    const panel = await html(React.createElement(TalentPanel, { viewer: (await getViewer())!, applicationId: app.id }), `/hiring/applications/${app.id}`);
    check("The candidate's talent panel renders the profile score and pools", panel.includes("Profile score") && panel.includes("Smoke talent: silver medallists"));
    await signInAs("meera.krishnan@acme.test");
    for (const [mod, pathname, expect] of [[`${W}/(app)/me/performance/requests/page`, "/me/performance/requests", colleague.displayName ?? colleague.firstName], [`${W}/(app)/me/performance/growth/page`, "/me/performance/growth", "Smoke talent: Meera to senior"], [`${W}/(app)/hiring/refer/page`, "/hiring/refer", "Internal job board"]] as const) {
      const out = await render(mod, pathname);
      check(`${pathname} renders for an employee`, !out.startsWith("ERROR") && out.includes(expect), out.startsWith("ERROR") ? out.slice(0, 200) : !out.includes(expect) ? `missing “${expect}”` : "");
    }
    const vv2 = (await getViewer())!;
    const { takeActionSources } = await import("../apps/web/src/app/(app)/inbox/_take/registry");
    check("An employee sees no Salary increments inbox", !(await takeActionSources(vv2)).some((x) => x.key === "salary-increments"));
  } finally {
    await cleanup();
    void rivalId;
    await prisma.$disconnect();
  }
  report("Talent depth");
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
