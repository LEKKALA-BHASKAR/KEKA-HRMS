import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Callout } from "@/components/ui";
import { MILEAGE_VEHICLES } from "@keka/services";
import { ClaimForm, AdvanceForm, AdvanceOps, TripForm, TripOps, CategoryForm } from "./forms";
import { Disclosure } from "../org/forms";
import { GrowthForm } from "@/components/growth-forms";
import { requestPreApprovalAction, delegateMoneyApprovalsAction } from "@/app/actions/expense-depth";
import { delegatedQueues } from "@/lib/money";

const P = PERMISSIONS;
const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  DRAFT: "neutral", SUBMITTED: "warning", PARTIALLY_APPROVED: "warning", APPROVED: "info", PAYMENT_PENDING: "info", PAID: "success", REJECTED: "danger", CANCELLED: "neutral",
  REQUESTED: "warning", DISBURSED: "info", PARTIALLY_SETTLED: "info", SETTLED: "success", RECOVERED: "success", BOOKED: "info", COMPLETED: "success", IN_PROGRESS: "info",
};
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const delegated = await prisma.approverDelegation.count({ where: { tenantId: viewer.tenantId, delegateUserId: viewer.user.id, revokedAt: null, endsOn: { gte: new Date() }, entityTypes: { hasSome: ["EXPENSE_CLAIM", "LOAN_REQUEST"] } } });
  const approver = canAny(viewer, [P.EXPENSE_APPROVE, P.EXPENSE_MANAGE]) || viewer.allReportIds.size > 0 || delegated > 0;
  const tabs = ["mine", ...(approver ? ["approvals"] : []), "advances", "travel", ...(can(viewer, P.EXPENSE_MANAGE) ? ["policy"] : [])];
  const sp = await searchParams;
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "mine";
  return (
    <>
      <PageHead title="Expenses & travel" subtitle="Claims checked against policy as you enter them, paid with your salary once approved"
        actions={<>
          <Link className="btn" href="/expenses/travel">Trips</Link>
          {can(viewer, P.EXPENSE_MANAGE) ? <><Link className="btn" href="/expenses/policies">Policies</Link><Link className="btn" href="/expenses/rates">Rates</Link><Link className="btn" href="/expenses/audit">Audit sampling</Link></> : null}
          {can(viewer, P.EXPENSE_MANAGE) ? <Link className="btn" href="/expenses/reports">Reports</Link> : null}
        </>} />
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
  const [claims, cats, policy, advances, projects, preApprovals, trips] = await Promise.all([
    prisma.expenseClaim.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { createdAt: "desc" } }),
    prisma.expenseCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.expensePolicy.findFirst({ where: { tenantId: viewer.tenantId, isActive: true, status: "ACTIVE" }, orderBy: { isDefault: "desc" }, include: { categories: true } }),
    prisma.cashAdvance.findMany({ where: { employeeId: viewer.employee.id, status: { in: ["DISBURSED", "PARTIALLY_SETTLED"] } } }),
    prisma.project.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" }, take: 200 }),
    prisma.expensePreApproval.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.travelRequest.findMany({ where: { employeeId: viewer.employee.id, status: { in: ["APPROVED", "BOOKED", "IN_PROGRESS", "COMPLETED"] } }, orderBy: { departDate: "desc" }, take: 20, select: { id: true, requestNumber: true, toCity: true } }),
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
          <ClaimForm categories={cats.map((c) => ({ value: c.id, label: c.name, cap: cap(c), receiptAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove), kind: c.kind }))}
            advances={advances.map((a) => ({ value: a.id, label: `${a.purpose} — ₹${Number(a.outstanding).toLocaleString("en-IN")} open` }))}
            projects={projects.map((p) => ({ value: p.id, label: `${p.name}${p.code ? ` (${p.code})` : ""}` }))}
            preApprovals={preApprovals.filter((p) => p.status === "APPROVED").map((p) => ({ value: p.id, label: `${p.number} · ${p.purpose} — ₹${(Number(p.estimatedAmount) - Number(p.usedAmount)).toLocaleString("en-IN")} left` }))}
            trips={trips.map((t) => ({ value: t.id, label: `${t.requestNumber} · ${t.toCity}` }))}
            vehicles={Object.entries(MILEAGE_VEHICLES).map(([value, label]) => ({ value, label }))} />
        </Disclosure>
      </Card>
      <Card title="Pre-approvals" description="Ask before spending on conferences, client entertainment or anything above your usual limits; claim against it afterwards.">
        <Disclosure label="Request pre-approval">
          <GrowthForm action={requestPreApprovalAction} submitLabel="Request" fields={[
            { name: "purpose", label: "What for", required: true, wide: true },
            { name: "categoryId", label: "Category", type: "select", options: cats.map((c) => ({ value: c.id, label: c.name })) },
            { name: "estimatedAmount", label: "Estimated amount (₹)", type: "number", required: true },
            { name: "expectedDate", label: "Expected on", type: "date" },
          ]} />
        </Disclosure>
        {preApprovals.length ? (
          <div className="table-wrap" style={{ marginTop: 10 }}><table className="data">
            <thead><tr><th>Number</th><th>Purpose</th><th className="num">Estimate</th><th className="num">Used</th><th>Status</th></tr></thead>
            <tbody>{preApprovals.map((p) => <tr key={p.id}><td className="text-sm strong">{p.number}</td><td className="text-sm">{p.purpose}</td><td className="num">{formatINR(Number(p.estimatedAmount))}</td><td className="num">{formatINR(Number(p.usedAmount))}</td><td><Badge tone={p.status === "APPROVED" ? "success" : p.status === "PENDING" ? "warning" : p.status === "REJECTED" ? "danger" : "neutral"}>{label(p.status)}</Badge></td></tr>)}</tbody>
          </table></div>
        ) : null}
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
  const [colleagues, delegations, onBehalf] = await Promise.all([
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, userId: { not: null }, NOT: { id: viewer.employee?.id ?? "__" } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" }, take: 500 }),
    prisma.approverDelegation.findMany({ where: { tenantId: viewer.tenantId, OR: [{ delegatorUserId: viewer.user.id }, { delegateUserId: viewer.user.id }], entityTypes: { hasSome: ["EXPENSE_CLAIM", "LOAN_REQUEST"] }, endsOn: { gte: new Date() } }, orderBy: { startsOn: "asc" } }),
    delegatedQueues(viewer),
  ]);
  return (
    <div className="stack gap-4">
      <Card title="Delegate approvals" description="Away? Hand your expense-claim approvals to a colleague for a period. Their decisions are recorded as made on your behalf.">
        <Disclosure label="Delegate">
          <GrowthForm action={delegateMoneyApprovalsAction} submitLabel="Delegate" fields={[
            { name: "type", label: "Approvals", type: "select", required: true, options: [{ value: "EXPENSE_CLAIM", label: "Expense claims" }, { value: "LOAN_REQUEST", label: "Loan requests" }], defaultValue: "EXPENSE_CLAIM" },
            { name: "delegateEmployeeId", label: "Delegate to", type: "select", required: true, options: colleagues.map((c) => ({ value: c.id, label: `${c.displayName} (${c.employeeNumber})` })) },
            { name: "startsOn", label: "From", type: "date", required: true },
            { name: "endsOn", label: "Until", type: "date", required: true },
            { name: "reason", label: "Reason", wide: true },
          ]} />
        </Disclosure>
        {delegations.length ? <ul className="text-sm" style={{ marginTop: 8 }}>{delegations.map((d) => <li key={d.id}>{d.delegatorUserId === viewer.user.id ? "You delegated" : "Delegated to you"}: {d.entityTypes.join(", ").toLowerCase().replace(/_/g, " ")} {formatDate(d.startsOn)} – {formatDate(d.endsOn)}</li>)}</ul> : null}
      </Card>
      {onBehalf.claims.length || onBehalf.loans.length ? (
        <Card tight title="Delegated to you" description="Waiting on approvers who handed their approvals to you">
          <div className="table-wrap"><table className="data"><tbody>
            {onBehalf.claims.map((c) => <tr key={c.id}><td><Link className="strong text-sm" href={`/expenses/${c.id}`}>{c.claimNumber}</Link><div className="text-xs subtle">{c.title}</div></td><td className="text-sm">{c.employee.displayName}</td><td className="num">{formatINR(Number(c.claimedTotal))}</td><td><Badge>expense claim</Badge></td></tr>)}
            {onBehalf.loans.map((l) => <tr key={l.id}><td><Link className="strong text-sm" href={`/payroll/loans/${l.id}`}>{l.category.name}</Link></td><td className="text-sm">{l.employee.displayName}</td><td className="num">{formatINR(Number(l.principal))}</td><td><Badge>loan request</Badge></td></tr>)}
          </tbody></table></div>
        </Card>
      ) : null}
      <Card tight title={`Waiting for you (${mgr.length})`}>{mgr.length === 0 ? <Empty title="Nothing to approve" /> : <ClaimTable claims={mgr} showEmployee />}</Card>
      {finance ? <Card tight title={`Finance (${fin.length})`} description="Escalated claims, and approved claims to be paid outside payroll">{fin.length === 0 ? <Empty title="Nothing for finance" /> : <ClaimTable claims={fin} showEmployee />}</Card> : null}
      <Card tight title="You approved recently">{recent.length === 0 ? <Empty title="None yet" /> : <ClaimTable claims={recent} showEmployee />}</Card>
    </div>
  );
}

async function Advances({ viewer }: { viewer: V }) {
  const approver = canAny(viewer, [P.ADVANCE_APPROVE, P.EXPENSE_MANAGE]);
  const [mine, others, myTrips] = await Promise.all([
    viewer.employee ? prisma.cashAdvance.findMany({ where: { employeeId: viewer.employee.id }, orderBy: { createdAt: "desc" } }) : [],
    approver ? prisma.cashAdvance.findMany({ where: { tenantId: viewer.tenantId, NOT: { employeeId: viewer.employee?.id ?? "__" } }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" }, take: 50 }) : [],
    viewer.employee ? prisma.travelRequest.findMany({ where: { employeeId: viewer.employee.id, status: { in: ["REQUESTED", "APPROVED", "BOOKED"] }, advanceId: null }, select: { id: true, requestNumber: true, toCity: true }, orderBy: { departDate: "asc" } }) : [],
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
      {viewer.employee ? <Card title="Request a cash advance" description="Settle it with expense claims; anything unclaimed is recovered from salary."><Disclosure label="Request advance"><AdvanceForm trips={myTrips.map((t) => ({ value: t.id, label: `${t.requestNumber} · ${t.toCity}` }))} /></Disclosure></Card> : null}
      <Card tight title="My advances">{mine.length === 0 ? <Empty title="No advances" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Purpose</th><th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead><tbody>{mine.map((a) => row(a))}</tbody></table></div>}</Card>
      {approver ? <Card tight title="All advances">{others.length === 0 ? <Empty title="No advances" /> : <div className="table-wrap"><table className="data"><thead><tr><th>Employee</th><th>Purpose</th><th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th><th /></tr></thead><tbody>{others.map((a) => row(a, a.employee))}</tbody></table></div>}</Card> : null}
    </div>
  );
}

async function Travel({ viewer }: { viewer: V }) {
  const desk = can(viewer, P.TRAVEL_MANAGE);
  const reports = [...viewer.allReportIds];
  const [trips, purposes] = await Promise.all([
    prisma.travelRequest.findMany({
      where: { tenantId: viewer.tenantId, OR: [{ employeeId: viewer.employee?.id ?? "__" }, { employeeId: { in: reports } }, ...(desk ? [{}] : [])] },
      include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } }, orderBy: { departDate: "desc" }, take: 60,
    }),
    prisma.tripPurpose.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Callout title="Travel desk">Open a trip for its bookings, itinerary, checklist and settlement — <Link href="/expenses/travel">all trips, search and filters</Link>{desk ? <>, <Link href="/expenses/travel/dashboard">spend dashboard and calendar</Link>, <Link href="/expenses/travel/policies">travel policies</Link></> : null}.</Callout>
      {viewer.employee ? <Card title="Request a trip" description="Your manager approves; trips outside policy, international or to risky places go on to the travel approval matrix; the travel desk books."><Disclosure label="New trip"><TripForm purposes={purposes.map((p) => ({ value: p.id, label: `${p.name}${p.isBillable ? " (billable)" : ""}` }))} /></Disclosure></Card> : null}
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
                    <td><Link href={`/expenses/travel/${t.id}`} className="strong text-sm">{t.fromCity} → {t.toCity}</Link><div className="text-xs subtle">{t.requestNumber} · {t.purpose}</div></td>
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
      <Callout title="Policies, rates and approval rules">Department, location and band policies, templates, reimbursement cut-offs and approval thresholds are kept on <Link href="/expenses/policies">Expense policies</Link>; mileage and per-diem rates on <Link href="/expenses/rates">Rates</Link>.</Callout>
      {cats.map((c) => <Card key={c.id} title={c.name}><CategoryForm c={{ id: c.id, name: c.name, maxAmount: c.maxAmount === null ? null : Number(c.maxAmount), receiptRequiredAbove: c.receiptRequiredAbove === null ? null : Number(c.receiptRequiredAbove), isTaxable: c.isTaxable, kind: c.kind }} /></Card>)}
      <Card title="New category"><Disclosure label="Add a category"><CategoryForm /></Disclosure></Card>
    </div>
  );
}
