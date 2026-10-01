import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { weekStart } from "@keka/services";
import { requireViewer, can, type Viewer } from "@/lib/context";
import { SectionTitle, Panel, EmptyState } from "@/components/keka";
import {
  IconTimer, IconHeadset, IconWallet, IconBox, IconPlay, IconCalendar, IconBriefcase, IconUserPlus, IconLogout,
} from "@/components/icons";
import s from "./apps.module.css";

/**
 * Me → Apps: the employee's other self-service tools, each with a live
 * figure where one helps. An app is listed only when the viewer can open the
 * page it links to, and every count is the viewer's own, within the tenant.
 */

const P = PERMISSIONS;

interface App {
  key: string;
  title: string;
  description: string;
  href: string;
  icon: ReactNode;
  colour: string;
  /** The headline figure, e.g. "3" with "open tickets"; hidden when zero. */
  count?: number;
  countLabel?: string;
  /** A second line: status, or what needs the viewer's attention. */
  note?: string | null;
  attention?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const amt = (v: unknown) => formatINR(Number(v ?? 0)).replace(/\.00$/, "");

export default async function MyAppsPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <Panel><EmptyState icon={<IconBox />} title="No employee record">This login is not linked to an employee, so there are no self-service apps to show.</EmptyState></Panel>;
  }
  const apps = await buildApps(viewer);
  return (
    <>
      <SectionTitle sub="Your other self-service tools, with what is waiting in each">Apps</SectionTitle>
      <ul className={s.grid}>
        {apps.map((a) => (
          <li key={a.key}>
            <Link href={a.href} className={s.card} aria-describedby={`${a.key}-desc`}>
              <span className={s.icon} style={{ color: a.colour, background: `color-mix(in srgb, ${a.colour} 12%, var(--surface))` }} aria-hidden="true">{a.icon}</span>
              <span className={s.body}>
                <span className={s.titleRow}>
                  <span className={s.title}>{a.title}</span>
                  {a.count ? (
                    <span className={`${s.count}${a.attention ? ` ${s.countAttention}` : ""}`} aria-label={`${a.count} ${a.countLabel ?? ""}`.trim()}>{a.count}</span>
                  ) : null}
                </span>
                <span id={`${a.key}-desc`} className={s.desc}>{a.description}</span>
                {a.note ? <span className={`${s.note}${a.attention ? ` ${s.noteAttention}` : ""}`}>{a.note}</span> : null}
              </span>
              <svg className={s.chev} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

async function buildApps(viewer: Viewer): Promise<App[]> {
  const me = viewer.employee!.id;
  const tenantId = viewer.tenantId;
  const now = new Date();
  const week = weekStart(now);

  const helpdesk = can(viewer, P.HELPDESK_VIEW);
  const assets = can(viewer, P.ASSET_VIEW);
  const training = can(viewer, P.TRAINING_VIEW);
  const meetings = can(viewer, P.MEETING_VIEW);
  const interviewer = can(viewer, P.INTERVIEW_FEEDBACK) || can(viewer, P.REQUISITION_VIEW);
  const zero = Promise.resolve(0);

  const [
    sheet, sheetsBack, tickets, ticketsWaiting, loans, held, unacknowledged, courses, coursesNew,
    upcomingMeetings, nextMeeting, openJobs, upcomingInterviews, feedbackDue, exit,
  ] = await Promise.all([
    prisma.timesheet.findFirst({ where: { tenantId, employeeId: me, periodStart: week }, select: { status: true, totalHours: true } }),
    prisma.timesheet.count({ where: { tenantId, employeeId: me, status: "REJECTED" } }),
    helpdesk ? prisma.helpdeskTicket.count({ where: { tenantId, employeeId: me, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"] } } }) : zero,
    helpdesk ? prisma.helpdeskTicket.count({ where: { tenantId, employeeId: me, status: "WAITING_ON_EMPLOYEE" } }) : zero,
    prisma.loan.findMany({ where: { employeeId: me, employee: { tenantId }, status: { in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "DISBURSED", "ACTIVE"] } }, select: { status: true, outstanding: true } }),
    assets ? prisma.assetAssignment.count({ where: { employeeId: me, returnedOn: null, asset: { tenantId } } }) : zero,
    assets ? prisma.assetAssignment.count({ where: { employeeId: me, returnedOn: null, acknowledgedAt: null, asset: { tenantId } } }) : zero,
    training ? prisma.trainingEnrolment.count({ where: { employeeId: me, status: { in: ["ASSIGNED", "IN_PROGRESS"] }, program: { tenantId } } }) : zero,
    training ? prisma.trainingEnrolment.count({ where: { employeeId: me, status: "ASSIGNED", program: { tenantId } } }) : zero,
    meetings ? prisma.meeting.count({ where: { tenantId, status: "SCHEDULED", startsAt: { gte: now }, OR: [{ organiserId: me }, { attendees: { some: { employeeId: me } } }] } }) : zero,
    meetings ? prisma.meeting.findFirst({ where: { tenantId, status: "SCHEDULED", startsAt: { gte: now }, OR: [{ organiserId: me }, { attendees: { some: { employeeId: me } } }] }, orderBy: { startsAt: "asc" }, select: { title: true, startsAt: true } }) : null,
    prisma.job.count({ where: { tenantId, status: "OPEN", allowReferral: true } }),
    interviewer ? prisma.interviewPanelist.count({ where: { employeeId: me, interview: { status: { in: ["SCHEDULED", "RESCHEDULED"] }, scheduledAt: { gte: now }, application: { tenantId } } } }) : zero,
    interviewer ? prisma.interviewPanelist.count({ where: { employeeId: me, interview: { status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED"] }, scheduledAt: { lt: now }, application: { tenantId }, scorecards: { none: { panelistId: me } } } } }) : zero,
    prisma.exitRecord.findFirst({ where: { employeeId: me, employee: { tenantId } }, select: { status: true, lastWorkingDay: true } }),
  ]);

  const apps: App[] = [];

  // Everyone with an employee record logs time; managers approve it from the Inbox.
  apps.push({
    key: "timesheets", title: "Timesheets", href: "/projects?tab=time", icon: <IconTimer />, colour: "#3d8fe6",
    description: "Log the hours you spend on each project, week by week.",
    count: sheetsBack || undefined, countLabel: "sent back", attention: sheetsBack > 0,
    note: sheetsBack ? `${plural(sheetsBack, "timesheet")} sent back to you`
      : sheet ? `This week: ${Number(sheet.totalHours).toLocaleString("en-IN")} h · ${sheet.status.toLowerCase()}` : "Nothing logged this week",
  });

  if (helpdesk) {
    apps.push({
      key: "helpdesk", title: "Helpdesk", href: "/helpdesk", icon: <IconHeadset />, colour: "#26a69a",
      description: "Raise a query with HR, IT, payroll or admin and track it to resolution.",
      count: tickets, countLabel: "open tickets", attention: ticketsWaiting > 0,
      note: ticketsWaiting ? `${plural(ticketsWaiting, "ticket")} waiting on your reply` : tickets ? `${plural(tickets, "open ticket")}` : "No open tickets",
    });
  }

  const outstanding = loans.reduce((t, l) => t + Number(l.outstanding ?? 0), 0);
  const pendingLoans = loans.filter((l) => ["REQUESTED", "PENDING_APPROVAL"].includes(l.status)).length;
  apps.push({
    key: "loans", title: "Loans", href: "/me/loans", icon: <IconWallet />, colour: "#ff9f1c",
    description: "Apply for a salary advance or loan, repaid through payroll.",
    count: loans.length, countLabel: "active loans",
    note: loans.length ? [outstanding ? `${amt(outstanding)} outstanding` : null, pendingLoans ? `${pendingLoans} awaiting approval` : null].filter(Boolean).join(" · ") || plural(loans.length, "active loan") : "No active loans",
  });

  if (assets) {
    apps.push({
      key: "assets", title: "Assets", href: "/assets", icon: <IconBox />, colour: "#9b7ede",
      description: "Laptops and equipment issued to you, and requests for new ones.",
      count: held, countLabel: "assets with you", attention: unacknowledged > 0,
      note: unacknowledged ? `${plural(unacknowledged, "asset")} to acknowledge` : held ? `${plural(held, "asset")} with you` : "No assets assigned",
    });
  }

  if (training) {
    apps.push({
      key: "training", title: "Training", href: "/training", icon: <IconPlay />, colour: "#5c7cfa",
      description: "Courses assigned to you and programmes you can join.",
      count: courses, countLabel: "courses to complete", attention: coursesNew > 0,
      note: coursesNew ? `${plural(coursesNew, "new course")} assigned` : courses ? `${plural(courses, "course")} in progress` : "Nothing assigned right now",
    });
  }

  if (meetings) {
    apps.push({
      key: "meetings", title: "Meetings", href: "/meetings", icon: <IconCalendar />, colour: "#36b8c9",
      description: "Your meetings, rooms, minutes and action items.",
      count: upcomingMeetings, countLabel: "upcoming meetings",
      note: nextMeeting ? `Next: ${nextMeeting.title} · ${formatDate(nextMeeting.startsAt)}` : "No upcoming meetings",
    });
  }

  // The hiring page is open to every employee: referrals for all, interviews for panelists.
  apps.push({
    key: "jobs", title: "Internal jobs", href: "/hiring?tab=refer", icon: <IconBriefcase />, colour: "#e5735a",
    description: "Open roles across the company. Refer someone you know.",
    count: openJobs, countLabel: "open roles",
    note: openJobs ? `${plural(openJobs, "open role")} accepting referrals` : "No open roles right now",
  });

  if (interviewer) {
    apps.push({
      key: "hiring", title: "Hiring & interviews", href: "/hiring", icon: <IconUserPlus />, colour: "#4fc3a1",
      description: "Interviews you are on, and the feedback the panel needs from you.",
      count: upcomingInterviews, countLabel: "upcoming interviews", attention: feedbackDue > 0,
      note: feedbackDue ? `Feedback due for ${plural(feedbackDue, "interview")}` : upcomingInterviews ? `${plural(upcomingInterviews, "upcoming interview")}` : "No interviews scheduled",
    });
  }

  const liveExit = exit && !["CANCELLED", "RETAINED", "REJECTED"].includes(exit.status);
  apps.push(liveExit ? {
    key: "exit", title: "Resignation", href: "/me/exit", icon: <IconLogout />, colour: "#ef6f8f",
    description: "Your resignation, exit checklist and final settlement.",
    note: `${exit!.status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())} · last day ${formatDate(exit!.lastWorkingDay)}`,
    attention: exit!.status === "PENDING_APPROVAL",
  } : {
    key: "exit", title: "Resign", href: "/me/exit", icon: <IconLogout />, colour: "#8891a3",
    description: "Submit your resignation. Your manager and HR are notified, and you can withdraw until it is accepted.",
  });

  return apps;
}
