import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { MONTH_SHORT } from "@keka/shared";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { teamAttention, operationsAttention, nextPayDate, type AttentionItem } from "@/lib/attention";
import { Avatar } from "@/components/avatar";
import { Ring } from "@/components/keka";
import { BannerArt, HolidayArt } from "./home/_components/banner-art";
import { HolidayCarousel } from "./home/_components/holidays";
import { Celebrations } from "./home/_components/celebrations";
import { PraiseComposer } from "./home/_components/praise";
import { LiveClock, ClockButton } from "./home/_components/clock";
import { IconMedal, IconCheckCircle, IconChevronRight, IconPin } from "./home/_components/icons";
import {
  istToday, istTime, dayLabel, myPlacement, onLeaveToday, myLeaveBalances, upcomingHolidays,
  inboxSummary, myOpenRequests, myPunchesToday, liveAnnouncements, celebrations, recentPraise,
  praiseableColleagues, type Today, type BalanceRing, type InboxLine, type AnnouncementLite, type PersonLite,
} from "./home/_lib/data";
import s from "./home/home.module.css";

export const metadata = { title: "Dashboard — Keka" };

const P = PERMISSIONS;

/**
 * Home → Dashboard, laid out like Keka's: a welcome banner, "Quick Access" on
 * the left (time today, who is off, balances, holidays, inbox) and the
 * organisation's pulse on the right (praise, announcements, celebrations).
 * Managers and HR also get the "what needs my attention" lists on top.
 */
export default async function DashboardPage() {
  const viewer = await requireViewer();
  const today = istToday();
  const me = await myPlacement(viewer);
  const canSeePeople = can(viewer, P.EMPLOYEE_VIEW_ALL);
  const canPraise = !!viewer.employee && can(viewer, P.PRAISE_GIVE);

  const [
    punches, payDay, openRequests, offToday, balances, holidays, inbox,
    announcements, groups, praise, colleagues, team, ops, byStatus,
  ] = await Promise.all([
    myPunchesToday(viewer, today),
    nextPayDate(viewer),
    myOpenRequests(viewer),
    onLeaveToday(viewer, today),
    myLeaveBalances(viewer, today),
    upcomingHolidays(viewer, today, me?.locationId),
    inboxSummary(viewer),
    can(viewer, P.ANNOUNCEMENT_VIEW) ? liveAnnouncements(viewer, me, 3) : Promise.resolve([]),
    celebrations(viewer, today),
    can(viewer, P.AWARD_VIEW) ? recentPraise(viewer, 3) : Promise.resolve([]),
    canPraise ? praiseableColleagues(viewer) : Promise.resolve([]),
    teamAttention(viewer),
    operationsAttention(viewer),
    canSeePeople
      ? prisma.employee.groupBy({ by: ["status"], where: { tenantId: viewer.tenantId, status: { not: "EXITED" } }, _count: true })
      : Promise.resolve([] as Array<{ status: string; _count: number }>),
  ]);

  const name = viewer.employee?.displayName ?? viewer.user.email;
  const statusCount = (st: string) => byStatus.find((b) => b.status === st)?._count ?? 0;
  const headcount = byStatus.reduce((a, b) => a + b._count, 0);

  return (
    <div className={s.page}>
      <section className={s.banner} aria-label="Welcome">
        <BannerArt id="dash-banner" className={s.bannerArt} />
        <h1 className={s.bannerTitle}>Welcome {name}!</h1>
      </section>

      <div className={s.grid}>
        <h2 className={s.quickTitle}>Quick Access</h2>

        <div className={`${s.col} ${s.left}`}>
          {viewer.employee ? (
            <TimeToday today={today} punches={punches} payDay={payDay} openRequests={openRequests} />
          ) : null}
          <OnLeaveToday people={offToday} />
          {viewer.employee ? <LeaveBalances balances={balances} /> : null}
          <Holidays holidays={holidays} />
          <Inbox lines={inbox} />
        </div>

        <div className={`${s.col} ${s.right}`}>
          {ops.length > 0 ? (
            <Attention
              title={`${ops.filter((i) => i.severity !== "green").length} things need attention`}
              subtitle={canSeePeople
                ? `Across the people you look after · ${headcount} active, ${statusCount("PROBATION")} on probation, ${statusCount("NOTICE_PERIOD")} serving notice`
                : "Across the people you look after"}
              items={ops}
            />
          ) : null}
          {team.length > 0 ? (
            <Attention title="Your team today" subtitle={`${viewer.allReportIds.size} ${viewer.allReportIds.size === 1 ? "person reports" : "people report"} to you`} items={team} />
          ) : null}
          <Praise viewer={viewer} canPraise={canPraise} colleagues={colleagues} feed={praise} />
          <Announcements items={announcements} />
          <Celebrations groups={groups} />
        </div>
      </div>
    </div>
  );
}

// --- Quick Access -------------------------------------------------------------

function TimeToday({ today, punches, payDay, openRequests }: {
  today: Today; punches: Array<{ timestamp: Date; direction: number }>; payDay: Date | null; openRequests: number;
}) {
  const now = Date.now();
  const last = punches[punches.length - 1];
  const clockedIn = last?.direction === 0;
  // Pair the punches to get time worked so far today.
  let worked = 0, inAt: number | null = null;
  for (const p of punches) {
    if (p.direction === 0) inAt ??= p.timestamp.getTime();
    else if (inAt !== null) { worked += p.timestamp.getTime() - inAt; inAt = null; }
  }
  if (inAt !== null) worked += now - inAt;
  const hm = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
  const payIn = payDay ? Math.max(0, Math.ceil((payDay.getTime() - now) / 86_400_000)) : null;

  return (
    <section className={`${s.card} ${s.timeCard}`} aria-labelledby="time-today">
      <div className={s.cardHead}>
        <div>
          <h3 id="time-today" className={s.cardTitle}>Time Today</h3>
          <div className={s.cardSub}>{dayLabel(today.date)}</div>
        </div>
        <Link href="/me/attendance" className={s.link}>View All</Link>
      </div>
      <div className={s.timeRow}>
        <div>
          <div className={s.label}>Current time</div>
          <LiveClock initial={new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase()} />
          <div className={s.timeStatus}>
            <span className={`${s.statusDot}${clockedIn ? ` ${s.in}` : ""}`} aria-hidden="true" />
            <span>
              {!last ? "Not clocked in yet"
                : clockedIn ? `Clocked in since ${istTime(last.timestamp)}`
                : `Clocked out at ${istTime(last.timestamp)}`}
              {worked > 0 ? ` · ${hm(worked)} worked` : ""}
            </span>
          </div>
        </div>
        <ClockButton direction={clockedIn ? "out" : "in"} />
      </div>
      <div className={s.facts}>
        <Link href="/me/pay" className={s.fact}>
          Next salary <strong>{payDay ? `${String(payDay.getUTCDate()).padStart(2, "0")} ${MONTH_SHORT[payDay.getUTCMonth()]}` : "—"}</strong>
          {payIn === null ? " · no pay group" : payIn === 0 ? " · today" : ` · in ${payIn} ${payIn === 1 ? "day" : "days"}`}
        </Link>
        <Link href="/me/leave" className={s.fact}>
          Your open requests <strong>{openRequests}</strong>
        </Link>
        <Link href="/me/helpdesk?new=1" className={s.fact}><strong>Ask HR</strong></Link>
      </div>
    </section>
  );
}

function OnLeaveToday({ people }: { people: Array<PersonLite & { partial: boolean }> }) {
  return (
    <section className={s.card} aria-labelledby="on-leave">
      <div className={s.cardHead}>
        <h3 id="on-leave" className={s.cardTitle}>On Leave Today</h3>
        {people.length > 0 ? <span className={s.muted}>{people.length} {people.length === 1 ? "person" : "people"}</span> : null}
      </div>
      {people.length === 0 ? (
        <p className={s.muted} style={{ margin: 0 }}>No one is on leave today.</p>
      ) : (
        <ul className={s.people} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {people.map((p) => (
            <li key={p.id}>
              <Link href={`/directory/${p.id}`} className={s.personTile} title={`${p.name}${p.partial ? " (part of the day)" : ""}`}>
                <span className={s.avatarWrap}>
                  <Avatar name={p.name} photoUrl={p.photoUrl} size={48} />
                  {p.partial ? <span className={s.halfDot} aria-hidden="true" /> : null}
                </span>
                <span className={s.personName}>{p.firstName}</span>
                {p.partial ? <span className="sr-only">, part of the day</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LeaveBalances({ balances }: { balances: BalanceRing[] }) {
  const shown = balances.slice(0, 3);
  return (
    <section className={s.card} aria-labelledby="leave-balances">
      <div className={s.cardHead}>
        <h3 id="leave-balances" className={s.cardTitle}>Leave Balances</h3>
      </div>
      <div className={s.balances}>
        {shown.length === 0 ? (
          <p className={s.muted} style={{ margin: 0 }}>No leave balances for this leave year yet.</p>
        ) : (
          <ul className={s.rings} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {shown.map((b) => {
              const days = Number.isInteger(b.available) ? String(b.available) : b.available.toFixed(1);
              return (
                <li key={b.id} className={s.ringItem}>
                  <Ring value={b.available} max={b.total} size={86} stroke={6} colour="var(--brand-500)" track="var(--brand-100)">
                    <span>
                      <span className={s.ringNum}>{days}</span>
                      <span className={s.ringUnit}>{b.available === 1 ? "Day" : "Days"}</span>
                    </span>
                  </Ring>
                  <span className={s.ringName}>{b.name}</span>
                  <span className="sr-only">{days} of {b.total} days available</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className={s.balanceLinks}>
          <Link href="/me/leave?apply=1" className={s.link}>Request Leave</Link>
          <Link href="/me/leave" className={s.link}>View All Balances</Link>
        </div>
      </div>
    </section>
  );
}

function Holidays({ holidays }: { holidays: Awaited<ReturnType<typeof upcomingHolidays>> }) {
  return (
    <section className={`${s.card} ${s.holidayCard}`} aria-labelledby="holidays">
      <HolidayArt className={s.holidayArt} />
      <div className={`${s.cardHead} ${s.holidayHead}`}>
        <h3 id="holidays" className={s.cardTitle}>Holidays</h3>
        <Link href="/me/leave" className={s.link} aria-label="View all holidays">View All</Link>
      </div>
      {holidays.length === 0 ? (
        <p className={s.muted} style={{ margin: 0, position: "relative" }}>No upcoming holidays on your calendar.</p>
      ) : (
        <HolidayCarousel holidays={holidays} />
      )}
    </section>
  );
}

function Inbox({ lines }: { lines: InboxLine[] }) {
  const total = lines.reduce((a, l) => a + l.count, 0);
  return (
    <section className={s.card} aria-labelledby="inbox-card">
      <div className={s.cardHead}>
        <div>
          <h3 id="inbox-card" className={s.cardTitle}>Inbox</h3>
          {total > 0 ? <div className={s.cardSub}>{total} {total === 1 ? "item needs" : "items need"} your action</div> : null}
        </div>
        <Link href="/inbox" className={s.link}>Go to Inbox</Link>
      </div>
      {lines.length === 0 ? (
        <div className={s.allClear}>
          <IconCheckCircle />
          <div><strong>Good job!</strong>You have no pending actions.</div>
        </div>
      ) : (
        <div className={s.list}>
          {lines.map((l) => (
            <Link key={l.key} href={l.href} className={s.listRow}>
              <span className={s.listLabel}>{l.label}</span>
              <span className={s.count}>{l.count}</span>
              <span className={s.chev} aria-hidden="true"><IconChevronRight width={16} height={16} /></span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// --- Right column -----------------------------------------------------------------

function Attention({ title, subtitle, items }: { title: string; subtitle: string; items: AttentionItem[] }) {
  const colour = { red: "var(--danger)", amber: "var(--warning)", green: "var(--success)" };
  return (
    <section className={`${s.card} ${s.flush}`} aria-label={title}>
      <div className={s.attnHead}>
        <div>
          <h3 className={s.cardTitle}>{title}</h3>
          <div className={s.cardSub}>{subtitle}</div>
        </div>
      </div>
      <div>
        {items.map((i, k) => (
          <Link key={k} href={i.href} className={s.attnRow}>
            <span className={s.attnDot} style={{ background: colour[i.severity] }} aria-hidden="true" />
            <span className={s.attnText}>
              <span className={s.attnTitle}>{i.title}</span>
              <span className={s.attnDetail}>{i.detail}</span>
            </span>
            <span className="sr-only">{i.severity === "red" ? "Urgent" : i.severity === "amber" ? "Needs action" : "For information"}</span>
            <span className={s.chev} aria-hidden="true"><IconChevronRight width={16} height={16} /></span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Praise({ viewer, canPraise, colleagues, feed }: {
  viewer: Viewer; canPraise: boolean; colleagues: Array<{ id: string; name: string }>;
  feed: Awaited<ReturnType<typeof recentPraise>>;
}) {
  return (
    <section className={`${s.card} ${s.flush}`} aria-labelledby="praise-title">
      <div className={s.tabs}>
        <div className={s.tabList}>
          <h3 id="praise-title" className={`${s.tab} ${s.tabStatic} ${s.tabActive}`}><IconMedal /> Praise</h3>
        </div>
        <Link href="/awards" className={s.link} style={{ alignSelf: "center", marginLeft: "auto", fontSize: 13.5 }}>Praise wall</Link>
      </div>
      <div className={s.cardBody}>
        {canPraise && colleagues.length > 0 ? (
          <PraiseComposer colleagues={colleagues} />
        ) : (
          <p className={s.muted} style={{ margin: 0 }}>
            {viewer.employee ? <>Recognise a colleague on the <Link href="/awards" className={s.link}>Awards</Link> page.</> : "Praise is given by employees to each other."}
          </p>
        )}
      </div>
      {feed.length > 0 ? (
        <div className={s.praiseFeed} aria-label="Recent praise">
          {feed.map((p) => (
            <div key={p.id} className={s.praiseItem}>
              <Avatar name={p.from.name} photoUrl={p.from.photoUrl} size={34} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div>
                  <Link href={`/directory/${p.from.id}`}>{p.from.name}</Link> praised{" "}
                  <Link href={`/directory/${p.to.id}`}>{p.to.name}</Link>
                  {p.badge ? <> · <span className={s.pill}>{p.badge}</span></> : null}
                  <span className="subtle"> · {p.date}</span>
                </div>
                <div className={s.praiseMsg}>{p.message}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Announcements({ items }: { items: AnnouncementLite[] }) {
  if (items.length === 0) {
    return <section className={`${s.card} ${s.slimCard}`} aria-label="Announcements">No announcements</section>;
  }
  return (
    <section className={s.card} aria-labelledby="announcements">
      <div className={s.cardHead}>
        <h3 id="announcements" className={s.cardTitle}>Announcements</h3>
        <Link href="/announcements" className={s.link}>View All</Link>
      </div>
      <div>
        {items.map((a) => (
          <Link key={a.id} href="/announcements" className={s.annItem}>
            <span className={s.annTitle}>
              {a.pinned ? <span className={s.pill}><IconPin width={11} height={11} /> Pinned</span> : null}
              {a.title}
              {a.needsAck ? <span className={`${s.pill} ${s.warn}`}>Acknowledge</span> : null}
            </span>
            <span className={s.annMeta} style={{ display: "block" }}>{a.date}</span>
            <span className={s.annText}>{a.excerpt}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
