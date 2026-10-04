import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { certificateStatus, enrolmentStanding } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { learningReport, LEARNING_REPORTS, type LearningReportKind } from "@/lib/growth-reports";
import { PageHead, Stat, Badge, Person } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { ReportView } from "@/components/growth-report";
import { ActButton } from "@/components/growth-forms";
import { revokeCertificateAction, updateEnrolmentAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;

export default async function LearningReportsPage({ searchParams }: { searchParams: Promise<{ report?: string; q?: string }> }) {
  const viewer = await requireViewer();
  if (!canAny(viewer, [P.COURSE_ASSIGN, P.COURSE_MANAGE])) forbidden();
  const sp = await searchParams;
  const kind = (sp.report && sp.report in LEARNING_REPORTS ? sp.report : "records") as LearningReportKind;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const who = scopedEmployeeWhere(viewer, P.COURSE_ASSIGN);
  const today = new Date();
  const [report, enrolments, certs] = await Promise.all([
    learningReport(viewer, kind, q),
    prisma.courseEnrolment.findMany({ where: { tenantId: viewer.tenantId, employee: who, course: { status: "PUBLISHED" } }, include: { course: { select: { title: true } }, employee: { select: { displayName: true, employeeNumber: true } } } }),
    kind === "certificates" && can(viewer, P.COURSE_MANAGE) ? prisma.learningCertificate.findMany({ where: { tenantId: viewer.tenantId, employee: who, revokedAt: null }, include: { course: { select: { title: true } }, employee: { select: { displayName: true } } }, orderBy: { issuedAt: "desc" }, take: 100 }) : Promise.resolve([]),
  ]);
  const done = enrolments.filter((e) => e.status === "COMPLETED").length;
  const overdue = enrolments.filter((e) => enrolmentStanding(e, today) === "OVERDUE");

  return (
    <>
      <PageHead title="Learning Reports" subtitle="Completion, attendance, quiz results and certificates for the people you look after" />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Enrolments" value={enrolments.length} />
        <Stat label="Completed" value={done} meta={enrolments.length ? `${Math.round((done / enrolments.length) * 100)}% completion` : undefined} />
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? "neg" : undefined} />
        <Stat label="Not started" value={enrolments.filter((e) => enrolmentStanding(e, today) === "NOT_STARTED").length} />
      </div>
      <form className="row gap-2" style={{ marginBottom: 12 }}>
        <input type="hidden" name="report" value={kind} />
        <input className="input" name="q" defaultValue={q} placeholder="Filter by employee name" style={{ maxWidth: 280 }} />
        <button className="btn">Filter</button>
      </form>
      <ReportView report={report} base="/learn/reports" kinds={LEARNING_REPORTS} kind={kind} exportHref={`/learn/reports/export?kind=${kind}${q ? `&q=${encodeURIComponent(q)}` : ""}`} />

      {kind === "records" && overdue.length ? (
        <div style={{ marginTop: 18 }}>
          <Panel title={`Overdue (${overdue.length})`} subtitle="Extend the due date, or reset a completion that needs to be retaken" pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Course</th><th>Due</th><th /></tr></thead>
                <tbody>
                  {overdue.slice(0, 100).map((e) => (
                    <tr key={e.id}>
                      <td><Person name={e.employee.displayName ?? ""} meta={e.employee.employeeNumber} /></td>
                      <td className="text-sm">{e.course.title}</td>
                      <td className="text-sm neg">{formatDate(e.dueDate)}</td>
                      <td className="right"><ActButton action={updateEnrolmentAction} hidden={{ enrolmentId: e.id, op: "due" }} label="Set due date" input={{ name: "dueDate", placeholder: "", type: "date", required: true }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}

      {kind === "certificates" && can(viewer, P.COURSE_MANAGE) ? (
        <div style={{ marginTop: 18 }}>
          <Panel title="Revoke a certificate" subtitle="A revoked certificate can no longer be downloaded" pad={false}>
            {certs.length === 0 ? <EmptyState title="No certificates" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Number</th><th>Holder</th><th>Course</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {certs.map((c) => (
                      <tr key={c.id}>
                        <td className="text-sm">{c.number}</td>
                        <td className="text-sm">{c.employee.displayName}</td>
                        <td className="text-sm">{c.course.title}</td>
                        <td><Badge tone={certificateStatus(c, today) === "VALID" ? "success" : "warning"} dot>{certificateStatus(c, today).toLowerCase()}</Badge></td>
                        <td className="right"><ActButton action={revokeCertificateAction} hidden={{ certificateId: c.id }} label="Revoke" variant="ghost" input={{ name: "reason", placeholder: "Reason", required: true }} /></td>
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
