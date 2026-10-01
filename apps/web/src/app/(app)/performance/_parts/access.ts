import "server-only";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { oneOnOnePair } from "@keka/services";
import { canAny, type Viewer } from "@/lib/context";

const P = PERMISSIONS;

/** Whether this viewer has the Performance workspace (managers and performance admins). */
export function inPerformanceWorkspace(viewer: Viewer): boolean {
  return viewer.allReportIds.size > 0 || canAny(viewer, [P.PERFORMANCE_MANAGE, P.PERFORMANCE_CALIBRATE, P.GOALS_MANAGE, P.PIP_MANAGE]);
}

/**
 * Who a viewer may hold a 1:1 with: anyone below them in the reporting line,
 * and their own manager. Nobody else — HR rights do not open other people's
 * 1:1s.
 */
export async function oneOnOnePeers(viewer: Viewer): Promise<{ managerId: string | null; reportIds: Set<string> }> {
  const me = viewer.employee?.id;
  if (!me) return { managerId: null, reportIds: new Set() };
  const row = await prisma.employee.findUnique({ where: { id: me }, select: { reportingManagerId: true } });
  return { managerId: row?.reportingManagerId ?? null, reportIds: viewer.allReportIds };
}

export async function mayMeet(viewer: Viewer, otherId: string): Promise<boolean> {
  const { managerId, reportIds } = await oneOnOnePeers(viewer);
  return reportIds.has(otherId) || managerId === otherId;
}

export type OneOnOneAccess = "PARTICIPANT" | "SKIP_LEVEL";

/**
 * Load a 1:1 the viewer may open. Participants get everything except other
 * people's private notes; a manager further up the line sees only that it
 * happened. Everyone else gets nothing, so ids cannot be probed.
 */
export async function loadOneOnOne(viewer: Viewer, meetingId: string) {
  const me = viewer.employee?.id;
  if (!me) return null;
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, tenantId: viewer.tenantId, meetingType: "ONE_ON_ONE" },
    include: { attendees: { select: { employeeId: true, attendance: true, response: true } } },
  });
  if (!meeting) return null;
  const participant = meeting.organiserId === me || meeting.attendees.some((a) => a.employeeId === me);
  if (participant) return { meeting, access: "PARTICIPANT" as OneOnOneAccess, pair: oneOnOnePair(meeting) };
  const pair = oneOnOnePair(meeting);
  if (pair && pair.some((id) => viewer.allReportIds.has(id))) return { meeting, access: "SKIP_LEVEL" as OneOnOneAccess, pair };
  return null;
}
