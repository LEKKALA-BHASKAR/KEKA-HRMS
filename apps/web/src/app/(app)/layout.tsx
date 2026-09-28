import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can, canAny } from "@/lib/context";
import { SidebarNav, type NavSection } from "@/components/sidebar";
import { UserMenu } from "@/components/user-menu";

const P = PERMISSIONS;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();

  // Counts shown as nav badges. Only queried when the viewer may see them.
  const [pendingApprovals, openRunCount, pendingDocuments, pendingAcks] = await Promise.all([
    canAny(viewer, [P.PAYROLL_APPROVE, P.LEAVE_APPROVE, P.EXIT_APPROVE])
      ? prisma.leaveRequest.count({ where: { tenantId: viewer.tenantId, status: "PENDING" } })
      : Promise.resolve(0),
    can(viewer, P.PAYROLL_VIEW)
      ? prisma.payrollRun.count({
          where: { tenantId: viewer.tenantId, status: { in: ["DRAFT", "IN_PROGRESS", "PENDING_APPROVAL"] } },
        })
      : Promise.resolve(0),
    can(viewer, P.DOCUMENT_VERIFY)
      ? prisma.employeeDocument.count({
          where: { tenantId: viewer.tenantId, status: "PENDING_VERIFICATION" },
        })
      : Promise.resolve(0),
    // Announcements this viewer still has to acknowledge.
    viewer.employee
      ? prisma.announcement.count({
          where: {
            tenantId: viewer.tenantId,
            status: "PUBLISHED",
            requireAck: true,
            reads: { none: { employeeId: viewer.employee.id, acknowledgedAt: { not: null } } },
          },
        })
      : Promise.resolve(0),
  ]);

  // The navigation is assembled from permissions, so a viewer never sees a
  // link to something they cannot open.
  const sections: NavSection[] = [];

  sections.push({
    items: [
      { href: "/", label: "Dashboard", icon: "home" },
      { href: "/inbox", label: "Inbox", icon: "inbox", count: pendingApprovals },
    ],
  });

  const meItems = [
    { href: "/me/pay", label: "My Pay", icon: "receipt" },
    { href: "/me/tax", label: "My Tax", icon: "file" },
    { href: "/me/leave", label: "My Leave", icon: "calendar" },
  ];
  if (viewer.employee) sections.push({ label: "Me", items: meItems });

  const peopleItems = [];
  if (can(viewer, P.EMPLOYEE_VIEW)) {
    peopleItems.push({ href: "/employees", label: "Employees", icon: "users" });
  }
  if (can(viewer, P.ORG_VIEW)) {
    peopleItems.push({ href: "/org", label: "Organisation", icon: "building" });
  }
  if (can(viewer, P.ONBOARDING_VIEW)) {
    peopleItems.push({ href: "/onboarding", label: "Onboarding", icon: "briefcase" });
  }
  if (can(viewer, P.EXIT_MANAGE)) {
    peopleItems.push({ href: "/exits", label: "Exits", icon: "clock" });
  }
  if (can(viewer, P.HR_ACTIVITY_VIEW)) {
    peopleItems.push({ href: "/activities", label: "HR Activities", icon: "briefcase" });
  }
  if (can(viewer, P.DOCUMENT_VIEW)) {
    peopleItems.push({ href: "/documents", label: "Documents", icon: "file", count: pendingDocuments });
  }
  if (peopleItems.length > 0) sections.push({ label: "People", items: peopleItems });

  const payrollItems = [];
  if (can(viewer, P.PAYROLL_VIEW)) {
    payrollItems.push({ href: "/payroll/runs", label: "Run Payroll", icon: "play", count: openRunCount });
  }
  if (can(viewer, P.PAY_REGISTER_VIEW)) {
    payrollItems.push({ href: "/payroll/register", label: "Pay Register", icon: "receipt" });
  }
  if (can(viewer, P.PAYGROUP_MANAGE)) {
    payrollItems.push({ href: "/payroll/pay-groups", label: "Pay Groups", icon: "wallet" });
  }
  if (can(viewer, P.SALARY_STRUCTURE_MANAGE)) {
    payrollItems.push({ href: "/payroll/structures", label: "Salary Structures", icon: "chart" });
  }
  if (can(viewer, P.STATUTORY_MANAGE)) {
    payrollItems.push({ href: "/payroll/statutory", label: "Statutory", icon: "shield" });
  }
  if (can(viewer, P.LOAN_MANAGE)) {
    payrollItems.push({ href: "/payroll/loans", label: "Loans", icon: "wallet" });
  }
  if (payrollItems.length > 0) sections.push({ label: "Payroll", items: payrollItems });

  const workplaceItems = [];
  if (can(viewer, P.ANNOUNCEMENT_VIEW)) {
    workplaceItems.push({ href: "/announcements", label: "Announcements", icon: "inbox", count: pendingAcks });
  }
  if (can(viewer, P.AWARD_VIEW)) {
    workplaceItems.push({ href: "/awards", label: "Awards & Praise", icon: "chart" });
  }
  if (can(viewer, P.TRAINING_VIEW)) {
    workplaceItems.push({ href: "/training", label: "Training", icon: "file" });
  }
  if (can(viewer, P.MEETING_VIEW)) {
    workplaceItems.push({ href: "/meetings", label: "Meetings", icon: "calendar" });
  }
  if (workplaceItems.length > 0) sections.push({ label: "Workplace", items: workplaceItems });

  const opsItems = [];
  if (can(viewer, P.LEAVE_VIEW)) opsItems.push({ href: "/leave", label: "Leave", icon: "calendar" });
  if (can(viewer, P.ATTENDANCE_VIEW)) opsItems.push({ href: "/attendance", label: "Attendance", icon: "clock" });
  if (can(viewer, P.ASSET_VIEW)) opsItems.push({ href: "/assets", label: "Assets", icon: "box" });
  if (can(viewer, P.HELPDESK_VIEW)) opsItems.push({ href: "/helpdesk", label: "Helpdesk", icon: "headset" });
  if (opsItems.length > 0) sections.push({ label: "Operations", items: opsItems });

  const adminItems = [];
  if (can(viewer, P.REPORT_VIEW)) adminItems.push({ href: "/reports", label: "Reports", icon: "chart" });
  if (can(viewer, P.ROLE_MANAGE)) adminItems.push({ href: "/admin/roles", label: "Roles & Permissions", icon: "shield" });
  if (can(viewer, P.AUDIT_LOG_VIEW)) adminItems.push({ href: "/admin/audit", label: "Audit Logs", icon: "file" });
  if (can(viewer, P.ORG_SETTINGS_MANAGE)) adminItems.push({ href: "/admin/settings", label: "Settings", icon: "settings" });
  if (adminItems.length > 0) sections.push({ label: "Administration", items: adminItems });

  const displayName = viewer.employee?.displayName ?? viewer.user.email;
  const initials = displayName.split(" ").filter(Boolean).slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "").join("");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">K</div>
          <div className="brand-text">
            <div className="brand-name">{viewer.tenant.name}</div>
            <div className="brand-sub">{viewer.tenant.subdomain}.keka.local</div>
          </div>
        </div>

        <SidebarNav sections={sections} />

        <div className="sidebar-footer">
          <UserMenu
            name={displayName}
            email={viewer.user.email}
            roles={viewer.roleNames}
            initials={initials}
          />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row gap-2">
            <span className="badge brand">{viewer.tenant.plan}</span>
            {viewer.employee ? (
              <span className="text-sm muted">
                {viewer.employee.employeeNumber} · {viewer.employee.jobTitleName ?? "—"}
              </span>
            ) : null}
          </div>
          <div className="spacer" />
          <div className="text-sm subtle nowrap">
            FY {new Date().getUTCMonth() + 1 >= viewer.tenant.fyStartMonth
              ? `${new Date().getUTCFullYear()}-${String((new Date().getUTCFullYear() + 1) % 100).padStart(2, "0")}`
              : `${new Date().getUTCFullYear() - 1}-${String(new Date().getUTCFullYear() % 100).padStart(2, "0")}`}
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
