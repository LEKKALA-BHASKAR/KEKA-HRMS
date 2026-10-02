import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR } from "@keka/shared";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { recordDamageRecoveryAction, recoverAssetAction } from "@/app/actions/assets";
import { FilterForm, ModalButton } from "../_ui";
import { FSelect, FSearch, Pager, pageOf, PAGE_SIZE, Toolbar, Segments, EmptyList, condLabel, fmt, qs } from "../_parts";
import { RecoverFields } from "../_menu";
import { AuditDrawer } from "../_drawers";
import { recoveryWhere, recoveryInclude } from "../_queries";
import s from "../assets.module.css";

/**
 * Damage Recovery: assets that came back damaged with a charge on the
 * employee. A charge is recovered through the open payroll run, or recorded
 * as collected some other way; one still open when the employee leaves is
 * taken in the final settlement. "Record recovery" recovers an asset someone
 * holds and sets its charge in one step.
 */

const P = PERMISSIONS;
type SP = Record<string, string | undefined>;
const money = (v: unknown) => formatINR(Number(v ?? 0)).replace(/\.00$/, "");
const STATUS_OPTIONS = [{ value: "CONFIRMED", label: "Confirmed" }, { value: "PROBATION", label: "Probation" }, { value: "NOTICE_PERIOD", label: "Notice period" }, { value: "EXITED", label: "Exited" }];

export default async function DamageRecoveryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;
  const done = sp.tab === "recovered";
  const filters = { tab: done ? "recovered" : undefined, dept: sp.dept, estatus: sp.estatus, q: sp.q };
  const here = `/assets/recovery${qs({ ...filters, page: sp.page })}`;
  const join = here.includes("?") ? "&" : "?";
  const where = recoveryWhere(viewer, filters);
  const canAssign = can(viewer, P.ASSET_ASSIGN), canPayroll = can(viewer, P.PAYROLL_RUN);

  const [depts, total, sum, pendingTotal] = await Promise.all([
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.assetAssignment.count({ where }),
    prisma.assetAssignment.aggregate({ where, _sum: { damageCharge: true } }),
    prisma.assetAssignment.aggregate({ where: recoveryWhere(viewer, {}), _sum: { damageCharge: true }, _count: true }),
  ]);
  const page = pageOf(sp.page, total);
  const rows = await prisma.assetAssignment.findMany({ where, include: recoveryInclude, orderBy: { returnedOn: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE });
  const openRuns = canPayroll && !done ? new Set((await prisma.payrollRun.findMany({
    where: { tenantId, status: { in: ["DRAFT", "IN_PROGRESS"] }, payGroupId: { in: rows.map((r) => r.employee.payGroupId).filter((x): x is string => !!x) } },
    select: { payGroupId: true },
  })).map((r) => r.payGroupId)) : new Set<string>();
  // What can be recovered right now, for "Record recovery".
  const held = canAssign && !done ? await prisma.assetAssignment.findMany({
    where: { returnedOn: null, asset: { tenantId }, employee: scopedEmployeeWhere(viewer, P.ASSET_ASSIGN) as Prisma.EmployeeWhereInput },
    include: { asset: { include: { assetType: true } }, employee: { select: { displayName: true, employeeNumber: true } } },
    orderBy: [{ employee: { firstName: "asc" } }, { assignedOn: "desc" }], take: 500,
  }) : [];

  return (
    <>
      <Segments items={[
        { label: "Pending Recovery", href: "/assets/recovery", on: !done },
        { label: "Recovered", href: "/assets/recovery?tab=recovered", on: done },
      ]} />
      <div className={s.pageHead}>
        <div>
          <h1 className={s.pageTitle}>{done ? "Recovered damage charges" : "Damage charges to recover"}</h1>
          <p className={s.pageSub}>
            {done ? "Charges already deducted in payroll, collected, or settled at exit." : `${pendingTotal._count} charge${pendingTotal._count === 1 ? "" : "s"} worth ${money(pendingTotal._sum.damageCharge)} still to recover. Any left open when an employee leaves is recovered in their final settlement.`}
          </p>
        </div>
        {canAssign && !done ? (
          <ModalButton label="Record Recovery" className={s.btnOutline} title="Recover an asset with a damage charge" action={recoverAssetAction} submitLabel="Recover">
            {held.length === 0 ? <p className="text-sm muted">No one you look after holds an asset right now.</p> : (
              <div className="field">
                <label className="label" htmlFor="rec-asg">Asset</label>
                <select id="rec-asg" name="assignmentId" className="select" required defaultValue="">
                  <option value="" disabled>Select the asset being returned…</option>
                  {held.map((h) => <option key={h.id} value={h.id}>{h.asset.name ?? h.asset.assetType.name} ({h.asset.assetTag}) — {h.employee.displayName} ({h.employee.employeeNumber})</option>)}
                </select>
              </div>
            )}
            <RecoverFields condition="DAMAGED" />
          </ModalButton>
        ) : null}
      </div>

      <FilterForm>
        {done ? <input type="hidden" name="tab" value="recovered" /> : null}
        <FSelect name="dept" label="Department" value={sp.dept} options={depts.map((d) => ({ value: d.id, label: d.name }))} />
        <FSelect name="estatus" label="Employee Status" value={sp.estatus} options={STATUS_OPTIONS} />
        <FSearch value={sp.q} placeholder="Search asset or employee" clearHref={[sp.dept, sp.estatus, sp.q].some(Boolean) ? (done ? "/assets/recovery?tab=recovered" : "/assets/recovery") : null} />
      </FilterForm>
      <div className={s.tableCard}>
        <Toolbar total={total} exportHref={`/assets/export${qs({ view: "recovery", ...filters })}`}
          left={total ? <span className="text-sm">Total charges: <strong>{money(sum._sum.damageCharge)}</strong></span> : undefined} />
        {rows.length === 0 ? (
          <EmptyList title={done ? "Nothing recovered yet" : "No damage charges to recover"}>{done ? "Recovered charges will be listed here." : "When an asset comes back damaged with a charge, it is listed here."}</EmptyList>
        ) : (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Asset</th><th>Employee</th><th>Department</th><th>Returned On</th><th>Condition Out → In</th><th>Damage Charge</th><th>Note</th><th>Actions</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const inRun = !!r.employee.payGroupId && openRuns.has(r.employee.payGroupId);
                    return (
                      <tr key={r.id}>
                        <td><Link className={s.link} href={`/assets/${r.assetId}`}>{r.asset.name ?? r.asset.assetType.name}</Link><span className={s.sub}>{r.asset.assetTag}</span></td>
                        <td><Link className={s.link} href={`/employees/${r.employee.id}?tab=assets`}>{r.employee.displayName}</Link><span className={s.sub}>{r.employee.employeeNumber}{r.employee.status === "EXITED" ? " · Exited" : ""}</span></td>
                        <td>{r.employee.department?.name ?? "Not Available"}</td>
                        <td className="nowrap">{fmt(r.returnedOn)}</td>
                        <td className="nowrap">{condLabel(r.conditionOut)} → {condLabel(r.conditionIn)}</td>
                        <td className="num nowrap">{money(r.damageCharge)}</td>
                        <td className="text-sm" style={{ maxWidth: 260 }}>{r.damageNote ?? "—"}</td>
                        <td>
                          <span className={s.decide}>
                            {done ? <span className="badge success">Recovered</span> : (
                              <>
                                {canPayroll ? (
                                  inRun ? (
                                    <ModalButton label="Deduct in payroll" className={s.linkish} title="Recover through payroll" action={recordDamageRecoveryAction} hidden={{ assignmentId: r.id, method: "PAYROLL" }} submitLabel="Add deduction">
                                      <p className="text-sm">{money(r.damageCharge)} is added as a non-taxable deduction for {r.employee.displayName} in the open payroll run, which is then recalculated.</p>
                                    </ModalButton>
                                  ) : <span className="text-xs muted" title="Payroll can deduct it once a run is open for this employee's pay group">No open payroll run</span>
                                ) : null}
                                {canAssign ? (
                                  <ModalButton label="Mark recovered" className={s.linkish} title="Record a recovery" action={recordDamageRecoveryAction} hidden={{ assignmentId: r.id, method: "COLLECTED" }} submitLabel="Save">
                                    <p className="text-sm muted">{r.employee.displayName} · {r.asset.assetTag} · {money(r.damageCharge)}</p>
                                    <div className="field">
                                      <label className="label" htmlFor={`col-${r.id}`}>How was it collected?</label>
                                      <input id={`col-${r.id}`} name="note" className="input" required minLength={3} maxLength={300} placeholder="e.g. Paid by UPI on 2 Oct, ref 4471" />
                                    </div>
                                  </ModalButton>
                                ) : null}
                              </>
                            )}
                            <Link className={s.link} href={`${here}${join}audit=${r.assetId}`} scroll={false}>History</Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager total={total} page={page} href={(p) => `/assets/recovery${qs(filters, { page: String(p) })}`} />
          </>
        )}
      </div>

      {sp.audit ? <AuditDrawer viewer={viewer} assetId={sp.audit} closeHref={here} /> : null}
    </>
  );
}
