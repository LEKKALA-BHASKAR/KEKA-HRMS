import type { PrismaClient } from "@prisma/client";
import { PT_SLABS } from "../../../payroll/src/data/pt-slabs";
import { LWF_RULES } from "../../../payroll/src/data/lwf-rules";
import { TAX_SLABS, TAX_CONFIGS } from "../../../payroll/src/data/tax-slabs";

/**
 * Reference data — statutory tables that are the same for every tenant.
 * Effective-dated so a historical payroll run reproduces exactly.
 */
export async function seedReferenceData(prisma: PrismaClient) {
  const effectiveFrom = new Date(Date.UTC(2025, 3, 1)); // 1 April 2025

  await prisma.ptSlab.deleteMany({});
  await prisma.ptSlab.createMany({
    data: PT_SLABS.map((s) => ({
      stateCode: s.stateCode,
      localBodyType: s.localBodyType ?? null,
      gender: s.gender ?? null,
      frequency: s.frequency,
      fromAmount: s.fromAmount,
      toAmount: s.toAmount,
      amount: s.amount,
      specialMonth: s.specialMonth ?? null,
      specialAmount: s.specialAmount ?? null,
      effectiveFrom,
    })),
  });

  await prisma.lwfRule.deleteMany({});
  await prisma.lwfRule.createMany({
    data: LWF_RULES.map((r) => ({
      stateCode: r.stateCode,
      frequency: r.frequency,
      deductionMonths: r.deductionMonths,
      employeeAmount: r.employeeAmount,
      employerAmount: r.employerAmount,
      wageLimit: r.wageLimit ?? null,
      effectiveFrom,
    })),
  });

  await prisma.incomeTaxSlab.deleteMany({});
  await prisma.incomeTaxSlab.createMany({
    data: TAX_SLABS.map((s) => ({
      regime: s.regime,
      fyStartYear: s.fyStartYear,
      minAge: s.minAge,
      maxAge: s.maxAge,
      fromAmount: s.fromAmount,
      toAmount: s.toAmount,
      ratePercent: s.ratePercent,
    })),
  });

  await prisma.incomeTaxConfig.deleteMany({});
  for (const c of TAX_CONFIGS) {
    await prisma.incomeTaxConfig.create({
      data: {
        regime: c.regime,
        fyStartYear: c.fyStartYear,
        standardDeduction: c.standardDeduction,
        rebateLimit: c.rebateLimit,
        rebateMaxAmount: c.rebateMaxAmount,
        cessPercent: c.cessPercent,
        surchargeBands: c.surchargeBands,
        marginalReliefEnabled: c.marginalReliefEnabled,
      },
    });
  }

  return {
    ptSlabs: PT_SLABS.length,
    lwfRules: LWF_RULES.length,
    taxSlabs: TAX_SLABS.length,
    taxConfigs: TAX_CONFIGS.length,
  };
}
