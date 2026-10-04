import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS, WORKFLOW_ENTITY_TYPES, parseActions } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { departmentOptions, locationOptions, employeeOptions, userOptions, fmtWhen } from "@/lib/governance";
import { PageHead, Card } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { AutomationEditor, ActButton, SpecForm, type ActionRow } from "@/components/gov-forms";
import { saveAutomationRuleAction, automationRuleOpAction, retryAutomationRunAction } from "@/app/actions/workflows";

export default async function AutomationRulePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.WORKFLOW_MANAGE);
  const { id } = await params;
  const t = viewer.tenantId;
  const rule = id === "new" ? null : await prisma.automationRule.findFirst({ where: { id, tenantId: t } });
  if (id !== "new" && !rule) notFound();
  const [departments, locations, employees, users, endpoints, templates, runs] = await Promise.all([
    departmentOptions(t), locationOptions(t), employeeOptions(t), userOptions(t),
    prisma.webhookEndpoint.findMany({ where: { tenantId: t, approvalStatus: "APPROVED" }, select: { id: true, url: true } }),
    prisma.documentTemplate.findMany({ where: { tenantId: t, isArchived: false }, select: { id: true, name: true } }),
    rule ? prisma.automationRun.findMany({ where: { ruleId: rule.id }, orderBy: { createdAt: "desc" }, take: 50 }) : Promise.resolve([]),
  ]);
  const actions: ActionRow[] = rule ? parseActions(rule.actions).map((a) => ({ type: a.type, to: a.to ?? "", subject: a.subject ?? "", body: a.body ?? "", endpointId: a.endpointId ?? "", templateId: a.templateId ?? "", dueInDays: a.dueInDays !== undefined ? String(a.dueInDays) : "" })) : [];
  return (
    <>
      <PageHead title={rule ? rule.name : "New automation rule"} subtitle={rule ? <Pill s={rule.status} /> : "When something happens, do something"} actions={<Link className="btn" href="/admin/workflows?tab=automation">All rules</Link>} />
      <div className="stack gap-4">
        {rule ? (
          <Card title="Status" description="Rules are activated through an approval; editing an active rule puts it back to draft.">
            <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
              {rule.status === "DRAFT" || rule.status === "PAUSED" ? <ActButton action={automationRuleOpAction} hidden={{ id: rule.id, op: "submit" }} label="Submit for activation" variant="primary" /> : null}
              {rule.status === "ACTIVE" ? <ActButton action={automationRuleOpAction} hidden={{ id: rule.id, op: "pause" }} label="Pause" /> : null}
              <ActButton action={automationRuleOpAction} hidden={{ id: rule.id, op: "delete" }} label="Delete" variant="ghost" confirmText="Delete this rule and its run log?" />
            </div>
            <div style={{ marginTop: 12, maxWidth: 420 }}>
              <SpecForm action={automationRuleOpAction} hidden={{ id: rule.id, op: "test" }} submitLabel="Test: run once now" columns={1} fields={[{ name: "employeeId", label: "Run the actions for", type: "select", options: employees, required: true }]} />
            </div>
          </Card>
        ) : null}
        <Card title={rule ? "Edit rule" : "Rule"}>
          <AutomationEditor action={saveAutomationRuleAction} hidden={rule ? { id: rule.id } : undefined} initialActions={actions}
            header={[
              { name: "name", label: "Name", required: true, defaultValue: rule?.name },
              { name: "trigger", label: "When", type: "select", required: true, options: Object.entries(AUTOMATION_TRIGGERS).map(([value, label]) => ({ value, label })), defaultValue: rule?.trigger },
              { name: "offsetDays", label: "Days (date triggers)", type: "number", defaultValue: rule?.offsetDays ?? 0, hint: "Days before the date; negative for after" },
              { name: "departmentId", label: "Only department", type: "select", options: departments, defaultValue: rule?.departmentId, placeholder: "Any" },
              { name: "locationId", label: "Only location", type: "select", options: locations, defaultValue: rule?.locationId, placeholder: "Any" },
              { name: "entityType", label: "Request type (request triggers)", type: "select", options: Object.entries(WORKFLOW_ENTITY_TYPES).map(([value, label]) => ({ value, label })), defaultValue: rule?.entityType, placeholder: "Any" },
              { name: "description", label: "Description", wide: true, defaultValue: rule?.description },
            ]}
            options={{
              types: Object.entries(AUTOMATION_ACTIONS).map(([value, label]) => ({ value, label })),
              recipients: [{ value: "EMPLOYEE", label: "The employee" }, { value: "MANAGER", label: "Their manager" }, { value: "HR", label: "HR" }, ...users.map((u) => ({ value: `USER:${u.value}`, label: u.label }))],
              endpoints: endpoints.map((e) => ({ value: e.id, label: e.url })), templates: templates.map((x) => ({ value: x.id, label: x.name })),
            }} />
        </Card>
        {rule ? (
          <Card tight title="Run log">
            <Table head={["When", "Subject", "Status", "Actions run", "Detail", ""]} empty={runs.length === 0}>
              {runs.map((r) => <tr key={r.id}><td className="text-xs">{fmtWhen(r.createdAt)}</td><td className="text-xs mono">{r.subjectType} {r.dedupeKey.slice(0, 40)}</td><td><Pill s={r.status} /></td><td className="num">{r.actionsRun}</td><td className="text-xs">{r.error ?? ((r.detail as { done?: string[] } | null)?.done ?? []).join(", ")}</td><td>{r.status !== "SUCCESS" && r.status !== "RUNNING" ? <ActButton action={retryAutomationRunAction} hidden={{ id: r.id }} label="Retry" /> : null}</td></tr>)}
            </Table>
          </Card>
        ) : null}
      </div>
    </>
  );
}

