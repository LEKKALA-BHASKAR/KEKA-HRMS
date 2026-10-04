import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { sessionOpen } from "@keka/services";
import { requireAuth, can, canAny } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Badge, Person, KeyValue } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { saveSessionAction, sessionOpAction, registerSessionAction, nominateSessionAction, cancelRegistrationAction, decideRegistrationAction, markAttendanceAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;
const local = (d: Date) => d.toISOString().slice(0, 16);

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const { id } = await params;
  const runs = canAny(viewer, [P.COURSE_MANAGE, P.TRAINING_MANAGE]);
  const s = await prisma.trainingSession.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { registrations: { include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } }, orderBy: { requestedAt: "asc" } } },
  });
  if (!s || (s.status === "CANCELLED" && !runs)) notFound();
  const me = viewer.employee?.id;
  const mine = me ? s.registrations.find((r) => r.employeeId === me) : undefined;
  const open = sessionOpen(s);
  const started = s.startsAt.getTime() <= Date.now();
  const nominator = runs || can(viewer, P.COURSE_ASSIGN) || viewer.allReportIds.size > 0;
  const taken = new Set(s.registrations.filter((r) => !["CANCELLED", "REJECTED"].includes(r.status)).map((r) => r.employeeId));
  const [candidates, course, instructor] = await Promise.all([
    nominator && open ? prisma.employee.findMany({ where: { ...(runs ? { tenantId: viewer.tenantId } : { OR: [{ id: { in: [...viewer.allReportIds] } }, scopedEmployeeWhere(viewer, P.COURSE_ASSIGN)], tenantId: viewer.tenantId }), status: { notIn: ["EXITED", "INACTIVE"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { firstName: "asc" }, take: 1000 }) : Promise.resolve([]),
    s.courseId ? prisma.course.findUnique({ where: { id: s.courseId }, select: { id: true, title: true } }) : Promise.resolve(null),
    s.instructorId ? prisma.employee.findUnique({ where: { id: s.instructorId }, select: { displayName: true } }) : Promise.resolve(null),
  ]);
  // Managers see their team's requests; session runners see everyone's.
  const decidable = s.registrations.filter((r) => r.status === "REQUESTED" && r.employeeId !== me && (runs || viewer.allReportIds.has(r.employeeId)));
  const registered = s.registrations.filter((r) => r.status === "REGISTERED");

  return (
    <>
      <PageHead
        title={s.title}
        subtitle={<span className="row gap-2"><Badge tone={s.status === "SCHEDULED" ? "info" : s.status === "COMPLETED" ? "success" : "neutral"} dot>{s.status.toLowerCase()}</Badge><span className="text-sm subtle">{s.mode === "VIRTUAL" ? "Virtual" : "Classroom"} · {formatDate(s.startsAt)}</span></span>}
        actions={<>
          <Link className="btn" href="/learn/sessions">Back</Link>
          {me && open && (!mine || ["CANCELLED", "REJECTED"].includes(mine.status)) ? <ActButton action={registerSessionAction} hidden={{ sessionId: s.id }} label={s.requiresApproval ? "Request a place" : "Register"} variant="primary" input={s.requiresApproval ? { name: "note", placeholder: "Note to your manager (optional)" } : undefined} /> : null}
          {mine && ["REGISTERED", "WAITLISTED", "REQUESTED"].includes(mine.status) && open ? <ActButton action={cancelRegistrationAction} hidden={{ registrationId: mine.id }} label="Cancel my place" variant="ghost" confirmText="Give up your place?" /> : null}
          {runs && s.status === "SCHEDULED" && started ? <ActButton action={sessionOpAction} hidden={{ sessionId: s.id, op: "complete" }} label="Mark completed" /> : null}
          {runs && s.status === "SCHEDULED" ? <ActButton action={sessionOpAction} hidden={{ sessionId: s.id, op: "cancel" }} label="Cancel session" variant="ghost" confirmText="Cancel the session and tell everyone registered?" /> : null}
        </>}
      />
      <div className="stack gap-4">
        <Panel title="Details">
          <KeyValue items={[
            ["When", `${formatDate(s.startsAt)} ${s.startsAt.toISOString().slice(11, 16)} – ${s.endsAt.toISOString().slice(11, 16)}`],
            ["Where", s.mode === "VIRTUAL" ? (s.meetingUrl && (mine?.status === "REGISTERED" || runs) ? <a href={s.meetingUrl} target="_blank" rel="noopener noreferrer">{s.meetingUrl}</a> : "Online — the link shows once you are registered") : (s.venue ?? "—")],
            ["Instructor", instructor?.displayName ?? s.instructorName ?? "—"],
            ["Seats", `${registered.length}${s.capacity ? ` of ${s.capacity}` : ""} taken`],
            ["Course", course ? <Link href={`/learn/courses/${course.id}`}>{course.title}</Link> : "—"],
            ["Your place", mine ? `${mine.status.toLowerCase()}${mine.attendance ? ` · ${mine.attendance.toLowerCase()}` : ""}` : "Not registered"],
          ]} />
          {s.description ? <p className="text-sm" style={{ marginTop: 10 }}>{s.description}</p> : null}
        </Panel>

        {decidable.length ? (
          <Panel title={`Waiting for approval (${decidable.length})`} pad={false}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Asked</th><th>Note</th><th /></tr></thead>
                <tbody>
                  {decidable.map((r) => (
                    <tr key={r.id}>
                      <td><Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} /></td>
                      <td className="text-sm">{formatDate(r.requestedAt)}</td>
                      <td className="text-sm">{r.note ?? "—"}</td>
                      <td className="right"><span className="row gap-1">
                        <ActButton action={decideRegistrationAction} hidden={{ registrationId: r.id, decision: "approve" }} label="Approve" variant="primary" />
                        <ActButton action={decideRegistrationAction} hidden={{ registrationId: r.id, decision: "reject" }} label="Reject" variant="ghost" />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        {nominator && open ? (
          <Reveal label="Register people">
            <Panel title="Register people" subtitle="Registrations beyond the seats go on the waitlist">
              <GrowthForm action={nominateSessionAction} hidden={{ sessionId: s.id }} cols={1} submitLabel="Register" fields={[{ name: "employeeIds", label: "People", type: "checklist", options: candidates.filter((p) => !taken.has(p.id)).map((p) => ({ value: p.id, label: `${p.displayName} · ${p.employeeNumber}` })) }]} />
            </Panel>
          </Reveal>
        ) : null}

        {runs ? (
          <Panel title={`Attendance${started ? "" : " — can be marked once the session starts"}`} subtitle={`${registered.length} registered`}>
            {registered.length === 0 ? <EmptyState title="Nobody is registered" /> : started && s.status !== "CANCELLED" ? (
              <GrowthForm action={markAttendanceAction} hidden={{ sessionId: s.id }} cols={1} submitLabel="Save attendance" fields={[{ name: "present", label: "Present (unticked = absent)", type: "checklist", options: registered.map((r) => ({ value: r.id, label: `${r.employee.displayName} · ${r.employee.employeeNumber}` })), checked: registered.filter((r) => r.attendance === "PRESENT").map((r) => r.id) }]} />
            ) : (
              <ul className="stack gap-1" style={{ margin: 0, paddingLeft: 18 }}>{registered.map((r) => <li key={r.id} className="text-sm">{r.employee.displayName}</li>)}</ul>
            )}
          </Panel>
        ) : null}

        {runs ? (
          <Panel title={`All registrations (${s.registrations.length})`} pad={false}>
            {s.registrations.length === 0 ? <EmptyState title="None yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Requested</th><th>Status</th><th>Attendance</th><th /></tr></thead>
                  <tbody>
                    {s.registrations.map((r) => (
                      <tr key={r.id}>
                        <td><Person name={r.employee.displayName ?? ""} meta={r.employee.employeeNumber} /></td>
                        <td className="text-sm">{formatDate(r.requestedAt)}</td>
                        <td><Badge tone={r.status === "REGISTERED" ? "success" : r.status === "WAITLISTED" || r.status === "REQUESTED" ? "warning" : "neutral"} dot>{r.status.toLowerCase()}</Badge></td>
                        <td className="text-sm">{r.attendance?.toLowerCase() ?? "—"}</td>
                        <td className="right">{open && ["REGISTERED", "WAITLISTED", "REQUESTED"].includes(r.status) ? <ActButton action={cancelRegistrationAction} hidden={{ registrationId: r.id }} label="Cancel" variant="ghost" /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ) : null}

        {runs && s.status === "SCHEDULED" ? (
          <Reveal label="Edit session">
            <Panel title="Edit session">
              <GrowthForm action={saveSessionAction} hidden={{ id: s.id }} submitLabel="Save" fields={[
                { name: "title", label: "Title", required: true, defaultValue: s.title },
                { name: "mode", label: "Mode", type: "select", required: true, options: [{ value: "CLASSROOM", label: "Classroom" }, { value: "VIRTUAL", label: "Virtual" }], defaultValue: s.mode },
                { name: "capacity", label: "Seats", type: "number", min: 1, max: 1000, defaultValue: s.capacity },
                { name: "startsAt", label: "Starts", type: "datetime-local", required: true, defaultValue: local(s.startsAt) },
                { name: "endsAt", label: "Ends", type: "datetime-local", required: true, defaultValue: local(s.endsAt) },
                { name: "venue", label: "Venue", defaultValue: s.venue },
                { name: "meetingUrl", label: "Meeting link", type: "url", defaultValue: s.meetingUrl },
                { name: "instructorName", label: "Instructor name", defaultValue: s.instructorName },
                { name: "courseId", label: "Linked course id", defaultValue: s.courseId, hint: "Optional" },
                { name: "description", label: "Description", type: "textarea", defaultValue: s.description },
                { name: "requiresApproval", label: "Registrations need approval", type: "checkbox", defaultChecked: s.requiresApproval },
              ]} />
            </Panel>
          </Reveal>
        ) : null}
      </div>
    </>
  );
}
