import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, PERMISSION_GROUPS } from "@keka/rbac";
import {
  APPROVER_TYPES, CONDITION_FIELDS, CONDITION_OPS, WORKFLOW_ENTITY_TYPES, GENERIC_REQUEST_CATEGORIES, simulateWorkflow,
  type ValidationRule, type WorkflowEntityType,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { userOptions, roleOptions, departmentOptions, locationOptions, employeeOptions, userNames, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { WorkflowDesigner, type StepRow } from "@/components/gov-forms";
import { saveWorkflowAction } from "@/app/actions/workflows";

/** Create or edit a workflow (new versions on edit once used), its versions, and simulation. */
export default async function WorkflowDefinitionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.WORKFLOW_MANAGE);
  const { id } = await params;
  const sp = await searchParams;
  const t = viewer.tenantId;
  const def = id === "new" ? null : await prisma.workflowDefinition.findFirst({ where: { id, tenantId: t }, include: { steps: { orderBy: { order: "asc" } } } });
  if (id !== "new" && !def) notFound();
  const [users, roles, departments, locations, employees] = await Promise.all([userOptions(t), roleOptions(t), departmentOptions(t), locationOptions(t), employeeOptions(t)]);
  const permissions = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => ({ value: p.key, label: `${g.label}: ${p.label}` })));
  const versions = def ? await prisma.workflowDefinition.findMany({ where: { tenantId: t, family: def.family }, orderBy: { version: "desc" }, include: { _count: { select: { requests: true } } } }) : [];
  const v = (def?.validations as ValidationRule[] | null) ?? [];
  const steps: StepRow[] = (def?.steps ?? []).map((s) => ({
    name: s.name, approverType: s.approverType, approverRoleId: s.approverRoleId ?? "", approverUserId: s.approverUserId ?? "", approverPermission: s.approverPermission ?? "",
    mode: s.mode, conditionField: s.conditionField ?? "", conditionOp: s.conditionOp ?? "", conditionValue: s.conditionValue ?? "", slaHours: s.slaHours ? String(s.slaHours) : "",
    escalateTo: s.escalateTo ?? "", escalateUserId: s.escalateUserId ?? "",
  }));

  let sim: Awaited<ReturnType<typeof simulateWorkflow>> | null = null;
  if (def && sp.simulate) {
    const emp = sp.employeeId ? await prisma.employee.findFirst({ where: { id: sp.employeeId, tenantId: t }, select: { id: true, userId: true } }) : null;
    sim = await simulateWorkflow({
      tenantId: t, entityType: def.entityType as WorkflowEntityType, requesterUserId: emp?.userId ?? viewer.user.id, subjectEmployeeId: emp?.id ?? null,
      amount: sp.amount ? Number(sp.amount) : null, category: sp.category || null, privileged: sp.privileged === "on", definitionId: def.id,
    });
  }
  const simNames = sim ? await userNames(t, sim.steps.flatMap((s) => s.approvers.flatMap((a) => [a.userId, a.delegatedFrom]))) : new Map();

  return (
    <>
      <PageHead title={def ? `${def.name} · v${def.version}` : "New workflow"} subtitle={def ? WORKFLOW_ENTITY_TYPES[def.entityType as WorkflowEntityType] : "An approval route for one request type"}
        actions={<Link className="btn" href="/admin/workflows">All workflows</Link>} />
      {def && !def.isCurrent ? <Callout tone="warning" title="An earlier version">This version is kept for the requests that ran on it. Edit the current version instead.</Callout> : null}
      <div className="stack gap-4">
        {!def || def.isCurrent ? (
          <Card title={def ? "Edit" : "Design"} description={def && versions.some((x) => x.id === def.id && x._count.requests > 0) ? "This version has routed requests, so saving publishes a new version; running requests keep this one." : "Steps run in order. Approvers are resolved when a step starts; nobody approves their own request."}>
            <WorkflowDesigner action={saveWorkflowAction} hidden={def ? { id: def.id } : undefined} initialSteps={steps}
              header={[
                { name: "name", label: "Name", required: true, defaultValue: def?.name },
                { name: "entityType", label: "Approves", type: "select", required: true, options: Object.entries(WORKFLOW_ENTITY_TYPES).map(([value, label]) => ({ value, label })), defaultValue: def?.entityType ?? sp.type },
                { name: "priority", label: "Priority", type: "number", defaultValue: def?.priority ?? 0, hint: "Higher wins between equally specific workflows" },
                { name: "matchDepartmentId", label: "Only for department", type: "select", options: departments, defaultValue: def?.matchDepartmentId, placeholder: "Any department" },
                { name: "matchLocationId", label: "Only for location", type: "select", options: locations, defaultValue: def?.matchLocationId, placeholder: "Any location" },
                { name: "isActive", label: "Active", type: "checkbox", defaultValue: def ? def.isActive : true, placeholder: "Route requests with this workflow" },
                { name: "requireAmount", label: "Validation", type: "checkbox", placeholder: "An amount is required", defaultValue: v.some((r) => r.field === "amount" && r.op === "REQUIRED") },
                { name: "maxAmount", label: "Maximum amount", type: "number", defaultValue: (v.find((r) => r.op === "MAX")?.value as number | undefined) ?? null },
                { name: "minDetails", label: "Minimum description length", type: "number", defaultValue: (v.find((r) => r.op === "MIN_LENGTH")?.value as number | undefined) ?? null },
                { name: "description", label: "Description", wide: true, defaultValue: def?.description },
              ]}
              options={{
                approverTypes: Object.entries(APPROVER_TYPES).map(([value, label]) => ({ value, label })), roles, users, permissions,
                conditionFields: Object.entries(CONDITION_FIELDS).map(([value, label]) => ({ value, label })),
                conditionOps: Object.entries(CONDITION_OPS).map(([value, label]) => ({ value, label })), departments, locations,
              }} />
          </Card>
        ) : null}
        {def ? (
          <>
            <Card title="Simulate" description="Who would approve, step by step, for a given employee and amount. Nothing is created.">
              <form method="get" className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
                <input type="hidden" name="simulate" value="1" />
                <div className="field"><label className="label">Requested by</label><select className="select" name="employeeId" defaultValue={sp.employeeId ?? ""}><option value="">Me</option>{employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select></div>
                <div className="field"><label className="label">Amount</label><input className="input num" name="amount" defaultValue={sp.amount ?? ""} style={{ width: 120 }} /></div>
                <div className="field"><label className="label">Category</label><select className="select" name="category" defaultValue={sp.category ?? ""}><option value="">—</option>{Object.entries(GENERIC_REQUEST_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <label className="row gap-2 text-sm"><input type="checkbox" name="privileged" defaultChecked={sp.privileged === "on"} /> Privileged</label>
                <button className="btn" type="submit">Simulate</button>
              </form>
              {sim ? (
                <div style={{ marginTop: 12 }}>
                  {sim.problems.length ? <Callout tone="warning" title="Would be refused">{sim.problems.join(" ")}</Callout> : null}
                  <Table head={["Step", "Runs?", "Decision", "Approvers"]}>
                    {sim.steps.map((s) => (
                      <tr key={s.order}>
                        <td>{s.order}. {s.name}</td><td>{s.applies ? <Pill s="ACTIVE" /> : <span className="text-xs muted">Skipped (condition)</span>}</td><td className="text-xs">{s.mode === "ALL" ? "All must approve" : "Any one"}</td>
                        <td className="text-sm">{s.applies ? (s.approvers.length ? s.approvers.map((a) => `${simNames.get(a.userId) ?? a.userId}${a.delegatedFrom ? ` (for ${simNames.get(a.delegatedFrom)})` : ""}`).join(", ") : "Passes automatically (nobody else can approve)") : "—"}{s.fallback ? <div className="text-xs muted">No approver resolved; workflow administrators decide.</div> : null}</td>
                      </tr>
                    ))}
                  </Table>
                </div>
              ) : null}
            </Card>
            <Card tight title="Versions">
              <Table head={["Version", "Created", "Retired", "Requests", ""]}>
                {versions.map((x) => <tr key={x.id}><td>v{x.version} {x.isCurrent ? <Pill s="ACTIVE" /> : null}</td><td className="text-xs">{fmtWhen(x.createdAt)}</td><td className="text-xs">{fmtWhen(x.supersededAt)}</td><td className="num">{x._count.requests}</td><td>{x.id !== def.id ? <Link href={`/admin/workflows/${x.id}`}>Open</Link> : "This one"}</td></tr>)}
              </Table>
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
