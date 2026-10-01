"use server";

import { prisma } from "@keka/db";
import { safeRevalidate } from "@/lib/forms";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { requireAuth, requireViewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";

const P = PERMISSIONS;

async function audit(opts: {
  tenantId: string; actorId: string; actorLabel: string;
  module: "EMPLOYEE" | "PAYROLL" | "LEAVE" | "ATTENDANCE" | "ROLE" | "AUTH" | "FINANCE";
  action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT";
  entityType: string; entityId: string; summary: string;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: opts.tenantId, module: opts.module, action: opts.action,
      entityType: opts.entityType, entityId: opts.entityId,
      actorId: opts.actorId, actorLabel: opts.actorLabel, summary: opts.summary,
    },
  });
}

// ---------------------------------------------------------------------------
//  ANNOUNCEMENTS
// ---------------------------------------------------------------------------

export async function acknowledgeAnnouncement(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const announcementId = String(formData.get("announcementId"));

  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, tenantId: viewer.tenantId },
  });
  if (!announcement) throw new Error("Announcement not found");

  await prisma.announcementRead.upsert({
    where: {
      announcementId_employeeId: { announcementId, employeeId: viewer.employee.id },
    },
    create: {
      announcementId, employeeId: viewer.employee.id,
      viewedAt: new Date(),
      acknowledgedAt: announcement.requireAck ? new Date() : null,
    },
    update: { acknowledgedAt: new Date() },
  });

  safeRevalidate("/announcements");
}

/** Records a view without acknowledging, so read stats are honest. */
export async function markAnnouncementViewed(announcementId: string): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) return;
  if (!(await prisma.announcement.count({ where: { id: announcementId, tenantId: viewer.tenantId } }))) return;
  await prisma.announcementRead.upsert({
    where: { announcementId_employeeId: { announcementId, employeeId: viewer.employee.id } },
    create: { announcementId, employeeId: viewer.employee.id },
    update: {},
  });
}

export async function publishAnnouncement(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const requireAck = formData.get("requireAck") === "on";
  const isPinned = formData.get("isPinned") === "on";
  const notifyByEmail = formData.get("notifyByEmail") === "on";
  const expiresRaw = String(formData.get("expiresAt") ?? "");

  if (!title || !body) throw new Error("A title and body are both required");

  const created = await prisma.announcement.create({
    data: {
      tenantId: viewer.tenantId,
      title, body,
      status: "PUBLISHED",
      publishAt: new Date(),
      expiresAt: expiresRaw ? new Date(expiresRaw) : null,
      requireAck, isPinned, notifyByEmail,
      createdBy: viewer.employee?.id ?? null,
    },
  });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    module: "EMPLOYEE", action: "CREATE", entityType: "Announcement",
    entityId: created.id, summary: `Published announcement "${title}"`,
  });

  safeRevalidate("/announcements");
}

export async function archiveAnnouncement(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const id = String(formData.get("id"));
  await prisma.announcement.updateMany({
    where: { id, tenantId: viewer.tenantId },
    data: { status: "ARCHIVED" },
  });
  safeRevalidate("/announcements");
}

// ---------------------------------------------------------------------------
//  PRAISE AND AWARDS
// ---------------------------------------------------------------------------

export async function givePraise(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PRAISE_GIVE);
  if (!viewer.employee) throw new Error("No employee record linked to this login");

  const toEmployeeId = String(formData.get("toEmployeeId"));
  const message = String(formData.get("message") ?? "").trim();
  const badge = String(formData.get("badge") ?? "") || null;

  if (!message) throw new Error("Write a message");
  if (toEmployeeId === viewer.employee.id) {
    throw new Error("You cannot praise yourself");
  }

  const target = await prisma.employee.findFirst({
    where: { id: toEmployeeId, tenantId: viewer.tenantId },
    select: { id: true },
  });
  if (!target) throw new Error("Employee not found");

  await prisma.praise.create({
    data: {
      tenantId: viewer.tenantId,
      fromEmployeeId: viewer.employee.id,
      toEmployeeId, badge, message, isPublic: true,
    },
  });

  safeRevalidate("/awards");
}

export async function grantAward(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.AWARD_MANAGE);
  const awardTypeId = String(formData.get("awardTypeId"));
  const employeeId = String(formData.get("employeeId"));
  const period = String(formData.get("period") ?? "") || null;
  const citation = String(formData.get("citation") ?? "").trim() || null;

  const [awardType, employee] = await Promise.all([
    prisma.awardType.findFirst({ where: { id: awardTypeId, tenantId: viewer.tenantId } }),
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      select: { id: true, displayName: true },
    }),
  ]);
  if (!awardType || !employee) throw new Error("Award type or employee not found");

  const award = await prisma.employeeAward.create({
    data: {
      tenantId: viewer.tenantId,
      awardTypeId, employeeId,
      period, awardedOn: new Date(), citation,
      cashAmount: awardType.cashAmount,
      nominatedBy: viewer.employee?.id ?? null,
      approvedBy: viewer.employee?.id ?? null,
    },
  });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    module: "EMPLOYEE", action: "CREATE", entityType: "EmployeeAward",
    entityId: award.id,
    summary: `Granted "${awardType.name}" to ${employee.displayName}`,
  });

  safeRevalidate("/awards");
}

/**
 * Push a cash award into the open payroll run as an ad-hoc payment. This is
 * the seam between recognition and pay — without it the cash figure on an
 * award is decorative.
 */
export async function payAwardThroughPayroll(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const awardId = String(formData.get("awardId"));

  const award = await prisma.employeeAward.findFirst({
    where: { id: awardId, tenantId: viewer.tenantId },
    include: {
      awardType: { select: { name: true } },
      employee: { select: { id: true, payGroupId: true, displayName: true } },
    },
  });
  if (!award) throw new Error("Award not found");
  if (award.paidInRunId) throw new Error("This award has already been pushed to a payroll run");
  if (!award.cashAmount || Number(award.cashAmount) <= 0) {
    throw new Error("This award carries no cash amount");
  }
  if (!award.employee.payGroupId) throw new Error("Employee is not assigned to a pay group");

  // Target the open run for the employee's pay group.
  const run = await prisma.payrollRun.findFirst({
    where: {
      tenantId: viewer.tenantId,
      payGroupId: award.employee.payGroupId,
      status: { in: ["DRAFT", "IN_PROGRESS"] },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  if (!run) {
    throw new Error("No open payroll run for this pay group. Start one first, or lock is already in progress.");
  }

  await prisma.adhocTransaction.create({
    data: {
      employeeId: award.employeeId,
      type: "PAYMENT",
      name: `${award.awardType.name} award`,
      amount: award.cashAmount,
      taxTreatment: "TAXABLE",
      year: run.year, month: run.month, runId: run.id,
      comment: award.citation,
      createdBy: viewer.user.id,
    },
  });

  await prisma.employeeAward.update({
    where: { id: awardId },
    data: { paidInRunId: run.id },
  });

  // Recalculate so the run totals reflect it immediately.
  const { calculateRun } = await import("@keka/services");
  await calculateRun(run.id);

  safeRevalidate("/awards");
  safeRevalidate(`/payroll/runs/${run.id}`);
}

// ---------------------------------------------------------------------------
//  ASSETS
// ---------------------------------------------------------------------------

export async function assignAsset(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.ASSET_ASSIGN);
  const assetId = String(formData.get("assetId"));
  const employeeId = String(formData.get("employeeId"));
  const conditionOut = String(formData.get("conditionOut") ?? "GOOD") as
    "NEW" | "GOOD" | "FAIR" | "DAMAGED" | "UNUSABLE";
  const notes = String(formData.get("notes") ?? "") || null;

  const asset = await prisma.asset.findFirst({
    where: { id: assetId, tenantId: viewer.tenantId },
    include: { assetType: { select: { name: true } } },
  });
  if (!asset) throw new Error("Asset not found");
  if (await foreignReference(viewer.tenantId, { employee: employeeId })) throw new Error("Employee not found");
  if (asset.status === "ASSIGNED") {
    throw new Error("This asset is already assigned. Record a return first.");
  }
  if (asset.status === "RETIRED" || asset.status === "LOST") {
    throw new Error(`A ${asset.status.toLowerCase()} asset cannot be assigned`);
  }

  await prisma.$transaction([
    prisma.assetAssignment.create({
      data: {
        assetId, employeeId,
        assignedOn: new Date(), assignedBy: viewer.employee?.id ?? null,
        conditionOut, notes,
      },
    }),
    prisma.asset.update({ where: { id: assetId }, data: { status: "ASSIGNED" } }),
  ]);

  safeRevalidate("/assets");
}

export async function acknowledgeAsset(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const assignmentId = String(formData.get("assignmentId"));

  // An employee may only acknowledge their own assignment.
  const updated = await prisma.assetAssignment.updateMany({
    where: { id: assignmentId, employeeId: viewer.employee.id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new Error("Nothing to acknowledge — it may already be acknowledged, or not assigned to you");
  }

  safeRevalidate("/assets");
  safeRevalidate("/me/assets");
}

export async function returnAsset(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.ASSET_ASSIGN);
  const assignmentId = String(formData.get("assignmentId"));
  const conditionIn = String(formData.get("conditionIn") ?? "GOOD") as
    "NEW" | "GOOD" | "FAIR" | "DAMAGED" | "UNUSABLE";
  const damageChargeRaw = String(formData.get("damageCharge") ?? "").trim();
  const damageNote = String(formData.get("damageNote") ?? "") || null;

  const assignment = await prisma.assetAssignment.findUnique({
    where: { id: assignmentId },
    include: { asset: { select: { id: true, tenantId: true } } },
  });
  if (!assignment || assignment.asset.tenantId !== viewer.tenantId) {
    throw new Error("Assignment not found");
  }
  if (assignment.returnedOn) throw new Error("This asset has already been returned");

  const damageCharge = damageChargeRaw === "" ? null : Number(damageChargeRaw);
  if (damageCharge !== null && (Number.isNaN(damageCharge) || damageCharge < 0)) {
    throw new Error("Enter a valid damage charge, or leave it blank");
  }

  await prisma.$transaction([
    prisma.assetAssignment.update({
      where: { id: assignmentId },
      data: { returnedOn: new Date(), conditionIn, damageCharge, damageNote },
    }),
    prisma.asset.update({
      where: { id: assignment.asset.id },
      data: {
        // A damaged return goes to repair, not straight back into the pool.
        status: conditionIn === "DAMAGED" || conditionIn === "UNUSABLE" ? "IN_REPAIR" : "AVAILABLE",
        condition: conditionIn,
      },
    }),
  ]);

  safeRevalidate("/assets");
}

/**
 * Recover a damage charge through payroll as an ad-hoc deduction.
 * For a leaver, the charge belongs in the F&F settlement instead, which the
 * settlement screen reads directly from the assignment.
 */
export async function recoverAssetDamage(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const assignmentId = String(formData.get("assignmentId"));

  const assignment = await prisma.assetAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      asset: { select: { tenantId: true, assetTag: true, assetType: { select: { name: true } } } },
      employee: { select: { id: true, payGroupId: true } },
    },
  });
  if (!assignment || assignment.asset.tenantId !== viewer.tenantId) {
    throw new Error("Assignment not found");
  }
  if (assignment.chargeRecovered) throw new Error("This charge has already been recovered");
  if (!assignment.damageCharge || Number(assignment.damageCharge) <= 0) {
    throw new Error("There is no damage charge on this assignment");
  }
  if (!assignment.employee.payGroupId) throw new Error("Employee is not assigned to a pay group");

  const run = await prisma.payrollRun.findFirst({
    where: {
      tenantId: viewer.tenantId,
      payGroupId: assignment.employee.payGroupId,
      status: { in: ["DRAFT", "IN_PROGRESS"] },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  if (!run) throw new Error("No open payroll run for this pay group");

  await prisma.adhocTransaction.create({
    data: {
      employeeId: assignment.employee.id,
      type: "DEDUCTION",
      name: `Asset damage recovery — ${assignment.asset.assetType.name} (${assignment.asset.assetTag})`,
      amount: assignment.damageCharge,
      taxTreatment: "NON_TAXABLE",
      year: run.year, month: run.month, runId: run.id,
      comment: assignment.damageNote,
      createdBy: viewer.user.id,
    },
  });

  await prisma.assetAssignment.update({
    where: { id: assignmentId },
    data: { chargeRecovered: true },
  });

  const { calculateRun } = await import("@keka/services");
  await calculateRun(run.id);

  safeRevalidate("/assets");
  safeRevalidate(`/payroll/runs/${run.id}`);
}

export async function decideAssetRequest(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.ASSET_MANAGE);
  const id = String(formData.get("id"));
  const decision = String(formData.get("decision"));
  const reason = String(formData.get("reason") ?? "") || null;

  await prisma.assetRequest.updateMany({
    where: { id, tenantId: viewer.tenantId, status: "PENDING" },
    data: decision === "approve"
      ? { status: "APPROVED", approvedBy: viewer.employee?.id ?? null, approvedAt: new Date() }
      : { status: "REJECTED", rejectReason: reason },
  });

  safeRevalidate("/assets");
}

export async function requestAsset(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const assetTypeId = String(formData.get("assetTypeId")) || null;
  const reason = String(formData.get("reason") ?? "").trim();
  const neededByRaw = String(formData.get("neededBy") ?? "");

  if (!reason) throw new Error("Give a reason for the request");
  if (assetTypeId && !(await prisma.assetType.count({ where: { id: assetTypeId, category: { tenantId: viewer.tenantId } } }))) {
    throw new Error("Asset type not found");
  }

  await prisma.assetRequest.create({
    data: {
      tenantId: viewer.tenantId,
      employeeId: viewer.employee.id,
      assetTypeId, reason,
      neededBy: neededByRaw ? new Date(neededByRaw) : null,
    },
  });

  safeRevalidate("/assets");
  safeRevalidate("/me/assets");
}

// ---------------------------------------------------------------------------
//  DOCUMENTS
// ---------------------------------------------------------------------------

export async function verifyDocument(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.DOCUMENT_VERIFY);
  const id = String(formData.get("id"));
  const decision = String(formData.get("decision"));
  const reason = String(formData.get("reason") ?? "") || null;

  if (decision === "reject" && !reason) {
    throw new Error("Give a reason when rejecting a document");
  }
  // Verify only within scope, and never your own document.
  const doc = await prisma.employeeDocument.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } },
  });
  if (!doc || doc.employeeId === viewer.employee?.id || !canAccessEmployee(viewer, doc.employee, P.DOCUMENT_VERIFY)) {
    throw new Error("You cannot verify this document");
  }

  await prisma.employeeDocument.updateMany({
    where: { id, tenantId: viewer.tenantId },
    data: decision === "approve"
      ? {
          status: "VERIFIED",
          verifiedBy: viewer.employee?.id ?? null,
          verifiedAt: new Date(),
          rejectReason: null,
        }
      : { status: "REJECTED", rejectReason: reason },
  });

  safeRevalidate("/documents");
}

export async function acknowledgeOrgDocument(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const documentId = String(formData.get("documentId"));

  const doc = await prisma.orgDocument.findFirst({
    where: { id: documentId, tenantId: viewer.tenantId },
  });
  if (!doc) throw new Error("Document not found");

  await prisma.orgDocumentAck.upsert({
    where: { documentId_employeeId: { documentId, employeeId: viewer.employee.id } },
    create: { documentId, employeeId: viewer.employee.id },
    update: {},
  });

  safeRevalidate("/documents");
  safeRevalidate("/me/documents");
}

/**
 * Generate a letter from a template. The rendered body is stored, so a later
 * template edit never rewrites an already-issued document.
 */
export async function generateLetter(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.LETTER_GENERATE);
  const templateId = String(formData.get("templateId"));
  const employeeId = String(formData.get("employeeId"));

  const [template, employee] = await Promise.all([
    prisma.documentTemplate.findFirst({
      where: { id: templateId, tenantId: viewer.tenantId, isArchived: false },
    }),
    prisma.employee.findFirst({
      where: { id: employeeId, tenantId: viewer.tenantId },
      include: {
        legalEntity: { select: { legalName: true, signatories: { take: 1 } } },
        location: { select: { name: true } },
        reportingManager: { select: { displayName: true } },
        salaryRevisions: { orderBy: { effectiveFrom: "desc" }, take: 1 },
        exitRecord: true,
      },
    }),
  ]);
  if (!template) throw new Error("Template not found");
  if (!employee) throw new Error("Employee not found");

  const signatory = employee.legalEntity?.signatories[0];
  const fmtDate = (d: Date | null | undefined) =>
    d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "";
  const fmtMoney = (v: unknown) =>
    v === null || v === undefined
      ? ""
      : `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

  const values: Record<string, string> = {
    employee_name: employee.displayName ?? `${employee.firstName} ${employee.lastName}`,
    candidate_name: employee.displayName ?? `${employee.firstName} ${employee.lastName}`,
    employee_number: employee.employeeNumber,
    job_title: employee.jobTitleName ?? "",
    legal_entity_name: employee.legalEntity?.legalName ?? "",
    location: employee.location?.name ?? "",
    reporting_manager: employee.reportingManager?.displayName ?? "",
    annual_ctc: fmtMoney(employee.salaryRevisions[0]?.annualCtc),
    joining_date: fmtDate(employee.dateOfJoining),
    date_of_joining: fmtDate(employee.dateOfJoining),
    confirmation_date: fmtDate(employee.confirmationDate),
    last_working_day: fmtDate(employee.lastWorkingDay ?? employee.exitRecord?.lastWorkingDay),
    notice_days: String(Number(employee.salaryRevisions[0]?.annualCtc ?? 0) > 3000000 ? 90 : 60),
    signatory_name: signatory?.name ?? "",
    signatory_designation: signatory?.designation ?? "",
  };

  // Substitute, and leave an obvious marker for anything unresolved rather
  // than silently emitting an empty gap in a legal document.
  const missing: string[] = [];
  const renderedBody = template.body.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined || v === "") {
      missing.push(key);
      return `[${key.toUpperCase()} NOT AVAILABLE]`;
    }
    return v;
  });

  const generated = await prisma.generatedDocument.create({
    data: {
      templateId, employeeId, renderedBody,
      status: template.workflow ? "PENDING_SIGNATURE" : "ISSUED",
      issuedBy: viewer.employee?.id ?? null,
    },
  });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    module: "EMPLOYEE", action: "CREATE", entityType: "GeneratedDocument",
    entityId: generated.id,
    summary: `Generated "${template.name}" for ${values.employee_name}` +
      (missing.length > 0 ? ` (${missing.length} placeholder(s) unresolved)` : ""),
  });

  safeRevalidate("/documents");
  safeRevalidate(`/employees/${employeeId}`);
}

// ---------------------------------------------------------------------------
//  TRAINING
// ---------------------------------------------------------------------------

export async function enrolInTraining(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.TRAINING_ENROL);
  const programId = String(formData.get("programId"));
  const employeeIds = formData.getAll("employeeIds").map(String).filter(Boolean);

  if (employeeIds.length === 0) throw new Error("Select at least one employee");

  const program = await prisma.trainingProgram.findFirst({
    where: { id: programId, tenantId: viewer.tenantId },
    include: { _count: { select: { enrolments: true } } },
  });
  if (!program) throw new Error("Programme not found");
  if (await foreignReference(viewer.tenantId, { employee: employeeIds })) throw new Error("A selected employee was not found");

  if (program.maxSeats !== null) {
    const remaining = program.maxSeats - program._count.enrolments;
    if (employeeIds.length > remaining) {
      throw new Error(
        `Only ${remaining} seat(s) remain on this programme; you selected ${employeeIds.length}.`,
      );
    }
  }

  await prisma.trainingEnrolment.createMany({
    data: employeeIds.map((employeeId) => ({
      programId, employeeId, assignedBy: viewer.employee?.id ?? null,
    })),
    skipDuplicates: true,
  });

  safeRevalidate("/training");
}

export async function updateTrainingProgress(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const enrolmentId = String(formData.get("enrolmentId"));
  const progress = Math.min(100, Math.max(0, Number(formData.get("progress") ?? 0)));

  const enrolment = await prisma.trainingEnrolment.findFirst({
    where: { id: enrolmentId, program: { tenantId: viewer.tenantId } },
    select: { employeeId: true },
  });
  if (!enrolment) throw new Error("Enrolment not found");

  // Employees update their own progress; trainers need the enrol permission.
  const isOwn = enrolment.employeeId === viewer.employee.id;
  if (!isOwn && !viewer.permissions.has(P.TRAINING_ENROL)) {
    throw new Error("You can only update your own training progress");
  }

  await prisma.trainingEnrolment.update({
    where: { id: enrolmentId },
    data: {
      progressPercent: progress,
      status: progress >= 100 ? "COMPLETED" : progress > 0 ? "IN_PROGRESS" : "ASSIGNED",
      completedAt: progress >= 100 ? new Date() : null,
    },
  });

  safeRevalidate("/training");
  safeRevalidate("/me/training");
}

// ---------------------------------------------------------------------------
//  MEETINGS
// ---------------------------------------------------------------------------

export async function respondToMeeting(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const meetingId = String(formData.get("meetingId"));
  const response = String(formData.get("response"));

  if (!["ACCEPTED", "DECLINED", "TENTATIVE"].includes(response)) {
    throw new Error("Invalid response");
  }

  await prisma.meetingAttendee.updateMany({
    where: { meetingId, employeeId: viewer.employee.id },
    data: { response },
  });

  safeRevalidate("/meetings");
}

export async function saveMeetingMinutes(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.MEETING_MANAGE);
  const meetingId = String(formData.get("meetingId"));
  const minutes = String(formData.get("minutes") ?? "").trim();

  await prisma.meeting.updateMany({
    where: { id: meetingId, tenantId: viewer.tenantId },
    data: { minutes, status: "COMPLETED" },
  });

  safeRevalidate("/meetings");
}

export async function addMeetingActionItem(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.MEETING_MANAGE);
  const meetingId = String(formData.get("meetingId"));
  const description = String(formData.get("description") ?? "").trim();
  const ownerId = String(formData.get("ownerId") ?? "") || null;
  const dueRaw = String(formData.get("dueDate") ?? "");

  if (!description) throw new Error("Describe the action item");

  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, tenantId: viewer.tenantId },
  });
  if (!meeting) throw new Error("Meeting not found");
  if (await foreignReference(viewer.tenantId, { employee: ownerId })) throw new Error("Owner not found");

  await prisma.meetingActionItem.create({
    data: {
      meetingId, description, ownerId,
      dueDate: dueRaw ? new Date(dueRaw) : null,
    },
  });

  safeRevalidate("/meetings");
}

export async function completeActionItem(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  if (!viewer.employee) throw new Error("No employee record linked to this login");
  const id = String(formData.get("id"));

  const item = await prisma.meetingActionItem.findUnique({
    where: { id },
    select: { ownerId: true, meeting: { select: { tenantId: true, organiserId: true } } },
  });
  if (!item || item.meeting.tenantId !== viewer.tenantId) throw new Error("Action item not found");

  // The owner, the organiser, or anyone who can manage meetings may close it.
  const allowed =
    item.ownerId === viewer.employee.id ||
    item.meeting.organiserId === viewer.employee.id ||
    viewer.permissions.has(P.MEETING_MANAGE);
  if (!allowed) throw new Error("Only the owner or organiser can close this action item");

  await prisma.meetingActionItem.update({
    where: { id },
    data: { status: "DONE", completedAt: new Date() },
  });

  safeRevalidate("/meetings");
}

// ---------------------------------------------------------------------------
//  HR ACTIVITIES
// ---------------------------------------------------------------------------

export async function recordHrActivity(formData: FormData): Promise<void> {
  const viewer = await requireAuth(P.HR_ACTIVITY_MANAGE);
  const employeeId = String(formData.get("employeeId"));
  const type = String(formData.get("type")) as
    "PROMOTION" | "TRANSFER" | "WARNING" | "COMPLAINT" | "WORK_TRIP"
    | "TERMINATION" | "RESIGNATION" | "APPRECIATION" | "SALARY_REVISION";
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "") || null;
  const occurredRaw = String(formData.get("occurredOn") ?? "");
  const fromValue = String(formData.get("fromValue") ?? "") || null;
  const toValue = String(formData.get("toValue") ?? "") || null;
  const severity = String(formData.get("severity") ?? "") || null;
  const destination = String(formData.get("destination") ?? "") || null;
  const tripFromRaw = String(formData.get("tripFrom") ?? "");
  const tripToRaw = String(formData.get("tripTo") ?? "");

  if (!title) throw new Error("Give the activity a title");

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: viewer.tenantId },
    select: { id: true, displayName: true },
  });
  if (!employee) throw new Error("Employee not found");

  const activity = await prisma.hrActivity.create({
    data: {
      tenantId: viewer.tenantId,
      employeeId, type, title, description,
      occurredOn: occurredRaw ? new Date(occurredRaw) : new Date(),
      fromValue, toValue, severity, destination,
      tripFrom: tripFromRaw ? new Date(tripFromRaw) : null,
      tripTo: tripToRaw ? new Date(tripToRaw) : null,
      recordedBy: viewer.employee?.id ?? null,
    },
  });

  await audit({
    tenantId: viewer.tenantId, actorId: viewer.user.id, actorLabel: viewer.user.email,
    module: "EMPLOYEE", action: "CREATE", entityType: "HrActivity",
    entityId: activity.id,
    summary: `Recorded ${type.replace(/_/g, " ").toLowerCase()} for ${employee.displayName}: ${title}`,
  });

  safeRevalidate("/activities");
  safeRevalidate(`/employees/${employeeId}`);
}
