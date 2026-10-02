import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { getTimesheetPolicy, TIMESHEET_INCREMENTS, APPROVAL_CHAIN_LABEL, incrementLabel } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Stat, KeyValue } from "@/components/ui";
import { SettingsTabs } from "../../billing/nav";
import { TimesheetPolicyForm } from "../forms";

/** Projects › Settings › Timesheets: the limits, rounding, approval chain, auto-approval and reminders every timesheet follows. */
export default async function TimesheetSettingsPage() {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const policy = await getTimesheetPolicy(viewer.tenantId);
  const [lastRun, chased, noApproval] = await Promise.all([
    prisma.jobRun.findFirst({ where: { job: "timesheet-reminders" }, orderBy: { startedAt: "desc" } }),
    prisma.timesheetReminder.groupBy({ by: ["kind"], where: { tenantId: viewer.tenantId, sentAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true } }),
    prisma.project.count({ where: { tenantId: viewer.tenantId, requireTimesheetApproval: false, status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
  ]);
  const count = (k: string) => chased.find((c) => c.kind === k)?._count._all ?? 0;
  return (
    <>
      <PageHead title="Timesheet policy" subtitle="What a week of time must keep to, who approves it, and who is chased when it is late" />
      <SettingsTabs viewer={viewer} active="/projects/settings/timesheets" />
      <div className="stack gap-3">
        <div className="grid grid-3">
          <Stat label="Reminders, last 30 days" value={count("REMINDER")} meta={policy.remindersEnabled ? `${policy.reminderAfterDays} day(s) after the week` : "off"} />
          <Stat label="Escalations, last 30 days" value={count("ESCALATION")} meta={policy.escalationEnabled ? `${policy.escalateAfterDays} day(s) after the week` : "off"} />
          <Stat label="Reminder job last ran" value={lastRun ? formatDate(lastRun.startedAt) : "never"} meta={lastRun ? (lastRun.ok ? "ok" : "failed") : "runs with the nightly jobs"} />
        </div>
        <Card title="In force">
          <KeyValue items={[
            ["Logging", `In ${incrementLabel(policy.incrementMinutes)}; ${policy.rounding === "REJECT" ? "other amounts are refused" : policy.rounding === "UP" ? "other amounts are rounded up" : "other amounts are rounded to the nearest step"}`],
            ["Per day", `At most ${policy.maxHoursPerDay} h${policy.minHoursPerDay !== null ? `, at least ${policy.minHoursPerDay} h on a day worked` : ""}`],
            ["Per week", policy.maxHoursPerWeek === null && policy.minHoursPerWeek === null ? "No limit" : [policy.minHoursPerWeek !== null ? `at least ${policy.minHoursPerWeek} h` : null, policy.maxHoursPerWeek !== null ? `at most ${policy.maxHoursPerWeek} h` : null].filter(Boolean).join(", ")],
            ["Approved by", APPROVAL_CHAIN_LABEL[policy.approvalChain]],
            ["Auto-approval", policy.autoApprove ? (policy.autoApproveMaxHours === null ? "Every submitted week" : `Weeks of up to ${policy.autoApproveMaxHours} h`) : `Off${noApproval ? ` (except ${noApproval} project(s) that need no approval)` : ""}`],
          ]} />
        </Card>
        <Card title="Edit the policy">
          <TimesheetPolicyForm policy={policy} increments={TIMESHEET_INCREMENTS} chains={Object.entries(APPROVAL_CHAIN_LABEL).map(([value, label]) => ({ value, label }))} />
        </Card>
      </div>
    </>
  );
}
