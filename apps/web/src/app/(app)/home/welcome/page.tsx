import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { requireViewer, type Viewer } from "@/lib/context";
import { directoryWhere, nameOf } from "@/lib/directory";
import { Avatar } from "@/components/avatar";
import { Ring, EmptyState } from "@/components/keka";
import { BannerArt } from "../_components/banner-art";
import { AboutResponse } from "../_components/about";
import {
  IconExternal, IconChevronRight, IconMail, IconDollar, IconPlane, IconHand, IconTray, IconDoc, IconCash, IconMegaphone,
} from "../_components/icons";
import { PERSON_SELECT, toPerson, type PersonLite } from "../_lib/data";
import s from "../home.module.css";
import { profileChecks } from "@keka/services";

export const metadata = { title: "Welcome — BooS-HR" };

/**
 * Home → Welcome: the new-joiner page. Who you are, how complete your
 * profile is, what is left of your onboarding, where things live, and the
 * people around you.
 */
export default async function WelcomePage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return (
      <div className={`${s.card}`}>
        <EmptyState title="No employee profile">
          This login is not linked to an employee record, so there is no welcome page to show. <Link href="/" className={s.link}>Go to the dashboard</Link>.
        </EmptyState>
      </div>
    );
  }
  const meId = viewer.employee.id;

  const me = await prisma.employee.findFirst({
    where: { id: meId, tenantId: viewer.tenantId },
    select: {
      id: true, firstName: true, lastName: true, displayName: true, photoUrl: true, jobTitleName: true, aboutMe: true,
      mobile: true, personalEmail: true, dateOfBirth: true, bloodGroup: true, reportingManagerId: true,
      location: { select: { name: true, city: true } },
      reportingManager: { select: { ...PERSON_SELECT, tenantId: true } },
      identityDocs: { where: { type: { in: ["PAN", "AADHAAR"] } }, select: { type: true } },
      _count: { select: { addresses: true, bankAccounts: true, emergencyContacts: true } },
    },
  });
  if (!me) {
    return <div className={s.card}><EmptyState title="Profile not found">Your employee record could not be loaded.</EmptyState></div>;
  }

  const [tasks, hr, peers, peerCount, reports, reportCount] = await Promise.all([
    prisma.journeyTask.findMany({
      where: {
        journey: { employeeId: meId, tenantId: viewer.tenantId, trigger: "JOINING", status: { not: "CANCELLED" } },
        OR: [{ owner: "EMPLOYEE" }, { assigneeEmployeeId: meId }],
      },
      select: { id: true, title: true, status: true, dueDate: true },
      orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }],
    }),
    hrContact(viewer),
    me.reportingManagerId
      ? prisma.employee.findMany({
          where: { ...directoryWhere(viewer.tenantId), reportingManagerId: me.reportingManagerId, NOT: { id: meId } },
          select: PERSON_SELECT, orderBy: [{ firstName: "asc" }, { lastName: "asc" }], take: 8,
        })
      : Promise.resolve([]),
    me.reportingManagerId
      ? prisma.employee.count({ where: { ...directoryWhere(viewer.tenantId), reportingManagerId: me.reportingManagerId, NOT: { id: meId } } })
      : Promise.resolve(0),
    viewer.directReportIds.size > 0
      ? prisma.employee.findMany({
          where: { ...directoryWhere(viewer.tenantId), reportingManagerId: meId },
          select: PERSON_SELECT, orderBy: [{ firstName: "asc" }, { lastName: "asc" }], take: 6,
        })
      : Promise.resolve([]),
    viewer.directReportIds.size > 0
      ? prisma.employee.count({ where: { ...directoryWhere(viewer.tenantId), reportingManagerId: meId } })
      : Promise.resolve(0),
  ]);

  // --- Profile completion, from the fields that make a profile useful ---
  const ids = new Set(me.identityDocs.map((d) => d.type));
  // One definition of a complete profile, shared with the stored figure.
  const { missing, percent: pct } = profileChecks({
    photoUrl: me.photoUrl, aboutMe: me.aboutMe, mobile: me.mobile, personalEmail: me.personalEmail, dateOfBirth: me.dateOfBirth,
    bloodGroup: me.bloodGroup, addresses: me._count.addresses, bankAccounts: me._count.bankAccounts,
    emergencyContacts: me._count.emergencyContacts, identityTypes: [...ids],
  });

  const live = tasks.filter((t) => t.status !== "SKIPPED");
  const doneTasks = live.filter((t) => t.status === "DONE").length;
  const pendingTasks = live.filter((t) => t.status === "PENDING");

  const name = nameOf(me);
  const place = me.location?.city ?? me.location?.name ?? null;
  const manager = me.reportingManager && me.reportingManager.tenantId === viewer.tenantId ? toPerson(me.reportingManager) : null;

  const explore = [
    { href: "/finances", title: "Finance", text: "Find your salary, payslips and tax settings all in one place", Icon: IconDollar },
    { href: "/me/leave", title: "Leaves", text: "Check your time-off policy, balances and apply for time off", Icon: IconPlane },
    { href: "/me/attendance", title: "Attendance", text: "Log your attendance, view stats and attendance policy", Icon: IconHand },
    { href: "/inbox", title: "Inbox", text: "Take an action on tasks assigned to you", Icon: IconTray },
    { href: "/documents", title: "Documents", text: `Read up on all the policies that ${viewer.tenant.name} follows`, Icon: IconDoc },
    { href: "/me/expenses", title: "Expenses", text: "Any expenses done on your end for official purposes show up here", Icon: IconCash },
    { href: "/announcements", title: "Engage", text: "Be in-sync with all the activities and announcements", Icon: IconMegaphone },
  ];

  return (
    <div className={s.page}>
      {/* --- Profile banner --- */}
      <section className={s.hero} aria-label="Your profile">
        <BannerArt id="welcome-banner" className={s.bannerArt} />
        <span className={s.heroAvatar}>
          <Avatar name={name} photoUrl={me.photoUrl} size={140} />
        </span>
        <div className={s.heroText}>
          <h1 className={s.heroName}>
            {name}
            <Link href={`/directory/${me.id}`} className={s.heroLink} aria-label="Open your profile">
              <IconExternal />
            </Link>
          </h1>
          <div className={s.heroMeta}>
            {me.jobTitleName ? <span>{me.jobTitleName}</span> : null}
            {me.jobTitleName && place ? <span className={s.heroDot} aria-hidden="true" /> : null}
            {place ? <span>{place}</span> : null}
          </div>
        </div>
        <div className={s.completion}>
          <Ring value={pct} max={100} size={64} stroke={5} colour={pct === 100 ? "#8bc34a" : "#ffd27a"} track="rgba(255,255,255,.3)">
            <span className={s.ringWhite}>{pct}%</span>
          </Ring>
          <div className={s.completionText}>
            <strong>{pct === 100 ? "Profile completed successfully!" : `Your profile is ${pct}% complete`}</strong>
            {missing.length > 0 ? (
              <div className={s.completionMissing}>
                Still to add: {missing.slice(0, 4).join(", ")}{missing.length > 4 ? ` and ${missing.length - 4} more` : ""}
              </div>
            ) : null}
            <Link href={`/directory/${me.id}`} className={s.completionLink}>Go to My Profile <IconChevronRight width={16} height={16} /></Link>
          </div>
        </div>
      </section>

      <div className={s.welcomeGrid}>
        <div className={s.col}>
          {/* --- Introduce yourself --- */}
          <section className={s.card} aria-labelledby="intro">
            <div className={s.introHead}>
              <div>
                <h2 id="intro" className={s.cardTitle}>Introduce yourself</h2>
                <div className={s.cardSub}>We would love to know more about yourself</div>
              </div>
              <Ring value={me.aboutMe ? 1 : 0} max={1} size={56} stroke={4} colour="var(--success)" track="var(--border)">
                <span className={s.progressRing} aria-hidden="true">{me.aboutMe ? 1 : 0}/1</span>
                <span className="sr-only">{me.aboutMe ? "1 of 1 answered" : "0 of 1 answered"}</span>
              </Ring>
            </div>
            <AboutResponse about={me.aboutMe} />
          </section>

          {/* --- Onboarding tasks --- */}
          <section className={s.card} aria-labelledby="onboarding">
            <div className={s.taskRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 id="onboarding" className={s.cardTitle}>Complete your onboarding tasks</h2>
                <div className={s.cardSub}>
                  {live.length > 0
                    ? pendingTasks.length > 0
                      ? "Finish your tasks in order to have a smooth onboarding experience"
                      : "All done — thank you for completing your onboarding tasks"
                    : "No onboarding tasks are assigned to you."}
                </div>
              </div>
              {live.length > 0 ? (
                <Ring value={doneTasks} max={live.length} size={56} stroke={4}
                  colour={doneTasks === live.length ? "var(--success)" : "var(--brand-500)"} track="var(--border)">
                  <span className={s.progressRing} aria-hidden="true">{doneTasks}/{live.length}</span>
                  <span className="sr-only">{doneTasks} of {live.length} tasks done</span>
                </Ring>
              ) : null}
              <Link href="/inbox" className={s.link}>Go to Inbox</Link>
            </div>
            {pendingTasks.length > 0 ? (
              <ul className={s.taskList} aria-label="Pending onboarding tasks">
                {pendingTasks.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <span>{t.title}</span>
                    <span className={s.taskDue}>Due {formatDate(t.dueDate)}</span>
                  </li>
                ))}
                {pendingTasks.length > 5 ? <li><span className="muted">and {pendingTasks.length - 5} more in your inbox</span></li> : null}
              </ul>
            ) : null}
          </section>

          {/* --- Explore --- */}
          <section className={s.card} aria-labelledby="explore">
            <h2 id="explore" className={s.cardTitle}>Explore BooS-HR</h2>
            <div className={s.cardSub}>Explore all things you can do in BooS-HR</div>
            <ul className={s.exploreGrid} style={{ listStyle: "none", padding: 0, marginBottom: 0 }}>
              {explore.map(({ href, title, text, Icon }) => (
                <li key={href} style={{ display: "flex" }}>
                  <Link href={href} className={s.exploreCard} style={{ flex: 1 }}>
                    <span className={s.exploreIcon}><Icon /></span>
                    <span className={s.exploreTitle}>{title}</span>
                    <span className={s.exploreText}>{text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className={s.col}>
          {/* --- HR contact --- */}
          <section className={s.card} aria-labelledby="assist">
            <h2 id="assist" className={s.cardTitle} style={{ marginBottom: 20 }}>We&apos;re here to assist you</h2>
            {hr ? (
              <>
                <div className={s.contact}>
                  <Avatar name={hr.name} photoUrl={hr.photoUrl} size={52} />
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/directory/${hr.id}`} className={s.contactName}>{hr.name}</Link>
                    <div className={s.contactTitle}>{hr.title ?? "Human Resources"}</div>
                  </div>
                </div>
                {hr.email ? (
                  <a href={`mailto:${hr.email}`} className={s.mail}>
                    <IconMail /><span>{hr.email}</span>
                  </a>
                ) : null}
              </>
            ) : (
              <p className={s.muted} style={{ margin: 0 }}>
                No HR contact has been set up yet. <Link href="/me/helpdesk?new=1" className={s.link}>Raise a helpdesk ticket</Link> instead.
              </p>
            )}
          </section>

          {/* --- My team --- */}
          <section className={s.card} aria-labelledby="my-team">
            <h2 id="my-team" className={s.cardTitle} style={{ marginBottom: 20 }}>My team</h2>
            <h3 className={s.teamLabel}>Reporting manager</h3>
            {manager ? <TeamPerson p={manager} /> : <p className={s.muted} style={{ margin: 0 }}>No reporting manager is set.</p>}

            {manager ? (
              <>
                <div className={s.teamDivider} />
                <h3 className={s.teamLabel}>Peers</h3>
                {peers.length > 0 ? (
                  <div className={s.teamList}>
                    {peers.map((p) => <TeamPerson key={p.id} p={toPerson(p)} />)}
                    {peerCount > peers.length ? <span className={s.teamMore}>and {peerCount - peers.length} more</span> : null}
                  </div>
                ) : (
                  <p className={s.muted} style={{ margin: 0 }}>No one else reports to {manager.firstName}.</p>
                )}
              </>
            ) : null}

            {reports.length > 0 ? (
              <>
                <div className={s.teamDivider} />
                <h3 className={s.teamLabel}>Direct reports</h3>
                <div className={s.teamList}>
                  {reports.map((p) => <TeamPerson key={p.id} p={toPerson(p)} />)}
                  {reportCount > reports.length ? <span className={s.teamMore}>and {reportCount - reports.length} more</span> : null}
                </div>
              </>
            ) : null}

            <div style={{ marginTop: 24 }}>
              <Link href="/directory/tree" className={s.link} style={{ fontSize: 15 }}>Go to Org Tree</Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function TeamPerson({ p }: { p: PersonLite }) {
  return (
    <div className={s.teamRow}>
      <Avatar name={p.name} photoUrl={p.photoUrl} size={48} />
      <div>
        <Link href={`/directory/${p.id}`} className={s.contactName}>{p.name}</Link>
        {p.title ? <div className={s.contactTitle}>{p.title}</div> : null}
      </div>
    </div>
  );
}

/**
 * The person to contact for HR questions: someone holding the HR Manager
 * role in this tenant (an HR Executive if there is none), preferring a
 * colleague over the viewer themselves.
 */
async function hrContact(viewer: Viewer): Promise<(PersonLite & { email: string | null }) | null> {
  let self: (PersonLite & { email: string | null }) | null = null;
  for (const key of ["HR_MANAGER", "HR_EXECUTIVE"]) {
    const rows = await prisma.employee.findMany({
      where: {
        ...directoryWhere(viewer.tenantId),
        user: { is: { tenantId: viewer.tenantId, isDeactivated: false, roleAssignments: { some: { role: { key, tenantId: viewer.tenantId } } } } },
      },
      select: { ...PERSON_SELECT, workEmail: true },
      orderBy: { dateOfJoining: "asc" },
      take: 5,
    });
    const other = rows.find((r) => r.id !== viewer.employee?.id);
    if (other) return { ...toPerson(other), email: other.workEmail };
    if (rows[0] && !self) self = { ...toPerson(rows[0]), email: rows[0].workEmail };
  }
  // The viewer is the only HR contact there is.
  return self;
}
