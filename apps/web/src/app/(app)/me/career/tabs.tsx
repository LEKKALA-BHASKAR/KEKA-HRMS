import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { internalEligibility, actionsProgress } from "@keka/services";
import type { Viewer } from "@/lib/context";
import { Badge, Callout } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { applyInternalAction, withdrawInternalApplicationAction, requestMobilityAction, withdrawMobilityAction } from "@/app/actions/mobility";
import { saveDevelopmentPlanAction, developmentPlanOpAction, saveDevelopmentActionAction, developmentActionStepAction, coachingPlanOpAction } from "@/app/actions/development";

const TONE: Record<string, "success" | "warning" | "neutral" | "danger" | "info"> = { APPROVED: "success", SELECTED: "success", ENDORSED: "info", SHORTLISTED: "info", PENDING_MANAGER: "warning", PENDING_HR: "warning", APPLIED: "warning", REJECTED: "danger", MANAGER_DECLINED: "danger", WITHDRAWN: "neutral", DRAFT: "neutral", SUBMITTED: "warning", COMPLETED: "success", CANCELLED: "neutral", OPEN: "neutral", IN_PROGRESS: "info", VERIFIED: "success", PROPOSED: "warning", ACTIVE: "info", DECLINED: "neutral" };
const tone = (s: string) => TONE[s] ?? "neutral";
const KINDS = ["COURSE", "MENTORING", "PROJECT", "READING", "PRACTICE", "OTHER"].map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() }));

/** Jobs open to internal applicants, whether I can apply, and my applications. */
export async function JobsTab({ viewer }: { viewer: Viewer }) {
  const myId = viewer.employee!.id;
  const [jobs, mine, me, onPip] = await Promise.all([
    prisma.job.findMany({ where: { tenantId: viewer.tenantId, allowInternal: true, status: "OPEN" }, orderBy: { title: "asc" } }),
    prisma.mobilityApplication.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { job: { select: { title: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.employee.findUniqueOrThrow({ where: { id: myId }, select: { dateOfJoining: true, status: true } }),
    prisma.improvementPlan.count({ where: { employeeId: myId, status: "ACTIVE" } }),
  ]);
  const [depts, locs] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true } }),
  ]);
  const name = new Map([...depts, ...locs].map((x) => [x.id, x.name]));
  const applied = new Map(mine.map((a) => [a.jobId, a]));
  return (
    <div className="stack gap-4">
      <Panel title={`Open internally (${jobs.length})`} subtitle="Your manager is told when you apply and endorses the application before HR reviews it" pad={false}>
        {jobs.length === 0 ? <EmptyState title="No jobs are open to internal applicants right now" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Job</th><th>Where</th><th>Closes</th><th /></tr></thead>
              <tbody>
                {jobs.map((j) => {
                  const a = applied.get(j.id);
                  const can = internalEligibility(j, { dateOfJoining: me.dateOfJoining, status: me.status, onActivePip: onPip > 0 });
                  return (
                    <tr key={j.id}>
                      <td><span className="strong">{j.title}</span>{j.description ? <div className="text-xs subtle">{j.description.slice(0, 160)}</div> : null}</td>
                      <td className="text-sm">{[name.get(j.departmentId ?? ""), name.get(j.locationId ?? "")].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="text-sm">{j.internalClosesAt ? formatDate(j.internalClosesAt) : "—"}</td>
                      <td className="right" style={{ minWidth: 220 }}>
                        {a && a.status !== "WITHDRAWN" ? <Badge tone={tone(a.status)} dot>{a.status.replace("_", " ").toLowerCase()}</Badge>
                          : can.ok ? <ActButton action={applyInternalAction} hidden={{ jobId: j.id }} label="Apply" variant="primary" input={{ name: "coverNote", placeholder: "Why you (optional)" }} />
                          : <span className="text-xs subtle">{can.message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="My applications" pad={false}>
        {mine.length === 0 ? <EmptyState title="You have not applied for an internal job" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Job</th><th>Applied</th><th>Status</th><th>Notes</th><th /></tr></thead>
              <tbody>
                {mine.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{a.job.title}</td>
                    <td className="text-sm">{formatDate(a.createdAt)}</td>
                    <td><Badge tone={tone(a.status)} dot>{a.status.replace("_", " ").toLowerCase()}</Badge></td>
                    <td className="text-sm">{[a.managerNote && `Manager: ${a.managerNote}`, a.hrNote && `HR: ${a.hrNote}`].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="right">{["APPLIED", "ENDORSED", "SHORTLISTED"].includes(a.status) ? <ActButton action={withdrawInternalApplicationAction} hidden={{ applicationId: a.id }} label="Withdraw" variant="ghost" /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Ask for a transfer or role change: manager, then HR; HR approval schedules the job change. */
export async function MovesTab({ viewer }: { viewer: Viewer }) {
  const myId = viewer.employee!.id;
  const [mine, depts, locs, titles] = await Promise.all([
    prisma.mobilityRequest.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, orderBy: { createdAt: "desc" } }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.jobTitle.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const name = new Map([...depts, ...locs, ...titles].map((x) => [x.id, x.name]));
  const open = mine.find((r) => ["PENDING_MANAGER", "PENDING_HR"].includes(r.status));
  return (
    <div className="stack gap-4">
      {open ? <Callout tone="info" title="You have a request in progress">Withdraw it to raise a different one.</Callout> : (
        <Panel title="Request a move" subtitle="Your manager endorses it first, then HR decides">
          <GrowthForm action={requestMobilityAction} submitLabel="Send request" fields={[
            { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "TRANSFER", label: "Transfer" }, { value: "ROLE_CHANGE", label: "Role change" }, { value: "RELOCATION", label: "Relocation" }], defaultValue: "TRANSFER" },
            { name: "toDepartmentId", label: "To department", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })) },
            { name: "toLocationId", label: "To location", type: "select", options: locs.map((d) => ({ value: d.id, label: d.name })) },
            { name: "toJobTitleId", label: "To role", type: "select", options: titles.map((d) => ({ value: d.id, label: d.name })) },
            { name: "preferredDate", label: "Preferred date", type: "date" },
            { name: "reason", label: "Why", type: "textarea", required: true },
          ]} />
        </Panel>
      )}
      <Panel title="My requests" pad={false}>
        {mine.length === 0 ? <EmptyState title="No move requests" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Raised</th><th>Move</th><th>Preferred</th><th>Status</th><th>Notes</th><th /></tr></thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm">{formatDate(r.createdAt)}</td>
                    <td className="text-sm">{r.kind.replace("_", " ").toLowerCase()}{[r.toDepartmentId, r.toLocationId, r.toJobTitleId].filter(Boolean).map((x) => ` → ${name.get(x!) ?? "?"}`).join("")}</td>
                    <td className="text-sm">{r.preferredDate ? formatDate(r.preferredDate) : "—"}</td>
                    <td><Badge tone={tone(r.status)} dot>{r.status === "PENDING_MANAGER" ? "with your manager" : r.status === "PENDING_HR" ? "with HR" : r.status.toLowerCase()}</Badge></td>
                    <td className="text-sm">{[r.managerNote && `Manager: ${r.managerNote}`, r.hrNote && `HR: ${r.hrNote}`].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="right">{["PENDING_MANAGER", "PENDING_HR"].includes(r.status) ? <ActButton action={withdrawMobilityAction} hidden={{ requestId: r.id }} label="Withdraw" variant="ghost" /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** My development plans and their actions, coaching I receive, and succession plans for my role. */
export async function DevelopmentTab({ viewer }: { viewer: Viewer }) {
  const myId = viewer.employee!.id;
  const [plans, loose, coaching, succession, courses, skills, steps] = await Promise.all([
    prisma.developmentPlan.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { actions: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } }),
    prisma.developmentAction.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId, planId: null, pipId: null }, orderBy: { createdAt: "desc" } }),
    prisma.coachingPlan.findMany({ where: { employeeId: myId, tenantId: viewer.tenantId }, include: { coach: { select: { displayName: true } }, sessions: { orderBy: { heldOn: "desc" } } }, orderBy: { createdAt: "desc" } }),
    prisma.successionPlan.findMany({ where: { incumbentId: myId, tenantId: viewer.tenantId }, select: { id: true, positionTitle: true, status: true } }),
    prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED" }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    prisma.skill.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE", isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.careerPathStep.findMany({ where: { path: { tenantId: viewer.tenantId, status: "APPROVED" } }, select: { id: true, title: true, path: { select: { name: true } } }, orderBy: [{ pathId: "asc" }, { sequence: "asc" }] }),
  ]);
  const ActionRow = ({ a }: { a: (typeof loose)[number] }) => (
    <div className="row gap-2 text-sm wrap" style={{ justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
      <span>{a.title} <span className="subtle">· {a.kind.toLowerCase()}{a.dueDate ? ` · by ${formatDate(a.dueDate)}` : ""}</span>{a.courseId ? <> · <Link href={`/learn/courses/${a.courseId}`}>course</Link></> : null}{a.verifierNote ? <div className="text-xs subtle">Reviewer: {a.verifierNote}</div> : null}</span>
      <span className="row gap-1">
        <Badge tone={tone(a.status)} dot>{a.status.replace("_", " ").toLowerCase()}</Badge>
        {a.status === "OPEN" ? <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "start" }} label="Start" /> : null}
        {["OPEN", "IN_PROGRESS"].includes(a.status) ? <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "submit" }} label="Mark done" variant="primary" input={{ name: "evidence", placeholder: "What you did / evidence", required: true }} /> : null}
      </span>
    </div>
  );
  return (
    <div className="stack gap-4">
      {coaching.some((c) => c.status === "PROPOSED") ? <Callout tone="info" title="Coaching proposed to you">Accept or decline it below.</Callout> : null}
      <Reveal label="+ New development plan">
        <Panel title="New development plan" subtitle="Draft it, add actions, then submit it to your manager">
          <GrowthForm action={saveDevelopmentPlanAction} submitLabel="Create" fields={[
            { name: "title", label: "Title", required: true },
            { name: "careerStepId", label: "Towards role", type: "select", options: steps.map((s) => ({ value: s.id, label: `${s.path.name} → ${s.title}` })) },
            { name: "startDate", label: "Start", type: "date", required: true },
            { name: "endDate", label: "End", type: "date", required: true },
            { name: "objective", label: "Objective", type: "textarea", required: true },
          ]} />
        </Panel>
      </Reveal>
      {plans.length === 0 ? <Panel><EmptyState title="No development plans yet" /></Panel> : plans.map((p) => (
        <Panel key={p.id} title={p.title} subtitle={`${formatDate(p.startDate)} – ${formatDate(p.endDate)} · ${actionsProgress(p.actions)}% of actions verified`} action={<span className="row gap-1 wrap">
          <Badge tone={tone(p.status)} dot>{p.status.toLowerCase()}</Badge>
          {["DRAFT", "REJECTED"].includes(p.status) ? <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "submit" }} label="Submit to manager" variant="primary" /> : null}
          {p.status === "APPROVED" ? <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "complete" }} label="Complete" /> : null}
          {p.status === "DRAFT" ? <ActButton action={developmentPlanOpAction} hidden={{ planId: p.id, op: "cancel" }} label="Discard" variant="ghost" /> : null}
        </span>}>
          <div className="text-sm muted" style={{ marginBottom: 6 }}>{p.objective}</div>
          {p.decisionNote ? <div className="text-sm" style={{ marginBottom: 6 }}>Manager: {p.decisionNote}</div> : null}
          {p.actions.map((a) => <ActionRow key={a.id} a={a} />)}
          {["DRAFT", "REJECTED", "APPROVED"].includes(p.status) ? (
            <Reveal label="+ Action">
              <GrowthForm action={saveDevelopmentActionAction} hidden={{ planId: p.id }} cols={3} compact submitLabel="Add" fields={[
                { name: "title", label: "Action", required: true },
                { name: "kind", label: "Kind", type: "select", required: true, options: KINDS, defaultValue: "COURSE" },
                { name: "courseId", label: "Course", type: "select", options: courses.map((c) => ({ value: c.id, label: c.title })) },
                { name: "skillId", label: "Skill it builds", type: "select", options: skills.map((s) => ({ value: s.id, label: s.name })) },
                { name: "dueDate", label: "By", type: "date" },
              ]} />
            </Reveal>
          ) : null}
        </Panel>
      ))}
      {loose.length ? (
        <>
          <SectionTitle sub="From coaching or skill gaps">Other development actions</SectionTitle>
          <Panel>{loose.map((a) => <ActionRow key={a.id} a={a} />)}</Panel>
        </>
      ) : null}
      <Reveal label="+ Action for a skill gap">
        <Panel title="Close a skill gap">
          <GrowthForm action={saveDevelopmentActionAction} cols={3} compact submitLabel="Add" fields={[
            { name: "skillId", label: "Skill", type: "select", required: true, options: skills.map((s) => ({ value: s.id, label: s.name })) },
            { name: "title", label: "Action", required: true },
            { name: "kind", label: "Kind", type: "select", required: true, options: KINDS, defaultValue: "PRACTICE" },
            { name: "courseId", label: "Course", type: "select", options: courses.map((c) => ({ value: c.id, label: c.title })) },
            { name: "dueDate", label: "By", type: "date" },
          ]} />
        </Panel>
      </Reveal>

      <SectionTitle>Coaching</SectionTitle>
      {coaching.length === 0 ? <Panel><EmptyState title="No coaching plans" /></Panel> : coaching.map((c) => (
        <Panel key={c.id} title={`${c.focusArea} — with ${c.coach.displayName}`} subtitle={`${formatDate(c.startDate)} – ${formatDate(c.endDate)} · ${c.sessions.length} sessions`} action={<span className="row gap-1 wrap">
          <Badge tone={tone(c.status)} dot>{c.status.toLowerCase()}</Badge>
          {c.status === "PROPOSED" ? <>
            <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "accept" }} label="Accept" variant="primary" />
            <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "decline" }} label="Decline" input={{ name: "note", placeholder: "Why", required: true }} />
          </> : null}
          {c.status === "ACTIVE" ? <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "complete" }} label="Complete" input={{ name: "effectivenessScore", placeholder: "Rate 1–5", type: "number", required: true }} /> : null}
          {c.status === "COMPLETED" && !c.effectivenessScore ? <ActButton action={coachingPlanOpAction} hidden={{ coachingPlanId: c.id, op: "rate" }} label="Rate" input={{ name: "effectivenessScore", placeholder: "1–5", type: "number", required: true }} /> : null}
        </span>}>
          <div className="text-sm muted">{c.goals}</div>
          {c.sessions.map((s) => <div key={s.id} className="text-sm" style={{ marginTop: 4 }}>{formatDate(s.heldOn)} · {s.progress.toLowerCase()} — {s.notes}</div>)}
          {c.effectivenessScore ? <div className="text-xs subtle" style={{ marginTop: 4 }}>You rated it {c.effectivenessScore}/5</div> : null}
        </Panel>
      ))}

      {succession.length ? (
        <>
          <SectionTitle sub="You can nominate who could step into your role">Succession for your role</SectionTitle>
          <Panel>{succession.map((s) => <div key={s.id} className="text-sm"><Link href={`/performance/succession/${s.id}`}>{s.positionTitle}</Link> <span className="subtle">· {s.status.toLowerCase()}</span></div>)}</Panel>
        </>
      ) : null}
    </div>
  );
}
