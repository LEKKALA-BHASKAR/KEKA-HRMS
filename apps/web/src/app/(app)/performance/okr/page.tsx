import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { CHECKIN_CADENCES, checkInOverdue, confidenceLabel, stretchProgress } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeIds } from "@/lib/scope";
import { runDataset } from "@/lib/insight/datasets";
import { userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Badge } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Tabs, Table, Pill } from "@/components/gov-ui";
import { InsightTableView, ExportLinks } from "@/components/insight-table";
import { checkInAction, publishDraftGoalAction } from "@/app/actions/performance";
import {
  saveOkrSettingAction, setGoalPlanAction, linkGoalsAction, unlinkGoalsAction, triageGoalAction, requestCloseoutAction, snapshotGoalsAction, runInsightJobAction,
} from "@/app/actions/insight-performance";

export const metadata = { title: "OKRs" };
const TABS = { goals: "Objectives", checkins: "Check-ins", risk: "At-risk queue", links: "Links & dependencies", approvals: "Approvals", closeout: "Close-out", snapshots: "Snapshots", settings: "Settings", audit: "Audit & export" };
type Tab = keyof typeof TABS;
type SP = Record<string, string | undefined>;
const LIVE: Array<"ON_TRACK" | "NEEDS_ATTENTION" | "AT_RISK"> = ["ON_TRACK", "NEEDS_ATTENTION", "AT_RISK"];
const isLive = (s: string) => (LIVE as string[]).includes(s);
const cadenceOpts = Object.keys(CHECKIN_CADENCES).map((k) => ({ value: k, label: k.toLowerCase() }));

/** Goals the viewer works with: their own, their team's, and — for goal administrators — everything in scope. */
async function goalWhere(viewer: Viewer) {
  const me = viewer.employee?.id ?? "__none__";
  if (can(viewer, P.GOALS_MANAGE)) {
    const ids = await scopedEmployeeIds(viewer, P.GOALS_MANAGE);
    return { tenantId: viewer.tenantId, ...(ids ? { OR: [{ employeeId: { in: [...ids, me] } }, { employeeId: null }] } : {}) };
  }
  return { tenantId: viewer.tenantId, OR: [{ employeeId: me }, { employeeId: { in: [...viewer.allReportIds] } }, { employeeId: null, visibility: "EVERYONE" }] };
}

/**
 * Performance › OKRs: stretch targets, check-in cadence and confidence,
 * overdue check-ins, the at-risk queue, cross-team links and dependencies,
 * goal approval, close-out (approval) and snapshots, settings, the audit
 * history and the OKR export.
 */
export default async function OkrPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const tab: Tab = (sp.tab as Tab) in TABS ? (sp.tab as Tab) : "goals";
  const admin = can(viewer, P.GOALS_MANAGE);
  const where = await goalWhere(viewer);
  const [goals, setting] = await Promise.all([
    prisma.goal.findMany({ where, include: { employee: { select: { displayName: true } }, checkIns: { orderBy: { recordedAt: "desc" }, take: 1 } }, orderBy: [{ level: "asc" }, { dueDate: "asc" }] }),
    prisma.insightOkrSetting.findUnique({ where: { tenantId: viewer.tenantId } }),
  ]);
  const me = viewer.employee?.id;
  const mayEdit = (g: (typeof goals)[number]) => (g.employeeId ? g.employeeId === me || viewer.allReportIds.has(g.employeeId) || admin : admin);
  const owner = (g: (typeof goals)[number]) => g.employee?.displayName ?? (g.level === "COMPANY" ? "Company" : g.level.toLowerCase());
  const goalOpts = goals.filter((g) => g.status !== "CANCELLED").map((g) => ({ value: g.id, label: `${g.title.slice(0, 60)} — ${owner(g)}` }));
  const grace = setting?.graceDays ?? 3;
  const cadenceOf = (g: (typeof goals)[number]) => g.checkInCadence ?? setting?.defaultCadence ?? "MONTHLY";
  return (
    <>
      <PageHead title="OKRs" subtitle="Objectives and key results: cadence, confidence, risk, links, approval and close-out" actions={<span className="row gap-2"><ExportLinks ds="okr" /><Link className="btn sm" href="/performance/goals">Goals</Link></span>} />
      <Tabs base="/performance/okr" tabs={TABS} active={tab} />
      {tab === "goals" ? (
        <>
          <Card title="Objectives and key results" description="Stretch targets go beyond the committed target; confidence (0–10) is recorded with each check-in.">
            <Table head={["Objective", "Owner", "Progress", "Stretch", "Confidence", "Cadence", "Status", ""]} empty={!goals.length}>
              {goals.filter((g) => g.status !== "CANCELLED").map((g) => {
                const s = stretchProgress(Number(g.startValue), Number(g.targetValue), g.stretchValue === null ? null : Number(g.stretchValue), Number(g.currentValue));
                return (
                  <tr key={g.id}>
                    <td><strong>{g.title}</strong><div className="text-xs muted">{g.level.toLowerCase()}{g.timeframe ? ` · ${g.timeframe}` : ""}</div></td>
                    <td className="text-sm">{owner(g)}</td><td className="num">{Number(g.progressPercent)}%</td>
                    <td className="num">{g.stretchValue === null ? "—" : `${Number(g.stretchValue)} (${s.stretch}%)`}</td>
                    <td>{g.confidence === null ? "—" : <Badge tone={confidenceLabel(g.confidence) === "LOW" ? "danger" : confidenceLabel(g.confidence) === "MEDIUM" ? "warning" : "success"}>{g.confidence}/10</Badge>}</td>
                    <td className="text-sm">{cadenceOf(g).toLowerCase()}</td>
                    <td><Pill s={g.approvalStatus === "PENDING" ? "PENDING_APPROVAL" : g.status} /></td>
                    <td>{mayEdit(g) ? <Link className="btn sm" href={`/performance/okr?tab=goals&goal=${g.id}`}>Plan · check in</Link> : null}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
          {sp.goal && goals.find((g) => g.id === sp.goal && mayEdit(g)) ? (() => {
            const g = goals.find((x) => x.id === sp.goal)!;
            return (
              <div className="grid grid-2">
                <Card title={`Check in: ${g.title}`} description={`Target ${Number(g.targetValue)} from ${Number(g.startValue)}; now ${Number(g.currentValue)}.`}>
                  <SpecForm action={checkInAction} hidden={{ goalId: g.id }} columns={1} submitLabel="Check in" fields={[
                    { name: "value", label: "Current value", type: "number", required: true, defaultValue: Number(g.currentValue) },
                    { name: "confidence", label: "Confidence of hitting it (0–10)", type: "number", defaultValue: g.confidence ?? "" },
                    { name: "note", label: "Note", type: "textarea" },
                  ]} />
                </Card>
                <Card title="Stretch target and cadence">
                  <SpecForm action={setGoalPlanAction} hidden={{ goalId: g.id }} columns={1} fields={[
                    { name: "stretchValue", label: "Stretch target", type: "number", defaultValue: g.stretchValue === null ? "" : Number(g.stretchValue) },
                    { name: "checkInCadence", label: "Check in", type: "select", options: cadenceOpts, defaultValue: g.checkInCadence ?? "", placeholder: `Company default (${(setting?.defaultCadence ?? "MONTHLY").toLowerCase()})` },
                  ]} />
                </Card>
              </div>
            );
          })() : null}
        </>
      ) : null}
      {tab === "checkins" ? (
        <>
          <Card title="Overdue check-ins" description={`Past the cadence plus ${grace} grace day(s). Owners are alerted nightly.`} action={admin ? <ActButton action={runInsightJobAction} hidden={{ job: "checkins" }} label="Send alerts now" /> : null}>
            <Table head={["Objective", "Owner", "Cadence", "Last check-in", "Days late"]} empty={!goals.some((g) => isLive(g.status) && g.employeeId && checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, cadenceOf(g), grace).overdue)}>
              {goals.filter((g) => isLive(g.status) && g.employeeId).map((g) => ({ g, o: checkInOverdue(g.checkIns[0]?.recordedAt ?? null, g.startDate, cadenceOf(g), grace) })).filter((x) => x.o.overdue).map(({ g, o }) => (
                <tr key={g.id}><td>{g.title}</td><td className="text-sm">{owner(g)}</td><td>{cadenceOf(g).toLowerCase()}</td><td>{fmtDate(g.checkIns[0]?.recordedAt)}</td><td className="num">{o.daysLate}</td></tr>
              ))}
            </Table>
          </Card>
          <Card><InsightTableView table={await runDataset(viewer, "okr-checkins")} ds="okr-checkins" limit={100} /></Card>
        </>
      ) : null}
      {tab === "risk" ? (
        <Card title="At-risk objectives" description="Live objectives at risk or needing attention, or with low confidence. Record the review and the plan; the owner is told.">
          <Table head={["Objective", "Owner", "Progress", "Status", "Confidence", "Last reviewed", ""]} empty={!goals.some((g) => isLive(g.status) && (g.status !== "ON_TRACK" || (g.confidence !== null && g.confidence < 4)))}>
            {goals.filter((g) => isLive(g.status) && (g.status !== "ON_TRACK" || (g.confidence !== null && g.confidence < 4))).sort((a, b) => (a.riskReviewedAt ? 1 : 0) - (b.riskReviewedAt ? 1 : 0)).map((g) => (
              <tr key={g.id}>
                <td><strong>{g.title}</strong>{g.riskNote ? <div className="text-xs muted">Plan: {g.riskNote}</div> : null}</td><td className="text-sm">{owner(g)}</td><td className="num">{Number(g.progressPercent)}%</td><td><Pill s={g.status} /></td>
                <td>{g.confidence ?? "—"}</td><td>{fmtDate(g.riskReviewedAt)}</td>
                <td>{mayEdit(g) ? <ActButton action={triageGoalAction} hidden={{ goalId: g.id }} label="Reviewed" input={{ name: "riskNote", placeholder: "Plan / next step", required: true }} /> : null}</td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
      {tab === "links" ? await (async () => {
        const ids = goals.map((g) => g.id);
        const links = await prisma.insightGoalLink.findMany({ where: { tenantId: viewer.tenantId, OR: [{ fromGoalId: { in: ids } }, { toGoalId: { in: ids } }] } });
        const all = await prisma.goal.findMany({ where: { tenantId: viewer.tenantId, id: { in: [...new Set(links.flatMap((l) => [l.fromGoalId, l.toGoalId]))] } }, select: { id: true, title: true, status: true, employee: { select: { displayName: true, department: { select: { name: true } } } } } });
        const t = new Map(all.map((g) => [g.id, g]));
        const allGoals = await prisma.goal.findMany({ where: { tenantId: viewer.tenantId, status: { in: LIVE } }, include: { employee: { select: { displayName: true } } }, orderBy: { title: "asc" }, take: 500 });
        return (
          <>
            <Card title="Dependency map" description="DEPENDS ON: the first can't finish before the second. SUPPORTS: a cross-functional contribution. Loops are refused.">
              <Table head={["Objective", "", "Linked objective", "Their status", "Note", ""]} empty={!links.length}>
                {links.map((l) => {
                  const a = t.get(l.fromGoalId), b = t.get(l.toGoalId);
                  return <tr key={l.id}><td>{a?.title}<div className="text-xs muted">{a?.employee?.displayName ?? "org"}</div></td><td><Badge tone={l.kind === "DEPENDS_ON" ? "warning" : "info"}>{l.kind === "DEPENDS_ON" ? "depends on" : "supports"}</Badge></td><td>{b?.title}<div className="text-xs muted">{b?.employee?.displayName ?? "org"}{b?.employee?.department ? ` · ${b.employee.department.name}` : ""}</div></td><td>{b ? <Pill s={b.status} /> : null}</td><td className="text-sm">{l.note}</td><td><ActButton action={unlinkGoalsAction} hidden={{ id: l.id }} label="Remove" variant="ghost" /></td></tr>;
                })}
              </Table>
            </Card>
            <Card title="Link objectives">
              <SpecForm action={linkGoalsAction} columns={2} submitLabel="Link" fields={[
                { name: "fromGoalId", label: "Objective", type: "select", options: goalOpts.filter((o) => { const g = goals.find((x) => x.id === o.value)!; return mayEdit(g); }), required: true },
                { name: "kind", label: "Link", type: "select", options: [{ value: "SUPPORTS", label: "supports (cross-team)" }, { value: "DEPENDS_ON", label: "depends on" }], required: true },
                { name: "toGoalId", label: "Other objective (any team)", type: "select", options: allGoals.map((g) => ({ value: g.id, label: `${g.title.slice(0, 60)} — ${g.employee?.displayName ?? "org"}` })), required: true },
                { name: "note", label: "Note" },
              ]} />
            </Card>
          </>
        );
      })() : null}
      {tab === "approvals" ? (
        <Card title="Goal approval" description={setting?.requireApproval ? "Goals people set for themselves go to their manager; org goals to a goal administrator. Decide them in Inbox › Approvals." : "Goal approval is off — turn it on under Settings."}>
          <Table head={["Goal", "Owner", "Approval", "Status", ""]} empty={!goals.some((g) => g.approvalStatus)}>
            {goals.filter((g) => g.approvalStatus).map((g) => (
              <tr key={g.id}><td>{g.title}</td><td className="text-sm">{owner(g)}</td><td><Pill s={g.approvalStatus!} /></td><td><Pill s={g.status} /></td>
                <td>{g.approvalStatus === "REJECTED" && g.status === "DRAFT" && mayEdit(g) ? <ActButton action={publishDraftGoalAction} hidden={{ goalId: g.id }} label="Resubmit" /> : null}</td></tr>
            ))}
          </Table>
        </Card>
      ) : null}
      {tab === "closeout" ? await (async () => {
        const closeouts = await prisma.insightOkrCloseout.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" } });
        const tfs = [...new Set((await prisma.goal.findMany({ where: { tenantId: viewer.tenantId, closedOutAt: null, timeframe: { not: null } }, select: { timeframe: true } })).map((g) => g.timeframe!))];
        const names = await userNames(viewer.tenantId, closeouts.map((c) => c.requestedBy));
        return (
          <>
            <Card title="OKR close-out" description="Closing out a timeframe scores every goal in it as completed or missed, snapshots them and locks the period — after a goal administrator approves.">
              <Table head={["Timeframe", "Status", "Asked by", "Closed", "Summary"]} empty={!closeouts.length}>
                {closeouts.map((c) => { const s = c.summary as { goals?: number; completed?: number; missed?: number; averageProgress?: number } | null; return <tr key={c.id}><td>{c.timeframe}</td><td><Pill s={c.status} /></td><td className="text-sm">{names.get(c.requestedBy) ?? ""}</td><td>{fmtDate(c.closedAt)}</td><td className="text-sm">{s ? `${s.completed}/${s.goals} completed, ${s.missed} missed, avg ${s.averageProgress}%` : "—"}</td></tr>; })}
              </Table>
            </Card>
            {admin ? (
              <Card title="Close out a timeframe">
                <SpecForm action={requestCloseoutAction} columns={2} submitLabel="Submit for approval" fields={[
                  { name: "timeframe", label: "Timeframe", type: "select", options: tfs.map((t) => ({ value: t, label: t })), required: true },
                  { name: "note", label: "Note" },
                ]} />
              </Card>
            ) : null}
          </>
        );
      })() : null}
      {tab === "snapshots" ? await (async () => {
        const labels = await prisma.insightGoalSnapshot.groupBy({ by: ["label"], where: { tenantId: viewer.tenantId }, _count: true, _max: { takenAt: true }, orderBy: { _max: { takenAt: "desc" } } });
        const pick = sp.label ?? labels[0]?.label;
        const rows = pick ? await prisma.insightGoalSnapshot.findMany({ where: { tenantId: viewer.tenantId, label: pick, ...(admin ? {} : { goalId: { in: goals.map((g) => g.id) } }) }, orderBy: { title: "asc" } }) : [];
        return (
          <>
            <Card title="OKR history and snapshots" action={admin ? <ActButton action={snapshotGoalsAction} hidden={{}} label="Snapshot now" input={{ name: "label", placeholder: "Label (optional)" }} /> : null}>
              <div className="row gap-2 wrap" style={{ marginBottom: 10 }}>{labels.map((l) => <Link key={l.label} className={`btn sm${l.label === pick ? " primary" : ""}`} href={`/performance/okr?tab=snapshots&label=${encodeURIComponent(l.label)}`}>{l.label} ({l._count})</Link>)}</div>
              <Table head={["Objective", "Level", "Owner", "Progress", "Status", "Value / target"]} empty={!rows.length}>
                {rows.map((r) => <tr key={r.id}><td>{r.title}</td><td>{r.level.toLowerCase()}</td><td className="text-sm">{r.ownerName ?? "—"}</td><td className="num">{Number(r.progress)}%</td><td><Pill s={r.status} /></td><td className="num">{Number(r.currentValue)} / {Number(r.targetValue)}</td></tr>)}
              </Table>
            </Card>
          </>
        );
      })() : null}
      {tab === "settings" ? (
        admin ? (
          <Card title="OKR settings">
            <SpecForm action={saveOkrSettingAction} columns={3} fields={[
              { name: "requireApproval", label: "Goals need approval", type: "checkbox", defaultValue: setting?.requireApproval ?? false },
              { name: "defaultCadence", label: "Default check-in cadence", type: "select", options: cadenceOpts, defaultValue: setting?.defaultCadence ?? "MONTHLY", required: true },
              { name: "graceDays", label: "Grace days before overdue", type: "number", defaultValue: setting?.graceDays ?? 3 },
            ]} />
          </Card>
        ) : <Card><div className="muted">Only goal administrators change OKR settings.</div></Card>
      ) : null}
      {tab === "audit" ? (
        <>
          <Card title="OKR export package" description="Every objective and key result with targets, stretch, progress, confidence and cadence; check-ins separately."><div className="row gap-2"><span className="text-sm">Objectives:</span><ExportLinks ds="okr" /><span className="text-sm">Check-ins:</span><ExportLinks ds="okr-checkins" /></div></Card>
          {can(viewer, P.GOALS_MANAGE) || can(viewer, P.AUDIT_LOG_VIEW) ? <Card><InsightTableView table={await runDataset(viewer, "okr-audit")} ds="okr-audit" /></Card> : null}
        </>
      ) : null}
    </>
  );
}
