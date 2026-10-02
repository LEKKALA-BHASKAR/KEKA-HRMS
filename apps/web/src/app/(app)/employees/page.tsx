import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS, employeeScopeFilter, hasUnscopedPermission } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Person, StatusBadge, Money, Card, Empty, Callout } from "@/components/ui";
import { IconPlus, IconDownload } from "@/components/icons";

const P = PERMISSIONS;
const PAGE_SIZE = 25;

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; dept?: string; status?: string; page?: string }>;
}) {
  const viewer = await requireAuth(P.EMPLOYEE_VIEW);
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const showFinancials = can(viewer, P.EMPLOYEE_VIEW_FINANCIALS);

  // The scope filter is the enforcement point. A viewer with an unscoped
  // grant gets null (no narrowing); everyone else gets a where-fragment built
  // from their role scopes, implicit roles and the visibility setting.
  const scopeFilter = employeeScopeFilter(viewer, P.EMPLOYEE_VIEW);
  const isUnscoped = hasUnscopedPermission(viewer, P.EMPLOYEE_VIEW);

  const where: Prisma.EmployeeWhereInput = {
    tenantId: viewer.tenantId,
    ...(scopeFilter as Prisma.EmployeeWhereInput ?? {}),
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.dept ? { departmentId: params.dept } : {}),
    ...(params.q
      ? {
          OR: [
            { firstName: { contains: params.q, mode: "insensitive" } },
            { lastName: { contains: params.q, mode: "insensitive" } },
            { employeeNumber: { contains: params.q, mode: "insensitive" } },
            { workEmail: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [employees, total, departments] = await Promise.all([
    prisma.employee.findMany({
      where,
      orderBy: [{ status: "asc" }, { firstName: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, employeeNumber: true, displayName: true, firstName: true, lastName: true,
        jobTitleName: true, workEmail: true, status: true, dateOfJoining: true,
        department: { select: { name: true } },
        location: { select: { name: true, stateCode: true } },
        reportingManager: { select: { displayName: true } },
        salaryRevisions: showFinancials
          ? { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } }
          : false,
      },
    }),
    prisma.employee.count({ where }),
    prisma.department.findMany({
      where: { tenantId: viewer.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (patch: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { ...params, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, String(v));
    return `?${sp.toString()}`;
  };

  return (
    <>
      <PageHead
        title="Employees"
        subtitle={`${total} ${total === 1 ? "record" : "records"} you can see`}
        actions={
          <>
            {can(viewer, P.REPORT_VIEW) ? (
              <button className="btn"><IconDownload width={15} height={15} />Export</button>
            ) : null}
            {can(viewer, P.EMPLOYEE_CREATE) ? (
              <Link className="btn primary" href="/employees/new"><IconPlus width={15} height={15} />Add employee</Link>
            ) : null}
          </>
        }
      />

      {!isUnscoped ? (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" title="This list is scoped to you">
            You are seeing only the employees your roles reach — your own record, your
            reporting line, and any departments or locations your role grants are scoped to.
            An unscoped grant would show the whole organisation.
          </Callout>
        </div>
      ) : null}

      <Card tight>
        <form className="row gap-2 wrap" style={{ padding: 14, borderBottom: "1px solid var(--border)" }}>
          <input
            className="input" name="q" placeholder="Search name, number or email"
            defaultValue={params.q ?? ""} style={{ maxWidth: 280 }}
          />
          <select className="select" name="dept" defaultValue={params.dept ?? ""} style={{ maxWidth: 200 }}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="select" name="status" defaultValue={params.status ?? ""} style={{ maxWidth: 170 }}>
            <option value="">All statuses</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="PROBATION">Probation</option>
            <option value="NOTICE_PERIOD">Notice period</option>
            <option value="ONBOARDING">Onboarding</option>
            <option value="EXITED">Exited</option>
          </select>
          <button className="btn" type="submit">Filter</button>
          {params.q || params.dept || params.status ? (
            <Link className="btn ghost" href="/employees">Clear</Link>
          ) : null}
        </form>

        {employees.length === 0 ? (
          <Empty title="No employees match">Adjust the filters, or widen your search.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Number</th>
                  <th>Department</th>
                  <th>Location</th>
                  <th>Reports to</th>
                  <th>Joined</th>
                  {showFinancials ? <th className="num">Annual CTC</th> : null}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/employees/${e.id}`}>
                        <Person
                          name={e.displayName ?? `${e.firstName} ${e.lastName}`}
                          meta={e.jobTitleName ?? e.workEmail}
                        />
                      </Link>
                    </td>
                    <td className="mono">{e.employeeNumber}</td>
                    <td>{e.department?.name ?? <span className="subtle">—</span>}</td>
                    <td>
                      {e.location ? (
                        <span>{e.location.name} <span className="subtle text-xs">{e.location.stateCode}</span></span>
                      ) : <span className="subtle">—</span>}
                    </td>
                    <td className="text-sm">{e.reportingManager?.displayName ?? <span className="subtle">—</span>}</td>
                    <td className="text-sm nowrap">{formatDate(e.dateOfJoining)}</td>
                    {showFinancials ? (
                      <td className="num">
                        {e.salaryRevisions && e.salaryRevisions.length > 0
                          ? <Money value={e.salaryRevisions[0].annualCtc} compact />
                          : <span className="subtle">—</span>}
                      </td>
                    ) : null}
                    <td><StatusBadge status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="card-foot row gap-2" style={{ justifyContent: "space-between" }}>
            <span className="text-sm muted">Page {page} of {totalPages}</span>
            <div className="row gap-2">
              {page > 1 ? <Link className="btn sm" href={qs({ page: String(page - 1) })}>Previous</Link> : null}
              {page < totalPages ? <Link className="btn sm" href={qs({ page: String(page + 1) })}>Next</Link> : null}
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
