import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireDepthConfig } from "@keka/services";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { ActButton } from "@/components/growth-forms";
import { runHireAlertsAction, resolveHireAlertAction } from "@/app/actions/hire-ops";
import { requireAnyOf } from "@/lib/hire-depth";
import { TaskTabs, when, pretty } from "../_parts/depth-tabs";

export const metadata = { title: "Hiring exceptions · Hire" };

const LINK: Record<string, (id: string) => string> = {
  Application: (id) => `/hiring/applications/${id}`, Requisition: () => "/hiring/requisitions", Interview: () => "/hiring/interviews",
  Offer: (id) => `/hiring/offers/${id}`, TalentPool: (id) => `/hiring/pools/${id}`, Candidate: (id) => `/hiring/candidates/${id}`,
};

/**
 * Hire › Exceptions: everything the hiring alert job has flagged — SLA
 * breaches (screening, feedback, offer response, requisition approval),
 * candidates stuck in a stage, ageing requisitions, expiring pool members
 * and consents — until someone resolves it.
 */
export default async function HiringExceptionsPage({ searchParams }: { searchParams: Promise<{ kind?: string; all?: string }> }) {
  const viewer = await requireAnyOf([PERMISSIONS.JOB_MANAGE, PERMISSIONS.CANDIDATE_MANAGE]);
  const sp = await searchParams;
  const [alerts, byKind, cfg, setting] = await Promise.all([
    prisma.hireAlert.findMany({ where: { tenantId: viewer.tenantId, ...(sp.all ? {} : { resolvedAt: null }), ...(sp.kind ? { kind: sp.kind } : {}) }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.hireAlert.groupBy({ by: ["kind"], where: { tenantId: viewer.tenantId, resolvedAt: null }, _count: { _all: true } }),
    hireDepthConfig(viewer.tenantId),
    prisma.hireDepthSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { alertsLastRunAt: true } }),
  ]);
  return (
    <>
      <TaskTabs />
      <PageHead title="Exceptions & SLAs" subtitle={`Screening within ${cfg.screenSlaHours}h · feedback within ${cfg.feedbackSlaHours}h · offer answers within ${cfg.offerResponseSlaHours}h · requisition approvals within ${cfg.requisitionApprovalSlaHours}h · requisitions older than ${cfg.requisitionMaxAgeDays} days.`}
        actions={<><span className="text-xs subtle">Last run {when(setting?.alertsLastRunAt)}</span><ActButton action={runHireAlertsAction} hidden={{}} label="Check now" variant="primary" /></>} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {byKind.length === 0 ? <Stat label="Open exceptions" value={0} /> : byKind.map((k) => (
          <Link key={k.kind} href={`?kind=${k.kind}`}><Stat label={pretty(k.kind)} value={k._count._all} tone="neg" /></Link>
        ))}
      </div>
      <div className="row gap-2" style={{ marginBottom: 8 }}>
        <Link className={`btn sm${!sp.all ? " primary" : ""}`} href="?">Open</Link>
        <Link className={`btn sm${sp.all ? " primary" : ""}`} href="?all=1">Including resolved</Link>
        {sp.kind ? <Link className="btn sm" href={sp.all ? "?all=1" : "?"}>Clear filter</Link> : null}
      </div>
      <Card tight>
        {alerts.length === 0 ? <Empty title="All clear">No hiring exceptions are open.</Empty> : (
          <div className="table-wrap">
            <table className="data" data-testid="exception-table">
              <thead><tr><th>Exception</th><th>Kind</th><th>Raised</th><th>Status</th><th /></tr></thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>{LINK[a.entityType] ? <Link href={LINK[a.entityType]!(a.entityId)}>{a.message}</Link> : a.message}</td>
                    <td>{pretty(a.kind)}</td>
                    <td className="nowrap">{when(a.createdAt)}</td>
                    <td>{a.resolvedAt ? <Badge tone="success">Resolved</Badge> : <Badge tone="danger">Open</Badge>}</td>
                    <td className="right">{a.resolvedAt ? null : <ActButton action={resolveHireAlertAction} hidden={{ id: a.id }} label="Resolve" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
