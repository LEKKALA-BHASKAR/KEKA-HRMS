import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { actionsProgress } from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Person, Stat } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { saveDevelopmentPlanAction, developmentPlanOpAction, saveDevelopmentActionAction, developmentActionStepAction, saveCoachingPlanAction, coachingPlanOpAction, logCoachingSessionAction } from "@/app/actions/development";

const P = PERMISSIONS;
const KINDS = ["COURSE", "MENTORING", "PROJECT", "READING", "PRACTICE", "OTHER"].map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() }));

/** The manager's (and HR's) side of development: plans to approve, actions to verify, coaching. */
export default async function DevelopmentPage() {
  const viewer = await requireViewer();
  const team = [...viewer.allReportIds];
  if (!team.length && !canAny(viewer, [P.CAREER_PATH_MANAGE, P.PIP_MANAGE, P.SKILL_MANAGE])) forbidden();
  const me = viewer.employee?.id ?? "__none__";
  const careers = can(viewer, P.CAREER_PATH_MANAGE);
  const pip = can(viewer, P.PIP_MANAGE);
  const who = { OR: [{ id: { in: team } }, ...(careers ? [scopedEmployeeWhere(viewer, P.CAREER_PATH_MANAGE)] : [])], NOT: { id: me } };
  const [plans, toVerify, coaching, people, courses, skills] = await Promise.all([
    prisma.developmentPlan.findMany({ where: { tenantId: viewer.tenantId, employee: who, status: { notIn: ["CANCELLED"] } }, include: { employee: { select: { displayName: true, employeeNumber: true } }, actions: true }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 }),
    prisma.developmentAction.findMany({ where: { tenantId: viewer.tenantId, status: "SUBMITTED", employeeId: { not: me }, OR: [{ employeeId: { in: team } }, { coachingPlan: { coachId: me } }, ...(careers ? [{ employee: scopedEmployeeWhere(viewer, P.CAREER_PATH_MANAGE) }] : []), ...(pip ? [{ pipId: { not: null }, employee: scopedEmployeeWhere(viewer, P.PIP_MANAGE) }] : [])] }, include: { employee: { select: { displayName: true } } }, orderBy: { updatedAt: "asc" } }),
    prisma.coachingPlan.findMany({ where: { tenantId: viewer.tenantId, OR: [{ coachId: me }, ...(pip ? [{ employee: scopedEmployeeWhere(viewer, P.PIP_MANAGE) }] : [])] }, include: { employee: { select: { displayName: true } }, coach: { select: { displayName: true } }, sessions: { orderBy: { heldOn: "desc" } }, actions: true }, orderBy: [{ status: "asc" }, { startDate: "desc" }] }),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] }, ...(pip || careers ? {} : { id: { in: team } }), NOT: { id: me } }, select: { id: true, displayName: true }, orderBy: { firstName: "asc" }, take: 2000 }),
    prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED" }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    prisma.skill.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE", isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const teamPeople = people.filter((p) => team.includes(p.id) || careers);
  const actionFields = (hidden: Record<string, string>) => ({ hidden, fields: [
    { name: "title", label: "Action", required: true },
    { name: "kind", label: "Kind", type: "select" as const, required: true, options: KINDS, defaultValue: "OTHER" },
    { name: "courseId", label: "Course (for a course action)", type: "select" as const, options: courses.map((c) => ({ value: c.id, label: c.title })) },
    { name: "skillId", label: "Skill it builds", type: "select" as const, options: skills.map((s) => ({ value: s.id, label: s.name })) },
    { name: "dueDate", label: "Due", type: "date" as const },
  ] });

  return (
    <>
      <PageHead title="Development & Coaching" subtitle="Individual development plans, actions to verify, and coaching" />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Plans to approve" value={plans.filter((p) => p.status === "SUBMITTED").length} />
        <Stat label="Actions to verify" value={toVerify.length} />
        <Stat label="Active coaching" value={coaching.filter((c) => c.status === "ACTIVE").length} />
        <Stat label="Approved plans" value={plans.filter((p) => p.status === "APPROVED").length} />
      </div>
      <div className="stack gap-4">
        <Panel title={`Actions to verify (${toVerify.length})`} pad={false}>
          {toVerify.length === 0 ? <EmptyState title="Nothing to verify" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Action</th><th>Evidence</th><th /></tr></thead>
                <tbody>
                  {toVerify.map((a) => (
                    <tr key={a.id}>
                      <td className="text-sm">{a.employee.displayName}</td>
                      <td className="text-sm">{a.title}<div className="text-xs subtle">{a.kind.toLowerCase()}{a.pipId ? " · improvement plan" : a.coachingPlanId ? " · coaching" : ""}</div></td>
                      <td className="text-sm">{a.evidence}</td>
                      <td className="right"><span className="row gap-1">
                        <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "verify" }} label="Verify" variant="primary" input={{ name: "note", placeholder: "Note (optional)" }} />
                        <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "return" }} label="Needs more" input={{ name: "note", placeholder: "What is missing?", required: true }} />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={`Development plans (${plans.length})`} subtitle="The employee drafts and submits; the manager approves" pad={false}>
          {plans.length === 0 ? <EmptyState title="No development plans in your team" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Plan</th><th>Period</th><th>Actions</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td><Person name={p.employee.displayName ?? ""} meta={p.employee.employeeNumber} /></td>
                      <td className="text-sm"><span className="strong">{p.title}</span><div className="text-xs subtle">{p.objective}</div>{p.actions.map((a) => <div key={a.id} className="text-xs">• {a.title} <span className="subtle">({a.status.toLowerCase().replace("_", " ")})</span></div>)}</td>
                      <td className="text-sm nowrap">{formatDate(p.startDate)} – {formatDate(p.endDate)}</td>
                      <td className="text-sm">{p.actions.length} · {actionsProgress(p.actions)}% verified</td>
                      <td><Badge tone={p.status === "APPROVED" ? "success" : p.status === "SUBMITTED" ? "warning" : p.status === "REJECTED" ? "danger" : "neutral"} dot>{p.status.toLowerCase()}</Badge></td>
                      <td className="right" style={{ minWidth: 220 }}>
                        <span className="row gap-1 wrap" style={{ justifyContent: "flex-end" }}>
                          {p.status === "SUBMITTED" ? <>
                            <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "approve" }} label="Approve" variant="primary" />
                            <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "reject" }} label="Send back" input={{ name: "note", placeholder: "What should change?", required: true }} />
                          </> : null}
                          {p.status === "APPROVED" ? <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "complete" }} label="Complete" /> : null}
                          {!["COMPLETED", "CANCELLED"].includes(p.status) ? <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "cancel" }} label="Cancel" variant="ghost" confirmText="Cancel this plan?" /> : null}
                        </span>
                        {["DRAFT", "REJECTED", "APPROVED"].includes(p.status) ? <Reveal label="+ Action"><GrowthForm action={saveDevelopmentActionAction} cols={2} compact submitLabel="Add" {...actionFields({ planId: p.id })} /></Reveal> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
            <Reveal label="+ Start a plan for someone in your team">
              <GrowthForm action={saveDevelopmentPlanAction} submitLabel="Create plan" fields={[
                { name: "employeeId", label: "Employee", type: "select", required: true, options: teamPeople.map((p) => ({ value: p.id, label: p.displayName ?? "" })) },
                { name: "title", label: "Title", required: true },
                { name: "startDate", label: "Start", type: "date", required: true },
                { name: "endDate", label: "End", type: "date", required: true },
                { name: "objective", label: "Objective", type: "textarea", required: true },
              ]} />
            </Reveal>
          </div>
        </Panel>

        <Panel title={`Coaching (${coaching.length})`} subtitle="The coach proposes; the coachee accepts, and rates the coaching at the end" pad={false}>
          {coaching.length === 0 ? <EmptyState title="No coaching plans" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Coachee</th><th>Coach</th><th>Focus</th><th>Sessions</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {coaching.map((c) => (
                    <tr key={c.id}>
                      <td className="text-sm">{c.employee.displayName}</td>
                      <td className="text-sm">{c.coach.displayName}</td>
                      <td className="text-sm"><span className="strong">{c.focusArea}</span><div className="text-xs subtle">{c.goals}</div>{c.employeeResponse ? <div className="text-xs">Coachee: {c.employeeResponse}</div> : null}</td>
                      <td className="text-sm">{c.sessions.length}{c.sessions[0] ? <div className="text-xs subtle">last {formatDate(c.sessions[0].heldOn)} ({c.sessions[0].progress.toLowerCase()})</div> : null}</td>
                      <td><Badge tone={c.status === "ACTIVE" ? "info" : c.status === "COMPLETED" ? "success" : c.status === "PROPOSED" ? "warning" : "neutral"} dot>{c.status.toLowerCase()}</Badge>{c.effectivenessScore ? <div className="text-xs subtle">rated {c.effectivenessScore}/5</div> : null}</td>
                      <td className="right" style={{ minWidth: 240 }}>
                        {c.status === "ACTIVE" && c.coachId === me ? (
                          <>
                            <Reveal label="Log session">
                              <GrowthForm action={logCoachingSessionAction} hidden={{ coachingPlanId: c.id }} cols={2} compact submitLabel="Log" fields={[
                                { name: "heldOn", label: "Date", type: "date", required: true },
                                { name: "progress", label: "Progress", type: "select", required: true, options: [{ value: "GOOD", label: "Good" }, { value: "STEADY", label: "Steady" }, { value: "CONCERN", label: "Concern" }], defaultValue: "STEADY" },
                                { name: "notes", label: "What was covered", type: "textarea", required: true },
                              ]} />
                            </Reveal>
                            <Reveal label="+ Action"><GrowthForm action={saveDevelopmentActionAction} cols={2} compact submitLabel="Add" {...actionFields({ coachingPlanId: c.id })} /></Reveal>
                            <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "complete" }} label="Complete" input={{ name: "note", placeholder: "Closing note" }} />
                          </>
                        ) : null}
                        {["PROPOSED", "ACTIVE"].includes(c.status) ? <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "cancel" }} label="Cancel" variant="ghost" confirmText="Cancel this coaching plan?" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
            <Reveal label="+ Propose coaching">
              <GrowthForm action={saveCoachingPlanAction} submitLabel="Propose" fields={[
                { name: "employeeId", label: "Coachee", type: "select", required: true, options: people.filter((p) => team.includes(p.id) || pip).map((p) => ({ value: p.id, label: p.displayName ?? "" })) },
                ...(pip ? [{ name: "coachId", label: "Coach (blank = you)", type: "select" as const, options: people.map((p) => ({ value: p.id, label: p.displayName ?? "" })) }] : []),
                { name: "focusArea", label: "Focus area", required: true },
                { name: "startDate", label: "Start", type: "date", required: true },
                { name: "endDate", label: "End", type: "date", required: true },
                { name: "goals", label: "Goals", type: "textarea", required: true },
              ]} />
            </Reveal>
          </div>
        </Panel>
      </div>
    </>
  );
}
