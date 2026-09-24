import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveStructure, selectStructureForCtc } from "../src/structure";
import { calculatePayroll } from "../src/engine";
import { TAX_SLABS, TAX_CONFIGS } from "../src/data/tax-slabs";
import { PT_SLABS } from "../src/data/pt-slabs";
import { LWF_RULES } from "../src/data/lwf-rules";
import type { StructureComponentSpec } from "../src/structure";

const newSlabs = TAX_SLABS.filter((s) => s.regime === "NEW");
const oldSlabs = TAX_SLABS.filter((s) => s.regime === "OLD" && s.maxAge === 59);
const newCfg = TAX_CONFIGS.find((c) => c.regime === "NEW")!;
const oldCfg = TAX_CONFIGS.find((c) => c.regime === "OLD")!;
const kaSlabs = PT_SLABS.filter((s) => s.stateCode === "KA");
const kaLwf = LWF_RULES.find((r) => r.stateCode === "KA")!;

/** A conventional Indian structure: Basic 40% of CTC, HRA 50% of Basic. */
const STANDARD_STRUCTURE: StructureComponentSpec[] = [
  {
    code: "BASIC", name: "Basic", type: "EARNING", calculationType: "FORMULA",
    formula: "[CTC_MONTHLY] * 0.40", sequence: 1,
    affectsPfWage: true, affectsEsiGross: true,
  },
  {
    code: "HRA", name: "House Rent Allowance", type: "EARNING", calculationType: "FORMULA",
    formula: "[BASIC] * 0.50", sequence: 2, affectsEsiGross: true,
  },
  {
    code: "CONVEYANCE", name: "Conveyance Allowance", type: "EARNING",
    calculationType: "FIXED", fixedAmount: 1600, sequence: 3, affectsEsiGross: true,
  },
  {
    code: "PF_EMPLOYER", name: "Employer PF", type: "EMPLOYER_CONTRIBUTION",
    calculationType: "FORMULA", formula: "IF([BASIC] > 15000, 1800, [BASIC] * 0.12)",
    sequence: 10,
  },
  {
    code: "GRATUITY_PROVISION", name: "Gratuity Provision", type: "EMPLOYER_CONTRIBUTION",
    calculationType: "FORMULA", formula: "[BASIC] * 0.0481", sequence: 11,
  },
  {
    code: "SPECIAL", name: "Special Allowance", type: "EARNING",
    calculationType: "BALANCE", sequence: 5, affectsEsiGross: true,
  },
];

describe("Structure resolution", () => {
  test("a 12 lakh CTC resolves and reconciles to the CTC", () => {
    const r = resolveStructure({ annualCtc: 1200000, components: STANDARD_STRUCTURE });
    const basic = r.byCode.get("BASIC")!;
    const hra = r.byCode.get("HRA")!;

    assert.equal(basic.monthly.toNumber(), 40000);  // 40% of 100,000
    assert.equal(hra.monthly.toNumber(), 20000);    // 50% of Basic
    assert.equal(r.byCode.get("PF_EMPLOYER")!.monthly.toNumber(), 1800);
    assert.equal(r.byCode.get("GRATUITY_PROVISION")!.monthly.toNumber(), 1924);

    // Special allowance absorbs the remainder so the total lands on the CTC.
    const special = r.byCode.get("SPECIAL")!;
    assert.equal(special.monthly.toNumber(), 100000 - 40000 - 20000 - 1600 - 1800 - 1924);
    assert.equal(r.monthlyCtcValue.toNumber(), 100000);
    assert.ok(r.reconciliationGap.abs().lessThanOrEqualTo(1));
    assert.deepEqual(r.warnings, []);
  });

  test("nested IF in the PF formula switches at the ceiling", () => {
    const low = resolveStructure({ annualCtc: 300000, components: STANDARD_STRUCTURE });
    // Basic = 10,000 -> below ceiling -> 12% = 1,200
    assert.equal(low.byCode.get("BASIC")!.monthly.toNumber(), 10000);
    assert.equal(low.byCode.get("PF_EMPLOYER")!.monthly.toNumber(), 1200);

    const high = resolveStructure({ annualCtc: 2400000, components: STANDARD_STRUCTURE });
    assert.equal(high.byCode.get("PF_EMPLOYER")!.monthly.toNumber(), 1800);
  });

  test("over-configured components warn and zero the balance rather than going negative", () => {
    const r = resolveStructure({
      annualCtc: 120000, // 10,000/month
      components: [
        { code: "BASIC", name: "Basic", type: "EARNING", calculationType: "FIXED", fixedAmount: 8000, sequence: 1 },
        { code: "HRA", name: "HRA", type: "EARNING", calculationType: "FIXED", fixedAmount: 5000, sequence: 2 },
        { code: "SPECIAL", name: "Special", type: "EARNING", calculationType: "BALANCE", sequence: 3 },
      ],
    });
    assert.equal(r.byCode.get("SPECIAL")!.monthly.toNumber(), 0);
    assert.ok(r.warnings.some((w) => w.includes("exceed the CTC")));
  });

  test("a circular reference is reported, not hung on", () => {
    const r = resolveStructure({
      annualCtc: 600000,
      components: [
        { code: "A", name: "A", type: "EARNING", calculationType: "FORMULA", formula: "[B] * 2", sequence: 1 },
        { code: "B", name: "B", type: "EARNING", calculationType: "FORMULA", formula: "[A] * 2", sequence: 2 },
      ],
    });
    assert.ok(r.warnings.some((w) => w.includes("Circular")));
  });

  test("range-based structures select by CTC", () => {
    const structures = [
      { name: "Class D", minAnnualCtc: 0, maxAnnualCtc: 300000 },
      { name: "Class C", minAnnualCtc: 300001, maxAnnualCtc: 800000 },
      { name: "Class B", minAnnualCtc: 800001, maxAnnualCtc: 2000000 },
      { name: "Class A", minAnnualCtc: 2000001, maxAnnualCtc: null },
    ];
    assert.equal(selectStructureForCtc(structures, 250000)!.name, "Class D");
    assert.equal(selectStructureForCtc(structures, 500000)!.name, "Class C");
    assert.equal(selectStructureForCtc(structures, 1200000)!.name, "Class B");
    assert.equal(selectStructureForCtc(structures, 5000000)!.name, "Class A");
  });
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  employeeId: "emp_1",
  year: 2026,
  month: 6,
  annualCtc: 1200000,
  structureComponents: STANDARD_STRUCTURE,
  statutory: {
    pfEnabled: true,
    esiEnabled: true,
    ptEnabled: true,
    ptSlabs: kaSlabs,
    lwfEnabled: true,
    lwfRule: kaLwf,
  },
  tax: {
    enabled: true,
    regime: "NEW" as const,
    slabs: newSlabs,
    config: newCfg,
  },
  ...overrides,
});

describe("Payroll engine", () => {
  test("full month, no LOP: gross, deductions and net all tie up", () => {
    const r = calculatePayroll(baseInput() as never);

    assert.equal(r.totalDays, 30);
    assert.equal(r.lopDays.toNumber(), 0);
    assert.equal(r.prorationFactor.toNumber(), 1);

    // Earnings: Basic 40,000 + HRA 20,000 + Conveyance 1,600 + Special 34,676
    assert.equal(r.grossEarnings.toNumber(), 96276);

    // PF on Basic 40,000, capped at the 15,000 ceiling -> 1,800
    assert.equal(r.pf.pfWage.toNumber(), 15000);
    assert.equal(r.pf.employeeContribution.toNumber(), 1800);

    // Gross is well over 21,000, so no ESI
    assert.equal(r.esi.applied, false);

    // Karnataka PT: 200 above 25,000
    assert.equal(r.pt.amount.toNumber(), 200);

    // June is not a Karnataka LWF month
    assert.equal(r.lwf.applied, false);

    // Net = gross - (PF + PT + TDS)
    const expectedNet = r.grossEarnings.minus(r.totalDeductions);
    assert.equal(r.netPay.toNumber(), expectedNet.toNumber());
    assert.ok(r.netPay.greaterThan(0));

    // Every line balances into one of the three buckets.
    const sumEarnings = r.lines.filter((l) => l.type === "EARNING" || l.type === "REIMBURSEMENT")
      .reduce((s, l) => s.plus(l.amount), r.grossEarnings.minus(r.grossEarnings));
    assert.equal(sumEarnings.toNumber(), r.grossEarnings.toNumber());
  });

  test("loss of pay prorates earnings and the PF ceiling together", () => {
    const full = calculatePayroll(baseInput() as never);
    const withLop = calculatePayroll(baseInput({
      attendance: { totalDays: 30, lopDays: 3 },
    }) as never);

    assert.equal(withLop.lopDays.toNumber(), 3);
    assert.equal(withLop.payableDays.toNumber(), 27);
    assert.equal(withLop.prorationFactor.toNumber(), 0.9);

    // Earnings drop by 10%
    assert.ok(withLop.grossEarnings.lessThan(full.grossEarnings));
    assert.equal(
      withLop.grossEarnings.toNumber(),
      Math.round(full.grossEarnings.toNumber() * 0.9),
    );

    // The PF ceiling prorates too, so PF is 12% of 13,500, not of 15,000.
    assert.equal(withLop.pf.pfWage.toNumber(), 13500);
    assert.equal(withLop.pf.employeeContribution.toNumber(), 1620);
  });

  test("LOP reversal from an earlier month reduces this month's LOP", () => {
    const r = calculatePayroll(baseInput({
      attendance: { totalDays: 30, lopDays: 3, lopReversalDays: 2 },
    }) as never);
    assert.equal(r.lopDays.toNumber(), 1);
    assert.equal(r.payableDays.toNumber(), 29);
  });

  test("a mid-month joiner is prorated from their joining date", () => {
    const r = calculatePayroll(baseInput({
      joiningDate: new Date(Date.UTC(2026, 5, 16)),
    }) as never);
    // Joined on the 16th -> 15 unpayable days -> 15 payable
    assert.equal(r.payableDays.toNumber(), 15);
    assert.equal(r.prorationFactor.toNumber(), 0.5);
    assert.ok(r.notes.some((n) => n.includes("Joined on day 16")));
  });

  test("a leaver is prorated to their last working day", () => {
    const r = calculatePayroll(baseInput({
      lastWorkingDay: new Date(Date.UTC(2026, 5, 10)),
    }) as never);
    assert.equal(r.payableDays.toNumber(), 10);
    assert.ok(r.notes.some((n) => n.includes("Last working day")));
  });

  test("a low salary is covered by ESI and PF on actual basic", () => {
    const r = calculatePayroll(baseInput({ annualCtc: 240000 }) as never);
    // Basic = 8,000 -> below the PF ceiling, so PF is on actual basic
    assert.equal(r.pf.pfWage.toNumber(), 8000);
    assert.equal(r.pf.employeeContribution.toNumber(), 960);

    // Monthly CTC is 20,000, but gross EARNINGS are 18,655 — employer PF
    // (960) and the gratuity provision (385) are part of CTC without being
    // paid to the employee, so they never enter the ESI base.
    assert.equal(r.grossEarnings.toNumber(), 18655);
    assert.equal(r.esi.applied, true);
    assert.equal(r.esi.esiWage.toNumber(), 18655);
    assert.equal(r.esi.employeeContribution.toNumber(), 140); // 0.75%, rounded up
    assert.equal(r.esi.employerContribution.toNumber(), 607); // 3.25%, rounded up
    // Karnataka PT is nil below 25,000
    assert.equal(r.pt.amount.toNumber(), 0);
  });

  test("December pulls in the Karnataka LWF deduction", () => {
    const r = calculatePayroll(baseInput({ month: 12 }) as never);
    assert.equal(r.lwf.applied, true);
    assert.equal(r.lwf.employeeContribution.toNumber(), 20);
    assert.equal(r.lwf.employerContribution.toNumber(), 40);
    assert.ok(r.lines.some((l) => l.code === "LWF_EMPLOYEE" && l.amount.toNumber() === 20));
  });

  test("variable pay lands on the payslip and moves net pay", () => {
    const plain = calculatePayroll(baseInput() as never);
    const withExtras = calculatePayroll(baseInput({
      variablePay: {
        arrears: 5000,
        bonus: 25000,
        overtimeAmount: 3000,
        adhocPayments: [{ name: "Referral Bonus", amount: 10000, isTaxable: true }],
        adhocDeductions: [{ name: "Canteen Recovery", amount: 1500 }],
        loanEmis: [{ name: "Personal Loan EMI", amount: 8000 }],
        componentClaims: [
          { code: "FUEL", name: "Fuel Reimbursement", amount: 6000, isTaxable: false },
        ],
      },
    }) as never);

    assert.ok(withExtras.lines.some((l) => l.code === "ARREARS" && l.amount.toNumber() === 5000));
    assert.ok(withExtras.lines.some((l) => l.code === "BONUS" && l.amount.toNumber() === 25000));
    assert.ok(withExtras.lines.some((l) => l.code === "LOAN_EMI_1" && l.amount.toNumber() === 8000));

    // The fuel claim is a reimbursement, not taxable income.
    const fuel = withExtras.lines.find((l) => l.code === "FUEL")!;
    assert.equal(fuel.type, "REIMBURSEMENT");
    assert.ok(withExtras.taxableGrossThisMonth.lessThan(withExtras.grossEarnings));

    assert.ok(withExtras.grossEarnings.greaterThan(plain.grossEarnings));
  });

  test("step-6 overrides replace the computed statutory figures", () => {
    const r = calculatePayroll(baseInput({
      overrides: { pt: 150, tds: 5000, lwf: 25 },
    }) as never);

    assert.equal(r.lines.find((l) => l.code === "PT")!.amount.toNumber(), 150);
    assert.equal(r.lines.find((l) => l.code === "TDS")!.amount.toNumber(), 5000);
    assert.ok(r.notes.some((n) => n.includes("Professional tax overridden")));
  });

  test("the new regime is cheaper for someone with no declarations", () => {
    const newRegime = calculatePayroll(baseInput() as never);
    const oldRegime = calculatePayroll(baseInput({
      tax: { enabled: true, regime: "OLD", slabs: oldSlabs, config: oldCfg },
    }) as never);
    assert.ok(newRegime.tds.lessThan(oldRegime.tds));
  });

  test("the old regime wins once declarations and rent are in play", () => {
    // At a 12L CTC the new regime's 87A rebate wipes the liability out
    // entirely, so no amount of declaration can beat it. The old regime only
    // becomes competitive once income clears the rebate band.
    //
    // YTD income matters: the engine projects the year from what has already
    // been drawn plus what is still to come. June is month 3 of the FY, so
    // two months of earnings must be supplied or the projection under-counts.
    const ctc = 1600000;
    const monthlyEarnings = 128968;
    const ytdTaxableIncome = monthlyEarnings * 2; // April and May

    const newRegime = calculatePayroll(baseInput({
      annualCtc: ctc,
      tax: { enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg, ytdTaxableIncome },
    }) as never);

    const withDeclarations = calculatePayroll(baseInput({
      annualCtc: ctc,
      tax: {
        enabled: true, regime: "OLD", slabs: oldSlabs, config: oldCfg,
        ytdTaxableIncome,
        chapterViaDeductions: 150000,
        rentPaidAnnual: 360000,
        isMetro: true,
        housePropertyIncome: -200000,
      },
    }) as never);

    assert.ok(
      withDeclarations.tds.lessThan(newRegime.tds),
      `old ${withDeclarations.tds} should be below new ${newRegime.tds}`,
    );
    assert.ok(withDeclarations.notes.some((n) => n.includes("HRA exemption")));
  });

  test("TDS spreads across the remaining periods of the financial year", () => {
    const ctc = 2400000;
    const monthlyEarnings = 194352;

    // April is month 1 of the FY, so the liability divides by 12.
    const april = calculatePayroll(baseInput({ month: 4, annualCtc: ctc }) as never);

    // March is the last period. With nothing deducted so far, the entire
    // year's liability has to land in this one payslip.
    const march = calculatePayroll(baseInput({
      year: 2027, month: 3, annualCtc: ctc,
      tax: {
        enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg,
        ytdTaxableIncome: monthlyEarnings * 11,
        ytdTdsDeducted: 0,
      },
    }) as never);

    assert.ok(april.tds.greaterThan(0));
    assert.ok(march.tds.greaterThan(april.tds.times(10)));
  });

  test("with YTD tracked correctly, monthly TDS stays level across the year", () => {
    // This is the property that matters in production: an employee on a flat
    // salary should not see their TDS drift month to month.
    const ctc = 2400000;
    const monthlyEarnings = 194352;

    const april = calculatePayroll(baseInput({ month: 4, annualCtc: ctc }) as never);

    // By March, eleven months of income and eleven months of TDS are behind us.
    const march = calculatePayroll(baseInput({
      year: 2027, month: 3, annualCtc: ctc,
      tax: {
        enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg,
        ytdTaxableIncome: monthlyEarnings * 11,
        ytdTdsDeducted: april.tds.times(11),
      },
    }) as never);

    const drift = march.tds.minus(april.tds).abs();
    assert.ok(drift.lessThan(100), `TDS drifted by ${drift} between April and March`);
  });

  test("TDS already deducted reduces what is left to collect", () => {
    const ctc = 2400000;
    const monthlyEarnings = 194352;
    // October is month 7 of the FY, so six months of income precede it.
    const ytdTaxableIncome = monthlyEarnings * 6;

    const fresh = calculatePayroll(baseInput({
      month: 10, annualCtc: ctc,
      tax: { enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg, ytdTaxableIncome },
    }) as never);

    const partlyPaid = calculatePayroll(baseInput({
      month: 10, annualCtc: ctc,
      tax: {
        enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg,
        ytdTaxableIncome, ytdTdsDeducted: 150000,
      },
    }) as never);

    assert.ok(fresh.tds.greaterThan(0));
    assert.ok(partlyPaid.tds.lessThan(fresh.tds));
  });

  test("flat TDS for a contractual employee bypasses the projection", () => {
    const r = calculatePayroll(baseInput({
      tax: {
        enabled: true, regime: "NEW", slabs: newSlabs, config: newCfg,
        flatTdsAmount: 10000,
      },
    }) as never);
    assert.equal(r.tds.toNumber(), 10000);
  });

  test("unit-based pay replaces the structure's earnings", () => {
    const r = calculatePayroll(baseInput({
      annualCtc: 0,
      attendance: { totalDays: 30, payableUnits: 500, unitRate: 40 },
    }) as never);
    const unitLine = r.lines.find((l) => l.code === "UNIT_PAY")!;
    assert.equal(unitLine.amount.toNumber(), 20000);
    assert.equal(r.grossEarnings.toNumber(), 20000);
  });

  test("a negative net pay is surfaced as a warning, not silently clamped", () => {
    const r = calculatePayroll(baseInput({
      annualCtc: 240000,
      variablePay: { loanEmis: [{ name: "Loan Recovery", amount: 50000 }] },
    }) as never);
    assert.ok(r.netPay.isNegative());
    assert.ok(r.warnings.some((w) => w.includes("Net pay is negative")));
  });

  test("disabling PF, ESI, PT and LWF zeroes every statutory line", () => {
    const r = calculatePayroll(baseInput({
      statutory: {
        pfEnabled: false, esiEnabled: false, ptEnabled: false, lwfEnabled: false,
      },
      tax: { enabled: false, regime: "NEW", slabs: newSlabs, config: newCfg },
    }) as never);
    assert.equal(r.pf.employeeContribution.toNumber(), 0);
    assert.equal(r.esi.employeeContribution.toNumber(), 0);
    assert.equal(r.pt.amount.toNumber(), 0);
    assert.equal(r.tds.toNumber(), 0);
    assert.equal(r.totalDeductions.toNumber(), 0);
    assert.equal(r.netPay.toNumber(), r.grossEarnings.toNumber());
  });

  test("the run is deterministic — same inputs, same payslip", () => {
    const a = calculatePayroll(baseInput({ attendance: { totalDays: 30, lopDays: 2.5 } }) as never);
    const b = calculatePayroll(baseInput({ attendance: { totalDays: 30, lopDays: 2.5 } }) as never);
    assert.equal(a.netPay.toNumber(), b.netPay.toNumber());
    assert.equal(a.grossEarnings.toNumber(), b.grossEarnings.toNumber());
    assert.deepEqual(
      a.lines.map((l) => [l.code, l.amount.toNumber()]),
      b.lines.map((l) => [l.code, l.amount.toNumber()]),
    );
  });
});
