import Link from "next/link";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { approvalsWaitingOn } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { ApprovalDecision, WithdrawRequest } from "../_forms/approvals";

const P = PERMISSIONS;

/**
 * Payroll approvals: payroll locks and salary changes climbing their
 * approval chains. Each row shows where it is in the chain; the ones waiting
 * on a role you hold can be decided here.
 */
export default async function PayrollApprovalsPage() {
  const viewer = await requireViewer();
  const all = await approvalsWaitingOn(viewer.tenantId, viewer.user.id);
  const seesAll = can(viewer, P.PAYROLL_VIEW) || can(viewer, P.SALARY_REVISE);
  const rows = seesAll ? all : all.filter((r) => r.mine || r.requestedBy === viewer.user.id);
  if (!seesAll && rows.length === 0 && !can(viewer, P.PAYROLL_APPROVE)) forbidden();
  const roleIds = [...new Set(rows.flatMap((r) => r.payload.chain ?? []))];
  const userIds = [...new Set(rows.map((r) => r.requestedBy))];
  const [roles, users, revisions] = await Promise.all([
    prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, employee: { select: { displayName: true } } } }),
    prisma.salaryRevision.findMany({
      where: { id: { in: rows.map((r) => r.payload.revisionId).filter((x): x is string => !!x) } },
      include: { employee: { select: { id: true, displayName: true, employeeNumber: true } } },
    }),
  ]);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const userName = new Map(users.map((u) => [u.id, u.employee?.displayName ?? u.email]));
  const revOf = new Map(revisions.map((r) => [r.id, r]));
  const mine = rows.filter((r) => r.mine);

  return (
    <>
      <PageHead title="Payroll approvals" subtitle="Payroll locks and salary changes waiting on their approval chain. Nobody approves their own request." />
      <Card tight title={`Waiting on you (${mine.length})`}>
        {rows.length === 0 ? <Empty title="Nothing is waiting for approval" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Request</th><th>Raised by</th><th>Chain</th><th /></tr></thead>
              <tbody>
                {[...mine, ...rows.filter((r) => !r.mine)].map((r) => {
                  const rev = r.payload.revisionId ? revOf.get(r.payload.revisionId) : undefined;
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.label}</strong>
                        {rev ? (
                          <div className="text-xs muted">
                            <Link href={`/employees/${rev.employee.id}?tab=finances`}>{rev.employee.displayName}</Link> · {Number(rev.previousCtc ?? 0).toLocaleString("en-IN")} → {Number(rev.annualCtc).toLocaleString("en-IN")}{rev.reason ? ` · ${rev.reason}` : ""}
                          </div>
                        ) : r.run ? <div className="text-xs muted"><Link href={`/payroll/runs/${r.run.id}`}>{r.run.payGroup.name}</Link></div> : null}
                      </td>
                      <td className="text-sm">{userName.get(r.requestedBy)}<div className="text-xs subtle">{formatDate(r.requestedAt)}</div></td>
                      <td className="text-sm">
                        {(r.payload.chain ?? []).map((id, i) => (
                          <span key={i} style={{ marginRight: 6 }}>
                            <Badge tone={i < r.currentLevel ? "success" : i === r.currentLevel ? "warning" : "neutral"}>{i + 1}. {roleName.get(id) ?? "Role"}</Badge>
                          </span>
                        ))}
                      </td>
                      <td className="right">
                        {r.mine ? <ApprovalDecision requestId={r.id} /> : r.requestedBy === viewer.user.id ? <WithdrawRequest requestId={r.id} /> : <span className="text-xs subtle">Waiting on {roleName.get(r.payload.chain?.[r.currentLevel] ?? "") ?? "the next level"}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
