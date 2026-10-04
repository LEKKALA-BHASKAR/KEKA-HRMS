import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { distribution, nineBoxCell, NINE_BOX } from "@keka/services";
import { requireAuth, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person } from "@/components/ui";
import { CalibrateForm, CycleOps } from "../../forms";
import { BandsForm } from "../../_parts/talent-forms";
import { Disclosure } from "../../_parts/disclosure";

/**
 * Calibration: the distribution against target, the bell curve before and
 * after calibration, the 9-box (performance × potential), editable bands,
 * and each review's final rating and potential.
 */
export default async function CalibrationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ box?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.PERFORMANCE_CALIBRATE);
  const { id } = await params;
  const sp = await searchParams;
  const cycle = await prisma.reviewCycle.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { bands: { orderBy: { displayOrder: "asc" } }, stageDates: true } });
  if (!cycle) notFound();
  const reviews = await prisma.employeeReview.findMany({
    where: { cycleId: id, employee: scopedEmployeeWhere(viewer, PERMISSIONS.PERFORMANCE_CALIBRATE) },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, department: { select: { name: true } } } }, band: true },
    orderBy: [{ status: "asc" }, { rawRating: "desc" }],
  });
  const bands = cycle.bands.map((b) => ({ id: b.id, name: b.name, minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null ? null : Number(b.targetPercent) }));
  const rated = reviews.map((r) => (r.finalRating ?? r.rawRating)).filter((x) => x !== null).map(Number);
  const dist = distribution(rated, bands);
  const before = distribution(reviews.map((r) => r.rawRating).filter((x) => x !== null).map(Number), bands);
  const after = distribution(reviews.map((r) => r.finalRating).filter((x) => x !== null).map(Number), bands);
  const color = new Map(cycle.bands.map((b) => [b.name, b.color ?? "var(--brand-500)"]));
  const max = Math.max(1, ...dist.map((d) => Math.max(d.actual, d.target ?? 0)));
  const curveMax = Math.max(1, ...before.map((d) => d.actual), ...after.map((d) => d.actual), ...after.map((d) => d.target ?? 0));

  // 9-box: final (else raw) performance against potential.
  const boxed = reviews.flatMap((r) => {
    const perf = r.finalRating ?? r.rawRating;
    if (perf === null || r.potentialRating === null) return [];
    return [{ r, cell: nineBoxCell(Number(perf), Number(r.potentialRating)) }];
  });
  const unboxed = reviews.filter((r) => (r.finalRating ?? r.rawRating) !== null && r.potentialRating === null).length;
  const chosenBox = sp.box && /^[0-2]-[0-2]$/.test(sp.box) ? sp.box : null;
  const editBands = canAny(viewer, [PERMISSIONS.PERFORMANCE_MANAGE, PERMISSIONS.PERFORMANCE_CALIBRATE]) && !["COMPLETED", "CANCELLED"].includes(cycle.status);
  const pct = (n: number) => `${Math.round(n)}%`;

  return (
    <>
      <PageHead title={`Calibrate — ${cycle.name}`} subtitle={`${reviews.length} review(s) in your scope · ${cycle.status.replace(/_/g, " ").toLowerCase()}${cycle.stageDates?.calibrationEndsAt ? ` · calibration ends ${cycle.stageDates.calibrationEndsAt.toISOString().slice(0, 10)}` : ""}`}
        actions={<div className="row gap-2">{can(viewer, PERMISSIONS.PERFORMANCE_MANAGE) ? <CycleOps cycleId={cycle.id} status={cycle.status} /> : null}{can(viewer, PERMISSIONS.PERFORMANCE_MANAGE) ? <Link className="btn" href={`/performance/cycles/${cycle.id}/setup`}>Form &amp; dates</Link> : null}{can(viewer, PERMISSIONS.SALARY_REVISE) ? <Link className="btn" href={`/performance/cycles/${cycle.id}/pay`}>Review to pay</Link> : null}<Link className="btn" href="/performance/cycles">Back</Link></div>} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Distribution against target" description={`${rated.length} rated. Bars show the share in each band; the marker is the target.`}
          action={editBands ? <Disclosure label="Edit bands"><BandsForm cycleId={cycle.id} bands={cycle.bands.map((b) => ({ id: b.id, name: b.name, min: Number(b.minRating), max: Number(b.maxRating), target: b.targetPercent === null ? null : Number(b.targetPercent), color: b.color }))} /></Disclosure> : undefined}>
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

        <Card title="Bell curve: before and after calibration" description="Share of reviews in each band from the reviewers' ratings (before) and the calibrated ratings (after), lowest band on the left; the line is the target.">
          {after.every((x) => x.count === 0) && before.every((x) => x.count === 0) ? <Empty title="No ratings yet" /> : (
            <div>
              <div className="row gap-3" style={{ alignItems: "flex-end", height: 160, borderBottom: "1px solid var(--border)", padding: "0 4px" }} role="img" aria-label="Bell curve before and after calibration">
                {[...before].reverse().map((b, i) => {
                  const a = [...after].reverse()[i];
                  return (
                    <div key={b.band} style={{ flex: 1, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 4, height: "100%", position: "relative" }}>
                      <div title={`Before: ${b.count} (${pct(b.actual)})`} style={{ width: "34%", height: `${(b.actual / curveMax) * 100}%`, background: "var(--surface-3, #c7ccd6)", borderRadius: "4px 4px 0 0" }} />
                      <div title={`After: ${a.count} (${pct(a.actual)})`} style={{ width: "34%", height: `${(a.actual / curveMax) * 100}%`, background: color.get(a.band), borderRadius: "4px 4px 0 0" }} />
                      {a.target !== null ? <div title={`Target ${a.target}%`} style={{ position: "absolute", left: "8%", right: "8%", bottom: `${(a.target / curveMax) * 100}%`, borderTop: "2px dashed var(--text)" }} /> : null}
                    </div>
                  );
                })}
              </div>
              <div className="row gap-3" style={{ padding: "6px 4px 0" }}>
                {[...before].reverse().map((b, i) => <div key={b.band} className="text-xs" style={{ flex: 1, textAlign: "center" }}>{b.band}<div className="subtle">{pct(b.actual)} → {pct([...after].reverse()[i].actual)}</div></div>)}
              </div>
              <div className="row gap-3 text-xs subtle" style={{ marginTop: 8 }}><span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--surface-3, #c7ccd6)" }} /> before</span><span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--brand-500)" }} /> after</span><span>- - target</span></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="9-box: performance × potential" description={`${boxed.length} placed${unboxed ? `; ${unboxed} rated without a potential yet — set it when calibrating` : ""}. Click a box to list its people.`}>
        <div style={{ display: "grid", gridTemplateColumns: "28px repeat(3, 1fr)", gap: 6 }}>
          {[2, 1, 0].map((pot) => (
            <div key={pot} style={{ display: "contents" }}>
              <div className="text-xs subtle" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center" }}>{["Low", "Moderate", "High"][pot]}</div>
              {[0, 1, 2].map((perf) => {
                const here = boxed.filter((b) => b.cell.pot === pot && b.cell.perf === perf);
                const key = `${pot}-${perf}`;
                const shade = pot + perf >= 3 ? "rgba(15,138,85,.12)" : pot + perf <= 1 ? "rgba(201,42,42,.10)" : "rgba(18,102,168,.08)";
                return (
                  <Link key={key} href={chosenBox === key ? `/performance/cycles/${cycle.id}` : `/performance/cycles/${cycle.id}?box=${key}`} scroll={false}
                    className="card" style={{ padding: 10, minHeight: 84, background: shade, outline: chosenBox === key ? "2px solid var(--brand-500)" : undefined, display: "block" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}><span className="text-sm strong">{NINE_BOX[pot][perf]}</span><span className="num strong">{here.length}</span></div>
                    <div className="text-xs subtle" style={{ marginTop: 4 }}>{here.slice(0, 3).map((h) => h.r.employee.displayName).join(", ")}{here.length > 3 ? ` +${here.length - 3}` : ""}</div>
                  </Link>
                );
              })}
            </div>
          ))}
          <div />
          {["Low", "Moderate", "High"].map((l) => <div key={l} className="text-xs subtle" style={{ textAlign: "center" }}>{l} performance</div>)}
        </div>
        {chosenBox ? (
          <div style={{ marginTop: 12 }}>
            <div className="strong text-sm">{NINE_BOX[Number(chosenBox[0])][Number(chosenBox[2])]}</div>
            <ul className="text-sm">{boxed.filter((b) => `${b.cell.pot}-${b.cell.perf}` === chosenBox).map((b) => <li key={b.r.id}><Link href={`/performance/reviews/${b.r.id}`}>{b.r.employee.displayName}</Link> — performance {Number(b.r.finalRating ?? b.r.rawRating).toFixed(2)}, potential {Number(b.r.potentialRating)}</li>)}</ul>
          </div>
        ) : null}
      </Card>

      <Card tight title="Reviews" description="Moving a rating away from the reviewers' needs a reason; it is shown to HR, not the employee. Potential places them on the 9-box.">
        {reviews.length === 0 ? <Empty title="Not launched yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Employee</th><th>Status</th><th className="num">From reviews</th><th className="num">Final</th><th className="num">Potential</th><th>Band</th><th /></tr></thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/performance/reviews/${r.id}`}><Person name={r.employee.displayName ?? ""} meta={`${r.employee.employeeNumber} · ${r.employee.department?.name ?? ""}`} /></Link></td>
                  <td><Badge tone={r.status === "CALIBRATED" || r.status === "SHARED" ? "success" : r.status === "PENDING_CALIBRATION" ? "warning" : "neutral"}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                  <td className="num">{r.rawRating ? Number(r.rawRating).toFixed(2) : "—"}</td>
                  <td className="num strong">{r.finalRating ? Number(r.finalRating).toFixed(2) : "—"}</td>
                  <td className="num">{r.potentialRating ? Number(r.potentialRating) : "—"}</td>
                  <td>{r.band ? <Badge>{r.band.name}</Badge> : null}</td>
                  <td className="right">{["PENDING_CALIBRATION", "CALIBRATED"].includes(r.status) && r.employeeId !== viewer.employee?.id ? <CalibrateForm reviewId={r.id} raw={r.rawRating ? Number(r.rawRating) : null} potential={r.potentialRating ? Number(r.potentialRating) : null} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
