import { PERMISSIONS, ALL_PERMISSIONS, type Permission } from "./permissions";

/**
 * The eleven built-in explicit roles, with the scopes documented in the
 * platform teardown. These are seeded per tenant and cannot be deleted.
 *
 * Two absences are deliberate and match the source product: there is no
 * standalone "Finance" role — finance-adjacent access runs through Payroll
 * Admin and HR Manager — and recruiter roles live inside the Hire module.
 */

export type SystemRoleKey =
  | "GLOBAL_ADMIN"
  | "HR_MANAGER"
  | "HR_EXECUTIVE"
  | "PAYROLL_ADMIN"
  | "PERFORMANCE_ADMIN"
  | "PROJECT_ADMIN"
  | "ASSET_MANAGER"
  | "EXPENSE_MANAGER"
  | "TRAVEL_DESK_MANAGER"
  | "HELP_DESK_MANAGER"
  | "REQUISITION_MANAGER";

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: Permission[];
}

const P = PERMISSIONS;

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: "GLOBAL_ADMIN",
    name: "Global Admin",
    description:
      "Complete system access including financial data and executive dashboards. Only Global Admins can create, assign or remove user roles, configure SSO, or run bulk imports.",
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "HR_MANAGER",
    name: "HR Manager",
    description: "All employee information including sensitive financial data.",
    permissions: [
      P.ORG_VIEW, P.ORG_MANAGE,
      P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_CREATE, P.EMPLOYEE_UPDATE,
      P.EMPLOYEE_BULK_IMPORT, P.EMPLOYEE_VIEW_FINANCIALS, P.EMPLOYEE_INVITE,
      P.EMPLOYEE_DISABLE_LOGIN,
      P.ONBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE,
      P.EXIT_INITIATE, P.EXIT_APPROVE, P.EXIT_MANAGE, P.BGV_MANAGE,
      P.DOCUMENT_VIEW, P.DOCUMENT_MANAGE, P.DOCUMENT_VERIFY,
      P.DOCUMENT_TEMPLATE_MANAGE, P.LETTER_GENERATE,
      P.PAYROLL_VIEW, P.PAYSLIP_VIEW_ALL, P.PAY_REGISTER_VIEW,
      P.SALARY_REVISE, P.FNF_MANAGE,
      P.ATTENDANCE_VIEW, P.ATTENDANCE_MANAGE, P.ATTENDANCE_APPROVE, P.SHIFT_MANAGE,
      P.LEAVE_VIEW, P.LEAVE_APPROVE, P.LEAVE_MANAGE, P.HOLIDAY_MANAGE,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.ASSET_VIEW, P.ASSET_ASSIGN,
      P.HELPDESK_VIEW, P.HELPDESK_MANAGE,
      P.PERFORMANCE_VIEW,
      P.REQUISITION_VIEW,
      P.AUDIT_LOG_VIEW, P.REPORT_VIEW, P.REPORT_BUILD,
    ],
  },
  {
    key: "HR_EXECUTIVE",
    name: "HR Executive",
    description: "Employee data excluding financials; onboarding and profiles.",
    permissions: [
      P.ORG_VIEW,
      P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_CREATE, P.EMPLOYEE_UPDATE,
      P.EMPLOYEE_INVITE,
      P.ONBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE, P.BGV_MANAGE,
      P.DOCUMENT_VIEW, P.DOCUMENT_MANAGE, P.DOCUMENT_VERIFY, P.LETTER_GENERATE,
      P.ATTENDANCE_VIEW, P.LEAVE_VIEW,
      P.ASSET_VIEW,
      P.HELPDESK_VIEW,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "PAYROLL_ADMIN",
    name: "Payroll Admin",
    description: "Full authority over payroll processes.",
    permissions: [
      P.ORG_VIEW,
      P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL,
      P.EMPLOYEE_VIEW_FINANCIALS, P.EMPLOYEE_MANAGE_FINANCIALS,
      P.PAYROLL_VIEW, P.PAYROLL_RUN, P.PAYROLL_LOCK, P.PAYROLL_ROLLBACK,
      P.PAYROLL_SETTINGS, P.PAYGROUP_MANAGE, P.SALARY_STRUCTURE_MANAGE,
      P.SALARY_REVISE, P.PAYSLIP_VIEW_ALL, P.PAYSLIP_RELEASE, P.PAY_REGISTER_VIEW,
      P.STATUTORY_MANAGE, P.STATUTORY_FILE, P.TAX_DECLARATION_APPROVE,
      P.FNF_MANAGE, P.FNF_APPROVE, P.LOAN_MANAGE, P.LOAN_APPROVE,
      P.ACCOUNTING_MANAGE,
      P.ATTENDANCE_VIEW, P.LEAVE_VIEW,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.AUDIT_LOG_VIEW, P.REPORT_VIEW, P.REPORT_BUILD,
    ],
  },
  {
    key: "PERFORMANCE_ADMIN",
    name: "Performance Admin",
    description: "Review cycles, feedback, goal tracking.",
    permissions: [
      P.ORG_VIEW, P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL,
      P.PERFORMANCE_VIEW, P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE,
      P.GOALS_MANAGE,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "PROJECT_ADMIN",
    name: "Project Admin",
    description: "Projects module — team assignments, tasks, expenses.",
    permissions: [
      P.ORG_VIEW, P.EMPLOYEE_VIEW,
      P.PROJECT_VIEW, P.PROJECT_MANAGE, P.TIMESHEET_APPROVE, P.BILLING_MANAGE,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "ASSET_MANAGER",
    name: "Asset Manager",
    description: "Company equipment.",
    permissions: [
      P.EMPLOYEE_VIEW,
      P.ASSET_VIEW, P.ASSET_MANAGE, P.ASSET_ASSIGN,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "EXPENSE_MANAGER",
    name: "Expense Manager",
    description: "Employee expenses and approvals.",
    permissions: [
      P.EMPLOYEE_VIEW,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE, P.EXPENSE_MANAGE,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "TRAVEL_DESK_MANAGER",
    name: "Travel Desk Manager",
    description: "Travel booking requests and approvals.",
    permissions: [
      P.EMPLOYEE_VIEW,
      P.TRAVEL_MANAGE, P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "HELP_DESK_MANAGER",
    name: "Help Desk Manager",
    description: "Helpdesk tickets and employee queries.",
    permissions: [
      P.EMPLOYEE_VIEW,
      P.HELPDESK_VIEW, P.HELPDESK_MANAGE, P.HELPDESK_SETTINGS,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "REQUISITION_MANAGER",
    name: "Requisition Manager",
    description: "Job requisitions in the recruitment module.",
    permissions: [
      P.ORG_VIEW, P.EMPLOYEE_VIEW,
      P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE,
      P.JOB_MANAGE,
      P.REPORT_VIEW,
    ],
  },
];

/**
 * Implicit roles are never granted manually — they are derived from a
 * person's position in the org tree and re-evaluated on every request.
 */
export type ImplicitRoleKey = "REPORTING_MANAGER" | "DEPARTMENT_HEAD" | "BUSINESS_HEAD";

export interface ImplicitRoleDefinition {
  key: ImplicitRoleKey;
  name: string;
  description: string;
  /** Permissions held over the people inside the derived scope only. */
  permissions: Permission[];
}

export const IMPLICIT_ROLES: ImplicitRoleDefinition[] = [
  {
    key: "REPORTING_MANAGER",
    name: "Reporting Manager",
    description: "Derived from direct reports. Approves leave and expenses, sees reports' documents.",
    permissions: [
      P.EMPLOYEE_VIEW, P.DOCUMENT_VIEW,
      P.LEAVE_VIEW, P.LEAVE_APPROVE,
      P.ATTENDANCE_VIEW, P.ATTENDANCE_APPROVE,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.PERFORMANCE_VIEW,
      P.EXIT_INITIATE,
      P.ASSET_VIEW,
    ],
  },
  {
    key: "DEPARTMENT_HEAD",
    name: "Department Head",
    description: "Derived from heading a department. Department-level request management.",
    permissions: [
      P.EMPLOYEE_VIEW, P.DOCUMENT_VIEW,
      P.LEAVE_VIEW, P.LEAVE_APPROVE,
      P.ATTENDANCE_VIEW, P.ATTENDANCE_APPROVE,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.PERFORMANCE_VIEW,
      P.EXIT_INITIATE,
      P.REQUISITION_VIEW,
      P.REPORT_VIEW,
    ],
  },
  {
    key: "BUSINESS_HEAD",
    name: "Business Head",
    description: "Derived from heading a business unit.",
    permissions: [
      P.EMPLOYEE_VIEW, P.DOCUMENT_VIEW,
      P.LEAVE_VIEW, P.LEAVE_APPROVE,
      P.ATTENDANCE_VIEW, P.ATTENDANCE_APPROVE,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.PERFORMANCE_VIEW,
      P.EXIT_INITIATE, P.EXIT_APPROVE,
      P.REQUISITION_VIEW, P.REQUISITION_APPROVE,
      P.REPORT_VIEW,
    ],
  },
];

/** Every employee holds this implicitly, over their own record only. */
export const SELF_PERMISSIONS: Permission[] = [
  P.EMPLOYEE_VIEW,
  P.DOCUMENT_VIEW,
  P.LEAVE_VIEW,
  P.ATTENDANCE_VIEW,
  P.EXPENSE_VIEW,
  P.ASSET_VIEW,
  P.HELPDESK_VIEW,
  P.PERFORMANCE_VIEW,
];

export const SYSTEM_ROLE_BY_KEY = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));
export const IMPLICIT_ROLE_BY_KEY = new Map(IMPLICIT_ROLES.map((r) => [r.key, r]));
