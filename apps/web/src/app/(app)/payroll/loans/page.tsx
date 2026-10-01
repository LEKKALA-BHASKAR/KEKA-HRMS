import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { concessionalLoanPerquisite } from "@keka/payroll";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress } from "@/components/ui";
import { LoanDecision, LoanOps, LoanCategoryForm, LoanRuleForm, LoanPolicyForm } from "../_forms/loans";
import { Disclosure } from "../../org/forms";

const P = PERMISSIONS;
const TABS = { requests: "Requests", active: "Active", closed: "Closed", setup: "Categories & policy" } as const;
type Tab = keyof typeof TABS;

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.LOAN_MANAGE);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "requests") as Tab;
  const scope = scopedEmployeeWhere(viewer, P.LOAN_MANAGE);
  const all = await prisma.loan.findMany({
    where: { employee: scope },
    include: {
      employee: { select: { id: true, displayName: true, employeeNumber: true } },
      category: true,
      schedule: { orderBy: { sequence: "asc" } },
    },
    orderBy: { requestedAt: "desc" },
  });
  const pending = all.filter((l) => ["REQUESTED", "PENDING_APPROVAL"].includes(l.status));
  const active = all.filter((l) => ["APPROVED", "DISBURSED", "ACTIVE"].includes(l.status));
  const closed = all.filter((l) => ["CLOSED", "FORECLOSED", "REJECTED"].includes(l.status));
  const outstanding = active.reduce((s, l) => s + Number(l.outstanding), 0);
  const now = new Date();
  const thisMonth = active.flatMap((l) => l.schedule.filter((i) => i.year === now.getUTCFullYear() && i.month === now.getUTCMonth() + 1 && i.status === "SCHEDULED"));

  return (
    <>
      <PageHead title="Loans & advances" subtitle="Requests, repayment schedules, and EMIs recovered through payroll" />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Awaiting approval" value={String(pending.length)} meta={formatINR(pending.reduce((s, l) => s + Number(l.principal), 0))} />
        <Stat label="Active loans" value={String(active.length)} meta="approved or repaying" />
        <Stat label="Outstanding" value={formatINR(outstanding)} meta="principal yet to recover" />
        <Stat label="EMIs this month" value={formatINR(thisMonth.reduce((s, i) => s + Number(i.totalAmount), 0))} meta={`${thisMonth.length} instalment(s) in payroll`} />
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Link key={t} href={`/payroll/loans?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TABS[t]}{t === "requests" && pending.length ? ` (${pending.length})` : ""}
          </Link>
        ))}
      </div>

      {tab === "requests" ? (
        <Card tight>
          {pending.length === 0 ? <Empty title="No loan requests waiting" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Type</th><th className="num">Amount</th><th className="num">Months</th><th className="num">EMI</th><th>Purpose</th><th>Requested</th><th /></tr></thead>
                <tbody>
                  {pending.map((l) => (
                    <tr key={l.id}>
                      <td><Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} /></td>
                      <td>{l.category.name}</td>
                      <td className="num">{formatINR(Number(l.principal))}</td>
                      <td className="num">{l.installments}</td>
                      <td className="num">{formatINR(Number(l.emiAmount))}</td>
                      <td className="text-sm muted" style={{ maxWidth: 240 }}>{l.purpose ?? "—"}</td>
                      <td className="nowrap text-sm">{formatDate(l.requestedAt)}</td>
                      <td className="right">{can(viewer, P.LOAN_APPROVE) && l.employeeId !== viewer.employee?.id ? <LoanDecision loanId={l.id} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "active" || tab === "closed" ? (
        <Card tight>
          {(tab === "active" ? active : closed).length === 0 ? <Empty title={`No ${tab} loans`} /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Type</th><th className="num">Principal</th><th style={{ width: 170 }}>Repaid</th><th className="num">Outstanding</th><th>Next EMI</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {(tab === "active" ? active : closed).map((l) => {
                    const next = l.schedule.find((i) => i.status === "SCHEDULED");
                    const paidCount = l.schedule.filter((i) => ["DEDUCTED", "PREPAID"].includes(i.status)).length;
                    const upcoming = l.schedule.filter((i) => i.status === "SCHEDULED").slice(0, 3).map((i) => ({ value: `${i.year}-${i.month}`, label: `${i.month}/${i.year}` }));
                    const perq = l.category.isConcessional && l.category.sbiBenchmarkRate
                      ? concessionalLoanPerquisite({ outstanding: Number(l.outstanding), benchmarkRate: Number(l.category.sbiBenchmarkRate), chargedRate: Number(l.interestRate), aggregateOutstanding: Number(l.outstanding) })
                      : null;
                    return (
                      <tr key={l.id}>
                        <td><Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} /></td>
                        <td>{l.category.name}<div className="text-xs subtle">{l.interestType === "NONE" ? "interest-free" : `${Number(l.interestRate)}% ${l.interestType.toLowerCase()}`}</div></td>
                        <td className="num">{formatINR(Number(l.principal))}</td>
                        <td>
                          <Progress value={paidCount} max={Math.max(1, l.schedule.length)} />
                          <div className="text-xs subtle" style={{ marginTop: 3 }}>{paidCount}/{l.schedule.length} EMIs · {formatINR(Number(l.totalRepaid))}</div>
                        </td>
                        <td className="num">{formatINR(Number(l.outstanding))}{perq && perq.monthly.gt(0) ? <div className="text-xs" style={{ color: "var(--warning)" }}>perquisite {formatINR(perq.monthly.toNumber())}/mo</div> : null}</td>
                        <td className="nowrap text-sm">{next ? `${formatINR(Number(next.totalAmount))} · ${next.month}/${next.year}` : "—"}</td>
                        <td><Badge tone={l.status === "ACTIVE" ? "success" : l.status === "APPROVED" ? "warning" : "neutral"}>{l.status.toLowerCase()}</Badge>{l.decisionNote ? <div className="text-xs subtle">{l.decisionNote}</div> : null}</td>
                        <td className="right">{tab === "active" ? <LoanOps loanId={l.id} status={l.status} upcoming={upcoming} /> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "setup" ? <Setup tenantId={viewer.tenantId} /> : null}
    </>
  );
}

async function Setup({ tenantId }: { tenantId: string }) {
  const [categories, policy] = await Promise.all([
    prisma.loanCategory.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.loanPolicy.findFirst({ where: { tenantId, isActive: true }, include: { rules: true } }),
  ]);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return (
    <div className="stack gap-4">
      {policy ? (
        <Card title={`Eligibility — ${policy.name}`}>
          <LoanPolicyForm policy={{ id: policy.id, requireProbationComplete: policy.requireProbationComplete, blockOnNoticePeriod: policy.blockOnNoticePeriod, minDaysFromJoining: policy.minDaysFromJoining, minAnnualSalary: n(policy.minAnnualSalary), maxAnnualSalary: n(policy.maxAnnualSalary) }} />
        </Card>
      ) : null}
      {categories.map((c) => {
        const rule = policy?.rules.find((r) => r.categoryId === c.id);
        return (
          <Card key={c.id} title={c.name} description={c.isConcessional ? `Concessional · benchmark ${Number(c.sbiBenchmarkRate ?? 0)}%` : undefined}>
            <LoanCategoryForm category={{ id: c.id, name: c.name, description: c.description, isConcessional: c.isConcessional, sbiBenchmarkRate: n(c.sbiBenchmarkRate) }} />
            {policy ? (
              <>
                <div className="divider" />
                <div className="text-xs strong subtle" style={{ marginBottom: 8 }}>REPAYMENT RULE{rule ? "" : " — none yet, so this category cannot be requested"}</div>
                <LoanRuleForm policyId={policy.id} categoryId={c.id} rule={rule ? { interestType: rule.interestType, interestRate: n(rule.interestRate), maxInstallments: rule.maxInstallments, commencementMonths: rule.commencementMonths, maxAmount: n(rule.maxAmount), maxPercentOfSalary: n(rule.maxPercentOfSalary) } : undefined} />
              </>
            ) : null}
          </Card>
        );
      })}
      <Card title="New category"><Disclosure label="Add a loan category"><LoanCategoryForm /></Disclosure></Card>
    </div>
  );
}
