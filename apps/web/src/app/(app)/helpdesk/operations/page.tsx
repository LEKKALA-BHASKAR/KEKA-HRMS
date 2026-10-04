import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import {
  helpdeskScopeWhere, helpdeskAgingReport, TICKET_PRIORITIES, TICKET_PRIORITY_LABEL, TICKET_SEVERITIES, ESCALATION_TRIGGERS, CASE_CHANNELS,
} from "@keka/services";
import { userOptions, userNames, employeeOptions, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Stat } from "@/components/ui";
import { Tabs, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  saveSlaPolicyAction, saveTriageRuleAction, saveEscalationRuleAction, saveCaseTemplateAction, logCaseAction, acknowledgeEscalationAction,
} from "@/app/actions/helpdesk-ops";
import { requireHelpdeskAgent } from "../_ui/access";
import { HelpdeskTabs } from "../_ui/tabs";
import { categoryOptions } from "../_ui/data";

export const metadata = { title: "Helpdesk operations" };
const TABS = { log: "Log a case", escalations: "Escalations", aging: "Aging", sla: "SLA by priority", triage: "Triage rules", rules: "Escalation rules", templates: "Case templates" };
type Tab = keyof typeof TABS;
const PRIORITY_OPTS = TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] ?? p }));
const SEVERITY_OPTS = Object.entries(TICKET_SEVERITIES).map(([value, label]) => ({ value, label }));
const ESCALATE_TO = [{ value: "CATEGORY_HEAD", label: "Category head" }, { value: "ASSIGNEE_MANAGER", label: "Assignee's manager" }, { value: "USER", label: "A named person" }];

/**
 * Org › Helpdesk › Operations: logging cases on an employee's behalf,
 * the escalation queue, the aging report and (for settings holders) the
 * per-priority SLA, keyword triage, escalation rules and case templates.
 */
export default async function HelpdeskOperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { viewer, scope, canSettings } = await requireHelpdeskAgent();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "log";
  const t = viewer.tenantId;
  const cats = await categoryOptions(t);
  const catOpts = cats.map((c) => ({ value: c.value, label: `${c.depth ? "— " : ""}${c.label}` }));
  const catName = new Map(cats.map((c) => [c.value, c.label]));
  const readOnly = !canSettings ? <p className="muted text-sm" style={{ marginTop: 8 }}>Only helpdesk settings holders can change these rules.</p> : null;
  return (
    <>
      <PageHead title="Helpdesk operations" subtitle="Cases logged for employees, escalations, aging and the rules behind them" />
      <HelpdeskTabs canSettings={canSettings} />
      <Tabs base="/helpdesk/operations" tabs={TABS} active={tab} />

      {tab === "log" ? <LogCase tenantId={t} catOpts={catOpts} /> : null}
      {tab === "escalations" ? <Escalations tenantId={t} where={helpdeskScopeWhere(scope)} userId={viewer.user.id} /> : null}
      {tab === "aging" ? <Aging tenantId={t} where={helpdeskScopeWhere(scope)} /> : null}

      {tab === "sla" ? (
        <Card title="Targets by priority" description="Overrides the category's own targets for tickets of that priority. A rule for a specific category beats one for every category.">
          <SlaTable tenantId={t} catName={catName} canSettings={canSettings} />
          {canSettings ? <div style={{ marginTop: 12 }}><SpecForm action={saveSlaPolicyAction} submitLabel="Save target" columns={2} fields={[
            { name: "priority", label: "Priority", type: "select", required: true, options: PRIORITY_OPTS },
            { name: "categoryId", label: "Category", type: "select", options: catOpts, placeholder: "Every category" },
            { name: "firstResponseHours", label: "First response (hours)", type: "number", required: true },
            { name: "resolutionHours", label: "Resolution (hours)", type: "number", required: true },
          ]} /></div> : readOnly}
        </Card>
      ) : null}

      {tab === "triage" ? (
        <Card title="Keyword triage" description="When a ticket is raised, any rule whose keyword appears in the subject or description sets its priority and severity. The highest wins.">
          <TriageTable tenantId={t} catName={catName} />
          {canSettings ? <div style={{ marginTop: 12 }}><SpecForm action={saveTriageRuleAction} submitLabel="Save rule" fields={[
            { name: "name", label: "Name", required: true },
            { name: "keywords", label: "Keywords", required: true, placeholder: "harassment, unsafe, threat" },
            { name: "categoryId", label: "Only in category", type: "select", options: catOpts, placeholder: "Every category" },
            { name: "setPriority", label: "Set priority", type: "select", options: PRIORITY_OPTS },
            { name: "setSeverity", label: "Set severity", type: "select", options: SEVERITY_OPTS },
          ]} /></div> : readOnly}
        </Card>
      ) : null}

      {tab === "rules" ? (
        <Card title="Escalation rules" description="Checked every night and whenever the queue loads. A ticket moves up a level when it meets the trigger for the stated hours.">
          <RulesTable tenantId={t} catName={catName} />
          {canSettings ? <div style={{ marginTop: 12 }}><SpecForm action={saveEscalationRuleAction} submitLabel="Save rule" fields={[
            { name: "name", label: "Name", required: true },
            { name: "trigger", label: "When", type: "select", required: true, options: Object.entries(ESCALATION_TRIGGERS).map(([value, label]) => ({ value, label })) },
            { name: "afterHours", label: "After (hours)", type: "number", defaultValue: 0 },
            { name: "level", label: "Escalation level", type: "number", defaultValue: 1 },
            { name: "categoryId", label: "Category", type: "select", options: catOpts, placeholder: "Every category" },
            { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTS, placeholder: "Every priority" },
            { name: "escalateTo", label: "Escalate to", type: "select", required: true, options: ESCALATE_TO },
            { name: "escalateUserId", label: "Named person", type: "select", options: await userOptions(t) },
            { name: "raisePriority", label: "Raise priority to", type: "select", options: PRIORITY_OPTS },
            { name: "reassign", label: "Reassign", type: "checkbox", placeholder: "Reassign the ticket to that person" },
          ]} /></div> : readOnly}
        </Card>
      ) : null}

      {tab === "templates" ? (
        <Card title="Case templates" description="Pre-filled cases with a task checklist, for requests agents log often.">
          <TemplatesTable tenantId={t} catName={catName} />
          {canSettings ? <div style={{ marginTop: 12 }}><SpecForm action={saveCaseTemplateAction} submitLabel="Save template" fields={[
            { name: "name", label: "Name", required: true },
            { name: "categoryId", label: "Category", type: "select", required: true, options: catOpts },
            { name: "subject", label: "Subject", required: true },
            { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTS },
            { name: "description", label: "Description", type: "textarea", required: true, wide: true },
            { name: "tasks", label: "Tasks (one per line)", type: "textarea", wide: true },
          ]} /></div> : readOnly}
        </Card>
      ) : null}
    </>
  );
}

async function LogCase({ tenantId, catOpts }: { tenantId: string; catOpts: Array<{ value: string; label: string }> }) {
  const [employees, templates, recent] = await Promise.all([
    employeeOptions(tenantId),
    prisma.helpdeskCaseTemplate.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.helpdeskTicket.findMany({ where: { tenantId, loggedByUserId: { not: null } }, orderBy: { createdAt: "desc" }, take: 15, include: { employee: { select: { displayName: true } } } }),
  ]);
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Log a case for an employee" description="For requests that arrive by phone, email or in person. Pick a template, or a category and describe it.">
        <SpecForm action={logCaseAction} submitLabel="Log case" fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, options: employees },
          { name: "channel", label: "Received via", type: "select", required: true, options: Object.entries(CASE_CHANNELS).map(([value, label]) => ({ value, label })) },
          { name: "templateId", label: "Template", type: "select", options: templates.map((x) => ({ value: x.id, label: x.name })) },
          { name: "categoryId", label: "Category", type: "select", options: catOpts },
          { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTS },
          { name: "subject", label: "Subject" },
          { name: "description", label: "Description", type: "textarea", wide: true },
        ]} />
      </Card>
      <Card title="Recently logged by agents">
        <Table head={["Ticket", "Employee", "Via", "Logged"]} empty={!recent.length}>
          {recent.map((r) => <tr key={r.id}><td><Link href={`/helpdesk/tickets/${r.id}`}>#{r.number}</Link> {r.subject}</td><td>{r.employee.displayName}</td><td>{CASE_CHANNELS[r.channel as keyof typeof CASE_CHANNELS] ?? r.channel}</td><td>{fmtWhen(r.createdAt)}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

async function Escalations({ tenantId, where, userId }: { tenantId: string; where: Prisma.HelpdeskTicketWhereInput; userId: string }) {
  const rows = await prisma.helpdeskTicketEscalation.findMany({
    where: { tenantId, ticket: where }, orderBy: { createdAt: "desc" }, take: 100,
    include: { ticket: { select: { id: true, number: true, subject: true, status: true } }, rule: { select: { name: true } } },
  });
  const names = await userNames(tenantId, rows.flatMap((r) => [r.escalatedToUserId, r.byUserId]));
  const open = rows.filter((r) => !r.acknowledgedAt);
  return (
    <>
      <div className="grid grid-3"><Stat label="Awaiting acknowledgement" value={open.length} /><Stat label="Mine to acknowledge" value={open.filter((r) => r.escalatedToUserId === userId).length} /><Stat label="Last 100 escalations" value={rows.length} /></div>
      <Card title="Escalations">
        <Table head={["Ticket", "Level", "Why", "To", "When", ""]} empty={!rows.length}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/helpdesk/tickets/${r.ticket.id}`}>#{r.ticket.number}</Link> {r.ticket.subject}</td>
              <td className="num">L{r.level}</td>
              <td className="text-sm">{r.reason}{r.rule ? ` (rule: ${r.rule.name})` : r.byUserId ? ` (by ${names.get(r.byUserId)})` : ""}</td>
              <td>{r.escalatedToUserId ? names.get(r.escalatedToUserId) : "—"}</td>
              <td>{fmtWhen(r.createdAt)}</td>
              <td>{r.acknowledgedAt ? <span className="muted text-xs">Acknowledged {fmtWhen(r.acknowledgedAt)}</span> : <ActButton action={acknowledgeEscalationAction} hidden={{ escalationId: r.id }} label="Acknowledge" />}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

async function Aging({ tenantId, where }: { tenantId: string; where: Prisma.HelpdeskTicketWhereInput }) {
  const rep = await helpdeskAgingReport(tenantId, where);
  return (
    <Card title="Open tickets by age" description="Days since the ticket was raised, by category." >
      <div style={{ marginBottom: 8 }}><a className="btn sm" href="/helpdesk/operations/export">Download CSV</a></div>
      <Table head={["Category", ...rep.buckets, "Total"]} empty={!rep.rows.length}>
        {rep.rows.map((r) => <tr key={r.category}><td>{r.category}</td>{rep.buckets.map((b) => <td key={b} className="num">{r.counts[b] || ""}</td>)}<td className="num"><strong>{r.total}</strong></td></tr>)}
      </Table>
    </Card>
  );
}

async function SlaTable({ tenantId, catName, canSettings }: { tenantId: string; catName: Map<string, string>; canSettings: boolean }) {
  const rows = await prisma.helpdeskSlaPolicy.findMany({ where: { tenantId }, orderBy: [{ categoryId: "asc" }, { priority: "asc" }] });
  return (
    <Table head={["Category", "Priority", "First response", "Resolution", ""]} empty={!rows.length}>
      {rows.map((r) => <tr key={r.id}><td>{r.categoryId ? catName.get(r.categoryId) ?? "—" : "Every category"}</td><td>{TICKET_PRIORITY_LABEL[r.priority] ?? r.priority}</td><td className="num">{r.firstResponseHours}h</td><td className="num">{r.resolutionHours}h</td><td>{canSettings ? <ActButton action={saveSlaPolicyAction} hidden={{ id: r.id, delete: "1" }} label="Remove" variant="ghost" /> : null}</td></tr>)}
    </Table>
  );
}

async function TriageTable({ tenantId, catName }: { tenantId: string; catName: Map<string, string> }) {
  const rows = await prisma.helpdeskTriageRule.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return (
    <Table head={["Rule", "Keywords", "Category", "Priority", "Severity", "Active"]} empty={!rows.length}>
      {rows.map((r) => <tr key={r.id}><td>{r.name}</td><td className="text-sm">{r.keywords}</td><td>{r.categoryId ? catName.get(r.categoryId) ?? "—" : "Every"}</td><td>{r.setPriority ? TICKET_PRIORITY_LABEL[r.setPriority] : "—"}</td><td>{r.setSeverity ?? "—"}</td><td>{r.isActive ? "Yes" : "No"}</td></tr>)}
    </Table>
  );
}

async function RulesTable({ tenantId, catName }: { tenantId: string; catName: Map<string, string> }) {
  const rows = await prisma.helpdeskEscalationRule.findMany({ where: { tenantId }, orderBy: [{ level: "asc" }, { name: "asc" }] });
  const names = await userNames(tenantId, rows.map((r) => r.escalateUserId));
  return (
    <Table head={["Rule", "When", "After", "Level", "Scope", "To", "Active"]} empty={!rows.length}>
      {rows.map((r) => (
        <tr key={r.id}>
          <td>{r.name}</td><td>{ESCALATION_TRIGGERS[r.trigger as keyof typeof ESCALATION_TRIGGERS] ?? r.trigger}</td><td className="num">{r.afterHours}h</td><td className="num">L{r.level}</td>
          <td className="text-sm">{r.categoryId ? catName.get(r.categoryId) ?? "—" : "Every category"} · {r.priority ? TICKET_PRIORITY_LABEL[r.priority] : "any priority"}</td>
          <td>{r.escalateTo === "USER" ? (r.escalateUserId ? names.get(r.escalateUserId) : "—") : ESCALATE_TO.find((e) => e.value === r.escalateTo)?.label}{r.reassign ? " (reassigns)" : ""}</td>
          <td>{r.isActive ? "Yes" : "No"}</td>
        </tr>
      ))}
    </Table>
  );
}

async function TemplatesTable({ tenantId, catName }: { tenantId: string; catName: Map<string, string> }) {
  const rows = await prisma.helpdeskCaseTemplate.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  return (
    <Table head={["Template", "Category", "Subject", "Tasks", "Active"]} empty={!rows.length}>
      {rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{catName.get(r.categoryId) ?? "—"}</td><td>{r.subject}</td><td className="num">{Array.isArray(r.tasks) ? r.tasks.length : 0}</td><td>{r.isActive ? "Yes" : "No"}</td></tr>)}
    </Table>
  );
}
