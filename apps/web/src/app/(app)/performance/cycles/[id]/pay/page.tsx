import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { meritOf } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { MeritMatrix, BuildProposals, ProposalEditor, RestoreProposal, ApplyProposals } from "./forms";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Review-to-pay for a cycle: merit matrix, proposals from calibrated ratings, and applying them to payroll. */
export default async function ReviewToPayPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.SALARY_REVISE);
  const { id } = await params;
  const cycle = await prisma.reviewCycle.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { bands: { orderBy: { displayOrder: "asc" } } } });
  if (!cycle) notFound();
  const matrix = meritOf(cycle.meritMatrix);
  const [proposals, bonusTypes, calibrated] = await Promise.all([
    prisma.compensationProposal.findMany({
      where: { cycleId: id, employee: scopedEmployeeWhere(viewer, PERMISSIONS.SALARY_REVISE) },
      include: { employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } } },
      orderBy: [{ status: "asc" }, { proposedPercent: "desc" }],
    }),
    prisma.bonusType.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employeeReview.count({ where: { cycleId: id, status: { in: ["CALIBRATED", "SHARED", "ACKNOWLEDGED"] } } }),
  ]);
  // Manager recommendations from the reviews (Inbox › Salary increments decides them).
  const recs = new Map((await prisma.salaryRecommendation.findMany({ where: { cycleId: id, tenantId: viewer.tenantId } })).map((r) => [r.reviewId, r]));
  const drafts = proposals.filter((p) => p.status === "DRAFT");
  const live = proposals.filter((p) => p.status !== "SKIPPED");
  const payroll = live.reduce((s, p) => s + Number(p.currentCtc), 0);
  const increase = live.reduce((s, p) => s + Number(p.proposedCtc) - Number(p.currentCtc), 0);
  const bonuses = live.reduce((s, p) => s + Number(p.bonusAmount), 0);

  return (
    <>
      <PageHead title={`Review to pay — ${cycle.name}`} subtitle={`${calibrated} calibrated review${calibrated === 1 ? "" : "s"}. Set an increment and bonus for each band, adjust where there is a reason, then apply.`}
        actions={<Link className="btn ghost" href={`/performance/cycles/${cycle.id}`}>Back to calibration</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Proposals" value={live.length} meta={`${drafts.length} still in draft`} />
        <Stat label="Annual cost of increases" value={inr(increase)} meta={payroll ? `${((increase / payroll) * 100).toFixed(2)}% of current CTC` : "—"} />
        <Stat label="Bonuses" value={inr(bonuses)} meta="One-time" />
        <Stat label="Average increment" value={live.length ? `${(live.reduce((s, p) => s + Number(p.proposedPercent), 0) / live.length).toFixed(1)}%` : "—"} meta="Across proposals" />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 18, alignItems: "start" }}>
        <Card title="Merit matrix">
          <MeritMatrix cycleId={cycle.id} bands={cycle.bands.map((b) => { const m = matrix.find((x) => x.bandId === b.id); return { id: b.id, name: b.name, inc: m?.incrementPercent ?? 0, bonus: m?.bonusPercent ?? 0 }; })} />
          {matrix.length ? <div style={{ marginTop: 12 }}><BuildProposals cycleId={cycle.id} label={proposals.length ? "Rebuild proposals" : "Build proposals"} /></div> : null}
        </Card>
        <div className="stack gap-4">
          <Card tight title={`Proposals (${proposals.length})`}>
            {proposals.length === 0 ? <Empty title="No proposals yet">Save the merit matrix, then build proposals from calibrated reviews.</Empty> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Employee</th><th>Band</th><th className="num">Current CTC</th><th className="num">Matrix</th><th className="num">Manager</th><th className="num">New CTC</th><th className="num">Bonus</th><th /></tr></thead>
                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/employees/${p.employee.id}`}>{p.employee.displayName}</Link><div className="text-xs subtle">{p.employee.employeeNumber} · {p.employee.department?.name ?? ""}</div></td>
                      <td className="text-sm">{p.bandName ?? "—"}</td>
                      <td className="num text-sm">{inr(Number(p.currentCtc))}</td>
                      <td className="num text-sm">{Number(p.recommendedPercent)}%</td>
                      <td className="num text-sm">{recs.get(p.reviewId) ? <>{Number(recs.get(p.reviewId)!.incrementPercent)}%{recs.get(p.reviewId)!.recommendPromotion ? <div className="text-xs">+ promotion</div> : null}<div className="text-xs subtle">{recs.get(p.reviewId)!.status.toLowerCase()}</div></> : "—"}</td>
                      <td className="num text-sm strong">{inr(Number(p.proposedCtc))}<div className="text-xs subtle">{Number(p.proposedPercent)}%</div></td>
                      <td className="num text-sm">{Number(p.bonusAmount) ? inr(Number(p.bonusAmount)) : "—"}</td>
                      <td className="right">
                        {p.status === "DRAFT" ? <ProposalEditor id={p.id} pct={Number(p.proposedPercent)} bonus={Number(p.bonusAmount)} note={p.note ?? ""} recommended={Number(p.recommendedPercent)} />
                          : p.status === "SKIPPED" ? <span className="row gap-1" style={{ justifyContent: "flex-end" }}><Badge tone="neutral">skipped</Badge><RestoreProposal id={p.id} /></span>
                          : <Badge tone="success">applied</Badge>}
                        {p.note && p.status !== "DRAFT" ? <div className="text-xs subtle">{p.note}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
          {drafts.length ? (
            <Card title="Apply to payroll">
              <ApplyProposals cycleId={cycle.id} ids={drafts.map((d) => d.id)} needsBonus={drafts.some((d) => Number(d.bonusAmount) > 0)} bonusTypes={bonusTypes.map((b) => ({ value: b.id, label: b.name }))} />
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
