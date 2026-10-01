import { apiListLeave } from "@keka/services";
import { caller, json } from "../../_lib";

/**
 * GET /api/v1/leave/requests?from=2026-10-01&to=2026-10-31&status=APPROVED
 * Who is on leave when (never why). Scope: leave:read.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await caller(req, "leave:read");
  if (c.error) return c.error;
  const q = new URL(req.url).searchParams;
  const r = await apiListLeave(c.tenantId!, { from: q.get("from"), to: q.get("to"), status: q.get("status"), cursor: q.get("cursor"), limit: q.get("limit") });
  return r.ok ? json({ data: r.data, nextCursor: r.nextCursor }) : json({ error: r.message }, 400);
}
