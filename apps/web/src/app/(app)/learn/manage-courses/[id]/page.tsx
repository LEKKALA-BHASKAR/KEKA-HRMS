import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { courseProblems } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Badge, Progress, Person, Callout } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { ModuleForm, QuestionForm, BulkQuestions } from "./builder-forms";
import { updateCourseAction, courseStateAction, saveSectionAction, deleteSectionAction, moduleOpAction, questionOpAction, assignCourseAction } from "@/app/actions/performance-learn";

const P = PERMISSIONS;
const TYPE: Record<string, string> = { PAGE: "Page", VIDEO: "Video", DOCUMENT: "PDF", ASSESSMENT: "Assessment" };

/** The course builder: details, sections, modules, assessment questions, publishing and learners. */
export default async function CourseBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.TRAINING_MANAGE);
  const { id } = await params;
  const course = await prisma.trainingProgram.findFirst({
    where: { id, tenantId: viewer.tenantId, format: "COURSE" },
    include: {
      sections: { orderBy: { displayOrder: "asc" } },
      modules: { orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }], include: { questions: { orderBy: { displayOrder: "asc" } } } },
      enrolments: { include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { assignedAt: "desc" } },
    },
  });
  if (!course) notFound();
  const [problems, people] = await Promise.all([
    courseProblems(course.id),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] }, trainingEnrolments: { none: { programId: course.id } } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" }, take: 500 }),
  ]);
  const state = course.courseState ?? "DRAFT";
  const groups = [{ id: null as string | null, title: "Not in a section" }, ...course.sections.map((s) => ({ id: s.id as string | null, title: s.title }))];
  const sectionOpts = course.sections.map((s) => ({ value: s.id, label: s.title }));
  const skills = Array.isArray(course.skills) ? (course.skills as unknown[]).map(String).join(", ") : "";

  return (
    <>
      <PageHead
        title={course.title}
        subtitle={<span className="row gap-2"><Badge tone={state === "PUBLISHED" ? "success" : state === "ARCHIVED" ? "info" : "neutral"} dot>{state.toLowerCase()}</Badge><span className="text-sm subtle">{course.modules.length} modules · {course.enrolments.length} learners · updated {formatDate(course.updatedAt)}</span></span>}
        actions={<>
          <Link className="btn" href="/learn/manage-courses">Back</Link>
          {state === "PUBLISHED" ? <Link className="btn" href={`/learn/courses/${course.id}`}>Learner view</Link> : null}
          {state !== "PUBLISHED" ? <ActButton action={courseStateAction} hidden={{ courseId: course.id, op: "publish" }} label="Publish" variant="primary" /> : <ActButton action={courseStateAction} hidden={{ courseId: course.id, op: "unpublish" }} label="Unpublish" />}
          {state !== "ARCHIVED" ? <ActButton action={courseStateAction} hidden={{ courseId: course.id, op: "archive" }} label="Archive" confirmText="Archive this course?" /> : <ActButton action={courseStateAction} hidden={{ courseId: course.id, op: "restore" }} label="Restore" />}
        </>}
      />
      {problems.length && state !== "PUBLISHED" ? <div style={{ marginBottom: 14 }}><Callout tone="warning" title="Before publishing">{problems.slice(0, 5).join(" ")}</Callout></div> : null}

      <div className="stack gap-4">
        <Panel title="Details">
          <GrowthForm action={updateCourseAction} hidden={{ courseId: course.id, settings: "1" }} cols={3} fields={[
            { name: "title", label: "Title", required: true, defaultValue: course.title },
            { name: "category", label: "Category", defaultValue: course.category },
            { name: "skills", label: "Skills (comma separated)", defaultValue: skills },
            { name: "description", label: "Description", type: "textarea", defaultValue: course.description },
            { name: "selfEnrol", label: "Learners can enrol themselves", type: "checkbox", defaultChecked: course.selfEnrol },
            { name: "isMandatory", label: "Mandatory", type: "checkbox", defaultChecked: course.isMandatory },
          ]} />
        </Panel>

        <Panel title="Sections" subtitle="Group modules into sections">
          <div className="stack gap-2" style={{ marginBottom: 10 }}>
            {course.sections.map((s) => (
              <div key={s.id} className="row gap-2 wrap">
                <GrowthForm action={saveSectionAction} hidden={{ courseId: course.id, sectionId: s.id }} cols={1} compact submitLabel="Rename" fields={[{ name: "title", label: "Section", defaultValue: s.title, required: true }]} />
                <ActButton action={deleteSectionAction} hidden={{ sectionId: s.id }} label="Delete" variant="ghost" confirmText="Delete this section and its modules?" />
              </div>
            ))}
          </div>
          <GrowthForm action={saveSectionAction} hidden={{ courseId: course.id }} cols={2} compact submitLabel="Add section" fields={[{ name: "title", label: "New section", required: true }]} />
        </Panel>

        <Panel title={`Modules (${course.modules.length})`}>
          {course.modules.length === 0 ? <EmptyState title="No modules yet" /> : groups.map((g) => {
            const mods = course.modules.filter((m) => m.sectionId === g.id);
            if (!mods.length) return null;
            return (
              <div key={g.id ?? "none"} style={{ marginBottom: 16 }}>
                <div className="strong text-sm" style={{ marginBottom: 6 }}>{g.title}</div>
                {mods.map((m) => (
                  <div key={m.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 10, marginBottom: 8 }}>
                    <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
                      <span><Badge tone="brand">{TYPE[m.type]}</Badge> <span className="strong">{m.title}</span> <span className="text-xs subtle">{m.durationMinutes} min{m.type === "ASSESSMENT" ? ` · pass ${m.passPercent ?? 70}% · ${m.questions.length} questions` : ""}{m.type === "DOCUMENT" ? (m.fileId ? " · PDF attached" : " · no file yet") : ""}</span></span>
                      <span className="row gap-1">
                        <ActButton action={moduleOpAction} hidden={{ moduleId: m.id, op: "up" }} label="↑" />
                        <ActButton action={moduleOpAction} hidden={{ moduleId: m.id, op: "down" }} label="↓" />
                        <ActButton action={moduleOpAction} hidden={{ moduleId: m.id, op: "delete" }} label="Delete" variant="ghost" confirmText="Delete this module?" />
                      </span>
                    </div>
                    <Reveal label="Edit module"><ModuleForm courseId={course.id} sections={sectionOpts} module={m} /></Reveal>
                    {m.type === "ASSESSMENT" ? (
                      <div style={{ marginTop: 6 }}>
                        {m.questions.map((q, i) => {
                          const opts = (Array.isArray(q.options) ? q.options : []) as Array<{ id: string; text: string }>;
                          const correct = (Array.isArray(q.correctOptionIds) ? q.correctOptionIds : []) as string[];
                          return (
                            <div key={q.id} className="text-sm" style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                              <div className="row gap-2 wrap" style={{ justifyContent: "space-between" }}>
                                <span>{i + 1}. {q.prompt} <span className="subtle text-xs">({opts.map((o) => (correct.includes(o.id) ? `✓ ${o.text}` : o.text)).join(" · ")})</span></span>
                                <span className="row gap-1">
                                  <ActButton action={questionOpAction} hidden={{ questionId: q.id, op: "duplicate" }} label="Duplicate" />
                                  <ActButton action={questionOpAction} hidden={{ questionId: q.id, op: "delete" }} label="Delete" variant="ghost" />
                                </span>
                              </div>
                              <Reveal label="Edit"><QuestionForm moduleId={m.id} question={{ id: q.id, type: q.type, prompt: q.prompt, options: opts, correct }} /></Reveal>
                            </div>
                          );
                        })}
                        <Reveal label="+ Question"><QuestionForm moduleId={m.id} /></Reveal>
                        <div className="text-xs subtle" style={{ marginBottom: 4 }}>Bulk upload: CSV with columns question, type (single / multiple / true-false), option 1 … option 6, correct (option numbers, e.g. 2 or 1;3).</div>
                        <BulkQuestions moduleId={m.id} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            );
          })}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <div className="strong text-sm" style={{ marginBottom: 6 }}>Add a module</div>
            <ModuleForm courseId={course.id} sections={sectionOpts} />
          </div>
        </Panel>

        {state === "PUBLISHED" ? (
          <Panel title="Assign learners">
            <GrowthForm action={assignCourseAction} hidden={{ courseId: course.id }} cols={1} submitLabel="Assign" fields={[{ name: "employeeIds", label: "People", type: "checklist", options: people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` })) }]} />
          </Panel>
        ) : null}

        <Panel title={`Learners (${course.enrolments.length})`} pad={false}>
          {course.enrolments.length === 0 ? <EmptyState title="Nobody is enrolled yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Learner</th><th>Assigned</th><th>Status</th><th style={{ minWidth: 120 }}>Progress</th><th className="num">Score</th></tr></thead>
                <tbody>
                  {course.enrolments.map((e) => (
                    <tr key={e.id}>
                      <td><Person name={e.employee.displayName ?? ""} meta={e.employee.employeeNumber} /></td>
                      <td className="text-sm">{formatDate(e.assignedAt)}</td>
                      <td><Badge tone={e.status === "COMPLETED" ? "success" : "info"} dot>{e.status.replace("_", " ").toLowerCase()}</Badge></td>
                      <td><Progress value={e.progressPercent} max={100} /></td>
                      <td className="num">{e.score === null ? "—" : `${Number(e.score)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
