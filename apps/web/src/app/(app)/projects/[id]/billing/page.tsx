import Link from "next/link";
import { notFound, forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { retainerSchedule } from "@keka/services/src/psa";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { RetainerForm, ExpenseChargeOps, GenerateCharges, AdhocChargeForm } from "../../billing/forms";
import { money, label, iso } from "../../billing/nav";

const DAY = 86_400_000;
const CHARGE_TONE: Record<string, "info" | "success" | "neutral"> = { UNBILLED: "info", INVOICED: "success", CANCELLED: "neutral" };

/** A project's billing set-up: its retainer and periods, expenses charged to it, and its charges. */
export default async function ProjectBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.PROJECT_MANAGE, P.INVOICE_MANAGE])) forbidden();
  const { id } = await params;
  const p = await prisma.project.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { client: { select: { name: true } }, allocations: { select: { employeeId: true } } } });
  if (!p) notFound();
  const manage = can(viewer, P.PROJECT_MANAGE), bill = can(viewer, P.INVOICE_MANAGE);
  const billable = !!p.clientId && p.billingModel !== "NON_BILLABLE";
  const team = new Set(p.allocations.map((a) => a.employeeId));
  const [schedule, charges, charged, unassigned, others] = await Promise.all([
    retainerSchedule(viewer.tenantId, p.id),
    prisma.projectCharge.findMany({ where: { tenantId: viewer.tenantId, projectId: p.id }, include: { invoice: { select: { id: true, invoiceNumber: true } } }, orderBy: [{ status: "asc" }, { periodStart: "desc" }], take: 100 }),
    prisma.expenseClaim.findMany({ where: { tenantId: viewer.tenantId, projectId: p.id }, include: { employee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" } }),
    bill && billable ? prisma.expenseClaim.findMany({
      where: { tenantId: viewer.tenantId, projectId: null, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] }, approvedTotal: { gt: 0 }, createdAt: { gte: new Date(Date.now() - 365 * DAY) } },
      include: { employee: { select: { id: true, displayName: true } } }, orderBy: { createdAt: "desc" }, take: 50,
    }) : [],
    bill ? prisma.project.findMany({ where: { tenantId: viewer.tenantId, clientId: { not: null }, billingModel: { not: "NON_BILLABLE" }, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
  ]);
  const chargeOf = (claimId: string) => charges.find((c) => (c.sourceRefs as { expenseClaimId?: string } | null)?.expenseClaimId === claimId);
  // Team members' claims first: they are the likeliest to belong here.
  unassigned.sort((a, b) => Number(team.has(b.employee.id)) - Number(team.has(a.employee.id)));
  const projectOpts = others.map((o) => ({ value: o.id, label: o.name }));
  const unbilled = charges.filter((c) => c.status === "UNBILLED");
  return (
    <>
      <PageHead title={`${p.name} · billing`} subtitle={`${p.client?.name ?? "Internal"} · ${label(p.billingModel)}`}
        actions={<><Link className="btn sm" href={`/projects/${p.id}`}>Project</Link>{bill ? <Link className="btn sm" href="/projects/billing/charges">All charges</Link> : null}</>} />
      <div className="stack gap-3">
        <div className="grid grid-3">
          <Stat label="Unbilled charges" value={money(unbilled.reduce((s, c) => s + Number(c.amount), 0))} meta={`${unbilled.length} charge(s)`} />
          <Stat label="Expenses charged here" value={money(charged.reduce((s, c) => s + Number(c.approvedTotal), 0))} meta={`${charged.length} claim(s)`} />
          <Stat label="Invoiced" value={money(charges.filter((c) => c.status === "INVOICED").reduce((s, c) => s + Number(c.amount), 0))} />
        </div>

        <Card title="Retainer" description={p.billingModel === "RETAINER" ? "One charge a month from the start month to the project's end. Changing the fee changes periods not yet invoiced." : "Bill this project as a fixed fee each month. Setting one up switches the project to retainer billing."}>
          <div className="stack gap-3">
            {manage && p.clientId ? <RetainerForm projectId={p.id} fee={p.retainerFee === null ? null : Number(p.retainerFee)} from={p.retainerFrom ? iso(p.retainerFrom) : p.startDate ? iso(p.startDate) : null} /> : null}
            {!p.clientId ? <span className="text-sm subtle">Set the project's client before billing a retainer.</span> : null}
            {schedule.length ? (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Period</th><th className="num">Fee</th><th>Charge</th><th>Status</th></tr></thead>
                <tbody>{schedule.map((r) => (
                  <tr key={r.month}>
                    <td className="text-sm">{r.label}</td><td className="num">{money(r.amount)}</td><td className="text-sm">{r.chargeNumber ?? "—"}</td>
                    <td>{r.state === "INVOICED" ? <Badge tone="success">{r.invoiceId ? <Link href={`/projects/billing/${r.invoiceId}`}>Invoiced {r.invoiceNumber}</Link> : "Invoiced"}</Badge> : r.state === "UNBILLED" ? <Badge tone="info">Ready to bill</Badge> : <Badge tone="neutral">Upcoming</Badge>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : null}
          </div>
        </Card>

        <Card tight title="Project expenses" description={billable ? "Approved expense claims charged to this project become charges, billed on its next invoice at the approved amount." : "Only a billable client project can be charged expenses."}>
          {charged.length === 0 ? <Empty title="No expenses charged to this project" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Claim</th><th>Employee</th><th>Stage</th><th className="num">Approved</th><th>Charge</th><th /></tr></thead>
              <tbody>{charged.map((c) => {
                const ch = chargeOf(c.id);
                return (
                  <tr key={c.id}>
                    <td className="text-sm"><span className="strong">{c.claimNumber}</span> {c.title}</td>
                    <td className="text-sm">{c.employee.displayName}</td>
                    <td className="text-sm">{label(c.stage)}</td>
                    <td className="num">{money(c.approvedTotal)}</td>
                    <td className="text-sm">{ch ? <>{ch.number} · {ch.invoice ? <Link href={`/projects/billing/${ch.invoice.id}`}>{ch.invoice.invoiceNumber}</Link> : "unbilled"}</> : <span className="subtle">{["APPROVED", "PAYMENT_PENDING", "PAID"].includes(c.stage) ? "—" : "not approved yet"}</span>}</td>
                    <td>{bill ? <ExpenseChargeOps claimId={c.id} projects={projectOpts} currentProjectId={p.id} invoiced={ch?.status === "INVOICED"} /> : null}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {bill && billable && unassigned.length ? (
            <div style={{ borderTop: "1px solid var(--border)" }}>
              <div className="text-sm strong" style={{ padding: "10px 16px 0" }}>Approved claims not charged to any project</div>
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Claim</th><th>Employee</th><th>Submitted</th><th className="num">Approved</th><th /></tr></thead>
                <tbody>{unassigned.map((c) => (
                  <tr key={c.id}>
                    <td className="text-sm"><span className="strong">{c.claimNumber}</span> {c.title}</td>
                    <td className="text-sm">{c.employee.displayName}{team.has(c.employee.id) ? <Badge tone="info">On this project</Badge> : null}</td>
                    <td className="text-sm nowrap">{formatDate(c.submittedAt ?? c.createdAt)}</td>
                    <td className="num">{money(c.approvedTotal)}</td>
                    <td><ExpenseChargeOps claimId={c.id} projects={[{ value: p.id, label: p.name }]} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          ) : null}
        </Card>

        {bill && billable ? (
          <Card tight title="Charges" description="Draft the invoice from Billing › Charges." action={<GenerateCharges projectId={p.id} />}>
            {charges.length === 0 ? <Empty title="No charges yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Charge</th><th>Kind</th><th>Period</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>{charges.map((c) => (
                  <tr key={c.id}>
                    <td className="text-sm"><span className="strong">{c.number}</span> {c.name}</td>
                    <td className="text-sm">{label(c.kind)}</td>
                    <td className="text-sm nowrap">{c.periodStart ? formatDate(c.periodStart) : "—"}</td>
                    <td className="num">{money(c.amount, c.currency)}</td>
                    <td><Badge tone={CHARGE_TONE[c.status]}>{label(c.status)}</Badge>{c.invoice ? <> <Link className="text-xs" href={`/projects/billing/${c.invoice.id}`}>{c.invoice.invoiceNumber}</Link></> : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}><AdhocChargeForm projectId={p.id} /></div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
