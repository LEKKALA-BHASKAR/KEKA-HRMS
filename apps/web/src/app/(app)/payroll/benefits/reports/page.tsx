import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { benefitReport, benefitForecast, eligibilityMatrix } from "@keka/services";
import { formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Badge } from "@/components/ui";

const BENEFIT_REPORTS = { enrollments: "Enrolments", plans: "Plans", dependents: "Dependents", deductions: "Payroll deductions", eligibility: "Eligibility" } as const;
type Kind = keyof typeof BENEFIT_REPORTS;
const show = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" ? v.toLocaleString("en-IN") : v === null || v === undefined ? "" : String(v));

/** Benefit reports, the cost forecast, the eligibility matrix and the audit trail. */
export default async function BenefitReportsPage({ searchParams }: { searchParams: Promise<{ report?: string; inflation?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.BENEFIT_MANAGE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const kind: Kind = sp.report && sp.report in BENEFIT_REPORTS ? (sp.report as Kind) : "enrollments";
  const inflation = Math.min(100, Math.max(0, Number(sp.inflation ?? 10) || 0));
  const [report, active, matrix, audit] = await Promise.all([
    benefitReport(t, kind),
    prisma.benefitEnrollment.findMany({ where: { tenantId: t, status: "ACTIVE" }, select: { planId: true, employeeMonthly: true, employerMonthly: true, plan: { select: { name: true } } } }),
    eligibilityMatrix(t),
    prisma.auditLog.findMany({ where: { tenantId: t, entityType: { in: ["BenefitPlan", "BenefitEnrollment", "BenefitEnrollmentWindow", "BenefitDeduction", "BenefitCarrierFile", "BenefitEligibilityException", "BenefitLifeEvent", "DependentRequest", "Dependent", "BenefitReport"] } }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  const planName = new Map(active.map((a) => [a.planId, a.plan.name]));
  const forecast = benefitForecast(active.map((a) => ({ planId: a.planId, employer: Number(a.employerMonthly), employee: Number(a.employeeMonthly) })), 12, inflation);
  return (
    <>
      <PageHead title="Benefit reports" subtitle="Enrolment, cost and eligibility" actions={<><Link className="btn" href="/payroll/benefits">Plans</Link><Link className="btn" href="/payroll/benefits/enrolment">Enrolments</Link></>} />
      <Card tight title="Cost forecast, next 12 months" description="Current members at current premiums, plus a premium inflation assumption for renewal."
        action={<form className="row gap-2" method="get"><input type="hidden" name="report" value={kind} /><input className="input" name="inflation" type="number" defaultValue={inflation} style={{ width: 80 }} /><button className="btn sm">% inflation</button></form>}>
        {forecast.length === 0 ? <Empty title="No active members" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Plan</th><th className="num">Members</th><th className="num">Employer / yr</th><th className="num">Employee / yr</th><th className="num">Employer after renewal</th><th className="num">Total after renewal</th></tr></thead>
            <tbody>{forecast.map((f) => <tr key={f.planId}><td>{planName.get(f.planId)}</td><td className="num">{f.members}</td><td className="num">{formatINR(f.employerAnnual)}</td><td className="num">{formatINR(f.employeeAnnual)}</td><td className="num">{formatINR(f.projectedEmployer)}</td><td className="num">{formatINR(f.projectedTotal)}</td></tr>)}
              <tr className="strong"><td>Total</td><td className="num">{forecast.reduce((s, f) => s + f.members, 0)}</td><td className="num">{formatINR(forecast.reduce((s, f) => s + f.employerAnnual, 0))}</td><td className="num">{formatINR(forecast.reduce((s, f) => s + f.employeeAnnual, 0))}</td><td className="num">{formatINR(forecast.reduce((s, f) => s + f.projectedEmployer, 0))}</td><td className="num">{formatINR(forecast.reduce((s, f) => s + f.projectedTotal, 0))}</td></tr>
            </tbody></table></div>
        )}
      </Card>
      <Card tight title={report.title} action={<div className="row gap-2 wrap">
        {(Object.keys(BENEFIT_REPORTS) as Kind[]).map((k) => <Link key={k} className={`btn sm ${k === kind ? "primary" : ""}`} href={`/payroll/benefits/reports?report=${k}`}>{BENEFIT_REPORTS[k]}</Link>)}
        <a className="btn sm" href={`/payroll/benefits/reports/export?report=${kind}`}>Download CSV</a>
      </div>}>
        {report.rows.length === 0 ? <Empty title="Nothing to report" /> : (
          <div className="table-wrap"><table className="data"><thead><tr>{report.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{report.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="text-sm">{show(c)}</td>)}</tr>)}</tbody></table></div>
        )}
      </Card>
      {kind !== "eligibility" ? (
        <Card tight title="Eligibility at a glance" description="Who each active plan is open to today">
          {matrix.plans.length === 0 ? <Empty title="No active plans" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Plan</th><th className="num">Eligible</th><th className="num">Waiting</th><th className="num">Excluded</th><th className="num">By exception</th></tr></thead>
              <tbody>{matrix.plans.map((p, i) => {
                const cells = matrix.rows.map((r) => r.cells[i]!);
                return <tr key={p.id}><td>{p.name}</td><td className="num">{cells.filter((c) => c.eligible && !c.waitLeft).length}</td><td className="num">{cells.filter((c) => c.eligible && c.waitLeft).length}</td><td className="num">{cells.filter((c) => !c.eligible).length}</td><td className="num">{cells.filter((c) => c.exception).length}</td></tr>;
              })}</tbody></table></div>
          )}
        </Card>
      ) : null}
      <Card tight title="Audit trail">
        {audit.length === 0 ? <Empty title="No entries" /> : <div className="table-wrap"><table className="data"><tbody>{audit.map((h) => <tr key={h.id}><td className="text-xs nowrap">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{h.actorLabel}</td><td><Badge>{h.action.toLowerCase()}</Badge></td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>}
      </Card>
    </>
  );
}
