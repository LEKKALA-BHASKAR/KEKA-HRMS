import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { PageHead, Badge, Progress, Callout } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { ActButton } from "@/components/growth-forms";
import { TakeAssessment } from "../../manage-courses/[id]/builder-forms";
import { selfEnrolAction, completeModuleAction } from "@/app/actions/performance-learn";

const TYPE: Record<string, string> = { PAGE: "Page", VIDEO: "Video", DOCUMENT: "PDF", ASSESSMENT: "Assessment" };

function embed(url: string | null): string | null {
  if (!url) return null;
  const y = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/.exec(url);
  if (y) return `https://www.youtube-nocookie.com/embed/${y[1]}`;
  const v = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  return v ? `https://player.vimeo.com/video/${v[1]}` : null;
}

/** The learner's player for a course made in the builder (sections and modules). */
export async function ProgramPlayer({ viewer, id, moduleId }: { viewer: Viewer; id: string; moduleId?: string }) {
  const course = await prisma.trainingProgram.findFirst({
    where: { id, tenantId: viewer.tenantId, format: "COURSE" },
    include: {
      sections: { orderBy: { displayOrder: "asc" } },
      modules: { orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }], include: { questions: { orderBy: { displayOrder: "asc" }, select: { id: true, type: true, prompt: true, options: true } } } },
    },
  });
  const builder = can(viewer, PERMISSIONS.TRAINING_MANAGE);
  if (!course || (course.courseState !== "PUBLISHED" && !builder)) notFound();
  const enrolment = viewer.employee ? await prisma.trainingEnrolment.findUnique({ where: { programId_employeeId: { programId: course.id, employeeId: viewer.employee.id } }, include: { moduleProgress: true, attempts: { orderBy: { submittedAt: "desc" } } } }) : null;
  const active = enrolment && enrolment.status !== "WITHDRAWN" ? enrolment : null;
  const done = new Set(active?.moduleProgress.map((m) => m.moduleId) ?? []);
  // Sections in order, then modules without a section.
  const ordered = [...course.sections.flatMap((s) => course.modules.filter((m) => m.sectionId === s.id)), ...course.modules.filter((m) => !m.sectionId)];
  const current = ordered.find((m) => m.id === moduleId) ?? ordered.find((m) => !done.has(m.id)) ?? ordered[0];
  const best = current && active ? Math.max(-1, ...active.attempts.filter((a) => a.moduleId === current.id).map((a) => Number(a.scorePercent))) : -1;

  return (
    <>
      <PageHead
        title={course.title}
        subtitle={<span className="row gap-2"><Badge tone="brand">{course.category ?? "Course"}</Badge><span className="text-sm subtle">{ordered.length} modules</span></span>}
        actions={<>
          <Link className="btn" href="/learn/my-courses">Back</Link>
          {builder ? <Link className="btn" href={`/learn/manage-courses/${course.id}`}>Edit in builder</Link> : null}
          {!active && viewer.employee && course.courseState === "PUBLISHED" && course.selfEnrol ? <ActButton action={selfEnrolAction} hidden={{ courseId: course.id }} label="Enrol" variant="primary" /> : null}
        </>}
      />
      {course.description ? <p className="muted" style={{ marginTop: -6, marginBottom: 16, maxWidth: 820 }}>{course.description}</p> : null}
      {!active ? (
        <Panel title="What you will cover">
          {ordered.length === 0 ? <EmptyState title="No modules yet" /> : <ol className="stack gap-1" style={{ margin: 0, paddingLeft: 20 }}>{ordered.map((m) => <li key={m.id} className="text-sm">{m.title} <span className="subtle text-xs">· {TYPE[m.type]}, {m.durationMinutes} min</span></li>)}</ol>}
          {!course.selfEnrol ? <div className="text-sm subtle" style={{ marginTop: 10 }}>This course is assigned by HR.</div> : null}
        </Panel>
      ) : (
        <div className="learn-layout">
          <aside className="k-panel" style={{ padding: 0, alignSelf: "start" }}>
            <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
              <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 4 }}><span>{active.status === "COMPLETED" ? `Completed ${formatDate(active.completedAt)}` : "Your progress"}</span><span>{active.progressPercent}%</span></div>
              <Progress value={active.progressPercent} max={100} tone={active.status === "COMPLETED" ? "success" : undefined} />
            </div>
            <ol className="lesson-list">
              {ordered.map((m, i) => (
                <li key={m.id} className={m.id === current?.id ? "active" : ""}>
                  <Link href={`/learn/courses/${course.id}?lesson=${m.id}`}>
                    <span className={`lesson-check${done.has(m.id) ? " done" : ""}`}>{done.has(m.id) ? "✓" : i + 1}</span>
                    <span style={{ minWidth: 0 }}><span className="text-sm">{m.title}</span><span className="text-xs subtle" style={{ display: "block" }}>{TYPE[m.type]} · {m.durationMinutes} min</span></span>
                  </Link>
                </li>
              ))}
            </ol>
          </aside>
          <section>
            {active.status === "COMPLETED" ? <div style={{ marginBottom: 14 }}><Callout tone="success" title="Course complete">You can revisit any module.</Callout></div> : null}
            {current ? (
              <Panel title={current.title} subtitle={`${TYPE[current.type]} · ${current.durationMinutes} minutes`}>
                {current.type === "VIDEO" ? (embed(current.url) ? <div className="video-frame"><iframe src={embed(current.url)!} title={current.title} allow="encrypted-media; picture-in-picture" allowFullScreen /></div> : <p><a className="btn" href={current.url ?? "#"} target="_blank" rel="noopener noreferrer">Open the video ↗</a></p>) : null}
                {current.type === "DOCUMENT" && current.fileId ? <p><a className="btn" href={`/files/${current.fileId}`}>Download the PDF</a></p> : null}
                {current.type === "PAGE" && current.body ? <div className="lesson-body">{current.body.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}</div> : null}
                {current.type === "ASSESSMENT" ? (
                  <>
                    {best >= 0 ? <div className="text-sm" style={{ marginBottom: 8 }}>Best score so far: <strong>{best}%</strong>{done.has(current.id) ? " — passed" : ""}</div> : null}
                    <TakeAssessment moduleId={current.id} passPercent={current.passPercent ?? 70} questions={current.questions.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: (Array.isArray(q.options) ? q.options : []) as Array<{ id: string; text: string }> }))} />
                  </>
                ) : done.has(current.id) ? <Badge tone="success" dot>Completed</Badge> : <ActButton action={completeModuleAction} hidden={{ moduleId: current.id }} label="Mark as complete" variant="primary" />}
              </Panel>
            ) : <Panel><EmptyState title="This course has no modules yet" /></Panel>}
          </section>
        </div>
      )}
    </>
  );
}
