import { redirect } from "next/navigation";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";

/** Org › Dashboard opens on Summary, as Keka's does. */
export default async function AnalyticsIndex() {
  const viewer = await requireViewer();
  if (can(viewer, PERMISSIONS.ANALYTICS_VIEW)) redirect("/analytics/summary");
  if (can(viewer, PERMISSIONS.REPORT_VIEW)) redirect("/reports");
  if (can(viewer, PERMISSIONS.AUDIT_LOG_VIEW)) redirect("/admin/audit");
  redirect("/");
}
