import "server-only";
import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { can, type Viewer } from "@/lib/context";
import { PERMISSIONS } from "@keka/rbac";
import { teamAttention, operationsAttention, type AttentionItem } from "@/lib/attention";
import { Avatar } from "@/components/avatar";
import { Ring } from "@/components/keka";
import {
  dayLabel, onLeaveToday, myLeaveBalances, upcomingHolidays, inboxSummary, myPunchesToday,
  workingRemotelyToday, feedbackReceivedCount, projectTimeToday, type Today,
} from "../_lib/data";
import { WIDGET_BY_TYPE, type WidgetType } from "../_lib/widgets";
import type { WidgetSlot } from "../_lib/wall";
import type { QuickItem } from "./quick-access";
import { LiveTime, ClockControls } from "./time-widget";
import { HolidaySlides } from "./holiday-widget";
import { IconHouse, IconCase } from "./icons";
import d from "../dash.module.css";

const P = PERMISSIONS;

/**
 * Renders the organisation's Quick Access layout for one viewer. Data is
 * fetched only for the widgets on the layout; a widget with nothing for this
 * viewer (no leave balances, not a manager, no project) is hidden, except in
 * edit mode where it shows as a faded placeholder so it can still be moved.
 */
export async function buildQuickAccess(viewer: Viewer, slots: WidgetSlot[], today: Today, opts: { editing: boolean; locationId: string | null | undefined }): Promise<QuickItem[]> {
  const has = (t: WidgetType) => slots.some((s) => s.type === t);
  const me = !!viewer.employee;
  const [punches, offToday, balances, holidays, inbox, remote, feedback, project, team, ops, policy] = await Promise.all([
    has("TIME_TODAY") && me ? myPunchesToday(viewer, today) : Promise.resolve([]),
    has("ON_LEAVE_TODAY") ? onLeaveToday(viewer, today) : Promise.resolve([]),
    has("LEAVE_BALANCES") && me ? myLeaveBalances(viewer, today) : Promise.resolve([]),
    has("HOLIDAYS") ? upcomingHolidays(viewer, today, opts.locationId) : Promise.resolve([]),
    has("INBOX") ? inboxSummary(viewer) : Promise.resolve([]),
    has("WORKING_REMOTELY") ? workingRemotelyToday(viewer, today) : Promise.resolve([]),
    has("FEEDBACK_RECEIVED") && me ? feedbackReceivedCount(viewer) : Promise.resolve(0),
    has("PROJECT_TIME_TODAY") && me ? projectTimeToday(viewer, today) : Promise.resolve({ assigned: false, lines: [], totalMinutes: 0 }),
    has("TEAM_TODAY") ? teamAttention(viewer) : Promise.resolve([] as AttentionItem[]),
    has("NEEDS_ATTENTION") ? operationsAttention(viewer) : Promise.resolve([] as AttentionItem[]),
    has("TIME_TODAY") && me
      ? prisma.employeeTimePolicy.count({ where: { employeeId: viewer.employee!.id, effectiveFrom: { lte: today.date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today.date } }] } })
      : Promise.resolve(1),
  ]);

  const out: QuickItem[] = [];
  for (const slot of slots) {
    const meta = WIDGET_BY_TYPE.get(slot.type)!;
    let node: ReactNode = null;
    switch (slot.type) {
      case "QUICK_LINKS":
        node = (
          <>
            <Head title="Quick Links" />
            {slot.links.length ? (
              <div className={d.links}>
                {slot.links.map((l, i) => l.url.startsWith("/")
                  ? <Link key={i} href={l.url}>{l.label}</Link>
                  : <a key={i} href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
              </div>
            ) : <p className={d.wMuted} style={{ margin: 0 }}>No links yet.{can(viewer, P.ORG_SETTINGS_MANAGE) ? " Add them from the widget's settings." : ""}</p>}
          </>
        );
        break;
      case "ON_LEAVE_TODAY":
        node = (
          <>
            <Head title="On Leave Today" />
            {offToday.length ? <Faces people={offToday.map((p) => ({ ...p, tag: null }))} /> : (
              <Empty title="Everyone is working today!" text="No one is on leave today." art={<LeaveArt />} />
            )}
          </>
        );
        break;
      case "WORKING_REMOTELY":
        node = (
          <>
            <Head title="Working Remotely" />
            {remote.length ? <Faces people={remote.map((p) => ({ ...p, tag: p.mode }))} /> : (
              <Empty title="Everyone is at office!" text="No one is working remotely today." art={<DeskArt />} />
            )}
          </>
        );
        break;
      case "LEAVE_BALANCES":
        if (!me) break;
        node = (
          <>
            <Head title="Leave Balances" />
            {balances.length ? (
              <div className={d.balances}>
                <ul className={d.rings} style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {balances.slice(0, 3).map((b) => {
                    const days = Number.isInteger(b.available) ? String(b.available) : b.available.toFixed(1);
                    return (
                      <li key={b.id} className={d.ringItem}>
                        <Ring value={b.available} max={b.total} size={72} stroke={5} colour="#4fb6c8" track="#dceff3">
                          <span><span className={d.ringNum}>{days}</span><span className={d.ringUnit}>{b.available === 1 ? "Day" : "Days"}</span></span>
                        </Ring>
                        <span className={d.ringName} title={b.name}>{b.name}</span>
                      </li>
                    );
                  })}
                </ul>
                <div className={d.balanceLinks}>
                  <Link href="/?apply=leave" scroll={false}>Request Leave</Link>
                  <Link href="/me/leave">View All Balances</Link>
                </div>
              </div>
            ) : null}
          </>
        );
        break;
      case "TIME_TODAY": {
        if (!me) break;
        const last = punches[punches.length - 1];
        const clockedIn = last?.direction === 0;
        node = (
          <>
            <Head title={`Time Today - ${dayLabel(today.date)}`} link={{ href: "/me/attendance", label: "View All" }} />
            {policy === 0 && punches.length === 0 ? (
              <p style={{ margin: "18px 0 4px", fontSize: 17 }}>Shift / Weekly Off is not assigned</p>
            ) : (
              <>
                <div className={d.timeLabel}>Current Time</div>
                <div className={d.timeRow}>
                  <LiveTime initialIso={new Date().toISOString()} />
                  <ClockControls clockedIn={clockedIn} sinceIso={clockedIn ? last.timestamp.toISOString() : null} />
                </div>
              </>
            )}
          </>
        );
        break;
      }
      case "HOLIDAYS":
        node = (
          <>
            {slot.color === "plain" ? <Confetti /> : null}
            <div style={{ position: "relative" }}>
              <Head title="Holidays" link={{ href: `/?holidays=${today.year}`, label: "View All" }} />
              {holidays.length ? <HolidaySlides holidays={holidays} /> : <p className={d.wMuted} style={{ margin: 0 }}>No upcoming holidays on your calendar.</p>}
            </div>
          </>
        );
        break;
      case "INBOX": {
        const total = inbox.reduce((a, l) => a + l.count, 0);
        node = (
          <>
            <Head title="Inbox" />
            <div className={d.inboxRow}>
              <span className={d.inboxNum}>{total}</span>
              <span className={d.inboxText}>{total ? "Tasks waiting for your approval. Please click on take action for more details." : "Good job! You have no pending actions."}</span>
              <Link href="/inbox" className={d.solid}>Take Action</Link>
            </div>
            {inbox.length ? (
              <div className={d.inboxLines}>
                {inbox.map((l) => <Link key={l.key} href={l.href}><span>{l.label}</span><span>{l.count}</span></Link>)}
              </div>
            ) : null}
          </>
        );
        break;
      }
      case "FEEDBACK_RECEIVED":
        if (!me) break;
        node = (
          <>
            <Head title="Feedbacks Received" />
            <div className={d.inboxRow}>
              <span className={d.inboxNum} style={{ color: "var(--brand-500)" }}>{feedback}</span>
              <span className={d.inboxText}>Feedbacks you have received from others.</span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <Link href="/me/performance?tab=feedback&request=1" className={d.outline}>Request Feedback</Link>
            </div>
          </>
        );
        break;
      case "PROJECT_TIME_TODAY":
        if (!project.assigned) break;
        node = (
          <>
            <Head title="Project Time - Today" />
            <div className={d.ptHead}><span>Client - Project - Task</span></div>
            {project.lines.length ? project.lines.map((l) => (
              <div key={l.id} className={d.ptLine}><span title={l.label}>{l.label}</span><span>{hm(l.minutes)}</span></div>
            )) : <div className={d.ptLine}><span className="subtle">No time logged today yet.</span></div>}
            <div className={d.ptFoot}>
              <span className={d.ptTotal}>TOTAL HOURS<strong>{fmtHours(project.totalMinutes)}</strong></span>
              <Link href="/projects/time" className={d.pink}>Add Time Entry</Link>
            </div>
          </>
        );
        break;
      case "NEEDS_ATTENTION":
        if (!ops.length) break;
        node = (<><Head title={`${ops.filter((i) => i.severity !== "green").length} things need attention`} /><Attention items={ops} /></>);
        break;
      case "TEAM_TODAY":
        if (!team.length) break;
        node = (<><Head title="Your Team Today" link={{ href: "/team", label: "View All" }} /><Attention items={team} /></>);
        break;
    }
    if (node === null && !opts.editing) continue;
    out.push({
      type: slot.type, title: meta.title, color: slot.color, placeholder: node === null,
      node: node ?? (<><Head title={meta.title} /><p className={d.wMuted} style={{ margin: 0 }}>Hidden for you: {meta.description}</p></>),
    });
  }
  return out;
}

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")} Hrs ${String(min % 60).padStart(2, "0")} min`;
const fmtHours = (min: number) => (min % 60 === 0 ? String(min / 60) : (min / 60).toFixed(1));

function Head({ title, link }: { title: string; link?: { href: string; label: string } }) {
  return (
    <div className={d.wHead}>
      <h3 className={d.wTitle}>{title}</h3>
      {link ? <Link href={link.href} className={d.wLink} scroll={false}>{link.label}</Link> : null}
    </div>
  );
}

function Empty({ title, text, art }: { title: string; text: string; art: ReactNode }) {
  return (
    <div className={d.wEmpty}>
      <div className={d.wEmptyText}><strong>{title}</strong><span>{text}</span></div>
      {art}
    </div>
  );
}

function Faces({ people }: { people: Array<{ id: string; name: string; firstName: string; photoUrl: string | null; tag: "WFH" | "ON_DUTY" | null }> }) {
  return (
    <ul className={d.faces} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {people.map((p) => (
        <li key={p.id}>
          <Link href={`/directory/${p.id}`} className={d.face} title={`${p.name}${p.tag === "WFH" ? " · Work from home" : p.tag === "ON_DUTY" ? " · On duty" : ""}`}>
            <span className={d.faceWrap}>
              <Avatar name={p.name} photoUrl={p.photoUrl} size={42} />
              {p.tag ? <span className={d.faceTag} aria-label={p.tag === "WFH" ? "Work from home" : "On duty"}>{p.tag === "WFH" ? <IconHouse /> : <IconCase />}</span> : null}
            </span>
            <span>{p.firstName}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Attention({ items }: { items: AttentionItem[] }) {
  const colour = { red: "var(--danger)", amber: "var(--warning)", green: "var(--success)" };
  return (
    <div>
      {items.slice(0, 6).map((i, k) => (
        <Link key={k} href={i.href} className={d.attnRow}>
          <span className={d.attnDot} style={{ background: colour[i.severity] }} aria-hidden="true" />
          <span className={d.attnText}><span className={d.attnTitle}>{i.title}</span><span className={d.attnDetail}>{i.detail}</span></span>
          <span className="sr-only">{i.severity === "red" ? "Urgent" : i.severity === "amber" ? "Needs action" : "For information"}</span>
        </Link>
      ))}
    </div>
  );
}

/** A clipboard with a tick and a small heart — "everyone is working". Our own line art. */
function LeaveArt() {
  return (
    <svg className={d.wArt} viewBox="0 0 112 64" fill="none" aria-hidden="true">
      <rect x="30" y="20" width="62" height="38" rx="3" fill="#fff" fillOpacity=".55" stroke="currentColor" strokeOpacity=".5" />
      <circle cx="44" cy="39" r="7" stroke="currentColor" strokeOpacity=".7" />
      <path d="m40.5 39 2.5 2.5 4.5-5" stroke="currentColor" strokeOpacity=".8" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M56 35h28M56 43h22" stroke="currentColor" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round" />
      <path d="M62 18c-4-6 4-10 7-5 3-5 11-1 7 5l-7 6z" fill="#fff" fillOpacity=".8" />
    </svg>
  );
}

/** A laptop on a desk with a mug — "everyone is at office". Our own line art. */
function DeskArt() {
  return (
    <svg className={d.wArt} viewBox="0 0 112 64" fill="none" aria-hidden="true">
      <path d="M8 56h100" stroke="currentColor" strokeOpacity=".45" strokeWidth="2" strokeLinecap="round" />
      <rect x="38" y="18" width="38" height="28" rx="3" fill="#fff" fillOpacity=".35" stroke="currentColor" strokeOpacity=".5" />
      <circle cx="57" cy="32" r="1.6" fill="currentColor" fillOpacity=".7" />
      <path d="M32 50h50" stroke="currentColor" strokeOpacity=".5" strokeWidth="3" strokeLinecap="round" />
      <path d="M90 42h8v8a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" fill="#fff" fillOpacity=".6" />
      <path d="M18 52c0-8 3-14 6-16-1 6 1 12 2 16" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" />
    </svg>
  );
}

/** Scattered confetti behind the white Holidays widget. */
function Confetti() {
  const bits = [
    [14, 12, "#e5484d"], [44, 30, "#3b66f6"], [78, 8, "#f5b83d"], [120, 22, "#a2549a"], [168, 10, "#2f9e44"], [210, 26, "#e5484d"],
    [252, 6, "#3b66f6"], [296, 20, "#f5b83d"], [338, 12, "#a2549a"], [380, 28, "#2f9e44"], [24, 96, "#3b66f6"], [64, 118, "#f5b83d"],
    [300, 104, "#e5484d"], [352, 122, "#3b66f6"], [396, 92, "#a2549a"], [230, 128, "#2f9e44"],
  ] as const;
  return (
    <svg className={d.confetti} viewBox="0 0 420 140" preserveAspectRatio="none" aria-hidden="true">
      {bits.map(([x, y, c], i) => <rect key={i} x={x} y={y} width="6" height="2.6" rx="1" fill={c} transform={`rotate(${(i * 47) % 180} ${x} ${y})`} opacity=".8" />)}
    </svg>
  );
}
