import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { loanPortfolio } from "@keka/services";
import { formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Stat, Empty, Badge } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { runLoanOverdueAlertsAction } from "@/app/actions/loan-depth";
import { LOAN_REPORTS, loanBookReport, type LoanReportKind } from "./data";

const show = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" ? v.toLocaleString("en-IN") : v === null || v === undefined ? "" : String(v));

/** The loan book: what is out, what is overdue, what comes back over the next year, and the reports. */
export default async function LoanPortfolioPage({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.LOAN_MANAGE);
  const sp = await searchParams;
  const kind: LoanReportKind = sp.report && sp.report in LOAN_REPORTS ? (sp.report as LoanReportKind) : "outstanding";
  const [p, report, audit] = await Promise.all([
    loanPortfolio(viewer.tenantId),
    loanBookReport(viewer.tenantId, kind),
    prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, entityType: { in: ["Loan", "LoanAdjustment", "LoanReport", "LoanPolicy", "LoanCategory"] } }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const peak = Math.max(1, ...p.next12.map((m) => m.amount));
  return (
    <>
      <PageHead title="Loan portfolio" subtitle="Outstanding balances, overdue aging and expected recoveries"
        actions={<><ActButton action={runLoanOverdueAlertsAction} hidden={{}} label="Alert overdue borrowers" /><Link className="btn" href="/payroll/loans">Loans</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <Stat label="Active loans" value={p.active} meta={`${p.pending} awaiting decision`} />
        <Stat label="Outstanding" value={formatINR(p.outstanding)} />
        <Stat label="Disbursed this year" value={formatINR(p.disbursedYtd)} />
        <Stat label="Processing fees" value={formatINR(p.fees)} />
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title="By loan type">
          {p.byCategory.length === 0 ? <Empty title="No active loans" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Type</th><th className="num">Loans</th><th className="num">Principal</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{p.byCategory.map((c) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.count}</td><td className="num">{formatINR(c.principal)}</td><td className="num">{formatINR(c.outstanding)}</td></tr>)}</tbody></table></div>
          )}
        </Card>
        <Card title="Overdue aging" description="Outstanding balance by how many EMIs are past due in closed payrolls">
          <div className="grid grid-4">
            {(Object.entries(p.aging) as Array<[string, number]>).map(([k, v]) => <Stat key={k} label={k === "current" ? "Current" : `${k} EMIs`} value={formatINR(v)} tone={k !== "current" && v > 0 ? "neg" : undefined} />)}
          </div>
          <div className="row gap-2 wrap" style={{ marginTop: 10 }}>{Object.entries(p.byStatus).map(([s, n]) => <Badge key={s}>{s.toLowerCase().replace(/_/g, " ")}: {n}</Badge>)}</div>
        </Card>
      </div>
      <Card title="Expected recoveries, next 12 months">
        <div className="stack gap-1">
          {p.next12.map((m) => (
            <div key={m.label} className="row gap-2" style={{ alignItems: "center" }}>
              <span className="text-xs" style={{ width: 64 }}>{m.label}</span>
              <div style={{ flex: 1, background: "var(--surface-2, #eee)", borderRadius: 4, height: 10 }}><div style={{ width: `${(m.amount / peak) * 100}%`, background: "var(--brand, #4f46e5)", height: 10, borderRadius: 4 }} /></div>
              <span className="text-xs num" style={{ width: 100, textAlign: "right" }}>{formatINR(m.amount)}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card tight title={report.title} action={<div className="row gap-2 wrap">
        {(Object.keys(LOAN_REPORTS) as LoanReportKind[]).map((k) => <Link key={k} className={`btn sm ${k === kind ? "primary" : ""}`} href={`/payroll/loans/portfolio?report=${k}`}>{LOAN_REPORTS[k]}</Link>)}
        <a className="btn sm" href={`/payroll/loans/portfolio/export?report=${kind}`}>Download CSV</a>
      </div>}>
        {report.rows.length === 0 ? <Empty title="Nothing to report" /> : (
          <div className="table-wrap"><table className="data"><thead><tr>{report.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{report.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="text-sm">{show(c)}</td>)}</tr>)}</tbody></table></div>
        )}
      </Card>
      <Card tight title="Recent loan activity">
        {audit.length === 0 ? <Empty title="No entries" /> : <div className="table-wrap"><table className="data"><tbody>{audit.map((h) => <tr key={h.id}><td className="text-xs nowrap">{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td className="text-xs">{h.actorLabel}</td><td className="text-sm">{h.summary}</td></tr>)}</tbody></table></div>}
      </Card>
    </>
  );
}
