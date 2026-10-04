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
      P.POSITION_VIEW, P.POSITION_MANAGE, P.POSITION_APPROVE,
      P.WORKFORCE_PLAN_VIEW, P.WORKFORCE_PLAN_MANAGE, P.WORKFORCE_PLAN_APPROVE,
      P.CONTINGENT_VIEW, P.CONTINGENT_MANAGE, P.CONTINGENT_APPROVE,
      P.EMPLOYEE_VIEW, P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_CREATE, P.EMPLOYEE_UPDATE,
      P.EMPLOYEE_BULK_IMPORT, P.EMPLOYEE_VIEW_FINANCIALS, P.EMPLOYEE_INVITE,
      P.EMPLOYEE_DISABLE_LOGIN,
      P.ONBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE,
      P.EXIT_INITIATE, P.EXIT_APPROVE, P.EXIT_MANAGE, P.BGV_MANAGE,
      P.DOCUMENT_VIEW, P.DOCUMENT_MANAGE, P.DOCUMENT_VERIFY,
      P.DOCUMENT_TEMPLATE_MANAGE, P.LETTER_GENERATE,
      P.CONTRACT_VIEW, P.CONTRACT_MANAGE,
      P.HR_ACTIVITY_VIEW, P.HR_ACTIVITY_MANAGE,
      P.ANNOUNCEMENT_VIEW, P.ANNOUNCEMENT_MANAGE,
      P.AWARD_VIEW, P.AWARD_MANAGE, P.PRAISE_GIVE,
      P.TRAINING_VIEW, P.TRAINING_MANAGE, P.TRAINING_ENROL,
      P.MEETING_VIEW, P.MEETING_MANAGE, P.MEETING_ROOM_MANAGE,
      P.SKILL_VIEW, P.SKILL_MANAGE, P.PIP_MANAGE, P.CAREER_PATH_MANAGE,
      P.SUCCESSION_MANAGE, P.MOBILITY_MANAGE,
      P.SURVEY_MANAGE, P.SURVEY_RESULTS, P.WELLNESS_MANAGE, P.SERVICE_MANAGE,
      P.LEARNING_VIEW, P.COURSE_MANAGE, P.COURSE_ASSIGN,
      P.ANALYTICS_VIEW,
      P.ADVANCE_APPROVE,
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
      P.ATTRITION_RISK_VIEW,
      P.WORKFLOW_MANAGE, P.COMPLIANCE_VIEW, P.COMPLIANCE_MANAGE,
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
      P.POSITION_VIEW, P.WORKFORCE_PLAN_VIEW, P.CONTINGENT_VIEW, P.CONTINGENT_MANAGE,
      P.DOCUMENT_VIEW, P.DOCUMENT_MANAGE, P.DOCUMENT_VERIFY, P.LETTER_GENERATE,
      P.CONTRACT_VIEW,
      P.HR_ACTIVITY_VIEW, P.HR_ACTIVITY_MANAGE,
      P.ANNOUNCEMENT_VIEW, P.ANNOUNCEMENT_MANAGE,
      P.AWARD_VIEW, P.PRAISE_GIVE,
      P.TRAINING_VIEW, P.TRAINING_ENROL,
      P.LEARNING_VIEW, P.COURSE_ASSIGN,
      P.SURVEY_MANAGE, P.SERVICE_MANAGE,
      P.MEETING_VIEW, P.MEETING_MANAGE,
      P.ATTENDANCE_VIEW, P.LEAVE_VIEW,
      P.ASSET_VIEW,
      P.HELPDESK_VIEW,
      P.REPORT_VIEW, P.ANALYTICS_VIEW,
      P.COMPLIANCE_VIEW,
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
      P.WORKFORCE_PLAN_VIEW, P.CONTINGENT_VIEW,
      P.ACCOUNTING_MANAGE,
      P.ACCOUNT_VIEW, P.ACCOUNT_MANAGE,
      P.LEDGER_VIEW, P.LEDGER_POST, P.LEDGER_REVERSE,
      P.PERIOD_CLOSE, P.FINANCIAL_REPORT_VIEW,
      P.ADVANCE_APPROVE,
      P.ANNOUNCEMENT_VIEW, P.AWARD_VIEW,
      P.CONTRACT_VIEW,
      P.ATTENDANCE_VIEW, P.LEAVE_VIEW,
      P.EXPENSE_VIEW, P.EXPENSE_APPROVE,
      P.AUDIT_LOG_VIEW, P.REPORT_VIEW, P.REPORT_BUILD,
      P.ANALYTICS_VIEW,
      P.COMPLIANCE_VIEW,
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
      P.SKILL_VIEW, P.SKILL_MANAGE, P.PIP_MANAGE, P.CAREER_PATH_MANAGE,
      P.SUCCESSION_MANAGE, P.MOBILITY_MANAGE,
      P.ANNOUNCEMENT_VIEW, P.AWARD_VIEW, P.PRAISE_GIVE,
      P.TRAINING_VIEW, P.TRAINING_MANAGE, P.TRAINING_ENROL,
      P.LEARNING_VIEW, P.COURSE_MANAGE, P.COURSE_ASSIGN,
      P.SURVEY_RESULTS,
      P.MEETING_VIEW, P.MEETING_MANAGE,
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
      P.CLIENT_VIEW, P.CLIENT_MANAGE,
      P.TASK_VIEW, P.TASK_MANAGE, P.TIMESHEET_SUBMIT,
      P.RATE_CARD_MANAGE, P.INVOICE_MANAGE,
      P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE, P.RESOURCE_VIEW, P.RESOURCE_MANAGE, P.RESOURCE_REQUEST,
      P.ANNOUNCEMENT_VIEW, P.MEETING_VIEW, P.MEETING_MANAGE,
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
      P.ANNOUNCEMENT_VIEW,
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
      P.ADVANCE_APPROVE, P.LEDGER_VIEW, P.ACCOUNT_VIEW,
      P.ANNOUNCEMENT_VIEW,
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
      P.ADVANCE_APPROVE, P.ANNOUNCEMENT_VIEW,
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
      P.CANDIDATE_MANAGE, P.INTERVIEW_MANAGE, P.INTERVIEW_FEEDBACK,
      P.OFFER_MANAGE, P.CAREER_PORTAL_MANAGE,
      P.ANNOUNCEMENT_VIEW,
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
      P.ANNOUNCEMENT_VIEW, P.AWARD_VIEW, P.PRAISE_GIVE,
      P.HR_ACTIVITY_VIEW,
      P.TRAINING_VIEW, P.TRAINING_ENROL, P.COURSE_ASSIGN,
      P.MEETING_VIEW, P.MEETING_MANAGE,
      P.INTERVIEW_FEEDBACK,
      P.SKILL_VIEW,
      P.TASK_VIEW, P.TASK_MANAGE, P.TIMESHEET_APPROVE,
      P.CONTRACT_VIEW,
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
      P.ANNOUNCEMENT_VIEW, P.AWARD_VIEW, P.AWARD_MANAGE, P.PRAISE_GIVE,
      P.HR_ACTIVITY_VIEW,
      P.TRAINING_VIEW, P.TRAINING_ENROL,
      P.MEETING_VIEW, P.MEETING_MANAGE,
      P.INTERVIEW_MANAGE, P.INTERVIEW_FEEDBACK,
      P.SKILL_VIEW, P.PIP_MANAGE,
      P.TASK_VIEW, P.TASK_MANAGE, P.TIMESHEET_APPROVE,
      P.CONTRACT_VIEW,
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
      P.ANNOUNCEMENT_VIEW, P.AWARD_VIEW, P.AWARD_MANAGE, P.PRAISE_GIVE,
      P.HR_ACTIVITY_VIEW,
      P.TRAINING_VIEW, P.TRAINING_ENROL,
      P.MEETING_VIEW, P.MEETING_MANAGE,
      P.INTERVIEW_MANAGE, P.INTERVIEW_FEEDBACK,
      P.SKILL_VIEW, P.PIP_MANAGE,
      P.OFFER_APPROVE,
      P.PROJECT_VIEW, P.TASK_VIEW, P.TIMESHEET_APPROVE,
      P.CONTRACT_VIEW,
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
  // Added with the workplace modules: everyone can read announcements, see
  // the award and praise walls, praise a colleague, view their own contracts
  // and training, attend meetings, and log their own time.
  P.ANNOUNCEMENT_VIEW,
  P.AWARD_VIEW,
  P.PRAISE_GIVE,
  P.CONTRACT_VIEW,
  P.HR_ACTIVITY_VIEW,
  P.TRAINING_VIEW,
  P.LEARNING_VIEW,
  P.MEETING_VIEW,
  P.SKILL_VIEW,
  P.TASK_VIEW,
  P.TIMESHEET_SUBMIT,
];

export const SYSTEM_ROLE_BY_KEY = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));
export const IMPLICIT_ROLE_BY_KEY = new Map(IMPLICIT_ROLES.map((r) => [r.key, r]));
