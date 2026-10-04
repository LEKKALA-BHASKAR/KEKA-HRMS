import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { esRef, activeRecipients, markViewed, ENVELOPE_STATUS_LABEL, RECIPIENT_ROLES } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { userOptions, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, KeyValue, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { sendEnvelopeAction, remindEnvelopeAction, voidEnvelopeAction, declineEnvelopeAction, delegateSignatureAction } from "@/app/actions/doc-ops";
import { SignEnvelope } from "../forms";

export const metadata = { title: "Envelope" };

/** One envelope: the document, its signers in order, the event trail, and the signer's own actions. */
export default async function EnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const env = await prisma.signatureEnvelope.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { recipients: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] }, events: { orderBy: { createdAt: "asc" } } } });
  if (!env) notFound();
  const sender = env.createdByUserId === viewer.user.id || can(viewer, PERMISSIONS.DOCUMENT_MANAGE);
  const mine = env.recipients.filter((r) => r.userId === viewer.user.id && r.status !== "DELEGATED");
  if (!sender && !mine.length) notFound();
  const h = await headers();
  if (mine.length) await markViewed({ tenantId: viewer.tenantId, envelopeId: env.id, userId: viewer.user.id, ip: (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || null });
  const active = env.status === "SENT" ? activeRecipients(env.recipients, env.sequential) : [];
  const myTurn = active.find((r) => r.userId === viewer.user.id);
  const waitingMine = mine.find((r) => r.status === "WAITING" || r.status === "PENDING");
  const letter = env.letterId ? await prisma.generatedDocument.findUnique({ where: { id: env.letterId }, select: { id: true, renderedBody: true, letterNumber: true } }) : null;
  const users = myTurn || waitingMine ? await userOptions(viewer.tenantId) : [];
  return (
    <>
      <PageHead title={<>{esRef(env.number)} · {env.title}</>} subtitle={`${env.sequential ? "Signed in order" : "Signed in parallel"} · created ${fmtDate(env.createdAt)}`}
        actions={<><Pill s={env.status} />{env.status === "COMPLETED" || env.status === "DECLINED" || env.status === "VOIDED" ? <a className="btn" href={`/documents/esign/${env.id}/certificate`}>Signature certificate (PDF)</a> : null}<Link className="btn" href={sender ? "/documents/esign" : "/me/sign"}>Back</Link></>} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Document">
            {env.message ? <Callout>{env.message}</Callout> : null}
            {env.fileId ? <p><a className="btn" href={`/files/${env.fileId}?inline=1`} target="_blank" rel="noreferrer">Open the PDF</a></p> : null}
            {letter ? <div className="card" style={{ padding: 16, maxHeight: 420, overflow: "auto" }} dangerouslySetInnerHTML={{ __html: letter.renderedBody }} /> : null}
            <div className="muted text-xs" style={{ marginTop: 8 }}>Fingerprint (SHA-256): {env.contentHash}</div>
          </Card>
          {myTurn ? (
            <Card title={myTurn.role === "APPROVER" ? "Your approval" : "Your signature"}>
              <SignEnvelope id={env.id} name={myTurn.name} role={myTurn.role} />
              <div className="stack gap-2" style={{ marginTop: 16 }}>
                <SpecForm action={declineEnvelopeAction} hidden={{ id: env.id }} submitLabel="Decline" columns={1} fields={[{ name: "reason", label: "Decline — tell the sender why", type: "textarea", required: true }]} />
              </div>
            </Card>
          ) : waitingMine ? <Callout>It is not your turn yet: earlier signers have to sign first. You will be notified.</Callout> : null}
          {waitingMine && waitingMine.role !== "CC" && env.status === "SENT" ? (
            <Card title="Delegate" description="Ask a colleague to sign in your place; the sender sees who delegated and why.">
              <SpecForm action={delegateSignatureAction} hidden={{ id: env.id }} submitLabel="Delegate" fields={[{ name: "toUserId", label: "To", type: "select", options: users.filter((u) => u.value !== viewer.user.id), required: true }, { name: "reason", label: "Why", required: true }]} />
            </Card>
          ) : null}
        </div>
        <div className="stack gap-4">
          <Card title="Recipients">
            <Table head={["Step", "Person", "Part", "Status", "When"]}>
              {env.recipients.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.order}</td>
                  <td>{r.name}<div className="muted text-xs">{r.email}</div>{r.delegatedFromId ? <div className="text-xs">on behalf of {env.recipients.find((x) => x.id === r.delegatedFromId)?.name}</div> : null}</td>
                  <td>{RECIPIENT_ROLES[r.role as keyof typeof RECIPIENT_ROLES]}</td>
                  <td><Pill s={r.status} />{r.declineReason ? <div className="text-xs neg">{r.declineReason}</div> : null}{r.remindCount ? <div className="muted text-xs">reminded {r.remindCount}×</div> : null}</td>
                  <td className="text-xs">{fmtWhen(r.signedAt ?? r.viewedAt)}</td>
                </tr>
              ))}
            </Table>
            {sender ? (
              <div className="row gap-2 wrap" style={{ marginTop: 12 }}>
                {env.status === "DRAFT" ? <ActButton action={sendEnvelopeAction} hidden={{ id: env.id }} label="Send for signature" variant="primary" /> : null}
                {env.status === "SENT" ? <ActButton action={remindEnvelopeAction} hidden={{ id: env.id }} label="Remind now" /> : null}
                {env.status === "SENT" || env.status === "DRAFT" ? <ActButton action={voidEnvelopeAction} hidden={{ id: env.id }} label="Void" variant="danger" input={{ name: "reason", placeholder: "Reason", required: true }} confirmText="Void this envelope? Pending signers are told it is no longer needed." /> : null}
              </div>
            ) : null}
          </Card>
          <Card title="Audit trail">
            <KeyValue items={[["Status", ENVELOPE_STATUS_LABEL[env.status]], ["Reminders", env.reminderEveryDays ? `every ${env.reminderEveryDays} days` : "off"], ["Expires", fmtDate(env.expiresOn)], ["Completed", fmtWhen(env.completedAt)], ["Voided", env.voidReason]]} />
            <Table head={["When", "Event", "Detail"]}>
              {env.events.map((e) => <tr key={e.id}><td className="text-xs">{fmtWhen(e.createdAt)}</td><td>{e.kind.toLowerCase()}</td><td className="text-xs">{e.note ?? ""}{e.recipientId ? ` · ${env.recipients.find((r) => r.id === e.recipientId)?.name ?? ""}` : ""}{e.ip ? ` · IP ${e.ip}` : ""}</td></tr>)}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
