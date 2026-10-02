import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { distribution } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person } from "@/components/ui";
import { CalibrateForm, CycleOps } from "../../forms";

export default async function CalibrationPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.PERFORMANCE_CALIBRATE);
  const { id } = await params;
  const cycle = await prisma.reviewCycle.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { bands: { orderBy: { displayOrder: "asc" } } } });
  if (!cycle) notFound();
  const reviews = await prisma.employeeReview.findMany({
    where: { cycleId: id, employee: scopedEmployeeWhere(viewer, PERMISSIONS.PERFORMANCE_CALIBRATE) },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } }, band: true },
    orderBy: [{ status: "asc" }, { rawRating: "desc" }],
  });
  const bands = cycle.bands.map((b) => ({ id: b.id, name: b.name, minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null ? null : Number(b.targetPercent) }));
  const rated = reviews.map((r) => (r.finalRating ?? r.rawRating)).filter((x) => x !== null).map(Number);
  const dist = distribution(rated, bands);
  const color = new Map(cycle.bands.map((b) => [b.name, b.color ?? "var(--brand-500)"]));
  const max = Math.max(1, ...dist.map((d) => Math.max(d.actual, d.target ?? 0)));

  return (
    <>
      <PageHead title={`Calibrate — ${cycle.name}`} subtitle={`${reviews.length} review(s) in your scope · ${cycle.status.replace(/_/g, " ").toLowerCase()}`}
        actions={<div className="row gap-2">{can(viewer, PERMISSIONS.PERFORMANCE_MANAGE) ? <CycleOps cycleId={cycle.id} status={cycle.status} /> : null}{can(viewer, PERMISSIONS.SALARY_REVISE) ? <Link className="btn" href={`/performance/cycles/${cycle.id}/pay`}>Review to pay</Link> : null}<Link className="btn" href="/performance?tab=cycles">Back</Link></div>} />
      <Card title="Distribution against target" description={`${rated.length} rated. Bars show the share in each band; the marker is the target.`}>
        <div className="stack gap-3">
          {dist.map((d) => (
            <div key={d.band}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                <span className="text-sm strong">{d.band}</span>
                <span className="text-sm num">{d.count} · {d.actual}%{d.target !== null ? <span className={d.variance! > 5 ? "neg" : d.variance! < -5 ? "muted" : "pos"}> (target {d.target}%{d.variance ? `, ${d.variance > 0 ? "+" : ""}${d.variance}` : ""})</span> : null}</span>
              </div>
              <div style={{ position: "relative", height: 10, background: "var(--surface-2)", borderRadius: 5 }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(d.actual / max) * 100}%`, background: color.get(d.band), borderRadius: 5 }} />
                {d.target !== null ? <div title={`Target ${d.target}%`} style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: `${(d.target / max) * 100}%`, background: "var(--text)" }} /> : null}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card tight title="Reviews" description="Moving a rating away from the reviewers' needs a reason; it is shown to HR, not the employee.">
        {reviews.length === 0 ? <Empty title="Not launched yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Status</th><th className="num">From reviews</th><th className="num">Final</th><th>Band</th><th /></tr></thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/performance/reviews/${r.id}`}><Person name={r.employee.displayName ?? ""} meta={`${r.employee.employeeNumber} · ${r.employee.department?.name ?? ""}`} /></Link></td>
                  <td><Badge tone={r.status === "CALIBRATED" || r.status === "SHARED" ? "success" : r.status === "PENDING_CALIBRATION" ? "warning" : "neutral"}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                  <td className="num">{r.rawRating ? Number(r.rawRating).toFixed(2) : "—"}</td>
                  <td className="num strong">{r.finalRating ? Number(r.finalRating).toFixed(2) : "—"}</td>
                  <td>{r.band ? <Badge>{r.band.name}</Badge> : null}</td>
                  <td className="right">{["PENDING_CALIBRATION", "CALIBRATED"].includes(r.status) && r.employeeId !== viewer.employee?.id ? <CalibrateForm reviewId={r.id} raw={r.rawRating ? Number(r.rawRating) : null} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
