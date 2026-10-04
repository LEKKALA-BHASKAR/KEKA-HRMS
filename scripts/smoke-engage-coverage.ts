/**
 * Coverage for the engagement flows that predate the engage-depth work,
 * through their actions and pages:
 *   1. Announcements (the quick publish form): publish, view, acknowledge,
 *      archive; who may publish.
 *   2. The wall: posts, likes, comments, deletion by author and moderator,
 *      reporting a wall post and the moderation decision.
 *   3. Polls: wall polls (vote, change vote, expiry rules) and survey polls,
 *      including approval before launch.
 *   4. Praise: public praise on the wall, private praise, points.
 *   5. Awards: granting, and paying a cash award through the open payroll run.
 *   6. The awards, announcements and home pages render; exports include it all.
 *
 * Everything it creates is tagged "Smoke EC" and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86_400_000;
const TAG = "Smoke EC";

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
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

  const work = await import("../apps/web/src/app/actions/workplace");
  const wall = await import("../apps/web/src/app/actions/home-wall");
  const eng = await import("../apps/web/src/app/actions/engage");
  const sAct = await import("../apps/web/src/app/actions/engage-surveys");
  const cAct = await import("../apps/web/src/app/actions/engage-comms");
  const wfAct = await import("../apps/web/src/app/actions/workflows");
  const svc = await import("@keka/services");
  const AwardsPage = (await import("../apps/web/src/app/(app)/awards/page")).default;
  const AnnouncementsPage = (await import("../apps/web/src/app/(app)/announcements/page")).default;
  const exportRoute = await import("../apps/web/src/app/(app)/engage/export/route");
  const { NextRequest } = await import("next/server");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const t = tenant.id;
  const emp = (email: string) => prisma.employee.findFirstOrThrow({ where: { tenantId: t, user: { email } } });
  const meera = await emp("meera.krishnan@acme.test");
  const harish = await emp("harish.prasad@acme.test");
  const settingsBefore = await prisma.engageSetting.findUnique({ where: { tenantId: t } });
  const startedAt = new Date();
  const as = (who: string) => signInAs(`${who}@acme.test`);
  const csv = async (q: string) => { const r = await exportRoute.GET(new NextRequest(`http://acme.localhost/engage/export?${q}`)); return { status: r.status, body: await r.text() }; };
  const tomorrow = new Date(Date.now() + 330 * 60_000 + DAY).toISOString().slice(0, 10);
  let payRunId: string | null = null;

  console.log("\nEngagement coverage: announcements, wall, polls, praise, awards\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Announcements (quick publish)");
    await as("meera.krishnan");
    check("An employee cannot publish", await throws(() => work.publishAnnouncement(fd({ title: `${TAG} x`, body: "y" }))));
    await as("priya.sharma");
    check("A title and body are required", await throws(() => work.publishAnnouncement(fd({ title: "", body: "" }))));
    await work.publishAnnouncement(fd({ title: `${TAG} Office closed Friday`, body: "For the festival.", requireAck: true, isPinned: true }));
    const a = await prisma.announcement.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} Office closed Friday` } });
    check("HR publishes an announcement that needs acknowledgement", a.status === "PUBLISHED" && a.requireAck && a.isPinned);
    check("…recorded in the audit log", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "Announcement", entityId: a.id, action: "CREATE" } })) === 1);
    await as("meera.krishnan");
    await work.markAnnouncementViewed(a.id);
    const viewed = await prisma.announcementRead.findFirst({ where: { announcementId: a.id, employeeId: meera.id } });
    check("Viewing records a read without acknowledging", !!viewed && viewed.acknowledgedAt === null);
    const live = await html(AnnouncementsPage({ searchParams: sp() }));
    check("Meera sees it with the acknowledgement button", live.includes(`${TAG} Office closed Friday`) && live.includes("I have read and understood this"));
    await work.acknowledgeAnnouncement(fd({ announcementId: a.id }));
    check("…and acknowledges it", !!(await prisma.announcementRead.findFirstOrThrow({ where: { announcementId: a.id, employeeId: meera.id } })).acknowledgedAt);
    check("…after which the page shows it acknowledged", (await html(AnnouncementsPage({ searchParams: sp() }))).includes("Acknowledged"));
    await wall.toggleLikeAction({}, fd({ target: "announcement", id: a.id }));
    check("Employees can like an announcement", (await prisma.wallLike.count({ where: { announcementId: a.id, employeeId: meera.id } })) === 1);
    await as("priya.sharma");
    await work.archiveAnnouncement(fd({ id: a.id }));
    check("HR archives it", (await prisma.announcement.findUniqueOrThrow({ where: { id: a.id } })).status === "ARCHIVED");
    await as("meera.krishnan");
    check("…and it leaves the live list", !(await html(AnnouncementsPage({ searchParams: sp() }))).includes(`${TAG} Office closed Friday`));

    // -----------------------------------------------------------------------
    section("The wall: posts, likes, comments, moderation");
    const empty = await wall.createPostAction({}, fd({ body: "" }));
    check("An empty post is refused", empty.ok === false && !!empty.errors?.body);
    const notMyGroup = await wall.createPostAction({}, fd({ body: `${TAG} hello`, audience: "some-other-group" }));
    check("Posting to another group is refused", notMyGroup.ok === false && !!notMyGroup.errors?.audience);
    const posted = await wall.createPostAction({}, fd({ body: `${TAG} shipped the new onboarding flow today` }));
    const post = await prisma.wallPost.findFirstOrThrow({ where: { tenantId: t, body: { startsWith: `${TAG} shipped` } } });
    check("Meera posts to the organisation", posted.ok && post.kind === "POST" && post.departmentId === null, posted.message);
    await as("harish.prasad");
    const liked = await wall.toggleLikeAction({}, fd({ target: "post", id: post.id }));
    check("Harish likes it", liked.ok && (await prisma.wallLike.count({ where: { postId: post.id } })) === 1, liked.message);
    await wall.toggleLikeAction({}, fd({ target: "post", id: post.id }));
    check("…and unlikes it", (await prisma.wallLike.count({ where: { postId: post.id } })) === 0);
    const cm = await wall.addCommentAction({}, fd({ target: "post", id: post.id, body: `${TAG} congrats!` }));
    const comment = await prisma.wallComment.findFirstOrThrow({ where: { postId: post.id } });
    check("…and comments", cm.ok, cm.message);
    await as("meera.krishnan");
    check("Others cannot delete his comment", (await wall.deleteCommentAction({}, fd({ commentId: comment.id }))).ok === false);
    await as("harish.prasad");
    check("…but he can", (await wall.deleteCommentAction({}, fd({ commentId: comment.id }))).ok && !!(await prisma.wallComment.findUniqueOrThrow({ where: { id: comment.id } })).deletedAt);
    check("Harish cannot delete Meera's post", (await wall.deletePostAction({}, fd({ postId: post.id }))).ok === false);
    const rep = await cAct.reportContentAction({}, fd({ targetType: "WALL_POST", targetId: post.id, reason: `${TAG} off-topic` }));
    check("…but can report it for moderation", rep.ok, rep.message);
    await as("priya.sharma");
    const r = await prisma.contentReport.findFirstOrThrow({ where: { tenantId: t, targetType: "WALL_POST", targetId: post.id } });
    const kept = await cAct.decideReportAction({}, fd({ id: r.id, decision: "dismiss" }));
    check("Communications dismiss it; the post stays", kept.ok && !(await prisma.wallPost.findUniqueOrThrow({ where: { id: post.id } })).deletedAt, kept.message);
    await as("meera.krishnan");
    const gone = await wall.deletePostAction({}, fd({ postId: post.id }));
    check("The author deletes her post", gone.ok && !!(await prisma.wallPost.findUniqueOrThrow({ where: { id: post.id } })).deletedAt, gone.message);
    await wall.createPostAction({}, fd({ body: `${TAG} second post` }));
    const p2 = await prisma.wallPost.findFirstOrThrow({ where: { tenantId: t, body: `${TAG} second post` } });
    await as("vikram.menon");
    check("A wall moderator can remove anyone's post", (await wall.deletePostAction({}, fd({ postId: p2.id }))).ok);

    // -----------------------------------------------------------------------
    section("Polls");
    await as("meera.krishnan");
    const oneOpt = await wall.createPollAction({}, multi({ question: `${TAG} lunch?`, expiresOn: tomorrow, option: ["Pizza"] }));
    check("A wall poll needs at least two options", oneOpt.ok === false && !!oneOpt.errors?.option);
    const past = await wall.createPollAction({}, multi({ question: `${TAG} lunch?`, expiresOn: "2020-01-01", option: ["Pizza", "Thali"] }));
    check("…and an expiry from tomorrow", past.ok === false && !!past.errors?.expiresOn);
    const poll = await wall.createPollAction({}, multi({ question: `${TAG} team lunch: pizza or thali?`, expiresOn: tomorrow, option: ["Pizza", "Thali"], anonymous: true }));
    const pollPost = await prisma.wallPost.findFirstOrThrow({ where: { tenantId: t, kind: "POLL", body: { startsWith: `${TAG} team lunch` } }, include: { pollOptions: { orderBy: { position: "asc" } } } });
    check("Meera runs an anonymous wall poll", poll.ok && pollPost.pollAnonymous && pollPost.pollOptions.length === 2, poll.message);
    await as("harish.prasad");
    check("A vote for a foreign option is refused", (await wall.votePollAction({}, fd({ postId: pollPost.id, optionId: "nope" }))).ok === false);
    await wall.votePollAction({}, fd({ postId: pollPost.id, optionId: pollPost.pollOptions[0].id }));
    const changed = await wall.votePollAction({}, fd({ postId: pollPost.id, optionId: pollPost.pollOptions[1].id }));
    const votes = await prisma.wallPollVote.findMany({ where: { postId: pollPost.id } });
    check("Harish votes, then changes his vote (one vote each)", changed.ok && votes.length === 1 && votes[0].optionId === pollPost.pollOptions[1].id);
    await prisma.wallPost.update({ where: { id: pollPost.id }, data: { pollExpiresAt: new Date(Date.now() - 60_000) } });
    check("An expired poll takes no more votes", (await wall.votePollAction({}, fd({ postId: pollPost.id, optionId: pollPost.pollOptions[0].id }))).ok === false);

    await as("priya.sharma");
    await sAct.saveEngageSettingsAction({}, fd({ scope: "surveys", surveyApproval: true, surveyRetentionDays: 0 }));
    const sp1 = await eng.createSurveyAction({}, fd({ title: `${TAG} offsite poll`, kind: "POLL", pollQuestion: "Where should the offsite be?", pollOptions: "Goa\nCoorg\nOoty" }));
    const sPoll = await prisma.survey.findFirstOrThrow({ where: { tenantId: t, title: `${TAG} offsite poll` }, include: { questions: true } });
    check("HR drafts a survey poll", sp1.ok && sPoll.kind === "POLL" && sPoll.questions[0].options.length === 3, sp1.message);
    check("With approval on it cannot launch directly", (await eng.surveyOpAction({}, fd({ surveyId: sPoll.id, op: "launch" }))).ok === false);
    await eng.surveyOpAction({}, fd({ surveyId: sPoll.id, op: "submit" }));
    const reqId = (await prisma.survey.findUniqueOrThrow({ where: { id: sPoll.id } })).workflowRequestId!;
    const tk = await prisma.workflowTask.findFirstOrThrow({ where: { requestId: reqId, status: "PENDING" } });
    const approver = await prisma.user.findUniqueOrThrow({ where: { id: tk.approverUserId } });
    await signInAs(approver.email);
    await wfAct.decideWorkflowTaskAction({}, fd({ taskId: tk.id, decision: "approve" }));
    check("Approved in the inbox, the poll goes live", (await prisma.survey.findUniqueOrThrow({ where: { id: sPoll.id } })).status === "ACTIVE");
    for (const [who, choice] of [["meera.krishnan", "1"], ["harish.prasad", "1"], ["aditya.verma", "0"]] as const) {
      await as(who);
      await eng.submitSurveyAction({}, fd({ surveyId: sPoll.id, [`q_${sPoll.questions[0].id}`]: choice }));
    }
    const { surveyResults } = await import("../apps/web/src/lib/survey-results");
    const pr = await surveyResults(t, sPoll.id);
    const tally = pr?.perQuestion[0].choices;
    check("Three votes are tallied (Coorg 2, Goa 1)", pr?.respondents === 3 && tally?.find((c) => c.label === "Coorg")?.count === 2 && tally?.find((c) => c.label === "Goa")?.count === 1, JSON.stringify(tally));
    await as("priya.sharma");
    check("HR closes the poll", (await eng.surveyOpAction({}, fd({ surveyId: sPoll.id, op: "close" }))).ok);
    const pollCsv = await csv("report=polls");
    check("The polls export lists both kinds of poll", pollCsv.status === 200 && pollCsv.body.includes("team lunch") && pollCsv.body.includes("offsite"));

    // -----------------------------------------------------------------------
    section("Praise and points");
    await as("meera.krishnan");
    check("Nobody praises themselves", (await wall.givePraisePostAction({}, multi({ message: `${TAG} me`, toEmployeeId: [meera.id] }))).ok === false);
    const before = await svc.pointsBalanceOf(t, harish.id);
    const badge = await prisma.praiseBadge.findFirst({ where: { tenantId: t, isActive: true } });
    const pub = await wall.givePraisePostAction({}, multi({ message: `${TAG} thanks for unblocking the release`, toEmployeeId: [harish.id], badgeId: badge?.id ?? "" }));
    const pubRow = await prisma.praise.findFirstOrThrow({ where: { tenantId: t, message: { startsWith: `${TAG} thanks for unblocking` } } });
    check("Public praise goes on the wall with its badge", pub.ok && !!pubRow.wallPostId && pubRow.isPublic && (badge ? pubRow.badgeId === badge.id : true), pub.message);
    await work.givePraise(fd({ toEmployeeId: harish.id, message: `${TAG} quiet thanks for the review`, private: true }));
    const priv = await prisma.praise.findFirstOrThrow({ where: { tenantId: t, message: `${TAG} quiet thanks for the review` } });
    check("Private praise is not posted to the wall", priv.wallPostId === null && priv.isPublic === false);
    const per = (await svc.engageSettings(t)).pointsPerPraise;
    check("Each praise earns the recipient points", (await svc.pointsBalanceOf(t, harish.id)) - before === 2 * per);
    check("Praise is audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "Praise", entityId: priv.id } })) === 1);
    check("The praise export includes it", (await (async () => { await as("priya.sharma"); return csv("report=praise"); })()).body.includes("unblocking the release"));

    // -----------------------------------------------------------------------
    section("Awards and payroll payout");
    await as("priya.sharma");
    const type = await prisma.awardType.create({ data: { tenantId: t, name: `${TAG} Spot`, cadence: "SPOT", cashAmount: 2500, points: 25 } });
    await as("meera.krishnan");
    check("An employee cannot grant awards", await throws(() => work.grantAward(fd({ awardTypeId: type.id, employeeId: harish.id }))));
    await as("priya.sharma");
    const pb = await svc.pointsBalanceOf(t, harish.id);
    await work.grantAward(fd({ awardTypeId: type.id, employeeId: harish.id, period: "2026-09", citation: `${TAG} release hero` }));
    const award = await prisma.employeeAward.findFirstOrThrow({ where: { tenantId: t, awardTypeId: type.id } });
    check("HR grants a cash award", Number(award.cashAmount) === 2500 && award.period === "2026-09");
    check("…crediting its points", (await svc.pointsBalanceOf(t, harish.id)) - pb === 25);
    check("…audited", (await prisma.auditLog.count({ where: { tenantId: t, entityType: "EmployeeAward", entityId: award.id } })) >= 1);
    check("HR cannot push it to payroll (payroll permission)", await throws(() => work.payAwardThroughPayroll(fd({ awardId: award.id }))));
    await as("ramesh.iyer");
    const run = await prisma.payrollRun.findFirst({ where: { tenantId: t, payGroupId: harish.payGroupId ?? "-", status: { in: ["DRAFT", "IN_PROGRESS"] } } });
    if (run && harish.payGroupId) {
      payRunId = run.id;
      await work.payAwardThroughPayroll(fd({ awardId: award.id }));
      const adhoc = await prisma.adhocTransaction.findFirst({ where: { employeeId: harish.id, runId: run.id, name: `${TAG} Spot award` } });
      check("Payroll pushes the cash into the open run as an ad-hoc payment", !!adhoc && Number(adhoc.amount) === 2500 && (await prisma.employeeAward.findUniqueOrThrow({ where: { id: award.id } })).paidInRunId === run.id);
      check("…only once", await throws(() => work.payAwardThroughPayroll(fd({ awardId: award.id }))));
    } else check("An open payroll run exists for the payout test", false, "no open run in the seed");
    await as("priya.sharma");
    const awardsHtml = await html(AwardsPage());
    check("The awards page lists it", awardsHtml.includes(`${TAG} Spot`));
    const awardsCsv = await csv("report=awards");
    check("The awards export shows it as paid", awardsCsv.body.includes(`${TAG} Spot`));
    const feedCsv = await csv("report=feed");
    check("The news-feed export lists wall activity", feedCsv.status === 200 && feedCsv.body.includes("team lunch"));
  } finally {
    await cleanup();
  }
  report("engage-coverage");

  async function cleanup() {
    const steps: Array<() => Promise<unknown>> = [
      async () => {
        const reqs = await prisma.workflowRequest.findMany({ where: { tenantId: t, entityType: "SURVEY_PUBLISH", createdAt: { gte: startedAt } }, select: { id: true } });
        await prisma.workflowRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } });
      },
      () => prisma.survey.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      () => prisma.announcement.deleteMany({ where: { tenantId: t, title: { startsWith: TAG } } }),
      async () => {
        const posts = await prisma.wallPost.findMany({ where: { tenantId: t, body: { startsWith: TAG } }, select: { id: true } });
        await prisma.contentReport.deleteMany({ where: { tenantId: t, targetId: { in: posts.map((p) => p.id) } } });
        await prisma.praise.deleteMany({ where: { tenantId: t, message: { startsWith: TAG } } });
        await prisma.wallPost.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } });
      },
      async () => {
        await prisma.adhocTransaction.deleteMany({ where: { employeeId: harish.id, name: `${TAG} Spot award` } });
        if (payRunId) await (await import("@keka/services")).calculateRun(payRunId);
      },
      () => prisma.awardType.deleteMany({ where: { tenantId: t, name: { startsWith: TAG } } }),
      () => prisma.rewardPointEntry.deleteMany({ where: { tenantId: t, createdAt: { gte: startedAt } } }),
      () => prisma.notification.deleteMany({ where: { tenantId: t, createdAt: { gte: startedAt }, kind: { in: ["ENGAGE", "WALL"] } } }),
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
