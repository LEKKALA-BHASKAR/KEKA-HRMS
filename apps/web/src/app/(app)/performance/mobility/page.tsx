import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { mobilityReport, MOBILITY_REPORTS, type MobilityReportKind } from "@/lib/growth-reports";
import { PageHead, Badge, Person, Stat } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { ActButton, GrowthForm, Reveal } from "@/components/growth-forms";
import { ReportView } from "@/components/growth-report";
import { decideMobilityAction, endorseInternalApplicationAction, decideInternalApplicationAction, endorseAspirationAction, setInternalPostingAction } from "@/app/actions/mobility";

const P = PERMISSIONS;
const TONE: Record<string, "success" | "warning" | "neutral" | "danger" | "info"> = { APPROVED: "success", SELECTED: "success", ENDORSED: "info", SHORTLISTED: "info", PENDING_MANAGER: "warning", PENDING_HR: "warning", APPLIED: "warning", REJECTED: "danger", MANAGER_DECLINED: "danger", WITHDRAWN: "neutral" };

export default async function MobilityPage({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const viewer = await requireViewer();
  const team = [...viewer.allReportIds];
  const hr = can(viewer, P.MOBILITY_MANAGE);
  const careers = can(viewer, P.CAREER_PATH_MANAGE);
  const jobs = can(viewer, P.JOB_MANAGE);
  if (!team.length && !canAny(viewer, [P.MOBILITY_MANAGE, P.CAREER_PATH_MANAGE, P.JOB_MANAGE])) forbidden();
  const sp = await searchParams;
  const kinds = Object.fromEntries(Object.entries(MOBILITY_REPORTS).filter(([k]) => (k === "aspirations" || k === "development" ? careers : hr)));
  const kind = (sp.report && sp.report in kinds ? sp.report : Object.keys(kinds)[0]) as MobilityReportKind | undefined;
  const hrScope = hr ? scopedEmployeeWhere(viewer, P.MOBILITY_MANAGE) : null;
  const me = viewer.employee?.id ?? "__none__";

  const [moves, applications, aspirations, postings, report, names] = await Promise.all([
    prisma.mobilityRequest.findMany({
      where: { tenantId: viewer.tenantId, employeeId: { not: me }, OR: [{ status: "PENDING_MANAGER", employeeId: { in: team } }, ...(hrScope ? [{ status: "PENDING_HR", employee: hrScope }] : [])] },
      include: { employee: { select: { displayName: true, employeeNumber: true, department: { select: { name: true } }, location: { select: { name: true } } } } }, orderBy: { createdAt: "asc" },
    }),
    prisma.mobilityApplication.findMany({
      where: { tenantId: viewer.tenantId, employeeId: { not: me }, OR: [{ status: "APPLIED", employeeId: { in: team } }, ...(hrScope ? [{ status: { in: ["ENDORSED", "SHORTLISTED"] }, employee: hrScope }] : [])] },
      include: { job: { select: { title: true } }, employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "asc" },
    }),
    prisma.careerAspiration.findMany({ where: { status: "PENDING", employeeId: { in: team } }, include: { employee: { select: { displayName: true, employeeNumber: true } }, step: { select: { title: true, path: { select: { name: true } } } } } }),
    jobs ? prisma.job.findMany({ where: { tenantId: viewer.tenantId, status: { in: ["OPEN", "ON_HOLD"] } }, include: { _count: { select: { mobilityApplications: true } } }, orderBy: { title: "asc" } }) : Promise.resolve([]),
    kind ? mobilityReport(viewer, kind) : Promise.resolve(null),
    prisma.$transaction([
      prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
      prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
    ]),
  ]);
  const name = new Map(names.flat().map((x) => [x.id, x.name]));

  return (
    <>
      <PageHead title="Internal Mobility" subtitle="Transfers, internal job applications and career aspirations waiting for you" />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Move requests" value={moves.length} meta="Waiting for you" />
        <Stat label="Internal applications" value={applications.length} meta="Waiting for you" />
        <Stat label="Aspirations to endorse" value={aspirations.length} />
        <Stat label="Jobs open internally" value={postings.filter((j) => j.allowInternal).length} />
      </div>
      <div className="stack gap-4">
        <Panel title={`Move requests (${moves.length})`} subtitle="The manager endorses first; HR approval raises the job change for its effective date" pad={false}>
          {moves.length === 0 ? <EmptyState title="Nothing waiting" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Move</th><th>Preferred date</th><th>Reason</th><th>Stage</th><th /></tr></thead>
                <tbody>
                  {moves.map((r) => (
                    <tr key={r.id}>
                      <td><Person name={r.employee.displayName ?? ""} meta={`${r.employee.department?.name ?? "—"} · ${r.employee.location?.name ?? "—"}`} /></td>
                      <td className="text-sm">{r.kind.replace("_", " ").toLowerCase()}{r.toDepartmentId ? ` → ${name.get(r.toDepartmentId) ?? "?"}` : ""}{r.toLocationId ? ` → ${name.get(r.toLocationId) ?? "?"}` : ""}{r.toJobTitleId ? ` → ${name.get(r.toJobTitleId) ?? "?"}` : ""}</td>
                      <td className="text-sm">{r.preferredDate ? formatDate(r.preferredDate) : "—"}</td>
                      <td className="text-sm">{r.reason}{r.managerNote ? <div className="text-xs subtle">Manager: {r.managerNote}</div> : null}</td>
                      <td><Badge tone={TONE[r.status]} dot>{r.status === "PENDING_MANAGER" ? "manager" : "HR"}</Badge></td>
                      <td className="right"><span className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                        <ActButton action={decideMobilityAction} hidden={{ requestId: r.id, decision: "approve" }} label={r.status === "PENDING_MANAGER" ? "Endorse" : "Approve"} variant="primary" input={r.status === "PENDING_HR" ? { name: "effectiveFrom", placeholder: "", type: "date" } : undefined} />
                        <ActButton action={decideMobilityAction} hidden={{ requestId: r.id, decision: "reject" }} label="Reject" input={{ name: "note", placeholder: "Reason", required: true }} />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={`Internal applications (${applications.length})`} subtitle="The manager endorses the application, then HR shortlists and selects" pad={false}>
          {applications.length === 0 ? <EmptyState title="Nothing waiting" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Job</th><th>Applied</th><th>Cover note</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {applications.map((a) => (
                    <tr key={a.id}>
                      <td><Person name={a.employee.displayName ?? ""} meta={a.employee.employeeNumber} /></td>
                      <td className="text-sm">{a.job.title}</td>
                      <td className="text-sm">{formatDate(a.createdAt)}</td>
                      <td className="text-sm">{a.coverNote ?? "—"}</td>
                      <td><Badge tone={TONE[a.status]} dot>{a.status.toLowerCase()}</Badge></td>
                      <td className="right"><span className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                        {a.status === "APPLIED" ? <>
                          <ActButton action={endorseInternalApplicationAction} hidden={{ applicationId: a.id, decision: "endorse" }} label="Endorse" variant="primary" />
                          <ActButton action={endorseInternalApplicationAction} hidden={{ applicationId: a.id, decision: "decline" }} label="Decline" input={{ name: "note", placeholder: "Reason", required: true }} />
                        </> : <>
                          {a.status === "ENDORSED" ? <ActButton action={decideInternalApplicationAction} hidden={{ applicationId: a.id, decision: "shortlist" }} label="Shortlist" /> : null}
                          <ActButton action={decideInternalApplicationAction} hidden={{ applicationId: a.id, decision: "select" }} label="Select" variant="primary" />
                          <ActButton action={decideInternalApplicationAction} hidden={{ applicationId: a.id, decision: "reject" }} label="Reject" input={{ name: "note", placeholder: "Reason" }} />
                        </>}
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {aspirations.length ? (
          <Panel title={`Career aspirations to endorse (${aspirations.length})`} pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Aims for</th><th>By</th><th>Relocate</th><th /></tr></thead>
                <tbody>
                  {aspirations.map((a) => (
                    <tr key={a.id}>
                      <td><Person name={a.employee.displayName ?? ""} meta={a.employee.employeeNumber} /></td>
                      <td className="text-sm">{a.step.title} <span className="subtle">({a.step.path.name})</span>{a.note ? <div className="text-xs subtle">{a.note}</div> : null}</td>
                      <td className="text-sm">{a.targetDate ? formatDate(a.targetDate) : "—"}</td>
                      <td className="text-sm">{a.openToRelocate ? "Yes" : "No"}</td>
                      <td className="right"><span className="row gap-1">
                        <ActButton action={endorseAspirationAction} hidden={{ aspirationId: a.id, decision: "endorse" }} label="Endorse" variant="primary" input={{ name: "note", placeholder: "Note (optional)" }} />
                        <ActButton action={endorseAspirationAction} hidden={{ aspirationId: a.id, decision: "decline" }} label="Not now" input={{ name: "note", placeholder: "Reason", required: true }} />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        {jobs ? (
          <Panel title="Internal job postings" subtitle="Open a job to employees: they apply from Me › Career › Internal jobs" pad={false}>
            {postings.length === 0 ? <EmptyState title="No open jobs" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Job</th><th>Status</th><th>Internal</th><th className="num">Internal applicants</th><th /></tr></thead>
                  <tbody>
                    {postings.map((j) => (
                      <tr key={j.id}>
                        <td><Link className="strong" href={`/hiring/jobs/${j.id}`}>{j.title}</Link></td>
                        <td className="text-sm">{j.status.toLowerCase()}</td>
                        <td>{j.allowInternal ? <Badge tone="success" dot>open{j.internalClosesAt ? ` until ${formatDate(j.internalClosesAt)}` : ""}{j.internalMinTenureMonths ? ` · ${j.internalMinTenureMonths}m tenure` : ""}</Badge> : <span className="subtle">No</span>}</td>
                        <td className="num">{j._count.mobilityApplications}</td>
                        <td className="right" style={{ minWidth: 200 }}>
                          <Reveal label={j.allowInternal ? "Change" : "Open internally"}>
                            <GrowthForm action={setInternalPostingAction} hidden={{ jobId: j.id }} cols={2} compact fields={[
                              { name: "internalClosesAt", label: "Applications close", type: "date", defaultValue: j.internalClosesAt?.toISOString().slice(0, 10) },
                              { name: "internalMinTenureMonths", label: "Minimum tenure (months)", type: "number", min: 0, max: 120, defaultValue: j.internalMinTenureMonths },
                              { name: "allowInternal", label: "Open to internal applicants", type: "checkbox", defaultChecked: j.allowInternal },
                            ]} />
                          </Reveal>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ) : null}
      </div>

      {report && kind ? (
        <>
          <SectionTitle sub="Download any of these as CSV">Reports</SectionTitle>
          <ReportView report={report} base="/performance/mobility" kinds={kinds} kind={kind} exportHref={`/performance/mobility/export?kind=${kind}`} />
        </>
      ) : null}
    </>
  );
}
