import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { renderCertificate } from "@keka/documents";
import { getViewer } from "@/lib/context";
import { reaches } from "@/lib/growth";

/** A completion certificate as a PDF: for its holder, and for whoever tracks their learning. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse("Sign in first.", { status: 401 });
  const { id } = await params;
  const cert = await prisma.learningCertificate.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { course: { select: { title: true, credits: true } }, employee: { select: { displayName: true } }, tenant: { select: { name: true } } },
  });
  // Not-found rather than forbidden, so ids cannot be probed.
  if (!cert) return new NextResponse("Not found.", { status: 404 });
  const own = cert.employeeId === viewer.employee?.id;
  if (!own && !(await reaches(viewer, cert.employeeId, PERMISSIONS.COURSE_ASSIGN))) return new NextResponse("Not found.", { status: 404 });
  if (cert.revokedAt) return new NextResponse("This certificate has been revoked.", { status: 410 });
  const enrolment = await prisma.courseEnrolment.findUnique({ where: { id: cert.enrolmentId }, select: { score: true } });
  const pdf = renderCertificate({
    company: cert.tenant.name, learner: cert.employee.displayName ?? "", course: cert.course.title, number: cert.number,
    issuedOn: formatDate(cert.issuedAt), expiresOn: cert.expiresAt ? formatDate(cert.expiresAt) : null,
    score: enrolment?.score ?? null, credits: cert.course.credits || null,
  });
  await prisma.auditLog.create({
    data: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: "EXPORT", entityType: "LearningCertificate", entityId: cert.id, summary: `Downloaded certificate ${cert.number}`, actorId: viewer.user.id, actorLabel: viewer.user.email },
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${cert.number}.pdf"`, "Cache-Control": "no-store" },
  });
}
