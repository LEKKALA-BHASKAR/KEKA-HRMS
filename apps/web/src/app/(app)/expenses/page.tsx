import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { ClaimForm, AdvanceForm, AdvanceOps, TripForm, TripOps, CategoryForm } from "./forms";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  DRAFT: "neutral", SUBMITTED: "warning", PARTIALLY_APPROVED: "warning", APPROVED: "info", PAYMENT_PENDING: "info", PAID: "success", REJECTED: "danger", CANCELLED: "neutral",
  REQUESTED: "warning", DISBURSED: "info", PARTIALLY_SETTLED: "info", SETTLED: "success", RECOVERED: "success", BOOKED: "info", COMPLETED: "success", IN_PROGRESS: "info",
};
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const approver = canAny(viewer, [P.EXPENSE_APPROVE, P.EXPENSE_MANAGE]) || viewer.allReportIds.size > 0;
  const tabs = ["mine", ...(approver ? ["approvals"] : []), "advances", "travel", ...(can(viewer, P.EXPENSE_MANAGE) ? ["policy"] : [])];
  const sp = await searchParams;
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "mine";
  return (
    <>
      <PageHead title="Expenses & travel" subtitle="Claims checked against policy as you enter them, paid with your salary once approved" />
      <div className="tabs">
        {tabs.map((t) => <Link key={t} href={`/expenses?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{{ mine: "My claims", approvals: "Approvals", advances: "Advances", travel: "Travel", policy: "Policy" }[t]}</Link>)}
      </div>
      {tab === "mine" ? <Mine viewer={viewer} /> : null}
      {tab === "approvals" ? <Approvals viewer={viewer} /> : null}
      {tab === "advances" ? <Advances viewer={viewer} /> : null}
      {tab === "travel" ? <Travel viewer={viewer} /> : null}
      {tab === "policy" ? <Policy tenantId={viewer.tenantId} /> : null}
    </>
  );
}

type V = Awaited<ReturnType<typeof requireViewer>>;

function ClaimTable({ claims, showEmployee }: { claims: Array<{ id: string; claimNumber: string; title: string; stage: string; claimedTotal: unknown; approvedTotal: unknown; submittedAt: Date | null; createdAt: Date; employee?: { displayName: string | null; employeeNumber: string } }>; showEmployee?: boolean }) {
  return (
    <div className="table-wrap"><table className="data">
      <thead><tr><th>Claim</th>{showEmployee ? <th>Employee</th> : null}<th>Submitted</th><th className="num">Claimed</th><th className="num">Approved</th><th>Stage</th></tr></thead>
      <tbody>
        {claims.map((c) => (
          <tr key={c.id}>
            <td><Link href={`/expenses/${c.id}`} className="strong text-sm">{c.claimNumber}</Link><div className="text-xs subtle">{c.title}</div></td>
            {showEmployee && c.employee ? <td><Person name={c.employee.displayName ?? ""} meta={c.employee.employeeNumber} /></td> : null}
            <td className="text-sm nowrap">{formatDate(c.submittedAt ?? c.createdAt)}</td>
            <td className="num">{formatINR(Number(c.claimedTotal))}</td>
            <td className="num">{Number(c.approvedTotal) ? formatINR(Number(c.approvedTotal)) : "—"}</td>
            <td><Badge tone={TONE[c.stage]}>{label(c.stage)}</Badge></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

async function Mine({ viewer }: { viewer: V }) {
  if (!viewer.employee) return <Card><Empty title="No employee record" /></Card>;
  const [claims, cats, policy, advances] = await Promise.all([
    prisma.expenseClaim.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { createdAt: "desc" } }),
    prisma.expenseCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.expensePolicy.findFirst({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { isDefault: "desc" }, include: { categories: true } }),
    prisma.cashAdvance.findMany({ where: { employeeId: viewer.employee.id, status: { in: ["DISBURSED", "PARTIALLY_SETTLED"] } } }),
  ]);
  const cap = (c: (typeof cats)[number]) => {
    const p = policy?.categories.find((x) => x.categoryId === c.id)?.maxAmount;
    const caps = [c.maxAmount, p].filter((v) => v !== null && v !== undefined).map(Number);
    return caps.length ? Math.min(...caps) : null;
  };
  const open = claims.filter((c) => ["SUBMITTED", "PARTIALLY_APPROVED"].includes(c.stage));
  const pending = claims.filter((c) => c.stage === "PAYMENT_PENDING");
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Awaiting approval" value={formatINR(open.reduce((s, c) => s + Number(c.claimedTotal), 0))} meta={`${open.length} claim(s)`} />
        <Stat label="Coming with salary" value={formatINR(pending.reduce((s, c) => s + Number(c.approvedTotal), 0))} meta="approved, paid on finalisation" />
        <Stat label="Advance to settle" value={formatINR(advances.reduce((s, a) => s + Number(a.outstanding), 0))} meta={advances.length ? "claim against it" : "none open"} />
      </div>
      <Card title="New claim" description="Limits and receipt rules are checked as you enter each expense.">
        <Disclosure label="New claim">
          <ClaimForm categories={cats.map((c) => ({ value: c.id, label: c.name, cap: cap(c), receiptAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove) }))}
            advances={advances.map((a) => ({ value: a.id, label: `${a.purpose} — ₹${Number(a.outstanding).toLocaleString("en-IN")} open` }))} />
        </Disclosure>
      </Card>
      <Card tight title="My claims">{claims.length === 0 ? <Empty title="No claims yet" /> : <ClaimTable claims={claims} />}</Card>
    </div>
  );
}

async function Approvals({ viewer }: { viewer: V }) {
  const finance = can(viewer, P.EXPENSE_MANAGE);
  const [mgr, fin, recent] = await Promise.all([
    prisma.expenseClaim.findMany({ where: { tenantId: viewer.tenantId, stage: "SUBMITTED", employee: scopedEmployeeWhere(viewer, P.EXPENSE_APPROVE), NOT: { employeeId: viewer.employee?.id ?? "__" } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { submittedAt: "asc" } }),
    finance ? prisma.expenseClaim.findMany({ where: { tenantId: viewer.tenantId, stage: { in: ["PARTIALLY_APPROVED", "APPROVED"] }, NOT: { employeeId: viewer.employee?.id ?? "__" } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { approvedAt: "asc" } }) : [],
    prisma.expenseClaim.findMany({ where: { tenantId: viewer.tenantId, approvedBy: viewer.user.id }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { approvedAt: "desc" }, take: 10 }),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title={`Waiting for you (${mgr.length})`}>{mgr.length === 0 ? <Empty title="Nothing to approve" /> : <ClaimTable claims={mgr} showEmployee />}</Card>
      {finance ? <Card tight title={`Finance (${fin.length})`} description="Escalated claims, and approved claims to be paid outside payroll">{fin.length === 0 ? <Empty title="Nothing for finance" /> : <ClaimTable claims={fin} showEmployee />}</Card> : null}
      <Card tight title="You approved recently">{recent.length === 0 ? <Empty title="None yet" /> : <ClaimTable claims={recent} showEmployee />}</Card>
    </div>
  );
}

async function Advances({ viewer }: { viewer: V }) {
  const approver = canAny(viewer, [P.ADVANCE_APPROVE, P.EXPENSE_MANAGE]);
  const [mine, others] = await Promise.all([
    viewer.employee ? prisma.cashAdvance.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { createdAt: "desc" } }) : [],
    approver ? prisma.cashAdvance.findMany({ where: { tenantId: viewer.tenantId, NOT: { employeeId: viewer.employee?.id ?? "__" } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" }, take: 50 }) : [],
  ]);
  const ops = (s: string) => [
    ...(s === "REQUESTED" && can(viewer, P.ADVANCE_APPROVE) ? ["approve", "reject"] : []),
    ...(s === "APPROVED" && can(viewer, P.EXPENSE_MANAGE) ? ["disburse"] : []),
    ...(["DISBURSED", "PARTIALLY_SETTLED"].includes(s) && can(viewer, P.EXPENSE_MANAGE) ? ["recover"] : []),
  ];
  const row = (a: (typeof others)[number] | (typeof mine)[number], who?: { displayName: string | null; employeeNumber: string }) => (
    <tr key={a.id}>
      {who ? <td><Person name={who.displayName ?? ""} meta={who.employeeNumber} /></td> : null}
      <td className="text-sm">{a.purpose}</td>
      <td className="num">{formatINR(Number(a.amount))}</td>
      <td className="num">{Number(a.outstanding) ? formatINR(Number(a.outstanding)) : "—"}</td>
      <td><Badge tone={TONE[a.status]}>{label(a.status)}</Badge></td>
      <td className="right">{who ? <AdvanceOps advanceId={a.id} ops={ops(a.status)} /> : null}</td>
    </tr>
  );
  return (
    <div className="stack gap-4">
      {viewer.employee ? <Card title="Request a cash advance" description="Settle it with expense claims; anything unclaimed is recovered from salary."><Disclosure label="Request advance"><AdvanceForm /></Disclosure></Card> : null}
      <Card tight title="My advances">{mine.length === 0 ? <Empty title="No advances" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Purpose</th><th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead><tbody>{mine.map((a) => row(a))}</tbody></table></div>}</Card>
      {approver ? <Card tight title="All advances">{others.length === 0 ? <Empty title="No advances" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Employee</th><th>Purpose</th><th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead><tbody>{others.map((a) => row(a, a.employee))}</tbody></table></div>}</Card> : null}
    </div>
  );
}

async function Travel({ viewer }: { viewer: V }) {
  const desk = can(viewer, P.TRAVEL_MANAGE);
  const reports = [...viewer.allReportIds];
  const trips = await prisma.travelRequest.findMany({
    where: { tenantId: viewer.tenantId, OR: [{ employeeId: viewer.employee?.id ?? "__" }, { employeeId: { in: reports } }, ...(desk ? [{}] : [])] },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } }, orderBy: { departDate: "desc" }, take: 60,
  });
  return (
    <div className="stack gap-4">
      {viewer.employee ? <Card title="Request a trip" description="Your manager approves; the travel desk books."><Disclosure label="New trip"><TripForm /></Disclosure></Card> : null}
      <Card tight title="Trips">
        {trips.length === 0 ? <Empty title="No trips" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Trip</th><th>Traveller</th><th>Dates</th><th className="num">Cost</th><th>Status</th><th /></tr></thead>
            <tbody>
              {trips.map((t) => {
                const own = t.employeeId === viewer.employee?.id;
                const ops = [
                  ...(t.status === "REQUESTED" && !own && reports.includes(t.employeeId) ? ["approve", "reject"] : []),
                  ...(t.status === "APPROVED" && desk ? ["book"] : []),
                  ...(["BOOKED", "IN_PROGRESS"].includes(t.status) && (own || desk) ? ["complete"] : []),
                  ...(["REQUESTED", "APPROVED", "BOOKED"].includes(t.status) && (own || desk) ? ["cancel"] : []),
                ];
                return (
                  <tr key={t.id}>
                    <td><div className="strong text-sm">{t.fromCity} → {t.toCity}</div><div className="text-xs subtle">{t.requestNumber} · {t.purpose}</div></td>
                    <td className="text-sm">{t.employee.displayName}</td>
                    <td className="text-sm nowrap">{formatDate(t.departDate)}{t.returnDate ? ` – ${formatDate(t.returnDate)}` : ""}</td>
                    <td className="num text-sm">{t.actualCost ? formatINR(Number(t.actualCost)) : t.estimatedCost ? `~${formatINR(Number(t.estimatedCost))}` : "—"}</td>
                    <td><Badge tone={TONE[t.status] ?? "neutral"}>{label(t.status)}</Badge>{t.bookingRef ? <div className="text-xs subtle">{t.bookingRef}</div> : null}</td>
                    <td className="right">{ops.length ? <TripOps tripId={t.id} ops={ops} /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

async function Policy({ tenantId }: { tenantId: string }) {
  const [cats, policy] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.expensePolicy.findFirst({ where: { tenantId, isActive: true }, orderBy: { isDefault: "desc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card title={policy?.name ?? "Expense policy"} description={policy ? `Claims above ${policy.escalationAboveAmount ? formatINR(Number(policy.escalationAboveAmount)) : "—"} need finance approval after the manager. Future-dated expenses ${policy.allowFutureDated ? "allowed" : "refused"}; anything older than 60 days refused.` : "No policy yet."}><span /></Card>
      {cats.map((c) => <Card key={c.id} title={c.name}><CategoryForm c={{ id: c.id, name: c.name, maxAmount: c.maxAmount === null ? null : Number(c.maxAmount), receiptRequiredAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove) }} /></Card>)}
      <Card title="New category"><Disclosure label="Add a category"><CategoryForm /></Disclosure></Card>
    </div>
  );
}
