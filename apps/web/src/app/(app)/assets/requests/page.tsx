import Link from "next/link";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  ASSET_REQUEST_STATUS_LABEL, ASSET_REQUEST_TYPE_LABEL, currentAssetLevel, canActOnAssetLevel, type AssetLevelState,
} from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { decideAssetRequestAction, cancelAssetRequestAction } from "@/app/actions/assets";
import { FilterForm, Kebab, ActButton, ModalButton, type MenuItem } from "../_ui";
import { FSelect, FSearch, FDate, Pager, pageOf, PAGE_SIZE, Toolbar, Segments, fmt, qs } from "../_parts";
import { RequestDrawer, AssignOverlay } from "../_drawers";
import s from "../assets.module.css";

/**
 * Asset Requests (Keka 11, 15, 16): pending and closed, the approval chain's
 * "Waiting on", ✓/✕ for whoever the request waits on, "Assign asset" once
 * approved, and the View Request drawer with its activity.
 */

const P = PERMISSIONS;
type SP = Record<string, string | undefined>;
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default async function AssetRequestsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;
  const closed = sp.tab === "closed";
  const me = viewer.employee?.id ?? null;
  const canManage = can(viewer, P.ASSET_MANAGE), canAssign = can(viewer, P.ASSET_ASSIGN);

  const from = sp.from ?? isoDay(new Date(Date.now() - 60 * DAY));
  const to = sp.to ?? isoDay(new Date());
  const filters = closed
    ? { tab: "closed", from: sp.from, to: sp.to, dept: sp.dept, loc: sp.loc, rtype: sp.rtype, rstatus: sp.rstatus, q: sp.q }
    : { dept: sp.dept, loc: sp.loc, rtype: sp.rtype, rstatus: sp.rstatus, q: sp.q };
  const here = `/assets/requests${qs({ ...filters, page: sp.page })}`;
  const join = here.includes("?") ? "&" : "?";

  const statusIn = closed ? ["FULFILLED", "REJECTED", "CANCELLED"] : ["PENDING", "APPROVED"];
  const where: Prisma.AssetRequestWhereInput = {
    tenantId,
    status: { in: (sp.rstatus && statusIn.includes(sp.rstatus) ? [sp.rstatus] : statusIn) as Prisma.EnumAssetRequestStatusFilter["in"] },
    employee: {
      ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
      ...(sp.dept ? { departmentId: sp.dept } : {}), ...(sp.loc ? { locationId: sp.loc } : {}),
    },
    ...(sp.rtype ? { requestType: sp.rtype as Prisma.AssetRequestWhereInput["requestType"] } : {}),
    ...(closed ? { closedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } } : {}),
    ...(sp.q ? { OR: [{ title: { contains: sp.q, mode: "insensitive" } }, { reason: { contains: sp.q, mode: "insensitive" } }, { employee: { displayName: { contains: sp.q, mode: "insensitive" } } }] } : {}),
  };
  const [depts, locs, total] = await Promise.all([
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.assetRequest.count({ where }),
  ]);
  const page = pageOf(sp.page, total);
  const rows = await prisma.assetRequest.findMany({
    where, orderBy: closed ? { closedAt: "desc" } : { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    include: {
      employee: { select: { id: true, displayName: true, jobTitleName: true, department: { select: { name: true } }, businessUnit: { select: { name: true } }, location: { select: { name: true } } } },
      category: { select: { name: true } }, assetType: { select: { name: true } }, approvals: true,
    },
  });
  const people = new Map((await prisma.employee.findMany({
    where: { tenantId, id: { in: [...new Set(rows.flatMap((r) => [...r.approvals.map((a) => a.approverId), r.closedBy]).filter((x): x is string => !!x))] } },
    select: { id: true, displayName: true },
  })).map((e) => [e.id, e.displayName ?? "—"]));
  const closedUsers = new Map((await prisma.user.findMany({
    where: { tenantId, id: { in: rows.map((r) => r.closedBy).filter((x): x is string => !!x) } }, select: { id: true, email: true },
  })).map((u) => [u.id, u.email]));

  const statusOpts = closed
    ? [{ value: "FULFILLED", label: "Assigned" }, { value: "REJECTED", label: "Rejected" }, { value: "CANCELLED", label: "Cancelled" }]
    : [{ value: "PENDING", label: "Pending" }, { value: "APPROVED", label: "Approved. Assignment pending" }];
  const typeOpts = Object.entries(ASSET_REQUEST_TYPE_LABEL).map(([value, label]) => ({ value, label }));

  return (
    <>
      <Segments items={[
        { label: "Pending Requests", href: "/assets/requests", on: !closed },
        { label: "Closed Requests", href: "/assets/requests?tab=closed", on: closed },
      ]} />
      <FilterForm>
        {closed ? <input type="hidden" name="tab" value="closed" /> : null}
        {closed ? <FDate name="from" label="Closed on — from" value={from} /> : null}
        {closed ? <FDate name="to" label="Closed on — to" value={to} /> : null}
        <FSelect name="dept" label="Department" value={sp.dept} options={depts.map((d) => ({ value: d.id, label: d.name }))} />
        <FSelect name="loc" label="Location" value={sp.loc} options={locs.map((l) => ({ value: l.id, label: l.name }))} />
        <FSelect name="rtype" label="Request Type" value={sp.rtype} options={typeOpts} />
        <FSelect name="rstatus" label="Request Status" value={sp.rstatus} options={statusOpts} />
        <FSearch value={sp.q} clearHref={Object.entries(filters).some(([k, v]) => k !== "tab" && v) ? (closed ? "/assets/requests?tab=closed" : "/assets/requests") : null} />
      </FilterForm>
      <div className={s.tableCard}>
        <Toolbar total={total} exportHref={`/assets/export${qs({ view: closed ? "requests-closed" : "requests", ...filters, from: closed ? from : undefined, to: closed ? to : undefined })}`} />
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              {closed ? (
                <tr><th>Asset</th><th>Requested By</th><th>Request Status</th><th>Action Taken By</th><th>Department</th><th>Business Unit</th><th>Employee Location</th><th>Request Type</th><th>Actions</th></tr>
              ) : (
                <tr><th>Asset</th><th>Asset Category &amp; Type</th><th>Requested By</th><th>Request Type</th><th>Department</th><th>Business Unit</th><th>Employee Location</th><th>Request Status</th><th>Waiting On</th><th>Actions</th></tr>
              )}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={10} className="muted" style={{ textAlign: "center", padding: 30 }}>{closed ? "No requests were closed in this period." : "No pending asset requests."}</td></tr>
              ) : rows.map((r) => {
                const cur = r.status === "PENDING" ? currentAssetLevel(r.approvals as AssetLevelState[]) : null;
                const waiting = cur ? (cur.approverId ? people.get(cur.approverId) ?? "—" : "Asset Manager") : "NA";
                const canDecide = !!cur && me !== r.employeeId && canActOnAssetLevel(cur, { employeeId: me, canManage });
                const view = `${here}${join}view=${r.id}`;
                const by = (
                  <td><Link className={s.link} href={`/employees/${r.employee.id}?tab=assets`}>{r.employee.displayName}</Link><span className={s.sub}>{r.employee.jobTitleName}</span></td>
                );
                const typeCell = <td className="nowrap">{ASSET_REQUEST_TYPE_LABEL[r.requestType]}<span className={s.sub}>on {fmt(r.createdAt)}</span></td>;
                const menu: MenuItem[] = [{ kind: "link", label: "View Request", icon: "view", href: view }];
                if (!closed && canManage) menu.push({ kind: "act", label: "Cancel request", icon: "cancel", action: cancelAssetRequestAction, hidden: { requestId: r.id }, confirm: "Cancel this request?" });
                if (closed) {
                  return (
                    <tr key={r.id}>
                      <td>{r.title ?? r.reason}</td>
                      {by}
                      <td className="nowrap">{ASSET_REQUEST_STATUS_LABEL[r.status]}<span className={s.sub}>on {fmt(r.closedAt)}</span></td>
                      <td>{r.closedBy ? people.get(r.closedBy) ?? closedUsers.get(r.closedBy) ?? "—" : "—"}</td>
                      <td><span className={s.clip} style={{ display: "block" }}>{r.employee.department?.name ?? "Not Available"}</span></td>
                      <td>{r.employee.businessUnit?.name ?? "Not Available"}</td>
                      <td>{r.employee.location?.name ?? "—"}</td>
                      {typeCell}
                      <td><Link className={s.link} href={view} scroll={false}>View Request</Link></td>
                    </tr>
                  );
                }
                return (
                  <tr key={r.id}>
                    <td>{r.title ?? r.reason}</td>
                    <td>{[r.category?.name, r.assetType?.name].filter(Boolean).join(" › ") || "NA"}</td>
                    {by}
                    {typeCell}
                    <td><span className={s.clip} style={{ display: "block" }}>{r.employee.department?.name ?? "Not Available"}</span></td>
                    <td>{r.employee.businessUnit?.name ?? "Not Available"}</td>
                    <td>{r.employee.location?.name ?? "—"}</td>
                    <td>{ASSET_REQUEST_STATUS_LABEL[r.status]}</td>
                    <td>{waiting}</td>
                    <td>
                      <span className={s.decide}>
                        {r.status === "APPROVED" && canAssign && r.requestType !== "RETURN" ? <Link className={s.link} href={`${here}${join}assign=request:${r.id}`} scroll={false}>Assign asset</Link> : null}
                        {r.status === "APPROVED" && canAssign && r.requestType === "RETURN" ? <Link className={s.link} href="/assets/assigned">Recover asset</Link> : null}
                        {canDecide ? (
                          <>
                            <ActButton action={decideAssetRequestAction} hidden={{ requestId: r.id, decision: "approve" }} className={`${s.round} ${s.ok}`} title="Approve">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
                            </ActButton>
                            <ModalButton label={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>}
                              className={`${s.round} ${s.no}`} title="Reject request" action={decideAssetRequestAction} hidden={{ requestId: r.id, decision: "reject" }} submitLabel="Reject" danger>
                              <p className="text-sm muted">{r.employee.displayName} · {r.title ?? r.reason}</p>
                              <div className="field"><label className="label" htmlFor={`rej-${r.id}`}>Reason for rejecting</label><textarea id={`rej-${r.id}`} name="note" className="textarea" rows={3} required /></div>
                            </ModalButton>
                          </>
                        ) : null}
                        <Kebab horizontal items={menu} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager total={total} page={page} href={(p) => `/assets/requests${qs(filters, { page: String(p) })}`} />
      </div>

      {sp.view ? <RequestDrawer viewer={viewer} requestId={sp.view} closeHref={here} /> : null}
      {sp.assign ? <AssignOverlay viewer={viewer} spec={sp.assign} sp={sp} base="/assets/requests" closeHref={here} /> : null}
    </>
  );
}
