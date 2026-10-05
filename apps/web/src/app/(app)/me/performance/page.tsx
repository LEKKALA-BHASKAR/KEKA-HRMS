import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { SubTabs } from "@/components/subtabs";
import { Panel, SectionTitle, EmptyState } from "@/components/keka";
import { Avatar } from "@/components/avatar";
import { Badge } from "@/components/ui";
import { IconTrophy, IconEngage, IconLock, IconTarget, IconChart } from "@/components/icons";
import { GiveButtons } from "./give";
import { feedbackRules } from "@/lib/talent";
import s from "./performance.module.css";

/**
 * Me → Performance: praise and feedback between colleagues, the viewer's own
 * goals, and their reviews. Everything here is the viewer's own: what they
 * received or gave, filtered by tenant. Internal notes are shown only to the
 * person who wrote them — never to the person they are about.
 */

const P = PERMISSIONS;
const LIST_LIMIT = 100;

type FeedbackTab = "praises-received" | "feedback-received" | "praises-given" | "feedback-given" | "internal-notes";
const FEEDBACK_TABS: Array<{ key: FeedbackTab; label: string; description: string }> = [
  { key: "praises-received", label: "Praises Received", description: "This section contains the praises received by me." },
  { key: "feedback-received", label: "Feedback Received", description: "This section contains the feedback received by me." },
  { key: "praises-given", label: "Praises Given", description: "This section contains the praises given by me." },
  { key: "feedback-given", label: "Feedback Given", description: "This section contains the feedback given by me." },
  { key: "internal-notes", label: "Internal Notes", description: "This section contains the private notes I have written about people who report to me. They are never shown to the person they are about." },
];

export default async function MyPerformancePage({ searchParams }: { searchParams: Promise<{ view?: string; tab?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const view = sp.view === "goals" || sp.view === "reviews" ? sp.view : "feedback";
  const tab = FEEDBACK_TABS.find((t) => t.key === sp.tab)?.key ?? "praises-received";
  return (
    <>
      <SubTabs items={[
        { label: "Feedback", href: "/me/performance" },
        { label: "Goals", href: "/me/performance?view=goals" },
        { label: "Reviews", href: "/me/performance?view=reviews" },
        { label: "Feedback Requests", href: "/me/performance/requests" },
        { label: "Growth Plans", href: "/me/performance/growth" },
      ]} />
      {!viewer.employee ? (
        <Panel><EmptyState icon={<IconChart />} title="No employee record">This login is not linked to an employee, so there is no performance data to show.</EmptyState></Panel>
      ) : view === "goals" ? <Goals viewer={viewer} />
        : view === "reviews" ? <Reviews viewer={viewer} />
        : <Feedback viewer={viewer} tab={tab} />}
    </>
  );
}

// ---------------------------------------------------------------------------
//  Feedback
// ---------------------------------------------------------------------------

const PERSON = { select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, photoUrl: true, department: { select: { name: true } } } } as const;
type Person = { id: string; displayName: string | null; firstName: string; lastName: string; jobTitleName: string | null; photoUrl: string | null; department: { name: string } | null };
/** Shown in place of the giver when feedback was given anonymously. */
const ANONYMOUS: Person = { id: "anonymous", displayName: "Anonymous colleague", firstName: "Anonymous", lastName: "", jobTitleName: null, photoUrl: null, department: null };
type Item = { id: string; person: Person; direction: "From" | "To" | "About"; badge?: string | null; topic?: string | null; message: string; at: Date; isPublic?: boolean };

async function feedbackItems(viewer: Viewer, tab: FeedbackTab): Promise<Item[]> {
  const me = viewer.employee!.id;
  const tenantId = viewer.tenantId;
  switch (tab) {
    case "praises-received":
      return (await prisma.praise.findMany({ where: { tenantId, toEmployeeId: me }, include: { fromEmployee: PERSON }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT }))
        .map((p) => ({ id: p.id, person: p.fromEmployee, direction: "From", badge: p.badge, message: p.message, at: p.createdAt, isPublic: p.isPublic }));
    case "praises-given":
      return (await prisma.praise.findMany({ where: { tenantId, fromEmployeeId: me }, include: { toEmployee: PERSON }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT }))
        .map((p) => ({ id: p.id, person: p.toEmployee, direction: "To", badge: p.badge, message: p.message, at: p.createdAt, isPublic: p.isPublic }));
    case "feedback-received":
      // Only shared feedback: a note about the viewer is never theirs to read.
      return (await prisma.feedback.findMany({ where: { tenantId, aboutEmployeeId: me, kind: "FEEDBACK", deletedAt: null }, include: { fromEmployee: PERSON }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT }))
        .map((f) => ({ id: f.id, person: f.isAnonymous ? ANONYMOUS : f.fromEmployee, direction: "From", topic: f.topic, message: f.message, at: f.createdAt }));
    case "feedback-given":
      return (await prisma.feedback.findMany({ where: { tenantId, fromEmployeeId: me, kind: "FEEDBACK", deletedAt: null }, include: { aboutEmployee: PERSON }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT }))
        .map((f) => ({ id: f.id, person: f.aboutEmployee, direction: "To", topic: f.topic, message: f.message, at: f.createdAt }));
    case "internal-notes":
      return (await prisma.feedback.findMany({ where: { tenantId, fromEmployeeId: me, kind: "INTERNAL_NOTE", deletedAt: null }, include: { aboutEmployee: PERSON }, orderBy: { createdAt: "desc" }, take: LIST_LIMIT }))
        .map((f) => ({ id: f.id, person: f.aboutEmployee, direction: "About", topic: f.topic, message: f.message, at: f.createdAt }));
  }
}

const EMPTY: Record<FeedbackTab, { icon: ReactNode; title: string; text: string }> = {
  "praises-received": { icon: <IconTrophy />, title: "No praises received", text: "Keep giving your best, keep working hard" },
  "feedback-received": { icon: <IconEngage />, title: "No feedback received", text: "Feedback your colleagues share with you will appear here" },
  "praises-given": { icon: <IconTrophy />, title: "No praises given", text: "Noticed someone's good work? A word of praise goes a long way" },
  "feedback-given": { icon: <IconEngage />, title: "No feedback given", text: "Share specific, timely feedback to help a colleague grow" },
  "internal-notes": { icon: <IconLock />, title: "No internal notes", text: "Private notes you write about your reports will appear here" },
};

async function Feedback({ viewer, tab }: { viewer: Viewer; tab: FeedbackTab }) {
  const me = viewer.employee!.id;
  const [items, directory] = await Promise.all([
    feedbackItems(viewer, tab),
    prisma.employee.findMany({
      where: { ...directoryWhere(viewer.tenantId), NOT: { id: me } },
      select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true, department: { select: { name: true } } },
      orderBy: [{ displayName: "asc" }, { firstName: "asc" }],
    }),
  ]);
  const meta = FEEDBACK_TABS.find((t) => t.key === tab)!;
  const empty = EMPTY[tab];
  return (
    <>
      <nav className={s.strip} aria-label="Feedback sections">
        {FEEDBACK_TABS.map((t) => (
          <Link key={t.key} href={t.key === "praises-received" ? "/me/performance" : `/me/performance?tab=${t.key}`} scroll={false}
            className={s.stripTab} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      <div className={s.head}>
        <div>
          <h2 className={s.title}>{meta.label}</h2>
          <p className={s.desc}>{meta.description}</p>
        </div>
        <GiveButtons
          canPraise={can(viewer, P.PRAISE_GIVE)}
          allowAnonymous={(await feedbackRules(viewer.tenantId)).allowAnonymous}
          reportIds={[...viewer.allReportIds]}
          colleagues={directory.map((e) => ({ id: e.id, name: nameOf(e), meta: [e.jobTitleName, e.department?.name].filter(Boolean).join(", ") }))}
        />
      </div>

      {items.length === 0 ? (
        <Panel className={s.emptyPanel}>
          <EmptyState icon={empty.icon} title={empty.title}>{empty.text}</EmptyState>
        </Panel>
      ) : (
        <>
          <ul className={s.cards} aria-label={meta.label}>
            {items.map((it) => <FeedbackCard key={it.id} item={it} tab={tab} />)}
          </ul>
          {items.length === LIST_LIMIT ? <p className={s.more}>Showing the latest {LIST_LIMIT}.</p> : null}
        </>
      )}
    </>
  );
}

function FeedbackCard({ item, tab }: { item: Item; tab: FeedbackTab }) {
  const name = nameOf(item.person);
  const role = [item.person.jobTitleName, item.person.department?.name].filter(Boolean).join(" · ");
  const praise = tab.startsWith("praises");
  return (
    <li className={s.card}>
      <div className={s.cardHead}>
        <Avatar name={name} photoUrl={item.person.photoUrl} size={42} />
        <div className={s.who}>
          <div className={s.direction}>{item.direction}</div>
          <div className={s.name}>{name}</div>
          {role ? <div className={s.role}>{role}</div> : null}
        </div>
        <time className={s.date} dateTime={item.at.toISOString()}>{formatDate(item.at)}</time>
      </div>
      {item.badge || item.topic || (praise && item.isPublic === false) || tab === "internal-notes" ? (
        <div className={s.tags}>
          {item.badge ? <span className={s.badge}><IconTrophy width={14} height={14} aria-hidden="true" />{item.badge}</span> : null}
          {item.topic ? <span className={s.topic}><span className={s.topicLabel}>Topic</span>{item.topic}</span> : null}
          {praise && item.isPublic === false ? <span className={s.private}>Private</span> : null}
          {tab === "internal-notes" ? <span className={s.private}><IconLock width={12} height={12} aria-hidden="true" />Only you can see this</span> : null}
        </div>
      ) : null}
      <p className={s.message}>{item.message}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

const GOAL_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  DRAFT: { label: "Draft", tone: "neutral" }, ON_TRACK: { label: "On track", tone: "success" }, NEEDS_ATTENTION: { label: "Needs attention", tone: "warning" },
  AT_RISK: { label: "At risk", tone: "danger" }, COMPLETED: { label: "Completed", tone: "info" }, MISSED: { label: "Missed", tone: "danger" }, CANCELLED: { label: "Cancelled", tone: "neutral" },
};
const num = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function Goals({ viewer }: { viewer: Viewer }) {
  const me = viewer.employee!.id;
  const goals = await prisma.goal.findMany({
    where: { tenantId: viewer.tenantId, employeeId: me, status: { not: "CANCELLED" } },
    include: {
      goalType: { select: { name: true } }, parentGoal: { select: { title: true } },
      checkIns: { orderBy: { recordedAt: "desc" }, take: 1 }, _count: { select: { checkIns: true } },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });
  const recorders = [...new Set(goals.map((g) => g.checkIns[0]?.recordedBy).filter((x): x is string => !!x))];
  const people = recorders.length ? await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: recorders } }, select: { id: true, displayName: true, firstName: true, lastName: true } }) : [];
  const nameById = new Map(people.map((p) => [p.id, p.id === me ? "You" : nameOf(p)]));

  const open = goals.filter((g) => !["COMPLETED", "MISSED"].includes(g.status));
  const avg = goals.length ? Math.round(goals.reduce((t, g) => t + Number(g.progressPercent), 0) / goals.length) : 0;
  const count = (st: string[]) => goals.filter((g) => st.includes(g.status)).length;

  return (
    <>
      <SectionTitle
        sub="Goals set for you this period, with progress from your latest check-in"
        action={<Link className="btn" href="/performance?tab=goals">Update progress</Link>}
      >
        My Goals
      </SectionTitle>
      {goals.length === 0 ? (
        <Panel className={s.emptyPanel}><EmptyState icon={<IconTarget />} title="No goals yet">Goals you or your manager set for you will appear here</EmptyState></Panel>
      ) : (
        <>
          <div className={s.summary} role="list" aria-label="Goal summary">
            <Summary label="Goals" value={String(goals.length)} meta={`${open.length} open`} />
            <Summary label="Average progress" value={`${avg}%`} meta="across all goals" />
            <Summary label="On track" value={String(count(["ON_TRACK"]))} tone="success" />
            <Summary label="Needs attention" value={String(count(["NEEDS_ATTENTION", "AT_RISK"]))} tone={count(["NEEDS_ATTENTION", "AT_RISK"]) ? "danger" : undefined} meta={count(["AT_RISK"]) ? `${count(["AT_RISK"])} at risk` : undefined} />
            <Summary label="Completed" value={String(count(["COMPLETED"]))} />
          </div>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className={`data ${s.table}`}>
                <thead><tr><th>Goal</th><th>Progress</th><th>Status</th><th>Due</th><th>Latest check-in</th></tr></thead>
                <tbody>
                  {goals.map((g) => {
                    const pct = Math.round(Number(g.progressPercent));
                    const st = GOAL_STATUS[g.status] ?? { label: g.status, tone: "neutral" as const };
                    const last = g.checkIns[0];
                    const metric = g.metricType !== "PERCENTAGE" && g.metricType !== "COMPLETION";
                    return (
                      <tr key={g.id}>
                        <td className={s.goalCell}>
                          <div className={s.goalTitle}>{g.title}</div>
                          <div className={s.sub}>
                            {[g.goalType?.name, g.level !== "INDIVIDUAL" ? `${g.level.toLowerCase()} goal` : null, g.parentGoal ? `aligned to “${g.parentGoal.title}”` : null].filter(Boolean).join(" · ") || "Individual goal"}
                          </div>
                        </td>
                        <td className={s.progressCell}>
                          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${g.title} progress`}>
                            <div className={`progress-bar${g.status === "AT_RISK" || g.status === "MISSED" ? " warning" : g.status === "COMPLETED" ? " success" : ""}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                          </div>
                          <div className={s.sub}>{pct}%{metric ? ` · ${num(g.currentValue)} of ${num(g.targetValue)}${g.metricName ? ` ${g.metricName}` : ""}` : ""}</div>
                        </td>
                        <td><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td className="nowrap">{formatDate(g.dueDate)}</td>
                        <td className={s.checkInCell}>
                          {last ? (
                            <>
                              <div>{formatDate(last.recordedAt)}{last.recordedBy ? <span className="subtle"> · {nameById.get(last.recordedBy) ?? "—"}</span> : null}</div>
                              <div className={s.sub} title={last.note ?? undefined}>{metric ? `${num(last.value)}${g.metricName ? ` ${g.metricName}` : ""}` : `${Math.round(Number(last.progressPercent))}%`}{last.note ? ` — ${last.note}` : ""}</div>
                              {g._count.checkIns > 1 ? <div className={s.sub}>{g._count.checkIns} check-ins</div> : null}
                            </>
                          ) : <span className="subtle">No check-ins yet</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

function Summary({ label, value, meta, tone }: { label: string; value: string; meta?: string; tone?: "success" | "danger" }) {
  return (
    <div className={s.summaryItem} role="listitem">
      <div className={s.summaryLabel}>{label}</div>
      <div className={`${s.summaryValue}${tone ? ` ${s[tone]}` : ""}`}>{value}</div>
      {meta ? <div className={s.sub}>{meta}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

const REVIEW_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" | "brand" }> = {
  NOT_STARTED: { label: "Not started", tone: "neutral" }, SELF_PENDING: { label: "Self review pending", tone: "warning" },
  MANAGER_PENDING: { label: "Manager review pending", tone: "warning" }, PENDING_CALIBRATION: { label: "In calibration", tone: "info" },
  CALIBRATED: { label: "Calibrated", tone: "info" }, SHARED: { label: "Shared with you", tone: "brand" }, ACKNOWLEDGED: { label: "Acknowledged", tone: "success" },
};

function reviewWindow(opens: Date | null, closes: Date | null): ReactNode {
  if (opens && closes) return `${formatDate(opens)} – ${formatDate(closes)}`;
  if (closes) return `Closes ${formatDate(closes)}`;
  if (opens) return `Opens ${formatDate(opens)}`;
  return <span className="subtle">—</span>;
}

async function Reviews({ viewer }: { viewer: Viewer }) {
  const me = viewer.employee!.id;
  const reviews = await prisma.employeeReview.findMany({
    where: { employeeId: me, cycle: { tenantId: viewer.tenantId, status: { not: "CANCELLED" } } },
    include: {
      cycle: { select: { name: true, periodStart: true, periodEnd: true, reviewOpensAt: true, reviewClosesAt: true } },
      band: { select: { name: true } },
      responses: { where: { reviewerId: me, reviewerType: "SELF" }, select: { submittedAt: true } },
    },
    orderBy: [{ cycle: { periodEnd: "desc" } }, { createdAt: "desc" }],
  });
  return (
    <>
      <SectionTitle sub="Your reviews in each review cycle. Ratings are shared with you once the cycle is calibrated.">My Reviews</SectionTitle>
      {reviews.length === 0 ? (
        <Panel className={s.emptyPanel}><EmptyState icon={<IconChart />} title="No reviews yet">You will see a review here when a review cycle includes you</EmptyState></Panel>
      ) : (
        <Panel pad={false}>
          <div className="table-wrap">
            <table className={`data ${s.table}`}>
              <thead><tr><th>Review cycle</th><th>Review window</th><th>Self review</th><th>Status</th><th>Rating</th><th className={s.right}>Actions</th></tr></thead>
              <tbody>
                {reviews.map((r) => {
                  const st = REVIEW_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                  const self = r.responses[0];
                  const selfDue = !!self && !self.submittedAt;
                  const shared = ["SHARED", "ACKNOWLEDGED"].includes(r.status);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link className={s.link} href={`/performance/reviews/${r.id}`}>{r.cycle.name}</Link>
                        <div className={s.sub}>{formatDate(r.cycle.periodStart)} – {formatDate(r.cycle.periodEnd)}</div>
                      </td>
                      <td className="nowrap">{reviewWindow(r.cycle.reviewOpensAt, r.cycle.reviewClosesAt)}</td>
                      <td className="nowrap">{!self ? <span className="subtle">Not required</span> : self.submittedAt ? <>Submitted<div className={s.sub}>{formatDate(self.submittedAt)}</div></> : <span className={s.due}>Pending</span>}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td>{shared && r.finalRating !== null ? <><span className={s.strong}>{num(r.finalRating)}</span>{r.band ? <div className={s.sub}>{r.band.name}</div> : null}</> : <span className="subtle">Shared when the cycle closes</span>}</td>
                      <td className={s.right}>
                        <Link className={`btn sm${selfDue ? " primary" : ""}`} href={`/performance/reviews/${r.id}`}>{selfDue ? "Write self review" : r.status === "SHARED" ? "View & acknowledge" : "View"}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
