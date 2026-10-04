import "server-only";
import { PERMISSIONS } from "@keka/rbac";
import { can, canAny, type Viewer } from "./context";

/**
 * The navigation, shaped like Keka: a rail of sections — Home, Me, Inbox, My
 * Team, My Finances, Org, Engage, Learn, then the modules a viewer's roles
 * open (Hire, Performance, Project, Time Attend, Payroll) — each with a row
 * of tabs. Org doubles as the administrator's hub, as it does in Keka: the
 * people dashboard, employees, structure, onboarding, exits, expenses,
 * documents, assets, helpdesk and settings. It is assembled from
 * permissions, so a viewer never sees a link they cannot follow.
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
  /** A small red dot: something here wants attention but has no number. */
  dot?: boolean;
}

export interface NavSection {
  key: string;
  label: string;
  icon: string;
  href: string;
  tabs: NavTab[];
  count?: number;
  /** A module workspace (Hire, Payroll…) rather than one of the viewer's own sections. */
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
  /** Survey invitations this viewer hasn't answered. */
  surveys?: number;
  /** Courses assigned to this viewer and not finished. */
  learning?: number;
  /** Probations past their end or in review, waiting on HR. */
  probation?: number;
  /** Asset requests and acknowledgements this viewer can act on. */
  assets?: number;
  /** Requisitions waiting for this viewer's decision. */
  requisitions?: number;
  /** Resource and project requests waiting for this viewer. */
  projectRequests?: number;
  /** Time requests (leave, attendance, overtime, comp off…) an HR administrator can decide. */
  time?: number;
  /** Open helpdesk tickets in this agent's queue. */
  tickets?: number;
}

export interface NavOptions {
  hasExit: boolean;
  managesProject: boolean;
  /** Heads and agents of a helpdesk category work tickets without HELPDESK_MANAGE. */
  isHelpdeskAgent?: boolean;
  /** Storyboards someone has shared with this viewer. */
  sharedBoards?: number;
  /** The Welcome page still has something for the viewer to fill in. */
  welcomeDot?: boolean;
}

const path = (href: string) => href.split("?")[0];

export function buildNav(viewer: Viewer, counts: NavCounts, opts: NavOptions): NavSection[] {
  const sections: NavSection[] = [];
  const me = !!viewer.employee;
  const isManager = viewer.allReportIds.size > 0;
  const tabs = (list: Array<NavTab | false | null | undefined>) => list.filter((t): t is NavTab => !!t);
  /** Is this module switched on for the viewer's company? (The platform admin decides.) */
  const on = (module: string) => !viewer.tenant.disabledModules.includes(module);

  // ---- Home ------------------------------------------------------------------
  sections.push({
    key: "home", label: "Home", icon: "home", href: "/",
    tabs: tabs([
      { label: "Dashboard", href: "/", paths: ["/"] },
      me && { label: "Welcome", href: "/home/welcome", dot: opts.welcomeDot },
      on("analytics") && (can(viewer, P.ANALYTICS_VIEW) || (opts.sharedBoards ?? 0) > 0) && { label: "Storyboard", href: "/storyboards" },
    ]),
  });

  // ---- Me --------------------------------------------------------------------
  if (me) {
    sections.push({
      key: "me", label: "Me", icon: "user", href: "/me/attendance",
      tabs: tabs([
        { label: "Attendance", href: "/me/attendance" },
        { label: "Leave", href: "/me/leave" },
        { label: "Work Log", href: "/me/work-log" },
        on("performance") && { label: "Performance", href: "/me/performance", paths: ["/me/performance", "/me/career"] },
        on("expenses") && { label: "Expenses & Travel", href: "/me/expenses" },
        on("helpdesk") && { label: "Helpdesk", href: "/me/helpdesk" },
        { label: "Apps", href: "/me/apps", paths: ["/me/apps", "/me/assets"] },
      ]),
    });
  }

  // ---- Inbox -----------------------------------------------------------------
  sections.push({
    key: "inbox", label: "Inbox", icon: "inbox", href: "/inbox", count: counts.approvals,
    tabs: [
      { label: "Take Action", href: "/inbox", paths: ["/inbox"], count: counts.approvals },
      { label: "Notifications", href: "/inbox/notifications", paths: ["/inbox/notifications", "/notifications"], count: counts.notifications },
      { label: "Archive", href: "/inbox/archive" },
    ],
  });

  // ---- My Team and My Finances -------------------------------------------------
  // A manager decides their team's leave and attendance here; HR
  // administrators decide everyone's under Time Attend.
  const hrLeave = canAny(viewer, [P.LEAVE_MANAGE, P.HOLIDAY_MANAGE]);
  const hrAttendance = canAny(viewer, [P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE]);
  if (me) {
    sections.push({
      key: "team", label: "My Team", icon: "team", href: "/team",
      tabs: tabs([
        { label: "Summary", href: "/team", paths: ["/team"] },
        isManager && can(viewer, P.LEAVE_APPROVE) && { label: "Leave", href: "/team/leave", count: counts.leave },
        isManager && can(viewer, P.ATTENDANCE_APPROVE) && { label: "Attendance", href: "/team/attendance", count: counts.attendance },
      ]),
    });
    if (on("payroll")) sections.push({
      key: "finances", label: "My Finances", icon: "finance", href: "/finances",
      tabs: [
        { label: "Summary", href: "/finances", paths: ["/finances"] },
        { label: "My Pay", href: "/finances/pay", paths: ["/finances/pay", "/me/pay"] },
        { label: "Manage Tax", href: "/finances/tax", paths: ["/finances/tax", "/me/tax"] },
        { label: "Loans", href: "/finances/loans", paths: ["/finances/loans", "/me/loans"] },
      ],
    });
  }

  // ---- Org: the directory for everyone, the people hub for administrators ----
  const orgAdmin = canAny(viewer, [P.EMPLOYEE_VIEW_ALL, P.EMPLOYEE_CREATE, P.EMPLOYEE_UPDATE]);
  const dashboardPaths = [
    can(viewer, P.ANALYTICS_VIEW) && "/analytics",
    can(viewer, P.REPORT_VIEW) && "/reports",
    can(viewer, P.AUDIT_LOG_VIEW) && "/admin/audit",
  ].filter((p): p is string => !!p);
  const settingsHref = settingsLink(viewer);
  sections.push({
    key: "org", label: "Org", icon: "org", href: orgAdmin && dashboardPaths.length ? dashboardPaths[0] : "/directory",
    tabs: tabs([
      dashboardPaths.length > 0 && { label: "Dashboard", href: dashboardPaths[0], paths: dashboardPaths },
      orgAdmin
        ? { label: "Employees", href: "/employees", paths: ["/employees", "/directory"] }
        : { label: "Employees", href: "/directory" },
      can(viewer, P.ORG_MANAGE) && { label: "Org Structure", href: "/org" },
      can(viewer, P.ONBOARDING_VIEW) && { label: "Onboarding", href: "/onboarding" },
      can(viewer, P.PROBATION_MANAGE) && { label: "Probation", href: "/probation", count: counts.probation },
      canAny(viewer, [P.EXIT_MANAGE, P.EXIT_APPROVE, P.FNF_MANAGE]) && { label: "Exits", href: "/exits", count: counts.exits },
      can(viewer, P.HR_ACTIVITY_MANAGE) && { label: "HR Activities", href: "/activities" },
      canAny(viewer, [P.EXPENSE_MANAGE, P.TRAVEL_MANAGE, P.ADVANCE_APPROVE]) && { label: "Expenses & Travel", href: "/expenses" },
      can(viewer, P.DOCUMENT_VIEW) && { label: "Documents", href: "/documents", count: counts.documents },
      canAny(viewer, [P.ASSET_MANAGE, P.ASSET_ASSIGN]) && { label: "Assets", href: "/assets", count: counts.assets },
      on("helpdesk") && (can(viewer, P.HELPDESK_MANAGE) || opts.isHelpdeskAgent) && { label: "Helpdesk", href: "/helpdesk", count: counts.tickets },
      !!settingsHref && { label: "Settings", href: settingsHref, paths: ["/admin"] },
    ]),
  });

  // ---- Engage and Learn ---------------------------------------------------------
  const engage = tabs([
    can(viewer, P.ANNOUNCEMENT_VIEW) && { label: "Announcements", href: "/announcements", count: counts.acks },
    (me || can(viewer, P.ANNOUNCEMENT_VIEW)) && { label: "Wall", href: "/wall" },
    can(viewer, P.AWARD_VIEW) && { label: "Praise & Awards", href: "/awards" },
    (me || canAny(viewer, [P.SURVEY_MANAGE, P.SURVEY_RESULTS])) && { label: "Surveys & Polls", href: "/engage/surveys", count: counts.surveys },
    can(viewer, P.MEETING_VIEW) && { label: "Meetings", href: "/meetings" },
  ]);
  if (engage.length && on("engage")) sections.push({ key: "engage", label: "Engage", icon: "engage", href: engage[0].href, tabs: engage });

  const learn = tabs([
    (me || can(viewer, P.LEARNING_VIEW)) && { label: "My Courses", href: "/learn/my-courses", paths: ["/learn/my-courses", "/learn/courses", "/learn"], count: counts.learning },
    (me || can(viewer, P.LEARNING_VIEW)) && { label: "Course Library", href: "/learn/library" },
    canAny(viewer, [P.TRAINING_MANAGE, P.COURSE_MANAGE]) && { label: "Manage Courses", href: "/learn/manage-courses" },
    can(viewer, P.TRAINING_VIEW) && { label: "Programmes", href: "/training" },
  ]);
  if (learn.length && on("learn")) sections.push({ key: "learn", label: "Learn", icon: "learn", href: learn[0].href, tabs: learn });

  // ---- Modules ------------------------------------------------------------------
  // Interviewers give feedback from their apps; the workspace is for those who run hiring.
  if (canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE, P.JOB_MANAGE, P.CANDIDATE_MANAGE, P.INTERVIEW_MANAGE])) {
    const hire = tabs([
      canAny(viewer, [P.REQUISITION_VIEW, P.REQUISITION_MANAGE, P.REQUISITION_APPROVE]) && { label: "Requisitions", href: "/hiring/requisitions", count: counts.requisitions },
      canAny(viewer, [P.JOB_MANAGE, P.CANDIDATE_MANAGE]) && { label: "Jobs", href: "/hiring/jobs", paths: ["/hiring/jobs", "/hiring/applications", "/hiring"] },
      me && { label: "Interviews", href: "/hiring/interviews" },
      can(viewer, P.OFFER_MANAGE) && { label: "Offers", href: "/hiring/offers" },
      me && { label: "Refer & Apply", href: "/hiring/refer" },
      can(viewer, P.JOB_MANAGE) && { label: "Settings", href: "/hiring/settings" },
    ]);
    if (hire.length) sections.push({ key: "hire", label: "Hire", icon: "hire", href: hire[0].href, tabs: hire, admin: true });
  }

  if (on("performance") && (isManager || canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.GOALS_MANAGE, P.PIP_MANAGE, P.CAREER_PATH_MANAGE, P.SKILL_MANAGE]))) {
    sections.push({
      key: "performance", label: "Performance", icon: "performance", href: "/performance/goals", admin: true,
      tabs: tabs([
        { label: "Goals", href: "/performance/goals", paths: ["/performance/goals", "/performance"] },
        { label: "1:1 Meetings", href: "/performance/one-on-ones" },
        { label: "Reviews", href: "/performance/reviews", paths: ["/performance/reviews", "/performance/cycles"] },
        canAny(viewer, [P.PIP_MANAGE, P.PERFORMANCE_MANAGE]) || isManager ? { label: "Improvement Plans", href: "/performance/plans" } : false,
        (isManager || canAny(viewer, [P.CAREER_PATH_MANAGE, P.SKILL_MANAGE])) && { label: "Skills & Career Paths", href: "/performance/careers" },
      ]),
    });
  }

  // Line managers approve timesheets from the inbox; the workspace is for project people.
  if (on("projects") && (opts.managesProject || canAny(viewer, [P.PROJECT_VIEW, P.PROJECT_MANAGE, P.INVOICE_MANAGE, P.OPPORTUNITY_VIEW, P.RESOURCE_VIEW]))) {
    const hub = canAny(viewer, [P.PROJECT_VIEW, P.PROJECT_MANAGE]);
    const project = tabs([
      hub && { label: "Dashboard", href: "/projects/dashboard" },
      canAny(viewer, [P.CLIENT_VIEW, P.CLIENT_MANAGE]) && { label: "Clients", href: "/projects/clients" },
      // "/projects" claims /projects/[id] for the people who run projects.
      { label: "Projects", href: "/projects/list", paths: ["/projects/list", "/projects"] },
      can(viewer, P.OPPORTUNITY_VIEW) && { label: "Opportunities", href: "/projects/opportunities" },
      canAny(viewer, [P.INVOICE_MANAGE, P.BILLING_MANAGE, P.RATE_CARD_MANAGE]) && { label: "Finances", href: "/projects/finances" },
      (opts.managesProject || can(viewer, P.RESOURCE_VIEW)) && { label: "Resources", href: "/projects/resources" },
      (opts.managesProject || canAny(viewer, [P.TIMESHEET_APPROVE, P.PROJECT_MANAGE])) && { label: "Approvals", href: "/projects/approvals", count: counts.sheets + (counts.projectRequests ?? 0) },
      can(viewer, P.PROJECT_MANAGE) && { label: "Policies & Settings", href: "/projects/settings" },
      can(viewer, P.PROJECT_MANAGE) && { label: "Bulk Import", href: "/projects/import" },
      hub && can(viewer, P.REPORT_VIEW) && { label: "Analytics", href: "/projects/analytics" },
    ]);
    sections.push({ key: "projects", label: "Project", icon: "projects", href: project[0].href, tabs: project, admin: true });
  }

  if (hrLeave || hrAttendance) {
    sections.push({
      key: "time", label: "Time Attend", icon: "time", href: "/time", admin: true,
      tabs: tabs([
        { label: "Dashboard", href: "/time", paths: ["/time"] },
        { label: "Approvals", href: "/time/approvals", count: counts.time },
        hrLeave && { label: "Leave", href: "/time/leave", paths: ["/time/leave", "/leave"] },
        hrAttendance && { label: "Attendance", href: "/time/attendance", paths: ["/time/attendance", "/attendance"] },
        canAny(viewer, [P.SHIFT_MANAGE, P.HOLIDAY_MANAGE]) && { label: "Shift / Weekly Offs & Holidays", href: "/time/shifts" },
        can(viewer, P.SHIFT_MANAGE) && { label: "Roster", href: "/attendance/roster" },
        (hrAttendance || can(viewer, P.PAYROLL_RUN)) && { label: "Overtime", href: "/time/overtime" },
        can(viewer, P.REPORT_VIEW) && { label: "Reports", href: "/time/reports" },
        canAny(viewer, [P.LEAVE_MANAGE, P.ATTENDANCE_MANAGE, P.SHIFT_MANAGE]) && { label: "Settings", href: "/time/settings" },
      ]),
    });
  }

  const payroll = tabs([
    can(viewer, P.PAYROLL_VIEW) && { label: "Run Payroll", href: "/payroll/runs", paths: ["/payroll/runs", "/payroll/payslips"], count: counts.runs },
    can(viewer, P.PAY_REGISTER_VIEW) && { label: "Pay Register", href: "/payroll/register" },
    can(viewer, P.PAYGROUP_MANAGE) && { label: "Pay Groups", href: "/payroll/pay-groups" },
    can(viewer, P.SALARY_STRUCTURE_MANAGE) && { label: "Salary Structures", href: "/payroll/structures" },
    can(viewer, P.STATUTORY_MANAGE) && { label: "Statutory", href: "/payroll/statutory" },
    can(viewer, P.STATUTORY_MANAGE) && { label: "Filings", href: "/payroll/filings" },
    (can(viewer, P.PAYROLL_VIEW) || can(viewer, P.PAYROLL_APPROVE)) && { label: "Approvals", href: "/payroll/approvals" },
    can(viewer, P.PAYROLL_RUN) && { label: "Bonuses", href: "/payroll/bonuses" },
    can(viewer, P.PAYROLL_RUN) && { label: "Flexible Benefits", href: "/payroll/fbp" },
    can(viewer, P.PAYROLL_RUN) && { label: "Perks", href: "/payroll/perks" },
    can(viewer, P.LOAN_MANAGE) && { label: "Loans", href: "/payroll/loans" },
    can(viewer, P.TAX_DECLARATION_APPROVE) && { label: "Tax Proofs", href: "/payroll/tax-proofs" },
    can(viewer, P.LEDGER_VIEW) && { label: "Accounting", href: "/accounting" },
  ]);
  if (payroll.length) sections.push({ key: "payroll", label: "Payroll", icon: "payroll", href: payroll[0].href, tabs: payroll, admin: true });

  // Routes an employee reaches as one of their own apps, unless a workspace
  // above already owns them for this viewer.
  const owned = new Set(sections.flatMap((s) => s.tabs.flatMap((t) => t.paths ?? [path(t.href)])));
  const meSection = sections.find((s) => s.key === "me");
  if (meSection) {
    const apps = meSection.tabs.find((t) => t.href === "/me/apps")!;
    for (const p of ["/helpdesk", "/projects", "/assets", "/hiring", "/onboarding"]) if (!owned.has(p)) apps.paths!.push(p);
    // Logging time is always the employee's own, whoever else runs projects.
    apps.paths!.push("/projects/time");
    const expenses = meSection.tabs.find((t) => t.href === "/me/expenses")!;
    if (!owned.has("/expenses")) expenses.paths = ["/me/expenses", "/expenses"];
    const perf = meSection.tabs.find((t) => t.href === "/me/performance")!;
    if (!owned.has("/performance")) perf.paths!.push("/performance");
    if (opts.hasExit) apps.paths!.push("/me/exit");
  }
  const teamSection = sections.find((s) => s.key === "team");
  if (teamSection && !owned.has("/employees")) teamSection.tabs[0].paths = ["/team", "/employees"];
  return sections;
}

/** Where the settings gear in the top bar goes, if anywhere. */
export function settingsLink(viewer: Viewer): string | null {
  return can(viewer, P.ORG_SETTINGS_MANAGE) ? "/admin/settings" : can(viewer, P.ROLE_MANAGE) ? "/admin/roles" : null;
}

/** The quick actions offered by ⌘K, filtered to what this viewer can do. */
export function quickActions(viewer: Viewer): Array<{ label: string; href: string; keywords: string }> {
  const me = !!viewer.employee;
  const list: Array<{ label: string; href: string; keywords: string } | false> = [
    me && { label: "Apply leave", href: "/me/leave?apply=1", keywords: "leave request time off vacation sick" },
    me && { label: "Clock in / out", href: "/me/attendance", keywords: "attendance punch web clock" },
    me && { label: "Request work from home", href: "/me/attendance?request=WFH", keywords: "wfh remote on duty" },
    me && { label: "Request overtime", href: "/me/attendance?view=overtime&request=OT", keywords: "overtime ot extra hours" },
    me && { label: "Request comp off", href: "/me/leave?compoff=1", keywords: "comp off compensatory holiday worked" },
    me && { label: "Encash leave", href: "/me/leave?encash=1", keywords: "leave encashment" },
    me && { label: "Log work hours", href: "/me/work-log", keywords: "work log timesheet hours daily" },
    canAny(viewer, [P.LEAVE_MANAGE, P.LEAVE_APPROVE]) && { label: "Encash leave for an employee", href: "/time/settings?tab=encash", keywords: "leave encashment on behalf" },
    can(viewer, P.ATTENDANCE_MANAGE) && { label: "Attendance kiosks", href: "/time/settings?tab=kiosks", keywords: "kiosk punch pin tablet" },
    me && { label: "View my payslips", href: "/finances/pay/payslips", keywords: "salary payslip pay slip" },
    me && { label: "Declare investments", href: "/finances/tax", keywords: "tax declaration 80c regime" },
    me && { label: "Claim a reimbursement", href: "/finances/pay/component-claims", keywords: "fbp reimbursement claim fuel telephone" },
    me && { label: "Declare flexible benefits", href: "/finances/pay/fbp", keywords: "fbp flexible benefit plan declaration special allowance" },
    me && { label: "Apply for a loan", href: "/finances/loans?apply=1", keywords: "loan advance emi" },
    me && { label: "Add an expense", href: "/me/expenses?new=1", keywords: "claim reimbursement expense" },
    me && { label: "Log time", href: "/projects/time", keywords: "timesheet hours project" },
    me && { label: "Raise a helpdesk ticket", href: "/me/helpdesk?new=1", keywords: "help support ticket hr question ask" },
    me && { label: "Request an asset", href: "/me/assets?request=1", keywords: "asset laptop device request" },
    me && { label: "Give praise", href: "/?compose=praise", keywords: "praise kudos appreciation" },
    me && { label: "Create a post", href: "/?compose=post", keywords: "wall post share" },
    me && { label: "Create a poll", href: "/?compose=poll", keywords: "wall poll vote survey" },
    me && { label: "View holidays", href: `/?holidays=${new Date().getFullYear()}`, keywords: "holiday calendar" },
    me && { label: "Schedule a 1:1", href: "/performance/one-on-ones?new=1", keywords: "one on one meeting manager" },
    me && { label: "My courses", href: "/learn/my-courses", keywords: "learning course training lms quiz" },
    { label: "Employee directory", href: "/directory", keywords: "people colleagues search" },
    { label: "Organisation tree", href: "/directory/tree", keywords: "org chart hierarchy reporting" },
    can(viewer, P.PAYROLL_VIEW) && { label: "Run payroll", href: "/payroll/runs", keywords: "payroll process month" },
    (can(viewer, P.PAYROLL_APPROVE) || can(viewer, P.SALARY_REVISE)) && { label: "Payroll approvals", href: "/payroll/approvals", keywords: "approve salary revision compensation lock maker checker" },
    can(viewer, P.TAX_DECLARATION_APPROVE) && { label: "Review tax proofs", href: "/payroll/tax-proofs", keywords: "investment declaration proof 80c verify" },
    can(viewer, P.EMPLOYEE_CREATE) && { label: "Add an employee", href: "/employees/new", keywords: "hire onboard new joinee" },
    canAny(viewer, [P.EMPLOYEE_CREATE, P.LEAVE_MANAGE, P.SALARY_REVISE, P.EMPLOYEE_MANAGE_FINANCIALS]) && { label: "Bulk import", href: "/admin/import", keywords: "import csv upload spreadsheet migrate employees balances salary bank" },
    canAny(viewer, [P.API_KEY_MANAGE, P.ATTENDANCE_MANAGE]) && { label: "Integrations", href: "/admin/integrations", keywords: "api key biometric device punch integration token webhook" },
    can(viewer, P.ORG_SETTINGS_MANAGE) && { label: "Custom fields", href: "/admin/settings?tab=fields", keywords: "custom field profile extra attribute dropdown" },
    can(viewer, P.DOCUMENT_MANAGE) && { label: "Document types", href: "/admin/settings?tab=documents", keywords: "document folder type mandatory request upload settings" },
    can(viewer, P.EXIT_MANAGE) && { label: "Notice periods and exit reasons", href: "/admin/settings?tab=exits", keywords: "notice period policy exit reason resignation settings" },
    can(viewer, P.LEDGER_VIEW) && { label: "Accounting", href: "/accounting", keywords: "ledger books journal trial balance" },
    can(viewer, P.REPORT_VIEW) && { label: "Reports", href: "/reports", keywords: "employee reports export" },
    !!viewer.employee && { label: "Clock in from phone", href: "/me/clock", keywords: "mobile clock in out punch selfie location app" },
    can(viewer, P.ANALYTICS_VIEW) && { label: "Org analytics", href: "/analytics", keywords: "analytics headcount attrition dashboard" },
    can(viewer, P.ANALYTICS_VIEW) && { label: "Attrition storyboard", href: "/storyboards/attrition", keywords: "attrition storyboard exits" },
    canAny(viewer, [P.REQUISITION_MANAGE, P.REQUISITION_VIEW]) && { label: "Raise a requisition", href: "/hiring/requisitions?new=1", keywords: "requisition hire headcount position" },
    can(viewer, P.ASSET_MANAGE) && { label: "Add an asset", href: "/assets/list?new=1", keywords: "asset inventory add" },
    can(viewer, P.ATTENDANCE_APPROVE) && { label: "Attendance approvals", href: "/team/attendance", keywords: "attendance regularize approve" },
    can(viewer, P.OPPORTUNITY_MANAGE) && { label: "Add opportunity", href: "/projects/opportunities?new=1", keywords: "opportunity pipeline deal" },
    can(viewer, P.RESOURCE_VIEW) && { label: "Resource planner", href: "/projects/resources", keywords: "resource allocation bench planner" },
    me && { label: "Take a survey", href: "/engage/surveys", keywords: "survey poll pulse feedback enps" },
  ];
  // Shortcuts into a module the company has switched off are dropped.
  const off = (href: string) => MODULE_ROUTES.some(([prefix, mod]) => href.startsWith(prefix) && viewer.tenant.disabledModules.includes(mod));
  return list.filter((x): x is { label: string; href: string; keywords: string } => !!x && !off(x.href));
}

/** Which module a self-service route belongs to, for hiding shortcuts. */
const MODULE_ROUTES: Array<[string, string]> = [
  ["/finances", "payroll"], ["/payroll", "payroll"], ["/accounting", "payroll"],
  ["/me/expenses", "expenses"], ["/expenses", "expenses"],
  ["/me/assets", "assets"], ["/assets", "assets"],
  ["/me/helpdesk", "helpdesk"], ["/helpdesk", "helpdesk"],
  ["/me/performance", "performance"], ["/performance", "performance"],
  ["/hiring", "hire"], ["/projects", "projects"],
  ["/engage", "engage"], ["/?compose", "engage"],
  ["/learn", "learn"], ["/analytics", "analytics"], ["/storyboards", "analytics"],
];
