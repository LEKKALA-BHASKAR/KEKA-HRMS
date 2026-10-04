import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatMinutes } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { ActButton } from "@/components/growth-forms";
import { EnrolSelf } from "../forms";
import { requestEnrolmentAction, joinPathAction } from "@/app/actions/learn-growth";
import { selfEnrolAction } from "@/app/actions/performance-learn";

const P = PERMISSIONS;
const LEVEL: Record<string, string> = { BEGINNER: "Beginner", INTERMEDIATE: "Intermediate", ADVANCED: "Advanced" };

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; level?: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const sp = await searchParams;
  const myId = viewer.employee?.id;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const text = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const [courses, categories, programmes, paths, enrolled, pending, done] = await Promise.all([
    prisma.course.findMany({
      where: {
        tenantId: viewer.tenantId, status: "PUBLISHED",
        ...(text ? { OR: [{ title: text }, { category: text }, { summary: text }] } : {}),
        ...(sp.category ? { category: sp.category } : {}),
        ...(sp.level && LEVEL[sp.level] ? { level: sp.level as "BEGINNER" } : {}),
      },
      orderBy: [{ isMandatory: "desc" }, { title: "asc" }],
      include: { skill: { select: { name: true } }, lessons: { select: { durationMinutes: true } }, _count: { select: { lessons: true } } },
    }),
    prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED" }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
    prisma.trainingProgram.findMany({ where: { tenantId: viewer.tenantId, format: "COURSE", courseState: "PUBLISHED", ...(text ? { OR: [{ title: text }, { category: text }] } : {}) }, include: { _count: { select: { modules: true } }, enrolments: myId ? { where: { employeeId: myId }, select: { status: true } } : false }, orderBy: { title: "asc" } }),
    prisma.learningPath.findMany({ where: { tenantId: viewer.tenantId, status: "APPROVED", ...(text ? { OR: [{ name: text }, { category: text }] } : {}) }, include: { courses: { select: { id: true } }, assignments: myId ? { where: { employeeId: myId }, select: { id: true } } : false }, orderBy: { name: "asc" } }),
    myId ? prisma.courseEnrolment.findMany({ where: { employeeId: myId }, select: { courseId: true } }) : Promise.resolve([]),
    myId ? prisma.learningRequest.findMany({ where: { employeeId: myId, kind: "ENROLMENT", status: "PENDING" }, select: { courseId: true } }) : Promise.resolve([]),
    myId ? prisma.courseEnrolment.findMany({ where: { employeeId: myId, status: "COMPLETED" }, select: { courseId: true } }) : Promise.resolve([]),
  ]);
  const enrolledIds = new Set(enrolled.map((e) => e.courseId));
  const pendingIds = new Set(pending.map((e) => e.courseId));
  const doneIds = new Set(done.map((e) => e.courseId));
  const preIds = [...new Set(courses.map((c) => c.prerequisiteCourseId).filter((x): x is string => !!x))];
  const pre = new Map((preIds.length ? await prisma.course.findMany({ where: { id: { in: preIds }, tenantId: viewer.tenantId }, select: { id: true, title: true } }) : []).map((c) => [c.id, c]));

  return (
    <>
      <PageHead title="Course Library" subtitle={`${courses.length + programmes.length} courses${paths.length ? ` · ${paths.length} learning paths` : ""}`} />
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search courses, paths or categories" style={{ maxWidth: 320 }} />
        <select className="select" name="category" defaultValue={sp.category ?? ""} style={{ maxWidth: 200 }}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
        </select>
        <select className="select" name="level" defaultValue={sp.level ?? ""} style={{ maxWidth: 160 }}>
          <option value="">Any level</option>
          {Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Search</button>
        {q || sp.category || sp.level ? <Link className="btn ghost" href="/learn/library">Clear</Link> : null}
      </form>

      {courses.length === 0 && programmes.length === 0 ? <Panel><EmptyState title="No courses found" /></Panel> : (
        <div className="grid grid-3" style={{ marginBottom: 18 }}>
          {courses.map((c) => {
            const blocked = c.prerequisiteCourseId && !doneIds.has(c.prerequisiteCourseId) ? (pre.get(c.prerequisiteCourseId) ?? null) : null;
            return (
              <div key={c.id} className="k-panel course-card">
                <div className="course-cover" style={{ background: c.coverColour ?? "var(--brand-500)" }}>
                  <span>{c.category}</span>{c.isMandatory ? <span className="course-flag">Mandatory</span> : null}
                </div>
                <div style={{ padding: 14 }}>
                  <Link href={`/learn/courses/${c.id}`} className="strong">{c.title}</Link>
                  {c.summary ? <div className="text-sm muted" style={{ margin: "4px 0 8px" }}>{c.summary}</div> : null}
                  <div className="text-xs subtle" style={{ marginBottom: 10 }}>
                    {LEVEL[c.level]} · {c._count.lessons} lessons · {formatMinutes(c.lessons.reduce((a, l) => a + l.durationMinutes, 0))}
                    {c.credits ? ` · ${c.credits} credits` : ""}{c.skill ? ` · builds ${c.skill.name}` : ""}
                  </div>
                  {blocked ? <div className="text-xs neg" style={{ marginBottom: 6 }}>Complete “{blocked.title}” first</div> : null}
                  {enrolledIds.has(c.id) ? <Link className="btn sm" href={`/learn/courses/${c.id}`}>Open</Link>
                    : !myId || blocked ? null
                    : pendingIds.has(c.id) ? <Badge tone="warning" dot>Request pending</Badge>
                    : c.requiresApproval ? <ActButton action={requestEnrolmentAction} hidden={{ courseId: c.id }} label="Request enrolment" variant="primary" input={{ name: "reason", placeholder: "Why (optional)" }} />
                    : <EnrolSelf courseId={c.id} />}
                </div>
              </div>
            );
          })}
          {programmes.map((c) => {
            const mine = Array.isArray(c.enrolments) ? c.enrolments.find((e) => e.status !== "WITHDRAWN") : undefined;
            return (
              <div key={c.id} className="k-panel course-card">
                <div className="course-cover" style={{ background: "var(--brand-500)" }}><span>{c.category ?? "Course"}</span>{c.isMandatory ? <span className="course-flag">Mandatory</span> : null}</div>
                <div style={{ padding: 14 }}>
                  <Link href={`/learn/courses/${c.id}`} className="strong">{c.title}</Link>
                  {c.description ? <div className="text-sm muted" style={{ margin: "4px 0 8px" }}>{c.description.slice(0, 160)}</div> : null}
                  <div className="text-xs subtle" style={{ marginBottom: 10 }}>{c._count.modules} modules</div>
                  {mine ? <Link className="btn sm" href={`/learn/courses/${c.id}`}>Open</Link> : myId && c.selfEnrol ? <ActButton action={selfEnrolAction} hidden={{ courseId: c.id }} label="Enrol" variant="primary" /> : <span className="text-xs subtle">Assigned by HR</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {paths.length ? (
        <>
          <SectionTitle sub="A sequence of courses towards a role or skill">Learning paths</SectionTitle>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Path</th><th>Category</th><th className="num">Courses</th><th /></tr></thead>
                <tbody>
                  {paths.map((p) => (
                    <tr key={p.id}>
                      <td><Link className="strong" href={`/learn/paths/${p.id}`}>{p.name}</Link>{p.jobTitle ? <div className="text-xs subtle">For {p.jobTitle}</div> : null}</td>
                      <td className="text-sm">{p.category ?? "—"}</td>
                      <td className="num">{p.courses.length}</td>
                      <td className="right">{Array.isArray(p.assignments) && p.assignments.length ? <Badge tone="success" dot>On this path</Badge> : myId ? <ActButton action={joinPathAction} hidden={{ pathId: p.id }} label="Join path" /> : null}</td>
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
