/**
 * Custom roles and assignments through the actions: who may manage roles;
 * creating, editing, duplicating and deleting a custom role; built-in roles
 * staying fixed; granting a role with and without a scope and the viewer's
 * permissions following on their next request; and the two lock-out guards
 * (the last unscoped Global Admin, and an administrator removing their own
 * ability to manage roles).
 *
 * Everything the suite creates is named "Smoke …" and removed at the end, so
 * it can run again.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";
import { PERMISSIONS as P } from "@keka/rbac";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

/** FormData with repeated keys, as checkbox groups submit. */
function multi(values: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

async function main() {
  const act = await import("../apps/web/src/app/actions/roles");
  const ctx = await import("../apps/web/src/lib/context");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } } });
  const engineering = await prisma.department.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Product Engineering" } });
  const smokeRoles = () => prisma.role.findMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke" } }, include: { permissions: true, assignments: { include: { scopes: true } } } });

  console.log("\nRoles and assignments\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot create a role", await denied(() => act.saveCustomRoleAction({}, multi({ name: "Smoke X", permission: [P.EMPLOYEE_VIEW_ALL] }))));
    check("…or grant one", await denied(() => act.assignRoleAction({}, fd({ roleId: "x", employeeId: meera.id }))));
    await signInAs("ramesh.iyer@acme.test");
    check("A payroll admin cannot manage roles", await denied(() => act.saveCustomRoleAction({}, multi({ name: "Smoke X", permission: [P.EMPLOYEE_VIEW_ALL] }))));

    // -----------------------------------------------------------------------
    section("Custom roles");
    await signInAs("vikram.menon@acme.test");
    const none = await act.saveCustomRoleAction({}, multi({ name: "Smoke Auditor" }));
    check("A role with no permissions is refused", none.ok === false, none.message);
    const bogus = await act.saveCustomRoleAction({}, multi({ name: "Smoke Auditor", permission: ["not.a.permission"] }));
    check("Unknown permission keys are ignored, not stored", bogus.ok === false, bogus.message);
    const created = await act.saveCustomRoleAction({}, multi({ name: "Smoke Auditor", description: "Reads people records", permission: [P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_VIEW_ALL] }));
    let [role] = await smokeRoles();
    check("A custom role is created with its permissions, duplicates dropped", created.ok === true && !!role && !role.isSystem && role.key === null && role.permissions.length === 2, created.message);
    const clash = await act.saveCustomRoleAction({}, multi({ name: "Smoke Auditor", permission: [P.EMPLOYEE_VIEW] }));
    check("Two roles cannot share a name", clash.ok === false && !!clash.errors?.name, clash.message);
    const gm = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: "GLOBAL_ADMIN" } });
    const sysEdit = await act.saveCustomRoleAction({}, multi({ id: gm.id, name: gm.name, permission: [P.EMPLOYEE_VIEW] }));
    check("A built-in role cannot be edited", sysEdit.ok === false && (await prisma.rolePermission.count({ where: { roleId: gm.id } })) > 100, sysEdit.message);
    const sysDelete = await act.deleteCustomRoleAction({}, fd({ id: gm.id }));
    check("…or deleted", sysDelete.ok === false, sysDelete.message);
    const hr = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: "HR_MANAGER" } });
    const dup = await act.duplicateRoleAction({}, fd({ id: hr.id }));
    const copy = await prisma.role.findFirst({ where: { tenantId: tenant.id, name: `${hr.name} (copy)` }, include: { permissions: true } });
    const hrCount = await prisma.rolePermission.count({ where: { roleId: hr.id } });
    check("Duplicating a built-in role makes an editable custom copy", dup.ok === true && !!copy && !copy.isSystem && copy.permissions.length === hrCount, dup.message);
    if (copy) await prisma.role.update({ where: { id: copy.id }, data: { name: "Smoke HR copy" } });

    // -----------------------------------------------------------------------
    section("Assignments and scope");
    const scoped = await act.assignRoleAction({}, multi({ roleId: role.id, employeeId: meera.id, departmentId: [engineering.id] }));
    [role] = (await smokeRoles()).filter((r) => r.name === "Smoke Auditor");
    check("A role is granted with a department scope", scoped.ok === true && role.assignments.length === 1 && role.assignments[0].scopes.length === 1 && role.assignments[0].scopes[0].departmentId === engineering.id, scoped.message);
    await signInAs("meera.krishnan@acme.test");
    let viewer = await ctx.requireViewer();
    check("The holder has the role's permissions on their next request", viewer.permissions.has(P.EMPLOYEE_VIEW_ALL) && viewer.roleNames.includes("Smoke Auditor"));
    check("…limited to the granted scope", viewer.grants.find((g) => g.roleName === "Smoke Auditor")?.scopes.length === 1);

    await signInAs("vikram.menon@acme.test");
    const unscope = await act.assignRoleAction({}, multi({ roleId: role.id, employeeId: meera.id }));
    [role] = (await smokeRoles()).filter((r) => r.name === "Smoke Auditor");
    check("Granting it again with no scope re-scopes the same grant to everyone", unscope.ok === true && role.assignments.length === 1 && role.assignments[0].scopes.length === 0, unscope.message);
    const badScope = await act.assignRoleAction({}, multi({ roleId: role.id, employeeId: meera.id, locationId: ["missing"] }));
    check("A scope naming a missing location is refused", badScope.ok === false, badScope.message);

    const edit = await act.saveCustomRoleAction({}, multi({ id: role.id, name: "Smoke Auditor", permission: [P.EMPLOYEE_VIEW] }));
    await signInAs("meera.krishnan@acme.test");
    viewer = await ctx.requireViewer();
    check("Editing the role changes what its holders can do", edit.ok === true && !viewer.permissions.has(P.EMPLOYEE_VIEW_ALL), edit.message);

    await signInAs("vikram.menon@acme.test");
    const busy = await act.deleteCustomRoleAction({}, fd({ id: role.id }));
    check("A role still assigned cannot be deleted", busy.ok === false && /assigned/.test(busy.message ?? ""), busy.message);

    // -----------------------------------------------------------------------
    section("Lock-out guards");
    const me = await prisma.userRoleAssignment.findFirstOrThrow({ where: { roleId: gm.id, user: { email: "vikram.menon@acme.test" } } });
    const lastGa = await prisma.userRoleAssignment.count({ where: { roleId: gm.id, scopes: { none: {} } } });
    if (lastGa === 1) {
      const removeLast = await act.removeAssignmentAction({}, fd({ id: me.id }));
      check("The last unscoped Global Admin cannot be removed", removeLast.ok === false && /last unscoped Global Admin/.test(removeLast.message ?? ""), removeLast.message);
      const vikram = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "vikram.menon@acme.test" } } });
      const scopeLast = await act.assignRoleAction({}, multi({ roleId: gm.id, employeeId: vikram.id, departmentId: [engineering.id] }));
      check("…or scoped down", scopeLast.ok === false && (await prisma.roleScope.count({ where: { assignmentId: me.id } })) === 0, scopeLast.message);
    } else {
      check("Seed has a single unscoped Global Admin to test the guard against", false, `found ${lastGa}`);
    }
    // A custom role that is an administrator's only route to role management.
    const keeper = await act.saveCustomRoleAction({}, multi({ name: "Smoke Role Keeper", permission: [P.ROLE_MANAGE] }));
    const keeperRole = (await smokeRoles()).find((r) => r.name === "Smoke Role Keeper")!;
    const priya = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "priya.sharma@acme.test" } } });
    await act.assignRoleAction({}, multi({ roleId: keeperRole.id, employeeId: priya.id }));
    await signInAs("priya.sharma@acme.test");
    const strip = await act.saveCustomRoleAction({}, multi({ id: keeperRole.id, name: "Smoke Role Keeper", permission: [P.EMPLOYEE_VIEW] }));
    check("An administrator cannot remove role management from their only role that grants it", keeper.ok === true && strip.ok === false, strip.message);
    const keeperGrant = await prisma.userRoleAssignment.findFirstOrThrow({ where: { roleId: keeperRole.id } });
    const selfRemove = await act.removeAssignmentAction({}, fd({ id: keeperGrant.id }));
    check("…or remove that role from themselves", selfRemove.ok === false, selfRemove.message);

    // -----------------------------------------------------------------------
    section("Removing and deleting");
    await signInAs("vikram.menon@acme.test");
    const grant = await prisma.userRoleAssignment.findFirstOrThrow({ where: { roleId: role.id } });
    const removed = await act.removeAssignmentAction({}, fd({ id: grant.id }));
    const gone = await act.deleteCustomRoleAction({}, fd({ id: role.id }));
    check("An assignment is removed, then the unused role deleted", removed.ok === true && gone.ok === true && !(await prisma.role.findUnique({ where: { id: role.id } })), `${removed.message} / ${gone.message}`);
    const audits = await prisma.auditLog.count({ where: { tenantId: tenant.id, module: "ROLE", summary: { contains: "Smoke Auditor" } } });
    check("Every role change is in the audit log", audits >= 5, `${audits} entries`);
  } finally {
    await prisma.role.deleteMany({ where: { tenantId: tenant.id, name: { startsWith: "Smoke" } } });
    await prisma.role.deleteMany({ where: { tenantId: tenant.id, isSystem: false, name: { endsWith: "(copy)" } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, module: "ROLE", OR: [{ summary: { contains: "Smoke" } }, { summary: { contains: "(copy)" } }] } });
  }
  report("Roles and assignments");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
