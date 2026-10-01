import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ASSET_CONDITIONS, ASSET_CONDITION_LABEL } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { remindAcknowledgementAction } from "@/app/actions/assets";
import { FilterForm, Kebab, RemindForm } from "../_ui";
import { FSelect, FSearch, FDate, Pager, pageOf, PAGE_SIZE, Toolbar, Segments, EmptyList, condLabel, fmt, qs } from "../_parts";
import { RequestDrawer, AuditDrawer } from "../_drawers";
import s from "../assets.module.css";

/**
 * Asset Acknowledgement (Keka 17, 18): assignments still waiting for the
 * employee to confirm receipt — select rows and Remind — and those already
 * acknowledged. Assets whose type needs no acknowledgement never appear.
 */

const P = PERMISSIONS;
type SP = Record<string, string | undefined>;
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default async function AcknowledgementsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;
  const done = sp.tab === "completed";
  const from = sp.from ?? isoDay(new Date(Date.now() - 30 * DAY));
  const to = sp.to ?? isoDay(new Date());
  const filters = done ? { tab: "completed", from: sp.from, to: sp.to, emp: sp.emp, cond: sp.cond, q: sp.q } : { emp: sp.emp, cond: sp.cond, q: sp.q };
  const here = `/assets/acknowledgements${qs({ ...filters, page: sp.page })}`;
  const join = here.includes("?") ? "&" : "?";
  const scope = scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput;

  const where: Prisma.AssetAssignmentWhereInput = {
    asset: { tenantId, ...(sp.q ? { OR: [{ assetTag: { contains: sp.q, mode: "insensitive" } }, { name: { contains: sp.q, mode: "insensitive" } }] } : {}) },
    employee: scope,
    ...(sp.emp ? { employeeId: sp.emp } : {}),
    ...(sp.cond ? { conditionOut: sp.cond as Prisma.AssetAssignmentWhereInput["conditionOut"] } : {}),
    ...(done
      ? { ackStatus: "ACKNOWLEDGED", acknowledgedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } }
      : { ackStatus: "PENDING", returnedOn: null }),
  };
  const [holders, total] = await Promise.all([
    prisma.employee.findMany({
      where: { ...scope, assetAssignments: { some: done ? { ackStatus: "ACKNOWLEDGED" } : { ackStatus: "PENDING", returnedOn: null } } },
      select: { id: true, displayName: true }, orderBy: { firstName: "asc" },
    }),
    prisma.assetAssignment.count({ where }),
  ]);
  const page = pageOf(sp.page, total);
  const rows = await prisma.assetAssignment.findMany({
    where, orderBy: done ? { acknowledgedAt: "desc" } : { assignedOn: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    include: { asset: { include: { assetType: true } }, employee: { select: { id: true, displayName: true } } },
  });
  const canRemind = can(viewer, P.ASSET_ASSIGN);
  const exportHref = `/assets/export${qs({ view: done ? "acks-completed" : "acks", ...filters, from: done ? from : undefined, to: done ? to : undefined })}`;

  const filterBar = (
    <FilterForm>
      {done ? <input type="hidden" name="tab" value="completed" /> : null}
      {done ? <FDate name="from" label="Acknowledged on — from" value={from} /> : null}
      {done ? <FDate name="to" label="Acknowledged on — to" value={to} /> : null}
      <FSelect name="emp" label="Assigned To" value={sp.emp} options={holders.map((h) => ({ value: h.id, label: h.displayName ?? "—" }))} />
      <FSelect name="cond" label="Condition" value={sp.cond} options={ASSET_CONDITIONS.map((c) => ({ value: c, label: ASSET_CONDITION_LABEL[c] }))} />
      <FSearch value={sp.q} clearHref={Object.entries(filters).some(([k, v]) => k !== "tab" && v) ? (done ? "/assets/acknowledgements?tab=completed" : "/assets/acknowledgements") : null} />
    </FilterForm>
  );

  return (
    <>
      <Segments items={[
        { label: "Pending Acknowledgements", href: "/assets/acknowledgements", on: !done },
        { label: "Completed Acknowledgements", href: "/assets/acknowledgements?tab=completed", on: done },
      ]} />
      <div className={s.sectionHead}>
        <h1 className={s.sectionTitle}>{done ? "Completed acknowledgements" : "Pending acknowledgements"}</h1>
        <p className={s.sectionSub}>{done ? "This is the list of acknowledged assets within org." : "These are assigned assets yet to be acknowledged by employees."}</p>
      </div>
      {filterBar}

      {done ? (
        <div className={s.tableCard}>
          <Toolbar total={total} exportHref={exportHref} />
          {rows.length === 0 ? (
            <EmptyList title="No acknowledgements found">Assets that are acknowledged will be listed here</EmptyList>
          ) : (
            <>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>Asset ID</th><th>Asset Name</th><th>Assigned To</th><th>Assigned On</th><th>Acknowledged On</th><th>Asset Condition</th><th>Actions</th></tr></thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td>{a.asset.assetTag}</td>
                        <td>{a.asset.name ?? a.asset.assetType.name}</td>
                        <td><Link className={s.link} href={`/employees/${a.employee.id}?tab=assets`}>{a.employee.displayName}</Link></td>
                        <td className="nowrap">{fmt(a.assignedOn)}</td>
                        <td className="nowrap">{fmt(a.acknowledgedAt)}</td>
                        <td>{condLabel(a.conditionOut)}</td>
                        <td>{a.requestId ? <Link className={s.link} href={`${here}${join}view=${a.requestId}`} scroll={false}>View Request</Link> : <Link className={s.link} href={`${here}${join}audit=${a.assetId}`} scroll={false}>View History</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager total={total} page={page} href={(p) => `/assets/acknowledgements${qs(filters, { page: String(p) })}`} />
            </>
          )}
        </div>
      ) : (
        <div className={s.tableCard}>
          <RemindForm action={remindAcknowledgementAction} toolbarRight={<>
            <span className={s.total}>Total: {total}</span>
            <a href={exportHref} className={s.iconBtn} aria-label="Download as CSV" title="Download">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            </a>
          </>}>
            {rows.length === 0 ? (
              <EmptyList title="No pending acknowledgements">Every assigned asset that needs one has been acknowledged.</EmptyList>
            ) : (
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className={s.check}>{canRemind ? <input type="checkbox" data-all aria-label="Select all" /> : null}</th>
                      <th>Asset ID</th><th>Asset Name</th><th>Assigned To</th><th>Assigned On</th><th>Asset Condition</th><th>Last Reminded</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td className={s.check}>{canRemind ? <input type="checkbox" name="ids" value={a.id} aria-label={`Select ${a.asset.assetTag}`} /> : null}</td>
                        <td>{a.asset.assetTag}</td>
                        <td>{a.asset.name ?? a.asset.assetType.name}</td>
                        <td><Link className={s.link} href={`/employees/${a.employee.id}?tab=assets`}>{a.employee.displayName}</Link></td>
                        <td className="nowrap">{fmt(a.assignedOn)}</td>
                        <td>{condLabel(a.conditionOut)}</td>
                        <td className="nowrap">{a.ackRemindedAt ? <>{fmt(a.ackRemindedAt)}<span className={s.sub}>{a.ackRemindCount} reminder{a.ackRemindCount === 1 ? "" : "s"}</span></> : "—"}</td>
                        <td>
                          <span className={s.decide}>
                            {a.requestId ? <Link className={s.link} href={`${here}${join}view=${a.requestId}`} scroll={false}>View Request</Link> : <Link className={s.link} href={`${here}${join}audit=${a.assetId}`} scroll={false}>View History</Link>}
                            {canRemind ? <Kebab horizontal items={[{ kind: "act", label: "Remind", icon: "bell", action: remindAcknowledgementAction, hidden: { ids: a.id } }]} /> : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </RemindForm>
          {rows.length ? <Pager total={total} page={page} href={(p) => `/assets/acknowledgements${qs(filters, { page: String(p) })}`} /> : null}
        </div>
      )}

      {sp.view ? <RequestDrawer viewer={viewer} requestId={sp.view} closeHref={here} /> : null}
      {sp.audit ? <AuditDrawer viewer={viewer} assetId={sp.audit} closeHref={here} /> : null}
    </>
  );
}
