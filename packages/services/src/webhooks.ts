import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma, type Prisma } from "@keka/db";

/**
 * Outgoing webhooks. Events are queued as one delivery per subscribed
 * endpoint and sent by the deliver-webhooks job, so a slow receiver never
 * holds up the request that raised the event. Each POST carries:
 *
 *   X-Keka-Event: employee.created
 *   X-Keka-Delivery: <delivery id>          (receivers dedupe on this)
 *   X-Keka-Timestamp: <unix seconds>
 *   X-Keka-Signature: sha256=<hex HMAC of "<timestamp>.<body>" with the secret>
 *
 * Failures retry with backoff; after the last attempt the delivery is failed,
 * and an endpoint that keeps failing is paused until someone re-enables it.
 * Only public https addresses are called: private, loopback and link-local
 * addresses are refused at send time, after DNS, so a hostname cannot be
 * pointed at the internal network.
 */

export const WEBHOOK_EVENTS = {
  "employee.created": "An employee is added",
  "employee.exited": "An employee's exit is completed",
  "leave.approved": "A leave request is approved",
  "payroll.finalized": "A payroll run is finalised",
  "ping": "A test event sent from settings",
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

const BACKOFF_MIN = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
export const PAUSE_AFTER_FAILURES = 15;
type R = { ok: boolean; message: string };

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Whether a URL may be called: https, a real host, not an internal address. */
export async function checkWebhookUrl(raw: string, resolve = true): Promise<{ ok: true; url: URL } | { ok: false; message: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, message: "Enter a full https:// address." }; }
  if (url.protocol !== "https:") return { ok: false, message: "Webhook addresses must use https." };
  if (url.username || url.password) return { ok: false, message: "Put credentials in the signature check, not the address." };
  if (url.port && url.port !== "443") return { ok: false, message: "Use the standard https port." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return { ok: false, message: "That address is not reachable from the internet." };
  if (isIP(host)) { if (privateAddress(host)) return { ok: false, message: "That address is not reachable from the internet." }; }
  else if (resolve) {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (addrs.length === 0) return { ok: false, message: "That host name does not resolve." };
    if (addrs.some((a) => privateAddress(a.address))) return { ok: false, message: "That address is not reachable from the internet." };
  }
  return { ok: true, url };
}

export async function createWebhook(input: { tenantId: string; url: string; events: string[]; description?: string | null; createdBy: string | null; resolve?: boolean }): Promise<R & { id?: string; secret?: string }> {
  const events = [...new Set(input.events)].filter((e) => e in WEBHOOK_EVENTS && e !== "ping");
  if (events.length === 0) return { ok: false, message: "Pick at least one event." };
  const chk = await checkWebhookUrl(input.url.trim(), input.resolve ?? true);
  if (!chk.ok) return chk;
  if ((await prisma.webhookEndpoint.count({ where: { tenantId: input.tenantId } })) >= 20) return { ok: false, message: "A company can have up to 20 webhook endpoints." };
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.webhookEndpoint.create({ data: { tenantId: input.tenantId, url: chk.url.toString(), events, description: input.description?.trim() || null, secret, createdBy: input.createdBy } });
  return { ok: true, id: row.id, secret, message: "Webhook added. Copy the signing secret now; it will not be shown again." };
}

export async function setWebhookActive(tenantId: string, id: string, active: boolean): Promise<R> {
  const r = await prisma.webhookEndpoint.updateMany({ where: { id, tenantId }, data: { isActive: active, ...(active ? { failureCount: 0 } : {}) } });
  return r.count ? { ok: true, message: active ? "Webhook resumed." : "Webhook paused." } : { ok: false, message: "Webhook not found." };
}

export async function deleteWebhook(tenantId: string, id: string): Promise<R> {
  const r = await prisma.webhookEndpoint.deleteMany({ where: { id, tenantId } });
  return r.count ? { ok: true, message: "Webhook removed." } : { ok: false, message: "Webhook not found." };
}

/**
 * Queue an event for every active endpoint of the tenant that listens for it.
 * Never throws: an event that cannot be queued must not undo the action that
 * raised it.
 */
export async function emitEvent(tenantId: string, event: WebhookEvent, data: Record<string, unknown>, endpointId?: string): Promise<number> {
  try {
    const eps = await prisma.webhookEndpoint.findMany({ where: { tenantId, isActive: true, ...(endpointId ? { id: endpointId } : { events: { has: event } }) }, select: { id: true } });
    if (eps.length === 0) return 0;
    const payload = { event, occurredAt: new Date().toISOString(), data } as unknown as Prisma.InputJsonValue;
    await prisma.webhookDelivery.createMany({ data: eps.map((e) => ({ endpointId: e.id, event, payload })) });
    return eps.length;
  } catch {
    return 0;
  }
}

export type WebhookSender = (url: string, init: { body: string; headers: Record<string, string> }) => Promise<{ status: number }>;

const fetchSender: WebhookSender = async (url, init) => {
  const res = await fetch(url, { method: "POST", body: init.body, headers: init.headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};

/** Send due deliveries. Idempotent per delivery: one claim, one attempt. */
export async function deliverWebhooks(opts: { limit?: number; send?: WebhookSender; resolve?: boolean; now?: Date } = {}): Promise<{ sent: number; failed: number; retrying: number }> {
  const now = opts.now ?? new Date();
  const send = opts.send ?? fetchSender;
  const due = await prisma.webhookDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now }, endpoint: { isActive: true } },
    include: { endpoint: true }, orderBy: { nextAttemptAt: "asc" }, take: opts.limit ?? 200,
  });
  let sent = 0, failed = 0, retrying = 0;
  for (const d of due) {
    // Claim it, so two job runs never send the same attempt.
    const claimed = await prisma.webhookDelivery.updateMany({ where: { id: d.id, status: "PENDING", attempts: d.attempts }, data: { attempts: d.attempts + 1 } });
    if (!claimed.count) continue;
    const attempt = d.attempts + 1;
    const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
    const ts = Math.floor(now.getTime() / 1000);
    let status: number | null = null, error: string | null = null;
    const chk = await checkWebhookUrl(d.endpoint.url, opts.resolve ?? true);
    if (!chk.ok) error = chk.message;
    else {
      try {
        status = (await send(d.endpoint.url, { body, headers: { "Content-Type": "application/json", "User-Agent": "Keka-Webhooks/1", "X-Keka-Event": d.event, "X-Keka-Delivery": d.id, "X-Keka-Timestamp": String(ts), "X-Keka-Signature": signPayload(d.endpoint.secret, ts, body) } })).status;
        if (status < 200 || status >= 300) error = `Responded ${status}`;
      } catch (e) { error = e instanceof Error ? e.message.slice(0, 300) : "Request failed"; }
    }
    if (!error) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "DELIVERED", deliveredAt: now, responseStatus: status, error: null } });
      await prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { failureCount: 0, lastSuccessAt: now } });
      sent++;
      continue;
    }
    const final = attempt >= MAX_ATTEMPTS;
    await prisma.webhookDelivery.update({
      where: { id: d.id },
      data: { status: final ? "FAILED" : "PENDING", responseStatus: status, error, nextAttemptAt: final ? now : new Date(now.getTime() + BACKOFF_MIN[attempt - 1]! * 60_000) },
    });
    const ep = await prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { failureCount: { increment: 1 } } });
    if (ep.failureCount >= PAUSE_AFTER_FAILURES) await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { isActive: false } });
    if (final) failed++; else retrying++;
  }
  return { sent, failed, retrying };
}

/** Send a failed delivery again from the start of its retry schedule. */
export async function retryDelivery(tenantId: string, id: string): Promise<R> {
  const r = await prisma.webhookDelivery.updateMany({ where: { id, status: "FAILED", endpoint: { tenantId } }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), error: null } });
  return r.count ? { ok: true, message: "Queued to send again." } : { ok: false, message: "Only failed deliveries can be retried." };
}
