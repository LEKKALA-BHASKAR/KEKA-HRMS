/**
 * Pure rules for helpdesk case operations, employee relations, documents and
 * e-signature, HR letters and asset operations. No database access, so the
 * unit tests cover them directly.
 */

const DAY = 86_400_000;
export const cdUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const cdAddDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export function cdAddMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

// ---------------------------------------------------------------------------
//  Knowledge base
// ---------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "my", "i", "how", "do", "what", "can", "with", "it", "be", "me", "are", "was", "not", "at", "this", "that"]);
export function kbTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
}

export interface KbLike { id: string; title: string; body: string; keywords: string | null; helpdeskCategoryId: string | null; helpfulYes?: number; helpfulNo?: number }

/** Relevance of an article to some text: title and keyword hits weigh more than body hits. */
export function kbScore(a: KbLike, text: string, categoryId?: string | null): number {
  const q = kbTokens(text);
  if (!q.length) return 0;
  const title = new Set(kbTokens(a.title)), kw = new Set(kbTokens(a.keywords ?? "")), body = new Set(kbTokens(a.body));
  let s = 0;
  for (const w of q) {
    if (title.has(w)) s += 3;
    if (kw.has(w)) s += 3;
    if (body.has(w)) s += 1;
  }
  if (s > 0 && categoryId && a.helpdeskCategoryId === categoryId) s += 2;
  const votes = (a.helpfulYes ?? 0) + (a.helpfulNo ?? 0);
  if (s > 0 && votes >= 3) s += ((a.helpfulYes ?? 0) / votes - 0.5);
  return s;
}

/** The best matches (score > 0), most relevant first. */
export function suggestArticles<T extends KbLike>(articles: T[], text: string, categoryId?: string | null, limit = 5): T[] {
  return articles
    .map((a) => ({ a, s: kbScore(a, text, categoryId) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.a.title.localeCompare(y.a.title))
    .slice(0, limit)
    .map((x) => x.a);
}

// ---------------------------------------------------------------------------
//  Helpdesk: SLA by priority, triage, escalation, balancing, aging
// ---------------------------------------------------------------------------

export interface SlaPolicyLike { categoryId: string | null; priority: string; firstResponseHours: number; resolutionHours: number }

/**
 * Targets for a ticket: a policy for its category (or the parent category)
 * and priority wins over an all-category policy for the priority, which wins
 * over the category's own hours.
 */
export function slaTargets(policies: SlaPolicyLike[], cat: { id: string; parentId: string | null; firstResponseHours: number; slaHours: number }, priority: string): { firstResponseHours: number; resolutionHours: number; source: "category" | "priority" | "category-priority" } {
  const p = priority === "URGENT" ? "HIGH" : priority;
  const exact = policies.find((x) => x.priority === p && x.categoryId === cat.id) ?? (cat.parentId ? policies.find((x) => x.priority === p && x.categoryId === cat.parentId) : undefined);
  if (exact) return { firstResponseHours: exact.firstResponseHours, resolutionHours: exact.resolutionHours, source: "category-priority" };
  const any = policies.find((x) => x.priority === p && x.categoryId === null);
  if (any) return { firstResponseHours: any.firstResponseHours, resolutionHours: any.resolutionHours, source: "priority" };
  return { firstResponseHours: cat.firstResponseHours, resolutionHours: cat.slaHours, source: "category" };
}

export interface TriageRuleLike { id: string; name: string; keywords: string; categoryId: string | null; setPriority: string | null; setSeverity: string | null; sortOrder: number; isActive: boolean }
export const TICKET_SEVERITIES = { S1: "S1 · Critical", S2: "S2 · Major", S3: "S3 · Moderate", S4: "S4 · Minor" } as const;
const PRIORITY_RANK: Record<string, number> = { NA: 0, LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 3 };

/** Apply triage rules: the highest priority and most severe severity any matching rule sets. */
export function triage(rules: TriageRuleLike[], text: string, categoryId: string, parentId: string | null): { priority: string | null; severity: string | null; matched: string[] } {
  const hay = ` ${text.toLowerCase()} `;
  let priority: string | null = null, severity: string | null = null;
  const matched: string[] = [];
  for (const r of [...rules].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!r.isActive) continue;
    if (r.categoryId && r.categoryId !== categoryId && r.categoryId !== parentId) continue;
    const kws = r.keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!kws.some((k) => hay.includes(k))) continue;
    matched.push(r.name);
    if (r.setPriority && (priority === null || PRIORITY_RANK[r.setPriority]! > PRIORITY_RANK[priority]!)) priority = r.setPriority;
    if (r.setSeverity && (severity === null || r.setSeverity < severity)) severity = r.setSeverity;
  }
  return { priority, severity, matched };
}

export const ESCALATION_TRIGGERS = {
  FIRST_RESPONSE_BREACH: "First response target missed",
  RESOLUTION_BREACH: "Resolution target missed",
  UNASSIGNED: "Still unassigned",
  NO_UPDATE: "No update from HR",
} as const;
export type EscalationTrigger = keyof typeof ESCALATION_TRIGGERS;

export interface EscalationTicket {
  createdAt: Date; firstResponseAt: Date | null; firstResponseDueAt: Date | null; dueAt: Date; assigneeUserId: string | null;
  lastRespondedAt: Date | null; escalationLevel: number; priority: string; categoryId: string; parentCategoryId: string | null;
}
export interface EscalationRuleLike { id: string; categoryId: string | null; priority: string | null; trigger: string; afterHours: number; level: number; isActive: boolean }

/** The moment a rule's trigger starts counting for a ticket, or null when it does not apply. */
export function escalationStart(trigger: string, t: EscalationTicket): Date | null {
  switch (trigger) {
    case "FIRST_RESPONSE_BREACH": return !t.firstResponseAt && t.firstResponseDueAt ? t.firstResponseDueAt : null;
    case "RESOLUTION_BREACH": return t.dueAt;
    case "UNASSIGNED": return t.assigneeUserId ? null : t.createdAt;
    case "NO_UPDATE": return t.lastRespondedAt ?? t.createdAt;
    default: return null;
  }
}

/** The highest-level rule now due that would raise the ticket's escalation level. */
export function dueEscalation<R extends EscalationRuleLike>(rules: R[], t: EscalationTicket, now: Date): R | null {
  let best: R | null = null;
  for (const r of rules) {
    if (!r.isActive || r.level <= t.escalationLevel) continue;
    if (r.categoryId && r.categoryId !== t.categoryId && r.categoryId !== t.parentCategoryId) continue;
    if (r.priority && r.priority !== (t.priority === "URGENT" ? "HIGH" : t.priority)) continue;
    const start = escalationStart(r.trigger, t);
    if (!start || now.getTime() < start.getTime() + r.afterHours * 3_600_000) continue;
    if (!best || r.level > best.level) best = r;
  }
  return best;
}

/** Least-loaded agent; ties go to whoever comes after the last one assigned. */
export function leastLoaded(agents: string[], openCounts: Map<string, number>, lastAssigned: string | null): string | null {
  if (!agents.length) return null;
  const start = lastAssigned ? (agents.indexOf(lastAssigned) + 1) % agents.length : 0;
  const order = [...agents.slice(start), ...agents.slice(0, start)];
  let best = order[0]!;
  for (const a of order) if ((openCounts.get(a) ?? 0) < (openCounts.get(best) ?? 0)) best = a;
  return best;
}

export const AGING_BUCKETS = ["0-1 days", "2-3 days", "4-7 days", "8-14 days", "15-30 days", "30+ days"] as const;
export function agingBucket(createdAt: Date, now: Date): (typeof AGING_BUCKETS)[number] {
  const d = (now.getTime() - createdAt.getTime()) / DAY;
  return d <= 1 ? "0-1 days" : d <= 3 ? "2-3 days" : d <= 7 ? "4-7 days" : d <= 14 ? "8-14 days" : d <= 30 ? "15-30 days" : "30+ days";
}

// ---------------------------------------------------------------------------
//  Employee relations
// ---------------------------------------------------------------------------

export const ER_KINDS = { GRIEVANCE: "Grievance", COMPLAINT: "Complaint", DISCIPLINARY: "Disciplinary" } as const;
export type ErKind = keyof typeof ER_KINDS;
export const ER_CATEGORIES = {
  HARASSMENT: "Harassment / bullying", POSH: "Sexual harassment (POSH)", DISCRIMINATION: "Discrimination", PAY: "Pay & benefits",
  WORKING_CONDITIONS: "Working conditions & safety", MANAGER: "Manager conduct", POLICY: "Policy breach", MISCONDUCT: "Misconduct",
  ATTENDANCE: "Attendance & punctuality", PERFORMANCE: "Performance", FRAUD: "Fraud / integrity", OTHER: "Other",
} as const;
export const ER_SEVERITIES = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" } as const;
export const ER_STATUSES = {
  NEW: "New", UNDER_REVIEW: "Under review", INVESTIGATION: "Investigation", HEARING: "Hearing", PENDING_DECISION: "Pending decision",
  ACTION_TAKEN: "Action taken", RESOLVED: "Resolved", CLOSED: "Closed", APPEALED: "Appealed",
} as const;
export type ErStatus = keyof typeof ER_STATUSES;
export const ER_OUTCOMES = {
  UPHELD: "Upheld", PARTIALLY_UPHELD: "Partially upheld", NOT_UPHELD: "Not upheld", WITHDRAWN: "Withdrawn", ACTION_TAKEN: "Action taken", NO_ACTION: "No action",
} as const;
export const ER_ACTION_TYPES = {
  SHOW_CAUSE: "Show-cause notice", VERBAL_WARNING: "Verbal warning", WRITTEN_WARNING: "Written warning", FINAL_WARNING: "Final warning",
  SUSPENSION: "Suspension", TERMINATION: "Termination", COUNSELLING: "Counselling", NO_ACTION: "No action",
} as const;
export type ErActionType = keyof typeof ER_ACTION_TYPES;
export const WARNING_TYPES: ErActionType[] = ["VERBAL_WARNING", "WRITTEN_WARNING", "FINAL_WARNING"];
export const INVESTIGATION_CONCLUSIONS = {
  SUBSTANTIATED: "Substantiated", PARTIALLY_SUBSTANTIATED: "Partially substantiated", UNSUBSTANTIATED: "Unsubstantiated", INCONCLUSIVE: "Inconclusive",
} as const;

/** Which statuses can follow which. Closing needs an approved resolution. */
const ER_FLOW: Record<string, string[]> = {
  NEW: ["UNDER_REVIEW", "INVESTIGATION", "PENDING_DECISION"],
  UNDER_REVIEW: ["INVESTIGATION", "HEARING", "PENDING_DECISION"],
  INVESTIGATION: ["HEARING", "PENDING_DECISION", "UNDER_REVIEW"],
  HEARING: ["PENDING_DECISION", "INVESTIGATION"],
  PENDING_DECISION: ["ACTION_TAKEN", "RESOLVED", "HEARING", "INVESTIGATION"],
  ACTION_TAKEN: ["RESOLVED", "APPEALED"],
  RESOLVED: ["CLOSED", "APPEALED"],
  APPEALED: ["RESOLVED", "ACTION_TAKEN"],
  CLOSED: [],
};
export const erCanMove = (from: string, to: string) => (ER_FLOW[from] ?? []).includes(to);

export interface LadderAction { actionType: string; status: string; effectiveOn: Date; expiresOn: Date | null }

/**
 * Progressive discipline: a final warning normally follows an active written
 * warning, and a termination an active final warning. Skipping a step is
 * allowed only with a recorded reason (gross misconduct).
 */
export function disciplinaryLadder(history: LadderAction[], next: string, now: Date): { ok: true; skipped: boolean; reason?: string } {
  const active = history.filter((a) => (a.status === "ISSUED" || a.status === "APPROVED") && (!a.expiresOn || a.expiresOn >= now));
  const has = (t: string) => active.some((a) => a.actionType === t);
  if (next === "FINAL_WARNING" && !has("WRITTEN_WARNING") && !has("FINAL_WARNING")) return { ok: true, skipped: true, reason: "No active written warning precedes this final warning." };
  if (next === "TERMINATION" && !has("FINAL_WARNING")) return { ok: true, skipped: true, reason: "No active final warning precedes this termination." };
  return { ok: true, skipped: false };
}

/** An action can be appealed by the employee within the window after it was issued. */
export function appealOpen(action: { status: string; issuedAt: Date | null; actionType: string }, windowDays: number, now: Date): boolean {
  if (action.status !== "ISSUED" || !action.issuedAt) return false;
  if (action.actionType === "NO_ACTION" || action.actionType === "COUNSELLING") return false;
  return now.getTime() <= action.issuedAt.getTime() + windowDays * DAY;
}

export function suspensionDays(from: Date | null, to: Date | null): number {
  if (!from || !to) return 0;
  return Math.max(0, Math.round((cdUtcDay(to).getTime() - cdUtcDay(from).getTime()) / DAY) + 1);
}

/** Who may see a case's internals. The case's subject never can, whatever their role. */
export function erCanView(c: { isConfidential: boolean; subjectEmployeeId: string | null; ownerUserId: string | null }, v: { userId: string; employeeId: string | null; canManage: boolean; canApprove: boolean; onAccessList: boolean }): boolean {
  if (v.employeeId && c.subjectEmployeeId === v.employeeId) return false;
  if (c.ownerUserId === v.userId || v.onAccessList) return true;
  if (!c.isConfidential) return v.canManage || v.canApprove;
  return v.canApprove;
}

// ---------------------------------------------------------------------------
//  E-signature
// ---------------------------------------------------------------------------

export interface RecipientLike { id: string; order: number; role: string; status: string }

/** Recipients who should be signing now. */
export function activeRecipients<R extends RecipientLike>(rs: R[], sequential: boolean): R[] {
  const signers = rs.filter((r) => r.role !== "CC" && r.status !== "DELEGATED");
  const open = signers.filter((r) => r.status === "WAITING" || r.status === "PENDING");
  if (!sequential) return open;
  if (!open.length) return [];
  const first = Math.min(...open.map((r) => r.order));
  // Sequential: everyone in the earliest unfinished order position (equal orders sign in parallel).
  return open.filter((r) => r.order === first);
}

export function envelopeOutcome(rs: RecipientLike[]): "DECLINED" | "COMPLETED" | "IN_PROGRESS" {
  const signers = rs.filter((r) => r.role !== "CC" && r.status !== "DELEGATED");
  if (signers.some((r) => r.status === "DECLINED")) return "DECLINED";
  if (signers.length > 0 && signers.every((r) => r.status === "SIGNED" || r.status === "SKIPPED")) return "COMPLETED";
  return "IN_PROGRESS";
}

export function envelopeReminderDue(r: { status: string; remindedAt: Date | null; createdAt: Date }, sentAt: Date | null, everyDays: number | null, now: Date): boolean {
  if (!everyDays || everyDays <= 0 || r.status !== "PENDING") return false;
  const since = r.remindedAt ?? sentAt ?? r.createdAt;
  return now.getTime() - since.getTime() >= everyDays * DAY;
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

/** 0 nothing due · 1 within 30 days · 2 within 7 days · 3 expired. */
export function expiryStage(expiresOn: Date | null, now: Date): 0 | 1 | 2 | 3 {
  if (!expiresOn) return 0;
  const days = Math.ceil((cdUtcDay(expiresOn).getTime() - cdUtcDay(now).getTime()) / DAY);
  return days < 0 ? 3 : days <= 7 ? 2 : days <= 30 ? 1 : 0;
}

/** "ACM0009_passport.pdf", "ACM0009-visa.png", "ACM0009.pdf" → "ACM0009". */
export function employeeNumberFromFilename(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, "");
  const m = /^([A-Za-z]{0,6}\d{1,8})(?:[\s_\-.].*)?$/.exec(base.trim());
  return m ? m[1]!.toUpperCase() : null;
}

/** Completeness of an employee's mandatory documents, 0–100. */
export function documentCompleteness(docs: Array<{ mandatory: boolean; status: string }>): { required: number; done: number; percent: number } {
  const req = docs.filter((d) => d.mandatory && d.status !== "NOT_APPLICABLE");
  const done = req.filter((d) => d.status === "VERIFIED" || d.status === "PENDING_VERIFICATION").length;
  return { required: req.length, done, percent: req.length ? Math.round((done / req.length) * 100) : 100 };
}

/** Folder visibility: open folders follow the document permissions; confidential ones need a role or a grant. */
export function folderAllows(folder: { isConfidential: boolean; viewRoles: unknown; editRoles: unknown }, v: { roleNames: string[]; isOwnDocument: boolean; hasGrant: boolean; grantCanEdit: boolean; canManageAll: boolean }, mode: "view" | "edit"): boolean {
  if (v.isOwnDocument && mode === "view") return true;
  const list = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const roles = list(mode === "view" ? folder.viewRoles : folder.editRoles);
  const roleOk = roles.some((r) => v.roleNames.includes(r));
  if (v.hasGrant && (mode === "view" || v.grantCanEdit)) return true;
  if (!folder.isConfidential) return roles.length ? roleOk || v.canManageAll : true;
  return roleOk || (v.canManageAll && roles.length === 0);
}

// ---------------------------------------------------------------------------
//  HR letters
// ---------------------------------------------------------------------------

/** HR/{YYYY}/0042 style numbers. */
export function formatLetterNumber(prefix: string, digits: number, n: number, at: Date, category: string | null): string {
  const p = prefix
    .replace(/\{YYYY\}/g, String(at.getUTCFullYear()))
    .replace(/\{YY\}/g, String(at.getUTCFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(at.getUTCMonth() + 1).padStart(2, "0"))
    .replace(/\{CAT\}/g, (category ?? "GEN").slice(0, 4).toUpperCase());
  return `${p}${String(n).padStart(Math.max(1, Math.min(10, digits)), "0")}`;
}

/** The number to use next, given a yearly reset. */
export function nextSeriesNumber(s: { nextNumber: number; yearlyReset: boolean; lastYear: number | null }, at: Date): { use: number; next: number; year: number } {
  const year = at.getUTCFullYear();
  const use = s.yearlyReset && s.lastYear !== null && s.lastYear !== year ? 1 : s.nextNumber;
  return { use, next: use + 1, year };
}

/**
 * Conditional sections: {{#if key}}…{{else}}…{{/if}} and {{#unless key}}…{{/unless}},
 * kept when the value is present (non-empty). Not nested.
 */
export function applyConditionals(body: string, values: Record<string, string | undefined>): string {
  const present = (k: string) => { const v = values[k]; return v !== undefined && v !== "" && v !== "0"; };
  let out = body.replace(/\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_m, k: string, yes: string, no?: string) => (present(k) ? yes : no ?? ""));
  out = out.replace(/\{\{#unless\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_m, k: string, yes: string) => (present(k) ? "" : yes));
  return out;
}

export function issueDateProblem(issuedOn: Date, now: Date, maxBackdateDays: number): string | null {
  const d = cdUtcDay(issuedOn).getTime(), today = cdUtcDay(now).getTime();
  if (d > today + 30 * DAY) return "A letter cannot be dated more than 30 days ahead.";
  if (d < today - maxBackdateDays * DAY) return `A letter cannot be backdated more than ${maxBackdateDays} days.`;
  return null;
}

// ---------------------------------------------------------------------------
//  Assets
// ---------------------------------------------------------------------------

export interface ChecklistItem { label: string; required: boolean; done?: boolean; note?: string | null }
export function parseAssetChecklistItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => (x && typeof x === "object" && typeof (x as ChecklistItem).label === "string" ? [{ label: (x as ChecklistItem).label, required: !!(x as ChecklistItem).required, done: !!(x as ChecklistItem).done, note: (x as ChecklistItem).note ?? null }] : []));
}
export function checklistMissing(items: ChecklistItem[]): string[] {
  return items.filter((i) => i.required && !i.done).map((i) => i.label);
}

export function reservationOverlaps(existing: Array<{ fromDate: Date; toDate: Date; status: string }>, from: Date, to: Date): boolean {
  return existing.some((r) => ["REQUESTED", "APPROVED", "CHECKED_OUT"].includes(r.status) && r.fromDate <= to && from <= r.toDate);
}

export function stockShortfalls<T extends { assetTypeId: string; minAvailable: number }>(thresholds: T[], available: Map<string, number>): Array<T & { available: number; short: number }> {
  return thresholds.map((t) => ({ ...t, available: available.get(t.assetTypeId) ?? 0, short: t.minAvailable - (available.get(t.assetTypeId) ?? 0) })).filter((t) => t.short > 0);
}

export function reconciliationSummary(lines: Array<{ found: boolean | null; expectedLocation: string | null; foundLocation: string | null; expectedStatus: string; foundCondition: string | null }>) {
  const checked = lines.filter((l) => l.found !== null);
  return {
    total: lines.length,
    checked: checked.length,
    found: checked.filter((l) => l.found).length,
    missing: checked.filter((l) => l.found === false).length,
    misplaced: checked.filter((l) => l.found && l.expectedLocation && l.foundLocation && l.expectedLocation !== l.foundLocation).length,
    unchecked: lines.length - checked.length,
  };
}

export const DISPOSAL_METHODS = { SCRAP: "Scrap", SALE: "Sale", DONATION: "Donation", RECYCLE: "E-waste recycling", WRITE_OFF: "Write-off" } as const;
export const MAINTENANCE_KINDS = { PREVENTIVE: "Preventive maintenance", REPAIR: "Repair", INSPECTION: "Inspection" } as const;
