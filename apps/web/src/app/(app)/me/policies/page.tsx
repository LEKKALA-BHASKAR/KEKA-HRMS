import { prisma } from "@keka/db";
import { requireViewer } from "@/lib/context";
import { fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, Empty } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { acknowledgePolicyAction, recordConsentAction } from "@/app/actions/compliance";

/** An employee's policies to acknowledge and their consent choices. */
export default async function MyPoliciesPage() {
  const viewer = await requireViewer();
  const t = viewer.tenantId;
  const empId = viewer.employee?.id ?? null;
  const emp = empId ? await prisma.employee.findUnique({ where: { id: empId }, select: { departmentId: true } }) : null;
  const campaigns = await prisma.policyCampaign.findMany({ where: { tenantId: t, status: "ACTIVE" } });
  const mine = campaigns.filter((c) => c.departmentIds.length === 0 || (emp?.departmentId && c.departmentIds.includes(emp.departmentId)));
  const docs = await prisma.orgDocument.findMany({ where: { tenantId: t, isPublished: true, requireAck: true }, orderBy: { title: "asc" } });
  const acks = empId ? await prisma.orgDocumentAck.findMany({ where: { employeeId: empId, documentId: { in: docs.map((d) => d.id) } } }) : [];
  const ackAt = new Map(acks.map((a) => [a.documentId, a.acknowledgedAt]));
  const dueFor = new Map(mine.map((c) => [c.documentId, c.dueOn]));
  const purposes = await prisma.consentPurpose.findMany({ where: { tenantId: t, status: "PUBLISHED" }, orderBy: { title: "asc" } });
  const consents = empId ? await prisma.consentRecord.findMany({ where: { employeeId: empId, purposeId: { in: purposes.map((p) => p.id) } } }) : [];
  const consentOf = new Map(consents.map((c) => [c.purposeId, c]));
  return (
    <>
      <PageHead title="Policies & consent" subtitle="Read and acknowledge company policies, and choose how your personal data is used" />
      <div className="stack gap-4">
        <Card tight title="Policies">
          {docs.length === 0 ? <Empty title="No policies to acknowledge" /> : (
            <Table head={["Policy", "Version", "Due", "Status", ""]}>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong>{d.description ? <div className="text-xs muted">{d.description}</div> : null}{d.fileUrl ? <div><a className="text-xs" href={d.fileUrl}>Open document</a></div> : null}</td>
                  <td>{d.version ?? "—"}</td><td>{fmtDate(dueFor.get(d.id))}</td>
                  <td>{ackAt.get(d.id) ? <><Pill s="ACKNOWLEDGED" /> <span className="text-xs">{fmtWhen(ackAt.get(d.id))}</span></> : <Pill s="PENDING" />}</td>
                  <td>{!ackAt.get(d.id) && empId ? <SpecForm action={acknowledgePolicyAction} hidden={{ documentId: d.id }} submitLabel="Acknowledge" columns={1} fields={[{ name: "confirm", label: "", type: "checkbox", placeholder: "I have read and understood this policy" }]} /> : null}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card tight title="Consent" description="Each request says what the data is used for. You can withdraw an optional consent at any time.">
          {purposes.length === 0 ? <Empty title="Nothing to consent to" /> : (
            <Table head={["Purpose", "Version", "Your choice", ""]}>
              {purposes.map((p) => {
                const c = consentOf.get(p.id);
                return (
                  <tr key={p.id}>
                    <td><strong>{p.title}</strong>{p.mandatory ? <span className="text-xs muted"> (required)</span> : null}<div className="text-xs muted">{p.description}</div></td>
                    <td>v{p.version}</td>
                    <td>{c ? <><Pill s={c.decision} /> <span className="text-xs">{fmtWhen(c.recordedAt)}</span></> : <Pill s="PENDING" />}</td>
                    <td className="row gap-2">{empId ? <>
                      {c?.decision !== "GRANTED" ? <ActButton action={recordConsentAction} hidden={{ purposeId: p.id, decision: "GRANTED" }} label="I consent" variant="primary" /> : null}
                      {!p.mandatory && !c ? <ActButton action={recordConsentAction} hidden={{ purposeId: p.id, decision: "DECLINED" }} label="Decline" variant="ghost" /> : null}
                      {!p.mandatory && c?.decision === "GRANTED" ? <ActButton action={recordConsentAction} hidden={{ purposeId: p.id, decision: "WITHDRAWN" }} label="Withdraw" variant="ghost" confirmText="Withdraw your consent?" /> : null}
                    </> : null}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
