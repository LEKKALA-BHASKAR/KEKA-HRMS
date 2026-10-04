"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, engageSettings, releaseAnnouncement, remindAnnouncement, rsvpOutcome, fillFromWaitlist, announceEvent, notify, usersWithPermission,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import { formList, writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Corporate communication & collaboration: announcements (audience,
 * schedule, approval, acknowledgement chasing, translations, emergency
 * broadcast, archive), discussion channels and groups with moderation,
 * content reports, and the company events calendar with RSVP, waitlist,
 * attendance and town-hall questions.
 */

const P = PERMISSIONS;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
/** datetime-local (IST wall clock) → instant. */
const when = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? new Date(`${v}:00+05:30`) : null);
const A = "/announcements";
const C = "/engage/communities";
const E = "/engage/events";

// ---------------------------------------------------------------------------
//  Announcements
// ---------------------------------------------------------------------------

const LANGS = ["hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "fr", "de", "es", "ar"];

export async function saveAnnouncementAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title");
  const body = str(f, "body");
  const intent = str(f, "intent") || "draft";
  const isEmergency = f.get("isEmergency") === "on";
  const publishAt = when(str(f, "publishAt"));
  const expiresAt = day(str(f, "expiresAt"));
  const values = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
  const errors: Record<string, string> = {};
  if (!title) errors.title = "Required";
  if (title.length > 200) errors.title = "Keep it under 200 characters";
  if (!body) errors.body = "Required";
  if (str(f, "publishAt") && !publishAt) errors.publishAt = "Use a valid date and time";
  if (expiresAt && expiresAt.getTime() < Date.now() - 86_400_000) errors.expiresAt = "In the past";
  if (publishAt && expiresAt && expiresAt < publishAt) errors.expiresAt = "Before it publishes";
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors, values };
  const audience = { departmentIds: formList(f, "departmentIds"), locationIds: formList(f, "locationIds"), businessUnitIds: formList(f, "businessUnitIds"), excludeOnNotice: f.get("excludeOnNotice") === "on" };
  const foreign = await foreignReference(viewer.tenantId, { department: audience.departmentIds, location: audience.locationIds, businessUnit: audience.businessUnitIds });
  if (foreign) return { ok: false, message: foreign, values };
  const lang = str(f, "lang");
  const translations: Record<string, { title: string; body: string }> = {};
  if (lang) {
    if (!LANGS.includes(lang)) return { ok: false, message: "Pick a language.", values };
    if (!str(f, "langTitle") || !str(f, "langBody")) return { ok: false, message: "Give the translated title and body.", errors: { langTitle: "Required" }, values };
    translations[lang] = { title: str(f, "langTitle"), body: str(f, "langBody") };
  }
  const empty = !audience.departmentIds.length && !audience.locationIds.length && !audience.businessUnitIds.length && !audience.excludeOnNotice;
  const data = {
    title, body, category: str(f, "category") || "GENERAL", audience: empty ? undefined : (audience as Prisma.InputJsonValue),
    publishAt: isEmergency ? null : publishAt, expiresAt, requireAck: f.get("requireAck") === "on", isPinned: isEmergency || f.get("isPinned") === "on",
    notifyByEmail: isEmergency || f.get("notifyByEmail") === "on", isEmergency,
  };
  let annId = id;
  if (id) {
    const a = await prisma.announcement.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!a) return { ok: false, message: "Announcement not found.", values };
    if (a.approvalStatus === "PENDING") return { ok: false, message: "It is waiting for approval; withdraw the request to edit it.", values };
    if (["ARCHIVED", "EXPIRED"].includes(a.status)) return { ok: false, message: "Archived announcements cannot be edited.", values };
    const merged = { ...((a.translations ?? {}) as Record<string, unknown>), ...translations };
    await prisma.announcement.update({ where: { id }, data: { ...data, audience: empty ? Prisma.DbNull : data.audience, translations: Object.keys(merged).length ? (merged as Prisma.InputJsonValue) : undefined, ...(a.status === "PUBLISHED" ? {} : { status: "DRAFT", approvalStatus: a.approvalStatus === "APPROVED" ? null : a.approvalStatus }) } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Announcement", entityId: id, summary: `Edited announcement "${title}"`, oldValue: { title: a.title, body: a.body.slice(0, 500), audience: a.audience }, newValue: { title, body: body.slice(0, 500), audience } });
    if (a.status === "PUBLISHED") return done([A, "/"], "Saved. The published announcement is updated.");
  } else {
    const created = await prisma.announcement.create({ data: { ...data, tenantId: viewer.tenantId, status: "DRAFT", translations: Object.keys(translations).length ? translations : undefined, createdBy: viewer.employee?.id ?? null } });
    annId = created.id;
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Announcement", entityId: annId, summary: `${isEmergency ? "Emergency broadcast" : "Drafted announcement"} "${title}"` });
  }
  if (intent === "draft" && !isEmergency) return { ...done([A], "Saved as a draft."), values: { announcementId: annId } };
  const res = await publishOrSubmit(viewer, annId);
  return { ...res, values: { announcementId: annId } };
}

async function publishOrSubmit(viewer: Viewer, id: string): Promise<ActionState> {
  const a = await prisma.announcement.findFirstOrThrow({ where: { id, tenantId: viewer.tenantId } });
  const needsApproval = !a.isEmergency && (await engageSettings(viewer.tenantId)).announcementApproval && a.approvalStatus !== "APPROVED";
  if (needsApproval) {
    if (a.approvalStatus === "PENDING") return { ok: false, message: "It is already waiting for approval." };
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ANNOUNCEMENT_PUBLISH", entityId: a.id, title: `Publish announcement: ${a.title}`, details: a.body.slice(0, 500), category: a.category, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) return { ok: false, message: wf.message };
    const after = await prisma.announcement.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } });
    await prisma.announcement.update({ where: { id: a.id }, data: { workflowRequestId: wf.requestId, ...(after.status === "DRAFT" ? { approvalStatus: "PENDING" } : {}) } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Announcement", entityId: a.id, summary: `Submitted "${a.title}" for approval` });
    return done([A], after.status === "DRAFT" ? "Submitted for approval. It publishes when approved." : "Approved automatically.");
  }
  const outcome = await releaseAnnouncement(viewer.tenantId, a.id, viewer.user.id);
  if (!outcome) return { ok: false, message: "Only a draft or scheduled announcement can be published." };
  return done([A, "/"], outcome === "SCHEDULED" ? "Scheduled." : a.isEmergency ? "Emergency broadcast sent to everyone." : "Published.");
}

export async function announcementOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const a = await prisma.announcement.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Announcement not found." };
  const op = str(f, "op");
  if (op === "publish") return publishOrSubmit(viewer, a.id);
  if (op === "remind") {
    const r = await remindAnnouncement(viewer.tenantId, a.id, viewer.user.id);
    return r.ok ? done([A], r.message) : { ok: false, message: r.message };
  }
  if (op === "archive" || op === "unarchive") {
    if (op === "archive" && !["PUBLISHED", "EXPIRED", "SCHEDULED"].includes(a.status)) return { ok: false, message: "Only a published or scheduled announcement can be archived." };
    if (op === "unarchive" && a.status !== "ARCHIVED") return { ok: false, message: "It is not archived." };
    await prisma.announcement.update({ where: { id: a.id }, data: { status: op === "archive" ? "ARCHIVED" : "PUBLISHED", ...(op === "unarchive" && a.expiresAt && a.expiresAt < new Date() ? { expiresAt: null } : {}) } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Announcement", entityId: a.id, summary: `${op === "archive" ? "Archived" : "Restored"} "${a.title}"` });
    return done([A, "/"], op === "archive" ? "Archived." : "Restored and live again.");
  }
  if (op === "unschedule") {
    if (a.status !== "SCHEDULED") return { ok: false, message: "It is not scheduled." };
    await prisma.announcement.update({ where: { id: a.id }, data: { status: "DRAFT" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Announcement", entityId: a.id, summary: `Unscheduled "${a.title}"` });
    return done([A], "Back to draft.");
  }
  if (op === "delete") {
    if (a.status !== "DRAFT" || a.approvalStatus === "PENDING") return { ok: false, message: "Only a draft that is not waiting for approval can be deleted." };
    await prisma.announcement.delete({ where: { id: a.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "Announcement", entityId: a.id, summary: `Deleted draft "${a.title}"` });
    return done([A], "Draft deleted.");
  }
  return { ok: false, message: "Unknown operation." };
}

/** Acknowledge with a state result (the card button); the read row records when. */
export async function acknowledgeAnnouncementAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees acknowledge announcements." };
  const a = await prisma.announcement.findFirst({ where: { id: str(f, "announcementId"), tenantId: viewer.tenantId, status: "PUBLISHED" } });
  if (!a) return { ok: false, message: "Announcement not found." };
  await prisma.announcementRead.upsert({
    where: { announcementId_employeeId: { announcementId: a.id, employeeId: viewer.employee.id } },
    create: { announcementId: a.id, employeeId: viewer.employee.id, acknowledgedAt: new Date() },
    update: { acknowledgedAt: new Date() },
  });
  return done([A, "/"], "Acknowledged.");
}

// ---------------------------------------------------------------------------
//  Channels and groups
// ---------------------------------------------------------------------------

async function membership(channelId: string, employeeId: string | undefined) {
  return employeeId ? prisma.communityMember.findUnique({ where: { channelId_employeeId: { channelId, employeeId } } }) : null;
}
const isMod = (m: { role: string; status: string } | null, viewer: Viewer) => can(viewer, P.ANNOUNCEMENT_MANAGE) || (!!m && m.status === "ACTIVE" && (m.role === "OWNER" || m.role === "MODERATOR"));

export async function saveChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can create channels." };
  const id = str(f, "id");
  const name = str(f, "name");
  const kind = str(f, "kind") || "CHANNEL";
  const visibility = str(f, "visibility") || "OPEN";
  const departmentId = str(f, "departmentId") || null;
  if (!name || name.length > 80) return { ok: false, message: "Name the channel (up to 80 characters).", errors: { name: "Required" } };
  if (!["CHANNEL", "INTEREST_GROUP", "DEPARTMENT", "LEADERSHIP"].includes(kind)) return { ok: false, message: "Pick a kind." };
  if (!["OPEN", "PRIVATE"].includes(visibility)) return { ok: false, message: "Pick who can join." };
  if ((kind === "DEPARTMENT" || kind === "LEADERSHIP") && !can(viewer, P.ANNOUNCEMENT_MANAGE)) return { ok: false, message: "Department news and leadership channels are set up by communications." };
  if (kind === "DEPARTMENT" && !departmentId) return { ok: false, message: "Pick the department.", errors: { departmentId: "Required" } };
  const foreign = await foreignReference(viewer.tenantId, { department: departmentId });
  if (foreign) return { ok: false, message: foreign };
  const data = { name, description: str(f, "description") || null, kind, visibility, departmentId: kind === "DEPARTMENT" ? departmentId : null, postingRestricted: kind === "LEADERSHIP" || kind === "DEPARTMENT" || f.get("postingRestricted") === "on" };
  try {
    if (id) {
      const ch = await prisma.communityChannel.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!ch) return { ok: false, message: "Channel not found." };
      if (!isMod(await membership(ch.id, viewer.employee.id), viewer)) return { ok: false, message: "Only the channel's owners can edit it." };
      await prisma.communityChannel.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CommunityChannel", entityId: id, summary: `Edited channel "${name}"` });
      return done([C, `${C}/${id}`], "Channel updated.");
    }
    const ch = await prisma.communityChannel.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id, members: { create: { employeeId: viewer.employee.id, role: "OWNER" } } } });
    // Department news: everyone in the department is a member.
    if (kind === "DEPARTMENT" && departmentId) {
      const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, departmentId, status: { notIn: ["EXITED", "INACTIVE"] }, NOT: { id: viewer.employee.id } }, select: { id: true } });
      await prisma.communityMember.createMany({ data: people.map((p) => ({ channelId: ch.id, employeeId: p.id })), skipDuplicates: true });
    }
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CommunityChannel", entityId: ch.id, summary: `Created ${kind.toLowerCase().replace("_", " ")} "${name}"` });
    return { ...done([C], "Channel created."), values: { channelId: ch.id } };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "A channel with that name exists.", errors: { name: "Taken" } };
    throw err;
  }
}

export async function joinChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can join." };
  const ch = await prisma.communityChannel.findFirst({ where: { id: str(f, "channelId"), tenantId: viewer.tenantId, archivedAt: null } });
  if (!ch) return { ok: false, message: "Channel not found." };
  const m = await membership(ch.id, viewer.employee.id);
  if (m?.status === "ACTIVE") return { ok: false, message: "You are already a member." };
  if (m?.status === "PENDING") return { ok: false, message: "Your request is waiting for the owner." };
  if (ch.visibility === "OPEN") {
    await prisma.communityMember.upsert({ where: { channelId_employeeId: { channelId: ch.id, employeeId: viewer.employee.id } }, create: { channelId: ch.id, employeeId: viewer.employee.id }, update: { status: "ACTIVE", role: "MEMBER", joinedAt: new Date() } });
    return done([C, `${C}/${ch.id}`], `You joined ${ch.name}.`);
  }
  const owner = await prisma.communityMember.findFirst({ where: { channelId: ch.id, role: "OWNER", status: "ACTIVE" }, orderBy: { joinedAt: "asc" } });
  const ownerUser = owner ? await prisma.employee.findFirst({ where: { id: owner.employeeId, tenantId: viewer.tenantId }, select: { userId: true } }) : null;
  const row = await prisma.communityMember.upsert({ where: { channelId_employeeId: { channelId: ch.id, employeeId: viewer.employee.id } }, create: { channelId: ch.id, employeeId: viewer.employee.id, status: "PENDING" }, update: { status: "PENDING", role: "MEMBER" } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "CHANNEL_JOIN", entityId: row.id, title: `Join ${ch.name}: ${viewer.employee.displayName}`, details: str(f, "note") || null, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee.id, reviewerUserId: ownerUser?.userId ?? null });
  if (!wf.ok) { await prisma.communityMember.update({ where: { id: row.id }, data: { status: "REMOVED" } }); return { ok: false, message: wf.message }; }
  await prisma.communityMember.update({ where: { id: row.id }, data: { workflowRequestId: wf.requestId } });
  return done([C, `${C}/${ch.id}`], "Request sent to the channel owner.");
}

export async function leaveChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ch = await prisma.communityChannel.findFirst({ where: { id: str(f, "channelId"), tenantId: viewer.tenantId } });
  const m = ch ? await membership(ch.id, viewer.employee?.id) : null;
  if (!ch || !m || m.status !== "ACTIVE") return { ok: false, message: "You are not a member." };
  if (m.role === "OWNER" && (await prisma.communityMember.count({ where: { channelId: ch.id, role: "OWNER", status: "ACTIVE" } })) === 1) return { ok: false, message: "Make someone else an owner before you leave." };
  await prisma.communityMember.update({ where: { id: m.id }, data: { status: "REMOVED" } });
  return done([C, `${C}/${ch.id}`], `You left ${ch.name}.`);
}

export async function postToChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ch = await prisma.communityChannel.findFirst({ where: { id: str(f, "channelId"), tenantId: viewer.tenantId, archivedAt: null } });
  if (!ch || !viewer.employee) return { ok: false, message: "Channel not found." };
  const m = await membership(ch.id, viewer.employee.id);
  if (!m || m.status !== "ACTIVE") return { ok: false, message: "Join the channel to post." };
  const parentId = str(f, "parentId") || null;
  if (ch.postingRestricted && !parentId && !isMod(m, viewer)) return { ok: false, message: "Only the channel's owners post here; you can reply." };
  const body = str(f, "body");
  if (!body || body.length > 4000) return { ok: false, message: "Write something (up to 4,000 characters).", errors: { body: "Required" } };
  if (parentId && !(await prisma.communityPost.count({ where: { id: parentId, channelId: ch.id, hiddenAt: null } }))) return { ok: false, message: "That post is gone." };
  await prisma.communityPost.create({ data: { channelId: ch.id, authorId: viewer.employee.id, body, parentId } });
  if (!parentId && (ch.kind === "LEADERSHIP" || ch.kind === "DEPARTMENT")) {
    const members = await prisma.communityMember.findMany({ where: { channelId: ch.id, status: "ACTIVE", NOT: { employeeId: viewer.employee.id } }, select: { employeeId: true } });
    const users = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: members.map((x) => x.employeeId) } }, select: { userId: true } });
    await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "ENGAGE", title: `New in ${ch.name}`, body: body.slice(0, 200), link: `${C}/${ch.id}` });
  }
  return done([`${C}/${ch.id}`], parentId ? "Replied." : "Posted.");
}

/** Owners/moderators (and communications) hide, restore, pin or unpin posts, and manage members. */
export async function moderateChannelAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ch = await prisma.communityChannel.findFirst({ where: { id: str(f, "channelId"), tenantId: viewer.tenantId } });
  if (!ch) return { ok: false, message: "Channel not found." };
  const me = await membership(ch.id, viewer.employee?.id);
  if (!isMod(me, viewer)) return { ok: false, message: "Only the channel's owners and moderators can do that." };
  const op = str(f, "op");
  if (["hide", "restore", "pin", "unpin"].includes(op)) {
    const post = await prisma.communityPost.findFirst({ where: { id: str(f, "postId"), channelId: ch.id } });
    if (!post) return { ok: false, message: "Post not found." };
    if (op === "hide" && !str(f, "reason")) return { ok: false, message: "Say why it is hidden." };
    await prisma.communityPost.update({ where: { id: post.id }, data: op === "hide" ? { hiddenAt: new Date(), hiddenBy: viewer.user.id, hideReason: str(f, "reason") } : op === "restore" ? { hiddenAt: null, hiddenBy: null, hideReason: null } : { isPinned: op === "pin" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CommunityPost", entityId: post.id, summary: `${op} a post in "${ch.name}"${op === "hide" ? `: ${str(f, "reason")}` : ""}` });
    return done([`${C}/${ch.id}`], op === "hide" ? "Hidden." : op === "restore" ? "Restored." : op === "pin" ? "Pinned." : "Unpinned.");
  }
  if (["promote", "demote", "remove"].includes(op)) {
    const m = await prisma.communityMember.findFirst({ where: { id: str(f, "memberId"), channelId: ch.id } });
    if (!m) return { ok: false, message: "Member not found." };
    if (m.role === "OWNER" && op !== "promote" && (await prisma.communityMember.count({ where: { channelId: ch.id, role: "OWNER", status: "ACTIVE" } })) === 1) return { ok: false, message: "A channel needs at least one owner." };
    await prisma.communityMember.update({ where: { id: m.id }, data: op === "promote" ? { role: m.role === "MEMBER" ? "MODERATOR" : "OWNER" } : op === "demote" ? { role: "MEMBER" } : { status: "REMOVED" } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CommunityMember", entityId: m.id, summary: `${op} a member of "${ch.name}"` });
    return done([`${C}/${ch.id}`], "Member updated.");
  }
  if (op === "archive" || op === "unarchive") {
    await prisma.communityChannel.update({ where: { id: ch.id }, data: { archivedAt: op === "archive" ? new Date() : null } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CommunityChannel", entityId: ch.id, summary: `${op === "archive" ? "Archived" : "Reopened"} channel "${ch.name}"` });
    return done([C, `${C}/${ch.id}`], op === "archive" ? "Archived — read only." : "Reopened.");
  }
  return { ok: false, message: "Unknown operation." };
}

// ---------------------------------------------------------------------------
//  Content reports (wall and channel posts)
// ---------------------------------------------------------------------------

export async function reportContentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can report posts." };
  const targetType = str(f, "targetType");
  const targetId = str(f, "targetId");
  const reason = str(f, "reason");
  if (!reason) return { ok: false, message: "Say what is wrong with it." };
  const exists = targetType === "WALL_POST"
    ? await prisma.wallPost.count({ where: { id: targetId, tenantId: viewer.tenantId, deletedAt: null } })
    : targetType === "CHANNEL_POST" ? await prisma.communityPost.count({ where: { id: targetId, channel: { tenantId: viewer.tenantId }, hiddenAt: null } }) : 0;
  if (!exists) return { ok: false, message: "Post not found." };
  if (await prisma.contentReport.findUnique({ where: { targetType_targetId_reporterId: { targetType, targetId, reporterId: viewer.employee.id } } })) return { ok: false, message: "You have already reported this." };
  try {
    await prisma.contentReport.create({ data: { tenantId: viewer.tenantId, targetType, targetId, reporterId: viewer.employee.id, reason: reason.slice(0, 500) } });
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, message: "You have already reported this." };
    throw err;
  }
  await notify({ tenantId: viewer.tenantId, userIds: await usersWithPermission(viewer.tenantId, P.ANNOUNCEMENT_MANAGE), kind: "ENGAGE", title: "A post was reported for moderation", link: `${C}?tab=moderation` });
  return done([C], "Reported to the moderators. Thank you.");
}

export async function decideReportAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const r = await prisma.contentReport.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Report not found." };
  if (r.status !== "OPEN") return { ok: false, message: "Already decided." };
  const remove = str(f, "decision") === "remove";
  if (remove) {
    if (r.targetType === "WALL_POST") await prisma.wallPost.updateMany({ where: { id: r.targetId, tenantId: viewer.tenantId }, data: { deletedAt: new Date() } });
    else await prisma.communityPost.updateMany({ where: { id: r.targetId, channel: { tenantId: viewer.tenantId } }, data: { hiddenAt: new Date(), hiddenBy: viewer.user.id, hideReason: `Reported: ${r.reason}` } });
  }
  // Every open report on the same post is settled together.
  await prisma.contentReport.updateMany({ where: { tenantId: viewer.tenantId, targetType: r.targetType, targetId: r.targetId, status: "OPEN" }, data: { status: remove ? "REMOVED" : "DISMISSED", decidedBy: viewer.user.id, decidedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: remove ? "DELETE" : "UPDATE", entityType: r.targetType === "WALL_POST" ? "WallPost" : "CommunityPost", entityId: r.targetId, summary: `Moderation: ${remove ? "removed" : "kept"} a reported post (${r.reason})` });
  return done([C, "/", "/wall"], remove ? "Removed." : "Dismissed; the post stays.");
}

// ---------------------------------------------------------------------------
//  Company events
// ---------------------------------------------------------------------------

export async function saveEventAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee && !can(viewer, P.ANNOUNCEMENT_MANAGE)) return { ok: false, message: "Only employees can propose events." };
  const manager = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const id = str(f, "id");
  const title = str(f, "title");
  const kind = str(f, "kind") || "GENERAL";
  const startsAt = when(str(f, "startsAt")), endsAt = when(str(f, "endsAt"));
  const capacity = str(f, "capacity") ? Number(str(f, "capacity")) : null;
  const rsvpBy = day(str(f, "rsvpBy"));
  const departmentIds = formList(f, "departmentIds");
  const errors: Record<string, string> = {};
  if (!title) errors.title = "Required";
  if (!["GENERAL", "TOWN_HALL", "CELEBRATION", "HEALTH_SCREENING", "TRAINING", "SPORTS"].includes(kind)) errors.kind = "Pick one";
  if (!startsAt) errors.startsAt = "Required";
  if (!endsAt) errors.endsAt = "Required";
  if (startsAt && endsAt && endsAt <= startsAt) errors.endsAt = "After the start";
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) errors.capacity = "1 or more";
  if (str(f, "onlineUrl") && !/^https:\/\//.test(str(f, "onlineUrl"))) errors.onlineUrl = "https:// only";
  if (Object.keys(errors).length) return { ok: false, message: "Please correct the highlighted fields.", errors };
  const foreign = await foreignReference(viewer.tenantId, { department: departmentIds });
  if (foreign) return { ok: false, message: foreign };
  const data = { title, description: str(f, "description") || null, kind, startsAt: startsAt!, endsAt: endsAt!, location: str(f, "location") || null, onlineUrl: str(f, "onlineUrl") || null, capacity, rsvpBy, departmentIds, allowQuestions: kind === "TOWN_HALL" || f.get("allowQuestions") === "on" };
  if (id) {
    const e = await prisma.companyEvent.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!e) return { ok: false, message: "Event not found." };
    if (!manager && e.createdBy !== viewer.user.id) return { ok: false, message: "Only the organiser or communications can edit it." };
    if (!manager && e.status !== "DRAFT" && e.status !== "REJECTED") return { ok: false, message: "It has been submitted; ask communications to change it." };
    await prisma.companyEvent.update({ where: { id }, data });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CompanyEvent", entityId: id, summary: `Edited event "${title}"` });
    if (e.capacity !== capacity) await fillFromWaitlist(id);
    return done([E, `${E}/${id}`], "Event updated.");
  }
  const publishNow = manager && str(f, "intent") === "publish";
  const e = await prisma.companyEvent.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id, status: publishNow ? "PUBLISHED" : "DRAFT" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CompanyEvent", entityId: e.id, summary: `${publishNow ? "Published" : "Drafted"} event "${title}"` });
  if (publishNow) await announceEvent(viewer.tenantId, e.id);
  return { ...done([E], publishNow ? "Published to the calendar." : manager ? "Saved as a draft." : "Saved — submit it for approval to put it on the calendar."), values: { eventId: e.id } };
}

export async function eventOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await prisma.companyEvent.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!e) return { ok: false, message: "Event not found." };
  const manager = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const organiser = e.createdBy === viewer.user.id;
  const op = str(f, "op");
  if (op === "submit") {
    if (!organiser) return { ok: false, message: "Only the organiser can submit it." };
    if (!["DRAFT", "REJECTED"].includes(e.status)) return { ok: false, message: "Only a draft can be submitted." };
    await prisma.companyEvent.update({ where: { id: e.id }, data: { status: "PENDING_APPROVAL" } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "COMPANY_EVENT", entityId: e.id, title: `Publish event: ${e.title}`, details: e.description, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
    if (!wf.ok) { await prisma.companyEvent.update({ where: { id: e.id }, data: { status: e.status } }); return { ok: false, message: wf.message }; }
    await prisma.companyEvent.update({ where: { id: e.id }, data: { workflowRequestId: wf.requestId } });
    return done([E, `${E}/${e.id}`], wf.message);
  }
  if (!manager) return { ok: false, message: "Only communications can do that." };
  if (op === "publish") {
    if (!["DRAFT", "REJECTED"].includes(e.status)) return { ok: false, message: "Only a draft can be published." };
    await prisma.companyEvent.update({ where: { id: e.id }, data: { status: "PUBLISHED" } });
    await announceEvent(viewer.tenantId, e.id);
  } else if (op === "cancel") {
    if (e.status !== "PUBLISHED") return { ok: false, message: "Only a published event can be cancelled." };
    await prisma.companyEvent.update({ where: { id: e.id }, data: { status: "CANCELLED" } });
    const going = await prisma.eventRsvp.findMany({ where: { eventId: e.id, response: { in: ["GOING", "MAYBE", "WAITLIST"] } }, select: { employeeId: true } });
    const users = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: going.map((g) => g.employeeId) } }, select: { userId: true } });
    await notify({ tenantId: viewer.tenantId, userIds: users.map((u) => u.userId), kind: "ENGAGE", title: `Cancelled: ${e.title}`, body: str(f, "reason") || null, link: `${E}/${e.id}`, email: true });
  } else return { ok: false, message: "Unknown operation." };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CompanyEvent", entityId: e.id, summary: `${op === "publish" ? "Published" : "Cancelled"} event "${e.title}"` });
  return done([E, `${E}/${e.id}`], op === "publish" ? "Published to the calendar." : "Cancelled; attendees are notified.");
}

export async function rsvpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can RSVP." };
  const e = await prisma.companyEvent.findFirst({ where: { id: str(f, "eventId"), tenantId: viewer.tenantId, status: "PUBLISHED" } });
  if (!e) return { ok: false, message: "Event not found." };
  if (e.endsAt < new Date()) return { ok: false, message: "This event is over." };
  if (e.rsvpBy && e.rsvpBy.getTime() + 86_400_000 < Date.now()) return { ok: false, message: "RSVPs have closed." };
  const me = await prisma.employee.findUniqueOrThrow({ where: { id: viewer.employee.id }, select: { departmentId: true } });
  if (e.departmentIds.length && !e.departmentIds.includes(me.departmentId ?? "")) return { ok: false, message: "This event is for other departments." };
  const response = str(f, "response") as "GOING" | "MAYBE" | "DECLINED";
  if (!["GOING", "MAYBE", "DECLINED"].includes(response)) return { ok: false, message: "Pick a response." };
  const goingOthers = await prisma.eventRsvp.count({ where: { eventId: e.id, response: "GOING", NOT: { employeeId: viewer.employee.id } } });
  const outcome = rsvpOutcome(response, e.capacity, goingOthers);
  const prev = await prisma.eventRsvp.findUnique({ where: { eventId_employeeId: { eventId: e.id, employeeId: viewer.employee.id } } });
  // Already holding a place: keep it.
  const final = prev?.response === "GOING" && response === "GOING" ? "GOING" : outcome;
  await prisma.eventRsvp.upsert({ where: { eventId_employeeId: { eventId: e.id, employeeId: viewer.employee.id } }, create: { eventId: e.id, employeeId: viewer.employee.id, response: final }, update: { response: final } });
  if (prev?.response === "GOING" && final !== "GOING") await fillFromWaitlist(e.id);
  return done([E, `${E}/${e.id}`], final === "WAITLIST" ? "The event is full — you are on the waitlist." : final === "GOING" ? "See you there." : final === "MAYBE" ? "Marked as maybe." : "Declined.");
}

export async function markAttendanceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const e = await prisma.companyEvent.findFirst({ where: { id: str(f, "eventId"), tenantId: viewer.tenantId } });
  if (!e) return { ok: false, message: "Event not found." };
  if (e.startsAt > new Date()) return { ok: false, message: "Mark attendance once the event has started." };
  const attended = new Set(formList(f, "attended"));
  const rsvps = await prisma.eventRsvp.findMany({ where: { eventId: e.id, response: { in: ["GOING", "MAYBE"] } } });
  for (const r of rsvps) await prisma.eventRsvp.update({ where: { id: r.id }, data: { attended: attended.has(r.employeeId) } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CompanyEvent", entityId: e.id, summary: `Marked attendance for "${e.title}": ${attended.size} of ${rsvps.length}` });
  return done([`${E}/${e.id}`], `Attendance saved: ${attended.size} attended.`);
}

export async function askQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can ask." };
  const e = await prisma.companyEvent.findFirst({ where: { id: str(f, "eventId"), tenantId: viewer.tenantId, status: "PUBLISHED" } });
  if (!e || !e.allowQuestions) return { ok: false, message: "This event is not taking questions." };
  const body = str(f, "body");
  if (body.length < 5 || body.length > 1000) return { ok: false, message: "Ask in 5 to 1,000 characters.", errors: { body: "5–1000" } };
  await prisma.eventQuestion.create({ data: { eventId: e.id, authorId: f.get("anonymous") === "on" ? null : viewer.employee.id, body } });
  return done([`${E}/${e.id}`], "Question submitted.");
}

export async function voteQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can vote." };
  const q = await prisma.eventQuestion.findFirst({ where: { id: str(f, "questionId"), event: { tenantId: viewer.tenantId } } });
  if (!q || q.status === "HIDDEN") return { ok: false, message: "Question not found." };
  const me = viewer.employee.id;
  const voterIds = q.voterIds.includes(me) ? q.voterIds.filter((v) => v !== me) : [...q.voterIds, me];
  await prisma.eventQuestion.update({ where: { id: q.id }, data: { voterIds } });
  return done([`${E}/${q.eventId}`], q.voterIds.includes(me) ? "Vote removed." : "Upvoted.");
}

export async function answerQuestionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANNOUNCEMENT_MANAGE);
  const q = await prisma.eventQuestion.findFirst({ where: { id: str(f, "questionId"), event: { tenantId: viewer.tenantId } } });
  if (!q) return { ok: false, message: "Question not found." };
  const op = str(f, "op");
  if (op === "hide") await prisma.eventQuestion.update({ where: { id: q.id }, data: { status: "HIDDEN" } });
  else {
    const answer = str(f, "answer");
    if (!answer) return { ok: false, message: "Write the answer." };
    await prisma.eventQuestion.update({ where: { id: q.id }, data: { status: "ANSWERED", answer } });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EventQuestion", entityId: q.id, summary: op === "hide" ? "Hid a town-hall question" : "Answered a town-hall question" });
  return done([`${E}/${q.eventId}`], op === "hide" ? "Hidden." : "Answered.");
}
