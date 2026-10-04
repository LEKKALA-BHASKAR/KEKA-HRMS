import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { journeyProgress } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Callout } from "@/components/ui";
import { ActButton } from "@/components/gov-forms";
import { fmtDay } from "@/lib/engage-depth";
import { issueOnboardingCertificateAction } from "@/app/actions/join-onboarding";

/** A printable onboarding completion certificate. The hire sees it once HR has issued it. */
export default async function OnboardingCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const j = await prisma.journey.findFirst({
    where: { id, tenantId: viewer.tenantId, trigger: "JOINING" },
    include: { tasks: { select: { status: true, isRequired: true, dueDate: true } }, tenant: { select: { name: true } }, employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, dateOfJoining: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true, department: { select: { name: true } } } } },
  });
  if (!j) notFound();
  const hr = can(viewer, PERMISSIONS.ONBOARDING_MANAGE) && canAccessEmployee(viewer, j.employee, PERMISSIONS.ONBOARDING_MANAGE);
  const self = viewer.employee?.id === j.employeeId;
  if (!hr && !(self && j.certificateIssuedAt)) notFound();
  const p = journeyProgress(j.tasks);
  return (
    <>
      <PageHead title="Onboarding completion certificate" actions={hr && j.status === "COMPLETED" && !j.certificateIssuedAt ? <ActButton action={issueOnboardingCertificateAction} hidden={{ journeyId: j.id }} label="Issue to the employee" variant="primary" /> : null} />
      {j.status !== "COMPLETED" ? <Callout tone="warning">Onboarding is {p.pct}% complete — the certificate can be issued once every task is closed.</Callout> : null}
      <Card>
        <div style={{ textAlign: "center", padding: "40px 24px", border: "2px solid var(--border)", borderRadius: 8 }}>
          <div className="text-xs subtle" style={{ letterSpacing: ".2em", textTransform: "uppercase" }}>{j.tenant.name}</div>
          <h2 style={{ margin: "18px 0 6px" }}>Certificate of onboarding completion</h2>
          <div className="text-sm muted">This certifies that</div>
          <div style={{ fontSize: 26, fontWeight: 600, margin: "10px 0" }}>{j.employee.displayName}</div>
          <div className="text-sm">{[j.employee.jobTitleName, j.employee.department?.name].filter(Boolean).join(" · ")} · {j.employee.employeeNumber}</div>
          <div className="text-sm muted" style={{ marginTop: 14 }}>joined on {fmtDay(j.employee.dateOfJoining)} and completed the onboarding programme ({p.total} task(s)) on {fmtDay(j.completedAt)}.</div>
          <div className="text-xs subtle" style={{ marginTop: 24 }}>{j.certificateIssuedAt ? `Issued ${fmtDay(j.certificateIssuedAt)} · ` : "Not yet issued · "}Reference {j.id.slice(-8).toUpperCase()} · BooS-HR</div>
        </div>
      </Card>
    </>
  );
}
