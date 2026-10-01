"use server";

import { prisma } from "@keka/db";
import {
  scheduleOneOnOne, busySlots as findBusySlots, notify,
  parseAgendaItems, parseMeetingSummary, RECURRENCES, type Recurrence, type MeetingSummaryShape,
} from "@keka/services";
import { requireViewer, type Viewer } from "@/lib/context";
import { writeAudit, actionDone as done, safeRevalidate, type ActionState } from "@/lib/forms";
import { aiForViewer, aiJson, AI_UNAVAILABLE, aiEnabled } from "@/lib/ai";
import { mayMeet, loadOneOnOne } from "@/app/(app)/performance/_parts/access";

/**
 * 1:1 meetings: scheduling, the shared workspace (agenda, talking points,
 * shared notes, action items), private notes, and the two AI helpers. Every
 * action re-reads the meeting and the viewer's place in it; nothing about who
 * may act is taken from the form.
 */

const LIST = "/performance/one-on-ones";
const MINE = "/me/performance";
const paths = (id?: string) => [LIST, MINE, "/meetings", ...(id ? [`${LIST}/${id}`] : [])];
const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function participantMeeting(viewer: Viewer, meetingId: string) {
  const r = await loadOneOnOne(viewer, meetingId);
  return r && r.access === "PARTICIPANT" ? r : null;
}

// ---------------------------------------------------------------------------
//  Scheduling
// ---------------------------------------------------------------------------

const timeOk = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const at = (date: string, time: string) => new Date(`${date}T${time}:00.000Z`);

export async function scheduleOneOnOneAction(_prev: ActionState, formData: FormData): Promise<ActionState & { meetingId?: string }> {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)]));
  if (!me) return { ok: false, message: "This login is not linked to an employee.", values };
  const employeeId = text(formData, "employeeId");
  const date = text(formData, "date");
  const start = text(formData, "startTime");
  const end = text(formData, "endTime");
  const title = text(formData, "title");
  const recurrence = (RECURRENCES as readonly string[]).includes(text(formData, "recurrence")) ? text(formData, "recurrence") as Recurrence : "NONE";
  const errors: Record<string, string> = {};
  if (!employeeId) errors.employeeId = "Choose who the 1:1 is with";
  if (!title) errors.title = "Required";
  else if (title.length > 160) errors.title = "Keep it under 160 characters";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(at(date, "00:00").getTime())) errors.date = "Pick a date";
  if (!timeOk(start)) errors.startTime = "Pick a start time";
  if (!timeOk(end)) errors.endTime = "Pick an end time";
  if (Object.keys(errors).length) return { ok: false, message: "Fix the highlighted fields.", errors, values };
  if (!(await mayMeet(viewer, employeeId))) return { ok: false, message: "You can hold 1:1s with people in your reporting line and with your own manager.", values };

  const optionalIds = [...new Set(formData.getAll("optionalIds").map(String).filter(Boolean))].slice(0, 8);
  if (optionalIds.length) {
    const found = await prisma.employee.count({ where: { tenantId: viewer.tenantId, id: { in: optionalIds }, status: { notIn: ["EXITED"] } } });
    if (found !== optionalIds.length) return { ok: false, message: "An optional participant was not found.", values };
  }
  const virtual = text(formData, "location") === "VIRTUAL";
  const meetingUrl = virtual ? text(formData, "meetingUrl") : "";
  if (virtual && !/^https:\/\/\S+$/.test(meetingUrl)) return { ok: false, message: "Add the https link for the call.", errors: { meetingUrl: "An https link" }, values };
  const roomId = !virtual ? text(formData, "roomId") || null : null;
  if (roomId && !(await prisma.meetingRoom.findFirst({ where: { id: roomId, tenantId: viewer.tenantId } }))) return { ok: false, message: "That room was not found.", values };
  const templateId = text(formData, "templateId") || null;
  if (templateId && !(await prisma.meetingAgendaTemplate.findFirst({ where: { id: templateId, tenantId: viewer.tenantId } }))) return { ok: false, message: "That agenda template was not found.", values };
  const purpose = text(formData, "purpose").slice(0, 120) || null;
  const agenda = text(formData, "agenda").slice(0, 4000) || null;

  const startsAt = at(date, start), endsAt = at(date, end);
  const r = await scheduleOneOnOne({
    tenantId: viewer.tenantId, organiserId: me, employeeId, optionalIds, title, startsAt, endsAt,
    roomId, meetingUrl: meetingUrl || null, purpose, agenda, templateId, recurrence,
  });
  if (!r.ok) return { ok: false, message: r.message, values };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Meeting", entityId: r.meetingIds![0], summary: `Scheduled a 1:1: ${title}${recurrence !== "NONE" ? ` (${recurrence.toLowerCase()})` : ""}` });
  safeRevalidate(...paths());
  return { ok: true, message: r.message, meetingId: r.meetingIds![0] };
}

/** Busy blocks for the viewer and the other person on a day ("Check available timeslots"). */
export async function busySlotsAction(input: { employeeId: string; date: string }): Promise<{ ok: boolean; message?: string; slots?: Array<{ who: string; from: string; to: string; label: string }> }> {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  if (!me || !(await mayMeet(viewer, String(input.employeeId)))) return { ok: false, message: "Pick someone you can meet first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) return { ok: false, message: "Pick a date first." };
  const slots = await findBusySlots(viewer.tenantId, [me, input.employeeId], new Date(`${input.date}T00:00:00Z`));
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  return { ok: true, slots: slots.map((s) => ({ who: s.employeeId === me ? "You" : "Them", from: s.label === "On leave" ? "All day" : hm(s.start), to: s.label === "On leave" ? "" : hm(s.end), label: s.label })) };
}

// ---------------------------------------------------------------------------
//  Agenda templates and the AI agenda
// ---------------------------------------------------------------------------

export async function saveAgendaTemplateAction(input: { name: string; purpose?: string; items: string }): Promise<{ ok: boolean; message: string; id?: string }> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "This login is not linked to an employee." };
  const name = String(input.name ?? "").trim().slice(0, 80);
  const items = String(input.items ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20).join("\n");
  if (!name) return { ok: false, message: "Name the template." };
  if (!items) return { ok: false, message: "Write the agenda first." };
  if (await prisma.meetingAgendaTemplate.findFirst({ where: { tenantId: viewer.tenantId, name } })) return { ok: false, message: "A template with that name already exists." };
  const t = await prisma.meetingAgendaTemplate.create({ data: { tenantId: viewer.tenantId, name, purpose: String(input.purpose ?? "").trim().slice(0, 120) || null, items, createdById: viewer.employee.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "MeetingAgendaTemplate", entityId: t.id, summary: `Saved agenda template ${name}` });
  safeRevalidate(LIST);
  return { ok: true, message: "Saved as a template.", id: t.id };
}

export async function deleteAgendaTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await prisma.meetingAgendaTemplate.findFirst({ where: { id: text(formData, "id"), tenantId: viewer.tenantId } });
  if (!t) return { ok: false, message: "Template not found." };
  if (t.isSystem || t.createdById !== viewer.employee?.id) return { ok: false, message: "Only the person who saved a template can delete it; system templates stay." };
  await prisma.meetingAgendaTemplate.delete({ where: { id: t.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "MeetingAgendaTemplate", entityId: t.id, summary: `Deleted agenda template ${t.name}` });
  return done([LIST], "Template deleted.");
}

/**
 * "Generate using AI": an agenda for a 1:1 from its purpose. Sent: the
 * purpose, how often it repeats, the other person's job title, the titles and
 * health of their open goals, and open action items carried from earlier
 * 1:1s of this pair. Never names, ratings, pay or notes.
 */
export async function generateAgendaAction(input: { purpose: string; employeeId: string; recurrence?: string }): Promise<{ ok: boolean; message?: string; items?: string[] }> {
  const viewer = await requireViewer();
  if (!aiEnabled()) return { ok: false, message: AI_UNAVAILABLE };
  const purpose = String(input.purpose ?? "").trim().slice(0, 120);
  if (!purpose) return { ok: false, message: "Enter the purpose of the meeting first." };
  const other = String(input.employeeId ?? "");
  if (!(await mayMeet(viewer, other))) return { ok: false, message: "Choose who the 1:1 is with first." };
  const me = viewer.employee!.id;
  const report = viewer.allReportIds.has(other) ? other : me;
  const [person, goals, open] = await Promise.all([
    prisma.employee.findUnique({ where: { id: other }, select: { jobTitleName: true } }),
    prisma.goal.findMany({ where: { tenantId: viewer.tenantId, employeeId: report, status: { in: ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"] } }, select: { title: true, status: true }, take: 5, orderBy: { dueDate: "asc" } }),
    prisma.meetingActionItem.findMany({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] }, meeting: { tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE", AND: [{ attendees: { some: { employeeId: me } } }, { attendees: { some: { employeeId: other } } }] } },
      select: { description: true }, take: 5, orderBy: { createdAt: "desc" },
    }),
  ]);
  const prompt = [
    `Purpose: ${purpose}`,
    `Repeats: ${String(input.recurrence ?? "NONE").toLowerCase()}`,
    `The ${report === other ? "report" : "manager"}'s job title: ${person?.jobTitleName ?? "not given"}`,
    goals.length ? `The report's open goals:\n${goals.map((g) => `- ${g.title} (${g.status.replace(/_/g, " ").toLowerCase()})`).join("\n")}` : "The report has no open goals recorded.",
    open.length ? `Open action items from earlier 1:1s:\n${open.map((a) => `- ${a.description}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const r = await aiForViewer(viewer, { feature: "MEETING_AGENDA", subjectId: other, inputChars: prompt.length }, () => aiJson({
    system: "You help a manager and their direct report prepare a 1:1 meeting. Write a short, practical agenda: 4 to 7 items, each under 140 characters, in plain English, specific to the purpose and the context given. Return a JSON array of strings.",
    prompt, maxTokens: 600, validate: parseAgendaItems,
  }));
  return r.ok ? { ok: true, items: r.value } : { ok: false, message: r.reason };
}

// ---------------------------------------------------------------------------
//  The 1:1 workspace
// ---------------------------------------------------------------------------

export async function saveAgendaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  const agenda = text(formData, "agenda");
  if (agenda.length > 4000) return { ok: false, message: "Keep the agenda under 4,000 characters." };
  await prisma.meeting.update({ where: { id: r.meeting.id }, data: { agenda: agenda || null, purpose: text(formData, "purpose").slice(0, 120) || r.meeting.purpose } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Meeting", entityId: r.meeting.id, summary: "Updated a 1:1 agenda" });
  return done(paths(r.meeting.id), "Agenda saved.");
}

export async function addTalkingPointAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  const t = text(formData, "text");
  if (!t) return { ok: false, message: "Write the talking point.", errors: { text: "Required" } };
  if (t.length > 300) return { ok: false, message: "Keep it under 300 characters.", errors: { text: "Too long" } };
  const count = await prisma.meetingTalkingPoint.count({ where: { meetingId: r.meeting.id } });
  if (count >= 30) return { ok: false, message: "A 1:1 can hold 30 talking points." };
  const tp = await prisma.meetingTalkingPoint.create({ data: { meetingId: r.meeting.id, authorId: viewer.employee!.id, text: t, displayOrder: count } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "MeetingTalkingPoint", entityId: tp.id, summary: "Added a 1:1 talking point" });
  return done(paths(r.meeting.id), "Added.");
}

export async function toggleTalkingPointAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const tp = await prisma.meetingTalkingPoint.findUnique({ where: { id: text(formData, "id") } });
  const r = tp ? await participantMeeting(viewer, tp.meetingId) : null;
  if (!tp || !r) return { ok: false, message: "Talking point not found." };
  if (text(formData, "op") === "delete") {
    if (tp.authorId !== viewer.employee!.id) return { ok: false, message: "Only the person who added it can remove it." };
    await prisma.meetingTalkingPoint.delete({ where: { id: tp.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "MeetingTalkingPoint", entityId: tp.id, summary: "Removed a 1:1 talking point" });
    return done(paths(tp.meetingId), "Removed.");
  }
  await prisma.meetingTalkingPoint.update({ where: { id: tp.id }, data: { isDone: !tp.isDone } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "MeetingTalkingPoint", entityId: tp.id, summary: `Marked a talking point ${tp.isDone ? "open" : "discussed"}` });
  return done(paths(tp.meetingId), tp.isDone ? "Reopened." : "Discussed.");
}

export async function saveSharedNotesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  const notes = String(formData.get("minutes") ?? "").trim();
  if (notes.length > 10000) return { ok: false, message: "Keep shared notes under 10,000 characters." };
  await prisma.meeting.update({ where: { id: r.meeting.id }, data: { minutes: notes || null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Meeting", entityId: r.meeting.id, summary: "Updated 1:1 shared notes" });
  return done(paths(r.meeting.id), "Shared notes saved.");
}

/** A private note is the author's alone: one per person per meeting. */
export async function savePrivateNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  const body = String(formData.get("body") ?? "").trim();
  if (body.length > 10000) return { ok: false, message: "Keep private notes under 10,000 characters." };
  const me = viewer.employee!.id;
  if (!body) await prisma.meetingPrivateNote.deleteMany({ where: { meetingId: r.meeting.id, authorId: me } });
  else await prisma.meetingPrivateNote.upsert({ where: { meetingId_authorId: { meetingId: r.meeting.id, authorId: me } }, create: { meetingId: r.meeting.id, authorId: me, body }, update: { body } });
  // The audit row records that a note changed, never what it says.
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "MeetingPrivateNote", entityId: r.meeting.id, summary: "Updated a private 1:1 note" });
  return done([`${LIST}/${r.meeting.id}`], "Private note saved. Only you can see it.");
}

export async function addOneOnOneActionItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  const description = text(formData, "description");
  if (!description) return { ok: false, message: "Describe the action item.", errors: { description: "Required" } };
  if (description.length > 300) return { ok: false, message: "Keep it under 300 characters.", errors: { description: "Too long" } };
  const ownerId = text(formData, "ownerId") || viewer.employee!.id;
  const people = new Set([r.meeting.organiserId, ...r.meeting.attendees.map((a) => a.employeeId)]);
  if (!people.has(ownerId)) return { ok: false, message: "The owner must be someone in this 1:1." };
  const due = text(formData, "dueDate");
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T00:00:00Z`) : null;
  const item = await prisma.meetingActionItem.create({ data: { meetingId: r.meeting.id, description, ownerId, dueDate } });
  if (ownerId !== viewer.employee!.id) {
    const owner = await prisma.employee.findUnique({ where: { id: ownerId }, select: { userId: true } });
    await notify({ tenantId: viewer.tenantId, userIds: [owner?.userId], kind: "PERFORMANCE", title: "New action item from your 1:1", body: description, link: `${LIST}/${r.meeting.id}` });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "MeetingActionItem", entityId: item.id, summary: `Added a 1:1 action item: ${description.slice(0, 80)}` });
  return done(paths(r.meeting.id), "Action item added.");
}

/** Tick an action item done (or reopen it): its owner or anyone in the 1:1 it came from. */
export async function toggleOneOnOneActionItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const item = await prisma.meetingActionItem.findUnique({ where: { id: text(formData, "id") }, select: { id: true, status: true, ownerId: true, meetingId: true, meeting: { select: { tenantId: true, meetingType: true } } } });
  if (!item || item.meeting.tenantId !== viewer.tenantId || item.meeting.meetingType !== "ONE_ON_ONE") return { ok: false, message: "Action item not found." };
  const r = await participantMeeting(viewer, item.meetingId);
  if (!r && item.ownerId !== viewer.employee?.id) return { ok: false, message: "Action item not found." };
  const reopen = item.status === "DONE";
  await prisma.meetingActionItem.update({ where: { id: item.id }, data: reopen ? { status: "OPEN", completedAt: null } : { status: "DONE", completedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "MeetingActionItem", entityId: item.id, summary: reopen ? "Reopened a 1:1 action item" : "Completed a 1:1 action item" });
  safeRevalidate(...paths(item.meetingId));
  const viewing = text(formData, "viewing");
  if (viewing && viewing !== item.meetingId) safeRevalidate(`${LIST}/${viewing}`);
  return { ok: true, message: reopen ? "Reopened." : "Done." };
}

export async function completeOneOnOneAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  if (r.meeting.status === "CANCELLED") return { ok: false, message: "A cancelled meeting cannot be completed." };
  if (r.meeting.status === "COMPLETED") return { ok: false, message: "Already completed." };
  if (r.meeting.startsAt.getTime() > Date.now()) return { ok: false, message: "A 1:1 can be marked completed once it has started." };
  await prisma.meeting.update({ where: { id: r.meeting.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await prisma.meetingAttendee.updateMany({ where: { meetingId: r.meeting.id, attendance: "REQUIRED" }, data: { attended: true } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Meeting", entityId: r.meeting.id, summary: `Completed 1:1 ${r.meeting.title}` });
  return done(paths(r.meeting.id), "Marked as completed.");
}

export async function cancelOneOnOneAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, text(formData, "meetingId"));
  if (!r) return { ok: false, message: "Meeting not found." };
  if (r.meeting.organiserId !== viewer.employee!.id) return { ok: false, message: "Only the person who scheduled it can cancel it." };
  if (r.meeting.status !== "SCHEDULED") return { ok: false, message: "Only a scheduled meeting can be cancelled." };
  const series = text(formData, "scope") === "series" && r.meeting.seriesId;
  const where = series
    ? { tenantId: viewer.tenantId, seriesId: r.meeting.seriesId!, status: "SCHEDULED" as const, startsAt: { gte: r.meeting.startsAt } }
    : { id: r.meeting.id };
  const n = await prisma.meeting.updateMany({ where, data: { status: "CANCELLED" } });
  const others = await prisma.employee.findMany({ where: { id: { in: r.meeting.attendees.map((a) => a.employeeId).filter((id) => id !== viewer.employee!.id) } }, select: { userId: true } });
  await notify({ tenantId: viewer.tenantId, userIds: others.map((o) => o.userId), kind: "PERFORMANCE", title: `1:1 cancelled: ${r.meeting.title}`, body: series ? `${n.count} upcoming meetings in the series were cancelled.` : r.meeting.startsAt.toISOString().slice(0, 16).replace("T", " "), link: LIST });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Meeting", entityId: r.meeting.id, summary: `Cancelled ${n.count} 1:1 meeting(s): ${r.meeting.title}` });
  return done(paths(r.meeting.id), n.count > 1 ? `${n.count} meetings cancelled.` : "Meeting cancelled.");
}

// ---------------------------------------------------------------------------
//  AI summary
// ---------------------------------------------------------------------------

/**
 * "Summarise with AI". Sent: the purpose, agenda lines, talking points, the
 * shared notes and the action items — with the two people as "Manager" and
 * "Report". Private notes are never read here. Nothing is saved until a
 * participant chooses to keep the result.
 */
export async function summariseOneOnOneAction(input: { meetingId: string }): Promise<{ ok: boolean; message?: string; summary?: MeetingSummaryShape }> {
  const viewer = await requireViewer();
  if (!aiEnabled()) return { ok: false, message: AI_UNAVAILABLE };
  const r = await participantMeeting(viewer, String(input.meetingId ?? ""));
  if (!r) return { ok: false, message: "Meeting not found." };
  if (r.meeting.startsAt.getTime() > Date.now()) return { ok: false, message: "Summaries are for 1:1s that have taken place." };
  const [points, items] = await Promise.all([
    prisma.meetingTalkingPoint.findMany({ where: { meetingId: r.meeting.id }, orderBy: { displayOrder: "asc" }, select: { text: true, isDone: true } }),
    prisma.meetingActionItem.findMany({ where: { meetingId: r.meeting.id }, select: { description: true, status: true } }),
  ]);
  if (!r.meeting.minutes?.trim() && points.length === 0) return { ok: false, message: "Add talking points or shared notes first — there is nothing to summarise yet." };
  const prompt = [
    `Purpose: ${r.meeting.purpose ?? "not given"}`,
    r.meeting.agenda ? `Agenda:\n${r.meeting.agenda.split("\n").map((l) => `- ${l.replace(/^[-•*]\s*/, "")}`).join("\n")}` : "",
    points.length ? `Talking points:\n${points.map((p) => `- ${p.text}${p.isDone ? " (discussed)" : ""}`).join("\n")}` : "",
    r.meeting.minutes ? `Shared notes:\n${r.meeting.minutes.slice(0, 6000)}` : "",
    items.length ? `Action items already recorded:\n${items.map((a) => `- ${a.description} (${a.status.toLowerCase()})`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const res = await aiForViewer(viewer, { feature: "MEETING_SUMMARY", subjectId: r.meeting.id, inputChars: prompt.length }, () => aiJson({
    system: "You summarise a 1:1 meeting between a manager and their direct report, for both of them. Be factual and brief; use only what is in the material. Return JSON: {\"summary\": string (under 600 characters), \"decisions\": string[] (at most 5), \"actionItems\": [{\"description\": string, \"owner\": \"MANAGER\" | \"REPORT\", \"dueInDays\": number | null}] (at most 6, only new ones not already recorded)}.",
    prompt, maxTokens: 1200, validate: parseMeetingSummary,
  }));
  return res.ok ? { ok: true, summary: res.value } : { ok: false, message: res.reason };
}

/** Keep an AI summary on the meeting — re-validated, since it comes back from the browser. */
export async function saveOneOnOneSummaryAction(input: { meetingId: string; summary: unknown }): Promise<{ ok: boolean; message: string }> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, String(input.meetingId ?? ""));
  if (!r) return { ok: false, message: "Meeting not found." };
  const s = parseMeetingSummary(input.summary);
  if (!s) return { ok: false, message: "That summary is not in the expected shape." };
  await prisma.meeting.update({ where: { id: r.meeting.id }, data: { aiSummary: { summary: s.summary, decisions: s.decisions }, aiSummaryAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Meeting", entityId: r.meeting.id, summary: "Saved an AI summary to a 1:1" });
  safeRevalidate(`${LIST}/${r.meeting.id}`);
  return { ok: true, message: "Summary saved to the meeting." };
}

/** Add one suggested action item: "MANAGER"/"REPORT" become the real people here, on the server. */
export async function addSuggestedActionAction(input: { meetingId: string; description: string; owner: string; dueInDays: number | null }): Promise<{ ok: boolean; message: string }> {
  const viewer = await requireViewer();
  const r = await participantMeeting(viewer, String(input.meetingId ?? ""));
  if (!r || !r.pair) return { ok: false, message: "Meeting not found." };
  const description = String(input.description ?? "").trim().slice(0, 300);
  if (!description) return { ok: false, message: "Nothing to add." };
  const [a, b] = r.pair;
  // The manager is whichever of the two the other reports to (directly or not).
  const aManagesB = (await prisma.employee.findUnique({ where: { id: b }, select: { reportingManagerId: true } }))?.reportingManagerId === a;
  const manager = aManagesB ? a : b, report = aManagesB ? b : a;
  const ownerId = input.owner === "REPORT" ? report : manager;
  const days = Number(input.dueInDays);
  const dueDate = Number.isInteger(days) && days >= 1 && days <= 60 ? new Date(Date.now() + days * 86_400_000) : null;
  const item = await prisma.meetingActionItem.create({ data: { meetingId: r.meeting.id, description, ownerId, dueDate: dueDate ? new Date(dueDate.toISOString().slice(0, 10) + "T00:00:00Z") : null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "MeetingActionItem", entityId: item.id, summary: `Added a suggested 1:1 action item: ${description.slice(0, 80)}` });
  safeRevalidate(...paths(r.meeting.id));
  return { ok: true, message: "Added." };
}
