"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, ALL_PERMISSIONS, type Permission } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { z, parseForm, formList, writeAudit, actionDone as done, zName, type ActionState } from "@/lib/forms";

/**
 * Custom roles and role assignments — what lets a tenant hand out access
 * without a seed script.
 *
 * Built-in roles keep their key and their privilege list; a custom role is a
 * name plus any subset of the catalogue. A grant is (user × role × scope),
 * and an empty scope list means unscoped: every employee, whatever the
 * visibility settings say. Two guards keep a tenant from locking itself out:
 * the last unscoped Global Admin cannot be removed, and nobody can take away
 * their own ability to manage roles.
 */

const P = PERMISSIONS;
const KNOWN = new Set<string>(ALL_PERMISSIONS);

const roleSchema = z.object({
  id: z.string().optional(),
  name: zName(80),
  description: z.string().max(400).optional(),
});

function pickPermissions(formData: FormData): Permission[] {
  return [...new Set(formList(formData, "permission"))].filter((p): p is Permission => KNOWN.has(p));
}

/** Holders of ROLE_MANAGE after a change, to refuse one that leaves the viewer without it. */
async function viewerKeepsRoleManage(userId: string, change: { roleId: string; permissions?: Permission[]; dropAssignmentId?: string; deleteRole?: boolean }) {
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId },
    include: { role: { include: { permissions: true } } },
  });
  return assignments.some((a) => {
    if (a.id === change.dropAssignmentId) return false;
    if (a.roleId === change.roleId) {
      if (change.deleteRole) return false;
      if (change.permissions) return change.permissions.includes(P.ROLE_MANAGE);
    }
    return a.role.permissions.some((p) => p.permission === P.ROLE_MANAGE);
  });
}

export async function saveCustomRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const parsed = parseForm(roleSchema, formData);
  if (parsed.state) return parsed.state;
  const permissions = pickPermissions(formData);
  if (permissions.length === 0) return { ok: false, message: "Tick at least one permission. A role with none grants nothing." };
  const { id, name, description } = parsed.data;

  const clash = await prisma.role.findFirst({ where: { tenantId: viewer.tenantId, name, ...(id ? { NOT: { id } } : {}) }, select: { id: true } });
  if (clash) return { ok: false, message: "Another role already has that name.", errors: { name: "Already in use" } };

  if (id) {
    const role = await prisma.role.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { permissions: true } });
    if (!role) return { ok: false, message: "Role not found." };
    if (role.isSystem) return { ok: false, message: "Built-in roles cannot be changed. Duplicate it as a custom role instead." };
    if (!permissions.includes(P.ROLE_MANAGE) && !(await viewerKeepsRoleManage(viewer.user.id, { roleId: id, permissions }))) {
      return { ok: false, message: "Removing “Manage roles & permissions” here would take it away from you. Keep it, or have another administrator make the change." };
    }
    const before = role.permissions.map((p) => p.permission).sort();
    await prisma.$transaction([
      prisma.role.update({ where: { id }, data: { name, description: description || null } }),
      prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: id, permission })) }),
    ]);
    const added = permissions.filter((p) => !before.includes(p)).length;
    const removed = before.filter((p) => !permissions.includes(p as Permission)).length;
    await writeAudit(viewer, {
      module: "ROLE", action: "UPDATE", entityType: "Role", entityId: id,
      summary: `Updated custom role ${name}: ${permissions.length} permissions (+${added} / −${removed})`,
      oldValue: { name: role.name, permissions: before }, newValue: { name, permissions: [...permissions].sort() },
    });
    return done(["/admin/roles", `/admin/roles/${id}`], `Saved ${name}. Holders get the new permissions on their next page load.`);
  }

  const role = await prisma.role.create({
    data: {
      tenantId: viewer.tenantId, name, description: description || null, isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  await writeAudit(viewer, {
    module: "ROLE", action: "CREATE", entityType: "Role", entityId: role.id,
    summary: `Created custom role ${name} with ${permissions.length} permissions`, newValue: { name, permissions: [...permissions].sort() },
  });
  return done(["/admin/roles"], `Created ${name}. Assign it from the Assignments tab.`);
}

export async function duplicateRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const source = await prisma.role.findFirst({ where: { id: String(formData.get("id")), tenantId: viewer.tenantId }, include: { permissions: true } });
  if (!source) return { ok: false, message: "Role not found." };
  let name = `${source.name} (copy)`;
  for (let n = 2; await prisma.role.findFirst({ where: { tenantId: viewer.tenantId, name }, select: { id: true } }); n++) name = `${source.name} (copy ${n})`;
  const role = await prisma.role.create({
    data: {
      tenantId: viewer.tenantId, name, description: source.description, isSystem: false,
      permissions: { create: source.permissions.map((p) => ({ permission: p.permission })) },
    },
  });
  await writeAudit(viewer, { module: "ROLE", action: "CREATE", entityType: "Role", entityId: role.id, summary: `Duplicated ${source.name} as ${name}` });
  return done(["/admin/roles"], `Created ${name} with the same ${source.permissions.length} permissions. Open it to adjust.`);
}

export async function deleteCustomRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const role = await prisma.role.findFirst({ where: { id: String(formData.get("id")), tenantId: viewer.tenantId }, include: { _count: { select: { assignments: true } } } });
  if (!role) return { ok: false, message: "Role not found." };
  if (role.isSystem) return { ok: false, message: "Built-in roles cannot be deleted." };
  if (role._count.assignments > 0) return { ok: false, message: `${role.name} is assigned to ${role._count.assignments} user(s). Remove those assignments first.` };
  await prisma.role.delete({ where: { id: role.id } });
  await writeAudit(viewer, { module: "ROLE", action: "DELETE", entityType: "Role", entityId: role.id, summary: `Deleted custom role ${role.name}` });
  return done(["/admin/roles"], `Deleted ${role.name}.`);
}

const assignSchema = z.object({
  roleId: z.string().min(1, "Choose a role"),
  employeeId: z.string().min(1, "Choose a person"),
});

/** The department × location pairs a form submitted; none means unscoped. */
async function pickScopes(tenantId: string, formData: FormData) {
  const departments = formList(formData, "departmentId");
  const locations = formList(formData, "locationId");
  const [d, l] = await Promise.all([
    prisma.department.count({ where: { tenantId, id: { in: departments } } }),
    prisma.location.count({ where: { tenantId, id: { in: locations } } }),
  ]);
  if (d !== departments.length || l !== locations.length) return null;
  // Each ticked department and each ticked location is its own filter; an
  // employee matching any one of them is in scope.
  return [
    ...departments.map((departmentId) => ({ departmentId, locationId: null })),
    ...locations.map((locationId) => ({ departmentId: null, locationId })),
  ];
}

export async function assignRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const parsed = parseForm(assignSchema, formData);
  if (parsed.state) return parsed.state;
  const [role, employee] = await Promise.all([
    prisma.role.findFirst({ where: { id: parsed.data.roleId, tenantId: viewer.tenantId } }),
    prisma.employee.findFirst({ where: { id: parsed.data.employeeId, tenantId: viewer.tenantId }, select: { id: true, displayName: true, userId: true } }),
  ]);
  if (!role) return { ok: false, message: "Role not found.", errors: { roleId: "Not found" } };
  if (!employee) return { ok: false, message: "Person not found.", errors: { employeeId: "Not found" } };
  if (!employee.userId) return { ok: false, message: `${employee.displayName} has no login yet, so they cannot hold a role.`, errors: { employeeId: "No login" } };
  const scopes = await pickScopes(viewer.tenantId, formData);
  if (!scopes) return { ok: false, message: "A department or location in the scope no longer exists. Reload and try again." };

  const existing = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: employee.userId, roleId: role.id } }, include: { scopes: true } });
  if (existing && role.key === "GLOBAL_ADMIN" && existing.scopes.length === 0 && scopes.length > 0 && (await unscopedGlobalAdmins(viewer.tenantId)) <= 1) {
    return { ok: false, message: "This is the last unscoped Global Admin. Scoping it would leave nobody who can reach every employee." };
  }
  const assignment = await prisma.$transaction(async (tx) => {
    const a = existing ?? await tx.userRoleAssignment.create({ data: { userId: employee.userId!, roleId: role.id, grantedBy: viewer.user.id } });
    await tx.roleScope.deleteMany({ where: { assignmentId: a.id } });
    if (scopes.length) await tx.roleScope.createMany({ data: scopes.map((s) => ({ assignmentId: a.id, ...s })) });
    return a;
  });
  const reach = scopes.length === 0 ? "unscoped" : `${scopes.length} scope filter(s)`;
  await writeAudit(viewer, {
    module: "ROLE", action: existing ? "UPDATE" : "CREATE", entityType: "UserRoleAssignment", entityId: assignment.id,
    summary: `${existing ? "Re-scoped" : "Granted"} ${role.name} for ${employee.displayName} (${reach})`,
    oldValue: existing ? { scopes: existing.scopes.map((s) => ({ departmentId: s.departmentId, locationId: s.locationId })) } : undefined,
    newValue: { roleId: role.id, scopes },
  });
  return done(["/admin/roles"], existing
    ? `Updated the scope of ${employee.displayName}'s ${role.name} role (${reach}).`
    : `${employee.displayName} now holds ${role.name} (${reach}).`);
}

async function unscopedGlobalAdmins(tenantId: string) {
  return prisma.userRoleAssignment.count({
    where: { role: { tenantId, key: "GLOBAL_ADMIN" }, scopes: { none: {} }, user: { loginDisabled: false, isDeactivated: false } },
  });
}

export async function removeAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const a = await prisma.userRoleAssignment.findFirst({
    where: { id: String(formData.get("id")), role: { tenantId: viewer.tenantId } },
    include: { role: true, scopes: true, user: { select: { email: true, employee: { select: { displayName: true } } } } },
  });
  if (!a) return { ok: false, message: "Assignment not found." };
  if (a.role.key === "GLOBAL_ADMIN" && a.scopes.length === 0 && (await unscopedGlobalAdmins(viewer.tenantId)) <= 1) {
    return { ok: false, message: "This is the last unscoped Global Admin. Grant the role to someone else before removing it here." };
  }
  if (a.userId === viewer.user.id && !(await viewerKeepsRoleManage(viewer.user.id, { roleId: a.roleId, dropAssignmentId: a.id }))) {
    return { ok: false, message: "This is the role that lets you manage roles. Have another administrator remove it." };
  }
  await prisma.userRoleAssignment.delete({ where: { id: a.id } });
  const who = a.user.employee?.displayName ?? a.user.email;
  await writeAudit(viewer, { module: "ROLE", action: "DELETE", entityType: "UserRoleAssignment", entityId: a.id, summary: `Removed ${a.role.name} from ${who}` });
  return done(["/admin/roles"], `Removed ${a.role.name} from ${who}.`);
}
