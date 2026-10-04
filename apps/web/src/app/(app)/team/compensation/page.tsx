import { prisma } from "@keka/db";
import { compPoolStatus, compGuardrailBreaches, type CompGuardrails } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, Callout } from "@/components/ui";
import { CompWorksheet } from "../../payroll/compensation/_worksheet";

/** The manager's increase worksheet for each open compensation plan, within their budget pool. */
export default async function TeamCompensationPage() {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  if (!me) return <><PageHead title="Compensation" /><Empty title="No employee record is linked to this login." /></>;
  const t = viewer.tenantId;
  const plans = await prisma.compPlan.findMany({ where: { tenantId: t, status: { in: ["PLANNING", "CALIBRATION", "PENDING_APPROVAL", "APPROVED", "APPLIED"] }, items: { some: { ownerEmployeeId: me } } }, orderBy: { effectiveDate: "desc" }, take: 5 });
  const grades = (await prisma.payGrade.findMany({ where: { tenantId: t, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })).map((g) => ({ value: g.id, label: g.name }));
  const sections = await Promise.all(plans.map(async (p) => {
    const [items, pools] = await Promise.all([
      prisma.compPlanItem.findMany({ where: { planId: p.id, tenantId: t, ownerEmployeeId: me }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { employee: { displayName: "asc" } } }),
      compPoolStatus(t, p.id),
    ]);
    const breaches = new Map(items.map((i) => [i.id, compGuardrailBreaches(p.guardrails as CompGuardrails | null, { totalPct: Number(i.totalPct), promotionPct: Number(i.promotionPct), note: i.note })] as const).filter(([, b]) => b.length));
    return { plan: p, items, pool: pools.find((x) => x.ownerEmployeeId === me), breaches };
  }));
  return (
    <>
      <PageHead title="Team compensation" subtitle="Propose increases for your team within your budget" />
      {sections.length === 0 ? <Empty title="No compensation plan needs your input">When HR opens a planning round, your team appears here.</Empty> : sections.map(({ plan, items, pool, breaches }) => (
        <Card key={plan.id} tight title={plan.name} description={`Effective ${formatDate(plan.effectiveDate)} · ${plan.status === "PLANNING" ? "open for your proposals" : plan.status.toLowerCase().replace("_", " ")}`}
          action={pool ? <div style={{ minWidth: 220 }}><div className={`text-xs ${pool.over ? "neg" : ""}`}>Budget used {formatINR(pool.used)} of {formatINR(pool.amount)} · {formatINR(pool.left)} left</div><Progress value={pool.used} max={Math.max(1, pool.amount)} tone={pool.over ? "warning" : "success"} /></div> : undefined}>
          {plan.status === "PLANNING" && breaches.size ? <div style={{ padding: 12 }}><Callout tone="warning" title="Outside the guardrails">Lines marked in red need a note or an approved exception before HR can submit the plan.</Callout></div> : null}
          <CompWorksheet items={items} editable={plan.status === "PLANNING"} admin={false} grades={grades} sessions={[]} breaches={breaches} viewerEmployeeId={me} />
          {plan.status !== "PLANNING" ? <div className="text-xs subtle" style={{ padding: 12 }}><Badge>read only</Badge> HR is {plan.status === "CALIBRATION" ? "calibrating" : "finalising"} this plan.</div> : null}
        </Card>
      ))}
    </>
  );
}
