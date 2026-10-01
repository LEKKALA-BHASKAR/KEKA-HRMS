import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate, fyLabel, fyRange, fyStartYear } from "@keka/shared";
import { explainEmployeePay, salaryTimeline } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { Panel, Field, Chip, EmptyState } from "@/components/keka";
import { ExplainCard } from "@/components/explain";
import { IconWallet } from "@/components/icons";
import { IconChevron, IconTrend } from "../_components/icons";
import { RegimeBanner } from "../_components/regime-banner";
import { BreakupButton } from "../_components/breakup";
import { inr, regimeSwitchState } from "../_lib/rules";
import s from "../finances.module.css";

export const metadata = { title: "My Salary" };

const n = (v: unknown) => Number(v ?? 0);
const FREQ: Record<string, string> = { MONTHLY: "Monthly", SEMI_MONTHLY: "Semi-monthly", WEEKLY: "Weekly", BI_WEEKLY: "Fortnightly" };

export default async function MySalaryPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconWallet />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const { start, end } = fyRange(fy, viewer.tenant.fyStartMonth);

  const [emp, timeline, ytd] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      select: {
        statutoryProfile: { select: { taxRegime: true, regimeLockedAt: true } },
        payGroup: { select: { frequency: true, name: true, allowRegimeChoice: true, regimeChangeCutoff: true } },
      },
    }),
    salaryTimeline(employeeId),
    prisma.payrollRunEmployee.findMany({
      where: {
        employeeId,
        run: { tenantId: viewer.tenantId, status: "FINALIZED", rolledBackAt: null, periodEnd: { gte: start, lte: end }, payslips: { some: { employeeId, status: "RELEASED" } } },
      },
      select: { grossEarnings: true, totalDeductions: true, netPay: true, pfEmployee: true, vpf: true, esiEmployee: true, professionalTax: true, tds: true },
    }),
  ]);

  const today = new Date();
  const current = timeline.find((t) => t.isCurrent) ?? null;
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
          {timeline.length === 0 ? (
            <EmptyState title="No salary on record">Your compensation has not been set up yet. It will appear here once your payroll team adds it.</EmptyState>
          ) : (
            <ol className={s.timeline}>
              {timeline.map((t, i) => {
                const terms: Array<[string, number]> = [["Regular Salary", t.regular]];
                if (t.other > 0) terms.push(["Other", t.other]);
                if (t.bonuses.length) terms.push(["Bonus", t.bonus]);
                return (
                  <li key={t.revisionId} className={s.tlItem}>
                    <div className={s.tlRail}><span className={s.tlDot}><IconTrend width={20} height={20} /></span></div>
                    <div style={{ minWidth: 0 }}>
                      <div className={s.tlHead}>
                        <span className={s.tlTitle}>{t.isJoining ? "Joining Salary" : "Salary Revision"}</span>
                        <span className={s.muted}>Effective {formatDate(t.effectiveFrom)}</span>
                        {t.isCurrent ? <Chip kind="current">Current</Chip> : t.isUpcoming ? <Chip kind="on-duty">Upcoming</Chip> : null}
                      </div>
                      <div className={s.tlBody}>
                        <details className={s.salaryBox}>
                          <summary aria-label={`${t.isJoining ? "Joining salary" : "Salary revision"} effective ${formatDate(t.effectiveFrom)}`}>
                            <IconChevron className={s.chev} width={20} height={20} />
                            {terms.map(([label, value], k) => (
                              <span key={label} className={s.term}>
                                {k > 0 ? <span className={s.op} aria-hidden="true">+</span> : null}
                                <Field label={label}>{inr(value)}</Field>
                              </span>
                            ))}
                            <span className={s.op} aria-hidden="true">=</span>
                            <Field label="Total">{inr(t.total)}</Field>
                          </summary>
                          <div className={s.revBody}>
                            <div className={s.revBar}>
                              <span className={s.revBarLabel}>Regular Salary</span>
                              <span>{inr(t.regular)} / Annum</span>
                              <BreakupButton annualCtc={t.annualCtc} breakup={t.breakup} versions={t.versions} />
                            </div>
                            <div className={s.revRow}>
                              <Field label="Salary Per Month">{inr(Math.round(t.regular / 12))}</Field>
                              <Field label="Effective From">{formatDate(t.effectiveFrom)}</Field>
                              {t.structureName ? <Field label="Salary Structure">{t.structureName}</Field> : null}
                            </div>
                            {t.other > 0 ? (
                              <>
                                <div className={s.revBar}><span className={s.revBarLabel}>Other</span><span>{inr(t.other)} / Annum</span></div>
                                <div className={s.revRow}>
                                  {t.otherItems.map((o) => (
                                    <Field key={o.code} label={`${o.name} / ${o.varies ? "Year" : "Month"}`}>{inr(o.varies ? o.annual : o.monthly)}</Field>
                                  ))}
                                </div>
                              </>
                            ) : null}
                            {t.bonuses.length ? (
                              <>
                                <div className={s.revBar}><span className={s.revBarLabel}>Bonus</span><span>{inr(t.bonus)}</span></div>
                                {t.bonuses.map((b) => (
                                  <div key={b.id} className={s.bonusRow}>
                                    <span className={s.bonusName}>{b.name}</span>
                                    <Field label="Type">{b.type}</Field>
                                    <Field label="Status">{b.status}</Field>
                                    <Field label="Amount">{inr(b.amount)}</Field>
                                    <Field label="Due">{formatDate(b.due)}</Field>
                                    {b.note ? <div className={s.bonusNote}>Note: {b.note}</div> : null}
                                  </div>
                                ))}
                              </>
                            ) : null}
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
    </>
  );
}
