/**
 * Core HR depth, second pass — the pure rules, with no database access, so
 * the unit tests cover them directly: configuration snapshots and their
 * diffs, setup completeness and entity readiness scores, hierarchies and
 * inheritance, as-of-date org reconstruction and snapshot comparison,
 * reorganisation impact, cross-entity transfer rules, dependent
 * relationships, duplicate people, completeness rules, nominee shares,
 * HR transaction SLAs and ageing, quality-control sampling, vCards,
 * coworker suggestions, data freshness and company date formats.
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
//  Workflow request types (routed by the workflow engine's default case)
// ---------------------------------------------------------------------------

export const CORE2_WORKFLOW_ENTITY_TYPES = {
  PRIVACY_REQUEST: "Employee data-privacy requests",
  ID_CARD_REQUEST: "Employee ID card requests",
  DIRECTORY_LISTING: "Requests to be left out of the directory",
  INTERCOMPANY_ASSIGNMENT: "Intercompany employee assignments",
  ENTITY_TRANSITION: "Entity mergers, spin-offs and acquisitions",
  REORG_PLAN: "Reorganisation scenarios",
} as const;
export type Core2WorkflowEntityType = keyof typeof CORE2_WORKFLOW_ENTITY_TYPES;
export const isCore2WorkflowEntityType = (v: string): v is Core2WorkflowEntityType => v in CORE2_WORKFLOW_ENTITY_TYPES;

interface Core2Step { order: number; name: string; approverType: string; approverPermission?: string | null; mode?: string | null; slaHours?: number | null; escalateTo?: string | null }

/** Built-in routes for the core HR request types (until a tenant configures its own). */
export function core2BuiltInRoute(entityType: string): Core2Step[] | null {
  if (!isCore2WorkflowEntityType(entityType)) return null;
  const perm = (name: string, permission: string, slaHours = 48): Core2Step => ({ order: 1, name, approverType: "PERMISSION", approverPermission: permission, mode: "ANY", slaHours, escalateTo: "ADMINS" });
  switch (entityType) {
    case "PRIVACY_REQUEST": return [perm("Data protection (compliance)", "admin.compliance.manage", 240)];
    case "ID_CARD_REQUEST": return [perm("HR", "employee.record.update")];
    case "DIRECTORY_LISTING": return [perm("HR", "employee.record.update")];
    case "INTERCOMPANY_ASSIGNMENT": return [perm("Legal entity administrator", "org.legal_entity.manage")];
    case "ENTITY_TRANSITION": return [perm("Legal entity administrator", "org.legal_entity.manage", 120)];
    case "REORG_PLAN": return [perm("Org structure owner", "org.structure.manage", 120)];
  }
}

// ---------------------------------------------------------------------------
//  Configuration snapshots
// ---------------------------------------------------------------------------

export const CONFIG_SECTIONS = {
  organisation: "Organisation settings",
  company: "Company profile",
  workingRules: "Working rules",
  visibility: "Directory visibility",
  changeApprovals: "Changes that need approval",
  fiscalYears: "Fiscal years",
  notificationSettings: "Notification settings",
  numberSeries: "Employee number series",
  countries: "Country availability",
  branding: "Branding profiles",
  statusCatalog: "Employee status catalog",
  dictionaries: "Master dictionaries",
  slaPolicies: "HR transaction SLAs",
  completenessRules: "Master data completeness rules",
} as const;
export type ConfigSection = keyof typeof CONFIG_SECTIONS;
export const CONFIG_ENVIRONMENTS = ["PRODUCTION", "SANDBOX", "UAT", "TEMPLATE"] as const;
export const CONFIG_FORMAT_VERSION = 1;

export interface ConfigPayload { format: "boos-hr-config"; version: number; exportedAt: string; sections: Partial<Record<ConfigSection, unknown>> }

/** Check an uploaded configuration file before it is applied. */
export function validateConfigPayload(raw: unknown): { ok: true; payload: ConfigPayload } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, issues: ["The file is not a BooS-HR configuration export."] };
  const p = raw as Record<string, unknown>;
  if (p.format !== "boos-hr-config") issues.push("The file is not a BooS-HR configuration export.");
  if (typeof p.version !== "number" || p.version > CONFIG_FORMAT_VERSION) issues.push("The file was made by a newer version of BooS-HR.");
  const sections = p.sections;
  if (!sections || typeof sections !== "object") issues.push("The file has no settings in it.");
  else {
    for (const [k, v] of Object.entries(sections as Record<string, unknown>)) {
      if (!(k in CONFIG_SECTIONS)) { issues.push(`Unknown section "${k}".`); continue; }
      const listy = !["organisation", "company", "workingRules", "visibility"].includes(k);
      if (listy && !Array.isArray(v)) issues.push(`${CONFIG_SECTIONS[k as ConfigSection]} should be a list.`);
      if (!listy && v !== null && typeof v !== "object") issues.push(`${CONFIG_SECTIONS[k as ConfigSection]} is malformed.`);
    }
    const org = (sections as Record<string, unknown>).organisation as Record<string, unknown> | undefined;
    if (org && org.fyStartMonth !== undefined && (typeof org.fyStartMonth !== "number" || org.fyStartMonth < 1 || org.fyStartMonth > 12)) issues.push("The financial year must start in a month from 1 to 12.");
    const rules = (sections as Record<string, unknown>).workingRules as Record<string, unknown> | undefined;
    if (rules && rules.workDays !== undefined && (!Array.isArray(rules.workDays) || rules.workDays.length === 0)) issues.push("Working rules need at least one working day.");
  }
  return issues.length ? { ok: false, issues } : { ok: true, payload: raw as ConfigPayload };
}

/** How many settings each section holds, for the snapshot list. */
export function configSummary(payload: ConfigPayload): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(payload.sections)) out[k] = Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v as object).length : 0;
  return out;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export interface ConfigDiff { section: string; key: string; from: string | null; to: string | null }

/**
 * What changes between two configuration copies: object sections field by
 * field, list sections item by item (keyed by their natural key).
 */
export function diffConfigPayloads(a: ConfigPayload, b: ConfigPayload): ConfigDiff[] {
  const out: ConfigDiff[] = [];
  const keyOf = (x: Record<string, unknown>) => String(x.key ?? x.code ?? x.countryCode ?? x.event ?? x.transactionType ?? x.targetType ?? (x.calendarSet ? `${x.calendarSet}/${x.name}` : x.name ?? x.field ?? stable(x)));
  const sections = new Set([...Object.keys(a.sections), ...Object.keys(b.sections)]);
  for (const s of sections) {
    const x = (a.sections as Record<string, unknown>)[s];
    const y = (b.sections as Record<string, unknown>)[s];
    if (Array.isArray(x) || Array.isArray(y)) {
      const mx = new Map(((x ?? []) as Record<string, unknown>[]).map((i) => [keyOf(i), i]));
      const my = new Map(((y ?? []) as Record<string, unknown>[]).map((i) => [keyOf(i), i]));
      for (const k of new Set([...mx.keys(), ...my.keys()])) {
        const fx = mx.get(k), fy = my.get(k);
        if (stable(fx ?? null) !== stable(fy ?? null)) out.push({ section: s, key: k, from: fx ? stable(fx) : null, to: fy ? stable(fy) : null });
      }
    } else {
      const ox = (x ?? {}) as Record<string, unknown>, oy = (y ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ox), ...Object.keys(oy)])) {
        if (stable(ox[k] ?? null) !== stable(oy[k] ?? null)) out.push({ section: s, key: k, from: ox[k] === undefined ? null : stable(ox[k]), to: oy[k] === undefined ? null : stable(oy[k]) });
      }
    }
  }
  return out;
}

/** Every value one setting has had across snapshots, oldest first (version history). */
export function parameterHistory(snapshots: Array<{ id: string; name: string; createdAt: Date; payload: ConfigPayload }>, section: string, key: string): Array<{ snapshotId: string; name: string; at: Date; value: string | null }> {
  const sorted = [...snapshots].sort((p, q) => p.createdAt.getTime() - q.createdAt.getTime());
  const out: Array<{ snapshotId: string; name: string; at: Date; value: string | null }> = [];
  for (const s of sorted) {
    const sec = (s.payload.sections as Record<string, unknown>)[section];
    const v = sec && typeof sec === "object" && !Array.isArray(sec) ? (sec as Record<string, unknown>)[key] : undefined;
    const value = v === undefined ? null : stable(v);
    if (!out.length || out[out.length - 1]!.value !== value) out.push({ snapshotId: s.id, name: s.name, at: s.createdAt, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Setup completeness and entity readiness
// ---------------------------------------------------------------------------

export interface ScoreItem { key: string; label: string; done: boolean; weight: number; detail?: string; link?: string }
const score = (items: ScoreItem[]) => {
  const total = items.reduce((s, i) => s + i.weight, 0);
  return total ? Math.round((items.filter((i) => i.done).reduce((s, i) => s + i.weight, 0) / total) * 100) : 0;
};

export interface SetupFacts {
  companyProfile: boolean; legalEntities: number; entitiesWithAddress: number; businessUnits: number; departments: number;
  locations: number; locationsWithState: number; holidayCalendars: number; payGroups: number; payGroupsWithFiling: number;
  leaveTypes: number; shifts: number; workingRules: boolean; fiscalYears: number; employees: number; employeesWithManager: number;
  employeesWithDepartment: number; numberSeries: number; workflowDefinitions: number; documentTemplates: number;
}

/** How far the company's setup has got, 0–100, and what is left. */
export function setupCompleteness(f: SetupFacts): { score: number; items: ScoreItem[] } {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const items: ScoreItem[] = [
    { key: "company", label: "Company profile filled in", done: f.companyProfile, weight: 5, link: "/admin/company" },
    { key: "entities", label: "Legal entity with a registered address", done: f.legalEntities > 0 && f.entitiesWithAddress === f.legalEntities, weight: 10, detail: `${f.entitiesWithAddress} of ${f.legalEntities} with an address`, link: "/org" },
    { key: "units", label: "Business units and departments", done: f.businessUnits > 0 && f.departments > 0, weight: 10, detail: `${f.businessUnits} units, ${f.departments} departments`, link: "/org" },
    { key: "locations", label: "Locations with their state (drives PT and LWF)", done: f.locations > 0 && f.locationsWithState === f.locations, weight: 10, detail: `${f.locationsWithState} of ${f.locations} with a state`, link: "/org" },
    { key: "holidays", label: "Holiday calendar", done: f.holidayCalendars > 0, weight: 5, link: "/leave" },
    { key: "payGroups", label: "Pay groups with statutory filing details", done: f.payGroups > 0 && f.payGroupsWithFiling === f.payGroups, weight: 10, detail: `${f.payGroupsWithFiling} of ${f.payGroups} with filing details`, link: "/payroll/pay-groups" },
    { key: "leave", label: "Leave types", done: f.leaveTypes > 0, weight: 5, link: "/leave" },
    { key: "shifts", label: "Shifts", done: f.shifts > 0, weight: 5, link: "/attendance" },
    { key: "rules", label: "Working rules", done: f.workingRules, weight: 5, link: "/admin/company" },
    { key: "fiscal", label: "Fiscal years", done: f.fiscalYears > 0, weight: 5, link: "/admin/company" },
    { key: "series", label: "Employee number series", done: f.numberSeries > 0, weight: 5, link: "/org" },
    { key: "people", label: "Employees added", done: f.employees > 0, weight: 10, detail: `${f.employees} people`, link: "/employees" },
    { key: "managers", label: "Everyone (but the top) has a manager", done: f.employees > 0 && f.employeesWithManager >= f.employees - 1, weight: 5, detail: `${pct(f.employeesWithManager, f.employees)}% have one`, link: "/org/tree" },
    { key: "departments", label: "Everyone sits in a department", done: f.employees > 0 && f.employeesWithDepartment === f.employees, weight: 5, detail: `${pct(f.employeesWithDepartment, f.employees)}% do`, link: "/employees" },
    { key: "workflows", label: "Approval workflows configured", done: f.workflowDefinitions > 0, weight: 3, link: "/admin/workflows" },
    { key: "templates", label: "Letter templates", done: f.documentTemplates > 0, weight: 2, link: "/documents" },
  ];
  return { score: score(items), items };
}

export interface EntityFacts {
  hasAddress: boolean; hasCin: boolean; signatories: number; bankAccounts: number; payGroups: number; payGroupsWithFiling: number;
  taxTypes: string[]; holidayCalendars: number; payrollMonthsAhead: number; businessUnits: number; employees: number; overdueDeadlines: number;
}

/** Is a legal entity ready to run payroll and hold people? */
export function entityReadiness(f: EntityFacts): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [
    { key: "address", label: "Registered address", done: f.hasAddress, weight: 10 },
    { key: "cin", label: "Company identification number (CIN)", done: f.hasCin, weight: 5 },
    { key: "signatory", label: "Authorised signatory", done: f.signatories > 0, weight: 10 },
    { key: "bank", label: "Bank account for payouts", done: f.bankAccounts > 0, weight: 10 },
    { key: "pan", label: "PAN registered", done: f.taxTypes.includes("PAN"), weight: 10 },
    { key: "tan", label: "TAN registered (TDS)", done: f.taxTypes.includes("TAN"), weight: 10 },
    { key: "payGroup", label: "Pay group with filing details", done: f.payGroups > 0 && f.payGroupsWithFiling === f.payGroups, weight: 15 },
    { key: "holidays", label: "Holiday calendar assigned", done: f.holidayCalendars > 0, weight: 5 },
    { key: "payrollCalendar", label: "Payroll calendar for the next three months", done: f.payrollMonthsAhead >= 3, weight: 10, detail: `${f.payrollMonthsAhead} month(s) planned` },
    { key: "units", label: "Business unit", done: f.businessUnits > 0, weight: 5 },
    { key: "deadlines", label: "No overdue compliance deadlines", done: f.overdueDeadlines === 0, weight: 10, detail: f.overdueDeadlines ? `${f.overdueDeadlines} overdue` : undefined },
  ];
  return { score: score(items), items };
}

// ---------------------------------------------------------------------------
//  Hierarchies and inheritance
// ---------------------------------------------------------------------------

/** Would making `parentId` the parent of `id` close a loop? */
export function hierarchyCycle(id: string, parentId: string | null | undefined, parentOf: Map<string, string | null>): boolean {
  if (!parentId) return false;
  if (parentId === id) return true;
  const seen = new Set<string>();
  let cur: string | null | undefined = parentId;
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** The chain from a node up to its root, starting with the node itself. */
export function ancestorsOf(id: string, parentOf: Map<string, string | null>, max = 20): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = id;
  while (cur && out.length < max && !out.includes(cur)) { out.push(cur); cur = parentOf.get(cur) ?? null; }
  return out;
}

export interface TreeRow<T> { node: T; depth: number; path: string }

/** Nodes in display order (parents before children), each with its depth. */
export function flattenTree<T extends { id: string; parentId: string | null; name: string }>(nodes: T[]): TreeRow<T>[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, T[]>();
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const out: TreeRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, path: string) => {
    for (const n of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const p = path ? `${path} › ${n.name}` : n.name;
      out.push({ node: n, depth, path: p });
      walk(n.id, depth + 1, p);
    }
  };
  walk(null, 0, "");
  for (const n of nodes) if (!seen.has(n.id)) out.push({ node: n, depth: 0, path: n.name }); // a loop in the data: list it flat
  return out;
}

/** All descendants of a node (not including it). */
export function descendantsOf(id: string, nodes: Array<{ id: string; parentId: string | null }>): string[] {
  const out: string[] = [];
  let frontier = [id];
  while (frontier.length && out.length < 10_000) {
    const next = nodes.filter((n) => n.parentId && frontier.includes(n.parentId) && !out.includes(n.id) && n.id !== id).map((n) => n.id);
    out.push(...next);
    frontier = next;
  }
  return out;
}

export interface UnitRef { unitType: string; unitId: string; label?: string }

/** The first value found walking up a chain of units (nearest unit wins). */
export function resolveInherited<T>(chain: UnitRef[], valueOf: (u: UnitRef) => T | undefined): { value: T; from: UnitRef; inherited: boolean } | null {
  for (let i = 0; i < chain.length; i++) {
    const v = valueOf(chain[i]!);
    if (v !== undefined && v !== null && v !== "") return { value: v, from: chain[i]!, inherited: i > 0 };
  }
  return null;
}

/** A location's own values, or its nearest ancestor's where it has none. */
export function inheritLocationFields<T extends { id: string; parentId: string | null }>(loc: T, byId: Map<string, T>, fields: Array<keyof T>): Record<string, { value: unknown; from: string }> {
  const out: Record<string, { value: unknown; from: string }> = {};
  for (const f of fields) {
    let cur: T | undefined = loc; const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const v = cur[f];
      if (v !== null && v !== undefined && v !== "") { out[String(f)] = { value: v, from: cur.id }; break; }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Effective dating, snapshots and reorganisation
// ---------------------------------------------------------------------------

/** The job record in force on a date (latest start on or before it, not yet ended). */
export function recordAsOf<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(records: T[], on: Date): T | null {
  let best: T | null = null;
  for (const r of records) {
    if (r.effectiveFrom > on) continue;
    if (r.effectiveTo && r.effectiveTo <= on) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

export interface SnapshotPerson { id: string; number: string; name: string; departmentId: string | null; managerId: string | null; locationId: string | null; legalEntityId: string | null; businessUnitId: string | null; title: string | null }
export interface SnapshotUnit { id: string; type: string; name: string; parentId: string | null; headId: string | null; isActive: boolean }
export interface OrgSnapshotPayload { asOf: string; units: SnapshotUnit[]; people: SnapshotPerson[] }

export interface OrgComparison {
  joined: SnapshotPerson[]; left: SnapshotPerson[];
  moved: Array<{ id: string; name: string; field: "department" | "manager" | "location" | "legalEntity" | "businessUnit" | "title"; from: string | null; to: string | null }>;
  unitsAdded: SnapshotUnit[]; unitsRemoved: SnapshotUnit[];
  unitChanges: Array<{ id: string; name: string; field: "name" | "parent" | "head" | "active"; from: string | null; to: string | null }>;
}

/** Everything that differs between two org snapshots (a → b). */
export function compareOrgSnapshots(a: OrgSnapshotPayload, b: OrgSnapshotPayload): OrgComparison {
  const pa = new Map(a.people.map((p) => [p.id, p])), pb = new Map(b.people.map((p) => [p.id, p]));
  const ua = new Map(a.units.map((u) => [`${u.type}:${u.id}`, u])), ub = new Map(b.units.map((u) => [`${u.type}:${u.id}`, u]));
  const out: OrgComparison = { joined: [], left: [], moved: [], unitsAdded: [], unitsRemoved: [], unitChanges: [] };
  for (const [id, p] of pb) if (!pa.has(id)) out.joined.push(p);
  for (const [id, p] of pa) if (!pb.has(id)) out.left.push(p);
  const fields = [["department", "departmentId"], ["manager", "managerId"], ["location", "locationId"], ["legalEntity", "legalEntityId"], ["businessUnit", "businessUnitId"], ["title", "title"]] as const;
  for (const [id, x] of pa) {
    const y = pb.get(id);
    if (!y) continue;
    for (const [field, key] of fields) if ((x[key] ?? null) !== (y[key] ?? null)) out.moved.push({ id, name: y.name, field, from: x[key] ?? null, to: y[key] ?? null });
  }
  for (const [k, u] of ub) if (!ua.has(k)) out.unitsAdded.push(u);
  for (const [k, u] of ua) {
    const v = ub.get(k);
    if (!v) { out.unitsRemoved.push(u); continue; }
    if (u.name !== v.name) out.unitChanges.push({ id: u.id, name: v.name, field: "name", from: u.name, to: v.name });
    if ((u.parentId ?? null) !== (v.parentId ?? null)) out.unitChanges.push({ id: u.id, name: v.name, field: "parent", from: u.parentId, to: v.parentId });
    if ((u.headId ?? null) !== (v.headId ?? null)) out.unitChanges.push({ id: u.id, name: v.name, field: "head", from: u.headId, to: v.headId });
    if (u.isActive !== v.isActive) out.unitChanges.push({ id: u.id, name: v.name, field: "active", from: String(u.isActive), to: String(v.isActive) });
  }
  return out;
}

export interface ReorgMove { employeeId: string; departmentId?: string | null; reportingManagerId?: string | null }

/** Clean a list of moves: one per person, nobody managing themselves. */
export function normaliseReorgMoves(moves: ReorgMove[]): ReorgMove[] {
  const byId = new Map<string, ReorgMove>();
  for (const m of moves) {
    if (!m.employeeId) continue;
    const cur = byId.get(m.employeeId) ?? { employeeId: m.employeeId };
    if (m.departmentId !== undefined && m.departmentId !== "") cur.departmentId = m.departmentId;
    if (m.reportingManagerId !== undefined && m.reportingManagerId !== "" && m.reportingManagerId !== m.employeeId) cur.reportingManagerId = m.reportingManagerId;
    byId.set(m.employeeId, cur);
  }
  return [...byId.values()].filter((m) => m.departmentId !== undefined || m.reportingManagerId !== undefined);
}

/** What a reorganisation would do: headcount per department, span per manager, loops. */
export function reorgImpact(people: Array<{ id: string; departmentId: string | null; managerId: string | null }>, moves: ReorgMove[], maxSpan = 12) {
  const before = new Map(people.map((p) => [p.id, { ...p }]));
  const after = new Map(people.map((p) => [p.id, { ...p }]));
  for (const m of normaliseReorgMoves(moves)) {
    const p = after.get(m.employeeId);
    if (!p) continue;
    if (m.departmentId !== undefined) p.departmentId = m.departmentId ?? null;
    if (m.reportingManagerId !== undefined) p.managerId = m.reportingManagerId ?? null;
  }
  const count = (m: Map<string, { departmentId: string | null; managerId: string | null }>, key: "departmentId" | "managerId") => {
    const c = new Map<string, number>();
    for (const p of m.values()) { const k = p[key]; if (k) c.set(k, (c.get(k) ?? 0) + 1); }
    return c;
  };
  const db = count(before, "departmentId"), da = count(after, "departmentId"), sb = count(before, "managerId"), sa = count(after, "managerId");
  const headcount = [...new Set([...db.keys(), ...da.keys()])].map((id) => ({ id, before: db.get(id) ?? 0, after: da.get(id) ?? 0 })).filter((r) => r.before !== r.after);
  const span = [...new Set([...sb.keys(), ...sa.keys()])].map((id) => ({ id, before: sb.get(id) ?? 0, after: sa.get(id) ?? 0, overLimit: (sa.get(id) ?? 0) > maxSpan })).filter((r) => r.before !== r.after);
  const managerOf = new Map([...after.values()].map((p) => [p.id, p.managerId]));
  const cycles = normaliseReorgMoves(moves).filter((m) => m.reportingManagerId && hierarchyCycle(m.employeeId, m.reportingManagerId, new Map([...managerOf].map(([k, v]) => [k, k === m.employeeId ? null : v])))).map((m) => m.employeeId);
  const changed = [...after.values()].filter((p) => { const b = before.get(p.id)!; return b.departmentId !== p.departmentId || b.managerId !== p.managerId; }).length;
  return { headcount, span, cycles, changed };
}

// ---------------------------------------------------------------------------
//  Legal entities
// ---------------------------------------------------------------------------

export interface TransferRuleLike { id: string; fromEntityId: string | null; toEntityId: string | null; requiresApproval: boolean; minNoticeDays: number; carryForwardLeave: boolean; restartProbation: boolean; newEmployeeNumber: boolean }

/** The rule that governs a move from one entity to another: exact pair first, then one side, then the catch-all. */
export function matchTransferRule<T extends TransferRuleLike>(rules: T[], from: string, to: string): T | null {
  const rank = (r: T) => (r.fromEntityId === from ? 2 : r.fromEntityId === null ? 0 : -99) + (r.toEntityId === to ? 2 : r.toEntityId === null ? 0 : -99);
  const ok = rules.filter((r) => rank(r) >= 0).sort((a, b) => rank(b) - rank(a));
  return ok[0] ?? null;
}

/** What stops (or shapes) a cross-entity transfer under a rule. */
export function transferRuleIssues(rule: TransferRuleLike | null, effectiveDate: Date, today: Date): string[] {
  if (!rule) return [];
  const issues: string[] = [];
  const days = Math.floor((effectiveDate.getTime() - today.getTime()) / DAY);
  if (days < rule.minNoticeDays) issues.push(`Transfers between these entities need ${rule.minNoticeDays} days' notice; this one is ${Math.max(days, 0)} day(s) away.`);
  return issues;
}

export const ENTITY_TAX_TYPES = ["PAN", "TAN", "GSTIN", "PT", "LWF", "PF", "ESI", "OTHER"] as const;

/** Format checks for an entity tax registration number. */
export function taxRegistrationIssue(type: string, number: string): string | null {
  const n = number.trim().toUpperCase();
  if (!n) return "Enter the registration number.";
  if (type === "PAN" && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(n)) return "A PAN looks like ABCDE1234F.";
  if (type === "TAN" && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(n)) return "A TAN looks like BLRA12345B.";
  if (type === "GSTIN" && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(n)) return "A GSTIN has 15 characters, like 29ABCDE1234F1Z5.";
  return null;
}

/** Months of an entity payroll calendar: cut-off and pay date for each. */
export function proposePayrollCalendar(year: number, opts: { cutoffDay: number; payDay: number }): Array<{ month: number; inputCutoff: Date; payDate: Date }> {
  const last = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: 12 }, (_v, i) => {
    const m = i + 1;
    return { month: m, inputCutoff: new Date(Date.UTC(year, i, Math.min(opts.cutoffDay, last(year, m)))), payDate: new Date(Date.UTC(year, i, Math.min(opts.payDay, last(year, m)))) };
  });
}

/** The next due date of a recurring deadline once it is done. */
export function nextDeadline(due: Date, recurrence: string): Date | null {
  const d = new Date(due);
  if (recurrence === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (recurrence === "QUARTERLY") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (recurrence === "ANNUAL") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d;
}

export const ACQUISITION_STEPS = [
  { key: "entity", label: "Target legal entity set up with address and signatory" },
  { key: "mapping", label: "Every acquired person mapped to a business unit and department" },
  { key: "payroll", label: "Pay group with statutory filing details ready" },
  { key: "policies", label: "Leave, attendance and policy packs assigned" },
  { key: "communication", label: "Welcome communication sent to the acquired team" },
] as const;

// ---------------------------------------------------------------------------
//  Employee master data
// ---------------------------------------------------------------------------

export const DEPENDENT_RELATIONSHIPS = {
  SPOUSE: "Spouse", CHILD: "Child", FATHER: "Father", MOTHER: "Mother", PARENT: "Parent",
  FATHER_IN_LAW: "Father-in-law", MOTHER_IN_LAW: "Mother-in-law", SIBLING: "Sibling", GRANDPARENT: "Grandparent", OTHER: "Other",
} as const;
export type DependentRelationship = keyof typeof DEPENDENT_RELATIONSHIPS;

const RELATION_SYNONYMS: Record<string, DependentRelationship> = {
  WIFE: "SPOUSE", HUSBAND: "SPOUSE", PARTNER: "SPOUSE", SON: "CHILD", DAUGHTER: "CHILD", KID: "CHILD",
  DAD: "FATHER", MOM: "MOTHER", MUM: "MOTHER", MOTHERINLAW: "MOTHER_IN_LAW", FATHERINLAW: "FATHER_IN_LAW",
  BROTHER: "SIBLING", SISTER: "SIBLING", GRANDFATHER: "GRANDPARENT", GRANDMOTHER: "GRANDPARENT",
};

/** "Mother-in-law" → MOTHER_IN_LAW; unknown words → null. */
export function normaliseRelationship(raw: string): DependentRelationship | null {
  const k = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (k in DEPENDENT_RELATIONSHIPS) return k as DependentRelationship;
  return RELATION_SYNONYMS[k.replace(/_/g, "")] ?? null;
}

/**
 * Does a dependent make sense? The relationship must be a known one; a
 * child must be at least 12 years younger than the employee and a parent
 * (or in-law, or grandparent) at least 12 years older; there is one father,
 * one mother and one spouse at most.
 */
export function dependentRelationIssue(dep: { relationship: string; dateOfBirth: Date | null }, employeeDob: Date | null, existing: Array<{ relationship: string }>): string | null {
  const rel = normaliseRelationship(dep.relationship);
  if (!rel) return `"${dep.relationship}" is not a relationship we recognise. Use one of: ${Object.values(DEPENDENT_RELATIONSHIPS).join(", ")}.`;
  if (dep.dateOfBirth && employeeDob) {
    const years = (dep.dateOfBirth.getTime() - employeeDob.getTime()) / (365.25 * DAY);
    if (rel === "CHILD" && years < 12) return "A child must be born at least 12 years after the employee.";
    if (["FATHER", "MOTHER", "PARENT", "FATHER_IN_LAW", "MOTHER_IN_LAW"].includes(rel) && years > -12) return "A parent must be at least 12 years older than the employee.";
    if (rel === "GRANDPARENT" && years > -30) return "A grandparent must be at least 30 years older than the employee.";
  }
  const taken = existing.map((e) => normaliseRelationship(e.relationship));
  if ((rel === "FATHER" || rel === "MOTHER" || rel === "SPOUSE") && taken.includes(rel)) return `A ${DEPENDENT_RELATIONSHIPS[rel].toLowerCase()} is already listed.`;
  return null;
}

export interface PersonForDuplicates { id: string; firstName: string; lastName: string; dateOfBirth: Date | null; personalEmail: string | null; mobile: string | null; pan?: string | null; workEmail?: string | null }

const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
const normPhone = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

/** Pairs of records that are probably the same person, with why. */
export function findDuplicatePeople(people: PersonForDuplicates[]): Array<{ a: string; b: string; reasons: string[]; score: number }> {
  const out: Array<{ a: string; b: string; reasons: string[]; score: number }> = [];
  const pairs = new Map<string, { a: string; b: string; reasons: Set<string>; score: number }>();
  const index = (key: string | null, id: string, reason: string, weight: number, buckets: Map<string, string[]>) => {
    if (!key) return;
    const ids = buckets.get(key) ?? [];
    for (const other of ids) {
      const [a, b] = [other, id].sort() as [string, string];
      const k = `${a}|${b}`;
      const p = pairs.get(k) ?? { a, b, reasons: new Set<string>(), score: 0 };
      if (!p.reasons.has(reason)) { p.reasons.add(reason); p.score += weight; }
      pairs.set(k, p);
    }
    buckets.set(key, [...ids, id]);
  };
  const byNameDob = new Map<string, string[]>(), byEmail = new Map<string, string[]>(), byPhone = new Map<string, string[]>(), byPan = new Map<string, string[]>(), byName = new Map<string, string[]>();
  for (const p of people) {
    const name = `${normName(p.firstName)}${normName(p.lastName)}`;
    index(p.dateOfBirth ? `${name}|${p.dateOfBirth.toISOString().slice(0, 10)}` : null, p.id, "Same name and date of birth", 60, byNameDob);
    index(name.length > 3 ? name : null, p.id, "Same name", 15, byName);
    index(p.personalEmail ? p.personalEmail.trim().toLowerCase() : null, p.id, "Same personal email", 50, byEmail);
    const ph = normPhone(p.mobile);
    index(ph.length === 10 ? ph : null, p.id, "Same mobile number", 40, byPhone);
    index(p.pan ? p.pan.trim().toUpperCase() : null, p.id, "Same PAN", 80, byPan);
  }
  for (const p of pairs.values()) {
    const reasons = [...p.reasons];
    if (reasons.length === 1 && reasons[0] === "Same name") continue; // a shared name alone is common
    out.push({ a: p.a, b: p.b, reasons, score: Math.min(100, p.score) });
  }
  return out.sort((x, y) => y.score - x.score);
}

export const COMPLETENESS_FIELDS = {
  personalEmail: "Personal email", mobile: "Mobile", dateOfBirth: "Date of birth", gender: "Gender", maritalStatus: "Marital status",
  bloodGroup: "Blood group", nationality: "Nationality", departmentId: "Department", locationId: "Location", reportingManagerId: "Reporting manager",
  costCenterId: "Cost centre", workerTypeId: "Employment type", bandId: "Band", legalEntityId: "Legal entity", jobTitleName: "Job title",
  address: "Current address", emergencyContact: "Emergency contact", bankAccount: "Bank account", pan: "PAN",
} as const;
export type CompletenessField = keyof typeof COMPLETENESS_FIELDS;

/** The completeness rules a person breaks. */
export function completenessGaps(person: Partial<Record<CompletenessField, unknown>> & { workerTypeId?: string | null }, rules: Array<{ field: string; workerTypeId: string | null; severity: string; isActive?: boolean }>): Array<{ field: string; label: string; severity: string }> {
  const out: Array<{ field: string; label: string; severity: string }> = [];
  for (const r of rules) {
    if (r.isActive === false) continue;
    if (r.workerTypeId && r.workerTypeId !== (person.workerTypeId ?? null)) continue;
    const v = (person as Record<string, unknown>)[r.field];
    const empty = v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
    if (empty) out.push({ field: r.field, label: COMPLETENESS_FIELDS[r.field as CompletenessField] ?? r.field, severity: r.severity });
  }
  return out;
}

export const NOMINEE_BENEFITS = { PF: "Provident fund", EPS: "Pension (EPS)", GRATUITY: "Gratuity", INSURANCE: "Group insurance" } as const;

/** Each benefit's shares must be whole percentages adding up to 100. */
export function nomineeShareIssues(rows: Array<{ benefit: string; sharePct: number }>): string[] {
  const issues: string[] = [];
  const by = new Map<string, number>();
  for (const r of rows) {
    if (!(r.benefit in NOMINEE_BENEFITS)) { issues.push(`Unknown benefit ${r.benefit}.`); continue; }
    if (!Number.isInteger(r.sharePct) || r.sharePct < 0 || r.sharePct > 100) { issues.push("A share must be a whole percentage from 0 to 100."); continue; }
    by.set(r.benefit, (by.get(r.benefit) ?? 0) + r.sharePct);
  }
  for (const [b, total] of by) if (total !== 0 && total !== 100) issues.push(`${NOMINEE_BENEFITS[b as keyof typeof NOMINEE_BENEFITS]} shares add up to ${total}%, not 100%.`);
  return issues;
}

// ---------------------------------------------------------------------------
//  Self-service: privacy, preferences
// ---------------------------------------------------------------------------

export const PRIVACY_REQUEST_KINDS = {
  ACCESS: "A copy of the personal data held about me",
  RECTIFICATION: "Correct personal data that is wrong",
  ERASURE: "Erase personal data that is no longer needed",
  RESTRICTION: "Restrict how my data is used",
  DIRECTORY_HIDE: "Leave me out of the employee directory",
} as const;
export type PrivacyRequestKind = keyof typeof PRIVACY_REQUEST_KINDS;

/** Statutory answer time for a privacy request (30 days; 7 for leaving the directory). */
export function privacyDueDate(kind: string, raised: Date): Date {
  return new Date(raised.getTime() + (kind === "DIRECTORY_HIDE" ? 7 : 30) * DAY);
}

/** Notification kinds people may mute; approvals and security notices always arrive. */
export const MUTABLE_NOTIFICATION_KINDS = {
  LEAVE: "Leave", ATTENDANCE: "Attendance", PAYROLL: "Payroll", HELPDESK: "Helpdesk", JOURNEY: "Onboarding and journeys",
  ENGAGE: "Engagement and announcements", PERFORMANCE: "Performance", LEARNING: "Learning", EXPENSE: "Expenses", ASSET: "Assets",
} as const;
const ALWAYS_DELIVERED = new Set(["WORKFLOW", "SECURITY", "APPROVAL"]);

/** Who still gets a notification of this kind, given everyone's preferences. */
export function notificationAudience(kind: string, userIds: string[], prefs: Array<{ userId: string; inAppMuted: string[]; emailMuted: string[]; preferredChannel: string }>): { inApp: string[]; emailBlocked: Set<string> } {
  const by = new Map(prefs.map((p) => [p.userId, p]));
  const k = kind.toUpperCase();
  const mandatory = ALWAYS_DELIVERED.has(k);
  const inApp = userIds.filter((u) => mandatory || !by.get(u)?.inAppMuted.includes(k));
  const emailBlocked = new Set(userIds.filter((u) => {
    const p = by.get(u);
    if (!p || mandatory) return false;
    return p.emailMuted.includes(k) || p.preferredChannel === "IN_APP";
  }));
  return { inApp, emailBlocked };
}

// ---------------------------------------------------------------------------
//  HR operations
// ---------------------------------------------------------------------------

export const HR_TRANSACTION_TYPES = {
  CHANGE_REQUEST: { label: "Profile and org change requests", defaultHours: 48 },
  LETTER_REQUEST: { label: "Letter requests", defaultHours: 24 },
  CHECKLIST: { label: "HR checklists", defaultHours: 120 },
  JOB_CHANGE: { label: "Promotions, transfers and job changes", defaultHours: 72 },
  ID_CARD: { label: "ID card requests", defaultHours: 72 },
  PRIVACY: { label: "Privacy requests", defaultHours: 720 },
} as const;
export type HrTransactionType = keyof typeof HR_TRANSACTION_TYPES;

export const HR_AGING_BUCKETS = ["0–2 days", "3–7 days", "8–14 days", "15–30 days", "Over 30 days"] as const;

export function hrAgingBucket(createdAt: Date, now: Date = new Date()): (typeof HR_AGING_BUCKETS)[number] {
  const days = Math.floor((now.getTime() - createdAt.getTime()) / DAY);
  return days <= 2 ? HR_AGING_BUCKETS[0] : days <= 7 ? HR_AGING_BUCKETS[1] : days <= 14 ? HR_AGING_BUCKETS[2] : days <= 30 ? HR_AGING_BUCKETS[3] : HR_AGING_BUCKETS[4];
}

export function slaState(createdAt: Date, targetHours: number, now: Date = new Date()): { dueAt: Date; breached: boolean; hoursLeft: number } {
  const dueAt = new Date(createdAt.getTime() + targetHours * 3_600_000);
  const hoursLeft = Math.round((dueAt.getTime() - now.getTime()) / 3_600_000);
  return { dueAt, breached: hoursLeft < 0, hoursLeft };
}

/** Pick about pct% of items (at least one when there are any) for a quality check. */
export function pickQcSample<T>(items: T[], pct: number, rng: () => number = Math.random): T[] {
  if (!items.length || pct <= 0) return [];
  const n = Math.min(items.length, Math.max(1, Math.ceil((items.length * Math.min(pct, 100)) / 100)));
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  return pool.slice(0, n);
}

// ---------------------------------------------------------------------------
//  Directory
// ---------------------------------------------------------------------------

const vEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** A vCard 3.0 contact card. */
export function buildVCard(p: { firstName: string; lastName: string; displayName?: string | null; title?: string | null; org?: string | null; department?: string | null; workEmail?: string | null; phone?: string | null; location?: string | null; note?: string | null }): string {
  const lines = [
    "BEGIN:VCARD", "VERSION:3.0",
    `N:${vEsc(p.lastName)};${vEsc(p.firstName)};;;`,
    `FN:${vEsc(p.displayName || `${p.firstName} ${p.lastName}`)}`,
    p.org ? `ORG:${vEsc(p.org)}${p.department ? `;${vEsc(p.department)}` : ""}` : null,
    p.title ? `TITLE:${vEsc(p.title)}` : null,
    p.workEmail ? `EMAIL;TYPE=WORK,INTERNET:${p.workEmail}` : null,
    p.phone ? `TEL;TYPE=CELL:${p.phone.replace(/[^\d+]/g, "")}` : null,
    p.location ? `ADR;TYPE=WORK:;;${vEsc(p.location)};;;;` : null,
    p.note ? `NOTE:${vEsc(p.note)}` : null,
    "END:VCARD",
  ].filter((l): l is string => !!l);
  return lines.join("\r\n") + "\r\n";
}

export interface CoworkerFacts { id: string; departmentId: string | null; locationId: string | null; managerId: string | null; skills: string[]; teams: string[]; projects: string[] }

/** People someone may want to know: same manager, team, project, skills, department or office. */
export function coworkerSuggestions(me: CoworkerFacts, others: CoworkerFacts[], limit = 6): Array<{ id: string; score: number; reasons: string[] }> {
  const out: Array<{ id: string; score: number; reasons: string[] }> = [];
  for (const o of others) {
    if (o.id === me.id || o.id === me.managerId || o.managerId === me.id) continue; // already connected
    const reasons: string[] = []; let s = 0;
    if (me.managerId && o.managerId === me.managerId) { s += 30; reasons.push("Same manager"); }
    const teams = o.teams.filter((t) => me.teams.includes(t)).length; if (teams) { s += 25; reasons.push("Same team"); }
    const projects = o.projects.filter((p) => me.projects.includes(p)).length; if (projects) { s += 20; reasons.push("Same project"); }
    const skills = o.skills.filter((k) => me.skills.includes(k)).length; if (skills) { s += Math.min(20, skills * 7); reasons.push(`${skills} shared skill${skills === 1 ? "" : "s"}`); }
    if (me.departmentId && o.departmentId === me.departmentId) { s += 10; reasons.push("Same department"); }
    if (me.locationId && o.locationId === me.locationId) { s += 5; reasons.push("Same office"); }
    if (s >= 15) out.push({ id: o.id, score: s, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** How fresh a profile is, from the last time anything on it changed. */
export function dataFreshness(lastUpdated: Date, now: Date = new Date()): { days: number; level: "FRESH" | "AGING" | "STALE"; label: string } {
  const days = Math.max(0, Math.floor((now.getTime() - lastUpdated.getTime()) / DAY));
  const level = days <= 180 ? "FRESH" : days <= 365 ? "AGING" : "STALE";
  const label = days === 0 ? "Updated today" : days < 31 ? `Updated ${days} day${days === 1 ? "" : "s"} ago` : days < 365 ? `Updated ${Math.floor(days / 30)} month(s) ago` : `Updated ${Math.floor(days / 365)} year(s) ago`;
  return { days, level, label };
}

// ---------------------------------------------------------------------------
//  Regional formats and the service timeline
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date in the company's chosen format (the CompanyProfile date format). */
export function formatCompanyDate(d: Date | null | undefined, pattern: string = "DD/MM/YYYY"): string {
  if (!d) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0"), mm = String(d.getUTCMonth() + 1).padStart(2, "0"), yyyy = String(d.getUTCFullYear());
  switch (pattern) {
    case "MM/DD/YYYY": return `${mm}/${dd}/${yyyy}`;
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    case "DD MMM YYYY": return `${dd} ${MONTHS[d.getUTCMonth()]} ${yyyy}`;
    default: return `${dd}/${mm}/${yyyy}`;
  }
}

/** A number in the company's (or person's) locale: 12,34,567 in en-IN, 1,234,567 elsewhere. */
export function formatCompanyNumber(n: number, locale: string = "en-IN", fractionDigits = 0): string {
  const safe = ["en-IN", "en-US", "en-GB"].includes(locale) ? locale : "en-IN";
  return new Intl.NumberFormat(safe, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(n);
}

export interface TimelineEvent { date: Date; kind: string; label: string; future?: boolean }

/** Joining, every work anniversary up to the next one, and the events given, newest first. */
export function serviceTimeline(joined: Date, now: Date, events: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [{ date: joined, kind: "JOINED", label: "Joined" }, ...events];
  for (let y = 1; y <= 60; y++) {
    const d = new Date(Date.UTC(joined.getUTCFullYear() + y, joined.getUTCMonth(), joined.getUTCDate()));
    if (d > now) { out.push({ date: d, kind: "ANNIVERSARY", label: `${y}-year work anniversary`, future: true }); break; }
    out.push({ date: d, kind: "ANNIVERSARY", label: `${y}-year work anniversary` });
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

// ---------------------------------------------------------------------------
//  Reference data import
// ---------------------------------------------------------------------------

export const REFERENCE_IMPORT_KINDS = {
  DEPARTMENT: { label: "Departments", columns: ["name", "code", "parent", "business_unit", "description"] },
  LOCATION: { label: "Locations", columns: ["name", "code", "city", "state_code", "state", "postal_code", "timezone", "parent"] },
  COST_CENTRE: { label: "Cost centres", columns: ["name", "code", "parent", "legal_entity"] },
  BUSINESS_UNIT: { label: "Business units", columns: ["name", "code", "legal_entity", "parent", "pl_code"] },
  JOB_TITLE: { label: "Job titles", columns: ["name", "band"] },
} as const;
export type ReferenceImportKind = keyof typeof REFERENCE_IMPORT_KINDS;

export function referenceTemplateCsv(kind: ReferenceImportKind): string {
  const examples: Record<ReferenceImportKind, string> = {
    DEPARTMENT: "Payables,FIN-AP,Finance,,Accounts payable team",
    LOCATION: "Pune Office,PUN,Pune,MH,Maharashtra,411001,Asia/Kolkata,",
    COST_CENTRE: "CC Marketing Digital,MKT-D,CC Marketing,",
    BUSINESS_UNIT: "Consumer,CONS,,,PL-100",
    JOB_TITLE: "Senior Analyst,",
  };
  return `${REFERENCE_IMPORT_KINDS[kind].columns.join(",")}\n${examples[kind]}\n`;
}

export interface ReferenceRow { line: number; name: string; values: Record<string, string>; action: "CREATE" | "UPDATE"; errors: string[] }

/**
 * Check pasted reference rows before anything is written: required name,
 * known header, references (parent, business unit, entity, band) that exist
 * either already or earlier in the same file, no duplicate names.
 */
export function validateReferenceRows(kind: ReferenceImportKind, table: string[][], ctx: { existing: Set<string>; refs: Partial<Record<"parent" | "business_unit" | "legal_entity" | "band", Set<string>>> }): { rows: ReferenceRow[]; headerError: string | null } {
  const cols = REFERENCE_IMPORT_KINDS[kind].columns as readonly string[];
  if (!table.length) return { rows: [], headerError: "The file is empty." };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (header[0] !== "name") return { rows: [], headerError: `The first column must be "name". Download the template for ${REFERENCE_IMPORT_KINDS[kind].label.toLowerCase()}.` };
  const unknown = header.filter((h) => h && !cols.includes(h));
  if (unknown.length) return { rows: [], headerError: `Unknown column(s): ${unknown.join(", ")}.` };
  const seen = new Set<string>();
  const inFile = new Set<string>();
  const rows: ReferenceRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    if (cells.every((c) => !c.trim())) continue;
    const values: Record<string, string> = {};
    header.forEach((h, j) => { if (h) values[h] = (cells[j] ?? "").trim(); });
    const name = values.name ?? "";
    const errors: string[] = [];
    if (!name) errors.push("Name is required.");
    if (name.length > 120) errors.push("Name is longer than 120 characters.");
    const key = name.toLowerCase();
    if (name && seen.has(key)) errors.push("This name appears twice in the file.");
    seen.add(key);
    for (const ref of ["parent", "business_unit", "legal_entity", "band"] as const) {
      const v = values[ref];
      if (!v) continue;
      const known = ctx.refs[ref];
      const self = ref === "parent" && (inFile.has(v.toLowerCase()) || ctx.existing.has(v.toLowerCase()));
      if (ref === "parent" && v.toLowerCase() === key) errors.push("A unit cannot be its own parent.");
      else if (!self && !(known?.has(v.toLowerCase()))) errors.push(`${ref.replace("_", " ")} "${v}" was not found.`);
    }
    if (kind === "LOCATION" && values.state_code && !/^[A-Za-z]{2}$/.test(values.state_code)) errors.push("State code must be two letters, like KA.");
    inFile.add(key);
    rows.push({ line: i + 1, name, values, action: ctx.existing.has(key) ? "UPDATE" : "CREATE", errors });
  }
  return { rows, headerError: null };
}

// ---------------------------------------------------------------------------
//  Approval policy library
// ---------------------------------------------------------------------------

export interface LibraryStep { order: number; name: string; approverType: string; approverPermission?: string | null; mode: "ANY" | "ALL"; slaHours: number; escalateTo: string; conditionField?: string | null; conditionOp?: string | null; conditionValue?: string | null }

/** Ready-made approval policies an administrator can install and then adjust. */
export const APPROVAL_POLICY_LIBRARY: Array<{ key: string; name: string; entityType: string; description: string; steps: LibraryStep[] }> = [
  {
    key: "generic-manager-hr", name: "Manager, then HR", entityType: "GENERIC_REQUEST",
    description: "The reporting manager approves, then anyone in HR confirms.",
    steps: [
      { order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 48, escalateTo: "MANAGER_OF_APPROVER" },
      { order: 2, name: "HR", approverType: "PERMISSION", approverPermission: "employee.record.update", mode: "ANY", slaHours: 48, escalateTo: "ADMINS" },
    ],
  },
  {
    key: "access-manager-security", name: "Access: manager and security, privileged roles need two", entityType: "ACCESS_REQUEST",
    description: "Manager approves; the security team approves; privileged access needs every security approver.",
    steps: [
      { order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 24, escalateTo: "MANAGER_OF_APPROVER" },
      { order: 2, name: "Security (all for privileged)", approverType: "PERMISSION", approverPermission: "admin.security.govern", mode: "ALL", slaHours: 48, escalateTo: "ADMINS", conditionField: "privileged", conditionOp: "EQ", conditionValue: "true" },
      { order: 3, name: "Security", approverType: "PERMISSION", approverPermission: "admin.security.govern", mode: "ANY", slaHours: 48, escalateTo: "ADMINS", conditionField: "privileged", conditionOp: "NEQ", conditionValue: "true" },
    ],
  },
  {
    key: "idcard-manager-hr", name: "ID cards: manager, then HR", entityType: "ID_CARD_REQUEST",
    description: "The manager confirms the request, HR issues the card.",
    steps: [
      { order: 1, name: "Reporting manager", approverType: "REPORTING_MANAGER", mode: "ANY", slaHours: 24, escalateTo: "MANAGER_OF_APPROVER" },
      { order: 2, name: "HR", approverType: "PERMISSION", approverPermission: "employee.record.update", mode: "ANY", slaHours: 48, escalateTo: "ADMINS" },
    ],
  },
  {
    key: "privacy-dpo", name: "Privacy: compliance within 10 days", entityType: "PRIVACY_REQUEST",
    description: "The compliance team answers data-privacy requests, escalating after 10 days.",
    steps: [{ order: 1, name: "Compliance", approverType: "PERMISSION", approverPermission: "admin.compliance.manage", mode: "ANY", slaHours: 240, escalateTo: "ADMINS" }],
  },
  {
    key: "intercompany-two-entities", name: "Intercompany: department head, then entity administrator", entityType: "INTERCOMPANY_ASSIGNMENT",
    description: "The employee's department head agrees, then an entity administrator approves the cost split.",
    steps: [
      { order: 1, name: "Department head", approverType: "DEPARTMENT_HEAD", mode: "ANY", slaHours: 48, escalateTo: "ADMINS" },
      { order: 2, name: "Entity administrator", approverType: "PERMISSION", approverPermission: "org.legal_entity.manage", mode: "ANY", slaHours: 72, escalateTo: "ADMINS" },
    ],
  },
  {
    key: "reorg-hr-leadership", name: "Reorganisation: org owners, all must agree", entityType: "REORG_PLAN",
    description: "Every org-structure owner approves before a reorganisation is applied.",
    steps: [{ order: 1, name: "Org structure owners", approverType: "PERMISSION", approverPermission: "org.structure.manage", mode: "ALL", slaHours: 120, escalateTo: "ADMINS" }],
  },
];
