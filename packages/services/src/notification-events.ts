import type { RecipientGroup } from "./core-hr-workflows-math";

/**
 * The events that send email, as Admin > Settings > Notifications lists
 * them. A call to notify() names its event; the admin's setting for that
 * event (if any) decides whether the email goes and to whom. `defaults` is
 * who the event emails today, so an untouched event reads the same as its
 * code. `configurable` is false where the recipients are not about one
 * employee (an interview panel, everyone in a review cycle): those can be
 * switched off or copied to a custom address, but not re-targeted.
 */

export interface NotificationEvent {
  key: string;
  label: string;
  module: string;
  description: string;
  defaults: RecipientGroup[];
  configurable: boolean;
  /** Who counts as HR for this event. */
  hrPermission?: string;
  /** Describes non-configurable default recipients. */
  defaultLabel?: string;
}

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  { key: "EXIT_SUBMITTED", module: "Exits", label: "Resignation submitted or exit recorded", description: "Tells the manager and exit administrators that someone is leaving.", defaults: ["MANAGER", "HR"], configurable: true, hrPermission: "lifecycle.exit.manage" },
  { key: "EXIT_ACCEPTED", module: "Exits", label: "Resignation accepted", description: "Tells the employee their resignation was accepted and their last day.", defaults: ["EMPLOYEE"], configurable: true, hrPermission: "lifecycle.exit.manage" },
  { key: "PROBATION_REVIEW_DUE", module: "Probation", label: "Probation review due", description: "Asks the manager for feedback before probation ends.", defaults: ["MANAGER"], configurable: true },
  { key: "PROBATION_EXTENDED", module: "Probation", label: "Probation extended", description: "Tells the employee and manager the new end date.", defaults: ["EMPLOYEE", "MANAGER"], configurable: true },
  { key: "PROBATION_CONFIRMED", module: "Probation", label: "Employee confirmed", description: "Tells the employee and manager about the confirmation.", defaults: ["EMPLOYEE", "MANAGER"], configurable: true },
  { key: "LOAN_APPROVED", module: "Finances", label: "Loan approved", description: "Tells the employee the EMI and when deductions start.", defaults: ["EMPLOYEE"], configurable: true, hrPermission: "payroll.loan.manage" },
  { key: "ASSET_ACK_REMINDER", module: "Assets", label: "Asset acknowledgement reminder", description: "Asks the employee to confirm they received an asset.", defaults: ["EMPLOYEE"], configurable: true, hrPermission: "asset.item.manage" },
  { key: "REVIEW_CYCLE_STARTED", module: "Performance", label: "Review cycle started", description: "Asks everyone in the cycle to write their self review.", defaults: ["EMPLOYEE"], configurable: false, defaultLabel: "Everyone in the cycle" },
  { key: "REVIEW_SHARED", module: "Performance", label: "Review shared", description: "Tells everyone in the cycle their review is ready.", defaults: ["EMPLOYEE"], configurable: false, defaultLabel: "Everyone in the cycle" },
  { key: "INTERVIEW_SCHEDULED", module: "Hiring", label: "Interview scheduled", description: "Invites the interview panel.", defaults: [], configurable: false, defaultLabel: "The interview panel" },
  { key: "INTERVIEW_FEEDBACK_DUE", module: "Hiring", label: "Interview feedback due", description: "Reminds a panellist to submit feedback.", defaults: [], configurable: false, defaultLabel: "The panellist" },
  { key: "JOB_CHANGE_APPLIED", module: "Core HR", label: "Promotion or transfer takes effect", description: "Tells the employee and manager when an approved job change is applied. Off until switched on.", defaults: [], configurable: true },
];

/** Events that do not email until an admin turns them on (new events, so nothing changes by default). */
export const OFF_BY_DEFAULT = new Set(["JOB_CHANGE_APPLIED"]);

export const notificationEvent = (key: string) => NOTIFICATION_EVENTS.find((e) => e.key === key) ?? null;
