import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculatePf } from "../src/statutory/pf";
import { calculateEsi, esiContributionPeriod } from "../src/statutory/esi";
import { calculatePt } from "../src/statutory/pt";
import { calculateLwf } from "../src/statutory/lwf";
import {
  calculateAnnualTax, calculateHraExemption, calculateMonthlyTds,
  applySlabs, compareRegimes,
} from "../src/statutory/tax";
import {
  calculateGratuity, gratuityServiceYears, calculateLeaveEncashment,
  calculateNoticeBuyout,
} from "../src/statutory/gratuity";
import { TAX_SLABS, TAX_CONFIGS } from "../src/data/tax-slabs";
import { PT_SLABS } from "../src/data/pt-slabs";
import { LWF_RULES } from "../src/data/lwf-rules";

const newSlabs = TAX_SLABS.filter((s) => s.regime === "NEW");
const oldSlabs = TAX_SLABS.filter((s) => s.regime === "OLD" && s.maxAge === 59);
const newCfg = TAX_CONFIGS.find((c) => c.regime === "NEW")!;
const oldCfg = TAX_CONFIGS.find((c) => c.regime === "OLD")!;

describe("Provident Fund", () => {
  test("standard case: basic above the ceiling, capped", () => {
    const r = calculatePf({ pfWageBase: 50000, enabled: true });
    // Capped at 15,000 -> 12% employee = 1,800
    assert.equal(r.pfWage.toNumber(), 15000);
    assert.equal(r.employeeContribution.toNumber(), 1800);
    assert.equal(r.employerContribution.toNumber(), 1800);
    // EPS 8.33% of 15,000 = 1,249.50 -> 1,250 (half-up); EPF = 1,800 - 1,250
    assert.equal(r.employerEps.toNumber(), 1250);
    assert.equal(r.employerEpf.toNumber(), 550);
    assert.equal(r.employerEps.plus(r.employerEpf).toNumber(), 1800);
  });

  test("basic below the ceiling uses actual basic", () => {
    const r = calculatePf({ pfWageBase: 12000, enabled: true });
    assert.equal(r.pfWage.toNumber(), 12000);
    assert.equal(r.employeeContribution.toNumber(), 1440);
    assert.equal(r.employerEps.toNumber(), 1000); // 8.33% of 12,000 = 999.6 -> 1000
    assert.equal(r.employerEpf.toNumber(), 440);
  });

  test("uncapped: PF on actual basic when the employer does not restrict", () => {
    const r = calculatePf({ pfWageBase: 50000, enabled: true, capAtCeiling: false });
    assert.equal(r.pfWage.toNumber(), 50000);
    assert.equal(r.employeeContribution.toNumber(), 6000);
    // EPS still restricted to its own 15,000 ceiling
    assert.equal(r.employerEps.toNumber(), 1250);
    assert.equal(r.employerEpf.toNumber(), 4750);
  });

  test("EPS opted out sends the whole employer share to EPF", () => {
    const r = calculatePf({ pfWageBase: 15000, enabled: true, epsApplicable: false });
    assert.equal(r.employerEps.toNumber(), 0);
    assert.equal(r.employerEpf.toNumber(), 1800);
  });

  test("VPF as an amount and as a percentage", () => {
    const byAmount = calculatePf({ pfWageBase: 15000, enabled: true, vpfAmount: 2000 });
    assert.equal(byAmount.vpf.toNumber(), 2000);
    assert.equal(byAmount.totalEmployeeDeduction.toNumber(), 3800);

    const byPercent = calculatePf({ pfWageBase: 15000, enabled: true, vpfPercent: 10 });
    assert.equal(byPercent.vpf.toNumber(), 1500);
  });

  test("proration shrinks the ceiling too, so a half-month joiner is not over-credited", () => {
    const r = calculatePf({ pfWageBase: 25000, enabled: true, prorationFactor: 0.5 });
    assert.equal(r.pfWage.toNumber(), 7500); // ceiling 15,000 x 0.5
    assert.equal(r.employeeContribution.toNumber(), 900);
  });

  test("EDLI and admin charges are employer-borne and outside the 12%", () => {
    const r = calculatePf({ pfWageBase: 15000, enabled: true });
    assert.equal(r.edli.toNumber(), 75);          // 0.5% of 15,000
    assert.equal(r.adminCharges.toNumber(), 75);  // 0.5% of 15,000
    assert.equal(r.totalEmployerCost.toNumber(), 1950);
  });

  test("disabled returns zeroes", () => {
    const r = calculatePf({ pfWageBase: 50000, enabled: false });
    assert.equal(r.applied, false);
    assert.equal(r.employeeContribution.toNumber(), 0);
  });
});

describe("ESI", () => {
  test("covered below the wage limit, rounding up to the next rupee", () => {
    const r = calculateEsi({ esiGross: 20000, enabled: true });
    assert.equal(r.applied, true);
    assert.equal(r.employeeContribution.toNumber(), 150); // 0.75% of 20,000
    assert.equal(r.employerContribution.toNumber(), 650); // 3.25% of 20,000
  });

  test("ESIC rounds UP, not half-up", () => {
    // 0.75% of 10,101 = 75.7575 -> 76, not 75
    const r = calculateEsi({ esiGross: 10101, enabled: true });
    assert.equal(r.employeeContribution.toNumber(), 76);
  });

  test("not covered above the wage limit", () => {
    const r = calculateEsi({ esiGross: 25000, enabled: true });
    assert.equal(r.applied, false);
    assert.equal(r.employeeContribution.toNumber(), 0);
  });

  test("eligibility tests the full monthly wage, not the LOP-reduced figure", () => {
    // Earns 30,000 but lost most of the month to unpaid leave. Still not
    // ESI-covered — a month of absence must not pull someone into the scheme.
    const r = calculateEsi({ esiGross: 8000, fullMonthlyGross: 30000, enabled: true });
    assert.equal(r.applied, false);
  });

  test("coverage continues to the end of the contribution period after crossing the limit", () => {
    const r = calculateEsi({
      esiGross: 25000,
      enabled: true,
      cycleEndDate: new Date(Date.UTC(2026, 8, 30)),
      periodEnd: new Date(Date.UTC(2026, 6, 31)),
    });
    assert.equal(r.applied, true);
    assert.equal(r.continuedForCycle, true);
    // Contribution is on the capped 21,000
    assert.equal(r.esiWage.toNumber(), 21000);
  });

  test("arrears are included in the ESI wage base", () => {
    const withArrears = calculateEsi({ esiGross: 15000, arrears: 3000, enabled: true });
    assert.equal(withArrears.esiWage.toNumber(), 18000);
  });

  test("contribution periods are April-September and October-March", () => {
    const apr = esiContributionPeriod(new Date(Date.UTC(2026, 3, 15)));
    assert.equal(apr.label, "Apr-Sep 2026");
    const nov = esiContributionPeriod(new Date(Date.UTC(2026, 10, 15)));
    assert.equal(nov.label, "Oct 2026 - Mar 2027");
    const feb = esiContributionPeriod(new Date(Date.UTC(2027, 1, 15)));
    assert.equal(feb.label, "Oct 2026 - Mar 2027");
  });
});

describe("Professional Tax", () => {
  const ka = PT_SLABS.filter((s) => s.stateCode === "KA");
  const mh = PT_SLABS.filter((s) => s.stateCode === "MH");
  const tnCorp = PT_SLABS.filter((s) => s.stateCode === "TN" && s.localBodyType === "CORPORATION");

  test("Karnataka: nil below 25,000, flat 200 above", () => {
    assert.equal(calculatePt({ enabled: true, monthlyGross: 20000, month: 6, slabs: ka }).amount.toNumber(), 0);
    assert.equal(calculatePt({ enabled: true, monthlyGross: 30000, month: 6, slabs: ka }).amount.toNumber(), 200);
  });

  test("Maharashtra levies 300 in February and 200 otherwise", () => {
    const male = mh.filter((s) => s.gender === "MALE");
    assert.equal(calculatePt({ enabled: true, monthlyGross: 50000, month: 6, slabs: male, gender: "MALE" }).amount.toNumber(), 200);
    assert.equal(calculatePt({ enabled: true, monthlyGross: 50000, month: 2, slabs: male, gender: "MALE" }).amount.toNumber(), 300);
  });

  test("Maharashtra exempts women up to 25,000", () => {
    const female = mh.filter((s) => s.gender === "FEMALE");
    assert.equal(calculatePt({ enabled: true, monthlyGross: 20000, month: 6, slabs: female, gender: "FEMALE" }).amount.toNumber(), 0);
    assert.equal(calculatePt({ enabled: true, monthlyGross: 30000, month: 6, slabs: female, gender: "FEMALE" }).amount.toNumber(), 200);
  });

  test("Tamil Nadu is half-yearly and collected only in the collection month", () => {
    // 40,000/month -> 240,000 half-yearly -> top slab, 1,250
    const inMonth = calculatePt({
      enabled: true, monthlyGross: 40000, month: 9,
      slabs: tnCorp, frequency: "HALF_YEARLY", collectionMonths: [9, 3],
    });
    assert.equal(inMonth.amount.toNumber(), 1250);

    const offMonth = calculatePt({
      enabled: true, monthlyGross: 40000, month: 7,
      slabs: tnCorp, frequency: "HALF_YEARLY", collectionMonths: [9, 3],
    });
    assert.equal(offMonth.amount.toNumber(), 0);
  });

  test("half-yearly liability can be spread evenly across the period", () => {
    const r = calculatePt({
      enabled: true, monthlyGross: 40000, month: 7,
      slabs: tnCorp, frequency: "HALF_YEARLY", spreadAcrossPeriod: true,
    });
    assert.equal(r.amount.toNumber(), 208.33); // 1250 / 6
  });

  test("the 2,500 annual constitutional ceiling is enforced", () => {
    const r = calculatePt({ enabled: true, monthlyGross: 50000, month: 3, slabs: ka, ytdDeducted: 2400 });
    assert.equal(r.amount.toNumber(), 100); // only 100 of headroom left
    const exhausted = calculatePt({ enabled: true, monthlyGross: 50000, month: 3, slabs: ka, ytdDeducted: 2500 });
    assert.equal(exhausted.amount.toNumber(), 0);
  });
});

describe("Labour Welfare Fund", () => {
  const ka = LWF_RULES.find((r) => r.stateCode === "KA")!;
  const mh = LWF_RULES.find((r) => r.stateCode === "MH")!;

  test("Karnataka deducts once a year in December", () => {
    const dec = calculateLwf({ enabled: true, rule: ka, month: 12, monthlyGross: 50000 });
    assert.equal(dec.employeeContribution.toNumber(), 20);
    assert.equal(dec.employerContribution.toNumber(), 40);

    const jun = calculateLwf({ enabled: true, rule: ka, month: 6, monthlyGross: 50000 });
    assert.equal(jun.applied, false);
    assert.equal(jun.employeeContribution.toNumber(), 0);
  });

  test("Maharashtra deducts in June and December", () => {
    for (const m of [6, 12]) {
      const r = calculateLwf({ enabled: true, rule: mh, month: m, monthlyGross: 50000 });
      assert.equal(r.employeeContribution.toNumber(), 12);
      assert.equal(r.employerContribution.toNumber(), 36);
    }
    assert.equal(calculateLwf({ enabled: true, rule: mh, month: 7, monthlyGross: 50000 }).applied, false);
  });

  test("no rule configured means no deduction", () => {
    assert.equal(calculateLwf({ enabled: true, rule: null, month: 12, monthlyGross: 50000 }).applied, false);
  });
});

describe("HRA exemption", () => {
  test("least of the three figures wins", () => {
    // Basic 50,000/mo -> 600,000/yr. HRA 240,000. Rent 300,000. Metro.
    const r = calculateHraExemption({
      hraReceived: 240000, rentPaid: 300000, salaryForHra: 600000, isMetro: true,
    });
    assert.equal(r.actualHra.toNumber(), 240000);
    assert.equal(r.rentLessTenPercent.toNumber(), 240000); // 300,000 - 60,000
    assert.equal(r.percentOfSalary.toNumber(), 300000);    // 50% of 600,000
    assert.equal(r.exemption.toNumber(), 240000);
    assert.equal(r.taxableHra.toNumber(), 0);
  });

  test("non-metro uses 40 percent", () => {
    const r = calculateHraExemption({
      hraReceived: 300000, rentPaid: 400000, salaryForHra: 600000, isMetro: false,
    });
    assert.equal(r.percentOfSalary.toNumber(), 240000);
    assert.equal(r.exemption.toNumber(), 240000);
    assert.equal(r.taxableHra.toNumber(), 60000);
  });

  test("no rent paid means no exemption", () => {
    const r = calculateHraExemption({
      hraReceived: 240000, rentPaid: 0, salaryForHra: 600000, isMetro: true,
    });
    assert.equal(r.exemption.toNumber(), 0);
    assert.equal(r.taxableHra.toNumber(), 240000);
  });
});

describe("Income tax", () => {
  test("new regime: 12L taxable is fully rebated to nil", () => {
    // 12,75,000 gross - 75,000 standard deduction = 12,00,000 taxable
    const r = calculateAnnualTax({
      regime: "NEW", grossSalary: 1275000, slabs: newSlabs, config: newCfg,
    });
    assert.equal(r.taxableIncome.toNumber(), 1200000);
    // Slab tax: 4-8L @5% = 20,000; 8-12L @10% = 40,000 => 60,000
    assert.equal(r.taxBeforeRebate.toNumber(), 60000);
    assert.equal(r.rebate87A.toNumber(), 60000);
    assert.equal(r.totalTaxLiability.toNumber(), 0);
  });

  test("new regime: marginal relief just above the rebate threshold", () => {
    // Taxable 12,10,000. Slab tax = 60,000 + 15% of 10,000 = 61,500.
    // Income over the threshold is only 10,000, so relief caps tax at 10,000.
    const r = calculateAnnualTax({
      regime: "NEW", grossSalary: 1285000, slabs: newSlabs, config: newCfg,
    });
    assert.equal(r.taxableIncome.toNumber(), 1210000);
    assert.equal(r.taxBeforeRebate.toNumber(), 61500);
    assert.equal(r.taxAfterRebate.toNumber(), 10000);
    assert.equal(r.totalTaxLiability.toNumber(), 10400); // + 4% cess
  });

  test("new regime: a straightforward 20L salary", () => {
    const r = calculateAnnualTax({
      regime: "NEW", grossSalary: 2000000, slabs: newSlabs, config: newCfg,
    });
    assert.equal(r.taxableIncome.toNumber(), 1925000);
    // 4-8L@5%=20,000; 8-12L@10%=40,000; 12-16L@15%=60,000; 16-19.25L@20%=65,000
    assert.equal(r.taxBeforeRebate.toNumber(), 185000);
    assert.equal(r.rebate87A.toNumber(), 0);
    assert.equal(r.cess.toNumber(), 7400);
    assert.equal(r.totalTaxLiability.toNumber(), 192400);
  });

  test("old regime: standard deduction, 80C and HRA all apply", () => {
    const r = calculateAnnualTax({
      regime: "OLD",
      grossSalary: 1200000,
      exemptAllowances: 240000,      // HRA exemption
      chapterViaDeductions: 150000,  // 80C
      professionalTax: 2400,
      slabs: oldSlabs, config: oldCfg,
    });
    // 12,00,000 - 2,40,000 = 9,60,000; - 50,000 SD - 2,400 PT = 9,07,600
    // - 1,50,000 80C = 7,57,600 taxable
    assert.equal(r.taxableIncome.toNumber(), 757600);
    // 2.5-5L@5% = 12,500; 5-7.576L@20% = 51,520 => 64,020
    assert.equal(r.taxBeforeRebate.toNumber(), 64020);
    assert.equal(r.totalTaxLiability.toNumber(), 66581); // + 4% cess, rounded up
  });

  test("new regime refuses exemptions and Chapter VI-A", () => {
    const r = calculateAnnualTax({
      regime: "NEW",
      grossSalary: 1200000,
      exemptAllowances: 240000,
      chapterViaDeductions: 150000,
      professionalTax: 2400,
      slabs: newSlabs, config: newCfg,
    });
    // Only the 75,000 standard deduction applies.
    assert.equal(r.taxableIncome.toNumber(), 1125000);
    assert.ok(r.notes.some((n) => n.includes("new regime")));
  });

  test("80CCD(2) employer NPS survives into the new regime", () => {
    const r = calculateAnnualTax({
      regime: "NEW", grossSalary: 2000000, employerNpsDeduction: 100000,
      slabs: newSlabs, config: newCfg,
    });
    assert.equal(r.taxableIncome.toNumber(), 1825000);
  });

  test("old regime: surcharge above 50L with marginal relief", () => {
    const r = calculateAnnualTax({
      regime: "OLD", grossSalary: 5150000, slabs: oldSlabs, config: oldCfg,
    });
    assert.ok(r.surcharge.greaterThan(0));
    assert.equal(r.surchargeRate.toNumber(), 10);
  });

  test("surcharge marginal relief caps the cliff at 50L", () => {
    // A rupee over 50L must not cost more than a rupee in extra tax.
    const at = calculateAnnualTax({ regime: "OLD", grossSalary: 5050000, slabs: oldSlabs, config: oldCfg });
    const just = calculateAnnualTax({ regime: "OLD", grossSalary: 5050100, slabs: oldSlabs, config: oldCfg });
    const extraIncome = 100;
    const extraTax = just.totalTaxLiability.minus(at.totalTaxLiability).toNumber();
    assert.ok(extraTax <= extraIncome * 1.5, `extra tax ${extraTax} should stay near the extra income ${extraIncome}`);
  });

  test("previous employer income is added to the base", () => {
    const r = calculateAnnualTax({
      regime: "NEW", grossSalary: 800000, previousEmployerIncome: 600000,
      slabs: newSlabs, config: newCfg,
    });
    assert.equal(r.taxableIncome.toNumber(), 1325000);
  });

  test("home loan interest sets off against salary in the old regime", () => {
    const withLoan = calculateAnnualTax({
      regime: "OLD", grossSalary: 1500000, housePropertyIncome: -200000,
      slabs: oldSlabs, config: oldCfg,
    });
    const without = calculateAnnualTax({
      regime: "OLD", grossSalary: 1500000, slabs: oldSlabs, config: oldCfg,
    });
    assert.equal(without.taxableIncome.minus(withLoan.taxableIncome).toNumber(), 200000);
  });

  test("applySlabs produces a band-by-band breakdown", () => {
    const { tax, breakdown } = applySlabs(1000000, newSlabs);
    assert.equal(tax.toNumber(), 40000); // 20,000 + 20,000
    // The nil band is included on purpose - a tax computation statement has
    // to show the exempt slab, not silently skip it.
    assert.equal(breakdown.length, 3);
    assert.equal(breakdown[0].rate.toNumber(), 0);
    assert.equal(breakdown[0].taxableInBand.toNumber(), 400000);
    assert.equal(breakdown[0].tax.toNumber(), 0);
    assert.equal(breakdown[1].rate.toNumber(), 5);
    assert.equal(breakdown[1].taxableInBand.toNumber(), 400000);
    assert.equal(breakdown[1].tax.toNumber(), 20000);
    assert.equal(breakdown[2].rate.toNumber(), 10);
    assert.equal(breakdown[2].taxableInBand.toNumber(), 200000);
    assert.equal(breakdown[2].tax.toNumber(), 20000);
  });

  test("regime comparison picks the cheaper option", () => {
    // Someone with no deductions is better off in the new regime.
    const noDeductions = compareRegimes(
      { grossSalary: 1500000 }, oldSlabs, oldCfg, newSlabs, newCfg,
    );
    assert.equal(noDeductions.better, "NEW");

    // With heavy deductions the old regime can win.
    const heavy = compareRegimes(
      {
        grossSalary: 1500000,
        exemptAllowances: 300000,
        chapterViaDeductions: 200000,
        housePropertyIncome: -200000,
      },
      oldSlabs, oldCfg, newSlabs, newCfg,
    );
    assert.equal(heavy.better, "OLD");
  });
});

describe("Monthly TDS", () => {
  test("annual liability spreads across the remaining months", () => {
    const r = calculateMonthlyTds({ annualTaxLiability: 120000, monthsRemaining: 12 });
    assert.equal(r.tds.toNumber(), 10000);
  });

  test("tax already deducted reduces the spread", () => {
    const r = calculateMonthlyTds({
      annualTaxLiability: 120000, tdsAlreadyDeducted: 60000, monthsRemaining: 6,
    });
    assert.equal(r.tds.toNumber(), 10000);
  });

  test("a mid-year joiner carries a heavier monthly deduction", () => {
    const r = calculateMonthlyTds({ annualTaxLiability: 120000, monthsRemaining: 4 });
    assert.equal(r.tds.toNumber(), 30000);
  });

  test("over-deduction stops further TDS rather than going negative", () => {
    const r = calculateMonthlyTds({
      annualTaxLiability: 50000, tdsAlreadyDeducted: 60000, monthsRemaining: 3,
    });
    assert.equal(r.tds.toNumber(), 0);
  });

  test("flat TDS for contractual employees bypasses the spread", () => {
    const r = calculateMonthlyTds({
      annualTaxLiability: 999999, monthsRemaining: 12, flatAmount: 5000,
    });
    assert.equal(r.tds.toNumber(), 5000);
  });

  test("admin override wins but the computed figure is retained", () => {
    const r = calculateMonthlyTds({
      annualTaxLiability: 120000, monthsRemaining: 12, override: 3000,
    });
    assert.equal(r.tds.toNumber(), 3000);
    assert.equal(r.computed.toNumber(), 10000);
    assert.equal(r.isOverridden, true);
  });
});

describe("Gratuity", () => {
  test("service under five years is not eligible", () => {
    const r = calculateGratuity({
      lastDrawnBasicDa: 50000,
      dateOfJoining: new Date(Date.UTC(2022, 0, 1)),
      lastWorkingDay: new Date(Date.UTC(2026, 0, 1)),
      actCovered: true,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.grossGratuity.toNumber(), 0);
  });

  test("covered by the Act: 15 days per year on a 26-day month", () => {
    const r = calculateGratuity({
      lastDrawnBasicDa: 52000,
      dateOfJoining: new Date(Date.UTC(2016, 0, 1)),
      lastWorkingDay: new Date(Date.UTC(2026, 0, 1)),
      actCovered: true,
    });
    assert.equal(r.eligible, true);
    assert.equal(r.serviceYears, 10);
    // 15 x 52,000 x 10 / 26 = 300,000
    assert.equal(r.grossGratuity.toNumber(), 300000);
    assert.equal(r.taxableAmount.toNumber(), 0);
  });

  test("a final part-year over six months rounds up", () => {
    const over = gratuityServiceYears(
      new Date(Date.UTC(2016, 0, 1)), new Date(Date.UTC(2026, 7, 15)),
    );
    assert.equal(over.years, 10);
    assert.equal(over.months, 7);
    assert.equal(over.rounded, 11);

    const under = gratuityServiceYears(
      new Date(Date.UTC(2016, 0, 1)), new Date(Date.UTC(2026, 4, 15)),
    );
    assert.equal(under.rounded, 10);
  });

  test("not covered by the Act uses a 30-day month and average wages", () => {
    const r = calculateGratuity({
      lastDrawnBasicDa: 60000,
      averageMonthlyWages: 60000,
      dateOfJoining: new Date(Date.UTC(2016, 0, 1)),
      lastWorkingDay: new Date(Date.UTC(2026, 0, 1)),
      actCovered: false,
    });
    // 15 x 60,000 x 10 / 30 = 300,000
    assert.equal(r.grossGratuity.toNumber(), 300000);
    assert.equal(r.divisor.toNumber(), 30);
  });

  test("the 20 lakh exemption ceiling caps the exempt portion", () => {
    const r = calculateGratuity({
      lastDrawnBasicDa: 500000,
      dateOfJoining: new Date(Date.UTC(2000, 0, 1)),
      lastWorkingDay: new Date(Date.UTC(2026, 0, 1)),
      actCovered: true,
    });
    // 15 x 500,000 x 26 / 26 = 7,500,000 gross
    assert.equal(r.grossGratuity.toNumber(), 7500000);
    assert.equal(r.exemptAmount.toNumber(), 2000000);
    assert.equal(r.taxableAmount.toNumber(), 5500000);
  });

  test("the minimum-service rule is waived on death or disablement", () => {
    const r = calculateGratuity({
      lastDrawnBasicDa: 50000,
      dateOfJoining: new Date(Date.UTC(2024, 0, 1)),
      lastWorkingDay: new Date(Date.UTC(2026, 0, 1)),
      actCovered: true,
      waiveMinimumService: true,
    });
    assert.equal(r.eligible, true);
    assert.ok(r.grossGratuity.greaterThan(0));
  });
});

describe("Leave encashment and notice buyout", () => {
  test("encashment during service is fully taxable", () => {
    const r = calculateLeaveEncashment({ days: 10, monthlyWage: 60000, isOnExit: false });
    assert.equal(r.grossAmount.toNumber(), 20000);
    assert.equal(r.exemptAmount.toNumber(), 0);
    assert.equal(r.taxableAmount.toNumber(), 20000);
  });

  test("encashment on exit attracts the 10(10AA) exemption", () => {
    const r = calculateLeaveEncashment({ days: 30, monthlyWage: 60000, isOnExit: true });
    assert.equal(r.grossAmount.toNumber(), 60000);
    assert.equal(r.exemptAmount.toNumber(), 60000);
    assert.equal(r.taxableAmount.toNumber(), 0);
  });

  test("notice shortfall is recovered from the employee", () => {
    const r = calculateNoticeBuyout({
      requiredDays: 60, servedDays: 30, monthlyWage: 90000,
    });
    assert.equal(r.shortfallDays, 30);
    assert.equal(r.amount.toNumber(), 90000); // 3,000/day x 30
    assert.equal(r.isRecovery, true);
  });

  test("full notice served means nothing changes hands", () => {
    const r = calculateNoticeBuyout({ requiredDays: 60, servedDays: 60, monthlyWage: 90000 });
    assert.equal(r.amount.toNumber(), 0);
  });

  test("an employer buyout pays the employee instead", () => {
    const r = calculateNoticeBuyout({
      requiredDays: 60, servedDays: 30, monthlyWage: 90000, employerBuyout: true,
    });
    assert.equal(r.isRecovery, false);
    assert.equal(r.amount.toNumber(), 90000);
  });
});

describe("Age-band slab selection (regression)", () => {
  // A real bug this guards against: the old regime publishes three separate
  // slab tables (under-60, 60-79, 80+). Loading them into one list makes the
  // upper slabs repeat, which silently over-deducts tax for everyone.
  const senior = TAX_SLABS.filter((s) => s.regime === "OLD" && s.minAge === 60);
  const superSenior = TAX_SLABS.filter((s) => s.regime === "OLD" && s.minAge === 80);

  test("each old-regime age band is a complete, self-contained table", () => {
    assert.equal(oldSlabs.length, 4);       // 0, 5%, 20%, 30%
    assert.equal(senior.length, 4);
    assert.equal(superSenior.length, 3);    // no 5% band
    // Each band must start at zero, or the first rupee of income is untaxed
    // by accident rather than by design.
    for (const band of [oldSlabs, senior, superSenior]) {
      assert.equal(Math.min(...band.map((s) => s.fromAmount)), 0);
    }
  });

  test("a higher exemption limit means less tax at the same income", () => {
    const income = 900000;
    const under60 = applySlabs(income, oldSlabs).tax.toNumber();
    const sixtyPlus = applySlabs(income, senior).tax.toNumber();
    const eightyPlus = applySlabs(income, superSenior).tax.toNumber();

    assert.ok(sixtyPlus < under60, "senior citizens pay less than under-60s");
    assert.ok(eightyPlus < sixtyPlus, "super seniors pay less than seniors");

    // Exact figures, so a slab edit cannot drift unnoticed.
    assert.equal(under60, 12500 + 80000);        // 2.5-5L @5%, 5-9L @20%
    assert.equal(sixtyPlus, 10000 + 80000);      // 3-5L @5%,   5-9L @20%
    assert.equal(eightyPlus, 80000);             // 5-9L @20% only
  });

  test("merging the age bands inflates tax — this is the bug being guarded", () => {
    const merged = [...oldSlabs, ...senior, ...superSenior];
    const income = 1900000;
    const correct = applySlabs(income, oldSlabs).tax.toNumber();
    const wrong = applySlabs(income, merged).tax.toNumber();
    assert.ok(
      wrong > correct * 2,
      `merged bands should massively overstate tax (correct ${correct}, merged ${wrong})`,
    );
  });

  test("the new regime has a single band covering every age", () => {
    const bands = new Set(newSlabs.map((s) => `${s.minAge}-${s.maxAge}`));
    assert.equal(bands.size, 1);
    assert.equal([...bands][0], "0-200");
  });
});
