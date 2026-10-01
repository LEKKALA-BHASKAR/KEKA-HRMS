import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  weekdayInstance, weeklyOffPortion, classifyDay, workingDaysBetween, DEFAULT_WEEKLY_OFF,
  type WorkCalendar,
} from "../src/calendar";
import { countLeave, validateLeave, accrueFor, type LeaveTypeRules, type AccrualRules } from "../src/leave";
import {
  evaluateDay, applyMonthlyPenalties, pairPunches, requiredHoursFor, DEFAULT_RULES,
  type ShiftSpec,
} from "../src/attendance";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
/** An IST wall-clock time on a date, as the UTC instant a device would log. */
const ist = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m) - 330 * 60_000);
};

// October 2026: Thu 1, Fri 2 (Gandhi Jayanti), Sat 3, Sun 4, Mon 5 … Tue 20 (Dussehra).
const cal: WorkCalendar = {
  weeklyOff: DEFAULT_WEEKLY_OFF,
  holidays: new Set(["2026-10-02", "2026-10-20"]),
};

describe("Calendar", () => {
  test("weekday instance within the month", () => {
    assert.equal(weekdayInstance(d("2026-10-03")), 1);
    assert.equal(weekdayInstance(d("2026-10-10")), 2);
    assert.equal(weekdayInstance(d("2026-10-31")), 5);
  });

  test("alternate Saturdays: only the 2nd and 4th are off", () => {
    const alt = { SUN: { instances: "ALL" as const }, SAT: { instances: [2, 4] } };
    assert.equal(weeklyOffPortion(d("2026-10-03"), alt), null);
    assert.equal(weeklyOffPortion(d("2026-10-10"), alt), "FULL_DAY");
    assert.equal(weeklyOffPortion(d("2026-10-17"), alt), null);
    assert.equal(weeklyOffPortion(d("2026-10-24"), alt), "FULL_DAY");
    assert.equal(weeklyOffPortion(d("2026-10-11"), alt), "FULL_DAY");
  });

  test("a holiday outranks a weekly off", () => {
    const c: WorkCalendar = { weeklyOff: DEFAULT_WEEKLY_OFF, holidays: new Set(["2026-10-03"]) };
    assert.equal(classifyDay(d("2026-10-03"), c), "HOLIDAY");
  });

  test("working days in October 2026", () => {
    // 31 days − 9 weekend days − 2 holidays = 20
    assert.equal(workingDaysBetween(d("2026-10-01"), d("2026-10-31"), cal), 20);
  });

  test("a half weekly-off counts as half a working day", () => {
    const c: WorkCalendar = {
      weeklyOff: { SUN: { instances: "ALL" }, SAT: { instances: "ALL", portion: "SECOND_HALF" } },
      holidays: new Set(),
    };
    // Mon 5 .. Sun 11: five full days + half Saturday
    assert.equal(workingDaysBetween(d("2026-10-05"), d("2026-10-11"), c), 5.5);
  });
});

describe("Leave counting and the sandwich rule", () => {
  test("a plain Mon–Fri week is five days", () => {
    const r = countLeave({ from: d("2026-10-05"), to: d("2026-10-09"), calendar: cal });
    assert.equal(r.leaveDays, 5);
    assert.equal(r.sandwichDays, 0);
  });

  test("without a sandwich rule, off-days inside the range are free", () => {
    // Thu 1 → Mon 5: Thu and Mon are working; Fri holiday, Sat, Sun off.
    const r = countLeave({ from: d("2026-10-01"), to: d("2026-10-05"), calendar: cal });
    assert.equal(r.totalDays, 2);
  });

  test("'between' on both weekly offs and holidays charges all five days", () => {
    const r = countLeave({
      from: d("2026-10-01"), to: d("2026-10-05"), calendar: cal,
      sandwich: { weeklyOff: { between: true }, holiday: { between: true } },
    });
    assert.equal(r.leaveDays, 2);
    assert.equal(r.sandwichDays, 3);
    assert.equal(r.totalDays, 5);
  });

  test("weekly-off and holiday triggers are independent", () => {
    const r = countLeave({
      from: d("2026-10-01"), to: d("2026-10-05"), calendar: cal,
      sandwich: { weeklyOff: { between: true } },
    });
    // Sat and Sun sandwiched; the Friday holiday is not.
    assert.equal(r.sandwichDays, 2);
    assert.equal(r.totalDays, 4);
    assert.ok(!r.days.some((x) => x.key === "2026-10-02"));
  });

  test("'after' pulls in the weekend following a Friday leave", () => {
    const r = countLeave({
      from: d("2026-10-09"), to: d("2026-10-09"), calendar: cal,
      sandwich: { weeklyOff: { after: true } },
    });
    assert.equal(r.totalDays, 3);
  });

  test("'before' pulls in the weekend preceding a Monday leave", () => {
    const r = countLeave({
      from: d("2026-10-12"), to: d("2026-10-12"), calendar: cal,
      sandwich: { weeklyOff: { before: true } },
    });
    assert.equal(r.totalDays, 3);
  });

  test("'dayBetweenLeaves' links this request to another leave across a weekend", () => {
    const other = new Map([["2026-10-09", "FULL_DAY" as const]]);
    const linked = countLeave({
      from: d("2026-10-12"), to: d("2026-10-12"), calendar: cal,
      sandwich: { weeklyOff: { dayBetweenLeaves: true } }, otherLeave: other,
    });
    assert.equal(linked.sandwichDays, 2);

    const alone = countLeave({
      from: d("2026-10-12"), to: d("2026-10-12"), calendar: cal,
      sandwich: { weeklyOff: { dayBetweenLeaves: true } },
    });
    assert.equal(alone.sandwichDays, 0);
  });

  test("a half-day at the boundary does not trigger the sandwich when excluded", () => {
    const r = countLeave({
      from: d("2026-10-09"), to: d("2026-10-09"), fromPortion: "SECOND_HALF", calendar: cal,
      sandwich: { weeklyOff: { after: true }, excludeHalfDay: true },
    });
    assert.equal(r.totalDays, 0.5);
  });

  test("the threshold suppresses the sandwich for short leave", () => {
    const short = countLeave({
      from: d("2026-10-09"), to: d("2026-10-12"), calendar: cal,
      sandwich: { weeklyOff: { between: true }, threshold: 3 },
    });
    assert.equal(short.totalDays, 2);
    const long = countLeave({
      from: d("2026-10-09"), to: d("2026-10-12"), calendar: cal,
      sandwich: { weeklyOff: { between: true }, threshold: 2 },
    });
    assert.equal(long.totalDays, 4);
  });

  test("half and quarter portions", () => {
    assert.equal(countLeave({
      from: d("2026-10-05"), to: d("2026-10-06"), fromPortion: "SECOND_HALF", calendar: cal,
    }).totalDays, 1.5);
    assert.equal(countLeave({
      from: d("2026-10-05"), to: d("2026-10-05"), fromPortion: "FIRST_HALF", calendar: cal,
    }).totalDays, 0.5);
    assert.equal(countLeave({
      from: d("2026-10-05"), to: d("2026-10-05"), fromPortion: "QUARTER", calendar: cal,
    }).totalDays, 0.25);
  });

  test("a request covering only off-days is empty", () => {
    const r = countLeave({ from: d("2026-10-03"), to: d("2026-10-04"), calendar: cal });
    assert.equal(r.empty, true);
    assert.equal(r.totalDays, 0);
  });

  test("overlap with existing leave is reported", () => {
    const r = countLeave({
      from: d("2026-10-05"), to: d("2026-10-07"), calendar: cal,
      otherLeave: new Map([["2026-10-06", "FULL_DAY" as const]]),
    });
    assert.deepEqual(r.overlaps, ["2026-10-06"]);
  });
});

const EL: LeaveTypeRules = {
  name: "Earned Leave", isPaid: true, allowHalfDay: true, allowQuarterDay: false,
  allowBackdated: true, priorNoticeDays: null, requireComment: false,
  attachmentAboveDays: null, maxConsecutiveDays: null, allowNegativeBalance: false,
  maxNegativeDays: null, isUnlimited: false, accrueDuringProbation: true,
  maxDaysDuringProbation: null,
};
const base = (over: Partial<Parameters<typeof validateLeave>[0]> = {}) => ({
  rules: EL,
  count: countLeave({ from: d("2026-10-05"), to: d("2026-10-07"), calendar: cal }),
  from: d("2026-10-05"), to: d("2026-10-07"),
  fromPortion: "FULL_DAY" as const, toPortion: "FULL_DAY" as const,
  today: d("2026-09-28"), available: 10,
  ...over,
});

describe("Leave validation", () => {
  test("a valid request passes", () => {
    assert.deepEqual(validateLeave(base()), []);
  });

  test("insufficient balance is refused", () => {
    const issues = validateLeave(base({ available: 2 }));
    assert.ok(issues.some((i) => /Not enough/.test(i.message)));
  });

  test("an overdraft is allowed within its limit and refused beyond it", () => {
    const rules = { ...EL, allowNegativeBalance: true, maxNegativeDays: 2 };
    assert.deepEqual(validateLeave(base({ rules, available: 1 })), []);
    assert.ok(validateLeave(base({ rules, available: 0 })).length > 0);
  });

  test("unpaid leave has no balance to check", () => {
    assert.deepEqual(validateLeave(base({ rules: { ...EL, isPaid: false }, available: 0 })), []);
  });

  test("half days refused where the type forbids them", () => {
    const issues = validateLeave(base({ rules: { ...EL, allowHalfDay: false }, fromPortion: "SECOND_HALF" }));
    assert.ok(issues.some((i) => i.field === "fromPortion"));
  });

  test("back-dating refused where the type forbids it", () => {
    const issues = validateLeave(base({
      rules: { ...EL, allowBackdated: false },
      from: d("2026-09-21"), to: d("2026-09-22"),
      count: countLeave({ from: d("2026-09-21"), to: d("2026-09-22"), calendar: cal }),
    }));
    assert.ok(issues.some((i) => /past dates/.test(i.message)));
  });

  test("prior notice is enforced", () => {
    const issues = validateLeave(base({ rules: { ...EL, priorNoticeDays: 14 } }));
    assert.ok(issues.some((i) => /notice/.test(i.message)));
  });

  test("maximum consecutive days", () => {
    const issues = validateLeave(base({ rules: { ...EL, maxConsecutiveDays: 2 } }));
    assert.ok(issues.some((i) => /consecutive/.test(i.message)));
  });

  test("a document is demanded above the threshold", () => {
    const need = validateLeave(base({ rules: { ...EL, attachmentAboveDays: 2 } }));
    assert.ok(need.some((i) => i.field === "attachment"));
    const has = validateLeave(base({ rules: { ...EL, attachmentAboveDays: 2 }, hasAttachment: true }));
    assert.deepEqual(has, []);
  });

  test("the probation ceiling", () => {
    const issues = validateLeave(base({
      rules: { ...EL, maxDaysDuringProbation: 4 }, onProbation: true, usedDuringProbation: 2,
    }));
    assert.ok(issues.some((i) => /probation/.test(i.message)));
  });

  test("an end before the start is refused outright", () => {
    const issues = validateLeave(base({ from: d("2026-10-07"), to: d("2026-10-05") }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, "toDate");
  });
});

const monthly: AccrualRules = {
  frequency: "MONTHLY", annualQuota: 18, isUnlimited: false, prorateOnJoining: true,
  noAwardIfJoinAfterDay: null, accrueDuringProbation: true, maxAccumulation: null,
};
const acc = (over: Partial<Parameters<typeof accrueFor>[0]> = {}) => accrueFor({
  rules: monthly, year: 2026, month: 10, leaveYearStartMonth: 4,
  joinDate: d("2024-01-01"), currentBalance: 0, ...over,
});

describe("Accrual", () => {
  test("monthly credit is the annual quota over twelve", () => {
    const r = acc();
    assert.equal(r.credit, 1.5);
    assert.equal(r.periodKey, "2026-10");
  });

  test("a mid-month joiner is prorated by days", () => {
    // Joined 16 Oct: 16 of 31 days -> 1.5 × 16/31
    assert.equal(acc({ joinDate: d("2026-10-16") }).credit, 0.77);
  });

  test("joining after the cut-off day earns nothing that month", () => {
    const r = acc({ rules: { ...monthly, noAwardIfJoinAfterDay: 15 }, joinDate: d("2026-10-16") });
    assert.equal(r.credit, 0);
  });

  test("probation defers accrual when configured", () => {
    const r = acc({
      rules: { ...monthly, accrueDuringProbation: false },
      probationEndDate: d("2026-12-31"),
    });
    assert.equal(r.credit, 0);
    assert.match(r.reason, /probation/);
  });

  test("the accumulation cap limits the credit", () => {
    assert.equal(acc({ rules: { ...monthly, maxAccumulation: 30 }, currentBalance: 29.5 }).credit, 0.5);
    assert.equal(acc({ rules: { ...monthly, maxAccumulation: 30 }, currentBalance: 30 }).credit, 0);
  });

  test("quarterly credits only at quarter starts of the leave year", () => {
    const q = { ...monthly, frequency: "QUARTERLY" as const };
    assert.equal(acc({ rules: q, month: 7 }).credit, 4.5); // July is Q2 start for an April year
    assert.equal(acc({ rules: q, month: 8 }).credit, 0);
  });

  test("an annual credit lands once, and a mid-year joiner gets the remaining share", () => {
    const a = { ...monthly, frequency: "UPFRONT" as const, annualQuota: 12 };
    assert.equal(acc({ rules: a, month: 4 }).credit, 12);
    assert.equal(acc({ rules: a, month: 5 }).credit, 0);
    // Joined in October, six months into an April year.
    assert.equal(acc({ rules: a, month: 10, joinDate: d("2026-10-01") }).credit, 6);
  });

  test("no credit before joining or after exit", () => {
    assert.equal(acc({ joinDate: d("2026-11-01") }).credit, 0);
    assert.equal(acc({ exitDate: d("2026-09-30") }).credit, 0);
  });

  test("monthly slices of a quota that does not divide by twelve sum to it exactly", () => {
    // Regression: 8 days monthly was twelve credits of 0.67 = 8.04.
    for (const quota of [8, 7, 10, 15, 1, 0.5]) {
      const rules = { ...monthly, annualQuota: quota };
      let total = 0;
      for (let i = 0; i < 12; i++) {
        const month = ((3 + i) % 12) + 1; // April through March
        const year = month >= 4 ? 2026 : 2027;
        total += acc({ rules, month, year }).credit;
      }
      assert.equal(Math.round(total * 100) / 100, quota, `quota ${quota}`);
    }
  });

  test("quarterly and half-yearly slices also sum exactly", () => {
    for (const [frequency, starts] of [["QUARTERLY", [4, 7, 10, 1]], ["SEMI_ANNUAL", [4, 10]]] as const) {
      const rules = { ...monthly, frequency, annualQuota: 7 };
      const total = starts.reduce((s, m) => s + acc({ rules, month: m, year: m >= 4 ? 2026 : 2027 }).credit, 0);
      assert.equal(Math.round(total * 100) / 100, 7, frequency);
    }
  });

  test("a mid-month exit prorates the final credit", () => {
    // Left on 15 Oct: 15 of 31 days
    assert.equal(acc({ exitDate: d("2026-10-15") }).credit, 0.73);
  });
});

const shift: ShiftSpec = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, isFlexible: false };
const day = (over: Partial<Parameters<typeof evaluateDay>[0]> = {}) => evaluateDay({
  date: d("2026-10-06"), kind: "WORKING", shift, rules: DEFAULT_RULES, logs: [], ...over,
});
const punches = (date: string, ...times: string[]) =>
  times.map((t, i) => ({ timestamp: ist(date, t), direction: (i % 2) as 0 | 1 }));

describe("Attendance evaluation", () => {
  test("required hours are the shift span less the break", () => {
    assert.equal(requiredHoursFor(shift), 8);
    assert.equal(requiredHoursFor({ ...shift, isFlexible: true, requiredHours: 7 }), 7);
    assert.equal(requiredHoursFor({ startTime: "22:00", endTime: "06:00", breakMinutes: 30, isFlexible: false, crossesMidnight: true }), 7.5);
  });

  test("a full day on time", () => {
    const r = day({ logs: punches("2026-10-06", "09:25", "18:40") });
    assert.equal(r.status, "PRESENT");
    assert.equal(r.isLate, false);
    assert.equal(r.lopValue, 0);
    assert.equal(r.payableValue, 1);
  });

  test("arrival beyond the grace period is late", () => {
    const r = day({ logs: punches("2026-10-06", "10:00", "18:40") });
    assert.equal(r.isLate, true);
    assert.equal(r.lateMinutes, 30);
    assert.equal(r.status, "PRESENT"); // still a full day on hours
  });

  test("within grace is not late", () => {
    assert.equal(day({ logs: punches("2026-10-06", "09:40", "18:40") }).isLate, false);
  });

  test("short hours make a half day", () => {
    const r = day({ logs: punches("2026-10-06", "09:30", "14:00") });
    assert.equal(r.status, "HALF_DAY");
    assert.equal(r.lopValue, 0.5);
    assert.equal(r.payableValue, 0.5);
  });

  test("very short hours make an absence", () => {
    const r = day({ logs: punches("2026-10-06", "09:30", "11:00") });
    assert.equal(r.status, "ABSENT");
    assert.equal(r.lopValue, 1);
  });

  test("lunch-break punches pair into separate intervals", () => {
    const p = pairPunches(punches("2026-10-06", "09:00", "13:00", "14:00", "18:00"));
    assert.equal(p.intervals.length, 2);
    const r = day({ logs: punches("2026-10-06", "09:00", "13:00", "14:00", "18:00") });
    assert.equal(r.effectiveHours, 8);
    assert.equal(r.grossHours, 9);
  });

  test("no punches on a working day is loss of pay, unless the policy says otherwise", () => {
    assert.equal(day().lopValue, 1);
    assert.equal(day({ rules: { ...DEFAULT_RULES, noAttendanceIsLop: false } }).lopValue, 0);
  });

  test("unpaid leave carries no attendance LOP — it is charged through the leave", () => {
    const r = day({ leave: { portion: "FULL_DAY", isPaid: false } });
    assert.equal(r.status, "ON_LEAVE");
    assert.equal(r.lopValue, 0);
    assert.equal(r.payableValue, 0);
  });

  test("paid leave is fully payable", () => {
    const r = day({ leave: { portion: "FULL_DAY", isPaid: true } });
    assert.equal(r.payableValue, 1);
    assert.equal(r.lopValue, 0);
  });

  test("a first-half leave plus an afternoon worked is a full paid day", () => {
    const r = day({
      leave: { portion: "FIRST_HALF", isPaid: true },
      logs: punches("2026-10-06", "14:00", "18:30"),
    });
    assert.equal(r.lopValue, 0);
    assert.equal(r.payableValue, 1);
    assert.equal(r.isLate, false);
  });

  test("a half-day leave with no punches loses only the working half", () => {
    const r = day({ leave: { portion: "SECOND_HALF", isPaid: true } });
    assert.equal(r.lopValue, 0.5);
    assert.equal(r.payableValue, 0.5);
  });

  test("approved remote work counts as attended", () => {
    assert.equal(day({ remote: "WORK_FROM_HOME" }).payableValue, 1);
    assert.equal(day({ remote: "ON_DUTY" }).status, "ON_DUTY");
  });

  test("a regularised day carries no LOP and no penalty flags", () => {
    const r = day({ regularised: true, logs: punches("2026-10-06", "11:30", "14:00") });
    assert.equal(r.lopValue, 0);
    assert.equal(r.isLate, false);
  });

  test("a lone IN punch is a missing punch, not an absence", () => {
    const r = day({ logs: [{ timestamp: ist("2026-10-06", "09:30"), direction: 0 }] });
    assert.equal(r.isMissingPunch, true);
    assert.equal(r.status, "PRESENT");
    assert.equal(r.lopValue, 0);
  });

  test("working on a weekly off is overtime when enabled", () => {
    const r = day({
      kind: "WEEKLY_OFF", rules: { ...DEFAULT_RULES, overtimeEnabled: true },
      logs: punches("2026-10-10", "10:00", "15:00"),
    });
    assert.equal(r.status, "WEEKLY_OFF");
    assert.equal(r.overtimeHours, 5);
    assert.equal(r.lopValue, 0);
  });

  test("overtime beyond the shift on a working day", () => {
    const r = day({
      rules: { ...DEFAULT_RULES, overtimeEnabled: true },
      logs: punches("2026-10-06", "09:00", "19:00"),
    });
    assert.equal(r.overtimeHours, 2);
  });

  test("a flexible shift is never late", () => {
    const r = day({
      shift: { ...shift, isFlexible: true, requiredHours: 8 },
      logs: punches("2026-10-06", "12:00", "20:30"),
    });
    assert.equal(r.isLate, false);
    assert.equal(r.status, "PRESENT");
  });

  test("an untracked employee is always payable", () => {
    assert.equal(day({ trackAttendance: false }).lopValue, 0);
  });
});

describe("Monthly penalties", () => {
  const lateDay = (n: number) => ({
    ...day({ logs: punches(`2026-10-${String(n).padStart(2, "0")}`, "10:00", "18:40") }),
    date: d(`2026-10-${String(n).padStart(2, "0")}`),
  });

  test("late arrivals beyond the exemption each cost half a day", () => {
    const days = [5, 6, 7, 8, 9].map(lateDay);
    const out = applyMonthlyPenalties(days, DEFAULT_RULES);
    assert.deepEqual(out.map((x) => x.lopValue), [0, 0, 0, 0.5, 0.5]);
    assert.match(out[3].penaltyReason ?? "", /Late arrival 4/);
    assert.equal(out[3].payableValue, 0.5);
  });

  test("penalties apply in date order regardless of input order", () => {
    const days = [9, 5, 8, 6, 7].map(lateDay);
    const out = applyMonthlyPenalties(days, DEFAULT_RULES);
    assert.equal(out[out.length - 1].date.toISOString().slice(0, 10), "2026-10-09");
    assert.equal(out[out.length - 1].lopValue, 0.5);
  });

  test("missing punches beyond the exemption are penalised", () => {
    const miss = (n: number) => ({
      ...day({ logs: [{ timestamp: ist(`2026-10-0${n}`, "09:30"), direction: 0 as const }] }),
      date: d(`2026-10-0${n}`),
    });
    const out = applyMonthlyPenalties([5, 6, 7].map(miss), DEFAULT_RULES);
    assert.deepEqual(out.map((x) => x.lopValue), [0, 0, 0.5]);
  });

  test("a penalty never pushes a day beyond one full day of LOP", () => {
    const absentAndLate = {
      ...day({ logs: punches("2026-10-09", "11:00", "12:00") }),
      date: d("2026-10-09"), isLate: true,
    };
    const priors = [5, 6, 7, 8].map(lateDay);
    const out = applyMonthlyPenalties([...priors, absentAndLate], DEFAULT_RULES);
    const last = out.find((x) => x.date.toISOString().startsWith("2026-10-09"))!;
    assert.equal(last.lopValue, 1);
    assert.equal(last.payableValue, 0);
  });
});
