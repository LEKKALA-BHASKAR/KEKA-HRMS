import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Person } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { ActButton } from "@/components/growth-forms";
import { decideLearningRequestAction, decideRegistrationAction, courseReviewAction, pathReviewAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;

/** Everything in Learn waiting for the viewer's decision. */
export default async function LearningApprovalsPage() {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const me = viewer.employee?.id ?? "__none__";
  const team = [...viewer.allReportIds];
  const assigner = can(viewer, P.COURSE_ASSIGN);
  const admin = can(viewer, P.COURSE_MANAGE);
  const runs = canAny(viewer, [P.COURSE_MANAGE, P.TRAINING_MANAGE]);
  const whose = { OR: [{ id: { in: team } }, ...(assigner ? [scopedEmployeeWhere(viewer, P.COURSE_ASSIGN)] : [])], NOT: { id: me } };
  const [requests, registrations, courses, paths] = await Promise.all([
    prisma.learningRequest.findMany({ where: { tenantId: viewer.tenantId, status: "PENDING", employee: whose }, include: { course: { select: { id: true, title: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.sessionRegistration.findMany({ where: { status: "REQUESTED", session: { tenantId: viewer.tenantId, status: "SCHEDULED" }, employeeId: { not: me }, ...(runs ? {} : { employee: whose }) }, include: { session: { select: { id: true, title: true, startsAt: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { requestedAt: "asc" } }),
    admin ? prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "IN_REVIEW" }, orderBy: { submittedAt: "asc" } }) : Promise.resolve([]),
    admin ? prisma.learningPath.findMany({ where: { tenantId: viewer.tenantId, status: "SUBMITTED" }, include: { courses: { select: { id: true } } }, orderBy: { submittedAt: "asc" } }) : Promise.resolve([]),
  ]);
  const total = requests.length + registrations.length + courses.filter((c) => c.submittedBy !== viewer.user.id).length + paths.filter((p) => p.submittedBy !== viewer.user.id).length;

  return (
    <>
      <PageHead title="Learning Approvals" subtitle={total ? `${total} waiting for you` : "Nothing waiting for you"} />
      <div className="stack gap-4">
        <Panel title={`Enrolment and retake requests (${requests.length})`} pad={false}>
          {requests.length === 0 ? <EmptyState title="No requests" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Course</th><th>Request</th><th>Reason</th><th>Asked</th><th /></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td><Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} /></td>
                      <td><Link href={`/learn/courses/${r.course.id}`}>{r.course.title}</Link></td>
                      <td className="text-sm">{r.kind === "RETAKE" ? "Quiz retake" : "Enrolment"}</td>
                      <td className="text-sm">{r.reason ?? "—"}</td>
                      <td className="text-sm nowrap">{formatDate(r.createdAt)}</td>
                      <td className="right"><span className="row gap-1">
                        <ActButton action={decideLearningRequestAction} hidden={{ requestId: r.id, decision: "approve" }} label="Approve" variant="primary" />
                        <ActButton action={decideLearningRequestAction} hidden={{ requestId: r.id, decision: "reject" }} label="Reject" input={{ name: "note", placeholder: "Reason", required: true }} />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={`Session places (${registrations.length})`} pad={false}>
          {registrations.length === 0 ? <EmptyState title="No session requests" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Session</th><th>Date</th><th>Note</th><th /></tr></thead>
                <tbody>
                  {registrations.map((r) => (
                    <tr key={r.id}>
                      <td><Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} /></td>
                      <td><Link href={`/learn/sessions/${r.session.id}`}>{r.session.title}</Link></td>
                      <td className="text-sm">{formatDate(r.session.startsAt)}</td>
                      <td className="text-sm">{r.note ?? "—"}</td>
                      <td className="right"><span className="row gap-1">
                        <ActButton action={decideRegistrationAction} hidden={{ registrationId: r.id, decision: "approve" }} label="Approve" variant="primary" />
                        <ActButton action={decideRegistrationAction} hidden={{ registrationId: r.id, decision: "reject" }} label="Reject" />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {admin ? (
          <Panel title={`Courses to review (${courses.length})`} pad={false}>
            {courses.length === 0 ? <EmptyState title="No courses in review" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Course</th><th>Version</th><th>Submitted</th><th /></tr></thead>
                  <tbody>
                    {courses.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="strong" href={`/learn/courses/${c.id}?view=admin`}>{c.title}</Link></td>
                        <td className="text-sm">v{c.version}</td>
                        <td className="text-sm">{formatDate(c.submittedAt)}</td>
                        <td className="right">{c.submittedBy === viewer.user.id ? <span className="text-xs subtle">You submitted this</span> : <span className="row gap-1">
                          <ActButton action={courseReviewAction} hidden={{ courseId: c.id, op: "approve" }} label="Approve & publish" variant="primary" />
                          <ActButton action={courseReviewAction} hidden={{ courseId: c.id, op: "reject" }} label="Send back" input={{ name: "note", placeholder: "What should change?", required: true }} />
                        </span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ) : null}

        {admin ? (
          <Panel title={`Learning paths to approve (${paths.length})`} pad={false}>
            {paths.length === 0 ? <EmptyState title="No paths waiting" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Path</th><th className="num">Courses</th><th>Submitted</th><th /></tr></thead>
                  <tbody>
                    {paths.map((p) => (
                      <tr key={p.id}>
                        <td><Link className="strong" href={`/learn/paths/${p.id}`}>{p.name}</Link></td>
                        <td className="num">{p.courses.length}</td>
                        <td className="text-sm">{formatDate(p.submittedAt)}</td>
                        <td className="right">{p.submittedBy === viewer.user.id ? <span className="text-xs subtle">You submitted this</span> : <span className="row gap-1">
                          <ActButton action={pathReviewAction} hidden={{ pathId: p.id, op: "approve" }} label="Approve" variant="primary" />
                          <ActButton action={pathReviewAction} hidden={{ pathId: p.id, op: "reject" }} label="Send back" input={{ name: "note", placeholder: "What should change?", required: true }} />
                        </span>}</td>
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
