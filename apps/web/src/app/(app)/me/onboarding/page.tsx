import Link from "next/link";
import { prisma } from "@keka/db";
import {
  preboardingReadiness, preboardingScore, bgvConsentState, PREBOARDING_OPEN, MILESTONE_KINDS, type NewHireField,
} from "@keka/services";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, KeyValue, Callout } from "@/components/ui";
import { Table, Pill } from "@/components/gov-ui";
import { SpecForm, ActButton, type FieldSpec } from "@/components/gov-forms";
import { fmtDay, fmtTime, pretty } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import { openPolicyTaskAction, submitPreboardingTaskAction, submitNewHireFormAction } from "@/app/actions/join-preboarding";
import { buddyOpAction, rsvpOrientationAction, milestoneFeedbackAction } from "@/app/actions/join-onboarding";
import { giveBgvConsentAction } from "@/app/actions/join-bgv";


/**
 * The new hire's welcome center: their preboarding checklist (forms,
 * policies, location confirmation and the rest), readiness for day one,
 * messages from the company, their buddy, orientation sessions,
 * checkpoint feedback and the status of their background verification.
 */
export default async function WelcomeCenterPage() {
  const viewer = await requireViewer();
  const me = viewer.employee;
  if (!me) return <><PageHead title="Welcome" /><Card><Empty title="No employee record is linked to this login" /></Card></>;
  const t = viewer.tenantId;
  const emp = await prisma.employee.findFirst({ where: { id: me.id }, select: { displayName: true, dateOfJoining: true, status: true, location: { select: { name: true, addressLine1: true, city: true } }, reportingManager: { select: { displayName: true } }, department: { select: { name: true } } } });
  const [tasks, readiness, logs, buddies, invites, milestones, cases, journeys] = await Promise.all([
    prisma.preboardingTask.findMany({ where: { tenantId: t, employeeId: me.id }, orderBy: { dueDate: "asc" } }),
    preboardingReadiness(t, me.id),
    prisma.prejoinMessageLog.findMany({ where: { tenantId: t, employeeId: me.id }, orderBy: { sentAt: "desc" }, take: 20 }),
    prisma.onboardingBuddy.findMany({ where: { tenantId: t, OR: [{ employeeId: me.id }, { buddyEmployeeId: me.id }], status: { in: ["ACTIVE", "COMPLETED", "PROPOSED"] } }, include: { checkins: { orderBy: { heldOn: "desc" }, take: 5 } } }),
    prisma.orientationAttendee.findMany({ where: { employeeId: me.id, session: { tenantId: t, status: { in: ["SCHEDULED", "COMPLETED"] } } }, include: { session: true }, orderBy: { session: { startsAt: "asc" } } }),
    prisma.onboardingMilestone.findMany({ where: { tenantId: t, employeeId: me.id }, orderBy: { dueDate: "asc" } }),
    prisma.bgvCheck.findMany({ where: { tenantId: t, employeeId: me.id }, include: { items: { select: { id: true, checkType: true, status: true, recheckOfId: true } } }, orderBy: { initiatedAt: "desc" }, take: 3 }),
    prisma.journey.findMany({ where: { tenantId: t, employeeId: me.id, trigger: "JOINING" }, select: { id: true, status: true, completedAt: true } }),
  ]);
  const formIds = tasks.filter((x) => x.kind === "FORM" && x.refId).map((x) => x.refId!);
  const docIds = tasks.filter((x) => x.kind === "POLICY" && x.refId).map((x) => x.refId!);
  const [forms, docs] = await Promise.all([
    prisma.newHireForm.findMany({ where: { tenantId: t, id: { in: formIds } } }),
    prisma.orgDocument.findMany({ where: { tenantId: t, id: { in: docIds } }, select: { id: true, title: true, fileUrl: true, description: true } }),
  ]);
  const ppl = await peopleIndex(t, buddies.flatMap((b) => [b.employeeId, b.buddyEmployeeId]));
  const score = preboardingScore(tasks, readiness);
  const open = tasks.filter((x) => PREBOARDING_OPEN.includes(x.status));
  const now = new Date();
  const days = emp ? Math.round((emp.dateOfJoining.getTime() - now.getTime()) / 86_400_000) : 0;
  const done = journeys.find((j) => j.status === "COMPLETED");

  return (
    <>
      <PageHead title={`Welcome, ${emp?.displayName ?? ""}`} subtitle={emp?.status === "PREBOARDING" ? `You join on ${fmtDay(emp.dateOfJoining)}${days > 0 ? ` — in ${days} day(s)` : ""}` : "Your onboarding"}
        actions={done ? <Link className="btn" href={`/onboarding/certificate/${done.id}`}>Completion certificate</Link> : null} />
      <div className="grid grid-2" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <div className="stack gap-4">
          <Card title="Your checklist" description={`${open.length} open · ${score.pct}% ready`}>
            <Progress value={score.pct} tone={score.pct >= 80 ? "success" : "warning"} />
            {tasks.length === 0 ? <Empty title="Nothing to do yet">HR will share your checklist before you join.</Empty> : (
              <div className="stack gap-3" style={{ marginTop: 12 }}>
                {tasks.map((x) => {
                  const form = x.kind === "FORM" ? forms.find((f) => f.id === x.refId) : null;
                  const doc = x.kind === "POLICY" ? docs.find((d) => d.id === x.refId) : null;
                  const isOpen = PREBOARDING_OPEN.includes(x.status);
                  return (
                    <div key={x.id} className="card" style={{ padding: 12 }}>
                      <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                        <div><strong className="text-sm">{x.title}</strong><div className="text-xs subtle">{pretty(x.kind)} · due {fmtDay(x.dueDate)}</div></div>
                        <Pill s={x.status} />
                      </div>
                      {x.description ? <div className="text-sm muted" style={{ marginTop: 4 }}>{x.description}</div> : null}
                      {x.decisionNote && x.status === "REJECTED" ? <Callout tone="warning">{x.decisionNote}</Callout> : null}
                      {isOpen ? (
                        <div style={{ marginTop: 8 }}>
                          {form ? (
                            <SpecForm action={submitNewHireFormAction} hidden={{ formId: form.id, taskId: x.id }} submitLabel="Submit form"
                              fields={(form.fields as unknown as NewHireField[]).map((fl): FieldSpec => ({
                                name: `f_${fl.key}`, label: fl.label, required: fl.required,
                                type: fl.type === "NUMBER" ? "number" : fl.type === "DATE" ? "date" : fl.type === "SELECT" || fl.type === "YESNO" ? "select" : "text",
                                options: fl.type === "YESNO" ? [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }] : fl.options.map((o) => ({ value: o, label: o })),
                              }))} />
                          ) : x.kind === "POLICY" ? (
                            <div className="stack gap-2">
                              <div className="row gap-2">
                                {doc?.fileUrl ? <a className="btn sm" href={doc.fileUrl} target="_blank" rel="noreferrer">Read {doc.title}</a> : <span className="text-sm">{doc?.title ?? "Policy"}</span>}
                                <ActButton action={openPolicyTaskAction} hidden={{ id: x.id }} label={x.viewedAt ? "Opened" : "I have opened it"} />
                              </div>
                              {x.viewedAt ? <SpecForm action={submitPreboardingTaskAction} hidden={{ id: x.id }} submitLabel="Confirm" columns={1} fields={[{ name: "ack", label: "Acknowledgement", type: "checkbox", required: true, placeholder: "I have read and understood this policy" }]} /> : null}
                            </div>
                          ) : x.kind === "LOCATION" ? (
                            <SpecForm action={submitPreboardingTaskAction} hidden={{ id: x.id }} submitLabel="Confirm" fields={[
                              { name: "confirm", label: `Joining at ${emp?.location?.name ?? "your office"}${emp?.location?.city ? `, ${emp.location.city}` : ""}`, type: "select", required: true, options: [{ value: "YES", label: "Yes, that's right" }, { value: "CHANGE", label: "I need a change" }] },
                              { name: "note", label: "What should change", type: "textarea" },
                            ]} />
                          ) : (
                            <SpecForm action={submitPreboardingTaskAction} hidden={{ id: x.id }} submitLabel={x.requiresApproval ? "Submit for review" : "Mark done"} columns={1} fields={[{ name: "note", label: "Note (optional)", type: "textarea" }]} />
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card tight title="Orientation and onboarding meetings">
            <Table head={["When", "Session", "Where", "Your reply", ""]} empty={!invites.length}>
              {invites.map((a) => (
                <tr key={a.id}>
                  <td className="text-sm nowrap">{fmtTime(a.session.startsAt)}</td>
                  <td className="text-sm"><strong>{a.session.title}</strong><div className="text-xs subtle">{pretty(a.session.kind)}{a.session.agenda ? ` · ${a.session.agenda}` : ""}</div></td>
                  <td className="text-xs">{a.session.location ?? ""}{a.session.meetingLink ? <div><a href={a.session.meetingLink}>Join link</a></div> : null}</td>
                  <td><Pill s={a.status} /></td>
                  <td className="right">{a.session.status === "SCHEDULED" ? (
                    <div className="row gap-2"><ActButton action={rsvpOrientationAction} hidden={{ sessionId: a.sessionId, response: "CONFIRMED" }} label="Accept" /><ActButton action={rsvpOrientationAction} hidden={{ sessionId: a.sessionId, response: "DECLINED" }} label="Decline" variant="ghost" /></div>
                  ) : null}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Checkpoints" description="Tell us how your first week and first 90 days are going">
            {milestones.length === 0 ? <Empty title="No checkpoints yet" /> : (
              <div className="stack gap-3">
                {milestones.map((m) => (
                  <div key={m.id} className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}><strong className="text-sm">{pretty(m.kind)} ({MILESTONE_KINDS[m.kind as keyof typeof MILESTONE_KINDS]} days)</strong><span className="text-xs subtle">due {fmtDay(m.dueDate)}</span></div>
                    {m.objectives ? <div className="text-sm muted">{m.objectives}</div> : null}
                    {m.hireDoneAt ? <div className="text-xs pos">You rated it {m.hireRating}/5</div> : m.dueDate <= new Date(now.getTime() + 3 * 86_400_000) ? (
                      <SpecForm action={milestoneFeedbackAction} hidden={{ id: m.id }} submitLabel="Send feedback" fields={[
                        { name: "rating", label: "How is it going? (1–5)", type: "select", required: true, options: ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v })) },
                        { name: "comment", label: "Anything to share", type: "textarea" },
                      ]} />
                    ) : <div className="text-xs subtle">Opens a few days before it is due.</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack gap-4">
          <Card title="Ready for day one">
            <div className="stack gap-1">
              {readiness.map((r) => <div key={r.key} className="text-sm">{r.ok ? <span className="pos">✓</span> : <span className="neg">○</span>} {r.label}</div>)}
            </div>
            <div className="text-xs subtle" style={{ marginTop: 8 }}>Bank, tax, benefits and contacts go on <Link href="/me">your profile</Link>.</div>
          </Card>
          <Card title="Your first day">
            <KeyValue items={[["Joining", fmtDay(emp?.dateOfJoining)], ["Office", [emp?.location?.name, emp?.location?.addressLine1].filter(Boolean).join(", ") || "—"], ["Manager", emp?.reportingManager?.displayName ?? "—"], ["Team", emp?.department?.name ?? "—"]]} />
          </Card>
          {buddies.map((b) => {
            const iAmHire = b.employeeId === me.id;
            return (
              <Card key={b.id} title={iAmHire ? `Your buddy: ${ppl.name(b.buddyEmployeeId)}` : `You are buddy to ${ppl.name(b.employeeId)}`} description={`${fmtDay(b.startsOn)} to ${fmtDay(b.endsOn)} · ${pretty(b.status)}`}>
                {b.goals ? <div className="text-sm muted">{b.goals}</div> : null}
                {b.checkins.map((c) => <div key={c.id} className="text-xs" style={{ marginTop: 4 }}>{fmtDay(c.heldOn)} — {c.note}</div>)}
                {b.status === "ACTIVE" ? <div style={{ marginTop: 8 }}><SpecForm action={buddyOpAction} hidden={{ id: b.id, op: "checkin" }} columns={1} submitLabel="Log check-in" fields={[{ name: "note", label: "Check-in note", type: "textarea", required: true }]} /></div> : null}
                {iAmHire && b.status !== "PROPOSED" && !b.feedbackRating ? <div style={{ marginTop: 8 }}><SpecForm action={buddyOpAction} hidden={{ id: b.id, op: "feedback" }} columns={1} submitLabel="Rate your buddy" fields={[{ name: "rating", label: "Rating (1–5)", type: "select", required: true, options: ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v })) }, { name: "note", label: "Comment" }]} /></div> : null}
              </Card>
            );
          })}
          <div id="verification" />
          {cases.map((c) => {
            const consent = bgvConsentState(c, now);
            const current = c.items.filter((i) => !c.items.some((n) => n.recheckOfId === i.id));
            return (
              <Card key={c.id} title="Background verification" description={`Started ${fmtDay(c.initiatedAt)}`}>
                <div className="row gap-2"><Pill s={c.status} /><Badge tone={consent === "VALID" ? "success" : consent === "EXPIRED" || consent === "MISSING" ? "danger" : "warning"}>Consent: {pretty(consent)}</Badge></div>
                <div className="stack gap-1" style={{ marginTop: 8 }}>
                  {current.map((i, k) => <div key={k} className="text-sm row" style={{ justifyContent: "space-between" }}><span>{pretty(i.checkType)}</span><span className="text-xs">{pretty(i.status === "PENDING_REVIEW" ? "IN_PROGRESS" : i.status)}</span></div>)}
                </div>
                {["INITIATED", "IN_PROGRESS"].includes(c.status) && consent !== "VALID" ? (
                  <div style={{ marginTop: 8 }}><SpecForm action={giveBgvConsentAction} hidden={{ id: c.id }} columns={1} submitLabel="Give consent" fields={[{ name: "agree", label: "Consent", type: "checkbox", required: true, placeholder: "I consent to BooS-HR and its verification partner checking the details I have shared" }]} /></div>
                ) : null}
              </Card>
            );
          })}
          <Card tight title="Messages">
            <Table head={["", ""]} empty={!logs.length}>
              {logs.map((l) => <tr key={l.id}><td className="text-xs nowrap">{fmtDay(l.sentAt)}</td><td className="text-sm"><strong>{l.subject}</strong>{l.body ? <div className="text-xs muted" style={{ whiteSpace: "pre-wrap" }}>{l.body.slice(0, 400)}</div> : null}</td></tr>)}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
