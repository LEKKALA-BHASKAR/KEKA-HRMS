import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceWindow, lopCarry, lopDayRate, payoutState, unverifiedWarnings, challanIssues, form24qStatement,
  type ChallanRow, type DeducteeRow,
} from "../src/payroll-pilot-math";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe("Attendance window", () => {
  const sep = { year: 2026, month: 9, periodStart: d(2026, 9, 1), periodEnd: d(2026, 9, 30) };
  test("runs from the day after the last window to the cut-off", () => {
    const w = attendanceWindow({ ...sep, cutoffDay: 25, previousTo: d(2026, 8, 25) });
    assert.equal(iso(w.from), "2026-08-26");
    assert.equal(iso(w.to), "2026-09-25");
  });
  test("a previous run without a window counted to its period end", () => {
    const w = attendanceWindow({ ...sep, cutoffDay: 25, previousTo: d(2026, 8, 31) });
    assert.equal(iso(w.from), "2026-09-01");
    assert.equal(iso(w.to), "2026-09-25");
  });
  test("no cut-off means the whole period; no previous run means the period start", () => {
    const w = attendanceWindow({ ...sep, cutoffDay: null, previousTo: null });
    assert.equal(iso(w.from), "2026-09-01");
    assert.equal(iso(w.to), "2026-09-30");
  });
  test("a cut-off past the month's last day is the month end", () => {
    const w = attendanceWindow({ year: 2026, month: 2, periodStart: d(2026, 2, 1), periodEnd: d(2026, 2, 28), cutoffDay: 31, previousTo: d(2026, 1, 31) });
    assert.equal(iso(w.to), "2026-02-28");
  });
  test("a skipped month does not reach back further than the previous month", () => {
    const w = attendanceWindow({ ...sep, cutoffDay: 25, previousTo: d(2026, 5, 25) });
    assert.equal(iso(w.from), "2026-08-01");
  });
});

describe("LOP carried from closed months", () => {
  test("LOP recorded late is charged as days; nothing changed carries nothing", () => {
    const c = lopCarry([
      { year: 2026, month: 8, counted: 1, current: 3, alreadyCarried: 0, dayRate: 1000 },
      { year: 2026, month: 7, counted: 2, current: 2, alreadyCarried: 0, dayRate: 1000 },
    ]);
    assert.equal(c.lateDays, 2);
    assert.equal(c.arrears, 0);
    assert.deepEqual(c.entries, [{ year: 2026, month: 8, days: 2, amount: 0 }]);
  });
  test("LOP reversed after closing is paid back at that month's day rate", () => {
    const c = lopCarry([{ year: 2026, month: 8, counted: 3, current: 1, alreadyCarried: 0, dayRate: 1234.5 }]);
    assert.equal(c.reversalDays, 2);
    assert.equal(c.arrears, 2469);
    assert.equal(c.entries[0].days, -2);
  });
  test("what an earlier run already carried is not carried again", () => {
    const c = lopCarry([{ year: 2026, month: 8, counted: 1, current: 3, alreadyCarried: 2, dayRate: 1000 }]);
    assert.equal(c.entries.length, 0);
    const back = lopCarry([{ year: 2026, month: 8, counted: 1, current: 1, alreadyCarried: 2, dayRate: 1000 }]);
    assert.equal(back.reversalDays, 2, "a late charge later reversed is paid back");
  });
  test("day rate counts only LOP-applicable earnings", () => {
    const rate = lopDayRate([
      { type: "EARNING", code: "BASIC", fullAmount: 30000 }, { type: "EARNING", code: "HRA", fullAmount: 15000 },
      { type: "EARNING", code: "FUEL", fullAmount: 3000 }, { type: "DEDUCTION", code: "BASIC", fullAmount: 999 },
    ], new Set(["BASIC", "HRA"]), 30);
    assert.equal(rate, 1500);
    assert.equal(lopDayRate([], new Set(), 0), 0);
  });
});

describe("Payout state", () => {
  const payables = [
    { employeeId: "a", holdId: null, amount: 100 }, { employeeId: "b", holdId: null, amount: 200 },
    { employeeId: "c", holdId: null, amount: 300 }, { employeeId: "a", holdId: "h1", amount: 50 }, { employeeId: "d", holdId: null, amount: 10 },
  ];
  test("the latest attempt decides; a failure re-batched and paid is paid", () => {
    const s = payoutState(payables, [
      { employeeId: "a", holdId: null, status: "PAID", batchNumber: 1 },
      { employeeId: "b", holdId: null, status: "FAILED", batchNumber: 1 },
      { employeeId: "c", holdId: null, status: "FAILED", batchNumber: 1 },
      { employeeId: "c", holdId: null, status: "PAID", batchNumber: 2 },
      { employeeId: "d", holdId: null, status: "PENDING", batchNumber: 2 },
    ]);
    assert.deepEqual(s.paid.map((p) => p.employeeId).sort(), ["a", "c"]);
    assert.deepEqual(s.failed.map((p) => p.employeeId), ["b"]);
    assert.deepEqual(s.pending.map((p) => p.employeeId), ["d"]);
    assert.deepEqual(s.unbatched, [{ employeeId: "a", holdId: "h1", amount: 50 }], "a released hold is a separate payable");
  });
  test("unverified accounts are warned about, masked", () => {
    const w = unverifiedWarnings([{ name: "A", accountNumber: "123456789012", verified: false }, { name: "B", accountNumber: "1", verified: true }, { name: "C", accountNumber: null, verified: false }]);
    assert.equal(w.length, 2);
    assert.match(w[0], /XXXX9012/);
    assert.doesNotMatch(w[0], /12345678/);
  });
});

describe("Form 24Q statement", () => {
  const ch = (id: string, month: number, amt: number, serial = "00012", day = 7): ChallanRow => ({ id, year: 2026, month, bsrCode: "0510001", challanNumber: serial, paymentDate: d(2026, month + 1, day), tdsAmount: amt, surcharge: 0, cess: 0, interest: 0, fee: 0 });
  const dd = (emp: string, month: number, paid: number, tds: number, pan: string | null = "ABCDE1234F"): DeducteeRow => ({ employeeId: emp, employeeNumber: emp, name: `Emp ${emp}`, pan, year: 2026, month, paymentDate: d(2026, month + 1, 1), amountPaid: paid, tds });

  test("challans are checked like the counterfoil", () => {
    assert.deepEqual(challanIssues({ bsrCode: "0510001", challanNumber: "12", tdsAmount: 1 }), []);
    assert.equal(challanIssues({ bsrCode: "51000", challanNumber: "123456", tdsAmount: 0 }).length, 3);
  });
  test("a month that reconciles books every row against its challan", () => {
    const s = form24qStatement([dd("E1", 7, 100000, 5000), dd("E2", 7, 50000, 1000)], [ch("c1", 7, 6000)]);
    assert.deepEqual(s.issues, []);
    assert.equal(s.months[0].deducted, 6000);
    assert.ok(s.allocations.every((a) => a.challanId === "c1"));
    assert.match(s.csv, /^Record,Challan serial/);
    assert.match(s.csv, /DEDUCTEE,00012,0510001,\d\d\/08\/2026,192,E1,ABCDE1234F/);
  });
  test("a row is split across challans, amount paid in proportion", () => {
    const s = form24qStatement([dd("E1", 7, 100000, 6000)], [ch("c1", 7, 4000, "00001", 5), ch("c2", 7, 2000, "00002", 9)]);
    assert.equal(s.allocations.length, 2);
    assert.deepEqual(s.allocations.map((a) => [a.challanId, a.tdsBooked, a.amountPaid]), [["c1", 4000, 66666.67], ["c2", 2000, 33333.33]]);
  });
  test("shortfalls, missing challans and missing PANs are reported", () => {
    const s = form24qStatement([dd("E1", 7, 100000, 5000), dd("E2", 8, 80000, 2000, null)], [ch("c1", 7, 4000)]);
    assert.ok(s.issues.some((i) => /07\/2026: TDS deducted ₹5,000 but challans total ₹4,000/.test(i)));
    assert.ok(s.issues.some((i) => /08\/2026: .*no challan recorded/.test(i)));
    assert.ok(s.issues.some((i) => /E2 .*PANNOTAVBL/.test(i)));
    const unbooked = s.allocations.filter((a) => a.challanId === null);
    assert.deepEqual(unbooked.map((a) => [a.employeeId, a.tdsBooked]), [["E1", 1000], ["E2", 2000]]);
    assert.match(s.csv, /PANNOTAVBL/);
    assert.match(s.csv, /NO CHALLAN/);
  });
});
