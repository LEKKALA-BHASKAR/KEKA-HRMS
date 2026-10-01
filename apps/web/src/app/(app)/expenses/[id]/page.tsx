import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { defaultApproved } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Person, Callout } from "@/components/ui";
import { ClaimDecision, ClaimOps } from "../forms";

const P = PERMISSIONS;

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const claim = await prisma.expenseClaim.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      lines: { include: { category: true }, orderBy: { expenseDate: "asc" } }, policy: { include: { categories: true } },
      employee: { select: { id: true, displayName: true, employeeNumber: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } },
    },
  });
  if (!claim) notFound();
  const own = claim.employeeId === viewer.employee?.id;
  const approver = !own && can(viewer, P.EXPENSE_APPROVE) && canAccessEmployee(viewer, claim.employee, P.EXPENSE_APPROVE);
  const finance = !own && can(viewer, P.EXPENSE_MANAGE);
  if (!own && !approver && !finance && !canAccessEmployee(viewer, claim.employee, P.EXPENSE_VIEW)) notFound();
  const canDecide = (claim.stage === "SUBMITTED" && approver) || (claim.stage === "PARTIALLY_APPROVED" && finance);
  const cap = (l: (typeof claim.lines)[number]) => {
    const p = claim.policy?.categories.find((x) => x.categoryId === l.categoryId)?.maxAmount;
    const caps = [l.category.maxAmount, p].filter((v) => v !== null && v !== undefined).map(Number);
    return caps.length ? Math.min(...caps) : null;
  };
  return (
    <>
      <PageHead title={`${claim.claimNumber} — ${claim.title}`} subtitle={`${claim.employee.displayName} · ${claim.stage.replace(/_/g, " ").toLowerCase()}`}
        actions={<div className="row gap-2">{own && ["DRAFT", "SUBMITTED"].includes(claim.stage) ? <ClaimOps claimId={claim.id} ops={["cancel"]} /> : null}{finance && claim.stage === "APPROVED" ? <ClaimOps claimId={claim.id} ops={["paid"]} /> : null}<Link className="btn" href="/expenses">Back</Link></div>} />
      {claim.rejectReason ? <Callout tone="danger" title="Rejected">{claim.rejectReason}</Callout> : null}
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start", marginTop: 12 }}>
        <div className="stack gap-4">
          <Card tight title="Expenses">
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Date</th><th>Category</th><th>Merchant</th><th className="num">Claimed</th><th className="num">Approved</th><th>Receipt</th></tr></thead>
              <tbody>
                {claim.lines.map((l) => {
                  const c = cap(l);
                  return (
                    <tr key={l.id}>
                      <td className="nowrap text-sm">{formatDate(l.expenseDate)}</td>
                      <td className="text-sm">{l.category.name}{c && Number(l.amount) > c ? <div className="text-xs" style={{ color: "var(--warning)" }}>over the ₹{c.toLocaleString("en-IN")} limit</div> : null}</td>
                      <td className="text-sm muted">{l.merchant ?? "—"}</td>
                      <td className="num">{formatINR(Number(l.amount))}</td>
                      <td className="num">{l.approvedAmount !== null ? formatINR(Number(l.approvedAmount)) : "—"}</td>
                      <td>{l.receiptUrl ? <a className="text-xs" href={l.receiptUrl}>View</a> : <span className="text-xs subtle">none</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Card>
          {canDecide ? (
            <Card title={claim.stage === "PARTIALLY_APPROVED" ? "Finance approval" : "Approve"} description="Amounts default to the claim, capped at policy limits. Reduce any line before approving.">
              <ClaimDecision claimId={claim.id} lines={claim.lines.map((l) => ({ id: l.id, label: `${l.category.name}${l.merchant ? ` · ${l.merchant}` : ""}`, amount: Number(l.amount), suggested: l.approvedAmount !== null ? Number(l.approvedAmount) : defaultApproved(Number(l.amount), cap(l)) }))} />
            </Card>
          ) : null}
        </div>
        <Card title="Summary">
          <Person name={claim.employee.displayName ?? ""} meta={claim.employee.employeeNumber} />
          <div className="divider" />
          <KeyValue items={[
            ["Claimed", formatINR(Number(claim.claimedTotal))],
            ["Approved", Number(claim.approvedTotal) ? formatINR(Number(claim.approvedTotal)) : "—"],
            ["Submitted", claim.submittedAt ? formatDate(claim.submittedAt) : "draft"],
            ["Paid", claim.paidAt ? formatDate(claim.paidAt) : claim.stage === "PAYMENT_PENDING" ? "with the next salary" : "—"],
          ]} />
        </Card>
      </div>
    </>
  );
}
