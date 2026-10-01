import "server-only";
import { forbidden } from "next/navigation";
import { PERMISSIONS } from "@keka/rbac";
import { helpdeskScope, hasHelpdeskScope, refreshSla, type HelpdeskScope } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";

/**
 * The agent side of the helpdesk (Org › Helpdesk): everyone with
 * HELPDESK_MANAGE, and category heads and agents for their categories.
 * Anyone else gets a 403. Settings additionally need HELPDESK_SETTINGS.
 */
export async function requireHelpdeskAgent(opts: { settings?: boolean } = {}): Promise<{ viewer: Viewer; scope: HelpdeskScope; canSettings: boolean }> {
  const viewer = await requireViewer();
  const canSettings = can(viewer, PERMISSIONS.HELPDESK_SETTINGS);
  if (opts.settings) {
    if (!canSettings) forbidden();
    return { viewer, scope: await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, PERMISSIONS.HELPDESK_MANAGE)), canSettings };
  }
  const scope = await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, PERMISSIONS.HELPDESK_MANAGE));
  if (!hasHelpdeskScope(scope) && !canSettings) forbidden();
  // Flag tickets that have just missed a target before the queue renders.
  await refreshSla(viewer.tenantId);
  return { viewer, scope, canSettings };
}
