import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { orgNames, workerRows } from "@/lib/workforce";
import { PageHead, Card, Empty } from "@/components/ui";
import { Disclosure, SimpleForm, F, Select } from "@/components/workforce-ui";
import { StatusPill, FilterBar } from "@/components/workforce-tables";
import { saveWorkerAction } from "@/app/actions/contingent";
import { WorkerFields } from "./fields";

const P = PERMISSIONS;

export default async function WorkersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; vendorId?: string; kind?: string }> }) {
  const viewer = await requireAuth(P.CONTINGENT_VIEW);
  const sp = await searchParams;
  const [names, rows, vendors] = await Promise.all([
    orgNames(viewer.tenantId), workerRows(viewer.tenantId, sp),
    prisma.contingentVendor.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
  ]);
  const opts = {
    vendors: vendors.filter((v) => v.status === "ACTIVE").map((v) => ({ value: v.id, label: v.name })),
    departments: names.departments.map((d) => ({ value: d.id, label: d.name })),
    employees: names.employees.filter((e) => e.status !== "EXITED").map((e) => ({ value: e.id, label: `${e.displayName ?? e.firstName} (${e.employeeNumber})` })),
  };
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => !!v) as Array<[string, string]>).toString();
  return (
    <>
      <PageHead title="Contractors & vendor workers" subtitle="Contingent workers are not employees: they have contracts, rates and a payment profile instead of payroll." actions={<a className="btn sm" href={`/contingent/export?report=workers${qs ? `&${qs}` : ""}`}>Export CSV</a>} />
      {can(viewer, P.CONTINGENT_MANAGE) ? (
        <Card title="Engage a contingent worker" description="The engagement starts once a contingent approver approves it.">
          <Disclosure label="Add worker"><SimpleForm action={saveWorkerAction} submitLabel="Send for approval"><WorkerFields opts={opts} creating /></SimpleForm></Disclosure>
        </Card>
      ) : null}
      <Card title="Workers">
        <FilterBar action="/contingent/workers">
          <F label="Search"><input className="input" name="q" defaultValue={sp.q} placeholder="Name, code, email, skill, PO or role" /></F>
          <F label="Status"><Select name="status" options={["PENDING_APPROVAL", "ACTIVE", "ENDED", "CONVERTED", "REJECTED"].map((s) => ({ value: s, label: s.toLowerCase().replace("_", " ") }))} defaultValue={sp.status} placeholder="Any" /></F>
          <F label="Type"><Select name="kind" options={[{ value: "CONTRACTOR", label: "Contractor" }, { value: "VENDOR_WORKER", label: "Vendor worker" }]} defaultValue={sp.kind} placeholder="Any" /></F>
          <F label="Vendor"><Select name="vendorId" options={vendors.map((v) => ({ value: v.id, label: v.name }))} defaultValue={sp.vendorId} placeholder="Any" /></F>
        </FilterBar>
        {rows.length === 0 ? <Empty title="No contingent workers match." /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Vendor</th><th>Department</th><th>Manager</th><th>Current contract</th><th>Payment profile</th><th>Status</th></tr></thead>
            <tbody>{rows.map((w) => {
              const cur = w.assignments.find((a) => a.status === "ACTIVE") ?? w.assignments[0];
              return (
                <tr key={w.id}>
                  <td className="mono"><Link href={`/contingent/workers/${w.id}`}>{w.code}</Link></td><td>{w.firstName} {w.lastName}<div className="text-xs muted">{w.email}</div></td>
                  <td className="text-xs">{w.workerKind === "VENDOR_WORKER" ? "Vendor worker" : "Contractor"} · {w.engagementType.toLowerCase().replace(/_/g, " ")}</td>
                  <td>{w.vendor?.name ?? "—"}</td><td>{w.departmentId ? names.dept.get(w.departmentId) : "—"}</td><td className="text-xs">{w.managerEmployeeId ? names.emp.get(w.managerEmployeeId) : "—"}</td>
                  <td className="text-xs">{cur ? <>{cur.role} · {formatDate(cur.startDate)} → {formatDate(cur.endDate)} <StatusPill status={cur.status} /></> : "—"}</td>
                  <td>{w.paymentProfile ? <StatusPill status={w.paymentProfile.status} /> : <span className="muted text-xs">none</span>}</td><td><StatusPill status={w.status} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
