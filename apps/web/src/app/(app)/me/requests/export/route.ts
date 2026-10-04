import { NextResponse } from "next/server";
import { prisma } from "@keka/db";
import { getViewer } from "@/lib/context";

/**
 * Download my own data: my record and everything recorded about me that I
 * can see (not HR's internal notes). Bank account numbers are masked. The
 * download is written to the audit log.
 */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  if (!viewer.employee) return new NextResponse("This account has no employee record.", { status: 404 });
  const id = viewer.employee.id;
  const e = await prisma.employee.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      addresses: true, dependents: true, emergencyContacts: true, educations: true, experiences: true,
      bankAccounts: { select: { bankName: true, accountNumber: true, ifsc: true, branch: true, isPrimary: true } },
      department: { select: { name: true } }, location: { select: { name: true } }, legalEntity: { select: { name: true } },
    },
  });
  if (!e) return new NextResponse("Not found.", { status: 404 });
  const [changeRequests, documentRequests, idCards, jobHistory] = await Promise.all([
    prisma.recordChangeRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: id }, select: { title: true, status: true, createdAt: true, decidedAt: true, decisionNote: true } }),
    prisma.selfServiceDocumentRequest.findMany({ where: { tenantId: viewer.tenantId, employeeId: id }, select: { purpose: true, status: true, createdAt: true, type: { select: { name: true } } } }),
    prisma.employeeIdCard.findMany({ where: { tenantId: viewer.tenantId, employeeId: id }, select: { cardNumber: true, issuedAt: true, validUntil: true, status: true } }),
    prisma.jobChange.findMany({ where: { employeeId: id, tenantId: viewer.tenantId }, select: { effectiveFrom: true, reason: true, status: true }, orderBy: { effectiveFrom: "asc" } }).catch(() => []),
  ]);
  const { bankAccounts, ...rest } = e;
  const body = {
    exportedAt: new Date().toISOString(),
    employee: { ...rest, bankAccounts: bankAccounts.map((b) => ({ ...b, accountNumber: `••••${b.accountNumber.slice(-4)}` })) },
    changeRequests, documentRequests, idCards, jobHistory,
  };
  await prisma.auditLog.create({ data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "Employee", entityId: id, summary: "Downloaded their own data", actorId: viewer.user.id, actorLabel: viewer.user.email } });
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="my-data-${e.employeeNumber}.json"`, "Cache-Control": "no-store" },
  });
}
