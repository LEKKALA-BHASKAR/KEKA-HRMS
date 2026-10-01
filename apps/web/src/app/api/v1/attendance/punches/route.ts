import { NextResponse } from "next/server";
import { authenticateApiKey, ingestPunches, MAX_PUNCHES } from "@keka/services";

/**
 * POST /api/v1/attendance/punches — push raw punches from a biometric device
 * bridge or any other client. Authenticated by an API key with the
 * attendance:write scope; the key decides the company.
 *
 *   { "punches": [ { "employeeCode": "ACM0009", "timestamp": "2026-10-01T09:04:00+05:30",
 *                    "direction": "IN", "deviceSerial": "BLR-GATE-1" } ] }
 *
 * direction and deviceSerial are optional. The response counts what was
 * accepted, what was already recorded, and why any punch was rejected (by
 * its index in the array). GET with the same key checks the connection.
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const auth = await authenticateApiKey(req.headers.get("authorization"), "attendance:write");
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  return json({ ok: true, maxPunchesPerRequest: MAX_PUNCHES });
}

export async function POST(req: Request) {
  const auth = await authenticateApiKey(req.headers.get("authorization"), "attendance:write");
  if (!auth.ok) return json({ error: auth.message }, auth.status);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "The body must be JSON." }, 400); }
  const punches = (body as { punches?: unknown })?.punches;
  if (!Array.isArray(punches) || punches.length === 0) return json({ error: "Send { \"punches\": [ ... ] } with at least one punch." }, 400);
  if (punches.length > MAX_PUNCHES) return json({ error: `Send at most ${MAX_PUNCHES} punches per request.` }, 413);
  const result = await ingestPunches(auth.caller.tenantId, punches.map((p) => (p && typeof p === "object" ? p : {})));
  return json(result, result.accepted === 0 && result.duplicates === 0 ? 422 : 200);
}
