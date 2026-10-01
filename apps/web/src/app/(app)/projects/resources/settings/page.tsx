import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { capacityOf, costLabel } from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Empty } from "@/components/ui";
import { ResourceTabs } from "../nav";
import { BillingRoleForm, ProfileForm } from "../forms";

const PAGE = 40;

/** Projects › Resources › Roles & cost: the billing roles master and each person's cost, capacity and target. */
export default async function ResourceSettings({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = sp.q?.trim();
  const where = { tenantId: viewer.tenantId, status: { notIn: ["EXITED" as const, "PREBOARDING" as const] }, ...(q ? { OR: [{ displayName: { contains: q, mode: "insensitive" as const } }, { employeeNumber: { contains: q, mode: "insensitive" as const } }] } : {}) };
  const [roles, total, people] = await Promise.all([
    prisma.billingRole.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    prisma.employee.count({ where }),
    prisma.employee.findMany({ where, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, resourceProfile: true }, orderBy: { employeeNumber: "asc" }, skip: (page - 1) * PAGE, take: PAGE }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      <PageHead title="Roles & cost" subtitle="Billing roles used by allocations and requests, and what each person costs and can work" />
      <ResourceTabs viewer={viewer} active="/projects/resources/settings" />
      <div className="stack gap-3">
        <Card title="Billing roles">
          <div className="stack gap-2">
            {roles.map((r) => <BillingRoleForm key={r.id} role={r} />)}
            {roles.length === 0 ? <span className="text-sm subtle">No roles yet.</span> : null}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}><BillingRoleForm /></div>
          </div>
        </Card>
        <Card tight title="Cost, target utilisation and weekly capacity" description="Capacity is hours per day, Sunday to Saturday. The hourly cost becomes the default cost rate of new allocations."
          action={<form className="row gap-2"><input className="input" name="q" defaultValue={q} placeholder="Name or number" style={{ padding: "4px 6px", fontSize: 13 }} aria-label="Search" /><button className="btn sm">Find</button></form>}>
          {people.length === 0 ? <Empty title="Nobody matches" /> : (
            <table className="data">
              <thead><tr><th>Person</th><th>Current</th><th>Cost · target % · Sun–Sat hours</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td>{p.displayName ?? `${p.firstName} ${p.lastName}`} <span className="subtle text-xs">{p.employeeNumber}</span></td>
                    <td className="text-sm">{costLabel(p.resourceProfile) ?? <span className="subtle">No cost</span>}{p.resourceProfile?.hourlyCost ? <div className="text-xs subtle">₹{Number(p.resourceProfile.hourlyCost).toLocaleString("en-IN")}/hr</div> : null}</td>
                    <td><ProfileForm employeeId={p.id} profile={{ costType: p.resourceProfile?.costType ?? null, costAmount: p.resourceProfile?.costAmount === null || p.resourceProfile?.costAmount === undefined ? null : Number(p.resourceProfile.costAmount), targetUtilization: p.resourceProfile?.targetUtilization ?? null, capacity: capacityOf(p.resourceProfile?.capacity) }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pages > 1 ? (
            <div className="row gap-2" style={{ padding: "10px 18px" }}>
              {page > 1 ? <Link className="btn sm" href={`?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) })}`}>‹ Previous</Link> : null}
              <span className="text-sm subtle">Page {page} of {pages}</span>
              {page < pages ? <Link className="btn sm" href={`?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) })}`}>Next ›</Link> : null}
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
