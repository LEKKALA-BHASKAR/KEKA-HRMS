import { redirect } from "next/navigation";
import { requireViewer, can } from "@/lib/context";
import { PERMISSIONS } from "@keka/rbac";
import { GoalsBoard, type GoalScope } from "../_parts/goals-board";
import { inPerformanceWorkspace } from "../_parts/access";
import { Toast } from "../_parts/toast";

/** Performance › Goals: the team's goals first for a manager, then theirs, the department's and the company's. */
export default async function WorkspaceGoalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireViewer();
  if (!inPerformanceWorkspace(viewer)) redirect("/me/performance");
  const sp = await searchParams;
  const scopes: GoalScope[] = [...(viewer.allReportIds.size ? ["team" as const] : []), ...(viewer.employee ? ["mine" as const, "department" as const] : []), "company"];
  const scope = (scopes as string[]).includes(sp.scope ?? "") ? sp.scope as GoalScope : scopes[0];
  const title = scope === "team" ? "My Team Goals" : scope === "mine" ? "My Goals" : scope === "department" ? "Department Goals" : can(viewer, PERMISSIONS.GOALS_MANAGE) ? "Company Goals" : "Company Goals";
  return (
    <>
      <Toast message={sp.done ?? null} />
      <GoalsBoard viewer={viewer} base="/performance/goals" scope={scope} scopes={scopes} sp={sp} title={title} />
    </>
  );
}
