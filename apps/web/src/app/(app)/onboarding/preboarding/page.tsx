import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { BGV_CHECKS } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { JoinActions, StartBgv, UpdateBgv } from "./forms";

const P = PERMISSIONS;
const DAY = 86_400_000;
const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { INITIATED: "info", IN_PROGRESS: "info", CLEAR: "success", DISCREPANCY: "warning", FAILED: "danger", CANCELLED: "neutral" };

/**
 * Preboarding: hires who have not joined yet, how far their onboarding and
 * background checks have got, and the day-one step of marking them joined.
 */
export default async function PreboardingPage() {
  const viewer = await requireAuth(P.ONBOARDING_VIEW);
  const manage = can(viewer, P.ONBOARDING_MANAGE), bgv = can(viewer, P.BGV_MANAGE);
  const scope = scopedEmployeeWhere(viewer, P.ONBOARDING_VIEW);
  const today = new Date(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) + "T00:00:00Z");
  const people = await prisma.employee.findMany({
    where: { AND: [scope, { status: "PREBOARDING" }] },
    select: {
      id: true, displayName: true, employeeNumber: true, dateOfJoining: true, jobTitleName: true, personalEmail: true,
      department: { select: { name: true } },
      user: { select: { lastLoginAt: true } },
      journeys: { where: { trigger: "JOINING", status: "ACTIVE" }, select: { tasks: { select: { status: true, isRequired: true } } } },
      bgvChecks: { orderBy: { initiatedAt: "desc" }, take: 1, select: { status: true } },
    },
    orderBy: { dateOfJoining: "asc" },
  });
  const checks = bgv ? await prisma.bgvCheck.findMany({
    where: { tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.BGV_MANAGE), OR: [{ status: { in: ["INITIATED", "IN_PROGRESS"] } }, { completedAt: { gte: new Date(Date.now() - 60 * DAY) } }] },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } },
    orderBy: { initiatedAt: "desc" },
  }) : [];
  const candidates = bgv ? await prisma.employee.findMany({
    where: { AND: [scopedEmployeeWhere(viewer, P.BGV_MANAGE), { status: { in: ["PREBOARDING", "ONBOARDING", "PROBATION"] } }] },
    select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
  }) : [];
  const todayKey = today.toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Preboarding" subtitle="Hires who have not joined yet. Mark them joined on their first day to start probation and bring them into payroll." />
      <div className="tabs">
        <Link className="tab" href="/onboarding">Journeys</Link>
        <Link className="tab active" href="/onboarding/preboarding">Preboarding</Link>
      </div>
      <Card tight title={`Joining soon (${people.length})`}>
        {people.length === 0 ? <Empty title="Nobody is preboarding">Hires with a future joining date appear here once their offer is accepted.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Hire</th><th>Joins</th><th>Onboarding tasks</th><th>Portal</th><th>Background check</th><th /></tr></thead>
              <tbody>
                {people.map((p) => {
                  const tasks = p.journeys.flatMap((j) => j.tasks).filter((t) => t.isRequired);
                  const doneTasks = tasks.filter((t) => t.status !== "PENDING").length;
                  const days = Math.round((p.dateOfJoining.getTime() - today.getTime()) / DAY);
                  const check = p.bgvChecks[0]?.status;
                  return (
                    <tr key={p.id}>
                      <td><Link href={`/employees/${p.id}`}><strong>{p.displayName}</strong></Link><div className="text-xs subtle">{[p.jobTitleName, p.department?.name].filter(Boolean).join(" · ")}</div></td>
                      <td className="text-sm">{formatDate(p.dateOfJoining)}<div className={`text-xs ${days < 0 ? "neg" : "subtle"}`}>{days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : days === 0 ? "today" : `${-days} day${days === -1 ? "" : "s"} ago`}</div></td>
                      <td className="text-sm">{tasks.length ? `${doneTasks} of ${tasks.length}` : "—"}</td>
                      <td className="text-xs">{p.user?.lastLoginAt ? `signed in ${formatDate(p.user.lastLoginAt)}` : <span className="subtle">not yet</span>}</td>
                      <td>{check ? <Badge tone={TONE[check] ?? "neutral"}>{check.toLowerCase().replace("_", " ")}</Badge> : <span className="text-xs subtle">not started</span>}</td>
                      <td className="right">{manage && days <= 0 ? <JoinActions employeeId={p.id} today={todayKey} /> : manage ? <span className="text-xs subtle">from {formatDate(p.dateOfJoining)}</span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {bgv ? (
        <>
          <Card tight title="Background checks">
            {checks.length === 0 ? <Empty title="No background checks in progress" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Checks</th><th>Vendor</th><th>Started</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id}>
                        <td><strong>{c.employee?.displayName}</strong><div className="text-xs subtle">{c.employee?.employeeNumber}</div></td>
                        <td className="text-xs">{(Array.isArray(c.checkTypes) ? (c.checkTypes as string[]) : []).map((t) => t.toLowerCase()).join(", ")}</td>
                        <td className="text-sm">{c.vendor ?? "—"}</td>
                        <td className="text-sm">{formatDate(c.initiatedAt)}</td>
                        <td>
                          <Badge tone={TONE[c.status] ?? "neutral"}>{c.status.toLowerCase().replace("_", " ")}</Badge>
                          {c.findings ? <div className="text-xs subtle">{c.findings}</div> : null}
                          {c.reportUrl ? <div className="text-xs"><a href={c.reportUrl}>Report</a></div> : null}
                        </td>
                        <td className="right">{["INITIATED", "IN_PROGRESS"].includes(c.status) ? <UpdateBgv id={c.id} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Start a background check">
            <StartBgv employees={candidates.map((e) => ({ value: e.id, label: `${e.employeeNumber} · ${e.displayName}` }))} checks={[...BGV_CHECKS]} />
          </Card>
        </>
      ) : null}
    </>
  );
}
