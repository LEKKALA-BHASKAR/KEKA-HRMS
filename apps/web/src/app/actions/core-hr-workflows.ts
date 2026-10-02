"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  notificationEvent, cleanEmails, invalidEmails, RECIPIENT_GROUPS, nextReportRun,
  ensureExitSurvey, submitExitSurvey, type SubmittedAnswer,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { REPORTS } from "@/lib/reports";
import { savedReportFor } from "@/lib/report-builder";
import { z, parseForm, formList, writeAudit, actionDone as done, toErrorState, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Core HR workflow settings and self-service: email notification settings,
 * the exit survey, and scheduling standard or custom reports by email.
 */

// ---------------------------------------------------------------------------
//  Notification settings (Admin › Settings › Notifications)
// ---------------------------------------------------------------------------

export async function saveNotificationSettingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const event = notificationEvent(String(formData.get("event") ?? ""));
  if (!event) return { ok: false, message: "Unknown notification event." };
  const emailEnabled = formData.get("emailEnabled") === "on";
  const recipients = event.configurable ? formList(formData, "recipients").filter((r) => (RECIPIENT_GROUPS as string[]).includes(r)) : event.defaults;
  const typed = String(formData.get("customEmails") ?? "");
  const bad = invalidEmails(typed);
  if (bad.length) return { ok: false, message: `Not an email address: ${bad.join(", ")}`, errors: { customEmails: "Check the addresses" } };
  const customEmails = cleanEmails(typed);
  if (customEmails.length > 10) return { ok: false, message: "Up to 10 custom addresses.", errors: { customEmails: "Too many" } };
  if (emailEnabled && event.configurable && recipients.length === 0 && customEmails.length === 0 && event.defaults.length > 0) {
    return { ok: false, message: "Choose at least one recipient, or switch the email off.", errors: { recipients: "Required" } };
  }
  const before = await prisma.notificationSetting.findUnique({ where: { tenantId_event: { tenantId: viewer.tenantId, event: event.key } } });
  const data = { emailEnabled, recipients, customEmails, updatedBy: viewer.user.id };
  await prisma.notificationSetting.upsert({
    where: { tenantId_event: { tenantId: viewer.tenantId, event: event.key } },
    create: { tenantId: viewer.tenantId, event: event.key, ...data },
    update: data,
  });
  await writeAudit(viewer, {
    module: "SYSTEM", action: "UPDATE", entityType: "NotificationSetting", entityId: event.key,
    summary: `${emailEnabled ? "Email on" : "Email off"} for “${event.label}”${emailEnabled ? ` → ${[...recipients.map((r) => r.toLowerCase()), ...customEmails].join(", ") || "default recipients"}` : ""}`,
    oldValue: before ? { emailEnabled: before.emailEnabled, recipients: before.recipients, customEmails: before.customEmails } : null,
    newValue: { emailEnabled, recipients, customEmails },
  });
  return done(["/admin/settings"], "Saved.");
}

export async function resetNotificationSettingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const event = notificationEvent(String(formData.get("event") ?? ""));
  if (!event) return { ok: false, message: "Unknown notification event." };
  const removed = await prisma.notificationSetting.deleteMany({ where: { tenantId: viewer.tenantId, event: event.key } });
  if (removed.count) {
    await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "NotificationSetting", entityId: event.key, summary: `Reset “${event.label}” to its default recipients` });
  }
  return done(["/admin/settings"], "Back to the default.");
}

// ---------------------------------------------------------------------------
//  Exit survey
// ---------------------------------------------------------------------------

/** Create the organisation's exit survey from the standard questions. */
export async function setupExitSurveyAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const { survey, created } = await ensureExitSurvey(viewer.tenantId, viewer.user.id);
  if (created) {
    await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "Survey", entityId: survey.id, summary: "Set up the exit survey" });
  }
  return done(["/exits", "/exits/survey", "/me/exit"], created ? "Exit survey set up. Everyone leaving is asked to complete it on their My exit page." : "The exit survey is already set up.");
}

/** A leaving employee answers the exit survey on /me/exit. */
export async function submitExitSurveyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can respond." };
  const exit = await prisma.exitRecord.findUnique({ where: { employeeId: viewer.employee.id }, select: { id: true } });
  if (!exit || exit.id !== String(formData.get("exitId") ?? "")) return { ok: false, message: "That exit was not found." };
  const keys = [...new Set([...formData.keys()].filter((k) => k.startsWith("q_")))];
  const types = new Map(
    (await prisma.surveyQuestion.findMany({ where: { id: { in: keys.map((k) => k.slice(2)) } }, select: { id: true, type: true } })).map((q) => [q.id, q.type]),
  );
  const answers: SubmittedAnswer[] = keys.map((key) => {
    const id = key.slice(2);
    const type = types.get(id);
    if (type === "RATING" || type === "NPS") {
      const v = String(formData.get(key) ?? "");
      return { questionId: id, score: v === "" ? null : Number(v) };
    }
    if (type === "SINGLE_CHOICE" || type === "MULTI_CHOICE") return { questionId: id, choices: formList(formData, key).map(Number).filter((n) => Number.isInteger(n)) };
    return { questionId: id, text: String(formData.get(key) ?? "") };
  });
  try {
    const res = await submitExitSurvey({ exitId: exit.id, employeeId: viewer.employee.id, answers });
    if (!res.ok) {
      return { ok: false, message: res.message, errors: res.errors ? Object.fromEntries(Object.entries(res.errors).map(([k, m]) => [`q_${k}`, m])) : undefined };
    }
    // Record which survey this exit answered, so later changes to the default do not re-ask.
    const response = await prisma.surveyResponse.findUniqueOrThrow({ where: { id: res.responseId }, select: { surveyId: true } });
    await prisma.exitRecord.update({ where: { id: exit.id }, data: { exitSurveyId: response.surveyId } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "ExitSurveyResponse", entityId: exit.id, summary: `${viewer.employee.employeeNumber} completed the exit survey` });
    return done(["/me/exit", `/exits/${exit.id}`, "/exits/survey"], "Thank you — your answers have been shared with HR.");
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  Scheduled report delivery (standard and custom reports)
// ---------------------------------------------------------------------------

const scheduleSchema = z.object({
  reportKey: z.string().trim().min(1),
  name: z.string().trim().min(2, "Name the schedule.").max(80),
  recipients: z.string().trim().min(3, "Add at least one recipient."),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  dayOfWeek: z.coerce.number().int().min(0).max(7).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
});

/**
 * Email a standard report (/reports) or a saved custom report on a cadence.
 * The report runs as the person scheduling it, so they may only schedule
 * what they can open themselves.
 */
export async function scheduleReportAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REPORT_VIEW);
  const parsed = parseForm(scheduleSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.reportKey.startsWith("saved:")) {
    if (!(await savedReportFor(viewer, d.reportKey.slice(6)))) return { ok: false, message: "That saved report was not found." };
  } else {
    const report = REPORTS.find((r) => r.key === d.reportKey);
    if (!report || !can(viewer, report.permission)) return { ok: false, message: "Choose a report you can open." };
  }
  const bad = invalidEmails(d.recipients);
  if (bad.length) return { ok: false, message: `Not an email address: ${bad.join(", ")}`, errors: { recipients: "Check the addresses." } };
  const emails = cleanEmails(d.recipients);
  if (emails.length === 0) return { ok: false, message: "Add at least one recipient.", errors: { recipients: "Required" } };
  if (emails.length > 10) return { ok: false, message: "Up to 10 recipients.", errors: { recipients: "Too many." } };
  const dayOfWeek = d.frequency === "WEEKLY" ? (d.dayOfWeek ?? 1) : null;
  const dayOfMonth = d.frequency === "MONTHLY" ? (d.dayOfMonth ?? 1) : null;
  const s = await prisma.scheduledReport.create({
    data: {
      tenantId: viewer.tenantId, reportKey: d.reportKey, name: d.name, recipients: emails, frequency: d.frequency, dayOfWeek, dayOfMonth,
      nextRunAt: nextReportRun(d.frequency, dayOfWeek, dayOfMonth), createdBy: viewer.user.id,
    },
  });
  await writeAudit(viewer, { module: "REPORT", action: "CREATE", entityType: "ScheduledReport", entityId: s.id, summary: `Scheduled ${d.name} (${d.frequency.toLowerCase()}) to ${emails.length} recipient(s)` });
  return done(["/reports", "/reports/builder"], `Scheduled. The first email goes out ${s.nextRunAt.toISOString().slice(0, 10)}.`);
}

/** Stop a schedule: its owner, or an administrator. Asset schedules are managed under Assets. */
export async function deleteScheduledReportAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.REPORT_VIEW);
  const s = await prisma.scheduledReport.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, NOT: { reportKey: { startsWith: "asset-" } } } });
  if (!s) return { ok: false, message: "Schedule not found." };
  if (s.createdBy !== viewer.user.id && !can(viewer, P.ORG_SETTINGS_MANAGE)) return { ok: false, message: "Only the person who scheduled it, or an administrator, can stop it." };
  await prisma.scheduledReport.delete({ where: { id: s.id } });
  await writeAudit(viewer, { module: "REPORT", action: "DELETE", entityType: "ScheduledReport", entityId: s.id, summary: `Stopped the schedule ${s.name}` });
  return done(["/reports", "/reports/builder"], "Schedule stopped.");
}
