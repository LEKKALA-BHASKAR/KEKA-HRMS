import "server-only";
import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { pendingHireRequest, pendingHireRequests } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { rejectWithReasonAction, withdrawApplicationAction, requestStageMoveAction } from "@/app/actions/hire-ops";
import {
  rescheduleInterviewAction, markNoShowAction, cancelInterviewAction, completeInterviewAction, notifyCandidateAction, recordInterviewConsentAction,
  addPanelistAction, removePanelistAction, respondToPanelAction, requestScorecardReopenAction,
} from "@/app/actions/hire-interviews";
import { when, pretty } from "./depth-tabs";
import s from "../hire.module.css";

const P = PERMISSIONS;
const OPEN_APP = ["ACTIVE", "ON_HOLD", "OFFER_EXTENDED", "OFFER_ACCEPTED"];
const UPCOMING = ["SCHEDULED", "RESCHEDULED"];

/**
 * The recruiter's depth tools on a candidate's profile tab: close with a
 * reason from the library, record a withdrawal, ask for a gated stage move,
 * and per interview reschedule, no-show, cancel, mark held, consent to
 * record, send details in the candidate's time zone and manage the panel.
 */
export async function HireDepthPanel({ viewer, applicationId }: { viewer: Viewer; applicationId: string }) {
  const tenantId = viewer.tenantId;
  const app = await prisma.application.findFirst({
    where: { id: applicationId, tenantId },
    include: {
      job: { include: { flow: { include: { stages: { orderBy: { sequence: "asc" } } } } } },
      interviews: { include: { panel: { include: { employee: { select: { id: true, displayName: true } } } }, scorecards: true }, orderBy: { scheduledAt: "asc" } },
    },
  });
  if (!app) return null;
  const manageIv = can(viewer, P.INTERVIEW_MANAGE);
  const ivIds = app.interviews.map((i) => i.id);
  const [reasons, disposition, events, consents, stageMovePending, employees, reopenPending] = await Promise.all([
    prisma.dispositionReason.findMany({ where: { tenantId, isActive: true }, orderBy: [{ kind: "asc" }, { label: "asc" }] }),
    prisma.applicationDisposition.findUnique({ where: { applicationId: app.id } }),
    prisma.interviewEvent.findMany({ where: { tenantId, interviewId: { in: ivIds } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.interviewConsent.findMany({ where: { tenantId, interviewId: { in: ivIds } } }),
    pendingHireRequest(tenantId, "STAGE_MOVE", app.id),
    manageIv ? prisma.employee.findMany({ where: { tenantId, status: { in: ["CONFIRMED", "PROBATION", "NOTICE_PERIOD"] } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 500 }) : Promise.resolve([]),
    pendingHireRequests(tenantId, "SCORECARD_REOPEN", app.interviews.flatMap((i) => i.scorecards.map((sc) => sc.id))),
  ]);
  const scorers = await prisma.employee.findMany({ where: { tenantId, id: { in: app.interviews.flatMap((i) => i.scorecards.map((sc) => sc.panelistId)) } }, select: { id: true, displayName: true } });
  const scorerName = new Map(scorers.map((e) => [e.id, e.displayName]));
  const consentOf = new Map(consents.map((c) => [c.interviewId, c]));
  const titleOf = new Map(app.interviews.map((i) => [i.id, i.title]));
  const rejectOpts = reasons.filter((r) => r.kind === "REJECT").map((r) => ({ value: r.id, label: r.label }));
  const withdrawOpts = reasons.filter((r) => r.kind === "WITHDRAW").map((r) => ({ value: r.id, label: r.label }));
  const stages = (app.job.flow?.stages ?? []).filter((st) => st.id !== app.currentStageId);
  const open = OPEN_APP.includes(app.status);
  return (
    <div className={s.box} style={{ padding: 20 }} data-testid="hire-depth-panel">
      <div className={s.fbTitle} style={{ marginBottom: 10 }}>Pipeline actions</div>
      <div className="text-sm" style={{ marginBottom: 10 }}><Link href={`/hiring/candidates/${app.candidateId}`}>Full candidate history (all applications, messages, documents)</Link></div>
      {disposition ? <div className="text-sm" style={{ marginBottom: 10 }} data-testid="disposition">Closed — {pretty(disposition.kind)}: <strong>{disposition.label}</strong>{disposition.note ? ` (${disposition.note})` : ""} · by {disposition.byWhom.toLowerCase()} {when(disposition.createdAt)}</div> : null}
      {open ? (
        <div className="row gap-2 wrap" style={{ alignItems: "flex-start" }}>
          {stageMovePending ? <span className="text-sm subtle">A stage move is waiting for approval.</span> : stages.length ? (
            <Reveal label="Move stage (with checks)">
              <GrowthForm action={requestStageMoveAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Move" fields={[
                { name: "stageId", label: "To", type: "select", required: true, options: stages.map((st) => ({ value: st.id, label: st.name })) },
                { name: "note", label: "Note" },
              ]} />
            </Reveal>
          ) : null}
          <Reveal label="Reject with reason">
            {rejectOpts.length === 0 ? <div className="text-sm subtle">Add reasons in Hire › Settings › Operations.</div> : (
              <GrowthForm action={rejectWithReasonAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Reject" fields={[
                { name: "reasonId", label: "Reason", type: "select", required: true, options: rejectOpts },
                { name: "note", label: "Note" },
              ]} />
            )}
          </Reveal>
          <Reveal label="Candidate withdrew">
            <GrowthForm action={withdrawApplicationAction} hidden={{ applicationId: app.id }} cols={2} submitLabel="Mark withdrawn" fields={[
              withdrawOpts.length ? { name: "reasonId", label: "Reason", type: "select", options: withdrawOpts } : { name: "reason", label: "Reason", required: true },
              { name: "note", label: "Note" },
            ]} />
          </Reveal>
        </div>
      ) : null}
      {app.interviews.length ? <div className={s.blockLabel}>Interviews</div> : null}
      <div className="stack gap-3" data-testid="interview-actions">
        {app.interviews.map((iv) => {
          const upcoming = UPCOMING.includes(iv.status);
          const started = iv.scheduledAt.getTime() <= Date.now();
          const consent = consentOf.get(iv.id);
          return (
            <div key={iv.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div className="text-sm"><strong>{iv.title}</strong> · {when(iv.scheduledAt)} · {pretty(iv.status)}{consent ? ` · recording ${consent.status === "GRANTED" ? "allowed" : "declined"}` : ""}</div>
              <div className="text-xs muted">{iv.panel.map((p) => `${p.employee.displayName}${p.response !== "PENDING" ? ` (${p.response.toLowerCase()})` : ""}`).join(", ")}</div>
              {manageIv ? (
                <div className="row gap-2 wrap" style={{ marginTop: 6, alignItems: "flex-start" }}>
                  {upcoming ? (
                    <>
                      <Reveal label="Reschedule">
                        <GrowthForm action={rescheduleInterviewAction} hidden={{ interviewId: iv.id }} cols={2} submitLabel="Move" fields={[
                          { name: "date", label: "Date", type: "date", required: true }, { name: "time", label: "Time (HH:MM)", required: true, placeholder: "14:30" },
                          { name: "timeZone", label: "Time zone", defaultValue: "Asia/Kolkata" }, { name: "reason", label: "Why", required: true },
                        ]} />
                      </Reveal>
                      <ActButton action={notifyCandidateAction} hidden={{ interviewId: iv.id }} label="Send details to candidate" />
                      {started ? <ActButton action={completeInterviewAction} hidden={{ interviewId: iv.id }} label="Mark held" /> : null}
                      {started ? <ActButton action={markNoShowAction} hidden={{ interviewId: iv.id }} label="No-show" confirmText="Mark the candidate as a no-show?" input={{ name: "reason", placeholder: "Note (optional)" }} /> : null}
                      <ActButton action={cancelInterviewAction} hidden={{ interviewId: iv.id }} label="Cancel" variant="danger" confirmText="Cancel this interview?" input={{ name: "reason", placeholder: "Reason", required: true }} />
                      <Reveal label="Panel">
                        <div className="stack gap-2">
                          {iv.panel.map((p) => <div key={p.id} className="row gap-2 text-sm">{p.employee.displayName} <ActButton action={removePanelistAction} hidden={{ interviewId: iv.id, employeeId: p.employeeId, override: "on" }} label="Remove" confirmText={`Remove ${p.employee.displayName} from the panel?`} /></div>)}
                          <GrowthForm action={addPanelistAction} hidden={{ interviewId: iv.id }} cols={2} submitLabel="Add" fields={[
                            { name: "employeeId", label: "Add interviewer", type: "select", required: true, options: employees.filter((e) => !iv.panel.some((p) => p.employeeId === e.id)).map((e) => ({ value: e.id, label: e.displayName ?? e.id })) },
                          ]} />
                        </div>
                      </Reveal>
                    </>
                  ) : null}
                  {!consent ? (
                    <Reveal label="Recording consent">
                      <GrowthForm action={recordInterviewConsentAction} hidden={{ interviewId: iv.id }} cols={2} submitLabel="Record" fields={[
                        { name: "status", label: "Candidate", type: "select", options: [{ value: "GRANTED", label: "Agreed to recording" }, { value: "DECLINED", label: "Declined recording" }] },
                        { name: "method", label: "How (e.g. email reply)", required: true },
                      ]} />
                    </Reveal>
                  ) : null}
                </div>
              ) : null}
              {iv.scorecards.filter((sc) => sc.status === "SUBMITTED" && (manageIv || sc.panelistId === viewer.employee?.id)).map((sc) => (
                <div key={sc.id} className="text-xs" style={{ marginTop: 4 }}>
                  Feedback from {scorerName.get(sc.panelistId) ?? "an interviewer"}: {reopenPending.has(sc.id) ? "reopen waiting for approval" : <ActButton action={requestScorecardReopenAction} hidden={{ scorecardId: sc.id }} label="Ask to reopen" input={{ name: "reason", placeholder: "What needs amending", required: true }} />}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {events.length ? (
        <>
          <div className={s.blockLabel}>Interview changes</div>
          <ul className="text-xs" data-testid="interview-events" style={{ paddingLeft: 18 }}>
            {events.map((e) => <li key={e.id}>{when(e.createdAt)} · {titleOf.get(e.interviewId)} · {pretty(e.kind)}{e.toAt ? ` → ${when(e.toAt)}` : ""}{e.reason ? ` — ${e.reason}` : ""}</li>)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** For an interviewer on this candidate's panels: accept or decline each invitation. */
export async function PanelResponses({ viewer, applicationId }: { viewer: Viewer; applicationId: string }) {
  const me = viewer.employee?.id;
  if (!me) return null;
  const mine = await prisma.interviewPanelist.findMany({
    where: { employeeId: me, interview: { applicationId, application: { tenantId: viewer.tenantId }, status: { in: UPCOMING as ("SCHEDULED" | "RESCHEDULED")[] } } },
    include: { interview: { select: { id: true, title: true, scheduledAt: true } } },
  });
  if (!mine.length) return null;
  return (
    <div className={s.box} style={{ padding: 14, marginBottom: 14 }} data-testid="panel-responses">
      {mine.map((p) => (
        <div key={p.id} className="row gap-2 wrap text-sm" style={{ alignItems: "center" }}>
          <span>You are on the panel for <strong>{p.interview.title}</strong> at {when(p.interview.scheduledAt)} — {p.response === "PENDING" ? "please respond" : p.response.toLowerCase()}.</span>
          {p.response !== "ACCEPTED" ? <ActButton action={respondToPanelAction} hidden={{ interviewId: p.interview.id, response: "ACCEPTED" }} label="Accept" variant="primary" /> : null}
          {p.response !== "DECLINED" ? <ActButton action={respondToPanelAction} hidden={{ interviewId: p.interview.id, response: "DECLINED" }} label="Decline" input={{ name: "reason", placeholder: "Why", required: true }} /> : null}
        </div>
      ))}
    </div>
  );
}
