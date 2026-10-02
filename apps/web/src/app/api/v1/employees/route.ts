import { apiListEmployees } from "@keka/services";
import { caller, json } from "../_lib";

/**
 * GET /api/v1/employees?limit=50&cursor=<id>&status=ACTIVE,PROBATION&updatedSince=2026-09-01
 * The employee directory (no pay, bank, identity or personal contact
 * details). Page with nextCursor until it is null. Scope: employees:read.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await caller(req, "employees:read");
  if (c.error) return c.error;
  const q = new URL(req.url).searchParams;
  const r = await apiListEmployees(c.tenantId!, { cursor: q.get("cursor"), limit: q.get("limit"), status: q.get("status"), updatedSince: q.get("updatedSince") });
  return r.ok ? json({ data: r.data, nextCursor: r.nextCursor }) : json({ error: r.message }, 400);
}
