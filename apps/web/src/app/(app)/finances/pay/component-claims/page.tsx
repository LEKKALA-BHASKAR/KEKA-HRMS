import { prisma } from "@keka/db";
import { formatDate, formatINR, fyRange, fyStartYear, MONTH_SHORT } from "@keka/shared";
import { componentClaimSummary } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { Chip, EmptyState } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { NavSelect } from "../../_components/nav-select";
import { ClaimButton, WithdrawButton } from "../../_components/claims";
import { fySpan } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Component Claim" };

const n = (v: unknown) => Number(v ?? 0);
const money = (v: number) => `INR ${formatINR(v, false)}`;
const STATUS: Record<string, { label: string; kind: string }> = {
  APPROVED: { label: "Approved", kind: "current" }, PAID: { label: "Paid", kind: "verified" }, REJECTED: { label: "Rejected", kind: "closed" },
};

function Pager({ count }: { count: number }) {
  return (
    <div className={s.pager} aria-label="Pagination">
      <span>{count === 0 ? "0 to 0 of 0" : `1 to ${count} of ${count}`}</span>
      <span className={s.pagerArrows} aria-hidden="true">|‹ ‹</span>
      <span>Page {count === 0 ? "0 of 0" : "1 of 1"}</span>
      <span className={s.pagerArrows} aria-hidden="true">› ›|</span>
    </div>
  );
}

/**
 * Component Claims: what each flexible-benefit reimbursement allows this year,
 * what has accrued so far, what is claimed and what is left — and the claims
 * still waiting on the payroll team.
 */
export default async function ComponentClaimsPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const fyStartMonth = viewer.tenant.fyStartMonth;
  const currentFy = fyStartYear(new Date(), fyStartMonth);
  const emp = await prisma.employee.findFirst({ where: { id: viewer.employee.id, tenantId: viewer.tenantId }, select: { dateOfJoining: true } });
  const joinedFy = fyStartYear(emp?.dateOfJoining ?? new Date(), fyStartMonth);
  const years = Array.from({ length: Math.max(1, Math.min(4, currentFy - joinedFy + 1)) }, (_, i) => currentFy - i);
  const raw = Number((await searchParams).fy);
  const fy = years.includes(raw) ? raw : currentFy;
  const data = await componentClaimSummary(viewer.employee.id, fy);
  const today = new Date();
  const { start } = fyRange(fy, fyStartMonth);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const nameOf = new Map(data.rows.map((r) => [r.componentId, r.name]));

  return (
    <>
      <div className={s.titleRow}>
        <h1 className={s.bigTitle}>Component Claims Summary</h1>
        <NavSelect label="Financial year" className={s.fySelect} value={String(fy)}
          options={years.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: `/finances/pay/component-claims?fy=${y}` }))} />
      </div>

      <section className={`${s.boxed} ${s.mt}`} aria-label="Component claims summary">
        <div className={s.claimLegend}><span className={s.legendSquare} aria-hidden="true" />Projected amount that can be claimed till the end of FY</div>
        <div className={s.tableScroll}>
          <table className={`${s.table} ${s.flatTable}`}>
            <thead>
              <tr>
                <th scope="col">Component Name</th><th scope="col">Component Type</th><th scope="col">Annual Claim Amount</th>
                <th scope="col">Accrued</th><th scope="col">Claimed</th><th scope="col">Remaining Balance</th><th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr><td colSpan={7} className={s.noRecords}>No records found</td></tr>
              ) : data.rows.map((r) => (
                <tr key={r.componentId}>
                  <td>{r.name}</td>
                  <td>{r.typeLabel}</td>
                  <td className={s.num}><span className={s.projected}><span className={s.legendSquare} aria-label="projected" />{money(r.annual)}</span></td>
                  <td className={s.num}>{money(r.accrued)}</td>
                  <td className={s.num}>{money(r.claimed)}{r.pending > 0 ? <div className={s.muted} style={{ fontSize: 12.5 }}>{money(r.pending)} pending</div> : null}</td>
                  <td className={s.num}>{money(r.remaining)}</td>
                  <td>{fy === currentFy ? <ClaimButton componentId={r.componentId} name={r.name} remaining={r.remaining} today={iso(today)} fyStart={iso(start)} /> : <span className={s.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager count={data.rows.length} />
      </section>

      <h2 className={s.sectionTitle}>Pending Claims</h2>
      <section className={s.boxed} aria-label="Pending claims">
        <div className={s.tableScroll}>
          <table className={`${s.table} ${s.flatTable}`}>
            <thead>
              <tr><th scope="col">Component Name</th><th scope="col">Component Type</th><th scope="col">Claimed Amount</th><th scope="col">Note</th><th scope="col">Claimed On</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {data.pending.length === 0 ? <tr><td colSpan={6} className={s.noRecords}>No records found</td></tr> : data.pending.map((c) => (
                <tr key={c.id}>
                  <td>{c.component.name}</td>
                  <td>Reimbursement</td>
                  <td className={s.num}>{money(n(c.claimedAmount))}</td>
                  <td className={s.noteCell}>{c.comment ?? <span className={s.muted}>—</span>}{c.billNumber ? <div className={s.muted} style={{ fontSize: 12.5 }}>Bill {c.billNumber}{c.billDate ? ` · ${formatDate(c.billDate)}` : ""}</div> : null}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td className={s.actionsCell}>
                    {c.attachmentUrl?.startsWith("/files/") ? <a className={s.link} href={c.attachmentUrl}>View bill</a> : null}
                    <WithdrawButton kind="claim" id={c.id} label={`the ${nameOf.get(c.componentId) ?? c.component.name} claim`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <h2 className={s.sectionTitle}>Processed Claims</h2>
      <section className={s.boxed} aria-label="Processed claims">
        <div className={s.tableScroll}>
          <table className={`${s.table} ${s.flatTable}`}>
            <thead>
              <tr><th scope="col">Component Name</th><th scope="col">Claimed Amount</th><th scope="col">Approved Amount</th><th scope="col">Claimed On</th><th scope="col">Status</th><th scope="col">Paid In</th></tr>
            </thead>
            <tbody>
              {data.processed.length === 0 ? <tr><td colSpan={6} className={s.noRecords}>No records found</td></tr> : data.processed.map((c) => (
                <tr key={c.id}>
                  <td>{c.component.name}{c.status === "REJECTED" && c.reviewerNote ? <div className={s.muted} style={{ fontSize: 12.5 }}>{c.reviewerNote}</div> : null}</td>
                  <td className={s.num}>{money(n(c.claimedAmount))}</td>
                  <td className={s.num}>{c.status === "REJECTED" ? <span className={s.muted}>—</span> : money(n(c.payableAmount ?? c.claimedAmount))}</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td><Chip kind={STATUS[c.status]?.kind ?? "closed"}>{STATUS[c.status]?.label ?? c.status}</Chip></td>
                  <td>{c.payoutYear && c.payoutMonth ? `${MONTH_SHORT[c.payoutMonth - 1]} ${c.payoutYear}` : <span className={s.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
