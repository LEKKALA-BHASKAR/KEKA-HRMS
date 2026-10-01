import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, KeyValue, Person } from "@/components/ui";
import { JourneyChecklist } from "../../_lifecycle/journey-view";

const P = PERMISSIONS;

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const j = await prisma.journey.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, dateOfJoining: true, department: { select: { name: true } }, reportingManager: { select: { displayName: true } } } },
      template: { select: { name: true } },
      tasks: { select: { assigneeEmployeeId: true } },
    },
  });
  if (!j) notFound();
  // HR for the journey type, or anyone with a task on it.
  const perm = j.trigger === "EXIT" ? P.EXIT_MANAGE : P.ONBOARDING_VIEW;
  const hasTask = j.tasks.some((t) => t.assigneeEmployeeId && t.assigneeEmployeeId === viewer.employee?.id);
  if (!hasTask && !(can(viewer, perm) && canAccessEmployee(viewer, j.employee, perm))) notFound();
  const anchor = j.trigger === "JOINING" ? "joining" : j.trigger === "EXIT" ? "the last day" : "the effective date";

  return (
    <>
      <PageHead title={j.title} subtitle={`${j.trigger.toLowerCase()} · anchored on ${formatDate(j.anchorDate)}${j.template ? ` · from ${j.template.name}` : ""}`}
        actions={<Link className="btn" href={j.trigger === "EXIT" ? "/exits" : "/onboarding"}>Back</Link>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }}>
        <Card tight title="Tasks"><JourneyChecklist journeyId={j.id} viewer={viewer} anchorLabel={anchor} /></Card>
        <Card title="Employee">
          <Link href={`/employees/${j.employee.id}`}><Person name={j.employee.displayName ?? ""} meta={`${j.employee.employeeNumber} · ${j.employee.jobTitleName ?? ""}`} /></Link>
          <div className="divider" />
          <KeyValue items={[
            ["Department", j.employee.department?.name ?? "—"],
            ["Manager", j.employee.reportingManager?.displayName ?? "—"],
            ["Joined", formatDate(j.employee.dateOfJoining)],
            ["Started", formatDate(j.createdAt)],
            ["Status", j.status.toLowerCase()],
          ]} />
        </Card>
      </div>
    </>
  );
}
