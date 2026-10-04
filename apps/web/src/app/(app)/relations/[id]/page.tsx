import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  erCaseFor, erRef, erCanMove, ER_KINDS, ER_CATEGORIES, ER_STATUSES, ER_OUTCOMES, ER_ACTION_TYPES, INVESTIGATION_CONCLUSIONS, disciplinaryLadder,
} from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { userOptions, userNames, employeeOptions, fmtDate, fmtWhen } from "@/lib/governance";
import { PageHead, Card, KeyValue, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import {
  erAccessAction, erNoteAction, erMoveAction, startInvestigationAction, investigationTaskAction, witnessAction, evidenceAction, submitFindingsAction,
  scheduleHearingAction, recordHearingAction, proposeActionAction, revokeActionAction, takeUpAppealAction, decideAppealAction, proposeResolutionAction, closeErCaseAction,
} from "@/app/actions/relations";

export const metadata = { title: "Employee Relations case" };
const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));

export default async function ErCasePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const canManage = can(viewer, PERMISSIONS.ER_CASE_MANAGE), canApprove = can(viewer, PERMISSIONS.ER_CASE_APPROVE);
  const found = await erCaseFor({ tenantId: viewer.tenantId, userId: viewer.user.id, employeeId: viewer.employee?.id ?? null, canManage, canApprove }, id);
  // Not found rather than forbidden: a case's existence is itself confidential.
  if (!found) notFound();
  const hr = canManage || canApprove;
  const t = viewer.tenantId;
  const c = await prisma.erCase.findUniqueOrThrow({
    where: { id: found.id },
    include: {
      access: true, notes: { orderBy: { createdAt: "asc" } }, investigation: { include: { tasks: { orderBy: { sortOrder: "asc" } } } },
      witnesses: { orderBy: { createdAt: "asc" } }, evidence: { orderBy: { createdAt: "asc" } }, hearings: { orderBy: { scheduledAt: "asc" } },
      actions: { orderBy: { createdAt: "asc" } }, appeals: { orderBy: { filedAt: "asc" } },
    },
  });
  const [users, emps, letters, names, people, history] = await Promise.all([
    userOptions(t), employeeOptions(t),
    prisma.documentTemplate.findMany({ where: { tenantId: t, isArchived: false, approvalStatus: "APPROVED" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    userNames(t, [c.ownerUserId, ...c.access.map((a) => a.userId), c.investigation?.investigatorUserId, ...c.hearings.flatMap((h) => (Array.isArray(h.panelUserIds) ? h.panelUserIds.map(String) : []))]),
    prisma.employee.findMany({ where: { tenantId: t, id: { in: [c.subjectEmployeeId, c.reporterEmployeeId, ...c.witnesses.map((w) => w.employeeId)].filter((x): x is string => !!x) } }, select: { id: true, displayName: true, employeeNumber: true } }),
    c.subjectEmployeeId ? prisma.erAction.findMany({ where: { tenantId: t, employeeId: c.subjectEmployeeId }, select: { actionType: true, status: true, effectiveOn: true, expiresOn: true, caseId: true } }) : Promise.resolve([]),
  ]);
  const person = new Map(people.map((p) => [p.id, `${p.displayName} (${p.employeeNumber})`]));
  const moves = Object.keys(ER_STATUSES).filter((s) => erCanMove(c.status, s) && !["ACTION_TAKEN", "RESOLVED", "CLOSED", "APPEALED"].includes(s));
  const inv = c.investigation;
  const isInvestigator = inv?.investigatorUserId === viewer.user.id;
  const priorWarnings = history.filter((h) => h.caseId !== c.id && (h.status === "ISSUED" || h.status === "APPROVED"));
  const finalCheck = disciplinaryLadder(history, "FINAL_WARNING", new Date()), termCheck = disciplinaryLadder(history, "TERMINATION", new Date());
  const closed = c.status === "CLOSED";
  return (
    <>
      <PageHead title={<>{erRef(c.number)} · {c.title}</>} subtitle={<>{ER_KINDS[c.kind as keyof typeof ER_KINDS]} · {ER_CATEGORIES[c.category as keyof typeof ER_CATEGORIES]} · opened {fmtDate(c.createdAt)}</>}
        actions={<><Pill s={c.severity} /><Pill s={c.status} />{c.isConfidential ? <span className="badge danger">confidential</span> : null}<Link className="btn" href="/relations">All cases</Link></>} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Case">
            <KeyValue items={[
              ["About", c.subjectEmployeeId ? person.get(c.subjectEmployeeId) : null],
              ["Raised by", c.isAnonymous ? "Anonymous reporter (tracking code)" : c.reporterEmployeeId ? person.get(c.reporterEmployeeId) : "HR"],
              ["Incident", c.incidentDate ? `${fmtDate(c.incidentDate)}${c.incidentLocation ? ` at ${c.incidentLocation}` : ""}` : null],
              ["Owner", c.ownerUserId ? names.get(c.ownerUserId) : null],
              ["Outcome", c.outcome ? `${ER_OUTCOMES[c.outcome as keyof typeof ER_OUTCOMES]} (${c.resolutionStatus.toLowerCase()})` : c.resolutionStatus === "PENDING" ? "Awaiting approval" : null],
              ["Retained until", c.retainUntil ? fmtDate(c.retainUntil) : null],
            ]} />
            <p className="text-sm" style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{c.description}</p>
            {hr && moves.length && !closed ? (
              <div style={{ marginTop: 12 }}>
                <SpecForm action={erMoveAction} hidden={{ caseId: c.id }} submitLabel="Move" columns={2} fields={[
                  { name: "to", label: "Move to", type: "select", options: moves.map((m) => ({ value: m, label: ER_STATUSES[m as keyof typeof ER_STATUSES] })), required: true },
                  { name: "note", label: "Note" },
                ]} />
              </div>
            ) : null}
          </Card>

          <Card title="Timeline" description="Notes are internal. Tick “to the reporter” to answer the person who raised it (an anonymous reporter reads it with their code).">
            <div className="stack gap-2">
              {c.notes.map((n) => (
                <div key={n.id} className="text-sm" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 8 }}>
                  <div className="muted text-xs">{fmtWhen(n.createdAt)} · {n.authorLabel} · {n.kind.toLowerCase()}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
                </div>
              ))}
            </div>
            {!closed ? <div style={{ marginTop: 12 }}><SpecForm action={erNoteAction} hidden={{ caseId: c.id }} submitLabel="Add" columns={1} fields={[{ name: "body", label: "Note", type: "textarea", required: true }, { name: "toReporter", label: "Send", type: "checkbox", placeholder: "To the reporter (visible to them)" }]} /></div> : null}
          </Card>

          <Card title="Investigation">
            {inv ? (
              <>
                <KeyValue items={[["Investigator", names.get(inv.investigatorUserId)], ["Scope", inv.scope], ["Due", fmtDate(inv.dueOn)], ["Status", <Pill key="s" s={inv.status} />], ["Conclusion", inv.conclusion ? INVESTIGATION_CONCLUSIONS[inv.conclusion as keyof typeof INVESTIGATION_CONCLUSIONS] : null]]} />
                {inv.findings ? <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}><strong>Findings:</strong> {inv.findings}{inv.recommendation ? <><br /><strong>Recommendation:</strong> {inv.recommendation}</> : null}</p> : null}
                <Table head={["Step", "Due", "Done", ""]} empty={!inv.tasks.length}>
                  {inv.tasks.map((k) => <tr key={k.id}><td>{k.title}</td><td>{fmtDate(k.dueOn)}</td><td>{fmtDate(k.doneAt)}</td><td>{inv.status === "OPEN" || inv.status === "RETURNED" ? <ActButton action={investigationTaskAction} hidden={{ taskId: k.id }} label={k.doneAt ? "Reopen" : "Done"} /> : null}</td></tr>)}
                </Table>
                {inv.status === "OPEN" || inv.status === "RETURNED" ? (
                  <div className="stack gap-2" style={{ marginTop: 12 }}>
                    <SpecForm action={investigationTaskAction} hidden={{ caseId: c.id }} submitLabel="Add step" fields={[{ name: "title", label: "Step", required: true }, { name: "dueOn", label: "Due", type: "date" }]} />
                    {isInvestigator ? (
                      <SpecForm action={submitFindingsAction} hidden={{ caseId: c.id }} submitLabel="Submit findings for sign-off" columns={1} fields={[
                        { name: "conclusion", label: "Conclusion", type: "select", options: opts(INVESTIGATION_CONCLUSIONS), required: true },
                        { name: "findings", label: "Findings", type: "textarea", required: true },
                        { name: "recommendation", label: "Recommendation", type: "textarea" },
                      ]} />
                    ) : <Callout>Only the investigator submits the findings; every step must be done first.</Callout>}
                  </div>
                ) : null}
              </>
            ) : hr && !closed ? (
              <SpecForm action={startInvestigationAction} hidden={{ caseId: c.id }} submitLabel="Open investigation" fields={[
                { name: "investigatorUserId", label: "Investigator", type: "select", options: users, required: true, hint: "Cannot be a party to the case. They are added to the access list." },
                { name: "dueOn", label: "Due by", type: "date" },
                { name: "scope", label: "Scope", type: "textarea", wide: true },
              ]} />
            ) : <div className="muted text-sm">No investigation.</div>}
          </Card>

          <Card title="Witnesses">
            <Table head={["Witness", "Interviewed", "Statement"]} empty={!c.witnesses.length}>
              {c.witnesses.map((w) => (
                <tr key={w.id}><td>{w.employeeId ? person.get(w.employeeId) ?? w.name : w.name}{w.contact ? <div className="muted text-xs">{w.contact}</div> : null}</td><td>{fmtDate(w.interviewedOn)}</td>
                  <td className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{w.statement ?? (!closed ? <SpecForm action={witnessAction} hidden={{ witnessId: w.id }} submitLabel="Record" columns={1} fields={[{ name: "statement", label: "Statement", type: "textarea", required: true }, { name: "interviewedOn", label: "Interviewed on", type: "date" }]} /> : "—")}</td></tr>
              ))}
            </Table>
            {!closed ? <div style={{ marginTop: 12 }}><SpecForm action={witnessAction} hidden={{ caseId: c.id }} submitLabel="Add witness" fields={[{ name: "employeeId", label: "Employee", type: "select", options: emps }, { name: "name", label: "Or name (outside party)" }, { name: "contact", label: "Contact" }, { name: "interviewedOn", label: "Interviewed on", type: "date" }, { name: "statement", label: "Statement", type: "textarea", wide: true }]} /></div> : null}
          </Card>

          <Card title="Evidence" description="Files are fingerprinted (SHA-256) when added and served only to people who can open this case.">
            <Table head={["Item", "Collected", "File"]} empty={!c.evidence.length}>
              {c.evidence.map((e) => <tr key={e.id}><td>{e.title}{e.description ? <div className="muted text-xs">{e.description}</div> : null}</td><td>{fmtDate(e.collectedOn)}</td><td>{e.fileId ? <a href={`/files/${e.fileId}`}>Download</a> : "—"}{e.sha256 ? <div className="muted text-xs">SHA-256 {e.sha256.slice(0, 16)}…</div> : null}</td></tr>)}
            </Table>
            {!closed ? <div style={{ marginTop: 12 }}><SpecForm action={evidenceAction} hidden={{ caseId: c.id }} submitLabel="Add evidence" fields={[{ name: "title", label: "Title", required: true }, { name: "collectedOn", label: "Collected on", type: "date" }, { name: "file", label: "File (PDF, PNG, JPEG)", type: "file" }, { name: "description", label: "Description", type: "textarea", wide: true }]} /></div> : null}
          </Card>
        </div>

        <div className="stack gap-4">
          <Card title="Hearings">
            <Table head={["When", "Where", "Panel", "Status", ""]} empty={!c.hearings.length}>
              {c.hearings.map((h) => (
                <tr key={h.id}><td>{fmtWhen(h.scheduledAt)}</td><td>{h.location ?? "—"}</td><td className="text-sm">{(Array.isArray(h.panelUserIds) ? h.panelUserIds.map(String) : []).map((u) => names.get(u)).join(", ")}</td><td><Pill s={h.status} /></td>
                  <td>{h.status === "SCHEDULED" ? <SpecForm action={recordHearingAction} hidden={{ hearingId: h.id }} submitLabel="Save" columns={1} fields={[{ name: "status", label: "Outcome", type: "select", options: [{ value: "HELD", label: "Held" }, { value: "ADJOURNED", label: "Adjourned" }, { value: "CANCELLED", label: "Cancelled" }], required: true }, { name: "attendees", label: "Attendees" }, { name: "employeeStatement", label: "Employee's statement", type: "textarea" }, { name: "minutes", label: "Minutes", type: "textarea" }]} /> : h.minutes ? <span className="text-xs" style={{ whiteSpace: "pre-wrap" }}>{h.minutes}</span> : null}</td></tr>
              ))}
            </Table>
            {hr && !closed ? <div style={{ marginTop: 12 }}><SpecForm action={scheduleHearingAction} hidden={{ caseId: c.id }} submitLabel="Schedule hearing" fields={[{ name: "scheduledAt", label: "Date and time", type: "text", placeholder: "2026-10-12T15:00", required: true, hint: "YYYY-MM-DDTHH:MM, India time" }, { name: "location", label: "Where" }, { name: "panelUserIds", label: "Panel", type: "multiselect", options: users, wide: true }]} /></div> : null}
          </Card>

          <Card title="Disciplinary actions" description="Every action needs an approver's sign-off before it is issued. Issued warnings appear on the employee's HR activity timeline.">
            {c.subjectEmployeeId ? <div className="text-sm muted" style={{ marginBottom: 8 }}>Earlier active actions for this employee: {priorWarnings.length ? priorWarnings.map((h) => ER_ACTION_TYPES[h.actionType as keyof typeof ER_ACTION_TYPES]).join(", ") : "none"}.{finalCheck.skipped ? " A final warning would skip the written-warning step." : ""}{termCheck.skipped ? " Termination would skip the final-warning step." : ""}</div> : null}
            <Table head={["Action", "Effective", "Status", "Response", ""]} empty={!c.actions.length}>
              {c.actions.map((a) => (
                <tr key={a.id}><td>{ER_ACTION_TYPES[a.actionType as keyof typeof ER_ACTION_TYPES]}<div className="muted text-xs">{a.summary}</div>{a.ladderOverride ? <div className="text-xs">Step skipped: {a.ladderOverride}</div> : null}{a.letterId ? <Link className="text-xs" href={`/documents/letters/${a.letterId}`}>Notice letter</Link> : null}</td>
                  <td>{fmtDate(a.effectiveOn)}{a.suspensionFrom ? <div className="text-xs">{fmtDate(a.suspensionFrom)} – {fmtDate(a.suspensionTo)} ({a.suspensionPaid ? "paid" : "unpaid"})</div> : null}</td>
                  <td><Pill s={a.status} />{a.acknowledgedAt ? <div className="text-xs">acknowledged {fmtDate(a.acknowledgedAt)}</div> : null}</td>
                  <td className="text-xs" style={{ whiteSpace: "pre-wrap" }}>{a.employeeResponse ?? (a.responseDueOn ? `due ${fmtDate(a.responseDueOn)}` : "—")}</td>
                  <td>{canApprove && (a.status === "ISSUED" || a.status === "APPROVED") ? <ActButton action={revokeActionAction} hidden={{ actionId: a.id }} label="Revoke" variant="danger" input={{ name: "reason", placeholder: "Reason", required: true }} /> : null}</td></tr>
              ))}
            </Table>
            {canManage && c.subjectEmployeeId && !closed ? (
              <div style={{ marginTop: 12 }}>
                <SpecForm action={proposeActionAction} hidden={{ caseId: c.id }} submitLabel="Propose for approval" fields={[
                  { name: "actionType", label: "Action", type: "select", options: opts(ER_ACTION_TYPES), required: true },
                  { name: "effectiveOn", label: "Effective", type: "date", required: true },
                  { name: "summary", label: "What it is for", type: "textarea", required: true, wide: true },
                  { name: "responseDueOn", label: "Show cause: respond by", type: "date" },
                  { name: "letterTemplateId", label: "Notice letter", type: "select", options: letters.map((l) => ({ value: l.id, label: l.name })) },
                  { name: "suspensionFrom", label: "Suspension from", type: "date" },
                  { name: "suspensionTo", label: "Suspension to", type: "date" },
                  { name: "suspensionPaid", label: "Suspension", type: "checkbox", placeholder: "Paid" },
                  { name: "ladderOverride", label: "If a step is skipped, why", hint: "e.g. gross misconduct — required when skipping a warning step." },
                ]} />
              </div>
            ) : null}
          </Card>

          <Card title="Appeals">
            <Table head={["Filed", "Grounds", "Status", ""]} empty={!c.appeals.length}>
              {c.appeals.map((a) => (
                <tr key={a.id}><td>{fmtDate(a.filedAt)}</td><td className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{a.grounds}{a.decision ? <div className="muted text-xs">Decision: {a.decision}</div> : null}</td><td><Pill s={a.status} /></td>
                  <td>{canApprove && a.status === "FILED" ? <ActButton action={takeUpAppealAction} hidden={{ appealId: a.id }} label="Take up" /> : null}
                    {canApprove && a.status === "UNDER_REVIEW" && a.reviewerUserId === viewer.user.id ? <SpecForm action={decideAppealAction} hidden={{ appealId: a.id }} submitLabel="Decide" columns={1} fields={[{ name: "decision", label: "Decision", type: "select", options: [{ value: "UPHELD", label: "Upheld (action stands)" }, { value: "MODIFIED", label: "Modified" }, { value: "OVERTURNED", label: "Overturned (action revoked)" }], required: true }, { name: "note", label: "Reasons", type: "textarea", required: true }]} /> : null}</td></tr>
              ))}
            </Table>
          </Card>

          <Card title="Resolution">
            {c.resolution ? <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>{c.resolution}</p> : null}
            {hr && !closed && c.resolutionStatus !== "PENDING" && c.resolutionStatus !== "APPROVED" ? (
              <SpecForm action={proposeResolutionAction} hidden={{ caseId: c.id }} submitLabel="Send for approval" columns={1} fields={[{ name: "outcome", label: "Outcome", type: "select", options: opts(ER_OUTCOMES), required: true }, { name: "resolution", label: "Resolution", type: "textarea", required: true }]} />
            ) : null}
            {c.resolutionStatus === "PENDING" ? <Callout>The resolution is awaiting approval in Inbox › Approvals.</Callout> : null}
            {hr && c.status === "RESOLVED" ? <ActButton action={closeErCaseAction} hidden={{ caseId: c.id }} label="Close case" confirmText="Close the case? It is then kept until its retention date." /> : null}
          </Card>

          <Card title="Access list" description="Who can open this case besides employee relations approvers.">
            <Table head={["Person", "Role", ""]} empty={!c.access.length}>
              {c.access.map((a) => <tr key={a.id}><td>{names.get(a.userId)}</td><td>{a.role.toLowerCase()}</td><td>{hr && a.userId !== c.ownerUserId ? <ActButton action={erAccessAction} hidden={{ caseId: c.id, userId: a.userId, remove: "1" }} label="Remove" variant="ghost" /> : null}</td></tr>)}
            </Table>
            {hr ? <div style={{ marginTop: 12 }}><SpecForm action={erAccessAction} hidden={{ caseId: c.id }} submitLabel="Grant access" fields={[{ name: "userId", label: "Person", type: "select", options: users, required: true }, { name: "role", label: "Role", type: "select", options: [{ value: "VIEWER", label: "Viewer" }, { value: "PANEL", label: "Panel" }, { value: "INVESTIGATOR", label: "Investigator" }, { value: "OWNER", label: "Owner" }], defaultValue: "VIEWER" }]} /></div> : null}
          </Card>
        </div>
      </div>
    </>
  );
}
