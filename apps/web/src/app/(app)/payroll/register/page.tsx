import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatPeriod, formatINR } from "@keka/shared";
import { registerData } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty, Callout, RunStatusBadge, Badge } from "@/components/ui";
import { IconDownload } from "@/components/icons";

const P = PERMISSIONS;

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

  // Columns follow the pay group's saved layout (Customise), on screen and in the CSV.
  const data = await registerData(viewer.tenantId, runId);
  if (!data) return <Card><Empty title="Run not found" /></Card>;
  const { run, columns, rows, totals } = data;
  const cell = (v: string | number, numeric: boolean) =>
    numeric && typeof v === "number" ? (v === 0 ? <span className="subtle">—</span> : formatINR(v, false)) : (v || <span className="subtle">—</span>);

  return (
    <>
      <PageHead
        title="Pay register"
        subtitle={`${formatPeriod(run.year, run.month)} · ${run.payGroupName} · ${rows.length} employees`}
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
            {can(viewer, P.PAYROLL_SETTINGS) ? <Link className="btn" href={`/payroll/register/customise?payGroup=${run.payGroupId}`}>Customise columns</Link> : null}
            <a className="btn" href={`/api/payroll/register.csv?run=${run.id}`}>
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
                {columns.map((c, i) => (
                  <th key={c.key} className={c.numeric ? "num" : undefined} title={c.label}
                    style={i === 0 ? { position: "sticky", left: 0, zIndex: 2 } : undefined}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId}>
                  {columns.map((c, i) => (
                    <td key={c.key} className={c.numeric ? "num" : c.key === "name" ? "strong" : "text-xs"}
                      style={i === 0 ? { position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 } : undefined}>
                      {c.key === "name" ? (
                        <Link href={`/employees/${r.employeeId}`}>{r.cells.name}</Link>
                      ) : c.key === "payableDays" ? Number(r.cells.payableDays).toFixed(1) : cell(r.cells[c.key], c.numeric)}
                      {c.key === "name" && r.payAction !== "PROCESS_AS_SALARY" ? (
                        <> <Badge tone="warning">{r.payAction.replace(/_/g, " ").toLowerCase()}</Badge></>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="total-row">
                {columns.map((c, i) => (
                  <td key={c.key} className={c.numeric ? "num" : undefined} style={i === 0 ? { position: "sticky", left: 0, zIndex: 1 } : undefined}>
                    {i === 0 ? `Total — ${rows.length}` : totals[c.key] !== undefined ? (c.key === "payableDays" ? totals[c.key].toFixed(1) : formatINR(totals[c.key], false)) : null}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
