import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { EXPENSE_POLICY_TEMPLATES } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, ActButton, Reveal, type FieldSpec } from "@/components/growth-forms";
import { saveExpensePolicyAction, expensePolicyTemplateAction, expensePolicyOpAction } from "@/app/actions/expense-depth";

const TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = { ACTIVE: "success", PENDING_APPROVAL: "warning", DRAFT: "neutral", RETIRED: "neutral" };

/** Expense policies: scoped by department, location or band, approved before they apply, revised as drafts. */
export default async function ExpensePoliciesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; edit?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.EXPENSE_MANAGE);
  const sp = await searchParams;
  const q = sp.q?.trim() || null;
  const [policies, cats, depts, locs, bands, history] = await Promise.all([
    prisma.expensePolicy.findMany({ where: { tenantId: viewer.tenantId, ...(sp.status ? { status: sp.status } : {}), ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) }, include: { categories: { include: { category: true } } }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    prisma.expenseCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.band.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: "ExpensePolicy" }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  const name = (list: Array<{ id: string; name: string }>, id: string | null) => list.find((x) => x.id === id)?.name ?? null;
  const editing = policies.find((p) => p.id === sp.edit && p.status === "DRAFT");
  const fields = (p?: (typeof policies)[number]): FieldSpec[] => [
    { name: "name", label: "Policy name", required: true, defaultValue: p?.name },
    { name: "escalationAboveAmount", label: "Finance approval above (₹)", type: "number", defaultValue: p?.escalationAboveAmount === null || p?.escalationAboveAmount === undefined ? null : Number(p.escalationAboveAmount), hint: "Claims above this go to finance after the manager" },
    { name: "payrollCutoffDay", label: "Payroll cut-off day", type: "number", min: 1, max: 28, defaultValue: p?.payrollCutoffDay ?? null, hint: "Approved after this day: paid the month after" },
    { name: "departmentId", label: "Department", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })), defaultValue: p?.departmentId },
    { name: "locationId", label: "Location", type: "select", options: locs.map((d) => ({ value: d.id, label: d.name })), defaultValue: p?.locationId },
    { name: "bandId", label: "Band", type: "select", options: bands.map((d) => ({ value: d.id, label: d.name })), defaultValue: p?.bandId },
    ...cats.map((c): FieldSpec => {
      const cap = p?.categories.find((x) => x.categoryId === c.id)?.maxAmount;
      return { name: `cap_${c.id}`, label: `${c.name} cap (₹)`, type: "number", defaultValue: cap === null || cap === undefined ? null : Number(cap) };
    }),
    { name: "description", label: "Description", type: "textarea", defaultValue: p?.description },
    { name: "allowFutureDated", label: "Allow future-dated expenses", type: "checkbox", defaultChecked: p?.allowFutureDated },
    { name: "isDefault", label: "Default policy (when no scoped policy matches)", type: "checkbox", defaultChecked: p?.isDefault },
  ];
  return (
    <>
      <PageHead title="Expense policies" subtitle="Who a policy covers, its limits, approval thresholds and payroll cut-off. Changes are approved through the workflow before they apply."
        actions={<><Link className="btn" href="/expenses/rates">Rates</Link><Link className="btn" href="/expenses?tab=policy">Categories</Link><Link className="btn" href="/admin/workflows">Approval routes</Link></>} />
      <Callout title="How a policy is chosen">The most specific active policy wins: department, then location, then band, then the default. A submitted policy waits in Approvals; an active policy is changed by opening a revision, which replaces it once approved.</Callout>
      <div className="grid grid-2" style={{ marginTop: 12, alignItems: "start" }}>
        <Card title="Start from a template" description="Caps are filled in for categories with matching names.">
          <GrowthForm action={expensePolicyTemplateAction} submitLabel="Create draft" cols={2} fields={[
            { name: "templateKey", label: "Template", type: "select", required: true, options: Object.entries(EXPENSE_POLICY_TEMPLATES).map(([k, t]) => ({ value: k, label: `${t.name} — ${t.description}` })) },
            { name: "name", label: "Name (optional)" },
          ]} />
        </Card>
        <Card title={editing ? `Edit ${editing.name}` : "New policy"}>
          <Reveal label={editing ? "Edit draft" : "New policy"} open={!!editing}>
            <GrowthForm action={saveExpensePolicyAction} hidden={editing ? { id: editing.id } : undefined} fields={fields(editing)} cols={2} submitLabel={editing ? "Save draft" : "Save as draft"} />
          </Reveal>
        </Card>
      </div>
      <form className="row gap-2" style={{ margin: "12px 0" }}>
        <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search policies" style={{ maxWidth: 260 }} />
        <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ maxWidth: 200 }}><option value="">Any status</option>{["DRAFT", "PENDING_APPROVAL", "ACTIVE", "RETIRED"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}</select>
        <button className="btn">Filter</button>
      </form>
      <Card tight title={`Policies (${policies.length})`}>
        {policies.length === 0 ? <Empty title="No policies match" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Policy</th><th>Applies to</th><th>Finance above</th><th>Cut-off</th><th>Caps</th><th>Status</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td><div className="strong text-sm">{p.name}</div><div className="text-xs subtle">{p.description ?? ""}{p.supersedesId ? " · revision" : ""}{p.isDefault ? " · default" : ""}</div></td>
                  <td className="text-sm">{[name(depts, p.departmentId), name(locs, p.locationId), name(bands, p.bandId)].filter(Boolean).join(" · ") || "Everyone"}</td>
                  <td className="num text-sm">{p.escalationAboveAmount ? formatINR(Number(p.escalationAboveAmount)) : "—"}</td>
                  <td className="text-sm">{p.payrollCutoffDay ? `day ${p.payrollCutoffDay}` : "—"}</td>
                  <td className="text-xs">{p.categories.filter((c) => c.maxAmount !== null).map((c) => `${c.category.name} ₹${Number(c.maxAmount).toLocaleString("en-IN")}`).join(", ") || "—"}</td>
                  <td><Badge tone={TONE[p.status] ?? "neutral"}>{p.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                  <td className="right">
                    <div className="row gap-1" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {p.status === "DRAFT" ? <><Link className="btn sm" href={`/expenses/policies?edit=${p.id}`}>Edit</Link><ActButton action={expensePolicyOpAction} hidden={{ id: p.id, op: "submit" }} label="Submit for approval" variant="primary" /></> : null}
                      {p.status === "ACTIVE" ? <><ActButton action={expensePolicyOpAction} hidden={{ id: p.id, op: "revise" }} label="Revise" /><ActButton action={expensePolicyOpAction} hidden={{ id: p.id, op: "retire" }} label="Retire" variant="ghost" confirmText="Retire this policy?" /></> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <Card tight title="Policy audit trail">
        {history.length === 0 ? <Empty title="No changes yet" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>When</th><th>Who</th><th>Summary</th></tr></thead>
            <tbody>{history.map((h) => <tr key={h.id}><td className="text-xs nowrap">{formatDate(h.createdAt)}</td><td className="text-xs">{h.actorLabel}</td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>
        )}
      </Card>
    </>
  );
}
