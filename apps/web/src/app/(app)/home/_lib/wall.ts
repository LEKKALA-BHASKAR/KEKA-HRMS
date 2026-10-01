import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { mentionSegments, tallyPoll, type MentionSegment, type PollTally } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { WIDGETS, linksOf, isWidgetColor, isWidgetType, type WidgetColor, type WidgetType, type QuickLink } from "./widgets";

/**
 * Data for Keka Wall and the configurable Home: the feed, single posts,
 * announcement slides, wishes, praise badges, the wall settings and the
 * organisation's Quick Access layout. Everything is tenant-scoped; group
 * posts are visible only to members of that department (and to moderators).
 * People are reduced to directory fields — name, title, photo.
 */

const P = PERMISSIONS;

export interface PersonDto { id: string; name: string; photoUrl: string | null; title: string | null }
const PERSON = { id: true, firstName: true, lastName: true, displayName: true, photoUrl: true, jobTitleName: true } as const;
type PersonRow = { id: string; firstName: string; lastName: string; displayName: string | null; photoUrl: string | null; jobTitleName: string | null };
export const person = (e: PersonRow): PersonDto => ({ id: e.id, name: nameOf(e), photoUrl: e.photoUrl, title: e.jobTitleName });

// ---------------------------------------------------------------------------
//  Settings, groups and badges
// ---------------------------------------------------------------------------

export interface WallSettings { allowPosts: boolean; allowPolls: boolean; allowPraise: boolean; allowComments: boolean }

export async function wallSettings(tenantId: string): Promise<WallSettings> {
  const s = await prisma.wallSetting.findUnique({ where: { tenantId } });
  return { allowPosts: s?.allowPosts ?? true, allowPolls: s?.allowPolls ?? true, allowPraise: s?.allowPraise ?? true, allowComments: s?.allowComments ?? true };
}

/** Moderators can remove any post or comment and see every group's posts. */
export const isModerator = (viewer: Viewer) => can(viewer, P.ANNOUNCEMENT_MANAGE);

export interface WallGroup { id: string; label: string }

/** The viewer's own group on the wall — their department, labelled "Business unit > Department". */
export async function myGroup(viewer: Viewer): Promise<WallGroup | null> {
  if (!viewer.employee) return null;
  const e = await prisma.employee.findFirst({
    where: { id: viewer.employee.id, tenantId: viewer.tenantId },
    select: { department: { select: { id: true, name: true } }, businessUnit: { select: { name: true } } },
  });
  if (!e?.department) return null;
  return { id: e.department.id, label: e.businessUnit ? `${e.businessUnit.name} > ${e.department.name}` : e.department.name };
}

export interface BadgeDto { id: string; name: string; description: string | null; icon: string; color: string }

export async function praiseBadges(tenantId: string): Promise<BadgeDto[]> {
  const rows = await prisma.praiseBadge.findMany({
    where: { tenantId, isActive: true }, orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, icon: true, color: true },
  });
  return rows;
}

/** Projects the viewer works on, for the optional project on a praise. */
export async function myProjects(viewer: Viewer): Promise<Array<{ id: string; name: string }>> {
  if (!viewer.employee) return [];
  return prisma.project.findMany({
    where: {
      tenantId: viewer.tenantId, status: { in: ["ACTIVE", "ON_HOLD"] },
      OR: [{ projectManagerId: viewer.employee.id }, { allocations: { some: { employeeId: viewer.employee.id } } }],
    },
    select: { id: true, name: true }, orderBy: { name: "asc" },
  });
}

/** Everyone the viewer may tag or praise: the directory, minus themselves. */
export async function directoryPeople(viewer: Viewer): Promise<Array<PersonDto & { number: string }>> {
  const rows = await prisma.employee.findMany({
    where: { ...directoryWhere(viewer.tenantId), ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}) },
    select: { ...PERSON, employeeNumber: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return rows.map((r) => ({ ...person(r), number: r.employeeNumber }));
}

// ---------------------------------------------------------------------------
//  Feed
// ---------------------------------------------------------------------------

export type FeedScope = "org" | "group" | "all";
export type FeedKind = "POST" | "POLL" | "PRAISE" | "WISH";

export interface CommentDto { id: string; author: PersonDto; segments: MentionSegment[]; at: string; canDelete: boolean }

export interface PostDto {
  id: string;
  kind: FeedKind;
  author: PersonDto;
  segments: MentionSegment[];
  imageUrl: string | null;
  createdAt: string;
  group: string | null;
  praise: null | {
    recipients: PersonDto[];
    badge: { name: string; color: string; icon: string; description: string | null } | null;
    project: string | null;
    attachments: Array<{ id: string; name: string }>;
  };
  wish: null | { for: PersonDto; occasion: "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE" };
  poll: null | (PollTally & { anonymous: boolean; expiresAt: string | null });
  likes: number;
  likedByMe: boolean;
  commentCount: number;
  comments: CommentDto[];
  canDelete: boolean;
  canComment: boolean;
}

/** Posts this viewer may see: not deleted, org-wide or in their group (moderators see every group). */
export function visiblePostsWhere(viewer: Viewer, groupId: string | null): Prisma.WallPostWhereInput {
  return {
    tenantId: viewer.tenantId,
    deletedAt: null,
    // A praise post whose praise rows were removed has nothing left to show.
    NOT: { kind: "PRAISE", praises: { none: {} } },
    ...(isModerator(viewer) ? {} : { OR: [{ departmentId: null }, ...(groupId ? [{ departmentId: groupId }] : [])] }),
  };
}

const POST_INCLUDE = (viewerEmployeeId: string | null, commentsTake: number) => ({
  author: { select: PERSON },
  department: { select: { name: true } },
  wishFor: { select: PERSON },
  praises: {
    orderBy: { createdAt: "asc" as const },
    select: {
      toEmployee: { select: PERSON }, badge: true,
      badgeRef: { select: { name: true, color: true, icon: true, description: true } },
      project: { select: { name: true } },
    },
  },
  pollOptions: { select: { id: true, label: true, position: true } },
  pollVotes: { select: { optionId: true, employeeId: true, employee: { select: { firstName: true, lastName: true, displayName: true } } } },
  likes: { where: { employeeId: viewerEmployeeId ?? "__none__" }, select: { id: true } },
  comments: {
    where: { deletedAt: null }, orderBy: { createdAt: "desc" as const }, take: commentsTake,
    select: { id: true, body: true, createdAt: true, authorId: true, author: { select: PERSON } },
  },
  _count: { select: { likes: true, comments: { where: { deletedAt: null } } } },
});

type PostRow = Prisma.WallPostGetPayload<{ include: ReturnType<typeof POST_INCLUDE> }>;

async function toDtos(viewer: Viewer, rows: PostRow[], settings: WallSettings): Promise<PostDto[]> {
  const me = viewer.employee?.id ?? null;
  const mod = isModerator(viewer);
  const attachments = rows.some((r) => r.kind === "PRAISE")
    ? await prisma.storedFile.findMany({
        where: { tenantId: viewer.tenantId, relatedType: "WallPostAttachment", relatedId: { in: rows.map((r) => r.id) } },
        select: { id: true, filename: true, relatedId: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  return rows.map((r) => {
    const first = r.praises[0];
    const badge = first?.badgeRef ?? (first?.badge ? { name: first.badge, color: "#F5B83D", icon: "star", description: null } : null);
    return {
      id: r.id,
      kind: r.kind,
      author: person(r.author),
      segments: mentionSegments(r.body),
      imageUrl: r.imageUrl,
      createdAt: r.createdAt.toISOString(),
      group: r.department?.name ?? null,
      praise: r.kind === "PRAISE" ? {
        recipients: r.praises.map((p) => person(p.toEmployee)),
        badge,
        project: first?.project?.name ?? null,
        attachments: attachments.filter((a) => a.relatedId === r.id).map((a) => ({ id: a.id, name: a.filename })),
      } : null,
      wish: r.kind === "WISH" && r.wishFor && r.wishOccasion ? { for: person(r.wishFor), occasion: r.wishOccasion } : null,
      poll: r.kind === "POLL" ? {
        ...tallyPoll(
          r.pollOptions,
          r.pollVotes.map((v) => ({ optionId: v.optionId, employeeId: v.employeeId, voterName: r.pollAnonymous ? undefined : nameOf(v.employee) })),
          me, r.pollAnonymous, r.pollExpiresAt,
        ),
        anonymous: r.pollAnonymous,
        expiresAt: r.pollExpiresAt?.toISOString() ?? null,
      } : null,
      likes: r._count.likes,
      likedByMe: r.likes.length > 0,
      commentCount: r._count.comments,
      comments: [...r.comments].reverse().map((c) => ({
        id: c.id, author: person(c.author), segments: mentionSegments(c.body), at: c.createdAt.toISOString(),
        canDelete: c.authorId === me || mod,
      })),
      canDelete: r.authorId === me || mod,
      canComment: settings.allowComments && !!me,
    };
  });
}

export async function loadFeed(viewer: Viewer, opts: {
  scope: FeedScope; group: WallGroup | null; kind?: FeedKind | null; cursor?: string | null; take?: number;
  authorId?: string; involvingEmployeeId?: string; commentsTake?: number;
}): Promise<{ posts: PostDto[]; next: string | null }> {
  const take = opts.take ?? 10;
  const settings = await wallSettings(viewer.tenantId);
  const where: Prisma.WallPostWhereInput = {
    AND: [
      visiblePostsWhere(viewer, opts.group?.id ?? null),
      opts.scope === "org" ? { departmentId: null } : {},
      opts.scope === "group" ? { departmentId: opts.group?.id ?? "__none__" } : {},
      opts.kind ? { kind: opts.kind } : {},
      opts.authorId ? { authorId: opts.authorId } : {},
      opts.involvingEmployeeId ? {
        OR: [
          { authorId: opts.involvingEmployeeId },
          { wishForId: opts.involvingEmployeeId },
          { praises: { some: { toEmployeeId: opts.involvingEmployeeId } } },
        ],
      } : {},
    ],
  };
  const rows = await prisma.wallPost.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: POST_INCLUDE(viewer.employee?.id ?? null, opts.commentsTake ?? 2),
  });
  const page = rows.slice(0, take);
  return { posts: await toDtos(viewer, page, settings), next: rows.length > take ? page[page.length - 1].id : null };
}

/** One post the viewer may see, with all its comments; null otherwise. */
export async function loadPost(viewer: Viewer, id: string): Promise<PostDto | null> {
  const group = await myGroup(viewer);
  const settings = await wallSettings(viewer.tenantId);
  const row = await prisma.wallPost.findFirst({
    where: { AND: [{ id }, visiblePostsWhere(viewer, group?.id ?? null)] },
    include: POST_INCLUDE(viewer.employee?.id ?? null, 200),
  });
  if (!row) return null;
  return (await toDtos(viewer, [row], settings))[0];
}

// ---------------------------------------------------------------------------
//  Announcements
// ---------------------------------------------------------------------------

export interface AnnouncementSlide {
  id: string; title: string; segments: MentionSegment[]; excerpt: string; bannerUrl: string | null; date: string;
  pinned: boolean; requireAck: boolean; acknowledged: boolean; likes: number; likedByMe: boolean; comments: number; acks: number;
}

interface Audience { departmentIds?: string[]; locationIds?: string[]; businessUnitIds?: string[]; workerTypeIds?: string[]; excludeOnNotice?: boolean }
type Placement = { status: string; departmentId: string | null; locationId: string | null; businessUnitId: string | null; workerTypeId: string | null } | null;

export function inAudience(raw: unknown, me: Placement): boolean {
  if (!raw || typeof raw !== "object") return true;
  const a = raw as Audience;
  const match = (list: string[] | undefined, value: string | null | undefined) =>
    !Array.isArray(list) || list.length === 0 || (!!value && list.includes(value));
  if (!me) return !(a.departmentIds?.length || a.locationIds?.length || a.businessUnitIds?.length || a.workerTypeIds?.length);
  if (a.excludeOnNotice && me.status === "NOTICE_PERIOD") return false;
  return match(a.departmentIds, me.departmentId) && match(a.locationIds, me.locationId)
    && match(a.businessUnitIds, me.businessUnitId) && match(a.workerTypeIds, me.workerTypeId);
}

export async function placementOf(viewer: Viewer): Promise<Placement> {
  if (!viewer.employee) return null;
  return prisma.employee.findFirst({
    where: { id: viewer.employee.id, tenantId: viewer.tenantId },
    select: { status: true, departmentId: true, locationId: true, businessUnitId: true, workerTypeId: true },
  });
}

/** Live announcements addressed to the viewer, pinned first, with their engagement counts. */
export async function announcementSlides(viewer: Viewer, take = 6): Promise<AnnouncementSlide[]> {
  const me = await placementOf(viewer);
  const now = new Date();
  const empId = viewer.employee?.id ?? "__none__";
  const rows = await prisma.announcement.findMany({
    where: {
      tenantId: viewer.tenantId, status: "PUBLISHED",
      AND: [{ OR: [{ publishAt: null }, { publishAt: { lte: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: [{ isPinned: "desc" }, { publishAt: "desc" }, { createdAt: "desc" }],
    take: 30,
    select: {
      id: true, title: true, body: true, bannerUrl: true, publishAt: true, createdAt: true, isPinned: true, requireAck: true, audience: true,
      reads: { where: { employeeId: empId }, select: { acknowledgedAt: true } },
      likes: { where: { employeeId: empId }, select: { id: true } },
      _count: { select: { likes: true, comments: { where: { deletedAt: null } }, reads: { where: { acknowledgedAt: { not: null } } } } },
    },
  });
  return rows.filter((r) => inAudience(r.audience, me)).slice(0, take).map((r) => {
    const text = r.body.replace(/\s+/g, " ").trim();
    return {
      id: r.id, title: r.title, segments: mentionSegments(r.body),
      excerpt: text.length > 260 ? `${text.slice(0, 257).trimEnd()}…` : text,
      bannerUrl: r.bannerUrl, date: (r.publishAt ?? r.createdAt).toISOString(),
      pinned: r.isPinned, requireAck: r.requireAck, acknowledged: r.reads.some((x) => !!x.acknowledgedAt),
      likes: r._count.likes, likedByMe: r.likes.length > 0, comments: r._count.comments, acks: r._count.reads,
    };
  });
}

/**
 * One announcement for its details page: visible if published to the viewer's
 * audience (live or closed), or to anyone who manages announcements.
 */
export async function announcementDetail(viewer: Viewer, id: string) {
  const empId = viewer.employee?.id ?? "__none__";
  const a = await prisma.announcement.findFirst({
    where: { id, tenantId: viewer.tenantId },
    select: {
      id: true, title: true, body: true, bannerUrl: true, status: true, publishAt: true, createdAt: true, expiresAt: true,
      requireAck: true, isPinned: true, audience: true, createdBy: true,
      reads: { where: { employeeId: empId }, select: { acknowledgedAt: true } },
      likes: { where: { employeeId: empId }, select: { id: true } },
      comments: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, body: true, createdAt: true, authorId: true, author: { select: PERSON } } },
      _count: { select: { likes: true, reads: { where: { acknowledgedAt: { not: null } } } } },
    },
  });
  if (!a) return null;
  const manage = can(viewer, P.ANNOUNCEMENT_MANAGE);
  const published = a.status === "PUBLISHED" || a.status === "EXPIRED" || a.status === "ARCHIVED";
  const started = !a.publishAt || a.publishAt <= new Date();
  if (!manage && (!published || !started || !inAudience(a.audience, await placementOf(viewer)))) return null;
  const author = a.createdBy
    ? await prisma.employee.findFirst({ where: { id: a.createdBy, tenantId: viewer.tenantId }, select: PERSON })
    : null;
  const closed = a.status === "EXPIRED" || a.status === "ARCHIVED" || (!!a.expiresAt && a.expiresAt <= new Date());
  const settings = await wallSettings(viewer.tenantId);
  return {
    id: a.id, title: a.title, segments: mentionSegments(a.body), bannerUrl: a.bannerUrl,
    date: (a.publishAt ?? a.createdAt).toISOString(), closed, requireAck: a.requireAck,
    acknowledged: a.reads.some((r) => !!r.acknowledgedAt), acks: a._count.reads,
    likes: a._count.likes, likedByMe: a.likes.length > 0,
    author: author ? person(author) : null,
    comments: a.comments.map((c) => ({
      id: c.id, author: person(c.author), segments: mentionSegments(c.body), at: c.createdAt.toISOString(),
      canDelete: c.authorId === viewer.employee?.id || manage,
    })) satisfies CommentDto[],
    canComment: settings.allowComments && !!viewer.employee && !closed,
  };
}

// ---------------------------------------------------------------------------
//  Wishes
// ---------------------------------------------------------------------------

export async function wishesFor(viewer: Viewer, employeeId: string, occasion: "BIRTHDAY" | "WORK_ANNIVERSARY" | "NEW_JOINEE", year: number) {
  const rows = await prisma.wallPost.findMany({
    where: { tenantId: viewer.tenantId, kind: "WISH", deletedAt: null, wishForId: employeeId, wishOccasion: occasion, wishYear: year },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, createdAt: true, authorId: true, author: { select: PERSON } },
  });
  return rows.map((r) => ({ id: r.id, author: person(r.author), segments: mentionSegments(r.body), at: r.createdAt.toISOString(), mine: r.authorId === viewer.employee?.id }));
}

/** Which of these people the viewer has already wished for the occasion this year. */
export async function wishedBy(viewer: Viewer, year: number): Promise<Set<string>> {
  if (!viewer.employee) return new Set();
  const rows = await prisma.wallPost.findMany({
    where: { tenantId: viewer.tenantId, kind: "WISH", deletedAt: null, authorId: viewer.employee.id, wishYear: year },
    select: { wishForId: true, wishOccasion: true },
  });
  return new Set(rows.map((r) => `${r.wishOccasion}:${r.wishForId}`));
}

// ---------------------------------------------------------------------------
//  Quick Access layout
// ---------------------------------------------------------------------------

export interface WidgetSlot { type: WidgetType; color: WidgetColor; links: QuickLink[]; stored: boolean }

/** The organisation's Quick Access widgets in order; the default layout until someone edits it. */
export async function dashboardLayout(tenantId: string): Promise<WidgetSlot[]> {
  const rows = await prisma.dashboardWidget.findMany({ where: { tenantId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  if (rows.length === 0) {
    return WIDGETS.filter((w) => w.standard).map((w) => ({
      type: w.type, color: w.color, stored: false,
      links: w.type === "QUICK_LINKS" ? [{ label: "Helpdesk", url: "/me/helpdesk" }, { label: "Documents", url: "/documents" }] : [],
    }));
  }
  return rows
    .filter((r) => isWidgetType(r.type))
    .map((r) => ({ type: r.type as WidgetType, color: isWidgetColor(r.color) ? r.color : "plain", links: linksOf(r.config), stored: true }));
}
