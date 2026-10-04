import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { capacityStatus, suggestInterviewers } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { saveCapacityAction } from "@/app/actions/hire-interviews";
import { EmployeeHireTabs } from "../../_parts/employee-tabs";

export const metadata = { title: "Interviewer capacity · Hire" };

/**
 * Interviewer capacity: how many interviews each interviewer has this week
 * and today against their limits, and who has room for the next panel.
 */
export default async function InterviewerCapacityPage() {
  const viewer = await requireAuth(PERMISSIONS.INTERVIEW_MANAGE);
  const now = new Date();
  const weekStart = new Date(now); weekStart.setUTCHours(0, 0, 0, 0); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const recent = new Date(now.getTime() - 120 * 86_400_000);
  const [panel, caps] = await Promise.all([
    prisma.interviewPanelist.findMany({ where: { interview: { application: { tenantId: viewer.tenantId }, scheduledAt: { gte: recent }, status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] } } }, select: { employeeId: true, interview: { select: { scheduledAt: true } }, employee: { select: { displayName: true } } } }),
    prisma.interviewerCapacity.findMany({ where: { tenantId: viewer.tenantId } }),
  ]);
  const people = new Map<string, { id: string; name: string; scheduled: number; today: number }>();
  for (const p of panel) {
    const row = people.get(p.employeeId) ?? { id: p.employeeId, name: p.employee.displayName ?? "Interviewer", scheduled: 0, today: 0 };
    const at = p.interview.scheduledAt;
    if (at >= weekStart && at < weekEnd) row.scheduled++;
    if (at >= dayStart && at < dayEnd) row.today++;
    people.set(p.employeeId, row);
  }
  const capEmps = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: caps.map((c) => c.employeeId) } }, select: { id: true, displayName: true } });
  for (const e of capEmps) if (!people.has(e.id)) people.set(e.id, { id: e.id, name: e.displayName ?? "Interviewer", scheduled: 0, today: 0 });
  const cap = new Map(caps.map((c) => [c.employeeId, c]));
  const rows = [...people.values()].map((p) => ({ ...p, cap: cap.get(p.id) ?? null, status: capacityStatus(p.scheduled, p.today, cap.get(p.id) ?? null) })).sort((a, b) => Number(b.status.over) - Number(a.status.over) || b.scheduled - a.scheduled);
  const suggestions = suggestInterviewers(rows.filter((r) => r.cap?.isActive !== false).map((r) => ({ id: r.id, name: r.name, scheduled: r.scheduled, maxPerWeek: r.cap?.maxPerWeek ?? 5 })), 5);
  const employees = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { not: "EXITED" } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 1000 });
  return (
    <>
      <EmployeeHireTabs viewer={viewer} />
      <PageHead title="Interviewer capacity" subtitle="Interviews this week and today against each interviewer's limit (default 5 a week, 2 a day)." />
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card tight>
          {rows.length === 0 ? <Empty title="No interviewers yet" /> : (
            <table className="data" data-testid="capacity-table"><thead><tr><th>Interviewer</th><th>This week</th><th>Today</th><th>Limit</th><th /></tr></thead><tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td>{r.scheduled}</td><td>{r.today}</td><td>{r.cap ? `${r.cap.maxPerWeek}/wk · ${r.cap.maxPerDay}/day` : "default"}</td>
                  <td><Badge tone={r.status.over ? "danger" : r.status.free === 0 ? "warning" : "success"}>{r.status.label}</Badge></td></tr>
              ))}
            </tbody></table>
          )}
        </Card>
        <div className="stack gap-3">
          <Card title="Suggested for the next panel">
            {suggestions.length === 0 ? <div className="text-sm subtle">Everyone is at capacity this week.</div> : <ol className="text-sm">{suggestions.map((s) => <li key={s.id}>{s.name} — {s.maxPerWeek - s.scheduled} slot(s) free</li>)}</ol>}
          </Card>
          <Card title="Set a limit">
            <Reveal label="Set capacity" open>
              <GrowthForm action={saveCapacityAction} cols={3} fields={[
                { name: "employeeId", label: "Interviewer", type: "select", required: true, options: employees.map((e) => ({ value: e.id, label: e.displayName ?? e.id })) },
                { name: "maxPerWeek", label: "Per week", type: "number", defaultValue: 5, required: true },
                { name: "maxPerDay", label: "Per day", type: "number", defaultValue: 2, required: true },
              ]} />
            </Reveal>
          </Card>
        </div>
      </div>
    </>
  );
}
