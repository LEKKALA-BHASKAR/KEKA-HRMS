import Link from "next/link";
import { prisma } from "@keka/db";
import { esRef } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { fmtDate } from "@/lib/governance";
import { PageHead, Card } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { MeCasesTabs } from "../cases/tabs";

export const metadata = { title: "Documents to sign" };

/** Me › Cases › Documents to sign: every envelope you are on, the ones waiting on you first. */
export default async function MySignPage() {
  const viewer = await requireViewer();
  const rows = await prisma.signatureRecipient.findMany({ where: { tenantId: viewer.tenantId, userId: viewer.user.id, status: { not: "DELEGATED" } }, include: { envelope: true }, orderBy: { createdAt: "desc" }, take: 200 });
  const pending = rows.filter((r) => r.status === "PENDING" && r.envelope.status === "SENT");
  const rest = rows.filter((r) => !pending.includes(r));
  return (
    <>
      <PageHead title="Documents to sign" subtitle="Envelopes sent to you for signature, approval or a copy" />
      <MeCasesTabs toSign={pending.length} />
      <div className="stack gap-4">
        <Card title={`Waiting on you (${pending.length})`}>
          <Table head={["Document", "Your part", "Sent", "Expires", ""]} empty={!pending.length}>
            {pending.map((r) => <tr key={r.id}><td><strong>{esRef(r.envelope.number)}</strong> {r.envelope.title}</td><td>{r.role === "APPROVER" ? "Approve" : "Sign"}</td><td>{fmtDate(r.envelope.sentAt)}</td><td>{fmtDate(r.envelope.expiresOn)}</td><td><Link className="btn primary sm" href={`/documents/esign/${r.envelopeId}`}>{r.role === "APPROVER" ? "Review" : "Sign"}</Link></td></tr>)}
          </Table>
        </Card>
        <Card title="Everything else">
          <Table head={["Document", "Your part", "Your status", "Envelope"]} empty={!rest.length}>
            {rest.map((r) => <tr key={r.id}><td><Link href={`/documents/esign/${r.envelopeId}`}><strong>{esRef(r.envelope.number)}</strong> {r.envelope.title}</Link></td><td>{r.role === "CC" ? "Copy" : r.role === "APPROVER" ? "Approve" : "Sign"}</td><td><Pill s={r.status} /></td><td><Pill s={r.envelope.status} /></td></tr>)}
          </Table>
        </Card>
      </div>
    </>
  );
}
