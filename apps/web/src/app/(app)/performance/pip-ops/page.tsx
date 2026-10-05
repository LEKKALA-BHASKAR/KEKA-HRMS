import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeIds } from "@/lib/scope";
import { runDataset } from "@/lib/insight/datasets";
import { coachingTimeline } from "@/lib/insight/timeline";
import { userNames, fmtDate, employeeOptions } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, Table, Pill } from "@/components/gov-ui";
import { InsightTableView } from "@/components/insight-table";
import { Timeline } from "@/components/timeline";
import {
  savePipSettingAction, savePipTemplateAction, startPipFromTemplateAction, startCoachingFromTemplateAction, logBehaviourAction, runInsightJobAction,
} from "@/app/actions/insight-performance";

export const metadata = { title: "PIP operations" };
const TABS = { register: "Register", risk: "Performance risk", checkins: "Check-in report", requests: "Requests", templates: "Templates", coaching: "Coaching", settings: "Eligibility & checklist" };
type Tab = keyof typeof TABS;
type SP = Record<string, string | undefined>;

/**
 * Performance › PIP operations: the plan register, the performance-risk
 * report, the check-in report, PIP requests awaiting approval, PIP and
 * coaching templates (and starting from them), coaching behaviour logs and
 * timelines with reminders, and the eligibility and checklist rules.
 */
export default async function PipOpsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const manage = can(viewer, P.PIP_MANAGE);
  const sp = await searchParams;
  if (!manage && !viewer.allReportIds.size) forbidden();
  const tabs = manage ? TABS : { risk: TABS.risk, coaching: TABS.coaching };
  const tab: Tab = (sp.tab as Tab) in tabs ? (sp.tab as Tab) : manage ? "register" : "risk";
  const scope = manage ? await scopedEmployeeIds(viewer, P.PIP_MANAGE) : [...viewer.allReportIds];
  const inScope = (id: string) => scope === null || scope.includes(id);
  return (
    <>
      <PageHead title="PIP operations" subtitle="Improvement plans and coaching: register, risk, templates, requests and rules" actions={<Link className="btn sm" href="/performance/plans">Improvement plans</Link>} />
      <Tabs base="/performance/pip-ops" tabs={tabs} active={tab} />

      {tab === "register" ? (
        <Card title="Improvement plan register" description="Every plan with objectives met, checklist progress, risk and behaviour trend.">
          <InsightTableView table={await runDataset(viewer, "pip-register")} ds="pip-register" extra={(r) => <Link className="btn sm" href={`/performance/plans/${r.id}`}>Open</Link>} />
        </Card>
      ) : null}
      {tab === "risk" ? (
        <Card title="Performance risk" description="People whose ratings, goals, check-ins and feedback point to a risk — before a plan is needed.">
          <InsightTableView table={await runDataset(viewer, "perf-risk", { all: sp.all })} ds="perf-risk" params={{ all: sp.all }} />
          <div className="row gap-2" style={{ marginTop: 8 }}>{sp.all ? <Link className="btn sm" href="/performance/pip-ops?tab=risk">Only people at risk</Link> : <Link className="btn sm" href="/performance/pip-ops?tab=risk&all=1">Show everyone</Link>}</div>
        </Card>
      ) : null}
      {tab === "checkins" ? (
        <Card title="Plan check-in report"><InsightTableView table={await runDataset(viewer, "pip-checkins")} ds="pip-checkins" /></Card>
      ) : null}
      {tab === "requests" ? await (async () => {
        const reqs = await prisma.insightPipRequest.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 300 });
        const pips = new Map((await prisma.improvementPlan.findMany({ where: { id: { in: reqs.map((r) => r.pipId) } }, include: { employee: { select: { displayName: true } } } })).map((p) => [p.id, p]));
        const names = await userNames(viewer.tenantId, reqs.map((r) => r.requestedBy));
        const rows = reqs.filter((r) => { const p = pips.get(r.pipId); return p && inScope(p.employeeId); });
        return (
          <Card title="Plan requests" description="Extensions, escalations and check-in sign-offs. Decide them in Inbox › Approvals.">
            <Table head={["Asked", "Employee", "Request", "Reason", "By", "Status", ""]} empty={!rows.length}>
              {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{pips.get(r.pipId)?.employee.displayName}</td><td>{r.kind.toLowerCase().replace("_", " ")}{r.days ? ` · ${r.days} days` : ""}</td><td className="text-sm">{r.reason}</td><td className="text-sm">{names.get(r.requestedBy) ?? ""}</td><td><Pill s={r.status} /></td><td><Link className="btn sm" href={`/performance/plans/${r.pipId}`}>Plan</Link></td></tr>)}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "templates" ? await (async () => {
        const [templates, people] = await Promise.all([
          prisma.insightPipTemplate.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ kind: "asc" }, { name: "asc" }] }),
          employeeOptions(viewer.tenantId),
        ]);
        const opts = people.filter((p) => inScope(p.value) && p.value !== viewer.employee?.id);
        const live = (k: string) => templates.filter((t) => t.kind === k && t.isActive).map((t) => ({ value: t.id, label: t.name }));
        return (
          <>
            <Card title="Templates" description="PIP templates carry the reason, objectives, milestones and checklist; coaching templates the focus, goals and session rhythm.">
              <Table head={["Template", "Kind", "Duration", "Milestones", "Checklist", "Active", ""]} empty={!templates.length}>
                {templates.map((t) => <tr key={t.id}><td>{t.name}{t.reason ? <div className="text-xs muted">{t.reason}</div> : null}</td><td><Badge tone={t.kind === "PIP" ? "warning" : "info"}>{t.kind.toLowerCase()}</Badge></td><td className="num">{t.durationDays} d</td><td className="num">{Array.isArray(t.milestones) ? t.milestones.length : 0}</td><td className="num">{t.checklist.length}</td><td>{t.isActive ? "Yes" : "No"}</td>
                  <td><ActButton action={savePipTemplateAction} hidden={{ id: t.id, kind: t.kind, name: t.name, durationDays: String(t.durationDays), reason: t.reason ?? "", objectives: t.objectives ?? "", checklist: t.checklist.join("\n"), milestones: (Array.isArray(t.milestones) ? (t.milestones as Array<{ title: string; offsetDays: number }>) : []).map((m) => `${m.title} @ ${m.offsetDays}`).join("\n"), sessionEveryDays: t.sessionEveryDays === null ? "" : String(t.sessionEveryDays), isActive: t.isActive ? "" : "on" }} label={t.isActive ? "Retire" : "Restore"} variant="ghost" /></td></tr>)}
              </Table>
            </Card>
            <div className="grid grid-2">
              <Card title="Start a plan from a template" description="Eligibility rules are checked first.">
                <SpecForm action={startPipFromTemplateAction} columns={1} submitLabel="Start plan" fields={[
                  { name: "templateId", label: "Template", type: "select", options: live("PIP"), required: true },
                  { name: "employeeId", label: "Employee", type: "select", options: opts, required: true },
                  { name: "startDate", label: "Starts", type: "date" },
                  { name: "reason", label: "Reason (blank = the template's)", type: "textarea" },
                ]} />
              </Card>
              <Card title="Propose coaching from a template">
                <SpecForm action={startCoachingFromTemplateAction} columns={1} submitLabel="Propose coaching" fields={[
                  { name: "templateId", label: "Template", type: "select", options: live("COACHING"), required: true },
                  { name: "employeeId", label: "Coachee", type: "select", options: opts, required: true },
                  { name: "coachId", label: "Coach (blank = you)", type: "select", options: people },
                  { name: "startDate", label: "Starts", type: "date" },
                ]} />
              </Card>
            </div>
            <Card title="New template">
              <SpecForm action={savePipTemplateAction} columns={2} fields={[
                { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "PIP", label: "Improvement plan" }, { value: "COACHING", label: "Coaching" }] },
                { name: "name", label: "Name", required: true },
                { name: "durationDays", label: "Duration (days)", type: "number", defaultValue: 60 },
                { name: "sessionEveryDays", label: "Coaching: days between sessions", type: "number" },
                { name: "reason", label: "Reason / focus area", type: "textarea" },
                { name: "objectives", label: "Objectives / goals (one per line)", type: "textarea" },
                { name: "milestones", label: "Milestones (“title @ day”, one per line)", type: "textarea", placeholder: "First review @ 30" },
                { name: "checklist", label: "Checklist (one per line; “?” = optional)", type: "textarea" },
              ]} />
            </Card>
          </>
        );
      })() : null}
      {tab === "coaching" ? await (async () => {
        const plans = await prisma.coachingPlan.findMany({ where: { tenantId: viewer.tenantId, ...(manage && scope === null ? {} : { OR: [{ coachId: viewer.employee?.id ?? "__none__" }, { employeeId: { in: scope ?? [] } }] }) }, include: { employee: { select: { displayName: true } }, coach: { select: { displayName: true } }, sessions: { orderBy: { heldOn: "desc" }, take: 1 } }, orderBy: [{ status: "asc" }, { startDate: "desc" }] });
        const pick = plans.find((p) => p.id === sp.plan);
        const logs = pick ? await prisma.insightBehaviorLog.findMany({ where: { tenantId: viewer.tenantId, coachingPlanId: pick.id }, orderBy: { observedOn: "desc" } }) : [];
        const setting = await prisma.insightPipSetting.findUnique({ where: { tenantId: viewer.tenantId } });
        return (
          <>
            <Card title="Coaching plans" description={`Coaches are reminded when a live plan has had no session for ${setting?.coachingReminderDays ?? 14} days.`} action={manage ? <ActButton action={runInsightJobAction} hidden={{ job: "coaching" }} label="Send reminders now" /> : null}>
              <Table head={["Coachee", "Coach", "Focus", "Status", "Last session", ""]} empty={!plans.length}>
                {plans.map((p) => <tr key={p.id}><td>{p.employee.displayName}</td><td>{p.coach.displayName}</td><td className="text-sm">{p.focusArea}</td><td><Pill s={p.status} /></td><td>{fmtDate(p.sessions[0]?.heldOn)}</td><td><Link className="btn sm" href={`/performance/pip-ops?tab=coaching&plan=${p.id}`}>Behaviours · timeline</Link></td></tr>)}
              </Table>
            </Card>
            {pick ? (
              <div className="grid grid-2">
                <Card title={`Behaviours: ${pick.employee.displayName}`}>
                  <Table head={["Observed", "Behaviour", "Rating", "Note"]} empty={!logs.length}>
                    {logs.map((l) => <tr key={l.id}><td>{fmtDate(l.observedOn)}</td><td>{l.behaviour}</td><td>{l.rating}/5</td><td className="text-sm">{l.note}</td></tr>)}
                  </Table>
                  <div style={{ marginTop: 12 }}><SpecForm action={logBehaviourAction} hidden={{ coachingPlanId: pick.id }} columns={2} submitLabel="Log" fields={[
                    { name: "behaviour", label: "Behaviour", required: true }, { name: "rating", label: "Rating (1–5)", type: "number", required: true },
                    { name: "observedOn", label: "Observed on", type: "date" }, { name: "note", label: "Note" },
                  ]} /></div>
                </Card>
                <Card title="Coaching timeline"><Timeline events={await coachingTimeline(viewer.tenantId, pick.employeeId)} /></Card>
              </div>
            ) : null}
          </>
        );
      })() : null}
      {tab === "settings" ? await (async () => {
        const s = await prisma.insightPipSetting.findUnique({ where: { tenantId: viewer.tenantId } });
        return (
          <Card title="Eligibility and completion rules" description="Who can be placed on a plan, and the checklist every new plan starts with.">
            <SpecForm action={savePipSettingAction} columns={3} fields={[
              { name: "minTenureDays", label: "Minimum tenure (days)", type: "number", defaultValue: s?.minTenureDays ?? 90 },
              { name: "maxRating", label: "Only if last rating is at most", type: "number", defaultValue: s?.maxRating === null || s?.maxRating === undefined ? "" : Number(s.maxRating) },
              { name: "coachingReminderDays", label: "Coaching reminder after (days)", type: "number", defaultValue: s?.coachingReminderDays ?? 14 },
              { name: "blockProbation", label: "Not during probation", type: "checkbox", defaultValue: s?.blockProbation ?? true },
              { name: "blockNotice", label: "Not while serving notice", type: "checkbox", defaultValue: s?.blockNotice ?? true },
              { name: "requireChecklist", label: "Checklist must be done to close", type: "checkbox", defaultValue: s?.requireChecklist ?? true },
              { name: "defaultChecklist", label: "Default checklist (one per line; “?” = optional)", type: "textarea", defaultValue: (s?.defaultChecklist ?? []).join("\n") },
            ]} />
          </Card>
        );
      })() : null}
    </>
  );
}
