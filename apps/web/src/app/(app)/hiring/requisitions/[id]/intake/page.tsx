import Link from "next/link";
import { notFound, forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireDepthConfig } from "@keka/services";
import { requireViewer, canAny } from "@/lib/context";
import { PageHead, Card, Callout } from "@/components/ui";
import { GrowthForm } from "@/components/growth-forms";
import { saveRequisitionIntakeAction } from "@/app/actions/hire-ops";
import { when } from "../../../_parts/depth-tabs";

export const metadata = { title: "Requisition intake · Hire" };

type Answer = { question: string; answer: string };

/**
 * The intake questionnaire for one requisition: the questions the hiring
 * team set in Hire › Settings › Operations, answered by the requester (or the
 * hiring team) so recruiters start sourcing with the full brief.
 */
export default async function RequisitionIntakePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const r = await prisma.requisition.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!r) notFound();
  if (!canAny(viewer, [PERMISSIONS.REQUISITION_MANAGE, PERMISSIONS.REQUISITION_APPROVE]) && r.raisedBy !== viewer.user.id) forbidden();
  const [cfg, intake] = await Promise.all([
    hireDepthConfig(viewer.tenantId),
    prisma.requisitionIntake.findUnique({ where: { requisitionId: r.id } }),
  ]);
  const answers = (Array.isArray(intake?.answers) ? intake!.answers : []) as Answer[];
  const prior = new Map(answers.map((a) => [a.question, a.answer]));
  return (
    <>
      <PageHead title={`Intake: ${r.title}`} subtitle={<Link href={`/hiring/requisitions?req=${r.id}`}>‹ Back to the requisition {r.code ?? ""}</Link>} />
      {intake ? <Callout tone="success">Answered {when(intake.updatedAt)}.</Callout> : null}
      <Card>
        {cfg.intakeQuestions.length === 0 ? <Callout tone="info">No intake questions are set up yet. Add them in Hire › Settings › Operations.</Callout> : (
          <div data-testid="intake-form">
            <GrowthForm action={saveRequisitionIntakeAction} hidden={{ requisitionId: r.id }} submitLabel="Save answers"
              fields={cfg.intakeQuestions.map((q, i) => ({ name: `a_${i}`, label: q, type: "textarea" as const, rows: 3, required: true, defaultValue: prior.get(q) ?? "" }))} />
          </div>
        )}
      </Card>
    </>
  );
}
