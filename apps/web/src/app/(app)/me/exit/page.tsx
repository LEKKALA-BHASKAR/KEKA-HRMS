import { prisma } from "@keka/db";
import { formatDate, formatINR } from "@keka/shared";
import { noticeDaysFor } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Callout, KeyValue } from "@/components/ui";
import { ResignForm, WithdrawExitButton } from "../../_lifecycle/forms";
import { JourneyChecklist } from "../../_lifecycle/journey-view";

const DAY = 86_400_000;

export default async function MyExitPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <Callout tone="info" title="No employee record">This login is not linked to an employee record.</Callout>;
  }
  const employeeId = viewer.employee.id;
  const [exit, settlement, journey] = await Promise.all([
    prisma.exitRecord.findUnique({ where: { employeeId } }),
    prisma.fnfSettlement.findUnique({ where: { employeeId } }),
    prisma.journey.findFirst({ where: { employeeId, trigger: "EXIT", status: { not: "CANCELLED" } }, select: { id: true } }),
  ]);
  const live = exit && !["CANCELLED", "RETAINED", "REJECTED"].includes(exit.status);
  const notice = await noticeDaysFor(employeeId, "RESIGNATION");
  // An employee resigning picks from the voluntary reasons the organisation configured.
  const reasons = live ? [] : await prisma.exitReason.findMany({ where: { tenantId: viewer.tenantId, isActive: true, kind: { not: "INVOLUNTARY" } }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] });
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const policyLwd = new Date(today.getTime() + notice.days * DAY).toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="My exit" subtitle={live ? `Last working day ${formatDate(exit!.lastWorkingDay)}` : "Resignation and clearance"} />
      {!live ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <Card title="Resign" description="Your manager and HR are notified. Nothing changes until your resignation is accepted, and you can withdraw it until then.">
            <ResignForm policyLwd={policyLwd} noticeDays={notice.days} reasons={reasons.map((r) => ({ value: r.id, label: r.name }))} />
          </Card>
          <Card title="Before you decide">
            <div className="text-sm muted stack gap-2">
              <p style={{ margin: 0 }}>Your notice period under the {notice.policy} policy is <strong>{notice.days} days</strong>.</p>
              <p style={{ margin: 0 }}>Leaving earlier than that may mean a recovery of {notice.basis.toLowerCase()} pay for the days short, unless it is waived.</p>
              <p style={{ margin: 0 }}>Earned leave you have not used is paid out in your final settlement; gratuity is paid after five years of service.</p>
              <p style={{ margin: 0 }}>Talking to your manager or HR first is always an option — <a href="/helpdesk">raise a confidential ticket</a>.</p>
            </div>
          </Card>
        </div>
      ) : (
        <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 360px", alignItems: "start" }}>
          <div className="stack gap-4">
            {exit!.status === "PENDING_APPROVAL" ? (
              <Callout tone="warning" title="Awaiting your manager's decision">
                You resigned on {formatDate(exit!.noticeDate)}. You can withdraw until it is accepted.
                <div style={{ marginTop: 8 }}><WithdrawExitButton exitId={exit!.id} /></div>
              </Callout>
            ) : null}
            {journey ? (
              <Card tight title="Your exit checklist" description="Tasks assigned to you can be marked done here.">
                <JourneyChecklist journeyId={journey.id} viewer={viewer} anchorLabel="your last day" />
              </Card>
            ) : null}
          </div>
          <div className="stack gap-4">
            <Card title="Status">
              <KeyValue items={[
                ["Status", <Badge key="s" tone="info">{exit!.status.replace(/_/g, " ").toLowerCase()}</Badge>],
                ["Resigned on", formatDate(exit!.noticeDate)],
                ["Last working day", formatDate(exit!.lastWorkingDay)],
              ]} />
            </Card>
            {settlement && ["FINALIZED", "PAID"].includes(settlement.status) ? (
              <Card title="Final settlement">
                <KeyValue items={[
                  ["Payable", formatINR(Number(settlement.totalPayable))],
                  ["Recovered", formatINR(Number(settlement.totalRecovery))],
                  ["Net", <strong key="n">{formatINR(Number(settlement.netSettlement))}</strong>],
                ]} />
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
