import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { can, canAny, type Viewer } from "./context";
import { scopedEmployeeWhere, scopedEmployeeIds, inScope } from "./scope";
import { REPORTS } from "./reports";

/**
 * "What needs my attention today?" — one ranked list per viewer, assembled
 * from their permissions. Each item says how many, why it matters and where
 * to fix it; nothing here is a chart to interpret.
 */

const P = PERMISSIONS;
const DAY = 86_400_000;

export interface AttentionItem {
  severity: "red" | "amber" | "green";
  title: string;
  detail: string;
  href: string;
  count: number;
}

const rank = { red: 0, amber: 1, green: 2 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** For anyone who manages people: their team's day. */
export async function teamAttention(viewer: Viewer): Promise<AttentionItem[]> {
  if (!viewer.employee || viewer.allReportIds.size === 0) return [];
  const reports = [...viewer.allReportIds];
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const [leave, attendance, offToday, probation, tasks, notIn] = await Promise.all([
    prisma.leaveRequest.count({ where: { employeeId: { in: reports }, status: "PENDING" } }),
    prisma.attendanceRequest.count({ where: { employeeId: { in: reports }, status: "PENDING" } }),
    prisma.leaveRequestDay.findMany({ where: { date: today, request: { employeeId: { in: reports }, status: "APPROVED" } }, select: { request: { select: { employeeId: true } } } }),
    prisma.employee.findMany({ where: { id: { in: reports }, status: "PROBATION" }, select: { dateOfJoining: true } }),
    prisma.journeyTask.count({ where: { assigneeEmployeeId: viewer.employee.id, status: "PENDING", dueDate: { lte: new Date(Date.now() + 7 * DAY) }, journey: { status: "ACTIVE" } } }),
    prisma.attendanceRecord.count({ where: { employeeId: { in: reports }, date: { gte: new Date(today.getTime() - 7 * DAY), lt: today }, status: "NO_ATTENDANCE" } }),
  ]);
  const dueSoon = probation.filter((p) => p.dateOfJoining.getTime() + 180 * DAY - Date.now() < 30 * DAY).length;
  const items: AttentionItem[] = [];
  if (leave + attendance) items.push({ severity: "amber", title: `${plural(leave + attendance, "request")} to approve`, detail: `${leave} leave, ${attendance} attendance`, href: "/inbox", count: leave + attendance });
  if (tasks) items.push({ severity: "amber", title: `${plural(tasks, "task")} due this week`, detail: "From onboarding, promotion and exit journeys", href: "/inbox", count: tasks });
  if (dueSoon) items.push({ severity: "amber", title: `${plural(dueSoon, "probation review")} due`, detail: "Within 30 days", href: "/reports?r=probation-due", count: dueSoon });
  if (notIn) items.push({ severity: "amber", title: `${plural(notIn, "unexplained absence")} last week`, detail: "No punches and no leave — likely loss of pay unless regularised", href: "/attendance?tab=register", count: notIn });
  const off = new Set(offToday.map((o) => o.request.employeeId)).size;
  items.push({ severity: "green", title: off ? `${plural(off, "person", "people")} off today` : "Everyone is in today", detail: `Of ${reports.length} in your team`, href: "/leave?tab=calendar", count: off });
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** For HR, payroll and administrators: the organisation's day. */
export async function operationsAttention(viewer: Viewer): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const now = new Date();
  const jobs: Array<Promise<void>> = [];

  if (can(viewer, P.PAYROLL_VIEW)) jobs.push((async () => {
    const open = await prisma.payrollRun.findFirst({ where: { tenantId: viewer.tenantId, status: { in: ["DRAFT", "IN_PROGRESS", "PENDING_APPROVAL", "LOCKED"] } }, orderBy: [{ year: "desc" }, { month: "desc" }] });
    if (open) {
      const due = new Date(Date.UTC(open.year, open.month, 1));
      const days = Math.ceil((due.getTime() - now.getTime()) / DAY);
      items.push({ severity: days <= 3 ? "red" : "amber", title: `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][open.month]} payroll is ${open.status.toLowerCase().replace(/_/g, " ")}`, detail: days >= 0 ? `Pay day in ${plural(days, "day")}` : `${plural(-days, "day")} past pay day`, href: `/payroll/runs/${open.id}`, count: 1 });
    }
  })());

  if (can(viewer, P.STATUTORY_MANAGE)) jobs.push((async () => {
    const r = await REPORTS.find((x) => x.key === "statutory-dues")!.run(viewer, { fy: now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1 });
    const overdue = r.rows.filter((x) => x.status === "overdue").length;
    if (overdue) items.push({ severity: "red", title: `${plural(overdue, "month")} of PF/ESI not filed`, detail: "Past the 15th-of-next-month deadline — interest and damages accrue", href: "/payroll/filings", count: overdue });
  })());

  if (can(viewer, P.EMPLOYEE_VIEW_ALL)) jobs.push((async () => {
    const r = await REPORTS.find((x) => x.key === "data-quality")!.run(viewer, { fy: now.getUTCFullYear() });
    const high = r.rows.filter((x) => x.severity === "high").length;
    if (r.rows.length) items.push({ severity: high ? "red" : "amber", title: `${plural(r.rows.length, "data issue")} in employee records`, detail: high ? `${high} would break payroll or filings` : "None blocks payroll", href: "/reports?r=data-quality", count: r.rows.length });
  })());

  if (can(viewer, P.EXIT_APPROVE)) jobs.push((async () => {
    const [pending, settle] = await Promise.all([
      prisma.exitRecord.count({ where: { status: "PENDING_APPROVAL", employee: scopedEmployeeWhere(viewer, P.EXIT_APPROVE) } }),
      prisma.fnfSettlement.count({ where: { status: "IN_REVIEW", employee: scopedEmployeeWhere(viewer, P.EXIT_APPROVE) } }),
    ]);
    if (pending) items.push({ severity: "amber", title: `${plural(pending, "resignation")} to decide`, detail: "Waiting on HR", href: "/exits", count: pending });
    if (settle) items.push({ severity: "amber", title: `${plural(settle, "settlement")} to finalise`, detail: "Full and final, drafted and under review", href: "/exits", count: settle });
  })());

  if (can(viewer, P.ONBOARDING_VIEW)) jobs.push((async () => {
    const overdue = await prisma.journeyTask.count({ where: { status: "PENDING", dueDate: { lt: new Date(now.getTime() - DAY) }, journey: { status: "ACTIVE", employee: scopedEmployeeWhere(viewer, P.ONBOARDING_VIEW) } } });
    if (overdue) items.push({ severity: overdue > 5 ? "red" : "amber", title: `${plural(overdue, "journey task")} overdue`, detail: "Onboarding, promotion and exit checklists", href: "/onboarding", count: overdue });
  })());

  if (can(viewer, P.HELPDESK_MANAGE)) jobs.push((async () => {
    const late = await prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: now } } });
    const open = await prisma.helpdeskTicket.count({ where: { tenantId: viewer.tenantId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_ON_EMPLOYEE"] } } });
    if (open) items.push({ severity: late ? "red" : "green", title: `${plural(open, "helpdesk ticket")} open`, detail: late ? `${late} past the response target` : "All within target", href: "/helpdesk", count: open });
  })());

  if (can(viewer, P.DOCUMENT_VERIFY)) jobs.push((async () => {
    const pending = await prisma.employeeDocument.count({ where: { tenantId: viewer.tenantId, status: "PENDING_VERIFICATION" } });
    if (pending) items.push({ severity: "amber", title: `${plural(pending, "document")} to verify`, detail: "Uploaded by employees", href: "/documents", count: pending });
  })());

  if (canAny(viewer, [P.LEAVE_MANAGE, P.LEAVE_APPROVE])) jobs.push((async () => {
    const ids = await scopedEmployeeIds(viewer, P.LEAVE_APPROVE);
    const old = await prisma.leaveRequest.count({ where: { tenantId: viewer.tenantId, status: "PENDING", createdAt: { lt: new Date(now.getTime() - 3 * DAY) }, ...inScope(ids) } });
    if (old) items.push({ severity: "amber", title: `${plural(old, "leave request")} waiting over 3 days`, detail: "Approvers may need a nudge", href: "/leave", count: old });
  })());

  await Promise.all(jobs);
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Next salary credit for the viewer's pay group. */
export async function nextPayDate(viewer: Viewer): Promise<Date | null> {
  if (!viewer.employee) return null;
  const emp = await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { payGroup: { select: { payDay: true } } } });
  if (!emp?.payGroup) return null;
  const d = emp.payGroup.payDay || 1;
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
  return thisMonth.getTime() >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) ? thisMonth : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, d));
}
