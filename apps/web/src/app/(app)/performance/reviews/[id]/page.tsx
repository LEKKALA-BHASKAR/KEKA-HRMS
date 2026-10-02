import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Person, Callout, Empty } from "@/components/ui";
import { REVIEWER_LABEL, FEEDBACK_TYPES } from "@keka/services";
import { ReviewForm, CalibrateForm, AcknowledgeForm, NominatePeers, DecideNomination } from "../../forms";

type Weight = { type: string; weight: number };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const review = await prisma.employeeReview.findFirst({
    where: { id, cycle: { tenantId: viewer.tenantId } },
    include: {
      cycle: true, band: true,
      employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } },
      responses: { include: { reviewer: { select: { displayName: true, employeeNumber: true } } }, orderBy: { reviewerType: "desc" } },
    },
  });
  if (!review) notFound();
  const me = viewer.employee?.id;
  const subject = review.employeeId === me;
  const open = ["NOT_STARTED", "SELF_PENDING", "MANAGER_PENDING", "PENDING_CALIBRATION"].includes(review.status) && ["IN_PROGRESS", "LAUNCHED"].includes(review.cycle.status);
  const live = review.responses.filter((r) => r.status === "ACTIVE" || (r.submittedAt && r.status !== "DECLINED"));
  const mySlot = open ? live.find((r) => r.reviewerId === me && !r.submittedAt) : undefined;
  const mySlots = live.filter((r) => r.reviewerId === me);
  const isReviewer = mySlots.length > 0;
  const isManager = review.employee.reportingManagerId === me;
  const calibrator = can(viewer, PERMISSIONS.PERFORMANCE_CALIBRATE) && canAccessEmployee(viewer, review.employee, PERMISSIONS.PERFORMANCE_CALIBRATE) && !subject;
  // Managers up the line and HR with performance visibility can read it.
  const hr = !subject && canAccessEmployee(viewer, review.employee, PERMISSIONS.PERFORMANCE_VIEW);
  if (!subject && !isReviewer && !calibrator && !hr) notFound();
  const shared = ["SHARED", "ACKNOWLEDGED"].includes(review.status);
  // Managers, calibrators and HR read every response; a peer or report sees
  // only what they wrote; the subject sees their own words always and the
  // rest once shared.
  const privileged = calibrator || hr || isManager || mySlots.some((r) => r.reviewerType === "MANAGER" || r.reviewerType === "SKIP_LEVEL");
  const visible = live.filter((r) => r.submittedAt && (subject ? r.reviewerType === "SELF" || shared : privileged || r.reviewerId === me));
  const anonymous = review.cycle.anonymousFeedback;
  const own = visible.filter((r) => !FEEDBACK_TYPES.includes(r.reviewerType) || r.reviewerId === me && !privileged);
  const feedback = visible.filter((r) => !own.includes(r));
  const weights = (Array.isArray(review.cycle.reviewerTypes) ? review.cycle.reviewerTypes : []) as Weight[];
  const peersOn = weights.some((w) => w.type === "PEER");
  const peers = review.responses.filter((r) => r.reviewerType === "PEER" && ["PROPOSED", "ACTIVE"].includes(r.status));
  const canNominate = peersOn && open && (subject || isManager) && peers.length < review.cycle.maxPeers;
  const peerOptions = canNominate ? await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] }, id: { notIn: [review.employeeId, review.employee.reportingManagerId ?? "", ...review.responses.filter((r) => r.status !== "DECLINED").map((r) => r.reviewerId)] } },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" },
  }) : [];
  const pendingFeedback = live.filter((r) => FEEDBACK_TYPES.includes(r.reviewerType) && !r.submittedAt).length;
  const [indicators, goals] = await Promise.all([
    mySlot ? prisma.performanceIndicator.findMany({ where: { isActive: true, category: { tenantId: viewer.tenantId, isActive: true } }, include: { category: true }, orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }] }) : [],
    prisma.goal.findMany({ where: { employeeId: review.employeeId, countsInReview: true, dueDate: { gte: review.cycle.periodStart }, startDate: { lte: review.cycle.periodEnd } }, orderBy: { dueDate: "asc" } }),
  ]);

  return (
    <>
      <PageHead title={`${review.cycle.name} — ${review.employee.displayName}`} subtitle={`${review.status.replace(/_/g, " ").toLowerCase()} · period ${formatDate(review.cycle.periodStart)} – ${formatDate(review.cycle.periodEnd)}`}
        actions={<Link className="btn" href="/performance?tab=reviews">Back</Link>} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          {mySlot ? (
            <Card title={mySlot.reviewerType === "SELF" ? "Your self review" : mySlot.reviewerType === "MANAGER" ? `Your review of ${review.employee.displayName}` : `Your feedback for ${review.employee.displayName}`}
              description={mySlot.reviewerType === "MANAGER" && review.status === "SELF_PENDING" ? "Waiting for the self review first." : undefined}>
              {mySlot.reviewerType === "MANAGER" && review.status === "SELF_PENDING"
                ? <Empty title="The self review comes first">You will be notified when it is submitted.</Empty>
                : <>
                    {FEEDBACK_TYPES.includes(mySlot.reviewerType) ? <p className="text-sm muted" style={{ marginTop: 0 }}>You are giving feedback as their {(REVIEWER_LABEL[mySlot.reviewerType] ?? "").toLowerCase()}.{anonymous ? " It is shown without your name." : " Your name is shown with it."}</p> : null}
                    <ReviewForm reviewId={review.id} reviewerType={mySlot.reviewerType} indicators={FEEDBACK_TYPES.includes(mySlot.reviewerType) ? [] : indicators.map((i) => ({ id: i.id, name: i.name, category: i.category.name }))} />
                  </>}
            </Card>
          ) : null}
          {peersOn && (subject || isManager || privileged) ? (
            <Card title="Peer feedback" description={`Up to ${review.cycle.maxPeers} peers.${subject ? " Your manager approves the peers you choose." : ""}`}>
              <div className="stack gap-3">
                {peers.length === 0 ? <div className="text-sm subtle">No peers chosen yet.</div> : (
                  <div className="table-wrap"><table className="data"><tbody>
                    {peers.map((p) => (
                      <tr key={p.id}>
                        <td className="text-sm">{p.reviewer.displayName}</td>
                        <td>{p.status === "PROPOSED" ? <Badge tone="warning">awaiting manager</Badge> : p.submittedAt ? <Badge tone="success">submitted</Badge> : <Badge tone="info">asked</Badge>}</td>
                        <td className="right">{p.status === "PROPOSED" && isManager && open ? <DecideNomination reviewId={review.id} responseId={p.id} /> : null}</td>
                      </tr>
                    ))}
                  </tbody></table></div>
                )}
                {canNominate ? <NominatePeers reviewId={review.id} byManager={isManager} remaining={review.cycle.maxPeers - peers.length} options={peerOptions.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` }))} /> : null}
              </div>
            </Card>
          ) : null}
          {own.map((r) => (
            <Card key={r.id} title={r.reviewerType === "SELF" ? "Self review" : r.reviewerType === "MANAGER" ? `Manager review — ${r.reviewer.displayName}` : `Your ${(REVIEWER_LABEL[r.reviewerType] ?? "").toLowerCase()} feedback`} description={r.submittedAt ? `Submitted ${formatDate(r.submittedAt)}` : undefined}
              action={r.overallRating ? <Badge tone="info">{Number(r.overallRating)} / 5</Badge> : null}>
              <div className="stack gap-3">
                {r.strengths ? <div><div className="text-xs strong subtle">STRENGTHS</div><div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{r.strengths}</div></div> : null}
                {r.improvements ? <div><div className="text-xs strong subtle">TO IMPROVE</div><div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{r.improvements}</div></div> : null}
              </div>
            </Card>
          ))}
          {feedback.length || (privileged && pendingFeedback) ? (
            <Card title="Feedback from others" description={`${feedback.length} received${privileged && pendingFeedback ? `, ${pendingFeedback} still to come` : ""}${anonymous ? " · shown without names" : ""}`}>
              <div className="stack gap-3">
                {[...feedback].sort((a, b) => a.reviewerType.localeCompare(b.reviewerType) || (anonymous ? a.id.localeCompare(b.id) : 0)).map((r) => (
                  <div key={r.id} className="stack gap-1" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="text-sm strong">{REVIEWER_LABEL[r.reviewerType]}{anonymous ? "" : ` — ${r.reviewer.displayName}`}</span>
                      {r.overallRating ? <Badge tone="info">{Number(r.overallRating)} / 5</Badge> : null}
                    </div>
                    {r.strengths ? <div className="text-sm" style={{ whiteSpace: "pre-wrap" }}><span className="subtle">Does well: </span>{r.strengths}</div> : null}
                    {r.improvements ? <div className="text-sm" style={{ whiteSpace: "pre-wrap" }}><span className="subtle">Could improve: </span>{r.improvements}</div> : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          {subject && review.status === "SHARED" ? <Card title="Acknowledge"><AcknowledgeForm reviewId={review.id} /></Card> : null}
          {review.employeeComments ? <Callout tone="info" title="Employee's comments">{review.employeeComments}</Callout> : null}
        </div>
        <div className="stack gap-4">
          <Card title="Employee">
            <Person name={review.employee.displayName ?? ""} meta={`${review.employee.employeeNumber} · ${review.employee.jobTitleName ?? ""}`} />
          </Card>
          {(shared || calibrator || hr) ? (
            <Card title="Rating">
              <KeyValue items={[
                ["From responses", review.rawRating ? Number(review.rawRating).toFixed(2) : "—"],
                ["Final", review.finalRating ? Number(review.finalRating).toFixed(2) : "—"],
                ["Band", review.band?.name ?? "—"],
                ...(review.calibrationReason && !subject ? [["Calibration note", review.calibrationReason] as [string, string]] : []),
              ]} />
              {calibrator && ["PENDING_CALIBRATION", "CALIBRATED"].includes(review.status) ? <div style={{ marginTop: 12 }}><CalibrateForm reviewId={review.id} raw={review.rawRating ? Number(review.rawRating) : null} /></div> : null}
            </Card>
          ) : null}
          {subject || privileged ? <Card tight title="Goals in this period">
            {goals.length === 0 ? <Empty title="No goals counted" /> : (
              <div className="table-wrap"><table className="data"><tbody>
                {goals.map((g) => <tr key={g.id}><td className="text-sm">{g.title}</td><td className="num text-sm">{Number(g.progressPercent)}%</td><td><Badge>{g.status.replace(/_/g, " ").toLowerCase()}</Badge></td></tr>)}
              </tbody></table></div>
            )}
          </Card> : null}
        </div>
      </div>
    </>
  );
}
