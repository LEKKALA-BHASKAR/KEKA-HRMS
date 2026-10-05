import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { requireViewer } from "@/lib/context";
import { Avatar } from "@/components/avatar";
import { Chip, EmptyState } from "@/components/keka";
import { IconTeam } from "@/components/icons";
import { loadTeam, type Member, type TeamData, type Today } from "./_data";
import { TeamCalendar } from "./calendar";
import s from "./team.module.css";

/**
 * My Team → Summary, as Keka lays it out: who is away and who is not in yet,
 * today's attendance at a glance, the team calendar for a month, and a card
 * for every teammate. Direct reports come first for a manager; everyone sees
 * their peers (all who share their reporting manager, themselves included).
 */

const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });
const at = (d: Date) => TIME.format(d).toLowerCase();

export default async function TeamSummaryPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const viewer = await requireViewer();
  const team = await loadTeam(viewer, (await searchParams).month);
  if (!team) {
    return (
      <div className={s.panel}>
        <EmptyState icon={<IconTeam />} title="No team to show">
          This login is not linked to an employee record, so there is no reporting line to build a team from.
        </EmptyState>
      </div>
    );
  }

  const others = team.everyone.filter((m) => m.id !== team.self.id);
  const t = (m: Member) => team.today.get(m.id)!;
  const onLeave = others.filter((m) => t(m).onLeave);
  const notIn = others.filter((m) => t(m).notInYet);
  const onTime = others.filter((m) => t(m).onTime);
  const late = others.filter((m) => t(m).lateBy !== null);
  const remote = others.filter((m) => t(m).remote);
  const remoteIn = others.filter((m) => t(m).remoteClockIn);

  return (
    <div className={s.page}>
      <div className={s.topRow}>
        <section className={`${s.panel} ${s.who}`} aria-labelledby="who-leave">
          <h2 id="who-leave" className={s.whoTitle}>Who is on leave today</h2>
          {onLeave.length === 0 ? <p className={s.quiet}>No one on your team is on leave today.</p> : <Faces members={onLeave} max={8} moreId="pop-leave" />}
        </section>
        <section className={`${s.panel} ${s.who}`} aria-labelledby="who-notin">
          <h2 id="who-notin" className={s.whoTitle}>Not in yet today</h2>
          {notIn.length === 0
            ? <p className={s.quiet}>{team.isOffToday ? "It's a day off for the team." : "Everyone expected in has clocked in."}</p>
            : <Faces members={notIn} max={5} moreId="pop-notin" />}
        </section>
      </div>
      <ListModal id="pop-leave" title={`On leave today (${onLeave.length})`} members={onLeave} meta={() => "On leave"} />
      <ListModal id="pop-notin" title={`Not in yet today (${notIn.length})`} members={notIn} meta={(m) => m.jobTitleName ?? ""} />

      <div className={s.stats}>
        <StatCard label="Employees On Time today" accent="#36b8c9" id="pop-ontime" members={onTime}
          meta={(m) => `In at ${at(t(m).firstIn!)}`} />
        <StatCard label="Late Arrivals today" accent="#e5484d" id="pop-late" members={late}
          meta={(m) => `In at ${at(t(m).firstIn!)} · ${t(m).lateBy} min after shift start`} />
        <StatCard label="Work from Home / On Duty today" accent="#f0a020" id="pop-remote" members={remote}
          meta={(m) => (t(m).remote === "ON_DUTY" ? "On duty" : "Work from home")} />
        <StatCard label="Remote Clock-ins today" accent="#8a63d2" id="pop-remotein" members={remoteIn}
          meta={(m) => { const r = t(m).remoteClockIn!; return `${r.source === "MOBILE" ? "Mobile app" : "Web"} · ${at(r.at)}`; }} />
      </div>

      <h2 className={s.sectionTitle}>Team calendar</h2>
      <TeamCalendar team={team} />

      {team.directs.length > 0 ? (
        <>
          <h2 className={s.sectionTitle}>Direct reports ({team.directs.length})</h2>
          <Cards members={team.directs} team={team} />
        </>
      ) : null}
      {team.directs.length === 0 || team.peers.length > 1 ? (
        <>
          <h2 className={s.sectionTitle}>Peers ({team.peers.length})</h2>
          <Cards members={team.peers} team={team} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Faces({ members, max, moreId }: { members: Member[]; max: number; moreId: string }) {
  const shown = members.slice(0, max);
  return (
    <div className={s.faces}>
      {shown.map((m) => (
        <Link key={m.id} href={`/directory/${m.id}`} className={s.face} title={m.name}>
          <Avatar name={m.name} photoUrl={m.photoUrl} size={40} />
          <span>{m.firstName}</span>
        </Link>
      ))}
      {members.length > max ? (
        <button type="button" className={s.more} popoverTarget={moreId}>+{members.length - max} more</button>
      ) : null}
    </div>
  );
}

function StatCard({ label, accent, id, members, meta }: {
  label: string; accent: string; id: string; members: Member[]; meta: (m: Member) => string;
}) {
  return (
    <section className={`${s.panel} ${s.stat}`} style={{ "--accent": accent } as CSSProperties} aria-label={label}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statFoot}>
        <span className={s.statValue}>{members.length}</span>
        <button type="button" className={s.viewLink} popoverTarget={id} aria-haspopup="dialog">View Employees</button>
      </div>
      <ListModal id={id} title={`${label} (${members.length})`} members={members} meta={meta} />
    </section>
  );
}

/** A list of people in a native popover: Esc and clicking outside close it. */
function ListModal({ id, title, members, meta }: { id: string; title: string; members: Member[]; meta: (m: Member) => ReactNode }) {
  return (
    <div id={id} popover="auto" className={s.modal} role="dialog" aria-label={title}>
      <div className={s.modalHead}>
        <h3>{title}</h3>
        <button type="button" className={s.modalClose} popoverTarget={id} popoverTargetAction="hide" aria-label="Close">×</button>
      </div>
      {members.length === 0 ? <div className={s.modalEmpty}>No one yet.</div> : (
        <ul className={s.modalList}>
          {members.map((m) => (
            <li key={m.id}>
              <Avatar name={m.name} photoUrl={m.photoUrl} size={34} />
              <div style={{ minWidth: 0 }}>
                <Link href={`/directory/${m.id}`}>{m.name}</Link>
                <div className={s.modalMeta}>{meta(m)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Cards({ members, team }: { members: Member[]; team: TeamData }) {
  return (
    <div className={s.cards}>
      {members.map((m) => <PersonCard key={m.id} m={m} today={team.today.get(m.id)!} self={m.id === team.self.id} />)}
    </div>
  );
}

function PersonCard({ m, today, self }: { m: Member; today: Today; self: boolean }) {
  return (
    <article className={`${s.panel} ${s.card}`} aria-label={m.name}>
      <Avatar name={m.name} photoUrl={m.photoUrl} size={76} />
      <div style={{ minWidth: 0 }}>
        <div className={s.cardHead}>
          <div className={s.cardName} title={m.name}>
            <Link href={`/directory/${m.id}`}>{m.name}</Link>
            {self ? <span className={s.youTag}>(You)</span> : null}
          </div>
          <details className={s.menu}>
            <summary aria-label={`Actions for ${m.name}`}>⋯</summary>
            <div className={s.menuList}>
              <Link href={`/directory/${m.id}`}>View profile</Link>
              {m.workEmail ? <a href={`mailto:${m.workEmail}`}>Send email</a> : null}
              {/* HR shortcuts for a manager's own reports. */}
              {!self ? (
                <>
                  <Link href={`/employees/${m.id}`} data-shortcut="record">Full record</Link>
                  <Link href="/team/roster" data-shortcut="roster">Roster &amp; attendance</Link>
                  <Link href="/team/insights" data-shortcut="insights">Documents, goals &amp; reviews</Link>
                  <Link href={`/team/activity?who=${m.id}`} data-shortcut="activity">Recent changes</Link>
                  <Link href="/team/delegation" data-shortcut="delegation">Delegate approvals</Link>
                </>
              ) : null}
            </div>
          </details>
          {today.chips.length > 0 ? (
            <div className={s.chips}>
              {today.chips.map((c) => <Chip key={c.label} kind={c.kind}>{c.label}</Chip>)}
            </div>
          ) : null}
        </div>
        <div className={s.cardTitle}>{m.jobTitleName ?? "—"}</div>
        <div className={s.cardFacts}>
          <div><span>Location : </span>{m.location?.city ?? m.location?.name ?? "—"}</div>
          <div><span>Department : </span>{m.department?.name ?? "—"}</div>
          <div><span>Email : </span>{m.workEmail ? <a href={`mailto:${m.workEmail}`} title={m.workEmail}>{m.workEmail}</a> : "—"}</div>
        </div>
      </div>
    </article>
  );
}
