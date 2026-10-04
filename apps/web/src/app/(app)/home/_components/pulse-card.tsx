import Link from "next/link";
import { prisma } from "@keka/db";
import type { Viewer } from "@/lib/context";

/**
 * Pulse on sign-in: live surveys flagged "ask at sign-in" that reach the
 * viewer and that they have not answered yet, shown at the top of Home.
 */
export async function SignInPulse({ viewer }: { viewer: Viewer }) {
  if (!viewer.employee) return null;
  const me = await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { id: true, departmentId: true } });
  if (!me) return null;
  const live = await prisma.survey.findMany({
    where: { tenantId: viewer.tenantId, status: "ACTIVE", onSignIn: true, archivedAt: null, participants: { none: { employeeId: me.id } } },
    orderBy: { launchedAt: "desc" }, take: 3,
    include: { questions: { orderBy: { sequence: "asc" }, take: 1, select: { prompt: true } }, _count: { select: { questions: true } } },
  });
  const mine = live.filter((s) => s.departmentIds.length === 0 || s.departmentIds.includes(me.departmentId ?? ""));
  if (mine.length === 0) return null;
  return (
    <div className="stack gap-2" style={{ marginBottom: 12 }} aria-label="Quick pulse">
      {mine.map((s) => (
        <div key={s.id} className="card" style={{ borderColor: "var(--brand, #5b84c4)" }}>
          <div className="card-body row gap-3 wrap" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div className="text-xs muted">Quick pulse · {s.isAnonymous ? "anonymous" : "named"} · {s._count.questions} question{s._count.questions === 1 ? "" : "s"}</div>
              <div className="strong">{s.questions[0]?.prompt ?? s.title}</div>
            </div>
            <Link className="btn primary sm" href={`/engage/surveys/${s.id}`}>Answer now</Link>
          </div>
        </div>
      ))}
    </div>
  );
}
