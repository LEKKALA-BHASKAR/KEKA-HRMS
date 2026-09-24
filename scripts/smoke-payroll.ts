/**
 * End-to-end payroll smoke test.
 * Creates a run for a period, calculates it, and prints a reconciliation so the
 * numbers can be checked by hand against the statutory rules.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { formatINR, formatPeriod } from "@keka/shared";

const prisma = new PrismaClient();

async function main() {
  const year = Number(process.argv[2] ?? 2026);
  const month = Number(process.argv[3] ?? 6);

  // Imported lazily so the env is loaded before Prisma is constructed inside.
  const { createRun, calculateRun } = await import("@keka/services");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const payGroup = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });

  console.log(`\nPayroll run — ${formatPeriod(year, month)} — ${payGroup.name}`);
  console.log("=".repeat(96));

  const runId = await createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year, month });
  const summary = await calculateRun(runId);

  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId },
    orderBy: { employee: { employeeNumber: "asc" } },
    include: {
      employee: {
        select: {
          employeeNumber: true, displayName: true, gender: true,
          location: { select: { stateCode: true } },
          statutoryProfile: { select: { taxRegime: true } },
        },
      },
    },
  });

  const pad = (s: string | number, w: number, right = false) =>
    right ? String(s).padStart(w) : String(s).padEnd(w);

  console.log(
    pad("Employee", 24), pad("St", 3), pad("Rg", 3),
    pad("Gross", 12, true), pad("PF", 9, true), pad("ESI", 8, true),
    pad("PT", 7, true), pad("LWF", 6, true), pad("TDS", 11, true), pad("Net", 13, true),
  );
  console.log("-".repeat(96));

  for (const l of lines) {
    console.log(
      pad(`${l.employee.employeeNumber} ${l.employee.displayName}`.slice(0, 23), 24),
      pad(l.employee.location?.stateCode ?? "—", 3),
      pad(l.employee.statutoryProfile?.taxRegime === "OLD" ? "OLD" : "NEW", 3),
      pad(Number(l.grossEarnings).toFixed(0), 12, true),
      pad(Number(l.pfEmployee).toFixed(0), 9, true),
      pad(Number(l.esiEmployee).toFixed(0), 8, true),
      pad(Number(l.professionalTax).toFixed(0), 7, true),
      pad(Number(l.lwfEmployee).toFixed(0), 6, true),
      pad(Number(l.tds).toFixed(0), 11, true),
      pad(Number(l.netPay).toFixed(0), 13, true),
    );
  }

  console.log("-".repeat(96));
  const sum = (f: (l: typeof lines[number]) => number) => lines.reduce((s, l) => s + f(l), 0);
  console.log(
    pad("TOTAL", 31),
    pad(sum((l) => Number(l.grossEarnings)).toFixed(0), 12, true),
    pad(sum((l) => Number(l.pfEmployee)).toFixed(0), 9, true),
    pad(sum((l) => Number(l.esiEmployee)).toFixed(0), 8, true),
    pad(sum((l) => Number(l.professionalTax)).toFixed(0), 7, true),
    pad(sum((l) => Number(l.lwfEmployee)).toFixed(0), 6, true),
    pad(sum((l) => Number(l.tds)).toFixed(0), 11, true),
    pad(sum((l) => Number(l.netPay)).toFixed(0), 13, true),
  );

  console.log("\nReconciliation");
  console.log("-".repeat(60));
  const gross = sum((l) => Number(l.grossEarnings));
  const ded = sum((l) => Number(l.totalDeductions));
  const net = sum((l) => Number(l.netPay));
  console.log(`  Gross earnings        ${formatINR(gross).padStart(18)}`);
  console.log(`  Total deductions      ${formatINR(ded).padStart(18)}`);
  console.log(`  Net payable           ${formatINR(net).padStart(18)}`);
  console.log(`  Gross - deductions    ${formatINR(gross - ded).padStart(18)}  ${Math.abs(gross - ded - net) < 0.01 ? "matches net" : "MISMATCH"}`);
  console.log(`  Employer cost         ${formatINR(sum((l) => Number(l.employerCost))).padStart(18)}`);
  console.log(`  Employees in run      ${String(summary.employeeCount).padStart(18)}`);

  // Statutory spot-checks the engine should always satisfy.
  console.log("\nStatutory checks");
  console.log("-".repeat(60));
  const esiCovered = lines.filter((l) => Number(l.esiEmployee) > 0);
  const esiBreaches = esiCovered.filter((l) => Number(l.esiGross) > 21000);
  console.log(`  ESI covered employees                ${esiCovered.length}`);
  console.log(`  ESI computed above the 21,000 cap     ${esiBreaches.length}  ${esiBreaches.length === 0 ? "ok" : "FAIL"}`);

  const pfBreaches = lines.filter((l) => Number(l.pfWage) > 15000.01);
  console.log(`  PF wage above the 15,000 ceiling      ${pfBreaches.length}  ${pfBreaches.length === 0 ? "ok" : "FAIL"}`);

  const ptBreaches = lines.filter((l) => Number(l.professionalTax) > 300);
  console.log(`  Monthly PT above 300                 ${ptBreaches.length}  ${ptBreaches.length === 0 ? "ok" : "FAIL"}`);

  const byState = new Map<string, number>();
  for (const l of lines) {
    const k = l.employee.location?.stateCode ?? "—";
    byState.set(k, (byState.get(k) ?? 0) + Number(l.professionalTax));
  }
  console.log(`  PT by state: ${[...byState].map(([k, v]) => `${k}=${v.toFixed(0)}`).join("  ")}`);

  const negatives = lines.filter((l) => Number(l.netPay) < 0);
  console.log(`  Negative net pay                     ${negatives.length}${negatives.length ? " (" + negatives.map(l => l.employee.employeeNumber).join(",") + ")" : ""}`);

  if (summary.warnings.length > 0) {
    console.log(`\nWarnings (${summary.warnings.length})`);
    console.log("-".repeat(60));
    for (const w of summary.warnings.slice(0, 12)) console.log(`  ${w}`);
  }
  console.log();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
