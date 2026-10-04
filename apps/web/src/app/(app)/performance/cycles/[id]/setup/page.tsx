import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Callout, Person } from "@/components/ui";
import { CycleOps } from "../../../forms";
import { SectionForm, QuestionForm, RemoveFormItem, CopyFormForm, StageDatesForm, AddParticipantsForm, ParticipantRow } from "../../../_parts/talent-forms";

const KIND: Record<string, string> = { RATING: "Rating 1–5", TEXT: "Text", COMPETENCY: "Competency" };
const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "");

/**
 * Performance › Review cycles › Set up: the review form (sections and
 * questions), the dates each stage runs, and — before launch — exactly who
 * is reviewed and by which manager.
 */
export default async function CycleSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.PERFORMANCE_MANAGE);
  const { id } = await params;
  const cycle = await prisma.reviewCycle.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: {
      stageDates: true,
      formSections: { orderBy: { displayOrder: "asc" }, include: { questions: { orderBy: { displayOrder: "asc" } } } },
      participants: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true, reportingManager: { select: { displayName: true } }, department: { select: { name: true } } } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!cycle) notFound();
  const draft = cycle.status === "DRAFT";
  const [people, departments, otherCycles] = await Promise.all([
    prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, PERMISSIONS.PERFORMANCE_MANAGE), { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } }] }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" }, take: 1000 }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.reviewCycle.findMany({ where: { tenantId: viewer.tenantId, id: { not: cycle.id }, formSections: { some: {} } }, select: { id: true, name: true } }),
  ]);
  const options = people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` }));
  const managerName = new Map(people.map((p) => [p.id, p.displayName]));
  const s = cycle.stageDates;

  return (
    <>
      <PageHead title={`Set up — ${cycle.name}`} subtitle={`${cycle.status.replace(/_/g, " ").toLowerCase()} · the form and participants are fixed at launch`}
        actions={<div className="row gap-2"><CycleOps cycleId={cycle.id} status={cycle.status} /><Link className="btn" href={`/performance/cycles/${cycle.id}`}>Calibration</Link><Link className="btn" href="/performance/cycles">Back</Link></div>} />
      <div className="stack gap-4">
        <Card title="Stage dates" description="Self and manager reviews can only be submitted in their windows; results cannot be shared before the publish date.">
          <StageDatesForm cycleId={cycle.id} values={{ selfStartsAt: d(s?.selfStartsAt), selfEndsAt: d(s?.selfEndsAt), managerStartsAt: d(s?.managerStartsAt), managerEndsAt: d(s?.managerEndsAt), calibrationStartsAt: d(s?.calibrationStartsAt), calibrationEndsAt: d(s?.calibrationEndsAt), publishOn: d(s?.publishOn) }} />
        </Card>

        <Card title="Review form" description="Sections of questions reviewers answer alongside the overall rating. Rating and competency questions use a 1–5 scale.">
          <div className="stack gap-4">
            {cycle.formSections.length === 0 ? (
              <>
                <Empty title="No form yet">Reviewers will give an overall rating with strengths and areas to improve.</Empty>
                {draft && otherCycles.length ? <CopyFormForm cycleId={cycle.id} cycles={otherCycles.map((c) => ({ value: c.id, label: c.name }))} /> : null}
              </>
            ) : cycle.formSections.map((sec) => (
              <div key={sec.id} className="card" style={{ padding: 14 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div><div className="strong">{sec.title}</div>{sec.description ? <div className="text-xs subtle">{sec.description}</div> : null}</div>
                  {draft ? <RemoveFormItem cycleId={cycle.id} id={sec.id} kind="section" /> : null}
                </div>
                {sec.questions.length ? (
                  <div className="table-wrap" style={{ marginTop: 8 }}><table className="data"><tbody>
                    {sec.questions.map((q) => (
                      <tr key={q.id}>
                        <td className="text-sm">{q.prompt}{q.competency ? <span className="subtle"> · {q.competency}</span> : null}{q.isRequired ? <span style={{ color: "var(--danger)" }}> *</span> : null}</td>
                        <td><Badge>{KIND[q.kind] ?? q.kind}</Badge></td>
                        <td className="text-xs subtle">{Array.isArray(q.appliesTo) && (q.appliesTo as string[]).length ? (q.appliesTo as string[]).map((t) => t.toLowerCase().replace("_", "-")).join(", ") : "everyone"}</td>
                        <td className="right">{draft ? <RemoveFormItem cycleId={cycle.id} id={q.id} kind="question" /> : null}</td>
                      </tr>
                    ))}
                  </tbody></table></div>
                ) : <div className="text-sm subtle" style={{ marginTop: 6 }}>No questions yet.</div>}
                {draft ? <div style={{ marginTop: 10 }}><QuestionForm cycleId={cycle.id} sectionId={sec.id} /></div> : null}
              </div>
            ))}
            {draft ? <SectionForm cycleId={cycle.id} /> : null}
          </div>
        </Card>

        <Card tight title={`Participants (${cycle.participants.length})`} description={cycle.participants.length ? "Launch reviews exactly these people, each by the manager shown." : "None mapped: launch includes everyone employed for the cycle's last 90 days, reviewed by their reporting manager."}>
          {draft ? <div style={{ padding: 14 }}><AddParticipantsForm cycleId={cycle.id} people={options} departments={departments.map((x) => ({ value: x.id, label: x.name }))} /></div> : <div style={{ padding: 14 }}><Callout tone="info" title="Launched">The participant list is fixed.</Callout></div>}
          {cycle.participants.length ? (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Employee</th><th>Department</th><th>Reviewing manager</th><th /></tr></thead>
              <tbody>
                {cycle.participants.map((p) => (
                  <tr key={p.id}>
                    <td><Person name={p.employee.displayName ?? ""} meta={p.employee.employeeNumber} /></td>
                    <td className="text-sm">{p.employee.department?.name ?? "—"}</td>
                    <td className="text-sm">{p.managerId ? <><strong>{managerName.get(p.managerId) ?? "Mapped manager"}</strong> <Badge tone="info">mapped</Badge></> : p.employee.reportingManager?.displayName ?? <span className="subtle">none</span>}</td>
                    <td className="right">{draft ? <ParticipantRow cycleId={cycle.id} id={p.id} managerId={p.managerId} managers={options.filter((o) => o.value !== p.employee.id)} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
