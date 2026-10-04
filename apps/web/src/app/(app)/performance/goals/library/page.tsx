import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { SubTabs } from "@/components/subtabs";
import { inPerformanceWorkspace } from "../../_parts/access";
import { Disclosure } from "../../_parts/disclosure";
import { TimeframeForms, ToggleTimeframe, GoalTemplateForm, ArchiveGoalTemplate, AssignGoalForm } from "../../_parts/talent-forms";

const P = PERMISSIONS;
const METRIC: Record<string, string> = { PERCENTAGE: "Percent", COMPLETION: "Done / not done", NUMBER_INCREASE: "Increase", NUMBER_DECREASE: "Decrease", CURRENCY: "Amount" };

/**
 * Performance › Goals › Library: the goal templates HR maintains, the goal
 * timeframes (quarters, half-years, custom), and assigning a goal — from a
 * template or from scratch — to one person or a whole team at once.
 */
export default async function GoalLibraryPage({ searchParams }: { searchParams: Promise<{ use?: string }> }) {
  const viewer = await requireViewer();
  if (!inPerformanceWorkspace(viewer)) redirect("/me/performance?view=goals");
  const sp = await searchParams;
  const manage = can(viewer, P.GOALS_MANAGE);
  const [templates, timeframes, teamGoals] = await Promise.all([
    prisma.goalTemplate.findMany({ where: { tenantId: viewer.tenantId, ...(manage ? {} : { isActive: true }) }, orderBy: [{ isActive: "desc" }, { category: "asc" }, { title: "asc" }] }),
    prisma.goalTimeframe.findMany({ where: { tenantId: viewer.tenantId, ...(manage ? {} : { isActive: true }) }, orderBy: { startDate: "asc" } }),
    prisma.goal.groupBy({ by: ["teamGoalId", "title"], where: { tenantId: viewer.tenantId, teamGoalId: { not: null }, status: { not: "CANCELLED" } }, _count: { _all: true }, _avg: { progressPercent: true } }),
  ]);
  // People the viewer can set goals for: their reporting line, and everyone in goal-management scope.
  const people = await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] }, OR: [{ id: { in: [...viewer.allReportIds, viewer.employee?.id ?? "__none__"] } }, ...(manage ? [scopedEmployeeWhere(viewer, P.GOALS_MANAGE)] : [])] },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" }, take: 500,
  });
  const usage = new Map((await prisma.goal.groupBy({ by: ["templateId"], where: { tenantId: viewer.tenantId, templateId: { not: null } }, _count: { _all: true } })).map((g) => [g.templateId, g._count._all]));
  const fyNow = (() => { const d = new Date(); const m = d.getUTCMonth() + 1; return m >= viewer.tenant.fyStartMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1; })();

  return (
    <>
      <SubTabs items={[{ label: "Goals", href: "/performance/goals" }, { label: "Goal library & team goals", href: "/performance/goals/library" }]} />
      <PageHead title="Goal library" subtitle="Start goals from templates HR maintains, and assign one goal to a whole team at once" />
      <div className="stack gap-4">
        <Card title="Assign a goal" description="From a template or from scratch. Pick several people to make it a team goal — each gets their own copy to track.">
          <AssignGoalForm
            defaultTemplateId={templates.some((t) => t.id === sp.use && t.isActive) ? sp.use : undefined}
            templates={templates.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.title, metricType: t.metricType, target: Number(t.targetValue), start: Number(t.startValue) }))}
            timeframes={timeframes.filter((t) => t.isActive).map((t) => ({ value: t.id, label: `${t.name} (${formatDate(t.startDate)} – ${formatDate(t.endDate)})` }))}
            people={people.map((p) => ({ value: p.id, label: `${p.displayName}${p.id === viewer.employee?.id ? " (me)" : ""} · ${p.employeeNumber}` }))}
          />
        </Card>

        <Card tight title={`Templates (${templates.length})`}>
          {manage ? <div style={{ padding: 14 }}><Disclosure label="New template"><GoalTemplateForm /></Disclosure></div> : null}
          {templates.length === 0 ? <Empty title="No goal templates yet">{manage ? "Add the goals your teams set again and again." : "HR has not added any templates yet."}</Empty> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Template</th><th>Category</th><th>Measure</th><th className="num">Used</th><th /></tr></thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td><div className="strong text-sm">{t.title}</div>{t.description ? <div className="text-xs subtle">{t.description}</div> : null}</td>
                    <td className="text-sm">{t.category ?? "—"}</td>
                    <td className="text-sm">{METRIC[t.metricType] ?? t.metricType}{t.metricType.startsWith("NUMBER") || t.metricType === "CURRENCY" ? ` · ${Number(t.startValue)} → ${Number(t.targetValue)}${t.metricName ? ` ${t.metricName}` : ""}` : ""}</td>
                    <td className="num">{usage.get(t.id) ?? 0}</td>
                    <td className="right"><span className="row gap-2" style={{ justifyContent: "flex-end" }}>
                      {t.isActive ? <a className="btn sm" href={`/performance/goals/library?use=${t.id}`}>Use</a> : <Badge>archived</Badge>}
                      {manage ? <ArchiveGoalTemplate id={t.id} active={t.isActive} /> : null}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>

        <Card tight title="Team goals" description="Goals assigned to several people at once, with their average progress.">
          {teamGoals.length === 0 ? <Empty title="No team goals yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Goal</th><th className="num">People</th><th className="num">Average progress</th></tr></thead>
              <tbody>{teamGoals.map((g) => <tr key={g.teamGoalId}><td className="text-sm strong">{g.title}</td><td className="num">{g._count._all}</td><td className="num">{Math.round(Number(g._avg.progressPercent ?? 0))}%</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>

        <Card tight title="Goal timeframes" description="The periods goals are set for. Choosing one fills in a goal's dates.">
          {manage ? <div style={{ padding: 14 }}><Disclosure label="Add timeframes"><TimeframeForms fy={fyNow} /></Disclosure></div> : null}
          {timeframes.length === 0 ? <Empty title="No timeframes yet" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Timeframe</th><th>Kind</th><th>Dates</th><th /></tr></thead>
              <tbody>
                {timeframes.map((t) => (
                  <tr key={t.id}>
                    <td className="strong text-sm">{t.name}{t.isActive ? null : <> <Badge>hidden</Badge></>}</td>
                    <td className="text-sm">{t.kind.replace("_", "-").toLowerCase()}</td>
                    <td className="text-sm nowrap">{formatDate(t.startDate)} – {formatDate(t.endDate)}</td>
                    <td className="right">{manage ? <ToggleTimeframe id={t.id} active={t.isActive} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
