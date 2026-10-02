import { prisma } from "@keka/db";
import { requireHelpdeskAgent } from "../../_ui/access";
import { HelpdeskTabs, SettingsTabs } from "../../_ui/tabs";
import { ClosingReasons } from "../../_ui/settings-simple";
import s from "../../_ui/hd.module.css";

/** Settings › Closing reasons: what an agent records when closing a ticket. */
export default async function ClosingReasonsPage() {
  const { viewer } = await requireHelpdeskAgent({ settings: true });
  const rows = await prisma.helpdeskClosingReason.findMany({
    where: { tenantId: viewer.tenantId }, orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { tickets: true } } },
  });
  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings active="/helpdesk/settings/categories" />
      <SettingsTabs active="closing-reasons" />
      <ClosingReasons rows={rows.map((r) => ({ id: r.id, name: r.name, description: r.description, isActive: r.isActive, used: r._count.tickets }))} />
    </div>
  );
}
