import { apiGetEmployee } from "@keka/services";
import { caller, json } from "../../_lib";

/** GET /api/v1/employees/<id or employee number>. Scope: employees:read. */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await caller(req, "employees:read");
  if (c.error) return c.error;
  const { id } = await params;
  const e = await apiGetEmployee(c.tenantId!, decodeURIComponent(id));
  return e ? json({ data: e }) : json({ error: "Employee not found." }, 404);
}
