import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { toCsv, delegatorsOf } from "@keka/services";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "./storage";
import { viewerForUser, can, type Viewer } from "./context";
import { scopedEmployeeWhere } from "./scope";

/**
 * Shared bits for the money pages (expenses, travel, loans, benefits,
 * compensation): file uploads stored against the viewer, and CSV exports
 * recorded in the audit log under the right module.
 */

/** Store an uploaded file; null when none was chosen. Throws a readable message on a bad file. */
export async function storeUpload(viewer: Viewer, file: FormDataEntryValue | null, relatedType: string, employeeId: string | null): Promise<{ url: string; data: Buffer; mimeType: string } | null> {
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Files are limited to 10 MB.");
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok) throw new Error(sniff.reason);
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name, mimeType: sniff.mimeType, data, relatedType, employeeId, uploadedBy: viewer.user.id });
  return { url: `/files/${stored.id}`, data, mimeType: sniff.mimeType };
}

export async function moneyCsv(viewer: Viewer, opts: { module: "FINANCE" | "PAYROLL" | "EMPLOYEE"; filename: string; head: string[]; rows: unknown[][]; entityType: string; summary: string }) {
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: opts.module, action: "EXPORT", entityType: opts.entityType, summary: opts.summary, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(toCsv(opts.head, opts.rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${opts.filename}"`, "Cache-Control": "no-store" },
  });
}

/** yyyy-mm-dd query parameter to a date, or null. */
export function qDate(v: string | string[] | null | undefined): Date | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
}

export const qStr = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;

/**
 * Expense claims and loan requests waiting on someone who delegated their
 * approvals to the viewer, so the delegate can find them.
 */
export async function delegatedQueues(viewer: Viewer) {
  const claims = new Map<string, { id: string; claimNumber: string; title: string; claimedTotal: unknown; employee: { displayName: string | null } }>();
  const loans = new Map<string, { id: string; principal: unknown; employee: { displayName: string | null }; category: { name: string } }>();
  for (const userId of await delegatorsOf(viewer.tenantId, viewer.user.id, "EXPENSE_CLAIM")) {
    const v = await viewerForUser(userId);
    if (!v || !can(v, PERMISSIONS.EXPENSE_APPROVE)) continue;
    const rows = await prisma.expenseClaim.findMany({ where: { tenantId: viewer.tenantId, stage: "SUBMITTED", employee: scopedEmployeeWhere(v, PERMISSIONS.EXPENSE_APPROVE), NOT: [{ employeeId: v.employee?.id ?? "__" }, { employeeId: viewer.employee?.id ?? "__" }] }, include: { employee: { select: { displayName: true } } }, take: 50 });
    for (const r of rows) claims.set(r.id, r);
  }
  for (const userId of await delegatorsOf(viewer.tenantId, viewer.user.id, "LOAN_REQUEST")) {
    const v = await viewerForUser(userId);
    if (!v || !can(v, PERMISSIONS.LOAN_APPROVE)) continue;
    const rows = await prisma.loan.findMany({ where: { status: { in: ["REQUESTED", "PENDING_APPROVAL"] }, employee: scopedEmployeeWhere(v, PERMISSIONS.LOAN_APPROVE), NOT: { employeeId: viewer.employee?.id ?? "__" } }, include: { employee: { select: { displayName: true } }, category: { select: { name: true } } }, take: 50 });
    for (const r of rows) loans.set(r.id, r);
  }
  return { claims: [...claims.values()], loans: [...loans.values()] };
}

export const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
