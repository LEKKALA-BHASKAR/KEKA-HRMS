import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { buildStatutoryReturn, statutoryReturnFile, statutoryReturnBase, STATUTORY_FORMS, type StatutoryForm } from "@keka/services";
import { getViewer, can } from "@/lib/context";

/**
 * A periodic statutory return — PF 3A/6A, ESI half-yearly, PT, LWF — as CSV
 * or PDF, built on request from finalised payroll. Statutory rights only.
 */
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!can(viewer, PERMISSIONS.STATUTORY_MANAGE)) return new NextResponse("Not found.", { status: 404 });

  const q = new URL(req.url).searchParams;
  const form = q.get("form") as StatutoryForm;
  if (!STATUTORY_FORMS.some((f) => f.form === form)) return new NextResponse("Unknown form.", { status: 400 });
  const fy = Number(q.get("fy"));
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return new NextResponse("Choose a financial year.", { status: 400 });
  const half = q.get("half") === "2" ? 2 : 1;
  const month = Number(q.get("month")) || undefined;
  if (form === "PT_MONTHLY" && !(month && month >= 1 && month <= 12)) return new NextResponse("Choose a month.", { status: 400 });
  const format = q.get("format") === "pdf" ? "pdf" : "csv";

  let built;
  try {
    built = await buildStatutoryReturn(viewer.tenantId, { form, fy, half, month });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not build the return.", { status: 422 });
  }
  const file = statutoryReturnFile(built, format, statutoryReturnBase({ form, fy, half, month }), viewer.tenant.name);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "PAYROLL", action: "EXPORT", entityType: "StatutoryReturn", entityId: `${form}:${fy}`, summary: `Downloaded ${file.filename}: ${built.summary}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "Content-Type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
