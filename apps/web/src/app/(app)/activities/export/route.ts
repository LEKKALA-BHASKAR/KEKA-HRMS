import { NextResponse, type NextRequest } from "next/server";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS as P, employeeScopeFilter } from "@keka/rbac";
import { searchHrActivities } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { opsCsv, d10 } from "@/lib/ops-export";

/** CSV of the HR activity timeline with the page's filters, limited to the viewer's scope. */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(v, P.HR_ACTIVITY_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const scope = employeeScopeFilter(v, P.HR_ACTIVITY_VIEW);
  const ids = scope ? (await prisma.employee.findMany({ where: { ...(scope as Prisma.EmployeeWhereInput), tenantId: v.tenantId }, select: { id: true } })).map((e) => e.id) : null;
  const day = (x: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(`${x}T00:00:00Z`) : null);
  const rows = await searchHrActivities(v.tenantId, { q: sp.get("q"), type: sp.get("type"), status: sp.get("status"), from: day(sp.get("from")), to: day(sp.get("to")), employeeIds: ids, take: 5000 });
  return opsCsv(v, "EMPLOYEE", "HrActivity", "hr-activities", ["Date", "Employee no.", "Employee", "Department", "Type", "Title", "Severity", "From", "To", "Destination", "Approval", "Edited", "Detail"],
    rows.map((a) => [d10(a.occurredOn), a.employee.employeeNumber, a.employee.displayName ?? "", a.employee.department?.name ?? "", a.type, a.title, a.severity ?? "", a.fromValue ?? "", a.toValue ?? "", a.destination ?? "", a.approvalStatus ?? "RECORDED", d10(a.editedAt), a.description ?? ""]));
}
