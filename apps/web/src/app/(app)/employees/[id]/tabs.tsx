import Link from "next/link";
import { prisma } from "@keka/db";
import { formatDate } from "@keka/shared";
import { EMPLOYEE_VISIBLE, LETTER_STATUS_LABEL, attendanceByPerson, isAbsence, type DayRecord } from "@keka/services";
import { Card, Badge, Empty, Money, Stat, Progress } from "@/components/ui";

/**
 * The module tabs on an employee's profile: Time, Documents, Assets,
 * Expenses and Performance. Each reads that one employee's rows with the
 * same queries the Me pages use; the page decides which tabs a viewer may
 * open (by module permission over this employee) before rendering any.
 */

const DAY = 86_400_000;
const lower = (s: string) => s.replace(/_/g, " ").toLowerCase();
const num = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

// ---------------------------------------------------------------------------
//  Time
// ---------------------------------------------------------------------------

const ATT_TONE: Record<string, Tone> = {
  PRESENT: "success", WORK_FROM_HOME: "info", ON_DUTY: "info", HALF_DAY: "warning", ABSENT: "danger", NO_ATTENDANCE: "danger",
  ON_LEAVE: "brand", WEEKLY_OFF: "neutral", HOLIDAY: "neutral",
};
const LEAVE_TONE: Record<string, Tone> = { PENDING: "warning", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral", WITHDRAWN: "neutral" };
const hhmm = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : "—");

/** Attendance over the last 30 processed days, the recent days themselves, and leave. */
export async function TimeTab({ tenantId, employeeId, attendance, leave, isSelf }: { tenantId: string; employeeId: string; attendance: boolean; leave: boolean; isSelf: boolean }) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(today.getTime() - 30 * DAY);
  const [records, balances, requests] = await Promise.all([
    attendance
      ? prisma.attendanceRecord.findMany({
          where: { tenantId, employeeId, date: { gte: since, lt: today } },
          select: { date: true, status: true, firstIn: true, lastOut: true, effectiveHours: true, penaltyReason: true, lopValue: true, isRegularised: true },
          orderBy: { date: "desc" },
        })
      : Promise.resolve([]),
    leave ? prisma.leaveBalance.findMany({ where: { employeeId, leaveType: { tenantId } }, include: { leaveType: { select: { name: true, code: true } } }, orderBy: { yearStart: "desc" } }) : Promise.resolve([]),
    leave ? prisma.leaveRequest.findMany({ where: { tenantId, employeeId }, include: { leaveType: { select: { name: true } } }, orderBy: { fromDate: "desc" }, take: 10 }) : Promise.resolve([]),
  ]);
  const days: DayRecord[] = records.map((r) => ({ employeeId, date: r.date, status: r.status, effectiveHours: Number(r.effectiveHours), lop: Number(r.lopValue), late: !!r.penaltyReason && /late/i.test(r.penaltyReason) }));
  const stats = attendanceByPerson(days)[0];
  const lop = Math.round(days.reduce((s, r) => s + r.lop, 0) * 10) / 10;
  // The current leave year's balances: the latest year any balance exists for.
  const year = balances[0]?.yearStart.getTime();
  const current = balances.filter((b) => b.yearStart.getTime() === year);

  return (
    <div className="stack gap-4">
      {attendance ? (
        <>
          <div className="grid grid-4">
            <Stat label="Attendance rate" value={stats ? `${stats.rate}%` : "—"} meta={stats ? `${stats.workdays} working days in the last 30` : "No processed days in the last 30"} tone={stats && stats.rate < 85 ? "neg" : undefined} />
            <Stat label="Average hours" value={stats ? `${stats.hours} h` : "—"} meta="Effective hours on days worked" />
            <Stat label="Absent days" value={days.filter((d) => isAbsence(d.status)).length} meta={`${lop} day${lop === 1 ? "" : "s"} loss of pay`} tone={lop > 0 ? "neg" : undefined} />
            <Stat label="Late marks" value={stats?.late ?? 0} meta="From the late-arrival policy" />
          </div>
          <Card title="Recent days" description="Processed attendance, newest first." tight action={isSelf ? <Link className="btn sm" href="/me/attendance">My attendance</Link> : null}>
            {records.length === 0 ? <Empty title="No processed attendance in the last 30 days" /> : (
              <div className="table-wrap">
                <table className="data" data-section="attendance">
                  <thead><tr><th>Date</th><th>Status</th><th>First in</th><th>Last out</th><th className="num">Effective hours</th><th>Note</th></tr></thead>
                  <tbody>
                    {records.slice(0, 14).map((r) => (
                      <tr key={r.date.toISOString()}>
                        <td className="nowrap">{formatDate(r.date)}</td>
                        <td><Badge tone={ATT_TONE[r.status] ?? "neutral"}>{lower(r.status)}</Badge>{r.isRegularised ? <span className="text-xs subtle"> · regularised</span> : null}</td>
                        <td className="mono text-sm">{hhmm(r.firstIn)}</td>
                        <td className="mono text-sm">{hhmm(r.lastOut)}</td>
                        <td className="num">{num(r.effectiveHours)}</td>
                        <td className="text-sm muted">{r.penaltyReason ?? (Number(r.lopValue) ? `LOP ${num(r.lopValue)}` : "")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
      {leave ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <Card title="Leave balances" description={current[0] ? `Leave year from ${formatDate(current[0].yearStart)}` : undefined} tight action={isSelf ? <Link className="btn sm" href="/me/leave">My leave</Link> : null}>
            {current.length === 0 ? <Empty title="No leave balances yet" /> : (
              <div className="table-wrap">
                <table className="data" data-section="leave-balances">
                  <thead><tr><th>Leave type</th><th className="num">Accrued</th><th className="num">Used</th><th className="num">Available</th></tr></thead>
                  <tbody>
                    {current.map((b) => (
                      <tr key={b.id}><td>{b.leaveType.name}</td><td className="num">{num(Number(b.opening) + Number(b.accrued) + Number(b.carriedForward))}</td><td className="num">{num(b.used)}</td><td className="num strong">{num(b.available)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Recent leave" tight>
            {requests.length === 0 ? <Empty title="No leave requests" /> : (
              <div className="table-wrap">
                <table className="data" data-section="leave-requests">
                  <thead><tr><th>Type</th><th>Dates</th><th className="num">Days</th><th>Status</th></tr></thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id}>
                        <td>{r.leaveType.name}</td>
                        <td className="nowrap text-sm">{formatDate(r.fromDate)}{r.toDate.getTime() !== r.fromDate.getTime() ? ` – ${formatDate(r.toDate)}` : ""}</td>
                        <td className="num">{num(r.totalDays)}</td>
                        <td><Badge tone={LEAVE_TONE[r.status] ?? "neutral"}>{lower(r.status)}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

const DOC_TONE: Record<string, Tone> = { VERIFIED: "success", PENDING_VERIFICATION: "warning", PENDING_ON_EMPLOYEE: "warning", REJECTED: "danger", EXPIRED: "danger", NOT_APPLICABLE: "neutral" };
const LETTER_TONE: Record<string, Tone> = { ISSUED: "success", SIGNED: "success", ACKNOWLEDGED: "success", PENDING_SIGNATURE: "warning", PENDING_ACKNOWLEDGEMENT: "warning", PENDING_APPROVAL: "warning", REJECTED: "danger", VOID: "neutral" };

/**
 * The employee's documents and letters. Files in confidential folders are
 * only listed to the employee and to document managers; letters only to the
 * employee (once issued to them) and to people who may generate theirs.
 */
export async function DocumentsTab({ tenantId, employeeId, isSelf, seeConfidential, seeAllLetters }: { tenantId: string; employeeId: string; isSelf: boolean; seeConfidential: boolean; seeAllLetters: boolean }) {
  const [docs, letters] = await Promise.all([
    prisma.employeeDocument.findMany({
      where: { tenantId, employeeId, ...(isSelf || seeConfidential ? {} : { OR: [{ folderId: null }, { folder: { isConfidential: false } }] }) },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { documentType: { select: { name: true, isMandatory: true } }, folder: { select: { name: true, isConfidential: true } } },
    }),
    isSelf || seeAllLetters
      ? prisma.generatedDocument.findMany({
          where: { employeeId, employee: { tenantId }, ...(seeAllLetters ? {} : { status: { in: EMPLOYEE_VISIBLE } }) },
          orderBy: { issuedOn: "desc" },
          include: { template: { select: { name: true } } },
        })
      : Promise.resolve(null),
  ]);
  const soon = new Date(Date.now() + 90 * DAY);
  return (
    <div className="stack gap-4">
      <Card title={`Documents (${docs.length})`} tight action={isSelf ? <Link className="btn sm" href="/documents?tab=mine">My documents</Link> : null}>
        {docs.length === 0 ? <Empty title="No documents on file" /> : (
          <div className="table-wrap">
            <table className="data" data-section="documents">
              <thead><tr><th>Document</th><th>Folder</th><th>Status</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td><span className="strong">{d.documentType?.name ?? d.name}</span>{d.documentType?.isMandatory ? <span className="text-xs subtle"> · mandatory</span> : null}{d.documentType && d.name !== d.documentType.name ? <div className="text-xs subtle">{d.name}</div> : null}</td>
                    <td className="text-sm">{d.folder?.name ?? "—"}{d.folder?.isConfidential ? <> <Badge tone="danger">confidential</Badge></> : null}</td>
                    <td><Badge tone={DOC_TONE[d.status] ?? "neutral"}>{lower(d.status)}</Badge>{d.rejectReason ? <div className="text-xs subtle">{d.rejectReason}</div> : null}</td>
                    <td className={`nowrap text-sm ${d.expiresOn && d.expiresOn < soon ? "neg" : ""}`}>{d.expiresOn ? formatDate(d.expiresOn) : "—"}</td>
                    <td className="right">{d.fileUrl?.startsWith("/files/") ? <a className="btn sm ghost" href={d.fileUrl}>View</a> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {letters ? (
        <Card title={`Letters (${letters.length})`} tight>
          {letters.length === 0 ? <Empty title="No letters issued" /> : (
            <div className="table-wrap">
              <table className="data" data-section="letters">
                <thead><tr><th>Letter</th><th>Issued</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {letters.map((l) => (
                    <tr key={l.id}>
                      <td className="strong">{l.template.name}</td>
                      <td className="nowrap text-sm">{formatDate(l.issuedOn)}</td>
                      <td><Badge tone={LETTER_TONE[l.status] ?? "neutral"}>{LETTER_STATUS_LABEL[l.status] ?? lower(l.status)}</Badge></td>
                      <td className="right"><Link className="btn sm ghost" href={`/documents/letters/${l.id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Assets
// ---------------------------------------------------------------------------

/** What the employee holds now, and what they have handed back. */
export async function AssetsTab({ tenantId, employeeId, isSelf, seeValue }: { tenantId: string; employeeId: string; isSelf: boolean; seeValue: boolean }) {
  const rows = await prisma.assetAssignment.findMany({
    where: { employeeId, asset: { tenantId } },
    include: { asset: { select: { id: true, assetTag: true, name: true, serialNumber: true, purchaseCost: true, assetType: { select: { name: true } } } } },
    orderBy: [{ returnedOn: { sort: "desc", nulls: "first" } }, { assignedOn: "desc" }],
  });
  const held = rows.filter((r) => !r.returnedOn);
  const returned = rows.filter((r) => r.returnedOn);
  const assetName = (r: (typeof rows)[number]) => r.asset.name ?? r.asset.assetType.name;
  return (
    <div className="stack gap-4">
      <Card title={`Assigned assets (${held.length})`} tight action={isSelf ? <Link className="btn sm" href="/assets/assigned">My assets</Link> : null}>
        {held.length === 0 ? <Empty title="No assets assigned" /> : (
          <div className="table-wrap">
            <table className="data" data-section="assets">
              <thead><tr><th>Asset</th><th>Type</th><th>Assigned</th><th>Condition</th><th>Acknowledgement</th>{seeValue ? <th className="num">Cost</th> : null}</tr></thead>
              <tbody>
                {held.map((r) => (
                  <tr key={r.id}>
                    <td><span className="strong">{assetName(r)}</span><div className="mono text-xs subtle">{r.asset.assetTag}{r.asset.serialNumber ? ` · ${r.asset.serialNumber}` : ""}</div></td>
                    <td className="text-sm">{r.asset.assetType.name}</td>
                    <td className="nowrap text-sm">{formatDate(r.assignedOn)}</td>
                    <td className="text-sm">{lower(r.conditionOut)}</td>
                    <td><Badge tone={r.ackStatus === "ACKNOWLEDGED" ? "success" : r.ackStatus === "PENDING" ? "warning" : "neutral"}>{lower(r.ackStatus)}</Badge></td>
                    {seeValue ? <td className="num">{r.asset.purchaseCost ? <Money value={r.asset.purchaseCost} /> : "—"}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {returned.length ? (
        <Card title={`Returned (${returned.length})`} tight>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Asset</th><th>Assigned</th><th>Returned</th><th>Condition</th><th className="num">Damage charge</th></tr></thead>
              <tbody>
                {returned.map((r) => (
                  <tr key={r.id}>
                    <td><span className="strong">{assetName(r)}</span><div className="mono text-xs subtle">{r.asset.assetTag}</div></td>
                    <td className="nowrap text-sm">{formatDate(r.assignedOn)}</td>
                    <td className="nowrap text-sm">{formatDate(r.returnedOn)}</td>
                    <td className="text-sm">{r.conditionIn ? lower(r.conditionIn) : "—"}</td>
                    <td className="num">{r.damageCharge ? <Money value={r.damageCharge} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Expenses
// ---------------------------------------------------------------------------

const STAGE_TONE: Record<string, Tone> = { DRAFT: "neutral", SUBMITTED: "warning", PARTIALLY_APPROVED: "warning", APPROVED: "info", PAYMENT_PENDING: "info", PAID: "success", REJECTED: "danger", CANCELLED: "neutral" };
const APPROVED = ["APPROVED", "PARTIALLY_APPROVED", "PAYMENT_PENDING", "PAID"];

/** Expense claims, newest first. Other people's drafts stay private to them. */
export async function ExpensesTab({ tenantId, employeeId, isSelf }: { tenantId: string; employeeId: string; isSelf: boolean }) {
  const claims = await prisma.expenseClaim.findMany({
    where: { tenantId, employeeId, ...(isSelf ? {} : { stage: { not: "DRAFT" } }) },
    select: { id: true, claimNumber: true, title: true, stage: true, claimedTotal: true, approvedTotal: true, submittedAt: true, createdAt: true, paidAt: true, _count: { select: { lines: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const waiting = claims.filter((c) => c.stage === "SUBMITTED" || c.stage === "PARTIALLY_APPROVED");
  const approved = claims.filter((c) => APPROVED.includes(c.stage));
  const unpaid = claims.filter((c) => c.stage === "APPROVED" || c.stage === "PAYMENT_PENDING");
  const sum = (list: typeof claims, k: "claimedTotal" | "approvedTotal") => list.reduce((s, c) => s + Number(c[k]), 0);
  return (
    <div className="stack gap-4">
      <div className="grid grid-3">
        <Stat label="Waiting for approval" value={waiting.length} meta={<Money value={sum(waiting, "claimedTotal")} />} />
        <Stat label="Approved" value={<Money value={sum(approved, "approvedTotal")} />} meta={`${approved.length} claim${approved.length === 1 ? "" : "s"}`} />
        <Stat label="Approved, not yet paid" value={unpaid.length} meta={<Money value={sum(unpaid, "approvedTotal")} />} />
      </div>
      <Card title="Expense claims" tight action={isSelf ? <Link className="btn sm" href="/me/expenses">My expenses</Link> : null}>
        {claims.length === 0 ? <Empty title="No expense claims" /> : (
          <div className="table-wrap">
            <table className="data" data-section="expenses">
              <thead><tr><th>Claim</th><th>Submitted</th><th className="num">Lines</th><th className="num">Claimed</th><th className="num">Approved</th><th>Stage</th></tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td><Link className="strong" href={`/expenses/${c.id}`}>{c.title}</Link><div className="mono text-xs subtle">{c.claimNumber}</div></td>
                    <td className="nowrap text-sm">{c.submittedAt ? formatDate(c.submittedAt) : <span className="subtle">not submitted</span>}</td>
                    <td className="num">{c._count.lines}</td>
                    <td className="num"><Money value={c.claimedTotal} /></td>
                    <td className="num">{APPROVED.includes(c.stage) ? <Money value={c.approvedTotal} /> : <span className="subtle">—</span>}</td>
                    <td><Badge tone={STAGE_TONE[c.stage] ?? "neutral"}>{lower(c.stage)}</Badge>{c.paidAt ? <div className="text-xs subtle">paid {formatDate(c.paidAt)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Performance
// ---------------------------------------------------------------------------

const GOAL_TONE: Record<string, Tone> = { DRAFT: "neutral", NOT_STARTED: "neutral", ON_TRACK: "success", BEHIND: "warning", AT_RISK: "danger", COMPLETED: "info", MISSED: "danger", CANCELLED: "neutral" };
const REVIEW_TONE: Record<string, Tone> = { NOT_STARTED: "neutral", SELF_REVIEW: "warning", MANAGER_REVIEW: "warning", PEER_REVIEW: "warning", CALIBRATION: "info", SHARED: "success", ACKNOWLEDGED: "success" };
const MEETING_TONE: Record<string, Tone> = { SCHEDULED: "info", COMPLETED: "success", CANCELLED: "neutral" };

/**
 * Goals, reviews and 1:1s. A rating is shown to the employee only once it is
 * shared with them; reviewers with performance visibility see it as the
 * review page does. 1:1s are listed only to the employee and to managers up
 * their line, because HR rights do not open other people's 1:1s.
 */
export async function PerformanceTab({ tenantId, employeeId, isSelf, seeOneOnOnes }: { tenantId: string; employeeId: string; isSelf: boolean; seeOneOnOnes: boolean }) {
  const now = new Date();
  const [goals, reviews, meetings] = await Promise.all([
    prisma.goal.findMany({
      where: { tenantId, employeeId, status: { not: "CANCELLED" } },
      select: { id: true, title: true, status: true, statusOverride: true, progressPercent: true, dueDate: true, goalType: { select: { name: true } } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    }),
    prisma.employeeReview.findMany({
      where: { employeeId, cycle: { tenantId, status: { not: "CANCELLED" } } },
      select: { id: true, status: true, finalRating: true, band: { select: { name: true } }, cycle: { select: { name: true, periodStart: true, periodEnd: true } } },
      orderBy: [{ cycle: { periodEnd: "desc" } }, { createdAt: "desc" }],
    }),
    seeOneOnOnes
      ? prisma.meeting.findMany({
          where: { tenantId, meetingType: "ONE_ON_ONE", OR: [{ organiserId: employeeId }, { attendees: { some: { employeeId } } }] },
          select: { id: true, title: true, startsAt: true, status: true, organiserId: true, attendees: { select: { employeeId: true, employee: { select: { displayName: true } } } } },
          orderBy: { startsAt: "desc" },
          take: 10,
        })
      : Promise.resolve(null),
  ]);
  const avg = goals.length ? Math.round(goals.reduce((s, g) => s + Number(g.progressPercent), 0) / goals.length) : 0;
  return (
    <div className="stack gap-4">
      <Card title={`Goals (${goals.length})`} description={goals.length ? `Average progress ${avg}%` : undefined} tight action={isSelf ? <Link className="btn sm" href="/me/performance">My performance</Link> : null}>
        {goals.length === 0 ? <Empty title="No goals set" /> : (
          <div className="table-wrap">
            <table className="data" data-section="goals">
              <thead><tr><th>Goal</th><th>Due</th><th style={{ width: 180 }}>Progress</th><th>Status</th></tr></thead>
              <tbody>
                {goals.map((g) => {
                  const st = g.statusOverride ?? g.status;
                  return (
                    <tr key={g.id}>
                      <td><span className="strong">{g.title}</span>{g.goalType ? <div className="text-xs subtle">{g.goalType.name}</div> : null}</td>
                      <td className={`nowrap text-sm ${g.dueDate < now && !["COMPLETED", "MISSED"].includes(st) ? "neg" : ""}`}>{formatDate(g.dueDate)}</td>
                      <td><div className="row gap-2"><div style={{ flex: 1 }}><Progress value={Number(g.progressPercent)} /></div><span className="text-sm num">{Math.round(Number(g.progressPercent))}%</span></div></td>
                      <td><Badge tone={GOAL_TONE[st] ?? "neutral"}>{lower(st)}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title={`Reviews (${reviews.length})`} tight>
        {reviews.length === 0 ? <Empty title="No reviews yet" /> : (
          <div className="table-wrap">
            <table className="data" data-section="reviews">
              <thead><tr><th>Review cycle</th><th>Period</th><th>Status</th><th>Rating</th><th /></tr></thead>
              <tbody>
                {reviews.map((r) => {
                  const shared = ["SHARED", "ACKNOWLEDGED"].includes(r.status);
                  const showRating = r.finalRating !== null && (!isSelf || shared);
                  return (
                    <tr key={r.id}>
                      <td className="strong">{r.cycle.name}</td>
                      <td className="nowrap text-sm">{formatDate(r.cycle.periodStart)} – {formatDate(r.cycle.periodEnd)}</td>
                      <td><Badge tone={REVIEW_TONE[r.status] ?? "neutral"}>{lower(r.status)}</Badge></td>
                      <td>{showRating ? <><span className="strong">{num(r.finalRating)}</span>{r.band ? <div className="text-xs subtle">{r.band.name}</div> : null}</> : <span className="subtle">{isSelf && r.finalRating !== null ? "Shared when the cycle closes" : "—"}</span>}</td>
                      <td className="right"><Link className="btn sm ghost" href={`/performance/reviews/${r.id}`}>View</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {meetings ? (
        <Card title="1:1 meetings" tight action={isSelf ? <Link className="btn sm" href="/performance/one-on-ones">My 1:1s</Link> : null}>
          {meetings.length === 0 ? <Empty title="No 1:1s yet" /> : (
            <div className="table-wrap">
              <table className="data" data-section="one-on-ones">
                <thead><tr><th>Meeting</th><th>With</th><th>When</th><th>Status</th></tr></thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id}>
                      <td><Link className="strong" href={`/performance/one-on-ones/${m.id}`}>{m.title}</Link></td>
                      <td className="text-sm">{m.attendees.filter((a) => a.employeeId !== employeeId).map((a) => a.employee.displayName).join(", ") || "—"}</td>
                      <td className="nowrap text-sm">{formatDate(m.startsAt)} {m.startsAt.toISOString().slice(11, 16)}</td>
                      <td><Badge tone={MEETING_TONE[m.status] ?? "neutral"}>{lower(m.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
