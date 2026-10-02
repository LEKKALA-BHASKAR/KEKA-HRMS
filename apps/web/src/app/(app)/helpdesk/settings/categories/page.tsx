import { prisma } from "@keka/db";
import { parseHelpdeskAudience, PREDEFINED_CATEGORIES } from "@keka/services";
import { requireHelpdeskAgent } from "../../_ui/access";
import { HelpdeskTabs, SettingsTabs } from "../../_ui/tabs";
import { userOptions } from "../../_ui/ticket-access";
import { CategoryBoard, type CategoryValue } from "../../_ui/settings-categories";
import s from "../../_ui/hd.module.css";

/** Settings › Ticket Categories: who can raise what, who works it, and its targets. */
export default async function CategoriesPage() {
  const { viewer } = await requireHelpdeskAgent({ settings: true });
  const t = viewer.tenantId;
  const [cats, users, employees, departments, locations, businessUnits, hours, used] = await Promise.all([
    prisma.helpdeskCategory.findMany({
      where: { tenantId: t, parentId: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        agents: { select: { userId: true } },
        children: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, description: true, defaultAssigneeUserId: true, isActive: true } },
      },
    }),
    userOptions(t),
    prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED", "INACTIVE"] } }, orderBy: { displayName: "asc" }, select: { id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true } }),
    prisma.department.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.businessUnit.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.helpdeskBusinessHours.findMany({ where: { tenantId: t }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, isDefault: true } }),
    prisma.helpdeskTicket.groupBy({ by: ["categoryId"], where: { tenantId: t }, _count: { _all: true } }),
  ]);
  const ticketsIn = new Map(used.map((u) => [u.categoryId, u._count._all]));
  const taken = new Set((await prisma.helpdeskCategory.findMany({ where: { tenantId: t }, select: { name: true } })).map((c) => c.name.toLowerCase()));

  const categories: CategoryValue[] = cats.map((c) => {
    const a = parseHelpdeskAudience(c.audience);
    const audienceType = !a ? "ALL" : a.employeeIds?.length ? "EMPLOYEES" : "GROUPS";
    return {
      id: c.id, name: c.name, description: c.description, isActive: c.isActive,
      tickets: (ticketsIn.get(c.id) ?? 0) + c.children.reduce((n, k) => n + (ticketsIn.get(k.id) ?? 0), 0),
      audienceType,
      audience: { employeeIds: a?.employeeIds ?? [], departmentIds: a?.departmentIds ?? [], locationIds: a?.locationIds ?? [], businessUnitIds: a?.businessUnitIds ?? [] },
      defaultAssigneeUserId: c.defaultAssigneeUserId, agentUserIds: c.agents.map((x) => x.userId), assignMode: c.assignMode,
      businessHoursId: c.businessHoursId, enableOnHold: c.enableOnHold, firstResponseHours: c.firstResponseHours, slaHours: c.slaHours, defaultPriority: c.defaultPriority,
      subcategories: c.children.map((k) => ({ id: k.id, name: k.name, description: k.description, head: k.defaultAssigneeUserId === c.defaultAssigneeUserId ? null : k.defaultAssigneeUserId, isActive: k.isActive })),
    };
  });

  return (
    <div className={s.page}>
      <HelpdeskTabs canSettings active="/helpdesk/settings/categories" />
      <SettingsTabs active="categories" />
      <CategoryBoard
        categories={categories}
        options={{
          users: users.map((u) => ({ value: u.value, label: u.label })),
          employees: employees.map((e) => ({ value: e.id, label: `${e.displayName ?? `${e.firstName} ${e.lastName}`} (${e.employeeNumber})` })),
          departments: departments.map((d) => ({ value: d.id, label: d.name })),
          locations: locations.map((d) => ({ value: d.id, label: d.name })),
          businessUnits: businessUnits.map((d) => ({ value: d.id, label: d.name })),
          businessHours: hours.map((h) => ({ value: h.id, label: h.isDefault ? `${h.name} (default)` : h.name })),
          predefined: PREDEFINED_CATEGORIES.map((p) => ({ name: p.name, description: p.description, subcategories: p.subcategories.length, exists: taken.has(p.name.toLowerCase()) })),
        }}
      />
    </div>
  );
}
