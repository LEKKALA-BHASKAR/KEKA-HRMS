import { NextResponse, type NextRequest } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";
import { EXPENSE_REPORTS, expenseFilter, expenseReport, type ExpenseReportKind } from "../data";

/** Expense reports as CSV (reimbursements, receipts, project spend, GL export, audit trail). */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.EXPENSE_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const k = sp.kind ?? "reimbursements";
  if (!(k in EXPENSE_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const kind = k as ExpenseReportKind;
  const r = await expenseReport(viewer.tenantId, kind, expenseFilter(sp));
  return moneyCsv(viewer, { module: "FINANCE", filename: `expenses-${kind}.csv`, head: r.head, rows: r.rows, entityType: "ExpenseReport", summary: `Exported ${EXPENSE_REPORTS[kind].toLowerCase()} (${r.rows.length} rows)` });
}
