import { prisma } from "@keka/db";

/**
 * Asking employees for documents. A request is an EmployeeDocument waiting on
 * the employee (PENDING_ON_EMPLOYEE); they upload against it from Documents.
 * Requests are idempotent: someone who already has a row of that type, in any
 * state, is not asked again.
 */

const LIVE = { status: { not: "EXITED" as const } };

/** Request one employee-scope document type from everyone, or the given people. Returns how many were asked. */
export async function requestDocumentType(documentTypeId: string, employeeIds?: string[]): Promise<number> {
  const type = await prisma.documentType.findUniqueOrThrow({ where: { id: documentTypeId }, include: { folder: true } });
  if (type.folder.scope !== "EMPLOYEE") return 0;
  const people = await prisma.employee.findMany({
    where: { tenantId: type.folder.tenantId, ...LIVE, ...(employeeIds ? { id: { in: employeeIds } } : {}), documents: { none: { documentTypeId: type.id } } },
    select: { id: true },
  });
  if (!people.length) return 0;
  const r = await prisma.employeeDocument.createMany({
    data: people.map((p) => ({
      tenantId: type.folder.tenantId, employeeId: p.id, folderId: type.folderId, documentTypeId: type.id,
      name: type.name, status: "PENDING_ON_EMPLOYEE" as const,
    })),
  });
  return r.count;
}

/** Every mandatory employee document, requested from one person: run when someone joins. */
export async function requestMandatoryDocuments(employeeId: string): Promise<number> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true } });
  const types = await prisma.documentType.findMany({ where: { isMandatory: true, folder: { tenantId: emp.tenantId, scope: "EMPLOYEE" } }, select: { id: true } });
  let n = 0;
  for (const t of types) n += await requestDocumentType(t.id, [employeeId]);
  return n;
}
