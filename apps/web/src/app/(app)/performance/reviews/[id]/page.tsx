import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, KeyValue, Person, Callout, Empty } from "@/components/ui";
import { ReviewForm, CalibrateForm, AcknowledgeForm } from "../../forms";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const review = await prisma.employeeReview.findFirst({
    where: { id, cycle: { tenantId: viewer.tenantId } },
    include: {
      cycle: true, band: true,
      employee: { select: { id: true, displayName: true, employeeNumber: true, jobTitleName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } },
      responses: { include: { reviewer: { select: { displayName: true } } }, orderBy: { reviewerType: "desc" } },
    },
  });
  if (!review) notFound();
  const me = viewer.employee?.id;
  const subject = review.employeeId === me;
  const mySlot = review.responses.find((r) => r.reviewerId === me && !r.submittedAt);
  const isReviewer = review.responses.some((r) => r.reviewerId === me);
  const calibrator = can(viewer, PERMISSIONS.PERFORMANCE_CALIBRATE) && canAccessEmployee(viewer, review.employee, PERMISSIONS.PERFORMANCE_CALIBRATE) && !subject;
  // Managers up the line and HR with performance visibility can read it.
  const hr = !subject && canAccessEmployee(viewer, review.employee, PERMISSIONS.PERFORMANCE_VIEW);
  if (!subject && !isReviewer && !calibrator && !hr) notFound();
  const shared = ["SHARED", "ACKNOWLEDGED"].includes(review.status);
  // The subject sees their own words always, the manager's only once shared.
  const visible = review.responses.filter((r) => r.submittedAt && (!subject || r.reviewerType === "SELF" || shared));
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
            <Card title={mySlot.reviewerType === "SELF" ? "Your self review" : `Your review of ${review.employee.displayName}`}
              description={mySlot.reviewerType === "MANAGER" && review.status === "SELF_PENDING" ? "Waiting for the self review first." : undefined}>
              {mySlot.reviewerType === "MANAGER" && review.status === "SELF_PENDING"
                ? <Empty title="The self review comes first">You will be notified when it is submitted.</Empty>
                : <ReviewForm reviewId={review.id} reviewerType={mySlot.reviewerType as "SELF" | "MANAGER"} indicators={indicators.map((i) => ({ id: i.id, name: i.name, category: i.category.name }))} />}
            </Card>
          ) : null}
          {visible.map((r) => (
            <Card key={r.id} title={r.reviewerType === "SELF" ? "Self review" : `Manager review — ${r.reviewer.displayName}`} description={r.submittedAt ? `Submitted ${formatDate(r.submittedAt)}` : undefined}
              action={r.overallRating ? <Badge tone="info">{Number(r.overallRating)} / 5</Badge> : null}>
              <div className="stack gap-3">
                {r.strengths ? <div><div className="text-xs strong subtle">STRENGTHS</div><div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{r.strengths}</div></div> : null}
                {r.improvements ? <div><div className="text-xs strong subtle">TO IMPROVE</div><div className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{r.improvements}</div></div> : null}
              </div>
            </Card>
          ))}
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
          <Card tight title="Goals in this period">
            {goals.length === 0 ? <Empty title="No goals counted" /> : (
              <div className="table-wrap"><table className="data"><tbody>
                {goals.map((g) => <tr key={g.id}><td className="text-sm">{g.title}</td><td className="num text-sm">{Number(g.progressPercent)}%</td><td><Badge>{g.status.replace(/_/g, " ").toLowerCase()}</Badge></td></tr>)}
              </tbody></table></div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
