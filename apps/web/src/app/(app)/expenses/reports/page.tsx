import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty, Stat } from "@/components/ui";
import { EXPENSE_REPORTS, expenseFilter, expenseReport, taxClassificationSummary, type ExpenseReportKind } from "./data";

const cell = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString("en-IN") : String(v));

/** Expense reports with filters; every report downloads as CSV. */
export default async function ExpenseReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireAuth(PERMISSIONS.EXPENSE_MANAGE);
  const sp = await searchParams;
  const kind = (sp.kind && sp.kind in EXPENSE_REPORTS ? sp.kind : "reimbursements") as ExpenseReportKind;
  const f = expenseFilter(sp);
  const [r, tax, projects] = await Promise.all([
    expenseReport(viewer.tenantId, kind, f),
    taxClassificationSummary(viewer.tenantId, f),
    prisma.project.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
  ]);
  const qs = new URLSearchParams(Object.entries({ ...sp, kind }).filter(([, v]) => v) as Array<[string, string]>).toString();
  return (
    <>
      <PageHead title="Expense reports" subtitle="Reimbursements, receipts, project spend, the finance export and the audit trail" actions={<><Link className="btn primary" href={`/expenses/reports/export?${qs}`}>Download CSV</Link><Link className="btn" href="/expenses">Back</Link></>} />
      <div className="tabs">
        {Object.entries(EXPENSE_REPORTS).map(([k, l]) => <Link key={k} className={`tab${kind === k ? " active" : ""}`} href={`/expenses/reports?${new URLSearchParams({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => v) as Array<[string, string]>), kind: k })}`}>{l}</Link>)}
      </div>
      <form className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input type="hidden" name="kind" value={kind} />
        <input className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Claim, title or employee" style={{ maxWidth: 220 }} />
        <input className="input" type="date" name="from" defaultValue={sp.from ?? ""} aria-label="From" style={{ maxWidth: 160 }} />
        <input className="input" type="date" name="to" defaultValue={sp.to ?? ""} aria-label="To" style={{ maxWidth: 160 }} />
        <select className="select" name="stage" defaultValue={sp.stage ?? ""} style={{ maxWidth: 180 }}><option value="">Any stage</option>{["SUBMITTED", "PARTIALLY_APPROVED", "APPROVED", "PAYMENT_PENDING", "PAID", "REJECTED"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}</select>
        <select className="select" name="projectId" defaultValue={sp.projectId ?? ""} style={{ maxWidth: 200 }}><option value="">Any project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="btn">Apply</button>
      </form>
      <div className="grid grid-3" style={{ marginBottom: 12 }}>
        <Stat label="Taxable reimbursements" value={formatINR(tax.taxable)} meta="paid through payroll as taxable" />
        <Stat label="Non-taxable" value={formatINR(tax.nonTaxable)} />
        <Stat label="Rows" value={r.rows.length} />
      </div>
      <Card tight title={EXPENSE_REPORTS[kind]}>
        {r.rows.length === 0 ? <Empty title="Nothing in this period" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr>{r.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{r.rows.slice(0, 300).map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} className="text-sm">{cell(c)}</td>)}</tr>)}</tbody>
          </table></div>
        )}
        {r.rows.length > 300 ? <div className="text-xs subtle" style={{ padding: 10 }}>Showing 300 of {r.rows.length}; download the CSV for all.</div> : null}
      </Card>
    </>
  );
}
