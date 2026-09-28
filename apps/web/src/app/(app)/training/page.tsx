import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINRCompact } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Money, Person, Stat, Progress, Callout } from "@/components/ui";
import { enrolInTraining, updateTrainingProgress } from "@/app/actions/workplace";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

const PROGRAM_TONE: Record<string, "success" | "warning" | "info" | "neutral"> = {
  PLANNED: "info", IN_PROGRESS: "warning", COMPLETED: "success", CANCELLED: "neutral",
};
const ENROL_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  COMPLETED: "success", IN_PROGRESS: "warning", ASSIGNED: "info",
  FAILED: "danger", WITHDRAWN: "neutral",
};

export default async function TrainingPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; program?: string }> }) {
  const viewer = await requireAuth(P.TRAINING_VIEW);
  const sp = await searchParams;
  const canManage = can(viewer, P.TRAINING_MANAGE);
  const canEnrol = can(viewer, P.TRAINING_ENROL);
  const myId = viewer.employee?.id;
  const tab = sp.tab === "mine" || !canEnrol ? "mine" : sp.tab === "compliance" ? "compliance" : "programmes";

  const [programs, myEnrolments, employees, complianceStats] = await Promise.all([
    prisma.trainingProgram.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: [{ status: "asc" }, { startDate: "desc" }],
      include: {
        trainingType: true,
        _count: { select: { enrolments: true } },
        // Included unconditionally: a conditional `include` widens the row
        // into a union that drops the relation, and the volume here is small.
        enrolments: {
          include: {
            employee: {
              select: {
                id: true, displayName: true, employeeNumber: true,
                department: { select: { name: true } },
              },
            },
          },
          orderBy: { status: "asc" as const },
        },
      },
    }),
    myId
      ? prisma.trainingEnrolment.findMany({
          where: { employeeId: myId },
          orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
          include: { program: { include: { trainingType: true } } },
        })
      : Promise.resolve([]),
    canEnrol
      ? prisma.employee.findMany({
          where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
          select: { id: true, displayName: true, employeeNumber: true },
          orderBy: { firstName: "asc" },
        })
      : Promise.resolve([]),
    canEnrol
      ? prisma.trainingEnrolment.groupBy({
          by: ["status"],
          where: { program: { tenantId: viewer.tenantId, trainingType: { mode: "ONLINE" } } },
          _count: true,
        })
      : Promise.resolve([] as Array<{ status: string; _count: number }>),
  ]);

  const selected = sp.program
    ? programs.find((p) => p.id === sp.program)
    : undefined;

  const totalSpend = programs.reduce(
    (s, p) => s + n(p.costPerHead) * p._count.enrolments, 0,
  );
  const myPending = myEnrolments.filter((e) => e.status !== "COMPLETED" && e.status !== "WITHDRAWN");

  // Mandatory compliance programmes need a completion rate, not a list.
  const mandatory = programs.filter((p) => p.trainingType.mode === "ONLINE" || p.trainingType.name.includes("Compliance"));

  return (
    <>
      <PageHead
        title="Training"
        subtitle={`${programs.length} programmes · ${formatINRCompact(totalSpend)} committed spend`}
      />

      {myPending.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warning" title={`${myPending.length} training programme(s) assigned to you`}>
            {myPending.map((e) => e.program.title).join(" · ")}
          </Callout>
        </div>
      ) : null}

      {canEnrol ? (
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <Stat label="Programmes" value={programs.length} meta={`${programs.filter((p) => p.status === "IN_PROGRESS").length} running`} />
          <Stat label="Enrolments" value={programs.reduce((s, p) => s + p._count.enrolments, 0)} meta="Across all programmes" />
          <Stat
            label="Completed"
            value={complianceStats.find((c) => c.status === "COMPLETED")?._count ?? 0}
            meta="Online and compliance"
          />
          <Stat label="Committed spend" value={formatINRCompact(totalSpend)} meta="Cost per head × enrolled" />
        </div>
      ) : null}

      <div className="tabs">
        {canEnrol ? (
          <>
            <Link href="/training" className={`tab${tab === "programmes" ? " active" : ""}`}>Programmes</Link>
            <Link href="/training?tab=compliance" className={`tab${tab === "compliance" ? " active" : ""}`}>
              Compliance tracking
            </Link>
          </>
        ) : null}
        {myId ? (
          <Link href="/training?tab=mine" className={`tab${tab === "mine" ? " active" : ""}`}>
            My training{myPending.length > 0 ? ` (${myPending.length})` : ""}
          </Link>
        ) : null}
      </div>

      {tab === "programmes" && canEnrol ? (
        <div className="stack gap-4">
          <Card title={`Programmes (${programs.length})`} tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Programme</th><th>Type</th><th>Trainer</th><th>Dates</th>
                    <th className="num">Hours</th><th className="num">Seats</th>
                    <th className="num">Cost/head</th><th>Status</th><th>Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {programs.map((p) => {
                    const completed = p.enrolments.filter((e) => e.status === "COMPLETED").length;
                    const total = p._count.enrolments;
                    return (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/training?program=${p.id}`} className="strong">{p.title}</Link>
                          {p.description ? (
                            <div className="text-xs subtle" style={{ maxWidth: 300 }}>{p.description}</div>
                          ) : null}
                        </td>
                        <td className="text-sm">
                          {p.trainingType.name}
                          <div className="text-xs subtle">{p.trainingType.mode.toLowerCase()}</div>
                        </td>
                        <td className="text-sm">{p.trainer ?? "—"}</td>
                        <td className="text-sm nowrap">
                          {formatDate(p.startDate)}
                          {p.endDate ? <> → {formatDate(p.endDate)}</> : null}
                        </td>
                        <td className="num">{n(p.durationHours) || <span className="subtle">—</span>}</td>
                        <td className="num">
                          {p.maxSeats
                            ? <span className={total >= p.maxSeats ? "neg" : ""}>{total} / {p.maxSeats}</span>
                            : total}
                        </td>
                        <td className="num"><Money value={p.costPerHead} showZero={false} /></td>
                        <td><Badge tone={PROGRAM_TONE[p.status] ?? "neutral"} dot>{p.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                        <td style={{ minWidth: 130 }}>
                          {total === 0 ? <span className="subtle text-xs">No enrolments</span> : (
                            <>
                              <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 3 }}>
                                <span>{completed} / {total}</span>
                                <span className="num">{Math.round((completed / total) * 100)}%</span>
                              </div>
                              <Progress value={completed} max={total} tone={completed === total ? "success" : "warning"} />
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {selected ? (
            <Card
              title={`${selected.title} — enrolments (${selected._count.enrolments})`}
              description={
                selected.maxSeats
                  ? `${selected.maxSeats - selected._count.enrolments} seat(s) remaining`
                  : "No seat limit"
              }
              action={<Link className="btn sm" href="/training">Close</Link>}
              tight
            >
              <form action={enrolInTraining} style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
                <input type="hidden" name="programId" value={selected.id} />
                <div className="label">Enrol employees</div>
                <div
                  className="stack gap-1"
                  style={{
                    maxHeight: 190, overflowY: "auto", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)", padding: 10, marginBottom: 10,
                  }}
                >
                  {employees
                    .filter((e) => !selected.enrolments.some((en) => en.employeeId === e.id))
                    .map((e) => (
                      <label key={e.id} className="row gap-2 text-sm">
                        <input type="checkbox" name="employeeIds" value={e.id} />
                        {e.displayName} <span className="mono text-xs subtle">{e.employeeNumber}</span>
                      </label>
                    ))}
                </div>
                <button className="btn primary sm" type="submit">Enrol selected</button>
              </form>

              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Employee</th><th>Status</th><th>Progress</th><th className="num">Score</th><th>Completed</th></tr>
                  </thead>
                  <tbody>
                    {selected.enrolments.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Link href={`/employees/${e.employee.id}`}>
                            <Person
                              name={e.employee.displayName ?? ""}
                              meta={`${e.employee.employeeNumber} · ${e.employee.department?.name ?? "—"}`}
                            />
                          </Link>
                        </td>
                        <td><Badge tone={ENROL_TONE[e.status] ?? "neutral"}>{e.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                        <td style={{ minWidth: 130 }}>
                          <div className="row text-xs subtle" style={{ justifyContent: "space-between", marginBottom: 3 }}>
                            <span>{e.progressPercent}%</span>
                          </div>
                          <Progress value={e.progressPercent} max={100} tone={e.progressPercent === 100 ? "success" : undefined} />
                        </td>
                        <td className="num">{e.score ? n(e.score).toFixed(0) : <span className="subtle">—</span>}</td>
                        <td className="text-sm nowrap">{e.completedAt ? formatDate(e.completedAt) : <span className="subtle">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "compliance" && canEnrol ? (
        <div className="stack gap-4">
          <Callout tone="info" title="Mandatory compliance training">
            These programmes have to reach 100%. Anyone still outstanding is listed so they
            can be chased individually rather than by another all-staff email.
          </Callout>

          {mandatory.map((p) => {
            const enrolments = p.enrolments ?? [];
            const outstanding = enrolments.filter((e) => e.status !== "COMPLETED");
            const completed = enrolments.length - outstanding.length;
            return (
              <Card
                key={p.id}
                title={p.title}
                description={`${completed} of ${enrolments.length} complete · ${p.trainingType.name}`}
                action={
                  <Badge tone={outstanding.length === 0 ? "success" : "warning"}>
                    {enrolments.length === 0 ? "0%" : `${Math.round((completed / enrolments.length) * 100)}%`}
                  </Badge>
                }
                tight
              >
                <div style={{ padding: 14 }}>
                  <Progress
                    value={completed}
                    max={Math.max(1, enrolments.length)}
                    tone={outstanding.length === 0 ? "success" : "warning"}
                  />
                </div>
                {outstanding.length > 0 ? (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Outstanding</th><th>Status</th><th>Progress</th></tr></thead>
                      <tbody>
                        {outstanding.map((e) => (
                          <tr key={e.id}>
                            <td>
                              <Link href={`/employees/${e.employee.id}`}>
                                <Person name={e.employee.displayName ?? ""} meta={e.employee.department?.name} />
                              </Link>
                            </td>
                            <td><Badge tone={ENROL_TONE[e.status] ?? "neutral"}>{e.status.toLowerCase()}</Badge></td>
                            <td className="num">{e.progressPercent}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: "0 14px 14px" }}>
                    <Badge tone="success" dot>Everyone enrolled has completed this</Badge>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : null}

      {tab === "mine" && myId ? (
        <Card title={`My training (${myEnrolments.length})`} tight>
          {myEnrolments.length === 0 ? (
            <Empty title="No training assigned to you yet" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Programme</th><th>Type</th><th>Dates</th>
                    <th>Status</th><th>Progress</th><th>Update</th>
                  </tr>
                </thead>
                <tbody>
                  {myEnrolments.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span className="strong">{e.program.title}</span>
                        {e.program.durationHours ? (
                          <div className="text-xs subtle">{n(e.program.durationHours)} hours</div>
                        ) : null}
                      </td>
                      <td className="text-sm">{e.program.trainingType.name}</td>
                      <td className="text-sm nowrap">
                        {formatDate(e.program.startDate)}
                        {e.program.endDate ? <> → {formatDate(e.program.endDate)}</> : null}
                      </td>
                      <td><Badge tone={ENROL_TONE[e.status] ?? "neutral"} dot>{e.status.replace(/_/g, " ").toLowerCase()}</Badge></td>
                      <td style={{ minWidth: 120 }}>
                        <Progress value={e.progressPercent} max={100} tone={e.progressPercent === 100 ? "success" : undefined} />
                        <div className="text-xs subtle" style={{ marginTop: 3 }}>{e.progressPercent}%</div>
                      </td>
                      <td>
                        {e.status === "COMPLETED" ? (
                          <Badge tone="success">Done {formatDate(e.completedAt)}</Badge>
                        ) : (
                          <form action={updateTrainingProgress} className="row gap-1">
                            <input type="hidden" name="enrolmentId" value={e.id} />
                            <input
                              className="input num" name="progress" type="number" min="0" max="100"
                              defaultValue={e.progressPercent}
                              style={{ width: 66, padding: "3px 6px", fontSize: 12 }}
                            />
                            <button className="btn sm" type="submit">Save</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}
