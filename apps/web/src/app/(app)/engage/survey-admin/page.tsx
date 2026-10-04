import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { actionPlanState, engageSettings, enps, ratingSummary, trendDeltas } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { departmentOptions } from "@/lib/governance";
import { employeeNames, fmtDay, matches } from "@/lib/engage-depth";
import { PageHead, Card, Callout, Stat } from "@/components/ui";
import { Pill, Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { saveScheduleAction, scheduleOpAction, templateOpAction, saveEngageSettingsAction, applySurveyRetentionAction } from "@/app/actions/engage-surveys";
import { forbidden } from "next/navigation";

const P = PERMISSIONS;
const TABS = { schedules: "Recurring pulses", templates: "Template library", actions: "Action plans", trends: "Trends", settings: "Settings" };
type Tab = keyof typeof TABS;

/** Survey administration: recurring pulse schedules, the template library, action plans across surveys, trends and settings. */
export default async function SurveyAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.SURVEY_MANAGE, P.SURVEY_RESULTS])) forbidden();
  const sp = await searchParams;
  const canManage = can(viewer, P.SURVEY_MANAGE);
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : canManage ? "schedules" : "trends";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="Survey administration" subtitle="Recurring pulses, reusable templates, action plans and engagement trends" actions={<Link className="btn" href="/engage/surveys">All surveys</Link>} />
      <Tabs base="/engage/survey-admin" tabs={canManage ? TABS : { actions: TABS.actions, trends: TABS.trends }} active={tab} />
      {tab === "schedules" && canManage ? <Schedules tenantId={t} /> : null}
      {tab === "templates" && canManage ? <Templates tenantId={t} q={sp.q} /> : null}
      {tab === "actions" ? <Plans tenantId={t} q={sp.q} status={sp.status} /> : null}
      {tab === "trends" ? <Trends tenantId={t} kind={sp.kind} /> : null}
      {tab === "settings" && canManage ? <Settings tenantId={t} /> : null}
    </>
  );
}

async function Schedules({ tenantId }: { tenantId: string }) {
  const [rows, templates, depts] = await Promise.all([
    prisma.surveySchedule.findMany({ where: { tenantId }, orderBy: [{ isActive: "desc" }, { nextRunOn: "asc" }] }),
    prisma.surveyTemplate.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    departmentOptions(tenantId),
  ]);
  const tplName = new Map(templates.map((x) => [x.id, x.name]));
  return (
    <div className="stack gap-4">
      <Card tight title="Recurring pulses" description="Each run is created from the template, launched to the audience and closed after it has been open for its window. Runs from a schedule are pre-approved.">
        <div className="row gap-2" style={{ marginBottom: 10 }}><ActButton action={scheduleOpAction} hidden={{ op: "run-due", id: "" }} label="Run everything due now" /></div>
        <Table head={["Schedule", "Type", "Every", "Open for", "Next run", "Runs", "Status", ""]} empty={rows.length === 0}>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.title}</strong><div className="text-xs muted">{s.templateId ? `Template: ${tplName.get(s.templateId) ?? "removed"}` : "Built-in pulse questions"}{s.onSignIn ? " · asked at sign-in" : ""}{s.departmentIds.length ? ` · ${s.departmentIds.length} department(s)` : " · everyone"}</div></td>
              <td>{s.kind}</td><td>{s.everyDays} days</td><td>{s.openDays} days</td><td>{fmtDay(s.nextRunOn)}</td><td>{s.runs}</td>
              <td><Pill s={s.isActive ? "ACTIVE" : "PAUSED"} /></td>
              <td className="row gap-2">
                <ActButton action={scheduleOpAction} hidden={{ id: s.id, op: s.isActive ? "pause" : "resume" }} label={s.isActive ? "Pause" : "Resume"} variant="ghost" />
                <ActButton action={scheduleOpAction} hidden={{ id: s.id, op: "run-now" }} label="Run now" />
                <ActButton action={scheduleOpAction} hidden={{ id: s.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this schedule? Past runs are kept." />
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="New recurring pulse">
        <SpecForm action={saveScheduleAction} submitLabel="Create schedule" fields={[
          { name: "title", label: "Title", required: true, placeholder: "Fortnightly pulse" },
          { name: "kind", label: "Type", type: "select", required: true, defaultValue: "PULSE", options: [{ value: "PULSE", label: "Pulse" }, { value: "ENPS", label: "eNPS" }, { value: "ENGAGEMENT", label: "Engagement" }] },
          { name: "templateId", label: "Questions from", type: "select", options: templates.map((x) => ({ value: x.id, label: x.name })), placeholder: "Built-in pulse questions" },
          { name: "everyDays", label: "Run every (days)", type: "number", required: true, defaultValue: 14 },
          { name: "openDays", label: "Each run stays open (days)", type: "number", defaultValue: 7 },
          { name: "nextRunOn", label: "First run on", type: "date", required: true },
          { name: "onSignIn", label: "Sign-in pulse", type: "checkbox", placeholder: "Ask the first question on the dashboard at sign-in" },
          { name: "departmentIds", label: "Departments (none = everyone)", type: "multiselect", options: depts, wide: true },
        ]} />
      </Card>
    </div>
  );
}

async function Templates({ tenantId, q }: { tenantId: string; q?: string }) {
  const rows = (await prisma.surveyTemplate.findMany({ where: { tenantId }, orderBy: { name: "asc" } })).filter((x) => matches(q, x.name, x.description));
  return (
    <Card tight title="Template library" description="Save any survey as a template from its page; new surveys and recurring pulses can start from these.">
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value="templates" /><input className="input" name="q" defaultValue={q ?? ""} placeholder="Search templates…" /><button className="btn sm">Search</button></form>
      <Table head={["Template", "Type", "Questions", "Status", "Rename", ""]} empty={rows.length === 0}>
        {rows.map((x) => (
          <tr key={x.id}>
            <td><strong>{x.name}</strong>{x.description ? <div className="text-xs muted">{x.description}</div> : null}</td>
            <td>{x.kind}</td><td>{Array.isArray(x.questions) ? x.questions.length : 0}</td><td><Pill s={x.isActive ? "ACTIVE" : "RETIRED"} /></td>
            <td><ActButton action={templateOpAction} hidden={{ id: x.id, op: "rename" }} label="Rename" input={{ name: "name", placeholder: x.name, required: true }} /></td>
            <td className="row gap-2">
              <ActButton action={templateOpAction} hidden={{ id: x.id, op: "toggle" }} label={x.isActive ? "Retire" : "Reactivate"} variant="ghost" />
              <ActButton action={templateOpAction} hidden={{ id: x.id, op: "delete" }} label="Delete" variant="danger" confirmText="Delete this template?" />
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Plans({ tenantId, q, status }: { tenantId: string; q?: string; status?: string }) {
  const rows = await prisma.surveyActionPlan.findMany({ where: { tenantId }, orderBy: { dueOn: "asc" } });
  const surveys = new Map((await prisma.survey.findMany({ where: { tenantId, id: { in: rows.map((r) => r.surveyId) } }, select: { id: true, title: true } })).map((s) => [s.id, s.title]));
  const owners = await employeeNames(tenantId, rows.map((r) => r.ownerEmployeeId));
  const now = new Date();
  const withState = rows.map((r) => ({ ...r, state: actionPlanState(r.status, r.dueOn, now) }))
    .filter((r) => (!status || r.state === status) && matches(q, r.title, r.driver, surveys.get(r.surveyId), owners.get(r.ownerEmployeeId)));
  const open = rows.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS").length;
  const overdue = rows.filter((r) => actionPlanState(r.status, r.dueOn, now) === "OVERDUE").length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Open" value={open} meta="Not yet done" />
        <Stat label="Overdue" value={overdue} tone={overdue ? "neg" : undefined} meta="Past their due date" />
        <Stat label="Done" value={rows.filter((r) => r.status === "DONE").length} meta="Completed" />
      </div>
      <Card tight title="Action plans across surveys" description="Owners are reminded when a plan passes its due date." >
        <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
          <input type="hidden" name="tab" value="actions" />
          <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search…" />
          <select className="select" name="status" defaultValue={status ?? ""} style={{ width: 160 }}>
            <option value="">Any status</option>{["OPEN", "IN_PROGRESS", "OVERDUE", "DONE", "CANCELLED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
          </select>
          <button className="btn sm">Filter</button>
          <a className="btn sm" href="/engage/export?report=action-plans">Export CSV</a>
        </form>
        <Table head={["Action", "Survey", "Driver", "Owner", "Due", "Status"]} empty={withState.length === 0}>
          {withState.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.title}</strong>{r.progressNote ? <div className="text-xs muted">{r.progressNote}</div> : null}</td>
              <td><Link href={`/engage/surveys/${r.surveyId}`}>{surveys.get(r.surveyId) ?? "—"}</Link></td>
              <td>{r.driver ?? "—"}</td><td>{owners.get(r.ownerEmployeeId) ?? "—"}</td><td>{fmtDay(r.dueOn)}</td><td><Pill s={r.state} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Trends({ tenantId, kind }: { tenantId: string; kind?: string }) {
  const k = ["PULSE", "ENGAGEMENT", "ENPS"].includes(kind ?? "") ? kind! : undefined;
  const surveys = await prisma.survey.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "CLOSED"] }, kind: k ? (k as "PULSE") : { in: ["PULSE", "ENGAGEMENT", "ENPS"] } },
    orderBy: { launchedAt: "asc" }, take: 24,
    include: { questions: { select: { id: true, type: true } }, responses: { select: { answers: { select: { questionId: true, score: true } } } } },
  });
  const points = surveys.map((s) => {
    const rating = new Set(s.questions.filter((q) => q.type === "RATING").map((q) => q.id));
    const nps = new Set(s.questions.filter((q) => q.type === "NPS").map((q) => q.id));
    const revealed = s.responses.length >= s.minGroupSize;
    const scores = s.responses.flatMap((r) => r.answers.filter((a) => rating.has(a.questionId) && a.score !== null).map((a) => a.score!));
    const npsScores = s.responses.flatMap((r) => r.answers.filter((a) => nps.has(a.questionId) && a.score !== null).map((a) => a.score!));
    return { s, n: s.responses.length, favourable: revealed && scores.length ? ratingSummary(scores).favourable : null, enps: revealed && npsScores.length ? enps(npsScores).score : null };
  });
  const favDelta = trendDeltas(points.map((p) => ({ value: p.favourable })));
  const npsDelta = trendDeltas(points.map((p) => ({ value: p.enps })));
  const sign = (n: number | null) => (n === null ? "" : n > 0 ? ` (+${n})` : n < 0 ? ` (${n})` : " (=)");
  return (
    <Card tight title="Engagement over time" description="Favourable % and eNPS for each launched survey, oldest first. Surveys under their anonymity minimum show no score.">
      <form method="get" className="row gap-2" style={{ marginBottom: 12 }}>
        <input type="hidden" name="tab" value="trends" />
        <select className="select" name="kind" defaultValue={k ?? ""} style={{ width: 180 }}><option value="">Pulse, engagement & eNPS</option><option value="PULSE">Pulse</option><option value="ENGAGEMENT">Engagement</option><option value="ENPS">eNPS</option></select>
        <button className="btn sm">Show</button>
      </form>
      <Table head={["Survey", "Type", "Launched", "Responses", "Favourable", "eNPS"]} empty={points.length === 0}>
        {points.map((p, i) => (
          <tr key={p.s.id}>
            <td><Link href={`/engage/surveys/${p.s.id}`}>{p.s.title}</Link></td><td>{p.s.kind}</td><td>{fmtDay(p.s.launchedAt)}</td><td>{p.n}</td>
            <td>{p.favourable === null ? "—" : `${p.favourable}%${sign(favDelta[i] ?? null)}`}</td>
            <td>{p.enps === null ? "—" : `${p.enps}${sign(npsDelta[i] ?? null)}`}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Settings({ tenantId }: { tenantId: string }) {
  const s = await engageSettings(tenantId);
  return (
    <div className="stack gap-4">
      <Callout title="Approval before launch">With approval on, a survey or poll is submitted for approval and launches automatically once another survey manager approves it (Inbox › Approvals). Route it differently under Admin › Workflows.</Callout>
      <Card title="Survey settings">
        <SpecForm action={saveEngageSettingsAction} hidden={{ scope: "surveys" }} submitLabel="Save" fields={[
          { name: "surveyApproval", label: "Approval", type: "checkbox", placeholder: "Surveys and polls need approval before they go live", defaultValue: s.surveyApproval },
          { name: "surveyRetentionDays", label: "Delete responses this many days after a survey closes", type: "number", defaultValue: s.surveyRetentionDays, hint: "0 keeps them; minimum 30. Runs nightly; participation counts are kept." },
        ]} />
      </Card>
      <Card title="Data retention" description={s.surveyRetentionDays ? `Responses are deleted ${s.surveyRetentionDays} days after a survey closes.` : "No retention period is set; responses are kept."}>
        <ActButton action={applySurveyRetentionAction} hidden={{}} label="Apply retention now" variant="danger" confirmText="Delete responses of surveys past the retention period? This cannot be undone." />
      </Card>
    </div>
  );
}
