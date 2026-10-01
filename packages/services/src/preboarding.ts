import { prisma } from "@keka/db";
import { notify } from "./lifecycle";

/**
 * Preboarding and background verification. A hire whose joining date is in
 * the future is created as PREBOARDING: invited to the portal to fill in
 * their profile and documents, but kept out of payroll and headcount. HR
 * marks them joined on the day (which starts probation), or records that
 * they did not join. Background checks are tracked per employee: who runs
 * them, which checks, and the outcome.
 */

export const BGV_CHECKS = ["IDENTITY", "ADDRESS", "EDUCATION", "EMPLOYMENT", "CRIMINAL", "CREDIT", "REFERENCE"] as const;
export type BgvCheckType = (typeof BGV_CHECKS)[number];
export const BGV_STATUSES = ["INITIATED", "IN_PROGRESS", "CLEAR", "DISCREPANCY", "FAILED", "CANCELLED"] as const;
export type BgvStatus = (typeof BGV_STATUSES)[number];
const OPEN: BgvStatus[] = ["INITIATED", "IN_PROGRESS"];
const LABEL: Record<BgvStatus, string> = { INITIATED: "started", IN_PROGRESS: "in progress", CLEAR: "clear", DISCREPANCY: "flagged with a discrepancy", FAILED: "failed", CANCELLED: "cancelled" };

type R = { ok: boolean; message: string };
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function markJoined(input: { tenantId: string; employeeId: string; joinedOn: Date; today?: Date }): Promise<R> {
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, status: true, displayName: true, dateOfJoining: true, userId: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.status !== "PREBOARDING") return { ok: false, message: `${emp.displayName} is not preboarding.` };
  const joined = day(input.joinedOn), today = day(input.today ?? new Date());
  if (joined > today) return { ok: false, message: "They can be marked joined on or after the day they join." };
  if (joined.getTime() < today.getTime() - 31 * 86_400_000) return { ok: false, message: "That joining date is more than a month ago. Correct it on the profile instead." };
  await prisma.employee.update({ where: { id: emp.id }, data: { status: "PROBATION", dateOfJoining: joined } });
  const moved = joined.getTime() !== day(emp.dateOfJoining).getTime();
  return { ok: true, message: `${emp.displayName} has joined${moved ? `; joining date set to ${joined.toISOString().slice(0, 10)}` : ""}. Probation starts now.` };
}

export async function markNoShow(input: { tenantId: string; employeeId: string; reason: string }): Promise<R> {
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, status: true, displayName: true, userId: true, dateOfJoining: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.status !== "PREBOARDING") return { ok: false, message: `${emp.displayName} is not preboarding.` };
  if (!input.reason.trim()) return { ok: false, message: "Give a reason." };
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: emp.id }, data: { status: "EXITED", lastWorkingDay: emp.dateOfJoining } });
    if (emp.userId) await tx.user.update({ where: { id: emp.userId }, data: { loginDisabled: true } });
    await tx.journey.updateMany({ where: { employeeId: emp.id, status: "ACTIVE" }, data: { status: "CANCELLED" } });
    await tx.bgvCheck.updateMany({ where: { employeeId: emp.id, status: { in: OPEN } }, data: { status: "CANCELLED", completedAt: new Date(), findings: `Did not join: ${input.reason.trim()}` } });
  });
  return { ok: true, message: `Recorded that ${emp.displayName} did not join. Their portal access is switched off.` };
}

export async function initiateBgv(input: { tenantId: string; employeeId: string; vendor: string | null; checks: string[] }): Promise<R & { id?: string }> {
  const checks = [...new Set(input.checks)].filter((c): c is BgvCheckType => (BGV_CHECKS as readonly string[]).includes(c));
  if (checks.length === 0) return { ok: false, message: "Pick at least one check." };
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { id: true, displayName: true, status: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.status === "EXITED") return { ok: false, message: `${emp.displayName} has left.` };
  const open = await prisma.bgvCheck.findFirst({ where: { employeeId: emp.id, status: { in: OPEN } }, select: { id: true } });
  if (open) return { ok: false, message: `A background check for ${emp.displayName} is already under way.` };
  const row = await prisma.bgvCheck.create({ data: { tenantId: input.tenantId, employeeId: emp.id, vendor: input.vendor?.trim() || null, checkTypes: checks, status: "INITIATED" } });
  return { ok: true, id: row.id, message: `Background check started for ${emp.displayName}: ${checks.map((c) => c.toLowerCase()).join(", ")}.` };
}

export async function updateBgv(input: { tenantId: string; id: string; status: BgvStatus; findings: string | null; reportUrl?: string | null; notifyUserIds?: string[] }): Promise<R> {
  if (!(BGV_STATUSES as readonly string[]).includes(input.status)) return { ok: false, message: "Pick a status." };
  const row = await prisma.bgvCheck.findFirst({ where: { id: input.id, tenantId: input.tenantId }, include: { employee: { select: { displayName: true } } } });
  if (!row) return { ok: false, message: "Background check not found." };
  if (!OPEN.includes(row.status as BgvStatus)) return { ok: false, message: `This check is already closed as ${LABEL[row.status as BgvStatus] ?? row.status.toLowerCase()}.` };
  if ((input.status === "DISCREPANCY" || input.status === "FAILED") && !input.findings?.trim()) return { ok: false, message: "Describe what was found." };
  const closes = !OPEN.includes(input.status);
  await prisma.bgvCheck.update({
    where: { id: row.id },
    data: { status: input.status, findings: input.findings?.trim() || row.findings, reportUrl: input.reportUrl ?? row.reportUrl, completedAt: closes ? new Date() : null },
  });
  if (closes && input.status !== "CLEAR" && input.status !== "CANCELLED" && input.notifyUserIds?.length) {
    await notify({ tenantId: input.tenantId, userIds: input.notifyUserIds, kind: "LIFECYCLE", title: `Background check ${input.status.toLowerCase()}: ${row.employee?.displayName}`, body: input.findings, link: "/onboarding/preboarding" });
  }
  return { ok: true, message: `Background check for ${row.employee?.displayName ?? "the employee"} is now ${LABEL[input.status]}.` };
}
