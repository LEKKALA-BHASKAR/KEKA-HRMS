import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer, can } from "@/lib/context";
import { EmployeeHireTabs } from "../_parts/employee-tabs";
import s from "../hire.module.css";

const P = PERMISSIONS;
export const metadata = { title: "Interviews · Hire" };
const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Interviews the viewer sits on — prepare (the interview kit and AI
 * questions) before, give feedback after. Recruiters also see every
 * upcoming interview with its outstanding feedback.
 */
export default async function InterviewsPage() {
  const viewer = await requireViewer();
  const me = viewer.employee?.id;
  const [mine, upcoming] = await Promise.all([
    me ? prisma.interviewPanelist.findMany({
      where: { employeeId: me, interview: { status: { not: "CANCELLED" }, application: { tenantId: viewer.tenantId } } },
      include: { interview: { include: { scorecards: { where: { panelistId: me }, select: { status: true } }, application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } } } } },
      orderBy: { interview: { scheduledAt: "desc" } }, take: 200,
    }) : [],
    can(viewer, P.INTERVIEW_MANAGE) ? prisma.interview.findMany({
      where: { application: { tenantId: viewer.tenantId }, status: { in: ["SCHEDULED", "RESCHEDULED"] } },
      include: { panel: { include: { employee: { select: { displayName: true } } } }, scorecards: { select: { panelistId: true, status: true } }, application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } } },
      orderBy: { scheduledAt: "asc" }, take: 100,
    }) : [],
  ]);
  const now = Date.now();
  return (
    <>
      <EmployeeHireTabs viewer={viewer} />
      <div className={s.head}>
        <div><h1 className={s.h1}>Interviews</h1><p className={s.sub}>Feedback opens when the interview starts; give it the same day while it is fresh.</p></div>
      </div>
      <div className={s.listCard}>
        <div className={s.listHead}><span className={s.listTitle}>Interviews you are on</span><span className="text-xs subtle">{mine.length}</span></div>
        {mine.length === 0 ? <div className={s.empty}>You are not on any interview panel.</div> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Candidate</th><th>Job</th><th>Round</th><th>When</th><th>Feedback</th><th /></tr></thead>
              <tbody>
                {mine.map((p) => {
                  const iv = p.interview, card = iv.scorecards[0];
                  const past = iv.scheduledAt.getTime() <= now;
                  const done = card?.status === "SUBMITTED";
                  const href = `/hiring/applications/${iv.applicationId}?tab=feedback`;
                  return (
                    <tr key={p.id}>
                      <td><Link className={s.reqLink} href={href}>{iv.application.candidate.firstName} {iv.application.candidate.lastName}</Link></td>
                      <td>{iv.application.job.title}</td>
                      <td>{iv.title}{p.isLead ? <span className="text-xs subtle"> · lead</span> : null}</td>
                      <td className="nowrap">{when(iv.scheduledAt)}</td>
                      <td>{done ? <span className={`${s.statusChip} ${s.good}`}>Submitted</span> : card?.status === "DRAFT" ? <span className={`${s.statusChip} ${s.info}`}>Draft saved</span> : past ? <span className={`${s.statusChip} ${s.warn}`}>Feedback due</span> : <span className={s.statusChip}>Upcoming</span>}</td>
                      <td className="right">
                        {!done && past ? <Link className={s.takeAction} href={`${href}&feedback=${iv.id}`}>{card?.status === "DRAFT" ? "Continue feedback" : "Give feedback"}</Link>
                          : !past ? <Link className={s.takeAction} href={href}>Prepare</Link> : <Link className={s.takeAction} href={href}>Open</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {can(viewer, P.INTERVIEW_MANAGE) ? (
        <div className={s.listCard} style={{ marginTop: 20 }}>
          <div className={s.listHead}><span className={s.listTitle}>All scheduled interviews</span><span className="text-xs subtle">{upcoming.length}</span></div>
          {upcoming.length === 0 ? <div className={s.empty}>No interviews are scheduled.</div> : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Candidate</th><th>Job</th><th>Round</th><th>When</th><th>Panel</th><th>Feedback</th></tr></thead>
                <tbody>
                  {upcoming.map((iv) => {
                    const given = iv.scorecards.filter((x) => x.status === "SUBMITTED").length;
                    return (
                      <tr key={iv.id}>
                        <td><Link className={s.reqLink} href={`/hiring/applications/${iv.applicationId}?tab=feedback`}>{iv.application.candidate.firstName} {iv.application.candidate.lastName}</Link></td>
                        <td>{iv.application.job.title}</td>
                        <td>{iv.title}</td>
                        <td className="nowrap">{when(iv.scheduledAt)}</td>
                        <td className="text-sm">{iv.panel.map((p) => p.employee.displayName).join(", ")}</td>
                        <td>{iv.scheduledAt.getTime() > now ? <span className={s.statusChip}>Upcoming</span> : <span className={`${s.statusChip} ${given >= iv.panel.length ? s.good : s.warn}`}>{given}/{iv.panel.length} given</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
