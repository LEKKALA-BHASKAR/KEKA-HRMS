import "server-only";
import { prisma } from "@keka/db";
import { externalRecipients, startWorkflow } from "@keka/services";
import type { Viewer } from "@/lib/context";

/** Email domains that count as "inside the company": those of the company's own logins. */
export async function companyDomains(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { tenantId, isDeactivated: false }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d))];
}

/**
 * A schedule that mails anyone outside the company waits for a report
 * administrator's approval (REPORT_SCHEDULE) before it runs. Returns the
 * message to show when it was sent for approval, or null when it can run.
 */
export async function routeExternalSchedule(viewer: Viewer, scheduleId: string, name: string, emails: string[]): Promise<string | null> {
  const outside = externalRecipients(emails, await companyDomains(viewer.tenantId));
  if (!outside.length) {
    await prisma.scheduledReport.updateMany({ where: { id: scheduleId, tenantId: viewer.tenantId, approvalStatus: { not: null } }, data: { approvalStatus: null, workflowRequestId: null } });
    return null;
  }
  await prisma.scheduledReport.update({ where: { id: scheduleId }, data: { approvalStatus: "PENDING", isActive: false } });
  const wf = await startWorkflow({
    tenantId: viewer.tenantId, entityType: "REPORT_SCHEDULE", entityId: scheduleId, title: `Schedule "${name}" mails outside the company`,
    details: `External recipients: ${outside.join(", ")}`, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null,
    data: { link: "/insights/reports?tab=schedules" },
  });
  if (!wf.ok) return `Saved, but the approval could not start: ${wf.message}`;
  await prisma.scheduledReport.update({ where: { id: scheduleId }, data: { workflowRequestId: wf.requestId ?? null } });
  return `Saved. ${outside.length} recipient(s) are outside the company, so the schedule waits for a report administrator's approval.`;
}
