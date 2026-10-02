import { PERMISSIONS, type Permission } from "@keka/rbac";
import type { ImportColumn } from "@keka/services";

/**
 * The bulk imports a tenant needs to go live, and the columns each expects.
 * Each row is handed to the same server action a person would use for one
 * record, so an import can never do anything the screens would refuse.
 */

const P = PERMISSIONS;

export type ImportKind = "employees" | "leave-balances" | "salaries" | "bank-accounts" | "bonuses" | "job-details";

export const IMPORTS: Record<ImportKind, { label: string; description: string; permission: Permission; columns: ImportColumn[] }> = {
  employees: {
    label: "Employees",
    description: "New joiners or a whole workforce moving in. Each row creates the employee, their first job record, statutory profile, opening salary and onboarding journey.",
    permission: P.EMPLOYEE_CREATE,
    columns: [
      { key: "employee_number", label: "Employee number", hint: "Blank takes the next number from the default series", example: "" },
      { key: "first_name", label: "First name", required: true, example: "Asha" },
      { key: "last_name", label: "Last name", required: true, example: "Pillai" },
      { key: "work_email", label: "Work email", required: true, example: "asha.pillai@acme.test" },
      { key: "date_of_joining", label: "Date of joining", required: true, hint: "yyyy-mm-dd or dd/mm/yyyy", example: "2026-10-01" },
      { key: "legal_entity", label: "Legal entity", required: true, hint: "Name as set up under Organisation", example: "Acme Technologies" },
      { key: "location", label: "Location", required: true, example: "Bengaluru HQ" },
      { key: "department", label: "Department", example: "Product Engineering" },
      { key: "job_title", label: "Job title", example: "Software Engineer" },
      { key: "reporting_manager", label: "Reporting manager", hint: "Their employee number; may be someone earlier in the same file", example: "ACM0002" },
      { key: "status", label: "Status", hint: "PROBATION, CONFIRMED, ONBOARDING or PREBOARDING", example: "PROBATION" },
      { key: "pay_group", label: "Pay group", hint: "Required when an annual CTC is given", example: "Acme India — Monthly" },
      { key: "annual_ctc", label: "Annual CTC", example: "1200000" },
      { key: "tax_regime", label: "Tax regime", hint: "NEW or OLD", example: "NEW" },
      { key: "leave_plan", label: "Leave plan", example: "" },
      { key: "mobile", label: "Mobile", example: "9876543210" },
      { key: "date_of_birth", label: "Date of birth", example: "1996-04-12" },
      { key: "gender", label: "Gender", hint: "MALE, FEMALE, OTHER or UNDISCLOSED", example: "FEMALE" },
      { key: "invite", label: "Invite to portal", hint: "yes or no", example: "yes" },
    ],
  },
  "leave-balances": {
    label: "Leave opening balances",
    description: "Balances carried over from the previous system. Each row is a manual adjustment on the leave ledger, so the balance stays explained.",
    permission: P.LEAVE_MANAGE,
    columns: [
      { key: "employee_number", label: "Employee number", required: true, example: "ACM0007" },
      { key: "leave_type", label: "Leave type", required: true, hint: "Name or code", example: "EL" },
      { key: "days", label: "Days", required: true, hint: "Negative to reduce", example: "6.5" },
      { key: "note", label: "Note", hint: "Defaults to “Opening balance import”", example: "Carried over from previous HRMS" },
    ],
  },
  salaries: {
    label: "Salary revisions",
    description: "CTC changes, for example after an appraisal cycle. A revision dated before the last finalised payroll raises arrears, exactly as a single revision does.",
    permission: P.SALARY_REVISE,
    columns: [
      { key: "employee_number", label: "Employee number", required: true, example: "ACM0007" },
      { key: "effective_from", label: "Effective from", required: true, example: "2026-10-01" },
      { key: "annual_ctc", label: "Annual CTC", required: true, example: "1450000" },
      { key: "reason", label: "Reason", example: "Annual appraisal 2026" },
    ],
  },
  "bank-accounts": {
    label: "Bank accounts",
    description: "Salary accounts. A primary account replaces the employee's current primary for salary payments.",
    permission: P.EMPLOYEE_MANAGE_FINANCIALS,
    columns: [
      { key: "employee_number", label: "Employee number", required: true, example: "ACM0007" },
      { key: "bank_name", label: "Bank name", required: true, example: "HDFC Bank" },
      { key: "account_number", label: "Account number", required: true, example: "50100123456789" },
      { key: "ifsc", label: "IFSC", required: true, example: "HDFC0001234" },
      { key: "branch", label: "Branch", example: "Koramangala" },
      { key: "account_holder", label: "Account holder", example: "Asha Pillai" },
      { key: "primary", label: "Primary", hint: "yes or no; defaults to yes", example: "yes" },
    ],
  },
  bonuses: {
    label: "Bonuses",
    description: "Bonuses for a payout month, for example after an appraisal cycle. Each row is scheduled as a single bonus would be, and that month's payroll run pays it.",
    permission: P.PAYROLL_RUN,
    columns: [
      { key: "employee_number", label: "Employee number", required: true, example: "ACM0007" },
      { key: "bonus_type", label: "Bonus type", required: true, hint: "Name as set up under Payroll › Bonuses", example: "Performance Bonus" },
      { key: "amount", label: "Amount", required: true, example: "50000" },
      { key: "payout_month", label: "Payout month", required: true, hint: "yyyy-mm, or any date in that month", example: "2026-11" },
      { key: "note", label: "Note", example: "FY26 appraisal" },
    ],
  },
  "job-details": {
    label: "Job details",
    description: "Promotions, transfers and manager changes in bulk. Each row is a job change on its effective date: future-dated rows are written on that day, and when the pay group has a job-change approval rule every row goes through it first.",
    permission: P.EMPLOYEE_UPDATE,
    columns: [
      { key: "employee_number", label: "Employee number", required: true, example: "ACM0007" },
      { key: "effective_from", label: "Effective from", required: true, hint: "yyyy-mm-dd or dd/mm/yyyy", example: "2026-11-01" },
      { key: "designation", label: "Designation", hint: "Job title as set up under Organisation", example: "Senior Software Engineer" },
      { key: "department", label: "Department", example: "Product Engineering" },
      { key: "location", label: "Location", example: "Bengaluru HQ" },
      { key: "reporting_manager", label: "Reporting manager", hint: "Their employee number", example: "ACM0002" },
      { key: "grade", label: "Grade", hint: "Pay grade, or band, by name", example: "" },
      { key: "reason", label: "Reason", hint: "PROMOTION, TRANSFER, DEPARTMENT_CHANGE, LOCATION_CHANGE, MANAGER_CHANGE, DEMOTION; worked out from the columns when blank", example: "PROMOTION" },
      { key: "note", label: "Note", example: "FY26 appraisal" },
    ],
  },
};

export const IMPORT_KINDS = Object.keys(IMPORTS) as ImportKind[];

/** A ready-to-fill template: the header row and one example row. */
export function templateCsv(kind: ImportKind): string {
  const cols = IMPORTS[kind].columns;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${cols.map((c) => esc(c.label)).join(",")}\n${cols.map((c) => esc(c.example)).join(",")}\n`;
}
