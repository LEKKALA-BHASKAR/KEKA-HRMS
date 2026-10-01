import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  plannedHours, workdays, estRevenue, estCost, marginPct, markupPct, recognisedRevenue, estimateLine, estimateTotals, funnel,
  checkOpportunityDates, peakLoad, isCritical, hourlyCost, utilisationBreakdown, invoiceStatusLabel, psaPctChange, parseCsv, csvCell,
  parseLooseDate, retainerPeriods, capacityOf, DEFAULT_CAPACITY, wholeYearsBetween,
} from "../src/psa-math";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("Capacity and planned hours", () => {
  test("Mon–Fri 8h, with holidays skipped and an allocation share", () => {
    // 28 Sep 2026 (Mon) to 4 Oct 2026 (Sun): five working days.
    assert.equal(plannedHours(DEFAULT_CAPACITY, d("2026-09-28"), d("2026-10-04")), 40);
    assert.equal(plannedHours(DEFAULT_CAPACITY, d("2026-09-28"), d("2026-10-04"), 50), 20);
    assert.equal(plannedHours(DEFAULT_CAPACITY, d("2026-09-28"), d("2026-10-04"), 100, new Set(["2026-10-02"])), 32);
    assert.equal(plannedHours(DEFAULT_CAPACITY, d("2026-09-28"), null), 0, "open-ended plans nothing");
    assert.equal(plannedHours([0, 4, 4, 4, 4, 4, 0], d("2026-09-28"), d("2026-10-04")), 20, "a part-timer");
    assert.equal(workdays(d("2026-09-01"), d("2026-09-30")), 22);
  });
  test("a stored capacity must be seven sane numbers", () => {
    assert.deepEqual(capacityOf([0, 8, 8, 8, 8, 8, 0]), [0, 8, 8, 8, 8, 8, 0]);
    assert.deepEqual(capacityOf("nonsense"), DEFAULT_CAPACITY);
    assert.deepEqual(capacityOf([0, 30, 8, 8, 8, 8, 0]), DEFAULT_CAPACITY);
  });
});

describe("Project financials", () => {
  const tm = { billingModel: "TIME_AND_MATERIAL" as const, startDate: d("2026-09-28"), endDate: d("2026-10-04"), budget: null, retainerFee: null };
  const alloc = { startDate: d("2026-09-28"), endDate: null, allocationPercent: 50, billRate: 2000, costRate: 800, isBillable: true };
  test("T&M estimated revenue and cost are planned hours × rates over the project", () => {
    assert.equal(estRevenue(tm, [alloc], []), 40000); // 20 h × 2,000
    assert.equal(estCost(tm, [alloc], 1000), 17000); // 20 h × 800 + 1,000 expenses
    assert.equal(estRevenue(tm, [{ ...alloc, kind: "SOFT" }], []), 0, "a soft allocation is not yet revenue");
  });
  test("a budget wins; fixed fee sums milestones; retainers count periods", () => {
    assert.equal(estRevenue({ ...tm, budget: 650000 }, [alloc], []), 650000);
    assert.equal(estRevenue({ ...tm, billingModel: "MILESTONE" }, [], [400000, 900000]), 1300000);
    assert.equal(estRevenue({ ...tm, billingModel: "RETAINER", retainerFee: 450000, startDate: d("2026-04-01"), endDate: d("2027-03-31") }, [], []), 5400000);
    assert.equal(estRevenue({ ...tm, billingModel: "NON_BILLABLE" }, [alloc], []), 0);
    assert.equal(retainerPeriods(d("2026-01-01"), d("2026-01-31"), "WEEKLY"), 5);
  });
  test("margin as Keka shows it: (revenue − cost) / revenue", () => {
    assert.equal(marginPct(30_400_000, 136_200), 99.55);
    assert.equal(marginPct(650_000, 1_800_000), -176.92);
    assert.equal(marginPct(0, 100), null);
  });
  test("rate card markup is over cost", () => {
    assert.equal(markupPct(5000, 6000), -16.67);
    assert.equal(markupPct(12000, 5000), 140);
    assert.equal(markupPct(100, 80), 25);
    assert.equal(markupPct(1000, null), null);
  });
  test("recognised revenue follows the method and never passes the estimate", () => {
    const base = { estRevenue: 100000, estCost: 40000, incomeToDate: 30000, invoiced: 50000, costToDate: 10000, loggedHours: 60, estimatedHours: 100 };
    assert.equal(recognisedRevenue("INCOME_TO_DATE", base), 30000);
    assert.equal(recognisedRevenue("INVOICED_AMOUNT", base), 50000);
    assert.equal(recognisedRevenue("COST_TO_COST", base), 25000);
    assert.equal(recognisedRevenue("TIME_EXPENDED", base), 60000);
    assert.equal(recognisedRevenue("TIME_EXPENDED", { ...base, loggedHours: 150 }), 100000);
  });
});

describe("Estimates", () => {
  test("a role line's hours come from its dates, headcount and share", () => {
    const l = estimateLine({ kind: "ROLE", startDate: d("2026-09-28"), endDate: d("2026-10-09"), headcount: 2, allocationPercent: 50, hours: 0, billRate: 3000, costRate: 1000, amount: 0 });
    assert.deepEqual(l, { hours: 80, amount: 240000, cost: 80000 }); // 10 days × 8 × 50% × 2
  });
  test("tasks carry hours, milestones an amount, phases nothing; totals and span", () => {
    const t = estimateTotals([
      { kind: "PHASE", startDate: d("2026-10-01"), endDate: d("2026-12-31"), headcount: 1, allocationPercent: 100, hours: 0, billRate: 0, costRate: 0, amount: 0 },
      { kind: "TASK", startDate: d("2026-10-05"), endDate: d("2026-10-20"), headcount: 1, allocationPercent: 100, hours: 40, billRate: 2500, costRate: 900, amount: 0 },
      { kind: "MILESTONE", startDate: null, endDate: d("2026-11-15"), headcount: 1, allocationPercent: 100, hours: 0, billRate: 0, costRate: 0, amount: 50000 },
    ]);
    assert.equal(t.hours, 40); assert.equal(t.billing, 150000); assert.equal(t.cost, 36000); assert.equal(t.margin, 76);
    assert.equal(t.start?.toISOString().slice(0, 10), "2026-10-01"); assert.equal(t.end?.toISOString().slice(0, 10), "2026-12-31");
  });
});

describe("Pipeline", () => {
  const stages = [
    { id: "w", name: "Closed Won", color: "#8bc34a", kind: "WON" as const, sequence: 5, winProbability: 100 },
    { id: "p", name: "Prospecting", color: "#3b82f6", kind: "OPEN" as const, sequence: 1, winProbability: 10 },
    { id: "l", name: "Closed Lost", color: "#ef5350", kind: "LOST" as const, sequence: 6, winProbability: 0 },
  ];
  const opps = [{ stageId: "p", estimatedRevenue: 100000, fxRate: 1 }, { stageId: "p", estimatedRevenue: 1000, fxRate: 83 }, { stageId: "w", estimatedRevenue: 50000, fxRate: 1 }];
  test("the funnel is in stage order, in base currency, weighted by win probability", () => {
    const f = funnel(stages, opps);
    assert.deepEqual(f.map((s) => s.name), ["Prospecting", "Closed Won"]);
    assert.equal(f[0].amount, 183000); assert.equal(f[0].weighted, 18300); assert.equal(f[0].count, 2);
    assert.equal(funnel(stages, opps, "COUNT")[0].value, 2);
    assert.equal(funnel(stages, opps, "AMOUNT", true).length, 3);
  });
  test("Keka's import rule: expected project start cannot precede the opportunity start", () => {
    assert.deepEqual(checkOpportunityDates({ startDate: d("2026-10-01"), closeDate: d("2026-10-31"), expectedProjectStart: d("2026-11-01"), expectedProjectEnd: d("2027-01-31") }), []);
    assert.ok(checkOpportunityDates({ startDate: d("2026-10-01"), closeDate: d("2026-10-31"), expectedProjectStart: d("2026-09-01"), expectedProjectEnd: null })[0].includes("cannot be smaller"));
    assert.equal(checkOpportunityDates({ startDate: d("2026-10-01"), closeDate: d("2026-09-01"), expectedProjectStart: d("2026-10-01"), expectedProjectEnd: null }).length, 1);
  });
});

describe("Resourcing", () => {
  test("peak load counts hard allocations on working days only", () => {
    const allocs = [
      { startDate: d("2026-10-01"), endDate: d("2026-10-31"), allocationPercent: 60, kind: "HARD" },
      { startDate: d("2026-10-15"), endDate: null, allocationPercent: 50, kind: "HARD" },
      { startDate: d("2026-10-01"), endDate: null, allocationPercent: 100, kind: "SOFT" },
    ];
    assert.equal(peakLoad(allocs, d("2026-10-01"), d("2026-10-14")), 60);
    assert.equal(peakLoad(allocs, d("2026-10-01"), d("2026-10-31")), 110);
    assert.equal(peakLoad(allocs, d("2026-11-01"), d("2026-11-30")), 50);
  });
  test("critical means open and wanted within the window", () => {
    assert.equal(isCritical({ status: "OPEN", startDate: d("2026-10-08") }, d("2026-10-01")), true);
    assert.equal(isCritical({ status: "OPEN", startDate: d("2026-10-20") }, d("2026-10-01")), false);
    assert.equal(isCritical({ status: "ALLOCATED", startDate: d("2026-10-02") }, d("2026-10-01")), false);
  });
  test("hourly cost from what is stored", () => {
    assert.equal(hourlyCost("HOURLY", 1800), 1800);
    assert.equal(hourlyCost("MONTHLY", 208000), 1200); // 2,496,000 / 2,080 h
    assert.equal(hourlyCost("ANNUAL", 2080000), 1000);
    assert.equal(hourlyCost(null, 1000), null);
    assert.equal(wholeYearsBetween(d("2017-03-20"), d("2026-10-01")), 9);
  });
  test("utilisation is billable over available hours; the rest is not logged", () => {
    const u = utilisationBreakdown({ capacity: 160, planned: 120, billable: 96, nonBillable: 24, leave: 16 });
    assert.equal(u.pct, 66.67); assert.equal(u.notLogged, 24);
  });
});

describe("Invoices and import", () => {
  const today = d("2026-10-01");
  test("status lines read the way Keka writes them", () => {
    assert.equal(invoiceStatusLabel({ status: "OVERDUE", dueDate: d("2026-08-05"), amountDue: 10 }, today).text, "Overdue 57 days");
    assert.equal(invoiceStatusLabel({ status: "SENT", dueDate: d("2026-10-17"), amountDue: 10 }, today).text, "Due in 16 days");
    assert.equal(invoiceStatusLabel({ status: "PARTIALLY_PAID", dueDate: d("2026-10-17"), amountDue: 10 }, today).text, "Partially Paid");
    assert.equal(invoiceStatusLabel({ status: "WRITTEN_OFF", dueDate: d("2026-08-05"), amountDue: 0 }, today).text, "Paid (Write Off)");
    assert.equal(invoiceStatusLabel({ status: "SENT", dueDate: d("2026-08-05"), amountDue: 0, kind: "PROFORMA" }, today).text, "Sent");
  });
  test("week-over-week change", () => {
    assert.equal(psaPctChange(40, 62.24), 55.6);
    assert.equal(psaPctChange(0, 5), null);
  });
  test("CSV with quotes, commas, BOM and CRLF", () => {
    const rows = parseCsv('﻿Name,Client\r\n"Acme, Inc",Northwind\r\n\r\n"say ""hi""",x\n');
    assert.deepEqual(rows, [["Name", "Client"], ["Acme, Inc", "Northwind"], ['say "hi"', "x"]]);
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(parseLooseDate("14/08/2025")?.toISOString().slice(0, 10), "2025-08-14");
    assert.equal(parseLooseDate("2025-08-14")?.toISOString().slice(0, 10), "2025-08-14");
    assert.equal(parseLooseDate("Aug 14"), null);
  });
});
