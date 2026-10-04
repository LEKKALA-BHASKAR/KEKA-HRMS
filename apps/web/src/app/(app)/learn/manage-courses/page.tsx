import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { PageHead, Badge, Progress } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { GrowthForm } from "@/components/growth-forms";
import { CourseForm } from "../forms";
import { createCourseAction } from "@/app/actions/performance-learn";

const P = PERMISSIONS;
const LEVEL: Record<string, string> = { BEGINNER: "Beginner", INTERMEDIATE: "Intermediate", ADVANCED: "Advanced" };
const TONE: Record<string, "success" | "neutral" | "info" | "warning"> = { PUBLISHED: "success", DRAFT: "neutral", IN_REVIEW: "warning", ARCHIVED: "info" };

export default async function ManageCoursesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; new?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.COURSE_MANAGE, P.TRAINING_MANAGE])) forbidden();
  const sp = await searchParams;
  const canCourses = can(viewer, P.COURSE_MANAGE);
  const canBuilder = can(viewer, P.TRAINING_MANAGE);
  const q = (sp.q ?? "").trim().slice(0, 80);
  const text = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const status = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"].includes(sp.status ?? "") ? (sp.status as "DRAFT") : undefined;

  const [courses, allCourses, skills, programmes] = await Promise.all([
    canCourses ? prisma.course.findMany({
      where: { tenantId: viewer.tenantId, ...(status ? { status } : {}), ...(text ? { OR: [{ title: text }, { category: text }] } : {}) },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      include: { skill: { select: { name: true } }, _count: { select: { lessons: true, enrolments: true } }, enrolments: { where: { status: "COMPLETED" }, select: { id: true } } },
    }) : Promise.resolve([]),
    canCourses && sp.new ? prisma.course.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true }, orderBy: { title: "asc" } }) : Promise.resolve([]),
    canCourses && sp.new ? prisma.skill.findMany({ where: { tenantId: viewer.tenantId, isActive: true, status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    canBuilder ? prisma.trainingProgram.findMany({
      where: { tenantId: viewer.tenantId, format: "COURSE", ...(text ? { OR: [{ title: text }, { category: text }] } : {}) },
      include: { _count: { select: { modules: true, sections: true, enrolments: true } }, enrolments: { where: { status: "COMPLETED" }, select: { id: true } } },
      orderBy: { updatedAt: "desc" },
    }) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHead
        title="Manage Courses"
        subtitle="Author, review and publish courses; track completion"
        actions={<>
          {canCourses ? <Link className="btn primary" href={sp.new ? "/learn/manage-courses" : "/learn/manage-courses?new=1"}>{sp.new ? "Cancel" : "+ New course"}</Link> : null}
          <Link className="btn" href="/learn/reports">Reports</Link>
        </>}
      />
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search by title or category" style={{ maxWidth: 300 }} />
        {canCourses ? (
          <select className="select" name="status" defaultValue={status ?? ""} style={{ maxWidth: 180 }}>
            <option value="">Any status</option><option value="DRAFT">Draft</option><option value="IN_REVIEW">In review</option><option value="PUBLISHED">Published</option><option value="ARCHIVED">Archived</option>
          </select>
        ) : null}
        <button className="btn">Search</button>
      </form>

      {canCourses && sp.new ? (
        <div style={{ marginBottom: 18 }}>
          <Panel title="New course" subtitle="Lesson-based: articles, videos, documents and quizzes"><CourseForm skills={skills.map((s) => ({ value: s.id, label: s.name }))} courses={allCourses.map((c) => ({ value: c.id, label: c.title }))} /></Panel>
        </div>
      ) : null}

      {canCourses ? (
        <Panel title={`Courses (${courses.length})`} pad={false}>
          {courses.length === 0 ? <EmptyState title="No courses match" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Course</th><th>Category</th><th>Status</th><th className="num">Lessons</th><th className="num">Enrolled</th><th style={{ minWidth: 140 }}>Completion</th><th>Updated</th></tr></thead>
                <tbody>
                  {courses.map((c) => (
                    <tr key={c.id}>
                      <td><Link className="strong" href={`/learn/courses/${c.id}?view=admin`}>{c.title}</Link><div className="text-xs subtle">{LEVEL[c.level]} · v{c.version}{c.isMandatory ? " · mandatory" : ""}{c.requiresApproval ? " · needs approval" : ""}{c.skill ? ` · ${c.skill.name}` : ""}</div></td>
                      <td className="text-sm">{c.category}</td>
                      <td><Badge tone={TONE[c.status]} dot>{c.status.replace("_", " ").toLowerCase()}</Badge>{c.reviewNote && c.status === "DRAFT" ? <div className="text-xs neg">Sent back: {c.reviewNote}</div> : null}</td>
                      <td className="num">{c._count.lessons}</td>
                      <td className="num">{c._count.enrolments}</td>
                      <td>{c._count.enrolments === 0 ? <span className="text-xs subtle">—</span> : <><Progress value={c.enrolments.length} max={c._count.enrolments} tone="success" /><div className="text-xs subtle">{c.enrolments.length} / {c._count.enrolments}</div></>}</td>
                      <td className="text-sm nowrap">{formatDate(c.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {canBuilder ? (
        <>
          <SectionTitle sub="Sections and modules — pages, videos, PDFs and graded assessments">Course builder</SectionTitle>
          <Panel title="Start a course in the builder"><GrowthForm action={createCourseAction} submitLabel="Create" cols={2} fields={[{ name: "title", label: "Title", required: true }, { name: "description", label: "Description", type: "textarea" }]} /></Panel>
          <div style={{ height: 14 }} />
          <Panel title={`Builder courses (${programmes.length})`} pad={false}>
            {programmes.length === 0 ? <EmptyState title="No builder courses yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Course</th><th>State</th><th className="num">Sections</th><th className="num">Modules</th><th className="num">Learners</th><th className="num">Completed</th><th>Updated</th></tr></thead>
                  <tbody>
                    {programmes.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="strong" href={`/learn/manage-courses/${c.id}`}>{c.title}</Link>{c.category ? <div className="text-xs subtle">{c.category}</div> : null}</td>
                        <td><Badge tone={c.courseState === "PUBLISHED" ? "success" : c.courseState === "ARCHIVED" ? "info" : "neutral"} dot>{(c.courseState ?? "DRAFT").toLowerCase()}</Badge></td>
                        <td className="num">{c._count.sections}</td>
                        <td className="num">{c._count.modules}</td>
                        <td className="num">{c._count.enrolments}</td>
                        <td className="num">{c.enrolments.length}</td>
                        <td className="text-sm nowrap">{formatDate(c.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </>
  );
}
