import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Money, Person, Avatar, Stat, Callout } from "@/components/ui";
import { givePraise, grantAward, payAwardThroughPayroll } from "@/app/actions/workplace";

const P = PERMISSIONS;

const BADGES = [
  "Team Player", "Above and Beyond", "Great Mentor",
  "Sharp Thinking", "Unblocked Me", "Customer Hero",
];

export default async function AwardsPage() {
  const viewer = await requireAuth(P.AWARD_VIEW);
  const canGrant = can(viewer, P.AWARD_MANAGE);
  const canPraise = can(viewer, P.PRAISE_GIVE);
  const canPay = can(viewer, P.PAYROLL_RUN);

  const [awardTypes, awards, praises, employees, openRun] = await Promise.all([
    prisma.awardType.findMany({
      where: { tenantId: viewer.tenantId, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.employeeAward.findMany({
      where: { tenantId: viewer.tenantId, isPublished: true },
      orderBy: { awardedOn: "desc" },
      take: 30,
      include: {
        awardType: true,
        employee: {
          select: {
            id: true, displayName: true, employeeNumber: true, jobTitleName: true,
            department: { select: { name: true } },
          },
        },
      },
    }),
    prisma.praise.findMany({
      where: { tenantId: viewer.tenantId, isPublic: true },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        fromEmployee: { select: { id: true, displayName: true, jobTitleName: true } },
        toEmployee: { select: { id: true, displayName: true, jobTitleName: true } },
      },
    }),
    prisma.employee.findMany({
      where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED"] } },
      select: { id: true, displayName: true, employeeNumber: true },
      orderBy: { firstName: "asc" },
    }),
    canPay
      ? prisma.payrollRun.findFirst({
          where: { tenantId: viewer.tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] } },
          orderBy: [{ year: "desc" }, { month: "desc" }],
          select: { id: true, year: true, month: true },
        })
      : Promise.resolve(null),
  ]);

  const unpaidCash = awards.filter(
    (a) => a.cashAmount && Number(a.cashAmount) > 0 && !a.paidInRunId,
  );

  // Praise leaderboard for the current quarter.
  const quarterStart = new Date(Date.UTC(2026, 6, 1));
  const praiseCounts = new Map<string, { name: string; count: number }>();
  for (const p of praises) {
    if (p.createdAt < quarterStart) continue;
    const cur = praiseCounts.get(p.toEmployeeId) ?? { name: p.toEmployee.displayName ?? "", count: 0 };
    cur.count++;
    praiseCounts.set(p.toEmployeeId, cur);
  }
  const leaderboard = [...praiseCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  return (
    <>
      <PageHead
        title="Awards & recognition"
        subtitle={`${awards.length} awards granted · ${praises.length} praises on the wall`}
      />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Award types" value={awardTypes.length} meta="Monthly, quarterly, annual and spot" />
        <Stat label="Granted" value={awards.length} meta="Most recent 30 shown" />
        <Stat
          label="Cash awaiting payout"
          value={<Money value={unpaidCash.reduce((s, a) => s + Number(a.cashAmount), 0)} compact />}
          meta={`${unpaidCash.length} award(s)`}
        />
        <Stat label="Praises this quarter" value={[...praiseCounts.values()].reduce((s, v) => s + v.count, 0)} meta="Peer to peer" />
      </div>

      {canPay && unpaidCash.length > 0 && !openRun ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" title="No open payroll run">
            {unpaidCash.length} cash award(s) are waiting to be paid. Start a payroll run and
            they can be pushed in as ad-hoc payments.
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {/* ---- Praise wall ---- */}
        <div className="stack gap-4">
          {canPraise && viewer.employee ? (
            <Card title="Praise a colleague" description="Visible on the organisation wall.">
              <form action={givePraise} className="stack gap-3">
                <div className="row gap-2 wrap">
                  <select className="select" name="toEmployeeId" required style={{ maxWidth: 230 }}>
                    <option value="">Who deserves it?</option>
                    {employees
                      .filter((e) => e.id !== viewer.employee?.id)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.displayName} ({e.employeeNumber})
                        </option>
                      ))}
                  </select>
                  <select className="select" name="badge" style={{ maxWidth: 190 }}>
                    <option value="">No badge</option>
                    {BADGES.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <textarea
                  className="textarea" name="message" required rows={2}
                  placeholder="What did they do? Be specific — it means more."
                />
                <button className="btn primary" type="submit" style={{ alignSelf: "flex-start" }}>
                  Post praise
                </button>
              </form>
            </Card>
          ) : null}

          <Card title="Praise wall" tight>
            {praises.length === 0 ? (
              <Empty title="No praise yet">Be the first to recognise a colleague.</Empty>
            ) : (
              <div className="stack" style={{ padding: 14, gap: 14 }}>
                {praises.map((p) => (
                  <div key={p.id} className="row gap-3" style={{ alignItems: "flex-start" }}>
                    <Avatar name={p.fromEmployee.displayName ?? ""} size="sm" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="text-sm">
                        <Link href={`/employees/${p.fromEmployeeId}`} className="strong">
                          {p.fromEmployee.displayName}
                        </Link>
                        <span className="muted"> praised </span>
                        <Link href={`/employees/${p.toEmployeeId}`} className="strong">
                          {p.toEmployee.displayName}
                        </Link>
                        {p.badge ? <> <Badge tone="brand">{p.badge}</Badge></> : null}
                      </div>
                      <div className="text-sm" style={{ marginTop: 3 }}>{p.message}</div>
                      <div className="text-xs subtle" style={{ marginTop: 3 }}>
                        {formatDate(p.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {leaderboard.length > 0 ? (
            <Card title="Most praised this quarter" tight>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th className="num">Praises</th></tr></thead>
                  <tbody>
                    {leaderboard.map(([id, v]) => (
                      <tr key={id}>
                        <td><Link href={`/employees/${id}`}>{v.name}</Link></td>
                        <td className="num strong">{v.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>

        {/* ---- Awards ---- */}
        <div className="stack gap-4">
          {canGrant ? (
            <Card title="Grant an award">
              <form action={grantAward} className="stack gap-3">
                <div className="row gap-2 wrap">
                  <select className="select" name="awardTypeId" required style={{ maxWidth: 220 }}>
                    <option value="">Award type…</option>
                    {awardTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.cashAmount ? ` — ₹${Number(t.cashAmount).toLocaleString("en-IN")}` : ""}
                      </option>
                    ))}
                  </select>
                  <select className="select" name="employeeId" required style={{ maxWidth: 220 }}>
                    <option value="">Recipient…</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{e.displayName} ({e.employeeNumber})</option>
                    ))}
                  </select>
                  <input className="input" name="period" placeholder="Period, e.g. 2026-09" style={{ maxWidth: 150 }} />
                </div>
                <textarea className="textarea" name="citation" rows={2} placeholder="Citation — why they earned it" />
                <button className="btn primary" type="submit" style={{ alignSelf: "flex-start" }}>
                  Grant award
                </button>
              </form>
            </Card>
          ) : null}

          <Card title="Award types" tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Award</th><th>Cadence</th><th className="num">Cash</th><th className="num">Points</th></tr>
                </thead>
                <tbody>
                  {awardTypes.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="strong">{t.name}</span>
                        <div className="text-xs subtle">{t.description}</div>
                      </td>
                      <td><Badge tone="neutral">{t.cadence.toLowerCase()}</Badge></td>
                      <td className="num"><Money value={t.cashAmount} showZero={false} /></td>
                      <td className="num">{t.points ?? <span className="subtle">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Awards granted" tight>
            {awards.length === 0 ? <Empty title="No awards granted yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Recipient</th><th>Award</th><th>Period</th>
                      <th className="num">Cash</th><th>Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {awards.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link href={`/employees/${a.employeeId}`}>
                            <Person
                              name={a.employee.displayName ?? ""}
                              meta={a.employee.department?.name ?? a.employee.employeeNumber}
                            />
                          </Link>
                          {a.citation ? (
                            <div className="text-xs subtle" style={{ marginTop: 3, maxWidth: 320 }}>
                              {a.citation}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <span className="strong text-sm">{a.awardType.name}</span>
                          <div className="text-xs subtle">{formatDate(a.awardedOn)}</div>
                        </td>
                        <td className="text-sm">{a.period ?? <span className="subtle">—</span>}</td>
                        <td className="num"><Money value={a.cashAmount} showZero={false} /></td>
                        <td>
                          {!a.cashAmount || Number(a.cashAmount) === 0 ? (
                            <span className="subtle text-xs">No cash</span>
                          ) : a.paidInRunId ? (
                            <Badge tone="success">In payroll</Badge>
                          ) : canPay && openRun ? (
                            <form action={payAwardThroughPayroll}>
                              <input type="hidden" name="awardId" value={a.id} />
                              <button className="btn sm" type="submit">Pay in payroll</button>
                            </form>
                          ) : (
                            <Badge tone="warning">Pending payout</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
