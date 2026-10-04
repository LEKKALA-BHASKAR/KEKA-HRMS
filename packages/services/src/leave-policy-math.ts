/**
 * Pure rules for leave and attendance policy depth: approval chains, usage
 * limits, optional holidays, manual day overrides, the LOP import file, shift
 * allowance and overtime rounding. No database access, so each is unit-tested
 * directly; leave-policy.ts gathers the inputs and persists the results.
 */
import { parseCsv, headerKey } from "./import-math";

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const key = (d: Date) => d.toISOString().slice(0, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------------------------------------------------------------------------
//  Approval chains
// ---------------------------------------------------------------------------

/**
 * Who decides a level. ANY is today's behaviour — anyone whose role lets them
 * approve leave for this employee; HR is anyone who manages leave for them;
 * the rest resolve to one person from the org chart.
 */
export const APPROVAL_ROLES = ["REPORTING_MANAGER", "SKIP_LEVEL_MANAGER", "DOTTED_LINE_MANAGER", "DEPARTMENT_HEAD", "HR", "ANY"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];
export const APPROVAL_ROLE_LABEL: Record<ApprovalRole, string> = {
  REPORTING_MANAGER: "Reporting manager",
  SKIP_LEVEL_MANAGER: "Manager's manager",
  DOTTED_LINE_MANAGER: "Dotted-line manager",
  DEPARTMENT_HEAD: "Department head",
  HR: "HR",
  ANY: "Any approver",
};

export interface ApprovalChainConfig {
  levels: ApprovalRole[];
  /** Skip a later level its approver has already cleared at an earlier one. */
  skipSamePerson: boolean;
  /** Approve automatically once a level has waited this many days. */
  autoApproveAfterDays: number | null;
}

/** A stored chain, or null when there is none (the single-decision default). */
export function parseApprovalChain(raw: unknown): ApprovalChainConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const levels = Array.isArray(o.levels)
    ? o.levels.filter((l): l is ApprovalRole => typeof l === "string" && (APPROVAL_ROLES as readonly string[]).includes(l)).slice(0, 5)
    : [];
  const auto = Number(o.autoApproveAfterDays);
  const autoApproveAfterDays = Number.isFinite(auto) && auto > 0 ? Math.floor(auto) : null;
  if (levels.length === 0 && autoApproveAfterDays === null) return null;
  return {
    levels: levels.length ? levels : ["ANY"],
    skipSamePerson: o.skipSamePerson !== false,
    autoApproveAfterDays,
  };
}

/** The type's own chain wins over its plan's. */
export function effectiveChain(typeChain: unknown, planChain: unknown): ApprovalChainConfig | null {
  return parseApprovalChain(typeChain) ?? parseApprovalChain(planChain);
}

export type StepStatus = "PENDING" | "APPROVED" | "SKIPPED" | "AUTO" | "REJECTED";

export interface ApprovalStep {
  role: ApprovalRole;
  /** The person who must act, for person roles; null for HR and ANY. */
  approverId: string | null;
  status: StepStatus;
  /** Employee id of whoever cleared it; null for the system. */
  by: string | null;
  at: string | null;
  note: string | null;
}

export interface ChainPeople {
  employeeId: string;
  managerId: string | null;
  skipManagerId: string | null;
  departmentHeadId: string | null;
  /** The employee's dotted-line manager (32-core-hr-depth), if any. */
  dottedLineManagerId?: string | null;
}

/**
 * Turn a chain into concrete steps for one employee. A person level with
 * nobody in the seat — or with the employee themselves in it — is dropped;
 * with skipSamePerson, so is a level held by the same person as the one
 * before. A chain that resolves to nothing falls back to one ANY level, so a
 * request is never left with no one able to approve it.
 */
export function resolveApprovalSteps(cfg: ApprovalChainConfig, people: ChainPeople): ApprovalStep[] {
  const seat: Record<ApprovalRole, string | null> = {
    REPORTING_MANAGER: people.managerId,
    SKIP_LEVEL_MANAGER: people.skipManagerId,
    DOTTED_LINE_MANAGER: people.dottedLineManagerId ?? null,
    DEPARTMENT_HEAD: people.departmentHeadId,
    HR: null,
    ANY: null,
  };
  const steps: ApprovalStep[] = [];
  for (const role of cfg.levels) {
    const personal = role !== "HR" && role !== "ANY";
    const approverId = seat[role];
    if (personal && (!approverId || approverId === people.employeeId)) continue;
    const prev = steps[steps.length - 1];
    if (cfg.skipSamePerson && prev && personal && prev.approverId === approverId) continue;
    if (prev && !personal && prev.role === role) continue;
    steps.push({ role, approverId: personal ? approverId : null, status: "PENDING", by: null, at: null, note: null });
  }
  if (steps.length === 0) steps.push({ role: "ANY", approverId: null, status: "PENDING", by: null, at: null, note: null });
  return steps;
}

export function parseSteps(raw: unknown): ApprovalStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.filter((s): s is ApprovalStep => !!s && typeof s === "object" && typeof (s as ApprovalStep).role === "string");
}

export interface LeaveApprovalActor {
  employeeId: string | null;
  /** Manages leave for this employee (HR, admins). */
  isHr: boolean;
  /** Holds leave approval over this employee at all. */
  canApprove: boolean;
}

/**
 * May this actor decide this level? The named person may, and so may HR —
 * an administrator can always move a request along; ANY is anyone who may
 * approve for the employee.
 */
export function canActOnStep(step: ApprovalStep, actor: LeaveApprovalActor): boolean {
  if (step.role === "ANY") return actor.canApprove || actor.isHr;
  if (step.role === "HR") return actor.isHr;
  return (!!actor.employeeId && actor.employeeId === step.approverId) || actor.isHr;
}

/** Would this actor's approval already cover the step (for skipSamePerson)? */
function covers(step: ApprovalStep, actor: LeaveApprovalActor): boolean {
  if (step.role === "HR") return actor.isHr;
  if (step.role === "ANY") return actor.canApprove || actor.isHr;
  return !!actor.employeeId && actor.employeeId === step.approverId;
}

/**
 * Record an approval at the current level and move on. Returns the next level
 * waiting, or null when the chain is complete.
 */
export function approveStep(
  steps: ApprovalStep[], level: number, actor: LeaveApprovalActor, at: Date, note: string | null, skipSamePerson: boolean,
): { steps: ApprovalStep[]; nextLevel: number | null } {
  const out = steps.map((s) => ({ ...s }));
  out[level] = { ...out[level], status: "APPROVED", by: actor.employeeId, at: at.toISOString(), note };
  let i = level + 1;
  while (i < out.length && skipSamePerson && covers(out[i], actor)) {
    out[i] = { ...out[i], status: "SKIPPED", by: actor.employeeId, at: at.toISOString(), note: "Already approved by the same person" };
    i++;
  }
  return { steps: out, nextLevel: i < out.length ? i : null };
}

/** Clear every remaining level as the system. */
export function autoApproveSteps(steps: ApprovalStep[], level: number, at: Date): ApprovalStep[] {
  return steps.map((s, i) => (i >= level && s.status === "PENDING"
    ? { ...s, status: "AUTO" as const, by: null, at: at.toISOString(), note: "Auto-approved: no decision in time" }
    : s));
}

/** Has the waiting level sat long enough to approve itself? */
export function autoApproveDue(levelSince: Date, days: number | null, today: Date): boolean {
  if (!days || days <= 0) return false;
  return utcMidnight(today).getTime() - utcMidnight(levelSince).getTime() >= days * DAY;
}

// ---------------------------------------------------------------------------
//  Usage limits
// ---------------------------------------------------------------------------

export interface UsageLimits {
  name: string;
  maxDaysPerMonth: number | null;
  minGapDays: number | null;
  maxConsecutiveDays: number | null;
}

/** A request's charged days (sandwiched days included — they are charged). */
export interface LeaveSpan {
  from: Date;
  to: Date;
  days: Array<{ key: string; value: number }>;
}

export interface UsageIssue { field: string; message: string }

const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const spanLabel = (s: LeaveSpan) => (key(s.from) === key(s.to) ? key(s.from) : `${key(s.from)} to ${key(s.to)}`);
const total = (s: LeaveSpan) => r2(s.days.reduce((a, d) => a + d.value, 0));

/**
 * Checks a request against the type's usage limits, given the employee's
 * other pending and approved requests of the same type:
 *
 *   maxDaysPerMonth     charged days per calendar month, this request included
 *   minGapDays          clear calendar days required between two requests
 *   maxConsecutiveDays  across requests that touch (directly or over off days)
 *
 * The single-request consecutive limit is validateLeave's; this adds the case
 * where an adjoining request makes the run too long.
 */
export function usageLimitIssues(input: {
  limits: UsageLimits;
  request: LeaveSpan;
  others: LeaveSpan[];
  /** Weekly off or holiday for this employee. */
  isOffDay?: (dayKey: string) => boolean;
}): UsageIssue[] {
  const { limits: l, request } = input;
  const issues: UsageIssue[] = [];
  const isOff = input.isOffDay ?? (() => false);

  if (l.maxDaysPerMonth && l.maxDaysPerMonth > 0) {
    const mine = new Map<string, number>();
    for (const d of request.days) mine.set(d.key.slice(0, 7), (mine.get(d.key.slice(0, 7)) ?? 0) + d.value);
    for (const [ym, days] of [...mine.entries()].sort()) {
      const already = r2(input.others.flatMap((o) => o.days).filter((d) => d.key.startsWith(ym)).reduce((a, d) => a + d.value, 0));
      const sum = r2(already + days);
      if (sum > l.maxDaysPerMonth + 1e-9) {
        issues.push({
          field: "fromDate",
          message: `At most ${l.maxDaysPerMonth} day(s) of ${l.name} can be taken in a month; ${monthLabel(ym)} would have ${sum}` +
            (already > 0 ? ` (${already} already taken or pending).` : "."),
        });
        break;
      }
    }
  }

  if (l.minGapDays && l.minGapDays > 0) {
    for (const o of input.others) {
      let gap: number | null = null;
      if (o.to.getTime() < request.from.getTime()) gap = Math.round((request.from.getTime() - o.to.getTime()) / DAY) - 1;
      else if (o.from.getTime() > request.to.getTime()) gap = Math.round((o.from.getTime() - request.to.getTime()) / DAY) - 1;
      if (gap !== null && gap < l.minGapDays) {
        issues.push({
          field: "fromDate",
          message: `Leave a gap of at least ${l.minGapDays} day(s) between two ${l.name} requests; this is ${gap} day(s) from your ${l.name} on ${spanLabel(o)}.`,
        });
        break;
      }
    }
  }

  if (l.maxConsecutiveDays && l.maxConsecutiveDays > 0) {
    // Requests that touch the run, directly or across weekly offs/holidays.
    const touches = (a: Date, b: Date) => {
      for (let t = a.getTime() + DAY; t < b.getTime(); t += DAY) if (!isOff(key(new Date(t)))) return false;
      return true;
    };
    const run = [request];
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of input.others) {
        if (run.includes(o)) continue;
        const first = run.reduce((m, s) => (s.from < m ? s.from : m), run[0].from);
        const last = run.reduce((m, s) => (s.to > m ? s.to : m), run[0].to);
        if ((o.to < first && touches(o.to, first)) || (o.from > last && touches(last, o.from))) {
          run.push(o); grew = true;
        }
      }
    }
    if (run.length > 1) {
      const sum = r2(run.reduce((a, s) => a + total(s), 0));
      if (sum > l.maxConsecutiveDays + 1e-9) {
        issues.push({
          field: "toDate",
          message: `Together with your adjoining ${l.name} (${run.slice(1).map(spanLabel).join(", ")}) this makes ${sum} consecutive day(s); at most ${l.maxConsecutiveDays} are allowed.`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
//  Optional holidays
// ---------------------------------------------------------------------------

/** Why an employee may not pick this optional holiday, or null when they may. */
export function optionalHolidayPickIssue(input: {
  isOptional: boolean;
  quota: number;
  pickedThisCalendar: number;
  alreadyPicked: boolean;
  date: Date;
  today: Date;
  hasLeaveThatDay: boolean;
}): string | null {
  if (!input.isOptional) return "That is a public holiday — everyone already has it off.";
  if (input.alreadyPicked) return "You have already picked this holiday.";
  if (utcMidnight(input.date).getTime() < utcMidnight(input.today).getTime()) return "Optional holidays can only be picked for dates still to come.";
  if (input.quota <= 0) return "Your holiday calendar does not allow optional holidays.";
  if (input.pickedThisCalendar >= input.quota) {
    return `You have already picked ${input.pickedThisCalendar} of ${input.quota} optional holiday(s) this year. Remove one first.`;
  }
  if (input.hasLeaveThatDay) return "You have leave on that day. Withdraw it before picking the holiday.";
  return null;
}

// ---------------------------------------------------------------------------
//  Manual day override
// ---------------------------------------------------------------------------

export const EDITABLE_STATUSES = ["PRESENT", "ABSENT", "HALF_DAY", "ON_DUTY", "WORK_FROM_HOME", "WEEKLY_OFF", "HOLIDAY", "NO_ATTENDANCE"] as const;
export type EditableStatus = (typeof EDITABLE_STATUSES)[number];

/** What a status set by an administrator pays and docks. */
export function manualDayValues(status: string, noAttendanceIsLop = true): { payableValue: number; lopValue: number } {
  switch (status) {
    case "HALF_DAY": return { payableValue: 0.5, lopValue: 0.5 };
    case "ABSENT": return { payableValue: 0, lopValue: 1 };
    case "NO_ATTENDANCE": return noAttendanceIsLop ? { payableValue: 0, lopValue: 1 } : { payableValue: 1, lopValue: 0 };
    default: return { payableValue: 1, lopValue: 0 };
  }
}

// ---------------------------------------------------------------------------
//  LOP import
// ---------------------------------------------------------------------------

export interface LopImportRow { line: number; employeeNumber: string; year: number; month: number; days: number; note: string | null }
export interface LopImportResult { rows: LopImportRow[]; errors: Array<{ line: number; message: string }> }

const EMP_HEADERS = ["employeenumber", "employeeno", "empno", "employeecode", "employeeid", "empcode", "employee"];
const DAYS_HEADERS = ["lopdays", "lop", "days", "lossofpaydays", "lossofpay"];

/**
 * Read a CSV of LOP days per employee per month. Columns (any order, header
 * names forgiving): employee number, month (YYYY-MM, or separate month and
 * year columns), LOP days, an optional note. Zero days clears the month.
 */
export function parseLopCsv(text: string): LopImportResult {
  const table = parseCsv(text);
  const errors: LopImportResult["errors"] = [];
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: "The file is empty." }] };
  const head = table[0].map(headerKey);
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const iEmp = col(EMP_HEADERS), iDays = col(DAYS_HEADERS), iMonth = col(["month", "period", "paymonth"]), iYear = col(["year"]), iNote = col(["note", "remarks", "remark", "reason"]);
  const missing = [iEmp < 0 && "employee number", iMonth < 0 && "month", iDays < 0 && "LOP days"].filter(Boolean);
  if (missing.length) return { rows: [], errors: [{ line: 1, message: `Missing column(s): ${missing.join(", ")}.` }] };

  const rows: LopImportRow[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const cell = (j: number) => (j >= 0 ? (cells[j] ?? "").trim() : "");
    const employeeNumber = cell(iEmp);
    if (!employeeNumber) { errors.push({ line, message: "No employee number." }); return; }
    let year: number, month: number;
    const m = /^(\d{4})-(\d{1,2})$/.exec(cell(iMonth)) ?? /^(\d{1,2})[/-](\d{4})$/.exec(cell(iMonth));
    if (m && m[1].length === 4) { year = Number(m[1]); month = Number(m[2]); }
    else if (m) { month = Number(m[1]); year = Number(m[2]); }
    else if (/^\d{1,2}$/.test(cell(iMonth)) && /^\d{4}$/.test(cell(iYear))) { month = Number(cell(iMonth)); year = Number(cell(iYear)); }
    else { errors.push({ line, message: `Month "${cell(iMonth)}" is not YYYY-MM.` }); return; }
    if (month < 1 || month > 12 || year < 2000 || year > 2100) { errors.push({ line, message: `Month "${cell(iMonth)}" is out of range.` }); return; }
    const raw = cell(iDays);
    const days = Number(raw);
    if (raw === "" || !Number.isFinite(days) || days < 0 || days > 31) { errors.push({ line, message: `LOP days "${raw}" must be a number from 0 to 31.` }); return; }
    if (Math.round(days * 100) !== days * 100) { errors.push({ line, message: `LOP days "${raw}" has more than two decimals.` }); return; }
    const k = `${employeeNumber.toUpperCase()}:${year}-${month}`;
    if (seen.has(k)) { errors.push({ line, message: `${employeeNumber} already has a row for ${year}-${String(month).padStart(2, "0")} on line ${seen.get(k)}.` }); return; }
    seen.set(k, line);
    rows.push({ line, employeeNumber, year, month, days, note: cell(iNote) || null });
  });
  return { rows, errors };
}

// ---------------------------------------------------------------------------
//  Shift allowance
// ---------------------------------------------------------------------------

export interface AllowanceShift { code: string; allowanceCode: string | null; perDay: number | null }
export interface AllowanceDay { employeeId: string; shiftId: string | null; status: string; payableValue: number }
export interface AllowanceLine { employeeId: string; shiftCode: string; allowanceCode: string; days: number; amount: number }

/** Days that earn a shift allowance: the shift was actually worked. */
export function allowanceDayValue(status: string, payableValue: number): number {
  if (status === "HALF_DAY") return 0.5;
  if (status === "PRESENT" || status === "ON_DUTY" || status === "WORK_FROM_HOME") return Math.max(0, Math.min(1, payableValue));
  return 0;
}

/** One line per employee per allowance-bearing shift for the month. */
export function shiftAllowanceLines(days: AllowanceDay[], shifts: Map<string, AllowanceShift>): AllowanceLine[] {
  const acc = new Map<string, AllowanceLine>();
  for (const d of days) {
    const s = d.shiftId ? shifts.get(d.shiftId) : undefined;
    if (!s || !s.allowanceCode || !s.perDay || s.perDay <= 0) continue;
    const v = allowanceDayValue(d.status, d.payableValue);
    if (v <= 0) continue;
    const k = `${d.employeeId}:${s.code}`;
    const line = acc.get(k) ?? { employeeId: d.employeeId, shiftCode: s.code, allowanceCode: s.allowanceCode, days: 0, amount: 0 };
    line.days = r2(line.days + v);
    line.amount = r2(line.days * s.perDay);
    acc.set(k, line);
  }
  return [...acc.values()];
}

// ---------------------------------------------------------------------------
//  Overtime policy
// ---------------------------------------------------------------------------

/** Overtime minutes rounded down to the policy's block. */
export function roundOvertimeMinutes(minutes: number, block: number): number {
  const m = Math.max(0, Math.round(minutes));
  return block > 0 ? Math.floor(m / block) * block : m;
}

/** Pay for overtime minutes at an hourly rate and a multiplier. */
export function overtimePay(minutes: number, rate: number, multiplier: number): number {
  return r2((minutes / 60) * rate * (multiplier > 0 ? multiplier : 1));
}
