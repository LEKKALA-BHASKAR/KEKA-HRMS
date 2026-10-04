import type { Permission } from "./permissions";

/**
 * The product modules a platform administrator can switch on or off per
 * company. Core HR (people, organisation, documents, lifecycle, time and
 * settings) is always on; everything else is a module.
 *
 * A switched-off module takes its permissions away from everyone in the
 * company, so its menus disappear and its pages answer 403 — the same
 * mechanism that already hides what a role does not grant.
 */
export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  description: string;
  /** Permission prefixes (the part before the first dot) the module owns. */
  domains: string[];
}

export type ModuleKey =
  | "payroll" | "expenses" | "assets" | "helpdesk" | "performance"
  | "hire" | "projects" | "engage" | "learn" | "analytics";

export const MODULES: ModuleDefinition[] = [
  { key: "payroll", label: "Payroll & Accounting", description: "Payroll runs, statutory filings, loans, tax proofs and the general ledger.", domains: ["payroll", "accounting"] },
  { key: "expenses", label: "Expenses & Travel", description: "Expense claims, advances and travel requests.", domains: ["expense"] },
  { key: "assets", label: "Assets", description: "Company assets, assignment and recovery.", domains: ["asset"] },
  { key: "helpdesk", label: "Helpdesk", description: "Employee tickets, categories and SLAs.", domains: ["helpdesk"] },
  { key: "performance", label: "Performance", description: "Goals, reviews, 1:1s, improvement plans, skills and career paths.", domains: ["performance"] },
  { key: "hire", label: "Hire", description: "Requisitions, jobs, candidates, interviews and offers.", domains: ["hire"] },
  { key: "projects", label: "Projects (PSA)", description: "Clients, projects, timesheets, billing and resource planning.", domains: ["psa"] },
  { key: "engage", label: "Engage", description: "Announcements, praise and awards, surveys and meetings.", domains: ["engagement", "meeting"] },
  { key: "learn", label: "Learn", description: "Courses and training programmes.", domains: ["learning", "training"] },
  { key: "analytics", label: "Analytics", description: "HR dashboards and attrition risk.", domains: ["analytics"] },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

const DOMAIN_TO_MODULE = new Map<string, ModuleKey>(MODULES.flatMap((m) => m.domains.map((d) => [d, m.key] as const)));

/** The module a permission belongs to, or null for core HR. */
export function moduleOf(permission: Permission | string): ModuleKey | null {
  return DOMAIN_TO_MODULE.get(String(permission).split(".")[0]) ?? null;
}

export function isModuleKey(v: string): v is ModuleKey {
  return (MODULE_KEYS as string[]).includes(v);
}
