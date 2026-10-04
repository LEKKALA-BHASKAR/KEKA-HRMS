import { NextResponse } from "next/server";
import { PERMISSIONS } from "@keka/rbac";
import { compaRatioRows } from "@keka/services";
import { getViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { moneyCsv } from "@/lib/money";

/** Compa-ratio and range penetration for everyone in scope, as CSV. */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.SALARY_REVISE)) return new NextResponse("Forbidden.", { status: 403 });
  const rows = await compaRatioRows(viewer.tenantId, scopedEmployeeWhere(viewer, PERMISSIONS.SALARY_REVISE));
  return moneyCsv(viewer, {
    module: "PAYROLL", filename: `compa-ratio-${new Date().toISOString().slice(0, 10)}.csv`, entityType: "CompaRatioReport", summary: `Compa-ratio report exported (${rows.length} employees)`,
    head: ["Employee", "Number", "Department", "Location", "Grade", "Annual CTC", "Range min", "Range mid", "Range max", "Compa-ratio", "Penetration", "Position"],
    rows: rows.map((r) => [r.name, r.number, r.department, r.location, r.grade, r.ctc, r.min, r.mid, r.max, r.compa, r.penetration, r.position]),
  });
}
