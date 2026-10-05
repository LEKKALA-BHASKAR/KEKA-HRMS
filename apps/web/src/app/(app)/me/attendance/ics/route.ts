import { NextResponse } from "next/server";
import { prisma } from "@keka/db";
import { opsAttendanceIcs } from "@keka/services";
import { getViewer } from "@/lib/context";

const LABEL: Record<string, string> = { PRESENT: "Present", HALF_DAY: "Half day", ABSENT: "Absent", ON_LEAVE: "On leave", WORK_FROM_HOME: "Work from home", ON_DUTY: "On duty", WEEKLY_OFF: "Weekly off", HOLIDAY: "Holiday" };
const hm = (d: Date | null) => (d ? d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "");

/** The signed-in employee's attendance for the last 90 days and the next 30 (holidays, approved leave) as an iCalendar file. */
export async function GET() {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in first.", { status: 401 });
  if (!v.employee) return new NextResponse("No employee record linked to this login.", { status: 404 });
  const now = new Date();
  const from = new Date(now.getTime() - 90 * 86_400_000), to = new Date(now.getTime() + 30 * 86_400_000);
  const [recs, leave] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { tenantId: v.tenantId, employeeId: v.employee.id, date: { gte: from, lte: now } }, orderBy: { date: "asc" } }),
    prisma.leaveRequest.findMany({ where: { tenantId: v.tenantId, employeeId: v.employee.id, status: "APPROVED", toDate: { gte: now }, fromDate: { lte: to } }, include: { leaveType: { select: { name: true } } } }),
  ]);
  const days = recs.map((r) => { const st = r.manualStatus ?? r.status; return { date: r.date, summary: `${LABEL[st] ?? st}${r.firstIn ? ` ${hm(r.firstIn)}–${hm(r.lastOut)}` : ""}`, description: `Worked ${Number(r.effectiveHours)} h` }; });
  for (const l of leave) for (let t = Math.max(l.fromDate.getTime(), now.getTime() - (now.getTime() % 86_400_000)); t <= l.toDate.getTime(); t += 86_400_000) days.push({ date: new Date(t), summary: `On leave: ${l.leaveType.name}`, description: "Approved leave" });
  await prisma.auditLog.create({ data: { tenantId: v.tenantId, module: "ATTENDANCE", action: "EXPORT", entityType: "AttendanceRecord", entityId: v.employee.id, summary: `Exported own attendance calendar (${days.length} days)`, actorId: v.user.id, actorLabel: v.user.email } });
  return new Response(opsAttendanceIcs(`${v.employee.displayName} attendance`, days), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="attendance-${now.toISOString().slice(0, 10)}.ics"`, "Cache-Control": "no-store" } });
}
