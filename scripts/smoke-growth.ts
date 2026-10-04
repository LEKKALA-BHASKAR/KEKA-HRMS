/**
 * Growth modules through their real actions and routes: learning (course
 * review, enrolment and retake requests, certificates, paths, sessions, the
 * course builder, reports), talent reviews and succession, internal mobility,
 * skills and competency frameworks, development plans, coaching and PIPs, and
 * feedback templates. Every flow checks who may act, the approval step that
 * a second person must take, and that the report exports. Everything it
 * creates is named "SMK-G …" and removed afterwards.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const prisma = new PrismaClient();
const TAG = "SMK-G";

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
function form(values: Record<string, string | number | boolean | undefined | null>, lists: Record<string, string[]> = {}) {
  const f = fd(values);
  for (const [k, vs] of Object.entries(lists)) for (const v of vs) f.append(k, v);
  return f;
}
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const req = (path: string) => new NextRequest(new URL(path, "http://acme.localhost:3000"));
const S = {} as never;

async function main() {
  const lg = await import("../apps/web/src/app/actions/learn-growth");
  const lrn = await import("../apps/web/src/app/actions/learning");
  const pl = await import("../apps/web/src/app/actions/performance-learn");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const meera = await emp("ACM0009"), ananya = await emp("ACM0007"), sneha = await emp("ACM0005"), deepak = await emp("ACM0019"), vikram = await emp("ACM0001");
  const started = new Date();
  const jobChanges: string[] = [], approvalRequests: string[] = [], pips: string[] = [];
  const restore: Array<() => Promise<unknown>> = [];

  console.log("\nGrowth: learning, succession, mobility, skills, development\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Learning: course review, enrolment requests, retakes, certificates");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a course", await denied(() => lrn.saveCourseAction(S, fd({ title: "x", category: "x", level: "BEGINNER" }))));
    await signInAs("priya.sharma@acme.test");
    const base = await lrn.saveCourseAction(S, fd({ title: `${TAG} Basics`, category: "Smoke", level: "BEGINNER", passPercent: 50 }));
    const baseId = base.values?.courseId ?? "";
    await lrn.addLessonAction(S, fd({ courseId: baseId, title: "Read me", kind: "ARTICLE", body: "Hello", durationMinutes: 5 }));
    const made = await lrn.saveCourseAction(S, fd({ title: `${TAG} Secure Coding`, category: "Smoke", level: "INTERMEDIATE", passPercent: 100, requiresApproval: true, certificateValidityMonths: 12, credits: 3, prerequisiteCourseId: baseId }));
    const courseId = made.values?.courseId ?? "";
    const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
    check("A course saves approval, certificate validity, credits and a prerequisite", made.ok && course.requiresApproval && course.certificateValidityMonths === 12 && course.credits === 3 && course.prerequisiteCourseId === baseId, made.message);
    await lrn.addLessonAction(S, fd({ courseId, title: "Injection", kind: "ARTICLE", body: "Parameterise queries.", durationMinutes: 10 }));
    await lrn.addLessonAction(S, fd({ courseId, title: "Check", kind: "QUIZ", durationMinutes: 5 }));
    const quiz = await prisma.courseLesson.findFirstOrThrow({ where: { courseId, kind: "QUIZ" } });
    await lrn.addQuizQuestionAction(S, fd({ lessonId: quiz.id, prompt: "Safe?", options: "Concatenate\nBind parameters", correct: 2 }));
    const imported = await lg.importQuizQuestionsAction(S, fd({ lessonId: quiz.id, csv: "Question,Type,Option 1,Option 2,Option 3,Correct\nPick b,single,a,b,c,2" }));
    const q2 = await prisma.quizQuestion.findFirst({ where: { lessonId: quiz.id, prompt: "Pick b" } });
    check("Quiz questions import from CSV", imported.ok && !!q2, imported.message);
    if (q2) {
      const edited = await lg.updateQuizQuestionAction(S, fd({ questionId: q2.id, prompt: "Pick b now", options: "a\nb", correct: 2 }));
      check("A quiz question can be edited", edited.ok, edited.message);
      const del = await lg.deleteQuizQuestionAction(S, fd({ questionId: q2.id }));
      check("A quiz question can be deleted", del.ok && !(await prisma.quizQuestion.count({ where: { id: q2.id } })), del.message);
    }
    const rules = await lg.setQuizRulesAction(S, fd({ lessonId: quiz.id, maxAttempts: 1 }));
    check("The quiz is limited to one attempt", rules.ok && (await prisma.courseLesson.findUniqueOrThrow({ where: { id: quiz.id } })).maxAttempts === 1, rules.message);
    const sub = await lg.courseReviewAction(S, fd({ courseId, op: "submit" }));
    const self = await lg.courseReviewAction(S, fd({ courseId, op: "approve" }));
    check("The author submits the course and cannot approve it", sub.ok && !self.ok && (await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).status === "IN_REVIEW", self.message);
    await signInAs("vikram.menon@acme.test");
    const back = await lg.courseReviewAction(S, fd({ courseId, op: "reject" }));
    check("Sending a course back needs a note", !back.ok, back.message);
    const approved = await lg.courseReviewAction(S, fd({ courseId, op: "approve", note: "Good" }));
    const baseOk = await lrn.courseOpAction(S, fd({ courseId: baseId, op: "publish" }));
    check("A second course admin approves and publishes it", approved.ok && baseOk.ok && (await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).status === "PUBLISHED", approved.message);

    await signInAs("meera.krishnan@acme.test");
    const direct = await lrn.enrolSelfAction(S, fd({ courseId }));
    check("A course that needs approval cannot be self-enrolled", !direct.ok, direct.message);
    const early = await lg.requestEnrolmentAction(S, fd({ courseId, reason: "For the audit" }));
    check("The prerequisite must be completed first", !early.ok && /Basics/.test(early.message ?? ""), early.message);
    await lrn.enrolSelfAction(S, fd({ courseId: baseId }));
    const baseEnrol = await prisma.courseEnrolment.findFirstOrThrow({ where: { courseId: baseId, employeeId: meera.id } });
    const baseLesson = await prisma.courseLesson.findFirstOrThrow({ where: { courseId: baseId } });
    await lrn.completeLessonAction(S, fd({ enrolmentId: baseEnrol.id, lessonId: baseLesson.id }));
    const asked = await lg.requestEnrolmentAction(S, fd({ courseId, reason: "For the audit" }));
    const reqRow = await prisma.learningRequest.findFirst({ where: { courseId, employeeId: meera.id, kind: "ENROLMENT" } });
    check("After the prerequisite, the employee requests enrolment", asked.ok && reqRow?.status === "PENDING", asked.message);
    await signInAs("manish.tiwari@acme.test");
    const outsider = await lg.decideLearningRequestAction(S, fd({ requestId: reqRow?.id, decision: "approve" }));
    check("Someone outside her line cannot decide it", !outsider.ok, outsider.message);
    await signInAs("ananya.ghosh@acme.test");
    const ok1 = await lg.decideLearningRequestAction(S, fd({ requestId: reqRow?.id, decision: "approve" }));
    const enrol = await prisma.courseEnrolment.findFirst({ where: { courseId, employeeId: meera.id } });
    check("Her manager approves and she is enrolled", ok1.ok && !!enrol, ok1.message);

    await signInAs("meera.krishnan@acme.test");
    const article = await prisma.courseLesson.findFirstOrThrow({ where: { courseId, kind: "ARTICLE" } });
    await lrn.completeLessonAction(S, fd({ enrolmentId: enrol!.id, lessonId: article.id }));
    const q = await prisma.quizQuestion.findFirstOrThrow({ where: { lessonId: quiz.id } });
    const wrong = await lrn.submitQuizAction(S, fd({ enrolmentId: enrol!.id, lessonId: quiz.id, ["qq_" + q.id]: 0 }));
    const again = await lrn.submitQuizAction(S, fd({ enrolmentId: enrol!.id, lessonId: quiz.id, ["qq_" + q.id]: 1 }));
    check("A failed attempt uses up the single attempt", !wrong.ok && !again.ok && /attempts/.test(again.message ?? ""), again.message);
    const retake = await lg.requestRetakeAction(S, fd({ enrolmentId: enrol!.id, lessonId: quiz.id, reason: "Misread" }));
    const rt = await prisma.learningRequest.findFirstOrThrow({ where: { lessonId: quiz.id, employeeId: meera.id, kind: "RETAKE" } });
    await signInAs("ananya.ghosh@acme.test");
    const rtNo = await lg.decideLearningRequestAction(S, fd({ requestId: rt.id, decision: "reject" }));
    const rtOk = await lg.decideLearningRequestAction(S, fd({ requestId: rt.id, decision: "approve" }));
    check("A retake is requested; rejecting needs a reason; the manager approves", retake.ok && !rtNo.ok && rtOk.ok, rtOk.message);
    await signInAs("meera.krishnan@acme.test");
    const pass = await lrn.submitQuizAction(S, fd({ enrolmentId: enrol!.id, lessonId: quiz.id, ["qq_" + q.id]: 1 }));
    const cert = await prisma.learningCertificate.findFirst({ where: { enrolmentId: enrol!.id } });
    check("The approved retake is passed and a numbered certificate is issued", pass.ok && !!cert && !!cert.expiresAt, `${pass.message} ${cert?.number ?? ""}`);

    const certRoute = await import("../apps/web/src/app/(app)/learn/certificates/[id]/route");
    const certGet = (id: string) => certRoute.GET(req(`/learn/certificates/${id}`), { params: Promise.resolve({ id }) });
    const mine = await certGet(cert!.id);
    const pdf = Buffer.from(await mine.arrayBuffer());
    check("The holder downloads the certificate as a PDF", mine.status === 200 && pdf.subarray(0, 4).toString() === "%PDF", `${mine.status}`);
    await signInAs("manish.tiwari@acme.test");
    check("Someone outside her line gets not-found", (await certGet(cert!.id)).status === 404);
    await signInAs("ananya.ghosh@acme.test");
    check("Her manager can download it", (await certGet(cert!.id)).status === 200);
    check("Certificate downloads are audited", (await prisma.auditLog.count({ where: { entityType: "LearningCertificate", entityId: cert!.id, action: "EXPORT" } })) >= 2);
    await signInAs("priya.sharma@acme.test");
    const noReason = await lg.revokeCertificateAction(S, fd({ certificateId: cert!.id }));
    const revoked = await lg.revokeCertificateAction(S, fd({ certificateId: cert!.id, reason: "Issued in error" }));
    await signInAs("meera.krishnan@acme.test");
    check("A revoked certificate (reason required) no longer downloads", !noReason.ok && revoked.ok && (await certGet(cert!.id)).status === 410);

    await signInAs("priya.sharma@acme.test");
    const revise = await lg.courseReviewAction(S, fd({ courseId, op: "revise" }));
    const v2 = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
    check("A published course opens a new version as a draft", revise.ok && v2.status === "DRAFT" && v2.version === 2, revise.message);
    await signInAs("vikram.menon@acme.test");
    await lg.courseReviewAction(S, fd({ courseId: courseId, op: "submit" }));
    await signInAs("priya.sharma@acme.test");
    await lg.courseReviewAction(S, fd({ courseId: courseId, op: "approve" }));
    const dueSet = await lg.updateEnrolmentAction(S, fd({ enrolmentId: baseEnrol.id, op: "refresh" }));
    check("A learning admin can recompute a record", dueSet.ok, dueSet.message);

    // -----------------------------------------------------------------------
    section("Learning paths");
    const path = await lg.savePathAction(S, fd({ name: `${TAG} Engineer onboarding`, description: "Start here", dueInDays: 30 }));
    const pathId = path.values?.pathId ?? "";
    const empty = await lg.pathReviewAction(S, fd({ pathId, op: "submit" }));
    check("An empty path cannot be submitted", path.ok && !empty.ok, empty.message);
    await lg.pathCourseAction(S, fd({ pathId, courseId: baseId, op: "add" }));
    await lg.pathCourseAction(S, fd({ pathId, courseId, op: "add" }));
    const up = await lg.pathCourseAction(S, fd({ pathId, courseId, op: "up" }));
    const order = await prisma.learningPathCourse.findMany({ where: { pathId }, orderBy: { sequence: "asc" } });
    check("Courses are added and reordered", up.ok && order[0]?.courseId === courseId, up.message);
    const notYet = await lg.assignPathAction(S, form({ pathId }, { employeeIds: [deepak.id] }));
    check("A draft path cannot be assigned", !notYet.ok, notYet.message);
    await lg.pathReviewAction(S, fd({ pathId, op: "submit" }));
    const selfApprove = await lg.pathReviewAction(S, fd({ pathId, op: "approve" }));
    await signInAs("vikram.menon@acme.test");
    const pathOk = await lg.pathReviewAction(S, fd({ pathId, op: "approve", note: "Fine" }));
    check("The submitter cannot approve; another admin does", !selfApprove.ok && pathOk.ok && (await prisma.learningPath.findUniqueOrThrow({ where: { id: pathId } })).status === "APPROVED", pathOk.message);
    await signInAs("priya.sharma@acme.test");
    const assigned = await lg.assignPathAction(S, form({ pathId, dueDate: day(20) }, { employeeIds: [deepak.id] }));
    const pa = await prisma.learningPathAssignment.findFirst({ where: { pathId, employeeId: deepak.id } });
    const dEnrol = await prisma.courseEnrolment.count({ where: { employeeId: deepak.id, courseId: { in: [baseId, courseId] } } });
    check("Assigning the path enrols its courses", assigned.ok && !!pa && dEnrol === 2, assigned.message);
    await signInAs("meera.krishnan@acme.test");
    const join = await lg.joinPathAction(S, fd({ pathId }));
    check("A path with an approval-gated course cannot be self-joined", !join.ok, join.message);
    check("An employee cannot assign paths", await denied(() => lg.assignPathAction(S, form({ pathId }, { employeeIds: [deepak.id] }))));

    // -----------------------------------------------------------------------
    section("Training sessions");
    await signInAs("priya.sharma@acme.test");
    const badVirtual = await lg.saveSessionAction(S, fd({ title: `${TAG} Workshop`, mode: "VIRTUAL", startsAt: `${day(5)}T10:00`, endsAt: `${day(5)}T12:00`, meetingUrl: "http://x" }));
    check("A virtual session needs an https link", !badVirtual.ok, badVirtual.message);
    const ses = await lg.saveSessionAction(S, fd({ title: `${TAG} Workshop`, mode: "CLASSROOM", venue: "Room 4", startsAt: `${day(5)}T10:00`, endsAt: `${day(5)}T12:00`, capacity: 1, requiresApproval: true, courseId }));
    const sessionId = ses.values?.sessionId ?? "";
    check("A classroom session is scheduled", ses.ok && !!sessionId, ses.message);
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot schedule sessions", !(await lg.saveSessionAction(S, fd({ title: "x" }))).ok);
    const reg = await lg.registerSessionAction(S, fd({ sessionId, note: "Keen" }));
    const mreg = await prisma.sessionRegistration.findFirstOrThrow({ where: { sessionId, employeeId: meera.id } });
    check("Registration waits for approval", reg.ok && mreg.status === "REQUESTED", reg.message);
    const selfDecide = await lg.decideRegistrationAction(S, fd({ registrationId: mreg.id, decision: "approve" }));
    check("She cannot approve her own place", !selfDecide.ok, selfDecide.message);
    await signInAs("priya.sharma@acme.test");
    await lg.nominateSessionAction(S, form({ sessionId }, { employeeIds: [deepak.id] }));
    await signInAs("ananya.ghosh@acme.test");
    const decided = await lg.decideRegistrationAction(S, fd({ registrationId: mreg.id, decision: "approve" }));
    check("Her manager approves; the full session puts her on the waitlist", decided.ok && (await prisma.sessionRegistration.findUniqueOrThrow({ where: { id: mreg.id } })).status === "WAITLISTED", decided.message);
    await signInAs("deepak.chauhan@acme.test");
    const dreg = await prisma.sessionRegistration.findFirstOrThrow({ where: { sessionId, employeeId: deepak.id } });
    await lg.cancelRegistrationAction(S, fd({ registrationId: dreg.id }));
    check("A cancellation promotes the waitlist", (await prisma.sessionRegistration.findUniqueOrThrow({ where: { id: mreg.id } })).status === "REGISTERED");
    await signInAs("priya.sharma@acme.test");
    const tooEarly = await lg.markAttendanceAction(S, form({ sessionId }, { present: [mreg.id] }));
    check("Attendance waits for the session to start", !tooEarly.ok, tooEarly.message);
    await prisma.trainingSession.update({ where: { id: sessionId }, data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 600_000) } });
    const att = await lg.markAttendanceAction(S, form({ sessionId }, { present: [mreg.id] }));
    const closed = await lg.sessionOpAction(S, fd({ sessionId, op: "complete" }));
    check("Attendance is marked and the session closed", att.ok && closed.ok && (await prisma.sessionRegistration.findUniqueOrThrow({ where: { id: mreg.id } })).attendance === "PRESENT", closed.message);

    // -----------------------------------------------------------------------
    section("Course builder (modules and assessments)");
    const built = await pl.createCourseAction(S, fd({ title: `${TAG} Builder course`, description: "Built in smoke" }));
    const progId = built.courseId ?? "";
    const sec = await pl.saveSectionAction(S, fd({ courseId: progId, title: "Part 1" }));
    const page = await pl.saveModuleAction(S, fd({ courseId: progId, sectionId: sec.sectionId, type: "PAGE", title: "Intro", body: "Welcome", durationMinutes: 5 }));
    const asmt = await pl.saveModuleAction(S, fd({ courseId: progId, sectionId: sec.sectionId, type: "ASSESSMENT", title: "Check", passPercent: 50 }));
    const notReady = await pl.courseStateAction(S, fd({ courseId: progId, op: "publish" }));
    check("An assessment without questions blocks publishing", built.ok && page.ok && asmt.ok && !notReady.ok, notReady.message);
    const qs = await pl.saveQuestionAction(S, fd({ moduleId: asmt.moduleId, type: "SINGLE_CHOICE", prompt: "2+2?", options: JSON.stringify([{ id: "o1", text: "3" }, { id: "o2", text: "4" }]), correct: JSON.stringify(["o2"]) }));
    const pub = await pl.courseStateAction(S, fd({ courseId: progId, op: "publish" }));
    check("With a question it publishes", qs.ok && pub.ok, pub.message);
    await signInAs("meera.krishnan@acme.test");
    const se = await pl.selfEnrolAction(S, fd({ courseId: progId }));
    const cm = await pl.completeModuleAction(S, fd({ moduleId: page.moduleId }));
    const sa = await pl.submitAssessmentAction({ moduleId: asmt.moduleId ?? "", answers: { [(await prisma.assessmentQuestion.findFirstOrThrow({ where: { moduleId: asmt.moduleId } })).id]: ["o2"] } });
    const te = await prisma.trainingEnrolment.findFirst({ where: { programId: progId, employeeId: meera.id } });
    check("A learner enrols, reads, passes and completes the course", se.ok && cm.ok && sa.ok && !!sa.passed && te?.status === "COMPLETED", `${sa.message} ${te?.status}`);

    // -----------------------------------------------------------------------
    section("Learning reports and exports");
    const lx = await import("../apps/web/src/app/(app)/learn/reports/export/route");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot export learning reports", (await lx.GET(req("/learn/reports/export?kind=records"))).status === 403);
    await signInAs("priya.sharma@acme.test");
    for (const kind of ["records", "courses", "paths", "sessions", "assessments", "certificates", "requests"]) {
      const r = await lx.GET(req(`/learn/reports/export?kind=${kind}`));
      const body = await r.text();
      check(`The ${kind} report exports as CSV`, r.status === 200 && body.split("\n").length >= 2 && (kind !== "certificates" || body.includes(cert!.number)), `${r.status}`);
    }
    check("An unknown report is refused", (await lx.GET(req("/learn/reports/export?kind=nope"))).status === 400);
    check("Exports are audited", (await prisma.auditLog.count({ where: { tenantId: tenant.id, action: "EXPORT", entityType: "LearningReport", createdAt: { gte: started } } })) >= 7);

    // -----------------------------------------------------------------------
    section("Talent reviews and the 9-box");
    const suc = await import("../apps/web/src/app/actions/succession");
    const labelsBefore = await prisma.talentBoxLabel.findMany({ where: { tenantId: tenant.id } });
    restore.push(async () => {
      if (labelsBefore.length === 0) return prisma.talentBoxLabel.deleteMany({ where: { tenantId: tenant.id } });
      for (const l of labelsBefore) await prisma.talentBoxLabel.update({ where: { id: l.id }, data: { label: l.label, description: l.description } });
    });
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot open talent reviews", await denied(() => suc.saveTalentReviewAction(S, fd({ name: "x" }))));
    await signInAs("priya.sharma@acme.test");
    const tr = await suc.saveTalentReviewAction(S, fd({ name: `${TAG} Engineering review`, agenda: "Calibrate the 9-box", meetingAt: `${day(3)}T15:00` }));
    const reviewId = tr.values?.reviewId ?? "";
    const added = await suc.addReviewParticipantsAction(S, form({ reviewId }, { employeeIds: [meera.id, ananya.id] }));
    const entries = await prisma.talentReviewEntry.findMany({ where: { reviewId } });
    check("A talent review is created and people added", tr.ok && added.ok && entries.length === 2, added.message);
    const early2 = await suc.talentReviewOpAction(S, fd({ reviewId, op: "submit" }));
    const unrated = entries.some((e) => e.performance === null || e.potential === null);
    check("It cannot be submitted while someone is unplaced", !unrated || !early2.ok, early2.message);
    for (const [i, e] of entries.entries()) await suc.rateTalentAction(S, fd({ entryId: e.id, performance: 3, potential: i === 0 ? 3 : 2, flightRisk: "MEDIUM", retentionAction: "Stretch project" }));
    const placed = await prisma.talentReviewEntry.findFirstOrThrow({ where: { reviewId, employeeId: meera.id } });
    check("High performance and potential land in box 9", placed.box === 9, `box ${placed.box}`);
    const labels = Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`label${k + 1}`, k === 8 ? "Future leader" : `Box ${k + 1}`]));
    const lab = await suc.saveBoxLabelsAction(S, fd(labels));
    check("The 9-box labels can be renamed", lab.ok && (await prisma.talentBoxLabel.findFirst({ where: { tenantId: tenant.id, box: 9 } }))?.label === "Future leader", lab.message);
    await suc.talentReviewOpAction(S, fd({ reviewId, op: "submit" }));
    const ownSign = await suc.talentReviewOpAction(S, fd({ reviewId, op: "approve" }));
    const locked = await suc.rateTalentAction(S, fd({ entryId: placed.id, performance: 1, potential: 1 }));
    await signInAs("vikram.menon@acme.test");
    const signed = await suc.talentReviewOpAction(S, fd({ reviewId, op: "approve", note: "Agreed" }));
    check("Submitted ratings are locked; a second person signs off", !ownSign.ok && !locked.ok && signed.ok && (await prisma.talentReview.findUniqueOrThrow({ where: { id: reviewId } })).status === "APPROVED", signed.message);

    // -----------------------------------------------------------------------
    section("Succession plans");
    await signInAs("priya.sharma@acme.test");
    const lvl = await suc.saveReadinessLevelAction(S, fd({ name: `${TAG} Ready in 3 years`, code: "SMKG_3Y", minMonths: 25, maxMonths: 36, displayOrder: 9 }));
    const level = await prisma.readinessLevel.findFirstOrThrow({ where: { tenantId: tenant.id, code: "SMKG_3Y" } });
    const levels = await prisma.readinessLevel.findMany({ where: { tenantId: tenant.id, isActive: true }, orderBy: { displayOrder: "asc" } });
    check("Readiness levels are configurable", lvl.ok && levels.length >= 2, lvl.message);
    const plan = await suc.saveSuccessionPlanAction(S, fd({ positionTitle: `${TAG} Engineering Manager`, criticality: "HIGH", riskOfLoss: "MEDIUM", incumbentId: sneha.id, vacancyImpact: "Delivery stalls" }));
    const planId = plan.values?.planId ?? "";
    check("A succession plan is created for a critical position", plan.ok && !!planId, plan.message);
    await signInAs("sneha.reddy@acme.test");
    const byHolder = await suc.nominateSuccessorAction(S, fd({ planId, employeeId: ananya.id, readinessId: levels[0].id, rank: 1 }));
    await signInAs("meera.krishnan@acme.test");
    const byOther = await suc.nominateSuccessorAction(S, fd({ planId, employeeId: ananya.id, readinessId: levels[0].id }));
    check("The position's holder may nominate; others may not", byHolder.ok && !byOther.ok, byOther.message);
    await signInAs("priya.sharma@acme.test");
    const second = await suc.nominateSuccessorAction(S, fd({ planId, employeeId: meera.id, readinessId: level.id, rank: 2, isEmergency: true }));
    const succs = await prisma.successor.findMany({ where: { planId } });
    const sA = succs.find((s) => s.employeeId === ananya.id)!, sM = succs.find((s) => s.employeeId === meera.id)!;
    const selfOk = await suc.decideSuccessorAction(S, fd({ successorId: sM.id, decision: "approve" }));
    const okA = await suc.decideSuccessorAction(S, fd({ successorId: sA.id, decision: "approve" }));
    const blocked = await suc.successionPlanReviewAction(S, fd({ planId, op: "submit" }));
    check("A nominator cannot approve their own nominee; the plan waits on open nominations", second.ok && !selfOk.ok && okA.ok && !blocked.ok, blocked.message);
    await signInAs("vikram.menon@acme.test");
    await suc.decideSuccessorAction(S, fd({ successorId: sM.id, decision: "approve" }));
    await signInAs("priya.sharma@acme.test");
    const noReason2 = await suc.updateSuccessorAction(S, fd({ successorId: sM.id, readinessId: levels[0].id, rank: 2 }));
    const proposed = await suc.updateSuccessorAction(S, fd({ successorId: sM.id, readinessId: levels[0].id, rank: 2, reason: "Led the migration" }));
    const pend = await prisma.successor.findUniqueOrThrow({ where: { id: sM.id } });
    check("A readiness change on an approved successor needs a reason and waits", !noReason2.ok && proposed.ok && pend.pendingReadinessId === levels[0].id && pend.readinessId === level.id, proposed.message);
    const ownChange = await suc.decideReadinessChangeAction(S, fd({ successorId: sM.id, decision: "approve" }));
    await signInAs("vikram.menon@acme.test");
    const changed = await suc.decideReadinessChangeAction(S, fd({ successorId: sM.id, decision: "approve" }));
    check("Another person approves the readiness change", !ownChange.ok && changed.ok && (await prisma.successor.findUniqueOrThrow({ where: { id: sM.id } })).readinessId === levels[0].id, changed.message);
    await signInAs("priya.sharma@acme.test");
    const devp = await suc.successorDevelopmentAction(S, fd({ successorId: sM.id }));
    const linked = await prisma.successor.findUniqueOrThrow({ where: { id: sM.id } });
    check("A development plan is started for a successor", devp.ok && !!linked.developmentPlanId, devp.message);
    await suc.successionPlanReviewAction(S, fd({ planId, op: "submit" }));
    await signInAs("vikram.menon@acme.test");
    const planOk = await suc.successionPlanReviewAction(S, fd({ planId, op: "approve" }));
    check("The plan is approved by someone other than the submitter", planOk.ok && (await prisma.successionPlan.findUniqueOrThrow({ where: { id: planId } })).status === "APPROVED", planOk.message);
    await signInAs("priya.sharma@acme.test");
    const lvlDel = await suc.deleteReadinessLevelAction(S, fd({ id: level.id }));
    check("An unused readiness level can be deleted", lvlDel.ok, lvlDel.message);
    const sx = await import("../apps/web/src/app/(app)/performance/succession/export/route");
    for (const kind of ["plans", "successors", "ninebox"]) {
      const r = await sx.GET(req(`/performance/succession/export?kind=${kind}`));
      const body = await r.text();
      check(`The succession ${kind} report exports`, r.status === 200 && body.includes(kind === "ninebox" ? "Meera" : TAG), `${r.status}`);
    }
    await signInAs("sneha.reddy@acme.test");
    check("Succession reports are confidential to HR", (await sx.GET(req("/performance/succession/export?kind=plans"))).status === 403);

    // -----------------------------------------------------------------------
    section("Internal mobility: internal jobs, PIP block, transfers, aspirations, career paths");
    const mob = await import("../apps/web/src/app/actions/mobility");
    const car = await import("../apps/web/src/app/actions/career");
    const perf = await import("../apps/web/src/app/actions/performance");
    const dev = await import("../apps/web/src/app/actions/development");
    const job = await prisma.job.findFirstOrThrow({ where: { tenantId: tenant.id, status: "OPEN" } });
    restore.push(() => prisma.job.update({ where: { id: job.id }, data: { allowInternal: job.allowInternal, internalClosesAt: job.internalClosesAt, internalMinTenureMonths: job.internalMinTenureMonths } }));
    restore.push(() => prisma.internalApplication.deleteMany({ where: { jobId: job.id, createdAt: { gte: started } } }));
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot post a job internally", await denied(() => mob.setInternalPostingAction(S, fd({ jobId: job.id, allowInternal: true }))));
    const notPosted = await mob.applyInternalAction(S, fd({ jobId: job.id }));
    check("A job not posted internally cannot be applied for", !notPosted.ok, notPosted.message);
    await signInAs("vikram.menon@acme.test");
    const posted = await mob.setInternalPostingAction(S, fd({ jobId: job.id, allowInternal: true, internalMinTenureMonths: 0, internalClosesAt: day(30) }));
    check("HR posts the job internally", posted.ok, posted.message);
    await signInAs("priya.sharma@acme.test");
    const pipMade = await perf.createPipAction(S, fd({ employeeId: meera.id, reason: `${TAG} reason`, objectives: "Ship two features", startDate: day(-1), endDate: day(60) }));
    const pip = await prisma.improvementPlan.findFirstOrThrow({ where: { employeeId: meera.id, reason: `${TAG} reason` } });
    pips.push(pip.id);
    await signInAs("meera.krishnan@acme.test");
    const onPip = await mob.applyInternalAction(S, fd({ jobId: job.id, coverNote: "Keen" }));
    check("Someone on an active improvement plan cannot apply internally", pipMade.ok && !onPip.ok, onPip.message);

    section("Improvement plans: depth and second sign-off");
    await signInAs("priya.sharma@acme.test");
    const short = await dev.updatePipAction(S, fd({ pipId: pip.id, reason: `${TAG} reason`, objectives: "Ship two features and review", endDate: day(5) }));
    const edited = await dev.updatePipAction(S, fd({ pipId: pip.id, reason: `${TAG} reason`, objectives: "Ship two features and review", endDate: day(75) }));
    check("A plan can be edited within 30–180 days", !short.ok && edited.ok, edited.message);
    const outside = await dev.pipMilestoneAction(S, fd({ pipId: pip.id, op: "add", title: "Too late", dueDate: day(200) }));
    const ms = await dev.pipMilestoneAction(S, fd({ pipId: pip.id, op: "add", title: "Feature one shipped", dueDate: day(20) }));
    const milestone = await prisma.pipMilestone.findFirstOrThrow({ where: { pipId: pip.id } });
    const met = await dev.pipMilestoneAction(S, fd({ milestoneId: milestone.id, op: "met", note: "Done early" }));
    check("Milestones must fall within the plan and can be marked met", !outside.ok && ms.ok && met.ok && (await prisma.pipMilestone.findUniqueOrThrow({ where: { id: milestone.id } })).status === "MET", met.message);
    const ci = await dev.pipCheckInAction(S, fd({ pipId: pip.id, op: "add", progress: "AT_RISK", notes: "Slipping on reviews" }));
    const sup = await dev.saveDevelopmentActionAction(S, fd({ pipId: pip.id, title: "Pair with a senior", kind: "MENTORING", dueDate: day(30) }));
    check("HR records a check-in and a support action", ci.ok && sup.ok, `${ci.message} / ${sup.message}`);
    await signInAs("meera.krishnan@acme.test");
    const checkIn = await prisma.pipCheckIn.findFirstOrThrow({ where: { pipId: pip.id } });
    const ack = await dev.pipCheckInAction(S, fd({ op: "ack", checkInId: checkIn.id, comment: "Understood" }));
    const resp = await dev.respondPipAction(S, fd({ pipId: pip.id, response: "I will improve" }));
    const supSelf = await dev.saveDevelopmentActionAction(S, fd({ pipId: pip.id, title: "Self-added", kind: "OTHER" }));
    check("The employee acknowledges the plan and check-in but cannot add plan actions", ack.ok && resp.ok && !supSelf.ok, supSelf.message);
    check("An employee cannot edit their plan", await denied(() => dev.updatePipAction(S, fd({ pipId: pip.id, reason: "x", objectives: "y" }))));
    await signInAs("priya.sharma@acme.test");
    const proposedOut = await perf.closePipAction(S, fd({ id: pip.id, outcome: "UNSUCCESSFUL", note: "Targets missed" }));
    const stillActive = await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pip.id } });
    const ownSignOff = await dev.decidePipOutcomeAction(S, fd({ pipId: pip.id, decision: "approve" }));
    check("An unsuccessful outcome is only proposed; the proposer cannot confirm it", proposedOut.ok && stillActive.status === "ACTIVE" && stillActive.proposedOutcome === "UNSUCCESSFUL" && !ownSignOff.ok, proposedOut.message);
    await signInAs("vikram.menon@acme.test");
    const noNote = await dev.decidePipOutcomeAction(S, fd({ pipId: pip.id, decision: "reject" }));
    const confirmed = await dev.decidePipOutcomeAction(S, fd({ pipId: pip.id, decision: "approve", note: "Agree" }));
    const closedPip = await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pip.id } });
    check("A second PIP manager confirms it and the plan closes", !noNote.ok && confirmed.ok && closedPip.status === "CLOSED" && closedPip.outcome === "UNSUCCESSFUL", confirmed.message);

    section("Internal applications and transfers");
    await signInAs("meera.krishnan@acme.test");
    const applied = await mob.applyInternalAction(S, fd({ jobId: job.id, coverNote: "I know the codebase" }));
    const app = await prisma.internalApplication.findFirstOrThrow({ where: { jobId: job.id, employeeId: meera.id } });
    check("After the plan closes she can apply; it goes to her manager", applied.ok && app.status === "APPLIED", applied.message);
    await signInAs("priya.sharma@acme.test");
    const skip = await mob.decideInternalApplicationAction(S, fd({ applicationId: app.id, decision: "shortlist" }));
    check("HR cannot shortlist before the manager endorses", !skip.ok, skip.message);
    await signInAs("manish.tiwari@acme.test");
    check("Someone outside her line cannot endorse", !(await mob.endorseInternalApplicationAction(S, fd({ applicationId: app.id, decision: "endorse" }))).ok);
    await signInAs("ananya.ghosh@acme.test");
    const endorsed = await mob.endorseInternalApplicationAction(S, fd({ applicationId: app.id, decision: "endorse", note: "Ready" }));
    await signInAs("priya.sharma@acme.test");
    const sl = await mob.decideInternalApplicationAction(S, fd({ applicationId: app.id, decision: "shortlist" }));
    const sel = await mob.decideInternalApplicationAction(S, fd({ applicationId: app.id, decision: "select", note: "Strong" }));
    check("Manager endorses, then HR shortlists and selects", endorsed.ok && sl.ok && sel.ok && (await prisma.internalApplication.findUniqueOrThrow({ where: { id: app.id } })).status === "SELECTED", sel.message);

    const sales = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, id: { not: meera.departmentId ?? "" } } });
    await signInAs("meera.krishnan@acme.test");
    const noWhy = await mob.requestMobilityAction(S, fd({ kind: "TRANSFER", toDepartmentId: sales.id }));
    const move = await mob.requestMobilityAction(S, fd({ kind: "TRANSFER", toDepartmentId: sales.id, reason: "Closer to customers", preferredDate: day(40) }));
    const mr = await prisma.mobilityRequest.findFirstOrThrow({ where: { employeeId: meera.id, createdAt: { gte: started } } });
    const dup = await mob.requestMobilityAction(S, fd({ kind: "TRANSFER", toDepartmentId: sales.id, reason: "Again" }));
    check("A transfer request needs a reason, goes to the manager, and only one may be open", !noWhy.ok && move.ok && mr.status === "PENDING_MANAGER" && !dup.ok, move.message);
    const selfMove = await mob.decideMobilityAction(S, fd({ requestId: mr.id, decision: "approve" }));
    await signInAs("priya.sharma@acme.test");
    const hrFirst = await mob.decideMobilityAction(S, fd({ requestId: mr.id, decision: "approve" }));
    check("Neither she nor HR can skip the manager", !selfMove.ok && !hrFirst.ok, hrFirst.message);
    await signInAs("ananya.ghosh@acme.test");
    const mgrOk = await mob.decideMobilityAction(S, fd({ requestId: mr.id, decision: "approve", note: "Supported" }));
    const mgrAgain = await mob.decideMobilityAction(S, fd({ requestId: mr.id, decision: "approve" }));
    check("The manager endorses it on to HR (and cannot take the HR step)", mgrOk.ok && !mgrAgain.ok && (await prisma.mobilityRequest.findUniqueOrThrow({ where: { id: mr.id } })).status === "PENDING_HR", mgrAgain.message);
    await signInAs("priya.sharma@acme.test");
    const hrOk = await mob.decideMobilityAction(S, fd({ requestId: mr.id, decision: "approve", effectiveFrom: day(45) }));
    const doneMove = await prisma.mobilityRequest.findUniqueOrThrow({ where: { id: mr.id } });
    const jc = doneMove.jobChangeId ? await prisma.jobChange.findUnique({ where: { id: doneMove.jobChangeId } }) : null;
    if (jc) { jobChanges.push(jc.id); if (jc.approvalRequestId) approvalRequests.push(jc.approvalRequestId); }
    check("HR approval raises a dated job change for the new department", hrOk.ok && doneMove.status === "APPROVED" && jc?.departmentId === sales.id, `${hrOk.message}`);

    const aspBefore = await prisma.careerAspiration.findUnique({ where: { employeeId: meera.id } });
    restore.push(async () => {
      await prisma.careerAspiration.deleteMany({ where: { employeeId: meera.id } });
      if (aspBefore) await prisma.careerAspiration.create({ data: aspBefore });
    });
    await signInAs("priya.sharma@acme.test");
    const cp = await car.createPathAction(S, fd({ name: `${TAG} Engineering ladder`, description: "IC track" }));
    const cpath = await prisma.careerPath.findFirstOrThrow({ where: { tenantId: tenant.id, name: `${TAG} Engineering ladder` } });
    await car.addStepAction(S, fd({ pathId: cpath.id, title: `${TAG} Engineer`, minYears: 0 }));
    await car.addStepAction(S, fd({ pathId: cpath.id, title: `${TAG} Senior Engineer`, minYears: 3 }));
    const target = await prisma.careerPathStep.findFirstOrThrow({ where: { pathId: cpath.id, minYears: 3 } });
    await signInAs("meera.krishnan@acme.test");
    const draftAim = await car.setAspirationAction(S, fd({ stepId: target.id }));
    check("A draft career path cannot be aimed for", cp.ok && cpath.status === "DRAFT" && !draftAim.ok, draftAim.message);
    await signInAs("priya.sharma@acme.test");
    await mob.careerPathReviewAction(S, fd({ pathId: cpath.id, op: "submit" }));
    const selfPath = await mob.careerPathReviewAction(S, fd({ pathId: cpath.id, op: "approve" }));
    await signInAs("vikram.menon@acme.test");
    const pathApproved = await mob.careerPathReviewAction(S, fd({ pathId: cpath.id, op: "approve" }));
    check("Another careers admin approves the path", !selfPath.ok && pathApproved.ok, pathApproved.message);
    await signInAs("meera.krishnan@acme.test");
    const aim = await car.setAspirationAction(S, fd({ stepId: target.id, targetDate: day(365), openToRelocate: true, note: "Within a year" }));
    const asp = await prisma.careerAspiration.findUniqueOrThrow({ where: { employeeId: meera.id } });
    check("She sets an aspiration with a target date; it awaits her manager", aim.ok && asp.status === "PENDING" && asp.openToRelocate && !!asp.targetDate, aim.message);
    await signInAs("ananya.ghosh@acme.test");
    const declineNoNote = await mob.endorseAspirationAction(S, fd({ aspirationId: asp.id, decision: "decline" }));
    const endorsedAsp = await mob.endorseAspirationAction(S, fd({ aspirationId: asp.id, decision: "endorse", note: "Agreed" }));
    check("Her manager endorses it (declining needs a reason)", !declineNoNote.ok && endorsedAsp.ok, endorsedAsp.message);
    await signInAs("priya.sharma@acme.test");
    const inUse = await mob.deleteCareerPathAction(S, fd({ pathId: cpath.id }));
    check("A path someone is aiming for cannot be deleted", !inUse.ok, inUse.message);
    const mx = await import("../apps/web/src/app/(app)/performance/mobility/export/route");
    for (const kind of ["applications", "moves", "aspirations", "development"]) {
      const r = await mx.GET(req(`/performance/mobility/export?kind=${kind}`));
      check(`The mobility ${kind} report exports`, r.status === 200 && (await r.text()).length > 0, `${r.status}`);
    }
    await signInAs("meera.krishnan@acme.test");
    check("Mobility reports are not open to employees", (await mx.GET(req("/performance/mobility/export?kind=moves"))).status === 403);

    // -----------------------------------------------------------------------
    section("Skills library, frameworks, scales and gaps");
    const sk = await import("../apps/web/src/app/actions/skills");
    await signInAs("priya.sharma@acme.test");
    await car.createSkillAction(S, fd({ name: `${TAG} Rust`, category: "Engineering", levels: "Aware, Basic, Working, Expert" }));
    const rust = await prisma.skill.findFirstOrThrow({ where: { tenantId: tenant.id, name: `${TAG} Rust` } });
    const badLevels = await sk.updateSkillAction(S, fd({ skillId: rust.id, name: `${TAG} Rust`, levels: "Only" }));
    const upd = await sk.updateSkillAction(S, fd({ skillId: rust.id, name: `${TAG} Rust`, category: "Engineering", description: "Systems language", isCritical: true, validityMonths: 24, levels: "Aware\nBasic\nWorking\nExpert" }));
    const rust2 = await prisma.skill.findUniqueOrThrow({ where: { id: rust.id } });
    check("A skill is edited: critical, revalidated every 24 months", !badLevels.ok && upd.ok && rust2.isCritical && rust2.validityMonths === 24, upd.message);
    const off = await sk.toggleSkillAction(S, fd({ skillId: rust.id }));
    const onAgain = await sk.toggleSkillAction(S, fd({ skillId: rust.id }));
    check("A skill can be deactivated and reactivated", off.ok && onAgain.ok && (await prisma.skill.findUniqueOrThrow({ where: { id: rust.id } })).isActive, onAgain.message);
    await signInAs("meera.krishnan@acme.test");
    const prop = await sk.proposeSkillAction(S, fd({ name: `${TAG} Kotlin`, category: "Engineering" }));
    const kotlin = await prisma.skill.findFirstOrThrow({ where: { tenantId: tenant.id, name: `${TAG} Kotlin` } });
    check("An employee suggests a skill; it is pending", prop.ok && kotlin.status === "PROPOSED", prop.message);
    check("An employee cannot approve suggestions", await denied(() => sk.decideSkillProposalAction(S, fd({ skillId: kotlin.id, decision: "approve" }))));
    await signInAs("priya.sharma@acme.test");
    const kOk = await sk.decideSkillProposalAction(S, fd({ skillId: kotlin.id, decision: "approve" }));
    check("A skills admin adds it to the library", kOk.ok && (await prisma.skill.findUniqueOrThrow({ where: { id: kotlin.id } })).status === "ACTIVE", kOk.message);

    const fw = await sk.saveFrameworkAction(S, fd({ name: `${TAG} Software Engineer`, jobTitle: "Software Engineer", description: "What the role needs" }));
    const fwId = fw.values?.frameworkId ?? "";
    const emptySubmit = await sk.frameworkReviewAction(S, fd({ frameworkId: fwId, op: "submit" }));
    const item = await sk.frameworkItemAction(S, fd({ frameworkId: fwId, skillId: rust.id, op: "add", requiredLevel: 2, weight: 3, isCritical: true }));
    check("A framework needs a skill before it is submitted", fw.ok && !emptySubmit.ok && item.ok, item.message);
    await sk.frameworkReviewAction(S, fd({ frameworkId: fwId, op: "submit" }));
    const fwSelf = await sk.frameworkReviewAction(S, fd({ frameworkId: fwId, op: "approve" }));
    const fwLocked = await sk.frameworkItemAction(S, fd({ frameworkId: fwId, skillId: kotlin.id, op: "add", requiredLevel: 1 }));
    await signInAs("vikram.menon@acme.test");
    const fwOk = await sk.frameworkReviewAction(S, fd({ frameworkId: fwId, op: "approve" }));
    check("A submitted framework is locked; another admin approves it", !fwSelf.ok && !fwLocked.ok && fwOk.ok, fwOk.message);
    const v2f = await sk.frameworkReviewAction(S, fd({ frameworkId: fwId, op: "version" }));
    const v2Id = v2f.values?.frameworkId ?? "";
    const v2row = await prisma.competencyFramework.findUnique({ where: { id: v2Id }, include: { items: true } });
    check("A new version copies the framework as a draft", v2f.ok && v2row?.version === 2 && v2row.items.length === 1 && v2row.status === "DRAFT", v2f.message);
    await sk.frameworkItemAction(S, fd({ frameworkId: v2Id, skillId: kotlin.id, op: "add", requiredLevel: 1 }));
    await sk.frameworkReviewAction(S, fd({ frameworkId: v2Id, op: "submit" }));
    await signInAs("priya.sharma@acme.test");
    await sk.frameworkReviewAction(S, fd({ frameworkId: v2Id, op: "approve" }));
    check("Approving version 2 archives version 1", (await prisma.competencyFramework.findUniqueOrThrow({ where: { id: fwId } })).status === "ARCHIVED" && (await prisma.competencyFramework.findUniqueOrThrow({ where: { id: v2Id } })).status === "APPROVED");

    const sc = await sk.saveScaleAction(S, fd({ name: `${TAG} Five step`, levels: "Novice\nBeginner\nCompetent\nProficient\nExpert", descriptions: "New\nLearning\nIndependent\nGuides others\nSets direction" }));
    const scaleId = sc.values?.scaleId ?? "";
    const early3 = await sk.applyScaleAction(S, fd({ scaleId, skillId: kotlin.id }));
    await sk.scaleReviewAction(S, fd({ scaleId, op: "submit" }));
    await signInAs("vikram.menon@acme.test");
    await sk.scaleReviewAction(S, fd({ scaleId, op: "approve" }));
    const applied2 = await sk.applyScaleAction(S, fd({ scaleId, skillId: kotlin.id }));
    check("Only an approved scale is applied to a skill", sc.ok && !early3.ok && applied2.ok && ((await prisma.skill.findUniqueOrThrow({ where: { id: kotlin.id } })).levels as string[]).length === 5, applied2.message);

    await signInAs("meera.krishnan@acme.test");
    const mine2 = await car.addMySkillAction(S, fd({ skillId: rust.id, level: 1, evidence: "Side project" }));
    await signInAs("ananya.ghosh@acme.test");
    const rated = await car.rateSkillAction(S, fd({ employeeId: meera.id, skillId: rust.id, level: 1 }));
    const logs = await prisma.skillAssessmentLog.findMany({ where: { employeeId: meera.id, skillId: rust.id } });
    check("Self and manager assessments are logged", mine2.ok && rated.ok && logs.some((l) => l.kind === "SELF") && logs.some((l) => l.kind === "MANAGER"), rated.message);
    await signInAs("priya.sharma@acme.test");
    const kx = await import("../apps/web/src/app/(app)/performance/skills/export/route");
    const gap = await kx.GET(req(`/performance/skills/export?kind=gaps&frameworkId=${v2Id}`));
    const gapCsv = await gap.text();
    check("The gap report shows her short of the framework level", gap.status === 200 && gapCsv.includes("Meera") && gapCsv.includes(`${TAG} Rust`), gapCsv.split("\n").slice(0, 2).join(" | "));
    for (const kind of ["inventory", "assessments", "library"]) {
      const r = await kx.GET(req(`/performance/skills/export?kind=${kind}`));
      check(`The skills ${kind} report exports`, r.status === 200 && (await r.text()).includes(TAG), `${r.status}`);
    }
    await signInAs("meera.krishnan@acme.test");
    check("Skill reports are not open to employees", (await kx.GET(req("/performance/skills/export?kind=gaps"))).status === 403);

    // -----------------------------------------------------------------------
    section("Development plans, actions and coaching");
    await signInAs("meera.krishnan@acme.test");
    const idp = await dev.saveDevelopmentPlanAction(S, fd({ title: `${TAG} Grow into senior`, objective: "Own a service end to end", startDate: day(0), endDate: day(180), careerStepId: target.id }));
    const idpId = idp.values?.planId ?? "";
    const bare = await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "submit" }));
    const act = await dev.saveDevelopmentActionAction(S, fd({ planId: idpId, title: `${TAG} Read the Rust book`, kind: "READING", skillId: rust.id, dueDate: day(60) }));
    const action = await prisma.developmentAction.findFirstOrThrow({ where: { planId: idpId } });
    await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "submit" }));
    const ownApprove = await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "approve" }));
    check("An IDP needs an action before submitting and is not self-approved", idp.ok && !bare.ok && act.ok && !ownApprove.ok, ownApprove.message);
    await signInAs("manish.tiwari@acme.test");
    check("Someone outside her line cannot approve it", !(await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "approve" }))).ok);
    await signInAs("ananya.ghosh@acme.test");
    const idpOk = await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "approve", note: "Good plan" }));
    check("Her manager approves the plan", idpOk.ok, idpOk.message);
    await signInAs("meera.krishnan@acme.test");
    const noEv = await dev.developmentActionStepAction(S, fd({ actionId: action.id, op: "submit" }));
    await dev.developmentActionStepAction(S, fd({ actionId: action.id, op: "start" }));
    const subm = await dev.developmentActionStepAction(S, fd({ actionId: action.id, op: "submit", evidence: "Finished chapters 1-10" }));
    const selfVerify = await dev.developmentActionStepAction(S, fd({ actionId: action.id, op: "verify" }));
    const tooSoon = await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "complete" }));
    check("Actions need evidence, cannot be self-verified, and hold the plan open", !noEv.ok && subm.ok && !selfVerify.ok && !tooSoon.ok, tooSoon.message);
    await signInAs("ananya.ghosh@acme.test");
    const verified = await dev.developmentActionStepAction(S, fd({ actionId: action.id, op: "verify", note: "Nice" }));
    await signInAs("meera.krishnan@acme.test");
    const idpDone = await dev.developmentPlanOpAction(S, fd({ planId: idpId, op: "complete" }));
    check("Once verified, the plan completes", verified.ok && idpDone.ok && (await prisma.developmentPlan.findUniqueOrThrow({ where: { id: idpId } })).status === "COMPLETED", idpDone.message);
    const gapAction = await dev.saveDevelopmentActionAction(S, fd({ title: `${TAG} Close the Kotlin gap`, kind: "COURSE", courseId: baseId, skillId: kotlin.id }));
    check("An action can be raised against a skill gap, enrolling the course", gapAction.ok && (await prisma.developmentAction.count({ where: { employeeId: meera.id, skillId: kotlin.id, planId: null } })) === 1, gapAction.message);

    await signInAs("deepak.chauhan@acme.test");
    const notTeam = await dev.saveCoachingPlanAction(S, fd({ employeeId: meera.id, focusArea: "x", goals: "y", startDate: day(0), endDate: day(30) }));
    check("Only her manager or HR can propose coaching", !notTeam.ok, notTeam.message);
    await signInAs("ananya.ghosh@acme.test");
    const cpl = await dev.saveCoachingPlanAction(S, fd({ employeeId: meera.id, focusArea: `${TAG} Code review depth`, goals: "Review 10 PRs a week with comments", startDate: day(0), endDate: day(90) }));
    const coachingPlanId = cpl.values?.coachingPlanId ?? "";
    const early4 = await dev.logCoachingSessionAction(S, fd({ coachingPlanId, heldOn: day(0), notes: "Kickoff" }));
    check("Coaching is proposed; sessions wait for acceptance", cpl.ok && !early4.ok, early4.message);
    await signInAs("meera.krishnan@acme.test");
    const noReasonDecline = await dev.coachingPlanOpAction(S, fd({ coachingPlanId, op: "decline" }));
    const accepted = await dev.coachingPlanOpAction(S, fd({ coachingPlanId, op: "accept" }));
    check("The coachee accepts (a decline needs a reason)", !noReasonDecline.ok && accepted.ok, accepted.message);
    await signInAs("ananya.ghosh@acme.test");
    const logged = await dev.logCoachingSessionAction(S, fd({ coachingPlanId, heldOn: day(0), notes: "Walked through two reviews", progress: "GOOD" }));
    const cact = await dev.saveDevelopmentActionAction(S, fd({ coachingPlanId, title: "Review three PRs", kind: "PRACTICE" }));
    check("The coach logs a session and adds an action", logged.ok && cact.ok, cact.message);
    await signInAs("meera.krishnan@acme.test");
    const noLog = await dev.logCoachingSessionAction(S, fd({ coachingPlanId, heldOn: day(0), notes: "x" }));
    const noScore = await dev.coachingPlanOpAction(S, fd({ coachingPlanId, op: "complete" }));
    const finished = await dev.coachingPlanOpAction(S, fd({ coachingPlanId, op: "complete", effectivenessScore: 4, note: "Helpful" }));
    check("Only the coach logs; the coachee closes it with an effectiveness score", !noLog.ok && !noScore.ok && finished.ok && (await prisma.coachingPlan.findUniqueOrThrow({ where: { id: coachingPlanId } })).effectivenessScore === 4, finished.message);
    await signInAs("priya.sharma@acme.test");
    const px = await import("../apps/web/src/app/(app)/performance/plans/export/route");
    for (const kind of ["pips", "checkins", "coaching", "actions"]) {
      const r = await px.GET(req(`/performance/plans/export?kind=${kind}`));
      const body = await r.text();
      check(`The plans ${kind} report exports`, r.status === 200 && body.length > 0 && (kind === "pips" || kind === "checkins" ? body.includes("Meera") : true), `${r.status}`);
    }
    await signInAs("ananya.ghosh@acme.test");
    check("Plan reports are HR-only", (await px.GET(req("/performance/plans/export?kind=pips"))).status === 403);

    // -----------------------------------------------------------------------
    section("Feedback templates");
    await signInAs("priya.sharma@acme.test");
    check("Without review-cycle rights, templates are off limits", await denied(() => sk.saveFeedbackTemplateAction(S, fd({ name: "x", questions: "y" }))));
    const priyaUser = await prisma.user.findFirstOrThrow({ where: { email: "priya.sharma@acme.test" } });
    const perfAdmin = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Performance Admin" } });
    const grant = await prisma.userRoleAssignment.upsert({ where: { userId_roleId: { userId: priyaUser.id, roleId: perfAdmin.id } }, create: { userId: priyaUser.id, roleId: perfAdmin.id }, update: {} });
    restore.push(() => prisma.userRoleAssignment.delete({ where: { id: grant.id } }));
    await signInAs("vikram.menon@acme.test");
    const tooMany = await sk.saveFeedbackTemplateAction(S, fd({ name: `${TAG} Peer`, purpose: "PEER", questions: "" }));
    const tpl = await sk.saveFeedbackTemplateAction(S, fd({ name: `${TAG} Peer`, purpose: "PEER", questions: "What should they keep doing?\nWhat should they change?", description: "Quarterly peer feedback" }));
    const templateId = tpl.values?.templateId ?? "";
    await sk.feedbackTemplateReviewAction(S, fd({ templateId, op: "submit" }));
    const tSelf = await sk.feedbackTemplateReviewAction(S, fd({ templateId, op: "approve" }));
    await signInAs("priya.sharma@acme.test");
    const tOk = await sk.feedbackTemplateReviewAction(S, fd({ templateId, op: "approve" }));
    check("A template needs questions; another reviewer approves it", !tooMany.ok && tpl.ok && !tSelf.ok && tOk.ok && (await prisma.feedbackTemplate.findUniqueOrThrow({ where: { id: templateId } })).status === "APPROVED", tOk.message);

    // -----------------------------------------------------------------------
    section("Audit trail");
    const types = ["Course", "LearningPath", "LearningRequest", "TrainingSession", "TalentReview", "SuccessionPlan", "Successor", "InternalApplication", "MobilityRequest", "CareerPath", "CompetencyFramework", "ProficiencyScale", "DevelopmentPlan", "DevelopmentAction", "CoachingPlan", "PipCheckIn", "ImprovementPlan", "FeedbackTemplate"];
    const audited = await prisma.auditLog.groupBy({ by: ["entityType"], where: { tenantId: tenant.id, createdAt: { gte: started }, entityType: { in: types } } });
    const missing = types.filter((t) => !audited.some((a) => a.entityType === t));
    check("Every growth object's changes are audited", missing.length === 0, missing.join(", "));
  } finally {
    for (const f of restore.reverse()) await f().catch((e) => console.error("restore failed:", e));
    await cleanup(tenant.id, started, { jobChanges, approvalRequests, pips });
    await prisma.$disconnect();
  }
  report("Growth");
}

async function cleanup(tenantId: string, started: Date, made: { jobChanges: string[]; approvalRequests: string[]; pips: string[] }) {
  const like = { startsWith: TAG };
  const step = async (label: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { console.error(`cleanup ${label} failed:`, e); } };
  const meera = await prisma.employee.findFirst({ where: { tenantId, employeeNumber: "ACM0009" } });
  // Development, coaching and improvement plans
  await step("dev actions", () => prisma.developmentAction.deleteMany({ where: { tenantId, OR: [{ title: like }, { createdAt: { gte: started } }] } }));
  await step("dev plans", () => prisma.developmentPlan.deleteMany({ where: { tenantId, createdAt: { gte: started } } }));
  await step("coaching", () => prisma.coachingPlan.deleteMany({ where: { tenantId, focusArea: like } }));
  await step("pips", () => prisma.improvementPlan.deleteMany({ where: { OR: [{ id: { in: made.pips } }, { tenantId, reason: like }] } }));
  // Mobility
  await step("moves", () => prisma.mobilityRequest.deleteMany({ where: { tenantId, createdAt: { gte: started } } }));
  await step("job changes", () => prisma.jobChange.deleteMany({ where: { id: { in: made.jobChanges } } }));
  await step("approval requests", () => prisma.payrollApprovalRequest.deleteMany({ where: { id: { in: made.approvalRequests } } }));
  await step("career paths", () => prisma.careerPath.deleteMany({ where: { tenantId, name: like } }));
  // Succession
  await step("succession", () => prisma.successionPlan.deleteMany({ where: { tenantId, positionTitle: like } }));
  await step("talent reviews", () => prisma.talentReview.deleteMany({ where: { tenantId, name: like } }));
  await step("readiness", () => prisma.readinessLevel.deleteMany({ where: { tenantId, code: "SMKG_3Y" } }));
  // Skills
  await step("frameworks", () => prisma.competencyFramework.deleteMany({ where: { tenantId, name: like } }));
  await step("scales", () => prisma.proficiencyScale.deleteMany({ where: { tenantId, name: like } }));
  await step("templates", () => prisma.feedbackTemplate.deleteMany({ where: { tenantId, name: like } }));
  await step("skills", () => prisma.skill.deleteMany({ where: { tenantId, name: like } }));
  // Learning
  const courses = await prisma.course.findMany({ where: { tenantId, title: like }, select: { id: true } });
  const ids = courses.map((c) => c.id);
  await step("certificates", () => prisma.learningCertificate.deleteMany({ where: { courseId: { in: ids } } }));
  await step("requests", () => prisma.learningRequest.deleteMany({ where: { courseId: { in: ids } } }));
  await step("sessions", () => prisma.trainingSession.deleteMany({ where: { tenantId, title: like } }));
  await step("paths", () => prisma.learningPath.deleteMany({ where: { tenantId, name: like } }));
  await step("enrolments", () => prisma.courseEnrolment.deleteMany({ where: { courseId: { in: ids } } }));
  await step("courses", () => prisma.course.deleteMany({ where: { id: { in: ids } } }));
  const progs = await prisma.trainingProgram.findMany({ where: { tenantId, title: like }, select: { id: true } });
  await step("programs", async () => {
    await prisma.trainingEnrolment.deleteMany({ where: { programId: { in: progs.map((p) => p.id) } } });
    await prisma.trainingProgram.deleteMany({ where: { id: { in: progs.map((p) => p.id) } } });
  });
  await step("notifications", () => prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } }));
  void meera;
}

main().catch((e) => { console.error(e); process.exit(1); });
