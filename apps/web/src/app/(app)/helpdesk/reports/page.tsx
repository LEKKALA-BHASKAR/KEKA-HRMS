import Link from "next/link";
import type { ReactNode } from "react";
import { prisma, type Prisma } from "@keka/db";
import {
  helpdeskScopeWhere, helpdeskCategoryPath, helpdeskUserNames, helpdeskClocks, helpdeskTime, helpdeskReport,
  summariseTickets, groupTicketStats, formatTicketDuration, HELPDESK_REPORTS, type HelpdeskReportKey, type TicketStats,
} from "@keka/services";
import { BarChart } from "@/components/charts";
import { requireHelpdeskAgent } from "../_ui/access";
import { HelpdeskTabs } from "../_ui/tabs";
import { categoryOptions } from "../_ui/data";
import { ReportFilters } from "../_ui/report-filters";
import { resolveRange, isoDay } from "../_ui/format";
import s from "../_ui/hd.module.css";

/**
 * Org › Helpdesk › Reports: for tickets raised in the chosen window (and
 * categories), the volume, SLA attainment, average first-response and
 * resolution times (in each category's business hours) and satisfaction —
 * overall, by category and by agent — then Keka's detailed reports.
 */

type SP = Record<string, string | string[] | undefined>;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
const DAY = 86_400_000;

const dur = (m: number | null) => (m === null ? "N/A" : formatTicketDuration(m));
const pct = (v: number | null) => (v === null ? "N/A" : `${v}%`);

export default async function HelpdeskReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { viewer, scope, canSettings } = await requireHelpdeskAgent();
  const sp = await searchParams;
  const range = resolveRange({ range: one(sp.range), from: one(sp.from), to: one(sp.to) }, "30d");
  const cat = list(sp.cat);
  const reportKey = HELPDESK_REPORTS.some((r) => r.key === one(sp.report)) ? (one(sp.report) as HelpdeskReportKey) : null;

  // Picked categories include their subcategories.
  let categoryIds: string[] | null = null;
  if (cat.length) {
    const all = await prisma.helpdeskCategory.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, parentId: true } });
    categoryIds = all.filter((c) => cat.includes(c.id) || (c.parentId && cat.includes(c.parentId))).map((c) => c.id);
  }
  const where: Prisma.HelpdeskTicketWhereInput = {
    tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope), createdAt: { gte: range.from, lt: range.to },
    ...(categoryIds ? { AND: [{ categoryId: { in: categoryIds } }] } : {}),
  };
  const tickets = await prisma.helpdeskTicket.findMany({
    where,
    select: {
      id: true, categoryId: true, assigneeUserId: true, status: true, createdAt: true, firstResponseAt: true, closedAt: true, resolvedAt: true,
      satisfaction: true, missedFirstResponse: true, missedResolution: true,
      category: { select: { name: true, parent: { select: { name: true } } } },
    },
  });
  const rows = tickets.map((t) => ({ ...t, closedAt: t.closedAt ?? t.resolvedAt }));
  const clock = await helpdeskClocks(viewer.tenantId);
  const minutes = (r: (typeof rows)[number], end: Date) => {
    const c = clock(r.categoryId);
    return helpdeskTime.businessMinutesBetween(r.createdAt, end, c.schedule, c.holidays);
  };
  const total = summariseTickets(rows, minutes);
  const catLabel = new Map(rows.map((r) => [r.categoryId, helpdeskCategoryPath(r.category)]));
  const byCategory = groupTicketStats(rows, (r) => r.categoryId, minutes).map((g) => ({ label: catLabel.get(g.key) ?? "—", stats: g.stats }));
  const names = await helpdeskUserNames(viewer.tenantId, rows.map((r) => r.assigneeUserId));
  const byAgent = groupTicketStats(rows, (r) => r.assigneeUserId ?? "", minutes).map((g) => ({ label: g.key ? names.get(g.key) ?? "—" : "Not assigned", stats: g.stats }));

  // Volume: days for two weeks, weeks up to a quarter, months beyond.
  const span = (range.to.getTime() - range.from.getTime()) / DAY;
  const buckets: Array<{ label: string; from: number; to: number }> = [];
  if (span <= 14) {
    for (let t = range.from.getTime(); t < range.to.getTime(); t += DAY) buckets.push({ label: isoDay(new Date(t)).slice(5), from: t, to: t + DAY });
  } else if (span <= 92) {
    for (let t = range.from.getTime(); t < range.to.getTime(); t += 7 * DAY) buckets.push({ label: `w/c ${isoDay(new Date(t)).slice(5)}`, from: t, to: Math.min(t + 7 * DAY, range.to.getTime()) });
  } else {
    const first = new Date(range.from.getTime() + 330 * 60_000);
    for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); ; m++) {
      const from = Date.UTC(y, m, 1) - 330 * 60_000, to = Date.UTC(y, m + 1, 1) - 330 * 60_000;
      if (from >= range.to.getTime()) break;
      buckets.push({ label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }), from: Math.max(from, range.from.getTime()), to });
    }
  }
  const closedInRange = await prisma.helpdeskTicket.findMany({
    where: { tenantId: viewer.tenantId, ...helpdeskScopeWhere(scope), closedAt: { gte: range.from, lt: range.to }, status: { in: ["CLOSED", "RESOLVED"] }, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
    select: { closedAt: true },
  });
  const series = buckets.map((b) => ({
    label: b.label,
    raised: rows.filter((r) => r.createdAt.getTime() >= b.from && r.createdAt.getTime() < b.to).length,
    closed: closedInRange.filter((r) => r.closedAt!.getTime() >= b.from && r.closedAt!.getTime() < b.to).length,
  }));

  const categories = await categoryOptions(viewer.tenantId, { only: scope.all ? undefined : scope.categoryIds, includeInactive: true });
  const report = reportKey ? await helpdeskReport(reportKey, { tenantId: viewer.tenantId, scope, filters: { from: range.from, to: range.to, categoryIds: cat.length ? cat : undefined } }) : null;
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "report") for (const x of list(v)) keep.append(k, x);
  const reportHref = (key: string | null) => {
    const q = new URLSearchParams(keep);
    if (key) q.set("report", key);
    const qs = q.toString();
    return `/helpdesk/reports${qs ? `?${qs}` : ""}${key ? "#report" : ""}`;
  };

  const tile = (label: string, value: string | number, rule: string, note?: ReactNode) => (
    <div className={s.tile} style={{ ["--rule" as string]: rule }}>
      <div><div className={s.tileLabel}>{label}</div><div className={s.tileValue}>{value}</div></div>
      {note ? <div className={s.tileDelta}>{note}</div> : null}
    </div>
  );

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings={canSettings} active="/helpdesk/reports" />
      <div className={s.sectionRow}>
        <div>
          <div className={s.h2}>Reports</div>
          <div className={s.caption}>Tickets raised {range.label}. Times are in each category&apos;s business hours.</div>
        </div>
        <ReportFilters rangeKey={range.key} from={range.fromYmd} to={range.toYmd} categories={categories} cat={cat} />
      </div>

      <div className={`${s.tiles} ${s.tiles4}`}>
        {tile("Tickets raised", total.total, "#7c8ce0", <>Open<b>{total.open}</b></>)}
        {tile("Closed", total.closed, "#4caf7a")}
        {tile("First response SLA met", pct(total.firstResponse.attainment), "#f2b23a", <>Measured<b>{total.firstResponse.measured}</b></>)}
        {tile("Resolution SLA met", pct(total.resolution.attainment), "#4fb6c9", <>Measured<b>{total.resolution.measured}</b></>)}
        {tile("Avg first response", dur(total.firstResponse.avgMinutes), "#f29f67")}
        {tile("Avg resolution", dur(total.resolution.avgMinutes), "#5a9bd8")}
        {tile("Satisfaction", total.satisfaction.average === null ? "N/A" : `${total.satisfaction.average} / 5`, "#d87aa8", <>Ratings<b>{total.satisfaction.rated}</b></>)}
        {tile("Escalated", rows.filter((r) => r.missedFirstResponse || r.missedResolution).length, "#c94848")}
      </div>

      <div className={s.panel}>
        <div className={s.chartHead}>Ticket volume</div>
        <div className={s.chartBody}>
          {series.some((x) => x.raised || x.closed)
            ? <BarChart rows={series.map((x) => ({ label: x.label, value: x.raised }))} series={[{ label: "Raised", values: series.map((x) => x.raised) }, { label: "Closed", values: series.map((x) => x.closed) }]} height={300} title="Tickets raised and closed" />
            : <div className={s.noData}>No tickets in this period.</div>}
        </div>
      </div>

      <StatsTable title="By category" first="Category" groups={byCategory} />
      <StatsTable title="By agent" first="Assigned to" groups={byAgent} />

      <div className={s.h2} id="report">Detailed reports</div>
      <div className={s.reportCards}>
        {HELPDESK_REPORTS.map((r) => (
          <Link key={r.key} href={reportHref(r.key)} className={s.reportCard} style={r.key === reportKey ? { borderColor: "var(--brand-300)" } : undefined} scroll={false}>
            <div className={s.reportTitle}>{r.title}</div>
            <div className={s.reportDesc}>{r.description}</div>
          </Link>
        ))}
      </div>
      {report && reportKey ? (
        <div className={s.runner}>
          <div className={s.runnerHead}>
            <span>{HELPDESK_REPORTS.find((r) => r.key === reportKey)!.title}</span>
            <Link href={reportHref(null)} className={s.link} style={{ fontSize: 14 }} scroll={false}>Close</Link>
          </div>
          <div className={s.runnerDesc}>{HELPDESK_REPORTS.find((r) => r.key === reportKey)!.description} {range.label}.</div>
          {report.rows.length === 0 ? <div className={s.emptySmall}>No tickets in this period.</div> : (
            <div className="table-wrap">
              <table className={s.table}>
                <thead><tr>{report.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {report.rows.map((row, i) => <tr key={i}>{report.columns.map((c) => <td key={c.key} className={typeof row[c.key] === "number" ? s.num : undefined}>{row[c.key]}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatsTable({ title, first, groups }: { title: string; first: string; groups: Array<{ label: string; stats: TicketStats }> }) {
  return (
    <div className={s.panel}>
      <div className={s.chartHead}>{title}</div>
      {groups.length === 0 ? <div className={s.emptySmall}>No tickets in this period.</div> : (
        <div className="table-wrap">
          <table className={s.table}>
            <thead>
              <tr><th>{first}</th><th>Raised</th><th>Open</th><th>Closed</th><th>First response SLA</th><th>Resolution SLA</th><th>Avg first response</th><th>Avg resolution</th><th>Satisfaction</th></tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.label}>
                  <td>{g.label}</td>
                  <td className={s.num}>{g.stats.total}</td>
                  <td className={s.num}>{g.stats.open}</td>
                  <td className={s.num}>{g.stats.closed}</td>
                  <td className={s.num}>{pct(g.stats.firstResponse.attainment)}</td>
                  <td className={s.num}>{pct(g.stats.resolution.attainment)}</td>
                  <td className={s.nowrap}>{dur(g.stats.firstResponse.avgMinutes)}</td>
                  <td className={s.nowrap}>{dur(g.stats.resolution.avgMinutes)}</td>
                  <td className={s.num}>{g.stats.satisfaction.average === null ? "—" : `${g.stats.satisfaction.average} (${g.stats.satisfaction.rated})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
