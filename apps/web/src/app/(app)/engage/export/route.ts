import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import {
  safeCsv, govAudit, heatmap, recognitionFairness, wellbeingSummary, reachStats, announcementAudience, engageSettings, programPointsUsed, programCashUsed,
} from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { surveyResults } from "@/lib/survey-results";

type Sheet = { name: string; head: string[]; rows: Array<Array<string | number | null>> };
type Ctx = { tenantId: string; q: URLSearchParams };
const P = PERMISSIONS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "");
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

async function people(tenantId: string) {
  const rows = await prisma.employee.findMany({ where: { tenantId }, select: { id: true, displayName: true, employeeNumber: true, departmentId: true, department: { select: { name: true } } } });
  const m = new Map(rows.map((r) => [r.id, r]));
  return { name: (id: string | null | undefined) => (id ? m.get(id)?.displayName ?? "" : ""), number: (id: string | null | undefined) => (id ? m.get(id)?.employeeNumber ?? "" : ""), dept: (id: string | null | undefined) => (id ? m.get(id)?.department?.name ?? "" : ""), rows };
}

/** Each report: who may download it and how it is built. Every query is scoped to the viewer's tenant; survey exports keep the anonymity rule. */
const REPORTS: Record<string, { perm: Permission | Permission[]; build: (c: Ctx) => Promise<Sheet | null> }> = {
  surveys: { perm: [P.SURVEY_MANAGE, P.SURVEY_RESULTS], build: async ({ tenantId }) => {
    const rows = await prisma.survey.findMany({ where: { tenantId, kind: { not: "EXIT" } }, orderBy: { createdAt: "desc" }, include: { _count: { select: { participants: true, questions: true } } } });
    return { name: "surveys", head: ["Title", "Type", "Status", "Approval", "Anonymous", "Questions", "Responses", "Launched", "Closed", "Archived"],
      rows: rows.map((s) => [s.title, s.kind, s.status, s.approvalStatus ?? "", s.isAnonymous ? "Yes" : "No", s._count.questions, s._count.participants, iso(s.launchedAt), iso(s.closedAt), iso(s.archivedAt)]) };
  } },
  "survey-results": { perm: [P.SURVEY_MANAGE, P.SURVEY_RESULTS], build: async ({ tenantId, q }) => {
    const r = await surveyResults(tenantId, q.get("id") ?? "");
    if (!r || r.survey.kind === "EXIT") return null;
    const rows: Sheet["rows"] = [];
    if (!r.revealed) rows.push(["(withheld)", "", "", `Fewer than ${r.minGroupSize} responses`, "", ""]);
    else for (const x of r.perQuestion) {
      if (x.rating) rows.push([x.prompt, x.type, x.driver ?? "", x.answered, `${x.rating.favourable}% favourable`, `avg ${x.rating.mean}`]);
      else if (x.nps) rows.push([x.prompt, x.type, "", x.answered, `eNPS ${x.nps.score}`, `${x.nps.promoters}/${x.nps.passives}/${x.nps.detractors}`]);
      else if (x.choices) for (const c of x.choices) rows.push([x.prompt, x.type, "", x.answered, c.label, `${c.count} (${c.percent}%)`]);
      else if (x.comments) for (const c of x.comments) rows.push([x.prompt, x.type, "", x.answered, "comment", c]);
    }
    return { name: `survey-results-${r.survey.title.replace(/\W+/g, "-").toLowerCase()}`, head: ["Question", "Type", "Driver", "Answers", "Result", "Detail"], rows };
  } },
  "survey-heatmap": { perm: [P.SURVEY_MANAGE, P.SURVEY_RESULTS], build: async ({ tenantId, q }) => {
    const s = await prisma.survey.findFirst({ where: { id: q.get("id") ?? "", tenantId, kind: { not: "EXIT" } }, include: { questions: true, responses: { include: { answers: true } } } });
    if (!s) return null;
    const by = q.get("by") === "location" ? "location" : "department";
    const names = new Map((by === "location" ? await prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true } }) : await prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const driver = new Map(s.questions.filter((x) => x.type === "RATING").map((x) => [x.id, x.driver]));
    const h = heatmap(s.responses.map((r) => ({ group: names.get((by === "location" ? r.locationId : r.departmentId) ?? "") ?? "Unassigned", answers: r.answers.filter((a) => driver.has(a.questionId)).map((a) => ({ driver: driver.get(a.questionId) ?? null, score: a.score })) })), s.minGroupSize);
    return { name: `survey-heatmap-${by}`, head: [by === "location" ? "Location" : "Department", "Responses", "Overall", ...h.drivers],
      rows: h.rows.map((r) => [r.group, r.respondents, r.hidden ? "withheld" : r.overall ?? "", ...r.cells.map((c) => (r.hidden ? "withheld" : c ?? ""))]) };
  } },
  "action-plans": { perm: [P.SURVEY_MANAGE, P.SURVEY_RESULTS], build: async ({ tenantId }) => {
    const rows = await prisma.surveyActionPlan.findMany({ where: { tenantId }, orderBy: { dueOn: "asc" } });
    const pp = await people(tenantId);
    const titles = new Map((await prisma.survey.findMany({ where: { tenantId, id: { in: rows.map((r) => r.surveyId) } }, select: { id: true, title: true } })).map((s) => [s.id, s.title]));
    return { name: "survey-action-plans", head: ["Survey", "Driver", "Action", "Owner", "Due", "Status", "Progress", "Completed"],
      rows: rows.map((r) => [titles.get(r.surveyId) ?? "", r.driver ?? "", r.title, pp.name(r.ownerEmployeeId), dateOnly(r.dueOn), r.status, r.progressNote ?? "", iso(r.completedAt)]) };
  } },
  awards: { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.employeeAward.findMany({ where: { tenantId }, orderBy: { awardedOn: "desc" }, include: { awardType: { select: { name: true, cadence: true } } } });
    const pp = await people(tenantId);
    const programs = new Map((await prisma.recognitionProgram.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    return { name: "awards", head: ["Awarded", "Award", "Cadence", "Employee", "Number", "Department", "Programme", "Points", "Cash", "Paid in payroll", "Revoked", "Citation"],
      rows: rows.map((a) => [dateOnly(a.awardedOn), a.awardType.name, a.awardType.cadence, pp.name(a.employeeId), pp.number(a.employeeId), pp.dept(a.employeeId), a.programId ? programs.get(a.programId) ?? "" : "", a.points ?? "", a.cashAmount === null ? "" : Number(a.cashAmount), a.paidInRunId ? "Yes" : "", a.revokedAt ? `${dateOnly(a.revokedAt)} ${a.revokeReason ?? ""}` : "", a.citation ?? ""]) };
  } },
  nominations: { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.awardNomination.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    const pp = await people(tenantId);
    const types = new Map((await prisma.awardType.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return { name: "award-nominations", head: ["Nominated", "Award", "Nominee", "Nominated by", "Status", "Decided", "Citation"],
      rows: rows.map((n) => [iso(n.createdAt), types.get(n.awardTypeId) ?? "", pp.name(n.nomineeId), pp.name(n.nominatorId), n.status, iso(n.decidedAt), n.citation]) };
  } },
  praise: { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.praise.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50_000 });
    const pp = await people(tenantId);
    return { name: "praise", head: ["When", "From", "To", "Recipient department", "Badge", "Public", "Message"], rows: rows.map((p) => [iso(p.createdAt), pp.name(p.fromEmployeeId), pp.name(p.toEmployeeId), pp.dept(p.toEmployeeId), p.badge ?? "", p.isPublic ? "Yes" : "No", p.message]) };
  } },
  "points-ledger": { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.rewardPointEntry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100_000 });
    const pp = await people(tenantId);
    return { name: "points-ledger", head: ["When", "Employee", "Number", "Points", "Source", "Note"], rows: rows.map((r) => [iso(r.createdAt), pp.name(r.employeeId), pp.number(r.employeeId), r.delta, r.source, r.note ?? ""]) };
  } },
  redemptions: { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.rewardRedemption.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    const pp = await people(tenantId);
    return { name: "reward-redemptions", head: ["Requested", "Employee", "Reward", "Qty", "Points", "Status", "Fulfilled", "Fulfilment note"], rows: rows.map((r) => [iso(r.createdAt), pp.name(r.employeeId), r.itemName, r.quantity, r.points, r.status, iso(r.fulfilledAt), r.fulfilmentNote ?? ""]) };
  } },
  "program-budgets": { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.recognitionProgram.findMany({ where: { tenantId }, orderBy: { startsOn: "desc" } });
    const out: Sheet["rows"] = [];
    for (const p of rows) {
      const used = await programPointsUsed(tenantId, p.id), cash = await programCashUsed(tenantId, p.id);
      out.push([p.name, p.kind, p.status, dateOnly(p.startsOn), dateOnly(p.endsOn), p.budgetPoints ?? "unlimited", used, p.budgetPoints === null ? "" : p.budgetPoints - used, p.budgetAmount === null ? "unlimited" : Number(p.budgetAmount), cash]);
    }
    return { name: "recognition-budgets", head: ["Programme", "Kind", "Status", "Starts", "Ends", "Points budget", "Points used", "Points left", "Cash budget", "Cash used"], rows: out };
  } },
  fairness: { perm: P.AWARD_MANAGE, build: async ({ tenantId }) => {
    const pp = await people(tenantId);
    const depts = await prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } });
    const since = new Date(Date.now() - 365 * 86_400_000);
    const [praise, awards, headcounts] = await Promise.all([
      prisma.praise.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { toEmployeeId: true } }),
      prisma.employeeAward.findMany({ where: { tenantId, awardedOn: { gte: since }, revokedAt: null }, select: { employeeId: true } }),
      prisma.employee.groupBy({ by: ["departmentId"], where: { tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, _count: true }),
    ]);
    const deptOf = new Map(pp.rows.map((r) => [r.id, r.departmentId ?? ""]));
    const count = new Map<string, number>();
    for (const id of [...praise.map((p) => p.toEmployeeId), ...awards.map((a) => a.employeeId)]) { const k = deptOf.get(id) ?? ""; count.set(k, (count.get(k) ?? 0) + 1); }
    const f = recognitionFairness(headcounts.map((h) => ({ group: depts.find((d) => d.id === h.departmentId)?.name ?? "No department", headcount: h._count, recognitions: count.get(h.departmentId ?? "") ?? 0 })));
    return { name: "recognition-fairness", head: ["Department", "Headcount", "Recognitions (12 months)", "Per 10 people", "Index vs organisation", "Under-recognised"], rows: f.rows.map((r) => [r.group, r.headcount, r.recognitions, r.rate, r.index ?? "", r.underRecognised ? "Yes" : ""]) };
  } },
  wellness: { perm: P.WELLNESS_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.wellnessProgram.findMany({ where: { tenantId }, orderBy: { startsOn: "desc" }, include: { enrollments: true } });
    return { name: "wellness-participation", head: ["Programme", "Category", "Kind", "Status", "Starts", "Ends", "Enrolled", "Completed", "Withdrawn", "Completion %"],
      rows: rows.map((p) => {
        const active = p.enrollments.filter((e) => e.status !== "WITHDRAWN");
        const completed = p.enrollments.filter((e) => e.status === "COMPLETED").length;
        return [p.title, p.category, p.kind, p.status, dateOnly(p.startsOn), dateOnly(p.endsOn), active.length, completed, p.enrollments.length - active.length, active.length ? Math.round((completed / active.length) * 100) : 0];
      }) };
  } },
  wellbeing: { perm: P.WELLNESS_MANAGE, build: async ({ tenantId }) => {
    const s = await engageSettings(tenantId);
    const rows = await prisma.wellbeingCheckIn.findMany({ where: { tenantId, week: { gte: new Date(Date.now() - 84 * 86_400_000) } } });
    const depts = new Map((await prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    const sum = wellbeingSummary(rows.map((r) => ({ group: depts.get(r.departmentId ?? "") ?? "No department", mood: r.mood, stress: r.stress, wantsSupport: r.wantsSupport })), s.checkInMinGroup);
    return { name: "wellbeing-12-weeks", head: ["Department", "Check-ins", "Avg mood", "Avg stress", "Low mood %", "High stress %", "Asked for support"],
      rows: sum.groups.map((g) => (g.hidden ? [g.group, g.n, "withheld", "withheld", "withheld", "withheld", "withheld"] : [g.group, g.n, g.avgMood, g.avgStress, g.lowMoodPct, g.highStressPct, g.supportRequests])) };
  } },
  "service-requests": { perm: P.SERVICE_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.serviceRequest.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
    const types = new Map((await prisma.serviceType.findMany({ where: { tenantId } })).map((t) => [t.id, t]));
    const pp = await people(tenantId);
    return { name: "service-requests", head: ["Raised", "Service", "Category", "Employee", "Status", "Due", "Fulfilled", "Days to fulfil", "Rating", "Note"],
      rows: rows.map((r) => {
        const t = types.get(r.typeId);
        return [iso(r.createdAt), t?.name ?? "", t?.category ?? "", t?.confidential ? "(confidential)" : pp.name(r.employeeId), r.status, dateOnly(r.dueOn), iso(r.fulfilledAt), r.fulfilledAt ? Math.round((r.fulfilledAt.getTime() - r.createdAt.getTime()) / 86_400_000 * 10) / 10 : "", r.rating ?? "", t?.confidential ? "" : r.fulfilmentNote ?? ""];
      }) };
  } },
  announcements: { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.announcement.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, include: { reads: { select: { acknowledgedAt: true } }, _count: { select: { likes: true, comments: true } } } });
    const out: Sheet["rows"] = [];
    for (const a of rows) {
      const audience = a.status === "PUBLISHED" || a.status === "ARCHIVED" || a.status === "EXPIRED" ? (await announcementAudience(tenantId, a.audience)).length : 0;
      const st = reachStats(audience, a.reads.length, a.reads.filter((r) => r.acknowledgedAt).length);
      out.push([a.title, a.category ?? "", a.status, a.approvalStatus ?? "", a.isEmergency ? "Yes" : "", iso(a.publishAt), dateOnly(a.expiresAt), st.audience, st.viewed, `${st.viewedPct}%`, a.requireAck ? st.acknowledged : "", a.requireAck ? `${st.ackPct}%` : "", a._count.likes, a._count.comments]);
    }
    return { name: "announcements", head: ["Title", "Category", "Status", "Approval", "Emergency", "Published", "Expires", "Audience", "Viewed", "Viewed %", "Acknowledged", "Ack %", "Likes", "Comments"], rows: out };
  } },
  "announcement-acks": { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId, q }) => {
    const a = await prisma.announcement.findFirst({ where: { id: q.get("id") ?? "", tenantId }, include: { reads: true } });
    if (!a) return null;
    const pp = await people(tenantId);
    const read = new Map(a.reads.map((r) => [r.employeeId, r]));
    const audience = await announcementAudience(tenantId, a.audience);
    return { name: "announcement-acknowledgements", head: ["Employee", "Number", "Department", "Viewed", "Acknowledged"],
      rows: audience.map((e) => { const r = read.get(e.id); return [pp.name(e.id), pp.number(e.id), pp.dept(e.id), iso(r?.viewedAt), iso(r?.acknowledgedAt)]; }) };
  } },
  feed: { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.wallPost.findMany({ where: { tenantId, createdAt: { gte: new Date(Date.now() - 180 * 86_400_000) } }, orderBy: { createdAt: "desc" }, include: { _count: { select: { likes: true, comments: true, pollVotes: true } } } });
    const pp = await people(tenantId);
    return { name: "news-feed-activity", head: ["Posted", "Kind", "Author", "Department", "Text", "Likes", "Comments", "Poll votes", "Removed"], rows: rows.map((p) => [iso(p.createdAt), p.kind, pp.name(p.authorId), pp.dept(p.authorId), p.body.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1").slice(0, 200), p._count.likes, p._count.comments, p._count.pollVotes, iso(p.deletedAt)]) };
  } },
  polls: { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.wallPost.findMany({ where: { tenantId, kind: "POLL", deletedAt: null }, orderBy: { createdAt: "desc" }, include: { pollOptions: { orderBy: { position: "asc" }, include: { _count: { select: { votes: true } } } } } });
    // Survey polls (Engage › Surveys & Polls) alongside the wall polls.
    const surveyPolls = await prisma.survey.findMany({ where: { tenantId, kind: "POLL", status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" }, include: { questions: { orderBy: { sequence: "asc" }, take: 1, include: { answers: { select: { choices: true } } } } } });
    const wallRows = rows.flatMap((p) => p.pollOptions.map((o) => ["Wall", iso(p.createdAt), p.body, o.label, o._count.votes, iso(p.pollExpiresAt)]));
    const surveyRows = surveyPolls.flatMap((sv) => { const q = sv.questions[0]; return q ? q.options.map((label, i) => ["Survey poll", iso(sv.createdAt), `${sv.title}: ${q.prompt}`, label, q.answers.filter((a) => a.choices.includes(i)).length, iso(sv.closesAt ?? sv.closedAt)]) : []; });
    return { name: "polls", head: ["Source", "Posted", "Question", "Option", "Votes", "Closes"], rows: [...wallRows, ...surveyRows] };
  } },
  channels: { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.communityChannel.findMany({ where: { tenantId }, include: { members: { where: { status: "ACTIVE" }, select: { id: true } }, posts: { select: { createdAt: true, hiddenAt: true } } } });
    const since = new Date(Date.now() - 30 * 86_400_000);
    return { name: "channels-activity", head: ["Channel", "Kind", "Visibility", "Members", "Posts", "Posts (30 days)", "Hidden posts", "Archived"],
      rows: rows.map((c) => [c.name, c.kind, c.visibility, c.members.length, c.posts.length, c.posts.filter((p) => p.createdAt >= since).length, c.posts.filter((p) => p.hiddenAt).length, iso(c.archivedAt)]) };
  } },
  events: { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId }) => {
    const rows = await prisma.companyEvent.findMany({ where: { tenantId }, orderBy: { startsAt: "desc" }, include: { rsvps: true, questions: true } });
    return { name: "company-events", head: ["Event", "Kind", "Status", "Starts", "Ends", "Capacity", "Going", "Maybe", "Declined", "Waitlist", "Attended", "Questions"],
      rows: rows.map((e) => { const c = (r: string) => e.rsvps.filter((x) => x.response === r).length; return [e.title, e.kind, e.status, iso(e.startsAt), iso(e.endsAt), e.capacity ?? "", c("GOING"), c("MAYBE"), c("DECLINED"), c("WAITLIST"), e.rsvps.filter((x) => x.attended).length, e.questions.length]; }) };
  } },
  "event-rsvps": { perm: P.ANNOUNCEMENT_MANAGE, build: async ({ tenantId, q }) => {
    const e = await prisma.companyEvent.findFirst({ where: { id: q.get("id") ?? "", tenantId }, include: { rsvps: { orderBy: { createdAt: "asc" } } } });
    if (!e) return null;
    const pp = await people(tenantId);
    return { name: "event-rsvps", head: ["Employee", "Number", "Department", "Response", "Responded", "Attended"], rows: e.rsvps.map((r) => [pp.name(r.employeeId), pp.number(r.employeeId), pp.dept(r.employeeId), r.response, iso(r.updatedAt), r.attended === null ? "" : r.attended ? "Yes" : "No"]) };
  } },
};

/** CSV downloads for the engage pages. Each download is audited. */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const key = req.nextUrl.searchParams.get("report") ?? "";
  const report = REPORTS[key];
  if (!report) return new NextResponse("Unknown report.", { status: 404 });
  const perms = Array.isArray(report.perm) ? report.perm : [report.perm];
  if (!perms.some((p) => can(viewer, p))) return new NextResponse("Forbidden.", { status: 403 });
  const sheet = await report.build({ tenantId: viewer.tenantId, q: req.nextUrl.searchParams });
  if (!sheet) return new NextResponse("Not found.", { status: 404 });
  await govAudit(viewer.tenantId, viewer.user.id, { action: "EXPORT", entityType: "Report", entityId: key, summary: `Exported ${sheet.rows.length} row(s) of ${sheet.name}` });
  const csv = safeCsv(sheet.head, sheet.rows.map((r) => r.map((c) => (c === null ? "" : c))));
  return new NextResponse("﻿" + csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${sheet.name}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
