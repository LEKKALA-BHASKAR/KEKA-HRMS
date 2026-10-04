"use server";

import { unstable_rethrow } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  notify, extractMentions, sanitiseMentions, wallPlainText, validatePollOptions, wishWindowOpen, POLL_MAX_DAYS, creditPraisePoints,
} from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { z, parseForm, formList, writeAudit, actionDone, toErrorState, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { aiForViewer, aiText } from "@/lib/ai";
import { wallSettings, myGroup, visiblePostsWhere, isModerator, announcementDetail } from "@/app/(app)/home/_lib/wall";

/**
 * Keka Wall: posts, polls, praise, birthday wishes, likes and comments.
 *
 * Every action re-reads who the viewer is, what the tenant allows
 * (WallSetting) and whether the thing being touched is visible to them —
 * nothing is trusted from the form beyond the ids it names, and those are
 * looked up inside the viewer's tenant. Mentions are rewritten so only real
 * colleagues stay linked, and each mentioned person is notified.
 */

const P = PERMISSIONS;
const WALL_PATHS = ["/", "/wall"];
const POST_MAX = 3000;
const COMMENT_MAX = 1000;
const WISH_MAX = 500;
const ATTACHMENTS_MAX = 5;
const IMAGE_MAX = 5 * 1024 * 1024;

const IST = 330 * 60_000;
const istToday = () => { const l = new Date(Date.now() + IST); return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate())); };

function noEmployee(): ActionState { return { ok: false, message: "No employee record is linked to this login." }; }

/** Keep only mentions of people in this tenant's directory, with their current names. */
async function cleanMentions(viewer: Viewer, body: string): Promise<{ body: string; mentioned: Array<{ id: string; userId: string | null }> }> {
  const ids = extractMentions(body);
  if (ids.length === 0) return { body, mentioned: [] };
  const rows = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), id: { in: ids } },
    select: { id: true, userId: true, firstName: true, lastName: true, displayName: true },
  });
  return {
    body: sanitiseMentions(body, new Map(rows.map((r) => [r.id, nameOf(r)]))),
    mentioned: rows.filter((r) => r.id !== viewer.employee?.id).map((r) => ({ id: r.id, userId: r.userId })),
  };
}

/** The audience a post goes to: the organisation (empty) or the viewer's own group. */
async function audienceFor(viewer: Viewer, raw: string): Promise<{ departmentId: string | null } | { error: string }> {
  const v = raw.trim();
  if (!v || v === "org") return { departmentId: null };
  const group = await myGroup(viewer);
  if (!group || group.id !== v) return { error: "You can post to the organisation or to your own group only." };
  return { departmentId: group.id };
}

async function notifyMentions(viewer: Viewer, mentioned: Array<{ userId: string | null }>, what: string, body: string, link: string) {
  await notify({
    tenantId: viewer.tenantId, userIds: mentioned.map((m) => m.userId), kind: "WALL",
    title: `${viewer.employee!.displayName} mentioned you in ${what}`, body: wallPlainText(body).slice(0, 280), link,
  });
}

const fileList = (formData: FormData, key: string): File[] =>
  formData.getAll(key).filter((v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v && (v as File).size > 0);

// ---------------------------------------------------------------------------
//  Posts
// ---------------------------------------------------------------------------

const postSchema = z.object({
  body: z.string().min(1, "Write something to post").max(POST_MAX, `Keep it under ${POST_MAX} characters`),
  audience: z.string().optional().default(""),
});

export async function createPostAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  if (!(await wallSettings(viewer.tenantId)).allowPosts) return { ok: false, message: "Posting on the wall is turned off for your organisation." };
  const parsed = parseForm(postSchema, formData);
  if (parsed.state) return parsed.state;
  const values = { body: parsed.data.body, audience: parsed.data.audience };
  const aud = await audienceFor(viewer, parsed.data.audience);
  if ("error" in aud) return { ok: false, message: aud.error, errors: { audience: aud.error }, values };

  const image = fileList(formData, "image")[0];
  let imageData: { data: Buffer; mimeType: string; name: string } | null = null;
  if (image) {
    if (image.size > IMAGE_MAX) return { ok: false, message: "Images are limited to 5 MB.", errors: { image: "Too large" }, values };
    const data = Buffer.from(await image.arrayBuffer());
    const sniff = sniffUpload(data, image.type);
    if (!sniff.ok || !sniff.mimeType.startsWith("image/")) return { ok: false, message: "Attach a PNG or JPEG image.", errors: { image: "Not an image" }, values };
    imageData = { data, mimeType: sniff.mimeType, name: image.name || "image" };
  }

  try {
    const { body, mentioned } = await cleanMentions(viewer, parsed.data.body);
    const post = await prisma.wallPost.create({
      data: { tenantId: viewer.tenantId, kind: "POST", authorId: viewer.employee.id, body, departmentId: aud.departmentId },
    });
    if (imageData) {
      const f = await saveFile({ tenantId: viewer.tenantId, filename: imageData.name, mimeType: imageData.mimeType, data: imageData.data, relatedType: "WallPostImage", relatedId: post.id, uploadedBy: viewer.user.id });
      await prisma.wallPost.update({ where: { id: post.id }, data: { imageUrl: `/wall/files/${f.id}` } });
    }
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WallPost", entityId: post.id, summary: `Posted on the wall${aud.departmentId ? " (group)" : ""}` });
    await notifyMentions(viewer, mentioned, "a post", body, `/wall/${post.id}`);
    return actionDone(WALL_PATHS, "Post is created");
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}

export async function deletePostAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("postId") ?? "");
  const post = await prisma.wallPost.findFirst({ where: { id, tenantId: viewer.tenantId, deletedAt: null }, select: { id: true, authorId: true, kind: true } });
  if (!post) return { ok: false, message: "That post no longer exists." };
  const own = !!viewer.employee && post.authorId === viewer.employee.id;
  if (!own && !isModerator(viewer)) return { ok: false, message: "Only the author or a wall moderator can delete this post." };
  await prisma.wallPost.update({ where: { id: post.id }, data: { deletedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "WallPost", entityId: post.id, summary: `${own ? "Deleted their" : "Removed a"} ${post.kind.toLowerCase()} from the wall` });
  return actionDone(WALL_PATHS, "Post deleted.");
}

// ---------------------------------------------------------------------------
//  Polls
// ---------------------------------------------------------------------------

const pollSchema = z.object({
  question: z.string().min(1, "Say what this poll is about").max(300, "Keep the question under 300 characters"),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date the poll expires"),
  audience: z.string().optional().default(""),
});

export async function createPollAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  if (!(await wallSettings(viewer.tenantId)).allowPolls) return { ok: false, message: "Polls are turned off for your organisation." };
  const parsed = parseForm(pollSchema, formData);
  if (parsed.state) return parsed.state;
  const values = { question: parsed.data.question, expiresOn: parsed.data.expiresOn, audience: parsed.data.audience };
  const opts = validatePollOptions(formData.getAll("option").map(String));
  if (!opts.ok) return { ok: false, message: opts.error, errors: { option: opts.error }, values };

  const today = istToday();
  const expires = new Date(`${parsed.data.expiresOn}T00:00:00Z`);
  const days = Math.round((expires.getTime() - today.getTime()) / 86_400_000);
  if (Number.isNaN(days) || days < 1 || days > POLL_MAX_DAYS) {
    const msg = `The poll must expire between tomorrow and ${POLL_MAX_DAYS} days from today.`;
    return { ok: false, message: msg, errors: { expiresOn: msg }, values };
  }
  const aud = await audienceFor(viewer, parsed.data.audience);
  if ("error" in aud) return { ok: false, message: aud.error, errors: { audience: aud.error }, values };
  const anonymous = formData.get("anonymous") === "on";
  const notifyAll = formData.get("notify") === "on";

  try {
    const { body, mentioned } = await cleanMentions(viewer, parsed.data.question);
    // Expires at the end of the chosen day in India.
    const pollExpiresAt = new Date(expires.getTime() + 86_400_000 - 330 * 60_000);
    const post = await prisma.wallPost.create({
      data: {
        tenantId: viewer.tenantId, kind: "POLL", authorId: viewer.employee.id, body, departmentId: aud.departmentId,
        pollExpiresAt, pollAnonymous: anonymous, pollNotify: notifyAll,
        pollOptions: { create: opts.options.map((label, position) => ({ label, position })) },
      },
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WallPost", entityId: post.id, summary: `Created a poll${anonymous ? " (anonymous)" : ""}` });
    await notifyMentions(viewer, mentioned, "a poll", body, `/wall/${post.id}`);
    if (notifyAll) {
      const people = await prisma.employee.findMany({
        where: { ...directoryWhere(viewer.tenantId), ...(aud.departmentId ? { departmentId: aud.departmentId } : {}), NOT: { id: viewer.employee.id } },
        select: { userId: true },
      });
      await notify({
        tenantId: viewer.tenantId, userIds: people.map((p) => p.userId), kind: "WALL",
        title: `${viewer.employee.displayName} created a poll`, body: wallPlainText(body).slice(0, 280), link: `/wall/${post.id}`,
      });
    }
    return actionDone(WALL_PATHS, "Poll is created");
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}

export async function votePollAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  const postId = String(formData.get("postId") ?? "");
  const optionId = String(formData.get("optionId") ?? "");
  const group = await myGroup(viewer);
  const post = await prisma.wallPost.findFirst({
    where: { AND: [{ id: postId, kind: "POLL" }, visiblePostsWhere(viewer, group?.id ?? null)] },
    select: { id: true, pollExpiresAt: true, pollOptions: { select: { id: true } } },
  });
  if (!post) return { ok: false, message: "That poll is not available to you." };
  if (post.pollExpiresAt && post.pollExpiresAt <= new Date()) return { ok: false, message: "This poll has closed." };
  if (!post.pollOptions.some((o) => o.id === optionId)) return { ok: false, message: "Choose one of the poll's options." };
  const vote = await prisma.wallPollVote.upsert({
    where: { postId_employeeId: { postId: post.id, employeeId: viewer.employee.id } },
    create: { postId: post.id, optionId, employeeId: viewer.employee.id },
    update: { optionId },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "WallPollVote", entityId: vote.id, summary: "Voted in a wall poll" });
  return actionDone(WALL_PATHS, "Your vote is in.");
}

// ---------------------------------------------------------------------------
//  Praise
// ---------------------------------------------------------------------------

const praiseSchema = z.object({
  message: z.string().min(1, "Say what the employee did to deserve the praise").max(1000, "Keep it under 1,000 characters"),
  badgeId: z.string().optional().default(""),
  projectId: z.string().optional().default(""),
  audience: z.string().optional().default(""),
});

/** Praise one or more colleagues on the wall: one post, one Praise row per person. */
export async function givePraisePostAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  if (!can(viewer, P.PRAISE_GIVE)) return { ok: false, message: "Your role does not allow giving praise." };
  if (!(await wallSettings(viewer.tenantId)).allowPraise) return { ok: false, message: "Praise is turned off for your organisation." };
  const parsed = parseForm(praiseSchema, formData);
  if (parsed.state) return parsed.state;
  const values = { message: parsed.data.message, badgeId: parsed.data.badgeId, projectId: parsed.data.projectId, audience: parsed.data.audience };

  const ids = [...new Set(formList(formData, "toEmployeeId"))];
  if (ids.length === 0) return { ok: false, message: "Choose who you are praising.", errors: { toEmployeeId: "Required" }, values };
  if (ids.length > 10) return { ok: false, message: "Praise up to 10 people at a time.", errors: { toEmployeeId: "Too many" }, values };
  if (ids.includes(viewer.employee.id)) return { ok: false, message: "You cannot praise yourself.", errors: { toEmployeeId: "Not yourself" }, values };
  const people = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), id: { in: ids } },
    select: { id: true, userId: true, firstName: true, lastName: true, displayName: true },
  });
  if (people.length !== ids.length) return { ok: false, message: "One of those colleagues is not in the directory.", errors: { toEmployeeId: "Not found" }, values };

  const badge = parsed.data.badgeId
    ? await prisma.praiseBadge.findFirst({ where: { id: parsed.data.badgeId, tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true } })
    : null;
  if (parsed.data.badgeId && !badge) return { ok: false, message: "Pick a badge from the list.", errors: { badgeId: "Not available" }, values };
  const project = parsed.data.projectId
    ? await prisma.project.findFirst({ where: { id: parsed.data.projectId, tenantId: viewer.tenantId }, select: { id: true } })
    : null;
  if (parsed.data.projectId && !project) return { ok: false, message: "That project is not available.", errors: { projectId: "Not found" }, values };
  const aud = await audienceFor(viewer, parsed.data.audience);
  if ("error" in aud) return { ok: false, message: aud.error, errors: { audience: aud.error }, values };

  const files = fileList(formData, "attachment");
  if (files.length > ATTACHMENTS_MAX) return { ok: false, message: `Max number of files allowed is ${ATTACHMENTS_MAX}.`, errors: { attachment: "Too many" }, values };
  const uploads: Array<{ name: string; data: Buffer; mimeType: string }> = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) return { ok: false, message: `${f.name} is over 10 MB.`, errors: { attachment: "Too large" }, values };
    const data = Buffer.from(await f.arrayBuffer());
    const sniff = sniffUpload(data, f.type);
    if (!sniff.ok) return { ok: false, message: `${f.name}: ${sniff.reason}`, errors: { attachment: sniff.reason }, values };
    uploads.push({ name: f.name || "attachment", data, mimeType: sniff.mimeType });
  }

  try {
    const { body, mentioned } = await cleanMentions(viewer, parsed.data.message);
    const post = await prisma.$transaction(async (tx) => {
      const p = await tx.wallPost.create({
        data: { tenantId: viewer.tenantId, kind: "PRAISE", authorId: viewer.employee!.id, body, departmentId: aud.departmentId },
      });
      await tx.praise.createMany({
        data: people.map((person) => ({
          tenantId: viewer.tenantId, fromEmployeeId: viewer.employee!.id, toEmployeeId: person.id,
          badge: badge?.name ?? null, badgeId: badge?.id ?? null, projectId: project?.id ?? null,
          message: wallPlainText(body), isPublic: true, wallPostId: p.id,
        })),
      });
      return p;
    });
    for (const u of uploads) {
      await saveFile({ tenantId: viewer.tenantId, filename: u.name, mimeType: u.mimeType, data: u.data, relatedType: "WallPostAttachment", relatedId: post.id, uploadedBy: viewer.user.id });
    }
    await creditPraisePoints(viewer.tenantId, await prisma.praise.findMany({ where: { tenantId: viewer.tenantId, wallPostId: post.id }, select: { id: true, toEmployeeId: true } }));
    const names = people.map(nameOf).join(", ");
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Praise", entityId: post.id, summary: `Praised ${names}${badge ? ` — ${badge.name}` : ""}` });
    await notify({
      tenantId: viewer.tenantId, userIds: people.map((p) => p.userId), kind: "PRAISE",
      title: `${viewer.employee.displayName} praised you${badge ? ` — ${badge.name}` : ""}`, body: wallPlainText(body).slice(0, 280), link: `/wall/${post.id}`,
    });
    const praised = new Set(people.map((p) => p.id));
    await notifyMentions(viewer, mentioned.filter((m) => !praised.has(m.id)), "a praise", body, `/wall/${post.id}`);
    return actionDone([...WALL_PATHS, "/awards", "/me/performance"], `Praise posted for ${names}.`);
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}

// ---------------------------------------------------------------------------
//  Wishes
// ---------------------------------------------------------------------------

const wishSchema = z.object({
  employeeId: z.string().min(1),
  occasion: z.enum(["BIRTHDAY", "WORK_ANNIVERSARY", "NEW_JOINEE"]),
  message: z.string().min(1, "Write your wish").max(WISH_MAX, `Keep it under ${WISH_MAX} characters`),
});

export async function sendWishAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  const parsed = parseForm(wishSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, occasion } = parsed.data;
  const values = { message: parsed.data.message };
  if (employeeId === viewer.employee.id) return { ok: false, message: "You cannot wish yourself.", values };
  const who = await prisma.employee.findFirst({
    where: { ...directoryWhere(viewer.tenantId), id: employeeId },
    select: { id: true, userId: true, firstName: true, lastName: true, displayName: true, dateOfBirth: true, dateOfJoining: true },
  });
  if (!who) return { ok: false, message: "That colleague is not in the directory.", values };
  const today = istToday();
  if (!wishWindowOpen(occasion, who, today)) return { ok: false, message: "There is nothing to celebrate for them today.", values };
  const year = today.getUTCFullYear();
  const already = await prisma.wallPost.count({
    where: { tenantId: viewer.tenantId, kind: "WISH", deletedAt: null, authorId: viewer.employee.id, wishForId: who.id, wishOccasion: occasion, wishYear: year },
  });
  if (already) return { ok: false, message: `You have already wished ${nameOf(who)}.`, values };

  try {
    const { body } = await cleanMentions(viewer, parsed.data.message);
    const post = await prisma.wallPost.create({
      data: { tenantId: viewer.tenantId, kind: "WISH", authorId: viewer.employee.id, body, wishForId: who.id, wishOccasion: occasion, wishYear: year },
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WallPost", entityId: post.id, summary: `Wished ${nameOf(who)} (${occasion.toLowerCase().replace("_", " ")})` });
    const what = occasion === "BIRTHDAY" ? "a happy birthday" : occasion === "WORK_ANNIVERSARY" ? "a happy work anniversary" : "a warm welcome";
    await notify({ tenantId: viewer.tenantId, userIds: [who.userId], kind: "WALL", title: `${viewer.employee.displayName} wished you ${what}`, body: wallPlainText(body).slice(0, 280), link: `/wall/${post.id}` });
    return actionDone(WALL_PATHS, `Your wish for ${nameOf(who)} is on the wall.`);
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, values);
  }
}

// ---------------------------------------------------------------------------
//  Likes and comments (posts and announcements)
// ---------------------------------------------------------------------------

type Target = { kind: "post"; id: string; authorUserId: string | null } | { kind: "announcement"; id: string; closed: boolean };

/** Resolve a like/comment target the viewer may see, or null. */
async function resolveTarget(viewer: Viewer, kind: string, id: string): Promise<Target | null> {
  if (kind === "post") {
    const group = await myGroup(viewer);
    const post = await prisma.wallPost.findFirst({
      where: { AND: [{ id }, visiblePostsWhere(viewer, group?.id ?? null)] },
      select: { id: true, author: { select: { userId: true } } },
    });
    return post ? { kind: "post", id: post.id, authorUserId: post.author.userId } : null;
  }
  if (kind === "announcement") {
    const a = await announcementDetail(viewer, id);
    return a ? { kind: "announcement", id: a.id, closed: a.closed } : null;
  }
  return null;
}

export async function toggleLikeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  const target = await resolveTarget(viewer, String(formData.get("target") ?? ""), String(formData.get("id") ?? ""));
  if (!target) return { ok: false, message: "That is not available to you." };
  const key: Prisma.WallLikeWhereInput = target.kind === "post" ? { postId: target.id } : { announcementId: target.id };
  const existing = await prisma.wallLike.findFirst({ where: { ...key, employeeId: viewer.employee.id }, select: { id: true } });
  if (existing) await prisma.wallLike.delete({ where: { id: existing.id } });
  else await prisma.wallLike.create({ data: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, ...(target.kind === "post" ? { postId: target.id } : { announcementId: target.id }) } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "DELETE" : "CREATE", entityType: "WallLike", entityId: target.id, summary: `${existing ? "Unliked" : "Liked"} ${target.kind === "post" ? "a wall post" : "an announcement"}` });
  return actionDone([...WALL_PATHS, target.kind === "announcement" ? `/announcements/${target.id}` : `/wall/${target.id}`], existing ? "Like removed." : "Liked.");
}

const commentSchema = z.object({
  body: z.string().min(1, "Write a comment").max(COMMENT_MAX, `Keep it under ${COMMENT_MAX} characters`),
});

export async function addCommentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  if (!(await wallSettings(viewer.tenantId)).allowComments) return { ok: false, message: "Comments are turned off for your organisation." };
  const parsed = parseForm(commentSchema, formData);
  if (parsed.state) return parsed.state;
  const target = await resolveTarget(viewer, String(formData.get("target") ?? ""), String(formData.get("id") ?? ""));
  if (!target) return { ok: false, message: "That is not available to you." };
  if (target.kind === "announcement" && target.closed) return { ok: false, message: "This announcement is closed for comments." };
  try {
    const { body, mentioned } = await cleanMentions(viewer, parsed.data.body);
    const c = await prisma.wallComment.create({
      data: { tenantId: viewer.tenantId, authorId: viewer.employee.id, body, ...(target.kind === "post" ? { postId: target.id } : { announcementId: target.id }) },
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "WallComment", entityId: c.id, summary: `Commented on ${target.kind === "post" ? "a wall post" : "an announcement"}` });
    const link = target.kind === "post" ? `/wall/${target.id}` : `/announcements/${target.id}`;
    if (target.kind === "post" && target.authorUserId && target.authorUserId !== viewer.user.id) {
      await notify({ tenantId: viewer.tenantId, userIds: [target.authorUserId], kind: "WALL", title: `${viewer.employee.displayName} commented on your post`, body: wallPlainText(body).slice(0, 280), link });
    }
    await notifyMentions(viewer, mentioned, "a comment", body, link);
    return actionDone([...WALL_PATHS, link], "Comment added.");
  } catch (err) {
    unstable_rethrow(err);
    return toErrorState(err, { body: parsed.data.body });
  }
}

export async function deleteCommentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("commentId") ?? "");
  const c = await prisma.wallComment.findFirst({ where: { id, tenantId: viewer.tenantId, deletedAt: null }, select: { id: true, authorId: true, postId: true, announcementId: true } });
  if (!c) return { ok: false, message: "That comment no longer exists." };
  const own = !!viewer.employee && c.authorId === viewer.employee.id;
  if (!own && !isModerator(viewer)) return { ok: false, message: "Only the author or a wall moderator can delete this comment." };
  await prisma.wallComment.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "WallComment", entityId: c.id, summary: own ? "Deleted their comment" : "Removed a comment" });
  return actionDone([...WALL_PATHS, c.postId ? `/wall/${c.postId}` : `/announcements/${c.announcementId}`], "Comment deleted.");
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

export async function saveWallSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!can(viewer, P.ANNOUNCEMENT_MANAGE)) return { ok: false, message: "Only people who manage announcements can change wall settings." };
  const data = {
    allowPosts: formData.get("allowPosts") === "on", allowPolls: formData.get("allowPolls") === "on",
    allowPraise: formData.get("allowPraise") === "on", allowComments: formData.get("allowComments") === "on",
  };
  const before = await wallSettings(viewer.tenantId);
  await prisma.wallSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "WallSetting", entityId: viewer.tenantId, summary: "Changed wall settings", oldValue: before, newValue: data });
  return actionDone(WALL_PATHS, "Wall settings saved.");
}

// ---------------------------------------------------------------------------
//  AI: help me write
// ---------------------------------------------------------------------------

const polishSchema = z.object({
  draft: z.string().min(3, "Write a few words first, then ask for help").max(POST_MAX),
  kind: z.enum(["POST", "PRAISE"]).default("POST"),
  badge: z.string().max(80).optional().default(""),
  names: z.string().max(400).optional().default(""),
});

/**
 * Rewrites a post or praise draft. Sends only the draft, the badge name and
 * the first names of the people praised; mention tokens must come back as
 * they went in. Without an API key this says so and changes nothing.
 */
export async function polishWallTextAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return noEmployee();
  const parsed = parseForm(polishSchema, formData);
  if (parsed.state) return parsed.state;
  const { draft, kind, badge, names } = parsed.data;
  const firstNames = names.split(",").map((n) => n.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 10).join(", ");
  const prompt = [
    kind === "PRAISE" ? `Praise for: ${firstNames || "a colleague"}${badge ? ` (badge: ${badge})` : ""}.` : "A post for the company wall.",
    "Draft:", draft,
  ].join("\n");
  const result = await aiForViewer(viewer, { feature: "WALL_POLISH", inputChars: prompt.length }, () => aiText({
    system: "You polish short workplace messages for an internal social wall. Keep the author's meaning and facts; never invent details, numbers or names. Warm, specific and plain English, at most 80 words. Tokens of the form @[Name](id) are mentions: keep every one exactly as written. Reply with the rewritten message only.",
    prompt, maxTokens: 400,
  }));
  if (!result.ok) return { ok: false, message: result.reason };
  // A rewrite that drops a mention would silently untag someone: refuse it.
  const before = extractMentions(draft), after = extractMentions(result.value);
  if (before.some((m) => !after.includes(m))) return { ok: false, message: "The suggestion dropped a mention, so it was not used. Try again." };
  return { ok: true, message: "Suggestion ready.", values: { text: result.value.slice(0, POST_MAX) } };
}
