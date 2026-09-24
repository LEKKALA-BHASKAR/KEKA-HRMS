import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Money, Empty, Callout, RunStatusBadge, Badge } from "@/components/ui";
import { IconDownload } from "@/components/icons";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

export default async function PayRegisterPage({
  searchParams,
}: { searchParams: Promise<{ run?: string }> }) {
  const viewer = await requireAuth(P.PAY_REGISTER_VIEW);
  const sp = await searchParams;

  const runs = await prisma.payrollRun.findMany({
    where: { tenantId: viewer.tenantId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { id: true, year: true, month: true, status: true, payGroup: { select: { name: true } } },
    take: 24,
  });

  const runId = sp.run ?? runs[0]?.id;
  if (!runId) {
    return (
      <>
        <PageHead title="Pay register" />
        <Card><Empty title="No payroll runs yet">Run payroll first — the register is built from it.</Empty></Card>
      </>
    );
  }

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId: viewer.tenantId },
    include: {
      payGroup: { include: { payRegisterConfig: true } },
      lines: {
        orderBy: { employee: { employeeNumber: "asc" } },
        include: {
          employee: {
            select: {
              id: true, employeeNumber: true, displayName: true,
              department: { select: { name: true } },
              location: { select: { stateCode: true } },
            },
          },
          lines: { orderBy: { sequence: "asc" } },
        },
      },
    },
  });
  if (!run) return <Card><Empty title="Run not found" /></Card>;

  // Column set is the union of every component that appeared, so the register
  // is complete without hard-coding a component list.
  const earningCodes = new Map<string, string>();
  const deductionCodes = new Map<string, string>();
  for (const line of run.lines) {
    for (const c of line.lines) {
      if (c.type === "EARNING" || c.type === "REIMBURSEMENT") earningCodes.set(c.code, c.name);
      if (c.type === "DEDUCTION") deductionCodes.set(c.code, c.name);
    }
  }
  const earningList = [...earningCodes.entries()];
  const deductionList = [...deductionCodes.entries()];

  const amountFor = (line: typeof run.lines[number], code: string) =>
    n(line.lines.find((c) => c.code === code)?.amount);

  const colTotal = (code: string) =>
    run.lines.reduce((s, l) => s + amountFor(l, code), 0);

  return (
    <>
      <PageHead
        title="Pay register"
        subtitle={`${formatPeriod(run.year, run.month)} · ${run.payGroup.name} · ${run.lines.length} employees`}
        actions={
          <>
            <form className="row gap-2">
              <select className="select" name="run" defaultValue={runId} style={{ maxWidth: 260 }}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {formatPeriod(r.year, r.month)} — {r.payGroup.name}
                  </option>
                ))}
              </select>
              <button className="btn" type="submit">Go</button>
            </form>
            <RunStatusBadge status={run.status} />
            <a
              className="btn"
              href={`/api/payroll/register.csv?run=${run.id}`}
            >
              <IconDownload width={15} height={15} />CSV
            </a>
          </>
        }
      />

      <Callout tone="info" title="Fixed columns">
        Employee number, name, month, payable days and the salary components cannot be
        removed from the register. Layout changes apply retroactively to every month,
        and perks are not configurable here.
      </Callout>

      <div style={{ height: 14 }} />

      <Card tight>
        <div className="table-wrap">
          <table className="data" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, zIndex: 2 }}>Employee</th>
                <th>Dept</th>
                <th>St</th>
                <th className="num">Days</th>
                {earningList.map(([code, name]) => (
                  <th key={code} className="num" title={name}>{name}</th>
                ))}
                <th className="num">Gross</th>
                {deductionList.map(([code, name]) => (
                  <th key={code} className="num" title={name}>{name}</th>
                ))}
                <th className="num">Deductions</th>
                <th className="num">Net pay</th>
              </tr>
            </thead>
            <tbody>
              {run.lines.map((l) => (
                <tr key={l.id}>
                  <td style={{ position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 }}>
                    <Link href={`/employees/${l.employeeId}`}>
                      <span className="mono text-xs">{l.employee.employeeNumber}</span>{" "}
                      <span className="strong">{l.employee.displayName}</span>
                    </Link>
                    {l.payAction !== "PROCESS_AS_SALARY" ? (
                      <Badge tone="warning">{l.payAction.replace(/_/g, " ").toLowerCase()}</Badge>
                    ) : null}
                  </td>
                  <td className="text-xs">{l.employee.department?.name ?? "—"}</td>
                  <td className="text-xs">{l.employee.location?.stateCode ?? "—"}</td>
                  <td className="num">{n(l.payableDays).toFixed(1)}</td>
                  {earningList.map(([code]) => (
                    <td key={code} className="num">
                      {amountFor(l, code) === 0
                        ? <span className="subtle">—</span>
                        : formatINR(amountFor(l, code), false)}
                    </td>
                  ))}
                  <td className="num strong">{formatINR(n(l.grossEarnings), false)}</td>
                  {deductionList.map(([code]) => (
                    <td key={code} className="num">
                      {amountFor(l, code) === 0
                        ? <span className="subtle">—</span>
                        : formatINR(amountFor(l, code), false)}
                    </td>
                  ))}
                  <td className="num">{formatINR(n(l.totalDeductions), false)}</td>
                  <td className={`num strong ${n(l.netPay) < 0 ? "neg" : ""}`}>
                    {formatINR(n(l.netPay), false)}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td style={{ position: "sticky", left: 0, zIndex: 1 }}>
                  Total — {run.lines.length} employees
                </td>
                <td /><td />
                <td className="num">
                  {run.lines.reduce((s, l) => s + n(l.payableDays), 0).toFixed(1)}
                </td>
                {earningList.map(([code]) => (
                  <td key={code} className="num">{formatINR(colTotal(code), false)}</td>
                ))}
                <td className="num">{formatINR(n(run.totalGross), false)}</td>
                {deductionList.map(([code]) => (
                  <td key={code} className="num">{formatINR(colTotal(code), false)}</td>
                ))}
                <td className="num">{formatINR(n(run.totalDeductions), false)}</td>
                <td className="num">{formatINR(n(run.totalNetPay), false)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
