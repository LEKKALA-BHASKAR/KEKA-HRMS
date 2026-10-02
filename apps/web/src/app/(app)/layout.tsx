import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { helpdeskScope, hasHelpdeskScope, helpdeskScopeWhere, TICKET_ACTIVE_STATUSES } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { AppShell } from "@/components/shell";
import { buildNav, quickActions, settingsLink } from "@/lib/nav";
import { NavProgress } from "@/components/nav-progress";
import { Suspense } from "react";
import { scopedEmployeeIds, inScope, scopedEmployeeWhere, timesheetsToApproveWhere } from "@/lib/scope";

const P = PERMISSIONS;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  // An expired or administrator-reset password must be changed before anything else.
  if (viewer.user.mustChangePassword) redirect("/account/password?required=1");

  // Counts shown as nav badges. Only queried when the viewer may see them.
  // Approvals count only what this viewer could actually decide.
  const leaveScope = can(viewer, P.LEAVE_APPROVE) ? await scopedEmployeeIds(viewer, P.LEAVE_APPROVE) : [];
  const [pendingLeave, pendingAttendance, pendingPayroll, openRunCount, pendingDocuments, pendingAcks] = await Promise.all([
    can(viewer, P.LEAVE_APPROVE)
      ? prisma.leaveRequest.count({
          where: {
            tenantId: viewer.tenantId, status: "PENDING", ...inScope(leaveScope),
            ...(viewer.employee ? { NOT: { employeeId: viewer.employee.id } } : {}),
          },
        })
      : Promise.resolve(0),
    can(viewer, P.ATTENDANCE_APPROVE)
      ? prisma.attendanceRequest.count({
          where: {
            tenantId: viewer.tenantId, status: "PENDING",
            employee: scopedEmployeeWhere(viewer, P.ATTENDANCE_APPROVE),
            ...(viewer.employee ? { NOT: { employeeId: viewer.employee.id } } : {}),
          },
        })
      : Promise.resolve(0),
    can(viewer, P.PAYROLL_APPROVE)
      ? prisma.payrollApprovalRequest.count({ where: { status: "PENDING", run: { tenantId: viewer.tenantId } } })
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
  const [pendingExits, myTasks, unreadNotifications, myExit, pendingSheets, managedProjects, myProfile] = await Promise.all([
    can(viewer, P.EXIT_APPROVE)
      ? prisma.exitRecord.count({
          where: {
            status: "PENDING_APPROVAL",
            employee: { ...scopedEmployeeWhere(viewer, P.EXIT_APPROVE), ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}) },
          },
        })
      : Promise.resolve(0),
    viewer.employee
      ? prisma.journeyTask.count({
          where: { assigneeEmployeeId: viewer.employee.id, status: "PENDING", dueDate: { lte: new Date(Date.now() + 7 * 86_400_000) }, journey: { status: "ACTIVE" } },
        })
      : Promise.resolve(0),
    prisma.notification.count({ where: { userId: viewer.user.id, readAt: null } }),
    viewer.employee
      ? prisma.exitRecord.findFirst({
          where: { employeeId: viewer.employee.id, status: { notIn: ["CANCELLED", "RETAINED", "REJECTED"] } },
          select: { id: true },
        })
      : Promise.resolve(null),
    viewer.employee ? prisma.timesheet.count({ where: timesheetsToApproveWhere(viewer) }) : Promise.resolve(0),
    viewer.employee ? prisma.project.count({ where: { tenantId: viewer.tenantId, projectManagerId: viewer.employee.id } }) : Promise.resolve(0),
    viewer.employee ? prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { profileCompletion: true } }) : Promise.resolve(null),
  ]);
  const myDept = viewer.employee
    ? (await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { departmentId: true } }))?.departmentId ?? null
    : null;
  const [pendingSurveys, pendingCompOff, pendingEncash, myCourses] = await Promise.all([
    viewer.employee
      ? prisma.survey.count({
          where: {
            tenantId: viewer.tenantId, status: "ACTIVE", kind: { not: "EXIT" },
            participants: { none: { employeeId: viewer.employee.id } },
            OR: [{ departmentIds: { isEmpty: true } }, { departmentIds: { has: myDept ?? "-" } }],
          },
        })
      : Promise.resolve(0),
    can(viewer, P.LEAVE_APPROVE)
      ? prisma.compOffRequest.count({
          where: {
            tenantId: viewer.tenantId, status: "PENDING", ...inScope(leaveScope),
            ...(viewer.employee ? { NOT: { employeeId: viewer.employee.id } } : {}),
          },
        })
      : Promise.resolve(0),
    can(viewer, P.LEAVE_MANAGE)
      ? prisma.leaveEncashmentRequest.count({
          where: {
            tenantId: viewer.tenantId, status: "PENDING",
            employee: scopedEmployeeWhere(viewer, P.LEAVE_MANAGE),
            ...(viewer.employee ? { NOT: { employeeId: viewer.employee.id } } : {}),
          },
        })
      : Promise.resolve(0),
    viewer.employee
      ? prisma.courseEnrolment.count({ where: { employeeId: viewer.employee.id, status: { not: "COMPLETED" }, course: { status: "PUBLISHED" } } })
      : Promise.resolve(0),
  ]);
  const [myProbationReviews, probationsToDecide] = await Promise.all([
    viewer.employee
      ? prisma.probationEvaluation.count({ where: { evaluatorId: viewer.employee.id, status: "PENDING", probation: { tenantId: viewer.tenantId, status: "IN_REVIEW" } } })
      : Promise.resolve(0),
    can(viewer, P.PROBATION_MANAGE)
      ? prisma.employeeProbation.count({
          where: {
            tenantId: viewer.tenantId,
            OR: [{ status: "IN_REVIEW" }, { status: "ACTIVE", endDate: { lt: new Date() } }],
            employee: { ...scopedEmployeeWhere(viewer, P.PROBATION_MANAGE), ...(viewer.employee ? { NOT: { id: viewer.employee.id } } : {}) },
          },
        })
      : Promise.resolve(0),
  ]);
  // Category heads and agents work tickets without HELPDESK_MANAGE; the badge counts their queue.
  const hdScope = await helpdeskScope(viewer.tenantId, viewer.user.id, can(viewer, P.HELPDESK_MANAGE));
  const openTickets = hasHelpdeskScope(hdScope)
    ? await prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, ...helpdeskScopeWhere(hdScope), status: { in: TICKET_ACTIVE_STATUSES } } })
    : 0;
  const pendingApprovals = pendingLeave + pendingAttendance + pendingPayroll + pendingExits + myTasks + pendingSheets + pendingCompOff + pendingEncash + myProbationReviews;

  // The navigation is assembled from permissions, so a viewer never sees a
  // link to something they cannot open.
  const sections = buildNav(viewer, {
    approvals: pendingApprovals, leave: pendingLeave + pendingCompOff + pendingEncash, attendance: pendingAttendance,
    surveys: pendingSurveys, learning: myCourses, exits: pendingExits, runs: openRunCount,
    documents: pendingDocuments, acks: pendingAcks, sheets: pendingSheets, notifications: unreadNotifications,
    probation: probationsToDecide, tickets: openTickets,
  }, {
    isHelpdeskAgent: hasHelpdeskScope(hdScope),
    hasExit: !!myExit, managesProject: managedProjects > 0,
    welcomeDot: !!myProfile && myProfile.profileCompletion < 100,
  });

  const name = viewer.employee?.displayName ?? viewer.user.email;
  return (
    <>
      <Suspense fallback={null}><NavProgress /></Suspense>
      <AppShell
        sections={sections}
        company={viewer.tenant.name}
        notifications={unreadNotifications}
        actions={quickActions(viewer)}
        settingsHref={settingsLink(viewer)}
        user={{
          name, email: viewer.user.email, roles: viewer.roleNames, title: viewer.employee?.jobTitleName ?? null,
          employeeId: viewer.employee?.id ?? null, photoUrl: viewer.employee?.photoUrl ?? null,
        }}
      >
        {children}
      </AppShell>
    </>
  );
}
