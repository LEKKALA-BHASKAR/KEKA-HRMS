import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { journeyProgress } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { Badge, Progress } from "@/components/ui";
import { TaskControls, RecheckButton } from "./forms";

const DAY = 86_400_000;
const OWNER_TONE: Record<string, "info" | "neutral" | "warning" | "success"> = {
  HR: "info", MANAGER: "warning", EMPLOYEE: "success", IT: "neutral", FINANCE: "neutral", ADMIN: "neutral",
};

/**
 * A journey's tasks on a timeline relative to its anchor date, each with the
 * controls the viewer is actually allowed to use.
 */
export async function JourneyChecklist({ journeyId, viewer, anchorLabel }: { journeyId: string; viewer: Viewer; anchorLabel: string }) {
  const journey = await prisma.journey.findFirst({
    where: { id: journeyId, tenantId: viewer.tenantId },
    include: {
      tasks: { orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }] },
      employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } },
    },
  });
  if (!journey) return null;
  const assigneeIds = [...new Set(journey.tasks.map((t) => t.assigneeEmployeeId).filter((x): x is string => !!x))];
  const assignees = new Map((await prisma.employee.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
  const perm = journey.trigger === "EXIT" ? PERMISSIONS.EXIT_MANAGE : PERMISSIONS.ONBOARDING_MANAGE;
  const manages = can(viewer, perm) && canAccessEmployee(viewer, journey.employee, perm);
  const p = journeyProgress(journey.tasks);
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));

  const groups: Array<[string, typeof journey.tasks]> = [
    [`Before ${anchorLabel}`, journey.tasks.filter((t) => t.dueDate < journey.anchorDate)],
    [`On ${anchorLabel}`, journey.tasks.filter((t) => t.dueDate.getTime() === journey.anchorDate.getTime())],
    [`After ${anchorLabel}`, journey.tasks.filter((t) => t.dueDate > journey.anchorDate)],
  ];

  return (
    <div>
      <div className="row gap-3" style={{ justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border)", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <span className="strong text-sm">{p.pct}% complete</span>
            <span className="text-xs muted">{p.done} of {p.total} · {p.requiredLeft} required left{p.overdue ? ` · ${p.overdue} overdue` : ""}</span>
          </div>
          <Progress value={p.done} max={Math.max(1, p.total)} tone={p.overdue ? "warning" : "success"} />
        </div>
        {manages && journey.status === "ACTIVE" ? <RecheckButton journeyId={journey.id} /> : null}
        {journey.status !== "ACTIVE" ? <Badge tone={journey.status === "COMPLETED" ? "success" : "neutral"}>{journey.status.toLowerCase()}</Badge> : null}
      </div>
      {groups.filter(([, ts]) => ts.length > 0).map(([title, ts]) => (
        <div key={title}>
          <div className="text-xs strong subtle" style={{ padding: "10px 18px 4px", textTransform: "uppercase", letterSpacing: ".04em" }}>{title}</div>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {ts.map((t) => {
                  const overdue = t.status === "PENDING" && t.dueDate < today;
                  const mine = t.assigneeEmployeeId === viewer.employee?.id;
                  const offset = Math.round((t.dueDate.getTime() - journey.anchorDate.getTime()) / DAY);
                  return (
                    <tr key={t.id} style={t.status !== "PENDING" ? { opacity: 0.65 } : undefined}>
                      <td style={{ width: 28 }}>
                        {t.status === "DONE" ? <span className="pos strong">✓</span> : t.status === "SKIPPED" ? <span className="subtle">–</span> : <span className="subtle">○</span>}
                      </td>
                      <td>
                        <div className={t.status === "DONE" ? "muted" : "strong text-sm"} style={t.status === "DONE" ? { textDecoration: "line-through" } : undefined}>{t.title}</div>
                        <div className="text-xs subtle">
                          {t.category.toLowerCase()}
                          {t.autoCheck ? ` · verified by the system (${t.autoCheck.replace(/_/g, " ").toLowerCase()})` : ""}
                          {!t.isRequired ? " · optional" : ""}
                        </div>
                        {t.note ? <div className="text-xs muted" style={{ marginTop: 2 }}>{t.note}</div> : null}
                        {t.needsApproval || t.escalationLevel || t.delegatedFromEmployeeId ? (
                          <div className="row gap-1" style={{ marginTop: 2 }}>
                            {t.needsApproval ? <Badge tone={t.approvalStatus === "APPROVED" ? "success" : t.approvalStatus === "REJECTED" ? "danger" : t.approvalStatus === "PENDING" ? "warning" : "neutral"}>{t.approvalStatus === "PENDING" ? "awaiting sign-off" : t.approvalStatus === "REJECTED" ? "sign-off refused" : t.approvalStatus === "APPROVED" ? "signed off" : "needs sign-off"}</Badge> : null}
                            {t.escalationLevel ? <Badge tone="danger">escalated L{t.escalationLevel}</Badge> : null}
                            {t.delegatedFromEmployeeId ? <Badge>handed over</Badge> : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="nowrap">
                        <Badge tone={OWNER_TONE[t.owner]}>{t.owner.toLowerCase()}</Badge>
                        {t.assigneeEmployeeId ? <div className="text-xs subtle" style={{ marginTop: 2 }}>{mine ? "you" : assignees.get(t.assigneeEmployeeId)}</div> : null}
                      </td>
                      <td className="nowrap text-sm">
                        <span className={overdue ? "neg strong" : "muted"}>{formatDate(t.dueDate)}</span>
                        <div className="text-xs subtle">day {offset >= 0 ? `+${offset}` : offset}</div>
                      </td>
                      <td className="right">
                        {journey.status !== "CANCELLED" && (manages || mine)
                          ? <TaskControls taskId={t.id} status={t.status} required={t.isRequired} auto={!!t.autoCheck} />
                          : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
