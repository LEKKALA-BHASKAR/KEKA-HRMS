import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ENGAGE_WORKFLOW_TYPES } from "./engage-depth-math";

/**
 * Pure helpers for governance: workflow routing (definition matching, step
 * conditions, submission validation), automation date triggers and message
 * templates, IP allowlist matching, the audit hash chain, retention cut-offs,
 * account hygiene and compliance recurrence. No database access, so the unit
 * tests cover them directly.
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
//  Workflow entity types
// ---------------------------------------------------------------------------

export const WORKFLOW_ENTITY_TYPES = {
  GENERIC_REQUEST: "General requests (employee self-service)",
  ACCESS_REQUEST: "Access requests (role grants)",
  CHANGE_REQUEST: "Role, permission and security policy changes",
  WEBHOOK_ENDPOINT: "New webhook endpoints",
  AUTOMATION_RULE: "Automation & notification rule activation",
  RETENTION_PURGE: "Data retention purges",
  COMPLIANCE_ITEM: "Compliance checklist sign-off",
  POLICY_PUBLISH: "Policy acknowledgement campaigns",
  CONSENT_PURPOSE: "Consent purpose publication",
  // Engage depth (engage-depth.ts applies their outcomes).
  ...ENGAGE_WORKFLOW_TYPES,
  HELPDESK_CASE: "Helpdesk case decisions (policy exceptions)",
  KB_ARTICLE: "Knowledge base article publication",
  ER_FINDINGS: "Investigation findings sign-off",
  ER_ACTION: "Disciplinary action approval",
  ER_RESOLUTION: "Grievance & complaint resolution sign-off",
  DOCUMENT_FOLDER_ACCESS: "Confidential document folder access",
  LETTER_TEMPLATE: "Letter template approval",
  ASSET_DISPOSAL: "Asset disposal",
} as const;
export type WorkflowEntityType = keyof typeof WORKFLOW_ENTITY_TYPES;
export const isWorkflowEntityType = (v: string): v is WorkflowEntityType => v in WORKFLOW_ENTITY_TYPES;

export const GENERIC_REQUEST_CATEGORIES = {
  LETTER: "Letter request (address proof, visa, salary certificate)",
  ID_CARD: "ID card / access card",
  IT_ACCESS: "IT equipment or software access",
  POLICY_EXCEPTION: "Policy exception",
  REIMBURSEMENT: "Other reimbursement",
  OTHER: "Other",
} as const;

export const APPROVER_TYPES = {
  REPORTING_MANAGER: "Reporting manager",
  SKIP_MANAGER: "Manager's manager",
  DEPARTMENT_HEAD: "Department head",
  ROLE: "Everyone holding a role",
  USER: "A specific person",
  PERMISSION: "Holders of a permission",
} as const;
export type ApproverType = keyof typeof APPROVER_TYPES;

export const CONDITION_FIELDS = { amount: "Amount", department: "Department", location: "Location", privileged: "Privileged access", category: "Request category" } as const;
export const CONDITION_OPS = { GT: ">", GTE: "≥", LT: "<", LTE: "≤", EQ: "is", NEQ: "is not" } as const;

/** A step, from a definition version or a built-in route. */
export interface StepSpec {
  order: number;
  name: string;
  approverType: string;
  approverRoleId?: string | null;
  approverUserId?: string | null;
  approverPermission?: string | null;
  mode?: string | null;
  conditionField?: string | null;
  conditionOp?: string | null;
  conditionValue?: string | null;
  slaHours?: number | null;
  escalateTo?: string | null;
  escalateUserId?: string | null;
}

/** What a request is about, for routing. */
export interface RouteContext {
  amount?: number | null;
  departmentId?: string | null;
  locationId?: string | null;
  privileged?: boolean;
  category?: string | null;
}

/** Whether a step's optional condition holds for this request. */
export function stepApplies(step: Pick<StepSpec, "conditionField" | "conditionOp" | "conditionValue">, ctx: RouteContext): boolean {
  if (!step.conditionField || !step.conditionOp) return true;
  const op = step.conditionOp;
  const want = step.conditionValue ?? "";
  if (step.conditionField === "amount") {
    const v = ctx.amount ?? 0;
    const w = Number(want);
    if (!Number.isFinite(w)) return false;
    switch (op) {
      case "GT": return v > w;
      case "GTE": return v >= w;
      case "LT": return v < w;
      case "LTE": return v <= w;
      case "EQ": return v === w;
      case "NEQ": return v !== w;
      default: return false;
    }
  }
  const actual = step.conditionField === "department" ? ctx.departmentId ?? ""
    : step.conditionField === "location" ? ctx.locationId ?? ""
    : step.conditionField === "privileged" ? String(!!ctx.privileged)
    : step.conditionField === "category" ? ctx.category ?? ""
    : null;
  if (actual === null) return false;
  if (op === "EQ") return actual === want;
  if (op === "NEQ") return actual !== want;
  return false;
}

/** Index of the next step at or after `from` whose condition holds, or -1. */
export function nextApplicableStep(steps: StepSpec[], from: number, ctx: RouteContext): number {
  for (let i = Math.max(0, from); i < steps.length; i++) if (stepApplies(steps[i]!, ctx)) return i;
  return -1;
}

export interface DefinitionLike { id: string; matchDepartmentId: string | null; matchLocationId: string | null; priority: number; createdAt: Date }

/** The definition that routes a subject: most specific match, then priority, then oldest. */
export function pickDefinition<T extends DefinitionLike>(defs: T[], ctx: RouteContext): T | null {
  const fits = defs.filter((d) => (!d.matchDepartmentId || d.matchDepartmentId === ctx.departmentId) && (!d.matchLocationId || d.matchLocationId === ctx.locationId));
  const score = (d: T) => (d.matchDepartmentId ? 2 : 0) + (d.matchLocationId ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a) || b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
}

export interface ValidationRule { field: "amount" | "title" | "details"; op: "REQUIRED" | "MAX" | "MIN" | "MIN_LENGTH"; value?: string | number | null; message?: string | null }

/** Data validation on submission; returns the messages for the rules that fail. */
export function validateWorkflowSubmission(rules: ValidationRule[] | null | undefined, input: { amount?: number | null; title?: string | null; details?: string | null }): string[] {
  const out: string[] = [];
  for (const r of rules ?? []) {
    const v = input[r.field];
    const msg = r.message?.trim();
    if (r.op === "REQUIRED") {
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) out.push(msg || `${r.field} is required.`);
    } else if (r.op === "MAX") {
      if (typeof v === "number" && v > Number(r.value)) out.push(msg || `${r.field} cannot exceed ${r.value}.`);
    } else if (r.op === "MIN") {
      if (typeof v !== "number" || v < Number(r.value)) out.push(msg || `${r.field} must be at least ${r.value}.`);
    } else if (r.op === "MIN_LENGTH") {
      if (typeof v !== "string" || v.trim().length < Number(r.value)) out.push(msg || `${r.field} needs at least ${r.value} characters.`);
    }
  }
  return out;
}

/** Remove the requester and duplicates; apply delegations (delegator → delegate). */
export function finalApprovers(candidates: string[], requesterUserId: string, delegations: Map<string, string>): Array<{ approver: string; delegatedFrom: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ approver: string; delegatedFrom: string | null }> = [];
  for (const c of candidates) {
    if (!c || c === requesterUserId) continue;
    let approver = c, from: string | null = null;
    const d = delegations.get(c);
    if (d && d !== requesterUserId) { approver = d; from = c; }
    if (seen.has(approver)) continue;
    seen.add(approver);
    out.push({ approver, delegatedFrom: from });
  }
  return out;
}

/** Whether a step is decided: ANY needs one approval, ALL needs every task approved. Any rejection rejects. */
export function stepOutcome(mode: string, statuses: string[]): "APPROVED" | "REJECTED" | "PENDING" {
  if (statuses.includes("REJECTED")) return "REJECTED";
  const live = statuses.filter((s) => s !== "CANCELLED" && s !== "ESCALATED" && s !== "SKIPPED");
  if (mode === "ALL") return live.length > 0 && live.every((s) => s === "APPROVED") ? "APPROVED" : "PENDING";
  return live.includes("APPROVED") ? "APPROVED" : "PENDING";
}

export function dueAtFor(slaHours: number | null | undefined, from: Date): Date | null {
  return slaHours && slaHours > 0 ? new Date(from.getTime() + slaHours * 3_600_000) : null;
}

// ---------------------------------------------------------------------------
//  Automation
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGERS = {
  EMPLOYEE_CREATED: "An employee is added",
  EMPLOYEE_UPDATED: "An employee record changes",
  REQUEST_APPROVED: "A workflow request is approved",
  REQUEST_REJECTED: "A workflow request is rejected",
  PROBATION_END: "Days before probation ends",
  BIRTHDAY: "Days before a birthday",
  WORK_ANNIVERSARY: "Days before a work anniversary",
  CONTRACT_END: "Days before a contract ends",
  DOCUMENT_EXPIRY: "Days before a document expires",
} as const;
export type AutomationTrigger = keyof typeof AUTOMATION_TRIGGERS;
export const DATE_TRIGGERS = new Set<string>(["PROBATION_END", "BIRTHDAY", "WORK_ANNIVERSARY", "CONTRACT_END", "DOCUMENT_EXPIRY"]);

export const AUTOMATION_ACTIONS = {
  EMAIL: "Send an email",
  NOTIFY: "In-app notification",
  TASK: "Create a task",
  WEBHOOK: "Call a webhook",
  LETTER: "Generate a letter",
} as const;
export type AutomationActionType = keyof typeof AUTOMATION_ACTIONS;

export interface AutomationAction {
  type: AutomationActionType;
  /** EMPLOYEE | MANAGER | HR | USER:<id> | an email address (EMAIL only). */
  to?: string;
  subject?: string;
  body?: string;
  endpointId?: string;
  templateId?: string;
  dueInDays?: number;
}

export function parseActions(raw: unknown): AutomationAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is AutomationAction => !!a && typeof a === "object" && typeof (a as { type?: unknown }).type === "string" && (a as { type: string }).type in AUTOMATION_ACTIONS);
}

/** "Hello {{name}}" with the values given; unknown placeholders are left blank. */
export function renderTemplate(text: string, values: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => {
    const v = values[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const isoDay = (d: Date) => utcDay(d).toISOString().slice(0, 10);

/**
 * The occurrence of a date a trigger is about that falls on `today + offset`.
 * Birthdays and anniversaries recur yearly (29 Feb is kept on 28 Feb in
 * other years); probation, contract and document dates are one-off.
 * Returns the occurrence (UTC midnight) or null when it does not fire today.
 */
export function dateTriggerOccurrence(trigger: string, date: Date | null | undefined, today: Date, offsetDays: number): Date | null {
  if (!date) return null;
  const target = new Date(utcDay(today).getTime() + offsetDays * DAY);
  if (trigger === "BIRTHDAY" || trigger === "WORK_ANNIVERSARY") {
    const y = target.getUTCFullYear();
    let m = date.getUTCMonth(), d = date.getUTCDate();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (m === 1 && d === 29 && !leap) d = 28;
    const occ = new Date(Date.UTC(y, m, d));
    if (trigger === "WORK_ANNIVERSARY" && y <= date.getUTCFullYear()) return null;
    return occ.getTime() === target.getTime() ? occ : null;
  }
  return utcDay(date).getTime() === target.getTime() ? utcDay(date) : null;
}

// ---------------------------------------------------------------------------
//  IP allowlist
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let [head, tail] = ip.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const expand = (groups: string[]) => groups.flatMap((g) => {
    if (g.includes(".")) { const n = ipv4ToInt(g); return n === null ? ["x"] : [(n >>> 16).toString(16), (n & 0xffff).toString(16)]; }
    return [g];
  });
  const hh = expand(h), tt = expand(t);
  const fill = tail !== undefined ? 8 - hh.length - tt.length : 0;
  const all = [...hh, ...Array(Math.max(0, fill)).fill("0"), ...tt];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** Normalise "1.2.3.4" / "1.2.3.0/24" / "2001:db8::/32"; null when invalid. */
export function normaliseCidr(raw: string): string | null {
  const s = raw.trim();
  const [addr, bitsRaw] = s.split("/") as [string, string | undefined];
  const kind = isIP(addr);
  if (!kind) return null;
  const max = kind === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : /^\d{1,3}$/.test(bitsRaw) ? Number(bitsRaw) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return `${addr.toLowerCase()}/${bits}`;
}

/** Whether an address falls inside a CIDR (IPv4-mapped IPv6 addresses match IPv4 ranges). */
export function ipInCidr(ipRaw: string, cidr: string): boolean {
  const norm = normaliseCidr(cidr);
  if (!norm) return false;
  const [addr, bitsS] = norm.split("/") as [string, string];
  const bits = Number(bitsS);
  let ip = ipRaw.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped && isIP(addr) === 4) ip = mapped[1]!;
  if (isIP(addr) === 4) {
    const a = ipv4ToInt(ip), b = ipv4ToInt(addr);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  const a = ipv6ToBigInt(ip), b = ipv6ToBigInt(addr);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (a >> shift) === (b >> shift);
}

/** With enforcement on, an address passes only when a rule covers it. Unknown addresses fail. */
export function ipAllowed(ip: string | null | undefined, rules: string[], enforced: boolean): boolean {
  if (!enforced || rules.length === 0) return true;
  if (!ip) return false;
  return rules.some((r) => ipInCidr(ip, r));
}

// ---------------------------------------------------------------------------
//  Audit hash chain
// ---------------------------------------------------------------------------

export interface AuditLike {
  id: string; createdAt: Date; module: string; action: string; entityType: string; entityId: string | null;
  summary: string | null; actorId: string | null; actorLabel: string | null; oldValue: unknown; newValue: unknown;
}

/** Stable JSON: object keys sorted, so a re-read row hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const GENESIS_HASH = "0".repeat(64);

export function auditEntryHash(prevHash: string, e: AuditLike): string {
  const body = canonicalJson({
    id: e.id, at: e.createdAt.toISOString(), module: e.module, action: e.action, entityType: e.entityType, entityId: e.entityId,
    summary: e.summary, actorId: e.actorId, actorLabel: e.actorLabel, oldValue: e.oldValue ?? null, newValue: e.newValue ?? null,
  });
  return createHash("sha256").update(`${prevHash}|${body}`).digest("hex");
}

export interface SealLike { seq: number; auditLogId: string; prevHash: string; hash: string }
export interface ChainProblem { seq: number; auditLogId: string; problem: "MISSING" | "ALTERED" | "BROKEN_LINK" }

/** Check a sealed chain (in seq order) against the current rows. */
export function verifyChain(seals: SealLike[], rows: Map<string, AuditLike>): { checked: number; problems: ChainProblem[] } {
  const problems: ChainProblem[] = [];
  let prev = seals.length && seals[0]!.seq === 1 ? GENESIS_HASH : seals[0]?.prevHash ?? GENESIS_HASH;
  for (const s of seals) {
    if (s.prevHash !== prev) problems.push({ seq: s.seq, auditLogId: s.auditLogId, problem: "BROKEN_LINK" });
    const row = rows.get(s.auditLogId);
    if (!row) problems.push({ seq: s.seq, auditLogId: s.auditLogId, problem: "MISSING" });
    else if (auditEntryHash(s.prevHash, row) !== s.hash) problems.push({ seq: s.seq, auditLogId: s.auditLogId, problem: "ALTERED" });
    prev = s.hash;
  }
  return { checked: seals.length, problems };
}

// ---------------------------------------------------------------------------
//  Retention, accounts, compliance
// ---------------------------------------------------------------------------

export const RETENTION_DATA_TYPES = {
  LOGIN_EVENTS: { label: "Sign-in log", min: 30, actions: ["PURGE"] },
  NOTIFICATIONS: { label: "In-app notifications (read)", min: 30, actions: ["PURGE"] },
  EMAIL_OUTBOX: { label: "Sent email copies", min: 30, actions: ["PURGE"] },
  WEBHOOK_DELIVERIES: { label: "Webhook delivery log", min: 7, actions: ["PURGE"] },
  AUDIT_LOGS: { label: "Audit log", min: 365, actions: ["PURGE"] },
  EXITED_EMPLOYEES: { label: "Personal data of exited employees", min: 365, actions: ["ANONYMISE"] },
  ER_CASES: { label: "Closed employee relations cases", min: 365, actions: ["PURGE"] },
  DOCUMENT_VERSIONS: { label: "Superseded document versions", min: 90, actions: ["PURGE"] },
} as const;
export type RetentionDataType = keyof typeof RETENTION_DATA_TYPES;
export const isRetentionDataType = (v: string): v is RetentionDataType => v in RETENTION_DATA_TYPES;

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(utcDay(now).getTime() - retentionDays * DAY);
}

export interface AccountLike {
  userId: string; email: string; loginDisabled: boolean; isDeactivated: boolean; lastLoginAt: Date | null; createdAt: Date;
  employeeStatus: string | null; roleCount: number;
}

/** Enabled logins unused for `days` (never-used ones count from creation). */
export function isInactive(a: AccountLike, now: Date, days: number): boolean {
  if (a.loginDisabled || a.isDeactivated) return false;
  const last = a.lastLoginAt ?? a.createdAt;
  return now.getTime() - last.getTime() >= days * DAY;
}

/** Enabled logins with no employee behind them, or whose employee has left. */
export function orphanReason(a: AccountLike): string | null {
  if (a.loginDisabled || a.isDeactivated) return null;
  if (a.employeeStatus === null) return a.roleCount > 0 ? "No employee record, holds roles" : "No employee record";
  if (a.employeeStatus === "EXITED") return "Employee has exited";
  return null;
}

/** The next due date of a recurring compliance item. */
export function nextDueDate(frequency: string, dueOn: Date): Date | null {
  const months = frequency === "MONTHLY" ? 1 : frequency === "QUARTERLY" ? 3 : frequency === "ANNUAL" ? 12 : 0;
  if (!months) return null;
  const y = dueOn.getUTCFullYear(), m = dueOn.getUTCMonth() + months, d = dueOn.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last)));
}

export type ComplianceDisplayStatus = "OPEN" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETED" | "EXCEPTION" | "OVERDUE" | "DUE_SOON";

/** Status as shown: open work past its due date is overdue; within 7 days is due soon. */
export function complianceStatus(status: string, dueOn: Date, now: Date): ComplianceDisplayStatus {
  if (status === "COMPLETED" || status === "EXCEPTION" || status === "SUBMITTED") return status;
  const days = (utcDay(dueOn).getTime() - utcDay(now).getTime()) / DAY;
  if (days < 0) return "OVERDUE";
  if (days <= 7) return "DUE_SOON";
  return status === "IN_PROGRESS" ? "IN_PROGRESS" : "OPEN";
}

/** A 0–100 score: completed on time over everything due so far. */
export function complianceScore(items: Array<{ status: string; dueOn: Date; completedAt: Date | null }>, now: Date): number | null {
  const due = items.filter((i) => i.dueOn.getTime() <= now.getTime() || i.status === "COMPLETED");
  if (due.length === 0) return null;
  const good = due.filter((i) => i.status === "COMPLETED" || i.status === "EXCEPTION").length;
  return Math.round((good / due.length) * 100);
}

/** Days until an expiry, negative when past. */
export function daysUntil(date: Date, now: Date): number {
  return Math.round((utcDay(date).getTime() - utcDay(now).getTime()) / DAY);
}

/** A reproducible sample of n ids (audit sample selection), seeded. */
export function seededSample<T>(items: T[], n: number, seed: string): T[] {
  const scored = items.map((item, i) => ({ item, k: createHash("sha256").update(`${seed}:${i}`).digest("hex") }));
  return scored.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).slice(0, Math.max(0, n)).map((s) => s.item);
}
