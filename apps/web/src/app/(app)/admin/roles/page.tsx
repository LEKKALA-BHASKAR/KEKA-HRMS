import Link from "next/link";
import { prisma } from "@keka/db";
import {
  PERMISSIONS, PERMISSION_GROUPS, SYSTEM_ROLES, IMPLICIT_ROLES,
  SELF_PERMISSIONS, ALL_PERMISSIONS,
} from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, Person } from "@/components/ui";
import { AssignRoleForm, RemoveAssignmentButton } from "./forms";

const P = PERMISSIONS;

const TABS = ["roles", "implicit", "assignments", "matrix"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  roles: "User roles",
  implicit: "Implicit roles",
  assignments: "Assignments & scopes",
  matrix: "Permission matrix",
};

export default async function RolesPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const sp = await searchParams;
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : "roles") as Tab;

  const [roles, assignments, visibility] = await Promise.all([
    prisma.role.findMany({
      where: { tenantId: viewer.tenantId },
      include: {
        permissions: true,
        _count: { select: { assignments: true } },
      },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    }),
    prisma.userRoleAssignment.findMany({
      where: { role: { tenantId: viewer.tenantId } },
      include: {
        role: { select: { name: true, key: true, isSystem: true } },
        scopes: true,
        user: {
          select: {
            email: true, loginDisabled: true,
            employee: {
              select: {
                id: true, displayName: true, employeeNumber: true, jobTitleName: true,
              },
            },
          },
        },
      },
      orderBy: { grantedAt: "desc" },
    }),
    prisma.tenantVisibilitySetting.findUnique({ where: { tenantId: viewer.tenantId } }),
  ]);

  const departments = await prisma.department.findMany({
    where: { tenantId: viewer.tenantId },
    select: { id: true, name: true },
  });
  const locations = await prisma.location.findMany({
    where: { tenantId: viewer.tenantId },
    select: { id: true, name: true },
  });
  const people = await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, userId: { not: null }, status: { not: "EXITED" } },
    select: { id: true, displayName: true, employeeNumber: true },
    orderBy: { displayName: "asc" },
  });
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const locName = new Map(locations.map((l) => [l.id, l.name]));

  return (
    <>
      <PageHead
        title="Roles & permissions"
        subtitle="Two role families — explicit roles you assign, and implicit roles derived from position in the org tree"
        actions={<Link className="btn primary" href="/admin/roles/new">New custom role</Link>}
      />

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/roles?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
          </Link>
        ))}
      </div>

      {tab === "roles" ? (
        <div className="stack gap-4">
          <Callout tone="warning" title="How privilege and visibility combine">
            The combining rule is <strong>scope of privilege UNION scope of visibility</strong>.
            An <em>unscoped</em> role therefore reaches every employee regardless of the
            org-wide visibility restriction — visibility is a directory control, not a hard
            data partition. Anything that genuinely must not leak between businesses needs a
            separate tenant.
            {visibility ? (
              <div className="row gap-2" style={{ marginTop: 8 }}>
                <Badge tone={visibility.restrictByLegalEntity ? "info" : "neutral"}>
                  Restrict by legal entity: {visibility.restrictByLegalEntity ? "on" : "off"}
                </Badge>
                <Badge tone={visibility.restrictByBusinessUnit ? "info" : "neutral"}>
                  Restrict by business unit: {visibility.restrictByBusinessUnit ? "on" : "off"}
                </Badge>
                <Badge tone={visibility.managerReporteeOverride ? "info" : "neutral"}>
                  Manager/reportee override: {visibility.managerReporteeOverride ? "on" : "off"}
                </Badge>
              </div>
            ) : null}
          </Callout>

          <Card
            title={`User roles (${roles.length})`}
            description={`${roles.filter((r) => r.isSystem).length} built-in, ${roles.filter((r) => !r.isSystem).length} custom. Built-in roles cannot be deleted.`}
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Role</th><th>Key</th><th className="num">Permissions</th>
                    <th className="num">Assigned to</th><th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/admin/roles/${r.id}`} className="strong">{r.name}</Link>
                        <div className="text-xs subtle" style={{ maxWidth: 560 }}>{r.description}</div>
                      </td>
                      <td className="mono text-xs">{r.key ?? <span className="subtle">custom</span>}</td>
                      <td className="num">
                        {r.permissions.length}
                        {r.permissions.length === ALL_PERMISSIONS.length
                          ? <Badge tone="danger">all</Badge> : null}
                      </td>
                      <td className="num">{r._count.assignments}</td>
                      <td>
                        {r.isSystem
                          ? <Badge tone="neutral">Built-in</Badge>
                          : <Badge tone="brand">Custom</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "implicit" ? (
        <div className="stack gap-4">
          <Callout tone="info" title="Never granted manually">
            Implicit roles are derived from position and re-evaluated on every request.
            Give someone direct reports and they become a Reporting Manager; make them head
            of a department and they become a Department Head. Their permissions apply only
            to the people inside that derived scope.
          </Callout>

          {IMPLICIT_ROLES.map((r) => (
            <Card key={r.key} title={r.name} description={r.description} tight>
              <div style={{ padding: 14 }}>
                <div className="row gap-1 wrap">
                  {r.permissions.map((p) => (
                    <span key={p} className="badge neutral mono" style={{ fontSize: 10.5 }}>{p}</span>
                  ))}
                </div>
              </div>
            </Card>
          ))}

          <Card
            title="Self permissions"
            description="Held by every employee over their own record only. This is why an employee can open the Employees list and see exactly one person."
            tight
          >
            <div style={{ padding: 14 }}>
              <div className="row gap-1 wrap">
                {SELF_PERMISSIONS.map((p) => (
                  <span key={p} className="badge neutral mono" style={{ fontSize: 10.5 }}>{p}</span>
                ))}
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "assignments" ? (
        <div className="stack gap-4">
        <Card title="Grant or re-scope a role" description="Pick a person and a role. Tick departments or locations to limit whose records the role reaches." tight>
          <AssignRoleForm
            roles={roles.map((r) => ({ id: r.id, name: r.name }))}
            people={people.map((p) => ({ id: p.id, label: `${p.displayName ?? p.employeeNumber} · ${p.employeeNumber}` }))}
            departments={departments}
            locations={locations}
          />
        </Card>
        <Card
          title={`Role assignments (${assignments.length})`}
          description="A grant is (user × role × scope). Scope filters cover department and location — legal entity is deliberately not available as a role scope."
          tight
        >
          {assignments.length === 0 ? <Empty title="No roles assigned" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>User</th><th>Role</th><th>Scope</th><th>Effective reach</th><th /></tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.user.employee ? (
                          <Link href={`/employees/${a.user.employee.id}`}>
                            <Person
                              name={a.user.employee.displayName ?? a.user.email}
                              meta={`${a.user.employee.employeeNumber} · ${a.user.employee.jobTitleName ?? ""}`}
                            />
                          </Link>
                        ) : (
                          <span className="text-sm">{a.user.email}</span>
                        )}
                        {a.user.loginDisabled ? <Badge tone="danger">login disabled</Badge> : null}
                      </td>
                      <td>
                        <span className="strong">{a.role.name}</span>
                        {a.role.isSystem ? null : <Badge tone="brand">custom</Badge>}
                      </td>
                      <td>
                        {a.scopes.length === 0 ? (
                          <Badge tone="warning">Unscoped</Badge>
                        ) : (
                          <div className="row gap-1 wrap">
                            {a.scopes.map((s) => (
                              <Badge key={s.id} tone="info">
                                {s.departmentId ? deptName.get(s.departmentId) ?? "dept" : null}
                                {s.departmentId && s.locationId ? " + " : null}
                                {s.locationId ? locName.get(s.locationId) ?? "location" : null}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="text-sm muted">
                        {a.scopes.length === 0
                          ? "Every employee in the tenant — the UNION rule overrides visibility restrictions"
                          : `Only employees matching ${a.scopes.length} scope filter(s)`}
                      </td>
                      <td><RemoveAssignmentButton id={a.id} label={`${a.role.name} from ${a.user.employee?.displayName ?? a.user.email}`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </div>
      ) : null}

      {tab === "matrix" ? (
        <div className="stack gap-4">
          <Callout tone="info" title={`${ALL_PERMISSIONS.length} permissions across ${PERMISSION_GROUPS.length} modules`}>
            A custom role is nothing more than a subset of these. This matrix shows which
            built-in roles carry each permission.
          </Callout>

          {PERMISSION_GROUPS.map((group) => (
            <Card key={group.module} title={group.label} tight>
              <div className="table-wrap">
                <table className="data" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Permission</th>
                      {SYSTEM_ROLES.map((r) => (
                        <th key={r.key} className="num" title={r.name}>
                          {r.name.split(" ").map((w) => w[0]).join("")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.permissions.map((perm) => (
                      <tr key={perm.key}>
                        <td>
                          <span className="strong">{perm.label}</span>
                          <div className="mono text-xs subtle">{perm.key}</div>
                        </td>
                        {SYSTEM_ROLES.map((r) => (
                          <td key={r.key} className="num">
                            {r.permissions.includes(perm.key)
                              ? <span style={{ color: "var(--success)" }}>&#10003;</span>
                              : <span className="subtle">·</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}

          <Card title="Role key" tight>
            <div style={{ padding: 14 }}>
              <div className="grid grid-3">
                {SYSTEM_ROLES.map((r) => (
                  <div key={r.key} className="row gap-2">
                    <Badge tone="neutral">{r.name.split(" ").map((w) => w[0]).join("")}</Badge>
                    <span className="text-sm">{r.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
