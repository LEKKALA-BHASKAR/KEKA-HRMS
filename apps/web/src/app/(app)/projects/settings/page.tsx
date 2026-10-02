import { redirect, forbidden } from "next/navigation";
import { requireViewer } from "@/lib/context";
import { firstSettingsHref } from "../billing/nav";

/** Projects › Settings opens on the first settings page the viewer may use. */
export default async function ProjectSettingsIndex() {
  const href = firstSettingsHref(await requireViewer());
  if (!href) forbidden();
  redirect(href);
}
