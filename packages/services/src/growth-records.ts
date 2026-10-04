import { prisma } from "@keka/db";
import { addMonths, certificateNumber, pathProgress, DEFAULT_READINESS, NINE_BOX_DEFAULTS } from "./growth-math";

/**
 * Records that follow from learning: the certificate a completed course
 * earns, and the learning paths a course completion moves forward. Kept free
 * of the enrolment code so that code can call in here without a cycle.
 */

/**
 * Issue the certificate for a completed enrolment, once. The number is the
 * company's next in sequence; expiry follows the course's validity.
 */
export async function issueCertificate(enrolmentId: string): Promise<{ id: string; number: string } | null> {
  const e = await prisma.courseEnrolment.findUnique({ where: { id: enrolmentId }, include: { course: true } });
  if (!e || e.status !== "COMPLETED") return null;
  const existing = await prisma.learningCertificate.findUnique({ where: { enrolmentId } });
  if (existing) return { id: existing.id, number: existing.number };
  const issuedAt = e.completedAt ?? new Date();
  for (let tries = 0; tries < 5; tries++) {
    const seq = (await prisma.learningCertificate.count({ where: { tenantId: e.tenantId } })) + 1 + tries;
    try {
      const c = await prisma.learningCertificate.create({
        data: {
          tenantId: e.tenantId, employeeId: e.employeeId, courseId: e.courseId, enrolmentId, number: certificateNumber(issuedAt, seq), issuedAt,
          expiresAt: e.course.certificateValidityMonths ? addMonths(issuedAt, e.course.certificateValidityMonths) : null,
        },
      });
      return { id: c.id, number: c.number };
    } catch (err) {
      if (!String(err).includes("Unique constraint")) throw err;
    }
  }
  return null;
}

/** Recompute every path assignment of one employee from their course enrolments. */
export async function refreshPathAssignments(employeeId: string, pathId?: string) {
  const assignments = await prisma.learningPathAssignment.findMany({
    where: { employeeId, ...(pathId ? { pathId } : {}) },
    include: { path: { include: { courses: { select: { courseId: true, isOptional: true } } } } },
  });
  if (assignments.length === 0) return 0;
  const enrolments = await prisma.courseEnrolment.findMany({ where: { employeeId }, select: { courseId: true, status: true, progressPercent: true } });
  for (const a of assignments) {
    const p = pathProgress(a.path.courses, enrolments);
    await prisma.learningPathAssignment.update({
      where: { id: a.id },
      data: { progressPercent: p.percent, status: p.status, completedAt: p.status === "COMPLETED" ? (a.completedAt ?? new Date()) : null },
    });
  }
  return assignments.length;
}

/** The company's readiness levels, created with the three standard ones on first use. */
export async function ensureReadinessLevels(tenantId: string) {
  const have = await prisma.readinessLevel.findMany({ where: { tenantId }, orderBy: { displayOrder: "asc" } });
  if (have.length) return have;
  await prisma.readinessLevel.createMany({ data: DEFAULT_READINESS.map((r) => ({ tenantId, ...r })), skipDuplicates: true });
  return prisma.readinessLevel.findMany({ where: { tenantId }, orderBy: { displayOrder: "asc" } });
}

/** The company's 9-box labels, filled with the standard names on first use. */
export async function ensureBoxLabels(tenantId: string) {
  const have = await prisma.talentBoxLabel.findMany({ where: { tenantId } });
  if (have.length === 9) return have;
  await prisma.talentBoxLabel.createMany({
    data: Object.entries(NINE_BOX_DEFAULTS).map(([box, d]) => ({ tenantId, box: Number(box), label: d.label, description: d.description })),
    skipDuplicates: true,
  });
  return prisma.talentBoxLabel.findMany({ where: { tenantId } });
}
