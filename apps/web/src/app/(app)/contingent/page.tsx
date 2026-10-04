import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { orgNames, expiringContracts, contingentSpend, spendRollups, vendorScorecards } from "@/lib/workforce";
import { PageHead, Card, Stat, Empty, Badge } from "@/components/ui";
import { inr } from "@/components/workforce-tables";

/** Contingent workforce dashboard: expiry alerts, vendor compliance and spend. */
export default async function ContingentDashboard() {
  const viewer = await requireAuth(PERMISSIONS.CONTINGENT_VIEW);
  const t = viewer.tenantId;
  const [names, expiring, spend, cards, counts, pendingTs, pendingEx, vendors] = await Promise.all([
    orgNames(t), expiringContracts(t), contingentSpend(t), vendorScorecards(t),
    prisma.contingentWorker.groupBy({ by: ["status"], where: { tenantId: t }, _count: { _all: true } }),
    prisma.contractorTimesheet.count({ where: { tenantId: t, status: "SUBMITTED" } }),
    prisma.contractorExpense.count({ where: { tenantId: t, status: "SUBMITTED" } }),
    prisma.contingentVendor.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
  ]);
  const roll = spendRollups(spend, { vendor: new Map(vendors.map((v) => [v.id, v.name])), dept: names.dept });
  const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const nonCompliant = cards.filter((c) => !c.compliance.compliant || c.compliance.expiringSoon.length > 0);
  return (
    <>
      <PageHead title="Contingent workforce" subtitle="Contractors and agency workers — never on payroll — with their contracts, vendors and spend." actions={<>
        <a className="btn sm" href="/contingent/export?report=expiring">Expiring CSV</a><a className="btn sm" href="/contingent/export?report=spend">Spend CSV</a>
      </>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Active workers" value={count("ACTIVE")} meta={`${count("PENDING_APPROVAL")} awaiting approval`} />
        <Stat label="Contracts ending ≤ 30 days" value={expiring.filter((e) => e.expiry.state !== "EXPIRED").length} meta={`${expiring.filter((e) => e.expiry.state === "EXPIRED").length} past end date`} tone={expiring.length ? "neg" : undefined} />
        <Stat label="Approved spend" value={inr(roll.total)} meta="timesheets, expenses, paid milestones" />
        <Stat label="Waiting on managers" value={pendingTs + pendingEx} meta={`${pendingTs} timesheets · ${pendingEx} expenses`} />
      </div>
      <Card title="Contract expiry alerts" description="Managers and contingent admins are also notified once when a contract enters its last 30 days (nightly job).">
        {expiring.length === 0 ? <Empty title="No contracts end in the next 30 days." /> : (
          <table className="data"><thead><tr><th>Worker</th><th>Role</th><th>Ends</th><th className="num">Days</th><th>Alert</th></tr></thead>
            <tbody>{expiring.map((a) => (
              <tr key={a.id}><td><Link href={`/contingent/workers/${a.worker.id}`}>{a.worker.code}</Link> {a.worker.firstName} {a.worker.lastName}</td><td>{a.role}</td><td>{formatDate(a.endDate)}</td><td className="num">{a.expiry.days}</td>
                <td><Badge tone={a.expiry.state === "EXPIRED" || a.expiry.state === "EXPIRING_7" ? "danger" : "warning"}>{a.expiry.state.replace("_", " ").toLowerCase()}</Badge>{a.alertedAt ? <span className="text-xs muted"> notified {formatDate(a.alertedAt)}</span> : null}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
      <div className="grid grid-2">
        <Card title="Vendor compliance" description="Required: MSA, GST certificate, PAN, insurance — present and in date.">
          {cards.length === 0 ? <Empty title="No vendors yet." /> : nonCompliant.length === 0 ? <Empty title="Every vendor is compliant." /> : (
            <table className="data"><thead><tr><th>Vendor</th><th>Missing</th><th>Expired</th><th>Expiring ≤ 30 days</th></tr></thead>
              <tbody>{nonCompliant.map((c) => <tr key={c.id}><td><Link href={`/contingent/vendors/${c.id}`}>{c.name}</Link></td><td className="text-xs">{c.compliance.missing.join(", ")}</td><td className="text-xs">{c.compliance.expired.join(", ")}</td><td className="text-xs">{c.compliance.expiringSoon.join(", ")}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Vendor scorecards">
          {cards.length === 0 ? <Empty title="No vendors yet." /> : (
            <table className="data"><thead><tr><th>Vendor</th><th className="num">Active</th><th className="num">Avg rating</th><th className="num">Score</th><th>Grade</th></tr></thead>
              <tbody>{cards.map((c) => <tr key={c.id}><td><Link href={`/contingent/vendors/${c.id}`}>{c.name}</Link></td><td className="num">{c.activeWorkers}</td><td className="num">{c.avgRating ?? "—"}</td><td className="num">{c.score}</td><td><Badge>{c.grade}</Badge></td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <Card title="Contingent spend analytics">
        {roll.total === 0 ? <Empty title="No approved spend yet." /> : (
          <div className="grid grid-3">
            {([["By vendor", roll.byVendor], ["By department", roll.byDepartment], ["By type", roll.byType]] as const).map(([title, rows]) => (
              <div key={title}><div className="label">{title}</div>
                <table className="data"><tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{inr(r.amount)}</td></tr>)}</tbody></table></div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
