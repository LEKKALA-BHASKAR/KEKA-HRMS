import Link from "next/link";
import { PERMISSIONS } from "@keka/rbac";
import { fyLabel, formatINR } from "@keka/shared";
import { statutoryBonusReport, currentFy } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Stat, Badge, Callout } from "@/components/ui";
import { IconDownload } from "@/components/icons";

const P = PERMISSIONS;

/**
 * Statutory bonus under the Payment of Bonus Act, worked out from finalised
 * payroll: who is eligible, the bonus wage counted, and the bonus at the
 * configured rate and at the 20% maximum.
 */
export default async function StatutoryBonusPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const sp = await searchParams;
  const fy = Number(sp.fy) || currentFy(new Date(), viewer.tenant.fyStartMonth) - 1;
  const rep = await statutoryBonusReport(viewer.tenantId, fy);
  const c = rep.config;

  return (
    <>
      <PageHead title="Statutory bonus" subtitle={`Payment of Bonus Act — accounting year ${fyLabel(fy)}`}
        actions={<>
          <Link className="btn sm" href={`/payroll/statutory-bonus?fy=${fy - 1}`}>‹ {fyLabel(fy - 1)}</Link>
          <Link className="btn sm" href={`/payroll/statutory-bonus?fy=${fy + 1}`}>{fyLabel(fy + 1)} ›</Link>
          <Link className="btn" href="/payroll/settings">Settings</Link>
          <a className="btn primary" href={`/payroll/statutory-bonus/export?fy=${fy}`}><IconDownload width={15} height={15} />CSV</a>
        </>} />
      {!c.enabled ? <Callout tone="warning" title="Switched off">Payroll settings say the Act does not apply to this company; the figures below are for reference.</Callout> : null}
      <Callout tone="info" title="How it is worked out">
        Months with a wage (basic + DA as configured) at or under ₹{c.eligibilityCeiling.toLocaleString("en-IN")} count; each is counted at no more than
        ₹{Math.max(c.calculationCeiling, c.minimumWage ?? 0).toLocaleString("en-IN")}{c.minimumWage && c.minimumWage > c.calculationCeiling ? " (the minimum wage)" : ""}.
        The bonus is {c.percent}% of that, for employees who worked at least {c.minWorkingDays} days. Pay it through Bonuses once the allocable surplus fixes the rate.
      </Callout>
      <div className="grid grid-4" style={{ margin: "14px 0" }}>
        <Stat label="Employees paid in the year" value={rep.totals.employees} />
        <Stat label="Eligible" value={rep.totals.eligible} />
        <Stat label={`Bonus at ${c.percent}%`} value={formatINR(rep.totals.bonus, false)} meta={`on ${formatINR(rep.totals.bonusWage, false)} bonus wage`} />
        <Stat label="At the 20% maximum" value={formatINR(rep.totals.maxBonus, false)} />
      </div>
      <Card tight>
        {rep.rows.length === 0 ? <Empty title="No finalised payroll in this year" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Department</th><th>Eligible</th><th className="num">Days worked</th><th className="num">Eligible months</th><th className="num">Bonus wage</th><th className="num">Bonus at {c.percent}%</th><th className="num">At 20%</th></tr></thead>
              <tbody>
                {rep.rows.map((r) => (
                  <tr key={r.employeeId}>
                    <td><span className="mono text-xs">{r.employeeNumber}</span> <span className="strong">{r.name}</span></td>
                    <td className="text-xs">{r.department}</td>
                    <td>{r.eligible ? <Badge tone="success">Eligible</Badge> : <span className="text-xs subtle">{r.reason}</span>}</td>
                    <td className="num">{r.daysWorked}</td>
                    <td className="num">{r.eligibleMonths}</td>
                    <td className="num">{formatINR(r.bonusWage, false)}</td>
                    <td className="num strong">{r.eligible ? formatINR(r.bonus, false) : "—"}</td>
                    <td className="num">{r.eligible ? formatINR(r.maxBonus, false) : "—"}</td>
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
