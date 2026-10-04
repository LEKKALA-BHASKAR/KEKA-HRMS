import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatINR } from "@keka/shared";
import { varianceReport } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty, Stat, Badge, Callout, RunStatusBadge } from "@/components/ui";
import { IconDownload } from "@/components/icons";

const P = PERMISSIONS;
const TABS = { employees: "By employee", components: "By component", reconciliation: "Reconciliation" } as const;
type Tab = keyof typeof TABS;

function Pct({ p }: { p: number | null }) {
  if (p === null) return <Badge tone="info">new</Badge>;
  if (Math.abs(p) < 0.0005) return <span className="subtle">0%</span>;
  const big = Math.abs(p) >= 0.1;
  return <span className={p > 0 ? "pos" : "neg"} style={big ? { fontWeight: 650 } : undefined}>{p > 0 ? "+" : ""}{(p * 100).toFixed(1)}%</span>;
}
const Amt = ({ v }: { v: number }) => <span className={v > 0 ? "pos" : v < 0 ? "neg" : "subtle"}>{v > 0 ? "+" : ""}{formatINR(v, false)}</span>;

/**
 * Payroll variance: this month against last month, per employee and per
 * component with the % change, the gross reconciliation (opening → joiners
 * → exits → component movements → closing), integrity checks inside the run,
 * and the journal voucher export.
 */
export default async function VariancePage({ searchParams }: { searchParams: Promise<{ run?: string; tab?: string; flag?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_VIEW);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "employees") as Tab;
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId: viewer.tenantId, type: "REGULAR", rolledBackAt: null },
    orderBy: [{ year: "desc" }, { month: "desc" }], take: 24,
    select: { id: true, year: true, month: true, status: true, payGroup: { select: { name: true } } },
  });
  const runId = sp.run ?? runs[0]?.id;
  const v = runId ? await varianceReport(viewer.tenantId, runId) : null;
  if (!v) {
    return (<><PageHead title="Payroll variance" /><Card><Empty title="No payroll runs yet">Variance compares a month's run with the month before.</Empty></Card></>);
  }
  const threshold = Number(sp.flag ?? 10) / 100;
  const qs = (extra: Record<string, string>) => new URLSearchParams({ run: v.run.id, tab, ...extra }).toString();
  const prevLabel = v.previous ? formatPeriod(v.previous.year, v.previous.month) : "previous month";
  const canExport = can(viewer, P.PAYROLL_RUN) && ["LOCKED", "FINALIZED"].includes(v.run.status);
  const flagged = v.employees.filter((e) => e.status !== "CONTINUING" || e.grossPct === null || Math.abs(e.grossPct) >= threshold);

  return (
    <>
      <PageHead
        title="Payroll variance & reconciliation"
        subtitle={`${formatPeriod(v.run.year, v.run.month)} against ${prevLabel} · ${v.run.payGroupName}`}
        actions={
          <>
            <form className="row gap-2">
              <input type="hidden" name="tab" value={tab} />
              <select className="select" name="run" defaultValue={v.run.id} style={{ maxWidth: 260 }}>
                {runs.map((r) => <option key={r.id} value={r.id}>{formatPeriod(r.year, r.month)} — {r.payGroup.name}</option>)}
              </select>
              <button className="btn" type="submit">Go</button>
            </form>
            <RunStatusBadge status={v.run.status} />
            <a className="btn" href={`/payroll/variance/export?run=${v.run.id}&kind=${tab}`}><IconDownload width={15} height={15} />CSV</a>
            {canExport ? (
              <>
                <a className="btn" href={`/payroll/runs/${v.run.id}/journal-voucher`}><IconDownload width={15} height={15} />Journal voucher</a>
                <a className="btn" href={`/payroll/runs/${v.run.id}/journal-voucher?by=department`}>JV by department</a>
              </>
            ) : null}
          </>
        }
      />
      {!v.previous ? <Callout tone="info" title="Nothing to compare with">There is no run for {prevLabel}, so every employee shows as new.</Callout> : null}
      <div className="grid grid-4" style={{ margin: "14px 0" }}>
        <Stat label="Headcount" value={v.currTotals.headcount} meta={`${v.prevTotals.headcount} in ${prevLabel}`} />
        <Stat label="Gross" value={formatINR(v.currTotals.gross, false)} meta={<><Amt v={v.currTotals.gross - v.prevTotals.gross} /> · <Pct p={v.prevTotals.gross ? (v.currTotals.gross - v.prevTotals.gross) / v.prevTotals.gross : null} /></>} />
        <Stat label="Net pay" value={formatINR(v.currTotals.net, false)} meta={<><Amt v={v.currTotals.net - v.prevTotals.net} /> · <Pct p={v.prevTotals.net ? (v.currTotals.net - v.prevTotals.net) / v.prevTotals.net : null} /></>} />
        <Stat label="Employer cost" value={formatINR(v.currTotals.employerCost, false)} meta={<Amt v={v.currTotals.employerCost - v.prevTotals.employerCost} />} />
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => <Link key={t} href={`/payroll/variance?${new URLSearchParams({ run: v.run.id, tab: t })}`} className={`tab${tab === t ? " active" : ""}`}>{TABS[t]}</Link>)}
      </div>

      {tab === "employees" ? (
        <Card tight title={`${flagged.length} employee(s) to review`} description={`Joiners, exits and anyone whose gross moved by ${Math.round(threshold * 100)}% or more.`}
          action={<div className="row gap-2">{[5, 10, 20].map((f) => <Link key={f} className={`btn sm${Math.round(threshold * 100) === f ? " primary" : ""}`} href={`/payroll/variance?${qs({ flag: String(f) })}`}>≥{f}%</Link>)}</div>}>
          {flagged.length === 0 ? <Empty title="Nothing moved beyond the threshold" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Employee</th><th>Status</th><th className="num">{prevLabel} gross</th><th className="num">Gross</th><th className="num">Change</th><th className="num">%</th><th className="num">Net change</th><th>What moved</th></tr></thead>
                <tbody>
                  {flagged.map((e) => (
                    <tr key={e.employeeId}>
                      <td><span className="mono text-xs">{e.employeeNumber}</span> <span className="strong">{e.name}</span><div className="text-xs subtle">{e.department}</div></td>
                      <td>{e.status === "JOINED" ? <Badge tone="success">Joined</Badge> : e.status === "LEFT" ? <Badge tone="danger">Exited</Badge> : <Badge>Continuing</Badge>}</td>
                      <td className="num">{formatINR(e.prevGross, false)}</td>
                      <td className="num">{formatINR(e.currGross, false)}</td>
                      <td className="num"><Amt v={e.grossChange} /></td>
                      <td className="num"><Pct p={e.grossPct} /></td>
                      <td className="num"><Amt v={e.netChange} /></td>
                      <td className="text-xs">{e.movers.slice(0, 3).map((m) => `${m.name} ${m.change > 0 ? "+" : ""}${Math.round(m.change).toLocaleString("en-IN")}`).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "components" ? (
        <Card tight title="Component variance" description="Every component paid in either month, totalled across the pay group.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Component</th><th>Type</th><th className="num">{prevLabel}</th><th className="num">This month</th><th className="num">Change</th><th className="num">%</th><th className="num">Employees</th></tr></thead>
              <tbody>
                {v.components.map((c) => (
                  <tr key={c.code}>
                    <td className="strong">{c.name} <span className="mono text-xs subtle">{c.code}</span></td>
                    <td className="text-xs">{c.type.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="num">{formatINR(c.prev, false)}</td>
                    <td className="num">{formatINR(c.curr, false)}</td>
                    <td className="num"><Amt v={c.change} /></td>
                    <td className="num"><Pct p={c.pct} /></td>
                    <td className="num">{c.prevCount} → {c.currCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab === "reconciliation" ? (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <Card tight title="Gross reconciliation" description={`From ${prevLabel}'s gross to this month's, step by step.`}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Step</th><th className="num">Employees</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {v.reconciliation.steps.map((s, i) => (
                    <tr key={i} style={s.kind !== "movement" ? { fontWeight: 650 } : undefined}>
                      <td>{s.label}</td><td className="num">{s.count}</td>
                      <td className="num">{s.kind === "movement" ? <Amt v={s.amount} /> : formatINR(s.amount, false)}</td>
                    </tr>
                  ))}
                  <tr><td>Unexplained difference</td><td /><td className={`num ${Math.abs(v.reconciliation.difference) > 0.5 ? "neg" : "pos"}`}>{formatINR(v.reconciliation.difference, false)}</td></tr>
                </tbody>
              </table>
            </div>
          </Card>
          <Card tight title="Integrity checks" description="The run's totals against its employee rows and their payslip lines; every figure should be zero.">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Check</th><th className="num">Employees</th><th className="num">Difference</th><th /></tr></thead>
                <tbody>
                  {v.integrity.map((s, i) => {
                    const ok = s.label.startsWith("Employees whose") ? s.count === 0 : Math.abs(s.amount) < 0.5;
                    return (
                      <tr key={i}><td>{s.label}</td><td className="num">{s.count}</td><td className="num">{formatINR(s.amount, false)}</td><td>{ok ? <Badge tone="success">OK</Badge> : <Badge tone="danger">Check</Badge>}</td></tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
