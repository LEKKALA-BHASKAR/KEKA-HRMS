import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { esRef, ENVELOPE_STATUS_LABEL } from "@keka/services";
import { requireAuth, can, canAny } from "@/lib/context";
import { userOptions, fmtDate } from "@/lib/governance";
import { PageHead, Card, Callout } from "@/components/ui";
import { Pill, Tabs, SearchBar, Table } from "@/components/gov-ui";
import { DocumentsTabs } from "../tabs";
import { NewEnvelope } from "./forms";

export const metadata = { title: "E-signatures" };
const TABS = { sent: "Envelopes", new: "New envelope", mine: "Waiting on me" };
type Tab = keyof typeof TABS;

/**
 * Documents › E-sign: envelopes with several signers in order, approvers and
 * copies; decline with a reason, delegation, reminders, expiry and a
 * signature certificate. Senders see their own envelopes; document managers
 * see every envelope.
 */
export default async function EsignPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.DOCUMENT_VIEW);
  const sp = await searchParams;
  const sender = canAny(viewer, [PERMISSIONS.DOCUMENT_MANAGE, PERMISSIONS.LETTER_GENERATE]);
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : sender ? "sent" : "mine";
  const t = viewer.tenantId;
  return (
    <>
      <PageHead title="E-signatures" subtitle="Send documents for signature in order, track every step, and keep a signed certificate" />
      <DocumentsTabs />
      <Tabs base="/documents/esign" tabs={TABS} active={tab} />
      {tab === "sent" ? (sender ? <Sent tenantId={t} userId={viewer.user.id} all={can(viewer, PERMISSIONS.DOCUMENT_MANAGE)} q={sp.q} status={sp.status} /> : <Callout>Sending envelopes needs document management or letter rights.</Callout>) : null}
      {tab === "new" ? (sender ? <New tenantId={t} /> : <Callout>Sending envelopes needs document management or letter rights.</Callout>) : null}
      {tab === "mine" ? <Mine tenantId={t} userId={viewer.user.id} /> : null}
    </>
  );
}

async function Sent({ tenantId, userId, all, q, status }: { tenantId: string; userId: string; all: boolean; q?: string; status?: string }) {
  const num = q ? Number(q.replace(/^ES-/i, "")) : NaN;
  const where: Prisma.SignatureEnvelopeWhereInput = {
    tenantId, ...(all ? {} : { createdByUserId: userId }), ...(status ? { status } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { recipients: { some: { name: { contains: q, mode: "insensitive" } } } }, ...(Number.isInteger(num) ? [{ number: num }] : [])] } : {}),
  };
  const rows = await prisma.signatureEnvelope.findMany({ where, include: { recipients: true }, orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <Card title={`Envelopes (${rows.length})`}>
      <SearchBar action="/documents/esign" tab="sent" q={q}>
        <select className="select" name="status" defaultValue={status ?? ""}><option value="">Any status</option>{Object.entries(ENVELOPE_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </SearchBar>
      <Table head={["Envelope", "Recipients", "Signed", "Status", "Sent", "Completed"]} empty={!rows.length}>
        {rows.map((e) => {
          const signers = e.recipients.filter((r) => r.role !== "CC" && r.status !== "DELEGATED");
          return (
            <tr key={e.id}>
              <td><Link href={`/documents/esign/${e.id}`}><strong>{esRef(e.number)}</strong> {e.title}</Link></td>
              <td className="text-sm">{signers.map((r) => r.name).join(" → ")}</td>
              <td className="num">{signers.filter((r) => r.status === "SIGNED").length}/{signers.length}</td>
              <td><Pill s={e.status} /></td>
              <td>{fmtDate(e.sentAt)}</td>
              <td>{fmtDate(e.completedAt)}</td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}

async function New({ tenantId }: { tenantId: string }) {
  const [users, letters] = await Promise.all([
    userOptions(tenantId),
    prisma.generatedDocument.findMany({ where: { employee: { tenantId }, status: { in: ["ISSUED", "ACKNOWLEDGED", "PENDING_ACKNOWLEDGEMENT", "SIGNED", "PENDING_SIGNATURE"] } }, select: { id: true, letterNumber: true, template: { select: { name: true } }, employee: { select: { displayName: true } } }, orderBy: { issuedOn: "desc" }, take: 200 }),
  ]);
  return (
    <Card title="New envelope" description="Recipients with the same step number sign in parallel; the next step starts when they have all signed.">
      <NewEnvelope users={users} letters={letters.map((l) => ({ value: l.id, label: `${l.letterNumber ? `${l.letterNumber} · ` : ""}${l.template.name} — ${l.employee.displayName}` }))} />
    </Card>
  );
}

async function Mine({ tenantId, userId }: { tenantId: string; userId: string }) {
  const rows = await prisma.signatureRecipient.findMany({ where: { tenantId, userId, status: { not: "DELEGATED" } }, include: { envelope: true }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <Card title="Envelopes for you">
      <Table head={["Envelope", "Your part", "Your status", "Envelope"]} empty={!rows.length}>
        {rows.map((r) => <tr key={r.id}><td><Link href={`/documents/esign/${r.envelopeId}`}><strong>{esRef(r.envelope.number)}</strong> {r.envelope.title}</Link></td><td>{r.role === "CC" ? "Copy" : r.role === "APPROVER" ? "Approve" : "Sign"}</td><td><Pill s={r.status} /></td><td><Pill s={r.envelope.status} /></td></tr>)}
      </Table>
    </Card>
  );
}
