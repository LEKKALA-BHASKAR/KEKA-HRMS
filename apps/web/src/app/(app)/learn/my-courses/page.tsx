import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { enrolmentStanding, formatMinutes, certificateStatus } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Badge, Progress, Stat } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { ActButton } from "@/components/growth-forms";
import { withdrawLearningRequestAction, cancelRegistrationAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;
const STANDING: Record<string, { label: string; tone: "success" | "danger" | "warning" | "info" | "neutral" }> = {
  COMPLETED: { label: "Completed", tone: "success" }, OVERDUE: { label: "Overdue", tone: "danger" },
  DUE_SOON: { label: "Due soon", tone: "warning" }, ON_TRACK: { label: "In progress", tone: "info" }, NOT_STARTED: { label: "Not started", tone: "neutral" },
};
const CERT: Record<string, "success" | "warning" | "danger" | "neutral"> = { VALID: "success", EXPIRING: "warning", EXPIRED: "danger", REVOKED: "neutral" };

export default async function MyCoursesPage() {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const myId = viewer.employee?.id;
  const today = new Date();
  if (!myId) {
    return (
      <>
        <PageHead title="My Courses" subtitle="Your learning" />
        <Panel><EmptyState title="No employee record">This login is not linked to an employee. Browse the <Link href="/learn/library">course library</Link>.</EmptyState></Panel>
      </>
    );
  }
  const [mine, paths, requests, sessions, certificates, programmes] = await Promise.all([
    prisma.courseEnrolment.findMany({
      where: { employeeId: myId, tenantId: viewer.tenantId, course: { status: { not: "DRAFT" } } },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }],
      include: { course: { include: { _count: { select: { lessons: true } }, lessons: { select: { durationMinutes: true } } } } },
    }),
    prisma.learningPathAssignment.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { path: { include: { courses: { orderBy: { sequence: "asc" }, include: { course: { select: { id: true, title: true } } } } } } }, orderBy: { assignedAt: "desc" } }),
    prisma.learningRequest.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { course: { select: { id: true, title: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.sessionRegistration.findMany({ where: { employeeId: myId, session: { tenantId: viewer.tenantId, endsAt: { gte: new Date(today.getTime() - 30 * 86_400_000) } } }, include: { session: true }, orderBy: { session: { startsAt: "asc" } } }),
    prisma.learningCertificate.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { course: { select: { title: true } } }, orderBy: { issuedAt: "desc" } }),
    prisma.trainingEnrolment.findMany({ where: { employeeId: myId, status: { not: "WITHDRAWN" }, program: { tenantId: viewer.tenantId, format: "COURSE", courseState: "PUBLISHED" } }, include: { program: { select: { id: true, title: true, category: true } } }, orderBy: { assignedAt: "desc" } }),
  ]);

  const inProgress = mine.filter((e) => e.status !== "COMPLETED");
  const completed = mine.filter((e) => e.status === "COMPLETED");
  const overdue = inProgress.filter((e) => enrolmentStanding(e, today) === "OVERDUE");
  const minutesLearnt = completed.reduce((s, e) => s + e.course.lessons.reduce((a, l) => a + l.durationMinutes, 0), 0);
  const credits = completed.reduce((s, e) => s + (e.course.credits ?? 0), 0);
  const certBy = new Map(certificates.map((c) => [c.enrolmentId, c]));

  return (
    <>
      <PageHead title="My Courses" subtitle="Assigned learning, paths, sessions and certificates" actions={<Link className="btn primary" href="/learn/library">Browse the library</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="In progress" value={inProgress.length} meta={`${overdue.length} overdue`} tone={overdue.length ? "neg" : undefined} />
        <Stat label="Completed" value={completed.length} meta={`${credits} credits earned`} />
        <Stat label="Time learnt" value={formatMinutes(minutesLearnt)} meta="Across completed courses" />
        <Stat label="Certificates" value={certificates.filter((c) => certificateStatus(c, today) !== "REVOKED").length} meta={`${certificates.filter((c) => certificateStatus(c, today) === "EXPIRING").length} expiring soon`} />
      </div>

      <SectionTitle sub="Assigned to you or chosen by you">Continue learning</SectionTitle>
      {inProgress.length === 0 && programmes.filter((p) => p.status !== "COMPLETED").length === 0 ? (
        <Panel><EmptyState title="Nothing in progress">Browse the <Link href="/learn/library">course library</Link> to pick up something new.</EmptyState></Panel>
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
          {programmes.filter((p) => p.status !== "COMPLETED").map((p) => (
            <Link key={p.id} href={`/learn/courses/${p.programId}`} className="k-panel course-card">
              <div className="course-cover" style={{ background: "var(--brand-500)" }}><span>{p.program.category ?? "Course"}</span></div>
              <div style={{ padding: 14 }}>
                <div className="strong" style={{ marginBottom: 8 }}>{p.program.title}</div>
                <Progress value={p.progressPercent} max={100} />
                <div className="text-xs subtle" style={{ marginTop: 6 }}>{p.progressPercent}%</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {paths.length ? (
        <>
          <SectionTitle sub="Courses grouped into a sequence">My learning paths</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Path</th><th>Courses</th><th>Due</th><th>Status</th><th style={{ minWidth: 140 }}>Progress</th></tr></thead>
                <tbody>
                  {paths.map((a) => (
                    <tr key={a.id}>
                      <td><Link className="strong" href={`/learn/paths/${a.pathId}`}>{a.path.name}</Link></td>
                      <td className="text-sm">{a.path.courses.map((c) => <Link key={c.id} href={`/learn/courses/${c.course.id}`} style={{ marginRight: 8 }}>{c.course.title}{c.isOptional ? " (optional)" : ""}</Link>)}</td>
                      <td className="text-sm nowrap">{a.dueDate ? formatDate(a.dueDate) : "—"}</td>
                      <td><Badge tone={a.status === "COMPLETED" ? "success" : "info"} dot>{a.status.replace("_", " ").toLowerCase()}</Badge></td>
                      <td><Progress value={a.progressPercent} max={100} tone={a.status === "COMPLETED" ? "success" : undefined} /><div className="text-xs subtle">{a.progressPercent}%</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}

      {sessions.length ? (
        <>
          <SectionTitle sub="Classroom and virtual training">My sessions</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Session</th><th>When</th><th>Where</th><th>Registration</th><th>Attendance</th><th /></tr></thead>
                <tbody>
                  {sessions.map((r) => (
                    <tr key={r.id}>
                      <td><Link className="strong" href={`/learn/sessions/${r.sessionId}`}>{r.session.title}</Link>{r.session.status !== "SCHEDULED" ? <div className="text-xs subtle">{r.session.status.toLowerCase()}</div> : null}</td>
                      <td className="text-sm nowrap">{formatDate(r.session.startsAt)} {r.session.startsAt.toISOString().slice(11, 16)}</td>
                      <td className="text-sm">{r.session.mode === "VIRTUAL" ? "Online" : (r.session.venue ?? "—")}</td>
                      <td><Badge tone={r.status === "REGISTERED" ? "success" : r.status === "WAITLISTED" || r.status === "REQUESTED" ? "warning" : "neutral"} dot>{r.status.toLowerCase()}</Badge></td>
                      <td className="text-sm">{r.attendance ? r.attendance.toLowerCase() : "—"}</td>
                      <td className="right">{["REGISTERED", "WAITLISTED", "REQUESTED"].includes(r.status) && r.session.startsAt > today ? <ActButton action={cancelRegistrationAction} hidden={{ registrationId: r.id }} label="Cancel" variant="ghost" confirmText="Give up your place?" /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}

      {requests.length ? (
        <>
          <SectionTitle sub="Enrolment and retake requests to your manager">My requests</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Course</th><th>Request</th><th>Asked</th><th>Status</th><th>Note</th><th /></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/learn/courses/${r.course.id}`}>{r.course.title}</Link></td>
                      <td className="text-sm">{r.kind === "RETAKE" ? "Quiz retake" : "Enrolment"}</td>
                      <td className="text-sm nowrap">{formatDate(r.createdAt)}</td>
                      <td><Badge tone={r.status === "APPROVED" ? "success" : r.status === "PENDING" ? "warning" : "neutral"} dot>{r.status.toLowerCase()}</Badge></td>
                      <td className="text-sm">{r.decisionNote ?? "—"}</td>
                      <td className="right">{r.status === "PENDING" ? <ActButton action={withdrawLearningRequestAction} hidden={{ requestId: r.id }} label="Withdraw" variant="ghost" /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}

      {completed.length || programmes.some((p) => p.status === "COMPLETED") ? (
        <>
          <SectionTitle sub="Your learning record">Completed</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Course</th><th>Category</th><th>Completed</th><th className="num">Score</th><th className="num">Credits</th><th>Certificate</th></tr></thead>
                <tbody>
                  {completed.map((e) => {
                    const cert = certBy.get(e.id);
                    const cs = cert ? certificateStatus(cert, today) : null;
                    return (
                      <tr key={e.id}>
                        <td><Link className="strong" href={`/learn/courses/${e.courseId}`}>{e.course.title}</Link></td>
                        <td className="text-sm">{e.course.category}</td>
                        <td className="text-sm">{formatDate(e.completedAt)}</td>
                        <td className="num">{e.score === null ? <span className="subtle">—</span> : `${e.score}%`}</td>
                        <td className="num">{e.course.credits}</td>
                        <td>{cert && cs ? (
                          <span className="row gap-2"><Badge tone={CERT[cs]} dot>{cs.toLowerCase()}{cert.expiresAt ? ` · ${formatDate(cert.expiresAt)}` : ""}</Badge>{cs !== "REVOKED" ? <a className="btn sm" href={`/learn/certificates/${cert.id}`}>PDF</a> : null}</span>
                        ) : <span className="subtle">—</span>}</td>
                      </tr>
                    );
                  })}
                  {programmes.filter((p) => p.status === "COMPLETED").map((p) => (
                    <tr key={p.id}>
                      <td><Link className="strong" href={`/learn/courses/${p.programId}`}>{p.program.title}</Link></td>
                      <td className="text-sm">{p.program.category ?? "—"}</td>
                      <td className="text-sm">{formatDate(p.completedAt)}</td>
                      <td className="num">{p.score === null ? "—" : `${Number(p.score)}%`}</td>
                      <td className="num">—</td>
                      <td className="subtle">—</td>
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
