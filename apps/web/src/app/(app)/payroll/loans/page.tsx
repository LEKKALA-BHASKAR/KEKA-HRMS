import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR, MONTH_SHORT } from "@keka/shared";
import { concessionalLoanPerquisite } from "@keka/payroll";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat, Progress } from "@/components/ui";
import { LoanDecision, LoanOps, LoanCategoryForm, LoanRuleForm, LoanPolicyForm } from "../_forms/loans";
import { Disclosure } from "../../org/forms";
import { DepthForm } from "../_forms/depth";
import { createLoanPolicyAction, assignLoanPolicyAction, removeLoanPolicyAssignmentAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;
const TABS = { requests: "Requests", active: "Active", closed: "Closed", setup: "Categories & policy", policies: "Policies & assignment" } as const;
type Tab = keyof typeof TABS;

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ tab?: string; policy?: string }> }) {
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
  const closed = all.filter((l) => ["CLOSED", "FORECLOSED", "REJECTED", "WITHDRAWN"].includes(l.status));
  const ym = (y: number | null, m: number | null) => (y && m ? `${MONTH_SHORT[m - 1]} ${y}` : "—");
  const outstanding = active.reduce((s, l) => s + Number(l.outstanding), 0);
  const now = new Date();
  const thisMonth = active.flatMap((l) => l.schedule.filter((i) => i.year === now.getUTCFullYear() && i.month === now.getUTCMonth() + 1 && i.status === "SCHEDULED"));

  return (
    <>
      <PageHead title="Loans & advances" subtitle="Requests, repayment schedules, and EMIs recovered through payroll"
        actions={<><Link className="btn" href="/payroll/loans/portfolio">Portfolio & reports</Link></>} />
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
                <thead><tr><th>Employee</th><th>Type</th><th className="num">Amount</th><th className="num">Months</th><th className="num">EMI</th><th>Expected</th><th>EMI from</th><th>Purpose</th><th>Requested</th><th /></tr></thead>
                <tbody>
                  {pending.map((l) => (
                    <tr key={l.id}>
                      <td><Link href={`/payroll/loans/${l.id}`}><Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} /></Link></td>
                      <td>{l.category.name}{l.category.code ? <div className="text-xs subtle">{l.category.code}</div> : null}{l.documentUrl ? <div><a className="text-xs" href={l.documentUrl}>Document</a></div> : null}</td>
                      <td className="num">{formatINR(Number(l.principal))}</td>
                      <td className="num">{l.installments}</td>
                      <td className="num">{formatINR(Number(l.emiAmount))}</td>
                      <td className="nowrap text-sm">{ym(l.expectedYear, l.expectedMonth)}</td>
                      <td className="nowrap text-sm">{ym(l.startYear, l.startMonth)}</td>
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
                        <td><Link href={`/payroll/loans/${l.id}`}><Person name={l.employee.displayName ?? ""} meta={l.employee.employeeNumber} /></Link></td>
                        <td>{l.category.name}<div className="text-xs subtle">{l.interestType === "NONE" ? "interest-free" : `${Number(l.interestRate)}% ${l.interestType.toLowerCase()}`}</div></td>
                        <td className="num">{formatINR(Number(l.principal))}</td>
                        <td>
                          <Progress value={paidCount} max={Math.max(1, l.schedule.length)} />
                          <div className="text-xs subtle" style={{ marginTop: 3 }}>{paidCount}/{l.schedule.length} EMIs · {formatINR(Number(l.totalRepaid))}</div>
                        </td>
                        <td className="num">{formatINR(Number(l.outstanding))}{perq && perq.monthly.gt(0) ? <div className="text-xs" style={{ color: "var(--warning)" }}>perquisite {formatINR(perq.monthly.toNumber())}/mo</div> : null}</td>
                        <td className="nowrap text-sm">{next ? `${formatINR(Number(next.totalAmount))} · ${next.month}/${next.year}` : "—"}</td>
                        <td><Badge tone={l.status === "ACTIVE" ? "success" : l.status === "APPROVED" ? "warning" : l.status === "REJECTED" ? "danger" : "neutral"}>{l.status.toLowerCase()}</Badge>{l.decisionNote ? <div className="text-xs subtle">{l.decisionNote}</div> : null}</td>
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

      {tab === "setup" ? <Setup tenantId={viewer.tenantId} policyId={sp.policy} /> : null}
      {tab === "policies" ? <Policies tenantId={viewer.tenantId} scope={scope} /> : null}
    </>
  );
}

async function Setup({ tenantId, policyId }: { tenantId: string; policyId?: string }) {
  const [categories, policies, pendingChanges] = await Promise.all([
    prisma.loanCategory.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.loanPolicy.findMany({ where: { tenantId, isActive: true }, include: { rules: true }, orderBy: { createdAt: "asc" } }),
    prisma.loanProductChange.findMany({ where: { tenantId, status: "PENDING" } }),
  ]);
  const policy = policies.find((p) => p.id === policyId) ?? policies[0] ?? null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return (
    <div className="stack gap-4">
      {policies.length > 1 ? (
        <div className="row gap-2 wrap">
          <span className="text-xs subtle">Policy:</span>
          {policies.map((p) => <Link key={p.id} className={`btn sm${p.id === policy?.id ? " primary" : ""}`} href={`/payroll/loans?tab=setup&policy=${p.id}`}>{p.name}</Link>)}
        </div>
      ) : null}
      {policy ? (
        <Card title={`Eligibility — ${policy.name}`}>
          <LoanPolicyForm policy={{ id: policy.id, requireProbationComplete: policy.requireProbationComplete, blockOnNoticePeriod: policy.blockOnNoticePeriod, minDaysFromJoining: policy.minDaysFromJoining, minAnnualSalary: n(policy.minAnnualSalary), maxAnnualSalary: n(policy.maxAnnualSalary), requireChangeApproval: policy.requireChangeApproval }} />
        </Card>
      ) : null}
      {categories.map((c) => {
        const rule = policy?.rules.find((r) => r.categoryId === c.id);
        return (
          <Card key={c.id} title={c.code ? `${c.name} · ${c.code}` : c.name} description={c.isConcessional ? `Concessional · benchmark ${Number(c.sbiBenchmarkRate ?? 0)}%` : undefined}>
            <LoanCategoryForm category={{ id: c.id, name: c.name, code: c.code, description: c.description, isConcessional: c.isConcessional, sbiBenchmarkRate: n(c.sbiBenchmarkRate), isEmergency: c.isEmergency, emergencyMaxMonthsSalary: n(c.emergencyMaxMonthsSalary) }} />
            {policy ? (
              <>
                <div className="divider" />
                <div className="text-xs strong subtle" style={{ marginBottom: 8 }}>REPAYMENT RULE{rule ? "" : " — none yet, so this category cannot be requested"}</div>
                <LoanRuleForm policyId={policy.id} categoryId={c.id} rule={rule ? { interestType: rule.interestType, interestRate: n(rule.interestRate), maxInstallments: rule.maxInstallments, commencementMonths: rule.commencementMonths, maxAmount: n(rule.maxAmount), maxPercentOfSalary: n(rule.maxPercentOfSalary), requiresDocuments: rule.requiresDocuments, processingFeePct: n(rule.processingFeePct), processingFeeFlat: n(rule.processingFeeFlat) } : undefined} />
                {pendingChanges.filter((ch) => ch.categoryId === c.id && ch.policyId === policy.id).map((ch) => <div key={ch.id} className="text-xs" style={{ color: "var(--warning)", marginTop: 6 }}>Waiting for approval: {ch.summary}</div>)}
              </>
            ) : null}
          </Card>
        );
      })}
      <Card title="New category"><Disclosure label="Add a loan category"><LoanCategoryForm /></Disclosure></Card>
    </div>
  );
}

/** Several loan policies, each assigned to pay groups or individual employees. */
async function Policies({ tenantId, scope }: { tenantId: string; scope: Record<string, unknown> }) {
  const [policies, payGroups, employees] = await Promise.all([
    prisma.loanPolicy.findMany({
      where: { tenantId }, orderBy: { createdAt: "asc" },
      include: {
        rules: { include: { category: { select: { name: true } } } },
        assignments: { include: { payGroup: { select: { name: true } }, employee: { select: { displayName: true, employeeNumber: true } } } },
      },
    }),
    prisma.payGroup.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { ...scope, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
  ]);
  const unassigned = policies.filter((p) => p.assignments.length === 0);
  return (
    <div className="stack gap-4">
      <Card title="How a policy is chosen" description="An employee's own assignment wins, then their pay group's; a policy assigned to no one covers everyone else." tight>
        <div style={{ padding: 14 }} className="text-sm">
          {unassigned.length ? <>Default for everyone else: <strong>{unassigned[0].name}</strong>{unassigned.length > 1 ? ` (and ${unassigned.length - 1} more unassigned — the oldest applies)` : ""}.</> : "Every policy is assigned, so employees outside those assignments cannot borrow."}
        </div>
      </Card>
      {policies.map((p) => (
        <Card key={p.id} title={p.name} description={[p.description, p.minDaysFromJoining ? `Eligible after ${Math.round(p.minDaysFromJoining / 30.4375)} month(s) of service` : "No service minimum", p.isActive ? null : "Inactive"].filter(Boolean).join(" · ")}
          action={<Link className="btn sm" href={`/payroll/loans?tab=setup&policy=${p.id}`}>Edit rules</Link>}>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="data">
              <thead><tr><th>Category</th><th className="num">Max amount</th><th className="num">Max % of CTC</th><th>Interest</th><th className="num">Max tenure</th></tr></thead>
              <tbody>
                {p.rules.length === 0 ? <tr><td colSpan={5} className="subtle">No category rules yet.</td></tr> : p.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.category.name}</td>
                    <td className="num">{r.maxAmount ? formatINR(Number(r.maxAmount)) : "—"}</td>
                    <td className="num">{r.maxPercentOfSalary ? `${Number(r.maxPercentOfSalary)}%` : "—"}</td>
                    <td>{r.interestType === "NONE" ? "Interest-free" : `${Number(r.interestRate ?? 0)}% ${r.interestType.toLowerCase()}`}</td>
                    <td className="num">{r.maxInstallments} months</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs strong subtle" style={{ marginBottom: 6 }}>ASSIGNED TO</div>
          {p.assignments.length === 0 ? <div className="text-sm subtle" style={{ marginBottom: 8 }}>No one specifically.</div> : (
            <div className="stack gap-1" style={{ marginBottom: 8 }}>
              {p.assignments.map((a) => (
                <div key={a.id} className="row gap-2">
                  <Badge tone={a.employeeId ? "info" : "brand"}>{a.employeeId ? "Employee" : "Pay group"}</Badge>
                  <span className="text-sm">{a.employee ? `${a.employee.displayName} (${a.employee.employeeNumber})` : a.payGroup?.name}</span>
                  <DepthForm action={removeLoanPolicyAssignmentAction} inline variant="ghost" submitLabel="Remove" hidden={{ id: a.id }} />
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-2">
            <DepthForm action={assignLoanPolicyAction} inline submitLabel="Assign pay group" variant="default" hidden={{ policyId: p.id }}>
              <select className="select" name="payGroupId" required style={{ maxWidth: 220 }}>
                <option value="">Pay group…</option>
                {payGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </DepthForm>
            <DepthForm action={assignLoanPolicyAction} inline submitLabel="Assign employee" variant="default" hidden={{ policyId: p.id }}>
              <select className="select" name="employeeId" required style={{ maxWidth: 240 }}>
                <option value="">Employee…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.displayName}</option>)}
              </select>
            </DepthForm>
          </div>
        </Card>
      ))}
      <Card title="New loan policy" description="Set its eligibility here; then add the per-category maximum amount, interest and tenure under Categories & policy.">
        <DepthForm action={createLoanPolicyAction} submitLabel="Create policy">
          <div className="grid grid-2">
            <div className="field"><label className="label" htmlFor="lp-name">Name</label><input id="lp-name" className="input" name="name" required maxLength={120} placeholder="e.g. Senior staff loans" /></div>
            <div className="field"><label className="label" htmlFor="lp-months">Eligible after (months of service)</label><input id="lp-months" className="input num" name="eligibilityMonths" type="number" min={0} max={120} placeholder="e.g. 6" /></div>
            <div className="field"><label className="label" htmlFor="lp-desc">Description</label><input id="lp-desc" className="input" name="description" maxLength={300} /></div>
            <div className="field"><label className="label" htmlFor="lp-copy">Copy category rules from</label>
              <select id="lp-copy" className="select" name="copyFrom"><option value="">Start empty</option>{policies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            </div>
          </div>
          <label className="checkbox-row"><input type="checkbox" name="requireProbationComplete" defaultChecked /><span className="text-sm">Only after probation is complete</span></label>
        </DepthForm>
      </Card>
    </div>
  );
}
