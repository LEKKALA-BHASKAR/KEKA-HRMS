import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import { PageHead } from "@/components/ui";
import { SubTabs } from "@/components/subtabs";
import { Cycles } from "../_parts/sections";

/** Performance › Reviews › Review cycles: create, launch, calibrate and share. */
export default async function CyclesPage() {
  const viewer = await requireViewer();
  if (!canAny(viewer, [PERMISSIONS.PERFORMANCE_MANAGE, PERMISSIONS.PERFORMANCE_CALIBRATE])) forbidden();
  return (
    <>
      <SubTabs items={[{ label: "Reviews", href: "/performance/reviews" }, { label: "Review cycles", href: "/performance/cycles" }]} />
      <PageHead title="Review cycles" subtitle="Each cycle has rating bands with a target distribution; calibration compares against them" />
      <Cycles viewer={viewer} />
    </>
  );
}
