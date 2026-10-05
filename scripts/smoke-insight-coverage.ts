/**
 * Coverage for existing performance and analytics flows that had no test:
 *
 *   OKR cycle templates   financial-year quarters and halves generated from
 *                         the company's FY start month, idempotently.
 *   Timeline              the historical performance timeline (reviews,
 *                         goals, plans) and its page.
 *   360 tracking          a peer nomination by the manager, pending and
 *                         received counts on the review and the campaign.
 *   Feedback audit        audit entries for feedback, the audit history
 *                         table, its export and who may see it.
 *   Performance audit     cycle changes in the performance audit history.
 *   PIP extension         extending an active plan by 30 days at the outcome.
 *   Diversity summary     the analytics summary's gender mix, the diversity
 *                         table, and who may open them.
 *
 * Everything created is removed afterwards.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import Module from "node:module";
import type { ReactElement, ReactNode } from "react";

{
  const internal = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = internal._load;
  const classes: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? undefined : k === "default" ? classes : typeof k === "string" ? k : undefined) });
  internal._load = function cssModules(this: unknown, request: string, parent: unknown, isMain: boolean) {
    return request.endsWith(".module.css") ? classes : prev.call(this, request, parent, isMain);
  };
}

const prisma = new PrismaClient();
type SP = Record<string, string>;
type Page = (props: { searchParams: Promise<SP>; params: Promise<Record<string, string>> }) => Promise<unknown>;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
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
  async function render(page: Page, url: string, params: Record<string, string> = {}): Promise<string> {
    const u = new URL(url, "http://acme.test");
    const sp: SP = Object.fromEntries(u.searchParams.entries());
    try {
      const tree = (await resolve(await page({ searchParams: Promise.resolve(sp), params: Promise.resolve(params) }))) as ReactNode;
      return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: u.pathname },
          React.createElement(SearchParamsContext.Provider, { value: u.searchParams as never }, tree))));
    } catch (err) {
      const e = err as { digest?: string; message?: string };
      const d = `${e.digest ?? ""} ${e.message ?? ""}`;
      const r = /NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(d);
      if (r) return `redirect:${r[1]}`;
      if (/HTTP_ERROR_FALLBACK;404/.test(d)) return "404";
      if (/HTTP_ERROR_FALLBACK;403/.test(d)) return "403";
      throw err;
    }
  }
  const ok = (h: string) => !/^(redirect:|404$|403$)/.test(h);
  /** An action guarded by requireAuth throws its 403 interrupt; report it as a refusal. */
  async function refused(fn: () => Promise<{ ok?: boolean }>): Promise<boolean> {
    try { return (await fn()).ok === false; } catch (err) { return /HTTP_ERROR_FALLBACK;403/.test(`${(err as { digest?: string }).digest ?? ""}`); }
  }

  const TP = await import("../apps/web/src/app/actions/talent-performance");
  const PF = await import("../apps/web/src/app/actions/performance");
  const FB = await import("../apps/web/src/app/actions/feedback");
  const IP = await import("../apps/web/src/app/actions/insight-performance");
  const { viewerForUser } = await import("../apps/web/src/lib/context");
  const { runDataset } = await import("../apps/web/src/lib/insight/datasets");
  const { performanceTimeline } = await import("../apps/web/src/lib/insight/timeline");
  const load = async (p: string) => (await import(`../apps/web/src/app/(app)/${p}/page`)).default as Page;
  const pages = { me: await load("me/insights"), review: await load("performance/reviews/[id]"), hub: await load("performance/feedback-hub"), summary: await load("analytics/summary"), people: await load("insights/people") };
  const insightExport = (await import("../apps/web/src/app/(app)/insights/export/route")).GET;
  const get = (url: string) => insightExport(new NextRequest(new URL(url, "http://acme.test")));

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const tenantId = tenant.id;
  const user = (email: string) => prisma.user.findFirstOrThrow({ where: { email, tenantId }, include: { employee: true } });
  const [admin, hr, meera, ananya, aditya] = await Promise.all([
    user("vikram.menon@acme.test"), user("priya.sharma@acme.test"), user("meera.krishnan@acme.test"), user("ananya.ghosh@acme.test"), user("aditya.verma@acme.test"),
  ]);
  const started = new Date();
  const tag = `IC${String(Date.now()).slice(-6)}`;
  const made = { timeframes: [] as string[], responses: [] as string[], feedback: [] as string[], pips: [] as string[] };
  const fyYear = 2040 + (Date.now() % 50);
  const pipSetting = await prisma.insightPipSetting.findUnique({ where: { tenantId } });
  let midTypes: { id: string; reviewerTypes: unknown } | null = null;
  if (pipSetting) await prisma.insightPipSetting.delete({ where: { tenantId } });

  console.log("\nInsight coverage\n" + "=".repeat(72));
  try {
    // =========================================================================
    section("OKR cycle templates: financial-year quarters");
    await signInAs(meera.email);
    check("An employee cannot generate timeframes", await refused(() => TP.generateTimeframesAction({}, fd({ kind: "QUARTER", fy: fyYear }))));
    await signInAs(admin.email);
    check("A year outside 2000–2100 is refused", (await TP.generateTimeframesAction({}, fd({ kind: "QUARTER", fy: 1990 }))).ok === false);
    const q = await TP.generateTimeframesAction({}, fd({ kind: "QUARTER", fy: fyYear }));
    const quarters = await prisma.goalTimeframe.findMany({ where: { tenantId, kind: "QUARTER", startDate: { gte: new Date(Date.UTC(fyYear, 0, 1)), lt: new Date(Date.UTC(fyYear + 1, 12, 1)) } }, orderBy: { startDate: "asc" } });
    made.timeframes.push(...quarters.map((x) => x.id));
    check("Four quarters are generated", q.ok === true && quarters.length === 4, q.message);
    const fm = tenant.fyStartMonth;
    check("Q1 starts on the company's financial-year start month", quarters[0]!.startDate.getUTCMonth() === fm - 1 && quarters[0]!.startDate.getUTCFullYear() === fyYear);
    check("Quarters are contiguous", quarters.every((x, i) => i === 0 || x.startDate.getTime() - quarters[i - 1]!.endDate.getTime() <= 86_400_000));
    const again = await TP.generateTimeframesAction({}, fd({ kind: "QUARTER", fy: fyYear }));
    check("Generating again adds nothing", again.ok === true && (await prisma.goalTimeframe.count({ where: { id: { in: made.timeframes } } })) === 4 && /already exist/.test(again.message ?? ""));
    const h = await TP.generateTimeframesAction({}, fd({ kind: "HALF_YEAR", fy: fyYear }));
    const halves = await prisma.goalTimeframe.findMany({ where: { tenantId, kind: "HALF_YEAR", startDate: { gte: new Date(Date.UTC(fyYear, 0, 1)), lt: new Date(Date.UTC(fyYear + 1, 12, 1)) } } });
    made.timeframes.push(...halves.map((x) => x.id));
    check("Two halves are generated", h.ok === true && halves.length === 2);
    check("Generation is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "GoalTimeframe", createdAt: { gte: started } } })) >= 3);

    // =========================================================================
    section("Historical performance timeline");
    const events = await performanceTimeline(tenantId, meera.employee!.id);
    check("The timeline lists Meera's past reviews", events.some((e) => /Annual review 2025-26/.test(e.title)) && events.some((e) => /Annual review 2024-25/.test(e.title)));
    check("The timeline runs newest first", events.every((e, i) => i === 0 || events[i - 1]!.at.getTime() >= e.at.getTime()));
    await signInAs(meera.email);
    const mine = await render(pages.me, "/me/insights");
    check("Meera's personal analytics show the timeline", ok(mine) && mine.includes("Annual review 2025-26"));

    // =========================================================================
    section("360 response tracking");
    const mid = await prisma.reviewCycle.findFirstOrThrow({ where: { tenantId, name: "Mid-year 2026-27" } });
    const review = await prisma.employeeReview.findFirstOrThrow({ where: { cycleId: mid.id, employeeId: meera.employee!.id } });
    // The seeded mid-year cycle collects self and manager reviews only; add peers for this run.
    midTypes = { id: mid.id, reviewerTypes: mid.reviewerTypes };
    await prisma.reviewCycle.update({ where: { id: mid.id }, data: { reviewerTypes: [{ type: "SELF", weight: 20 }, { type: "MANAGER", weight: 60 }, { type: "PEER", weight: 20 }] } });
    await signInAs(ananya.email);
    const nom = await PF.nominatePeersAction({}, fd({ reviewId: review.id, peerIds: aditya.employee!.id }));
    const slot = await prisma.reviewResponse.findFirst({ where: { reviewId: review.id, reviewerId: aditya.employee!.id, reviewerType: "PEER" } });
    if (slot) made.responses.push(slot.id);
    check("The manager asks a peer for 360 feedback", nom.ok === true && slot?.status === "ACTIVE", nom.message);
    await signInAs(admin.email);
    const pending = await render(pages.review, `/performance/reviews/${review.id}`, { id: review.id });
    check("The review shows the feedback still to come", ok(pending) && pending.includes("1 still to come"));
    const adminV = (await viewerForUser(admin.id))!;
    const camp = (await runDataset(adminV, "campaigns"))?.rows.find((r) => r.id === mid.id);
    check("The campaign counts the open request", !!camp && Number(camp.slots) >= 1 && Number(camp.submitted) === 0);
    check("The campaign's tracking table shows it pending", (await render(pages.hub, `/performance/feedback-hub?tab=campaigns&cycleId=${mid.id}`)).includes("Aditya Verma"));
    await signInAs(aditya.email);
    const sub = await PF.submitReviewAction({}, fd({ reviewId: review.id, reviewerType: "PEER", overallRating: 4, strengths: `${tag} Clear communicator`, improvements: "Delegate more" }));
    check("The peer submits their feedback", sub.ok === true, sub.message);
    await signInAs(admin.email);
    const camp2 = (await runDataset(adminV, "campaigns"))?.rows.find((r) => r.id === mid.id);
    check("The campaign's response rate moves", !!camp2 && Number(camp2.submitted) >= 1 && Number(camp2.rate) > 0);
    check("The review shows it received", (await render(pages.review, `/performance/reviews/${review.id}`, { id: review.id })).includes("1 received"));

    // =========================================================================
    section("Feedback audit history");
    await signInAs(meera.email);
    const give = await FB.giveFeedbackAction({}, fd({ aboutEmployeeId: ananya.employee!.id, kind: "FEEDBACK", message: `${tag} Thanks for unblocking the release review so quickly.` }));
    const fb = await prisma.feedback.findFirst({ where: { tenantId, message: { startsWith: tag } } });
    if (fb) made.feedback.push(fb.id);
    check("Feedback is given", give.ok === true && !!fb, give.message);
    check("Giving feedback is audited", (await prisma.auditLog.count({ where: { tenantId, entityType: "Feedback", entityId: fb?.id } })) === 1);
    await signInAs(admin.email);
    const fa = await runDataset(adminV, "feedback-audit");
    check("The feedback audit history lists it", (fa?.rows ?? []).some((r) => String(r.summary ?? "").includes("Ananya")));
    check("Only feedback records are in it", (fa?.rows ?? []).every((r) => ["Feedback", "FeedbackRequest", "FeedbackTemplate", "FeedbackSetting", "InsightFeedbackTopic", "InsightFeedbackRule", "InsightFeedbackEscalation", "InsightFeedbackFollowUp"].includes(String(r.entity))));
    const csv = await get("/insights/export?ds=feedback-audit&format=csv");
    check("The audit history exports", csv.status === 200);
    check("The export itself is audited", (await prisma.auditLog.count({ where: { tenantId, action: "EXPORT", entityId: "feedback-audit", createdAt: { gte: started } } })) === 1);
    check("The audit tab renders", ok(await render(pages.hub, "/performance/feedback-hub?tab=audit")));
    await signInAs(meera.email);
    check("An employee cannot read the feedback audit", (await get("/insights/export?ds=feedback-audit&format=csv")).status === 403);

    section("Performance audit history");
    await signInAs(admin.email);
    check("A cycle setting change is saved", (await IP.updateCycleSettingsAction({}, fd({ cycleId: mid.id, name: mid.name, maxPeers: mid.maxPeers, reviewClosesAt: mid.reviewClosesAt?.toISOString().slice(0, 10) ?? "" }))).ok === true);
    const pa = await runDataset(adminV, "perf-audit");
    check("The performance audit history lists it", (pa?.rows ?? []).some((r) => r.entity === "ReviewCycle" && String(r.summary ?? "").includes(mid.name)));
    check("The performance audit history exports to Excel", (await get("/insights/export?ds=perf-audit&format=xlsx")).status === 200);

    // =========================================================================
    section("PIP extension");
    await signInAs(hr.email);
    const sp = await PF.createPipAction({}, fd({ employeeId: aditya.employee!.id, reason: `${tag} Missed delivery commitments`, objectives: "Ship on time", startDate: day(-20), endDate: day(40) }));
    const pip = await prisma.improvementPlan.findFirst({ where: { tenantId, reason: `${tag} Missed delivery commitments` } });
    if (pip) made.pips.push(pip.id);
    check("A plan is started", sp.ok === true && !!pip, sp.message);
    check("A second active plan is refused", (await PF.createPipAction({}, fd({ employeeId: aditya.employee!.id, reason: "Again", objectives: "x", startDate: day(-20), endDate: day(40) }))).ok === false);
    const ext = await PF.closePipAction({}, fd({ id: pip!.id, outcome: "EXTENDED", note: "More time to show the change" }));
    const after = await prisma.improvementPlan.findUniqueOrThrow({ where: { id: pip!.id } });
    check("Extending adds 30 days and keeps it active", ext.ok === true && after.status === "ACTIVE" && after.endDate.getTime() === pip!.endDate.getTime() + 30 * 86_400_000, ext.message);
    check("The extension is recorded", after.outcomeNote === "More time to show the change" && (await prisma.auditLog.count({ where: { tenantId, entityType: "ImprovementPlan", entityId: pip!.id, summary: { contains: "extended" } } })) === 1);
    check("An extension needs a note", (await PF.closePipAction({}, fd({ id: pip!.id, outcome: "EXTENDED", note: "" }))).ok === false);

    // =========================================================================
    section("Diversity summary");
    await signInAs(hr.email);
    const summary = await render(pages.summary, "/analytics/summary");
    check("The analytics summary shows the gender mix by department", ok(summary) && summary.includes("Gender mix by department"));
    const div = await runDataset((await viewerForUser(hr.id))!, "people:diversity");
    check("The diversity table has rows", (div?.rows.length ?? 0) > 0);
    check("The diversity tab renders", ok(await render(pages.people, "/insights/people?tab=diversity")));
    check("The diversity table downloads as PDF", (await get("/insights/export?ds=people:diversity&format=pdf")).status === 200);
    await signInAs(meera.email);
    check("An employee cannot open the summary", (await render(pages.summary, "/analytics/summary")) === "403");
  } finally {
    if (midTypes) await prisma.reviewCycle.update({ where: { id: midTypes.id }, data: { reviewerTypes: midTypes.reviewerTypes as never } });
    await prisma.goalTimeframe.deleteMany({ where: { id: { in: made.timeframes } } });
    await prisma.reviewResponse.deleteMany({ where: { id: { in: made.responses } } });
    await prisma.feedback.deleteMany({ where: { id: { in: made.feedback } } });
    await prisma.insightFeedbackEscalation.deleteMany({ where: { feedbackId: { in: made.feedback } } });
    await prisma.improvementPlan.deleteMany({ where: { id: { in: made.pips } } });
    await prisma.insightReportRun.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    if (pipSetting) await prisma.insightPipSetting.create({ data: pipSetting });
    await prisma.notification.deleteMany({ where: { tenantId, createdAt: { gte: started } } });
    await prisma.$disconnect();
  }
  report("Insight coverage");
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
