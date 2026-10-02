import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fyMonths, esiHalfMonths, mergeMonths, buildForm3A, buildForm6A, buildEsiHalfYearly, buildPtReturn, buildLwfReturn, returnToCsv,
  type ContributionRow,
} from "../src/statutory-returns-math";
import {
  validateSettlementMonth, settlementMonthOptions, parsePeriod, voidBlocker, voidPlan, adjustmentsNet, adjustmentStatus,
  validateAdjustment, fnfReportTotals,
} from "../src/fnf-math";

const row = (o: Partial<ContributionRow> & { employeeId: string; month: number; year?: number }): ContributionRow => ({
  year: 2026, employeeNumber: o.employeeId.toUpperCase(), name: `Person ${o.employeeId}`, uan: `1000${o.employeeId}`, esicNumber: null,
  grossWages: 30000, pfWage: 15000, pfEmployee: 1800, vpf: 0, pfEmployer: 550, epsEmployer: 1250, ncpDays: 0, payableDays: 30,
  esiGross: 0, esiEmployee: 0, esiEmployer: 0, professionalTax: 200, lwfEmployee: 0, lwfEmployer: 0,
  ptRegistrationId: "ka", lwfRegistrationId: "ka-lwf", lastWorkingDay: null, ...o,
});

describe("Statutory periods", () => {
  test("a financial year runs April to March", () => {
    const m = fyMonths(2026);
    assert.equal(m.length, 12);
    assert.deepEqual(m[0], { year: 2026, month: 4 });
    assert.deepEqual(m[11], { year: 2027, month: 3 });
  });
  test("ESI contribution periods are April–September and October–March", () => {
    assert.deepEqual(esiHalfMonths(2026, 1).map((m) => m.month), [4, 5, 6, 7, 8, 9]);
    assert.deepEqual(esiHalfMonths(2026, 2), [{ year: 2026, month: 10 }, { year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 1 }, { year: 2027, month: 2 }, { year: 2027, month: 3 }]);
  });
  test("a regular and an off-cycle run in one month add up to one row", () => {
    const merged = mergeMonths([row({ employeeId: "a", month: 5 }), row({ employeeId: "a", month: 5, grossWages: 5000, pfWage: 0, pfEmployee: 0, pfEmployer: 0, epsEmployer: 0, professionalTax: 0, payableDays: 0 })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].grossWages, 35000);
    assert.equal(merged[0].pfEmployee, 1800);
  });
});

describe("PF Form 3A and 6A", () => {
  const rows = [
    row({ employeeId: "a", month: 4 }), row({ employeeId: "a", month: 5, vpf: 500, ncpDays: 2 }),
    row({ employeeId: "b", month: 4, uan: null }), row({ employeeId: "c", month: 4, pfWage: 0, pfEmployee: 0, pfEmployer: 0, epsEmployer: 0 }),
  ];
  test("3A: one card per PF member, twelve months each, worker share includes VPF", () => {
    const r = buildForm3A({ fy: 2026, rows, establishment: { name: "Acme", code: "KABLR0001" } });
    assert.equal(r.sections.length, 2, "the member without PF has no card");
    const a = r.sections[0];
    assert.equal(a.rows.length, 12);
    assert.equal(a.rows[1][2], 2300, "May worker share = 1800 EPF + 500 VPF");
    assert.equal(a.rows[1][6], 2, "NCP days carried");
    assert.equal(a.rows[2][7], "No contribution");
    assert.deepEqual(a.totals!.slice(1, 5), [30000, 4100, 1100, 2500]);
    assert.ok(r.issues.some((i) => i.includes("no UAN")));
  });
  test("6A: member totals and the month-wise remittance agree", () => {
    const r = buildForm6A({ fy: 2026, rows, establishment: { name: "Acme", code: null } });
    const [members, monthly] = r.sections;
    assert.equal(members.rows.length, 2);
    assert.equal(members.rows[0][8], 500, "VPF shown separately");
    const memberTotal = Number(members.totals![4]) + Number(members.totals![5]) + Number(members.totals![6]);
    assert.equal(memberTotal, monthly.totals![6]);
    assert.equal(monthly.rows[0][1], 2, "two PF members in April");
  });
});

describe("ESI half-yearly", () => {
  test("only months in the period and only covered employees; average daily wage over days paid", () => {
    const rows = [
      row({ employeeId: "a", month: 4, esiGross: 18000, esiEmployee: 135, esiEmployer: 585, payableDays: 30, esicNumber: "31000" }),
      row({ employeeId: "a", month: 5, esiGross: 18000, esiEmployee: 135, esiEmployer: 585, payableDays: 30, esicNumber: "31000" }),
      row({ employeeId: "a", month: 10, esiGross: 18000, esiEmployee: 135, esiEmployer: 585 }),
      row({ employeeId: "b", month: 4, esiGross: 12000, esiEmployee: 90, esiEmployer: 390, payableDays: 20 }),
    ];
    const r = buildEsiHalfYearly({ fy: 2026, half: 1, rows, employer: { name: "Acme", code: null } });
    const ips = r.sections[0];
    assert.equal(ips.rows.length, 2);
    const a = ips.rows.find((x) => x[0] === "31000")!;
    assert.equal(a[8], 60, "total days");
    assert.equal(a[9], 36000, "October is in the other half");
    assert.equal(a[13], 600, "average daily wage");
    assert.equal(ips.totals![12], 1920);
    assert.ok(r.issues.some((i) => i.includes("no ESI IP number")));
  });
});

describe("Professional Tax and LWF", () => {
  const regs = [{ id: "ka", stateCode: "KA", stateName: "Karnataka", establishmentId: "PT-KA-1" }, { id: "mh", stateCode: "MH", stateName: "Maharashtra", establishmentId: null }];
  const rows = [
    row({ employeeId: "a", month: 6, professionalTax: 200 }), row({ employeeId: "b", month: 6, professionalTax: 0, grossWages: 12000 }),
    row({ employeeId: "c", month: 6, professionalTax: 300, ptRegistrationId: "mh", lwfRegistrationId: "mh-lwf", lwfEmployee: 12, lwfEmployer: 36 }),
    row({ employeeId: "d", month: 6, professionalTax: 200, ptRegistrationId: null }),
    row({ employeeId: "a", month: 7, professionalTax: 200 }),
  ];
  test("monthly: slab-wise per registration, and an unmapped deduction is flagged", () => {
    const r = buildPtReturn({ fy: 2026, month: { year: 2026, month: 6 }, rows, registrations: regs });
    const ka = r.sections.find((s) => s.heading.startsWith("Karnataka —") && s.heading.includes("Jun"))!;
    assert.deepEqual(ka.rows.map((x) => x[1]), [1, 1], "one nil, one ₹200");
    assert.equal(ka.totals![3], 200);
    assert.ok(r.issues.some((i) => i.includes("D")), "employee d has PT but no registration");
  });
  test("annual: month-wise per registration", () => {
    const r = buildPtReturn({ fy: 2026, rows, registrations: regs });
    const ka = r.sections[0];
    assert.equal(ka.rows.length, 12);
    assert.equal(ka.totals![4], 400);
  });
  test("LWF: a section per state and contribution month, nil states said so", () => {
    const r = buildLwfReturn({ fy: 2026, rows, registrations: [{ id: "ka-lwf", stateCode: "KA", stateName: "Karnataka", establishmentId: null }, { id: "mh-lwf", stateCode: "MH", stateName: "Maharashtra", establishmentId: "L-1" }] });
    assert.ok(r.sections[0].heading.includes("no contribution"));
    assert.equal(r.sections[1].rows.length, 1);
    assert.equal(r.sections[1].totals![5], 48);
  });
  test("CSV carries the portal warning, escapes text and defuses formulas", () => {
    const csv = returnToCsv(buildPtReturn({ fy: 2026, month: { year: 2026, month: 6 }, rows: [row({ employeeId: "a", month: 6, name: "=HYPERLINK(\"x\")" })], registrations: regs }));
    assert.ok(csv.startsWith("﻿"));
    assert.ok(csv.includes("Check every figure against the current portal format"));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(!csv.includes("₹"));
  });
});

describe("Full and final: settlement month", () => {
  const lwd = new Date(Date.UTC(2026, 7, 20));
  test("not before the last working day's month, not beyond the window", () => {
    assert.equal(validateSettlementMonth(lwd, 2026, 8), null);
    assert.equal(validateSettlementMonth(lwd, 2026, 10), null);
    assert.match(validateSettlementMonth(lwd, 2026, 7)!, /before the last working day/);
    assert.match(validateSettlementMonth(lwd, 2027, 3)!, /within 6 months/);
    assert.ok(validateSettlementMonth(lwd, 2026, 13));
  });
  test("options start at the last working day's month and cross the year", () => {
    const o = settlementMonthOptions(new Date(Date.UTC(2026, 10, 30)));
    assert.equal(o[0].value, "2026-11");
    assert.equal(o[2].value, "2027-01");
    assert.equal(o.length, 7);
    assert.deepEqual(parsePeriod("2027-01"), { year: 2027, month: 1 });
    assert.equal(parsePeriod("2027-13"), null);
  });
});

describe("Full and final: void", () => {
  test("only a finalised settlement, with a reason, and none of its adjustments paid", () => {
    assert.equal(voidBlocker({ status: "FINALIZED", reason: "Wrong gratuity basis", processedAdjustments: 0 }), null);
    assert.match(voidBlocker({ status: "IN_REVIEW", reason: "Wrong gratuity basis", processedAdjustments: 0 })!, /Only a finalised/);
    assert.match(voidBlocker({ status: "VOIDED", reason: "Wrong gratuity basis", processedAdjustments: 0 })!, /already voided/);
    assert.match(voidBlocker({ status: "FINALIZED", reason: " ", processedAdjustments: 0 })!, /why/);
    assert.match(voidBlocker({ status: "PAID", reason: "Wrong gratuity basis", processedAdjustments: 1 })!, /Roll that payroll back/);
  });
  test("the plan restores what was recorded, never back to exited", () => {
    const p = voidPlan({ installments: [{ id: "i1", interestPart: 120, totalAmount: 2120 }], loans: [{ id: "l1", status: "ACTIVE" }], assetAssignmentIds: ["a1"], bonusIds: [], claimIds: ["c1"], employeeStatus: "NOTICE_PERIOD", exitStatus: "IN_CLEARANCE" });
    assert.equal(p.partial, false);
    assert.equal(p.installments[0].interestPart, 120);
    assert.equal(p.employeeStatus, "NOTICE_PERIOD");
    assert.equal(voidPlan({ installments: [], loans: [], assetAssignmentIds: [], bonusIds: [], claimIds: [], employeeStatus: "EXITED", exitStatus: "SETTLED" }).employeeStatus, "NOTICE_PERIOD");
    const legacy = voidPlan(null);
    assert.equal(legacy.partial, true);
    assert.equal(legacy.installments.length, 0);
    assert.equal(legacy.exitStatus, "IN_CLEARANCE");
  });
});

describe("Full and final: adjustments and report", () => {
  test("adjustments net payments against recoveries", () => {
    const list = [{ type: "PAYMENT" as const, amount: 5000, isProcessed: true }, { type: "DEDUCTION" as const, amount: 1200.5, isProcessed: false }];
    assert.equal(adjustmentsNet(list), 3799.5);
    assert.equal(adjustmentsNet(list, { processedOnly: true }), 5000);
  });
  test("an adjustment says where it stands", () => {
    assert.match(adjustmentStatus({ isProcessed: true, run: { type: "OFF_CYCLE", status: "FINALIZED", year: 2026, month: 9 }, year: 2026, month: 9 }), /Paid in the off-cycle payroll for September 2026/);
    assert.match(adjustmentStatus({ isProcessed: false, run: null, year: 2026, month: 10 }), /Pending/);
  });
  test("adjustment validation", () => {
    assert.equal(validateAdjustment({ name: "Late travel claim", amount: 1500, type: "PAYMENT" }), null);
    assert.ok(validateAdjustment({ name: "", amount: 1500, type: "PAYMENT" }));
    assert.ok(validateAdjustment({ name: "x", amount: 0, type: "PAYMENT" }));
    assert.ok(validateAdjustment({ name: "x", amount: 10, type: "BONUS" }));
  });
  test("report totals leave voided settlements out of the money but count them", () => {
    const t = fnfReportTotals([
      { status: "FINALIZED", totalPayable: 100000, totalRecovery: 20000, net: 80000, adjustmentsNet: 5000 },
      { status: "IN_REVIEW", totalPayable: 30000, totalRecovery: 40000, net: -10000, adjustmentsNet: 0 },
      { status: "VOIDED", totalPayable: 99999, totalRecovery: 0, net: 99999, adjustmentsNet: 0 },
    ]);
    assert.equal(t.count, 3);
    assert.equal(t.net, 70000);
    assert.equal(t.payable, 130000);
    assert.equal(t.adjustments, 5000);
    assert.deepEqual(t.byStatus.VOIDED, { count: 1, net: 0 });
  });
});

describe("Rendering", () => {
  test("a long return breaks across landscape pages and the statement renders", async () => {
    const { renderTableReport, renderFnfStatement } = await import("@keka/documents");
    const rows = Array.from({ length: 120 }, (_, i) => row({ employeeId: `e${String(i).padStart(3, "0")}`, month: 4 }));
    const r = buildForm6A({ fy: 2026, rows, establishment: { name: "Acme", code: "X" } });
    const pdf = renderTableReport({ title: r.title, subtitle: r.subtitle, company: "Acme", banner: "Check the portal format", sections: r.sections, notes: r.notes, issues: r.issues });
    const text = pdf.toString("latin1");
    assert.ok(text.startsWith("%PDF-"));
    assert.ok((text.match(/\/Type \/Page /g) ?? []).length >= 3, "120 members need several pages");
    assert.ok(text.includes("/MediaBox [0 0 841.89 595.28]"), "landscape");
    const st = renderFnfStatement({
      company: { name: "Acme" }, status: "FINALISED", settlementPeriod: "September 2026", generatedOn: "02/10/2026",
      employee: { name: "A Person", number: "ACM1", lastWorkingDay: "31/08/2026", exitType: "resignation" },
      payable: [{ group: "Leave", label: "Earned leave encashment", amount: 12000, basis: "10 day(s)" }], recovered: [],
      totalPayable: 12000, totalRecovery: 0, net: 12000, adjustments: [{ label: "Late claim", amount: 500, direction: "PAY", status: "pending" }],
    }).toString("latin1");
    assert.ok(st.startsWith("%PDF-") && st.includes("Twelve Thousand Rupees Only"));
  });
});
