import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { feedbackTrend, feedbackEditable, anonymityMet, FEEDBACK_EDIT_HOURS } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeIds } from "@/lib/scope";
import { runDataset } from "@/lib/insight/datasets";
import { feedbackTimeline } from "@/lib/insight/timeline";
import { userNames, fmtDate, employeeOptions } from "@/lib/governance";
import { PageHead, Card, Badge, Stat } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, Table, Pill, SearchBar } from "@/components/gov-ui";
import { InsightTableView, ExportLinks } from "@/components/insight-table";
import { Timeline } from "@/components/timeline";
import { giveFeedbackAction } from "@/app/actions/feedback";
import {
  editFeedbackAction, deleteFeedbackAction, updateFeedbackRequestAction, saveFeedbackTopicAction, saveFeedbackRuleAction, resolveEscalationAction,
  addFollowUpAction, completeFollowUpAction, updateCycleSettingsAction, apply360TemplateAction, saveAnonymityThresholdAction, runInsightJobAction,
} from "@/app/actions/insight-performance";

export const metadata = { title: "Feedback hub" };
const TABS = { feedback: "Feedback", give: "Give feedback", requests: "Requests", followups: "Follow-ups", timeline: "Timeline", campaigns: "360 campaigns", compare: "Comparison", summaries: "Summaries", trends: "Trends", topics: "Topics", rules: "Escalations", templates: "Template report", settings: "Settings", audit: "Audit" };
const ADMIN_TABS = new Set(["campaigns", "compare", "summaries", "templates", "settings", "audit"]);
type Tab = keyof typeof TABS;
type SP = Record<string, string | undefined>;
const SENTIMENTS = [{ value: "POSITIVE", label: "Positive" }, { value: "NEUTRAL", label: "Neutral" }, { value: "NEGATIVE", label: "Negative" }];
const REVIEWER_TYPES = ["SELF", "MANAGER", "SKIP_LEVEL", "PEER", "SUBORDINATE"];

/**
 * Performance › Feedback hub: searching and exporting feedback, giving it
 * with a topic, tags, a template and quality prompts, editing and deleting
 * it, requests, follow-ups, a timeline, 360 campaign tracking and settings,
 * a side-by-side comparison, summaries, sentiment trends, the topic
 * taxonomy, escalation rules, the template report, digests and the audit.
 */
export default async function FeedbackHubPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const admin = can(viewer, P.PERFORMANCE_MANAGE);
  const tabs = Object.fromEntries(Object.entries(TABS).filter(([k]) => admin || !ADMIN_TABS.has(k))) as Record<string, string>;
  const tab: Tab = (sp.tab as Tab) in tabs ? (sp.tab as Tab) : "feedback";
  const me = viewer.employee?.id ?? "__none__";
  const topics = await prisma.insightFeedbackTopic.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } });
  const topicOpts = topics.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.parentId ? `${topics.find((p) => p.id === t.parentId)?.name ?? ""} › ${t.name}` : t.name }));
  const filters = { q: sp.q, sentiment: sp.sentiment, topicId: sp.topicId, about: sp.about };
  return (
    <>
      <PageHead title="Feedback hub" subtitle="Continuous feedback and 360: give, search, follow up, track and report" actions={<Link className="btn sm" href="/me/performance">My performance</Link>} />
      <Tabs base="/performance/feedback-hub" tabs={tabs} active={tab} />

      {tab === "feedback" ? await (async () => {
        const table = await runDataset(viewer, "feedback", filters);
        return (
          <Card title="Feedback" description={`Search by words, topic, tag or person. You can edit or delete your own feedback for ${FEEDBACK_EDIT_HOURS} hours.`}>
            <SearchBar action="/performance/feedback-hub" tab="feedback" q={sp.q}>
              <select className="select" name="sentiment" defaultValue={sp.sentiment ?? ""} style={{ width: 140 }}><option value="">Any sentiment</option>{SENTIMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
              <select className="select" name="topicId" defaultValue={sp.topicId ?? ""} style={{ width: 180 }}><option value="">Any topic</option>{topicOpts.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </SearchBar>
            <InsightTableView table={table} ds="feedback" params={filters} extraHead="" extra={(r) => (
              <span className="row gap-2">
                {r.own && feedbackEditable(r.createdAt as Date) ? <Link className="btn sm" href={`/performance/feedback-hub?tab=feedback&edit=${r.id}`}>Edit</Link> : null}
                {r.own && feedbackEditable(r.createdAt as Date) ? <ActButton action={deleteFeedbackAction} hidden={{ id: String(r.id) }} label="Delete" variant="ghost" confirmText="Delete this feedback?" /> : null}
                {!r.own && admin ? <ActButton action={deleteFeedbackAction} hidden={{ id: String(r.id) }} label="Remove" variant="ghost" input={{ name: "reason", placeholder: "Reason", required: true }} /> : null}
                {r.kind === "Feedback" ? <Link className="btn sm" href={`/performance/feedback-hub?tab=followups&feedback=${r.id}`}>Follow up</Link> : null}
              </span>
            )} />
            {sp.edit ? await (async () => {
              const f = await prisma.feedback.findFirst({ where: { id: sp.edit, tenantId: viewer.tenantId, fromEmployeeId: me, deletedAt: null } });
              if (!f || !feedbackEditable(f.createdAt)) return null;
              return (
                <div style={{ marginTop: 14 }}>
                  <strong className="text-sm">Edit feedback</strong>
                  <SpecForm action={editFeedbackAction} hidden={{ id: f.id }} columns={2} fields={[
                    { name: "message", label: "Feedback", type: "textarea", required: true, defaultValue: f.message },
                    { name: "topicId", label: "Topic", type: "select", options: topicOpts, defaultValue: f.topicId ?? "" },
                    { name: "tags", label: "Tags (comma separated)", defaultValue: f.tags.join(", ") },
                  ]} />
                </div>
              );
            })() : null}
          </Card>
        );
      })() : null}

      {tab === "give" ? await (async () => {
        const [people, templates] = await Promise.all([
          employeeOptions(viewer.tenantId),
          prisma.feedbackTemplate.findMany({ where: { tenantId: viewer.tenantId, status: "APPROVED" }, orderBy: { name: "asc" } }),
        ]);
        const tpl = templates.find((t) => t.id === sp.template);
        const others = people.filter((p) => p.value !== me);
        return (
          <div className="grid grid-2">
            <Card title={tpl ? `Give feedback: ${tpl.name}` : "Give feedback"} description={tpl ? "Answer each question; the answers become the feedback." : "We check the wording before it goes: specific, kind, and about the work."}>
              <SpecForm action={giveFeedbackAction} hidden={{ kind: "FEEDBACK", qualityCheck: "1", ...(tpl ? { templateId: tpl.id } : {}) }} columns={1} submitLabel="Send feedback" fields={[
                { name: "aboutEmployeeId", label: "About", type: "select", options: others, required: true },
                { name: "topicId", label: "Topic", type: "select", options: topicOpts },
                { name: "tags", label: "Tags (comma separated)" },
                ...(tpl ? tpl.questions.map((q, i) => ({ name: `answer_${i}`, label: q, type: "textarea" as const, required: true })) : [{ name: "message", label: "Feedback", type: "textarea" as const, required: true }]),
                { name: "anonymous", label: "Hide my name (if your company allows it)", type: "checkbox" as const },
                ...(tpl ? [] : [{ name: "sendAnyway", label: "Send as written (skip the wording check)", type: "checkbox" as const }]),
              ]} />
            </Card>
            <Card title="Feedback templates" description="Approved templates give structure to feedback.">
              <div className="stack gap-2">
                <Link className={`btn sm${tpl ? "" : " primary"}`} href="/performance/feedback-hub?tab=give">Free text</Link>
                {templates.map((t) => <Link key={t.id} className={`btn sm${t.id === tpl?.id ? " primary" : ""}`} href={`/performance/feedback-hub?tab=give&template=${t.id}`}>{t.name} <span className="muted">· {t.purpose.toLowerCase()}</span></Link>)}
              </div>
            </Card>
          </div>
        );
      })() : null}

      {tab === "requests" ? await (async () => {
        const table = await runDataset(viewer, "feedback-requests", { q: sp.q, status: sp.status });
        const edit = sp.edit ? await prisma.feedbackRequest.findFirst({ where: { id: sp.edit, tenantId: viewer.tenantId, requesterId: me, status: "PENDING" } }) : null;
        return (
          <Card title="Feedback requests" action={<Link className="btn sm" href="/me/performance/requests">Ask for feedback</Link>}>
            <SearchBar action="/performance/feedback-hub" tab="requests" q={sp.q}>
              <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ width: 140 }}><option value="">Any status</option>{["PENDING", "GIVEN", "DECLINED", "WITHDRAWN"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select>
            </SearchBar>
            <InsightTableView table={table} ds="feedback-requests" params={{ q: sp.q, status: sp.status }} extra={(r) => r.mine && r.status === "PENDING" ? (
              <span className="row gap-2"><Link className="btn sm" href={`/performance/feedback-hub?tab=requests&edit=${r.id}`}>Edit</Link><ActButton action={updateFeedbackRequestAction} hidden={{ id: String(r.id), op: "withdraw" }} label="Withdraw" variant="ghost" confirmText="Withdraw this request?" /></span>
            ) : null} />
            {edit ? (
              <div style={{ marginTop: 14 }}>
                <SpecForm action={updateFeedbackRequestAction} hidden={{ id: edit.id, op: "edit" }} columns={2} fields={[
                  { name: "message", label: "Message", type: "textarea", defaultValue: edit.message ?? "" },
                  { name: "dueDate", label: "Due", type: "date", defaultValue: edit.dueDate?.toISOString().slice(0, 10) ?? "" },
                ]} />
              </div>
            ) : null}
          </Card>
        );
      })() : null}

      {tab === "followups" ? await (async () => {
        const rows = await prisma.insightFeedbackFollowUp.findMany({ where: { tenantId: viewer.tenantId, ...(admin ? {} : { OR: [{ ownerEmployeeId: me }, { createdBy: viewer.user.id }, { ownerEmployeeId: { in: [...viewer.allReportIds] } }] }) }, orderBy: [{ status: "asc" }, { dueDate: "asc" }], take: 300 });
        const owners = new Map((await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.ownerEmployeeId) } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
        const fb = sp.feedback ? await prisma.feedback.findFirst({ where: { id: sp.feedback, tenantId: viewer.tenantId, deletedAt: null }, include: { aboutEmployee: { select: { displayName: true } } } }) : null;
        return (
          <>
            {fb ? (
              <Card title={`Follow up on feedback about ${fb.aboutEmployee.displayName}`} description={fb.message.slice(0, 200)}>
                <SpecForm action={addFollowUpAction} hidden={{ feedbackId: fb.id }} columns={3} submitLabel="Add follow-up" fields={[
                  { name: "title", label: "What will be done", required: true },
                  { name: "dueDate", label: "Due", type: "date", required: true },
                  { name: "ownerEmployeeId", label: "Owner", type: "select", options: await employeeOptions(viewer.tenantId), placeholder: "The person it is about" },
                ]} />
              </Card>
            ) : null}
            <Card title="Follow-up tasks" description="Actions agreed after feedback. Open “Follow up” on a feedback row to add one.">
              <Table head={["Task", "Owner", "Due", "Status", ""]} empty={!rows.length}>
                {rows.map((r) => (
                  <tr key={r.id}><td>{r.title}</td><td className="text-sm">{owners.get(r.ownerEmployeeId) ?? ""}</td><td>{fmtDate(r.dueDate)}{r.status === "OPEN" && r.dueDate < new Date() ? <Badge tone="danger">overdue</Badge> : null}</td><td><Pill s={r.status} /></td>
                    <td>{r.status === "OPEN" ? <ActButton action={completeFollowUpAction} hidden={{ id: r.id }} label="Done" /> : <ActButton action={completeFollowUpAction} hidden={{ id: r.id, op: "reopen" }} label="Reopen" variant="ghost" />}</td></tr>
                ))}
              </Table>
            </Card>
          </>
        );
      })() : null}

      {tab === "timeline" ? await (async () => {
        const reach = admin ? await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE) : [me, ...viewer.allReportIds];
        const who = sp.employeeId && (reach === null || reach.includes(sp.employeeId)) ? sp.employeeId : me;
        const opts = (await employeeOptions(viewer.tenantId)).filter((o) => reach === null || reach.includes(o.value));
        return (
          <Card title="Feedback timeline" description="Feedback received over time, newest first. Internal notes and anonymous givers stay hidden.">
            <form method="get" action="/performance/feedback-hub" className="row gap-2" style={{ marginBottom: 10 }}>
              <input type="hidden" name="tab" value="timeline" />
              <select className="select" name="employeeId" defaultValue={who} style={{ width: 280 }}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              <button className="btn sm" type="submit">Show</button>
            </form>
            <Timeline events={await feedbackTimeline(viewer.tenantId, who)} />
          </Card>
        );
      })() : null}

      {tab === "campaigns" ? await (async () => {
        const table = await runDataset(viewer, "campaigns", { q: sp.q, status: sp.status });
        const cycle = sp.cycleId ? await prisma.reviewCycle.findFirst({ where: { id: sp.cycleId, tenantId: viewer.tenantId }, include: { reviews: { include: { employee: { select: { displayName: true } }, responses: { include: { reviewer: { select: { displayName: true } } } } } } } }) : null;
        const templates = await prisma.feedbackTemplate.findMany({ where: { tenantId: viewer.tenantId, status: "APPROVED", purpose: "THREE_SIXTY" } });
        return (
          <>
            <Card title="360 campaigns" description="Response tracking across review cycles.">
              <SearchBar action="/performance/feedback-hub" tab="campaigns" q={sp.q} />
              <InsightTableView table={table} ds="campaigns" params={{ q: sp.q, status: sp.status }} extra={(r) => <Link className="btn sm" href={`/performance/feedback-hub?tab=campaigns&cycleId=${r.id}`}>Manage</Link>} />
            </Card>
            {cycle ? (
              <>
                <div className="grid grid-2">
                  <Card title={`Settings: ${cycle.name}`}>
                    <SpecForm action={updateCycleSettingsAction} hidden={{ cycleId: cycle.id }} columns={2} fields={[
                      { name: "name", label: "Name", defaultValue: cycle.name },
                      { name: "maxPeers", label: "Max peer reviewers", type: "number", defaultValue: cycle.maxPeers },
                      { name: "reviewClosesAt", label: "Responses close", type: "date", defaultValue: cycle.reviewClosesAt?.toISOString().slice(0, 10) ?? "" },
                      { name: "anonymousFeedback", label: "Anonymous peer feedback", type: "checkbox", defaultValue: cycle.anonymousFeedback },
                    ]} />
                  </Card>
                  <Card title="Use a 360 feedback template" description="Adds the template's questions to this cycle's review form as a 360 section.">
                    {cycle.status === "DRAFT" ? <SpecForm action={apply360TemplateAction} hidden={{ cycleId: cycle.id }} columns={1} submitLabel="Add to form" fields={[{ name: "templateId", label: "Template", type: "select", options: templates.map((t) => ({ value: t.id, label: t.name })), required: true }]} /> : <div className="muted text-sm">The form is fixed once the cycle launches.</div>}
                  </Card>
                </div>
                <Card title="Response tracking" action={<ActButton action={runInsightJobAction} hidden={{ job: "reviews" }} label="Remind late reviewers" />}>
                  <Table head={["Employee", "Reviewer", "Type", "Status", "Submitted", "Last reminded"]} empty={!cycle.reviews.some((r) => r.responses.length)}>
                    {cycle.reviews.flatMap((r) => r.responses.filter((x) => x.reviewerType !== "SELF").map((x) => (
                      <tr key={x.id}><td>{r.employee.displayName}</td><td className="text-sm">{cycle.anonymousFeedback && x.reviewerType === "PEER" ? "Peer (anonymous)" : x.reviewer.displayName}</td><td>{x.reviewerType.toLowerCase()}</td><td><Pill s={x.submittedAt ? "SUBMITTED" : x.status === "ACTIVE" ? "PENDING" : x.status} /></td><td>{fmtDate(x.submittedAt)}</td><td>{fmtDate(x.remindedAt)}</td></tr>
                    )))}
                  </Table>
                </Card>
              </>
            ) : null}
          </>
        );
      })() : null}

      {tab === "compare" ? await (async () => {
        const scope = await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE);
        const reviews = await prisma.employeeReview.findMany({ where: { cycle: { tenantId: viewer.tenantId }, ...(scope ? { employeeId: { in: scope } } : {}), responses: { some: { submittedAt: { not: null } } } }, include: { employee: { select: { displayName: true } }, cycle: { select: { name: true } } }, orderBy: { updatedAt: "desc" }, take: 200 });
        const pick = reviews.find((r) => r.id === sp.reviewId) ?? reviews[0];
        const full = pick ? await prisma.employeeReview.findUnique({ where: { id: pick.id }, include: { responses: { where: { submittedAt: { not: null } } }, cycle: { include: { formSections: { include: { questions: { orderBy: { displayOrder: "asc" } } }, orderBy: { displayOrder: "asc" } } } } } }) : null;
        const setting = await prisma.feedbackSetting.findUnique({ where: { tenantId: viewer.tenantId } });
        const min = setting?.minAnonymousResponses ?? 3;
        const types = REVIEWER_TYPES.filter((t) => full?.responses.some((r) => r.reviewerType === t));
        const hidden = (t: string) => !!full?.cycle.anonymousFeedback && (t === "PEER" || t === "SUBORDINATE") && !anonymityMet(full.responses.filter((r) => r.reviewerType === t).length, min);
        const cell = (t: string, qid: string) => {
          if (hidden(t)) return "Hidden — too few responses";
          const vals = full!.responses.filter((r) => r.reviewerType === t).map((r) => (r.answers as Record<string, unknown> | null)?.[qid]).filter((x) => x !== undefined && x !== null && x !== "");
          if (!vals.length) return "—";
          const nums = vals.map(Number).filter((x) => !Number.isNaN(x));
          return nums.length === vals.length ? `${Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10} (${nums.length})` : vals.map(String).join(" · ");
        };
        return (
          <Card title="360 comparison" description={`One review's answers side by side by reviewer type. Anonymous peer and upward answers show once ${min} have arrived.`}>
            <form method="get" action="/performance/feedback-hub" className="row gap-2" style={{ marginBottom: 10 }}>
              <input type="hidden" name="tab" value="compare" />
              <select className="select" name="reviewId" defaultValue={pick?.id ?? ""} style={{ width: 360 }}>{reviews.map((r) => <option key={r.id} value={r.id}>{r.employee.displayName} — {r.cycle.name}</option>)}</select>
              <button className="btn sm" type="submit">Compare</button>
            </form>
            {full ? (
              <Table head={["Question", ...types.map((t) => t.toLowerCase().replace("_", " "))]} empty={!types.length}>
                <tr><td><strong>Overall rating</strong></td>{types.map((t) => { const rs = full.responses.filter((r) => r.reviewerType === t && r.overallRating !== null).map((r) => Number(r.overallRating)); return <td key={t} className="num">{hidden(t) ? "Hidden" : rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 10) / 10 : "—"}</td>; })}</tr>
                {full.cycle.formSections.flatMap((s) => s.questions.map((q) => <tr key={q.id}><td className="text-sm">{q.prompt}<div className="text-xs muted">{s.title}</div></td>{types.map((t) => <td key={t} className="text-sm">{cell(t, q.id)}</td>)}</tr>))}
                <tr><td><strong>Strengths</strong></td>{types.map((t) => <td key={t} className="text-sm">{hidden(t) ? "Hidden" : full.responses.filter((r) => r.reviewerType === t).map((r) => r.strengths).filter(Boolean).join(" · ") || "—"}</td>)}</tr>
                <tr><td><strong>To improve</strong></td>{types.map((t) => <td key={t} className="text-sm">{hidden(t) ? "Hidden" : full.responses.filter((r) => r.reviewerType === t).map((r) => r.improvements).filter(Boolean).join(" · ") || "—"}</td>)}</tr>
              </Table>
            ) : null}
          </Card>
        );
      })() : null}

      {tab === "summaries" ? (
        <Card title="Feedback summaries" description="Generated from each review's ratings and comments; a manager can rewrite them under Review operations.">
          <SearchBar action="/performance/feedback-hub" tab="summaries" q={sp.q} />
          <InsightTableView table={await runDataset(viewer, "summaries", { q: sp.q })} ds="summaries" params={{ q: sp.q }} />
        </Card>
      ) : null}

      {tab === "trends" ? await (async () => {
        const scope = admin ? await scopedEmployeeIds(viewer, P.PERFORMANCE_MANAGE) : [me, ...viewer.allReportIds];
        const rows = await prisma.feedback.findMany({ where: { tenantId: viewer.tenantId, kind: "FEEDBACK", deletedAt: null, createdAt: { gte: new Date(Date.now() - 365 * 86400000) }, ...(scope ? { aboutEmployeeId: { in: scope } } : {}) }, select: { createdAt: true, sentiment: true, topicId: true } });
        const trend = feedbackTrend(rows);
        const byTopic = topics.map((t) => ({ t, n: rows.filter((r) => r.topicId === t.id).length, neg: rows.filter((r) => r.topicId === t.id && r.sentiment === "NEGATIVE").length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
        return (
          <>
            <div className="grid grid-3">
              <Stat label="Feedback in 12 months" value={rows.length} />
              <Stat label="Positive" value={rows.filter((r) => r.sentiment === "POSITIVE").length} tone="pos" />
              <Stat label="Negative" value={rows.filter((r) => r.sentiment === "NEGATIVE").length} tone="neg" />
            </div>
            <Card title="Sentiment by month">
              <Table head={["Month", "Total", "Positive", "Neutral", "Negative", "Positive share"]} empty={!trend.length}>
                {trend.map((m) => <tr key={m.month}><td>{m.month}</td><td className="num">{m.total}</td><td className="num">{m.positive}</td><td className="num">{m.neutral}</td><td className="num">{m.negative}</td><td className="num">{m.positiveShare}%</td></tr>)}
              </Table>
            </Card>
            <Card title="By topic">
              <Table head={["Topic", "Feedback", "Negative"]} empty={!byTopic.length}>{byTopic.map((x) => <tr key={x.t.id}><td>{x.t.name}</td><td className="num">{x.n}</td><td className="num">{x.neg}</td></tr>)}</Table>
            </Card>
          </>
        );
      })() : null}

      {tab === "topics" ? (
        <>
          <Card title="Feedback topics" description="A two-level taxonomy used to tag and search feedback.">
            <Table head={["Topic", "Parent", "Description", "Active", ""]} empty={!topics.length}>
              {topics.map((t) => <tr key={t.id}><td>{t.name}</td><td>{topics.find((p) => p.id === t.parentId)?.name ?? "—"}</td><td className="text-sm">{t.description}</td><td>{t.isActive ? "Yes" : "No"}</td>
                <td>{admin ? <ActButton action={saveFeedbackTopicAction} hidden={{ id: t.id, name: t.name, isActive: t.isActive ? "" : "on", ...(t.parentId ? { parentId: t.parentId } : {}), ...(t.description ? { description: t.description } : {}) }} label={t.isActive ? "Retire" : "Restore"} variant="ghost" /> : null}</td></tr>)}
            </Table>
          </Card>
          {admin ? (
            <Card title="Add a topic">
              <SpecForm action={saveFeedbackTopicAction} columns={3} fields={[
                { name: "name", label: "Name", required: true },
                { name: "parentId", label: "Under", type: "select", options: topics.filter((t) => !t.parentId).map((t) => ({ value: t.id, label: t.name })) },
                { name: "description", label: "Description" },
              ]} />
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === "rules" ? await (async () => {
        const [rules, escalations] = await Promise.all([
          prisma.insightFeedbackRule.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }),
          prisma.insightFeedbackEscalation.findMany({ where: { tenantId: viewer.tenantId, ...(admin ? {} : { notifiedUserIds: { has: viewer.user.id } }) }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 }),
        ]);
        const fbs = new Map((await prisma.feedback.findMany({ where: { id: { in: escalations.map((e) => e.feedbackId) } }, include: { aboutEmployee: { select: { displayName: true } } } })).map((f) => [f.id, f]));
        const names = await userNames(viewer.tenantId, escalations.map((e) => e.resolvedBy).filter((x): x is string => !!x));
        return (
          <>
            <Card title="Escalations" description="Feedback that tripped a rule. Those notified record what was done.">
              <Table head={["When", "Rule", "About", "Feedback", "Status", ""]} empty={!escalations.length}>
                {escalations.map((e) => { const f = fbs.get(e.feedbackId); return (
                  <tr key={e.id}><td>{fmtDate(e.createdAt)}</td><td>{rules.find((r) => r.id === e.ruleId)?.name}</td><td className="text-sm">{f?.aboutEmployee.displayName}</td><td className="text-sm">{f?.message.slice(0, 140)}</td>
                    <td><Pill s={e.status} />{e.resolutionNote ? <div className="text-xs muted">{e.resolutionNote} — {names.get(e.resolvedBy ?? "") ?? ""}</div> : null}</td>
                    <td>{e.status === "OPEN" ? <ActButton action={resolveEscalationAction} hidden={{ id: e.id }} label="Resolve" input={{ name: "note", placeholder: "What was done", required: true }} /> : null}</td></tr>
                ); })}
              </Table>
            </Card>
            {admin ? (
              <>
                <Card title="Escalation rules">
                  <Table head={["Rule", "Trigger", "Notifies", "Active", ""]} empty={!rules.length}>
                    {rules.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.trigger.toLowerCase()}{r.keyword ? `: “${r.keyword}”` : ""}{r.topicId ? `: ${topics.find((t) => t.id === r.topicId)?.name ?? ""}` : ""}</td><td>{r.notify.toLowerCase().replace("_", " ")}</td><td>{r.isActive ? "Yes" : "No"}</td>
                      <td><ActButton action={saveFeedbackRuleAction} hidden={{ id: r.id, name: r.name, trigger: r.trigger, notify: r.notify, isActive: r.isActive ? "" : "on", ...(r.keyword ? { keyword: r.keyword } : {}), ...(r.topicId ? { topicId: r.topicId } : {}) }} label={r.isActive ? "Pause" : "Resume"} variant="ghost" /></td></tr>)}
                  </Table>
                </Card>
                <Card title="Add a rule">
                  <SpecForm action={saveFeedbackRuleAction} columns={3} fields={[
                    { name: "name", label: "Name", required: true },
                    { name: "trigger", label: "When feedback", type: "select", required: true, options: [{ value: "NEGATIVE", label: "is negative" }, { value: "KEYWORD", label: "contains a keyword" }, { value: "TOPIC", label: "is on a topic" }] },
                    { name: "keyword", label: "Keyword" },
                    { name: "topicId", label: "Topic", type: "select", options: topicOpts },
                    { name: "notify", label: "Notify", type: "select", required: true, options: [{ value: "HR", label: "HR" }, { value: "MANAGER", label: "the manager" }, { value: "SKIP_MANAGER", label: "the skip-level manager" }] },
                  ]} />
                </Card>
              </>
            ) : null}
          </>
        );
      })() : null}

      {tab === "templates" ? (
        <Card title="Feedback template report" action={<Link className="btn sm" href="/performance/feedback-templates">Manage templates</Link>}>
          <InsightTableView table={await runDataset(viewer, "feedback-templates")} ds="feedback-templates" />
        </Card>
      ) : null}

      {tab === "settings" ? await (async () => {
        const setting = await prisma.feedbackSetting.findUnique({ where: { tenantId: viewer.tenantId } });
        return (
          <div className="grid grid-2">
            <Card title="Anonymity threshold" description="Anonymous peer and upward answers are pooled and shown only once this many have arrived.">
              <SpecForm action={saveAnonymityThresholdAction} columns={1} fields={[{ name: "minAnonymousResponses", label: "Minimum responses", type: "number", required: true, defaultValue: setting?.minAnonymousResponses ?? 3 }]} />
            </Card>
            <Card title="Feedback digests" description="A weekly summary to each person of the feedback they received and gave. It also runs on schedule.">
              <ActButton action={runInsightJobAction} hidden={{ job: "digests" }} label="Send digests now" />
              <div className="hint" style={{ marginTop: 8 }}>Who may give feedback and whether anonymously: <Link href="/performance/settings">Performance settings</Link>.</div>
            </Card>
          </div>
        );
      })() : null}

      {tab === "audit" ? (
        <Card title="Feedback audit history" action={<ExportLinks ds="feedback-audit" />}>
          {canAny(viewer, [P.PERFORMANCE_MANAGE]) ? <InsightTableView table={await runDataset(viewer, "feedback-audit")} ds="feedback-audit" hideExport /> : null}
        </Card>
      ) : null}
    </>
  );
}
