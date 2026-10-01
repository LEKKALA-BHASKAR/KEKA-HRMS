import "server-only";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { presetWindow, utcDay, type Window } from "@keka/services";
import { scopedEmployeeWhere } from "../scope";
import type { Viewer } from "../context";

/**
 * Analytics filters live in the URL, so a chart, its raw data, its export and
 * the AI digest are all computed from the same parameters on the server. Ids
 * are never trusted: they only ever narrow a where-clause that is already
 * bound to the viewer's tenant and analytics scope.
 */

export const DIM_KEYS = ["bu", "le", "dept", "loc", "cc", "wt"] as const;
export const POST_KEYS = ["xt", "xr", "g", "perf", "ten"] as const;
export type DimKey = (typeof DIM_KEYS)[number];
export type PostKey = (typeof POST_KEYS)[number];
export const RANGES = ["3m", "6m", "9m", "12m"] as const;
export type RangeKey = (typeof RANGES)[number] | "custom";

export interface AnalyticsFilters {
  dims: Record<DimKey, string[]>;
  post: Record<PostKey, string[]>;
  range: RangeKey;
  from?: string;
  to?: string;
}

/** "Unassigned" in a dimension filter. */
export const NONE = "none";

type SP = Record<string, string | string[] | undefined>;
const list = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v.join(",") : v ?? "").split(",").map((s) => s.trim()).filter((s) => /^[\w-]{1,40}$/.test(s)).slice(0, 50);
const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function parseFilters(sp: SP, defaultRange: RangeKey = "12m"): AnalyticsFilters {
  const dims = Object.fromEntries(DIM_KEYS.map((k) => [k, list(sp[k])])) as Record<DimKey, string[]>;
  const post = Object.fromEntries(POST_KEYS.map((k) => [k, list(sp[k])])) as Record<PostKey, string[]>;
  const r = typeof sp.range === "string" ? sp.range : undefined;
  const from = typeof sp.from === "string" && isDate(sp.from) ? sp.from : undefined;
  const to = typeof sp.to === "string" && isDate(sp.to) ? sp.to : undefined;
  if (from && to && from <= to) return { dims, post, range: "custom", from, to };
  return { dims, post, range: (RANGES as readonly string[]).includes(r ?? "") ? (r as RangeKey) : defaultRange };
}

/** The filters back as a query string (no leading "?"), with optional overrides. */
export function filterQuery(f: AnalyticsFilters, extra: Record<string, string | undefined> = {}, drop: string[] = []): string {
  const u = new URLSearchParams();
  for (const k of DIM_KEYS) if (f.dims[k].length && !drop.includes(k)) u.set(k, f.dims[k].join(","));
  for (const k of POST_KEYS) if (f.post[k].length && !drop.includes(k)) u.set(k, f.post[k].join(","));
  if (!drop.includes("range")) {
    if (f.range === "custom") { u.set("from", f.from!); u.set("to", f.to!); } else u.set("range", f.range);
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") u.set(k, v);
  return u.toString();
}

export function analyticsToday(): Date {
  return utcDay(new Date());
}

export function windowOf(f: AnalyticsFilters, today = analyticsToday()): Window {
  if (f.range === "custom" && f.from && f.to) return { from: new Date(`${f.from}T00:00:00Z`), to: new Date(`${f.to}T00:00:00Z`) };
  const months = Number((f.range === "custom" ? "12m" : f.range).replace("m", ""));
  return presetWindow(today, months);
}

const COLUMN: Record<DimKey, keyof Prisma.EmployeeWhereInput> = {
  bu: "businessUnitId", le: "legalEntityId", dept: "departmentId", loc: "locationId", cc: "costCenterId", wt: "workerTypeId",
};

/** Employees in the viewer's analytics scope, narrowed by the dimension filters. */
export function employeeWhere(viewer: Viewer, f: AnalyticsFilters, scope = PERMISSIONS.ANALYTICS_VIEW): Prisma.EmployeeWhereInput {
  const and: Prisma.EmployeeWhereInput[] = [scopedEmployeeWhere(viewer, scope) as Prisma.EmployeeWhereInput];
  for (const k of DIM_KEYS) {
    const vals = f.dims[k];
    if (!vals.length) continue;
    const ids = vals.filter((v) => v !== NONE);
    const ors: Prisma.EmployeeWhereInput[] = [];
    if (ids.length) ors.push({ [COLUMN[k]]: { in: ids } });
    if (vals.includes(NONE)) ors.push({ [COLUMN[k]]: null });
    and.push({ OR: ors });
  }
  return { tenantId: viewer.tenantId, AND: and };
}

export interface FilterOption { value: string; label: string }
export interface FilterOptions {
  bu: FilterOption[]; le: FilterOption[]; dept: FilterOption[]; loc: FilterOption[]; cc: FilterOption[]; wt: FilterOption[];
  xt: FilterOption[]; xr: FilterOption[]; g: FilterOption[]; perf: FilterOption[]; ten: FilterOption[];
}

export const EXIT_TYPE_LABEL: Record<string, string> = {
  RESIGNATION: "Resignation", TERMINATION: "Termination", RETIREMENT: "Retirement", ABSCONDING: "Absconding", END_OF_CONTRACT: "End of contract", DEATH: "Death",
};
export const GENDER_LABEL: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Non-binary", UNDISCLOSED: "Prefer not to respond" };

/** Option lists for every filter, tenant-bound. */
export async function filterOptions(tenantId: string): Promise<FilterOptions> {
  const [bu, le, dept, loc, cc, wt, xr] = await Promise.all([
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.exitReason.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { displayOrder: "asc" } }),
  ]);
  const o = (rows: Array<{ id: string; name: string }>) => rows.map((r) => ({ value: r.id, label: r.name }));
  return {
    bu: o(bu), le: o(le), dept: o(dept), loc: o(loc), cc: o(cc), wt: o(wt), xr: o(xr),
    xt: Object.entries(EXIT_TYPE_LABEL).map(([value, label]) => ({ value, label })),
    g: Object.entries(GENDER_LABEL).map(([value, label]) => ({ value, label })),
    perf: ["1-2", "2-3", "3-4", "4-5", "none"].map((v) => ({ value: v, label: v === "none" ? "Not rated" : v })),
    ten: ["lt1", "1-2", "2-3", "3-5", "5-10", "10plus"].map((v) => ({ value: v, label: v === "lt1" ? "<1 year" : v === "10plus" ? "10+ years" : `${v} years` })),
  };
}

/** Tenure filter tokens are URL-safe stand-ins for the band labels. */
export const TEN_TOKEN: Record<string, string> = { lt1: "<1", "1-2": "1-2", "2-3": "2-3", "3-5": "3-5", "5-10": "5-10", "10plus": "10+" };
