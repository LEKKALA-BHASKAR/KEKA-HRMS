import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, type Permission } from "@keka/rbac";
import { bandFor } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty, Stat, Progress } from "@/components/ui";

const P = PERMISSIONS;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const DONE = ["PENDING_CALIBRATION", "CALIBRATED", "SHARED", "ACKNOWLEDGED"];

/**
 * Performance › Analytics: rating distribution by department and by manager,
 * review completion, and goal completion — for the people in the viewer's
 * performance scope.
 */
export default async function PerformanceAnalyticsPage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  const viewer = await requireViewer();
  const perm: Permission | undefined = [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.PERFORMANCE_VIEW].find((x) => can(viewer, x));
  if (!perm) forbidden();
  const scope = scopedEmployeeWhere(viewer, perm);
  const sp = await searchParams;
  const cycles = await prisma.reviewCycle.findMany({ where: { tenantId: viewer.tenantId, status: { not: "DRAFT" } }, orderBy: { periodStart: "desc" }, include: { bands: true } });
  const cycle = cycles.find((c) => c.id === sp.cycle) ?? cycles[0] ?? null;

  const [reviews, goals] = await Promise.all([
    cycle ? prisma.employeeReview.findMany({
      where: { cycleId: cycle.id, employee: scope },
      include: { employee: { select: { department: { select: { name: true } }, reportingManager: { select: { id: true, displayName: true } } } }, responses: { select: { reviewerType: true, submittedAt: true, status: true } } },
    }) : [],
    prisma.goal.findMany({ where: { tenantId: viewer.tenantId, employee: scope, status: { not: "CANCELLED" }, level: { in: ["INDIVIDUAL", "TEAM"] } }, select: { status: true, progressPercent: true, dueDate: true, employee: { select: { department: { select: { name: true } } } } } }),
  ]);

  const bands = (cycle?.bands ?? []).map((b) => ({ id: b.id, name: b.name, minRating: Number(b.minRating), maxRating: Number(b.maxRating), targetPercent: b.targetPercent === null ? null : Number(b.targetPercent) })).sort((a, b) => b.minRating - a.minRating);
  const ratingOf = (r: (typeof reviews)[number]) => (r.finalRating ?? r.rawRating) === null ? null : Number(r.finalRating ?? r.rawRating);
  const group = <K extends string>(key: (r: (typeof reviews)[number]) => K) => {
    const m = new Map<K, typeof reviews>();
    for (const r of reviews) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m].sort((a, b) => b[1].length - a[1].length);
  };
  const byDept = group((r) => r.employee.department?.name ?? "No department");
  const byMgr = group((r) => r.employee.reportingManager?.displayName ?? "No manager");
  const slot = (type: string) => {
    const all = reviews.flatMap((r) => r.responses.filter((x) => x.reviewerType === type && x.status !== "DECLINED"));
    return { done: all.filter((x) => x.submittedAt).length, total: all.length };
  };
  const self = slot("SELF"), mgr = slot("MANAGER"), peer = slot("PEER");
  const complete = reviews.filter((r) => DONE.includes(r.status)).length;
  const goalsDone = goals.filter((g) => g.status === "COMPLETED").length;
  const goalsByDept = new Map<string, typeof goals>();
  for (const g of goals) { const k = g.employee?.department?.name ?? "No department"; goalsByDept.set(k, [...(goalsByDept.get(k) ?? []), g]); }

  const DistRow = ({ label, rows }: { label: string; rows: typeof reviews }) => {
    const rated = rows.map(ratingOf).filter((x): x is number => x !== null);
    return (
      <tr>
        <td className="text-sm strong">{label}</td>
        <td className="num">{rows.length}</td>
        <td className="num">{avg(rated) ?? "—"}</td>
        {bands.map((b) => { const n = rated.filter((x) => bandFor(x, bands)?.id === b.id).length; return <td key={b.id} className="num">{n ? <>{n} <span className="subtle text-xs">({pct(n, rated.length)}%)</span></> : <span className="subtle">0</span>}</td>; })}
      </tr>
    );
  };

  return (
    <>
      <PageHead title="Performance analytics" subtitle="Ratings, review completion and goal completion for the people in your scope"
        actions={cycles.length ? (
          <form className="row gap-2"><select name="cycle" className="select" defaultValue={cycle?.id} aria-label="Cycle">{cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="btn">Show</button></form>
        ) : null} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Reviews complete" value={`${pct(complete, reviews.length)}%`} meta={`${complete} of ${reviews.length}${cycle ? ` · ${cycle.name}` : ""}`} />
        <Stat label="Self reviews in" value={`${pct(self.done, self.total)}%`} meta={`${self.done} of ${self.total}`} />
        <Stat label="Manager reviews in" value={`${pct(mgr.done, mgr.total)}%`} meta={`${mgr.done} of ${mgr.total}`} />
        <Stat label="Goals completed" value={`${pct(goalsDone, goals.length)}%`} meta={`${goalsDone} of ${goals.length} · avg progress ${avg(goals.map((g) => Number(g.progressPercent))) ?? 0}%`} />
      </div>
      {!cycle ? <Card><Empty title="No launched review cycles yet">Ratings appear here once a cycle is launched. <Link href="/performance/cycles">Review cycles</Link></Empty></Card> : (
        <>
          <Card tight title="Rating distribution by department" description={`Final rating where calibrated, else the reviewers' rating · ${cycle.name}`}>
            {reviews.length === 0 ? <Empty title="No reviews in your scope" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Department</th><th className="num">Reviews</th><th className="num">Avg rating</th>{bands.map((b) => <th key={b.id} className="num">{b.name}</th>)}</tr></thead>
                <tbody>{byDept.map(([k, rows]) => <DistRow key={k} label={k} rows={rows} />)}</tbody>
              </table></div>
            )}
          </Card>
          <Card tight title="Rating distribution by manager" description="Spot managers who rate everyone high — or everyone low.">
            {reviews.length === 0 ? <Empty title="No reviews in your scope" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Manager</th><th className="num">Reviews</th><th className="num">Avg rating</th>{bands.map((b) => <th key={b.id} className="num">{b.name}</th>)}</tr></thead>
                <tbody>{byMgr.map(([k, rows]) => <DistRow key={k} label={k} rows={rows} />)}</tbody>
              </table></div>
            )}
          </Card>
          <Card tight title="Review completion by manager" description={peer.total ? `Peer feedback: ${peer.done} of ${peer.total} in.` : undefined}>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Manager</th><th className="num">Self</th><th className="num">Manager</th><th style={{ width: 220 }}>Fully reviewed</th></tr></thead>
              <tbody>{byMgr.map(([k, rows]) => {
                const s = rows.flatMap((r) => r.responses.filter((x) => x.reviewerType === "SELF")), m = rows.flatMap((r) => r.responses.filter((x) => x.reviewerType === "MANAGER"));
                const d = rows.filter((r) => DONE.includes(r.status)).length;
                return <tr key={k}><td className="text-sm strong">{k}</td><td className="num">{s.filter((x) => x.submittedAt).length}/{s.length}</td><td className="num">{m.filter((x) => x.submittedAt).length}/{m.length}</td><td><Progress value={d} max={rows.length} /><div className="text-xs subtle">{d} of {rows.length}</div></td></tr>;
              })}</tbody>
            </table></div>
          </Card>
        </>
      )}
      <Card tight title="Goal completion by department" description="Individual and team goals, excluding cancelled ones.">
        {goals.length === 0 ? <Empty title="No goals in your scope" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Department</th><th className="num">Goals</th><th className="num">Completed</th><th className="num">At risk</th><th className="num">Overdue</th><th style={{ width: 200 }}>Average progress</th></tr></thead>
            <tbody>{[...goalsByDept].sort((a, b) => b[1].length - a[1].length).map(([k, gs]) => {
              const a = avg(gs.map((g) => Number(g.progressPercent))) ?? 0;
              const overdue = gs.filter((g) => g.dueDate < new Date() && !["COMPLETED", "MISSED"].includes(g.status)).length;
              return <tr key={k}><td className="text-sm strong">{k}</td><td className="num">{gs.length}</td><td className="num">{gs.filter((g) => g.status === "COMPLETED").length} <span className="subtle text-xs">({pct(gs.filter((g) => g.status === "COMPLETED").length, gs.length)}%)</span></td><td className="num">{gs.filter((g) => g.status === "AT_RISK").length}</td><td className="num">{overdue}</td><td><Progress value={a} max={100} /><div className="text-xs subtle">{a}%</div></td></tr>;
            })}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
