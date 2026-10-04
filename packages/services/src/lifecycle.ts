import { prisma, Prisma } from "@keka/db";
import {
  resolveStructure, calculateGratuity, calculateLeaveEncashment, calculateNoticeBuyout, calculateAnnualTax,
  type StructureComponentSpec,
} from "@keka/payroll";
import { fyStartYear } from "@keka/shared";
import { loadStatutoryTables, ageAtFyEnd, slabsFor } from "./payroll-run";
import { recomputeBalance, leaveYearStart, trueUpExitAccrual } from "./time";
import type { FnfEffects } from "./fnf-math";
import { planEmail } from "./core-hr-workflows-math";
import { notificationEvent, OFF_BY_DEFAULT } from "./notification-events";

/**
 * The employee lifecycle beyond the payroll month: journeys that follow from
 * an event, exits and their full-and-final settlement, the helpdesk, and the
 * notification fan-out all of these share.
 *
 * Nothing here decides on a person's behalf. A journey proposes tasks; a
 * settlement proposes figures; both wait for a human to confirm.
 */

const DAY = 86_400_000;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const r2 = (n: number) => Math.round(n * 100) / 100;

type Trigger = "JOINING" | "CONFIRMATION" | "PROMOTION" | "TRANSFER" | "EXIT" | "MANUAL";

// ---------------------------------------------------------------------------
//  Notifications
// ---------------------------------------------------------------------------

export interface NotifyInput {
  tenantId: string;
  userIds: Array<string | null | undefined>;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Also queue an email to each user's address. */
  email?: boolean;
  relatedType?: string;
  relatedId?: string;
  /**
   * Event key from NOTIFICATION_EVENTS. With one, the admin's notification
   * setting for the event decides whether the email goes and to whom.
   */
  event?: string;
  /** The employee(s) the event is about, so "employee" and "manager" recipients can be resolved. */
  employeeIds?: Array<string | null | undefined>;
}

/**
 * In-app notification, and optionally an email written to the outbox in the
 * same call. The outbox is delivered separately, so a mail failure never
 * undoes the change that caused it.
 */
export async function notify(input: NotifyInput, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const ids = [...new Set(input.userIds.filter((u): u is string => !!u))];
  if (ids.length === 0) return 0;
  await tx.notification.createMany({
    data: ids.map((userId) => ({
      tenantId: input.tenantId, userId, kind: input.kind, title: input.title,
      body: input.body ?? null, link: input.link ?? null,
    })),
  });
  if (input.email) {
    const addresses = await emailAddressesFor(input, ids, tx);
    if (addresses.length) {
      await tx.emailOutbox.createMany({
        data: addresses.map((toAddress) => ({
          tenantId: input.tenantId, toAddress, subject: input.title,
          textBody: `${input.body ?? input.title}${input.link ? `\n\nOpen: ${input.link}` : ""}`,
          relatedType: input.relatedType ?? null, relatedId: input.relatedId ?? null,
        })),
      });
    }
  }
  return ids.length;
}

/**
 * Who an event's email goes to: the users the caller chose, unless the
 * admin has changed the event under Settings > Notifications (switched it
 * off, re-targeted it to employee / manager / HR, or copied an address).
 */
async function emailAddressesFor(input: NotifyInput, callSite: string[], tx: Prisma.TransactionClient): Promise<string[]> {
  const event = input.event ? notificationEvent(input.event) : null;
  const setting = event
    ? await tx.notificationSetting.findUnique({ where: { tenantId_event: { tenantId: input.tenantId, event: event.key } } })
    : null;
  if (event && !setting && OFF_BY_DEFAULT.has(event.key)) return [];
  const plan = event ? planEmail(setting, event.defaults, event.configurable) : planEmail(null, [], false);
  if (!plan.send) return [];
  let userIds = callSite;
  if (!plan.useCallSite) {
    const subjects = (input.employeeIds ?? []).filter((e): e is string => !!e);
    const emps = subjects.length
      ? await tx.employee.findMany({ where: { id: { in: subjects }, tenantId: input.tenantId }, select: { userId: true, reportingManager: { select: { userId: true } } } })
      : [];
    userIds = [];
    if (plan.groups.includes("EMPLOYEE")) userIds.push(...emps.map((e) => e.userId).filter((u): u is string => !!u));
    if (plan.groups.includes("MANAGER")) userIds.push(...emps.map((e) => e.reportingManager?.userId).filter((u): u is string => !!u));
    if (plan.groups.includes("HR")) userIds.push(...(await usersWithPermission(input.tenantId, event?.hrPermission ?? "employee.record.update")));
  }
  const users = userIds.length
    ? await tx.user.findMany({ where: { id: { in: [...new Set(userIds)] }, tenantId: input.tenantId }, select: { email: true } })
    : [];
  return [...new Set([...users.map((u) => u.email.toLowerCase()), ...plan.customEmails])];
}

/** The login behind an employee, if they have one. */
async function userOf(employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null;
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
  return e?.userId ?? null;
}

/** Users holding a permission tenant-wide through an explicit role. */
export async function usersWithPermission(tenantId: string, permission: string): Promise<string[]> {
  const rows = await prisma.userRoleAssignment.findMany({
    where: {
      role: { tenantId, permissions: { some: { permission } } },
      user: { tenantId, loginDisabled: false, isDeactivated: false },
      // A time-bound grant past its expiry no longer counts.
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

export interface OutboxTransport {
  /** attachmentFileIds are StoredFile ids; the transport reads and attaches them. */
  send(mail: { to: string; subject: string; text: string; html?: string | null; attachmentFileIds?: string[] }): Promise<void>;
}

/**
 * Deliver queued email. Retries a failed message up to `maxAttempts` times
 * across calls; each attempt is recorded so a stuck message is visible.
 */
export async function deliverOutbox(transport: OutboxTransport, opts: { limit?: number; maxAttempts?: number } = {}) {
  const batch = await prisma.emailOutbox.findMany({
    where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: opts.maxAttempts ?? 5 } },
    orderBy: { createdAt: "asc" }, take: opts.limit ?? 50,
  });
  let sent = 0, failed = 0;
  for (const m of batch) {
    try {
      await transport.send({ to: m.toAddress, subject: m.subject, text: m.textBody, html: m.htmlBody, attachmentFileIds: m.attachmentFileIds });
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      sent++;
    } catch (err) {
      await prisma.emailOutbox.update({
        where: { id: m.id },
        data: { status: "FAILED", attempts: { increment: 1 }, lastError: err instanceof Error ? err.message : String(err) },
      });
      failed++;
    }
  }
  return { sent, failed, examined: batch.length };
}

// ---------------------------------------------------------------------------
//  Journeys
// ---------------------------------------------------------------------------

/** The most specific active template for a trigger and an employee. */
async function templateFor(tenantId: string, trigger: Trigger, departmentId: string | null, locationId: string | null, jobTitle: string | null = null) {
  const candidates = await prisma.journeyTemplate.findMany({
    where: { tenantId, trigger, isActive: true },
    include: { tasks: { orderBy: [{ sortOrder: "asc" }, { offsetDays: "asc" }] } },
  });
  // Role-specific paths (job title) outrank department, which outranks location.
  const sameTitle = (t: { jobTitle: string | null }) => !!t.jobTitle && !!jobTitle && t.jobTitle.trim().toLowerCase() === jobTitle.trim().toLowerCase();
  const fits = candidates.filter((t) =>
    (!t.departmentId || t.departmentId === departmentId) && (!t.locationId || t.locationId === locationId) && (!t.jobTitle || sameTitle(t)));
  const score = (t: (typeof fits)[number]) => (t.jobTitle ? 4 : 0) + (t.departmentId ? 2 : 0) + (t.locationId ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export interface StartJourneyInput {
  employeeId: string;
  trigger: Trigger;
  anchorDate: Date;
  title?: string;
  templateId?: string;
  sourceType?: string;
  sourceId?: string;
  createdBy?: string | null;
}

/**
 * Start the journey an event calls for. Idempotent per employee, trigger and
 * anchor date: starting it again returns the existing journey.
 */
export async function startJourney(input: StartJourneyInput): Promise<{ journeyId: string | null; created: boolean; tasks: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    select: { tenantId: true, displayName: true, departmentId: true, locationId: true, reportingManagerId: true, userId: true, jobTitleName: true },
  });
  const anchor = utcMidnight(input.anchorDate);
  const existing = await prisma.journey.findUnique({
    where: { employeeId_trigger_anchorDate: { employeeId: input.employeeId, trigger: input.trigger, anchorDate: anchor } },
    include: { _count: { select: { tasks: true } } },
  });
  if (existing) return { journeyId: existing.id, created: false, tasks: existing._count.tasks };

  const template = input.templateId
    ? await prisma.journeyTemplate.findFirst({
        where: { id: input.templateId, tenantId: emp.tenantId },
        include: { tasks: { orderBy: [{ sortOrder: "asc" }, { offsetDays: "asc" }] } },
      })
    : await templateFor(emp.tenantId, input.trigger, emp.departmentId, emp.locationId, emp.jobTitleName);
  if (!template) return { journeyId: null, created: false, tasks: 0 };

  const assigneeFor = (owner: string) =>
    owner === "MANAGER" ? emp.reportingManagerId : owner === "EMPLOYEE" ? input.employeeId : null;

  const journey = await prisma.journey.create({
    data: {
      tenantId: emp.tenantId, employeeId: input.employeeId, templateId: template.id,
      trigger: input.trigger, anchorDate: anchor,
      title: input.title ?? `${template.name} — ${emp.displayName}`,
      sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null,
      createdBy: input.createdBy ?? null,
      tasks: {
        create: template.tasks.map((t, i) => ({
          title: t.title, description: t.description, owner: t.owner,
          assigneeEmployeeId: assigneeFor(t.owner),
          dueDate: new Date(anchor.getTime() + t.offsetDays * DAY),
          category: t.category, isRequired: t.isRequired, autoCheck: t.autoCheck, sortOrder: i, needsApproval: t.needsApproval,
        })),
      },
    },
  });

  // Tell the people who now have something to do.
  const managerUser = await userOf(emp.reportingManagerId);
  await notify({
    tenantId: emp.tenantId,
    userIds: [managerUser, template.tasks.some((t) => t.owner === "EMPLOYEE") ? emp.userId : null],
    kind: "JOURNEY", title: `${template.name}: tasks for ${emp.displayName}`,
    body: `${template.tasks.length} task(s) were created from the ${template.name} template.`,
    link: `/onboarding/${journey.id}`,
  });

  await runAutoChecks(journey.id);
  return { journeyId: journey.id, created: true, tasks: template.tasks.length };
}

/**
 * System checks that can close a task without anyone ticking it. Each
 * returns a sentence of evidence when satisfied, or null.
 */
const AUTO_CHECKS: Record<string, (employeeId: string) => Promise<string | null>> = {
  USER_ACCOUNT: async (id) => {
    const e = await prisma.employee.findUnique({ where: { id }, select: { user: { select: { email: true } } } });
    return e?.user ? `Login exists for ${e.user.email}` : null;
  },
  BANK_DETAILS: async (id) =>
    (await prisma.employeeBankAccount.count({ where: { employeeId: id } })) > 0 ? "Bank account on file" : null,
  SALARY_ASSIGNED: async (id) =>
    (await prisma.salaryRevision.count({ where: { employeeId: id } })) > 0 ? "Salary structure assigned" : null,
  LEAVE_PLAN_ASSIGNED: async (id) =>
    (await prisma.leavePlanAssignment.count({ where: { employeeId: id } })) > 0 ? "Leave plan assigned" : null,
  TIME_POLICY_ASSIGNED: async (id) =>
    (await prisma.employeeTimePolicy.count({ where: { employeeId: id } })) > 0 ? "Shift and attendance policy assigned" : null,
  DOCUMENTS_VERIFIED: async (id) => {
    const docs = await prisma.employeeDocument.findMany({ where: { employeeId: id }, select: { status: true } });
    if (docs.length === 0) return null;
    return docs.every((d) => d.status === "VERIFIED") ? `All ${docs.length} document(s) verified` : null;
  },
  ASSETS_RETURNED: async (id) => {
    const open = await prisma.assetAssignment.count({ where: { employeeId: id, returnedOn: null } });
    return open === 0 ? "No assets outstanding" : null;
  },
  EXIT_APPROVED: async (id) => {
    const x = await prisma.exitRecord.findUnique({ where: { employeeId: id }, select: { status: true } });
    return x && ["APPROVED", "IN_CLEARANCE", "SETTLED", "COMPLETED"].includes(x.status) ? "Exit approved" : null;
  },
  FNF_SETTLED: async (id) => {
    const s = await prisma.fnfSettlement.findUnique({ where: { employeeId: id }, select: { status: true } });
    return s && ["FINALIZED", "PAID", "ALREADY_PAID"].includes(s.status) ? `Settlement ${s.status.toLowerCase()}` : null;
  },
  LOANS_CLOSED: async (id) => {
    const open = await prisma.loan.count({ where: { employeeId: id, status: { in: ["DISBURSED", "ACTIVE"] } } });
    return open === 0 ? "No open loans" : null;
  },
};

export const AUTO_CHECK_CODES = Object.keys(AUTO_CHECKS);

/** Close any pending task whose system check now passes. */
export async function runAutoChecks(journeyId: string): Promise<number> {
  const journey = await prisma.journey.findUnique({
    where: { id: journeyId }, include: { tasks: { where: { status: "PENDING", autoCheck: { not: null } } } },
  });
  if (!journey || journey.status !== "ACTIVE") return 0;
  let closed = 0;
  for (const task of journey.tasks) {
    const check = AUTO_CHECKS[task.autoCheck!];
    const evidence = check ? await check(journey.employeeId) : null;
    if (evidence) {
      await prisma.journeyTask.update({
        where: { id: task.id },
        data: { status: "DONE", completedAt: new Date(), completedBy: "system", note: `Verified automatically: ${evidence}` },
      });
      closed++;
    }
  }
  await settleJourney(journeyId);
  return closed;
}

/** Mark a journey complete once nothing is pending. */
async function settleJourney(journeyId: string): Promise<void> {
  const pending = await prisma.journeyTask.count({ where: { journeyId, status: "PENDING" } });
  if (pending === 0) {
    await prisma.journey.updateMany({ where: { id: journeyId, status: "ACTIVE" }, data: { status: "COMPLETED", completedAt: new Date() } });
  }
}

export async function setJourneyTask(opts: {
  taskId: string; status: "DONE" | "SKIPPED" | "PENDING"; byUserId: string; note?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const task = await prisma.journeyTask.findUnique({ where: { id: opts.taskId }, include: { journey: true } });
  if (!task) return { ok: false, message: "Task not found." };
  if (task.journey.status === "CANCELLED") return { ok: false, message: "This journey was cancelled." };
  if (opts.status === "SKIPPED" && task.isRequired && !opts.note) {
    return { ok: false, message: "A required task can only be skipped with a reason." };
  }
  if (opts.status === "DONE" && task.autoCheck && AUTO_CHECKS[task.autoCheck]) {
    // A task the system can verify is verified, not just ticked.
    const evidence = await AUTO_CHECKS[task.autoCheck](task.journey.employeeId);
    if (!evidence) {
      return { ok: false, message: `This task closes itself once the system can see it is done (${task.autoCheck.replace(/_/g, " ").toLowerCase()}). Skip it with a reason if it does not apply.` };
    }
  }
  await prisma.journeyTask.update({
    where: { id: task.id },
    data: opts.status === "PENDING"
      ? { status: "PENDING", completedAt: null, completedBy: null }
      : { status: opts.status, completedAt: new Date(), completedBy: opts.byUserId, note: opts.note ?? task.note },
  });
  if (opts.status === "PENDING") {
    await prisma.journey.updateMany({ where: { id: task.journeyId, status: "COMPLETED" }, data: { status: "ACTIVE", completedAt: null } });
  } else {
    await settleJourney(task.journeyId);
  }
  return { ok: true, message: opts.status === "DONE" ? "Done." : opts.status === "SKIPPED" ? "Skipped." : "Reopened." };
}

export function journeyProgress(tasks: Array<{ status: string; isRequired: boolean; dueDate: Date }>, today = new Date()) {
  const done = tasks.filter((t) => t.status !== "PENDING").length;
  const overdue = tasks.filter((t) => t.status === "PENDING" && t.dueDate.getTime() < utcMidnight(today).getTime()).length;
  const requiredLeft = tasks.filter((t) => t.status === "PENDING" && t.isRequired).length;
  return { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 100, overdue, requiredLeft };
}

// ---------------------------------------------------------------------------
//  Exits
// ---------------------------------------------------------------------------

export async function noticeDaysFor(employeeId: string, type: string): Promise<{ days: number; policy: string; allowBuyout: boolean; basis: string }> {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { tenantId: true, status: true, noticePeriodPolicy: true } });
  // The person's own policy when one is assigned and still active, else the tenant default.
  const policy = emp.noticePeriodPolicy?.isActive
    ? emp.noticePeriodPolicy
    : await prisma.noticePeriodPolicy.findFirst({ where: { tenantId: emp.tenantId, isActive: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const base = { policy: policy?.name ?? "Default", allowBuyout: policy?.allowBuyout ?? true, basis: policy?.buyoutBasis ?? "GROSS" };
  if (["DEATH", "ABSCONDING", "END_OF_CONTRACT", "RETIREMENT"].includes(type)) return { days: 0, ...base };
  if (emp.status === "PROBATION") return { days: policy?.probationDays ?? 15, ...base };
  if (type === "TERMINATION") return { days: policy?.terminationDays ?? 30, ...base };
  return { days: policy?.resignationDays ?? 60, ...base };
}

export interface InitiateExitInput {
  employeeId: string;
  type: "RESIGNATION" | "TERMINATION" | "RETIREMENT" | "ABSCONDING" | "END_OF_CONTRACT" | "DEATH";
  noticeDate: Date;
  /** Defaults to the notice date plus the policy's notice period. */
  lastWorkingDay?: Date | null;
  reason?: string | null;
  /** A configured ExitReason of the same tenant, for attrition reporting. */
  reasonId?: string | null;
  initiatedByUserId?: string | null;
}

export async function initiateExit(input: InitiateExitInput): Promise<{ ok: boolean; message: string; exitId?: string; lastWorkingDay?: Date; shortfallDays?: number }> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    select: { tenantId: true, status: true, dateOfJoining: true, displayName: true, reportingManagerId: true, exitRecord: true },
  });
  if (emp.status === "EXITED") return { ok: false, message: "This employee has already exited." };
  const live = emp.exitRecord && !["CANCELLED", "RETAINED", "REJECTED"].includes(emp.exitRecord.status);
  if (live) return { ok: false, message: "An exit is already in progress for this employee." };

  const noticeDate = utcMidnight(input.noticeDate);
  if (noticeDate.getTime() < utcMidnight(emp.dateOfJoining).getTime()) {
    return { ok: false, message: "The notice date is before the joining date." };
  }
  if (input.reasonId && !(await prisma.exitReason.count({ where: { id: input.reasonId, tenantId: emp.tenantId, isActive: true } }))) {
    return { ok: false, message: "Choose a reason from the list." };
  }
  const notice = await noticeDaysFor(input.employeeId, input.type);
  const policyLwd = new Date(noticeDate.getTime() + notice.days * DAY);
  const lwd = input.lastWorkingDay ? utcMidnight(input.lastWorkingDay) : policyLwd;
  if (lwd.getTime() < noticeDate.getTime()) return { ok: false, message: "The last working day is before the notice date." };
  const shortfall = Math.max(0, Math.round((policyLwd.getTime() - lwd.getTime()) / DAY));

  // A resignation waits for approval; HR-initiated exits are decided already.
  const selfInitiated = input.type === "RESIGNATION";
  const data = {
    type: input.type, reason: input.reason ?? null, reasonId: input.reasonId ?? null,
    status: (selfInitiated ? "PENDING_APPROVAL" : "APPROVED") as "PENDING_APPROVAL" | "APPROVED",
    noticeDate, lastWorkingDay: lwd, noticeBuyoutDays: shortfall || null,
    initiatedBy: input.initiatedByUserId ?? null,
    approvedBy: selfInitiated ? null : input.initiatedByUserId ?? null,
    approvedAt: selfInitiated ? null : new Date(),
  };
  const exit = emp.exitRecord
    ? await prisma.exitRecord.update({ where: { id: emp.exitRecord.id }, data })
    : await prisma.exitRecord.create({ data: { ...data, employeeId: input.employeeId } });

  await prisma.employee.update({
    where: { id: input.employeeId },
    data: {
      exitInitiatedAt: new Date(),
      ...(selfInitiated ? {} : { status: "NOTICE_PERIOD", lastWorkingDay: lwd }),
    },
  });
  if (!selfInitiated) {
    await trueUpExitAccrual(input.employeeId);
    await startJourney({ employeeId: input.employeeId, trigger: "EXIT", anchorDate: lwd, sourceType: "ExitRecord", sourceId: exit.id, createdBy: input.initiatedByUserId });
  }
  await notify({
    tenantId: emp.tenantId,
    userIds: [await userOf(emp.reportingManagerId), ...(await usersWithPermission(emp.tenantId, "lifecycle.exit.manage"))],
    kind: "EXIT", title: `${emp.displayName}: ${input.type.toLowerCase().replace(/_/g, " ")} ${selfInitiated ? "submitted" : "recorded"}`,
    body: `Last working day ${lwd.toISOString().slice(0, 10)}.${shortfall ? ` ${shortfall} day(s) short of the ${notice.days}-day notice period.` : ""}`,
    link: `/exits/${exit.id}`, email: true, relatedType: "ExitRecord", relatedId: exit.id,
    event: "EXIT_SUBMITTED", employeeIds: [input.employeeId],
  });

  return { ok: true, message: selfInitiated ? "Resignation submitted for approval." : "Exit recorded.", exitId: exit.id, lastWorkingDay: lwd, shortfallDays: shortfall };
}

export async function decideExit(opts: {
  exitId: string; decision: "APPROVE" | "REJECT" | "RETAIN"; byUserId: string;
  lastWorkingDay?: Date | null; note?: string | null; isRehireEligible?: boolean | null;
}): Promise<{ ok: boolean; message: string }> {
  const exit = await prisma.exitRecord.findUnique({ where: { id: opts.exitId }, include: { employee: { select: { tenantId: true, userId: true, displayName: true } } } });
  if (!exit) return { ok: false, message: "Exit not found." };
  if (!["INITIATED", "PENDING_APPROVAL"].includes(exit.status)) return { ok: false, message: `This exit is already ${exit.status.toLowerCase().replace(/_/g, " ")}.` };

  if (opts.decision === "APPROVE") {
    const lwd = opts.lastWorkingDay ? utcMidnight(opts.lastWorkingDay) : exit.lastWorkingDay;
    if (lwd.getTime() < exit.noticeDate.getTime()) return { ok: false, message: "The last working day is before the notice date." };
    await prisma.$transaction([
      prisma.exitRecord.update({
        where: { id: exit.id },
        data: { status: "APPROVED", approvedBy: opts.byUserId, approvedAt: new Date(), lastWorkingDay: lwd, discussionNote: opts.note ?? exit.discussionNote, isRehireEligible: opts.isRehireEligible ?? exit.isRehireEligible },
      }),
      prisma.employee.update({ where: { id: exit.employeeId }, data: { status: "NOTICE_PERIOD", lastWorkingDay: lwd } }),
    ]);
    await trueUpExitAccrual(exit.employeeId);
    await startJourney({ employeeId: exit.employeeId, trigger: "EXIT", anchorDate: lwd, sourceType: "ExitRecord", sourceId: exit.id, createdBy: opts.byUserId });
    await notify({ tenantId: exit.employee.tenantId, userIds: [exit.employee.userId], kind: "EXIT", title: "Your resignation was accepted", body: `Your last working day is ${lwd.toISOString().slice(0, 10)}.`, link: "/me/exit", email: true, event: "EXIT_ACCEPTED", employeeIds: [exit.employeeId] });
    return { ok: true, message: `Approved. Last working day ${lwd.toISOString().slice(0, 10)}; the exit checklist has started.` };
  }
  await prisma.exitRecord.update({
    where: { id: exit.id },
    data: { status: opts.decision === "RETAIN" ? "RETAINED" : "REJECTED", approvedBy: opts.byUserId, approvedAt: new Date(), discussionNote: opts.note ?? null },
  });
  await prisma.employee.update({ where: { id: exit.employeeId }, data: { exitInitiatedAt: null } });
  return { ok: true, message: opts.decision === "RETAIN" ? "Marked as retained. The employee stays." : "Rejected." };
}

/** Withdraw an exit before the last working day. Reverses the notice status. */
export async function withdrawExit(exitId: string): Promise<{ ok: boolean; message: string }> {
  const exit = await prisma.exitRecord.findUnique({ where: { id: exitId } });
  if (!exit) return { ok: false, message: "Exit not found." };
  if (["SETTLED", "COMPLETED", "CANCELLED"].includes(exit.status)) return { ok: false, message: "This exit can no longer be withdrawn." };
  const settled = await prisma.fnfSettlement.findUnique({ where: { employeeId: exit.employeeId } });
  if (settled && ["FINALIZED", "PAID"].includes(settled.status)) return { ok: false, message: "The settlement is already finalised." };
  await prisma.$transaction([
    prisma.exitRecord.update({ where: { id: exitId }, data: { status: "CANCELLED" } }),
    prisma.employee.update({ where: { id: exit.employeeId }, data: { status: "CONFIRMED", lastWorkingDay: null, exitInitiatedAt: null } }),
    prisma.journey.updateMany({ where: { employeeId: exit.employeeId, trigger: "EXIT", status: "ACTIVE" }, data: { status: "CANCELLED" } }),
    prisma.fnfSettlement.deleteMany({ where: { employeeId: exit.employeeId, status: { in: ["PENDING", "IN_REVIEW"] } } }),
  ]);
  // The exit no longer stands, so neither does the accrual trimmed for it.
  await trueUpExitAccrual(exit.employeeId);
  return { ok: true, message: "Exit withdrawn. The employee is active again." };
}

// ---------------------------------------------------------------------------
//  Full and final settlement
// ---------------------------------------------------------------------------

export interface SettlementLine {
  group: "Leave" | "Salary" | "Others" | "Reimbursements" | "Assets" | "Loans" | "Statutory";
  label: string;
  amount: number;
  /** Payable to the employee, or recovered from them. */
  direction: "PAY" | "RECOVER";
  taxable: number;
  basis: string;
}

export interface SettlementComputation {
  lines: SettlementLine[];
  totalPayable: number;
  totalRecovery: number;
  tds: number;
  net: number;
  notes: string[];
  gratuityEligible: boolean;
  serviceYears: number;
  monthlyGross: number;
  monthlyBasic: number;
}

export function specsOf(revision: Prisma.SalaryRevisionGetPayload<{ include: { structure: { include: { components: { include: { component: true } } } } } }>): StructureComponentSpec[] {
  return (revision.structure?.components ?? []).filter((sc) => sc.isActive).map((sc) => ({
    code: sc.component.code, name: sc.component.name, type: sc.component.type,
    calculationType: sc.calculationType, formula: sc.formula,
    fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
    percentage: sc.percentage === null ? null : Number(sc.percentage),
    percentageOf: sc.percentageOf, sequence: sc.sequence,
    minAmount: sc.minAmount === null ? null : Number(sc.minAmount),
    maxAmount: sc.maxAmount === null ? null : Number(sc.maxAmount),
    isOutsideCtc: sc.component.isOutsideCtc, isLopApplicable: sc.component.isLopApplicable,
    affectsPfWage: sc.component.affectsPfWage, affectsEsiGross: sc.component.affectsEsiGross,
    showOnPayslip: sc.component.showOnPayslip, isPartOfFbp: sc.component.isPartOfFbp,
  }));
}

/**
 * Compute a settlement without saving it. Every line carries its basis, so
 * the statement explains itself: which balance, which wage, which rule.
 */
export async function computeSettlement(employeeId: string, opts: { waiveNoticeRecovery?: boolean; gratuityActCovered?: boolean } = {}): Promise<SettlementComputation> {
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    include: {
      exitRecord: true, statutoryProfile: true,
      // The salary in force on the last working day, exactly as payroll reads it.
      salaryRevisions: {
        where: { status: "APPLIED" },
        orderBy: { effectiveFrom: "desc" },
        include: { structure: { include: { components: { include: { component: true } } } } },
      },
    },
  });
  if (!emp.exitRecord) throw new Error("There is no exit for this employee.");
  const lwd = emp.exitRecord.lastWorkingDay;
  const notes: string[] = [];
  const lines: SettlementLine[] = [];

  const revision = emp.salaryRevisions.find((r) => r.effectiveFrom.getTime() <= lwd.getTime());
  const resolved = revision ? resolveStructure({ annualCtc: Number(revision.annualCtc), components: specsOf(revision) }) : null;
  const monthly = (code: string) => Number(resolved?.byCode.get(code)?.monthly ?? 0);
  const monthlyBasic = monthly("BASIC") || Number(resolved?.monthlyGross ?? 0) * 0.5;
  const monthlyGross = Number(resolved?.monthlyGross ?? 0);
  if (!resolved) notes.push("No salary on record — wage-based lines are zero.");

  // --- Salary: the final month goes through the regular payroll run.
  const lwdRun = await prisma.payrollRunEmployee.findFirst({
    where: { employeeId, run: { year: lwd.getUTCFullYear(), month: lwd.getUTCMonth() + 1, rolledBackAt: null } },
    include: { run: { select: { status: true, year: true, month: true } } },
  });
  notes.push(lwdRun
    ? `Salary up to the last working day is paid in the ${lwdRun.run.month}/${lwdRun.run.year} payroll run (${lwdRun.run.status.toLowerCase().replace(/_/g, " ")}), prorated to ${lwd.toISOString().slice(0, 10)}.`
    : `Salary up to the last working day will be paid, prorated, in the ${lwd.getUTCMonth() + 1}/${lwd.getUTCFullYear()} payroll run.`);

  // --- Leave encashment, per encashable type.
  const types = await prisma.leaveType.findMany({ where: { tenantId: emp.tenantId, encashmentEnabled: true, isActive: true } });
  const plan = await prisma.leavePlanAssignment.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: "desc" }, include: { plan: true } });
  const yearStart = leaveYearStart(lwd, plan?.plan.yearBasis ?? "FINANCIAL_APR", emp.dateOfJoining);
  for (const t of types) {
    const days = await recomputeBalance(employeeId, t.id, yearStart);
    if (days <= 0) continue;
    const m = /^\s*\[(\w+)\]\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(t.encashmentFormula ?? "");
    const code = m?.[1] ?? "BASIC";
    const divisor = m ? Number(m[2]) : 30;
    const wage = code === "GROSS" ? monthlyGross : monthly(code) || monthlyBasic;
    const enc = calculateLeaveEncashment({ days, monthlyWage: wage, divisor, isOnExit: true });
    lines.push({
      group: "Leave", label: `${t.name} encashment`, amount: Number(enc.grossAmount), direction: "PAY",
      taxable: Number(enc.taxableAmount),
      basis: `${days} day(s) × ₹${Number(enc.perDayRate).toFixed(2)}/day (${code} ÷ ${divisor}); exempt under s.10(10AA) up to the lifetime ceiling`,
    });
  }

  // --- Gratuity.
  const headcount = await prisma.employee.count({ where: { tenantId: emp.tenantId, status: { notIn: ["EXITED"] } } });
  const actCovered = opts.gratuityActCovered ?? headcount >= 10;
  // The tenant's gratuity settings (Payroll settings), when saved.
  const gs = await prisma.payrollPreference.findUnique({ where: { tenantId: emp.tenantId } });
  const gWageCodes = Array.isArray(gs?.gratuityWageCodes) ? (gs!.gratuityWageCodes as string[]) : null;
  const gratuity = calculateGratuity({
    lastDrawnBasicDa: gWageCodes ? gWageCodes.reduce((s, c) => s + monthly(c), 0) : monthlyBasic + monthly("DA"), dateOfJoining: emp.dateOfJoining, lastWorkingDay: lwd,
    actCovered, waiveMinimumService: emp.exitRecord.type === "DEATH",
    ...(gs ? { minServiceYears: Number(gs.gratuityEligibilityYears), daysPerYear: gs.gratuityDaysPerYear, divisorOverride: actCovered && gs.gratuityDivisor !== 26 ? gs.gratuityDivisor : null, payoutCap: Number(gs.gratuityCap) } : {}),
  });
  if (gratuity.eligible && Number(gratuity.grossGratuity) > 0) {
    lines.push({
      group: "Others", label: "Gratuity", amount: Number(gratuity.grossGratuity), direction: "PAY",
      taxable: Number(gratuity.taxableAmount),
      basis: `${gs?.gratuityDaysPerYear ?? 15} × ₹${Number(gratuity.wageBase).toFixed(0)} × ${gratuity.serviceYears} year(s) ÷ ${Number(gratuity.divisor)}; ${gratuity.notes.join("; ")}`,
    });
  } else {
    notes.push(gratuity.notes[0] ?? "Not eligible for gratuity.");
  }

  // --- Notice period.
  const notice = await noticeDaysFor(employeeId, emp.exitRecord.type);
  const served = Math.max(0, Math.round((lwd.getTime() - emp.exitRecord.noticeDate.getTime()) / DAY));
  const employerBuyout = emp.exitRecord.type === "TERMINATION";
  const nb = calculateNoticeBuyout({
    requiredDays: notice.days, servedDays: served,
    monthlyWage: notice.basis === "BASIC" ? monthlyBasic : monthlyGross, employerBuyout,
  });
  if (nb.shortfallDays > 0) {
    if (nb.isRecovery && opts.waiveNoticeRecovery) {
      notes.push(`${nb.shortfallDays} day(s) of notice shortfall waived.`);
    } else {
      lines.push({
        group: "Salary", label: nb.isRecovery ? "Notice period shortfall" : "Pay in lieu of notice",
        amount: Number(nb.amount), direction: nb.isRecovery ? "RECOVER" : "PAY",
        taxable: nb.isRecovery ? 0 : Number(nb.amount),
        basis: `${nb.shortfallDays} of ${notice.days} day(s) × ₹${Number(nb.perDayRate).toFixed(2)}/day (${notice.basis.toLowerCase()} ÷ 30)`,
      });
    }
  }

  // --- Unpaid bonuses.
  const bonuses = await prisma.employeeBonus.findMany({ where: { employeeId, isProcessed: false, payAction: "PAY" }, include: { bonusType: true } });
  for (const b of bonuses) {
    lines.push({ group: "Others", label: `${b.bonusType.name}`, amount: Number(b.amount) - Number(b.paidAmount ?? 0), direction: "PAY", taxable: Number(b.amount) - Number(b.paidAmount ?? 0), basis: `Scheduled for ${b.payoutMonth}/${b.payoutYear}, not yet paid` });
  }

  // --- Approved reimbursements not yet paid.
  const claims = await prisma.componentClaim.findMany({ where: { employeeId, status: "APPROVED" }, include: { component: true } });
  for (const c of claims) {
    const amt = Number(c.payableAmount ?? c.claimedAmount);
    lines.push({ group: "Reimbursements", label: `${c.component.name} claim`, amount: amt, direction: "PAY", taxable: 0, basis: "Approved, not yet paid" });
  }

  // --- Loans: everything not yet deducted.
  const installments = await prisma.loanInstallment.findMany({
    where: { status: "SCHEDULED", loan: { employeeId, status: { in: ["DISBURSED", "ACTIVE"] } } },
    include: { loan: { include: { category: true } } },
  });
  const byLoan = new Map<string, { label: string; amount: number; count: number }>();
  for (const i of installments) {
    const cur = byLoan.get(i.loanId) ?? { label: i.loan.category.name, amount: 0, count: 0 };
    cur.amount += Number(i.principalPart);
    cur.count++;
    byLoan.set(i.loanId, cur);
  }
  for (const l of byLoan.values()) {
    lines.push({ group: "Loans", label: `${l.label} — outstanding principal`, amount: r2(l.amount), direction: "RECOVER", taxable: 0, basis: `${l.count} scheduled instalment(s); future interest is not charged` });
  }

  // --- Assets: damage not yet recovered, and anything still out.
  const assignments = await prisma.assetAssignment.findMany({ where: { employeeId }, include: { asset: { include: { assetType: true } } } });
  for (const a of assignments) {
    if (a.returnedOn && Number(a.damageCharge ?? 0) > 0 && !a.chargeRecovered) {
      lines.push({ group: "Assets", label: `Damage — ${a.asset.assetType.name} ${a.asset.assetTag}`, amount: Number(a.damageCharge), direction: "RECOVER", taxable: 0, basis: a.damageNote ?? "Recorded on return" });
    }
    if (!a.returnedOn) {
      const value = Number(a.asset.currentValue ?? a.asset.purchaseCost ?? 0);
      if (value > 0) lines.push({ group: "Assets", label: `Not returned — ${a.asset.assetType.name} ${a.asset.assetTag}`, amount: value, direction: "RECOVER", taxable: 0, basis: "Book value; removed once the asset is returned" });
      else notes.push(`${a.asset.assetType.name} ${a.asset.assetTag} is not returned and has no recorded value.`);
    }
  }

  // --- TDS on the taxable part, at the employee's own marginal position.
  const taxable = lines.filter((l) => l.direction === "PAY").reduce((s, l) => s + l.taxable, 0);
  let tds = 0;
  if (taxable > 0 && !(emp.statutoryProfile?.tdsDisabled ?? false) && emp.payGroupId) {
    const fy = fyStartYear(lwd);
    const tables = await loadStatutoryTables(emp.payGroupId, fy, lwd);
    const regime = (emp.statutoryProfile?.taxRegime ?? "NEW") as "OLD" | "NEW";
    const config = tables.taxConfigs.get(regime);
    if (config) {
      const ytd = await prisma.payrollRunEmployee.aggregate({
        where: { employeeId, run: { rolledBackAt: null, OR: [{ year: fy, month: { gte: 4 } }, { year: fy + 1, month: { lte: 3 } }] } },
        _sum: { grossEarnings: true, professionalTax: true },
      });
      const base = {
        regime, grossSalary: Number(ytd._sum.grossEarnings ?? 0),
        professionalTax: Number(ytd._sum.professionalTax ?? 0),
        slabs: slabsFor(tables.taxSlabBands.get(regime), ageAtFyEnd(emp.dateOfBirth, fy)), config,
      };
      const without = calculateAnnualTax(base);
      const withF = calculateAnnualTax({ ...base, grossSalary: base.grossSalary + taxable });
      tds = Math.max(0, Math.round(Number(withF.totalTaxLiability) - Number(without.totalTaxLiability)));
      notes.push(`TDS is the extra tax the taxable ₹${taxable.toFixed(0)} adds to this year's ₹${base.grossSalary.toFixed(0)} salary under the ${regime.toLowerCase()} regime.`);
    }
  }
  if (tds > 0) lines.push({ group: "Statutory", label: "Income tax (TDS)", amount: tds, direction: "RECOVER", taxable: 0, basis: "Marginal tax on the taxable settlement" });

  const totalPayable = r2(lines.filter((l) => l.direction === "PAY").reduce((s, l) => s + l.amount, 0));
  const totalRecovery = r2(lines.filter((l) => l.direction === "RECOVER").reduce((s, l) => s + l.amount, 0));
  return {
    lines, totalPayable, totalRecovery, tds, net: r2(totalPayable - totalRecovery), notes,
    gratuityEligible: gratuity.eligible, serviceYears: gratuity.rawServiceYears, monthlyGross, monthlyBasic,
  };
}

const sumOf = (lines: SettlementLine[], f: (l: SettlementLine) => boolean) => r2(lines.filter(f).reduce((s, l) => s + l.amount, 0));

/** Compute and save as a draft for review. Refuses once finalised. */
export async function draftSettlement(employeeId: string, opts: { waiveNoticeRecovery?: boolean; settlementYear?: number; settlementMonth?: number } = {}): Promise<{ ok: boolean; message: string; settlementId?: string }> {
  const existing = await prisma.fnfSettlement.findUnique({ where: { employeeId } });
  if (existing && ["FINALIZED", "PAID", "ALREADY_PAID"].includes(existing.status)) {
    return { ok: false, message: "The settlement is already finalised." };
  }
  const exit = await prisma.exitRecord.findUnique({ where: { employeeId } });
  if (!exit || !["APPROVED", "IN_CLEARANCE", "SETTLED"].includes(exit.status)) {
    return { ok: false, message: "The exit must be approved before a settlement can be drafted." };
  }
  // The month it is booked in: as chosen, else as chosen before, else the
  // last working day's month.
  const { validateSettlementMonth } = await import("./fnf-math");
  const keep = existing?.status !== "VOIDED" && existing?.settlementYear && existing?.settlementMonth ? { year: existing.settlementYear, month: existing.settlementMonth } : null;
  const period = opts.settlementYear && opts.settlementMonth ? { year: opts.settlementYear, month: opts.settlementMonth }
    : keep && !validateSettlementMonth(exit.lastWorkingDay, keep.year, keep.month) ? keep
    : { year: exit.lastWorkingDay.getUTCFullYear(), month: exit.lastWorkingDay.getUTCMonth() + 1 };
  const bad = validateSettlementMonth(exit.lastWorkingDay, period.year, period.month);
  if (bad) return { ok: false, message: bad };
  // Leave earned only to the last working day is what gets encashed.
  await trueUpExitAccrual(employeeId);
  const c = await computeSettlement(employeeId, opts);
  const L = c.lines;
  const data = {
    status: "IN_REVIEW" as const,
    settlementYear: period.year, settlementMonth: period.month,
    leaveEncashment: sumOf(L, (l) => l.group === "Leave"),
    gratuity: sumOf(L, (l) => l.label === "Gratuity"),
    noticeBuyoutPay: sumOf(L, (l) => l.label === "Pay in lieu of notice"),
    bonusPayable: sumOf(L, (l) => l.group === "Others" && l.label !== "Gratuity"),
    reimbursements: sumOf(L, (l) => l.group === "Reimbursements"),
    noticeShortfallRecovery: sumOf(L, (l) => l.label === "Notice period shortfall"),
    loanRecovery: sumOf(L, (l) => l.group === "Loans"),
    assetDamageRecovery: sumOf(L, (l) => l.group === "Assets"),
    tdsDeduction: c.tds,
    totalPayable: c.totalPayable, totalRecovery: c.totalRecovery, netSettlement: c.net,
    gratuityEligible: c.gratuityEligible,
    breakdown: { lines: c.lines, notes: c.notes, waiveNoticeRecovery: !!opts.waiveNoticeRecovery, computedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
  };
  const s = existing
    ? await prisma.fnfSettlement.update({ where: { id: existing.id }, data })
    : await prisma.fnfSettlement.create({ data: { ...data, employeeId } });
  if (exit.status === "APPROVED") await prisma.exitRecord.update({ where: { id: exit.id }, data: { status: "IN_CLEARANCE" } });
  return { ok: true, message: `Drafted: net ${c.net >= 0 ? "payable" : "recoverable"} ₹${Math.abs(c.net).toLocaleString("en-IN")}.`, settlementId: s.id };
}

/**
 * Finalise. The last working day must have passed and every required exit
 * task must be closed. Marks recoveries as settled and the employee exited.
 */
export async function finalizeSettlement(employeeId: string, byUserId: string, today = new Date()): Promise<{ ok: boolean; message: string }> {
  const s = await prisma.fnfSettlement.findUnique({ where: { employeeId }, include: { employee: { include: { exitRecord: true } } } });
  if (!s) return { ok: false, message: "Draft the settlement first." };
  if (s.status !== "IN_REVIEW" && s.status !== "APPROVED") return { ok: false, message: `The settlement is ${s.status.toLowerCase().replace(/_/g, " ")}.` };
  const exit = s.employee.exitRecord!;
  if (exit.lastWorkingDay.getTime() > utcMidnight(today).getTime()) {
    return { ok: false, message: `The last working day (${exit.lastWorkingDay.toISOString().slice(0, 10)}) has not passed yet.` };
  }
  const journey = await prisma.journey.findFirst({ where: { employeeId, trigger: "EXIT", status: { not: "CANCELLED" } } });
  if (journey) {
    await runAutoChecks(journey.id);
    // FNF_SETTLED is what we are about to do; it cannot block itself.
    const blocking = await prisma.journeyTask.findMany({
      where: { journeyId: journey.id, status: "PENDING", isRequired: true, NOT: { autoCheck: "FNF_SETTLED" } },
      select: { title: true },
    });
    if (blocking.length > 0) {
      return { ok: false, message: `${blocking.length} required exit task(s) are still open: ${blocking.slice(0, 3).map((b) => b.title).join(", ")}${blocking.length > 3 ? "…" : ""}.` };
    }
  }
  // Recompute: balances or loans may have moved since the draft.
  const breakdown = s.breakdown as { waiveNoticeRecovery?: boolean } | null;
  const fresh = await computeSettlement(employeeId, { waiveNoticeRecovery: breakdown?.waiveNoticeRecovery });
  if (Math.abs(fresh.net - Number(s.netSettlement)) > 0.5) {
    return { ok: false, message: `The figures changed since the draft (net ₹${Number(s.netSettlement).toFixed(0)} → ₹${fresh.net.toFixed(0)}). Recompute and review before finalising.` };
  }

  await prisma.$transaction(async (tx) => {
    // Record exactly what finalising changes, so a void can put it back.
    const open = await tx.loanInstallment.findMany({ where: { status: "SCHEDULED", loan: { employeeId, status: { in: ["DISBURSED", "ACTIVE"] } } } });
    const effects: FnfEffects = {
      installments: open.map((i) => ({ id: i.id, interestPart: Number(i.interestPart), totalAmount: Number(i.totalAmount) })),
      loans: (await tx.loan.findMany({ where: { employeeId, status: { in: ["DISBURSED", "ACTIVE"] } }, select: { id: true, status: true } })).map((l) => ({ id: l.id, status: l.status })),
      assetAssignmentIds: (await tx.assetAssignment.findMany({ where: { employeeId, returnedOn: { not: null }, damageCharge: { gt: 0 }, chargeRecovered: false }, select: { id: true } })).map((a) => a.id),
      bonusIds: (await tx.employeeBonus.findMany({ where: { employeeId, isProcessed: false, payAction: "PAY" }, select: { id: true } })).map((b) => b.id),
      claimIds: (await tx.componentClaim.findMany({ where: { employeeId, status: "APPROVED" }, select: { id: true } })).map((c) => c.id),
      employeeStatus: s.employee.status, exitStatus: exit.status,
    };
    await tx.fnfSettlement.update({
      where: { id: s.id },
      data: { status: "FINALIZED", finalizedAt: new Date(), finalizedBy: byUserId, breakdown: { ...((s.breakdown ?? {}) as object), effects } as unknown as Prisma.InputJsonValue },
    });
    // Recovered in the settlement: the rest of each schedule is prepaid,
    // principal only, as the settlement line was computed.
    for (const i of open) {
      await tx.loanInstallment.update({ where: { id: i.id }, data: { status: "PREPAID", interestPart: 0, totalAmount: i.principalPart, deductedAt: new Date() } });
    }
    await tx.loan.updateMany({ where: { employeeId, status: { in: ["DISBURSED", "ACTIVE"] } }, data: { status: "FORECLOSED", closedAt: new Date() } });
    await tx.assetAssignment.updateMany({ where: { employeeId, returnedOn: { not: null }, damageCharge: { gt: 0 }, chargeRecovered: false }, data: { chargeRecovered: true } });
    await tx.employeeBonus.updateMany({ where: { employeeId, isProcessed: false, payAction: "PAY" }, data: { isProcessed: true } });
    await tx.componentClaim.updateMany({ where: { employeeId, status: "APPROVED" }, data: { status: "PAID" } });
    await tx.exitRecord.update({ where: { id: exit.id }, data: { status: "SETTLED" } });
    await tx.employee.update({ where: { id: employeeId }, data: { status: "EXITED" } });
    // Revoke access: an exited employee cannot sign in.
    if (s.employee.userId) await tx.user.update({ where: { id: s.employee.userId }, data: { loginDisabled: true } });
  });
  const { syncLoanBalance } = await import("./loans");
  for (const l of await prisma.loan.findMany({ where: { employeeId }, select: { id: true } })) await syncLoanBalance(l.id);
  if (journey) await runAutoChecks(journey.id);
  const { postSettlement } = await import("./accounting");
  const ledger = await postSettlement(s.id, byUserId);
  const gone = await prisma.employee.findUnique({ where: { id: employeeId }, select: { tenantId: true, employeeNumber: true, lastWorkingDay: true } });
  if (gone) {
    const { emitEvent } = await import("./webhooks");
    await emitEvent(gone.tenantId, "employee.exited", { employeeId, employeeNumber: gone.employeeNumber, lastWorkingDay: (gone.lastWorkingDay ?? exit.lastWorkingDay)?.toISOString().slice(0, 10) ?? null });
  }
  return { ok: true, message: `Finalised. Net ₹${Math.abs(fresh.net).toLocaleString("en-IN")} ${fresh.net >= 0 ? "payable to" : "recoverable from"} the employee; access revoked.${ledger.ok ? ` ${ledger.message}` : ` Not posted to the ledger: ${ledger.message}`}` };
}

// ---------------------------------------------------------------------------
//  Helpdesk: see ./helpdesk.ts (raiseTicket, commentOnTicket, setTicketStatus…)
// ---------------------------------------------------------------------------
