import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { formatDate, formatINR, MONTH_NAMES, MONTH_SHORT } from "@keka/shared";
import { loanSummaryFor, loanPolicyView, loanDetailFor, openPayrollMonthFor, payrollMonths, interestLabel } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { Chip, Donut, EmptyState } from "@/components/keka";
import { IconWallet } from "@/components/icons";
import { IconAlert, IconCar, IconCash, IconHistory, IconHome2, IconWalletLine } from "../_components/icons";
import { ApplyLoanButton, LoanPolicyButton } from "../_components/loans";
import { WithdrawButton } from "../_components/claims";
import s from "../finances.module.css";

export const metadata = { title: "Loans" };

const n = (v: unknown) => Number(v ?? 0);
const whole = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v));
const inr = (v: number) => `INR ${whole(v)}`;
const monthYear = (d: Date) => `${MONTH_SHORT[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
const ICON: Record<string, (p: { width?: number; height?: number }) => ReactNode> = { wallet: IconWalletLine, alert: IconAlert, home: IconHome2, car: IconCar };
const catIcon = (icon: string | null) => ICON[icon ?? ""] ?? IconCash;
const REQUEST_STATUS: Record<string, { label: string; kind: string }> = {
  REQUESTED: { label: "Pending", kind: "on-duty" }, PENDING_APPROVAL: { label: "Pending", kind: "on-duty" },
  APPROVED: { label: "Approved", kind: "current" }, REJECTED: { label: "Rejected", kind: "closed" }, WITHDRAWN: { label: "Withdrawn", kind: "withdrawn" },
};
const INST_STATUS: Record<string, string> = { SCHEDULED: "Scheduled", DEDUCTED: "Deducted", SKIPPED: "Skipped", PREPAID: "Prepaid", WAIVED: "Waived" };

/**
 * Loans, as Keka's Loan Summary: four cards, then the loans paid out (a list
 * on the left, the selected loan's details or recovery on the right) or the
 * requests still in flight. The policy explanation and Apply New Loan open in
 * dialogs. Everything shown is the signed-in employee's own.
 */
export default async function LoansPage({ searchParams }: { searchParams: Promise<{ view?: string; loan?: string; tab?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconWallet />} title="No employee record">This login is not linked to an employee record, so there are no loans to show.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const sp = await searchParams;
  const view = sp.view === "requests" ? "requests" : "disbursed";

  const [summary, policy, loans, categories, open] = await Promise.all([
    loanSummaryFor(employeeId),
    loanPolicyView(viewer.tenantId, (x) => whole(x)),
    prisma.loan.findMany({ where: { employeeId }, include: { category: true }, orderBy: [{ disbursedAt: "desc" }, { requestedAt: "desc" }] }),
    prisma.loanCategory.findMany({ where: { tenantId: viewer.tenantId, isActive: true, policyRules: { some: { policy: { isActive: true } } } }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    openPayrollMonthFor(employeeId),
  ]);
  const disbursed = loans.filter((l) => ["DISBURSED", "ACTIVE", "CLOSED", "FORECLOSED"].includes(l.status));
  const requests = loans.filter((l) => ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "WITHDRAWN"].includes(l.status))
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  const selectedId = disbursed.find((l) => l.id === sp.loan)?.id ?? disbursed[0]?.id ?? null;
  const detail = view === "disbursed" && selectedId ? await loanDetailFor(employeeId, selectedId) : null;
  const tab = sp.tab === "recovery" ? "recovery" : "details";
  const history = detail
    ? await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: "Loan", entityId: detail.loan.id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, summary: true, createdAt: true } })
    : [];
  const pendingCount = requests.filter((r) => r.status === "REQUESTED" || r.status === "PENDING_APPROVAL").length;
  const href = (q: Record<string, string>) => `/finances/loans?${new URLSearchParams(q)}`;

  return (
    <>
      <div className={s.titleRow}>
        <div>
          <div className={s.titleLeft}>
            <h1 className={s.bigTitle}>Loan Summary</h1>
            <LoanPolicyButton policy={policy} />
          </div>
          <p className={s.pageSub}>Below is the summary for your loans</p>
        </div>
        {categories.length ? (
          <ApplyLoanButton
            categories={categories.map((c) => ({ id: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))}
            months={payrollMonths(open, 12)}
          />
        ) : null}
      </div>

      <div className={s.loanKpis}>
        <div className={`${s.boxed} ${s.loanKpi}`} style={{ ["--bar" as string]: "#36b8c9" }}><div className={s.loanKpiLabel}>Outstanding Principal Balance</div><div className={s.loanKpiValue}>{inr(summary.outstandingPrincipal)}</div></div>
        <div className={`${s.boxed} ${s.loanKpi}`} style={{ ["--bar" as string]: "#c84fb8" }}><div className={s.loanKpiLabel}>Total Ongoing EMI</div><div className={s.loanKpiValue}>{inr(summary.ongoingEmi)}<span className={s.loanKpiUnit}>/PER MONTH</span></div></div>
        <div className={`${s.boxed} ${s.loanKpi}`} style={{ ["--bar" as string]: "#4fc3d9" }}><div className={s.loanKpiLabel}>Ongoing Loans</div><div className={s.loanKpiValue}>{summary.ongoingCount}<span className={s.loanKpiUnit}>| TOTAL LOAN(S) ISSUED: {summary.issuedCount}</span></div></div>
        <div className={`${s.boxed} ${s.loanKpi}`} style={{ ["--bar" as string]: "#8faa2e" }}><div className={s.loanKpiLabel}>Total Loan Issued</div><div className={s.loanKpiValue}>{inr(summary.totalIssued)}</div></div>
      </div>

      <nav className={s.innerTabs} aria-label="Loans">
        <Link href="/finances/loans" scroll={false} className={`${s.innerTab}${view === "disbursed" ? ` ${s.innerTabActive}` : ""}`} aria-current={view === "disbursed" ? "page" : undefined}>Loan Disbursed</Link>
        <Link href={href({ view: "requests" })} scroll={false} className={`${s.innerTab}${view === "requests" ? ` ${s.innerTabActive}` : ""}`} aria-current={view === "requests" ? "page" : undefined}>
          Loan Request{pendingCount ? <span className={s.tabCount}>{pendingCount}</span> : null}
        </Link>
      </nav>

      {view === "disbursed" ? (
        <>
          <div className={s.sectionHead}><h2>Loan Disbursed</h2><p>Below are the details for loan disbursed</p></div>
          {disbursed.length === 0 ? (
            <div className={s.boxed}><EmptyState title="No loans disbursed">Loans you take appear here once they are paid out. Use Apply New Loan to request one.</EmptyState></div>
          ) : (
            <div className={s.loanLayout}>
              <nav className={s.monthList} aria-label="Loans">
                <div className={s.monthListHead}>Loans</div>
                {disbursed.map((l) => {
                  const active = l.id === selectedId;
                  const when = l.disbursedAt ?? l.approvedAt ?? l.requestedAt;
                  return (
                    <Link key={l.id} href={href({ loan: l.id })} scroll={false} className={`${s.loanItem}${active ? ` ${s.monthItemActive}` : ""}`} aria-current={active ? "page" : undefined}>
                      <span>
                        <span className={s.loanItemAmount}>{inr(n(l.principal))}</span>
                        <span className={s.loanItemMeta}>{l.category.name} - {monthYear(when)}</span>
                      </span>
                      {l.status === "CLOSED" || l.status === "FORECLOSED" ? <Chip kind="cleared">Cleared</Chip> : null}
                    </Link>
                  );
                })}
              </nav>

              {detail ? (() => {
                const l = detail.loan;
                const Icon = catIcon(l.category.icon);
                const when = l.disbursedAt ?? l.approvedAt ?? l.requestedAt;
                const t = detail.totals;
                const interest = interestLabel(l.interestType, n(l.interestRate));
                const first = l.schedule[0];
                return (
                  <div style={{ minWidth: 0 }}>
                    <div className={`${s.boxed} ${s.loanHead}`}>
                      <span className={s.loanHeadIcon}><Icon width={20} height={20} /></span>
                      <div className={s.loanHeadText}>
                        <div>{inr(n(l.principal))} - {l.category.name}{l.category.code ? ` (${l.category.code})` : ""}</div>
                        <div className={s.muted} style={{ fontSize: 13.5 }}>Issued on {MONTH_SHORT[when.getUTCMonth()]} {when.getUTCFullYear()} - {l.disbursedOutside ? "Outside Payroll" : "Through Payroll"}</div>
                      </div>
                      <nav className={s.loanTabs} aria-label="Loan">
                        <Link href={href({ loan: l.id })} scroll={false} className={`${s.loanTab}${tab === "details" ? ` ${s.loanTabActive}` : ""}`} aria-current={tab === "details" ? "page" : undefined}>Loan Details</Link>
                        <Link href={href({ loan: l.id, tab: "recovery" })} scroll={false} className={`${s.loanTab}${tab === "recovery" ? ` ${s.loanTabActive}` : ""}`} aria-current={tab === "recovery" ? "page" : undefined}>Loan Recovery Details</Link>
                        <Link href={`/finances/loans/${l.id}`} className={s.loanTab}>Statement & changes</Link>
                      </nav>
                    </div>

                    {tab === "details" ? (
                      <section className={`${s.boxed} ${s.loanPane}`} aria-label="Loan details">
                        <div className={s.titleLeft}>
                          <h3 className={s.loanPaneTitle}>Loan Details</h3>
                          <details className={s.history}>
                            <summary aria-label="Loan history" title="Loan history"><IconHistory width={20} height={20} /></summary>
                            <div className={s.historyPanel} role="region" aria-label="Loan history">
                              {history.length === 0 ? <div className={s.historyItem}><span className={s.muted}>No changes recorded.</span></div> : history.map((h) => (
                                <div key={h.id} className={s.historyItem}><div>{h.summary}</div><div className={s.muted} style={{ fontSize: 12 }}>{formatDate(h.createdAt)}</div></div>
                              ))}
                            </div>
                          </details>
                        </div>
                        <div className={s.donuts}>
                          <div className={s.donutCard}>
                            <Donut size={150} stroke={16} parts={[{ value: t.paid, colour: "#8faa2e", label: "Total Amount Paid" }, { value: t.left, colour: "#d9dde5", label: "Total Amount Left" }]}>
                              <div className={s.donutLabel}>Total Amount:<br />{inr(t.total)}</div>
                            </Donut>
                            <ul className={s.donutLegend}>
                              <li><span style={{ background: "#8faa2e" }} />Total Amount Paid<strong>{inr(t.paid)}</strong></li>
                              <li><span style={{ background: "#d9dde5" }} />Total Amount Left<strong>{inr(t.left)}</strong></li>
                            </ul>
                          </div>
                          <div className={s.donutCard}>
                            <Donut size={150} stroke={16} parts={[{ value: t.principal, colour: "#4fc3d9", label: "Total Principal Amount" }, { value: t.interest, colour: "#ef6f6f", label: "Total Interest Amount" }]}>
                              <div className={s.donutLabel}>Total Amount:<br />{inr(t.total)}</div>
                            </Donut>
                            <ul className={s.donutLegend}>
                              <li><span style={{ background: "#4fc3d9" }} />Total Principal Amount<strong>{inr(t.principal)}</strong></li>
                              <li><span style={{ background: "#ef6f6f" }} />Total Interest Amount<strong>{inr(t.interest)}</strong></li>
                            </ul>
                          </div>
                        </div>
                        <div className={s.detailsTable}>
                          <div className={s.detailsHead}>Details</div>
                          {([
                            ["Loan Amount", inr(n(l.principal))],
                            ["Rate of Interest", `${interest.rate} ${interest.kind}`],
                            ["Installments", `${l.installments} Months`],
                            ["EMI", `${inr(n(l.emiAmount))} / month`],
                            ["EMI Starts From", first ? `${MONTH_NAMES[first.month - 1]} ${first.year}` : l.startYear && l.startMonth ? `${MONTH_NAMES[l.startMonth - 1]} ${l.startYear}` : "—"],
                            ["Disbursed On", l.disbursedAt ? formatDate(l.disbursedAt) : "—"],
                            ["Outstanding Principal", inr(n(l.outstanding))],
                            ["Approved By", detail.approvedBy ? `${detail.approvedBy}${l.approvedAt ? ` on ${formatDate(l.approvedAt)}` : ""}` : "—"],
                            ["Note", l.purpose ?? "—"],
                            ["Status", l.status === "CLOSED" || l.status === "FORECLOSED" ? "Cleared" : "Ongoing"],
                          ] as Array<[string, string]>).map(([k, v]) => (
                            <div key={k} className={s.detailsRow}><span className={s.muted}>{k}</span><span>{v}</span></div>
                          ))}
                        </div>
                      </section>
                    ) : (
                      <section className={`${s.boxed} ${s.loanPane}`} aria-label="Loan recovery details">
                        <h3 className={s.loanPaneTitle}>Loan Recovery Details</h3>
                        <div className={s.tableScroll} style={{ marginTop: 16 }}>
                          <table className={`${s.table} ${s.flatTable}`}>
                            <thead><tr><th scope="col">#</th><th scope="col">Month</th><th scope="col">Principal</th><th scope="col">Interest</th><th scope="col">EMI</th><th scope="col">Balance</th><th scope="col">Status</th></tr></thead>
                            <tbody>
                              {l.schedule.length === 0 ? <tr><td colSpan={7} className={s.noRecords}>No records found</td></tr> : l.schedule.map((i) => (
                                <tr key={i.id}>
                                  <td>{i.sequence}</td>
                                  <td>{MONTH_SHORT[i.month - 1]} {i.year}</td>
                                  <td className={s.num}>{formatINR(n(i.principalPart), false)}</td>
                                  <td className={s.num}>{formatINR(n(i.interestPart), false)}</td>
                                  <td className={s.num}>{formatINR(n(i.totalAmount), false)}</td>
                                  <td className={s.num}>{formatINR(n(i.balanceAfter), false)}</td>
                                  <td><Chip kind={i.status === "DEDUCTED" || i.status === "PREPAID" ? "verified" : i.status === "SKIPPED" ? "on-duty" : i.status === "WAIVED" ? "current" : "withdrawn"}>{INST_STATUS[i.status] ?? i.status}</Chip></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                  </div>
                );
              })() : null}
            </div>
          )}
        </>
      ) : (
        <>
          <div className={s.sectionHead}><h2>Loan Request</h2><p>Below are the loans you have asked for and where each one stands</p></div>
          <section className={s.boxed} aria-label="Loan requests">
            <div className={s.tableScroll}>
              <table className={`${s.table} ${s.flatTable}`}>
                <thead>
                  <tr><th scope="col">Loan Category</th><th scope="col">Amount</th><th scope="col">Requested On</th><th scope="col">Expected Month</th><th scope="col">EMI Starts</th><th scope="col">Term</th><th scope="col">EMI</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
                </thead>
                <tbody>
                  {requests.length === 0 ? <tr><td colSpan={9} className={s.noRecords}>No records found</td></tr> : requests.map((l) => {
                    const st = REQUEST_STATUS[l.status] ?? { label: l.status, kind: "withdrawn" };
                    return (
                      <tr key={l.id}>
                        <td>{l.category.name}{l.category.code ? ` (${l.category.code})` : ""}{l.purpose ? <div className={s.muted} style={{ fontSize: 12.5 }}>{l.purpose}</div> : null}</td>
                        <td className={s.num}>{inr(n(l.principal))}</td>
                        <td>{formatDate(l.requestedAt)}</td>
                        <td>{l.expectedYear && l.expectedMonth ? `${MONTH_SHORT[l.expectedMonth - 1]} ${l.expectedYear}` : <span className={s.muted}>—</span>}</td>
                        <td>{l.startYear && l.startMonth ? `${MONTH_SHORT[l.startMonth - 1]} ${l.startYear}` : <span className={s.muted}>—</span>}</td>
                        <td>{l.installments} Months</td>
                        <td className={s.num}>{inr(n(l.emiAmount))}</td>
                        <td><Chip kind={st.kind}>{st.label}</Chip>{l.decisionNote && l.status !== "WITHDRAWN" ? <div className={s.muted} style={{ fontSize: 12.5, marginTop: 4 }}>{l.decisionNote}</div> : null}</td>
                        <td>{l.status === "REQUESTED" || l.status === "PENDING_APPROVAL" ? <><Link href={`/finances/loans/${l.id}`} className={s.linkBtn}>Edit</Link> <WithdrawButton kind="loan" id={l.id} label={`the ${l.category.name} request`} /></> : <span className={s.muted}>—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
