import { NextResponse } from "next/server";
import { authenticateApiKey, type ApiScope } from "@keka/services";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Authenticate a request for one scope; the key decides the company. */
export async function caller(req: Request, scope: ApiScope) {
  const auth = await authenticateApiKey(req.headers.get("authorization"), scope);
  return auth.ok ? { tenantId: auth.caller.tenantId, error: null } : { tenantId: null, error: json({ error: auth.message }, auth.status) };
}
