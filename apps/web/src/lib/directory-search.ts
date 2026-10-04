import "server-only";
import { prisma } from "@keka/db";
import { DIRECTORY_TENURE_BANDS, cleanDirectoryQuery } from "@keka/services";
import type { Viewer } from "./context";
import { directoryWhere, DIRECTORY_SELECT } from "./directory";
import { directoryParams, directorySearchWhere, directoryVisibilityWhere, DIRECTORY_PARAM_KEYS, type DirectoryParams } from "./core-hr";

/** A card needs every directory field except the free-text "about me". */
const { aboutMe: _about, ...CARD_SELECT } = DIRECTORY_SELECT;

export const DIRECTORY_FILTERS = [
  { key: "bu", label: "Business Unit" }, { key: "dept", label: "Department" }, { key: "loc", label: "Location" },
  { key: "cc", label: "Cost Center" }, { key: "le", label: "Legal Entity" }, { key: "div", label: "Division" },
  { key: "team", label: "Team" }, { key: "mgr", label: "Manager" }, { key: "wt", label: "Employment type" },
  { key: "tenure", label: "Tenure" }, { key: "skill", label: "Skill" }, { key: "shift", label: "Shift today" },
] as const satisfies ReadonlyArray<{ key: keyof DirectoryParams; label: string }>;

/**
 * Everything the directory page shows for a set of URL parameters: the
 * people (visibility settings applied), how many match, the dropdowns, and
 * the viewer's saved and recent searches. A filtered first page is logged
 * as a search, so HR can see what people look for and do not find.
 */
export async function loadDirectory(viewer: Viewer, sp: Record<string, string | string[] | undefined>, opts: { show: number; log?: boolean }) {
  const t = viewer.tenantId;
  const p = directoryParams(sp);
  const where = await directorySearchWhere(viewer, p);
  const visible = { AND: [directoryWhere(t), await directoryVisibilityWhere(viewer)] };
  const has = (selected: string) => ({ tenantId: t, OR: [{ employees: { some: visible } }, ...(selected ? [{ id: selected }] : [])] });
  const opt = { select: { id: true, name: true }, orderBy: { name: "asc" as const } };
  const [people, matched, bus, depts, locs, ccs, les, divs, teams, managers, types, skills, shifts, saved, recent] = await Promise.all([
    prisma.employee.findMany({ where, select: CARD_SELECT, take: opts.show, orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }] }),
    prisma.employee.count({ where }),
    prisma.businessUnit.findMany({ where: has(p.bu), ...opt }),
    prisma.department.findMany({ where: has(p.dept), ...opt }),
    prisma.location.findMany({ where: has(p.loc), ...opt }),
    prisma.costCenter.findMany({ where: has(p.cc), ...opt }),
    prisma.legalEntity.findMany({ where: has(p.le), ...opt }),
    prisma.division.findMany({ where: { tenantId: t, isActive: true }, ...opt }),
    prisma.orgTeam.findMany({ where: { tenantId: t, isActive: true }, ...opt }),
    prisma.employee.findMany({ where: { AND: [visible, { OR: [{ directReports: { some: {} } }, ...(p.mgr ? [{ id: p.mgr }] : [])] }] }, select: { id: true, displayName: true, firstName: true, lastName: true }, orderBy: { firstName: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId: t }, ...opt }),
    prisma.skill.findMany({ where: { tenantId: t }, ...opt }),
    prisma.shift.findMany({ where: { tenantId: t }, ...opt }),
    prisma.directorySavedSearch.findMany({ where: { tenantId: t, userId: viewer.user.id }, orderBy: { name: "asc" } }),
    prisma.directorySearchLog.findMany({ where: { tenantId: t, userId: viewer.user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const options: Record<string, Array<{ id: string; name: string }>> = {
    bu: bus, dept: depts, loc: locs, cc: ccs, le: les, div: divs, team: teams,
    mgr: managers.map((m) => ({ id: m.id, name: m.displayName ?? `${m.firstName} ${m.lastName}` })),
    wt: types, tenure: DIRECTORY_TENURE_BANDS.map((b) => ({ id: b.key, name: b.label })), skill: skills, shift: shifts,
  };
  const filters = DIRECTORY_FILTERS.map((f) => ({ key: f.key, label: f.label, value: p[f.key], options: options[f.key] ?? [] }));
  const query = cleanDirectoryQuery(new URLSearchParams(Object.fromEntries(DIRECTORY_PARAM_KEYS.filter((k) => p[k]).map((k) => [k, p[k]]))).toString());
  if (opts.log !== false && query && (!recent[0] || recent[0].query !== query)) {
    await prisma.directorySearchLog.create({ data: { tenantId: t, userId: viewer.user.id, query, resultCount: matched } });
  }
  const recentUnique = [...new Map(recent.map((r) => [r.query, r])).values()].slice(0, 6);
  return { params: p, people, matched, filters, query, saved, recent: recentUnique, filtered: !!query };
}
