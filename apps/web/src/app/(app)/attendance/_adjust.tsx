import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { can, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere, scopedEmployeeIds, inScope } from "@/lib/scope";
import { Card, Badge, Empty } from "@/components/ui";
import {
  EditDayForm, LopImportForm, ShiftAllowanceRunForm, ShiftAllowanceRateForm, TimePolicyDepthForm,
} from "../_time/policy-forms";

/**
 * Attendance › Adjustments: an administrator's tools for what processing
 * cannot know — a corrected day, LOP days from outside, the month's shift
 * allowance — and the comp-off and overtime rules of each policy.
 */

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export async function AdjustTab({ viewer }: { viewer: Viewer }) {
  const now = new Date();
  const year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
  const scopeIds = await scopedEmployeeIds(viewer, P.ATTENDANCE_MANAGE);
  const [employees, edits, imports, shifts, allowances, policies] = await Promise.all([
    prisma.employee.findMany({
      where: { ...scopedEmployeeWhere(viewer, P.ATTENDANCE_MANAGE), status: { notIn: ["EXITED", "PREBOARDING"] } },
      select: { id: true, displayName: true, employeeNumber: true }, orderBy: { employeeNumber: "asc" },
    }),
    prisma.attendanceRecord.findMany({
      where: { tenantId: viewer.tenantId, editedAt: { not: null }, ...inScope(scopeIds) },
      orderBy: { editedAt: "desc" }, take: 15,
    }),
    prisma.lopAdjustment.findMany({
      where: { tenantId: viewer.tenantId, source: "IMPORT", ...inScope(scopeIds) }, orderBy: { createdAt: "desc" }, take: 15,
    }),
    prisma.shift.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.shiftAllowanceEntry.findMany({
      where: { tenantId: viewer.tenantId, ...inScope(scopeIds), OR: [{ year, month }, { isGenerated: true, isProcessed: false }] },
      orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }], take: 30,
    }),
    prisma.attendancePolicy.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const people = new Map(employees.map((e) => [e.id, e]));
  const nameOf = (id: string) => people.get(id)?.displayName ?? "—";
  const options = employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName}` }));

  return (
    <div className="stack gap-4">
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Edit a day" description="Replace the punches or pin the status, with a reason. Everything is kept in the audit log; replaced punches are kept as rejected.">
          <EditDayForm employees={options} defaultDate={now.toISOString().slice(0, 10)} />
        </Card>
        <Card tight title="Recent edits">
          {edits.length === 0 ? <Empty title="No days edited yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Day</th><th>Employee</th><th>Now</th><th>Reason</th></tr></thead>
                <tbody>
                  {edits.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap text-sm">{formatDate(r.date)}</td>
                      <td className="text-sm">{nameOf(r.employeeId)}</td>
                      <td>
                        <Badge tone={n(r.lopValue) > 0 ? "danger" : "success"}>{label(r.status)}</Badge>
                        {r.manualStatus ? <div className="text-xs subtle">pinned</div> : null}
                      </td>
                      <td className="text-xs muted" style={{ maxWidth: 220 }}>{r.editReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Import LOP days" description="One row per employee per month. Each row replaces that month's manual LOP for the employee (reversals are kept); 0 clears it. Payroll for the month reads these days. Check first — nothing is written while any row has a problem.">
          <LopImportForm />
        </Card>
        <Card tight title="Recently imported LOP">
          {imports.length === 0 ? <Empty title="Nothing imported yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Month</th><th>Employee</th><th className="num">Days</th><th>Note</th><th>Run</th></tr></thead>
                <tbody>
                  {imports.map((a) => (
                    <tr key={a.id}>
                      <td className="mono text-sm">{a.year}-{String(a.month).padStart(2, "0")}</td>
                      <td className="text-sm">{nameOf(a.employeeId)}</td>
                      <td className="num">{n(a.days)}</td>
                      <td className="text-xs muted">{a.note}</td>
                      <td className="text-xs">{a.runId ? <Badge tone="info">in a run</Badge> : <span className="subtle">next run</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title="Shift allowance rates" description="A shift with a code and a rate earns that much per day worked on it.">
          {shifts.length === 0 ? <Empty title="No shifts" /> : shifts.map((s) => (
            <div key={s.id}>
              <div className="row gap-2" style={{ padding: "10px 14px 0" }}>
                <span className="strong">{s.name}</span><span className="mono text-xs subtle">{s.code} · {s.startTime}–{s.endTime}</span>
                {s.allowanceCode ? <Badge tone="info">{s.allowanceCode} · {formatINR(n(s.allowancePerDay))}/day</Badge> : null}
              </div>
              {can(viewer, P.SHIFT_MANAGE) ? <ShiftAllowanceRateForm shiftId={s.id} code={s.allowanceCode} perDay={s.allowancePerDay === null ? null : n(s.allowancePerDay)} /> : null}
            </div>
          ))}
        </Card>
        <Card title="Create the month's shift allowance" description="Counts processed attendance — present, half, on duty and WFH days on an allowance shift — into one payroll entry per employee per shift. Re-running replaces entries not yet paid.">
          <ShiftAllowanceRunForm year={year} month={month} />
          {allowances.length === 0 ? null : (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data">
                <thead><tr><th>Month</th><th>Employee</th><th>Shift</th><th className="num">Days</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {allowances.map((a) => (
                    <tr key={a.id}>
                      <td className="mono text-sm">{a.year}-{String(a.month).padStart(2, "0")}</td>
                      <td className="text-sm">{nameOf(a.employeeId)}</td>
                      <td className="mono text-xs">{a.shiftCode}{a.allowanceCode ? ` · ${a.allowanceCode}` : ""}</td>
                      <td className="num">{n(a.days)}</td>
                      <td className="num">{formatINR(n(a.amount))}</td>
                      <td>{a.isProcessed ? <Badge tone="success">paid</Badge> : <Badge>{a.payAction.toLowerCase()}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card tight title="Comp-off and overtime rules" description="Per attendance policy.">
        {policies.length === 0 ? <Empty title="No attendance policies" /> : policies.map((p) => (
          <div key={p.id} style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
            <div className="strong" style={{ marginBottom: 8 }}>{p.name}{p.isDefault ? <> <Badge tone="info">default</Badge></> : null}</div>
            <TimePolicyDepthForm policy={{
              id: p.id, autoCreditCompOff: p.autoCreditCompOff, overtimeMultiplier: n(p.overtimeMultiplier),
              overtimeOffDayMultiplier: n(p.overtimeOffDayMultiplier), overtimeRoundingMinutes: p.overtimeRoundingMinutes,
            }} />
          </div>
        ))}
      </Card>
    </div>
  );
}
