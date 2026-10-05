import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { withEmployeeNames } from "@/lib/core2";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { SpecForm, SpecDisclosure } from "@/components/spec-form";
import { editScheduledMoveAction } from "@/app/actions/core2-people";

export const metadata = { title: "Employee movements — BooS-HR" };

const P = PERMISSIONS;
const REASONS = ["NEW_HIRE", "PROMOTION", "TRANSFER", "DEPARTMENT_CHANGE", "LOCATION_CHANGE", "MANAGER_CHANGE", "CONFIRMATION", "DEMOTION", "WORKER_TYPE_CHANGE"];

type SP = { from?: string; to?: string; reason?: string; status?: string };
const day = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null);

/**
 * Every promotion, transfer and reporting change in a period: applied,
 * scheduled and awaiting approval, with the units involved. Scheduled moves
 * can be re-dated or cancelled before they take effect.
 */
export default async function MovementsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const sp = await searchParams;
  const now = new Date();
  const from = day(sp.from) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const to = day(sp.to) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0));
  const t = viewer.tenantId;
  const inScope = await prisma.employee.findMany({ where: { AND: [{ tenantId: t }, scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE)] }, select: { id: true } });
  const rows = await prisma.jobChange.findMany({
    where: {
      tenantId: t, effectiveFrom: { gte: from, lte: to }, employeeId: { in: inScope.map((e) => e.id) },
      ...(sp.reason && REASONS.includes(sp.reason) ? { reason: sp.reason as never } : {}),
      ...(sp.status ? { status: sp.status as never } : { status: { in: ["APPLIED", "SCHEDULED", "PENDING_APPROVAL"] } }),
    },
    orderBy: { effectiveFrom: "desc" },
    take: 500,
  }).then((r) => withEmployeeNames(r));
  const [depts, locs, people, entities] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { tenantId: t, id: { in: rows.map((r) => r.reportingManagerId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } }),
    prisma.legalEntity.findMany({ where: { tenantId: t }, select: { id: true, name: true } }),
  ]);
  const name = new Map<string, string>([...depts, ...locs, ...entities].map((x) => [x.id, x.name]));
  for (const p of people) name.set(p.id, p.displayName ?? "");
  const what = (r: (typeof rows)[number]) => [r.departmentId && `department → ${name.get(r.departmentId)}`, r.locationId && `location → ${name.get(r.locationId)}`, r.reportingManagerId && `manager → ${name.get(r.reportingManagerId)}`, r.legalEntityId && `entity → ${name.get(r.legalEntityId)}`].filter(Boolean).join(", ");
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const qs = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), ...(sp.reason ? { reason: sp.reason } : {}), ...(sp.status ? { status: sp.status } : {}) });
  return (
    <>
      <PageHead title="Employee movements" subtitle="Promotions, transfers and reporting changes in a period" actions={<><Link className="btn" href="/hr-ops/desk">HR desk</Link><a className="btn" href={`/exports/core2/movements?${qs}`}>Export CSV</a></>} />
      <form method="get" className="row gap-2 wrap" style={{ marginBottom: 12 }}>
        <input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} />
        <input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} />
        <select className="select" name="reason" defaultValue={sp.reason ?? ""}><option value="">All kinds</option>{REASONS.map((r) => <option key={r} value={r}>{r.toLowerCase().replace(/_/g, " ")}</option>)}</select>
        <select className="select" name="status" defaultValue={sp.status ?? ""}><option value="">Applied, scheduled, pending</option>{["APPLIED", "SCHEDULED", "PENDING_APPROVAL", "REJECTED", "WITHDRAWN"].map((s) => <option key={s} value={s}>{s.toLowerCase().replace("_", " ")}</option>)}</select>
        <button className="btn" type="submit">Show</button>
      </form>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Movements" value={rows.length} />
        <Stat label="Applied" value={count("APPLIED")} />
        <Stat label="Scheduled" value={count("SCHEDULED")} />
        <Stat label="Awaiting approval" value={count("PENDING_APPROVAL")} />
      </div>
      <Card title={`${formatDate(from)} – ${formatDate(to)}`}>
        {rows.length ? (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Effective</th><th>Person</th><th>Kind</th><th>Change</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{formatDate(r.effectiveFrom)}</td>
                <td><Link href={`/employees/${r.employee.id}?tab=job`}>{r.employee.displayName}</Link> <span className="muted text-xs">{r.employee.employeeNumber}</span></td>
                <td className="text-sm">{r.reason.toLowerCase().replace(/_/g, " ")}</td>
                <td className="text-sm">{what(r) || r.note || "—"}</td>
                <td><Badge tone={r.status === "APPLIED" ? "success" : r.status === "SCHEDULED" ? "info" : "neutral"}>{r.status.toLowerCase().replace("_", " ")}</Badge></td>
                <td>{r.status === "SCHEDULED" ? <SpecDisclosure label="Change"><SpecForm compact action={editScheduledMoveAction} hidden={{ id: r.id }} fields={[{ name: "effectiveFrom", label: "New date", kind: "date", required: true, defaultValue: r.effectiveFrom.toISOString().slice(0, 10) }, { name: "note", label: "Note", defaultValue: r.note }, { name: "cancel", label: "Cancel the move instead", kind: "checkbox" }]} /></SpecDisclosure> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No movements in this period" />}
      </Card>
    </>
  );
}
