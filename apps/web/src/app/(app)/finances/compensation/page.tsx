import { prisma } from "@keka/db";
import type { CompStatementContent } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, KeyValue } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { acknowledgeStatementAction } from "@/app/actions/compensation";

/** My compensation statements: the new pay, how it was arrived at, and total rewards. */
export default async function MyCompensationPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="Compensation" /><Empty title="No employee record is linked to this login." /></>;
  const statements = await prisma.compStatement.findMany({ where: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, publishedAt: { not: null } }, orderBy: { publishedAt: "desc" } });
  return (
    <>
      <PageHead title="Compensation" subtitle="Your compensation statements" />
      {statements.length === 0 ? <Empty title="No statements yet">When a compensation review is completed, your statement appears here.</Empty> : statements.map((s) => {
        const c = s.content as unknown as CompStatementContent;
        return (
          <Card key={s.id} title={c.plan} description={`Effective ${c.effectiveDate} · published ${formatDate(s.publishedAt!)}`}
            action={s.acknowledgedAt ? <Badge tone="success">acknowledged {formatDate(s.acknowledgedAt)}</Badge> : <ActButton action={acknowledgeStatementAction} hidden={{ statementId: s.id }} label="Acknowledge" variant="primary" />}>
            <div className="grid grid-2" style={{ alignItems: "start" }}>
              <KeyValue items={[
                ["Previous CTC", formatINR(c.currentCtc)],
                ["New CTC", <strong key="n">{formatINR(c.newCtc)}</strong>],
                ["Increase", `${c.totalPct}%`],
                ["Merit", `${c.meritPct}%`],
                ["Promotion", `${c.promotionPct}%`],
                ["Market adjustment", `${c.marketPct}%`],
                ["Total rewards (incl. benefits)", formatINR(c.totalRewards)],
              ]} />
              <div>
                <div className="text-sm strong" style={{ marginBottom: 4 }}>Pay components (annual)</div>
                {c.components.length === 0 ? <div className="text-sm subtle">—</div> : c.components.map((x) => <div key={x.name} className="row text-sm" style={{ justifyContent: "space-between" }}><span>{x.name}</span><span className="num">{formatINR(x.annual)}</span></div>)}
                {c.benefits.length ? <><div className="text-sm strong" style={{ margin: "8px 0 4px" }}>Benefits paid by the company (annual)</div>{c.benefits.map((b) => <div key={b.plan} className="row text-sm" style={{ justifyContent: "space-between" }}><span>{b.plan}</span><span className="num">{formatINR(b.employerAnnual)}</span></div>)}</> : null}
              </div>
            </div>
          </Card>
        );
      })}
    </>
  );
}
