import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { govAudit } from "./governance-core";
import {
  anniversaryYears, budgetCheck, inAudience, nextRunOn, programEligibility, promoteFromWaitlist, reminderDue,
  type Audience, type EngageWorkflowType,
} from "./engage-depth-math";
import type { StepSpec } from "./governance-math";

/**
 * Engage depth: what the workflow engine runs when an engage approval
 * finishes, the reward points ledger, survey launch / reminders /
 * schedules, announcement publication and audiences, and the nightly
 * engage job. Everything is scoped by tenant.
 */

const DAY = 86_400_000;
const ACTIVE_STATUSES = ["PREBOARDING", "EXITED", "INACTIVE"] as const;
const audit = (tenantId: string, actor: string | null, entityType: string, entityId: string, action: "CREATE" | "UPDATE" | "APPROVE" | "REJECT", summary: string) =>
  govAudit(tenantId, actor, { action, entityType, entityId, summary });

export async function engageSettings(tenantId: string) {
  return (await prisma.engageSetting.findUnique({ where: { tenantId } }))
    ?? { tenantId, surveyApproval: false, announcementApproval: false, pointsPerPraise: 10, anniversaryPoints: 0, checkInMinGroup: 3, surveyRetentionDays: 0 };
}

// ---------------------------------------------------------------------------
//  Workflow routes and effects
// ---------------------------------------------------------------------------

const perm = (name: string, permission: string, order = 1): StepSpec => ({ order, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours: 48, escalateTo: "ADMINS" });

/** Built-in approval routes for the engage request types. */
export function engageBuiltInRoute(entityType: string, opts: { reviewerUserId?: string | null } = {}): StepSpec[] {
  switch (entityType as EngageWorkflowType) {
    case "SURVEY_PUBLISH": return [perm("Survey owner review", "engagement.survey.manage")];
    case "ANNOUNCEMENT_PUBLISH": return [perm("Communications review", "engagement.announcement.manage")];
    case "RECOGNITION_PROGRAM": return [perm("Rewards administrator", "engagement.award.manage")];
    case "AWARD_NOMINATION": return [
      { order: 1, name: "Nominee's manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 72, escalateTo: "MANAGER_OF_APPROVER" },
      perm("Awards panel", "engagement.award.manage", 2),
    ];
    case "REWARD_REDEMPTION": return [perm("Rewards administrator", "engagement.award.manage")];
    case "SERVICE_REQUEST": return [{ order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" }];
    case "WELLNESS_PROGRAM":
    case "SUPPORT_RESOURCE": return [perm("Wellness administrator", "engagement.wellness.manage")];
    case "COMPANY_EVENT": return [perm("Communications review", "engagement.announcement.manage")];
    case "CHANNEL_JOIN": return opts.reviewerUserId
      ? [{ order: 1, name: "Channel owner", approverType: "USER", approverUserId: opts.reviewerUserId, mode: "ANY", slaHours: 72, escalateTo: "ADMINS" }]
      : [perm("Community moderator", "engagement.announcement.manage")];
    default: return [];
  }
}

/** Apply a finished engage approval to its record. Throws to leave the request in ERROR. */
export async function applyEngageEffect(req: { id: string; tenantId: string; entityType: string; entityId: string | null }, outcome: "APPROVED" | "REJECTED" | "WITHDRAWN", actorUserId: string | null): Promise<void> {
  const t = req.tenantId, id = req.entityId;
  if (!id) return;
  const ok = outcome === "APPROVED";
  switch (req.entityType as EngageWorkflowType) {
    case "SURVEY_PUBLISH": {
      if (ok) {
        await prisma.survey.updateMany({ where: { id, tenantId: t }, data: { approvalStatus: "APPROVED" } });
        const r = await launchSurvey(t, id, actorUserId);
        if (!r.ok) throw new Error(r.message);
      } else await prisma.survey.updateMany({ where: { id, tenantId: t, status: "DRAFT" }, data: { approvalStatus: outcome === "WITHDRAWN" ? null : "REJECTED" } });
      return;
    }
    case "ANNOUNCEMENT_PUBLISH": {
      if (ok) {
        await prisma.announcement.updateMany({ where: { id, tenantId: t }, data: { approvalStatus: "APPROVED" } });
        await releaseAnnouncement(t, id, actorUserId);
      } else await prisma.announcement.updateMany({ where: { id, tenantId: t, status: "DRAFT" }, data: { approvalStatus: outcome === "WITHDRAWN" ? null : "REJECTED" } });
      return;
    }
    case "RECOGNITION_PROGRAM":
      await prisma.recognitionProgram.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      await audit(t, actorUserId, "RecognitionProgram", id, ok ? "APPROVE" : "REJECT", `Recognition programme ${ok ? "approved and active" : outcome.toLowerCase()}`);
      return;
    case "AWARD_NOMINATION":
      if (ok) await grantNomination(t, id, actorUserId);
      else await prisma.awardNomination.updateMany({ where: { id, tenantId: t, status: "PENDING" }, data: { status: outcome, decidedAt: new Date() } });
      return;
    case "REWARD_REDEMPTION": {
      const r = await prisma.rewardRedemption.findFirst({ where: { id, tenantId: t } });
      if (!r || r.status !== "PENDING") return;
      if (ok) {
        const item = await prisma.rewardItem.findFirst({ where: { id: r.itemId, tenantId: t } });
        if (item && item.stock !== null) {
          const dec = await prisma.rewardItem.updateMany({ where: { id: item.id, stock: { gte: r.quantity } }, data: { stock: { decrement: r.quantity } } });
          if (dec.count === 0) throw new Error(`"${item.name}" is out of stock; restock it and retry, or reject the request.`);
        }
        await prisma.rewardRedemption.update({ where: { id }, data: { status: "APPROVED" } });
        const fulfillers = await usersWithPermission(t, "engagement.award.manage");
        await notify({ tenantId: t, userIds: fulfillers, kind: "ENGAGE", title: `Fulfil reward: ${r.itemName}`, link: "/engage/rewards?tab=redemptions" });
      } else {
        await prisma.rewardRedemption.update({ where: { id }, data: { status: outcome === "WITHDRAWN" ? "CANCELLED" : "REJECTED" } });
        await creditPoints(t, { employeeId: r.employeeId, delta: r.points, source: "REFUND", sourceId: r.id, note: `Refund: ${r.itemName} ${outcome.toLowerCase()}`, createdBy: actorUserId });
      }
      return;
    }
    case "SERVICE_REQUEST": {
      const sr = await prisma.serviceRequest.findFirst({ where: { id, tenantId: t }, include: {} });
      if (!sr || sr.status !== "PENDING_APPROVAL") return;
      if (ok) {
        const type = await prisma.serviceType.findFirst({ where: { id: sr.typeId, tenantId: t } });
        await prisma.serviceRequest.update({ where: { id }, data: { status: "OPEN", dueOn: new Date(Date.now() + (type?.slaDays ?? 3) * DAY) } });
        await notify({ tenantId: t, userIds: await usersWithPermission(t, "engagement.service.manage"), kind: "ENGAGE", title: `Service request to fulfil: ${type?.name ?? "request"}`, link: "/engage/services?tab=queue" });
      } else await prisma.serviceRequest.update({ where: { id }, data: { status: outcome === "WITHDRAWN" ? "CANCELLED" : "REJECTED" } });
      return;
    }
    case "WELLNESS_PROGRAM":
      await prisma.wellnessProgram.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "ACTIVE" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      if (ok) {
        const p = await prisma.wellnessProgram.findFirstOrThrow({ where: { id, tenantId: t } });
        const people = await activeEmployees(t, p.departmentIds);
        await notify({ tenantId: t, userIds: people.map((e) => e.userId), kind: "ENGAGE", title: `New wellness ${p.kind === "CHALLENGE" ? "challenge" : "programme"}: ${p.title}`, link: "/engage/wellness" });
      }
      await audit(t, actorUserId, "WellnessProgram", id, ok ? "APPROVE" : "REJECT", `Wellness programme ${ok ? "approved and live" : outcome.toLowerCase()}`);
      return;
    case "SUPPORT_RESOURCE":
      await prisma.supportResource.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "PUBLISHED" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      await audit(t, actorUserId, "SupportResource", id, ok ? "APPROVE" : "REJECT", `Support resource ${ok ? "published" : outcome.toLowerCase()}`);
      return;
    case "COMPANY_EVENT":
      await prisma.companyEvent.updateMany({ where: { id, tenantId: t, status: "PENDING_APPROVAL" }, data: { status: ok ? "PUBLISHED" : outcome === "WITHDRAWN" ? "DRAFT" : "REJECTED" } });
      if (ok) await announceEvent(t, id);
      await audit(t, actorUserId, "CompanyEvent", id, ok ? "APPROVE" : "REJECT", `Company event ${ok ? "published" : outcome.toLowerCase()}`);
      return;
    case "CHANNEL_JOIN":
      await prisma.communityMember.updateMany({ where: { id, status: "PENDING", channel: { tenantId: t } }, data: ok ? { status: "ACTIVE", joinedAt: new Date() } : { status: outcome === "WITHDRAWN" ? "REMOVED" : "REJECTED" } });
      return;
  }
}

// ---------------------------------------------------------------------------
//  People helpers
// ---------------------------------------------------------------------------

/** Active employees (with a login) in the given departments (empty = all). */
export async function activeEmployees(tenantId: string, departmentIds: string[] = []) {
  return prisma.employee.findMany({
    where: { tenantId, status: { notIn: [...ACTIVE_STATUSES] }, ...(departmentIds.length ? { departmentId: { in: departmentIds } } : {}) },
    select: { id: true, userId: true, departmentId: true, locationId: true, businessUnitId: true, status: true },
  });
}

/** Everyone an announcement's audience filter reaches. */
export async function announcementAudience(tenantId: string, audience: Prisma.JsonValue | null) {
  const a = (audience ?? null) as Audience | null;
  return (await activeEmployees(tenantId)).filter((e) => inAudience(a, e));
}

// ---------------------------------------------------------------------------
//  Points ledger
// ---------------------------------------------------------------------------

/** Post a ledger entry. Idempotent per (source, sourceId, employee): posting twice does nothing. */
export async function creditPoints(tenantId: string, e: { employeeId: string; delta: number; source: string; sourceId?: string | null; programId?: string | null; note?: string | null; createdBy?: string | null }, tx: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (!e.delta) return false;
  const res = await tx.rewardPointEntry.createMany({
    data: [{ tenantId, employeeId: e.employeeId, delta: e.delta, source: e.source, sourceId: e.sourceId ?? null, programId: e.programId ?? null, note: e.note ?? null, createdBy: e.createdBy ?? null }],
    skipDuplicates: true,
  });
  return res.count > 0;
}

export async function pointsBalanceOf(tenantId: string, employeeId: string): Promise<number> {
  const agg = await prisma.rewardPointEntry.aggregate({ where: { tenantId, employeeId }, _sum: { delta: true } });
  return agg._sum.delta ?? 0;
}

/** Credit the tenant's per-praise points to each recipient of these praise rows. */
export async function creditPraisePoints(tenantId: string, praise: Array<{ id: string; toEmployeeId: string }>): Promise<number> {
  const s = await engageSettings(tenantId);
  if (s.pointsPerPraise <= 0) return 0;
  let n = 0;
  for (const p of praise) if (await creditPoints(tenantId, { employeeId: p.toEmployeeId, delta: s.pointsPerPraise, source: "PRAISE", sourceId: p.id, note: "Praise received" })) n++;
  return n;
}

/** Points granted under a programme so far (its budget usage). */
export async function programPointsUsed(tenantId: string, programId: string): Promise<number> {
  const agg = await prisma.rewardPointEntry.aggregate({ where: { tenantId, programId, source: { in: ["AWARD", "REVOKE"] } }, _sum: { delta: true } });
  return agg._sum.delta ?? 0;
}

/** Cash granted under a programme so far. */
export async function programCashUsed(tenantId: string, programId: string): Promise<number> {
  const agg = await prisma.employeeAward.aggregate({ where: { tenantId, programId, revokedAt: null }, _sum: { cashAmount: true } });
  return Number(agg._sum.cashAmount ?? 0);
}

/** An approved nomination becomes an award, with its points and the programme budget checked. */
export async function grantNomination(tenantId: string, nominationId: string, actorUserId: string | null): Promise<void> {
  const n = await prisma.awardNomination.findFirst({ where: { id: nominationId, tenantId } });
  if (!n || n.status !== "PENDING") return;
  const [type, program, nominee] = await Promise.all([
    prisma.awardType.findFirst({ where: { id: n.awardTypeId, tenantId } }),
    n.programId ? prisma.recognitionProgram.findFirst({ where: { id: n.programId, tenantId } }) : Promise.resolve(null),
    prisma.employee.findFirst({ where: { id: n.nomineeId, tenantId }, select: { id: true, userId: true, displayName: true, departmentId: true, dateOfJoining: true } }),
  ]);
  if (!type || !nominee) throw new Error("The award type or nominee no longer exists.");
  const points = program?.pointsPerAward ?? type.points ?? 0;
  if (program) {
    const elig = programEligibility(program, nominee, new Date());
    if (!elig.ok) throw new Error(elig.reason);
    const pts = budgetCheck(program.budgetPoints, await programPointsUsed(tenantId, program.id), points);
    if (!pts.fits) throw new Error(`The programme's points budget has ${pts.remaining} left; this award needs ${points}.`);
    if (program.budgetAmount !== null && type.cashAmount !== null) {
      const cash = budgetCheck(Number(program.budgetAmount), await programCashUsed(tenantId, program.id), Number(type.cashAmount));
      if (!cash.fits) throw new Error(`The programme's cash budget has ${cash.remaining} left; this award pays ${Number(type.cashAmount)}.`);
    }
  }
  const nominator = await prisma.employee.findFirst({ where: { id: n.nominatorId, tenantId }, select: { id: true } });
  const approver = actorUserId ? await prisma.employee.findFirst({ where: { tenantId, userId: actorUserId }, select: { id: true } }) : null;
  await prisma.$transaction(async (tx) => {
    const award = await tx.employeeAward.create({
      data: {
        tenantId, awardTypeId: type.id, employeeId: nominee.id, awardedOn: new Date(), citation: n.citation, cashAmount: type.cashAmount,
        nominatedBy: nominator?.id ?? null, approvedBy: approver?.id ?? null, programId: program?.id ?? null, points: points || null,
        period: new Date().toISOString().slice(0, 7),
      },
    });
    await tx.awardNomination.update({ where: { id: n.id }, data: { status: "APPROVED", awardId: award.id, decidedAt: new Date() } });
    if (points > 0) await creditPoints(tenantId, { employeeId: nominee.id, delta: points, source: "AWARD", sourceId: award.id, programId: program?.id ?? null, note: `${type.name} award`, createdBy: actorUserId }, tx);
  });
  await audit(tenantId, actorUserId, "AwardNomination", n.id, "APPROVE", `Nomination approved: "${type.name}" to ${nominee.displayName}${points ? ` (+${points} points)` : ""}`);
  await notify({ tenantId, userIds: [nominee.userId], kind: "ENGAGE", title: `You received the ${type.name} award`, body: n.citation, link: "/engage/rewards", email: true });
}

// ---------------------------------------------------------------------------
//  Surveys
// ---------------------------------------------------------------------------

/** Launch a draft survey: live now, invitations out. */
export async function launchSurvey(tenantId: string, surveyId: string, actorUserId: string | null): Promise<{ ok: boolean; message: string; invited?: number }> {
  const s = await prisma.survey.findFirst({ where: { id: surveyId, tenantId }, include: { _count: { select: { questions: true } } } });
  if (!s) return { ok: false, message: "Survey not found." };
  if (s.status !== "DRAFT") return { ok: false, message: "Only a draft can be launched." };
  if (s._count.questions === 0) return { ok: false, message: "Add at least one question first." };
  const audience = await activeEmployees(tenantId, s.departmentIds);
  if (audience.length === 0) return { ok: false, message: "Nobody is in the chosen departments." };
  await prisma.survey.update({ where: { id: s.id }, data: { status: "ACTIVE", launchedAt: new Date(), opensAt: new Date() } });
  await notify({
    tenantId, userIds: audience.map((a) => a.userId), kind: "ENGAGE",
    title: s.kind === "POLL" ? `New poll: ${s.title}` : `Your voice counts: ${s.title}`,
    body: s.isAnonymous ? "Your answers are anonymous." : "Your answers will carry your name.",
    link: `/engage/surveys/${s.id}`,
  });
  await audit(tenantId, actorUserId, "Survey", s.id, "UPDATE", `Launched "${s.title}" to ${audience.length} people`);
  return { ok: true, message: `Launched to ${audience.length} people.`, invited: audience.length };
}

/** Remind everyone invited who has not responded yet. */
export async function remindSurvey(tenantId: string, surveyId: string, actorUserId: string | null): Promise<{ ok: boolean; message: string; reminded: number }> {
  const s = await prisma.survey.findFirst({ where: { id: surveyId, tenantId }, include: { participants: { select: { employeeId: true } } } });
  if (!s) return { ok: false, message: "Survey not found.", reminded: 0 };
  if (s.status !== "ACTIVE") return { ok: false, message: "Only a live survey can send reminders.", reminded: 0 };
  const done = new Set(s.participants.map((p) => p.employeeId));
  const pending = (await activeEmployees(tenantId, s.departmentIds)).filter((e) => !done.has(e.id));
  await notify({ tenantId, userIds: pending.map((e) => e.userId), kind: "ENGAGE", title: `Reminder: ${s.title} is waiting for your response`, link: `/engage/surveys/${s.id}`, email: true });
  await prisma.survey.update({ where: { id: s.id }, data: { lastReminderAt: new Date() } });
  await audit(tenantId, actorUserId, "Survey", s.id, "UPDATE", `Reminded ${pending.length} people about "${s.title}"`);
  return { ok: true, message: `Reminded ${pending.length} ${pending.length === 1 ? "person" : "people"}.`, reminded: pending.length };
}

type SeedQuestion = { prompt: string; type: "RATING" | "NPS" | "SINGLE_CHOICE" | "MULTI_CHOICE" | "TEXT"; driver?: string | null; options?: string[]; required?: boolean };

/** Run every recurring survey schedule that is due: create the run from the template and launch it. */
export async function runSurveySchedules(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.surveySchedule.findMany({ where: { tenantId, isActive: true, nextRunOn: { lte: now } } });
  let launched = 0;
  for (const sc of due) {
    const tpl = sc.templateId ? await prisma.surveyTemplate.findFirst({ where: { id: sc.templateId, tenantId } }) : null;
    const questions = ((tpl?.questions ?? null) as SeedQuestion[] | null) ?? [
      { prompt: "How are you feeling about work this week?", type: "RATING", driver: "Wellbeing" },
      { prompt: "How likely are you to recommend this organisation as a place to work?", type: "NPS" },
    ];
    // Advance first so a failure cannot launch the same run twice.
    const claimed = await prisma.surveySchedule.updateMany({ where: { id: sc.id, nextRunOn: sc.nextRunOn }, data: { nextRunOn: nextRunOn(now, sc.everyDays), lastRunAt: now, runs: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const survey = await prisma.survey.create({
      data: {
        tenantId, title: `${sc.title} — ${now.toISOString().slice(0, 10)}`, kind: (["PULSE", "ENPS", "ENGAGEMENT"].includes(sc.kind) ? sc.kind : "PULSE") as "PULSE",
        departmentIds: sc.departmentIds, closesAt: new Date(now.getTime() + sc.openDays * DAY), scheduleId: sc.id, onSignIn: sc.onSignIn,
        approvalStatus: "APPROVED", createdBy: sc.createdBy,
        questions: { create: questions.map((q, i) => ({ sequence: i + 1, prompt: q.prompt, type: q.type, driver: q.driver ?? null, options: q.options ?? [], required: q.required ?? q.type !== "TEXT" })) },
      },
    });
    if ((await launchSurvey(tenantId, survey.id, null)).ok) launched++;
  }
  return launched;
}

// ---------------------------------------------------------------------------
//  Announcements and events
// ---------------------------------------------------------------------------

/** Publish now, or schedule when publishAt is in the future; notify the audience on publication. */
export async function releaseAnnouncement(tenantId: string, id: string, actorUserId: string | null, now = new Date()): Promise<"PUBLISHED" | "SCHEDULED" | null> {
  const a = await prisma.announcement.findFirst({ where: { id, tenantId } });
  if (!a || !["DRAFT", "SCHEDULED"].includes(a.status)) return null;
  if (a.publishAt && a.publishAt > now) {
    await prisma.announcement.update({ where: { id }, data: { status: "SCHEDULED" } });
    await audit(tenantId, actorUserId, "Announcement", id, "UPDATE", `Scheduled "${a.title}" for ${a.publishAt.toISOString().slice(0, 16).replace("T", " ")}`);
    return "SCHEDULED";
  }
  await prisma.announcement.update({ where: { id }, data: { status: "PUBLISHED", publishAt: a.publishAt ?? now } });
  const people = await announcementAudience(tenantId, a.audience);
  await notify({
    tenantId, userIds: people.map((p) => p.userId), kind: a.isEmergency ? "EMERGENCY" : "ANNOUNCEMENT",
    title: a.isEmergency ? `Emergency: ${a.title}` : `Announcement: ${a.title}`, body: a.body.slice(0, 280), link: "/announcements",
    email: a.notifyByEmail || a.isEmergency, relatedType: "Announcement", relatedId: a.id,
  });
  await audit(tenantId, actorUserId, "Announcement", id, "UPDATE", `Published "${a.title}" to ${people.length} people`);
  return "PUBLISHED";
}

/** Remind people in the audience who have not acknowledged (or, without ack, not viewed). */
export async function remindAnnouncement(tenantId: string, id: string, actorUserId: string | null): Promise<{ ok: boolean; message: string; reminded: number }> {
  const a = await prisma.announcement.findFirst({ where: { id, tenantId }, include: { reads: { select: { employeeId: true, acknowledgedAt: true } } } });
  if (!a) return { ok: false, message: "Announcement not found.", reminded: 0 };
  if (a.status !== "PUBLISHED") return { ok: false, message: "Only a published announcement can be chased.", reminded: 0 };
  const done = new Set(a.reads.filter((r) => (a.requireAck ? !!r.acknowledgedAt : true)).map((r) => r.employeeId));
  const pending = (await announcementAudience(tenantId, a.audience)).filter((e) => !done.has(e.id));
  await notify({ tenantId, userIds: pending.map((e) => e.userId), kind: "ANNOUNCEMENT", title: `Reminder: please ${a.requireAck ? "read and acknowledge" : "read"} "${a.title}"`, link: "/announcements", email: true });
  await prisma.announcement.update({ where: { id }, data: { lastReminderAt: new Date() } });
  await audit(tenantId, actorUserId, "Announcement", id, "UPDATE", `Reminded ${pending.length} people about "${a.title}"`);
  return { ok: true, message: `Reminded ${pending.length} ${pending.length === 1 ? "person" : "people"}.`, reminded: pending.length };
}

/** Tell the event's audience it is on the calendar. */
export async function announceEvent(tenantId: string, eventId: string): Promise<void> {
  const e = await prisma.companyEvent.findFirst({ where: { id: eventId, tenantId } });
  if (!e) return;
  const people = await activeEmployees(tenantId, e.departmentIds);
  await notify({ tenantId, userIds: people.map((p) => p.userId), kind: "ENGAGE", title: `New event: ${e.title}`, body: `${e.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC${e.location ? ` · ${e.location}` : ""}`, link: `/engage/events/${e.id}` });
}

/** Move people up from the waitlist when places free up. */
export async function fillFromWaitlist(eventId: string): Promise<number> {
  const e = await prisma.companyEvent.findUnique({ where: { id: eventId }, include: { rsvps: true } });
  if (!e) return 0;
  const promote = promoteFromWaitlist(e.rsvps, e.capacity);
  for (const r of promote) await prisma.eventRsvp.update({ where: { id: r.id }, data: { response: "GOING" } });
  if (promote.length) {
    const users = await prisma.employee.findMany({ where: { id: { in: promote.map((r) => r.employeeId) }, tenantId: e.tenantId }, select: { userId: true } });
    await notify({ tenantId: e.tenantId, userIds: users.map((u) => u.userId), kind: "ENGAGE", title: `A place opened up: you are going to ${e.title}`, link: `/engage/events/${e.id}` });
  }
  return promote.length;
}

// ---------------------------------------------------------------------------
//  The nightly engage job
// ---------------------------------------------------------------------------

/**
 * Idempotent: scheduled pulses, automatic survey reminders, closing surveys
 * past their date, scheduled announcements and expiry, work-anniversary
 * points, overdue action plans, and ending programmes past their end date.
 */
/**
 * Retention: responses to surveys closed more than `days` ago are deleted
 * (answers cascade) and the survey is archived. Participation marks stay so
 * the response rate remains on record. Returns the number of surveys purged.
 */
export async function purgeSurveyData(tenantId: string, days: number, now = new Date()): Promise<number> {
  if (!days || days < 1) return 0;
  const cutoff = new Date(now.getTime() - days * DAY);
  const old = await prisma.survey.findMany({ where: { tenantId, status: "CLOSED", closedAt: { lt: cutoff }, responses: { some: {} } }, select: { id: true } });
  for (const sv of old) {
    await prisma.$transaction([
      prisma.surveyResponse.deleteMany({ where: { surveyId: sv.id } }),
      prisma.survey.update({ where: { id: sv.id }, data: { archivedAt: now } }),
    ]);
  }
  return old.length;
}

export async function runEngageJob(tenantId: string, now = new Date()) {
  const pulses = await runSurveySchedules(tenantId, now);

  let reminders = 0;
  const live = await prisma.survey.findMany({ where: { tenantId, status: "ACTIVE", reminderEveryDays: { not: null } } });
  for (const s of live) if (reminderDue({ everyDays: s.reminderEveryDays, launchedAt: s.launchedAt, lastReminderAt: s.lastReminderAt, now })) { await remindSurvey(tenantId, s.id, null); reminders++; }

  const expiredSurveys = await prisma.survey.updateMany({ where: { tenantId, status: "ACTIVE", closesAt: { lt: new Date(now.getTime() - DAY) } }, data: { status: "CLOSED", closedAt: now } });

  let published = 0;
  const due = await prisma.announcement.findMany({ where: { tenantId, status: "SCHEDULED", publishAt: { lte: now } }, select: { id: true } });
  for (const a of due) if ((await releaseAnnouncement(tenantId, a.id, null, now)) === "PUBLISHED") published++;
  const expired = await prisma.announcement.updateMany({ where: { tenantId, status: "PUBLISHED", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });

  let anniversaries = 0;
  const s = await engageSettings(tenantId);
  if (s.anniversaryPoints > 0) {
    const people = await prisma.employee.findMany({ where: { tenantId, status: { notIn: [...ACTIVE_STATUSES] } }, select: { id: true, userId: true, dateOfJoining: true } });
    for (const p of people) {
      const years = anniversaryYears(p.dateOfJoining, now);
      if (years < 1) continue;
      if (await creditPoints(tenantId, { employeeId: p.id, delta: years * s.anniversaryPoints, source: "ANNIVERSARY", sourceId: `${now.getUTCFullYear()}`, note: `${years} year${years === 1 ? "" : "s"} of service` })) {
        anniversaries++;
        await notify({ tenantId, userIds: [p.userId], kind: "ENGAGE", title: `Happy work anniversary! ${years * s.anniversaryPoints} reward points added`, link: "/engage/rewards" });
      }
    }
  }

  const overduePlans = await prisma.surveyActionPlan.findMany({ where: { tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueOn: { lt: now }, overdueNotifiedAt: null } });
  for (const p of overduePlans) {
    const owner = await prisma.employee.findFirst({ where: { id: p.ownerEmployeeId, tenantId }, select: { userId: true } });
    await notify({ tenantId, userIds: [owner?.userId], kind: "ENGAGE", title: `Action plan overdue: ${p.title}`, link: `/engage/surveys/${p.surveyId}` });
    await prisma.surveyActionPlan.update({ where: { id: p.id }, data: { overdueNotifiedAt: now } });
  }

  const endedPrograms = await prisma.recognitionProgram.updateMany({ where: { tenantId, status: "ACTIVE", endsOn: { lt: new Date(now.getTime() - DAY) } }, data: { status: "CLOSED" } });
  const endedWellness = await prisma.wellnessProgram.updateMany({ where: { tenantId, status: "ACTIVE", endsOn: { lt: new Date(now.getTime() - DAY) } }, data: { status: "CLOSED" } });

  const purgedSurveys = await purgeSurveyData(tenantId, s.surveyRetentionDays, now);

  return { pulses, reminders, closedSurveys: expiredSurveys.count, purgedSurveys, published, expired: expired.count, anniversaries, overduePlans: overduePlans.length, closedPrograms: endedPrograms.count + endedWellness.count };
}
