import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/context";
import { inPerformanceWorkspace } from "./_parts/access";

/**
 * The old single Performance page, kept as a router so existing links and
 * notifications (`/performance?tab=reviews`, `?tab=plans`) still land on the
 * right tab: the workspace for managers and admins, Me › Performance for
 * everyone else.
 */
export default async function PerformanceRedirect({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const { tab } = await searchParams;
  const workspace = inPerformanceWorkspace(viewer);
  if (tab === "cycles") redirect(workspace ? "/performance/cycles" : "/me/performance?view=reviews");
  if (tab === "plans") redirect("/performance/plans");
  if (tab === "reviews") redirect(workspace ? "/performance/reviews" : "/me/performance?view=reviews");
  redirect(workspace ? "/performance/goals" : "/me/performance");
}
