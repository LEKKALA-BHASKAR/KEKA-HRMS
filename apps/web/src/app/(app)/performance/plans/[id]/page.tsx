import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { mergeTimeline, pipRisk, type TimelineEvent } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { reaches } from "@/lib/growth";
import { userNames, fmtDate } from "@/lib/governance";
import { PageHead, Card, Badge, Stat } from "@/components/ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { Table, Pill } from "@/components/gov-ui";
import { Timeline } from "@/components/timeline";
import {
  savePipObjectiveAction, addPipEvidenceAction, checklistItemAction, logBehaviourAction, requestPipChangeAction, editPipOutcomeAction,
} from "@/app/actions/insight-performance";

export const metadata = { title: "Improvement plan" };

/**
 * One improvement plan: weighted objectives, evidence (with file upload),
 * the completion checklist, behaviour observations, requests that go
 * through approval (extension, escalation, check-in sign-off), the outcome
 * record, and a timeline of everything that happened. The employee sees
 * their own plan read-only, without the behaviour log.
 */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const pip = await prisma.improvementPlan.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { employee: { select: { displayName: true, employeeNumber: true } }, milestones: { orderBy: { dueDate: "asc" } }, checkIns: { orderBy: { heldOn: "desc" } } } });
  if (!pip) notFound();
  const me = viewer.employee?.id;
  const manages = can(viewer, P.PIP_MANAGE) && (await reaches(viewer, pip.employeeId, P.PIP_MANAGE));
  const manager = pip.managerId === me || viewer.allReportIds.has(pip.employeeId);
  const self = pip.employeeId === me;
  if (!manages && !manager && !self) notFound();
  const staff = manages || manager;
  const live = pip.status === "ACTIVE";
  const [objectives, evidence, checklist, logs, requests] = await Promise.all([
    prisma.insightPipObjective.findMany({ where: { tenantId: viewer.tenantId, pipId: pip.id }, orderBy: { createdAt: "asc" } }),
    prisma.insightPipEvidence.findMany({ where: { tenantId: viewer.tenantId, pipId: pip.id }, orderBy: { createdAt: "desc" } }),
    prisma.insightPipChecklistItem.findMany({ where: { tenantId: viewer.tenantId, pipId: pip.id }, orderBy: { position: "asc" } }),
    staff ? prisma.insightBehaviorLog.findMany({ where: { tenantId: viewer.tenantId, pipId: pip.id }, orderBy: { observedOn: "desc" } }) : Promise.resolve([]),
    prisma.insightPipRequest.findMany({ where: { tenantId: viewer.tenantId, pipId: pip.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const names = await userNames(viewer.tenantId, [...evidence.map((e) => e.addedBy), ...requests.map((r) => r.requestedBy), ...checklist.map((c) => c.doneBy)].filter((x): x is string => !!x));
  const weight = objectives.reduce((a, o) => a + o.weight, 0);
  const met = objectives.filter((o) => o.status === "MET").reduce((a, o) => a + o.weight, 0);
  const events: TimelineEvent[] = mergeTimeline(
    [{ at: pip.startDate, kind: "Plan", title: "Plan started", detail: pip.reason }],
    pip.milestones.map((m) => ({ at: m.completedAt ?? m.dueDate, kind: "Milestone", title: `${m.title}: ${m.status.toLowerCase()}`, detail: m.note })),
    pip.checkIns.map((c) => ({ at: c.heldOn, kind: "Check-in", title: c.progress.toLowerCase().replace("_", " "), detail: c.notes.slice(0, 200) })),
    evidence.map((e) => ({ at: e.createdAt, kind: "Evidence", title: e.title, detail: e.note })),
    logs.map((l) => ({ at: l.observedOn, kind: "Behaviour", title: `${l.behaviour}: ${l.rating}/5`, detail: l.note })),
    requests.map((r) => ({ at: r.createdAt, kind: "Request", title: `${r.kind.toLowerCase().replace("_", " ")}${r.days ? ` (${r.days} days)` : ""}: ${r.status.toLowerCase()}`, detail: r.reason })),
    pip.decidedAt ? [{ at: pip.decidedAt, kind: "Outcome", title: String(pip.outcome ?? "").toLowerCase(), detail: pip.outcomeNote }] : [],
  );
  return (
    <>
      <PageHead title={`Improvement plan: ${pip.employee.displayName}`} subtitle={`${fmtDate(pip.startDate)} – ${fmtDate(pip.endDate)} · ${pip.employee.employeeNumber}`} actions={<Link className="btn sm" href="/performance/plans">All plans</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Status" value={<Pill s={pip.status} />} meta={pip.outcome ? `Outcome: ${pip.outcome.toLowerCase()}` : pip.proposedOutcome ? `Proposed: ${pip.proposedOutcome.toLowerCase()}` : undefined} />
        <Stat label="Objectives met (weighted)" value={weight ? `${Math.round((met / weight) * 100)}%` : "—"} meta={`${objectives.filter((o) => o.status === "MET").length} of ${objectives.length}`} />
        <Stat label="Checklist" value={`${checklist.filter((c) => c.doneAt).length}/${checklist.length}`} meta={`${checklist.filter((c) => c.required && !c.doneAt).length} required open`} />
        <Stat label="Risk" value={live ? pipRisk(pip.checkIns, pip.milestones.filter((m) => m.status === "MISSED").length) : "—"} />
      </div>
      <Card title="Reason and objectives"><p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{pip.reason}</p></Card>

      <Card title="Objectives" description="Weighted, measurable objectives; each is marked met or not met before the plan closes.">
        <Table head={["Objective", "Measure", "Target", "Weight", "Status", ""]} empty={!objectives.length}>
          {objectives.map((o) => (
            <tr key={o.id}><td>{o.title}{o.note ? <div className="text-xs muted">{o.note}</div> : null}</td><td className="text-sm">{o.measure ?? "—"}</td><td className="text-sm">{o.target ?? "—"}</td><td className="num">{o.weight}</td><td><Pill s={o.status} /></td>
              <td>{staff && live ? <span className="row gap-2">{o.status !== "MET" ? <ActButton action={savePipObjectiveAction} hidden={{ id: o.id, status: "MET" }} label="Met" /> : null}{o.status !== "NOT_MET" ? <ActButton action={savePipObjectiveAction} hidden={{ id: o.id, status: "NOT_MET" }} label="Not met" variant="ghost" /> : null}{o.status !== "OPEN" ? <ActButton action={savePipObjectiveAction} hidden={{ id: o.id, status: "OPEN" }} label="Reopen" variant="ghost" /> : null}</span> : null}</td></tr>
          ))}
        </Table>
        {staff && live ? <div style={{ marginTop: 12 }}><SpecForm action={savePipObjectiveAction} hidden={{ pipId: pip.id }} columns={2} submitLabel="Add objective" fields={[
          { name: "title", label: "Objective", required: true }, { name: "measure", label: "How it is measured" }, { name: "target", label: "Target" }, { name: "weight", label: "Weight", type: "number", defaultValue: 1 },
        ]} /></div> : null}
      </Card>

      <div className="grid grid-2">
        <Card title="Completion checklist" description="Required items must be done before the plan closes as successful or unsuccessful.">
          <Table head={["Item", "Done", ""]} empty={!checklist.length}>
            {checklist.map((c) => (
              <tr key={c.id}><td>{c.label}{c.required ? null : <span className="muted text-xs"> (optional)</span>}{c.note ? <div className="text-xs muted">{c.note}</div> : null}</td><td className="text-sm">{c.doneAt ? `${fmtDate(c.doneAt)} · ${names.get(c.doneBy ?? "") ?? ""}` : "—"}</td>
                <td>{staff ? (c.doneAt ? <ActButton action={checklistItemAction} hidden={{ id: c.id, op: "undo" }} label="Undo" variant="ghost" /> : <ActButton action={checklistItemAction} hidden={{ id: c.id, op: "done" }} label="Done" input={{ name: "note", placeholder: "Note (optional)" }} />) : null}</td></tr>
            ))}
          </Table>
          {staff && live ? <div style={{ marginTop: 12 }}><SpecForm action={checklistItemAction} hidden={{ pipId: pip.id, op: "add" }} columns={2} submitLabel="Add item" fields={[{ name: "label", label: "Item", required: true }, { name: "optional", label: "Optional", type: "checkbox" }]} /></div> : null}
        </Card>
        <Card title="Evidence" description="Documents and observations behind the plan's decisions. Files are stored with a checksum.">
          <Table head={["Evidence", "Kind", "Added", "File"]} empty={!evidence.length}>
            {evidence.map((e) => <tr key={e.id}><td>{e.title}{e.note ? <div className="text-xs muted">{e.note}</div> : null}</td><td>{e.kind.toLowerCase()}</td><td className="text-sm">{fmtDate(e.createdAt)} · {names.get(e.addedBy ?? "") ?? ""}</td><td>{e.fileId ? <a href={`/files/${e.fileId}`}>Download</a> : "—"}</td></tr>)}
          </Table>
          {staff ? <div style={{ marginTop: 12 }}><SpecForm action={addPipEvidenceAction} hidden={{ pipId: pip.id }} columns={2} submitLabel="Add evidence" fields={[
            { name: "title", label: "Title", required: true },
            { name: "kind", label: "Kind", type: "select", options: ["DOCUMENT", "OBSERVATION", "EMAIL", "METRIC"].map((k) => ({ value: k, label: k.toLowerCase() })) },
            { name: "file", label: "File", type: "file" }, { name: "note", label: "Note", type: "textarea" },
          ]} /></div> : null}
        </Card>
      </div>

      {staff ? (
        <Card title="Behaviour observations" description="Specific behaviours, rated 1–5, logged as they are seen.">
          <Table head={["Observed", "Behaviour", "Rating", "Note"]} empty={!logs.length}>
            {logs.map((l) => <tr key={l.id}><td>{fmtDate(l.observedOn)}</td><td>{l.behaviour}</td><td><Badge tone={l.rating >= 4 ? "success" : l.rating <= 2 ? "danger" : "warning"}>{l.rating}/5</Badge></td><td className="text-sm">{l.note}</td></tr>)}
          </Table>
          {live ? <div style={{ marginTop: 12 }}><SpecForm action={logBehaviourAction} hidden={{ pipId: pip.id }} columns={2} submitLabel="Log" fields={[
            { name: "behaviour", label: "Behaviour", required: true }, { name: "rating", label: "Rating (1–5)", type: "number", required: true },
            { name: "observedOn", label: "Observed on", type: "date" }, { name: "note", label: "Note" },
          ]} /></div> : null}
        </Card>
      ) : null}

      {staff ? (
        <Card title="Requests" description="Extensions, escalation to HR, and HR sign-off of a check-in go through approval (Inbox › Approvals).">
          <Table head={["Asked", "Request", "Reason", "By", "Status"]} empty={!requests.length}>
            {requests.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{r.kind.toLowerCase().replace("_", " ")}{r.days ? ` · ${r.days} days` : ""}</td><td className="text-sm">{r.reason}</td><td className="text-sm">{names.get(r.requestedBy) ?? ""}</td><td><Pill s={r.status} /></td></tr>)}
          </Table>
          {live ? <div style={{ marginTop: 12 }}><SpecForm action={requestPipChangeAction} hidden={{ pipId: pip.id }} columns={2} submitLabel="Submit for approval" fields={[
            { name: "kind", label: "Request", type: "select", required: true, options: [{ value: "EXTENSION", label: "Extend the plan" }, { value: "ESCALATION", label: "Escalate to HR" }, { value: "CHECKIN_SIGNOFF", label: "HR sign-off of a check-in" }] },
            { name: "days", label: "Extra days (extension)", type: "number" },
            { name: "checkInId", label: "Check-in (sign-off)", type: "select", options: pip.checkIns.filter((c) => !c.signoffStatus || c.signoffStatus === "REJECTED").map((c) => ({ value: c.id, label: `${fmtDate(c.heldOn)} · ${c.progress.toLowerCase()}` })) },
            { name: "reason", label: "Reason", type: "textarea", required: true },
          ]} /></div> : null}
        </Card>
      ) : null}

      <Card title="Check-ins">
        <Table head={["Held", "Progress", "Notes", "Acknowledged", "HR sign-off"]} empty={!pip.checkIns.length}>
          {pip.checkIns.map((c) => <tr key={c.id}><td>{fmtDate(c.heldOn)}</td><td><Pill s={c.progress} /></td><td className="text-sm">{c.notes}</td><td>{fmtDate(c.acknowledgedAt)}</td><td>{c.signoffStatus ? <Pill s={c.signoffStatus} /> : "—"}</td></tr>)}
        </Table>
      </Card>

      {manages && (pip.proposedOutcome || pip.status === "CLOSED") ? (
        <Card title="Outcome record" description={pip.proposedOutcome ? "Amend your proposal before it is signed off." : "Corrections to a closed plan's outcome note are audited with the reason."}>
          <SpecForm action={editPipOutcomeAction} hidden={{ pipId: pip.id }} columns={1} submitLabel="Save outcome note" fields={[
            { name: "note", label: "Outcome note", type: "textarea", required: true, defaultValue: pip.proposedNote ?? pip.outcomeNote ?? "" },
            ...(pip.proposedOutcome ? [] : [{ name: "reason", label: "Why the record changes", required: true }]),
          ]} />
        </Card>
      ) : null}

      <Card title="Timeline"><Timeline events={events} /></Card>
    </>
  );
}
