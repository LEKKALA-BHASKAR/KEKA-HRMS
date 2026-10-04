import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { getViewer, can } from "@/lib/context";
import { loadFile } from "@/lib/storage";
import { erCaseFor, sharedFileAllowed, folderGrants, folderAllows } from "@keka/services";

/**
 * The only way a stored file leaves the server. Access follows what the file
 * is attached to: a filing needs statutory rights; a file about an employee
 * needs document rights over that employee (or to be that employee).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const file = await prisma.storedFile.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!file) return new NextResponse("Not found.", { status: 404 });

  let allowed = false;
  if (file.relatedType === "StatutoryFiling") allowed = can(viewer, PERMISSIONS.STATUTORY_MANAGE);
  else if (file.relatedType === "PayrollOutput") allowed = can(viewer, PERMISSIONS.PAYROLL_RUN);
  else if (file.relatedType === "Offer" || file.relatedType === "OfferSignature") allowed = can(viewer, PERMISSIONS.OFFER_MANAGE);
  else if (file.relatedType === "Invoice") allowed = can(viewer, PERMISSIONS.INVOICE_MANAGE);
  else if (file.relatedType === "CandidateResume") allowed = can(viewer, PERMISSIONS.CANDIDATE_MANAGE);
  else if (file.relatedType === "Asset" || file.relatedType === "AssetImport") allowed = can(viewer, PERMISSIONS.ASSET_MANAGE) || can(viewer, PERMISSIONS.ASSET_ASSIGN);
  else if (file.relatedType === "ComplianceEvidence") allowed = can(viewer, PERMISSIONS.COMPLIANCE_VIEW) || (!!file.relatedId && (await prisma.complianceItem.count({ where: { id: file.relatedId, tenantId: viewer.tenantId, ownerUserId: viewer.user.id } })) > 0);
  // Policies are published to every employee for acknowledgement.
  else if (file.relatedType === "PolicyDocument") allowed = true;
  else if (file.relatedType === "CourseModule") {
    // A course PDF: its builders, and anyone enrolled in the course.
    const m = file.relatedId ? await prisma.courseModule.findFirst({ where: { id: file.relatedId, program: { tenantId: viewer.tenantId } }, select: { programId: true } }) : null;
    allowed = !!m && (can(viewer, PERMISSIONS.TRAINING_MANAGE) || (!!viewer.employee && (await prisma.trainingEnrolment.count({ where: { programId: m.programId, employeeId: viewer.employee.id, status: { not: "WITHDRAWN" } } })) > 0));
  }
  // E-sign documents and signatures: the sender, anyone on the envelope, and document managers.
  else if (file.relatedType === "SignatureEnvelope") {
    const env = file.relatedId ? await prisma.signatureEnvelope.findFirst({ where: { id: file.relatedId, tenantId: viewer.tenantId }, select: { createdByUserId: true, recipients: { select: { userId: true } } } }) : null;
    allowed = !!env && (env.createdByUserId === viewer.user.id || env.recipients.some((r) => r.userId === viewer.user.id) || can(viewer, PERMISSIONS.DOCUMENT_MANAGE));
  }
  // Case evidence follows the case's own access rules (the subject never sees it).
  else if (file.relatedType === "ErEvidence") {
    allowed = !!file.relatedId && !!(await erCaseFor({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null, canManage: can(viewer, PERMISSIONS.ER_CASE_MANAGE), canApprove: can(viewer, PERMISSIONS.ER_CASE_APPROVE) }, file.relatedId));
  }
  // A time-limited share opens one employee document to a named person.
  else if (file.relatedType === "EmployeeDocument" && file.relatedId && file.employeeId !== viewer.employee?.id && (await sharedFileAllowed(viewer.tenantId, viewer.user.id, file.relatedId))) allowed = true;
  else if (file.employeeId) {
    if (file.employeeId === viewer.employee?.id) allowed = true;
    else {
      const t = await prisma.employee.findUnique({ where: { id: file.employeeId }, select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } });
      const perm = file.relatedType === "Form16" || file.relatedType === "Form16PartA" ? PERMISSIONS.PAY_REGISTER_VIEW : file.relatedType === "FnfStatement" ? PERMISSIONS.FNF_MANAGE : file.relatedType === "ExpenseReceipt" ? PERMISSIONS.EXPENSE_VIEW : file.relatedType === "DeclarationItem" ? PERMISSIONS.TAX_DECLARATION_APPROVE : file.relatedType === "AttendanceSelfie" ? PERMISSIONS.ATTENDANCE_VIEW : file.relatedType === "BgvReport" ? PERMISSIONS.BGV_MANAGE : PERMISSIONS.DOCUMENT_VIEW;
      allowed = !!t && canAccessEmployee(viewer, t, perm);
      // Confidential folders additionally need a listed role or an approved access grant.
      if (allowed && file.relatedType === "EmployeeDocument" && file.relatedId) {
        const doc = await prisma.employeeDocument.findFirst({ where: { id: file.relatedId, tenantId: viewer.tenantId }, select: { folder: { select: { id: true, isConfidential: true, viewRoles: true, editRoles: true } } } });
        if (doc?.folder?.isConfidential) {
          const grant = (await folderGrants(viewer.tenantId, viewer.user.id)).get(doc.folder.id);
          const roleNames = viewer.grants.flatMap((g) => [g.roleKey ?? "", g.roleName]).filter(Boolean);
          allowed = folderAllows(doc.folder, { roleNames, isOwnDocument: false, hasGrant: !!grant, grantCanEdit: !!grant?.canEdit, canManageAll: can(viewer, PERMISSIONS.DOCUMENT_MANAGE) }, "view");
        }
      }
    }
  } else allowed = can(viewer, PERMISSIONS.ORG_SETTINGS_MANAGE);
  // Not-found rather than forbidden, so ids cannot be probed.
  if (!allowed) return new NextResponse("Not found.", { status: 404 });

  const data = await loadFile(file.storageKey, file.sha256);
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "REPORT", action: "EXPORT", entityType: "StoredFile", entityId: file.id, summary: `Downloaded ${file.filename}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": file.mimeType,
      // ?inline=1 shows a PDF in the browser (the résumé preview); anything else always downloads.
      "Content-Disposition": `${new URL(req.url).searchParams.get("inline") === "1" && file.mimeType === "application/pdf" ? "inline" : "attachment"}; filename="${file.filename.replace(/"/g, "")}"`,
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
