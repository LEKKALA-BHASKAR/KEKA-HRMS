import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { formatMinutes, enrolmentStanding, attemptsLeft, certificateStatus } from "@keka/services";
import { requireAuth, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Progress, Person, Callout } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { CourseForm, LessonForm, QuizQuestionForm, RemoveLesson, CourseOp, EnrolSelf, MarkComplete, QuizForm, AssignForm, RemoveEnrolment } from "../../forms";
import { ActButton, GrowthForm, Reveal } from "@/components/growth-forms";
import { ProgramPlayer } from "./program-player";
import { courseReviewAction, requestEnrolmentAction, requestRetakeAction, updateQuizQuestionAction, deleteQuizQuestionAction, importQuizQuestionsAction, setQuizRulesAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;
const KIND_ICON: Record<string, string> = { ARTICLE: "📄", VIDEO: "▶", DOCUMENT: "📎", QUIZ: "✎" };
const KIND_LABEL: Record<string, string> = { ARTICLE: "Article", VIDEO: "Video", DOCUMENT: "Document", QUIZ: "Quiz" };

/** A YouTube link becomes an embeddable URL; anything else is opened in a new tab. */
function youtubeEmbed(url: string | null): string | null {
  if (!url) return null;
  const m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/.exec(url);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
}

export default async function CoursePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ lesson?: string; edit?: string; view?: string }>;
}) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const { id } = await params;
  const sp = await searchParams;
  const canManage = can(viewer, P.COURSE_MANAGE);
  const canAssign = canAny(viewer, [P.COURSE_ASSIGN, P.COURSE_MANAGE]);

  const course = await prisma.course.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      skill: { select: { name: true, levels: true } },
      lessons: { orderBy: { sequence: "asc" }, include: { questions: { orderBy: { sequence: "asc" } } } },
    },
  });
  // A course made in the section/module builder plays in its own player.
  if (!course) return <ProgramPlayer viewer={viewer} id={id} moduleId={sp.lesson} />;
  if ((course.status === "DRAFT" || course.status === "IN_REVIEW") && !canManage) notFound();

  const enrolment = viewer.employee
    ? await prisma.courseEnrolment.findUnique({
        where: { courseId_employeeId: { courseId: course.id, employeeId: viewer.employee.id } },
        include: { lessons: true },
      })
    : null;
  if (course.status === "ARCHIVED" && !enrolment && !canAssign) notFound();

  const adminView = (canManage || canAssign) && (sp.view === "admin" || !enrolment);
  const progressBy = new Map(enrolment?.lessons.map((l) => [l.lessonId, l]) ?? []);
  const current = course.lessons.find((l) => l.id === sp.lesson)
    ?? course.lessons.find((l) => !progressBy.get(l.id)?.completedAt)
    ?? course.lessons[0];
  const totalMinutes = course.lessons.reduce((s, l) => s + l.durationMinutes, 0);

  const [enrolments, people, skills] = adminView
    ? await Promise.all([
        prisma.courseEnrolment.findMany({
          where: { courseId: course.id, employee: scopedEmployeeWhere(viewer, canManage ? P.COURSE_MANAGE : P.COURSE_ASSIGN) },
          include: { employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } } },
          orderBy: [{ status: "asc" }, { dueDate: "asc" }],
        }),
        prisma.employee.findMany({
          where: {
            ...scopedEmployeeWhere(viewer, canManage ? P.COURSE_MANAGE : P.COURSE_ASSIGN),
            status: { notIn: ["EXITED", "INACTIVE"] }, courseEnrolments: { none: { courseId: course.id } },
          },
          select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" },
        }),
        canManage && sp.edit ? prisma.skill.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
      ])
    : [[], [], []];

  const levels = Array.isArray(course.skill?.levels) ? (course.skill!.levels as string[]) : [];
  const [certificate, pendingRequest, retakes, prereq, otherCourses] = await Promise.all([
    enrolment ? prisma.learningCertificate.findUnique({ where: { enrolmentId: enrolment.id } }) : Promise.resolve(null),
    viewer.employee ? prisma.learningRequest.findFirst({ where: { employeeId: viewer.employee.id, courseId: course.id, status: "PENDING" } }) : Promise.resolve(null),
    viewer.employee ? prisma.learningRequest.findMany({ where: { employeeId: viewer.employee.id, courseId: course.id, kind: "RETAKE", status: "APPROVED" }, select: { lessonId: true } }) : Promise.resolve([]),
    course.prerequisiteCourseId ? prisma.course.findUnique({ where: { id: course.prerequisiteCourseId }, select: { id: true, title: true } }) : Promise.resolve(null),
    canManage && sp.edit ? prisma.course.findMany({ where: { tenantId: viewer.tenantId, id: { not: course.id } }, select: { id: true, title: true }, orderBy: { title: "asc" } }) : Promise.resolve([]),
  ]);
  const quizLeft = (lessonId: string, maxAttempts: number | null) => attemptsLeft(maxAttempts, progressBy.get(lessonId)?.attempts ?? 0, retakes.filter((r) => r.lessonId === lessonId).length);
  const certState = certificate ? certificateStatus(certificate) : null;

  return (
    <>
      <PageHead
        title={course.title}
        subtitle={
          <span className="row gap-2 wrap">
            <Badge tone="brand">{course.category}</Badge>
            {course.status !== "PUBLISHED" ? <Badge tone={course.status === "DRAFT" ? "neutral" : "info"} dot>{course.status.toLowerCase()}</Badge> : null}
            {course.isMandatory ? <Badge tone="warning">Mandatory</Badge> : null}
            <span className="text-sm subtle">{course.lessons.length} lessons · {formatMinutes(totalMinutes)}{course.skill ? ` · builds ${course.skill.name}${levels[course.skillLevel] ? ` (${levels[course.skillLevel]})` : ""}` : ""}</span>
          </span>
        }
        actions={
          <>
            <Link className="btn" href={adminView && canManage ? "/learn/manage-courses" : "/learn/my-courses"}>Back</Link>
            {enrolment && (canManage || canAssign) ? <Link className="btn" href={`/learn/courses/${course.id}${adminView ? "" : "?view=admin"}`}>{adminView ? "Learner view" : "Admin view"}</Link> : null}
            {canManage && adminView ? <Link className="btn" href={`/learn/courses/${course.id}?view=admin${sp.edit ? "" : "&edit=1"}`}>{sp.edit ? "Done editing" : "Edit details"}</Link> : null}
            {canManage && course.status === "DRAFT" ? <ActButton action={courseReviewAction} hidden={{ courseId: course.id, op: "submit" }} label="Submit for review" /> : null}
            {canManage && course.status === "IN_REVIEW" && course.submittedBy !== viewer.user.id ? <ActButton action={courseReviewAction} hidden={{ courseId: course.id, op: "approve" }} label="Approve & publish" variant="primary" /> : null}
            {canManage && course.status === "IN_REVIEW" && course.submittedBy !== viewer.user.id ? <ActButton action={courseReviewAction} hidden={{ courseId: course.id, op: "reject" }} label="Send back" input={{ name: "note", placeholder: "What should change?", required: true }} /> : null}
            {canManage && course.status === "DRAFT" ? <CourseOp courseId={course.id} op="publish" label="Publish now" primary /> : null}
            {canManage && course.status === "PUBLISHED" ? <ActButton action={courseReviewAction} hidden={{ courseId: course.id, op: "revise" }} label="New version" confirmText="Move the course back to draft for changes?" /> : null}
            {canManage && course.status === "PUBLISHED" ? <CourseOp courseId={course.id} op="archive" label="Archive" /> : null}
            {!enrolment && viewer.employee && course.status === "PUBLISHED" && !course.requiresApproval ? <EnrolSelf courseId={course.id} /> : null}
            {!enrolment && viewer.employee && course.status === "PUBLISHED" && course.requiresApproval ? (pendingRequest ? <Badge tone="warning" dot>Request pending</Badge> : <ActButton action={requestEnrolmentAction} hidden={{ courseId: course.id }} label="Request enrolment" variant="primary" input={{ name: "reason", placeholder: "Why (optional)" }} />) : null}
            {certificate && certState !== "REVOKED" ? <a className="btn" href={`/learn/certificates/${certificate.id}`}>Certificate</a> : null}
          </>
        }
      />
      {course.summary ? <p className="muted" style={{ marginTop: -6, marginBottom: 16, maxWidth: 820 }}>{course.summary}</p> : null}
      {prereq ? <p className="text-sm subtle" style={{ marginTop: -8, marginBottom: 12 }}>Prerequisite: <Link href={`/learn/courses/${prereq.id}`}>{prereq.title}</Link></p> : null}
      {course.status === "IN_REVIEW" ? <div style={{ marginBottom: 12 }}><Callout tone="info" title="Waiting for review">{course.submittedBy === viewer.user.id ? "You submitted this course; another course admin approves it." : "Approve to publish it, or send it back with a note."}</Callout></div> : null}
      {course.status === "DRAFT" && course.reviewNote ? <div style={{ marginBottom: 12 }}><Callout tone="warning" title="Sent back by the reviewer">{course.reviewNote}</Callout></div> : null}

      {!adminView && enrolment ? (
        <div className="learn-layout">
          <aside className="k-panel" style={{ padding: 0, alignSelf: "start" }}>
            <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
              <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                <span>{enrolment.status === "COMPLETED" ? `Completed ${formatDate(enrolment.completedAt)}` : "Your progress"}</span><span>{enrolment.progressPercent}%</span>
              </div>
              <Progress value={enrolment.progressPercent} max={100} tone={enrolment.status === "COMPLETED" ? "success" : undefined} />
              {enrolment.dueDate && enrolment.status !== "COMPLETED" ? (
                <div className={`text-xs ${enrolmentStanding(enrolment) === "OVERDUE" ? "neg" : "subtle"}`} style={{ marginTop: 6 }}>Due {formatDate(enrolment.dueDate)}</div>
              ) : null}
            </div>
            <ol className="lesson-list">
              {course.lessons.map((l) => {
                const p = progressBy.get(l.id);
                return (
                  <li key={l.id} className={l.id === current?.id ? "active" : ""}>
                    <Link href={`/learn/courses/${course.id}?lesson=${l.id}`}>
                      <span className={`lesson-check${p?.completedAt ? " done" : ""}`} aria-label={p?.completedAt ? "Done" : "Not done"}>{p?.completedAt ? "✓" : l.sequence}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="text-sm">{l.title}</span>
                        <span className="text-xs subtle" style={{ display: "block" }}>{KIND_LABEL[l.kind]} · {l.durationMinutes} min{l.kind === "QUIZ" && p?.score !== undefined && p?.score !== null ? ` · best ${p.score}%` : ""}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </aside>
          <section>
            {enrolment.status === "COMPLETED" ? (
              <div style={{ marginBottom: 14 }}>
                <Callout tone="success" title="Course complete">
                  {enrolment.score !== null ? `Your quiz average was ${enrolment.score}%. ` : ""}
                  {course.skill ? `${course.skill.name} has been added to your skills.` : "You can revisit any lesson."}
                  {certificate && certState ? <> Certificate {certificate.number} — {certState.toLowerCase()}{certificate.expiresAt ? `, valid until ${formatDate(certificate.expiresAt)}` : ""}. {certState !== "REVOKED" ? <a href={`/learn/certificates/${certificate.id}`}>Download PDF</a> : null}</> : null}
                </Callout>
              </div>
            ) : null}
            {current ? (
              <Panel title={<>{KIND_ICON[current.kind]} {current.title}</>} subtitle={`${KIND_LABEL[current.kind]} · ${current.durationMinutes} minutes`}>
                {current.kind === "VIDEO" ? (
                  youtubeEmbed(current.url) ? (
                    <div className="video-frame"><iframe src={youtubeEmbed(current.url)!} title={current.title} allow="encrypted-media; picture-in-picture" allowFullScreen /></div>
                  ) : <p><a className="btn" href={current.url ?? "#"} target="_blank" rel="noopener noreferrer">Open the video ↗</a></p>
                ) : null}
                {current.kind === "DOCUMENT" ? <p><a className="btn" href={current.url ?? "#"} target="_blank" rel="noopener noreferrer">Open the document ↗</a></p> : null}
                {current.body ? (
                  <div className="lesson-body">{current.body.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}</div>
                ) : null}
                {current.kind === "QUIZ" ? (
                  progressBy.get(current.id)?.completedAt ? (
                    <Callout tone="success" title={`Passed — best score ${progressBy.get(current.id)?.score ?? 0}%`}>You can take it again for practice; your pass stays.</Callout>
                  ) : null
                ) : null}
                {current.kind === "QUIZ" && course.status === "PUBLISHED" ? (
                  !progressBy.get(current.id)?.completedAt && quizLeft(current.id, current.maxAttempts) === 0 ? (
                    <div style={{ marginTop: 12 }}>
                      <Callout tone="warning" title="No attempts left">You have used all {current.maxAttempts} attempts. Ask your manager for a retake.</Callout>
                      <div style={{ marginTop: 8 }}><ActButton action={requestRetakeAction} hidden={{ enrolmentId: enrolment.id, lessonId: current.id }} label="Request a retake" variant="primary" input={{ name: "reason", placeholder: "Why (optional)" }} /></div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 12 }}>
                      <QuizForm enrolmentId={enrolment.id} lessonId={current.id} passPercent={course.passPercent} attemptsLeft={progressBy.get(current.id)?.completedAt ? null : quizLeft(current.id, current.maxAttempts)}
                        questions={current.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options }))} />
                    </div>
                  )
                ) : null}
                {current.kind !== "QUIZ" && course.status === "PUBLISHED" ? (
                  <div className="row gap-2" style={{ marginTop: 16 }}>
                    {progressBy.get(current.id)?.completedAt
                      ? <Badge tone="success" dot>Completed</Badge>
                      : <MarkComplete enrolmentId={enrolment.id} lessonId={current.id} />}
                    {(() => {
                      const next = course.lessons.find((l) => l.sequence === current.sequence + 1);
                      return next ? <Link className="btn sm" href={`/learn/courses/${course.id}?lesson=${next.id}`}>Next lesson →</Link> : null;
                    })()}
                  </div>
                ) : null}
              </Panel>
            ) : <Panel><EmptyState title="This course has no lessons yet" /></Panel>}
          </section>
        </div>
      ) : null}

      {!adminView && !enrolment ? (
        <Panel title="What you will cover">
          <ol className="stack gap-1" style={{ margin: 0, paddingLeft: 20 }}>
            {course.lessons.map((l) => <li key={l.id} className="text-sm">{l.title} <span className="subtle text-xs">· {KIND_LABEL[l.kind]}, {l.durationMinutes} min</span></li>)}
          </ol>
        </Panel>
      ) : null}

      {adminView ? (
        <div className="stack gap-4">
          {canManage && sp.edit ? (
            <Panel title="Course details">
              <CourseForm skills={skills.map((s) => ({ value: s.id, label: s.name }))} courses={otherCourses.map((c) => ({ value: c.id, label: c.title }))} course={course} />
            </Panel>
          ) : null}

          <Panel title={`Lessons (${course.lessons.length})`} subtitle={course.status === "DRAFT" ? "Add lessons, then publish" : "Adding a lesson to a published course re-opens it for everyone who had finished"} pad={false}>
            {course.lessons.length === 0 ? <EmptyState title="No lessons yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th style={{ width: 40 }}>#</th><th>Lesson</th><th>Type</th><th className="num">Minutes</th><th /></tr></thead>
                  <tbody>
                    {course.lessons.map((l) => (
                      <tr key={l.id}>
                        <td className="num subtle">{l.sequence}</td>
                        <td>
                          <span className="strong">{l.title}</span>
                          {l.kind === "QUIZ" ? (
                            <div className="text-xs subtle">{l.questions.length} question{l.questions.length === 1 ? "" : "s"}{l.questions.length ? ": " + l.questions.map((q) => q.prompt).join(" · ") : " — add some below"}</div>
                          ) : l.url ? <div className="text-xs subtle">{l.url}</div> : null}
                        </td>
                        <td className="text-sm">{KIND_LABEL[l.kind]}</td>
                        <td className="num">{l.durationMinutes}</td>
                        <td className="right">{canManage ? <RemoveLesson lessonId={l.id} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {canManage && course.status !== "ARCHIVED" ? (
            <>
              <Panel title="Add a lesson"><LessonForm courseId={course.id} /></Panel>
              {course.lessons.filter((l) => l.kind === "QUIZ").map((l) => (
                <Panel key={l.id} title={`Quiz: “${l.title}”`} subtitle={`${l.questions.length} questions · ${l.maxAttempts ? `${l.maxAttempts} attempts allowed` : "unlimited attempts"}`}>
                  {l.questions.map((q, i) => (
                    <div key={q.id} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                      <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
                        <span className="text-sm">{i + 1}. {q.prompt} <span className="subtle text-xs">({q.options.map((o, oi) => (oi === q.correctIndex ? `✓ ${o}` : o)).join(" · ")})</span></span>
                        <ActButton action={deleteQuizQuestionAction} hidden={{ questionId: q.id }} label="Delete" variant="ghost" confirmText="Delete this question?" />
                      </div>
                      <Reveal label="Edit">
                        <GrowthForm action={updateQuizQuestionAction} hidden={{ questionId: q.id }} compact fields={[
                          { name: "prompt", label: "Question", defaultValue: q.prompt, required: true },
                          { name: "options", label: "Options, one per line", type: "textarea", defaultValue: q.options.join("\n") },
                          { name: "correct", label: "Correct option number", type: "number", min: 1, max: 10, defaultValue: q.correctIndex + 1 },
                        ]} />
                      </Reveal>
                    </div>
                  ))}
                  <div style={{ marginTop: 10 }}><QuizQuestionForm lessonId={l.id} /></div>
                  <Reveal label="Import questions (CSV)">
                    <GrowthForm action={importQuizQuestionsAction} hidden={{ lessonId: l.id }} cols={1} submitLabel="Import" fields={[
                      { name: "file", label: "CSV file", type: "file", hint: "Columns: question, type (single / multiple / true-false), option 1 … option 6, correct (e.g. 2)" },
                      { name: "csv", label: "…or paste the rows", type: "textarea", rows: 4 },
                    ]} />
                  </Reveal>
                  <GrowthForm action={setQuizRulesAction} hidden={{ lessonId: l.id }} cols={2} compact submitLabel="Save rule" fields={[{ name: "maxAttempts", label: "Attempts allowed (blank = unlimited)", type: "number", min: 1, max: 20, defaultValue: l.maxAttempts }]} />
                </Panel>
              ))}
            </>
          ) : null}

          {canAssign && course.status === "PUBLISHED" ? (
            <Panel title="Assign" subtitle="People already enrolled are not listed">
              <AssignForm courseId={course.id} people={people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` }))} />
            </Panel>
          ) : null}

          <Panel title={`Enrolments (${enrolments.length})`} pad={false}>
            {enrolments.length === 0 ? <EmptyState title="Nobody is enrolled yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>How</th><th>Due</th><th>Status</th><th style={{ minWidth: 120 }}>Progress</th><th className="num">Score</th><th /></tr></thead>
                  <tbody>
                    {enrolments.map((e) => (
                      <tr key={e.id}>
                        <td><Person name={e.employee.displayName ?? ""} meta={`${e.employee.employeeNumber} · ${e.employee.department?.name ?? "—"}`} /></td>
                        <td className="text-sm">{e.source.toLowerCase()}</td>
                        <td className="text-sm nowrap">{e.dueDate ? formatDate(e.dueDate) : <span className="subtle">—</span>}</td>
                        <td><Badge tone={e.status === "COMPLETED" ? "success" : enrolmentStanding(e) === "OVERDUE" ? "danger" : "info"} dot>{e.status === "COMPLETED" ? `completed ${formatDate(e.completedAt)}` : enrolmentStanding(e) === "OVERDUE" ? "overdue" : e.status.replace("_", " ").toLowerCase()}</Badge></td>
                        <td><Progress value={e.progressPercent} max={100} tone={e.status === "COMPLETED" ? "success" : undefined} /><div className="text-xs subtle">{e.progressPercent}%</div></td>
                        <td className="num">{e.score === null ? <span className="subtle">—</span> : `${e.score}%`}</td>
                        <td className="right">{canAssign ? <RemoveEnrolment enrolmentId={e.id} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      ) : null}
    </>
  );
}
