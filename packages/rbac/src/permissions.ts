/**
 * The permission catalogue.
 *
 * Permissions are dot-namespaced `module.object.action` strings. A custom role
 * is nothing more than a set of these; the eleven built-in roles are
 * pre-baked sets defined in ./roles.
 */

export const PERMISSIONS = {
  // --- Organisation -------------------------------------------------------
  ORG_VIEW: "org.structure.view",
  ORG_MANAGE: "org.structure.manage",
  ORG_ENTITY_MANAGE: "org.legal_entity.manage",
  ORG_SETTINGS_MANAGE: "org.settings.manage",

  // --- Employees ----------------------------------------------------------
  EMPLOYEE_VIEW: "employee.record.view",
  EMPLOYEE_VIEW_ALL: "employee.record.view_all",
  EMPLOYEE_CREATE: "employee.record.create",
  EMPLOYEE_UPDATE: "employee.record.update",
  EMPLOYEE_DELETE: "employee.record.delete",
  EMPLOYEE_BULK_IMPORT: "employee.record.bulk_import",
  /// Salary, bank details, PAN — the sensitive tab.
  EMPLOYEE_VIEW_FINANCIALS: "employee.financials.view",
  EMPLOYEE_MANAGE_FINANCIALS: "employee.financials.manage",
  EMPLOYEE_INVITE: "employee.record.invite",
  EMPLOYEE_DISABLE_LOGIN: "employee.login.disable",

  // --- Lifecycle ----------------------------------------------------------
  ONBOARDING_VIEW: "lifecycle.onboarding.view",
  ONBOARDING_MANAGE: "lifecycle.onboarding.manage",
  PROBATION_MANAGE: "lifecycle.probation.manage",
  EXIT_INITIATE: "lifecycle.exit.initiate",
  EXIT_APPROVE: "lifecycle.exit.approve",
  EXIT_MANAGE: "lifecycle.exit.manage",
  BGV_MANAGE: "lifecycle.bgv.manage",

  // --- Documents ----------------------------------------------------------
  DOCUMENT_VIEW: "document.employee.view",
  DOCUMENT_MANAGE: "document.employee.manage",
  DOCUMENT_VERIFY: "document.employee.verify",
  DOCUMENT_TEMPLATE_MANAGE: "document.template.manage",
  LETTER_GENERATE: "document.letter.generate",

  // --- Payroll ------------------------------------------------------------
  PAYROLL_VIEW: "payroll.run.view",
  PAYROLL_RUN: "payroll.run.execute",
  PAYROLL_LOCK: "payroll.run.lock",
  PAYROLL_APPROVE: "payroll.run.approve",
  PAYROLL_ROLLBACK: "payroll.run.rollback",
  PAYROLL_SETTINGS: "payroll.settings.manage",
  PAYGROUP_MANAGE: "payroll.paygroup.manage",
  SALARY_STRUCTURE_MANAGE: "payroll.structure.manage",
  SALARY_REVISE: "payroll.salary.revise",
  SALARY_REVISION_APPROVE: "payroll.salary.approve",
  PAYSLIP_VIEW_ALL: "payroll.payslip.view_all",
  PAYSLIP_RELEASE: "payroll.payslip.release",
  PAY_REGISTER_VIEW: "payroll.register.view",
  STATUTORY_MANAGE: "payroll.statutory.manage",
  STATUTORY_FILE: "payroll.statutory.file",
  TAX_DECLARATION_APPROVE: "payroll.declaration.approve",
  FNF_MANAGE: "payroll.fnf.manage",
  FNF_APPROVE: "payroll.fnf.approve",
  LOAN_MANAGE: "payroll.loan.manage",
  LOAN_APPROVE: "payroll.loan.approve",
  ACCOUNTING_MANAGE: "payroll.accounting.manage",

  // --- Time and leave -----------------------------------------------------
  ATTENDANCE_VIEW: "time.attendance.view",
  ATTENDANCE_MANAGE: "time.attendance.manage",
  ATTENDANCE_APPROVE: "time.attendance.approve",
  SHIFT_MANAGE: "time.shift.manage",
  LEAVE_VIEW: "time.leave.view",
  LEAVE_APPROVE: "time.leave.approve",
  LEAVE_MANAGE: "time.leave.manage",
  HOLIDAY_MANAGE: "time.holiday.manage",

  // --- Expenses and travel ------------------------------------------------
  EXPENSE_VIEW: "expense.claim.view",
  EXPENSE_APPROVE: "expense.claim.approve",
  EXPENSE_MANAGE: "expense.policy.manage",
  TRAVEL_MANAGE: "expense.travel.manage",

  // --- Assets -------------------------------------------------------------
  ASSET_VIEW: "asset.item.view",
  ASSET_MANAGE: "asset.item.manage",
  ASSET_ASSIGN: "asset.item.assign",

  // --- Helpdesk -----------------------------------------------------------
  HELPDESK_VIEW: "helpdesk.ticket.view",
  HELPDESK_MANAGE: "helpdesk.ticket.manage",
  HELPDESK_SETTINGS: "helpdesk.settings.manage",

  // --- Performance --------------------------------------------------------
  PERFORMANCE_VIEW: "performance.review.view",
  PERFORMANCE_MANAGE: "performance.review.manage",
  PERFORMANCE_CALIBRATE: "performance.calibration.manage",
  GOALS_MANAGE: "performance.goals.manage",

  // --- Recruitment --------------------------------------------------------
  REQUISITION_VIEW: "hire.requisition.view",
  REQUISITION_MANAGE: "hire.requisition.manage",
  REQUISITION_APPROVE: "hire.requisition.approve",
  JOB_MANAGE: "hire.job.manage",
  CANDIDATE_MANAGE: "hire.candidate.manage",

  // --- Projects (PSA) -----------------------------------------------------
  PROJECT_VIEW: "psa.project.view",
  PROJECT_MANAGE: "psa.project.manage",
  TIMESHEET_APPROVE: "psa.timesheet.approve",
  BILLING_MANAGE: "psa.billing.manage",

  // --- Platform administration -------------------------------------------
  ROLE_MANAGE: "admin.role.manage",
  AUTH_SETTINGS_MANAGE: "admin.auth.manage",
  AUDIT_LOG_VIEW: "admin.audit.view",
  REPORT_VIEW: "admin.report.view",
  REPORT_BUILD: "admin.report.build",
  API_KEY_MANAGE: "admin.apikey.manage",
  WEBHOOK_MANAGE: "admin.webhook.manage",
  BILLING_VIEW: "admin.billing.view",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Grouped for the role-builder UI. */
export const PERMISSION_GROUPS: Array<{
  module: string;
  label: string;
  permissions: Array<{ key: Permission; label: string }>;
}> = [
  {
    module: "org",
    label: "Organisation",
    permissions: [
      { key: PERMISSIONS.ORG_VIEW, label: "View org structure" },
      { key: PERMISSIONS.ORG_MANAGE, label: "Manage org structure" },
      { key: PERMISSIONS.ORG_ENTITY_MANAGE, label: "Manage legal entities" },
      { key: PERMISSIONS.ORG_SETTINGS_MANAGE, label: "Manage org settings" },
    ],
  },
  {
    module: "employee",
    label: "Employees",
    permissions: [
      { key: PERMISSIONS.EMPLOYEE_VIEW, label: "View employees in scope" },
      { key: PERMISSIONS.EMPLOYEE_VIEW_ALL, label: "View all employees" },
      { key: PERMISSIONS.EMPLOYEE_CREATE, label: "Add employees" },
      { key: PERMISSIONS.EMPLOYEE_UPDATE, label: "Edit employees" },
      { key: PERMISSIONS.EMPLOYEE_DELETE, label: "Delete employees" },
      { key: PERMISSIONS.EMPLOYEE_BULK_IMPORT, label: "Bulk import" },
      { key: PERMISSIONS.EMPLOYEE_VIEW_FINANCIALS, label: "View financial details" },
      { key: PERMISSIONS.EMPLOYEE_MANAGE_FINANCIALS, label: "Manage financial details" },
      { key: PERMISSIONS.EMPLOYEE_INVITE, label: "Invite to portal" },
      { key: PERMISSIONS.EMPLOYEE_DISABLE_LOGIN, label: "Disable login" },
    ],
  },
  {
    module: "lifecycle",
    label: "Lifecycle",
    permissions: [
      { key: PERMISSIONS.ONBOARDING_VIEW, label: "View onboarding" },
      { key: PERMISSIONS.ONBOARDING_MANAGE, label: "Manage onboarding" },
      { key: PERMISSIONS.PROBATION_MANAGE, label: "Manage probation" },
      { key: PERMISSIONS.EXIT_INITIATE, label: "Initiate exits" },
      { key: PERMISSIONS.EXIT_APPROVE, label: "Approve exits" },
      { key: PERMISSIONS.EXIT_MANAGE, label: "Manage exits" },
      { key: PERMISSIONS.BGV_MANAGE, label: "Manage background verification" },
    ],
  },
  {
    module: "document",
    label: "Documents",
    permissions: [
      { key: PERMISSIONS.DOCUMENT_VIEW, label: "View documents" },
      { key: PERMISSIONS.DOCUMENT_MANAGE, label: "Manage documents" },
      { key: PERMISSIONS.DOCUMENT_VERIFY, label: "Verify documents" },
      { key: PERMISSIONS.DOCUMENT_TEMPLATE_MANAGE, label: "Manage templates" },
      { key: PERMISSIONS.LETTER_GENERATE, label: "Generate letters" },
    ],
  },
  {
    module: "payroll",
    label: "Payroll",
    permissions: [
      { key: PERMISSIONS.PAYROLL_VIEW, label: "View payroll" },
      { key: PERMISSIONS.PAYROLL_RUN, label: "Run payroll" },
      { key: PERMISSIONS.PAYROLL_LOCK, label: "Lock payroll" },
      { key: PERMISSIONS.PAYROLL_APPROVE, label: "Approve payroll" },
      { key: PERMISSIONS.PAYROLL_ROLLBACK, label: "Roll back payroll" },
      { key: PERMISSIONS.PAYROLL_SETTINGS, label: "Manage payroll settings" },
      { key: PERMISSIONS.PAYGROUP_MANAGE, label: "Manage pay groups" },
      { key: PERMISSIONS.SALARY_STRUCTURE_MANAGE, label: "Manage salary structures" },
      { key: PERMISSIONS.SALARY_REVISE, label: "Revise salaries" },
      { key: PERMISSIONS.SALARY_REVISION_APPROVE, label: "Approve salary revisions" },
      { key: PERMISSIONS.PAYSLIP_VIEW_ALL, label: "View all payslips" },
      { key: PERMISSIONS.PAYSLIP_RELEASE, label: "Release payslips" },
      { key: PERMISSIONS.PAY_REGISTER_VIEW, label: "View pay register" },
      { key: PERMISSIONS.STATUTORY_MANAGE, label: "Manage statutory settings" },
      { key: PERMISSIONS.STATUTORY_FILE, label: "File statutory returns" },
      { key: PERMISSIONS.TAX_DECLARATION_APPROVE, label: "Approve tax declarations" },
      { key: PERMISSIONS.FNF_MANAGE, label: "Manage full & final" },
      { key: PERMISSIONS.FNF_APPROVE, label: "Approve settlements" },
      { key: PERMISSIONS.LOAN_MANAGE, label: "Manage loans" },
      { key: PERMISSIONS.LOAN_APPROVE, label: "Approve loans" },
      { key: PERMISSIONS.ACCOUNTING_MANAGE, label: "Manage accounting export" },
    ],
  },
  {
    module: "time",
    label: "Time & leave",
    permissions: [
      { key: PERMISSIONS.ATTENDANCE_VIEW, label: "View attendance" },
      { key: PERMISSIONS.ATTENDANCE_MANAGE, label: "Manage attendance" },
      { key: PERMISSIONS.ATTENDANCE_APPROVE, label: "Approve regularisations" },
      { key: PERMISSIONS.SHIFT_MANAGE, label: "Manage shifts" },
      { key: PERMISSIONS.LEAVE_VIEW, label: "View leave" },
      { key: PERMISSIONS.LEAVE_APPROVE, label: "Approve leave" },
      { key: PERMISSIONS.LEAVE_MANAGE, label: "Manage leave policies" },
      { key: PERMISSIONS.HOLIDAY_MANAGE, label: "Manage holidays" },
    ],
  },
  {
    module: "expense",
    label: "Expenses & travel",
    permissions: [
      { key: PERMISSIONS.EXPENSE_VIEW, label: "View expenses" },
      { key: PERMISSIONS.EXPENSE_APPROVE, label: "Approve expenses" },
      { key: PERMISSIONS.EXPENSE_MANAGE, label: "Manage expense policies" },
      { key: PERMISSIONS.TRAVEL_MANAGE, label: "Manage travel desk" },
    ],
  },
  {
    module: "asset",
    label: "Assets",
    permissions: [
      { key: PERMISSIONS.ASSET_VIEW, label: "View assets" },
      { key: PERMISSIONS.ASSET_MANAGE, label: "Manage assets" },
      { key: PERMISSIONS.ASSET_ASSIGN, label: "Assign assets" },
    ],
  },
  {
    module: "helpdesk",
    label: "Helpdesk",
    permissions: [
      { key: PERMISSIONS.HELPDESK_VIEW, label: "View tickets" },
      { key: PERMISSIONS.HELPDESK_MANAGE, label: "Manage tickets" },
      { key: PERMISSIONS.HELPDESK_SETTINGS, label: "Manage helpdesk settings" },
    ],
  },
  {
    module: "performance",
    label: "Performance",
    permissions: [
      { key: PERMISSIONS.PERFORMANCE_VIEW, label: "View reviews" },
      { key: PERMISSIONS.PERFORMANCE_MANAGE, label: "Manage review cycles" },
      { key: PERMISSIONS.PERFORMANCE_CALIBRATE, label: "Calibrate ratings" },
      { key: PERMISSIONS.GOALS_MANAGE, label: "Manage goals & OKRs" },
    ],
  },
  {
    module: "hire",
    label: "Recruitment",
    permissions: [
      { key: PERMISSIONS.REQUISITION_VIEW, label: "View requisitions" },
      { key: PERMISSIONS.REQUISITION_MANAGE, label: "Manage requisitions" },
      { key: PERMISSIONS.REQUISITION_APPROVE, label: "Approve requisitions" },
      { key: PERMISSIONS.JOB_MANAGE, label: "Manage jobs" },
      { key: PERMISSIONS.CANDIDATE_MANAGE, label: "Manage candidates" },
    ],
  },
  {
    module: "psa",
    label: "Projects",
    permissions: [
      { key: PERMISSIONS.PROJECT_VIEW, label: "View projects" },
      { key: PERMISSIONS.PROJECT_MANAGE, label: "Manage projects" },
      { key: PERMISSIONS.TIMESHEET_APPROVE, label: "Approve timesheets" },
      { key: PERMISSIONS.BILLING_MANAGE, label: "Manage billing" },
    ],
  },
  {
    module: "admin",
    label: "Administration",
    permissions: [
      { key: PERMISSIONS.ROLE_MANAGE, label: "Manage roles & permissions" },
      { key: PERMISSIONS.AUTH_SETTINGS_MANAGE, label: "Manage authentication" },
      { key: PERMISSIONS.AUDIT_LOG_VIEW, label: "View audit logs" },
      { key: PERMISSIONS.REPORT_VIEW, label: "View reports" },
      { key: PERMISSIONS.REPORT_BUILD, label: "Build custom reports" },
      { key: PERMISSIONS.API_KEY_MANAGE, label: "Manage API keys" },
      { key: PERMISSIONS.WEBHOOK_MANAGE, label: "Manage webhooks" },
      { key: PERMISSIONS.BILLING_VIEW, label: "View billing" },
    ],
  },
];
