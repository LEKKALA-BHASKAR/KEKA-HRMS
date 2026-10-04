import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { renderTableReport } from "@keka/documents";
import { envelopeCertificate, esRef, ENVELOPE_STATUS_LABEL, RECIPIENT_ROLES } from "@keka/services";
import { getViewer, can } from "@/lib/context";

const when = (d: Date | null | undefined) => (d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");

/**
 * The signature certificate: the document's fingerprint, every recipient
 * with when and how they signed (or declined), and the full event trail,
 * sealed with a fingerprint over the signing record. Sender, recipients and
 * document managers may download it once the envelope is finished.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in first.", { status: 401 });
  const { id } = await params;
  const cert = await envelopeCertificate(viewer.tenantId, id);
  if (!cert) return new Response("Not found.", { status: 404 });
  const { env, fingerprint } = cert;
  const allowed = env.createdByUserId === viewer.user.id || env.recipients.some((r) => r.userId === viewer.user.id) || can(viewer, PERMISSIONS.DOCUMENT_MANAGE);
  if (!allowed) return new Response("Not found.", { status: 404 });
  if (!["COMPLETED", "DECLINED", "VOIDED", "EXPIRED"].includes(env.status)) return new Response("The certificate is available once the envelope is finished.", { status: 409 });
  const tenant = await prisma.tenant.findUnique({ where: { id: viewer.tenantId }, select: { name: true } });
  const names = new Map(env.recipients.map((r) => [r.id, r.name]));
  const pdf = renderTableReport({
    title: `Signature certificate ${esRef(env.number)}`,
    subtitle: env.title,
    company: tenant?.name ?? "BooS-HR",
    banner: `${ENVELOPE_STATUS_LABEL[env.status]} · document SHA-256 ${env.contentHash}`,
    sections: [
      {
        heading: "Envelope",
        meta: [["Envelope", esRef(env.number)], ["Signing", env.sequential ? "In order" : "In parallel"], ["Sent", when(env.sentAt)], ["Completed", when(env.completedAt)], ["Record fingerprint", fingerprint]],
        columns: [{ label: "Step", numeric: true }, { label: "Recipient" }, { label: "Email" }, { label: "Part" }, { label: "Status" }, { label: "Viewed" }, { label: "Signed" }, { label: "Signed as" }, { label: "IP address" }],
        rows: env.recipients.map((r) => [r.order, r.name, r.email ?? "", RECIPIENT_ROLES[r.role as keyof typeof RECIPIENT_ROLES] ?? r.role, r.status + (r.declineReason ? `: ${r.declineReason}` : ""), when(r.viewedAt), when(r.signedAt), r.typedName ?? "", r.ip ?? ""]),
      },
      {
        heading: "Event trail",
        columns: [{ label: "When" }, { label: "Event" }, { label: "Recipient" }, { label: "Detail" }, { label: "IP address" }],
        rows: env.events.map((e) => [when(e.createdAt), e.kind, e.recipientId ? names.get(e.recipientId) ?? "" : "", e.note ?? "", e.ip ?? ""]),
      },
    ],
    notes: [
      "Each signer signed electronically after confirming consent, typing their name and drawing a signature; the drawn signatures are kept with the envelope.",
      "The document fingerprint was checked at every signature: a document changed after sending cannot be signed.",
    ],
  });
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "SignatureEnvelope", entityId: env.id, summary: `Downloaded the signature certificate for ${esRef(env.number)}`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="certificate-${esRef(env.number)}.pdf"`, "cache-control": "private, no-store" } });
}
