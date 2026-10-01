import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addBusinessMinutes, businessMinutesBetween, clockMinutes, formatDuration, localDate, parseSchedule, slaLabel, zoneOffsetMinutes,
  TWENTY_FOUR_SEVEN, type BusinessSchedule,
} from "../src/helpdesk-time";

// Mon 5 Oct 2026 09:00 IST = 03:30 UTC.
const ist = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000);
const office: BusinessSchedule = {
  timezone: "Asia/Kolkata",
  days: [1, 2, 3, 4, 5].map((day) => ({ day, from: "09:00", to: "18:00" })),
};

describe("Clock and timezone", () => {
  test("parses wall-clock times, with 23:59 meaning end of day", () => {
    assert.equal(clockMinutes("09:30"), 570);
    assert.equal(clockMinutes("23:59"), 1440);
    assert.ok(Number.isNaN(clockMinutes("9am")));
  });
  test("IST is 5h30 ahead of UTC and has no DST", () => {
    assert.equal(zoneOffsetMinutes(new Date("2026-01-15T00:00:00Z"), "Asia/Kolkata"), 330);
    assert.equal(zoneOffsetMinutes(new Date("2026-07-15T00:00:00Z"), "Asia/Kolkata"), 330);
  });
  test("the local date follows the timezone, not UTC", () => {
    // 20:00 UTC on 4 Oct is 01:30 on 5 Oct in India.
    assert.equal(localDate(new Date("2026-10-04T20:00:00Z"), "Asia/Kolkata").toISOString().slice(0, 10), "2026-10-05");
  });
  test("stored schedules drop malformed rows", () => {
    const s = parseSchedule([{ day: 1, from: "09:00", to: "18:00" }, { day: 9, from: "09:00", to: "18:00" }, { day: 2, from: "18:00", to: "09:00" }, "x"]);
    assert.deepEqual(s.days, [{ day: 1, from: "09:00", to: "18:00" }]);
  });
});

describe("Adding business time", () => {
  test("24x7 without holidays is wall-clock time", () => {
    const start = new Date("2026-10-01T10:00:00Z");
    assert.equal(addBusinessMinutes(start, 8 * 60, TWENTY_FOUR_SEVEN).toISOString(), "2026-10-01T18:00:00.000Z");
  });
  test("an 8-hour target raised Monday 15:00 lands Tuesday 14:00 in office hours", () => {
    assert.equal(addBusinessMinutes(ist(2026, 10, 5, 15), 8 * 60, office).getTime(), ist(2026, 10, 6, 14).getTime());
  });
  test("a ticket raised after hours starts the clock next morning", () => {
    assert.equal(addBusinessMinutes(ist(2026, 10, 5, 21), 60, office).getTime(), ist(2026, 10, 6, 10).getTime());
  });
  test("Friday evening rolls over the weekend", () => {
    // Fri 9 Oct 17:00 + 2h → Mon 12 Oct 10:00.
    assert.equal(addBusinessMinutes(ist(2026, 10, 9, 17), 120, office).getTime(), ist(2026, 10, 12, 10).getTime());
  });
  test("holidays are skipped", () => {
    // Fri 2 Oct (Gandhi Jayanti) is a holiday: Thu 17:00 + 2h → Mon 10:00.
    assert.equal(addBusinessMinutes(ist(2026, 10, 1, 17), 120, office, ["2026-10-02"]).getTime(), ist(2026, 10, 5, 10).getTime());
  });
  test("24x7 with a holiday skips that whole day", () => {
    const s = TWENTY_FOUR_SEVEN;
    assert.equal(addBusinessMinutes(ist(2026, 10, 1, 23), 120, s, ["2026-10-02"]).getTime(), ist(2026, 10, 3, 1).getTime());
  });
  test("split shifts use each window", () => {
    const split: BusinessSchedule = { timezone: "Asia/Kolkata", days: [{ day: 1, from: "09:00", to: "13:00" }, { day: 1, from: "14:00", to: "18:00" }] };
    assert.equal(addBusinessMinutes(ist(2026, 10, 5, 12), 120, split).getTime(), ist(2026, 10, 5, 15).getTime());
  });
});

describe("Measuring business time", () => {
  test("counts only working minutes", () => {
    // Mon 17:00 → Tue 10:00 = 1h Monday + 1h Tuesday.
    assert.equal(businessMinutesBetween(ist(2026, 10, 5, 17), ist(2026, 10, 6, 10), office), 120);
  });
  test("a weekend in between costs nothing", () => {
    assert.equal(businessMinutesBetween(ist(2026, 10, 9, 17), ist(2026, 10, 12, 10), office), 120);
  });
  test("is the inverse of adding", () => {
    for (const [h, add] of [[8, 30], [16, 600], [20, 1234], [11, 5000]] as const) {
      const start = ist(2026, 10, 7, h);
      const end = addBusinessMinutes(start, add, office, ["2026-10-20"]);
      assert.equal(businessMinutesBetween(start, end, office, ["2026-10-20"]), add, `start ${h}:00 + ${add}`);
    }
  });
  test("is zero when the end is not after the start", () => {
    assert.equal(businessMinutesBetween(ist(2026, 10, 6, 10), ist(2026, 10, 5, 10), office), 0);
  });
});

describe("Keka's duration wording", () => {
  test("two units by default", () => {
    assert.equal(formatDuration(5 * 1440 + 19 * 60 + 12), "5 days 19 hours");
    assert.equal(formatDuration(23 * 60 + 17), "23 hours 17 minutes");
    assert.equal(formatDuration(130), "2 hours 10 minutes");
    assert.equal(formatDuration(45), "45 minutes");
    assert.equal(formatDuration(0), "0 minutes");
    assert.equal(formatDuration(1440), "1 day");
  });
  test("ticket age shows three units", () => {
    assert.equal(formatDuration(6 * 1440 + 20 * 60 + 59, 3), "6 days 20 hours 59 minutes");
  });
  test("SLA chips count down, then show how late", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    assert.deepEqual(slaLabel(new Date(now.getTime() + 20 * 3_600_000), now), { text: "20 hours left", overdue: false });
    assert.deepEqual(slaLabel(new Date(now.getTime() - 6 * 86_400_000), now), { text: "Overdue by 6 days", overdue: true });
  });
});
