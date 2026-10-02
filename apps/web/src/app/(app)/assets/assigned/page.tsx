import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireViewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { FilterForm, Kebab } from "../_ui";
import { AssetIcon, FSelect, FSearch, Pager, pageOf, PAGE_SIZE, Toolbar, Yellow, qs } from "../_parts";
import { assetMenu, assetPerms } from "../_menu";
import { AuditDrawer, AssignOverlay, EmployeeAssetsDrawer } from "../_drawers";
import { assignedEmployeesWhere } from "../_queries";
import s from "../assets.module.css";

/**
 * Assigned Assets (Keka 06–10): one row per employee holding something,
 * their first two assets as cards — corner flag for the acknowledgement,
 * ⋮ for the asset's actions — and "+N Assets" for the rest.
 */

const P = PERMISSIONS;
type SP = Record<string, string | undefined>;
const STATUS_OPTIONS = [
  { value: "PROBATION", label: "Probation" }, { value: "CONFIRMED", label: "Confirmed" }, { value: "NOTICE_PERIOD", label: "Notice period" },
  { value: "ONBOARDING", label: "Onboarding" }, { value: "INACTIVE", label: "Inactive" }, { value: "EXITED", label: "Exited" },
];
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.label]));
const FLAG: Record<string, { cls: string; tip: string }> = {
  PENDING: { cls: "pending", tip: "Acknowledgement pending" },
  ACKNOWLEDGED: { cls: "done", tip: "Acknowledged" },
  NOT_APPLICABLE: { cls: "", tip: "Acknowledgement not required" },
};

export default async function AssignedAssetsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const perms = assetPerms(viewer);
  const tenantId = viewer.tenantId;
  const filters = { status: sp.status, dept: sp.dept, loc: sp.loc, q: sp.q };
  const here = `/assets/assigned${qs({ ...filters, page: sp.page })}`;

  const where = assignedEmployeesWhere(viewer, filters);
  const [depts, locs, total, anyAssigned] = await Promise.all([
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.count({ where }),
    prisma.assetAssignment.count({ where: { returnedOn: null, asset: { tenantId }, employee: scopedEmployeeWhere(viewer, P.ASSET_VIEW) } }),
  ]);
  const page = pageOf(sp.page, total);
  const rows = await prisma.employee.findMany({
    where, orderBy: [{ firstName: "asc" }, { lastName: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    select: {
      id: true, displayName: true, employeeNumber: true, status: true,
      department: { select: { name: true } }, businessUnit: { select: { name: true } }, location: { select: { name: true } },
      assetAssignments: { where: { returnedOn: null }, orderBy: { assignedOn: "desc" }, include: { asset: { include: { assetType: true } } } },
    },
  });

  return (
    <>
      <div className={s.pageHead}>
        <div>
          <h1 className={s.pageTitle}>Assigned assets to employees</h1>
          <p className={s.pageSub}>The following are the employees for whom assets have been assigned.</p>
        </div>
        {perms.assign ? <Link className={s.btnOutline} href={`${here}${here.includes("?") ? "&" : "?"}assign=new`} scroll={false}>Assign Asset</Link> : null}
      </div>

      {anyAssigned === 0 ? (
        <div className={s.panel} style={{ padding: 18 }}><Yellow>No assets are assigned to employees.</Yellow></div>
      ) : (
        <>
          <FilterForm>
            <FSelect name="status" label="Employee Status" value={sp.status} options={STATUS_OPTIONS} />
            <FSelect name="dept" label="Department" value={sp.dept} options={depts.map((d) => ({ value: d.id, label: d.name }))} />
            <FSelect name="loc" label="Location" value={sp.loc} options={locs.map((l) => ({ value: l.id, label: l.name }))} />
            <FSearch value={sp.q} clearHref={Object.values(filters).some(Boolean) ? "/assets/assigned" : null} placeholder="Search employee or asset" />
          </FilterForm>
          <div className={s.tableCard}>
            <Toolbar total={total} exportHref={`/assets/export${qs({ view: "assigned", ...filters })}`} />
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Employee Name</th><th>Department</th><th>Business Unit</th><th>Location</th><th>Employee Status</th><th>Assets Assigned</th></tr></thead>
                <tbody>
                  {rows.length === 0 ? <tr><td colSpan={6} className="muted" style={{ textAlign: "center", padding: 30 }}>No employees match these filters.</td></tr> : rows.map((e) => {
                    const shown = e.assetAssignments.slice(0, 2), more = e.assetAssignments.length - shown.length;
                    return (
                      <tr key={e.id}>
                        <td><Link className={s.link} href={`/employees/${e.id}?tab=assets`}>{e.displayName}</Link><span className={s.sub}>{e.employeeNumber}</span></td>
                        <td><span className={s.clip} style={{ display: "block" }}>{e.department?.name ?? "Not Available"}</span></td>
                        <td><span className={s.clip} style={{ display: "block" }}>{e.businessUnit?.name ?? "Not Available"}</span></td>
                        <td><span className={s.clip} style={{ display: "block" }}>{e.location?.name ?? "—"}</span></td>
                        <td>{STATUS_LABEL[e.status] ?? e.status}</td>
                        <td>
                          <div className={s.cards}>
                            {shown.map((a) => {
                              const flag = FLAG[a.ackStatus];
                              return (
                                <div key={a.id} className={s.card}>
                                  <span className={`${s.flag}${flag.cls ? ` ${s[flag.cls]}` : ""}`} title={flag.tip} aria-label={flag.tip} />
                                  <span className={s.cardIcon}><AssetIcon icon={a.asset.assetType.icon} /></span>
                                  <span className={s.cardText}>
                                    <span className={s.cardName} style={{ display: "block" }}>{a.asset.name ?? a.asset.assetType.name}</span>
                                    <span className={s.cardTag} style={{ display: "block" }}>{a.asset.assetTag}</span>
                                  </span>
                                  <Kebab items={assetMenu({ asset: a.asset, assignmentId: a.id, perms, here })} label={`Actions for ${a.asset.assetTag}`} />
                                </div>
                              );
                            })}
                            {more > 0 ? <Link className={s.more} href={`${here}${here.includes("?") ? "&" : "?"}emp=${e.id}`} scroll={false}>+ {more} Asset{more === 1 ? "" : "s"}</Link> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager total={total} page={page} href={(p) => `/assets/assigned${qs(filters, { page: String(p) })}`} />
          </div>
        </>
      )}

      {sp.audit ? <AuditDrawer viewer={viewer} assetId={sp.audit} closeHref={here} /> : null}
      {sp.emp && !sp.assign && !sp.audit ? <EmployeeAssetsDrawer viewer={viewer} employeeId={sp.emp} closeHref={here} perms={perms} here={`${here}${here.includes("?") ? "&" : "?"}emp=${sp.emp}`} /> : null}
      {sp.assign ? <AssignOverlay viewer={viewer} spec={sp.assign} sp={sp} base="/assets/assigned" closeHref={here} /> : null}
    </>
  );
}
