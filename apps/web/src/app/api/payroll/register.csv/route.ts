import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod } from "@keka/shared";
import { getViewer } from "@/lib/context";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

/** Pay register as CSV. Every cell is escaped; totals row included. */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });
  if (!viewer.permissions.has(P.PAY_REGISTER_VIEW)) {
    return new Response("Forbidden", { status: 403 });
  }

  const runId = new URL(request.url).searchParams.get("run");
  if (!runId) return new Response("Missing run parameter", { status: 400 });

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
    include: {
      payGroup: { select: { name: true } },
      lines: {
        orderBy: { employee: { employeeNumber: "asc" } },
        include: {
          employee: {
            select: {
              employeeNumber: true, displayName: true,
              department: { select: { name: true } },
              location: { select: { stateCode: true } },
            },
          },
          lines: { orderBy: { sequence: "asc" } },
        },
      },
    },
  });
  if (!run) return new Response("Not found", { status: 404 });

  const earningCodes = new Map<string, string>();
  const deductionCodes = new Map<string, string>();
  for (const line of run.lines) {
    for (const c of line.lines) {
      if (c.type === "EARNING" || c.type === "REIMBURSEMENT") earningCodes.set(c.code, c.name);
      if (c.type === "DEDUCTION") deductionCodes.set(c.code, c.name);
    }
  }
  const earnings = [...earningCodes.entries()];
  const deductions = [...deductionCodes.entries()];

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    "Employee Number", "Employee Name", "Department", "State", "Month",
    "Total Days", "Payable Days", "LOP Days",
    ...earnings.map(([, name]) => name),
    "Gross Earnings",
    ...deductions.map(([, name]) => name),
    "Total Deductions", "Net Pay",
    "PF Wage", "PF Employee", "PF Employer", "EPS", "VPF",
    "ESI Gross", "ESI Employee", "ESI Employer",
    "Professional Tax", "LWF Employee", "LWF Employer", "TDS",
    "Employer Cost", "Pay Action",
  ];

  const amountFor = (line: typeof run.lines[number], code: string) =>
    n(line.lines.find((c) => c.code === code)?.amount);

  const rows = run.lines.map((l) => [
    l.employee.employeeNumber,
    l.employee.displayName,
    l.employee.department?.name ?? "",
    l.employee.location?.stateCode ?? "",
    formatPeriod(run.year, run.month),
    l.totalDays,
    n(l.payableDays).toFixed(2),
    n(l.lopDays).toFixed(2),
    ...earnings.map(([code]) => amountFor(l, code).toFixed(2)),
    n(l.grossEarnings).toFixed(2),
    ...deductions.map(([code]) => amountFor(l, code).toFixed(2)),
    n(l.totalDeductions).toFixed(2),
    n(l.netPay).toFixed(2),
    n(l.pfWage).toFixed(2), n(l.pfEmployee).toFixed(2), n(l.pfEmployer).toFixed(2),
    n(l.epsEmployer).toFixed(2), n(l.vpf).toFixed(2),
    n(l.esiGross).toFixed(2), n(l.esiEmployee).toFixed(2), n(l.esiEmployer).toFixed(2),
    n(l.professionalTax).toFixed(2), n(l.lwfEmployee).toFixed(2), n(l.lwfEmployer).toFixed(2),
    n(l.tds).toFixed(2),
    n(l.employerCost).toFixed(2),
    l.payAction,
  ]);

  const colTotal = (code: string) => run.lines.reduce((s, l) => s + amountFor(l, code), 0);
  const totalsRow = [
    "TOTAL", `${run.lines.length} employees`, "", "", formatPeriod(run.year, run.month),
    "", run.lines.reduce((s, l) => s + n(l.payableDays), 0).toFixed(2),
    run.lines.reduce((s, l) => s + n(l.lopDays), 0).toFixed(2),
    ...earnings.map(([code]) => colTotal(code).toFixed(2)),
    n(run.totalGross).toFixed(2),
    ...deductions.map(([code]) => colTotal(code).toFixed(2)),
    n(run.totalDeductions).toFixed(2),
    n(run.totalNetPay).toFixed(2),
    ...Array(13).fill(""),
    n(run.totalEmployerCost).toFixed(2), "",
  ];

  const csv = [header, ...rows, totalsRow]
    .map((r) => r.map(esc).join(","))
    .join("\n");

  const filename = `pay-register-${run.year}-${String(run.month).padStart(2, "0")}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
