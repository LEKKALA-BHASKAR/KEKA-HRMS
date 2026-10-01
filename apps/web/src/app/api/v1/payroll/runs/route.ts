import { apiListPayrollRuns } from "@keka/services";
import { caller, json } from "../../_lib";

/** GET /api/v1/payroll/runs?year=2026 — totals of finalised runs. Scope: payroll:read. */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await caller(req, "payroll:read");
  if (c.error) return c.error;
  return json({ data: await apiListPayrollRuns(c.tenantId!, { year: new URL(req.url).searchParams.get("year") }) });
}
