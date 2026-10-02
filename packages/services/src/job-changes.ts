import { prisma, type Prisma } from "@keka/db";
import { openApproval } from "./payroll-approvals";
import { notify, startJourney } from "./lifecycle";
import { jobChangeDue, dayBefore } from "./core-hr-workflows-math";

/**
 * Promotions, transfers and other job changes. A change is a JobChange row
 * until it is applied, which writes the effective-dated job record and the
 * denormalised fields the rest of the app reads. It is applied:
 *   - straight away when no approval is needed (as before), unless it was
 *     asked to wait for its date (the bulk import does);
 *   - on final approval when the employee's pay group has a JOB_CHANGE rule,
 *     or on the effective date if that is still ahead;
 *   - by the nightly "job-changes" job once a scheduled change falls due.
 */

export type JobChangeFields = {
  effectiveFrom: Date;
  reason: "PROMOTION" | "TRANSFER" | "DEPARTMENT_CHANGE" | "LOCATION_CHANGE" | "MANAGER_CHANGE" | "CONFIRMATION" | "DEMOTION" | "WORKER_TYPE_CHANGE";
  jobTitleId?: string | null;
  departmentId?: string | null;
  businessUnitId?: string | null;
  locationId?: string | null;
  legalEntityId?: string | null;
  bandId?: string | null;
  payGradeId?: string | null;
  workerTypeId?: string | null;
  reportingManagerId?: string | null;
  note?: string | null;
  logActivity?: boolean;
};

const ACTIVITY: Record<string, "PROMOTION" | "TRANSFER"> = {
  PROMOTION: "PROMOTION", DEMOTION: "PROMOTION",
  TRANSFER: "TRANSFER", LOCATION_CHANGE: "TRANSFER", DEPARTMENT_CHANGE: "TRANSFER",
};
const JOURNEY = { PROMOTION: "PROMOTION", TRANSFER: "TRANSFER", LOCATION_CHANGE: "TRANSFER", DEPARTMENT_CHANGE: "TRANSFER", CONFIRMATION: "CONFIRMATION" } as const;

export const jobChangeLabel = (reason: string) => reason.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Raise a job change: open its approval when the pay group asks for one,
 * otherwise apply it now (or schedule it, when `holdUntilEffective` and the
 * date is ahead). Returns what happened so the caller can word its message.
 */
export async function requestJobChange(input: {
  tenantId: string; employeeId: string; requestedBy: string; fields: JobChangeFields;
  source?: "MANUAL" | "IMPORT"; holdUntilEffective?: boolean; summary: string; today?: Date;
}): Promise<{ jobChangeId: string; status: "PENDING_APPROVAL" | "SCHEDULED" | "APPLIED"; applied?: AppliedJobChange }> {
  const emp = await prisma.employee.findFirstOrThrow({ where: { id: input.employeeId, tenantId: input.tenantId }, select: { payGroupId: true } });
  const f = input.fields;
  const change = await prisma.jobChange.create({
    data: {
      tenantId: input.tenantId, employeeId: input.employeeId, effectiveFrom: f.effectiveFrom, reason: f.reason,
      jobTitleId: f.jobTitleId ?? null, departmentId: f.departmentId ?? null, businessUnitId: f.businessUnitId ?? null,
      locationId: f.locationId ?? null, legalEntityId: f.legalEntityId ?? null, bandId: f.bandId ?? null,
      payGradeId: f.payGradeId ?? null, workerTypeId: f.workerTypeId ?? null, reportingManagerId: f.reportingManagerId ?? null,
      note: f.note ?? null, logActivity: !!f.logActivity, source: input.source ?? "MANUAL", requestedBy: input.requestedBy,
    },
  });
  const approval = emp.payGroupId
    ? await openApproval({
      tenantId: input.tenantId, payGroupId: emp.payGroupId, action: "JOB_CHANGE", requestedBy: input.requestedBy,
      employeeId: input.employeeId, jobChangeId: change.id, summary: input.summary, link: "/inbox?cat=job-changes",
    })
    : ({ required: false } as const);
  if (approval.required) await prisma.jobChange.update({ where: { id: change.id }, data: { approvalRequestId: approval.requestId } });
  if (approval.required && approval.status === "PENDING") return { jobChangeId: change.id, status: "PENDING_APPROVAL" };

  // Approved outright (no rule, or every level is the requester's own role).
  const hold = (input.holdUntilEffective || approval.required) && !jobChangeDue(f.effectiveFrom, input.today);
  if (hold) {
    await prisma.jobChange.update({ where: { id: change.id }, data: { status: "SCHEDULED", decidedAt: approval.required ? new Date() : null } });
    return { jobChangeId: change.id, status: "SCHEDULED" };
  }
  const applied = await applyJobChange(change.id);
  return { jobChangeId: change.id, status: "APPLIED", applied };
}

export interface AppliedJobChange {
  jobRecordId: string;
  /** Set when the move crosses into another state, which changes PT and LWF. */
  stateChange: { from: string | null; to: string | null } | null;
  journeyTasks: number;
}

/**
 * Write the job record for a change and update the employee. Idempotent: an
 * already-applied change returns its record without writing again.
 */
export async function applyJobChange(jobChangeId: string): Promise<AppliedJobChange> {
  const c = await prisma.jobChange.findUniqueOrThrow({ where: { id: jobChangeId } });
  if (c.status === "APPLIED" && c.jobRecordId) return { jobRecordId: c.jobRecordId, stateChange: null, journeyTasks: 0 };
  if (c.status === "REJECTED" || c.status === "WITHDRAWN") throw new Error(`This job change was ${c.status.toLowerCase()}.`);

  const before = await prisma.employee.findUniqueOrThrow({
    where: { id: c.employeeId },
    include: { department: { select: { name: true } }, location: { select: { name: true, stateCode: true } } },
  });
  const recordedBy = c.requestedBy
    ? (await prisma.employee.findFirst({ where: { userId: c.requestedBy }, select: { id: true } }))?.id ?? null
    : null;

  const jobRecordId = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction so two appliers never both write.
    const claimed = await tx.jobChange.updateMany({ where: { id: c.id, status: { in: ["PENDING_APPROVAL", "SCHEDULED"] } }, data: { status: "APPLIED", appliedAt: new Date() } });
    if (claimed.count === 0) throw new Error("This job change was already applied.");

    // Close the open job record at the day before the new one starts.
    const open = await tx.employeeJobRecord.findFirst({ where: { employeeId: c.employeeId, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
    if (open && open.effectiveFrom < c.effectiveFrom) {
      await tx.employeeJobRecord.update({ where: { id: open.id }, data: { effectiveTo: dayBefore(c.effectiveFrom) } });
    }
    const jobTitleName = c.jobTitleId ? (await tx.jobTitle.findUnique({ where: { id: c.jobTitleId }, select: { name: true } }))?.name : undefined;
    const record = await tx.employeeJobRecord.create({
      data: {
        employeeId: c.employeeId, effectiveFrom: c.effectiveFrom, reason: c.reason,
        jobTitleId: c.jobTitleId ?? open?.jobTitleId ?? null,
        departmentId: c.departmentId ?? before.departmentId,
        businessUnitId: c.businessUnitId ?? before.businessUnitId,
        locationId: c.locationId ?? before.locationId,
        legalEntityId: c.legalEntityId ?? before.legalEntityId,
        bandId: c.bandId ?? before.bandId,
        payGradeId: c.payGradeId ?? before.payGradeId,
        workerTypeId: c.workerTypeId ?? before.workerTypeId,
        reportingManagerId: c.reportingManagerId ?? before.reportingManagerId,
        note: c.note, createdBy: c.requestedBy,
      },
    });
    // The denormalised current state the rest of the app reads.
    await tx.employee.update({
      where: { id: c.employeeId },
      data: {
        ...(c.jobTitleId ? { jobTitleName: jobTitleName ?? null } : {}),
        ...(c.departmentId ? { departmentId: c.departmentId } : {}),
        ...(c.businessUnitId ? { businessUnitId: c.businessUnitId } : {}),
        ...(c.locationId ? { locationId: c.locationId } : {}),
        ...(c.legalEntityId ? { legalEntityId: c.legalEntityId } : {}),
        ...(c.bandId ? { bandId: c.bandId } : {}),
        ...(c.payGradeId ? { payGradeId: c.payGradeId } : {}),
        ...(c.workerTypeId ? { workerTypeId: c.workerTypeId } : {}),
        ...(c.reportingManagerId ? { reportingManagerId: c.reportingManagerId } : {}),
        ...(c.reason === "CONFIRMATION" ? { status: "CONFIRMED" as const, confirmationDate: c.effectiveFrom } : {}),
      },
    });
    const activityType = c.logActivity ? ACTIVITY[c.reason] : undefined;
    if (activityType) {
      await tx.hrActivity.create({
        data: {
          tenantId: c.tenantId, employeeId: c.employeeId, type: activityType, title: jobChangeLabel(c.reason),
          description: c.note, occurredOn: c.effectiveFrom,
          fromValue: c.departmentId ? before.department?.name ?? null : c.locationId ? before.location?.name ?? null : before.jobTitleName,
          toValue: jobTitleName ?? null, recordedBy, jobRecordId: record.id,
        },
      });
    }
    await tx.jobChange.update({ where: { id: c.id }, data: { jobRecordId: record.id } });
    return record.id;
  });

  let stateChange: AppliedJobChange["stateChange"] = null;
  if (c.locationId && c.locationId !== before.locationId) {
    const after = await prisma.location.findUnique({ where: { id: c.locationId }, select: { stateCode: true } });
    if (after?.stateCode !== before.location?.stateCode) stateChange = { from: before.location?.stateCode ?? null, to: after?.stateCode ?? null };
  }
  // Promotions, transfers and confirmations each set work in motion.
  const trigger = JOURNEY[c.reason as keyof typeof JOURNEY];
  const journey = trigger
    ? await startJourney({ employeeId: c.employeeId, trigger, anchorDate: c.effectiveFrom, createdBy: c.requestedBy ?? undefined, sourceType: "EmployeeJobRecord" })
    : null;
  const manager = await prisma.employee.findUnique({ where: { id: c.reportingManagerId ?? before.reportingManagerId ?? "" }, select: { userId: true } }).catch(() => null);
  await notify({
    tenantId: c.tenantId, userIds: [before.userId, manager?.userId], kind: "EMPLOYEE",
    title: `${jobChangeLabel(c.reason)} for ${before.displayName ?? before.firstName} is effective`,
    body: `Effective ${c.effectiveFrom.toISOString().slice(0, 10)}.`, link: `/employees/${c.employeeId}`,
    email: true, event: "JOB_CHANGE_APPLIED", employeeIds: [c.employeeId], relatedType: "JobChange", relatedId: c.id,
  });
  return { jobRecordId, stateChange, journeyTasks: journey?.created ? journey.tasks : 0 };
}

/**
 * The outcome of a JOB_CHANGE approval: on approval apply it (or schedule it
 * for its date); on rejection or withdrawal close it.
 */
export async function settleJobChangeApproval(jobChangeId: string, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN" | "ADVANCED", today: Date = new Date()):
  Promise<{ status: "PENDING_APPROVAL" | "SCHEDULED" | "APPLIED" | "REJECTED" | "WITHDRAWN"; applied?: AppliedJobChange }> {
  const c = await prisma.jobChange.findUniqueOrThrow({ where: { id: jobChangeId } });
  if (outcome === "ADVANCED") return { status: "PENDING_APPROVAL" };
  if (outcome === "REJECTED" || outcome === "WITHDRAWN") {
    await prisma.jobChange.updateMany({ where: { id: c.id, status: "PENDING_APPROVAL" }, data: { status: outcome, decidedAt: new Date() } });
    return { status: outcome };
  }
  if (!jobChangeDue(c.effectiveFrom, today)) {
    await prisma.jobChange.updateMany({ where: { id: c.id, status: "PENDING_APPROVAL" }, data: { status: "SCHEDULED", decidedAt: new Date() } });
    return { status: "SCHEDULED" };
  }
  await prisma.jobChange.update({ where: { id: c.id }, data: { decidedAt: new Date() } });
  return { status: "APPLIED", applied: await applyJobChange(c.id) };
}

/** Nightly: apply every scheduled change whose effective date has arrived. */
export async function applyDueJobChanges(today: Date = new Date()): Promise<{ applied: number; failed: number; errors: string[] }> {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const due = await prisma.jobChange.findMany({ where: { status: "SCHEDULED", effectiveFrom: { lt: end } }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }], select: { id: true } });
  let applied = 0;
  const errors: string[] = [];
  for (const d of due) {
    try { await applyJobChange(d.id); applied++; } catch (err) { errors.push(`${d.id}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { applied, failed: errors.length, errors: errors.slice(0, 20) };
}

/** Pending and scheduled changes for one employee, for the profile. */
export function openJobChangesFor(employeeId: string, tx: Prisma.TransactionClient = prisma) {
  return tx.jobChange.findMany({ where: { employeeId, status: { in: ["PENDING_APPROVAL", "SCHEDULED"] } }, orderBy: { effectiveFrom: "asc" } });
}
