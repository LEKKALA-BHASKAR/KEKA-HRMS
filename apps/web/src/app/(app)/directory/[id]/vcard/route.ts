import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { buildVCard } from "@keka/services";
import { getViewer } from "@/lib/context";
import { directoryWhere } from "@/lib/directory";
import { directoryVisibilityWhere } from "@/lib/core-hr";

/**
 * A colleague's contact card (vCard), with the same work-facing fields the
 * directory shows — never a personal phone or address. People left out of
 * the directory have no card, except for themselves.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const e = await prisma.employee.findFirst({
    where: { AND: [{ ...directoryWhere(viewer.tenantId), id }, await directoryVisibilityWhere(viewer)] },
    select: { id: true, firstName: true, lastName: true, displayName: true, jobTitleName: true, workEmail: true, department: { select: { name: true } }, location: { select: { name: true, city: true } } },
  });
  if (!e) return new NextResponse("Not found.", { status: 404 });
  const extra = await prisma.employeeProfileExtra.findUnique({ where: { employeeId: id }, select: { hideFromDirectory: true, pronouns: true } });
  if (extra?.hideFromDirectory && viewer.employee?.id !== id) return new NextResponse("Not found.", { status: 404 });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: viewer.tenantId }, select: { name: true } });
  const card = buildVCard({
    firstName: e.firstName, lastName: e.lastName, displayName: e.displayName, title: e.jobTitleName, org: tenant.name, department: e.department?.name,
    workEmail: e.workEmail, location: e.location ? [e.location.name, e.location.city].filter(Boolean).join(", ") : null, note: extra?.pronouns ? `Pronouns: ${extra.pronouns}` : null,
  });
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "ContactCard", entityId: id, summary: `Downloaded ${e.displayName ?? e.firstName}'s contact card`, actorId: viewer.user.id, actorLabel: viewer.user.email } });
  const file = (e.displayName ?? `${e.firstName} ${e.lastName}`).replace(/[^\w.-]+/g, "-");
  return new NextResponse(card, { headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.vcf"`, "Cache-Control": "no-store" } });
}
