import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { onboardingScorecard, onboardingCohorts, onboardingDropOff, journeyProgress, onboardingPhase } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Stat, Progress, Badge } from "@/components/ui";
import { Tabs, Table } from "@/components/gov-ui";
import { ActButton } from "@/components/gov-forms";
import { fmtDay, pretty } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import { OnboardingNav } from "../_join/nav";
import { escalateJourneyTasksAction } from "@/app/actions/join-onboarding";

const P = PERMISSIONS;
const DAY = 86_400_000;
const TABS = { dayone: "Day one", firstweek: "First week", blockers: "Blockers", scorecard: "Manager scorecard", cohorts: "Cohorts & drop-off", reports: "Reports" };

/** Onboarding insights: day-one readiness, first-week tracking, blockers, the manager scorecard, cohorts and drop-off, and exports. */
export default async function OnboardingInsightsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.ONBOARDING_MANAGE);
  const { tab: raw } = await searchParams;
  const tab = raw && raw in TABS ? raw : "dayone";
  const scope = scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE);
  const today = new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");
  const journeys = await prisma.journey.findMany({
    where: { tenantId: viewer.tenantId, trigger: "JOINING", employee: scope },
    include: { tasks: true, employee: { select: { id: true, displayName: true, dateOfJoining: true, status: true, reportingManagerId: true, lastWorkingDay: true } } },
    orderBy: { anchorDate: "desc" },
  });
  const ppl = await peopleIndex(viewer.tenantId, journeys.flatMap((j) => [j.employeeId, j.employee.reportingManagerId, ...j.tasks.map((t) => t.assigneeEmployeeId)]));
  const active = journeys.filter((j) => j.status === "ACTIVE");
  return (
    <>
      <PageHead title="Onboarding insights" actions={<ActButton action={escalateJourneyTasksAction} hidden={{}} label="Escalate overdue tasks now" />} />
      <OnboardingNav viewer={viewer} active="insights" />
      <Tabs base="/onboarding/insights" tabs={TABS} active={tab} />
      {tab === "dayone" ? (() => {
        const soon = active.filter((j) => j.anchorDate.getTime() >= today.getTime() - DAY && j.anchorDate.getTime() <= today.getTime() + 7 * DAY);
        return (
          <Card tight title="Day-one readiness" description="Hires joining in the next week (and yesterday): tasks due by day one">
            <Table head={["Hire", "Joins", "Due by day one", "Open", "Ready"]} empty={!soon.length}>
              {soon.map((j) => {
                const due = j.tasks.filter((t) => t.dueDate <= j.anchorDate && t.isRequired);
                const open = due.filter((t) => t.status === "PENDING");
                const pct = due.length ? Math.round(((due.length - open.length) / due.length) * 100) : 100;
                return (
                  <tr key={j.id}>
                    <td className="text-sm"><Link href={`/onboarding/${j.id}`}><strong>{j.employee.displayName}</strong></Link></td>
                    <td className="text-sm">{fmtDay(j.anchorDate)}</td>
                    <td className="num">{due.length}</td>
                    <td className="text-xs">{open.map((t) => <div key={t.id}>{t.title} <span className="subtle">({t.owner.toLowerCase()}{t.assigneeEmployeeId ? `: ${ppl.name(t.assigneeEmployeeId)}` : ""})</span></div>)}</td>
                    <td style={{ minWidth: 120 }}><div className="text-xs strong">{pct}%</div><Progress value={pct} tone={pct === 100 ? "success" : "warning"} /></td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "firstweek" ? (() => {
        const recent = active.filter((j) => j.anchorDate <= today && j.anchorDate.getTime() >= today.getTime() - 14 * DAY);
        return (
          <Card tight title="First-week task tracking" description="Tasks from day one to day seven for hires who joined in the last two weeks">
            <Table head={["Hire", "Joined", "Day", "Task", "Owner", "Status"]} empty={!recent.length}>
              {recent.flatMap((j) => j.tasks.filter((t) => { const o = Math.round((t.dueDate.getTime() - j.anchorDate.getTime()) / DAY); return ["DAY_ONE", "FIRST_WEEK"].includes(onboardingPhase(o)); }).map((t) => (
                <tr key={t.id}>
                  <td className="text-sm">{j.employee.displayName}</td>
                  <td className="text-sm">{fmtDay(j.anchorDate)}</td>
                  <td className="num">+{Math.round((t.dueDate.getTime() - j.anchorDate.getTime()) / DAY)}</td>
                  <td className="text-sm">{t.title}</td>
                  <td className="text-xs">{t.owner.toLowerCase()}{t.assigneeEmployeeId ? ` · ${ppl.name(t.assigneeEmployeeId)}` : ""}</td>
                  <td>{t.status === "PENDING" && t.dueDate < today ? <Badge tone="danger">overdue</Badge> : <Badge tone={t.status === "DONE" ? "success" : "neutral"}>{t.status.toLowerCase()}</Badge>}</td>
                </tr>
              )))}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "blockers" ? (() => {
        const blockers = active.flatMap((j) => j.tasks.filter((t) => t.status === "PENDING" && t.dueDate < today && (t.isRequired || t.escalationLevel > 0)).map((t) => ({ j, t })))
          .sort((a, b) => b.t.escalationLevel - a.t.escalationLevel || a.t.dueDate.getTime() - b.t.dueDate.getTime());
        return (
          <Card tight title={`Onboarding blockers (${blockers.length})`} description="Required tasks past due. Escalation reminds the assignee, then the manager, then onboarding HR.">
            <Table head={["Hire", "Task", "Due", "Owner", "Escalation"]} empty={!blockers.length}>
              {blockers.map(({ j, t }) => (
                <tr key={t.id}>
                  <td className="text-sm"><Link href={`/onboarding/${j.id}`}>{j.employee.displayName}</Link></td>
                  <td className="text-sm">{t.title}{t.approvalStatus === "PENDING" ? <div className="text-xs subtle">awaiting sign-off</div> : null}</td>
                  <td className="text-sm neg">{fmtDay(t.dueDate)}<div className="text-xs">{Math.round((today.getTime() - t.dueDate.getTime()) / DAY)} day(s) late</div></td>
                  <td className="text-xs">{t.owner.toLowerCase()}{t.assigneeEmployeeId ? ` · ${ppl.name(t.assigneeEmployeeId)}` : ""}</td>
                  <td>{t.escalationLevel ? <Badge tone={t.escalationLevel >= 3 ? "danger" : "warning"}>level {t.escalationLevel}</Badge> : <span className="text-xs subtle">—</span>}</td>
                </tr>
              ))}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "scorecard" ? (() => {
        // Tasks owned by managers: their assignee, or the hire's reporting manager for MANAGER tasks.
        const rows = onboardingScorecard(journeys.flatMap((j) => j.tasks.filter((t) => t.owner === "MANAGER").map((t) => ({ ownerEmployeeId: t.assigneeEmployeeId ?? j.employee.reportingManagerId, status: t.status, dueDate: t.dueDate, completedAt: t.completedAt }))), today);
        const hiresBy = new Map<string, number>();
        for (const j of journeys) if (j.employee.reportingManagerId) hiresBy.set(j.employee.reportingManagerId, (hiresBy.get(j.employee.reportingManagerId) ?? 0) + 1);
        return (
          <Card tight title="Manager onboarding scorecard">
            <Table head={["Manager", "Hires", "Tasks", "Done", "On time", "Overdue"]} empty={!rows.length}>
              {rows.map((r) => (
                <tr key={r.ownerEmployeeId}>
                  <td className="text-sm"><strong>{ppl.name(r.ownerEmployeeId)}</strong></td>
                  <td className="num">{hiresBy.get(r.ownerEmployeeId) ?? 0}</td>
                  <td className="num">{r.owned}</td>
                  <td className="num">{r.done}</td>
                  <td className="num">{r.onTimePct}%</td>
                  <td className={`num ${r.overdue ? "neg strong" : ""}`}>{r.overdue}</td>
                </tr>
              ))}
            </Table>
          </Card>
        );
      })() : null}
      {tab === "cohorts" ? (() => {
        const cohorts = onboardingCohorts(journeys.map((j) => {
          const p = journeyProgress(j.tasks);
          const exited = j.employee.status === "EXITED" ? j.employee.lastWorkingDay : null;
          return { joined: j.anchorDate, status: j.status, journeyPct: p.pct, exitedOn: exited, daysToComplete: j.completedAt ? Math.round((j.completedAt.getTime() - j.anchorDate.getTime()) / DAY) : null };
        }));
        const drop = onboardingDropOff(journeys.map((j) => {
          const noShow = j.employee.status === "EXITED" && !!j.employee.lastWorkingDay && j.employee.lastWorkingDay.getTime() === j.employee.dateOfJoining.getTime();
          const joined = !noShow && j.employee.dateOfJoining <= today && j.employee.status !== "PREBOARDING";
          const end = j.employee.status === "EXITED" && j.employee.lastWorkingDay ? j.employee.lastWorkingDay : today;
          const tenure = Math.round((end.getTime() - j.employee.dateOfJoining.getTime()) / DAY);
          return { joined, noShow, exitedWithinDays: j.employee.status === "EXITED" && !noShow ? tenure : null, tenureDays: Math.round((today.getTime() - j.employee.dateOfJoining.getTime()) / DAY) };
        }));
        return (
          <div className="stack gap-4">
            <div className="grid grid-4">
              {drop.stages.map((s) => <Stat key={s.stage} label={s.stage} value={s.count} meta={"eligible" in s && s.eligible !== undefined ? `of ${s.eligible} eligible` : undefined} />)}
            </div>
            <Card tight title="Drop-off" description={`${drop.noShow} no-show(s) — ${drop.noShowPct}% of accepted offers`}>
              <Table head={["Stage", "People"]}>{drop.stages.map((s) => <tr key={s.stage}><td className="text-sm">{s.stage}</td><td className="num">{s.count}</td></tr>)}</Table>
            </Card>
            <Card tight title="By joining month">
              <Table head={["Cohort", "Hires", "Avg completion", "Completed", "Avg days to complete", "Exits ≤ 90 days", "90-day retention"]} empty={!cohorts.length}>
                {cohorts.map((c) => (
                  <tr key={c.cohort}><td className="text-sm strong">{c.cohort}</td><td className="num">{c.hires}</td><td className="num">{c.avgCompletion}%</td><td className="num">{c.completed}</td><td className="num">{c.avgDaysToComplete ?? "—"}</td><td className="num">{c.earlyExits}</td><td className="num">{c.retention90}%</td></tr>
                ))}
              </Table>
            </Card>
          </div>
        );
      })() : null}
      {tab === "reports" ? (
        <Card title="Reports and exports" description="CSV downloads; each export is recorded in the audit log.">
          <div className="stack gap-2">
            {[
              ["preboarding", "Preboarding tasks — every hire's tasks and status"],
              ["forms", "New-hire form submissions"],
              ["comms", "Pre-joining communications log"],
              ["journeys", "Onboarding journeys and new-hire tasks"],
              ["orientation", "Orientation sessions and attendance"],
              ["buddies", "Buddy assignments and check-ins"],
              ["milestones", "30/60/90-day milestones and feedback"],
              ["audit", "Onboarding audit package — every onboarding audit entry"],
            ].map(([k, label]) => <div key={k} className="row gap-2"><a className="btn sm" href={`/onboarding/export?kind=${k}`}>Download</a><span className="text-sm">{label}</span></div>)}
          </div>
        </Card>
      ) : null}
      <div className="text-xs subtle" style={{ marginTop: 8 }}>{pretty(tab)} · {active.length} active journey(s)</div>
    </>
  );
}
