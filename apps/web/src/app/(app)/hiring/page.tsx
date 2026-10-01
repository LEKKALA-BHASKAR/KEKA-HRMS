import { redirect } from "next/navigation";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, canAny } from "@/lib/context";

const P = PERMISSIONS;

/**
 * /hiring used to hold every hiring screen behind in-page tabs. Each now has
 * its own route in the Hire tab bar; old links (`?tab=…`) land on the
 * matching one, and a bare /hiring on the first tab the viewer can use.
 */
export default async function HiringIndex({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const tab = (await searchParams).tab;
  const legacy: Record<string, string> = { jobs: "/hiring/jobs", requisitions: "/hiring/requisitions", interviews: "/hiring/interviews", refer: "/hiring/refer", offers: "/hiring/offers" };
  if (tab && legacy[tab]) redirect(legacy[tab]);
  if (canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE])) redirect("/hiring/requisitions");
  if (canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE])) redirect("/hiring/jobs");
  redirect(viewer.employee ? "/hiring/interviews" : "/");
}
