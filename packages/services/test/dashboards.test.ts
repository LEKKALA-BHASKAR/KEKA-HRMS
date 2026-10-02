import { test } from "node:test";
import assert from "node:assert/strict";
import {
  median, lastMonths, hiringFunnel, sourceEffectiveness, timeToHire, offerAcceptance,
  spendByMonth, spendBy, approvalTurnaround, weekOf, attendanceTrend, attendanceByPerson, bradfordFactor, type FunnelApp, type DayRecord,
} from "../src/dashboards";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

test("median and months", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual(lastMonths(D("2026-02-15"), 3), [{ key: "2025-12", label: "Dec" }, { key: "2026-01", label: "Jan" }, { key: "2026-02", label: "Feb" }]);
});

test("hiring funnel, sources, time to hire and offers", () => {
  const apps: FunnelApp[] = [
    { status: "HIRED", source: "REFERRAL", appliedAt: D("2026-01-01"), furthestSequence: 3, hiredAt: D("2026-01-21") },
    { status: "REJECTED", source: "REFERRAL", appliedAt: D("2026-01-01"), furthestSequence: 1 },
    { status: "ACTIVE", source: "JOB_BOARD", appliedAt: D("2026-01-05"), furthestSequence: 2 },
    { status: "ACTIVE", source: "JOB_BOARD", appliedAt: D("2026-01-05"), furthestSequence: 0 },
    { status: "HIRED", source: "CAREER_PORTAL", appliedAt: D("2026-01-01"), furthestSequence: null, hiredAt: D("2026-01-31") },
  ];
  const stages = [{ sequence: 0, name: "Applied" }, { sequence: 1, name: "Screen" }, { sequence: 2, name: "Interview" }, { sequence: 3, name: "Offer" }];
  assert.deepEqual(hiringFunnel(apps, stages).map((s) => [s.label, s.value, s.conversion]), [["Applied", 5, null], ["Screen", 4, 80], ["Interview", 3, 75], ["Offer", 2, 67]]);
  assert.deepEqual(sourceEffectiveness(apps)[0], { source: "REFERRAL", applications: 2, hires: 1, rate: 50 });
  assert.equal(timeToHire(apps), 25);
  assert.equal(offerAcceptance(["ACCEPTED", "ACCEPTED", "DECLINED", "EXTENDED", "EXPIRED"]), 50);
  assert.equal(offerAcceptance(["EXTENDED"]), null);
});

test("spend counts approved claims only", () => {
  const lines = [
    { date: D("2026-01-10"), amount: 100, category: "Travel", department: "Sales", stage: "PAID" },
    { date: D("2026-01-12"), amount: 50, category: "Meals", department: "Sales", stage: "APPROVED" },
    { date: D("2026-02-01"), amount: 70, category: "Travel", department: "Eng", stage: "PAYMENT_PENDING" },
    { date: D("2026-02-02"), amount: 999, category: "Travel", department: "Eng", stage: "SUBMITTED" },
    { date: D("2026-02-03"), amount: 999, category: "Travel", department: "Eng", stage: "REJECTED" },
  ];
  assert.deepEqual(spendByMonth(lines, lastMonths(D("2026-02-28"), 2)), [{ label: "Jan", value: 150 }, { label: "Feb", value: 70 }]);
  assert.deepEqual(spendBy(lines, (l) => l.category), [{ label: "Travel", value: 170 }, { label: "Meals", value: 50 }]);
  assert.equal(approvalTurnaround([{ submittedAt: D("2026-01-01"), approvedAt: D("2026-01-03") }, { submittedAt: D("2026-01-01"), approvedAt: null }]), 2);
});

test("attendance trend, per person and the Bradford factor", () => {
  assert.equal(weekOf(D("2026-09-30")), "2026-09-28");
  const rec = (employeeId: string, date: string, status: string, hours = 8, late = false, lop = 0): DayRecord => ({ employeeId, date: D(date), status, effectiveHours: hours, late, lop });
  const rows = [
    rec("a", "2026-09-28", "PRESENT", 9, true), rec("a", "2026-09-29", "ABSENT", 0, false, 1), rec("a", "2026-10-03", "WEEKLY_OFF", 0),
    rec("b", "2026-09-28", "WORK_FROM_HOME", 7), rec("b", "2026-09-29", "PRESENT", 8),
    rec("b", "2026-10-05", "PRESENT", 8),
  ];
  assert.deepEqual(attendanceTrend(rows), [
    { week: "2026-09-28", rate: 75, late: 1, hours: 8, absent: 1 },
    { week: "2026-10-05", rate: 100, late: 0, hours: 8, absent: 0 },
  ]);
  const a = attendanceByPerson(rows).find((p) => p.employeeId === "a")!;
  assert.deepEqual(a, { employeeId: "a", workdays: 2, absent: 1, late: 1, lop: 1, hours: 9, rate: 50 });
  // Fri + Mon is one spell; a separate Wednesday is a second.
  assert.equal(bradfordFactor([D("2026-09-25"), D("2026-09-28"), D("2026-09-30")]), 2 * 2 * 3);
  assert.equal(bradfordFactor([D("2026-09-28"), D("2026-09-29"), D("2026-09-30")]), 1 * 1 * 3);
  assert.equal(bradfordFactor([]), 0);
});
