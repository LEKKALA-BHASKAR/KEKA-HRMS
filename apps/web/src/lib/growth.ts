import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@keka/db";
import { canAccessEmployee, type Permission } from "@keka/rbac";
import { toCsv } from "@keka/services";
import type { Viewer } from "./context";

/**
 * Shared checks for the growth modules (learning, succession, mobility,
 * skills, coaching): who reaches whom, and the CSV download every report
 * offers.
 */

const TARGET = { id: true, userId: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, status: true, dateOfJoining: true } as const;

/** An employee of the viewer's company, with what scope checks need. */
export async function employeeOf(viewer: Viewer, employeeId: string) {
  if (!employeeId) return null;
  return prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: TARGET });
}

/** In the viewer's reporting line (direct or indirect)? */
export const inLine = (viewer: Viewer, employeeId: string) => viewer.allReportIds.has(employeeId);

/**
 * Can the viewer act on this person's behalf in a growth workflow — as their
 * line manager, or through the permission within its scope? Never on themselves.
 */
export async function reaches(viewer: Viewer, employeeId: string, permission: Permission): Promise<boolean> {
  if (employeeId === viewer.employee?.id) return false;
  if (inLine(viewer, employeeId)) return true;
  const t = await employeeOf(viewer, employeeId);
  return !!t && canAccessEmployee(viewer, t, permission);
}

/** The same, for a list: every id must be reachable. Returns those that are not. */
export async function unreachable(viewer: Viewer, employeeIds: string[], permission: Permission): Promise<string[]> {
  const out: string[] = [];
  for (const id of employeeIds) if (!(await reaches(viewer, id, permission))) out.push(id);
  return out;
}

/** A CSV download, recorded in the audit log as an export. */
export async function csvDownload(viewer: Viewer, opts: { filename: string; head: string[]; rows: unknown[][]; entityType: string; summary: string }) {
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: opts.entityType, summary: opts.summary, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(toCsv(opts.head, opts.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${opts.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Text from a form field, trimmed and capped. */
export const field = (f: FormData, k: string, max = 2000) => String(f.get(k) ?? "").trim().slice(0, max);

/** A yyyy-mm-dd date from a form, or null. */
export function dateField(f: FormData, k: string): Date | null {
  const v = field(f, k, 40);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A whole number from a form within bounds, or null when blank. Undefined means invalid. */
export function intField(f: FormData, k: string, min: number, max: number): number | null | undefined {
  const v = field(f, k, 20);
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** The title of a prerequisite course this person has not completed, if any. */
export async function missingPrerequisite(prerequisiteCourseId: string | null, employeeId: string): Promise<string | null> {
  if (!prerequisiteCourseId) return null;
  const pre = await prisma.course.findUnique({ where: { id: prerequisiteCourseId }, select: { title: true, enrolments: { where: { employeeId, status: "COMPLETED" }, select: { id: true } } } });
  return pre && pre.enrolments.length === 0 ? pre.title : null;
}
