import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR, formatINRCompact } from "@keka/shared";
import { spendByMonth, spendBy, approvalTurnaround, lastMonths, type SpendLine } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Stat } from "@/components/ui";
import { Panel, Bars, EmptyState } from "@/components/keka";
import { HBars } from "@/components/charts";
import { DashboardTabs } from "../_components/dashboard";

export const metadata = { title: "Expense dashboard — Analytics" };
const P = PERMISSIONS;
const OPEN = ["SUBMITTED", "PARTIALLY_APPROVED", "PAYMENT_PENDING"];
const APPROVED = ["APPROVED", "PARTIALLY_APPROVED", "PAYMENT_PENDING", "PAID"];

/** Org › Dashboard › Expenses: approved spend by month, category and department, and what is waiting. */
export default async function ExpenseDashboard({ searchParams }: { searchParams: Promise<{ months?: string }> }) {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  await requireAuth(P.EXPENSE_VIEW);
  const sp = await searchParams;
  const months = [3, 6, 12].includes(Number(sp.months)) ? Number(sp.months) : 6;
  const today = new Date();
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
  const claims = await prisma.expenseClaim.findMany({
    where: { tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.EXPENSE_VIEW), stage: { not: "DRAFT" }, OR: [{ submittedAt: { gte: since } }, { lines: { some: { expenseDate: { gte: since } } } }] },
    select: {
      id: true, stage: true, claimedTotal: true, approvedTotal: true, submittedAt: true, approvedAt: true, employeeId: true,
      employee: { select: { displayName: true, firstName: true, lastName: true, employeeNumber: true, department: { select: { name: true } } } },
      lines: { select: { expenseDate: true, baseAmount: true, approvedAmount: true, category: { select: { name: true } } } },
    },
  });
  const lines: SpendLine[] = claims.flatMap((c) => c.lines.filter((l) => l.expenseDate >= since).map((l) => ({
    date: l.expenseDate, amount: Number(l.approvedAmount ?? l.baseAmount), category: l.category.name, department: c.employee.department?.name ?? "No department", stage: c.stage,
  })));
  const approvedClaims = claims.filter((c) => APPROVED.includes(c.stage));
  const total = lines.filter((l) => APPROVED.includes(l.stage)).reduce((s, l) => s + l.amount, 0);
  const waiting = claims.filter((c) => c.stage === "SUBMITTED");
  const unpaid = claims.filter((c) => c.stage === "PAYMENT_PENDING" || c.stage === "APPROVED");
  const turnaround = approvalTurnaround(approvedClaims);
  const claimed = claims.filter((c) => c.stage !== "CANCELLED").reduce((s, c) => s + Number(c.claimedTotal), 0);
  const approvedSum = approvedClaims.reduce((s, c) => s + Number(c.approvedTotal), 0);
  const rejected = claims.filter((c) => c.stage === "REJECTED").length;
  const byPerson = new Map<string, { name: string; value: number }>();
  for (const c of approvedClaims) {
    const p = byPerson.get(c.employeeId) ?? { name: `${c.employee.displayName ?? `${c.employee.firstName} ${c.employee.lastName}`} (${c.employee.employeeNumber})`, value: 0 };
    p.value += Number(c.approvedTotal);
    byPerson.set(c.employeeId, p);
  }
  const top = [...byPerson.values()].sort((a, b) => b.value - a.value).slice(0, 8);

  return (
    <>
      <DashboardTabs viewer={viewer} active="expenses" />
      <div className="page-head">
        <div className="page-title-group"><h1>Expense dashboard</h1><div className="page-subtitle">Claims from people in your scope, last {months} months</div></div>
        <form className="row gap-2 no-print">
          <select name="months" className="select" defaultValue={String(months)} aria-label="Window">{[3, 6, 12].map((m) => <option key={m} value={m}>Last {m} months</option>)}</select>
          <button className="btn">Apply</button>
        </form>
      </div>
      {claims.length === 0 ? <EmptyState title="No expense claims in this window" /> : (
        <div className="stack gap-3">
          <div className="grid grid-4">
            <Stat label="Approved spend" value={formatINRCompact(total)} meta={`${approvedClaims.length} claim${approvedClaims.length === 1 ? "" : "s"}`} />
            <Stat label="Waiting for approval" value={waiting.length} meta={formatINR(waiting.reduce((s, c) => s + Number(c.claimedTotal), 0))} tone={waiting.length ? "neg" : undefined} />
            <Stat label="Approved, not yet paid" value={unpaid.length} meta={formatINR(unpaid.reduce((s, c) => s + Number(c.approvedTotal), 0))} />
            <Stat label="Approval turnaround" value={turnaround === null ? "—" : `${turnaround} days`} meta={`${claimed ? Math.round((approvedSum / claimed) * 100) : 0}% of claimed value approved · ${rejected} rejected`} />
          </div>
          <Panel title="Approved spend per month" subtitle="By the date the expense was incurred">
            <Bars data={spendByMonth(lines, lastMonths(today, months)).map((m) => ({ ...m, title: `${m.label}: ${formatINR(m.value)}` }))} height={140} colour="#f0a35e" />
          </Panel>
          <div className="grid grid-2">
            <Panel title="By category"><HBars rows={spendBy(lines, (l) => l.category).slice(0, 10)} color="#5b9bd5" format={(n) => formatINRCompact(n)} /></Panel>
            <Panel title="By department"><HBars rows={spendBy(lines, (l) => l.department).slice(0, 10)} color="#9b87c4" format={(n) => formatINRCompact(n)} /></Panel>
          </div>
          <Panel title="Highest claimants" subtitle="Approved value in the window">
            {top.length ? <HBars rows={top.map((t) => ({ label: t.name, value: Math.round(t.value) }))} color="#ef8f7d" format={(n) => formatINRCompact(n)} /> : <EmptyState title="No approved claims" />}
          </Panel>
        </div>
      )}
    </>
  );
}
