import { prisma } from "@keka/db";
import { helpdeskUserNames } from "@keka/services";
import { requireHelpdeskAgent } from "../../_ui/access";
import { HelpdeskTabs, SettingsTabs } from "../../_ui/tabs";
import { CannedResponses } from "../../_ui/settings-simple";
import s from "../../_ui/hd.module.css";

/** Settings › Canned Responses: saved replies agents insert from "Templates". */
export default async function CannedResponsesPage() {
  const { viewer } = await requireHelpdeskAgent({ settings: true });
  const rows = await prisma.helpdeskCannedResponse.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { title: "asc" } });
  const names = await helpdeskUserNames(viewer.tenantId, rows.map((r) => r.updatedByUserId));
  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings active="/helpdesk/settings/categories" />
      <SettingsTabs active="canned-responses" />
      <CannedResponses rows={rows.map((r) => ({ id: r.id, title: r.title, body: r.body, updatedBy: r.updatedByUserId ? names.get(r.updatedByUserId) ?? null : null, updatedAt: r.updatedAt.toISOString() }))} />
    </div>
  );
}
