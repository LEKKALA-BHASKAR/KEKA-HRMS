import { prisma } from "@keka/db";
import { NOTIFICATION_EVENTS, OFF_BY_DEFAULT } from "@keka/services";
import { Card, Badge } from "@/components/ui";
import { NotificationEventRow } from "../../_lifecycle/core-hr-forms";

/**
 * Settings › Notifications: every event that sends email, whether it does,
 * and to whom. An event nobody has touched behaves exactly as it always has;
 * the defaults shown are what its code sends today. In-app notifications are
 * not affected — switching an email off only stops the email.
 */
export async function Notifications({ tenantId }: { tenantId: string }) {
  const settings = await prisma.notificationSetting.findMany({ where: { tenantId } });
  const byEvent = new Map(settings.map((s) => [s.event, s]));
  const modules = [...new Set(NOTIFICATION_EVENTS.map((e) => e.module))];
  return (
    <div className="stack gap-4">
      {modules.map((m) => (
        <Card key={m} tight title={m} description={m === modules[0] ? "Email for each event, and who receives it. Employee and manager mean the person the event is about and their reporting manager; HR means everyone who administers that area. Custom addresses are copied on every email." : undefined}>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Event</th><th colSpan={3}>Email · recipients · custom addresses</th></tr></thead>
              <tbody>
                {NOTIFICATION_EVENTS.filter((e) => e.module === m).map((e) => {
                  const s = byEvent.get(e.key);
                  return (
                    <NotificationEventRow key={e.key} event={e.key} module={e.module} configurable={e.configurable} defaultLabel={e.defaultLabel}
                      label={e.label} description={`${e.description}${s ? "" : " (default)"}`}
                      emailEnabled={s ? s.emailEnabled : !OFF_BY_DEFAULT.has(e.key)}
                      recipients={s ? s.recipients : e.defaults} customEmails={s?.customEmails ?? []} customised={!!s} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <div className="text-xs subtle">
        <Badge tone="neutral">note</Badge> Sign-in codes, password resets and candidate emails always send; they are not listed here.
      </div>
    </div>
  );
}
