import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { delegationActive } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { SpecForm, ActionButton } from "@/components/spec-form";
import { createDelegationAction, revokeDelegationAction } from "@/app/actions/self-service-depth";

export const metadata = { title: "Delegation — BooS-HR" };

/**
 * My Team › Delegation: while away, a manager hands their approvals (leave,
 * attendance, profile changes) and their team view to a colleague for a set
 * of dates. Also lists the teams this person is covering for.
 */
export default async function DelegationPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="Delegation" /><Card><Empty title="No employee profile" /></Card></>;
  const me = viewer.employee.id;
  const [mine, covering, people] = await Promise.all([
    prisma.managerDelegation.findMany({ where: { tenantId: viewer.tenantId, delegatorId: me }, orderBy: { startDate: "desc" }, take: 30 }),
    prisma.managerDelegation.findMany({ where: { tenantId: viewer.tenantId, delegateId: me }, orderBy: { startDate: "desc" }, take: 30 }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, NOT: { id: me } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" } }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.displayName ?? p.employeeNumber]));
  const status = (d: { startDate: Date; endDate: Date; revokedAt: Date | null }) => d.revokedAt ? <Badge>Ended</Badge> : delegationActive(d) ? <Badge tone="success">In force</Badge> : d.startDate > new Date() ? <Badge tone="brand">Upcoming</Badge> : <Badge>Past</Badge>;
  return (
    <>
      <PageHead title="Delegation" subtitle="Hand your approvals to a colleague while you are away" />
      <Callout title="What the delegate can do">During the dates, your delegate sees your team on My Team and can approve their profile change requests and leave where you are an approver. Your own access is unchanged.</Callout>
      <div className="grid grid-2" style={{ alignItems: "start", marginTop: 14 }}>
        <Card title="Delegate my approvals">
          <SpecForm action={createDelegationAction} hidden={{ kind: "DELEGATE" }} submitLabel="Delegate" fields={[
            { name: "delegateId", label: "Colleague", kind: "select", required: true, options: people.map((p) => ({ value: p.id, label: `${p.displayName} (${p.employeeNumber})` })) },
            { name: "startDate", label: "From", kind: "date", required: true },
            { name: "endDate", label: "Until", kind: "date", required: true },
            { name: "reason", label: "Reason", placeholder: "Annual leave", wide: true },
          ]} />
        </Card>
        <Card title="Teams I am covering for" tight>
          {covering.length === 0 ? <Empty title="None" /> : (
            <ul className="stack" style={{ listStyle: "none", padding: 14, margin: 0 }}>{covering.map((d) => <li key={d.id}>{name.get(d.delegatorId) ?? "A manager"}&rsquo;s team · {formatDate(d.startDate)} – {formatDate(d.endDate)} {d.kind === "ACTING" ? "(acting manager)" : ""} {status(d)}</li>)}</ul>
          )}
        </Card>
      </div>
      <div style={{ height: 14 }} />
      <Card title="My delegations" tight>
        {mine.length === 0 ? <Empty title="You have not delegated" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>To</th><th>Dates</th><th>Kind</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{mine.map((d) => (
              <tr key={d.id}><td>{name.get(d.delegateId) ?? "—"}</td><td>{formatDate(d.startDate)} – {formatDate(d.endDate)}</td><td>{d.kind === "ACTING" ? "Acting manager (set by HR)" : "Approvals"}</td><td className="text-sm">{d.reason ?? "—"}</td><td>{status(d)}</td>
                <td className="right">{!d.revokedAt && d.endDate >= new Date() ? <ActionButton action={revokeDelegationAction} hidden={{ id: d.id }} label="End now" /> : null}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
