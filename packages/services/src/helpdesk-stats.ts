/**
 * Helpdesk report arithmetic, kept pure so it can be tested without a
 * database: volume, SLA attainment, average first-response and resolution
 * times and satisfaction over a set of tickets, overall and per group.
 *
 * SLA attainment reads the missed-target flags rather than comparing dates,
 * because the flags already account for time spent On Hold:
 *  - first response is measured once an agent has replied or the target has
 *    been missed; it is met when a reply came and the target was not missed;
 *  - resolution is measured once the ticket is closed or the target has been
 *    missed; it is met when it closed without missing the target.
 */

export interface TicketStatRow {
  status: string;
  createdAt: Date;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  satisfaction: number | null;
  missedFirstResponse: boolean;
  missedResolution: boolean;
}

export interface TicketStats {
  total: number;
  open: number;
  closed: number;
  firstResponse: { measured: number; met: number; attainment: number | null; avgMinutes: number | null };
  resolution: { measured: number; met: number; attainment: number | null; avgMinutes: number | null };
  satisfaction: { rated: number; average: number | null };
}

const isClosed = (s: string) => s === "CLOSED" || s === "RESOLVED";
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (met: number, of: number) => (of ? Math.round((met / of) * 1000) / 10 : null);

/**
 * `minutes(row, end)` gives the business minutes from raising to `end` in the
 * ticket's own clock; callers pass the category's schedule. Without it the
 * wall-clock difference is used.
 */
export function summariseTickets<R extends TicketStatRow>(rows: R[], minutes: (row: R, end: Date) => number = (r, end) => (end.getTime() - r.createdAt.getTime()) / 60_000): TicketStats {
  const closed = rows.filter((r) => isClosed(r.status));
  const frMeasured = rows.filter((r) => r.firstResponseAt || r.missedFirstResponse);
  const frMet = frMeasured.filter((r) => r.firstResponseAt && !r.missedFirstResponse);
  const resMeasured = rows.filter((r) => isClosed(r.status) || r.missedResolution);
  const resMet = resMeasured.filter((r) => isClosed(r.status) && !r.missedResolution);
  const rated = closed.filter((r) => r.satisfaction);
  return {
    total: rows.length,
    open: rows.length - closed.length,
    closed: closed.length,
    firstResponse: {
      measured: frMeasured.length, met: frMet.length, attainment: pct(frMet.length, frMeasured.length),
      avgMinutes: mean(rows.filter((r) => r.firstResponseAt).map((r) => minutes(r, r.firstResponseAt!))),
    },
    resolution: {
      measured: resMeasured.length, met: resMet.length, attainment: pct(resMet.length, resMeasured.length),
      avgMinutes: mean(closed.filter((r) => r.closedAt).map((r) => minutes(r, r.closedAt!))),
    },
    satisfaction: { rated: rated.length, average: rated.length ? Math.round(mean(rated.map((r) => r.satisfaction!))! * 10) / 10 : null },
  };
}

/** The same summary per group (category, agent…), largest group first. */
export function groupTicketStats<R extends TicketStatRow>(rows: R[], keyOf: (row: R) => string, minutes?: (row: R, end: Date) => number): Array<{ key: string; stats: TicketStats }> {
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = groups.get(k);
    if (list) list.push(r); else groups.set(k, [r]);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, stats: summariseTickets(rs, minutes) }))
    .sort((a, b) => b.stats.total - a.stats.total || a.key.localeCompare(b.key));
}
