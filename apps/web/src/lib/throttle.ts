import "server-only";
import { headers } from "next/headers";

/**
 * A sliding-window limit kept in memory, for public pages that anyone can
 * hit without signing in. Per process: enough to blunt scripted guessing and
 * hammering; the tokens themselves are what make guessing pointless.
 */
const buckets = new Map<string, number[]>();

export function throttled(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { buckets.set(key, hits); return true; }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
  return false;
}

/** The caller's address as the proxy reports it. */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || null;
}
