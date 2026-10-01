import { redirect } from "next/navigation";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, canAny } from "@/lib/context";
import { PageHead } from "@/components/ui";
import { SubTabs } from "@/components/subtabs";
import { Reviews } from "../_parts/sections";
import { inPerformanceWorkspace } from "../_parts/access";

/** Performance › Reviews: what you have to write and your own reviews; cycles for those who run them. */
export default async function ReviewsPage() {
  const viewer = await requireViewer();
  if (!inPerformanceWorkspace(viewer)) redirect("/me/performance?view=reviews");
  const admin = canAny(viewer, [PERMISSIONS.PERFORMANCE_MANAGE, PERMISSIONS.PERFORMANCE_CALIBRATE]);
  return (
    <>
      {admin ? <SubTabs items={[{ label: "Reviews", href: "/performance/reviews" }, { label: "Review cycles", href: "/performance/cycles" }]} /> : null}
      <PageHead title="Reviews" subtitle="Self and manager reviews in each cycle, calibrated before they are shared" />
      <Reviews viewer={viewer} />
    </>
  );
}
