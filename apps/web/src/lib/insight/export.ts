import "server-only";
import { prisma } from "@keka/db";
import { safeCsv } from "@keka/services";
import { renderXlsx, renderTableReport } from "@keka/documents";
import type { Viewer } from "@/lib/context";

/**
 * Insight tables: one shape for every on-screen insight table and its
 * download, so the screen and the file never disagree. Downloads come as CSV,
 * Excel (.xlsx) or PDF, each logged as a report run and an audit EXPORT.
 */

export type CellFormat = "text" | "int" | "num" | "pct" | "inr" | "date";
export interface InsightColumn { key: string; label: string; format?: CellFormat }
export interface InsightTable { title: string; columns: InsightColumn[]; rows: Array<Record<string, unknown>>; notes?: string[] }
export type ExportFormat = "csv" | "xlsx" | "pdf";
export const isExportFormat = (f: unknown): f is ExportFormat => f === "csv" || f === "xlsx" || f === "pdf";

/** Plain text of one cell (CSV and PDF); percentages are already in percent. */
export function cellText(v: unknown, f: CellFormat = "text"): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (f === "pct") return `${Math.round(v * 10) / 10}%`;
    if (f === "int") return String(Math.round(v));
    if (f === "inr") return v.toFixed(2);
    return String(Math.round(v * 100) / 100);
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Excel keeps numbers numeric. */
function xlsxCell(v: unknown, f: CellFormat = "text"): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && f !== "date") return Math.round(v * 10000) / 10000;
  return cellText(v, f);
}

export function renderTable(t: InsightTable, format: ExportFormat, company: string): { body: Buffer; contentType: string; ext: string } {
  if (format === "xlsx") {
    return {
      body: renderXlsx([{ name: t.title, columns: t.columns.map((c) => c.label), rows: t.rows.map((r) => t.columns.map((c) => xlsxCell(r[c.key], c.format))) }]),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx",
    };
  }
  if (format === "pdf") {
    return {
      body: renderTableReport({
        title: t.title, subtitle: `Generated ${new Date().toISOString().slice(0, 10)} · ${t.rows.length} row(s)`, company,
        sections: [{ heading: t.title, columns: t.columns.map((c) => ({ label: c.label, numeric: !!c.format && c.format !== "text" && c.format !== "date" })), rows: t.rows.slice(0, 2000).map((r) => t.columns.map((c) => cellText(r[c.key], c.format))) }],
        notes: [...(t.notes ?? []), ...(t.rows.length > 2000 ? ["Only the first 2,000 rows are printed; download Excel for the rest."] : [])],
      }),
      contentType: "application/pdf", ext: "pdf",
    };
  }
  return {
    body: Buffer.from("﻿" + safeCsv(t.columns.map((c) => c.label), t.rows.map((r) => t.columns.map((c) => cellText(r[c.key], c.format)))), "utf8"),
    contentType: "text/csv; charset=utf-8", ext: "csv",
  };
}

/** Record a report execution (screen, export, schedule, snapshot). */
export async function recordReportRun(viewer: Viewer | null, tenantId: string, d: { reportKey: string; title: string; trigger: "SCREEN" | "EXPORT" | "SCHEDULE" | "SNAPSHOT"; format?: string | null; rows: number; startedAt: number; error?: string | null }) {
  await prisma.insightReportRun.create({
    data: {
      tenantId, reportKey: d.reportKey.slice(0, 120), title: d.title.slice(0, 200), trigger: d.trigger, format: d.format?.toUpperCase() ?? null,
      rows: d.rows, durationMs: Math.max(0, Date.now() - d.startedAt), status: d.error ? "FAILED" : "OK", error: d.error ?? null, userId: viewer?.user.id ?? null,
    },
  });
}

/** Stream a table as a download, with the run and the audit recorded. */
export async function downloadTable(viewer: Viewer, reportKey: string, t: InsightTable, format: ExportFormat, startedAt: number, module: "REPORT" | "ANALYTICS" | "EMPLOYEE" = "REPORT"): Promise<Response> {
  const out = renderTable(t, format, viewer.tenant.name);
  await recordReportRun(viewer, viewer.tenantId, { reportKey, title: t.title, trigger: "EXPORT", format, rows: t.rows.length, startedAt });
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId, module, action: "EXPORT", entityType: "Report", entityId: reportKey.slice(0, 120),
      summary: `Exported ${t.title} as ${format.toUpperCase()} (${t.rows.length} rows)`, actorId: viewer.user.id, actorLabel: viewer.user.email,
    },
  });
  const name = `${reportKey.replace(/[^a-z0-9-]+/gi, "-").slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.${out.ext}`;
  return new Response(new Uint8Array(out.body), { headers: { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
