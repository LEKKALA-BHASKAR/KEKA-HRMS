import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { MONTH_SHORT } from "@keka/shared";
import { getViewer } from "@/lib/context";
import { financialYears, loadTaxPicture, pickFy } from "../../../_lib/data";

const csv = (cells: Array<string | number>) => cells.map((c) => {
  const v = typeof c === "number" ? String(Math.round(c * 100) / 100) : c;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}).join(",");

/**
 * The Income Tax Computation sheet as CSV: earnings by component and month,
 * the computation, and TDS by month — the signed-in employee's own figures.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!viewer.employee) return new NextResponse("Not found.", { status: 404 });
  const years = await financialYears(viewer);
  const fy = pickFy(req.nextUrl.searchParams.get("fy") ?? undefined, years);
  const p = await loadTaxPicture(viewer, fy);
  const r = p.result;
  if (!r) return new NextResponse("No tax computation for that year.", { status: 404 });

  const months = p.months.map((m) => `${MONTH_SHORT[m.month - 1]} ${m.year}${m.kind === "projected" ? " (projected)" : ""}`);
  const lines: string[] = [];
  lines.push(csv([`Income Tax Computation — FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`, p.regime === "NEW" ? "New Tax Regime (s.115BAC)" : "Old Tax Regime"]));
  lines.push("");
  lines.push(csv(["A. Gross Earnings from Employment", "Total", ...months]));
  for (const g of p.grid) lines.push(csv([g.name, g.total, ...g.cells]));
  if (p.previousIncome > 0) lines.push(csv(["Income from previous employer", p.previousIncome]));
  lines.push(csv(["Gross Earnings", p.actualGross + p.projectedGross + p.previousIncome, ...p.months.map((m) => m.gross)]));
  lines.push("");
  const rows: Array<[string, number]> = [
    ["B. Exemptions under section 10", r.exemptions.toNumber()],
    ["   House rent allowance — s.10(13A)", p.regime === "OLD" ? p.hraExemption : 0],
    ["   Tax-free reimbursements", p.reimbursements],
    ["C. Standard deduction — s.16(ia)", r.standardDeduction.toNumber()],
    ["   Professional tax — s.16(iii)", r.professionalTaxDeduction.toNumber()],
    ["D. Income from house property", p.deductions.houseProperty],
    ["   Income from other sources", p.deductions.otherIncome],
    ["   Gross total income", r.grossTotalIncome.toNumber()],
    ["E. Deductions under Chapter VI-A", r.chapterViaDeductions.toNumber()],
    ...p.deductions.bySection.filter((d) => d.allowed > 0 && !d.section.startsWith("24B") && !d.section.startsWith("OTHER_")).map((d): [string, number] => [`   ${d.section} — ${d.label}`, d.allowed]),
    ["F. Net taxable income", r.taxableIncome.toNumber()],
    ["   Tax on taxable income", r.taxBeforeRebate.toNumber()],
    ["   Rebate under s.87A", r.rebate87A.toNumber()],
    ["   Surcharge", r.surcharge.toNumber()],
    ["   Health and education cess", r.cess.toNumber()],
    ["   Net income tax payable", p.totalTax],
    ["   Tax paid till now", p.taxPaid],
    ["   Remaining tax to be paid", p.remaining],
  ];
  lines.push(csv(["Computation", "Amount (INR)"]));
  for (const [k, v] of rows) lines.push(csv([k, v]));
  lines.push("");
  lines.push(csv(["G. Monthly TDS", ...(p.previousTds > 0 ? ["Previous employer"] : []), ...months]));
  lines.push(csv(["TDS", ...(p.previousTds > 0 ? [p.previousTds] : []), ...p.months.map((m) => m.tds)]));

  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "IncomeTaxComputation", entityId: viewer.employee.id, summary: `Downloaded the income tax computation for FY ${fy}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="IncomeTax-Computation-FY${fy}-${String((fy + 1) % 100).padStart(2, "0")}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
