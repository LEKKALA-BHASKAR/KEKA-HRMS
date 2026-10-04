import { prisma } from "@keka/db";
import { moneyLoanReport } from "@keka/services";

export const LOAN_REPORTS = {
  outstanding: "Loans outstanding",
  advances: "Cash advances",
  settlements: "Settlements and prepayments",
  adjustments: "Loan adjustments",
} as const;
export type LoanReportKind = keyof typeof LOAN_REPORTS;

/** Rows for one loan-book report; every query is scoped to the tenant. */
export async function loanBookReport(tenantId: string, kind: LoanReportKind) {
  if (kind !== "outstanding") return moneyLoanReport(tenantId, kind);
  const loans = await prisma.loan.findMany({
    where: { employee: { tenantId }, status: { in: ["APPROVED", "DISBURSED", "ACTIVE"] } },
    include: { employee: { select: { displayName: true, employeeNumber: true } }, category: { select: { name: true } }, schedule: { where: { status: "SCHEDULED" }, orderBy: [{ year: "asc" }, { month: "asc" }], take: 1 } },
    orderBy: { requestedAt: "desc" },
  });
  return {
    title: LOAN_REPORTS.outstanding,
    head: ["Employee", "Number", "Loan", "Status", "Principal", "EMI", "Repaid", "Outstanding", "Next EMI", "Disbursed"],
    rows: loans.map((l) => [l.employee.displayName, l.employee.employeeNumber, l.category.name, l.status, Number(l.principal), Number(l.emiAmount), Number(l.totalRepaid), Number(l.outstanding), l.schedule[0] ? `${String(l.schedule[0].month).padStart(2, "0")}/${l.schedule[0].year}` : "", l.disbursedAt]),
  };
}
