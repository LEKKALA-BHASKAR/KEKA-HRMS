import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Progress, Stat } from "@/components/ui";
import { GoalForm, CheckIn, GoalStatus, CycleForm, CycleOps, PipForm, ClosePip } from "./forms";
import { Disclosure } from "../org/forms";

const P = PERMISSIONS;
const HEALTH: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  ON_TRACK: "success", NEEDS_ATTENTION: "warning", AT_RISK: "danger", COMPLETED: "info", MISSED: "danger", CANCELLED: "neutral", DRAFT: "neutral",
};
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const admin = canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE]);
  const tabs = ["goals", "reviews", ...(admin ? ["cycles"] : []), "plans"];
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "goals";
  return (
    <>
      <PageHead title="Performance" subtitle="Goals that roll up, reviews that are calibrated, and plans that end in a decision" />
      <div className="tabs">
        {tabs.map((t) => <Link key={t} href={`/performance?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{{ goals: "Goals", reviews: "Reviews", cycles: "Review cycles", plans: "Improvement plans" }[t]}</Link>)}
      </div>
      {tab === "goals" ? <Goals viewer={viewer} /> : null}
      {tab === "reviews" ? <Reviews viewer={viewer} /> : null}
      {tab === "cycles" ? <Cycles viewer={viewer} /> : null}
      {tab === "plans" ? <Plans viewer={viewer} /> : null}
    </>
  );
}

type V = Awaited<ReturnType<typeof requireViewer>>;

function GoalRow({ g, editable }: { g: { id: string; title: string; status: string; rollupMethod: string; progressPercent: unknown; dueDate: Date; metricType: string; currentValue: unknown; targetValue: unknown; metricName: string | null; _count: { childGoals: number; checkIns: number }; parentGoal: { title: string } | null; employee?: { displayName: string | null } | null }; editable: boolean }) {
  const pct = Number(g.progressPercent);
  return (
    <tr>
      <td style={{ minWidth: 240 }}>
        <div className="strong text-sm">{g.title}</div>
        <div className="text-xs subtle">
          {g.employee ? `${g.employee.displayName} · ` : ""}due {formatDate(g.dueDate)}
          {g.parentGoal ? ` · aligns to “${g.parentGoal.title}”` : ""}
          {g._count.childGoals ? (g.rollupMethod === "MANUAL" ? ` · ${g._count.childGoals} goal(s) aligned` : ` · rolls up ${g._count.childGoals} goal(s)`) : ""}
        </div>
      </td>
      <td style={{ width: 170 }}>
        <Progress value={pct} max={100} tone={g.status === "AT_RISK" || g.status === "MISSED" ? "warning" : "success"} />
        <div className="text-xs subtle" style={{ marginTop: 3 }}>
          {pct}%{g.metricType !== "PERCENTAGE" && g.metricType !== "COMPLETION" ? ` · ${Number(g.currentValue).toLocaleString("en-IN")} of ${Number(g.targetValue).toLocaleString("en-IN")}${g.metricName ? ` ${g.metricName}` : ""}` : ""}
        </div>
      </td>
      <td><Badge tone={HEALTH[g.status]}>{label(g.status)}</Badge></td>
      <td className="right">
        {editable && (g._count.childGoals === 0 || g.rollupMethod === "MANUAL") && !["CANCELLED", "COMPLETED", "MISSED"].includes(g.status) ? <CheckIn goalId={g.id} metric={g.metricType} current={Number(g.currentValue)} /> : null}
        {editable ? <GoalStatus goalId={g.id} cancelled={g.status === "CANCELLED"} /> : null}
      </td>
    </tr>
  );
}

const goalInclude = { _count: { select: { childGoals: true, checkIns: true } }, parentGoal: { select: { title: true } }, employee: { select: { displayName: true } } } as const;

async function Goals({ viewer }: { viewer: V }) {
  const me = viewer.employee?.id;
  const reports = [...viewer.allReportIds];
  const orgAdmin = can(viewer, P.GOALS_MANAGE);
  const [mine, team, org, employees, departments] = await Promise.all([
    me ? prisma.goal.findMany({ where: { employeeId: me }, include: goalInclude, orderBy: { dueDate: "asc" } }) : [],
    reports.length ? prisma.goal.findMany({ where: { employeeId: { in: reports }, status: { not: "CANCELLED" } }, include: goalInclude, orderBy: [{ status: "asc" }, { dueDate: "asc" }] }) : [],
    prisma.goal.findMany({ where: { tenantId: viewer.tenantId, level: { in: ["COMPANY", "DEPARTMENT", "TEAM"] } }, include: goalInclude, orderBy: [{ level: "asc" }, { title: "asc" }] }),
    orgAdmin ? prisma.employee.findMany({ where: { ...scopedEmployeeWhere(viewer, P.GOALS_MANAGE), status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } })
      : prisma.employee.findMany({ where: { id: { in: [...(me ? [me] : []), ...reports] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    orgAdmin ? prisma.department.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" } }) : [],
  ]);
  const now = new Date();
  const fyEnd = new Date(Date.UTC(now.getUTCMonth() >= 3 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(), 2, 31)).toISOString().slice(0, 10);
  const avg = (gs: typeof mine) => gs.length ? Math.round(gs.reduce((s, g) => s + Number(g.progressPercent), 0) / gs.length) : 0;
  const atRisk = [...mine, ...team].filter((g) => g.status === "AT_RISK").length;
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="My goals" value={String(mine.filter((g) => g.status !== "CANCELLED").length)} meta={`${avg(mine.filter((g) => g.status !== "CANCELLED"))}% average progress`} />
        <Stat label="At risk" value={String(atRisk)} meta="behind the clock by 25+ points" />
        <Stat label="Team goals" value={String(team.length)} meta={reports.length ? `${reports.length} people` : "no reports"} />
        <Stat label="Company & department" value={String(org.length)} meta={`${avg(org)}% average`} />
      </div>
      <Card title="Set a goal" description="Progress is checked against how much of the goal's time has passed: ten points behind is on track, twenty-five is at risk.">
        <Disclosure label="New goal">
          <GoalForm employees={employees.map((e) => ({ value: e.id, label: e.displayName ?? "" }))} departments={departments.map((d) => ({ value: d.id, label: d.name }))}
            parents={org.map((g) => ({ value: g.id, label: `${label(g.level)}: ${g.title}` }))} canOrgGoals={orgAdmin} defaultEmployeeId={me} fyEnd={fyEnd} />
        </Disclosure>
      </Card>
      {[["My goals", mine, true], ["My team's goals", team, true], ["Company and department goals", org, orgAdmin]].map(([title, gs, editable]) => (
        (gs as typeof mine).length || title === "My goals" ? (
          <Card key={title as string} tight title={title as string}>
            {(gs as typeof mine).length === 0 ? <Empty title="No goals yet">Set one above, or align to a company goal.</Empty> : (
              <div className="table-wrap"><table className="data"><tbody>
                {(gs as typeof mine).map((g) => <GoalRow key={g.id} g={g} editable={editable as boolean} />)}
              </tbody></table></div>
            )}
          </Card>
        ) : null
      ))}
    </div>
  );
}

async function Reviews({ viewer }: { viewer: V }) {
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

async function Cycles({ viewer }: { viewer: V }) {
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

async function Plans({ viewer }: { viewer: V }) {
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
