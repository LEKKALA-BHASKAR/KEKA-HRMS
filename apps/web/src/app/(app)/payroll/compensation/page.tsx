import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { PLAN_TONE, matrixText, settingsFields } from "./_shared";
import { saveCompTemplateAction, createCompPlanAction } from "@/app/actions/compensation";

/** Compensation planning: rounds of merit, promotion and market increases, and the templates they start from. */
export default async function CompensationPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.SALARY_REVISE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const [plans, templates, cycles] = await Promise.all([
    prisma.compPlan.findMany({ where: { tenantId: t }, include: { _count: { select: { items: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.compPlanTemplate.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.reviewCycle.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { periodStart: "desc" }, take: 20 }),
  ]);
  const editing = sp.template ? templates.find((x) => x.id === sp.template) : undefined;
  return (
    <>
      <PageHead title="Compensation planning" subtitle="Merit, promotion and market increases in BooS-HR"
        actions={<><Link className="btn" href="/payroll/compensation/ranges">Pay ranges</Link><Link className="btn" href="/payroll/compensation/equity">Pay equity</Link></>} />
      <Card tight title="Plans">
        {plans.length === 0 ? <Empty title="No compensation plans yet" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Plan</th><th>Effective</th><th className="num">Budget</th><th className="num">Employees</th><th>Status</th></tr></thead>
            <tbody>{plans.map((p) => <tr key={p.id}><td><Link className="strong" href={`/payroll/compensation/${p.id}`}>{p.name}</Link></td><td className="text-sm">{formatDate(p.effectiveDate)}</td><td className="num">{Number(p.budgetPct)}%</td><td className="num">{p._count.items}</td><td><Badge tone={PLAN_TONE[p.status] ?? "neutral"}>{p.status.toLowerCase().replace("_", " ")}</Badge></td></tr>)}</tbody></table></div>
        )}
        <div style={{ padding: 12 }}>
          <Reveal label="New plan">
            <GrowthForm action={createCompPlanAction} submitLabel="Create plan" fields={[
              { name: "name", label: "Name", required: true, placeholder: "Annual increments 2027" },
              { name: "templateId", label: "Start from template", type: "select", options: templates.map((x) => ({ value: x.id, label: x.name })) },
              { name: "reviewCycleId", label: "Ratings from review cycle", type: "select", options: cycles.map((c) => ({ value: c.id, label: c.name })) },
              { name: "periodStart", label: "Review period from", type: "date", required: true },
              { name: "effectiveDate", label: "Increases effective", type: "date", required: true },
              ...settingsFields(null),
            ]} />
            <div className="text-xs subtle">With a template chosen its settings are used and the ones above are ignored.</div>
          </Reveal>
        </div>
      </Card>
      <Card tight title="Templates" description="Reusable merit matrix, guardrails, eligibility and budget.">
        {templates.length === 0 ? <Empty title="No templates" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Template</th><th>Merit matrix</th><th className="num">Budget</th><th /></tr></thead>
            <tbody>{templates.map((x) => <tr key={x.id}><td className="strong text-sm">{x.name}</td><td className="text-xs">{matrixText(x.meritMatrix)}</td><td className="num">{Number(x.budgetPct)}%</td><td><Link className="btn sm" href={`/payroll/compensation?template=${x.id}`}>Edit</Link></td></tr>)}</tbody></table></div>
        )}
        <div style={{ padding: 12 }}>
          <Reveal label={editing ? `Edit ${editing.name}` : "New template"} open={!!editing}>
            <GrowthForm action={saveCompTemplateAction} hidden={editing ? { id: editing.id } : {}} submitLabel="Save template" fields={[{ name: "name", label: "Name", required: true, defaultValue: editing?.name }, ...settingsFields(editing ?? null)]} />
          </Reveal>
        </div>
      </Card>
    </>
  );
}
