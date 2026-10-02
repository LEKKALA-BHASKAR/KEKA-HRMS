import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summariseTickets, groupTicketStats, type TicketStatRow } from "../src/helpdesk-stats";

const H = 3_600_000;
const t0 = new Date("2026-09-01T04:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * H);
const row = (o: Partial<TicketStatRow> & { cat?: string } = {}): TicketStatRow & { cat: string } => ({
  status: "OPEN", createdAt: t0, firstResponseAt: null, closedAt: null, satisfaction: null,
  missedFirstResponse: false, missedResolution: false, cat: "A", ...o,
});

describe("summariseTickets", () => {
  test("an empty set has no averages or attainment", () => {
    const s = summariseTickets([]);
    assert.equal(s.total, 0);
    assert.equal(s.firstResponse.attainment, null);
    assert.equal(s.resolution.avgMinutes, null);
    assert.equal(s.satisfaction.average, null);
  });

  test("counts volume and splits open from closed, legacy RESOLVED included", () => {
    const s = summariseTickets([row(), row({ status: "IN_PROGRESS" }), row({ status: "CLOSED", closedAt: at(5) }), row({ status: "RESOLVED", closedAt: at(3) })]);
    assert.deepEqual([s.total, s.open, s.closed], [4, 2, 2]);
  });

  test("first-response attainment ignores tickets still inside their target", () => {
    const s = summariseTickets([
      row({ firstResponseAt: at(1) }),                              // met
      row({ firstResponseAt: at(9), missedFirstResponse: true }),   // replied late
      row({ missedFirstResponse: true }),                           // no reply, target gone
      row(),                                                        // still within target: not measured
    ]);
    assert.equal(s.firstResponse.measured, 3);
    assert.equal(s.firstResponse.met, 1);
    assert.equal(s.firstResponse.attainment, 33.3);
    assert.equal(s.firstResponse.avgMinutes, 300); // (60 + 540) / 2
  });

  test("resolution attainment and average use closed tickets and missed open ones", () => {
    const s = summariseTickets([
      row({ status: "CLOSED", closedAt: at(2) }),
      row({ status: "CLOSED", closedAt: at(30), missedResolution: true }),
      row({ status: "IN_PROGRESS", missedResolution: true }),
      row({ status: "OPEN" }),
    ]);
    assert.equal(s.resolution.measured, 3);
    assert.equal(s.resolution.met, 1);
    assert.equal(s.resolution.avgMinutes, 16 * 60);
  });

  test("uses the supplied business-minute clock", () => {
    const s = summariseTickets([row({ firstResponseAt: at(10) })], () => 42);
    assert.equal(s.firstResponse.avgMinutes, 42);
  });

  test("satisfaction averages ratings on closed tickets only", () => {
    const s = summariseTickets([
      row({ status: "CLOSED", closedAt: at(1), satisfaction: 5 }),
      row({ status: "CLOSED", closedAt: at(1), satisfaction: 4 }),
      row({ status: "CLOSED", closedAt: at(1) }),
      row({ status: "OPEN", satisfaction: 1 }),
    ]);
    assert.deepEqual(s.satisfaction, { rated: 2, average: 4.5 });
  });
});

describe("groupTicketStats", () => {
  test("groups by key, largest first, ties by name", () => {
    const g = groupTicketStats([row({ cat: "B" }), row({ cat: "A" }), row({ cat: "C" }), row({ cat: "C" })], (r) => r.cat);
    assert.deepEqual(g.map((x) => [x.key, x.stats.total]), [["C", 2], ["A", 1], ["B", 1]]);
  });
});
