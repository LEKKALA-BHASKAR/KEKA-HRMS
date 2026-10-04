import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { ensureBoxLabels, boxCounts } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Callout } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { ReviewButtons } from "@/components/growth-report";
import { saveTalentReviewAction, addReviewParticipantsAction, removeReviewParticipantAction, rateTalentAction, talentReviewOpAction, deleteTalentReviewAction } from "@/app/actions/succession";

const P = PERMISSIONS;
const LEVEL = [{ value: "1", label: "1 — Low" }, { value: "2", label: "2 — Moderate" }, { value: "3", label: "3 — High" }];
const RISK = [{ value: "LOW", label: "Low" }, { value: "MEDIUM", label: "Medium" }, { value: "HIGH", label: "High" }];
const BOX_TONE: Record<number, string> = { 9: "#1f9d55", 8: "#38c172", 6: "#38c172", 7: "#f6c343", 5: "#f6c343", 3: "#f6c343", 4: "#f59e0b", 2: "#f59e0b", 1: "#e3342f" };

export default async function TalentReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const { id } = await params;
  const review = await prisma.talentReview.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { entries: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, department: { select: { name: true } } } } }, orderBy: { employee: { displayName: "asc" } } } },
  });
  if (!review) notFound();
  const locked = review.status === "SUBMITTED" || review.status === "APPROVED";
  const [labels, departments, people] = await Promise.all([
    ensureBoxLabels(viewer.tenantId),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    locked ? Promise.resolve([]) : prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.SUCCESSION_MANAGE), status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] }, id: { notIn: review.entries.map((e) => e.employeeId) } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" }, take: 1000 }),
  ]);
  const label = new Map(labels.map((l) => [l.box, l]));
  const counts = boxCounts(review.entries);
  const unrated = review.entries.filter((e) => !e.box).length;

  return (
    <>
      <PageHead
        title={review.name}
        subtitle={<span className="row gap-2"><Badge tone={review.status === "APPROVED" ? "success" : review.status === "SUBMITTED" ? "warning" : "info"} dot>{review.status.replace("_", " ").toLowerCase()}</Badge><span className="text-sm subtle">{review.entries.length} people · {unrated} not placed{review.meetingAt ? ` · meeting ${formatDate(review.meetingAt)}` : ""}</span></span>}
        actions={<>
          <Link className="btn" href="/performance/talent-reviews">Back</Link>
          <ReviewButtons action={talentReviewOpAction} hidden={{ reviewId: review.id }} status={review.status === "IN_PROGRESS" ? "DRAFT" : review.status} submittedByMe={review.submittedBy === viewer.user.id} />
          {!locked ? <ActButton action={deleteTalentReviewAction} hidden={{ reviewId: review.id }} label="Delete" variant="ghost" confirmText="Delete this talent review and its ratings?" /> : null}
        </>}
      />
      {review.decisionNote ? <div style={{ marginBottom: 12 }}><Callout tone={review.status === "APPROVED" ? "success" : "warning"} title={review.status === "APPROVED" ? "Signed off" : "Note from the approver"}>{review.decisionNote}</Callout></div> : null}
      {review.agenda ? <p className="text-sm muted" style={{ marginBottom: 12 }}><strong>Agenda:</strong> {review.agenda}</p> : null}

      <div className="stack gap-4">
        <Panel title="The 9-box" subtitle="Rows: potential (high at the top). Columns: performance (high on the right).">
          <div style={{ display: "grid", gridTemplateColumns: "28px repeat(3, 1fr)", gap: 6 }}>
            {[3, 2, 1].map((pot) => (
              <div key={pot} style={{ display: "contents" }}>
                <div className="text-xs subtle" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center" }}>{["", "Low", "Moderate", "High"][pot]}</div>
                {[1, 2, 3].map((perf) => {
                  const box = (pot - 1) * 3 + perf;
                  const people = review.entries.filter((e) => e.box === box);
                  return (
                    <div key={box} style={{ border: `2px solid ${BOX_TONE[box]}`, borderRadius: 8, padding: 8, minHeight: 90 }}>
                      <div className="row" style={{ justifyContent: "space-between" }}><span className="strong text-sm">{label.get(box)?.label ?? `Box ${box}`}</span><span className="text-xs subtle">{counts[box] ?? 0}</span></div>
                      <div className="text-xs subtle" style={{ marginBottom: 4 }}>{label.get(box)?.description}</div>
                      {people.map((e) => <div key={e.id} className="text-xs">{e.employee.displayName}{e.flightRisk === "HIGH" ? " ⚑" : ""}</div>)}
                    </div>
                  );
                })}
              </div>
            ))}
            <div />
            {["Low", "Moderate", "High"].map((x) => <div key={x} className="text-xs subtle" style={{ textAlign: "center" }}>{x} performance</div>)}
          </div>
          <div className="text-xs subtle" style={{ marginTop: 6 }}>⚑ high flight risk</div>
        </Panel>

        {!locked ? (
          <Panel title="Add people" subtitle="Their latest review ratings pre-fill the grid">
            <GrowthForm action={addReviewParticipantsAction} hidden={{ reviewId: review.id }} cols={2} submitLabel="Add" fields={[
              { name: "departmentId", label: "Everyone in a department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })), defaultValue: review.departmentId },
              { name: "employeeIds", label: "…or choose people", type: "checklist", options: people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` })) },
            ]} />
          </Panel>
        ) : null}

        <Panel title={`People (${review.entries.length})`} pad={false}>
          {review.entries.length === 0 ? <EmptyState title="Add the people to review" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th className="num">Perf.</th><th className="num">Pot.</th><th>Box</th><th>Flight risk</th><th>Retention action</th><th /></tr></thead>
                <tbody>
                  {review.entries.map((e) => (
                    <tr key={e.id}>
                      <td><span className="strong">{e.employee.displayName}</span><div className="text-xs subtle">{e.employee.jobTitleName ?? ""}{e.employee.department ? ` · ${e.employee.department.name}` : ""}</div></td>
                      <td className="num">{e.performance ?? "—"}</td>
                      <td className="num">{e.potential ?? "—"}</td>
                      <td>{e.box ? <Badge tone="brand">{e.box} · {label.get(e.box)?.label}</Badge> : <span className="subtle">—</span>}</td>
                      <td className="text-sm">{e.flightRisk?.toLowerCase() ?? "—"}</td>
                      <td className="text-sm">{e.retentionAction ?? "—"}</td>
                      <td className="right" style={{ minWidth: 220 }}>
                        {!locked ? (
                          <>
                            <Reveal label="Rate">
                              <GrowthForm action={rateTalentAction} hidden={{ entryId: e.id }} cols={2} compact submitLabel="Place" fields={[
                                { name: "performance", label: "Performance", type: "select", required: true, options: LEVEL, defaultValue: e.performance ? String(e.performance) : "2" },
                                { name: "potential", label: "Potential", type: "select", required: true, options: LEVEL, defaultValue: e.potential ? String(e.potential) : "2" },
                                { name: "flightRisk", label: "Flight risk", type: "select", options: RISK, defaultValue: e.flightRisk },
                                { name: "retentionAction", label: "Retention action", defaultValue: e.retentionAction },
                                { name: "notes", label: "Calibration notes", type: "textarea", defaultValue: e.notes },
                              ]} />
                            </Reveal>
                            <ActButton action={removeReviewParticipantAction} hidden={{ entryId: e.id }} label="Remove" variant="ghost" />
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {!locked ? (
          <Reveal label="Edit details">
            <Panel title="Details">
              <GrowthForm action={saveTalentReviewAction} hidden={{ id: review.id }} fields={[
                { name: "name", label: "Name", required: true, defaultValue: review.name },
                { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })), defaultValue: review.departmentId },
                { name: "meetingAt", label: "Meeting", type: "date", defaultValue: review.meetingAt?.toISOString().slice(0, 10) },
                { name: "description", label: "Description", type: "textarea", defaultValue: review.description },
                { name: "agenda", label: "Agenda", type: "textarea", defaultValue: review.agenda },
                { name: "notes", label: "Meeting notes", type: "textarea", defaultValue: review.notes },
              ]} />
            </Panel>
          </Reveal>
        ) : null}
      </div>
    </>
  );
}
