import { prisma } from "@keka/db";
import { formatDate, fyStartYear, fyLabel, utcDate } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, Callout, KeyValue } from "@/components/ui";

const n = (v: unknown) => Number(v ?? 0);

export default async function MyLeavePage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <Callout tone="info" title="No employee record">This login is not linked to an employee record.</Callout>;
  }

  const employeeId = viewer.employee.id;
  const fyStart = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const yearStart = utcDate(fyStart, viewer.tenant.fyStartMonth, 1);

  const [balances, requests, holidays, plan] = await Promise.all([
    prisma.leaveBalance.findMany({
      where: { employeeId, yearStart },
      include: { leaveType: true },
      orderBy: { leaveType: { name: "asc" } },
    }),
    prisma.leaveRequest.findMany({
      where: { employeeId },
      include: { leaveType: { select: { name: true, isPaid: true } } },
      orderBy: { fromDate: "desc" },
      take: 15,
    }),
    prisma.holiday.findMany({
      where: {
        calendar: { tenantId: viewer.tenantId, year: new Date().getUTCFullYear() },
        date: { gte: new Date() },
      },
      orderBy: { date: "asc" },
      take: 8,
    }),
    prisma.leavePlanAssignment.findFirst({
      where: { employeeId },
      include: { plan: true },
      orderBy: { effectiveFrom: "desc" },
    }),
  ]);

  return (
    <>
      <PageHead
        title="My leave"
        subtitle={`${plan?.plan.name ?? "No plan assigned"} · leave year ${fyLabel(fyStart)}`}
      />

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Balances" description="Accrued, used and available for the current leave year">
          {balances.length === 0 ? (
            <Empty title="No leave balances yet">
              Balances appear once your leave plan accrues its first period.
            </Empty>
          ) : (
            <div className="stack gap-4">
              {balances.map((b) => (
                <div key={b.id}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <span className="row gap-2">
                      <span className="strong text-sm">{b.leaveType.name}</span>
                      <span className="mono text-xs subtle">{b.leaveType.code}</span>
                      {!b.leaveType.isPaid ? <Badge tone="danger">unpaid</Badge> : null}
                      {b.leaveType.encashmentEnabled ? <Badge tone="info">encashable</Badge> : null}
                    </span>
                    <span className="text-sm num">
                      <strong>{n(b.available).toFixed(1)}</strong>
                      <span className="subtle"> of {n(b.accrued).toFixed(1)} {b.leaveType.unit.toLowerCase()}</span>
                    </span>
                  </div>
                  <Progress
                    value={n(b.available)}
                    max={Math.max(1, n(b.accrued))}
                    tone={n(b.available) / Math.max(1, n(b.accrued)) > 0.5 ? "success" : "warning"}
                  />
                  <div className="text-xs subtle" style={{ marginTop: 4 }}>
                    Used {n(b.used).toFixed(1)} · carried forward {n(b.carriedForward).toFixed(1)}
                    {b.leaveType.maxConsecutiveDays ? ` · max ${n(b.leaveType.maxConsecutiveDays)} consecutive days` : ""}
                    {b.leaveType.yearEndAction !== "RESET"
                      ? ` · at year end: ${b.leaveType.yearEndAction.replace(/_/g, " ").toLowerCase()}`
                      : " · lapses at year end"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Upcoming holidays" tight>
          {holidays.length === 0 ? <Empty title="No upcoming holidays on the calendar" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th>Holiday</th><th>Type</th></tr></thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id}>
                      <td className="nowrap">{formatDate(h.date)}</td>
                      <td>{h.name}</td>
                      <td>
                        {h.isOptional
                          ? <Badge tone="info">optional — draws a floater</Badge>
                          : <Badge tone="success">public</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="My requests" tight>
          {requests.length === 0 ? <Empty title="No leave requests yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.leaveType.name}
                        {n(r.sandwichDays) > 0 ? (
                          <Badge tone="warning">+{n(r.sandwichDays).toFixed(1)} sandwich</Badge>
                        ) : null}
                      </td>
                      <td className="nowrap">{formatDate(r.fromDate)}</td>
                      <td className="nowrap">{formatDate(r.toDate)}</td>
                      <td className="num">{n(r.totalDays).toFixed(1)}</td>
                      <td>
                        <Badge tone={
                          r.status === "APPROVED" ? "success"
                          : r.status === "REJECTED" ? "danger"
                          : r.status === "PENDING" ? "warning" : "neutral"
                        }>
                          {r.status.toLowerCase()}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {plan ? (
          <Card title="My leave plan">
            <KeyValue items={[
              ["Plan", plan.plan.name],
              ["Leave year basis", plan.plan.yearBasis === "FINANCIAL_APR" ? "April to March"
                : plan.plan.yearBasis === "CALENDAR_JAN" ? "January to December"
                : "From your joining date"],
              ["Effective from", formatDate(plan.effectiveFrom)],
              ["Leave types", balances.length],
            ]} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
