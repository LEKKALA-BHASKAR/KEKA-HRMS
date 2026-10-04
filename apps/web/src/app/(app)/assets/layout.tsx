import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { actionableAssetRequests } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { AssetTabs } from "./_ui";

/**
 * Org › Assets: Keka's third row of tabs. Only asset managers and assigners
 * work here; everyone else has their own assets at /me/assets.
 */

const P = PERMISSIONS;

export default async function AssetsLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.ASSET_MANAGE, P.ASSET_ASSIGN])) redirect("/me/assets");
  const manage = can(viewer, P.ASSET_MANAGE);
  const [actionable, pendingAck] = await Promise.all([
    actionableAssetRequests({ tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? null, canManage: manage, canAssign: can(viewer, P.ASSET_ASSIGN) }),
    prisma.assetAssignment.count({ where: { ackStatus: "PENDING", returnedOn: null, asset: { tenantId: viewer.tenantId }, employee: scopedEmployeeWhere(viewer, P.ASSET_VIEW) } }),
  ]);
  const tabs = [
    { label: "Summary", href: "/assets" },
    { label: "Assigned Assets", href: "/assets/assigned" },
    { label: "Asset Requests", href: "/assets/requests", count: actionable.length },
    { label: "Asset Acknowledgement", href: "/assets/acknowledgements", count: pendingAck },
    { label: "Asset List", href: "/assets/list" },
    manage && { label: "Asset Categories & Asset Types", href: "/assets/categories" },
    manage && { label: "Operations", href: "/assets/operations" },
    manage && { label: "Reports", href: "/assets/reports" },
    manage && { label: "Settings", href: "/assets/settings" },
    { label: "Damage Recovery", href: "/assets/recovery" },
  ].filter((t): t is { label: string; href: string; count?: number } => !!t);
  return (
    <>
      <AssetTabs items={tabs} />
      {children}
    </>
  );
}
