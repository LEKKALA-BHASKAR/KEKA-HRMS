import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { PdfDoc } from "@keka/documents";
import { getViewer, can } from "@/lib/context";
import { parseFilters, filterOptions, filterLabels, employeeWhere, windowOf, headcountAsOf, analyticsToday } from "@/lib/analytics/filters";
import { population, chartByKey, parseGroupBy, type ChartData } from "@/lib/analytics/data";

/**
 * A chart's export, from the ≡ menu and the raw-data drawer: the chart's
 * figures as CSV ("Excel") or PDF, or the people behind it as CSV. Built
 * from the same filters and the same builder as the card, so it can never
 * show more than the viewer's analytics scope.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.ANALYTICS_VIEW)) return new NextResponse("Forbidden.", { status: 403 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const key = sp.key ?? "";
  const format = sp.format === "pdf" ? "pdf" : sp.format === "raw" ? "raw" : "csv";
  if (!/^[a-z]{2}-[a-z-]{1,40}$/.test(key)) return new NextResponse("Unknown chart.", { status: 404 });

  const f = parseFilters(sp, "12m");
  const today = analyticsToday();
  const w = windowOf(f, today);
  const pop = await population(employeeWhere(viewer, f));
  const chart = chartByKey(key, pop, w, f, {
    measure: sp.m === "pct" ? "pct" : "count", groupBy: parseGroupBy(sp.gb), asOf: headcountAsOf(sp, f, today), today,
  });
  if (!chart) return new NextResponse("Unknown chart.", { status: 404 });

  const range = key.startsWith("hc-") ? `As of ${headcountAsOf(sp, f, today).toISOString().slice(0, 10)}` : `${w.from.toISOString().slice(0, 10)} to ${w.to.toISOString().slice(0, 10)}`;
  const filters = filterLabels(f, await filterOptions(viewer.tenantId));
  const name = `${chart.key}${format === "raw" ? "-raw-data" : ""}`;
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module: "ANALYTICS", action: "EXPORT", entityType: "AnalyticsChart", entityId: chart.key,
      summary: `Exported ${chart.title} (${format === "raw" ? `${chart.raw.length} people` : format.toUpperCase()})`, actorId: viewer.user.id, actorLabel: viewer.user.email,
    },
  });

  if (format === "pdf") {
    return new NextResponse(new Uint8Array(chartPdf(chart, range, filters)), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "no-store" },
    });
  }
  const table = format === "raw" ? rawTable(chart) : chartTable(chart);
  return new NextResponse("\uFEFF" + table.map((r) => r.map(csvCell).join(",")).join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "no-store" },
  });
}

/** Spreadsheet apps execute cells that start with = + - @; neutralise them. */
function csvCell(v: string | number): string {
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The chart's figures: one row per bar, one column per series (and the line, if any). */
function chartTable(c: ChartData): Array<Array<string | number>> {
  const head = [c.xLabel ?? "Label"];
  if (c.series) head.push(...c.series.map((s) => s.label));
  else if (c.rows.some((r) => r.segments?.length)) head.push(...c.rows[0].segments!.map((s) => s.label), "Total");
  else head.push(c.legend ?? c.yLabel ?? "Value");
  if (c.line) head.push(c.line.label);
  const rows = c.rows.map((r, i) => {
    const out: Array<string | number> = [r.label];
    if (c.series) out.push(...c.series.map((s) => s.values[i] ?? 0));
    else if (r.segments?.length) out.push(...r.segments.map((s) => s.value), r.value);
    else out.push(r.value);
    if (c.line) out.push(c.line.values[i] ?? 0);
    return out;
  });
  return [head, ...rows];
}

function rawTable(c: ChartData): Array<Array<string | number>> {
  return [["Employee Name", "Employee Number", c.rawLabel], ...c.raw.map((r) => [r.name, r.number, r.value])];
}

/** A plain one-or-more-page PDF: title, range, filters, then the figures as a table. */
function chartPdf(c: ChartData, range: string, filters: Record<string, string[]>): Buffer {
  const doc = new PdfDoc({ title: c.title });
  const table = chartTable(c);
  const L = 40;
  let pg = doc.page();
  let y = 50;
  pg.text(L, y, c.title, { size: 16, bold: true });
  y += 20;
  pg.text(L, y, range, { size: 9, color: [0.4, 0.4, 0.45] });
  y += 14;
  for (const [k, v] of Object.entries(filters)) { y = pg.paragraph(L, y, `${k}: ${v.join(", ")}`, pg.width - 2 * L, { size: 8.5, color: [0.4, 0.4, 0.45] }); }
  if (c.info) y = pg.paragraph(L, y + 4, c.info, pg.width - 2 * L, { size: 8.5, color: [0.4, 0.4, 0.45] });
  y += 12;
  const cols = table[0].length;
  const first = Math.min(240, (pg.width - 2 * L) * 0.45);
  const rest = cols > 1 ? (pg.width - 2 * L - first) / (cols - 1) : 0;
  const x = (i: number) => (i === 0 ? L : L + first + rest * i);
  table.forEach((row, ri) => {
    if (y > pg.height - 50) { pg = doc.page(); y = 50; }
    if (ri === 0) pg.rect(L, y - 11, pg.width - 2 * L, 16, { fill: [0.95, 0.96, 0.98] });
    row.forEach((cell, ci) => {
      const text = String(cell).slice(0, ci === 0 ? 48 : 18);
      pg.text(ci === 0 ? x(0) + 4 : x(ci) - 4, y, text, { size: 9, bold: ri === 0, align: ci === 0 ? "left" : "right" });
    });
    y += 16;
  });
  if (c.insights?.length) {
    y += 8;
    for (const i of c.insights) { if (y > pg.height - 40) { pg = doc.page(); y = 50; } pg.text(L, y, `${i.label}: ${i.value}`, { size: 9 }); y += 13; }
  }
  return doc.toBuffer();
}
