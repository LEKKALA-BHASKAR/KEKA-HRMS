import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fyLabel, formatDate } from "@keka/shared";
import { currentFy } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Empty, Badge, Callout } from "@/components/ui";
import { DepthForm } from "../_forms/depth";
import { setTaxWindowAction, importDeclarationsAction, uploadForm16PartAAction } from "@/app/actions/payroll-depth";

const P = PERMISSIONS;

/**
 * Tax administration: lock or reopen the declaration and proof windows for
 * everyone or chosen employees, import declarations in bulk, upload each
 * employee's Form 16 Part A, and issue Form 12BA.
 */
export default async function TaxAdminPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireAuth(P.TAX_DECLARATION_APPROVE);
  const sp = await searchParams;
  const fy = Number(sp.fy) || currentFy(new Date(), viewer.tenant.fyStartMonth);
  const scope = scopedEmployeeWhere(viewer, P.TAX_DECLARATION_APPROVE);
  const canFile = can(viewer, P.STATUTORY_MANAGE);
  const [employees, overrides, partA] = await Promise.all([
    prisma.employee.findMany({ where: { ...scope, status: { notIn: ["EXITED", "PREBOARDING"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" } }),
    prisma.taxWindowOverride.findMany({ where: { tenantId: viewer.tenantId, fyStartYear: fy }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: [{ kind: "asc" }, { createdAt: "desc" }] }),
    prisma.storedFile.findMany({ where: { tenantId: viewer.tenantId, relatedType: "Form16PartA", relatedId: String(fy) }, select: { id: true, employeeId: true, createdAt: true, filename: true } }),
  ]);
  const partAByEmp = new Map(partA.map((f) => [f.employeeId, f]));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Tax administration" subtitle={`Declaration and proof windows, bulk declarations, Form 16 Part A and Form 12BA — FY ${fyLabel(fy)}`}
        actions={<>
          <Link className="btn sm" href={`/payroll/tax-admin?fy=${fy - 1}`}>‹ {fyLabel(fy - 1)}</Link>
          <Link className="btn sm" href={`/payroll/tax-admin?fy=${fy + 1}`}>{fyLabel(fy + 1)} ›</Link>
          <Link className="btn" href="/payroll/tax-proofs">Review proofs</Link>
          {canFile ? <Link className="btn" href="/payroll/filings/26q">Contractor TDS (26Q)</Link> : null}
        </>} />

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title="Window overrides" description="These win over the pay group's monthly window: an employee's own override over the one for everyone.">
          {overrides.length === 0 ? <Empty title="No overrides">Everyone follows their pay group's declaration and proof windows.</Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Window</th><th>Who</th><th>State</th><th>Note</th></tr></thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr key={o.id}>
                      <td>{o.kind === "DECLARATION" ? "Declarations" : "Proofs"}</td>
                      <td>{o.employee ? `${o.employee.employeeNumber} · ${o.employee.displayName}` : <strong>Everyone</strong>}</td>
                      <td>{o.state === "LOCKED" ? <Badge tone="danger">Locked</Badge> : <Badge tone="success">Open{o.until ? ` till ${formatDate(o.until)}` : ""}</Badge>}</td>
                      <td className="text-xs">{o.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
            <DepthForm action={setTaxWindowAction} submitLabel="Apply" hidden={{ fy: String(fy) }}>
              <div className="grid grid-2">
                <div className="field"><label className="label" htmlFor="tw-kind">Window</label>
                  <select id="tw-kind" className="select" name="kind"><option value="DECLARATION">Investment declarations</option><option value="PROOF">Proof submission</option></select></div>
                <div className="field"><label className="label" htmlFor="tw-state">Action</label>
                  <select id="tw-state" className="select" name="state"><option value="LOCKED">Lock</option><option value="OPEN">Reopen until a date</option><option value="DEFAULT">Back to the pay group&apos;s window</option></select></div>
                <div className="field"><label className="label" htmlFor="tw-until">Open until</label><input id="tw-until" className="input" type="date" name="until" min={today} /><div className="hint">For a reopening</div></div>
                <div className="field"><label className="label" htmlFor="tw-scope">For</label>
                  <select id="tw-scope" className="select" name="scope"><option value="ALL">Everyone</option><option value="SELECTED">Selected employees</option></select></div>
              </div>
              <div className="field"><label className="label" htmlFor="tw-emps">Selected employees</label>
                <select id="tw-emps" className="select" name="employeeIds" multiple size={6}>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.displayName}</option>)}
                </select>
                <div className="hint">Ctrl/Cmd-click to choose several; used when &quot;For&quot; is selected employees</div>
              </div>
              <div className="field"><label className="label" htmlFor="tw-note">Note</label><input id="tw-note" className="input" name="note" maxLength={300} /></div>
            </DepthForm>
          </div>
        </Card>

        <div className="stack gap-4">
          <Card title="Import declarations" description="A CSV with a header row: Employee Number, Section, Category, Amount — one line per investment. A line replaces the employee's amount for that section and category.">
            <DepthForm action={importDeclarationsAction} submitLabel="Import" hidden={{ fy: String(fy) }} encType="multipart/form-data">
              <div className="field"><label className="label" htmlFor="imp-file">CSV file</label><input id="imp-file" className="input" type="file" name="file" accept=".csv,text/csv" required /></div>
              <pre className="mono text-xs" style={{ background: "var(--surface-2, #f6f7f9)", padding: 8, borderRadius: 6, margin: 0 }}>{"Employee Number,Section,Category,Amount\nE001,80C,PPF,150000\nE001,80D,Health insurance - self,25000"}</pre>
            </DepthForm>
          </Card>

          <Callout tone="info" title="Form 12BA">
            Each employee&apos;s perquisites statement is generated from finalised payroll — use the 12BA link against their name below.
          </Callout>
        </div>
      </div>

      <div style={{ height: 16 }} />
      <Card tight title="Form 16 Part A and Form 12BA" description="Upload Part A as downloaded from TRACES; the employee finds it under Manage Tax → Forms. Part B is generated under Filings.">
        {canFile ? (
          <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
            <DepthForm action={uploadForm16PartAAction} inline submitLabel="Upload Part A" hidden={{ fy: String(fy) }} encType="multipart/form-data">
              <select className="select" name="employeeId" required aria-label="Employee" style={{ maxWidth: 260 }}>
                <option value="">Employee…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.displayName}</option>)}
              </select>
              <input className="input" type="file" name="file" accept="application/pdf" required aria-label="Part A PDF" style={{ maxWidth: 260 }} />
            </DepthForm>
          </div>
        ) : null}
        {employees.length === 0 ? <Empty title="No employees in your scope" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th>Form 16 Part A</th><th>Form 12BA</th></tr></thead>
              <tbody>
                {employees.map((e) => {
                  const f = partAByEmp.get(e.id);
                  return (
                    <tr key={e.id}>
                      <td><span className="mono text-xs">{e.employeeNumber}</span> {e.displayName}</td>
                      <td>{f ? <a href={`/files/${f.id}`}>Uploaded {formatDate(f.createdAt)}</a> : <span className="subtle text-xs">Not uploaded</span>}</td>
                      <td><a className="btn sm" href={`/payroll/tax-admin/12ba?employee=${e.id}&fy=${fy}`}>12BA PDF</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
