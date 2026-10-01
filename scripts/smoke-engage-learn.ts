/**
 * Engagement, learning, careers, comp-off and leave encashment through the
 * actions: who may run surveys and see results, anonymity, one response per
 * person; course authoring, quizzes, completion and the skill it awards;
 * skill confirmation; comp-off judged against the calendar and the punches;
 * and encashment reaching the payroll run. Cleans up after itself.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function main() {
  const eng = await import("../apps/web/src/app/actions/engage");
  const lrn = await import("../apps/web/src/app/actions/learning");
  const car = await import("../apps/web/src/app/actions/career");
  const tr = await import("../apps/web/src/app/actions/time-requests");
  const svc = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const emp = (n: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, employeeNumber: n } });
  const meera = await emp("ACM0009"), ramesh = await emp("ACM0002");
  const made = { surveys: [] as string[], courses: [] as string[], logs: [] as string[], compOff: [] as string[], encash: [] as string[], skills: [] as string[] };
  const started = new Date();
  const punchedDays: Date[] = [];
  const runIds = new Set<string>();
  // Encashment is configured per leave type; the seed leaves EL closed to in-service requests, so open it for the run and put it back after.
  const compTypeId = (await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, category: "COMP_OFF" } })).id;
  const compBalsBefore = await prisma.leaveBalance.findMany({ where: { employeeId: meera.id, leaveTypeId: compTypeId }, omit: { employeeId: true, leaveTypeId: true, yearStart: true, updatedAt: true } });
  const elBefore = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, code: "EL" }, select: { id: true, allowEncashmentRequest: true, encashmentMaxDaysPerYear: true } });

  console.log("\nEngagement, learning, careers and time off\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Surveys");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a survey", await denied(() => eng.createSurveyAction({}, fd({ title: "x", kind: "PULSE" }))));
    await signInAs("priya.sharma@acme.test");
    const badPoll = await eng.createSurveyAction({}, fd({ title: "Smoke poll", kind: "POLL", pollQuestion: "Pick one", pollOptions: "Only one" }));
    check("A poll with one option is refused", badPoll.ok === false && !!badPoll.errors?.pollOptions, badPoll.message);
    const created = await eng.createSurveyAction({}, fd({ title: "Smoke pulse", kind: "PULSE", isAnonymous: true, minGroupSize: 2 }));
    const survey = await prisma.survey.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke pulse" }, include: { questions: true } });
    made.surveys.push(survey.id);
    check("HR drafts a pulse from the template", created.ok === true && survey.status === "DRAFT" && survey.questions.length === 5, created.message);
    const added = await eng.addQuestionAction({}, fd({ surveyId: survey.id, prompt: "Which day suits the offsite?", type: "SINGLE_CHOICE", options: "Thursday\nFriday", required: true }));
    check("A choice question can be added before launch", added.ok === true, added.message);
    const sales = (await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Sales" } })).id;
    const salesForm = fd({ title: "Smoke sales-only", kind: "ENPS" });
    salesForm.append("departmentIds", sales);
    const salesMade = await eng.createSurveyAction({}, salesForm);
    const salesOnly = await prisma.survey.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke sales-only" } });
    made.surveys.push(salesOnly.id);
    check("A survey can be sent to one department", salesMade.ok === true && salesOnly.departmentIds.join() === sales, salesMade.message);

    await signInAs("meera.krishnan@acme.test");
    const early = await eng.submitSurveyAction({}, fd({ surveyId: survey.id }));
    check("Nobody can respond to a draft", early.ok === false, early.message);
    await signInAs("priya.sharma@acme.test");
    const launched = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "launch" }));
    check("Launching notifies everyone", launched.ok === true && /Launched to \d+/.test(launched.message ?? ""), launched.message);
    const locked = await eng.addQuestionAction({}, fd({ surveyId: survey.id, prompt: "Too late", type: "TEXT" }));
    check("…after which the questions are fixed", locked.ok === false, locked.message);
    await eng.surveyOpAction({}, fd({ surveyId: salesOnly.id, op: "launch" }));

    await signInAs("meera.krishnan@acme.test");
    const qs = [...survey.questions].sort((a, b) => a.sequence - b.sequence);
    const choiceQ = await prisma.surveyQuestion.findFirstOrThrow({ where: { surveyId: survey.id, type: "SINGLE_CHOICE" } });
    const answers = (over: Record<string, string> = {}) => {
      const f = fd({ surveyId: survey.id });
      for (const q of qs) if (q.type === "RATING") f.set(`q_${q.id}`, "4");
      f.set(`q_${choiceQ.id}`, "1");
      for (const [k, v] of Object.entries(over)) f.set(k, v);
      return f;
    };
    const bad = await eng.submitSurveyAction({}, answers({ [`q_${qs[0].id}`]: "9" }));
    check("An out-of-range rating is refused with the question flagged", bad.ok === false && !!bad.errors?.[`q_${qs[0].id}`], bad.message);
    const missing = (() => { const f = answers(); f.delete(`q_${qs[1].id}`); return f; })();
    const miss = await eng.submitSurveyAction({}, missing);
    check("A required question left blank is refused", miss.ok === false && !!miss.errors?.[`q_${qs[1].id}`]);
    const ok = await eng.submitSurveyAction({}, answers({ [`q_${qs[4].id}`]: "Smoke comment" }));
    check("Meera responds", ok.ok === true, ok.message);
    const twice = await eng.submitSurveyAction({}, answers());
    check("…but only once", twice.ok === false && /already/.test(twice.message ?? ""), twice.message);
    const resp = await prisma.surveyResponse.findMany({ where: { surveyId: survey.id } });
    check("The stored response carries no employee", resp.length === 1 && resp[0].employeeId === null);
    check("…and its timestamp is the day only", resp[0].submittedAt.toISOString().endsWith("T00:00:00.000Z"));
    check("…while participation is recorded separately", (await prisma.surveyParticipant.count({ where: { surveyId: survey.id, employeeId: meera.id } })) === 1);
    const notMine = await eng.submitSurveyAction({}, fd({ surveyId: salesOnly.id }));
    check("A survey addressed to another department is refused", notMine.ok === false && /not addressed/.test(notMine.message ?? ""), notMine.message);

    const { surveyResults } = await import("../apps/web/src/lib/survey-results");
    const one = await surveyResults(tenant.id, survey.id);
    check("With one response under a minimum of two, results are withheld", one?.revealed === false && one.perQuestion.every((q) => q.rating === null && q.comments === null));
    await signInAs("varun.rathore@acme.test");
    const v = await eng.submitSurveyAction({}, (() => { const f = answers(); f.set("surveyId", survey.id); return f; })());
    check("A second colleague responds", v.ok === true, v.message);
    const two = await surveyResults(tenant.id, survey.id);
    const q1 = two?.perQuestion.find((q) => q.id === qs[0].id);
    check("…and now results show, favourable 100% on all-4 answers", two?.revealed === true && q1?.rating?.favourable === 100, JSON.stringify(q1?.rating));
    const platform = two?.breakdown.find((b) => b.department === "Platform Engineering");
    check("A department slice of one is still hidden", (platform?.responses ?? 0) < 2 ? platform?.favourable === null : true);

    await signInAs("priya.sharma@acme.test");
    const closed = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "close" }));
    check("HR closes the survey", closed.ok === true, closed.message);
    await signInAs("ramesh.iyer@acme.test");
    const late = await eng.submitSurveyAction({}, answers());
    check("…after which nobody can respond", late.ok === false, late.message);

    // -----------------------------------------------------------------------
    section("Learning — authoring");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot author a course", await denied(() => lrn.saveCourseAction({}, fd({ title: "x", category: "y", level: "BEGINNER" }))));
    await signInAs("priya.sharma@acme.test");
    const skill = await prisma.skill.findFirstOrThrow({ where: { tenantId: tenant.id, name: "System Design" } });
    const c1 = await lrn.saveCourseAction({}, fd({ title: "Smoke course", category: "Engineering", level: "BEGINNER", passPercent: 60, skillId: skill.id, skillLevel: 2 }));
    const course = await prisma.course.findFirstOrThrow({ where: { tenantId: tenant.id, title: "Smoke course" } });
    made.courses.push(course.id);
    check("HR creates a course", c1.ok === true && course.status === "DRAFT", c1.message);
    const noBody = await lrn.addLessonAction({}, fd({ courseId: course.id, title: "Empty", kind: "ARTICLE" }));
    check("An article without text is refused", noBody.ok === false, noBody.message);
    const badUrl = await lrn.addLessonAction({}, fd({ courseId: course.id, title: "Vid", kind: "VIDEO", url: "javascript:alert(1)" }));
    check("A video link that is not http(s) is refused", badUrl.ok === false, badUrl.message);
    await lrn.addLessonAction({}, fd({ courseId: course.id, title: "Read me", kind: "ARTICLE", body: "Some text.", durationMinutes: 5 }));
    await lrn.addLessonAction({}, fd({ courseId: course.id, title: "Quiz", kind: "QUIZ", durationMinutes: 5 }));
    const early2 = await lrn.courseOpAction({}, fd({ courseId: course.id, op: "publish" }));
    check("A quiz with no questions blocks publishing", early2.ok === false && /no questions/.test(early2.message ?? ""), early2.message);
    const quiz = await prisma.courseLesson.findFirstOrThrow({ where: { courseId: course.id, kind: "QUIZ" } });
    const qq1 = await lrn.addQuizQuestionAction({}, fd({ lessonId: quiz.id, prompt: "2 + 2?", options: "3\n4\n5", correct: 2 }));
    const qqBad = await lrn.addQuizQuestionAction({}, fd({ lessonId: quiz.id, prompt: "Bad", options: "a\nb", correct: 3 }));
    await lrn.addQuizQuestionAction({}, fd({ lessonId: quiz.id, prompt: "Capital of India?", options: "Mumbai\nNew Delhi", correct: 2 }));
    check("Quiz questions are added; a correct answer outside the options is refused", qq1.ok === true && qqBad.ok === false, qqBad.message);
    const pub = await lrn.courseOpAction({}, fd({ courseId: course.id, op: "publish" }));
    check("The course publishes", pub.ok === true, pub.message);

    section("Learning — assigning and taking");
    await signInAs("sneha.reddy@acme.test"); // implicit manager of engineering
    const toTeam = await lrn.assignCourseAction({}, (() => { const f = fd({ courseId: course.id }); f.append("employeeIds", meera.id); return f; })());
    check("A manager assigns the course to someone in her line", toTeam.ok === true, toTeam.message);
    const outside = await lrn.assignCourseAction({}, (() => { const f = fd({ courseId: course.id }); f.append("employeeIds", ramesh.id); return f; })());
    check("…but not to someone outside it", outside.ok === false && /scope/.test(outside.message ?? ""), outside.message);
    const enrolment = await prisma.courseEnrolment.findUniqueOrThrow({ where: { courseId_employeeId: { courseId: course.id, employeeId: meera.id } } });
    check("…with a notification to the learner", (await prisma.notification.count({ where: { tenantId: tenant.id, kind: "LEARNING", link: `/learn/courses/${course.id}` } })) >= 1);

    await signInAs("ramesh.iyer@acme.test");
    const article = await prisma.courseLesson.findFirstOrThrow({ where: { courseId: course.id, kind: "ARTICLE" } });
    const notMineL = await lrn.completeLessonAction({}, fd({ enrolmentId: enrolment.id, lessonId: article.id }));
    check("Nobody can complete a lesson on someone else's enrolment", notMineL.ok === false, notMineL.message);
    await signInAs("meera.krishnan@acme.test");
    const tickQuiz = await lrn.completeLessonAction({}, fd({ enrolmentId: enrolment.id, lessonId: quiz.id }));
    check("A quiz cannot just be ticked off", tickQuiz.ok === false, tickQuiz.message);
    const read = await lrn.completeLessonAction({}, fd({ enrolmentId: enrolment.id, lessonId: article.id }));
    const e1 = await prisma.courseEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } });
    check("Reading the article moves progress to 50%", read.ok === true && e1.progressPercent === 50 && e1.status === "IN_PROGRESS", `${e1.progressPercent}%`);
    const questions = await prisma.quizQuestion.findMany({ where: { lessonId: quiz.id }, orderBy: { sequence: "asc" } });
    const fail = await lrn.submitQuizAction({}, fd({ enrolmentId: enrolment.id, lessonId: quiz.id, [`qq_${questions[0].id}`]: 1, [`qq_${questions[1].id}`]: 0 }));
    check("Half right fails a 60% bar and says what was wrong", fail.ok === false && /50%/.test(fail.message ?? "") && fail.values?.[`r_${questions[1].id}`] === "0", fail.message);
    const pass = await lrn.submitQuizAction({}, fd({ enrolmentId: enrolment.id, lessonId: quiz.id, [`qq_${questions[0].id}`]: 1, [`qq_${questions[1].id}`]: 1 }));
    const e2 = await prisma.courseEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } });
    check("A full marks retry passes and completes the course", pass.ok === true && e2.status === "COMPLETED" && e2.progressPercent === 100 && e2.score === 100, pass.message);
    const es = await prisma.employeeSkill.findUnique({ where: { employeeId_skillId: { employeeId: meera.id, skillId: skill.id } } });
    if (es) made.skills.push(es.id);
    check("Completion records the course's skill at its level", es?.level === 2 && es.isApproved && es.source === "COURSE_COMPLETION");
    await lrn.submitQuizAction({}, fd({ enrolmentId: enrolment.id, lessonId: quiz.id, [`qq_${questions[0].id}`]: 0, [`qq_${questions[1].id}`]: 0 }));
    const e3 = await prisma.courseEnrolment.findUniqueOrThrow({ where: { id: enrolment.id }, include: { lessons: true } });
    check("A later failed attempt does not undo the pass", e3.status === "COMPLETED" && e3.lessons.find((l) => l.lessonId === quiz.id)?.score === 100);

    // -----------------------------------------------------------------------
    section("Skills");
    await signInAs("meera.krishnan@acme.test");
    const react = await prisma.skill.findFirstOrThrow({ where: { tenantId: tenant.id, name: "React" } });
    const negotiation = await prisma.skill.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Negotiation" } });
    const confirmed = await car.addMySkillAction({}, fd({ skillId: react.id, level: 3 }));
    check("A self-rating cannot overwrite a level her manager confirmed", confirmed.ok === false, confirmed.message);
    const selfAdd = await car.addMySkillAction({}, fd({ skillId: negotiation.id, level: 2 }));
    const pendingRow = await prisma.employeeSkill.findUniqueOrThrow({ where: { employeeId_skillId: { employeeId: meera.id, skillId: negotiation.id } } });
    made.skills.push(pendingRow.id);
    check("A new self-rated skill waits for approval", selfAdd.ok === true && pendingRow.isApproved === false, selfAdd.message);
    const selfRate = await car.rateSkillAction({}, fd({ employeeId: meera.id, skillId: negotiation.id, level: 3 }));
    check("She cannot confirm her own skill", selfRate.ok === false, selfRate.message);
    await signInAs("ramesh.iyer@acme.test");
    const stranger = await car.rateSkillAction({}, fd({ employeeId: meera.id, skillId: negotiation.id, level: 1 }));
    check("Someone outside her line cannot either", stranger.ok === false, stranger.message);
    await signInAs("sneha.reddy@acme.test"); // skip-level manager
    const rated = await car.rateSkillAction({}, fd({ employeeId: meera.id, skillId: negotiation.id, level: 1 }));
    const after = await prisma.employeeSkill.findUniqueOrThrow({ where: { id: pendingRow.id } });
    check("Her manager's manager confirms it at a level of their choosing", rated.ok === true && after.isApproved && after.level === 1, rated.message);

    // -----------------------------------------------------------------------
    section("Comp-off");
    // Comp-off is now claimed for a date range; the credit is worked out from the processed attendance
    // (weekly offs and holidays worked, against the shift's full/half-day thresholds) rather than chosen.
    const tz = 330 * 60_000;
    const punch = async (day: Date, inH: number, outH: number) => {
      for (const [h, dir] of [[inH, 0], [outH, 1]] as const) {
        const l = await prisma.attendanceLog.create({ data: { tenantId: tenant.id, employeeId: meera.id, timestamp: new Date(day.getTime() - tz + h * 3_600_000), direction: dir, source: "WEB" } });
        made.logs.push(l.id);
      }
      punchedDays.push(day);
      await svc.reprocessRange(meera.id, day, day);
    };
    const DAY = 86_400_000;
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const back = (n: number) => new Date(today.getTime() - n * DAY);
    const sunday = back(((today.getUTCDay() + 6) % 7) + 1);        // the last Sunday before today
    const saturday = new Date(sunday.getTime() - 8 * DAY);          // the Saturday of the week before
    const wednesday = new Date(sunday.getTime() - 4 * DAY);
    const quietSunday = new Date(sunday.getTime() - 14 * DAY);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const tomorrow = iso(new Date(today.getTime() + DAY));
    await punch(sunday, 9.5, 18);    // 8.5 hours
    await punch(saturday, 10, 14);   // 4 hours
    await signInAs("meera.krishnan@acme.test");
    const onWeekday = await tr.raiseCompOffAction({}, fd({ fromDate: iso(wednesday), note: "x" }));
    check("A working day cannot be claimed", onWeekday.ok === false && /weekly off or holiday/.test(onWeekday.message ?? ""), onWeekday.message);
    const noPunch = await tr.raiseCompOffAction({}, fd({ fromDate: iso(quietSunday), note: "x" }));
    check("An off day with no attendance cannot be claimed", noPunch.ok === false && /None of these dates/.test(noPunch.message ?? ""), noPunch.message);
    const future = await tr.raiseCompOffAction({}, fd({ fromDate: tomorrow, note: "x" }));
    check("A day not yet worked cannot be claimed", future.ok === false && /already worked/.test(future.message ?? ""), future.message);
    const half = await tr.raiseCompOffAction({}, fd({ fromDate: iso(saturday), note: "Release" }));
    const satReq0 = await prisma.compOffRequest.findFirst({ where: { employeeId: meera.id, fromDate: saturday, status: "PENDING" } });
    if (satReq0) made.compOff.push(satReq0.id);
    check("Four hours on an off day earns a half day, not a full one", half.ok === true && Number(satReq0?.days) === 0.5, half.message);
    const full = await tr.raiseCompOffAction({}, fd({ fromDate: iso(sunday), note: "Payments outage" }));
    const sundayReq = await prisma.compOffRequest.findFirstOrThrow({ where: { employeeId: meera.id, fromDate: sunday, status: "PENDING" } });
    made.compOff.push(sundayReq.id);
    check("A full Sunday is a full day", full.ok === true && Number(sundayReq.days) === 1, full.message);
    const dup = await tr.raiseCompOffAction({}, fd({ fromDate: iso(sunday), note: "Again" }));
    check("The same day cannot be claimed twice", dup.ok === false, dup.message);

    await signInAs("ramesh.iyer@acme.test");
    const notHers = await tr.withdrawTimeRequestAction({}, fd({ entity: "CompOffRequest", requestId: satReq0!.id }));
    check("Nobody else can withdraw her claim", notHers.ok === false, notHers.message);
    await signInAs("meera.krishnan@acme.test");
    const withdrawn = await tr.withdrawTimeRequestAction({}, fd({ entity: "CompOffRequest", requestId: satReq0!.id }));
    check("She can withdraw her own pending claim", withdrawn.ok === true && (await prisma.compOffRequest.findUniqueOrThrow({ where: { id: satReq0!.id } })).status === "WITHDRAWN", withdrawn.message);
    const reraised = await tr.raiseCompOffAction({}, fd({ fromDate: iso(saturday), note: "Release" }));
    const satReq = await prisma.compOffRequest.findFirstOrThrow({ where: { employeeId: meera.id, fromDate: saturday, status: "PENDING" } });
    made.compOff.push(satReq.id);
    check("…which frees the day to be claimed again", reraised.ok === true, reraised.message);

    const decide = (requestId: string, decision: string, note?: string) => tr.decideTimeRequestAction({}, fd({ entity: "CompOffRequest", requestId, decision, note }));
    const own = await decide(sundayReq.id, "approve");
    check("She cannot approve her own claim", own.ok === false, own.message);
    await signInAs("ramesh.iyer@acme.test");
    // Ramesh approves leave for his own reports, but Meera is not one of them.
    const outsider = await decide(sundayReq.id, "approve");
    check("A manager outside her line cannot decide it", outsider.ok === false && /outside/.test(outsider.message ?? ""), outsider.message);
    await signInAs("manish.tiwari@acme.test");
    const noPerm = await decide(sundayReq.id, "approve");
    check("Someone with no leave approval at all is refused outright", noPerm.ok === false && /permission/.test(noPerm.message ?? ""), noPerm.message);
    await signInAs("ananya.ghosh@acme.test");
    const noReason = await decide(satReq.id, "reject");
    check("Rejecting needs a reason", noReason.ok === false && !!noReason.errors?.note, noReason.message);
    const rej = await decide(satReq.id, "reject", "Covered by overtime");
    check("Her manager rejects the half day", rej.ok === true, rej.message);
    const compType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, category: "COMP_OFF" } });
    const before = await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: meera.id, leaveTypeId: compType.id }, _sum: { days: true } });
    const app = await decide(sundayReq.id, "approve");
    const afterSum = await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: meera.id, leaveTypeId: compType.id }, _sum: { days: true } });
    check("…and approves the Sunday, crediting exactly one day", app.ok === true && Number(afterSum._sum.days ?? 0) - Number(before._sum.days ?? 0) === 1, app.message);
    const again = await decide(sundayReq.id, "approve");
    check("Approving again changes nothing", again.ok === false && (await prisma.leaveLedgerEntry.count({ where: { periodKey: `COMPOFF:${sundayReq.id}` } })) === 1, again.message);
    const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: meera.id, leaveTypeId: compType.id }, orderBy: { yearStart: "desc" } });
    check("The comp-off balance shows the day", Number(bal?.available ?? 0) >= 1, String(bal?.available));
    await signInAs("meera.krishnan@acme.test");
    const lateWithdraw = await tr.withdrawTimeRequestAction({}, fd({ entity: "CompOffRequest", requestId: sundayReq.id }));
    check("A decided claim can no longer be withdrawn", lateWithdraw.ok === false, lateWithdraw.message);

    // -----------------------------------------------------------------------
    section("Leave encashment");
    const el = await prisma.leaveType.update({ where: { id: elBefore.id }, data: { allowEncashmentRequest: true, encashmentMaxDaysPerYear: 10 } });
    const quoteOf = async (typeId: string) => (await svc.encashableTypes(meera.id)).find((t) => t.leaveTypeId === typeId);
    const quote = await quoteOf(el.id);
    const encash = (leaveTypeId: string, days: string | number, note?: string) => tr.raiseEncashmentAction({}, fd({ leaveTypeId, mode: "custom", days, note }));
    await signInAs("meera.krishnan@acme.test");
    const tooMany = await encash(el.id, quote!.encashable + 1);
    check("More than the free balance is refused", (quote?.encashable ?? 0) >= 1 && tooMany.ok === false && /at most/.test(tooMany.message ?? ""), tooMany.message);
    const cl = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, code: "CL" } });
    const notEnc = await encash(cl.id, 1);
    check("A non-encashable type is refused", notEnc.ok === false, notEnc.message);
    const raised = await encash(el.id, 1, "Smoke");
    const encReq = await prisma.leaveEncashmentRequest.findFirstOrThrow({ where: { employeeId: meera.id, note: "Smoke" } });
    made.encash.push(encReq.id);
    check("One day is requested at the quoted rate", raised.ok === true && Number(encReq.amount) === Math.round(quote!.ratePerDay), `${raised.message} · ${encReq.amount}`);
    const held = await quoteOf(el.id);
    check("…and that day is held while the request is pending", held!.encashable === quote!.encashable - 1, `${quote!.encashable} → ${held!.encashable}`);

    const decideEnc = (decision: string) => tr.decideTimeRequestAction({}, fd({ entity: "LeaveEncashmentRequest", requestId: encReq.id, decision }));
    await signInAs("ramesh.iyer@acme.test");
    const strangerEnc = await decideEnc("approve");
    check("A manager outside her line cannot approve her encashment", strangerEnc.ok === false && /outside/.test(strangerEnc.message ?? ""), strangerEnc.message);
    // Approved encashment is paid in the next payroll month (svc.nextPayrollMonth: the earliest open regular run
    // from this month on, else the month after the last finalised one, never before this month).
    const { year, month } = await svc.nextPayrollMonth(tenant.id);
    const run = await prisma.payrollRun.findFirst({ where: { tenantId: tenant.id, type: "REGULAR", year, month, status: { notIn: ["FINALIZED", "ROLLED_BACK"] } } });
    if (run) { runIds.add(run.id); await svc.calculateRun(run.id); }
    const pre = run ? await prisma.payrollRunEmployee.findFirst({ where: { runId: run.id, employeeId: meera.id } }) : null;
    await signInAs("priya.sharma@acme.test");
    const approved = await decideEnc("approve");
    const encDone = await prisma.leaveEncashmentRequest.findUniqueOrThrow({ where: { id: encReq.id } });
    const pay = await prisma.adhocTransaction.findFirst({ where: { sourceType: "LeaveEncashmentRequest", sourceId: encReq.id } });
    check("HR approves; a taxable payment is raised for the next payroll month",
      approved.ok === true && encDone.status === "APPROVED" && !!pay && pay.id === encDone.adhocTransactionId && pay.taxTreatment === "TAXABLE"
        && pay.year === year && pay.month === month && Math.round(Number(pay.amount)) === Math.round(Number(encDone.amount)),
      `${approved.message}`);
    check("…never into a payroll month already finalised",
      (await prisma.payrollRun.count({ where: { tenantId: tenant.id, year, month, status: "FINALIZED" } })) === 0, `${month}/${year}`);
    if (run && pre) {
      await svc.calculateRun(run.id);
      const post = await prisma.payrollRunEmployee.findFirstOrThrow({ where: { runId: run.id, employeeId: meera.id } });
      check("…which that month's open run picks up in gross pay", Math.round(Number(post.grossEarnings) - Number(pre.grossEarnings)) === Math.round(Number(encDone.amount)),
        `gross ${pre.grossEarnings} → ${post.grossEarnings}, amount ${encDone.amount}`);
      check("…TDS rises because it is taxable", Number(post.totalDeductions) >= Number(pre.totalDeductions));
    } else {
      console.log(`  (no open run for ${month}/${year} yet — the payment waits for it, so the gross/TDS checks are skipped)`);
    }
    check("…and the day leaves the balance through the ledger", (await prisma.leaveLedgerEntry.findFirst({ where: { periodKey: `ENCASH:${encReq.id}` } }))?.days.toNumber() === -1);
    const twiceEnc = await decideEnc("approve");
    check("It cannot be paid twice", twiceEnc.ok === false && (await prisma.adhocTransaction.count({ where: { sourceType: "LeaveEncashmentRequest", sourceId: encReq.id } })) === 1, twiceEnc.message);
  } finally {
    // ---- Clean up, so the suite can run again ----
    for (const id of made.encash) {
      await prisma.adhocTransaction.deleteMany({ where: { sourceType: "LeaveEncashmentRequest", sourceId: id } });
      await prisma.leaveLedgerEntry.deleteMany({ where: { periodKey: `ENCASH:${id}` } });
    }
    await prisma.leaveEncashmentRequest.deleteMany({ where: { id: { in: made.encash } } });
    await prisma.leaveType.update({ where: { id: elBefore.id }, data: { allowEncashmentRequest: elBefore.allowEncashmentRequest, encashmentMaxDaysPerYear: elBefore.encashmentMaxDaysPerYear } });
    for (const id of made.compOff) await prisma.leaveLedgerEntry.deleteMany({ where: { periodKey: `COMPOFF:${id}` } });
    await prisma.compOffRequest.deleteMany({ where: { id: { in: made.compOff } } });
    await prisma.attendanceLog.deleteMany({ where: { id: { in: made.logs } } });
    for (const d of punchedDays) await svc.reprocessRange(meera.id, d, d);
    await prisma.employeeSkill.deleteMany({ where: { id: { in: made.skills } } });
    await prisma.course.deleteMany({ where: { id: { in: made.courses } } });
    await prisma.survey.deleteMany({ where: { id: { in: made.surveys } } });
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, OR: [
      { title: { contains: "Smoke" } },
      { link: { in: made.courses.map((c) => `/learn/courses/${c}`) } },
      { kind: "LEAVE", createdAt: { gte: started } },
      { kind: "PERFORMANCE", createdAt: { gte: started }, link: { startsWith: "/performance/careers" } },
    ] } });
    // Rebuild the balances and the run the suite touched.
    // Comp-off: put the balance rows back as they were. Recomputing an empty ledger would "adopt" the
    // stale row as an opening balance, so restore the snapshot instead.
    await prisma.leaveBalance.deleteMany({ where: { employeeId: meera.id, leaveTypeId: compTypeId, id: { notIn: compBalsBefore.map((b) => b.id) } } });
    for (const { id, ...rest } of compBalsBefore) await prisma.leaveBalance.update({ where: { id }, data: rest });
    await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId: meera.id, leaveTypeId: compTypeId, periodKey: { startsWith: "ADOPTED-" }, createdAt: { gte: started } } });
    const elBals = await prisma.leaveBalance.findMany({ where: { employeeId: meera.id, leaveTypeId: elBefore.id } });
    for (const b of elBals) await svc.recomputeBalance(meera.id, b.leaveTypeId, b.yearStart);
    for (const r of runIds) await svc.calculateRun(r);
  }
  report("Engagement, learning, careers and time off");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
