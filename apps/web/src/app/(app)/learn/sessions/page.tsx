import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, canAny } from "@/lib/context";
import { PageHead, Badge } from "@/components/ui";
import { Panel, EmptyState } from "@/components/keka";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { saveSessionAction } from "@/app/actions/learn-growth";

const P = PERMISSIONS;
const time = (d: Date) => d.toISOString().slice(11, 16);

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ when?: string; q?: string }> }) {
  const viewer = await requireAuth(P.LEARNING_VIEW);
  const sp = await searchParams;
  const runs = canAny(viewer, [P.COURSE_MANAGE, P.TRAINING_MANAGE]);
  const past = sp.when === "past";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const now = new Date();
  const [sessions, courses, people] = await Promise.all([
    prisma.trainingSession.findMany({
      where: { tenantId: viewer.tenantId, ...(past ? { endsAt: { lt: now } } : { endsAt: { gte: now } }), ...(runs ? {} : { status: { not: "CANCELLED" } }), ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
      include: { registrations: { select: { status: true, employeeId: true, attendance: true } } },
      orderBy: { startsAt: past ? "desc" : "asc" }, take: 200,
    }),
    runs ? prisma.course.findMany({ where: { tenantId: viewer.tenantId, status: "PUBLISHED" }, select: { id: true, title: true }, orderBy: { title: "asc" } }) : Promise.resolve([]),
    runs ? prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, select: { id: true, displayName: true }, orderBy: { firstName: "asc" }, take: 1000 }) : Promise.resolve([]),
  ]);
  const me = viewer.employee?.id;

  return (
    <>
      <PageHead title="Training Sessions" subtitle="Classroom and virtual sessions — register, get approved, attend" />
      <div className="tabs">
        <Link href="/learn/sessions" className={`tab${past ? "" : " active"}`}>Upcoming</Link>
        <Link href="/learn/sessions?when=past" className={`tab${past ? " active" : ""}`}>Past</Link>
      </div>
      <form className="row gap-2" style={{ marginBottom: 12 }}>
        {past ? <input type="hidden" name="when" value="past" /> : null}
        <input className="input" name="q" defaultValue={q} placeholder="Search sessions" style={{ maxWidth: 280 }} />
        <button className="btn">Search</button>
      </form>
      {runs ? (
        <Reveal label="+ Schedule a session">
          <Panel title="New session">
            <GrowthForm action={saveSessionAction} submitLabel="Schedule" fields={[
              { name: "title", label: "Title", required: true },
              { name: "mode", label: "Mode", type: "select", required: true, options: [{ value: "CLASSROOM", label: "Classroom" }, { value: "VIRTUAL", label: "Virtual" }], defaultValue: "CLASSROOM" },
              { name: "courseId", label: "Linked course", type: "select", options: courses.map((c) => ({ value: c.id, label: c.title })) },
              { name: "startsAt", label: "Starts", type: "datetime-local", required: true },
              { name: "endsAt", label: "Ends", type: "datetime-local", required: true },
              { name: "capacity", label: "Seats", type: "number", min: 1, max: 1000, hint: "Blank = unlimited; extra registrations are waitlisted" },
              { name: "venue", label: "Venue (classroom)" },
              { name: "meetingUrl", label: "Meeting link (virtual)", type: "url" },
              { name: "instructorId", label: "Instructor (employee)", type: "select", options: people.map((p) => ({ value: p.id, label: p.displayName ?? "" })) },
              { name: "instructorName", label: "…or external instructor" },
              { name: "description", label: "Description", type: "textarea" },
              { name: "requiresApproval", label: "Registrations need the manager's approval", type: "checkbox" },
            ]} />
          </Panel>
        </Reveal>
      ) : null}
      <Panel pad={false}>
        {sessions.length === 0 ? <EmptyState title={past ? "No past sessions" : "No sessions scheduled"} /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Session</th><th>When</th><th>Where</th><th className="num">Seats</th><th>Status</th><th>You</th></tr></thead>
              <tbody>
                {sessions.map((s) => {
                  const taken = s.registrations.filter((r) => r.status === "REGISTERED").length;
                  const mine = me ? s.registrations.find((r) => r.employeeId === me) : undefined;
                  return (
                    <tr key={s.id}>
                      <td><Link className="strong" href={`/learn/sessions/${s.id}`}>{s.title}</Link>{s.requiresApproval ? <div className="text-xs subtle">Needs approval</div> : null}</td>
                      <td className="text-sm nowrap">{formatDate(s.startsAt)} {time(s.startsAt)}–{time(s.endsAt)}</td>
                      <td className="text-sm">{s.mode === "VIRTUAL" ? "Online" : (s.venue ?? "—")}</td>
                      <td className="num">{taken}{s.capacity ? ` / ${s.capacity}` : ""}{s.registrations.some((r) => r.status === "WAITLISTED") ? <div className="text-xs subtle">{s.registrations.filter((r) => r.status === "WAITLISTED").length} waitlisted</div> : null}</td>
                      <td><Badge tone={s.status === "SCHEDULED" ? "info" : s.status === "COMPLETED" ? "success" : "neutral"} dot>{s.status.toLowerCase()}</Badge></td>
                      <td>{mine ? <Badge tone={mine.status === "REGISTERED" ? "success" : "warning"} dot>{mine.status.toLowerCase()}{mine.attendance ? ` · ${mine.attendance.toLowerCase()}` : ""}</Badge> : <span className="subtle">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
