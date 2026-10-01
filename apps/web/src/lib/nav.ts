import "server-only";
import { PERMISSIONS } from "@keka/rbac";
import { can, canAny, type Viewer } from "./context";

/**
 * The navigation, shaped like Keka: a rail of sections (Home, Me, Inbox, My
 * Team, My Finances, Org, Engage, then the admin workspaces a viewer's roles
 * open), each with a row of tabs. It is assembled from permissions, so a
 * viewer never sees a link they cannot follow.
 *
 * Every route belongs to exactly one section for a given viewer: the active
 * rail item and tab are the ones whose path is the longest prefix of the URL.
 * A route an admin reaches from a workspace (say /helpdesk) belongs to that
 * workspace; for everyone else the same route is one of their own apps.
 */

const P = PERMISSIONS;

export interface NavTab {
  label: string;
  href: string;
  /** Path prefixes that light this tab up; defaults to the href's path. */
  paths?: string[];
  count?: number;
}

export interface NavSection {
  key: string;
  label: string;
  icon: string;
  href: string;
  tabs: NavTab[];
  count?: number;
  /** Admin workspaces sit below a divider on the rail. */
  admin?: boolean;
}

export interface NavCounts {
  approvals: number;
  leave: number;
  attendance: number;
  exits: number;
  runs: number;
  documents: number;
  acks: number;
  sheets: number;
  notifications: number;
  surveys: number;
  learning: number;
  /** Probations past their end or in review, waiting on HR. */
  probation: number;
}

const path = (href: string) => href.split("?")[0];

export function buildNav(viewer: Viewer, counts: NavCounts, opts: { hasExit: boolean; managesProject: boolean }): NavSection[] {
  const sections: NavSection[] = [];
  const me = !!viewer.employee;
  const isManager = viewer.allReportIds.size > 0;
  const tabs = (list: Array<NavTab | false | null | undefined>) => list.filter((t): t is NavTab => !!t);

  sections.push({
    key: "home", label: "Home", icon: "home", href: "/",
    tabs: tabs([{ label: "Dashboard", href: "/", paths: ["/"] }, me && { label: "Welcome", href: "/home/welcome" }]),
  });

  if (me) {
    sections.push({
      key: "me", label: "Me", icon: "user", href: "/me/attendance",
      tabs: [
        { label: "Attendance", href: "/me/attendance" },
        { label: "Leave", href: "/me/leave" },
        { label: "Performance", href: "/me/performance" },
        { label: "Skills & Career", href: "/me/career" },
        { label: "Expenses & Travel", href: "/me/expenses" },
        { label: "Apps", href: "/me/apps", paths: ["/me/apps", "/me/loans", "/me/exit"] },
      ],
    });
  }

  sections.push({
    key: "inbox", label: "Inbox", icon: "inbox", href: "/inbox", count: counts.approvals,
    tabs: [
      { label: "Take Action", href: "/inbox", paths: ["/inbox"], count: counts.approvals },
      { label: "Notifications", href: "/inbox/notifications", paths: ["/inbox/notifications", "/notifications"], count: counts.notifications },
      { label: "Archive", href: "/inbox/archive" },
    ],
  });

  // A manager decides their team's leave and attendance from My Team; HR
  // administrators have the same pages, with their settings, under People.
  const hrLeave = canAny(viewer, [P.LEAVE_MANAGE, P.HOLIDAY_MANAGE]);
  const hrAttendance = canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE]);
  if (me) {
    sections.push({
      key: "team", label: "My Team", icon: "team", href: "/team",
      tabs: tabs([
        { label: "Summary", href: "/team" },
        isManager && !hrLeave && can(viewer, P.LEAVE_APPROVE) && { label: "Leave", href: "/leave", count: counts.leave },
        isManager && !hrAttendance && can(viewer, P.ATTENDANCE_APPROVE) && { label: "Attendance", href: "/attendance", count: counts.attendance },
      ]),
    });
    sections.push({
      key: "finances", label: "My Finances", icon: "finance", href: "/finances",
      tabs: [
        { label: "Summary", href: "/finances", paths: ["/finances"] },
        { label: "My Pay", href: "/finances/pay", paths: ["/finances/pay", "/me/pay"] },
        { label: "Manage Tax", href: "/finances/tax", paths: ["/finances/tax", "/me/tax"] },
      ],
    });
  }

  sections.push({
    key: "org", label: "Org", icon: "org", href: "/directory",
    tabs: tabs([
      { label: "Employees", href: "/directory" },
      can(viewer, P.DOCUMENT_VIEW) && { label: "Documents", href: "/documents", count: counts.documents },
    ]),
  });

  const engage = tabs([
    can(viewer, P.ANNOUNCEMENT_VIEW) && { label: "Announcements", href: "/announcements", count: counts.acks },
    can(viewer, P.AWARD_VIEW) && { label: "Praise & Awards", href: "/awards" },
    (me || canAny(viewer, [P.SURVEY_MANAGE, P.SURVEY_RESULTS])) && { label: "Surveys & Polls", href: "/engage/surveys", count: counts.surveys },
    can(viewer, P.TRAINING_VIEW) && { label: "Training", href: "/training" },
    can(viewer, P.MEETING_VIEW) && { label: "Meetings", href: "/meetings" },
  ]);
  if (engage.length) sections.push({ key: "engage", label: "Engage", icon: "engage", href: engage[0].href, tabs: engage });

  if (can(viewer, P.LEARNING_VIEW)) {
    sections.push({ key: "learn", label: "Learn", icon: "learn", href: "/learn", count: counts.learning, tabs: [{ label: "Learning", href: "/learn", count: counts.learning }] });
  }

  // ---- Admin workspaces ----------------------------------------------------
  const people = tabs([
    canAny(viewer, [P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_CREATE, P.EMPLOYEE_UPDATE]) && { label: "Employees", href: "/employees" },
    can(viewer, P.ORG_MANAGE) && { label: "Organisation", href: "/org" },
    can(viewer, P.ONBOARDING_VIEW) && { label: "Journeys", href: "/onboarding" },
    can(viewer, P.PROBATION_MANAGE) && { label: "Probation", href: "/probation", count: counts.probation },
    canAny(viewer, [P.EXIT_MANAGE, P.EXIT_APPROVE, P.FNF_MANAGE]) && { label: "Exits", href: "/exits", count: counts.exits },
    hrLeave && { label: "Leave", href: "/leave", count: counts.leave },
    hrAttendance && { label: "Attendance", href: "/attendance", count: counts.attendance },
    can(viewer, P.HR_ACTIVITY_MANAGE) && { label: "HR Activities", href: "/activities" },
    canAny(viewer, [P.ASSET_MANAGE, P.ASSET_ASSIGN]) && { label: "Assets", href: "/assets" },
    can(viewer, P.HELPDESK_MANAGE) && { label: "Helpdesk", href: "/helpdesk" },
    can(viewer, P.REPORT_VIEW) && canAny(viewer, [P.EMPLOYEE_VIEW_ALL, P.PAYROLL_VIEW, P.LEAVE_MANAGE]) && { label: "Reports", href: "/reports" },
  ]);
  if (people.length) sections.push({ key: "people", label: "People", icon: "people", href: people[0].href, tabs: people, admin: true });

  // Interviewers give feedback from their apps; the workspace is for those who run hiring.
  if (canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.JOB_MANAGE, P.CANDIDATE_MANAGE, P.INTERVIEW_MANAGE])) {
    sections.push({ key: "hire", label: "Hire", icon: "hire", href: "/hiring", tabs: [{ label: "Recruitment", href: "/hiring" }], admin: true });
  }

  if (isManager || canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.GOALS_MANAGE, P.PIP_MANAGE, P.CAREER_PATH_MANAGE, P.SKILL_MANAGE])) {
    sections.push({
      key: "performance", label: "Performance", icon: "performance", href: "/performance", admin: true,
      tabs: tabs([
        { label: "Goals & Reviews", href: "/performance" },
        (isManager || canAny(viewer, [P.CAREER_PATH_MANAGE, P.SKILL_MANAGE])) && { label: "Skills & Career Paths", href: "/performance/careers" },
      ]),
    });
  }

  if (can(viewer, P.ANALYTICS_VIEW)) {
    sections.push({ key: "analytics", label: "Analytics", icon: "analytics", href: "/analytics", tabs: [{ label: "Workforce Insights", href: "/analytics" }], admin: true });
  }

  // Line managers approve timesheets from the inbox; the workspace is for project people.
  if (opts.managesProject || canAny(viewer, [P.PROJECT_VIEW, P.PROJECT_MANAGE, P.INVOICE_MANAGE])) {
    sections.push({ key: "projects", label: "Projects", icon: "projects", href: "/projects", tabs: [{ label: "Projects & Time", href: "/projects", count: counts.sheets }], admin: true });
  }

  const payroll = tabs([
    can(viewer, P.PAYROLL_VIEW) && { label: "Run Payroll", href: "/payroll/runs", paths: ["/payroll/runs", "/payroll/payslips"], count: counts.runs },
    can(viewer, P.PAY_REGISTER_VIEW) && { label: "Pay Register", href: "/payroll/register" },
    can(viewer, P.PAYGROUP_MANAGE) && { label: "Pay Groups", href: "/payroll/pay-groups" },
    can(viewer, P.SALARY_STRUCTURE_MANAGE) && { label: "Salary Structures", href: "/payroll/structures" },
    can(viewer, P.STATUTORY_MANAGE) && { label: "Statutory", href: "/payroll/statutory" },
    can(viewer, P.STATUTORY_MANAGE) && { label: "Filings", href: "/payroll/filings" },
    can(viewer, P.LOAN_MANAGE) && { label: "Loans", href: "/payroll/loans" },
  ]);
  if (payroll.length) sections.push({ key: "payroll", label: "Payroll", icon: "payroll", href: payroll[0].href, tabs: payroll, admin: true });

  const finance = tabs([
    can(viewer, P.LEDGER_VIEW) && { label: "Accounting", href: "/accounting" },
    canAny(viewer, [P.EXPENSE_MANAGE, P.TRAVEL_MANAGE, P.ADVANCE_APPROVE]) && { label: "Expenses & Travel", href: "/expenses" },
  ]);
  if (finance.length) sections.push({ key: "finance", label: "Finance", icon: "ledger", href: finance[0].href, tabs: finance, admin: true });

  const admin = tabs([
    can(viewer, P.ORG_SETTINGS_MANAGE) && { label: "Settings", href: "/admin/settings" },
    can(viewer, P.ROLE_MANAGE) && { label: "Roles & Permissions", href: "/admin/roles" },
    can(viewer, P.AUDIT_LOG_VIEW) && { label: "Audit Logs", href: "/admin/audit" },
  ]);
  if (admin.length) sections.push({ key: "admin", label: "Admin", icon: "settings", href: admin[0].href, tabs: admin, admin: true });

  // Routes an employee reaches as one of their own apps, unless an admin
  // workspace above already owns them for this viewer.
  const owned = new Set(sections.flatMap((s) => s.tabs.flatMap((t) => t.paths ?? [path(t.href)])));
  const meSection = sections.find((s) => s.key === "me");
  if (meSection) {
    const apps = meSection.tabs.find((t) => t.href === "/me/apps")!;
    for (const p of ["/helpdesk", "/projects", "/assets", "/hiring", "/onboarding"]) if (!owned.has(p)) apps.paths!.push(p);
    const expenses = meSection.tabs.find((t) => t.href === "/me/expenses")!;
    if (!owned.has("/expenses")) expenses.paths = ["/me/expenses", "/expenses"];
    const perf = meSection.tabs.find((t) => t.href === "/me/performance")!;
    if (!owned.has("/performance")) perf.paths = ["/me/performance", "/performance"];
    if (opts.hasExit) apps.paths!.push("/me/exit");
  }
  const teamSection = sections.find((s) => s.key === "team");
  if (teamSection && !owned.has("/employees")) teamSection.tabs[0].paths = ["/team", "/employees"];
  return sections;
}

/** The quick actions offered by ⌘K, filtered to what this viewer can do. */
export function quickActions(viewer: Viewer): Array<{ label: string; href: string; keywords: string }> {
  const me = !!viewer.employee;
  const list: Array<{ label: string; href: string; keywords: string } | false> = [
    me && { label: "Apply leave", href: "/me/leave?apply=1", keywords: "leave request time off vacation sick" },
    me && { label: "Clock in / out", href: "/me/attendance", keywords: "attendance punch web clock" },
    me && { label: "Request work from home", href: "/me/attendance?request=WFH", keywords: "wfh remote on duty" },
    me && { label: "View my payslips", href: "/finances/pay/payslips", keywords: "salary payslip pay slip" },
    me && { label: "Declare investments", href: "/finances/tax", keywords: "tax declaration 80c regime" },
    me && { label: "Add an expense", href: "/me/expenses?new=1", keywords: "claim reimbursement expense" },
    me && { label: "Log time", href: "/projects?tab=time", keywords: "timesheet hours project" },
    me && { label: "Raise a helpdesk ticket", href: "/helpdesk", keywords: "help support ticket hr question" },
    me && { label: "Give praise", href: "/awards", keywords: "praise kudos appreciation" },
    { label: "Employee directory", href: "/directory", keywords: "people colleagues search" },
    { label: "Organisation tree", href: "/directory/tree", keywords: "org chart hierarchy reporting" },
    can(viewer, P.PAYROLL_VIEW) && { label: "Run payroll", href: "/payroll/runs", keywords: "payroll process month" },
    can(viewer, P.EMPLOYEE_CREATE) && { label: "Add an employee", href: "/employees/new", keywords: "hire onboard new joinee" },
    can(viewer, P.LEDGER_VIEW) && { label: "Accounting", href: "/accounting", keywords: "ledger books journal trial balance" },
    can(viewer, P.REPORT_VIEW) && { label: "Reports", href: "/reports", keywords: "analytics headcount attrition" },
    can(viewer, P.ANALYTICS_VIEW) && { label: "Workforce analytics", href: "/analytics", keywords: "dashboard headcount attrition diversity cost insights" },
    me && { label: "Take a survey", href: "/engage/surveys", keywords: "survey poll pulse feedback enps" },
    me && { label: "My learning", href: "/learn", keywords: "course training lms learn quiz" },
    me && { label: "Claim comp-off", href: "/me/leave?compoff=1", keywords: "comp off compensatory weekend holiday worked" },
    me && { label: "Encash leave", href: "/me/leave?encash=1", keywords: "encash encashment sell leave" },
  ];
  return list.filter((x): x is { label: string; href: string; keywords: string } => !!x);
}
