import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { enrolmentStanding, formatMinutes } from "@keka/services";
import { requireAuth, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Progress, Stat, Person } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { CourseForm, EnrolSelf } from "./forms";

const P = PERMISSIONS;
const LEVEL: Record<string, string> = { BEGINNER: "Beginner", INTERMEDIATE: "Intermediate", ADVANCED: "Advanced" };
const STANDING: Record<string, { label: string; tone: "success" | "danger" | "warning" | "info" | "neutral" }> = {
  COMPLETED: { label: "Completed", tone: "success" }, OVERDUE: { label: "Overdue", tone: "danger" },
  DUE_SOON: { label: "Due soon", tone: "warning" }, ON_TRACK: { label: "In progress", tone: "info" }, NOT_STARTED: { label: "Not started", tone: "neutral" },
};

type Tab = "mine" | "catalogue" | "manage" | "team";

export default async function LearnPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; new?: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.COURSE_MANAGE);
  const canAssign = canAny(viewer, [P.COURSE_ASSIGN, P.COURSE_MANAGE]);
  const myId = viewer.employee?.id;
  const tabs: Array<{ key: Tab; label: string }> = [
    ...(myId ? [{ key: "mine" as const, label: "My Learning" }] : []),
    { key: "catalogue", label: "Catalogue" },
    ...(canAssign ? [{ key: "team" as const, label: canManage ? "Completion tracking" : "My team's learning" }] : []),
    ...(canManage ? [{ key: "manage" as const, label: "Manage courses" }] : []),
  ];
  const tab: Tab = (tabs.find((t) => t.key === sp.tab)?.key) ?? tabs[0].key;
  const today = new Date();

  const [mine, catalogue] = await Promise.all([
    myId
      ? prisma.courseEnrolment.findMany({
          where: { employeeId: myId, course: { status: { not: "DRAFT" } } },
          orderBy: [{ status: "asc" }, { dueDate: "asc" }],
          include: { course: { include: { _count: { select: { lessons: true } }, lessons: { select: { durationMinutes: true } } } } },
        })
      : Promise.resolve([]),
    prisma.course.findMany({
      where: {
        tenantId: viewer.tenantId, status: tab === "manage" ? undefined : "PUBLISHED",
        ...(sp.q ? { OR: [{ title: { contains: sp.q, mode: "insensitive" as const } }, { category: { contains: sp.q, mode: "insensitive" as const } }] } : {}),
      },
      orderBy: [{ status: "asc" }, { isMandatory: "desc" }, { title: "asc" }],
      include: {
        skill: { select: { name: true } },
        lessons: { select: { durationMinutes: true } },
        _count: { select: { lessons: true, enrolments: true } },
        enrolments: { where: { status: "COMPLETED" }, select: { id: true } },
      },
    }),
  ]);
  const enrolledIds = new Set(mine.map((e) => e.courseId));

  const inProgress = mine.filter((e) => e.status !== "COMPLETED");
  const completed = mine.filter((e) => e.status === "COMPLETED");
  const overdue = inProgress.filter((e) => enrolmentStanding(e, today) === "OVERDUE");
  const minutesLearnt = completed.reduce((s, e) => s + e.course.lessons.reduce((a, l) => a + l.durationMinutes, 0), 0);

  // Completion tracking — everyone in scope (HR) or your reports (managers).
  const tracking = tab === "team"
    ? await prisma.courseEnrolment.findMany({
        where: {
          tenantId: viewer.tenantId, course: { status: "PUBLISHED" },
          employee: canManage ? scopedEmployeeWhere(viewer, P.COURSE_MANAGE) : scopedEmployeeWhere(viewer, P.COURSE_ASSIGN),
          ...(myId ? { NOT: { employeeId: myId } } : {}),
        },
        include: {
          course: { select: { id: true, title: true, isMandatory: true } },
          employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } },
        },
        orderBy: [{ dueDate: "asc" }],
      })
    : [];
  const skills = tab === "manage" && sp.new ? await prisma.skill.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];

  return (
    <>
      <PageHead
        title="Learning"
        subtitle="Courses, assigned learning and your progress"
        actions={canManage && tab === "manage" ? <Link className="btn primary" href={sp.new ? "/learn?tab=manage" : "/learn?tab=manage&new=1"}>{sp.new ? "Cancel" : "+ New course"}</Link> : null}
      />
      <div className="tabs">
        {tabs.map((t) => <Link key={t.key} href={`/learn?tab=${t.key}`} className={`tab${tab === t.key ? " active" : ""}`}>{t.label}{t.key === "mine" && inProgress.length ? ` (${inProgress.length})` : ""}</Link>)}
      </div>

      {tab === "mine" ? (
        <>
          <div className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="In progress" value={inProgress.length} meta={`${overdue.length} overdue`} tone={overdue.length ? "neg" : undefined} />
            <Stat label="Completed" value={completed.length} meta="All time" />
            <Stat label="Time learnt" value={formatMinutes(minutesLearnt)} meta="Across completed courses" />
            <Stat label="Average quiz score" value={(() => { const s = completed.map((e) => e.score).filter((x): x is number => x !== null); return s.length ? `${Math.round(s.reduce((a, b) => a + b, 0) / s.length)}%` : "—"; })()} meta="Completed courses with quizzes" />
          </div>
          <SectionTitle sub="Assigned to you or chosen by you">Continue learning</SectionTitle>
          {inProgress.length === 0 ? (
            <Panel><EmptyState title="Nothing in progress">Browse the <Link href="/learn?tab=catalogue">catalogue</Link> to pick up something new.</EmptyState></Panel>
          ) : (
            <div className="grid grid-3" style={{ marginBottom: 18 }}>
              {inProgress.map((e) => {
                const st = STANDING[enrolmentStanding(e, today)];
                return (
                  <Link key={e.id} href={`/learn/courses/${e.courseId}`} className="k-panel course-card">
                    <div className="course-cover" style={{ background: e.course.coverColour ?? "var(--brand-500)" }}>
                      <span>{e.course.category}</span>
                      {e.course.isMandatory ? <span className="course-flag">Mandatory</span> : null}
                    </div>
                    <div style={{ padding: 14 }}>
                      <div className="strong" style={{ marginBottom: 4 }}>{e.course.title}</div>
                      <div className="text-xs subtle" style={{ marginBottom: 10 }}>{e.course._count.lessons} lessons · {formatMinutes(e.course.lessons.reduce((a, l) => a + l.durationMinutes, 0))}{e.dueDate ? ` · due ${formatDate(e.dueDate)}` : ""}</div>
                      <Progress value={e.progressPercent} max={100} tone={st.tone === "danger" ? "warning" : undefined} />
                      <div className="row text-xs" style={{ justifyContent: "space-between", marginTop: 6 }}>
                        <Badge tone={st.tone} dot>{st.label}</Badge><span className="subtle">{e.progressPercent}%</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          {completed.length ? (
            <>
              <SectionTitle>Completed</SectionTitle>
              <Panel pad={false}>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Course</th><th>Category</th><th>Completed</th><th className="num">Score</th></tr></thead>
                    <tbody>
                      {completed.map((e) => (
                        <tr key={e.id}>
                          <td><Link className="strong" href={`/learn/courses/${e.courseId}`}>{e.course.title}</Link></td>
                          <td className="text-sm">{e.course.category}</td>
                          <td className="text-sm">{formatDate(e.completedAt)}</td>
                          <td className="num">{e.score === null ? <span className="subtle">—</span> : `${e.score}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "catalogue" ? (
        <>
          <form className="row gap-2" style={{ marginBottom: 14 }}>
            <input type="hidden" name="tab" value="catalogue" />
            <input className="input" name="q" defaultValue={sp.q} placeholder="Search courses or categories" style={{ maxWidth: 320 }} />
            <button className="btn">Search</button>
          </form>
          {catalogue.length === 0 ? <Panel><EmptyState title="No courses found" /></Panel> : (
            <div className="grid grid-3">
              {catalogue.map((c) => (
                <div key={c.id} className="k-panel course-card">
                  <div className="course-cover" style={{ background: c.coverColour ?? "var(--brand-500)" }}>
                    <span>{c.category}</span>{c.isMandatory ? <span className="course-flag">Mandatory</span> : null}
                  </div>
                  <div style={{ padding: 14 }}>
                    <Link href={`/learn/courses/${c.id}`} className="strong">{c.title}</Link>
                    {c.summary ? <div className="text-sm muted" style={{ margin: "4px 0 8px" }}>{c.summary}</div> : null}
                    <div className="text-xs subtle" style={{ marginBottom: 10 }}>
                      {LEVEL[c.level]} · {c._count.lessons} lessons · {formatMinutes(c.lessons.reduce((a, l) => a + l.durationMinutes, 0))}
                      {c.skill ? ` · builds ${c.skill.name}` : ""}
                    </div>
                    {enrolledIds.has(c.id)
                      ? <Link className="btn sm" href={`/learn/courses/${c.id}`}>Open</Link>
                      : myId ? <EnrolSelf courseId={c.id} /> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {tab === "team" ? (
        <>
          <div className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="Enrolments" value={tracking.length} />
            <Stat label="Completed" value={tracking.filter((t) => t.status === "COMPLETED").length}
              meta={tracking.length ? `${Math.round((tracking.filter((t) => t.status === "COMPLETED").length / tracking.length) * 100)}% completion` : undefined} />
            <Stat label="Overdue" value={tracking.filter((t) => enrolmentStanding(t, today) === "OVERDUE").length} tone="neg" />
            <Stat label="Not started" value={tracking.filter((t) => enrolmentStanding(t, today) === "NOT_STARTED").length} />
          </div>
          <Panel title="Who still has learning to finish" subtitle="Overdue first; completed enrolments are counted above but not listed" pad={false}>
            {tracking.filter((t) => t.status !== "COMPLETED").length === 0 ? <EmptyState title="Everyone is up to date" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Course</th><th>Due</th><th>Status</th><th style={{ minWidth: 120 }}>Progress</th></tr></thead>
                  <tbody>
                    {tracking.filter((t) => t.status !== "COMPLETED")
                      .sort((a, b) => (enrolmentStanding(a, today) === "OVERDUE" ? 0 : 1) - (enrolmentStanding(b, today) === "OVERDUE" ? 0 : 1))
                      .map((t) => {
                        const st = STANDING[enrolmentStanding(t, today)];
                        return (
                          <tr key={t.id}>
                            <td><Person name={t.employee.displayName ?? ""} meta={`${t.employee.employeeNumber} · ${t.employee.department?.name ?? "—"}`} /></td>
                            <td><Link href={`/learn/courses/${t.course.id}`}>{t.course.title}</Link>{t.course.isMandatory ? <div className="text-xs subtle">Mandatory</div> : null}</td>
                            <td className="text-sm nowrap">{t.dueDate ? formatDate(t.dueDate) : <span className="subtle">—</span>}</td>
                            <td><Badge tone={st.tone} dot>{st.label}</Badge></td>
                            <td><Progress value={t.progressPercent} max={100} /><div className="text-xs subtle">{t.progressPercent}%</div></td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      {tab === "manage" ? (
        <>
          {sp.new ? (
            <div style={{ marginBottom: 18 }}>
              <Panel title="New course"><CourseForm skills={skills.map((s) => ({ value: s.id, label: s.name }))} /></Panel>
            </div>
          ) : null}
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Course</th><th>Category</th><th>Status</th><th className="num">Lessons</th><th className="num">Enrolled</th><th style={{ minWidth: 140 }}>Completion</th></tr></thead>
                <tbody>
                  {catalogue.map((c) => (
                    <tr key={c.id}>
                      <td><Link className="strong" href={`/learn/courses/${c.id}`}>{c.title}</Link><div className="text-xs subtle">{LEVEL[c.level]}{c.isMandatory ? " · mandatory" : ""}{c.skill ? ` · ${c.skill.name}` : ""}</div></td>
                      <td className="text-sm">{c.category}</td>
                      <td><Badge tone={c.status === "PUBLISHED" ? "success" : c.status === "DRAFT" ? "neutral" : "info"} dot>{c.status.toLowerCase()}</Badge></td>
                      <td className="num">{c._count.lessons}</td>
                      <td className="num">{c._count.enrolments}</td>
                      <td>
                        {c._count.enrolments === 0 ? <span className="text-xs subtle">—</span> : (
                          <>
                            <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 3 }}><span>{c.enrolments.length} / {c._count.enrolments}</span><span>{Math.round((c.enrolments.length / c._count.enrolments) * 100)}%</span></div>
                            <Progress value={c.enrolments.length} max={c._count.enrolments} tone="success" />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}
    </>
  );
}
