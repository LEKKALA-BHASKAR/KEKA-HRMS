import Link from "next/link";
import { prisma } from "@keka/db";
import { serviceTimeline, formatCompanyDate, type TimelineEvent } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";

export const metadata = { title: "My timeline — BooS-HR" };

const LABEL: Record<string, string> = { NEW_HIRE: "Joined as", PROMOTION: "Promoted", TRANSFER: "Transferred", DEPARTMENT_CHANGE: "Moved department", LOCATION_CHANGE: "Moved office", MANAGER_CHANGE: "New manager", CONFIRMATION: "Confirmed", DEMOTION: "Role change", WORKER_TYPE_CHANGE: "Employment type changed" };

/**
 * My career here, newest first: joining, every work anniversary, each job
 * change (title, department, office, manager), confirmation, scheduled
 * moves still to come, and the courses and certificates I have earned.
 */
export default async function TimelinePage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="My timeline" /><Card><Empty title="No employee profile" /></Card></>;
  const me = viewer.employee.id;
  const [emp, jobs, upcoming, certs, profile] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: me }, select: { dateOfJoining: true, confirmationDate: true } }),
    prisma.employeeJobRecord.findMany({ where: { employeeId: me }, orderBy: { effectiveFrom: "asc" }, include: { jobTitle: { select: { name: true } } } }),
    prisma.jobChange.findMany({ where: { employeeId: me, status: "SCHEDULED" }, select: { id: true, reason: true, effectiveFrom: true } }),
    prisma.learningCertificate.findMany({ where: { employeeId: me, revokedAt: null }, select: { issuedAt: true, course: { select: { title: true } } } }),
    prisma.companyProfile.findUnique({ where: { tenantId: viewer.tenantId }, select: { dateFormat: true } }),
  ]);
  const ids = [...new Set(jobs.flatMap((j) => [j.departmentId, j.locationId, j.reportingManagerId]).filter((x): x is string => !!x))];
  const [depts, locs, mgrs] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
  ]);
  const n = new Map<string, string>([...depts.map((d) => [d.id, d.name] as [string, string]), ...locs.map((l) => [l.id, l.name] as [string, string]), ...mgrs.map((m) => [m.id, m.displayName] as [string, string])]);
  const events: TimelineEvent[] = [];
  let prev: (typeof jobs)[number] | null = null;
  for (const j of jobs) {
    if (j.reason !== "NEW_HIRE") {
      const bits = [prev?.jobTitleId !== j.jobTitleId && j.jobTitle ? j.jobTitle.name : null, prev?.departmentId !== j.departmentId && j.departmentId ? n.get(j.departmentId) : null, prev?.locationId !== j.locationId && j.locationId ? n.get(j.locationId) : null, prev?.reportingManagerId !== j.reportingManagerId && j.reportingManagerId ? `reporting to ${n.get(j.reportingManagerId)}` : null].filter(Boolean);
      events.push({ date: j.effectiveFrom, kind: j.reason, label: `${LABEL[j.reason] ?? j.reason}${bits.length ? `: ${bits.join(", ")}` : ""}` });
    }
    prev = j;
  }
  if (emp.confirmationDate) events.push({ date: emp.confirmationDate, kind: "CONFIRMATION", label: "Confirmed after probation" });
  for (const u of upcoming) events.push({ date: u.effectiveFrom, kind: u.reason, label: `${LABEL[u.reason] ?? u.reason} (scheduled)`, future: true });
  for (const c of certs) events.push({ date: c.issuedAt, kind: "CERTIFICATE", label: `Certified: ${c.course.title}` });
  const timeline = serviceTimeline(emp.dateOfJoining, new Date(), events);
  const years = Math.floor((Date.now() - emp.dateOfJoining.getTime()) / (365.25 * 86_400_000));
  return (
    <>
      <PageHead title="My timeline" subtitle={`${years} year${years === 1 ? "" : "s"} with the company`} actions={<Link className="btn" href={`/employees/${me}?tab=job`}>Job history</Link>} />
      <Card>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {timeline.map((e, i) => (
            <li key={i} className="row gap-3" style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="mono text-sm" style={{ minWidth: 110 }}>{formatCompanyDate(e.date, profile?.dateFormat ?? undefined)}</span>
              <span>{e.label}</span>
              {e.future ? <Badge tone="info">upcoming</Badge> : null}
              {e.kind === "ANNIVERSARY" ? <Badge tone="success">anniversary</Badge> : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
