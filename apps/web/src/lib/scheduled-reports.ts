import "server-only";
import { prisma } from "@keka/db";
import { nextReportRun, safeCsv } from "@keka/services";
import { viewerForUser } from "./context";
import { REPORTS, defaultParams, formatCell } from "./reports";
import { savedReportFor, specOf, runCustomReport } from "./report-builder";
import { ASSET_REPORTS } from "@/app/(app)/assets/_reports";

/**
 * Scheduled report delivery (job "scheduled-reports"). Each ScheduledReport
 * names a report by key:
 *   - "asset-…"      an asset report (tenant-wide, Assets › Reports),
 *   - "saved:<id>"   a custom report from the report builder,
 *   - anything else  a standard report from /reports.
 * Standard and custom reports run as the person who scheduled them, through
 * their own scope, so a schedule never mails rows its owner could not see —
 * and stops once the owner's login is disabled or loses the permission.
 * The CSV goes into the email outbox, one message per recipient.
 */

/** Inline CSV beyond this is cut, with a note to download the rest. */
const MAX_CSV_CHARS = 400_000;

export interface ReportCsv { title: string; csv: string; rows: number }

/** The CSV a schedule would send now, or why it cannot run. */
export async function scheduledReportCsv(s: { tenantId: string; reportKey: string; createdBy: string | null; params: unknown }): Promise<ReportCsv | { error: string }> {
  if (s.reportKey.startsWith("asset-")) {
    const def = ASSET_REPORTS.find((r) => r.key === s.reportKey);
    if (!def) return { error: `Unknown asset report ${s.reportKey}` };
    const { columns, rows } = await def.run(s.tenantId, new Date());
    return { title: def.title, rows: rows.length, csv: safeCsv(columns.map((c) => c.label), rows.map((r) => columns.map((c) => r[c.key]))) };
  }

  const viewer = s.createdBy ? await viewerForUser(s.createdBy) : null;
  if (!viewer || viewer.tenantId !== s.tenantId) return { error: "The person who scheduled this report no longer has an active login." };

  if (s.reportKey.startsWith("saved:")) {
    const saved = await savedReportFor(viewer, s.reportKey.slice(6));
    if (!saved) return { error: "The saved report was deleted or is no longer shared with its scheduler." };
    const result = await runCustomReport(viewer, specOf(saved));
    if (!result.ok) return { error: result.errors.join(" ") };
    const cell = (v: unknown, f?: Parameters<typeof formatCell>[1]) => (typeof v === "boolean" ? (v ? "Yes" : "No") : formatCell(v, f));
    return {
      title: saved.name, rows: result.rows.length,
      csv: safeCsv(result.columns.map((c) => c.label), result.rows.map((r) => result.columns.map((c) => cell(r[c.key], c.format)))),
    };
  }

  const report = REPORTS.find((r) => r.key === s.reportKey);
  if (!report) return { error: `Unknown report ${s.reportKey}` };
  if (!viewer.permissions.has(report.permission)) return { error: `The scheduler no longer has access to ${report.title}.` };
  const p = (s.params ?? {}) as { fy?: string; month?: string };
  const result = await report.run(viewer, defaultParams(viewer, { fy: p.fy, month: p.month }));
  const rows = result.rows.map((r) => result.columns.map((c) => formatCell(r[c.key], c.format)));
  if (result.totals) rows.push(result.columns.map((c) => formatCell(result.totals![c.key], c.format)));
  return { title: report.title, rows: result.rows.length, csv: safeCsv(result.columns.map((c) => c.label), rows) };
}

function clip(csv: string): { body: string; clipped: boolean } {
  if (csv.length <= MAX_CSV_CHARS) return { body: csv, clipped: false };
  const cut = csv.lastIndexOf("\r\n", MAX_CSV_CHARS);
  return { body: csv.slice(0, cut > 0 ? cut : MAX_CSV_CHARS), clipped: true };
}

/**
 * Send every schedule that is due. Idempotent across overlapping runs: a
 * schedule is claimed by moving its next run forward before anything is
 * sent, so two workers never mail the same report twice.
 */
export async function runScheduledReports(now: Date = new Date(), opts: { ids?: string[] } = {}) {
  const due = await prisma.scheduledReport.findMany({
    // A schedule mailing outside the company runs only once it is approved.
    where: { isActive: true, nextRunAt: { lte: now }, OR: [{ approvalStatus: null }, { approvalStatus: "APPROVED" }], ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: { nextRunAt: "asc" }, take: 200,
  });
  let sent = 0, emails = 0, failed = 0;
  for (const s of due) {
    const next = nextReportRun(s.frequency, s.dayOfWeek, s.dayOfMonth, now);
    const claimed = await prisma.scheduledReport.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: next } });
    if (claimed.count === 0) continue;
    const recipients = (Array.isArray(s.recipients) ? s.recipients : []).filter((r): r is string => typeof r === "string" && r.includes("@"));
    let status: string;
    const startedAt = Date.now();
    let runRows = 0, runTitle = s.name;
    try {
      const out = recipients.length ? await scheduledReportCsv(s) : { error: "No recipients." };
      if ("error" in out) {
        status = `Failed: ${out.error}`;
        failed++;
      } else {
        const { body, clipped } = clip(out.csv);
        const day = now.toISOString().slice(0, 10);
        await prisma.emailOutbox.createMany({
          data: recipients.map((to) => ({
            tenantId: s.tenantId, toAddress: to, subject: `${s.name} — ${day}`,
            textBody: `${out.title}: ${out.rows} row(s), as of ${day}. The CSV follows; save the lines below as a .csv file to open it in a spreadsheet.` +
              `${clipped ? " The report is larger than an email allows, so it is cut short here; download it in full from BooS-HR." : ""}\n\n${body}`,
            relatedType: "ScheduledReport", relatedId: s.id,
          })),
        });
        runRows = out.rows; runTitle = out.title;
        status = `Sent ${out.rows} row(s) to ${recipients.length} recipient(s)${clipped ? " (cut short)" : ""}`;
        sent++;
        emails += recipients.length;
      }
    } catch (err) {
      status = `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
      failed++;
    }
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { lastRunAt: now, lastStatus: status } });
    // Execution history (Insights › Reports › History).
    await prisma.insightReportRun.create({
      data: { tenantId: s.tenantId, reportKey: s.reportKey.slice(0, 120), title: runTitle.slice(0, 200), trigger: "SCHEDULE", format: "CSV", rows: runRows, durationMs: Date.now() - startedAt, status: status.startsWith("Failed") ? "FAILED" : "OK", error: status.startsWith("Failed") ? status.slice(8, 500) : null, userId: s.createdBy },
    });
  }
  return { due: due.length, sent, emails, failed };
}
