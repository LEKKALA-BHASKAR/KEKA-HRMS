"use server";

import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { openOfferLink, acceptOfferByLink, declineOfferByLink, closedMessage } from "@keka/services";
import { saveFile, sniffUpload } from "@/lib/storage";
import { throttled, clientIp } from "@/lib/throttle";
import type { ActionState } from "@/lib/forms";

/**
 * The candidate's answer from the offer portal. No sign-in: the token in the
 * form is the only credential, checked afresh on every call, and every call
 * counts against a per-address and a per-link limit.
 */

const WINDOW_MS = 10 * 60_000;
const MAX_SIGNATURE_BYTES = 300 * 1024;
const BUSY = "Too many attempts just now. Please wait a few minutes and try again.";

async function gate(token: string): Promise<string | null> {
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`offer-act|${ip}`, 10, WINDOW_MS)) return BUSY;
  if (throttled(`offer-act-link|${token.slice(0, 16)}`, 6, WINDOW_MS)) return BUSY;
  return null;
}

export async function acceptOfferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const busy = await gate(token);
  if (busy) return { ok: false, message: busy };
  const view = await openOfferLink(token);
  if (!view) return { ok: false, message: "This link is not valid." };
  if (view.state !== "OPEN") return { ok: false, message: closedMessage(view.state) };

  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(formData.get("signature") ?? ""));
  if (!m) return { ok: false, message: "Draw your signature in the box." };
  const data = Buffer.from(m[1]!, "base64");
  if (data.length > MAX_SIGNATURE_BYTES) return { ok: false, message: "That signature image is too large. Clear it and sign again." };
  const sniff = sniffUpload(data, "image/png");
  if (!sniff.ok || sniff.mimeType !== "image/png") return { ok: false, message: "Draw your signature in the box." };
  if (formData.get("consent") !== "on") return { ok: false, message: "Confirm that you agree to sign electronically." };

  const stored = await saveFile({ tenantId: view.tenantId, filename: `offer-signature-${view.applicationId}.png`, mimeType: "image/png", data, relatedType: "OfferSignature", relatedId: view.applicationId });
  const h = await headers();
  const res = await acceptOfferByLink({
    token, typedName: String(formData.get("typedName") ?? ""), consent: true, signatureFileId: stored.id,
    ip: await clientIp(), userAgent: h.get("user-agent"),
    saveSignedLetter: async (pdf, filename, tenantId, applicationId) => {
      const f = await saveFile({ tenantId, filename, mimeType: "application/pdf", data: pdf, relatedType: "Offer", relatedId: applicationId });
      return `/files/${f.id}`;
    },
  });
  if (!res.ok) {
    await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined);
    return { ok: false, message: res.message, values: { typedName: String(formData.get("typedName") ?? "") } };
  }
  await prisma.auditLog.create({
    data: { tenantId: view.tenantId, module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: view.offerId, summary: `${view.candidateName} accepted and e-signed the offer from the offer portal`, actorLabel: "Candidate (offer link)", ipAddress: await clientIp() },
  }).catch(() => undefined);
  return { ok: true, message: res.message };
}

export async function declineOfferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const busy = await gate(token);
  if (busy) return { ok: false, message: busy };
  const res = await declineOfferByLink({ token, reason: String(formData.get("reason") ?? "") });
  if (!res.ok) return res;
  const view = await openOfferLink(token);
  if (view) {
    await prisma.auditLog.create({
      data: { tenantId: view.tenantId, module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: view.offerId, summary: `${view.candidateName} declined the offer from the offer portal`, actorLabel: "Candidate (offer link)", ipAddress: await clientIp() },
    }).catch(() => undefined);
  }
  return res;
}
