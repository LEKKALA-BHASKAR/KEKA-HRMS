import { NextResponse } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";
import { LOAN_REPORTS, loanBookReport, type LoanReportKind } from "../data";

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.LOAN_MANAGE)) return new NextResponse("Forbidden.", { status: 403 });
  const kind = new URL(req.url).searchParams.get("report") as LoanReportKind | null;
  if (!kind || !(kind in LOAN_REPORTS)) return new NextResponse("Unknown report.", { status: 400 });
  const r = await loanBookReport(viewer.tenantId, kind);
  return moneyCsv(viewer, { module: "PAYROLL", filename: `${kind}-${new Date().toISOString().slice(0, 10)}.csv`, head: r.head, rows: r.rows, entityType: "LoanReport", summary: `${r.title} report exported (${r.rows.length} rows)` });
}
