import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { hashBody } from "./letters";
import { activeRecipients, envelopeOutcome, reminderDue } from "./cases-docs-math";

/**
 * Multi-signer e-signature. An envelope carries one document (an uploaded
 * file or a generated letter) and its fingerprint, and an ordered list of
 * recipients: signers sign in order (or all at once), approvers approve,
 * CCs get the completed copy. Any signer can decline with a reason, which
 * stops the envelope, or delegate to a colleague. Pending signers are
 * reminded on the envelope's cadence; envelopes past their expiry stop.
 * Every step is an event, and the events plus the signers' records form the
 * signature certificate.
 */

type R = { ok: boolean; message: string };
export const esRef = (n: number) => `ES-${n}`;
export const ENVELOPE_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft", SENT: "Out for signature", COMPLETED: "Completed", DECLINED: "Declined", VOIDED: "Voided", EXPIRED: "Expired" };
export const RECIPIENT_ROLES = { SIGNER: "Signs", APPROVER: "Approves", CC: "Receives a copy" } as const;

async function event(tx: Prisma.TransactionClient, tenantId: string, envelopeId: string, kind: string, opts: { recipientId?: string | null; actorUserId?: string | null; ip?: string | null; note?: string | null } = {}) {
  await tx.signatureEvent.create({ data: { tenantId, envelopeId, kind, recipientId: opts.recipientId ?? null, actorUserId: opts.actorUserId ?? null, ip: opts.ip ?? null, note: opts.note ?? null } });
}

export interface EnvelopeRecipientInput { userId: string; role: string; order: number }

export async function createEnvelope(input: {
  tenantId: string; userId: string; title: string; message?: string | null; fileId?: string | null; letterId?: string | null; sequential: boolean;
  recipients: EnvelopeRecipientInput[]; reminderEveryDays?: number | null; expiresOn?: Date | null;
}): Promise<R & { id?: string; number?: number }> {
  const t = input.tenantId;
  const title = input.title.trim();
  if (title.length < 3 || title.length > 160) return { ok: false, message: "Give the envelope a title (3 to 160 characters)." };
  if (!!input.fileId === !!input.letterId) return { ok: false, message: "Attach a file or pick a letter." };
  let contentHash: string, employeeId: string | null = null;
  if (input.fileId) {
    const f = await prisma.storedFile.findFirst({ where: { id: input.fileId, tenantId: t } });
    if (!f) return { ok: false, message: "File not found." };
    contentHash = f.sha256;
    employeeId = f.employeeId;
  } else {
    const l = await prisma.generatedDocument.findFirst({ where: { id: input.letterId!, employee: { tenantId: t } } });
    if (!l) return { ok: false, message: "Letter not found." };
    if (l.status === "VOID" || l.status === "REJECTED" || l.status === "PENDING_APPROVAL") return { ok: false, message: "That letter is not issued." };
    contentHash = hashBody(l.renderedBody);
    employeeId = l.employeeId;
  }
  const rs = input.recipients.filter((r) => r.userId);
  if (!rs.some((r) => r.role === "SIGNER" || r.role === "APPROVER")) return { ok: false, message: "Add at least one signer." };
  if (rs.some((r) => !(r.role in RECIPIENT_ROLES))) return { ok: false, message: "Pick each recipient's role." };
  if (new Set(rs.map((r) => r.userId)).size !== rs.length) return { ok: false, message: "Each person can appear once." };
  if (rs.length > 10) return { ok: false, message: "Up to 10 recipients." };
  const users = await prisma.user.findMany({ where: { id: { in: rs.map((r) => r.userId) }, tenantId: t, loginDisabled: false }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
  if (users.length !== rs.length) return { ok: false, message: "A recipient was not found or cannot sign in." };
  if (input.reminderEveryDays !== null && input.reminderEveryDays !== undefined && (!Number.isInteger(input.reminderEveryDays) || input.reminderEveryDays < 1 || input.reminderEveryDays > 30)) return { ok: false, message: "Remind every 1 to 30 days, or never." };
  if (input.expiresOn && input.expiresOn < new Date()) return { ok: false, message: "The expiry date has passed." };
  const byId = new Map(users.map((u) => [u.id, u]));
  const env = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${t} FOR UPDATE`;
    const last = await tx.signatureEnvelope.aggregate({ where: { tenantId: t }, _max: { number: true } });
    const e = await tx.signatureEnvelope.create({
      data: {
        tenantId: t, number: (last._max.number ?? 1000) + 1, title, message: input.message?.trim() || null, fileId: input.fileId ?? null, letterId: input.letterId ?? null,
        contentHash, sequential: input.sequential, employeeId, reminderEveryDays: input.reminderEveryDays ?? null, expiresOn: input.expiresOn ?? null, createdByUserId: input.userId,
      },
    });
    await tx.signatureRecipient.createMany({
      data: rs.map((r) => {
        const u = byId.get(r.userId)!;
        return { tenantId: t, envelopeId: e.id, order: Math.max(1, Math.min(10, Math.round(r.order) || 1)), userId: u.id, name: u.employee?.displayName ?? u.email, email: u.email, role: r.role };
      }),
    });
    await event(tx, t, e.id, "CREATED", { actorUserId: input.userId });
    return e;
  });
  return { ok: true, id: env.id, number: env.number, message: `${esRef(env.number)} saved as a draft.` };
}

async function activate(tenantId: string, envelopeId: string): Promise<string[]> {
  const env = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { recipients: true } });
  const now = activeRecipients(env.recipients, env.sequential).filter((r) => r.status === "WAITING");
  if (now.length) await prisma.signatureRecipient.updateMany({ where: { id: { in: now.map((r) => r.id) } }, data: { status: "PENDING" } });
  if (now.length) await notify({ tenantId, userIds: now.map((r) => r.userId), kind: "ESIGN", title: `Please ${now[0]!.role === "APPROVER" ? "approve" : "sign"}: ${env.title}`, body: env.message, link: `/documents/esign/${env.id}`, email: true });
  return now.map((r) => r.id);
}

export async function sendEnvelope(input: { tenantId: string; id: string; userId: string }): Promise<R> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (!env) return { ok: false, message: "Envelope not found." };
  if (env.status !== "DRAFT") return { ok: false, message: "Only a draft can be sent." };
  await prisma.$transaction(async (tx) => {
    await tx.signatureEnvelope.update({ where: { id: env.id }, data: { status: "SENT", sentAt: new Date() } });
    await event(tx, input.tenantId, env.id, "SENT", { actorUserId: input.userId });
  });
  const n = await activate(input.tenantId, env.id);
  return { ok: true, message: `Sent; ${n.length} recipient${n.length === 1 ? " is" : "s are"} asked to sign now.` };
}

/** The recipient row a user acts on in an envelope, if any. */
export async function myRecipient(tenantId: string, envelopeId: string, userId: string) {
  return prisma.signatureRecipient.findFirst({ where: { tenantId, envelopeId, userId, status: { notIn: ["DELEGATED"] } }, orderBy: { createdAt: "desc" } });
}

export async function markViewed(input: { tenantId: string; envelopeId: string; userId: string; ip?: string | null }): Promise<void> {
  const r = await myRecipient(input.tenantId, input.envelopeId, input.userId);
  if (!r || r.viewedAt || r.status !== "PENDING") return;
  await prisma.$transaction(async (tx) => {
    await tx.signatureRecipient.update({ where: { id: r.id }, data: { viewedAt: new Date() } });
    await event(tx, input.tenantId, input.envelopeId, "VIEWED", { recipientId: r.id, actorUserId: input.userId, ip: input.ip });
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function currentHash(env: { tenantId: string; fileId: string | null; letterId: string | null }): Promise<string | null> {
  if (env.fileId) return (await prisma.storedFile.findFirst({ where: { id: env.fileId, tenantId: env.tenantId }, select: { sha256: true } }))?.sha256 ?? null;
  if (env.letterId) { const l = await prisma.generatedDocument.findUnique({ where: { id: env.letterId }, select: { renderedBody: true } }); return l ? hashBody(l.renderedBody) : null; }
  return null;
}

async function finishIfDone(tenantId: string, envelopeId: string, actorUserId: string | null): Promise<string> {
  const env = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { recipients: true } });
  const out = envelopeOutcome(env.recipients);
  if (out === "COMPLETED") {
    await prisma.$transaction(async (tx) => {
      await tx.signatureEnvelope.update({ where: { id: env.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      await event(tx, tenantId, env.id, "COMPLETED", { actorUserId });
    });
    await notify({ tenantId, userIds: [env.createdByUserId, ...env.recipients.map((r) => r.userId)], kind: "ESIGN", title: `Completed: ${env.title}`, body: "Everyone has signed. The signature certificate is available.", link: `/documents/esign/${env.id}`, email: true });
    return "COMPLETED";
  }
  await activate(tenantId, env.id);
  return "IN_PROGRESS";
}

/** Sign (or approve). The drawn signature is stored by the caller first. */
export async function signEnvelope(input: { tenantId: string; envelopeId: string; userId: string; typedName: string; signatureFileId: string | null; consent: boolean; ip: string | null; userAgent: string | null }): Promise<R & { completed?: boolean }> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.envelopeId, tenantId: input.tenantId }, include: { recipients: true } });
  if (!env) return { ok: false, message: "Envelope not found." };
  if (env.status !== "SENT") return { ok: false, message: `This envelope is ${ENVELOPE_STATUS_LABEL[env.status]?.toLowerCase()}.` };
  if (env.expiresOn && env.expiresOn < new Date()) return { ok: false, message: "This envelope has expired." };
  const r = activeRecipients(env.recipients, env.sequential).find((x) => x.userId === input.userId);
  if (!r) {
    const mine = env.recipients.find((x) => x.userId === input.userId && x.status === "WAITING");
    return { ok: false, message: mine ? "It is not your turn yet; earlier signers have to sign first." : "This envelope is not waiting on you." };
  }
  if (!input.consent) return { ok: false, message: "Confirm that you agree to sign electronically." };
  if (r.role === "SIGNER") {
    if (!input.signatureFileId) return { ok: false, message: "Draw your signature." };
    const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, employee: { select: { displayName: true, firstName: true, lastName: true } } } });
    const names = [r.name, u?.employee?.displayName, u?.employee ? `${u.employee.firstName} ${u.employee.lastName}` : null].filter((n): n is string => !!n).map(norm);
    if (!names.includes(norm(input.typedName))) return { ok: false, message: "Type your full name exactly as it appears on the envelope." };
  }
  if ((await currentHash(env)) !== env.contentHash) return { ok: false, message: "The document has changed since it was sent; it cannot be signed. Ask the sender to void and resend it." };
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.signatureRecipient.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "SIGNED", signedAt: new Date(), typedName: input.typedName.trim() || null, signatureFileId: input.signatureFileId, ip: input.ip, userAgent: input.userAgent?.slice(0, 300) ?? null, viewedAt: r.viewedAt ?? new Date() } });
    if (!claimed.count) throw new Error("Already signed.");
    await event(tx, input.tenantId, env.id, "SIGNED", { recipientId: r.id, actorUserId: input.userId, ip: input.ip, note: r.role === "APPROVER" ? "Approved" : `Signed as "${input.typedName.trim()}"` });
  });
  const state = await finishIfDone(input.tenantId, env.id, input.userId);
  return { ok: true, completed: state === "COMPLETED", message: state === "COMPLETED" ? "Signed — everyone has now signed." : "Signed. The next signer has been asked." };
}

export async function declineEnvelope(input: { tenantId: string; envelopeId: string; userId: string; reason: string; ip: string | null }): Promise<R> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.envelopeId, tenantId: input.tenantId }, include: { recipients: true } });
  if (!env || env.status !== "SENT") return { ok: false, message: "This envelope is not out for signature." };
  const r = activeRecipients(env.recipients, env.sequential).find((x) => x.userId === input.userId);
  if (!r) return { ok: false, message: "This envelope is not waiting on you." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why you are declining." };
  await prisma.$transaction(async (tx) => {
    await tx.signatureRecipient.update({ where: { id: r.id }, data: { status: "DECLINED", declineReason: input.reason.trim() } });
    await tx.signatureEnvelope.update({ where: { id: env.id }, data: { status: "DECLINED" } });
    await tx.signatureRecipient.updateMany({ where: { envelopeId: env.id, status: { in: ["WAITING", "PENDING"] }, NOT: { id: r.id } }, data: { status: "SKIPPED" } });
    await event(tx, input.tenantId, env.id, "DECLINED", { recipientId: r.id, actorUserId: input.userId, ip: input.ip, note: input.reason.trim() });
  });
  await notify({ tenantId: input.tenantId, userIds: [env.createdByUserId], kind: "ESIGN", title: `${r.name} declined to sign ${env.title}`, body: input.reason.trim(), link: `/documents/esign/${env.id}`, email: true });
  return { ok: true, message: "Declined. The sender has been told why." };
}

export async function delegateSignature(input: { tenantId: string; envelopeId: string; userId: string; toUserId: string; reason: string }): Promise<R> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.envelopeId, tenantId: input.tenantId }, include: { recipients: true } });
  if (!env || env.status !== "SENT") return { ok: false, message: "This envelope is not out for signature." };
  const r = env.recipients.find((x) => x.userId === input.userId && (x.status === "PENDING" || x.status === "WAITING"));
  if (!r) return { ok: false, message: "This envelope is not waiting on you." };
  if (r.role === "CC") return { ok: false, message: "Copies cannot be delegated." };
  if (env.recipients.some((x) => x.userId === input.toUserId && x.status !== "DELEGATED")) return { ok: false, message: "That person is already on the envelope." };
  const to = await prisma.user.findFirst({ where: { id: input.toUserId, tenantId: input.tenantId, loginDisabled: false }, select: { id: true, email: true, employee: { select: { displayName: true } } } });
  if (!to) return { ok: false, message: "That person does not exist." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why you are delegating." };
  await prisma.$transaction(async (tx) => {
    await tx.signatureRecipient.update({ where: { id: r.id }, data: { status: "DELEGATED" } });
    const n = await tx.signatureRecipient.create({ data: { tenantId: input.tenantId, envelopeId: env.id, order: r.order, userId: to.id, name: to.employee?.displayName ?? to.email, email: to.email, role: r.role, status: r.status, delegatedFromId: r.id } });
    await event(tx, input.tenantId, env.id, "DELEGATED", { recipientId: n.id, actorUserId: input.userId, note: `${r.name} delegated to ${n.name}: ${input.reason.trim()}` });
  });
  if (r.status === "PENDING") await notify({ tenantId: input.tenantId, userIds: [to.id], kind: "ESIGN", title: `Please sign on ${r.name}'s behalf: ${env.title}`, link: `/documents/esign/${env.id}`, email: true });
  return { ok: true, message: `Delegated to ${to.employee?.displayName ?? to.email}.` };
}

export async function voidEnvelope(input: { tenantId: string; envelopeId: string; userId: string; reason: string }): Promise<R> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.envelopeId, tenantId: input.tenantId }, include: { recipients: true } });
  if (!env || !["DRAFT", "SENT"].includes(env.status)) return { ok: false, message: "Only a draft or an envelope out for signature can be voided." };
  if (input.reason.trim().length < 5) return { ok: false, message: "Say why it is voided." };
  await prisma.$transaction(async (tx) => {
    await tx.signatureEnvelope.update({ where: { id: env.id }, data: { status: "VOIDED", voidReason: input.reason.trim() } });
    await tx.signatureRecipient.updateMany({ where: { envelopeId: env.id, status: { in: ["WAITING", "PENDING"] } }, data: { status: "SKIPPED" } });
    await event(tx, input.tenantId, env.id, "VOIDED", { actorUserId: input.userId, note: input.reason.trim() });
  });
  if (env.status === "SENT") await notify({ tenantId: input.tenantId, userIds: env.recipients.filter((r) => r.status === "PENDING").map((r) => r.userId), kind: "ESIGN", title: `No longer needed: ${env.title}`, body: input.reason.trim(), link: `/documents/esign/${env.id}` });
  return { ok: true, message: "Envelope voided." };
}

export async function remindRecipients(input: { tenantId: string; envelopeId: string; userId: string | null }): Promise<R & { reminded?: number }> {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: input.envelopeId, tenantId: input.tenantId }, include: { recipients: true } });
  if (!env || env.status !== "SENT") return { ok: false, message: "This envelope is not out for signature." };
  const pending = env.recipients.filter((r) => r.status === "PENDING");
  if (!pending.length) return { ok: false, message: "Nobody is waiting to sign." };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const r of pending) {
      await tx.signatureRecipient.update({ where: { id: r.id }, data: { remindedAt: now, remindCount: { increment: 1 } } });
      await event(tx, input.tenantId, env.id, "REMINDED", { recipientId: r.id, actorUserId: input.userId, note: input.userId ? "Reminder sent by the sender" : "Automatic reminder" });
    }
  });
  await notify({ tenantId: input.tenantId, userIds: pending.map((r) => r.userId), kind: "ESIGN", title: `Reminder: please sign ${env.title}`, link: `/documents/esign/${env.id}`, email: true });
  return { ok: true, reminded: pending.length, message: `Reminded ${pending.length} signer${pending.length === 1 ? "" : "s"}.` };
}

/** Nightly: remind on each envelope's cadence; stop envelopes past their expiry. */
export async function runSignatureReminders(tenantId: string, now = new Date()): Promise<{ reminded: number; expired: number }> {
  let reminded = 0, expired = 0;
  const envs = await prisma.signatureEnvelope.findMany({ where: { tenantId, status: "SENT" }, include: { recipients: true } });
  for (const env of envs) {
    if (env.expiresOn && env.expiresOn < now) {
      await prisma.$transaction(async (tx) => {
        await tx.signatureEnvelope.update({ where: { id: env.id }, data: { status: "EXPIRED" } });
        await tx.signatureRecipient.updateMany({ where: { envelopeId: env.id, status: { in: ["WAITING", "PENDING"] } }, data: { status: "SKIPPED" } });
        await event(tx, tenantId, env.id, "EXPIRED", {});
      });
      await notify({ tenantId, userIds: [env.createdByUserId], kind: "ESIGN", title: `Expired unsigned: ${env.title}`, link: `/documents/esign/${env.id}` });
      expired++;
      continue;
    }
    const due = env.recipients.filter((r) => reminderDue(r, env.sentAt, env.reminderEveryDays, now));
    if (!due.length) continue;
    const res = await remindRecipients({ tenantId, envelopeId: env.id, userId: null });
    reminded += res.reminded ?? 0;
  }
  return { reminded, expired };
}

/** Everything the signature certificate shows. */
export async function envelopeCertificate(tenantId: string, envelopeId: string) {
  const env = await prisma.signatureEnvelope.findFirst({ where: { id: envelopeId, tenantId }, include: { recipients: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] }, events: { orderBy: { createdAt: "asc" } } } });
  if (!env) return null;
  const fingerprint = createHash("sha256").update([env.contentHash, ...env.recipients.map((r) => `${r.id}:${r.status}:${r.signedAt?.toISOString() ?? ""}`)].join("|")).digest("hex");
  return { env, fingerprint };
}
