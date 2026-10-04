import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { defaultWish, wishWindowOpen } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { Avatar } from "@/components/avatar";
import { istToday, myPlacement, celebrations, holidayYear, type Today } from "./home/_lib/data";
import {
  dashboardLayout, myGroup, wallSettings, praiseBadges, myProjects, directoryPeople, announcementSlides, loadFeed, wishesFor, wishedBy,
} from "./home/_lib/wall";
import { WIDGET_BY_TYPE, isWidgetType } from "./home/_lib/widgets";
import { buildQuickAccess } from "./home/_components/widgets";
import { QuickAccess } from "./home/_components/quick-access";
import { Composer, type ComposerTab } from "./home/_components/composer";
import { AnnouncementCarousel } from "./home/_components/announcement-carousel";
import { Celebrations } from "./home/_components/celebrations";
import { Feed, Segments, Ago } from "./home/_components/feed";
import { UrlDialog } from "./home/_components/url-dialog";
import { AddWidgetList, WidgetSettingsForm } from "./home/_components/widget-admin";
import { WishForm } from "./home/_components/wish-form";
import { SignInPulse } from "./home/_components/pulse-card";
import { IconInfo, IconChevronLeft, IconChevronRight } from "./home/_components/icons";
import d from "./home/dash.module.css";

export const metadata = { title: "Dashboard — BooS-HR" };

const P = PERMISSIONS;
const MONTH = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEPT", "OCT", "NOV", "DEC"];
// One colour per month for the date tiles, dark enough for white text.
const MONTH_INK = ["#3b8ea5", "#d0605f", "#9c8562", "#5b84c4", "#b07d14", "#7f6bb3", "#4f9a5b", "#a2549a", "#2f8f91", "#c9524f", "#8c7b57", "#3f73b5"];

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Home → Dashboard, as Keka lays it out: Quick Access widgets on the left
 * (configurable for the whole organisation by an administrator), Keka Wall on
 * the right — group tabs, the Post · Poll · Praise composer, announcements,
 * celebrations, then the feed.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const today = istToday();
  const me = await myPlacement(viewer);
  const canEdit = can(viewer, P.ORG_SETTINGS_MANAGE);
  const editing = canEdit && one(sp.edit) === "widgets";
  const take = Math.min(100, Math.max(10, Number(one(sp.take)) || 10));

  const [slots, group, settings] = await Promise.all([dashboardLayout(viewer.tenantId), myGroup(viewer), wallSettings(viewer.tenantId)]);
  const scope = one(sp.feed) === "group" && group ? "group" : "org";
  const employee = !!viewer.employee;
  const tabs: ComposerTab[] = employee ? [
    ...(settings.allowPosts ? ["post" as const] : []),
    ...(settings.allowPolls ? ["poll" as const] : []),
    ...(settings.allowPraise && can(viewer, P.PRAISE_GIVE) ? ["praise" as const] : []),
  ] : [];
  const composeRaw = one(sp.compose);
  const compose = (["post", "poll", "praise"] as const).find((t) => t === composeRaw) ?? null;

  const [items, people, badges, projects, slides, groups, wished, feed] = await Promise.all([
    buildQuickAccess(viewer, slots, today, { editing, locationId: me?.locationId }),
    tabs.length ? directoryPeople(viewer) : Promise.resolve([]),
    tabs.includes("praise") ? praiseBadges(viewer.tenantId) : Promise.resolve([]),
    tabs.includes("praise") ? myProjects(viewer) : Promise.resolve([]),
    can(viewer, P.ANNOUNCEMENT_VIEW) ? announcementSlides(viewer) : Promise.resolve([]),
    celebrations(viewer, today),
    wishedBy(viewer, today.year),
    loadFeed(viewer, { scope, group, take }),
  ]);

  const base = (extra: Record<string, string | null>) => {
    const q = new URLSearchParams();
    if (scope === "group") q.set("feed", "group");
    for (const [k, v] of Object.entries(extra)) if (v !== null) q.set(k, v);
    const s = q.toString();
    return s ? `/?${s}` : "/";
  };
  const isoDay = (offset: number) => new Date(today.date.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className={d.page}>
      <div className={d.grid}>
        <QuickAccess items={items} canEdit={canEdit} editing={editing} />

        <section className={d.right} aria-label="Company wall">
          <nav className={d.groups} aria-label="Wall groups">
            <Link href="/" aria-current={scope === "org" ? "page" : undefined} scroll={false}>Organization</Link>
            {group ? <Link href="/?feed=group" aria-current={scope === "group" ? "page" : undefined} scroll={false}>{group.label}</Link> : null}
          </nav>
          <SignInPulse viewer={viewer} />
          {tabs.length ? (
            <Composer
              key={compose ?? "none"} tabs={tabs} initial={compose} group={group}
              people={people.map((p) => ({ id: p.id, name: p.name, title: p.title, number: p.number, photoUrl: p.photoUrl }))}
              badges={badges} projects={projects} tomorrow={isoDay(1)} maxDate={isoDay(90)}
            />
          ) : null}
          {can(viewer, P.ANNOUNCEMENT_VIEW) ? (
            <AnnouncementCarousel slides={slides} canManage={can(viewer, P.ANNOUNCEMENT_MANAGE)} canAct={employee} />
          ) : null}
          <Celebrations groups={groups} wished={[...wished]} selfId={viewer.employee?.id ?? null} canWish={employee} />
          <Feed
            posts={feed.posts} next={feed.next} moreHref={feed.next ? base({ take: String(take + 10) }) : null}
            empty={scope === "group" ? "Nothing posted in your group yet. Be the first — choose your group under Posting to." : "Nothing on the wall yet. Share an update, run a poll or praise a colleague."}
          />
        </section>
      </div>

      {editing && one(sp.add) === "1" ? (
        <UrlDialog title="Add Widget" closeHref="/?edit=widgets" side width={720}>
          <AddWidgetList present={slots.map((s) => s.type)} />
        </UrlDialog>
      ) : null}
      {editing && isWidgetType(one(sp.widget)) ? (() => {
        const type = one(sp.widget) as Parameters<typeof WIDGET_BY_TYPE.get>[0];
        const slot = slots.find((s) => s.type === type);
        if (!slot) return null;
        return (
          <UrlDialog title={`${WIDGET_BY_TYPE.get(type)!.title} settings`} closeHref="/?edit=widgets" side width={520}>
            <WidgetSettingsForm type={type} color={slot.color} links={slot.links} closeHref="/?edit=widgets" />
          </UrlDialog>
        );
      })() : null}
      {one(sp.holidays) ? <HolidaysModal viewerYear={Number(one(sp.holidays))} today={today} locationId={me?.locationId} closeHref={base({})} /> : null}
      {one(sp.wish) ? <WishDrawer id={one(sp.wish)} occasion={one(sp.for)} today={today} closeHref={base({})} /> : null}
    </div>
  );
}

async function HolidaysModal({ viewerYear, today, locationId, closeHref }: { viewerYear: number; today: Today; locationId: string | null | undefined; closeHref: string }) {
  const viewer = await requireViewer();
  const year = Number.isInteger(viewerYear) && viewerYear > 2000 && viewerYear < 2100 ? viewerYear : today.year;
  const { rows, years } = await holidayYear(viewer, year, locationId, today);
  const prev = years.filter((y) => y < year).pop();
  const next = years.find((y) => y > year);
  const half = Math.ceil(rows.length / 2);
  const cols = [rows.slice(0, half), rows.slice(half)];
  const yearNav = (
    <span className={d.hYear}>
      {prev ? <Link href={`/?holidays=${prev}`} aria-label={`Holidays in ${prev}`} scroll={false}><IconChevronLeft /></Link> : <span aria-disabled="true"><IconChevronLeft /></span>}
      <span>{year}</span>
      {next ? <Link href={`/?holidays=${next}`} aria-label={`Holidays in ${next}`} scroll={false}><IconChevronRight /></Link> : <span aria-disabled="true"><IconChevronRight /></span>}
    </span>
  );
  return (
    <UrlDialog title="Holidays" headExtra={yearNav} closeHref={closeHref} width={760}>
      {rows.length === 0 ? <p className="muted">No holiday calendar for {year}.</p> : (
        <div className={d.hCols}>
          {cols.map((col, c) => (
            <ul key={c} className={d.hList}>
              {col.map((h) => (
                <li key={h.id} className={`${d.hItem}${h.past ? ` ${d.past}` : ""}`}>
                  <span className={d.tile} aria-hidden="true">
                    <span style={{ background: MONTH_INK[h.month] }}>{MONTH[h.month]}</span>
                    <span>{String(h.day).padStart(2, "0")}</span>
                  </span>
                  <span className={d.hText}>
                    <span><strong>{h.name}</strong><small>{h.weekday}</small></span>
                    {h.optional ? <span className={`${d.floater} ${d.floaterInk}`}>Floater leave</span> : null}
                  </span>
                  <span className="sr-only">{h.day} {MONTH[h.month]} {year}{h.past ? ", past" : ""}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
    </UrlDialog>
  );
}

async function WishDrawer({ id, occasion: raw, today, closeHref }: { id: string; occasion: string; today: Today; closeHref: string }) {
  const viewer = await requireViewer();
  const occasion = raw === "WORK_ANNIVERSARY" || raw === "NEW_JOINEE" ? raw : "BIRTHDAY";
  const who = await prisma.employee.findFirst({
    where: { ...directoryWhere(viewer.tenantId), id },
    select: { id: true, firstName: true, lastName: true, displayName: true, photoUrl: true, jobTitleName: true, dateOfBirth: true, dateOfJoining: true },
  });
  if (!who) notFound();
  const name = nameOf(who);
  const open = wishWindowOpen(occasion, who, today.date);
  const wishes = await wishesFor(viewer, who.id, occasion, today.year);
  const mine = wishes.some((w) => w.mine);
  const self = viewer.employee?.id === who.id;
  const line = occasion === "BIRTHDAY" ? "Wish them a happy birthday" : occasion === "WORK_ANNIVERSARY" ? "Wish them a happy work anniversary" : "Give them a warm welcome";
  return (
    <UrlDialog title={<span className="sr-only">Wish {name}</span>} closeHref={closeHref} side width={600}>
      <div className={d.wishHero}>
        <svg className={d.confetti} viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
          {Array.from({ length: 26 }, (_, i) => <path key={i} d={`M${(i * 97) % 600} ${(i * 53) % 170} q6 -6 12 0`} stroke={["#7c5cc4", "#a78bfa", "#312e81"][i % 3]} strokeWidth="2.4" fill="none" />)}
        </svg>
        <Avatar name={name} photoUrl={who.photoUrl} size={68} />
        <h3>{name}</h3>
        <p>{who.jobTitleName ?? ""}</p>
        <p>{line}</p>
      </div>
      {self ? <p className="muted" style={{ marginTop: 18 }}>These are the wishes your colleagues have sent you.</p>
        : !open ? <div className={d.firstWish}><IconInfo width={16} height={16} /> There is nothing to celebrate for {name} today.</div>
        : mine ? <div className={d.firstWish}><IconInfo width={16} height={16} /> You have wished {name}.</div>
        : (
          <>
            {wishes.length === 0 ? <div className={d.firstWish}><IconInfo width={16} height={16} /> Be the first one to wish {name}</div> : <div style={{ height: 18 }} />}
            {viewer.employee ? (
              <WishForm employeeId={who.id} occasion={occasion} initial={defaultWish(occasion, name)} closeHref={closeHref}
                me={{ name: viewer.employee.displayName, photoUrl: viewer.employee.photoUrl }} />
            ) : null}
          </>
        )}
      <div className={d.received}>
        <h4>Wishes Received ({wishes.length})</h4>
        <div className="stack gap-3">
          {wishes.map((w) => (
            <div key={w.id} className={d.comment}>
              <Avatar name={w.author.name} photoUrl={w.author.photoUrl} size={32} />
              <div className={d.commentBubble}>
                <Link href={`/directory/${w.author.id}`}>{w.author.name}</Link>
                <div className={d.commentText}><Segments segments={w.segments} /></div>
                <div className={d.commentMeta}><Ago iso={w.at} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </UrlDialog>
  );
}
