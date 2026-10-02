import Link from "next/link";
import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { parseApprovalChain, APPROVAL_ROLE_LABEL, type ApprovalChainConfig } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { Card, Badge, Empty, Callout } from "@/components/ui";
import { ApprovalChainForm, AutoApproveButton, GrantCompOffForm, OptionalQuotaForm } from "../_time/policy-forms";
import { Disclosure } from "../org/forms";

/**
 * Leave admin tabs for policy depth: approval chains per plan and type, and
 * comp-off grants. The optional-holiday quota sits on the holidays tab.
 */

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

const describe = (c: ApprovalChainConfig | null) => !c ? null
  : `${c.levels.map((l) => APPROVAL_ROLE_LABEL[l]).join(" → ")}${c.autoApproveAfterDays ? ` · auto-approve after ${c.autoApproveAfterDays}d` : ""}${c.skipSamePerson ? "" : " · no skipping"}`;

export async function ApprovalsTab({ tenantId }: { tenantId: string }) {
  const [plans, types, pending] = await Promise.all([
    prisma.leavePlan.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, approvalChain: true, types: { select: { leaveTypeId: true } } } }),
    prisma.leaveType.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true, approvalChain: true } }),
    prisma.leaveRequest.count({ where: { tenantId, status: "PENDING", approvalSteps: { not: Prisma.DbNull } } }),
  ]);
  return (
    <div className="stack gap-4">
      <Callout tone="info" title="How approval works">
        With no chain, any one person who may approve leave for the employee decides it — the default. A chain routes each new
        request through up to three levels in order; a level with nobody in the seat, or the employee themselves, is skipped.
        HR can always act at any level. A leave type&apos;s chain overrides its plan&apos;s. Requests already raised keep the chain they started with.
      </Callout>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {plans.map((p) => {
          const chain = parseApprovalChain(p.approvalChain);
          return (
            <Card key={p.id} title={`Plan: ${p.name}`} description={describe(chain) ?? "Single decision (default)"}>
              <Disclosure label={chain ? "Edit chain" : "Add a chain"} variant="default">
                <ApprovalChainForm target="plan" id={p.id} chain={chain} />
              </Disclosure>
            </Card>
          );
        })}
      </div>
      <Card tight title="Per leave type" description="Overrides the plan for one type, e.g. long leave needs HR too.">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Leave type</th><th>Chain</th><th /></tr></thead>
            <tbody>
              {types.map((t) => {
                const chain = parseApprovalChain(t.approvalChain);
                return (
                  <tr key={t.id}>
                    <td><span className="strong">{t.name}</span> <span className="mono text-xs subtle">{t.code}</span></td>
                    <td className="text-sm">{describe(chain) ?? <span className="subtle">From the plan</span>}</td>
                    <td style={{ minWidth: 420 }}>
                      <Disclosure label={chain ? "Edit" : "Override"} variant="default">
                        <ApprovalChainForm target="type" id={t.id} chain={chain} />
                      </Disclosure>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Auto-approval" description={pending ? `${pending} pending request(s) are on a chain.` : undefined}>
        <AutoApproveButton />
      </Card>
    </div>
  );
}

export async function CompOffTab({ viewer }: { viewer: Viewer }) {
  const approve = can(viewer, P.LEAVE_MANAGE) ? P.LEAVE_MANAGE : P.LEAVE_APPROVE;
  const [type, employees, grants] = await Promise.all([
    prisma.leaveType.findFirst({ where: { tenantId: viewer.tenantId, category: "COMP_OFF", isActive: true }, orderBy: { createdAt: "asc" } }),
    prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, approve), status: { notIn: ["EXITED", "INACTIVE", "PREBOARDING"] }, id: { not: viewer.employee?.id ?? "__none__" } },
      select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
    }),
    prisma.leaveLedgerEntry.findMany({
      where: { tenantId: viewer.tenantId, kind: "COMP_OFF_CREDIT", OR: [{ periodKey: { startsWith: "COMPOFF-GRANT:" } }, { periodKey: { startsWith: "COMPOFF-AUTO:" } }] },
      orderBy: { createdAt: "desc" }, take: 30,
    }),
  ]);
  const names = new Map((await prisma.employee.findMany({
    where: { tenantId: viewer.tenantId, id: { in: [...new Set(grants.map((g) => g.employeeId))] } }, select: { id: true, displayName: true, employeeNumber: true },
  })).map((e) => [e.id, e]));
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <Card title="Grant comp-off" description={type
        ? `Credits ${type.name}${type.expiryDaysAfterCredit ? `, expiring ${type.expiryDaysAfterCredit} days later unless you set a date` : ""}. Usable like any other leave balance.`
        : undefined}>
        {type ? <GrantCompOffForm employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }))} />
          : <Empty title="No comp-off leave type">Create a leave type in the Comp off category first.</Empty>}
      </Card>
      <Card tight title="Recent grants and automatic credits" description="Automatic credits come from worked weekly offs and holidays when the attendance policy turns them on.">
        {grants.length === 0 ? <Empty title="No comp-off granted yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Employee</th><th className="num">Days</th><th>Source</th><th>Expires</th></tr></thead>
              <tbody>
                {grants.map((g) => {
                  const e = names.get(g.employeeId);
                  return (
                    <tr key={g.id}>
                      <td className="nowrap text-sm">{formatDate(g.createdAt)}</td>
                      <td className="text-sm"><Link href={`/leave?tab=balances&emp=${g.employeeId}`}>{e?.displayName ?? "—"}</Link></td>
                      <td className="num pos">+{n(g.days)}</td>
                      <td><Badge tone={g.periodKey?.startsWith("COMPOFF-AUTO:") ? "info" : "neutral"}>{g.periodKey?.startsWith("COMPOFF-AUTO:") ? "worked off day" : "granted"}</Badge>
                        <div className="text-xs subtle">{g.note}</div></td>
                      <td className="nowrap text-sm">{g.expiresOn ? formatDate(g.expiresOn) : "never"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** The quota line under a holiday calendar, and how many people have picked. */
export async function OptionalHolidayQuota({ calendarId, quota, canEdit }: { calendarId: string; quota: number; canEdit: boolean }) {
  const picks = await prisma.optionalHolidaySelection.groupBy({ by: ["holidayId"], where: { holiday: { calendarId } }, _count: { _all: true } });
  const total = picks.reduce((s, p) => s + p._count._all, 0);
  return (
    <>
      <div className="text-sm muted" style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
        {quota > 0 ? `Employees may pick ${quota} optional holiday(s) from this calendar. ${total} pick(s) so far.` : "Optional holidays are off for this calendar — set a quota so employees can pick them."}
      </div>
      {canEdit ? <OptionalQuotaForm calendarId={calendarId} quota={quota} /> : null}
    </>
  );
}

/** Pick counts per optional holiday, for the holidays table. */
export async function optionalPickCounts(calendarId: string): Promise<Map<string, number>> {
  const picks = await prisma.optionalHolidaySelection.groupBy({ by: ["holidayId"], where: { holiday: { calendarId } }, _count: { _all: true } });
  return new Map(picks.map((p) => [p.holidayId, p._count._all]));
}
