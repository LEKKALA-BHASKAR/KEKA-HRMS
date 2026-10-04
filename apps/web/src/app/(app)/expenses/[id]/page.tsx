import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { defaultApproved, delegatorsOf, EXPENSE_REASON_CODES } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can, viewerForUser } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Person, Callout, Empty } from "@/components/ui";
import { GrowthForm } from "@/components/growth-forms";
import { DraftClaimEditor } from "@/components/money-forms";
import { replaceReceiptAction } from "@/app/actions/expense-depth";
import { ClaimDecision, ClaimOps } from "../forms";

const P = PERMISSIONS;
const CODES = Object.entries(EXPENSE_REASON_CODES).map(([value, label]) => ({ value, label }));

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
  let approver = !own && can(viewer, P.EXPENSE_APPROVE) && canAccessEmployee(viewer, claim.employee, P.EXPENSE_APPROVE);
  let finance = !own && can(viewer, P.EXPENSE_MANAGE);
  // Approvals delegated to the viewer by someone who could decide this claim.
  let delegate = false;
  if (!own && !approver && !finance) {
    for (const userId of await delegatorsOf(viewer.tenantId, viewer.user.id, "EXPENSE_CLAIM")) {
      const v = await viewerForUser(userId);
      if (!v || v.employee?.id === claim.employeeId) continue;
      if (claim.stage === "SUBMITTED" && can(v, P.EXPENSE_APPROVE) && canAccessEmployee(v, claim.employee, P.EXPENSE_APPROVE)) { approver = true; delegate = true; }
      if (claim.stage === "PARTIALLY_APPROVED" && can(v, P.EXPENSE_MANAGE)) { finance = true; delegate = true; }
    }
  }
  if (!own && !approver && !finance && !canAccessEmployee(viewer, claim.employee, P.EXPENSE_VIEW)) notFound();
  const canDecide = (claim.stage === "SUBMITTED" && approver) || (claim.stage === "PARTIALLY_APPROVED" && finance);
  const cap = (l: (typeof claim.lines)[number]) => {
    const p = claim.policy?.categories.find((x) => x.categoryId === l.categoryId)?.maxAmount;
    const caps = [l.category.maxAmount, p].filter((v) => v !== null && v !== undefined).map(Number);
    return caps.length ? Math.min(...caps) : null;
  };
  const [cats, history, pre, trip] = await Promise.all([
    own && claim.stage === "DRAFT" ? prisma.expenseCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true, kind: { not: "MILEAGE" } }, orderBy: { name: "asc" } }) : [],
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, OR: [{ entityType: "ExpenseClaim", entityId: claim.id }, { entityType: "ExpenseClaimLine", entityId: { in: claim.lines.map((l) => l.id) } }] }, orderBy: { createdAt: "desc" }, take: 50 }),
    claim.preApprovalId ? prisma.expensePreApproval.findUnique({ where: { id: claim.preApprovalId } }) : null,
    claim.tripId ? prisma.travelRequest.findUnique({ where: { id: claim.tripId }, select: { id: true, requestNumber: true, toCity: true } }) : null,
  ]);
  const ops: Array<"cancel" | "recall" | "paid"> = [];
  if (own && claim.stage === "SUBMITTED") ops.push("recall");
  if (own && ["DRAFT", "SUBMITTED"].includes(claim.stage)) ops.push("cancel");
  const receiptsOpen = own && ["DRAFT", "SUBMITTED", "PARTIALLY_APPROVED"].includes(claim.stage);
  const dupOf = (l: (typeof claim.lines)[number]) => (l.duplicateOfLineId ? (l.duplicateOfLineId.startsWith("line ") || l.duplicateOfLineId === "earlier" ? l.duplicateOfLineId : "an earlier claim") : null);
  return (
    <>
      <PageHead title={`${claim.claimNumber} — ${claim.title}`} subtitle={`${claim.employee.displayName} · ${claim.stage.replace(/_/g, " ").toLowerCase()}`}
        actions={<div className="row gap-2">{ops.length ? <ClaimOps claimId={claim.id} ops={ops} /> : null}{own && claim.stage === "DRAFT" ? <ClaimOps claimId={claim.id} ops={["submit"]} /> : null}{finance && claim.stage === "APPROVED" ? <ClaimOps claimId={claim.id} ops={["paid"]} /> : null}<Link className="btn" href="/expenses">Back</Link></div>} />
      {claim.rejectReason ? <Callout tone="danger" title={`Rejected${claim.rejectCode ? ` — ${EXPENSE_REASON_CODES[claim.rejectCode as keyof typeof EXPENSE_REASON_CODES] ?? claim.rejectCode}` : ""}`}>{claim.rejectReason}</Callout> : null}
      {claim.lines.some((l) => l.duplicateOfLineId) ? <Callout tone="warning" title="Possible duplicates">Some expenses match another expense with the same date, amount and merchant. Check them before approving.</Callout> : null}
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
                      <td className="text-sm">{l.category.name}
                        {l.distanceKm ? <div className="text-xs subtle">{Number(l.distanceKm)} km · {(l.vehicleType ?? "").toLowerCase().replace(/_/g, " ")}</div> : null}
                        {c && Number(l.amount) > c ? <div className="text-xs" style={{ color: "var(--warning)" }}>over the ₹{c.toLocaleString("en-IN")} limit</div> : null}
                        {dupOf(l) ? <div className="text-xs" style={{ color: "var(--warning)" }}>possible duplicate of {dupOf(l)}</div> : null}
                        {l.reasonCode ? <div className="text-xs subtle">Reduced: {EXPENSE_REASON_CODES[l.reasonCode as keyof typeof EXPENSE_REASON_CODES] ?? l.reasonCode}</div> : null}
                      </td>
                      <td className="text-sm muted">{l.merchant ?? "—"}</td>
                      <td className="num">{formatINR(Number(l.amount))}</td>
                      <td className="num">{l.approvedAmount !== null ? formatINR(Number(l.approvedAmount)) : "—"}</td>
                      <td>
                        {l.receiptUrl ? <a className="text-xs" href={l.receiptUrl}>View</a> : <span className="text-xs subtle">none</span>}
                        {l.receiptCheck && l.receiptCheck !== "OK" ? <div className="text-xs" style={{ color: "var(--warning)" }}>{l.receiptCheck}</div> : null}
                        {l.receiptUpdatedAt ? <div className="text-xs subtle">replaced {formatDate(l.receiptUpdatedAt)}</div> : null}
                        {receiptsOpen ? <details><summary className="text-xs" style={{ cursor: "pointer" }}>{l.receiptUrl ? "Replace" : "Attach"}</summary><GrowthForm action={replaceReceiptAction} hidden={{ claimId: claim.id, lineId: l.id }} fields={[{ name: "receipt", label: "Receipt (PDF, PNG, JPEG)", type: "file" }]} submitLabel="Upload" cols={1} compact /></details> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Card>
          {own && claim.stage === "DRAFT" ? (
            <Card title="Edit draft" description="Change, add or remove expenses, then submit. Mileage lines are re-entered as a new claim.">
              <DraftClaimEditor claimId={claim.id} title={claim.title} categories={cats.map((c) => ({ value: c.id, label: c.name }))}
                lines={claim.lines.filter((l) => l.category.kind !== "MILEAGE").map((l) => ({ id: l.id, categoryId: l.categoryId, expenseDate: l.expenseDate.toISOString().slice(0, 10), amount: Number(l.amount), merchant: l.merchant, description: l.description }))} />
            </Card>
          ) : null}
          {canDecide ? (
            <Card title={claim.stage === "PARTIALLY_APPROVED" ? "Finance approval" : "Approve"} description={`Amounts default to the claim, capped at policy limits. Reduce any line before approving, with a reason code.${delegate ? " You are deciding as a delegate." : ""}`}>
              <ClaimDecision claimId={claim.id} codes={CODES} lines={claim.lines.map((l) => ({ id: l.id, label: `${l.category.name}${l.merchant ? ` · ${l.merchant}` : ""}`, amount: Number(l.amount), suggested: l.approvedAmount !== null ? Number(l.approvedAmount) : defaultApproved(Number(l.amount), cap(l)) }))} />
            </Card>
          ) : null}
          <Card tight title="Audit history" description="Every change and decision on this claim">
            {history.length === 0 ? <Empty title="No entries yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Summary</th></tr></thead>
                <tbody>{history.map((h) => <tr key={h.id}><td className="text-xs nowrap">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{h.actorLabel}</td><td><Badge>{h.action.toLowerCase()}</Badge></td><td className="text-sm">{h.summary}</td></tr>)}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <Card title="Summary">
          <Person name={claim.employee.displayName ?? ""} meta={claim.employee.employeeNumber} />
          <div className="divider" />
          <KeyValue items={[
            ["Claimed", formatINR(Number(claim.claimedTotal))],
            ["Approved", Number(claim.approvedTotal) ? formatINR(Number(claim.approvedTotal)) : "—"],
            ["Submitted", claim.submittedAt ? formatDate(claim.submittedAt) : "draft"],
            ["Paid", claim.paidAt ? formatDate(claim.paidAt) : claim.stage === "PAYMENT_PENDING" ? "with the next salary" : "—"],
            ["Pre-approval", pre ? `${pre.number} (₹${Number(pre.estimatedAmount).toLocaleString("en-IN")})` : "—"],
            ["Trip", trip ? <Link key="t" href={`/expenses/travel/${trip.id}`}>{trip.requestNumber} · {trip.toCity}</Link> : "—"],
          ]} />
        </Card>
      </div>
    </>
  );
}
