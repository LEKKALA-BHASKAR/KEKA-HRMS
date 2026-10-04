import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculatePayroll, calculateGratuity, resolveStructure, type StructureComponentSpec } from "@keka/payroll";
import {
  activeOverrides, applyComponentOverrides, monthBounds, wageTypeOf, unitsFromAttendance, splitDeduction,
  registerLayout, registerColumns, DEFAULT_REGISTER_LAYOUT, employeeVariance, componentVariance, grossReconciliation, runIntegrity,
  journalVoucher, toCsv, statutoryBonus, bonusConfigIssues, gratuityConfigIssues, effectiveWindowOverride, applyWindowOverride,
  parseDeclarationCsv, contractorTds, defaultContractorRate, form26qCsv, quarterRange, quarterOfMonth, resolveLoanPolicy,
  projectPayroll, nextMonths, scenarioCost, minimumWageCheck, coverageExceptions, ptLwfStatus, variancePct, type PeriodLine,
} from "../src/payroll-depth-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const spec = (code: string, o: Partial<StructureComponentSpec> = {}): StructureComponentSpec => ({ code, name: code, type: "EARNING", calculationType: "FORMULA", isLopApplicable: true, ...o });
const STRUCT = [
  spec("BASIC", { formula: "[CTC_MONTHLY] * 0.5", affectsPfWage: true, sequence: 1 }),
  spec("HRA", { formula: "[BASIC] * 0.4", sequence: 2 }),
  spec("SPECIAL", { calculationType: "BALANCE", sequence: 9 }),
];
const statutoryOff = { pfEnabled: false, esiEnabled: false, ptEnabled: false, lwfEnabled: false };
const taxOff = { enabled: false, regime: "NEW" as const, slabs: [], config: { standardDeduction: 0, rebateLimit: 0, rebateMaxAmount: 0, cessPercent: 4 } };

describe("Component overrides", () => {
  const rows = [
    { id: "a", componentId: "c1", monthlyAmount: 1000, effectiveFrom: d("2026-04-01"), effectiveTo: null },
    { id: "b", componentId: "c1", monthlyAmount: 2000, effectiveFrom: d("2026-07-01"), effectiveTo: d("2026-08-31") },
    { id: "c", componentId: "c2", monthlyAmount: 500, effectiveFrom: d("2026-10-01"), effectiveTo: null },
  ];
  test("the latest override started by the period wins, and an ended one drops out", () => {
    assert.equal(activeOverrides(rows, d("2026-05-01"), d("2026-05-31")).get("c1")?.id, "a");
    assert.equal(activeOverrides(rows, d("2026-08-01"), d("2026-08-31")).get("c1")?.id, "b");
    assert.equal(activeOverrides(rows, d("2026-09-01"), d("2026-09-30")).get("c1")?.id, "a");
    assert.equal(activeOverrides(rows, d("2026-09-01"), d("2026-09-30")).has("c2"), false);
  });
  test("an override fixes a structure component and formulas that use it follow", () => {
    const specs = applyComponentOverrides(STRUCT, [{ component: { code: "BASIC", name: "Basic", type: "EARNING", displayOrder: 1, isOutsideCtc: false, isLopApplicable: true, affectsPfWage: true, affectsEsiGross: true, showOnPayslip: true, isPartOfFbp: false }, monthlyAmount: 30000 }]);
    const r = resolveStructure({ annualCtc: 1200000, components: specs });
    assert.equal(r.byCode.get("BASIC")!.monthly.toNumber(), 30000);
    assert.equal(r.byCode.get("HRA")!.monthly.toNumber(), 12000);
    assert.equal(r.byCode.get("SPECIAL")!.monthly.toNumber(), 100000 - 42000);
  });
  test("a component the structure lacks is added at the fixed amount", () => {
    const specs = applyComponentOverrides(STRUCT, [{ component: { code: "CAR", name: "Car allowance", type: "EARNING", displayOrder: 5, isOutsideCtc: true, isLopApplicable: false, affectsPfWage: false, affectsEsiGross: false, showOnPayslip: true, isPartOfFbp: false }, monthlyAmount: 4000 }]);
    assert.equal(specs.length, 4);
    const r = resolveStructure({ annualCtc: 1200000, components: specs });
    assert.equal(r.byCode.get("CAR")!.monthly.toNumber(), 4000);
  });
  test("months parse to their first and last day", () => {
    const b = monthBounds("2027-02")!;
    assert.equal(b.start.toISOString().slice(0, 10), "2027-02-01");
    assert.equal(b.end.toISOString().slice(0, 10), "2027-02-28");
    assert.equal(monthBounds("2027-13"), null);
  });
});

describe("Wages paid by units", () => {
  test("remuneration type comes from the revision, or a daily-wage structure", () => {
    assert.equal(wageTypeOf({ remunerationType: "HOURLY", rate: 200 }), "HOURLY");
    assert.equal(wageTypeOf({ remunerationType: "MONTHLY", rate: 600, structureType: "DAILY_WAGE" }), "DAILY");
    assert.equal(wageTypeOf({ remunerationType: "DAILY", rate: null }), null);
    assert.equal(wageTypeOf({ remunerationType: "MONTHLY", rate: null }), null);
  });
  test("payable days count worked and paid-leave days, never offs or gaps", () => {
    const recs = [
      { status: "PRESENT", payableValue: 1, lopValue: 0, effectiveHours: 8 },
      { status: "HALF_DAY", payableValue: 0.5, lopValue: 0, effectiveHours: 4 },
      { status: "ON_LEAVE", payableValue: 1, lopValue: 0, effectiveHours: 0 },
      { status: "WEEKLY_OFF", payableValue: 1, lopValue: 0, effectiveHours: 0 },
      { status: "NO_ATTENDANCE", payableValue: 1, lopValue: 0, effectiveHours: 0 },
      { status: "PRESENT", payableValue: 1, lopValue: 1, effectiveHours: 3 },
    ];
    assert.equal(unitsFromAttendance("DAILY", recs), 2.5);
    assert.equal(unitsFromAttendance("HOURLY", recs), 15);
    assert.equal(unitsFromAttendance("PIECE_RATE", recs), 0);
  });
  test("a daily wage is rate × days, and a structure splits it so Basic still drives PF", () => {
    const r = calculatePayroll({
      employeeId: "e", year: 2027, month: 3, annualCtc: 120000, structureComponents: STRUCT,
      attendance: { totalDays: 31, lopDays: 5 }, wageBasis: { type: "DAILY", rate: 700, units: 20 },
      statutory: { ...statutoryOff, pfEnabled: true }, tax: taxOff,
    });
    const earnings = r.lines.filter((l) => l.type === "EARNING");
    assert.equal(earnings.reduce((s, l) => s + l.amount.toNumber(), 0), 14000);
    assert.equal(r.lines.find((l) => l.code === "BASIC")!.amount.toNumber(), 7000);
    assert.equal(r.pf.employeeContribution.toNumber(), 840);
    assert.equal(r.payableDays.toNumber(), 20);
  });
  test("without structure earnings, the wage is one line and counts for PF", () => {
    const r = calculatePayroll({
      employeeId: "e", year: 2027, month: 3, annualCtc: 0, structureComponents: [],
      wageBasis: { type: "HOURLY", rate: 250, units: 40 }, statutory: { ...statutoryOff, pfEnabled: true }, tax: taxOff,
    });
    const line = r.lines.find((l) => l.code === "HOURLY_WAGES")!;
    assert.equal(line.amount.toNumber(), 10000);
    assert.equal(r.grossEarnings.toNumber(), 10000);
    assert.equal(r.pf.employeeContribution.toNumber(), 1200);
  });
  test("no units recorded is a warning, not a guess", () => {
    const r = calculatePayroll({ employeeId: "e", year: 2027, month: 3, annualCtc: 0, structureComponents: [], wageBasis: { type: "PIECE_RATE", rate: 12, units: 0 }, statutory: statutoryOff, tax: taxOff });
    assert.equal(r.grossEarnings.toNumber(), 0);
    assert.ok(r.warnings.some((w) => /payable units/.test(w)));
  });
  test("no-attendance days come from leave in half days, the rest as LOP", () => {
    assert.deepEqual(splitDeduction(4, 2.75), { leave: 2.5, lop: 1.5 });
    assert.deepEqual(splitDeduction(3, 10), { leave: 3, lop: 0 });
    assert.deepEqual(splitDeduction(2, -1), { leave: 0, lop: 2 });
  });
});

describe("Pay register layout", () => {
  test("an empty or unknown layout falls back to the default", () => {
    assert.deepEqual(registerLayout(null), DEFAULT_REGISTER_LAYOUT);
    assert.deepEqual(registerLayout(["bogus"]), DEFAULT_REGISTER_LAYOUT);
  });
  test("components cannot be removed, repeats are dropped, order is kept", () => {
    assert.deepEqual(registerLayout(["net", "pan", "net"]), ["net", "pan", "earnings", "deductions"]);
  });
  test("columns lead with the fixed ones and expand components in place", () => {
    const cols = registerColumns(["pan", "earnings", "net", "deductions"], [["BASIC", "Basic"], ["HRA", "HRA"]], [["PT", "Professional Tax"]]);
    assert.deepEqual(cols.map((c) => c.key), ["employeeNumber", "name", "payableDays", "pan", "c:BASIC", "c:HRA", "net", "c:PT"]);
    assert.equal(cols.find((c) => c.key === "pan")!.numeric, false);
  });
});

const line = (id: string, gross: number, comps: Array<[string, string, number]>, net = gross): PeriodLine => ({
  employeeId: id, employeeNumber: id.toUpperCase(), name: id, department: "Eng", gross, deductions: gross - net, net, employerCost: 0,
  components: comps.map(([code, type, amount]) => ({ code, name: code, type, amount })),
});

describe("Variance and reconciliation", () => {
  const prev = [line("a", 50000, [["BASIC", "EARNING", 25000], ["HRA", "EARNING", 25000]]), line("b", 40000, [["BASIC", "EARNING", 40000]])];
  const curr = [line("a", 55000, [["BASIC", "EARNING", 30000], ["HRA", "EARNING", 25000]]), line("c", 30000, [["BASIC", "EARNING", 30000]])];
  test("each employee's change and percentage, with joiners and leavers", () => {
    const v = employeeVariance(prev, curr);
    const a = v.find((x) => x.employeeId === "a")!;
    assert.equal(a.grossChange, 5000);
    assert.equal(a.grossPct, 0.1);
    assert.deepEqual(a.movers.map((m) => m.code), ["BASIC"]);
    assert.equal(v.find((x) => x.employeeId === "b")!.status, "LEFT");
    assert.equal(v.find((x) => x.employeeId === "c")!.status, "JOINED");
    assert.equal(variancePct(0, 10), null);
  });
  test("component totals move with their percentage", () => {
    const c = componentVariance(prev, curr).find((x) => x.code === "BASIC")!;
    assert.equal(c.prev, 65000);
    assert.equal(c.curr, 60000);
    assert.equal(c.change, -5000);
  });
  test("the reconciliation walks last month's gross to this month's with nothing unexplained", () => {
    const r = grossReconciliation(prev, curr);
    assert.equal(r.steps[0].amount, 90000);
    assert.equal(r.steps.at(-1)!.amount, 85000);
    assert.equal(r.difference, 0);
  });
  test("integrity checks flag rows whose lines do not add up", () => {
    const checks = runIntegrity({ gross: 100, deductions: 10, net: 90 }, [
      { employeeNumber: "A", gross: 100, deductions: 10, net: 90, skipped: false, lines: [{ type: "EARNING", amount: 100 }, { type: "DEDUCTION", amount: 10 }] },
      { employeeNumber: "B", gross: 0, deductions: 0, net: 0, skipped: true, lines: [{ type: "EARNING", amount: 5 }] },
    ]);
    assert.ok(checks.slice(0, 3).every((c) => c.amount === 0));
    assert.equal(checks[3].count, 0);
  });
});

describe("Journal voucher", () => {
  const lines = [
    { type: "EARNING", code: "BASIC", amount: 30000 }, { type: "EARNING", code: "HRA", amount: 12000 },
    { type: "DEDUCTION", code: "PF_EMPLOYEE", amount: 1800 }, { type: "DEDUCTION", code: "TDS", amount: 2000 },
    { type: "EMPLOYER_CONTRIBUTION", code: "PF_EMPLOYER", amount: 1800 },
  ];
  test("debits equal credits, split by cost centre", () => {
    const jv = journalVoucher([{ costCenter: "Eng", lines }, { costCenter: "Ops", lines }], []);
    assert.ok(jv.balanced);
    assert.equal(jv.debit, 2 * (42000 + 1800));
    assert.ok(jv.rows.some((r) => r.costCenter === "Ops" && r.accountCode === "2100" && r.credit === 38200));
  });
  test("a mapped component moves to its own account and the voucher still balances", () => {
    const jv = journalVoucher([{ costCenter: "All", lines }], [{ componentCode: "HRA", accountCode: "5105", accountName: "House rent allowance" }]);
    assert.ok(jv.balanced);
    assert.equal(jv.rows.find((r) => r.accountCode === "5105")!.debit, 12000);
    assert.equal(jv.rows.find((r) => r.accountCode === "5100")!.debit, 30000);
  });
  test("CSV escapes and starts with a BOM for spreadsheets", () => {
    const csv = toCsv([["a,b", 'say "hi"']]);
    assert.ok(csv.startsWith("﻿"));
    assert.ok(csv.includes('"a,b","say ""hi"""'));
  });
});

describe("Statutory bonus and gratuity", () => {
  const cfg = { eligibilityCeiling: 21000, calculationCeiling: 7000, minimumWage: null, percent: 8.33, minWorkingDays: 30 };
  test("eligible months count at the ceiling; months above the eligibility limit do not", () => {
    const months = [
      ...Array.from({ length: 6 }, (_, i) => ({ year: 2025, month: 4 + i, wage: 15000, payableDays: 30 })),
      ...Array.from({ length: 6 }, (_, i) => ({ year: 2025, month: 10 + i > 12 ? i - 2 : 10 + i, wage: 25000, payableDays: 30 })),
    ];
    const r = statutoryBonus(months, cfg);
    assert.equal(r.eligibleMonths, 6);
    assert.equal(r.bonusWage, 42000);
    assert.equal(r.bonus, Math.round(42000 * 0.0833));
    assert.equal(r.maxBonus, 8400);
  });
  test("the minimum wage replaces the ceiling when higher, and the day minimum applies", () => {
    const r = statutoryBonus([{ year: 2025, month: 4, wage: 12000, payableDays: 31 }], { ...cfg, minimumWage: 10000 });
    assert.equal(r.bonusWage, 10000);
    const short = statutoryBonus([{ year: 2025, month: 4, wage: 12000, payableDays: 20 }], cfg);
    assert.equal(short.eligible, false);
    assert.match(short.reason!, /under the 30-day minimum/);
  });
  test("settings outside the Act are refused", () => {
    assert.ok(bonusConfigIssues({ ...cfg, percent: 25 }).length > 0);
    assert.equal(bonusConfigIssues(cfg).length, 0);
    assert.ok(gratuityConfigIssues({ eligibilityYears: 5, daysPerYear: 10, divisor: 26, cap: 2000000 }).length > 0);
    assert.equal(gratuityConfigIssues({ eligibilityYears: 4.8, daysPerYear: 15, divisor: 26, cap: 2000000 }).length, 0);
  });
  test("gratuity settings change eligibility, days, and cap the payout", () => {
    const base = { lastDrawnBasicDa: 52000, dateOfJoining: d("2021-01-01"), lastWorkingDay: d("2025-11-15"), actCovered: true };
    assert.equal(calculateGratuity(base).eligible, false);
    const early = calculateGratuity({ ...base, minServiceYears: 4.8 });
    assert.equal(early.eligible, true);
    assert.equal(early.grossGratuity.toNumber(), 150000);
    const capped = calculateGratuity({ ...base, minServiceYears: 4.8, daysPerYear: 30, payoutCap: 200000 });
    assert.equal(capped.grossGratuity.toNumber(), 200000);
  });
});

describe("Tax windows and imports", () => {
  const now = d("2026-10-04");
  const rows = [
    { employeeId: null, state: "LOCKED" as const, until: null, createdAt: d("2026-09-01") },
    { employeeId: "e1", state: "OPEN" as const, until: d("2026-10-31"), createdAt: d("2026-09-10") },
    { employeeId: "e2", state: "OPEN" as const, until: d("2026-10-01"), createdAt: d("2026-09-10") },
  ];
  test("an employee's own override wins over everyone's, and an expired reopening lapses", () => {
    assert.equal(effectiveWindowOverride(rows, "e1", now)?.state, "OPEN");
    assert.equal(effectiveWindowOverride(rows, "e2", now)?.state, "LOCKED");
    assert.equal(effectiveWindowOverride(rows, "e3", now)?.state, "LOCKED");
    assert.equal(effectiveWindowOverride([], "e3", now), null);
  });
  test("applying an override opens or closes the window with a note", () => {
    const closed = { open: false, till: null, note: "lapsed" };
    const opened = applyWindowOverride(closed, rows[1], "investment declarations");
    assert.equal(opened.open, true);
    assert.match(opened.note, /reopened investment declarations until 31 Oct 2026/);
    assert.equal(applyWindowOverride({ open: true, till: now, note: "x" }, rows[0], "proof submission").open, false);
  });
  test("the declaration CSV is read by header, with line-level errors", () => {
    const csv = "Employee Number,Section,Category,Amount\nE001,80C,PPF,\"1,50,000\"\nE002,80Z,Bogus,100\nE003,80D,,25000\n,80C,X,1\n";
    const r = parseDeclarationCsv(csv, new Set(["80C", "80D"]));
    assert.deepEqual(r.rows.map((x) => [x.employeeNumber, x.section, x.category, x.amount]), [["E001", "80C", "PPF", 150000], ["E003", "80D", "80D", 25000]]);
    assert.equal(r.errors.length, 2);
    assert.match(parseDeclarationCsv("Name,Amount\nx,1", new Set()).errors[0], /Missing column/);
  });
});

describe("Contractor TDS", () => {
  test("section rates, and 20% without a PAN", () => {
    assert.equal(defaultContractorRate("194C", "INDIVIDUAL"), 1);
    assert.equal(defaultContractorRate("194C", "OTHER"), 2);
    assert.deepEqual(contractorTds(100000, 10, true), { rate: 10, tds: 10000, note: null });
    assert.equal(contractorTds(100000, 1, false).tds, 20000);
  });
  test("quarters of the financial year", () => {
    assert.equal(quarterOfMonth(5), 1);
    assert.equal(quarterOfMonth(2), 4);
    const q4 = quarterRange(2026, 4);
    assert.equal(q4.start.toISOString().slice(0, 10), "2027-01-01");
    assert.equal(q4.end.toISOString().slice(0, 10), "2027-03-31");
  });
  test("the 26Q CSV totals by section and lists what is missing", () => {
    const r = form26qCsv({ deductor: "Acme", tan: null, fy: 2026, quarter: 2 }, [
      { contractor: "A", pan: "ABCDE1234F", section: "194C", paymentDate: d("2026-07-10"), amount: 50000, tdsRate: 1, tds: 500, bsrCode: "1234567", challanNumber: "00011", depositDate: d("2026-08-07") },
      { contractor: "B", pan: null, section: "194J", paymentDate: d("2026-08-10"), amount: 40000, tdsRate: 20, tds: 8000, bsrCode: null, challanNumber: null, depositDate: null },
    ]);
    assert.equal(r.tds, 8500);
    assert.ok(r.csv.includes("PANNOTAVBL"));
    assert.ok(r.issues.some((i) => /TAN/.test(i)) && r.issues.some((i) => /B: no PAN/.test(i)) && r.issues.some((i) => /challan/.test(i)));
  });
});

describe("Loan policy assignment", () => {
  const asg = [
    { policyId: "senior", employeeId: "e1", payGroupId: null },
    { policyId: "factory", employeeId: null, payGroupId: "pg2" },
  ];
  test("employee, then pay group, then the unassigned default", () => {
    assert.equal(resolveLoanPolicy({ id: "e1", payGroupId: "pg2" }, asg, ["base", "senior", "factory"]), "senior");
    assert.equal(resolveLoanPolicy({ id: "e2", payGroupId: "pg2" }, asg, ["base", "senior", "factory"]), "factory");
    assert.equal(resolveLoanPolicy({ id: "e3", payGroupId: "pg1" }, asg, ["base", "senior", "factory"]), "base");
    assert.equal(resolveLoanPolicy({ id: "e3", payGroupId: "pg1" }, asg, ["senior", "factory"]), null);
    assert.equal(resolveLoanPolicy({ id: "e1", payGroupId: "pg2" }, asg, ["base", "factory"]), "factory");
  });
});

describe("Budget", () => {
  test("projection switches to an approved revision and drops leavers", () => {
    const months = nextMonths(d("2026-10-15"), 3);
    assert.deepEqual(months, [{ year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 1 }]);
    const p = projectPayroll([
      { employeeId: "a", department: "Eng", annualCtc: 1200000, lastWorkingDay: null, upcoming: [{ effectiveFrom: d("2026-12-01"), annualCtc: 1320000 }] },
      { employeeId: "b", department: "Eng", annualCtc: 600000, lastWorkingDay: d("2026-11-30"), upcoming: [] },
    ], months);
    assert.deepEqual(p.map((m) => m.cost), [150000, 110000, 110000]);
    assert.deepEqual(p.map((m) => m.headcount), [2, 1, 1]);
    assert.equal(p[1].revisionImpact, 10000);
  });
  test("scenarios price department increments and the in-year cost", () => {
    const r = scenarioCost([
      { departmentId: "eng", department: "Eng", annualCtc: 1000000 }, { departmentId: "eng", department: "Eng", annualCtc: 500000 },
      { departmentId: "ops", department: "Ops", annualCtc: 400000 },
    ], { defaultPercent: 5, departmentPercents: { eng: 10 }, effectiveYear: 2026, effectiveMonth: 10 });
    assert.equal(r.monthsInYear, 6);
    assert.equal(r.rows.find((x) => x.departmentId === "eng")!.increase, 150000);
    assert.equal(r.rows.find((x) => x.departmentId === "ops")!.percent, 5);
    assert.equal(r.totals.inYearCost, (150000 + 20000) / 2);
  });
});

describe("Compliance checks", () => {
  test("minimum wage", () => {
    assert.deepEqual(minimumWageCheck(12000, 13000), { status: "BELOW", shortfall: 1000 });
    assert.equal(minimumWageCheck(13000, 13000).status, "OK");
    assert.equal(minimumWageCheck(5000, null).status, "NO_RATE");
  });
  test("PF and ESI coverage exceptions", () => {
    const base = { pfEnabled: true, esiEnabled: true, uan: "1001", esicNumber: "E1", pfWage: 12000, pfEmployee: 1440, esiGross: 18000, esiEmployee: 135, grossFullMonth: 18000, pfWageCeiling: 15000, esiWageLimit: 21000, payGroupPf: true, payGroupEsi: true };
    assert.deepEqual(coverageExceptions(base), []);
    assert.ok(coverageExceptions({ ...base, pfEnabled: false, pfEmployee: 0 }).some((x) => /membership is mandatory/.test(x)));
    assert.ok(coverageExceptions({ ...base, uan: null }).some((x) => /no UAN/.test(x)));
    assert.ok(coverageExceptions({ ...base, esiEnabled: false, esiEmployee: 0 }).some((x) => /ESI off/.test(x)));
  });
  test("PT and LWF applicability", () => {
    const s = ptLwfStatus({ stateCode: "KA", ptStates: new Set(["KA"]), lwfStates: new Set(["KA"]), ptRegistered: false, lwfRegistered: true, ptDeducted: 0, lwfDeducted: 0, ptEnabled: true, lwfEnabled: true });
    assert.ok(s.issues.some((x) => /not linked to a PT registration/.test(x)));
    const none = ptLwfStatus({ stateCode: "DL", ptStates: new Set(["KA"]), lwfStates: new Set(["DL"]), ptRegistered: false, lwfRegistered: true, ptDeducted: 200, lwfDeducted: 0.75, ptEnabled: true, lwfEnabled: true });
    assert.equal(none.pt, "Not applicable");
    assert.ok(none.issues.some((x) => /state without PT/.test(x)));
  });
});
