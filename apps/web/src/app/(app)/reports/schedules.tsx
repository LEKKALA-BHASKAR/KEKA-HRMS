import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { Card, Badge } from "@/components/ui";
import { ScheduleReportForm, StopScheduleButton } from "../_lifecycle/core-hr-forms";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * "Email this report": schedules for one report key (a standard report, or
 * "saved:<id>" for a custom one). People see their own schedules; an
 * administrator sees everyone's for the report.
 */
export async function ReportSchedules({ viewer, reportKey, title }: { viewer: Viewer; reportKey: string; title: string }) {
  const admin = can(viewer, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const rows = await prisma.scheduledReport.findMany({
    where: { tenantId: viewer.tenantId, reportKey, ...(admin ? {} : { createdBy: viewer.user.id }) },
    orderBy: { createdAt: "asc" },
  });
  const cadence = (r: (typeof rows)[number]) =>
    r.frequency === "DAILY" ? "Daily" : r.frequency === "WEEKLY" ? `Weekly on ${DAYS[r.dayOfWeek ?? 1]}` : `Monthly on day ${r.dayOfMonth ?? 1}`;
  return (
    <Card tight title="Email this report" description="Send the CSV to a list of people on a schedule.">
      {rows.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Schedule</th><th>Recipients</th><th>Next</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm"><strong>{r.name}</strong><div className="text-xs subtle">{cadence(r)}{r.isActive ? "" : " · paused"}</div></td>
                  <td className="text-xs">{(Array.isArray(r.recipients) ? r.recipients : []).join(", ")}</td>
                  <td className="text-sm nowrap">{formatDate(r.nextRunAt)}</td>
                  <td className="text-xs">
                    {r.lastRunAt ? <>{formatDate(r.lastRunAt)} <Badge tone={r.lastStatus?.startsWith("Failed") ? "danger" : "success"}>{r.lastStatus?.startsWith("Failed") ? "failed" : "sent"}</Badge><div className="subtle">{r.lastStatus}</div></> : <span className="subtle">not yet</span>}
                  </td>
                  <td className="right"><StopScheduleButton id={r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ScheduleReportForm reportKey={reportKey} defaultName={title} />
    </Card>
  );
}
