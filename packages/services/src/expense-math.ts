/**
 * Pure expense rules — no database. Line checks against policy, and how an
 * approved claim settles against an open cash advance.
 */

export interface LineRules {
  /** The tighter of the category cap and the policy's cap for it. */
  cap: number | null;
  receiptRequiredAbove: number | null;
  allowFutureDated: boolean;
  /** Claims older than this many days are refused. */
  maxAgeDays: number;
}

export interface LineIssue { level: "error" | "warning"; message: string }

export function checkLine(line: { amount: number; expenseDate: Date; hasReceipt: boolean }, rules: LineRules, today = new Date()): LineIssue[] {
  const issues: LineIssue[] = [];
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (!(line.amount > 0)) issues.push({ level: "error", message: "The amount must be more than zero." });
  if (!rules.allowFutureDated && line.expenseDate.getTime() > day) issues.push({ level: "error", message: "Expenses cannot be dated in the future." });
  if ((day - line.expenseDate.getTime()) / 86_400_000 > rules.maxAgeDays) issues.push({ level: "error", message: `Expenses older than ${rules.maxAgeDays} days cannot be claimed.` });
  if (rules.receiptRequiredAbove !== null && line.amount > rules.receiptRequiredAbove && !line.hasReceipt) {
    issues.push({ level: "error", message: `A receipt is required above ₹${rules.receiptRequiredAbove.toLocaleString("en-IN")}.` });
  }
  if (rules.cap !== null && line.amount > rules.cap) {
    issues.push({ level: "warning", message: `Over the ₹${rules.cap.toLocaleString("en-IN")} limit — at most that will be approved.` });
  }
  return issues;
}

/** What an approver sees as the default: the claim, capped. */
export function defaultApproved(amount: number, cap: number | null): number {
  return cap === null ? amount : Math.min(amount, cap);
}

/**
 * An approved claim first clears the employee's open advance; only the rest
 * is paid out. If the claim is smaller than the advance, the advance stays
 * partly open and nothing is paid.
 */
export function settleAgainstAdvance(approved: number, advanceOutstanding: number): { settles: number; payable: number; stillOutstanding: number } {
  const settles = Math.min(Math.max(0, approved), Math.max(0, advanceOutstanding));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { settles: r2(settles), payable: r2(approved - settles), stillOutstanding: r2(advanceOutstanding - settles) };
}
