import "server-only";
import { prisma } from "@keka/db";
import { reimbursementRows, receiptRows, projectSpendRows, financeExportRows, taxClassificationSummary, type ExpenseReportFilter } from "@keka/services";
import { qDate, qStr } from "@/lib/money";

/** The expense reports behind /expenses/reports and its CSV export. */
export const EXPENSE_REPORTS = {
  reimbursements: "Reimbursements",
  receipts: "Receipts",
  projects: "Spend by project",
  finance: "Finance export (GL)",
  audit: "Expense audit trail",
} as const;
export type ExpenseReportKind = keyof typeof EXPENSE_REPORTS;

export function expenseFilter(sp: Record<string, string | string[] | undefined>): ExpenseReportFilter {
  return { from: qDate(sp.from), to: qDate(sp.to), stage: qStr(sp.stage), projectId: qStr(sp.projectId), q: qStr(sp.q) };
}

export async function expenseReport(tenantId: string, kind: ExpenseReportKind, f: ExpenseReportFilter): Promise<{ head: string[]; rows: unknown[][] }> {
  if (kind === "receipts") return receiptRows(tenantId, f);
  if (kind === "projects") return projectSpendRows(tenantId, f);
  if (kind === "finance") return financeExportRows(tenantId, f);
  if (kind === "audit") {
    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId, module: "FINANCE",
        entityType: { in: ["ExpenseClaim", "ExpenseClaimLine", "ExpensePolicy", "ExpenseCategory", "ExpenseRate", "ExpensePreApproval", "ExpenseAuditSample", "ExpenseAuditSampleItem", "CashAdvance"] },
        ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: new Date(f.to.getTime() + 86_399_999) } : {}) } } : {}),
        ...(f.q ? { summary: { contains: f.q, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" }, take: 5000,
    });
    return { head: ["When", "Who", "Action", "Record", "Summary"], rows: logs.map((l) => [l.createdAt, l.actorLabel, l.action, l.entityType, l.summary]) };
  }
  return reimbursementRows(tenantId, f);
}

export { taxClassificationSummary };
