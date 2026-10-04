import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { MILESTONE_KINDS } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty, Stat } from "@/components/ui";
import { Tabs, Table, Pill, SearchBar } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { fmtDay, fmtTime, toLocalInput, pretty, opts, matches } from "@/lib/engage-depth";
import { peopleIndex } from "@/lib/join-depth";
import { OnboardingNav } from "../_join/nav";
import {
  assignBuddyAction, buddyOpAction, saveOrientationSessionAction, orientationOpAction, generateMilestonesAction, reviewMilestoneAction,
} from "@/app/actions/join-onboarding";

const P = PERMISSIONS;
const TABS = { buddies: "Buddies", sessions: "Orientation & meetings", milestones: "Milestones" };

/** Buddies, orientation sessions and onboarding meetings, and first-week / 30-60-90-day milestones. HR sees their scope; managers their team. */
export default async function OnboardingPeoplePage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const viewer = await requireViewer();
  const { tab: raw, q } = await searchParams;
  const tab = raw && raw in TABS ? raw : "buddies";
  const hr = can(viewer, P.ONBOARDING_MANAGE);
  const team = await prisma.employee.findMany({
    where: hr ? { AND: [scopedEmployeeWhere(viewer, P.ONBOARDING_MANAGE), { status: { notIn: ["EXITED"] } }] } : { tenantId: viewer.tenantId, reportingManagerId: viewer.employee?.id ?? "-", status: { notIn: ["EXITED"] } },
    select: { id: true, displayName: true, employeeNumber: true, status: true, dateOfJoining: true }, orderBy: { dateOfJoining: "desc" },
  });
  const hires = team.filter((e) => e.status === "PREBOARDING" || e.dateOfJoining.getTime() > Date.now() - 120 * 86_400_000);
  const everyone = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING", "INACTIVE"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } });
  const o = (rows: Array<{ id: string; displayName: string | null; employeeNumber: string }>) => rows.map((e) => ({ value: e.id, label: `${e.displayName ?? ""} (${e.employeeNumber})` }));
  return (
    <>
      <PageHead title="Buddies & milestones" subtitle={hr ? "New hires in your scope" : "Your new team members"} />
      <OnboardingNav viewer={viewer} active="people" />
      <Tabs base="/onboarding/people" tabs={TABS} active={tab} />
      {tab === "buddies" ? <Buddies viewer={viewer} ids={team.map((t) => t.id)} hireOpts={o(hires)} peerOpts={o(everyone)} q={q} /> : null}
      {tab === "sessions" ? <Sessions viewer={viewer} hr={hr} inviteOpts={o(hr ? everyone : hires)} q={q} /> : null}
      {tab === "milestones" ? <Milestones viewer={viewer} ids={team.map((t) => t.id)} hireOpts={o(hires)} hr={hr} /> : null}
    </>
  );
}

async function Buddies({ viewer, ids, hireOpts, peerOpts, q }: { viewer: Viewer; ids: string[]; hireOpts: Array<{ value: string; label: string }>; peerOpts: Array<{ value: string; label: string }>; q?: string }) {
  const rows = await prisma.onboardingBuddy.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids } }, include: { _count: { select: { checkins: true } } }, orderBy: { createdAt: "desc" } });
  const ppl = await peopleIndex(viewer.tenantId, rows.flatMap((r) => [r.employeeId, r.buddyEmployeeId]));
  const shown = rows.filter((r) => matches(q, ppl.name(r.employeeId), ppl.name(r.buddyEmployeeId), r.status));
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        <Stat label="Active pairings" value={rows.filter((r) => r.status === "ACTIVE").length} />
        <Stat label="Awaiting the buddy" value={rows.filter((r) => r.status === "PROPOSED").length} />
        <Stat label="Check-ins logged" value={rows.reduce((s, r) => s + r._count.checkins, 0)} />
        <Stat label="Average rating" value={(() => { const r = rows.filter((x) => x.feedbackRating); return r.length ? (r.reduce((s, x) => s + x.feedbackRating!, 0) / r.length).toFixed(1) : "—"; })()} />
      </div>
      <Card title="Assign a buddy" description="The buddy accepts or declines from their inbox. Works before joining too.">
        <SpecForm action={assignBuddyAction} submitLabel="Ask them" fields={[
          { name: "employeeId", label: "New hire", type: "select", required: true, options: hireOpts },
          { name: "buddyEmployeeId", label: "Buddy", type: "select", required: true, options: peerOpts },
          { name: "startsOn", label: "From", type: "date", hint: "Defaults to the joining date" },
          { name: "endsOn", label: "Until", type: "date", hint: "Defaults to 90 days" },
          { name: "goals", label: "Goals for the pairing", type: "textarea", wide: true },
        ]} />
      </Card>
      <Card tight title={`Buddy assignments (${shown.length})`}>
        <div style={{ padding: "12px 16px 0" }}><SearchBar action="/onboarding/people" tab="buddies" q={q} /></div>
        <Table head={["Hire", "Buddy", "Period", "Check-ins", "Feedback", "Status", ""]} empty={!shown.length}>
          {shown.map((b) => (
            <tr key={b.id}>
              <td className="text-sm"><strong>{ppl.name(b.employeeId)}</strong></td>
              <td className="text-sm">{ppl.name(b.buddyEmployeeId)}</td>
              <td className="text-xs">{fmtDay(b.startsOn)} – {fmtDay(b.endsOn)}</td>
              <td className="num">{b._count.checkins}</td>
              <td className="text-xs">{b.feedbackRating ? `${b.feedbackRating}/5${b.feedbackNote ? ` · ${b.feedbackNote}` : ""}` : "—"}</td>
              <td><Pill s={b.status} /></td>
              <td className="right">
                <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
                  {b.status === "ACTIVE" ? <ActButton action={buddyOpAction} hidden={{ id: b.id, op: "checkin" }} label="Log check-in" input={{ name: "note", placeholder: "What was covered", required: true }} /> : null}
                  {b.status === "ACTIVE" ? <ActButton action={buddyOpAction} hidden={{ id: b.id, op: "complete" }} label="Complete" /> : null}
                  {["PROPOSED", "ACTIVE"].includes(b.status) ? <ActButton action={buddyOpAction} hidden={{ id: b.id, op: "cancel" }} label="Cancel" variant="ghost" /> : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Sessions({ viewer, hr, inviteOpts, q }: { viewer: Viewer; hr: boolean; inviteOpts: Array<{ value: string; label: string }>; q?: string }) {
  const [rows, courses] = await Promise.all([
    prisma.orientationSession.findMany({ where: { tenantId: viewer.tenantId, ...(hr ? {} : { createdBy: viewer.user.id }) }, include: { attendees: true }, orderBy: { startsAt: "desc" }, take: 200 }),
    prisma.course.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, title: true }, take: 200 }),
  ]);
  const ppl = await peopleIndex(viewer.tenantId, rows.flatMap((r) => [r.hostEmployeeId, ...r.attendees.map((a) => a.employeeId)]));
  const shown = rows.filter((r) => matches(q, r.title, r.kind, r.location));
  const kinds = hr ? ["ORIENTATION", "MANAGER_INTRO", "TEAM_MEET", "IT_SETUP", "CHECKIN"] : ["MANAGER_INTRO", "CHECKIN"];
  const soon = new Date(Date.now() + 86_400_000);
  return (
    <div className="stack gap-4">
      <Card title="Schedule a session" description="Drafted first; once approved the invitations go out and attendees can accept or decline.">
        <SpecForm action={saveOrientationSessionAction} submitLabel="Save draft" fields={[
          { name: "title", label: "Title", required: true },
          { name: "kind", label: "Type", type: "select", options: opts(kinds), defaultValue: kinds[0] },
          { name: "startsAt", label: "Starts (IST)", type: "datetime-local", required: true, defaultValue: toLocalInput(soon) },
          { name: "endsAt", label: "Ends (IST)", type: "datetime-local", required: true, defaultValue: toLocalInput(new Date(soon.getTime() + 3_600_000)) },
          { name: "location", label: "Room / place" },
          { name: "meetingLink", label: "Video link" },
          { name: "capacity", label: "Capacity", type: "number" },
          ...(hr ? [{ name: "courseId", label: "Linked course (quiz)", type: "select" as const, options: courses.map((c) => ({ value: c.id, label: c.title })), placeholder: "None" }] : []),
          { name: "agenda", label: "Agenda", type: "textarea", wide: true },
          { name: "attendeeIds", label: "Invite", type: "multiselect", options: inviteOpts, wide: true },
        ]} />
      </Card>
      <Card tight title={`Sessions (${shown.length})`}>
        <div style={{ padding: "12px 16px 0" }}><SearchBar action="/onboarding/people" tab="sessions" q={q} /></div>
        <Table head={["When", "Session", "Attendees", "Status", ""]} empty={!shown.length}>
          {shown.map((s) => (
            <tr key={s.id}>
              <td className="text-sm nowrap">{fmtTime(s.startsAt)}</td>
              <td className="text-sm"><strong>{s.title}</strong><div className="text-xs subtle">{pretty(s.kind)}{s.location ? ` · ${s.location}` : ""}{s.hostEmployeeId ? ` · host ${ppl.name(s.hostEmployeeId)}` : ""}{s.capacity ? ` · ${s.attendees.length}/${s.capacity}` : ""}</div></td>
              <td className="text-xs">{s.attendees.map((a) => (
                <div key={a.id} className="row gap-2">{ppl.name(a.employeeId)} · {pretty(a.status)}
                  {s.status === "SCHEDULED" && s.startsAt < new Date() ? <><ActButton action={orientationOpAction} hidden={{ id: s.id, op: "attend", employeeId: a.employeeId, status: "ATTENDED" }} label="Attended" /><ActButton action={orientationOpAction} hidden={{ id: s.id, op: "attend", employeeId: a.employeeId, status: "NO_SHOW" }} label="No-show" variant="ghost" /></> : null}
                </div>))}
              </td>
              <td><Pill s={s.status} /></td>
              <td className="right">
                <div className="row gap-2 wrap" style={{ justifyContent: "flex-end" }}>
                  {["DRAFT", "REJECTED"].includes(s.status) ? <ActButton action={orientationOpAction} hidden={{ id: s.id, op: "submit" }} label="Submit" variant="primary" /> : null}
                  {s.status === "SCHEDULED" ? <ActButton action={orientationOpAction} hidden={{ id: s.id, op: "complete" }} label="Complete" /> : null}
                  {!["COMPLETED", "CANCELLED"].includes(s.status) ? <ActButton action={orientationOpAction} hidden={{ id: s.id, op: "cancel" }} label="Cancel" variant="ghost" /> : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

async function Milestones({ viewer, ids, hireOpts, hr }: { viewer: Viewer; ids: string[]; hireOpts: Array<{ value: string; label: string }>; hr: boolean }) {
  const rows = await prisma.onboardingMilestone.findMany({ where: { tenantId: viewer.tenantId, employeeId: { in: ids } }, orderBy: [{ dueDate: "asc" }] });
  const ppl = await peopleIndex(viewer.tenantId, rows.map((r) => r.employeeId));
  const today = new Date();
  return (
    <div className="stack gap-4">
      <div className="grid grid-4">
        {Object.keys(MILESTONE_KINDS).map((k) => <Stat key={k} label={`${pretty(k)} done`} value={`${rows.filter((r) => r.kind === k && r.status === "COMPLETED").length}/${rows.filter((r) => r.kind === k).length}`} />)}
      </div>
      {hr ? (
        <Card title="Set up milestones" description="First week, 30, 60 and 90 days from the joining date.">
          <SpecForm action={generateMilestonesAction} submitLabel="Set up" fields={[{ name: "employeeId", label: "Hire", type: "select", required: true, options: hireOpts }]} />
        </Card>
      ) : null}
      <Card tight title="Checkpoints">
        {rows.length === 0 ? <Empty title="No milestones yet" /> : (
          <Table head={["Hire", "Milestone", "Due", "Manager review", "Hire feedback", "Status", ""]}>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="text-sm"><strong>{ppl.name(m.employeeId)}</strong></td>
                <td className="text-sm">{pretty(m.kind)}{m.objectives ? <div className="text-xs subtle">{m.objectives}</div> : null}</td>
                <td className={`text-sm ${m.status === "PENDING" && m.dueDate < today ? "neg" : ""}`}>{fmtDay(m.dueDate)}</td>
                <td className="text-xs">{m.managerRating ? `${m.managerRating}/5${m.managerNote ? ` · ${m.managerNote}` : ""}` : "—"}</td>
                <td className="text-xs">{m.hireRating ? `${m.hireRating}/5${m.hireComment ? ` · ${m.hireComment}` : ""}` : "—"}</td>
                <td><Pill s={m.status} /></td>
                <td className="right" style={{ minWidth: 240 }}>
                  {m.status === "PENDING" && !m.managerDoneAt ? (
                    <SpecForm action={reviewMilestoneAction} hidden={{ id: m.id, op: "review" }} submitLabel="Review" columns={1} fields={[
                      { name: "rating", label: "Progress (1–5)", type: "select", required: true, options: ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v })) },
                      { name: "note", label: "Note" },
                    ]} />
                  ) : null}
                  {m.status === "PENDING" ? <ActButton action={reviewMilestoneAction} hidden={{ id: m.id, op: "objectives" }} label="Set objectives" input={{ name: "objectives", placeholder: "Objectives" }} /> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
