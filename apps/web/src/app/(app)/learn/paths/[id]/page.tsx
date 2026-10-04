import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Progress, Person, Callout } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReviewButtons } from "@/components/growth-report";
import { savePathAction, pathCourseAction, pathReviewAction, deletePathAction, assignPathAction, joinPathAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;

export default async function PathPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const { id } = await params;
  const admin = can(viewer, P.COURSE_MANAGE);
  const assigner = can(viewer, P.COURSE_ASSIGN);
  const path = await prisma.learningPath.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { courses: { orderBy: { sequence: "asc" }, include: { course: { select: { id: true, title: true, status: true, category: true } } } } },
  });
  if (!path || (path.status !== "APPROVED" && !admin)) notFound();
  const [assignments, candidates, courses, mine] = await Promise.all([
    assigner ? prisma.learningPathAssignment.findMany({ where: { pathId: path.id, employee: scopedEmployeeWhere(viewer, P.COURSE_ASSIGN) }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { assignedAt: "desc" } }) : Promise.resolve([]),
    assigner && path.status === "APPROVED" ? prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.COURSE_ASSIGN), status: { notIn: ["EXITED", "INACTIVE"] }, learningPathAssignments: { none: { pathId: path.id } }, ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}) }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" }, take: 500 }) : Promise.resolve([]),
    admin ? prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: { not: "ARCHIVED" }, pathItems: { none: { pathId: path.id } } }, select: { id: true, title: true }, orderBy: { title: "asc" } }) : Promise.resolve([]),
    viewer.employee ? prisma.learningPathAssignment.findUnique({ where: { pathId_employeeId: { pathId: path.id, employeeId: viewer.employee.id } } }) : Promise.resolve(null),
  ]);
  const editable = admin && ["DRAFT", "REJECTED"].includes(path.status);

  return (
    <>
      <PageHead
        title={path.name}
        subtitle={<span className="row gap-2"><Badge tone={STATUS_TONE[path.status]} dot>{path.status.toLowerCase()}</Badge>{path.isMandatory ? <Badge tone="warning">Mandatory</Badge> : null}<span className="text-sm subtle">{path.courses.length} courses{path.dueInDays ? ` · ${path.dueInDays} days to complete` : ""}{path.jobTitle ? ` · for ${path.jobTitle}` : ""}</span></span>}
        actions={<>
          <Link className="btn" href="/learn/paths">Back</Link>
          {admin ? <ReviewButtons action={pathReviewAction} hidden={{ pathId: path.id }} status={path.status} submittedByMe={path.submittedBy === viewer.user.id} /> : null}
          {admin && path.status === "DRAFT" ? <ActButton action={deletePathAction} hidden={{ pathId: path.id }} label="Delete" variant="ghost" confirmText="Delete this draft path?" /> : null}
          {!mine && viewer.employee && path.status === "APPROVED" ? <ActButton action={joinPathAction} hidden={{ pathId: path.id }} label="Join path" variant="primary" /> : null}
        </>}
      />
      {path.description ? <p className="muted" style={{ marginTop: -6, marginBottom: 14, maxWidth: 820 }}>{path.description}</p> : null}
      {path.decisionNote && path.status === "REJECTED" ? <div style={{ marginBottom: 12 }}><Callout tone="warning" title="Sent back">{path.decisionNote}</Callout></div> : null}
      {mine ? <div style={{ marginBottom: 14 }}><Callout tone={mine.status === "COMPLETED" ? "success" : "info"} title={mine.status === "COMPLETED" ? "You completed this path" : `You are ${mine.progressPercent}% through this path`}>{mine.dueDate ? `Due ${formatDate(mine.dueDate)}.` : ""}</Callout></div> : null}

      <div className="stack gap-4">
        <Panel title="Courses, in order" pad={false}>
          {path.courses.length === 0 ? <EmptyState title="No courses yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th style={{ width: 40 }}>#</th><th>Course</th><th>Category</th><th>Required</th>{editable ? <th /> : null}</tr></thead>
                <tbody>
                  {path.courses.map((c, i) => (
                    <tr key={c.id}>
                      <td className="num subtle">{i + 1}</td>
                      <td><Link className="strong" href={`/learn/courses/${c.course.id}`}>{c.course.title}</Link>{c.course.status !== "PUBLISHED" ? <div className="text-xs neg">{c.course.status.toLowerCase()} — publish it before submitting the path</div> : null}</td>
                      <td className="text-sm">{c.course.category}</td>
                      <td className="text-sm">{c.isOptional ? "Optional" : "Required"}</td>
                      {editable ? <td className="right"><span className="row gap-1">
                        <ActButton action={pathCourseAction} hidden={{ pathId: path.id, courseId: c.courseId, op: "up" }} label="↑" />
                        <ActButton action={pathCourseAction} hidden={{ pathId: path.id, courseId: c.courseId, op: "down" }} label="↓" />
                        <ActButton action={pathCourseAction} hidden={{ pathId: path.id, courseId: c.courseId, op: "remove" }} label="Remove" variant="ghost" />
                      </span></td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {editable ? (
            <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
              <GrowthForm action={pathCourseAction} hidden={{ pathId: path.id, op: "add" }} cols={2} compact submitLabel="Add course" fields={[
                { name: "courseId", label: "Course", type: "select", required: true, options: courses.map((c) => ({ value: c.id, label: c.title })) },
                { name: "isOptional", label: "Optional", type: "checkbox" },
              ]} />
            </div>
          ) : null}
        </Panel>

        {editable ? (
          <Reveal label="Edit details">
            <Panel title="Details">
              <GrowthForm action={savePathAction} hidden={{ id: path.id }} fields={[
                { name: "name", label: "Name", required: true, defaultValue: path.name },
                { name: "category", label: "Category", defaultValue: path.category },
                { name: "jobTitle", label: "For job title", defaultValue: path.jobTitle },
                { name: "dueInDays", label: "Days to complete", type: "number", min: 1, max: 730, defaultValue: path.dueInDays },
                { name: "description", label: "Description", type: "textarea", defaultValue: path.description },
                { name: "isMandatory", label: "Mandatory", type: "checkbox", defaultChecked: path.isMandatory },
              ]} />
            </Panel>
          </Reveal>
        ) : null}

        {assigner && path.status === "APPROVED" ? (
          <Panel title="Assign this path" subtitle="Everyone chosen is enrolled in every course on the path">
            <GrowthForm action={assignPathAction} hidden={{ pathId: path.id }} cols={2} submitLabel="Assign" fields={[
              { name: "dueDate", label: "Due date", type: "date", hint: path.dueInDays ? `Defaults to ${path.dueInDays} days from today` : "Optional" },
              { name: "employeeIds", label: "People", type: "checklist", options: candidates.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` })) },
            ]} />
          </Panel>
        ) : null}

        {assigner ? (
          <Panel title={`On this path (${assignments.length})`} pad={false}>
            {assignments.length === 0 ? <EmptyState title="Nobody yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Assigned</th><th>Due</th><th>Status</th><th style={{ minWidth: 140 }}>Progress</th></tr></thead>
                  <tbody>
                    {assignments.map((a) => (
                      <tr key={a.id}>
                        <td><Person name={a.employee.displayName ?? ""} meta={a.employee.employeeNumber} /></td>
                        <td className="text-sm">{formatDate(a.assignedAt)}</td>
                        <td className="text-sm">{a.dueDate ? formatDate(a.dueDate) : "—"}</td>
                        <td><Badge tone={a.status === "COMPLETED" ? "success" : "info"} dot>{a.status.replace("_", " ").toLowerCase()}</Badge></td>
                        <td><Progress value={a.progressPercent} max={100} /><div className="text-xs subtle">{a.progressPercent}%</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
