import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate, formatINR, formatPeriod, fyLabel, fyRange, fyStartYear } from "@keka/shared";
import { explainEmployeePay } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { Panel, Field, Chip, EmptyState } from "@/components/keka";
import { ExplainCard } from "@/components/explain";
import { IconWallet } from "@/components/icons";
import { IconChevron, IconTrend } from "../_components/icons";
import { RegimeBanner } from "../_components/regime-banner";
import { resolveFor, STRUCTURE_INCLUDE } from "../_lib/data";
import { inr, regimeSwitchState } from "../_lib/rules";
import s from "../finances.module.css";

export const metadata = { title: "My Salary" };

const n = (v: unknown) => Number(v ?? 0);
const FREQ: Record<string, string> = { MONTHLY: "Monthly", SEMI_MONTHLY: "Semi-monthly", WEEKLY: "Weekly", BI_WEEKLY: "Fortnightly" };
const TYPE_LABEL: Record<string, string> = {
  EARNING: "Earnings", EMPLOYER_CONTRIBUTION: "Employer contributions", DEDUCTION: "Deductions", REIMBURSEMENT: "Reimbursements", PERK: "Perquisites",
};

export default async function MySalaryPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconWallet />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const { start, end } = fyRange(fy, viewer.tenant.fyStartMonth);

  const [emp, revisions, ytd, claims, loans] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      select: {
        statutoryProfile: { select: { taxRegime: true, regimeLockedAt: true } },
        payGroup: { select: { frequency: true, name: true, allowRegimeChoice: true, regimeChangeCutoff: true } },
      },
    }),
    prisma.salaryRevision.findMany({
      where: { employeeId, status: { in: ["APPLIED", "APPROVED"] } },
      orderBy: { effectiveFrom: "desc" },
      include: { structure: { include: STRUCTURE_INCLUDE } },
    }),
    prisma.payrollRunEmployee.findMany({
      where: {
        employeeId,
        run: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null, periodEnd: { gte: start, lte: end }, payslips: { some: { employeeId, status: "RELEASED" } } },
      },
      select: { grossEarnings: true, totalDeductions: true, netPay: true, pfEmployee: true, vpf: true, esiEmployee: true, professionalTax: true, tds: true },
    }),
    prisma.componentClaim.findMany({
      where: { employeeId, fyStartYear: fy },
      include: { component: { select: { name: true, annualExemptLimit: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.loan.findMany({
      where: { employeeId, status: { in: ["ACTIVE", "DISBURSED"] } },
      include: { category: { select: { name: true } } },
    }),
  ]);

  const today = new Date();
  const current = revisions.find((r) => r.effectiveFrom <= today) ?? null;
  const regime = emp?.statutoryProfile?.taxRegime ?? "NEW";
  const canSwitch = regimeSwitchState(emp?.payGroup ?? null, emp?.statutoryProfile?.regimeLockedAt ?? null, { isCurrentFy: true, now: today }).allowed;
  const sum = (f: (r: (typeof ytd)[number]) => unknown) => ytd.reduce((a, r) => a + n(f(r)), 0);

  return (
    <>
      <div className={s.compRow}>
        <section className={`${s.boxed} ${s.pad}`} aria-label="Current compensation">
          <Field label="Current Compensation">
            {current ? <span style={{ fontSize: 17 }}>{inr(current.annualCtc)} / Annum</span> : <span className={s.muted}>Not set</span>}
          </Field>
        </section>
        <section className={`${s.boxed} ${s.pad} ${s.payroll}`} aria-label="Payroll">
          <h2 className={s.payrollTitle}>Payroll</h2>
          <Field label="Pay Cycle">{emp?.payGroup ? FREQ[emp.payGroup.frequency] ?? emp.payGroup.frequency : <span className={s.muted}>Not assigned</span>}</Field>
          {emp?.payGroup ? <Field label="Pay Group">{emp.payGroup.name}</Field> : null}
        </section>
      </div>

      <div className={s.mt}>
        <Panel title={<span style={{ fontSize: 21, fontWeight: 400 }}>Salary Timeline</span>}>
          <RegimeBanner regime={regime} canSwitch={canSwitch} tone="warning" />
          {revisions.length === 0 ? (
            <EmptyState title="No salary on record">Your compensation has not been set up yet. It will appear here once your payroll team adds it.</EmptyState>
          ) : (
            <ol className={s.timeline}>
              {revisions.map((r, i) => {
                const resolved = resolveFor(r.annualCtc, r.structure);
                const isCurrent = r.id === current?.id;
                const upcoming = r.effectiveFrom > today;
                const prev = r.previousCtc ?? revisions[i + 1]?.annualCtc ?? null;
                const change = prev && n(prev) > 0 ? ((n(r.annualCtc) - n(prev)) / n(prev)) * 100 : null;
                const groups = resolved
                  ? (["EARNING", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "DEDUCTION"] as const)
                      .map((t) => ({ t, rows: resolved.components.filter((c) => c.type === t && !(t === "DEDUCTION" && c.monthly.isZero())) }))
                      .filter((g) => g.rows.length > 0)
                  : [];
                return (
                  <li key={r.id} className={s.tlItem}>
                    <div className={s.tlRail}><span className={s.tlDot}><IconTrend width={20} height={20} /></span></div>
                    <div style={{ minWidth: 0 }}>
                      <div className={s.tlHead}>
                        <span className={s.tlTitle}>{i === revisions.length - 1 && !r.previousCtc ? "Joining Salary" : "Salary Revision"}</span>
                        <span className={s.muted}>Effective {formatDate(r.effectiveFrom)}</span>
                        {isCurrent ? <Chip kind="current">Current</Chip> : upcoming ? <Chip kind="on-duty">Upcoming</Chip> : null}
                        {change !== null && Math.abs(change) >= 0.05 ? (
                          <span className={s.muted} style={{ fontSize: 13 }}>{change > 0 ? "+" : ""}{change.toFixed(1)}% on {inr(prev)}</span>
                        ) : null}
                      </div>
                      <div className={s.tlBody}>
                        <details className={s.salaryBox}>
                          <summary>
                            <IconChevron className={s.chev} width={20} height={20} />
                            <Field label="Regular Salary">{inr(r.annualCtc)}</Field>
                            <span className={s.eq} aria-hidden="true">=</span>
                            <Field label="Total">{inr(r.annualCtc)}</Field>
                            <span className={s.viewLink}>
                              <span className={s.whenClosed}>View Salary Breakdown</span>
                              <span className={s.whenOpen}>Hide Salary Breakdown</span>
                            </span>
                          </summary>
                          <div className={s.breakdown}>
                            {resolved ? (
                              <>
                                <div className={s.muted} style={{ fontSize: 13.5, marginBottom: 12 }}>
                                  {r.structure?.name ? `${r.structure.name} · ` : ""}{r.reason ?? "Salary revision"}
                                </div>
                                <div className={s.tableWrap}>
                                  <table className={`${s.table} ${s.compact}`}>
                                    <thead><tr><th scope="col">Component</th><th scope="col" className={s.right}>Monthly</th><th scope="col" className={s.right}>Annual</th></tr></thead>
                                    <tbody>
                                      {groups.map((g) => [
                                        <tr key={`${g.t}-h`} className={s.groupRow}><td colSpan={3}>{TYPE_LABEL[g.t]}{g.t === "DEDUCTION" ? " (from your pay)" : ""}</td></tr>,
                                        ...g.rows.map((c) => (
                                          <tr key={`${g.t}-${c.code}`}>
                                            <td>{c.name}{c.isOutsideCtc ? <span className={s.muted}> · outside CTC</span> : null}</td>
                                            <td className={`${s.right} ${s.num}`}>{formatINR(c.monthly.toNumber(), false)}</td>
                                            <td className={`${s.right} ${s.num}`}>{formatINR(c.annual.toNumber(), false)}</td>
                                          </tr>
                                        )),
                                      ])}
                                      <tr className={s.totalRow}>
                                        <td>Cost to company</td>
                                        <td className={`${s.right} ${s.num}`}>{formatINR(resolved.monthlyCtcValue.toNumber(), false)}</td>
                                        <td className={`${s.right} ${s.num}`}>{formatINR(resolved.annualCtc.toNumber(), false)}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                              </>
                            ) : (
                              <span className={s.muted}>No salary structure is attached to this revision, so its split into components is not available.</span>
                            )}
                          </div>
                        </details>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>

      <div className={s.cols}>
        <Panel title={`Year to date — ${fyLabel(fy)}`} subtitle={ytd.length ? `From ${ytd.length} released payslip(s)` : undefined} className={s.ruled}>
          {ytd.length === 0 ? (
            <EmptyState title="Nothing paid yet this year">Figures appear here once your first payslip of the year is released.</EmptyState>
          ) : (
            <div className={s.fields}>
              <Field label="Gross earnings">{inr(sum((r) => r.grossEarnings))}</Field>
              <Field label="Net received">{inr(sum((r) => r.netPay))}</Field>
              <Field label="Provident Fund">{inr(sum((r) => r.pfEmployee) + sum((r) => r.vpf))}</Field>
              <Field label="ESI">{inr(sum((r) => r.esiEmployee))}</Field>
              <Field label="Professional Tax">{inr(sum((r) => r.professionalTax))}</Field>
              <Field label="Income Tax (TDS)">{inr(sum((r) => r.tds))}</Field>
              <Field label="Total deductions">{inr(sum((r) => r.totalDeductions))}</Field>
              <Field label="Payslips"><Link className={s.link} href="/finances/pay/payslips">View payslips</Link></Field>
            </div>
          )}
        </Panel>
        <ExplainCard title="Why did my pay change?" measure="Your net pay" explanation={await explainEmployeePay(employeeId, { releasedOnly: true })} />
      </div>

      {claims.length > 0 || loans.length > 0 ? (
        <div className={s.cols}>
          {claims.length > 0 ? (
            <Panel title={`Reimbursement claims — ${fyLabel(fy)}`} className={s.ruled}>
              <div className={s.tableWrap}>
                <table className={`${s.table} ${s.compact}`}>
                  <thead><tr><th scope="col">Component</th><th scope="col" className={s.right}>Claimed</th><th scope="col" className={s.right}>Annual limit</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.component.name}</td>
                        <td className={`${s.right} ${s.num}`}>{formatINR(n(c.claimedAmount), false)}</td>
                        <td className={`${s.right} ${s.num}`}>{c.component.annualExemptLimit ? formatINR(n(c.component.annualExemptLimit), false) : "—"}</td>
                        <td>{c.status.charAt(0) + c.status.slice(1).toLowerCase().replace(/_/g, " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
          {loans.length > 0 ? (
            <Panel title="Loans" action={<Link className={s.link} href="/me/loans">Manage loans</Link>} className={s.ruled}>
              <div className={s.tableWrap}>
                <table className={`${s.table} ${s.compact}`}>
                  <thead><tr><th scope="col">Loan</th><th scope="col" className={s.right}>EMI</th><th scope="col" className={s.right}>Outstanding</th></tr></thead>
                  <tbody>
                    {loans.map((l) => (
                      <tr key={l.id}>
                        <td>{l.category.name}{l.disbursedAt ? <span className={s.muted}> · since {formatPeriod(l.disbursedAt.getUTCFullYear(), l.disbursedAt.getUTCMonth() + 1)}</span> : null}</td>
                        <td className={`${s.right} ${s.num}`}>{formatINR(n(l.emiAmount), false)}</td>
                        <td className={`${s.right} ${s.num}`}>{formatINR(n(l.outstanding), false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
