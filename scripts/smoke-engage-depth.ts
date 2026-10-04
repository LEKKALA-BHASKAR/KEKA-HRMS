/**
 * Engage depth, end to end through the actions, the workflow engine, the
 * pages and the CSV exports:
 *   1. Access: who may run each module; employee exports are refused.
 *   2. Survey lifecycle: approval before launch, branching, reminders,
 *      sign-in pulse, templates, recurring schedules, action plans, heat map,
 *      comment moderation, archive and retention.
 *   3. Recognition: award categories, programmes with budget and eligibility
 *      (approval), nominations (manager + panel), praise points, the points
 *      ledger, reward catalog, redemption (approval, stock, refund,
 *      fulfilment), certificates, revocation, duplication.
 *   4. Wellness: programme approval, consent, enrolment, progress to
 *      completion (points), anonymous check-ins, support resources (review).
 *   5. Employee services: catalog, request with approval, SLA, fulfilment,
 *      decline, cancel and rating.
 *   6. Announcements: audience, approval, translation, acknowledgement and
 *      reminders, scheduled publish via the job, emergency broadcast banner.
 *   7. Communities: open and private channels (owner approval), posting
 *      rules, moderation, reports decided by communications.
 *   8. Events: proposal and approval, RSVP with capacity and waitlist,
 *      questions, attendance.
 *   9. Every page and tab renders; every export works and is audited; the
 *      nightly engage job runs.
 *
 * Everything it creates is tagged "Smoke ED" and removed at the end, and
 * the engage settings are restored.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const TAG = "Smoke ED";
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** An instant as an IST datetime-local value. */
const local = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
const ENGAGE_TYPES = ["SURVEY_PUBLISH", "ANNOUNCEMENT_PUBLISH", "RECOGNITION_PROGRAM", "AWARD_NOMINATION", "REWARD_REDEMPTION", "SERVICE_REQUEST", "WELLNESS_PROGRAM", "SUPPORT_RESOURCE", "COMPANY_EVENT", "CHANNEL_JOIN"];

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { digest?: string; message?: string };
    return /HTTP_ERROR_FALLBACK;40[34]|NEXT_REDIRECT/.test(`${e.digest ?? ""} ${e.message ?? ""}`);
  }
}
function multi(values: Record<string, string | string[] | boolean>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "boolean") { if (v) f.set(k, "on"); continue; }
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  }
  return f;
}

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  async function resolve(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (node instanceof Promise) return resolve(await node);
    if (!React.isValidElement(node)) return node;
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const props: Record<string, unknown> = {};
    let children: unknown = undefined;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "children") children = await resolve(v);
      else props[k] = React.isValidElement(v) ? await resolve(v) : v;
    }
    if (children === undefined) return React.cloneElement(el, props as never);
    return Array.isArray(children) ? React.cloneElement(el, props as never, ...(children as React.ReactNode[])) : React.cloneElement(el, props as never, children as React.ReactNode);
  }
  const html = async (page: unknown) => renderToStaticMarkup((await resolve(await page)) as Parameters<typeof renderToStaticMarkup>[0]);
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
  const id$ = (id: string) => Promise.resolve({ id });

  const eng = await import("../apps/web/src/app/actions/engage");
  const sAct = await import("../apps/web/src/app/actions/engage-surveys");
  const rAct = await import("../apps/web/src/app/actions/engage-rewards");
  const wAct = await import("../apps/web/src/app/actions/engage-wellness");
  const cAct = await import("../apps/web/src/app/actions/engage-comms");
  const wall = await import("../apps/web/src/app/actions/home-wall");
  const wfAct = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("@keka/services");
  const { requireViewer } = await import("../apps/web/src/lib/context");
  const SurveysPage = (await import("../apps/web/src/app/(app)/engage/surveys/page")).default;
  const SurveyPage = (await import("../apps/web/src/app/(app)/engage/surveys/[id]/page")).default;
  const SurveyAdminPage = (await import("../apps/web/src/app/(app)/engage/survey-admin/page")).default;
  const RewardsPage = (await import("../apps/web/src/app/(app)/engage/rewards/page")).default;
  const WellnessPage = (await import("../apps/web/src/app/(app)/engage/wellness/page")).default;
  const ServicesPage = (await import("../apps/web/src/app/(app)/engage/services/page")).default;
  const AnnouncementsPage = (await import("../apps/web/src/app/(app)/announcements/page")).default;
  const CommunitiesPage = (await import("../apps/web/src/app/(app)/engage/communities/page")).default;
  const ChannelPage = (await import("../apps/web/src/app/(app)/engage/communities/[id]/page")).default;
  const EventsPage = (await import("../apps/web/src/app/(app)/engage/events/page")).default;
  const EventPage = (await import("../apps/web/src/app/(app)/engage/events/[id]/page")).default;
  const { SignInPulse } = await import("../apps/web/src/app/(app)/home/_components/pulse-card");
  const { EmergencyBanner } = await import("../apps/web/src/components/emergency-banner");
  const exportRoute = await import("../apps/web/src/app/(app)/engage/export/route");
  const certRoute = await import("../apps/web/src/app/(app)/engage/rewards/certificate/[id]/route");
  const { NextRequest } = await import("next/server");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const emp = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const meera = await emp("meera.krishnan@acme.test");
  const harish = await emp("harish.prasad@acme.test");
  const aditya = await emp("aditya.verma@acme.test");
  const ananya = await emp("ananya.ghosh@acme.test");
  const rahul = await emp("rahul.kapoor@acme.test");
  const settingsBefore = await prisma.engageSetting.findUnique({ where: { tenantId: t } });
  const startedAt = new Date();
  const as = (who: string) => signInAs(`${who}@acme.test`);

  /** Decide every pending task of a request as whoever it is assigned to. */
  async function decideAll(requestId: string | null | undefined, decision: "approve" | "reject" = "approve") {
    if (!requestId) return "NO_REQUEST";
    for (let i = 0; i < 6; i++) {
      const tk = await prisma.workflowTask.findFirst({ where: { requestId, status: "PENDING" }, orderBy: { stepOrder: "asc" } });
      if (!tk) break;
      const u = await prisma.user.findUniqueOrThrow({ where: { id: tk.approverUserId } });
      await signInAs(u.email);
      const r = await wfAct.decideWorkflowTaskAction({}, fd({ taskId: tk.id, decision, comment: `${TAG} decision` }));
      if (!r.ok) return `FAILED: ${r.message}`;
      if (decision === "reject") break;
    }
    return (await prisma.workflowRequest.findUniqueOrThrow({ where: { id: requestId } })).status;
  }
  async function csv(q: string) {
    const res = await exportRoute.GET(new NextRequest(`http://acme.localhost/engage/export?${q}`));
    return { status: res.status, body: await res.text() };
  }
  const balance = (id: string) => svc.pointsBalanceOf(t, id);

  console.log("\nEngage depth: surveys, rewards, wellness, services, communication\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Access");
    await as("meera.krishnan");
    check("An employee cannot draft a recognition programme", await denied(() => rAct.saveProgramAction({}, fd({ name: "x" }))));
    check("…nor a wellness programme", await denied(() => wAct.saveWellnessProgramAction({}, fd({ title: "x" }))));
    check("…nor a service type", await denied(() => sAct.saveScheduleAction({}, fd({ title: "x" }))) && await denied(() => wAct.saveServiceTypeAction({}, fd({ name: "x" }))));
    check("…nor change engage settings", await denied(() => sAct.saveEngageSettingsAction({}, fd({ scope: "rewards", pointsPerPraise: 99, anniversaryPoints: 0 }))));
    check("…nor publish announcements", await denied(() => cAct.saveAnnouncementAction({}, fd({ title: "x", body: "y" }))));
    check("…nor open survey administration", await denied(() => html(SurveyAdminPage({ searchParams: sp() }))));
    for (const r of ["awards", "points-ledger", "wellbeing", "service-requests", "announcements", "surveys"]) check(`…nor export ${r}`, (await csv(`report=${r}`)).status === 403);

    // -----------------------------------------------------------------------
    section("Survey lifecycle");
    await as("priya.sharma");
    const setOn = await sAct.saveEngageSettingsAction({}, fd({ scope: "surveys", surveyApproval: true, surveyRetentionDays: 10 }));
    check("Retention under 30 days is refused", setOn.ok === false && !!setOn.errors?.surveyRetentionDays, setOn.message);
    check("HR turns survey approval on", (await sAct.saveEngageSettingsAction({}, fd({ scope: "surveys", surveyApproval: true, surveyRetentionDays: 0 }))).ok && (await svc.engageSettings(t)).surveyApproval);
    const made = await eng.createSurveyAction({}, fd({ title: `${TAG} pulse`, kind: "PULSE", isAnonymous: true, minGroupSize: 2, onSignIn: true, randomize: true, reminderEveryDays: 2 }));
    const survey = await prisma.survey.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} pulse` }, include: { questions: { orderBy: { sequence: "asc" } } } });
    check("A pulse is drafted with reminders, sign-in pulse and randomised order", made.ok && survey.onSignIn && survey.randomize && survey.reminderEveryDays === 2, made.message);
    const q1 = survey.questions.find((q) => q.type === "RATING")!;
    const badBranch = await eng.addQuestionAction({}, fd({ surveyId: survey.id, prompt: "What would help?", type: "TEXT", showIfQuestionId: q1.id, showIfValues: "9" }));
    check("A branch on an impossible score is refused", badBranch.ok === false, badBranch.message);
    const branch = await eng.addQuestionAction({}, fd({ surveyId: survey.id, prompt: "What would help most?", type: "TEXT", required: true, showIfQuestionId: q1.id, showIfValues: "1, 2" }));
    const follow = await prisma.surveyQuestion.findFirstOrThrow({ where: { surveyId: survey.id, prompt: "What would help most?" } });
    check("A follow-up asked only on a low score is added", branch.ok && follow.showIfQuestionId === q1.id && follow.showIfValues.join() === "1,2", branch.message);
    const edited = await eng.editQuestionAction({}, fd({ questionId: follow.id, prompt: "What one thing would help most?", required: true }));
    check("A draft question can be edited", edited.ok && (await prisma.surveyQuestion.findUniqueOrThrow({ where: { id: follow.id } })).prompt.startsWith("What one thing"), edited.message);
    const early = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "launch" }));
    check("With approval on, a direct launch is refused", early.ok === false, early.message);
    const submitted = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "submit" }));
    const sv1 = await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } });
    check("It is submitted for approval", submitted.ok && sv1.approvalStatus === "PENDING" && !!sv1.workflowRequestId, submitted.message);
    const svDecision = await decideAll(sv1.workflowRequestId);
    const sv2 = await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } });
    check("Another survey manager approves and it launches", svDecision === "APPROVED" && sv2.status === "ACTIVE" && sv2.approvalStatus === "APPROVED", `${svDecision} ${sv2.status}`);

    await as("meera.krishnan");
    const pulseHtml = await html(SignInPulse({ viewer: await requireViewer() }));
    check("The sign-in pulse appears on Meera's home", pulseHtml.includes("Answer now") && pulseHtml.includes("Quick pulse"));
    const qs = await prisma.surveyQuestion.findMany({ where: { surveyId: survey.id }, orderBy: { sequence: "asc" } });
    const answers = (score: string, extra: Record<string, string> = {}) => {
      const f = fd({ surveyId: survey.id });
      for (const q of qs) if (q.type === "RATING") f.set(`q_${q.id}`, score);
      for (const q of qs) if (q.type === "NPS") f.set(`q_${q.id}`, "8");
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      return f;
    };
    const high = await eng.submitSurveyAction({}, answers("5"));
    check("A high score skips the follow-up (not required)", high.ok, high.message);
    check("…and the pulse leaves her home", !(await html(SignInPulse({ viewer: await requireViewer() }))).includes("Answer now"));
    await as("harish.prasad");
    const lowNoFollow = await eng.submitSurveyAction({}, answers("1"));
    check("A low score makes the follow-up required", lowNoFollow.ok === false && !!lowNoFollow.errors?.[`q_${follow.id}`], lowNoFollow.message);
    const low = await eng.submitSurveyAction({}, answers("1", { [`q_${follow.id}`]: `${TAG} more focus time, Rahul is rude` }));
    check("…and is accepted with it", low.ok, low.message);
    await as("aditya.verma");
    check("A third colleague responds", (await eng.submitSurveyAction({}, answers("4", {}))).ok);

    await as("priya.sharma");
    const remind = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "remind" }));
    check("HR reminds the non-respondents", remind.ok && !!(await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } })).lastReminderAt, remind.message);
    const detail = await html(SurveyPage({ params: id$(survey.id), searchParams: Promise.resolve({ by: "location" }) }));
    check("Results show the heat map by location and the moderation panel", detail.includes("Comment moderation") && /heat map/i.test(detail));
    const comment = await prisma.surveyAnswer.findFirstOrThrow({ where: { questionId: follow.id } });
    const hideNoReason = await sAct.moderateSurveyCommentAction({}, fd({ answerId: comment.id, op: "hide" }));
    check("Hiding a comment needs a reason", hideNoReason.ok === false);
    const hid = await sAct.moderateSurveyCommentAction({}, fd({ answerId: comment.id, op: "hide", reason: "Names a colleague" }));
    const { surveyResults } = await import("../apps/web/src/lib/survey-results");
    const res = await surveyResults(t, survey.id);
    check("A hidden comment is left out of results", hid.ok && !(res?.perQuestion.find((q) => q.id === follow.id)?.comments ?? []).some((c) => c.includes("Rahul")), hid.message);
    check("…and out of the results export", !(await csv(`report=survey-results&id=${survey.id}`)).body.includes("Rahul"));
    const plan = await sAct.createActionPlanAction({}, fd({ surveyId: survey.id, title: `${TAG} protect focus time`, ownerEmployeeId: ananya.id, dueOn: iso(new Date(Date.now() + 14 * DAY)), driver: q1.driver ?? "" }));
    const planRow = await prisma.surveyActionPlan.findFirstOrThrow({ where: { tenantId: t, surveyId: survey.id } });
    check("An action plan is created with an owner and a due date", plan.ok && planRow.ownerEmployeeId === ananya.id, plan.message);
    await as("ananya.ghosh");
    const prog = await sAct.updateActionPlanAction({}, fd({ id: planRow.id, status: "IN_PROGRESS", progressNote: "No-meeting Wednesdays agreed" }));
    check("The owner records progress", prog.ok && (await prisma.surveyActionPlan.findUniqueOrThrow({ where: { id: planRow.id } })).status === "IN_PROGRESS", prog.message);
    await as("priya.sharma");
    const tpl = await sAct.saveTemplateFromSurveyAction({}, fd({ surveyId: survey.id, name: `${TAG} template` }));
    const tplRow = await prisma.surveyTemplate.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} template` } });
    check("The survey is saved to the template library", tpl.ok && Array.isArray(tplRow.questions) && (tplRow.questions as unknown[]).length === qs.length, tpl.message);
    const fromTpl = await eng.createSurveyAction({}, fd({ title: `${TAG} from template`, kind: "PULSE", templateId: tplRow.id }));
    const fromTplRow = await prisma.survey.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} from template` }, include: { questions: true } });
    check("A new survey starts from the library template", fromTpl.ok && fromTplRow.questions.length === qs.length, fromTpl.message);
    const sched = await sAct.saveScheduleAction({}, fd({ title: `${TAG} monthly pulse`, kind: "PULSE", everyDays: 30, openDays: 5, nextRunOn: iso(new Date()), templateId: tplRow.id }));
    const schedRow = await prisma.surveySchedule.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} monthly pulse` } });
    check("A recurring pulse is scheduled", sched.ok, sched.message);
    const ran = await sAct.scheduleOpAction({}, fd({ op: "run-now", id: schedRow.id }));
    const run = await prisma.survey.findFirst({ where: { tenantId: t, scheduleId: schedRow.id } });
    const schedAfter = await prisma.surveySchedule.findUniqueOrThrow({ where: { id: schedRow.id } });
    check("Running it launches a survey and moves the next run on", ran.ok && run?.status === "ACTIVE" && schedAfter.runs === 1 && schedAfter.nextRunOn > new Date(), ran.message);
    check("…and running due schedules again launches nothing new", (await svc.runSurveySchedules(t)) === 0);
    await sAct.scheduleOpAction({}, fd({ op: "pause", id: schedRow.id }));
    check("A schedule can be paused", !(await prisma.surveySchedule.findUniqueOrThrow({ where: { id: schedRow.id } })).isActive);
    for (const tab of ["schedules", "templates", "actions", "trends", "settings"]) check(`Survey admin › ${tab} renders`, (await html(SurveyAdminPage({ searchParams: sp({ tab }) }))).length > 400);
    check("The survey list searches and filters", (await html(SurveysPage({ searchParams: sp({ q: TAG, kind: "PULSE" }) }))).includes(`${TAG} pulse`));
    for (const r of [`survey-results&id=${survey.id}`, `survey-heatmap&id=${survey.id}&by=department`, "action-plans", "surveys"]) {
      const x = await csv(`report=${r}`);
      check(`Export ${r.split("&")[0]}`, x.status === 200 && x.body.split("\n").length >= 2, String(x.status));
    }
    await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "close" }));
    const arch = await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "archive" }));
    check("A closed survey is archived", arch.ok && !!(await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } })).archivedAt, arch.message);
    await eng.surveyOpAction({}, fd({ surveyId: survey.id, op: "unarchive" }));
    await prisma.survey.update({ where: { id: survey.id }, data: { closedAt: new Date(Date.now() - 40 * DAY) } });
    await sAct.saveEngageSettingsAction({}, fd({ scope: "surveys", surveyApproval: true, surveyRetentionDays: 30 }));
    const purge = await sAct.applySurveyRetentionAction({}, fd({}));
    check("Retention deletes responses 30+ days after closing, keeping participation", purge.ok && (await prisma.surveyResponse.count({ where: { surveyId: survey.id } })) === 0 && (await prisma.surveyParticipant.count({ where: { surveyId: survey.id } })) === 3, purge.message);

    // -----------------------------------------------------------------------
    section("Recognition & rewards");
    await as("priya.sharma");
    check("A programme with an end before its start is refused", (await rAct.saveProgramAction({}, fd({ name: `${TAG} bad`, kind: "SPOT", startsOn: iso(new Date()), endsOn: iso(new Date(Date.now() - 5 * DAY)) }))).ok === false);
    const at = await rAct.saveAwardTypeAction({}, fd({ name: `${TAG} Star`, cadence: "SPOT", cashAmount: 1000, points: 30 }));
    const type = await prisma.awardType.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Star` } });
    check("An award category is created", at.ok, at.message);
    const badge = await rAct.saveBadgeAction({}, fd({ name: `${TAG} Badge`, color: "#3366AA", icon: "rocket", position: 9 }));
    check("A praise badge is added to the picker", badge.ok && (await prisma.praiseBadge.count({ where: { tenantId: t, name: `${TAG} Badge`, isActive: true } })) === 1, badge.message);
    const pf = multi({ name: `${TAG} Q4 spot`, kind: "SPOT", awardTypeId: type.id, pointsPerAward: "100", budgetPoints: "150", budgetAmount: "5000", startsOn: iso(new Date()), minTenureDays: "30", cooldownDays: "0", departmentIds: [meera.departmentId!] });
    const progMade = await rAct.saveProgramAction({}, pf);
    const program = await prisma.recognitionProgram.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Q4 spot` } });
    check("A programme is drafted with a budget and eligibility", progMade.ok && program.status === "DRAFT" && program.budgetPoints === 150, progMade.message);
    await rAct.programOpAction({}, fd({ id: program.id, op: "submit" }));
    const progReq = (await prisma.recognitionProgram.findUniqueOrThrow({ where: { id: program.id } })).workflowRequestId;
    const progDecision = await decideAll(progReq);
    check("It is approved by another rewards administrator and goes live", progDecision === "APPROVED" && (await prisma.recognitionProgram.findUniqueOrThrow({ where: { id: program.id } })).status === "ACTIVE", progDecision);

    await as("meera.krishnan");
    const shortCite = await rAct.nominateAction({}, fd({ nomineeId: harish.id, programId: program.id, citation: "Great" }));
    check("A one-word citation is refused", shortCite.ok === false && !!shortCite.errors?.citation);
    const outside = await rAct.nominateAction({}, fd({ nomineeId: rahul.id, programId: program.id, citation: `${TAG}: closed the biggest deal of the quarter single-handedly` }));
    check("A nominee outside the programme's departments is refused", outside.ok === false, outside.message);
    const nom = await rAct.nominateAction({}, fd({ nomineeId: harish.id, programId: program.id, citation: `${TAG}: rebuilt the release pipeline over a weekend` }));
    const nomRow = await prisma.awardNomination.findFirstOrThrow({ where: { tenantId: t, nomineeId: harish.id, awardTypeId: type.id } });
    check("Meera nominates Harish", nom.ok && nomRow.status === "PENDING", nom.message);
    const steps = await prisma.workflowTask.findMany({ where: { requestId: nomRow.workflowRequestId! } });
    check("…and his manager decides first", steps.length >= 1 && steps[0].approverUserId === (await prisma.employee.findUniqueOrThrow({ where: { id: ananya.id } })).userId);
    const before = await balance(harish.id);
    const nomDecision = await decideAll(nomRow.workflowRequestId);
    const nomAfter = await prisma.awardNomination.findUniqueOrThrow({ where: { id: nomRow.id } });
    check("Manager and panel approve; the award is granted", nomDecision === "APPROVED" && nomAfter.status === "APPROVED" && !!nomAfter.awardId, nomDecision);
    check("…crediting the programme's 100 points", (await balance(harish.id)) - before === 100);
    await as("meera.krishnan");
    await rAct.nominateAction({}, fd({ nomineeId: aditya.id, programId: program.id, citation: `${TAG}: mentored three new joiners through their first release` }));
    const over = await prisma.awardNomination.findFirstOrThrow({ where: { tenantId: t, nomineeId: aditya.id, awardTypeId: type.id } });
    const overDecision = await decideAll(over.workflowRequestId);
    check("A nomination beyond the points budget is not granted", (await prisma.awardNomination.findUniqueOrThrow({ where: { id: over.id } })).status !== "APPROVED", overDecision);
    await as("meera.krishnan");
    const praiseBefore = await balance(harish.id);
    const praised = await wall.givePraisePostAction({}, multi({ message: `${TAG} thanks for the pairing session`, toEmployeeId: [harish.id] }));
    check("Praise on the wall earns the recipient points", praised.ok && (await balance(harish.id)) - praiseBefore === (await svc.engageSettings(t)).pointsPerPraise, praised.message);

    await as("priya.sharma");
    await rAct.saveRewardItemAction({}, fd({ name: `${TAG} Coffee voucher`, category: "VOUCHER", pointsCost: 50, stock: 1 }));
    await rAct.saveRewardItemAction({}, fd({ name: `${TAG} Hoodie`, category: "MERCHANDISE", pointsCost: 40 }));
    const coffee = await prisma.rewardItem.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Coffee voucher` } });
    const hoodie = await prisma.rewardItem.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Hoodie` } });
    const adj = await rAct.adjustPointsAction({}, fd({ employeeId: meera.id, delta: 5, note: `${TAG} correction` }));
    check("HR posts a manual adjustment", adj.ok, adj.message);
    await as("meera.krishnan");
    check("Meera cannot redeem more than her balance", (await rAct.redeemAction({}, fd({ itemId: coffee.id }))).ok === false || (await balance(meera.id)) >= 50);
    await as("harish.prasad");
    const hb = await balance(harish.id);
    const red = await rAct.redeemAction({}, fd({ itemId: coffee.id, deliveryNote: "Desk 4B" }));
    const redRow = await prisma.rewardRedemption.findFirstOrThrow({ where: { tenantId: t, itemId: coffee.id, employeeId: harish.id } });
    check("Harish redeems; the points are held", red.ok && redRow.status === "PENDING" && hb - (await balance(harish.id)) === 50, red.message);
    const redDecision = await decideAll(redRow.workflowRequestId);
    check("The rewards team approves; stock goes down", redDecision === "APPROVED" && (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: redRow.id } })).status === "APPROVED" && (await prisma.rewardItem.findUniqueOrThrow({ where: { id: coffee.id } })).stock === 0, redDecision);
    await as("harish.prasad");
    check("An out-of-stock reward cannot be redeemed", (await rAct.redeemAction({}, fd({ itemId: coffee.id }))).ok === false);
    const red2 = await rAct.redeemAction({}, fd({ itemId: hoodie.id }));
    const red2Row = await prisma.rewardRedemption.findFirstOrThrow({ where: { tenantId: t, itemId: hoodie.id } });
    const hb2 = await balance(harish.id);
    const rej = await decideAll(red2Row.workflowRequestId, "reject");
    check("A rejected redemption refunds the points", red2.ok && rej === "REJECTED" && (await balance(harish.id)) - hb2 === 40, rej);
    await as("priya.sharma");
    check("Fulfilment needs a note", (await rAct.fulfilRedemptionAction({}, fd({ id: redRow.id }))).ok === false);
    const ful = await rAct.fulfilRedemptionAction({}, fd({ id: redRow.id, note: "Voucher SMOKE-123 emailed" }));
    check("The reward is fulfilled", ful.ok && (await prisma.rewardRedemption.findUniqueOrThrow({ where: { id: redRow.id } })).status === "FULFILLED", ful.message);
    const award = await prisma.employeeAward.findUniqueOrThrow({ where: { id: nomAfter.awardId! } });
    await as("harish.prasad");
    const pdf = await certRoute.GET(new NextRequest(`http://acme.localhost/engage/rewards/certificate/${award.id}`), { params: Promise.resolve({ id: award.id }) });
    check("Harish downloads his certificate as a PDF", pdf.status === 200 && (pdf.headers.get("content-type") ?? "").includes("pdf") && (await pdf.arrayBuffer()).byteLength > 500);
    await as("priya.sharma");
    const upd = await rAct.updateAwardAction({}, fd({ awardId: award.id, citation: `${TAG}: rebuilt the release pipeline` }));
    check("HR edits the citation", upd.ok, upd.message);
    const dup = await rAct.programOpAction({}, fd({ id: program.id, op: "duplicate" }));
    check("A programme is duplicated into a new draft (template)", dup.ok && (await prisma.recognitionProgram.count({ where: { tenantId: t, name: { startsWith: `${TAG} Q4 spot (copy` }, status: "DRAFT" } })) === 1, dup.message);
    const hb3 = await balance(harish.id);
    const rev = await rAct.revokeAwardAction({}, fd({ awardId: award.id, reason: "Awarded in error" }));
    check("Revoking an award reverses its points", rev.ok && hb3 - (await balance(harish.id)) === 100, rev.message);
    const gone = await certRoute.GET(new NextRequest(`http://acme.localhost/engage/rewards/certificate/${award.id}`), { params: Promise.resolve({ id: award.id }) });
    check("…and withdraws its certificate", gone.status === 404);
    for (const tab of ["wallet", "nominate", "catalog", "programs", "awards", "redemptions", "setup", "reports"]) check(`Rewards › ${tab} renders`, (await html(RewardsPage({ searchParams: sp({ tab }) }))).length > 400);
    for (const r of ["awards", "nominations", "praise", "points-ledger", "redemptions", "program-budgets", "fairness"]) {
      const x = await csv(`report=${r}`);
      check(`Export ${r}`, x.status === 200 && x.body.split("\n").length >= 2, String(x.status));
    }
    await as("harish.prasad");
    const wallet = await html(RewardsPage({ searchParams: sp({ tab: "wallet" }) }));
    check("Harish's wallet shows his ledger and redemptions", wallet.includes("Points history") && wallet.includes(`${TAG} Coffee voucher`));
    check("…and an employee sees no admin tabs", !wallet.includes("tab=setup") && !wallet.includes("tab=redemptions"));

    // -----------------------------------------------------------------------
    section("Wellness");
    await as("priya.sharma");
    const noGoal = await wAct.saveWellnessProgramAction({}, fd({ title: `${TAG} steps`, kind: "CHALLENGE", category: "FITNESS", startsOn: iso(new Date()), endsOn: iso(new Date(Date.now() + 30 * DAY)) }));
    check("A challenge without a goal is refused", noGoal.ok === false && !!noGoal.errors?.goalValue);
    const wp = await wAct.saveWellnessProgramAction({}, fd({ title: `${TAG} steps`, kind: "CHALLENGE", category: "FITNESS", startsOn: iso(new Date()), endsOn: iso(new Date(Date.now() + 30 * DAY)), goalValue: 100, goalUnit: "km", capacity: 5, pointsReward: 20, requireConsent: true }));
    const wpr = await prisma.wellnessProgram.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} steps` } });
    await as("meera.krishnan");
    check("Nobody can enrol in a draft", (await wAct.enrolAction({}, fd({ programId: wpr.id, consent: true }))).ok === false);
    await as("priya.sharma");
    await wAct.wellnessProgramOpAction({}, fd({ id: wpr.id, op: "submit" }));
    const wpDecision = await decideAll((await prisma.wellnessProgram.findUniqueOrThrow({ where: { id: wpr.id } })).workflowRequestId);
    check("A challenge is drafted, approved and goes live", wp.ok && wpDecision === "APPROVED" && (await prisma.wellnessProgram.findUniqueOrThrow({ where: { id: wpr.id } })).status === "ACTIVE", wpDecision);
    await as("meera.krishnan");
    check("Enrolment without consent is refused", (await wAct.enrolAction({}, fd({ programId: wpr.id }))).ok === false);
    const enr = await wAct.enrolAction({}, fd({ programId: wpr.id, consent: true, showOnBoard: true }));
    const enrRow = await prisma.wellnessEnrollment.findFirstOrThrow({ where: { programId: wpr.id, employeeId: meera.id } });
    check("Meera enrols with consent recorded", enr.ok && !!enrRow.consentAt, enr.message);
    check("…only once", (await wAct.enrolAction({}, fd({ programId: wpr.id, consent: true }))).ok === false);
    const mb = await balance(meera.id);
    await wAct.logProgressAction({}, fd({ enrollmentId: enrRow.id, value: 60, note: "Week 1" }));
    const done = await wAct.logProgressAction({}, fd({ enrollmentId: enrRow.id, value: 50 }));
    const enr2 = await prisma.wellnessEnrollment.findUniqueOrThrow({ where: { id: enrRow.id } });
    check("Logging past the goal completes the challenge", done.ok && enr2.status === "COMPLETED" && enr2.progress === 110, done.message);
    check("…and credits the reward points once", (await balance(meera.id)) - mb === 20);
    const ci = await wAct.checkInAction({}, fd({ mood: 2, stress: 4, wantsSupport: true, note: TAG }));
    check("Meera checks in anonymously", ci.ok && (await prisma.wellbeingCheckIn.count({ where: { tenantId: t, note: TAG } })) === 1, ci.message);
    check("…once a week", (await wAct.checkInAction({}, fd({ mood: 4, stress: 2 }))).ok === false);
    check("The stored check-in carries no employee", !("employeeId" in (await prisma.wellbeingCheckIn.findFirstOrThrow({ where: { tenantId: t, note: TAG } }))));
    await as("priya.sharma");
    check("A support link must be https", (await wAct.saveResourceAction({}, fd({ title: `${TAG} EAP`, kind: "EAP", url: "http://x.test" }))).ok === false);
    await wAct.saveResourceAction({}, fd({ title: `${TAG} EAP`, kind: "EAP", phone: "1800-000-000", url: "https://eap.example.test", tags: "mental, confidential" }));
    const resRow = await prisma.supportResource.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} EAP` } });
    await wAct.resourceOpAction({}, fd({ id: resRow.id, op: "submit" }));
    const resDecision = await decideAll((await prisma.supportResource.findUniqueOrThrow({ where: { id: resRow.id } })).workflowRequestId);
    check("A support resource is reviewed and published", resDecision === "APPROVED" && (await prisma.supportResource.findUniqueOrThrow({ where: { id: resRow.id } })).status === "PUBLISHED", resDecision);
    await as("meera.krishnan");
    check("Employees find it in the support directory", (await html(WellnessPage({ searchParams: sp({ tab: "support", q: "eap" }) }))).includes(`${TAG} EAP`));
    check("…and see their challenge progress", (await html(WellnessPage({ searchParams: sp({ tab: "programs" }) }))).includes(`${TAG} steps`));
    await as("priya.sharma");
    const summary = svc.wellbeingSummary([{ group: "A", mood: 2, stress: 4 }], 3);
    check("Wellbeing groups under the minimum are hidden", summary.overall === null && summary.groups[0].hidden === true);
    for (const tab of ["programs", "checkin", "support", "manage", "reports"]) check(`Wellness › ${tab} renders`, (await html(WellnessPage({ searchParams: sp({ tab }) }))).length > 400);
    for (const r of ["wellness", "wellbeing"]) check(`Export ${r}`, (await csv(`report=${r}`)).status === 200);

    // -----------------------------------------------------------------------
    section("Employee services");
    await as("deepak.chauhan");
    const st = await wAct.saveServiceTypeAction({}, fd({ name: `${TAG} ID card`, category: "ID_CARD", slaDays: 2, requiresApproval: true, fields: "Card type\nReason" }));
    const st2 = await wAct.saveServiceTypeAction({}, fd({ name: `${TAG} Parking`, category: "PARKING", slaDays: 1, fields: "Vehicle number" }));
    const idType = await prisma.serviceType.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} ID card` } });
    const parkType = await prisma.serviceType.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Parking` } });
    check("The service team publishes services with their forms", st.ok && st2.ok && idType.fields.length === 2 && !parkType.requiresApproval, st.message);
    await as("meera.krishnan");
    check("A request with a blank field is refused", (await wAct.requestServiceAction({}, fd({ typeId: idType.id, f_0: "Replacement" }))).ok === false);
    const sr = await wAct.requestServiceAction({}, fd({ typeId: idType.id, f_0: "Replacement", f_1: "Lost it", details: TAG }));
    const srRow = await prisma.serviceRequest.findFirstOrThrow({ where: { tenantId: t, typeId: idType.id } });
    check("Meera requests an ID card; it waits for her manager", sr.ok && srRow.status === "PENDING_APPROVAL" && (srRow.answers as Record<string, string>)["Card type"] === "Replacement", sr.message);
    const srDecision = await decideAll(srRow.workflowRequestId);
    const srOpen = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: srRow.id } });
    check("Approved, it opens with an SLA due date", srDecision === "APPROVED" && srOpen.status === "OPEN" && !!srOpen.dueOn, srDecision);
    await as("meera.krishnan");
    check("Meera cannot fulfil it herself", (await wAct.serviceRequestOpAction({}, fd({ id: srRow.id, op: "fulfil", note: "x" }))).ok === false);
    await as("deepak.chauhan");
    await wAct.serviceRequestOpAction({}, fd({ id: srRow.id, op: "start" }));
    check("The team picks it up", (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: srRow.id } })).status === "IN_PROGRESS");
    check("Fulfilling needs a note", (await wAct.serviceRequestOpAction({}, fd({ id: srRow.id, op: "fulfil" }))).ok === false);
    const ful2 = await wAct.serviceRequestOpAction({}, fd({ id: srRow.id, op: "fulfil", note: "Card #4471 at reception" }));
    check("…and fulfils it", ful2.ok && (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: srRow.id } })).status === "FULFILLED", ful2.message);
    await as("meera.krishnan");
    check("Meera rates the service", (await wAct.rateServiceAction({}, fd({ id: srRow.id, rating: 5, comment: "Quick" }))).ok && (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: srRow.id } })).rating === 5);
    const pk = await wAct.requestServiceAction({}, fd({ typeId: parkType.id, f_0: "KA01AB1234" }));
    const pkRow = await prisma.serviceRequest.findFirstOrThrow({ where: { tenantId: t, typeId: parkType.id } });
    check("A service without approval opens straight away", pk.ok && pkRow.status === "OPEN", pk.message);
    const cancel = await wAct.serviceRequestOpAction({}, fd({ id: pkRow.id, op: "cancel" }));
    check("…and the requester can cancel it", cancel.ok && (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: pkRow.id } })).status === "CANCELLED", cancel.message);
    await wAct.requestServiceAction({}, fd({ typeId: parkType.id, f_0: "KA01ZZ0001" }));
    const pk2 = await prisma.serviceRequest.findFirstOrThrow({ where: { tenantId: t, typeId: parkType.id, status: "OPEN" } });
    await as("deepak.chauhan");
    const decl = await wAct.serviceRequestOpAction({}, fd({ id: pk2.id, op: "reject", note: "No bays left" }));
    check("The team can decline with a reason", decl.ok && (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: pk2.id } })).status === "REJECTED", decl.message);
    for (const tab of ["catalog", "mine", "queue", "setup", "reports"]) check(`Services › ${tab} renders`, (await html(ServicesPage({ searchParams: sp({ tab }) }))).length > 400);
    check("Export service-requests", (await csv("report=service-requests")).body.includes("Card #4471"));

    // -----------------------------------------------------------------------
    section("Announcements");
    await as("priya.sharma");
    await sAct.saveEngageSettingsAction({}, fd({ scope: "announcements", announcementApproval: true }));
    const af = multi({ title: `${TAG} Product all-hands`, body: "Thursday 4pm in the atrium.", category: "EVENT", intent: "publish", requireAck: true, departmentIds: [meera.departmentId!], lang: "hi", langTitle: `${TAG} उत्पाद सभा`, langBody: "गुरुवार 4 बजे" });
    const ann = await cAct.saveAnnouncementAction({}, af);
    const annRow = await prisma.announcement.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Product all-hands` } });
    check("With approval on, publishing submits it for approval", ann.ok && annRow.status === "DRAFT" && annRow.approvalStatus === "PENDING", ann.message);
    const annDecision = await decideAll(annRow.workflowRequestId);
    const annLive = await prisma.announcement.findUniqueOrThrow({ where: { id: annRow.id } });
    check("Approved by communications, it is published", annDecision === "APPROVED" && annLive.status === "PUBLISHED", annDecision);
    const audience = await svc.announcementAudience(t, annLive.audience as never);
    check("Its audience is the department only", audience.some((e) => e.id === meera.id) && !audience.some((e) => e.id === rahul.id));
    await as("meera.krishnan");
    check("Meera sees it in Hindi when she asks", (await html(AnnouncementsPage({ searchParams: sp({ lang: "hi" }) }))).includes("उत्पाद सभा"));
    const ack = await cAct.acknowledgeAnnouncementAction({}, fd({ announcementId: annRow.id }));
    check("…and acknowledges it", ack.ok && !!(await prisma.announcementRead.findFirst({ where: { announcementId: annRow.id, employeeId: meera.id } }))?.acknowledgedAt, ack.message);
    await as("rahul.kapoor");
    check("Sales does not see it", !(await html(AnnouncementsPage({ searchParams: sp() }))).includes(`${TAG} Product all-hands`));
    await as("priya.sharma");
    const rem = await cAct.announcementOpAction({}, fd({ id: annRow.id, op: "remind" }));
    check("HR reminds those yet to acknowledge", rem.ok && !!(await prisma.announcement.findUniqueOrThrow({ where: { id: annRow.id } })).lastReminderAt, rem.message);
    const report1 = await html(AnnouncementsPage({ searchParams: sp({ tab: "report", id: annRow.id }) }));
    check("The reach report lists who is still to acknowledge", report1.includes("Still to acknowledge") && !report1.includes(`${meera.displayName},`));
    const acks = await csv(`report=announcement-acks&id=${annRow.id}`);
    check("The acknowledgement export marks Meera", acks.status === 200 && acks.body.includes(meera.displayName));
    await sAct.saveEngageSettingsAction({}, fd({ scope: "announcements" }));
    const later = await cAct.saveAnnouncementAction({}, fd({ title: `${TAG} Policy update`, body: "New leave policy.", category: "POLICY", intent: "publish", publishAt: local(new Date(Date.now() + 2 * DAY)) }));
    const laterRow = await prisma.announcement.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Policy update` } });
    check("A future publish time schedules it", later.ok && laterRow.status === "SCHEDULED", later.message);
    await prisma.announcement.update({ where: { id: laterRow.id }, data: { publishAt: new Date(Date.now() - 60_000) } });
    const job = await svc.runEngageJob(t);
    check("The nightly engage job publishes it when due", job.published >= 1 && (await prisma.announcement.findUniqueOrThrow({ where: { id: laterRow.id } })).status === "PUBLISHED", JSON.stringify(job));
    const em = await cAct.saveAnnouncementAction({}, fd({ title: `${TAG} Fire drill now`, body: "Leave the building by the nearest exit.", isEmergency: true }));
    const emRow = await prisma.announcement.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Fire drill now` } });
    check("An emergency broadcast goes out at once, pinned and emailed", em.ok && emRow.status === "PUBLISHED" && emRow.isPinned && emRow.notifyByEmail, em.message);
    await as("rahul.kapoor");
    check("…and shows as a banner for everyone", (await html(EmergencyBanner({ viewer: await requireViewer() }))).includes(`${TAG} Fire drill now`));
    await as("priya.sharma");
    await cAct.announcementOpAction({}, fd({ id: emRow.id, op: "archive" }));
    await as("rahul.kapoor");
    check("Archiving it clears the banner", !(await html(EmergencyBanner({ viewer: await requireViewer() }))).includes(`${TAG} Fire drill now`));
    await as("priya.sharma");
    const draft = await cAct.saveAnnouncementAction({}, fd({ title: `${TAG} Draft note`, body: "Draft" }));
    const draftRow = await prisma.announcement.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Draft note` } });
    const editDraft = await cAct.saveAnnouncementAction({}, fd({ id: draftRow.id, title: `${TAG} Draft note v2`, body: "Edited" }));
    check("A draft is saved and edited", draft.ok && editDraft.ok && (await prisma.announcement.findUniqueOrThrow({ where: { id: draftRow.id } })).title.endsWith("v2"));
    const del = await cAct.announcementOpAction({}, fd({ id: draftRow.id, op: "delete" }));
    check("…and deleted", del.ok && !(await prisma.announcement.findUnique({ where: { id: draftRow.id } })), del.message);
    for (const tab of ["live", "manage", "compose", "archive", "report"]) check(`Announcements › ${tab} renders`, (await html(AnnouncementsPage({ searchParams: sp({ tab }) }))).length > 400);
    check("The archive tab finds the archived broadcast", (await html(AnnouncementsPage({ searchParams: sp({ tab: "archive", q: "Fire drill" }) }))).includes(`${TAG} Fire drill now`));
    check("Export announcements", (await csv("report=announcements")).body.includes(`${TAG} Product all-hands`));

    // -----------------------------------------------------------------------
    section("Communities");
    await as("meera.krishnan");
    check("Only communications create department channels", (await cAct.saveChannelAction({}, fd({ name: `${TAG} dept`, kind: "DEPARTMENT", departmentId: meera.departmentId! }))).ok === false);
    const ch = await cAct.saveChannelAction({}, fd({ name: `${TAG} Runners`, kind: "INTEREST_GROUP", visibility: "OPEN", description: "Weekend runs" }));
    const chRow = await prisma.communityChannel.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Runners` } });
    check("Meera starts an interest group and owns it", ch.ok && (await prisma.communityMember.findFirst({ where: { channelId: chRow.id, employeeId: meera.id } }))?.role === "OWNER", ch.message);
    await cAct.postToChannelAction({}, fd({ channelId: chRow.id, body: `${TAG} 10k on Sunday?` }));
    const post = await prisma.communityPost.findFirstOrThrow({ where: { channelId: chRow.id } });
    await as("harish.prasad");
    check("Non-members cannot post", (await cAct.postToChannelAction({}, fd({ channelId: chRow.id, body: "hi" }))).ok === false);
    const join = await cAct.joinChannelAction({}, fd({ channelId: chRow.id }));
    check("Anyone can join an open group", join.ok, join.message);
    const reply = await cAct.postToChannelAction({}, fd({ channelId: chRow.id, body: `${TAG} count me in`, parentId: post.id }));
    check("…and reply in a thread", reply.ok, reply.message);
    const rep = await cAct.reportContentAction({}, fd({ targetType: "CHANNEL_POST", targetId: post.id, reason: "Spam" }));
    check("A post can be reported", rep.ok, rep.message);
    check("…once per person", (await cAct.reportContentAction({}, fd({ targetType: "CHANNEL_POST", targetId: post.id, reason: "Spam" }))).ok === false);
    check("Members cannot moderate", (await cAct.moderateChannelAction({}, fd({ channelId: chRow.id, postId: post.id, op: "pin" }))).ok === false);
    await as("meera.krishnan");
    check("The owner pins a post", (await cAct.moderateChannelAction({}, fd({ channelId: chRow.id, postId: post.id, op: "pin" }))).ok && (await prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).isPinned);
    const hm = await prisma.communityMember.findFirstOrThrow({ where: { channelId: chRow.id, employeeId: harish.id } });
    check("…and promotes a moderator", (await cAct.moderateChannelAction({}, fd({ channelId: chRow.id, memberId: hm.id, op: "promote" }))).ok && (await prisma.communityMember.findUniqueOrThrow({ where: { id: hm.id } })).role === "MODERATOR");
    check("The last owner cannot leave", (await cAct.leaveChannelAction({}, fd({ channelId: chRow.id }))).ok === false);
    await as("priya.sharma");
    const modHtml = await html(CommunitiesPage({ searchParams: sp({ tab: "moderation" }) }));
    check("The report reaches the moderation queue", modHtml.includes(`${TAG} 10k on Sunday?`));
    const repRow = await prisma.contentReport.findFirstOrThrow({ where: { tenantId: t, targetId: post.id } });
    const decided = await cAct.decideReportAction({}, fd({ id: repRow.id, decision: "remove" }));
    check("Communications remove it; the post is hidden", decided.ok && !!(await prisma.communityPost.findUniqueOrThrow({ where: { id: post.id } })).hiddenAt, decided.message);
    await as("meera.krishnan");
    await cAct.saveChannelAction({}, fd({ name: `${TAG} Leads`, kind: "CHANNEL", visibility: "PRIVATE", postingRestricted: true }));
    const priv = await prisma.communityChannel.findFirstOrThrow({ where: { tenantId: t, name: `${TAG} Leads` } });
    await as("aditya.verma");
    const ask = await cAct.joinChannelAction({}, fd({ channelId: priv.id, note: "Please add me" }));
    const pend = await prisma.communityMember.findFirstOrThrow({ where: { channelId: priv.id, employeeId: aditya.id } });
    check("Joining a private channel asks the owner", ask.ok && pend.status === "PENDING" && !!pend.workflowRequestId, ask.message);
    const task = await prisma.workflowTask.findFirst({ where: { requestId: pend.workflowRequestId!, status: "PENDING" } });
    check("…routed to Meera, the owner", task?.approverUserId === meera.userId);
    const joinDecision = await decideAll(pend.workflowRequestId);
    check("Once she approves, Aditya is a member", joinDecision === "APPROVED" && (await prisma.communityMember.findUniqueOrThrow({ where: { id: pend.id } })).status === "ACTIVE", joinDecision);
    await as("aditya.verma");
    check("…who can reply but not start threads in a restricted channel", (await cAct.postToChannelAction({}, fd({ channelId: priv.id, body: "New thread" }))).ok === false);
    check("The private channel page renders for a member", (await html(ChannelPage({ params: id$(priv.id), searchParams: sp() }))).includes(`${TAG} Leads`));
    for (const tab of ["directory", "mine", "create"]) check(`Communities › ${tab} renders`, (await html(CommunitiesPage({ searchParams: sp({ tab }) }))).length > 300);
    await as("priya.sharma");
    for (const tab of ["moderation", "reports"]) check(`Communities › ${tab} renders`, (await html(CommunitiesPage({ searchParams: sp({ tab }) }))).length > 300);
    check("The channel page shows hidden posts to moderators", (await html(ChannelPage({ params: id$(chRow.id), searchParams: sp() }))).includes("Hidden"));
    const arc = await cAct.moderateChannelAction({}, fd({ channelId: chRow.id, op: "archive" }));
    check("Communications can archive a channel", arc.ok && !!(await prisma.communityChannel.findUniqueOrThrow({ where: { id: chRow.id } })).archivedAt, arc.message);
    for (const r of ["channels", "feed", "polls"]) check(`Export ${r}`, (await csv(`report=${r}`)).status === 200);

    // -----------------------------------------------------------------------
    section("Events");
    await as("meera.krishnan");
    const start = new Date(Date.now() - 60 * 60_000), end = new Date(Date.now() + 2 * 60 * 60_000);
    const badEv = await cAct.saveEventAction({}, fd({ title: `${TAG} bad`, kind: "GENERAL", startsAt: local(end), endsAt: local(start) }));
    check("An event that ends before it starts is refused", badEv.ok === false);
    const ev = await cAct.saveEventAction({}, fd({ title: `${TAG} Town hall`, kind: "TOWN_HALL", startsAt: local(start), endsAt: local(end), location: "Atrium", capacity: 1 }));
    const evRow = await prisma.companyEvent.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Town hall` } });
    check("An employee's event is saved as a draft with questions on", ev.ok && evRow.status === "DRAFT" && evRow.allowQuestions, ev.message);
    await cAct.eventOpAction({}, fd({ id: evRow.id, op: "submit" }));
    const evDecision = await decideAll((await prisma.companyEvent.findUniqueOrThrow({ where: { id: evRow.id } })).workflowRequestId);
    check("Communications approve it onto the calendar", evDecision === "APPROVED" && (await prisma.companyEvent.findUniqueOrThrow({ where: { id: evRow.id } })).status === "PUBLISHED", evDecision);
    await as("meera.krishnan");
    const r1 = await cAct.rsvpAction({}, fd({ eventId: evRow.id, response: "GOING" }));
    await as("harish.prasad");
    const r2 = await cAct.rsvpAction({}, fd({ eventId: evRow.id, response: "GOING" }));
    check("The first RSVP takes the only place; the next is waitlisted", r1.ok && r2.ok && /waitlist/i.test(r2.message ?? ""), r2.message);
    const qa = await cAct.askQuestionAction({}, fd({ eventId: evRow.id, body: `${TAG} what is the roadmap for Q1?`, anonymous: true }));
    const qRow = await prisma.eventQuestion.findFirstOrThrow({ where: { eventId: evRow.id } });
    check("Harish asks a question anonymously", qa.ok && qRow.authorId === null, qa.message);
    await as("meera.krishnan");
    const vote = await cAct.voteQuestionAction({}, fd({ questionId: qRow.id }));
    check("Meera upvotes it", vote.ok && (await prisma.eventQuestion.findUniqueOrThrow({ where: { id: qRow.id } })).voterIds.includes(meera.id));
    await cAct.rsvpAction({}, fd({ eventId: evRow.id, response: "DECLINED" }));
    check("When Meera declines, Harish moves up from the waitlist", (await prisma.eventRsvp.findFirstOrThrow({ where: { eventId: evRow.id, employeeId: harish.id } })).response === "GOING");
    await as("priya.sharma");
    const ans = await cAct.answerQuestionAction({}, fd({ questionId: qRow.id, op: "answer", answer: "Shared in the deck." }));
    check("Communications answer the question", ans.ok && (await prisma.eventQuestion.findUniqueOrThrow({ where: { id: qRow.id } })).status === "ANSWERED", ans.message);
    const att = await cAct.markAttendanceAction({}, multi({ eventId: evRow.id, attended: [harish.id] }));
    check("Attendance is marked once it has started", att.ok && (await prisma.eventRsvp.findFirstOrThrow({ where: { eventId: evRow.id, employeeId: harish.id } })).attended === true, att.message);
    const evHtml = await html(EventPage({ params: id$(evRow.id) }));
    check("The event page shows the guest list and questions", evHtml.includes("Guest list") && evHtml.includes("roadmap"));
    for (const tab of ["calendar", "mine", "propose", "manage", "reports"]) check(`Events › ${tab} renders`, (await html(EventsPage({ searchParams: sp({ tab }) }))).length > 400);
    check("Export events", (await csv("report=events")).body.includes(`${TAG} Town hall`));
    check("Export event RSVPs", (await csv(`report=event-rsvps&id=${evRow.id}`)).body.includes("Yes"));
    const cancelEv = await cAct.eventOpAction({}, fd({ id: evRow.id, op: "cancel", reason: "Rescheduled" }));
    check("Communications can cancel an event", cancelEv.ok && (await prisma.companyEvent.findUniqueOrThrow({ where: { id: evRow.id } })).status === "CANCELLED", cancelEv.message);

    // -----------------------------------------------------------------------
    section("Audit and the nightly job");
    check("Every export is audited", (await prisma.auditLog.count({ where: { tenantId: t, action: "EXPORT", entityType: "Report", createdAt: { gte: startedAt } } })) >= 20);
    check("Approvals and changes are in the audit log", (await prisma.auditLog.count({ where: { tenantId: t, createdAt: { gte: startedAt }, entityType: { in: ["RecognitionProgram", "AwardNomination", "RewardRedemption", "ServiceRequest", "WellnessProgram", "SupportResource", "CompanyEvent", "Announcement", "SurveyAnswer", "CommunityPost"] } } })) >= 10);
    const job2 = await svc.runEngageJob(t);
    check("The engage job runs end to end", typeof job2.reminders === "number" && typeof job2.purgedSurveys === "number", JSON.stringify(job2));
  } finally {
    await cleanup();
  }
  report("engage-depth");

  async function cleanup() {
    const steps: Array<() => Promise<unknown>> = [
      async () => {
        const reqs = await prisma.workflowRequest.findMany({ where: { tenantId: t, entityType: { in: ENGAGE_TYPES }, createdAt: { gte: startedAt } }, select: { id: true } });
        await prisma.workflowRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
      },
      async () => {
        const surveys = await prisma.survey.findMany({ where: { tenantId: t, OR: [{ title: { startsWith: TAG } }, { scheduleId: { in: (await prisma.surveySchedule.findMany({ where: { tenantId: t, title: { startsWith: TAG } }, select: { id: true } })).map((s) => s.id) } }] }, select: { id: true } });
        await prisma.surveyActionPlan.deleteMany({ where: { tenantId: t, surveyId: { in: surveys.map((s) => s.id) } } });
        await prisma.survey.deleteMany({ where: { id: { in: surveys.map((s) => s.id) } } });
      },
      () => prisma.surveySchedule.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      () => prisma.surveyTemplate.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      async () => {
        const types = await prisma.awardType.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        await prisma.awardNomination.deleteMany({ where: { tenantId: t, awardTypeId: { in: types.map((x) => x.id) } } });
        await prisma.awardType.deleteMany({ where: { id: { in: types.map((x) => x.id) } } });
      },
      () => prisma.recognitionProgram.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.praiseBadge.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      async () => {
        const items = await prisma.rewardItem.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        await prisma.rewardRedemption.deleteMany({ where: { tenantId: t, itemId: { in: items.map((x) => x.id) } } });
        await prisma.rewardItem.deleteMany({ where: { id: { in: items.map((x) => x.id) } } });
      },
      () => prisma.rewardPointEntry.deleteMany({ where: { tenantId: t, createdAt: { gte: startedAt } } }),
      async () => {
        const praise = await prisma.praise.findMany({ where: { tenantId: t, message: { startsWith: TAG } }, select: { wallPostId: true } });
        await prisma.praise.deleteMany({ where: { tenantId: t, message: { startsWith: TAG } } });
        await prisma.wallPost.deleteMany({ where: { id: { in: praise.map((p) => p.wallPostId).filter((x): x is string => !!x) } } });
      },
      () => prisma.wellnessProgram.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      () => prisma.wellbeingCheckIn.deleteMany({ where: { tenantId: t, note: TAG } }),
      () => prisma.wellbeingCheckInMark.deleteMany({ where: { tenantId: t, employeeId: meera.id, createdAt: { gte: startedAt } } }),
      () => prisma.supportResource.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      async () => {
        const types = await prisma.serviceType.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true } });
        await prisma.serviceRequest.deleteMany({ where: { tenantId: t, typeId: { in: types.map((x) => x.id) } } });
        await prisma.serviceType.deleteMany({ where: { id: { in: types.map((x) => x.id) } } });
      },
      () => prisma.announcement.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      async () => {
        const chans = await prisma.communityChannel.findMany({ where: { tenantId: t, name: { startsWith: TAG } }, select: { id: true, posts: { select: { id: true } } } });
        await prisma.contentReport.deleteMany({ where: { tenantId: t, targetId: { in: chans.flatMap((c) => c.posts.map((p) => p.id)) } } });
        await prisma.communityChannel.deleteMany({ where: { id: { in: chans.map((c) => c.id) } } });
      },
      () => prisma.companyEvent.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      () => prisma.notification.deleteMany({ where: { tenantId: t, createdAt: { gte: startedAt }, kind: "ENGAGE" } }),
      async () => {
        if (settingsBefore) {
          const { id: _id, updatedAt: _u, ...rest } = settingsBefore;
          await prisma.engageSetting.update({ where: { tenantId: t }, data: rest });
        } else await prisma.engageSetting.deleteMany({ where: { tenantId: t } });
      },
    ];
    for (const s of steps) {
      try { await s(); } catch (err) { console.error("  cleanup step failed:", (err as Error).message); }
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
