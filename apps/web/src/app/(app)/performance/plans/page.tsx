import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { pipRisk, actionsProgress } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { plansReport, PLAN_REPORTS, type PlanReportKind } from "@/lib/growth-reports";
import { PageHead, Badge, Person, Stat, Callout } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { ReportView } from "@/components/growth-report";
import { PipForm, ClosePip } from "../forms";
import { updatePipAction, respondPipAction, pipMilestoneAction, pipCheckInAction, decidePipOutcomeAction, saveDevelopmentActionAction, developmentActionStepAction } from "@/app/actions/development";

const P = PERMISSIONS;
const RISK_TONE: Record<string, "danger" | "warning" | "success"> = { HIGH: "danger", MEDIUM: "warning", LOW: "success" };
const KINDS = ["MENTORING", "COURSE", "PROJECT", "READING", "PRACTICE", "OTHER"].map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() }));

/** Performance › Improvement Plans. Without PIP rights, a person sees only their own plans. */
export default async function PlansPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; report?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const manage = can(viewer, P.PIP_MANAGE);
  const me = viewer.employee?.id ?? "__none__";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const status = sp.status === "CLOSED" ? "CLOSED" : sp.status === "ACTIVE" ? "ACTIVE" : undefined;
  const scope = manage ? scopedEmployeeWhere(viewer, P.PIP_MANAGE) : null;
  const plans = await prisma.improvementPlan.findMany({
    where: {
      tenantId: viewer.tenantId,
      ...(scope ? { OR: [{ employee: scope }, { employeeId: me }] } : { employeeId: me }),
      ...(status ? { status } : {}),
      ...(q ? { employee: { displayName: { contains: q, mode: "insensitive" } } } : {}),
    },
    include: { employee: { select: { displayName: true, employeeNumber: true } }, milestones: { orderBy: { dueDate: "asc" } }, checkIns: { orderBy: { heldOn: "desc" } }, actions: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ status: "asc" }, { endDate: "asc" }],
  });
  const employees = manage ? await prisma.employee.findMany({ where: { ...scope, status: { notIn: ["EXITED"] }, NOT: { id: me } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }) : [];
  const kind = (sp.report && sp.report in PLAN_REPORTS ? sp.report : "pips") as PlanReportKind;
  const report = manage ? await plansReport(viewer, kind) : null;
  const active = plans.filter((p) => p.status === "ACTIVE" && p.employeeId !== me);
  const riskOf = (p: (typeof plans)[number]) => pipRisk(p.checkIns, p.milestones.filter((m) => m.status === "MISSED").length);

  return (
    <>
      <PageHead title="Improvement Plans" subtitle="Plans that run for a fixed period, with milestones and check-ins, ending in a recorded decision" />
      {manage ? (
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <Stat label="Active plans" value={active.length} />
          <Stat label="High risk" value={active.filter((p) => riskOf(p) === "HIGH").length} tone={active.some((p) => riskOf(p) === "HIGH") ? "neg" : undefined} meta="Off track at the last two check-ins" />
          <Stat label="Past their end date" value={active.filter((p) => p.endDate.getTime() < Date.now()).length} meta="Waiting for a decision" />
          <Stat label="Outcomes to sign off" value={active.filter((p) => p.proposedOutcome && p.proposedBy !== viewer.user.id).length} />
        </div>
      ) : null}
      <div className="stack gap-4">
        {manage ? <Reveal label="+ Start an improvement plan"><Panel title="New plan" subtitle="A plan has a fixed end and must close as successful, extended, or unsuccessful — with the evidence recorded. An unsuccessful outcome needs a second PIP manager's sign-off."><PipForm employees={employees.map((e) => ({ value: e.id, label: e.displayName ?? "" }))} /></Panel></Reveal> : null}
        {manage ? (
          <form className="row gap-2 wrap">
            <input className="input" name="q" defaultValue={q} placeholder="Search by employee" style={{ maxWidth: 280 }} />
            <select className="select" name="status" defaultValue={status ?? ""} style={{ maxWidth: 160 }}><option value="">Any status</option><option value="ACTIVE">Active</option><option value="CLOSED">Closed</option></select>
            <button className="btn">Search</button>
          </form>
        ) : null}
        {plans.length === 0 ? <Panel><EmptyState title="No improvement plans" /></Panel> : plans.map((p) => {
          const own = p.employeeId === me;
          const mgr = manage && !own;
          const daysLeft = Math.ceil((p.endDate.getTime() - Date.now()) / 86_400_000);
          const risk = riskOf(p);
          return (
            <Panel key={p.id} title={<Person name={p.employee.displayName ?? ""} meta={`${p.employee.employeeNumber} · ${formatDate(p.startDate)} – ${formatDate(p.endDate)}`} />} action={<span className="row gap-1 wrap"><Link className="btn sm" href={`/performance/plans/${p.id}`}>Open plan</Link>
              {p.status === "ACTIVE" ? <Badge tone={daysLeft < 0 ? "danger" : "warning"} dot>{daysLeft >= 0 ? `active · ${daysLeft} days left` : `${-daysLeft} days past the end`}</Badge> : <Badge tone={p.outcome === "SUCCESSFUL" ? "success" : "danger"} dot>{(p.outcome ?? p.status).toLowerCase()}</Badge>}
              {p.status === "ACTIVE" ? <Badge tone={RISK_TONE[risk]}>risk {risk.toLowerCase()}</Badge> : null}
              {p.acknowledgedAt ? <Badge tone="info">acknowledged {formatDate(p.acknowledgedAt)}</Badge> : p.status === "ACTIVE" ? <Badge tone="neutral">not yet acknowledged</Badge> : null}
            </span>}>
              <div className="text-sm"><span className="strong">Why:</span> {p.reason}</div>
              <div className="text-sm muted" style={{ marginBottom: 8 }}><span className="strong">Objectives:</span> {p.objectives}</div>
              {p.employeeResponse ? <div className="text-sm" style={{ marginBottom: 8 }}><span className="strong">Employee response:</span> {p.employeeResponse}</div> : null}
              {p.outcomeNote && p.status !== "ACTIVE" ? <div className="text-sm subtle" style={{ marginBottom: 8 }}>Outcome: {p.outcomeNote}</div> : null}
              {p.proposedOutcome ? (
                <div style={{ marginBottom: 10 }}>
                  <Callout tone="warning" title={`Proposed outcome: ${p.proposedOutcome.toLowerCase()}`}>
                    {p.proposedNote} {mgr && p.proposedBy !== viewer.user.id ? (
                      <span className="row gap-1" style={{ marginTop: 6 }}>
                        <ActButton action={decidePipOutcomeAction} hidden={{ pipId: p.id, decision: "approve" }} label="Confirm outcome" variant="primary" input={{ name: "note", placeholder: "Note (optional)" }} />
                        <ActButton action={decidePipOutcomeAction} hidden={{ pipId: p.id, decision: "reject" }} label="Do not confirm" input={{ name: "note", placeholder: "Why", required: true }} />
                      </span>
                    ) : <span className="subtle"> Waiting for a second PIP manager.</span>}
                  </Callout>
                </div>
              ) : null}
              {own && p.status === "ACTIVE" && !p.acknowledgedAt ? (
                <div style={{ marginBottom: 10 }}>
                  <GrowthForm action={respondPipAction} hidden={{ pipId: p.id }} cols={1} compact submitLabel="Acknowledge the plan" fields={[{ name: "response", label: "Your response (optional) — it is kept on the plan", type: "textarea" }]} />
                </div>
              ) : null}

              <div className="grid grid-2" style={{ gap: 14 }}>
                <div>
                  <div className="strong text-sm" style={{ marginBottom: 4 }}>Milestones</div>
                  {p.milestones.length === 0 ? <div className="text-sm subtle">None yet.</div> : p.milestones.map((m) => (
                    <div key={m.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between", padding: "3px 0" }}>
                      <span>{m.title} <span className="subtle">· {formatDate(m.dueDate)}</span></span>
                      <span className="row gap-1">
                        <Badge tone={m.status === "MET" ? "success" : m.status === "MISSED" ? "danger" : "neutral"} dot>{m.status.toLowerCase()}</Badge>
                        {mgr && p.status === "ACTIVE" && m.status === "OPEN" ? <>
                          <ActButton action={pipMilestoneAction} hidden={{ milestoneId: m.id, op: "met" }} label="Met" />
                          <ActButton action={pipMilestoneAction} hidden={{ milestoneId: m.id, op: "missed" }} label="Missed" />
                        </> : null}
                      </span>
                    </div>
                  ))}
                  {mgr && p.status === "ACTIVE" ? <Reveal label="+ Milestone"><GrowthForm action={pipMilestoneAction} hidden={{ pipId: p.id, op: "add" }} cols={2} compact submitLabel="Add" fields={[{ name: "title", label: "Milestone", required: true }, { name: "dueDate", label: "By", type: "date", required: true }]} /></Reveal> : null}
                </div>
                <div>
                  <div className="strong text-sm" style={{ marginBottom: 4 }}>Check-ins</div>
                  {p.checkIns.length === 0 ? <div className="text-sm subtle">None yet.</div> : p.checkIns.map((c) => (
                    <div key={c.id} className="text-sm" style={{ padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                      <div className="row gap-2" style={{ justifyContent: "space-between" }}><span>{formatDate(c.heldOn)} · <Badge tone={c.progress === "ON_TRACK" ? "success" : c.progress === "AT_RISK" ? "warning" : "danger"}>{c.progress.replace("_", " ").toLowerCase()}</Badge></span>{c.acknowledgedAt ? <span className="text-xs subtle">acknowledged</span> : own ? <ActButton action={pipCheckInAction} hidden={{ checkInId: c.id, op: "ack" }} label="Acknowledge" input={{ name: "comment", placeholder: "Comment (optional)" }} /> : <span className="text-xs subtle">awaiting acknowledgement</span>}</div>
                      <div className="muted">{c.notes}</div>
                      {c.employeeComment ? <div className="text-xs">Employee: {c.employeeComment}</div> : null}
                    </div>
                  ))}
                  {mgr && p.status === "ACTIVE" ? <Reveal label="+ Check-in"><GrowthForm action={pipCheckInAction} hidden={{ pipId: p.id, op: "add" }} cols={2} compact submitLabel="Record" fields={[
                    { name: "heldOn", label: "Date", type: "date" },
                    { name: "progress", label: "Progress", type: "select", required: true, options: [{ value: "ON_TRACK", label: "On track" }, { value: "AT_RISK", label: "At risk" }, { value: "OFF_TRACK", label: "Off track" }] },
                    { name: "notes", label: "What was discussed", type: "textarea", required: true },
                  ]} /></Reveal> : null}
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="strong text-sm" style={{ marginBottom: 4 }}>Support actions {p.actions.length ? <span className="subtle">· {actionsProgress(p.actions)}% verified</span> : null}</div>
                {p.actions.map((a) => (
                  <div key={a.id} className="row gap-2 text-sm wrap" style={{ justifyContent: "space-between", padding: "3px 0" }}>
                    <span>{a.title} <span className="subtle">· {a.kind.toLowerCase()}{a.dueDate ? ` · by ${formatDate(a.dueDate)}` : ""}</span>{a.evidence ? <div className="text-xs subtle">Evidence: {a.evidence}</div> : null}</span>
                    <span className="row gap-1">
                      <Badge tone={a.status === "VERIFIED" ? "success" : a.status === "SUBMITTED" ? "warning" : "neutral"} dot>{a.status.replace("_", " ").toLowerCase()}</Badge>
                      {own && ["OPEN", "IN_PROGRESS"].includes(a.status) ? <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "submit" }} label="Mark done" input={{ name: "evidence", placeholder: "What was done", required: true }} /> : null}
                      {mgr && a.status === "SUBMITTED" ? <>
                        <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "verify" }} label="Verify" variant="primary" />
                        <ActButton action={developmentActionStepAction} hidden={{ actionId: a.id, op: "return" }} label="Needs more" input={{ name: "note", placeholder: "What is missing", required: true }} />
                      </> : null}
                    </span>
                  </div>
                ))}
                {mgr && p.status === "ACTIVE" ? <Reveal label="+ Support action"><GrowthForm action={saveDevelopmentActionAction} hidden={{ pipId: p.id }} cols={3} compact submitLabel="Add" fields={[{ name: "title", label: "Action", required: true }, { name: "kind", label: "Kind", type: "select", required: true, options: KINDS, defaultValue: "MENTORING" }, { name: "dueDate", label: "By", type: "date" }]} /></Reveal> : null}
              </div>

              {mgr && p.status === "ACTIVE" ? (
                <div className="row gap-2 wrap" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "flex-start" }}>
                  <Reveal label="Edit plan">
                    <GrowthForm action={updatePipAction} hidden={{ pipId: p.id }} cols={1} compact fields={[
                      { name: "reason", label: "Reason", type: "textarea", required: true, defaultValue: p.reason },
                      { name: "objectives", label: "Objectives", type: "textarea", required: true, defaultValue: p.objectives },
                      { name: "endDate", label: "End date", type: "date", defaultValue: p.endDate.toISOString().slice(0, 10) },
                    ]} />
                  </Reveal>
                  {!p.proposedOutcome ? <ClosePip id={p.id} /> : null}
                </div>
              ) : null}
            </Panel>
          );
        })}
      </div>
      {manage && report ? (
        <>
          <SectionTitle sub={<>Coaching and development actions are managed in <Link href="/performance/development">Development &amp; Coaching</Link></>}>Reports</SectionTitle>
          <ReportView report={report} base="/performance/plans" kinds={PLAN_REPORTS} kind={kind} exportHref={`/performance/plans/export?kind=${kind}`} />
        </>
      ) : null}
    </>
  );
}
