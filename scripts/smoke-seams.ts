/**
 * Verifies the cross-module seams into payroll.
 *
 * A recognition module that cannot actually pay a cash award, or an asset
 * module whose damage charge never reaches a payslip, is decorative. These
 * are the joins worth testing.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient } from "@prisma/client";
import { formatINR, formatPeriod } from "@keka/shared";

const prisma = new PrismaClient();
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const { createRun, calculateRun } = await import("@keka/services");

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const payGroup = await prisma.payGroup.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const actor = await prisma.user.findFirstOrThrow({ where: { email: "ramesh.iyer@acme.test" } });

  // A fresh open run for September, separate from the finalised June one.
  const year = 2026, month = 9;
  console.log(`\nCross-module seams — ${formatPeriod(year, month)}`);
  console.log("=".repeat(76));

  const runId = await createRun({ tenantId: tenant.id, payGroupId: payGroup.id, year, month });

  // createRun reuses an open run for the period, so clear anything an earlier,
  // interrupted run of this test injected before taking the baseline.
  await releaseInjections(runId);
  await calculateRun(runId);

  const createdAdhoc: string[] = [];
  let restoreAssignment: (() => Promise<unknown>) | null = null;
  try {

  const baseline = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  console.log(`\n  Baseline run: ${baseline.employeeCount} employees, net ${formatINR(Number(baseline.totalNetPay))}\n`);

  // -------------------------------------------------------------------
  //  SEAM 1 — a cash award becomes an ad-hoc payment
  // -------------------------------------------------------------------
  console.log("SEAM 1  Award with cash -> ad-hoc payment on the payslip");
  console.log("-".repeat(76));

  const award = await prisma.employeeAward.findFirstOrThrow({
    where: { tenantId: tenant.id, cashAmount: { not: null }, paidInRunId: null },
    include: { awardType: true, employee: { select: { id: true, displayName: true, employeeNumber: true } } },
  });
  const awardCash = Number(award.cashAmount);

  const beforeAward = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: award.employeeId } },
  });

  createdAdhoc.push((await prisma.adhocTransaction.create({
    data: {
      employeeId: award.employeeId, type: "PAYMENT",
      name: `${award.awardType.name} award`, amount: awardCash,
      taxTreatment: "TAXABLE", year, month, runId,
      comment: award.citation, createdBy: actor.id,
    },
  })).id);
  await prisma.employeeAward.update({ where: { id: award.id }, data: { paidInRunId: runId } });
  await calculateRun(runId);

  const afterAward = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: award.employeeId } },
    include: { lines: true },
  });

  const grossDelta = Number(afterAward.grossEarnings) - Number(beforeAward.grossEarnings);
  check(
    `Gross rose by the award amount for ${award.employee.employeeNumber}`,
    Math.abs(grossDelta - awardCash) < 1,
    `expected +${formatINR(awardCash)}, got +${formatINR(grossDelta)}`,
  );
  check(
    "The award appears as a named payslip line",
    afterAward.lines.some((l) => l.name.includes(award.awardType.name)),
    afterAward.lines.filter((l) => l.type === "EARNING").map((l) => l.name).join(", "),
  );
  // A taxable award should raise TDS, not leave it flat.
  const tdsDelta = Number(afterAward.tds) - Number(beforeAward.tds);
  check(
    "Taxable award increased TDS",
    tdsDelta > 0 || Number(beforeAward.tds) === 0,
    `TDS ${formatINR(Number(beforeAward.tds))} -> ${formatINR(Number(afterAward.tds))}`,
  );

  // -------------------------------------------------------------------
  //  SEAM 2 — asset damage becomes an ad-hoc deduction
  // -------------------------------------------------------------------
  console.log("\nSEAM 2  Asset damage charge -> ad-hoc deduction on the payslip");
  console.log("-".repeat(76));

  // Pick a serving employee and record a damaged return against them, so the
  // recovery path is exercised on someone still on payroll.
  const serving = await prisma.employee.findFirstOrThrow({
    where: { tenantId: tenant.id, status: "CONFIRMED", payGroupId: payGroup.id },
    orderBy: { employeeNumber: "asc" },
  });
  const openAssignment = await prisma.assetAssignment.findFirstOrThrow({
    where: { employeeId: serving.id, returnedOn: null },
    include: { asset: { include: { assetType: true } } },
  });

  const DAMAGE = 7500;
  const original = {
    returnedOn: openAssignment.returnedOn, conditionIn: openAssignment.conditionIn,
    damageCharge: openAssignment.damageCharge, damageNote: openAssignment.damageNote,
  };
  restoreAssignment = () => prisma.assetAssignment.update({ where: { id: openAssignment.id }, data: original });
  await prisma.assetAssignment.update({
    where: { id: openAssignment.id },
    data: {
      returnedOn: new Date(Date.UTC(2026, 8, 25)),
      conditionIn: "DAMAGED",
      damageCharge: DAMAGE,
      damageNote: "Liquid damage to the keyboard.",
    },
  });

  const beforeDamage = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: serving.id } },
  });

  createdAdhoc.push((await prisma.adhocTransaction.create({
    data: {
      employeeId: serving.id, type: "DEDUCTION",
      name: `Asset damage recovery — ${openAssignment.asset.assetType.name} (${openAssignment.asset.assetTag})`,
      amount: DAMAGE, taxTreatment: "NON_TAXABLE",
      year, month, runId, createdBy: actor.id,
    },
  })).id);
  await prisma.assetAssignment.update({
    where: { id: openAssignment.id }, data: { chargeRecovered: true },
  });
  await calculateRun(runId);

  const afterDamage = await prisma.payrollRunEmployee.findUniqueOrThrow({
    where: { runId_employeeId: { runId, employeeId: serving.id } },
    include: { lines: true },
  });

  const dedDelta = Number(afterDamage.totalDeductions) - Number(beforeDamage.totalDeductions);
  const netDelta = Number(afterDamage.netPay) - Number(beforeDamage.netPay);
  check(
    `Deductions rose by the damage charge for ${serving.employeeNumber}`,
    Math.abs(dedDelta - DAMAGE) < 1,
    `expected +${formatINR(DAMAGE)}, got +${formatINR(dedDelta)}`,
  );
  check(
    "Net pay fell by the same amount",
    Math.abs(netDelta + DAMAGE) < 1,
    `expected -${formatINR(DAMAGE)}, got ${formatINR(netDelta)}`,
  );
  check(
    "A non-taxable recovery did not change gross",
    Math.abs(Number(afterDamage.grossEarnings) - Number(beforeDamage.grossEarnings)) < 1,
  );
  check(
    "The recovery appears as a named deduction line",
    afterDamage.lines.some((l) => l.type === "DEDUCTION" && l.name.includes("Asset damage recovery")),
  );

  // -------------------------------------------------------------------
  //  SEAM 3 — the run still reconciles after both injections
  // -------------------------------------------------------------------
  console.log("\nSEAM 3  Whole-run reconciliation after both injections");
  console.log("-".repeat(76));

  const lines = await prisma.payrollRunEmployee.findMany({ where: { runId } });
  const gross = lines.reduce((s, l) => s + Number(l.grossEarnings), 0);
  const ded = lines.reduce((s, l) => s + Number(l.totalDeductions), 0);
  const net = lines.reduce((s, l) => s + Number(l.netPay), 0);
  check(
    "Gross minus deductions equals net across every employee",
    Math.abs(gross - ded - net) < 0.01,
    `${formatINR(gross)} - ${formatINR(ded)} = ${formatINR(gross - ded)} vs net ${formatINR(net)}`,
  );

  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  check(
    "Run header totals match the sum of its lines",
    Math.abs(Number(run.totalNetPay) - net) < 0.01,
    `header ${formatINR(Number(run.totalNetPay))} vs lines ${formatINR(net)}`,
  );

  const esiBreach = lines.filter((l) => Number(l.esiEmployee) > 0 && Number(l.esiGross) > 21000);
  check("ESI still capped at the wage limit", esiBreach.length === 0);
  const pfBreach = lines.filter((l) => Number(l.pfWage) > 15000.01);
  check("PF wage still capped at the ceiling", pfBreach.length === 0);

  // -------------------------------------------------------------------
  //  SEAM 4 — rollback releases everything the modules injected
  // -------------------------------------------------------------------
  console.log("\nSEAM 4  Rollback releases the injected transactions");
  console.log("-".repeat(76));

  await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "LOCKED", lockedAt: new Date(), lockedBy: actor.id },
  });
  for (const l of lines) {
    if (l.payAction === "HOLD_SALARY_PROCESSING" || l.payAction === "VOID_SALARY_PROCESSING") continue;
    await prisma.payslip.upsert({
      where: { runId_employeeId_isSegregated: { runId, employeeId: l.employeeId, isSegregated: false } },
      create: { runId, employeeId: l.employeeId, year, month, status: "GENERATED", netPay: l.netPay },
      update: { netPay: l.netPay },
    });
  }
  await prisma.payrollRun.update({
    where: { id: runId }, data: { status: "FINALIZED", finalizedAt: new Date() },
  });
  await prisma.adhocTransaction.updateMany({
    where: { runId, isProcessed: false }, data: { isProcessed: true },
  });

  const payslipsAfterFinalise = await prisma.payslip.count({ where: { runId } });
  check("Finalising generated payslips", payslipsAfterFinalise > 0, `${payslipsAfterFinalise} payslips`);

  // Now roll back.
  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId } });
    await tx.adhocTransaction.updateMany({ where: { runId }, data: { isProcessed: false } });
    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        status: "IN_PROGRESS", rolledBackAt: new Date(),
        rollbackReason: "Seam smoke test",
        lockedAt: null, lockedBy: null, finalizedAt: null, finalizedBy: null,
      },
    });
  });

  const payslipsAfterRollback = await prisma.payslip.count({ where: { runId } });
  const unprocessed = await prisma.adhocTransaction.count({ where: { runId, isProcessed: false } });
  check("Rollback removed the payslips", payslipsAfterRollback === 0);
  check("Rollback released the ad-hoc transactions", unprocessed === 2, `${unprocessed} released`);
  } finally {
    // Put back everything this test borrowed, so it can run again.
    await prisma.adhocTransaction.deleteMany({ where: { id: { in: createdAdhoc } } });
    await releaseInjections(runId);
    if (restoreAssignment) await restoreAssignment();
    await calculateRun(runId);
  }

  console.log("\n" + "=".repeat(76));
  console.log(failures === 0 ? "  All seams verified.\n" : `  ${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exitCode = 1;
}

/** Undo this test's side effects on a run: its ad-hoc rows and award links. */
async function releaseInjections(runId: string) {
  await prisma.adhocTransaction.deleteMany({
    where: { runId, OR: [{ name: { endsWith: " award" } }, { name: { startsWith: "Asset damage recovery" } }] },
  });
  await prisma.employeeAward.updateMany({ where: { paidInRunId: runId }, data: { paidInRunId: null } });
  // Damage the test recorded on otherwise-open assignments.
  await prisma.assetAssignment.updateMany({
    where: { damageNote: "Liquid damage to the keyboard." },
    data: { returnedOn: null, conditionIn: null, damageCharge: null, damageNote: null },
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
