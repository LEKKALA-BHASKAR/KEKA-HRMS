import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Person, Stat, Callout } from "@/components/ui";
import { searchHrActivities } from "@keka/services";
import { recordHrActivity } from "@/app/actions/workplace";
import { editHrActivityAction } from "@/app/actions/ops-lifecycle";
import { SpecForm } from "@/components/gov-forms";
import { Pill } from "@/components/gov-ui";

const P = PERMISSIONS;

const TYPE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral" | "brand"> = {
  PROMOTION: "success", APPRECIATION: "success", SALARY_REVISION: "brand",
  TRANSFER: "info", WORK_TRIP: "info",
  WARNING: "danger", COMPLAINT: "danger", TERMINATION: "danger",
  RESIGNATION: "warning",
};

const TYPES = [
  "PROMOTION", "TRANSFER", "WARNING", "COMPLAINT", "WORK_TRIP",
  "TERMINATION", "RESIGNATION", "APPRECIATION", "SALARY_REVISION",
] as const;

export default async function ActivitiesPage({
  searchParams,
}: { searchParams: Promise<{ type?: string; q?: string; status?: string; from?: string; to?: string; edit?: string }> }) {
  const viewer = await requireAuth(P.HR_ACTIVITY_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.HR_ACTIVITY_MANAGE);

  const scopeFilter = employeeScopeFilter(viewer, P.HR_ACTIVITY_VIEW);
  const scopedIds = scopeFilter
    ? (await prisma.employee.findMany({ where: { ...(scopeFilter as Prisma.EmployeeWhereInput), tenantId: viewer.tenantId }, select: { id: true } })).map((e) => e.id)
    : null;
  const isDay = (x?: string) => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const filters = { q: sp.q?.trim() || null, type: sp.type || null, status: sp.status || null, from: isDay(sp.from) ? new Date(`${sp.from}T00:00:00Z`) : null, to: isDay(sp.to) ? new Date(`${sp.to}T00:00:00Z`) : null, employeeIds: scopedIds, take: 120 };
  const qs = new URLSearchParams(Object.entries({ q: sp.q, type: sp.type, status: sp.status, from: sp.from, to: sp.to }).filter((e): e is [string, string] => !!e[1])).toString();

  const [activities, byType, employees] = await Promise.all([
    searchHrActivities(viewer.tenantId, filters),
    prisma.hrActivity.groupBy({
      by: ["type"],
      where: { tenantId: viewer.tenantId },
      _count: true,
    }),
    canManage
      ? prisma.employee.findMany({
          where: { tenantId: viewer.tenantId },
          select: { id: true, displayName: true, employeeNumber: true },
          orderBy: { firstName: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const tc = (t: string) => byType.find((b) => b.type === t)?._count ?? 0;

  return (
    <>
      <PageHead
        title="HR activities"
        subtitle="A timeline of discrete events — promotions, transfers, warnings, trips and appreciations"
      />

      <Callout tone="info" title="Events, not position changes">
        A warning or a work trip is an event on someone's record. A promotion or transfer
        that actually changes their position also creates an effective-dated job record,
        which is what payroll and reporting read from. This timeline is the narrative;
        the job history is the state.
      </Callout>

      <div style={{ height: 16 }} />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Promotions" value={tc("PROMOTION")} meta="All time" />
        <Stat label="Transfers" value={tc("TRANSFER")} meta="Location or department" />
        <Stat label="Warnings" value={tc("WARNING") + tc("COMPLAINT")} meta="Including complaints" />
        <Stat label="Work trips" value={tc("WORK_TRIP")} meta="Recorded travel" />
      </div>

      {canManage ? (
        <Card title="Record an activity" description="Use this for events. Position changes belong on the employee's Job tab.">
          <form action={recordHrActivity} className="stack gap-3">
            <div className="row gap-2 wrap">
              <select className="select" name="employeeId" required style={{ maxWidth: 230 }}>
                <option value="">Employee…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.displayName} ({e.employeeNumber})</option>
                ))}
              </select>
              <select className="select" name="type" required style={{ maxWidth: 180 }}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ").toLowerCase()}</option>
                ))}
              </select>
              <input className="input" name="occurredOn" type="date" style={{ maxWidth: 160 }} />
              <input className="input" name="title" placeholder="Title" required style={{ maxWidth: 260 }} />
            </div>
            <div className="row gap-2 wrap">
              <input className="input" name="fromValue" placeholder="From (promotion/transfer)" style={{ maxWidth: 200 }} />
              <input className="input" name="toValue" placeholder="To (promotion/transfer)" style={{ maxWidth: 200 }} />
              <select className="select" name="severity" style={{ maxWidth: 150 }}>
                <option value="">Severity (warnings)</option>
                <option value="MINOR">Minor</option>
                <option value="MAJOR">Major</option>
                <option value="FINAL">Final</option>
              </select>
              <input className="input" name="destination" placeholder="Destination (trips)" style={{ maxWidth: 180 }} />
            </div>
            <div className="row gap-2 wrap">
              <input className="input" name="tripFrom" type="date" placeholder="Trip from" style={{ maxWidth: 160 }} />
              <input className="input" name="tripTo" type="date" placeholder="Trip to" style={{ maxWidth: 160 }} />
            </div>
            <textarea className="textarea" name="description" rows={2} placeholder="Detail — what happened and what was agreed" />
            <button className="btn primary" type="submit" style={{ alignSelf: "flex-start" }}>
              Record activity
            </button>
          </form>
        </Card>
      ) : null}

      <div style={{ height: 16 }} />

      <form className="row gap-2 wrap" style={{ marginBottom: 12, alignItems: "center" }}>
        <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Search title, detail, employee…" style={{ width: 260 }} />
        <select className="select" name="type" defaultValue={sp.type ?? ""} style={{ maxWidth: 180 }}>
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, " ").toLowerCase()}</option>
          ))}
        </select>
        <select className="select" name="status" defaultValue={sp.status ?? ""} style={{ maxWidth: 170 }}>
          <option value="">Any status</option>
          <option value="RECORDED">Recorded</option>
          <option value="PENDING">Pending approval</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <input className="input" type="date" name="from" defaultValue={sp.from ?? ""} style={{ width: 150 }} />
        <input className="input" type="date" name="to" defaultValue={sp.to ?? ""} style={{ width: 150 }} />
        <button className="btn sm" type="submit">Filter</button>
        {qs ? <Link className="btn ghost sm" href="/activities">Clear</Link> : null}
      </form>

      <Card
        title={`Timeline (${activities.length})`}
        action={<a className="btn sm" href={`/activities/export${qs ? `?${qs}` : ""}`}>Download CSV</a>}
        tight
      >
        {activities.length === 0 ? <Empty title="No activities recorded" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Date</th><th>Employee</th><th>Type</th><th>Activity</th><th>Change</th>{canManage ? <th></th> : null}</tr>
              </thead>
              <tbody>
                {activities.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm nowrap">{formatDate(a.occurredOn)}</td>
                    <td>
                      <Link href={`/employees/${a.employee.id}`}>
                        <Person
                          name={a.employee.displayName ?? ""}
                          meta={`${a.employee.employeeNumber} · ${a.employee.department?.name ?? "—"}`}
                        />
                      </Link>
                    </td>
                    <td>
                      <Badge tone={TYPE_TONE[a.type] ?? "neutral"} dot>
                        {a.type.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                      {a.severity ? <Badge tone="danger">{a.severity.toLowerCase()}</Badge> : null}
                      {a.approvalStatus && a.approvalStatus !== "APPROVED" ? <div><Pill s={a.approvalStatus} /></div> : null}
                    </td>
                    <td>
                      <span className="strong">{a.title}</span>
                      {a.description ? (
                        <div className="text-xs subtle" style={{ maxWidth: 420 }}>{a.description}</div>
                      ) : null}
                      {a.editedAt ? <div className="text-xs muted">Edited {formatDate(a.editedAt)}</div> : null}
                      {canManage && sp.edit === a.id ? (
                        <div style={{ marginTop: 8, maxWidth: 520 }}>
                          <SpecForm action={editHrActivityAction} hidden={{ id: a.id }} submitLabel="Save changes" fields={[
                            { name: "title", label: "Title", required: true, defaultValue: a.title, wide: true },
                            { name: "occurredOn", label: "Date", type: "date", required: true, defaultValue: a.occurredOn.toISOString().slice(0, 10) },
                            { name: "severity", label: "Severity", type: "select", defaultValue: a.severity ?? "", options: [{ value: "MINOR", label: "Minor" }, { value: "MAJOR", label: "Major" }, { value: "FINAL", label: "Final" }] },
                            { name: "fromValue", label: "From", defaultValue: a.fromValue ?? "" }, { name: "toValue", label: "To", defaultValue: a.toValue ?? "" },
                            { name: "destination", label: "Destination", defaultValue: a.destination ?? "" },
                            { name: "description", label: "Detail", type: "textarea", defaultValue: a.description ?? "", wide: true },
                          ]} />
                        </div>
                      ) : null}
                    </td>
                    <td className="text-sm">
                      {a.fromValue && a.toValue ? (
                        <span>
                          <span className="subtle">{a.fromValue}</span>
                          <span className="muted"> → </span>
                          <span className="strong">{a.toValue}</span>
                        </span>
                      ) : a.destination ? (
                        <span>
                          {a.destination}
                          {a.tripFrom ? (
                            <div className="text-xs subtle">
                              {formatDate(a.tripFrom)} → {formatDate(a.tripTo)}
                            </div>
                          ) : null}
                        </span>
                      ) : <span className="subtle">—</span>}
                    </td>
                    {canManage ? (
                      <td>{a.approvalStatus !== "REJECTED" && sp.edit !== a.id ? <Link className="btn ghost sm" href={`/activities?${qs ? `${qs}&` : ""}edit=${a.id}`}>Edit</Link> : null}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
