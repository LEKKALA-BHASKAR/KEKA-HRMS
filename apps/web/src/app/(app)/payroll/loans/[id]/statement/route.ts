import { NextResponse } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { loanStatement } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { moneyCsv } from "@/lib/money";

/** A loan statement as CSV, for the borrower or the loan desk. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const loan = await prisma.loan.findFirst({ where: { id, employee: { tenantId: viewer.tenantId } }, include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!loan) return new NextResponse("Not found.", { status: 404 });
  const own = loan.employeeId === viewer.employee?.id;
  if (!own && !(can(viewer, PERMISSIONS.LOAN_MANAGE) && canAccessEmployee(viewer, loan.employee, PERMISSIONS.LOAN_MANAGE))) return new NextResponse("Forbidden.", { status: 403 });
  const st = await loanStatement(viewer.tenantId, id);
  if (!st) return new NextResponse("Not found.", { status: 404 });
  return moneyCsv(viewer, { module: "PAYROLL", filename: `loan-statement-${st.loan.employee.employeeNumber}-${st.loan.category.code ?? "loan"}.csv`, head: st.head, rows: st.rows, entityType: "Loan", summary: `Loan statement exported for ${st.loan.employee.displayName} (${st.loan.category.name})` });
}
