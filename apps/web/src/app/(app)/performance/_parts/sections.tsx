import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Card, Badge, Empty, Person, Progress } from "@/components/ui";
import { CycleForm, CycleOps, PipForm, ClosePip } from "../forms";
import { Disclosure } from "./disclosure";

/** The Reviews, Review cycles and Improvement plans sections of the Performance workspace. */

const P = PERMISSIONS;
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
type V = Viewer;

export async function Reviews({ viewer }: { viewer: V }) {
  const me = viewer.employee?.id;
  if (!me) return <Card><Empty title="No employee record" /></Card>;
  const [toWrite, mine] = await Promise.all([
    prisma.reviewResponse.findMany({
      where: { reviewerId: me, submittedAt: null, review: { cycle: { status: { in: ["IN_PROGRESS", "LAUNCHED"] } } } },
      include: { review: { include: { employee: { select: { displayName: true, employeeNumber: true } }, cycle: { select: { name: true, reviewClosesAt: true } } } } },
    }),
    prisma.employeeReview.findMany({ where: { employeeId: me }, include: { cycle: { select: { name: true, periodEnd: true } }, band: true }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <div className="stack gap-4">
      <Card tight title={`To write (${toWrite.length})`}>
        {toWrite.length === 0 ? <Empty title="Nothing to write right now" /> : (
          <div className="table-wrap"><table className="data"><tbody>
            {toWrite.map((r) => (
              <tr key={r.id}>
                <td><Person name={r.review.employee.displayName ?? ""} meta={r.review.employee.employeeNumber} /></td>
                <td className="text-sm">{r.review.cycle.name}</td>
                <td><Badge tone={r.reviewerType === "SELF" ? "info" : "warning"}>{r.reviewerType === "SELF" ? "self review" : "as manager"}</Badge></td>
                <td className="text-sm muted">{r.review.cycle.reviewClosesAt ? `closes ${formatDate(r.review.cycle.reviewClosesAt)}` : ""}</td>
                <td className="right"><Link className="btn sm primary" href={`/performance/reviews/${r.reviewId}`}>Write</Link></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Card>
      <Card tight title="My reviews">
        {mine.length === 0 ? <Empty title="No reviews yet" /> : (
          <div className="table-wrap"><table className="data"><tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td className="strong text-sm">{r.cycle.name}</td>
                <td><Badge>{label(r.status)}</Badge></td>
                <td className="text-sm">{["SHARED", "ACKNOWLEDGED"].includes(r.status) && r.finalRating ? <>{Number(r.finalRating)} · {r.band?.name}</> : <span className="subtle">shared when the cycle closes</span>}</td>
                <td className="right"><Link className="btn sm" href={`/performance/reviews/${r.id}`}>Open</Link></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}

export async function Cycles({ viewer }: { viewer: V }) {
  const cycles = await prisma.reviewCycle.findMany({
    where: { tenantId: viewer.tenantId }, orderBy: { periodStart: "desc" },
    include: { reviews: { select: { status: true } } },
  });
  return (
    <div className="stack gap-4">
      {can(viewer, P.PERFORMANCE_MANAGE) ? <Card title="New review cycle" description="Four rating bands with a target distribution are created with it; calibration compares against them."><Disclosure label="Create a cycle"><CycleForm /></Disclosure></Card> : null}
      <Card tight title="Cycles">
        {cycles.length === 0 ? <Empty title="No review cycles yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Cycle</th><th>Period</th><th>Status</th><th style={{ width: 200 }}>Progress</th><th /></tr></thead>
            <tbody>
              {cycles.map((c) => {
                const done = c.reviews.filter((r) => ["PENDING_CALIBRATION", "CALIBRATED", "SHARED", "ACKNOWLEDGED"].includes(r.status)).length;
                return (
                  <tr key={c.id}>
                    <td className="strong text-sm">{c.name}</td>
                    <td className="text-sm nowrap">{formatDate(c.periodStart)} – {formatDate(c.periodEnd)}</td>
                    <td><Badge tone={c.status === "COMPLETED" ? "success" : c.status === "DRAFT" ? "neutral" : "info"}>{label(c.status)}</Badge></td>
                    <td>{c.reviews.length ? <><Progress value={done} max={c.reviews.length} /><div className="text-xs subtle" style={{ marginTop: 3 }}>{done} of {c.reviews.length} fully reviewed</div></> : <span className="text-xs subtle">not launched</span>}</td>
                    <td className="right"><span className="row gap-2" style={{ justifyContent: "flex-end" }}>{can(viewer, P.PERFORMANCE_MANAGE) ? <CycleOps cycleId={c.id} status={c.status} /> : null}<Link className="btn sm" href={`/performance/cycles/${c.id}`}>Calibrate</Link></span></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

export async function Plans({ viewer }: { viewer: V }) {
  const manage = can(viewer, P.PIP_MANAGE);
  const plans = await prisma.improvementPlan.findMany({
    where: manage ? { tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.PIP_MANAGE) } : { employeeId: viewer.employee?.id ?? "__none__" },
    include: { employee: { select: { displayName: true, employeeNumber: true } } },
    orderBy: [{ status: "asc" }, { endDate: "asc" }],
  });
  const employees = manage ? await prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.PIP_MANAGE), status: { notIn: ["EXITED"] }, NOT: viewer.employee ? { id: viewer.employee.id } : undefined }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [];
  return (
    <div className="stack gap-4">
      {manage ? <Card title="Start an improvement plan" description="A plan has a fixed end and must close as successful, extended, or unsuccessful — with the evidence recorded."><Disclosure label="New plan"><PipForm employees={employees.map((e) => ({ value: e.id, label: e.displayName ?? "" }))} /></Disclosure></Card> : null}
      <Card tight title="Plans">
        {plans.length === 0 ? <Empty title="No improvement plans" /> : (
          <div className="table-wrap"><table className="data"><tbody>
            {plans.map((p) => {
              const daysLeft = Math.ceil((p.endDate.getTime() - Date.now()) / 86_400_000);
              return (
                <tr key={p.id} style={{ verticalAlign: "top" }}>
                  <td><Person name={p.employee.displayName ?? ""} meta={p.employee.employeeNumber} /></td>
                  <td className="text-sm" style={{ maxWidth: 360 }}><div className="strong">{p.reason}</div><div className="muted">{p.objectives}</div></td>
                  <td className="text-sm nowrap">{formatDate(p.startDate)} – {formatDate(p.endDate)}<div className="text-xs subtle">{p.status === "ACTIVE" ? (daysLeft >= 0 ? `${daysLeft} days left` : `${-daysLeft} days overdue for a decision`) : ""}</div></td>
                  <td>{p.status === "ACTIVE" ? <Badge tone={daysLeft < 0 ? "danger" : "warning"}>active</Badge> : <Badge tone={p.outcome === "SUCCESSFUL" ? "success" : "danger"}>{label(p.outcome ?? p.status)}</Badge>}{p.outcomeNote ? <div className="text-xs subtle">{p.outcomeNote}</div> : null}</td>
                  <td className="right">{manage && p.status === "ACTIVE" ? <ClosePip id={p.id} /> : null}</td>
                </tr>
              );
            })}
          </tbody></table></div>
        )}
      </Card>
    </div>
  );
}
