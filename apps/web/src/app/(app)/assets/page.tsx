import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma, type Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { assetSummary, ASSET_CONDITIONS, ASSET_CONDITION_LABEL, ASSET_STATUS_LABEL, type AssetConditionKey, type AssetStatusKey } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { ConditionChart } from "./_chart";
import { AutoSelect, CategorySelect } from "./_summary-controls";
import { FilterForm, UrlSheet } from "./_ui";
import { FSelect, FSearch, Pager, pageOf, PAGE_SIZE, Toolbar, fmt, qs } from "./_parts";
import s from "./assets.module.css";

/**
 * Asset summary (Keka 03/05): four counts with drill-down drawers, and the
 * two "by condition" charts. Old `/assets?tab=` links redirect to their new
 * homes.
 */

const P = PERMISSIONS;
const OLD_TABS: Record<string, string> = {
  inventory: "/assets/list", assigned: "/assets/assigned", requests: "/assets/requests", recovery: "/assets/recovery", mine: "/me/assets",
};

type SP = Record<string, string | undefined>;

export default async function AssetSummaryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  if (sp.tab && OLD_TABS[sp.tab]) redirect(OLD_TABS[sp.tab]);
  const viewer = await requireViewer();
  const tenantId = viewer.tenantId;

  const [cats, depts, locs] = await Promise.all([
    prisma.assetCategory.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const category = cats.some((c) => c.id === sp.category) ? sp.category : undefined;
  const avail = sp.avail === "unavailable" ? "unavailable" : "available";
  const summary = await assetSummary(tenantId, { categoryId: category, departmentId: sp.dept, locationId: sp.loc });
  const base = { category, avail: sp.avail, dept: sp.dept, loc: sp.loc };
  const kpi = (label: string, value: number, link?: { text: string; list: string }) => (
    <div className={s.kpi}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiRow}>
        <span className={s.kpiValue}>{value}</span>
        {link ? <Link className={s.kpiLink} href={qs(base, { list: link.list })} scroll={false}>{link.text}</Link> : null}
      </div>
    </div>
  );

  return (
    <>
      <div className={s.pageHead}>
        <h1 className={s.pageTitle}>Asset summary</h1>
        <form method="get" className="row gap-2">
          {Object.entries({ avail: sp.avail, dept: sp.dept, loc: sp.loc }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <CategorySelect value={category} options={cats} />
        </form>
      </div>

      <div className={s.kpis}>
        {kpi("Total Assets", summary.total)}
        {kpi("Assets Available", summary.available, { text: "View Assets", list: "available" })}
        {kpi("Assets Assigned", summary.assigned, { text: "View Employees", list: "assigned" })}
        {kpi("Assets Not Available", summary.notAvailable, { text: "View Assets", list: "unavailable" })}
      </div>

      <section className={s.chartPanel} aria-labelledby="avail-h">
        <div className={s.chartHead}>
          <h2 id="avail-h" className={s.chartTitle}>Asset availability by condition</h2>
          <div className={s.toggle}>
            <Link href={qs(base, { avail: undefined })} className={avail === "available" ? s.on : undefined} scroll={false}>Available</Link>
            <Link href={qs(base, { avail: "unavailable" })} className={avail === "unavailable" ? s.on : undefined} scroll={false}>Not Available</Link>
          </div>
        </div>
        <div className={s.chartBody}>
          <ConditionChart categories={summary.categories} data={avail === "available" ? summary.availableByCondition : summary.notAvailableByCondition} empty="No assets yet." />
        </div>
      </section>

      <section className={s.chartPanel} aria-labelledby="assign-h">
        <div className={s.chartHead}>
          <h2 id="assign-h" className={s.chartTitle}>Asset assignment by condition</h2>
          <form method="get" className={s.chartSelects}>
            {Object.entries({ category, avail: sp.avail }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
            <AutoSelect name="dept" value={sp.dept} all="All Departments" options={depts} />
            <AutoSelect name="loc" value={sp.loc} all="All Locations" options={locs} />
          </form>
        </div>
        <div className={s.chartBody}>
          <ConditionChart categories={summary.categories} data={summary.assignedByCondition} empty="Nothing is assigned yet." />
        </div>
      </section>

      {sp.list === "assigned" || sp.list === "available" || sp.list === "unavailable"
        ? <ListDrawer viewer={viewer} list={sp.list} sp={sp} base={base} cats={cats} depts={depts} locs={locs} />
        : null}
    </>
  );
}


async function ListDrawer({ viewer, list, sp, base, cats, depts, locs }: {
  viewer: Awaited<ReturnType<typeof requireViewer>>; list: "assigned" | "available" | "unavailable"; sp: SP; base: SP;
  cats: Array<{ id: string; name: string }>; depts: Array<{ id: string; name: string }>; locs: Array<{ id: string; name: string }>;
}) {
  const tenantId = viewer.tenantId;
  const [types, units, centres, entities] = await Promise.all([
    prisma.assetType.findMany({ where: { category: { tenantId }, ...(sp.dcat ? { categoryId: sp.dcat } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.businessUnit.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.costCenter.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const holder: Prisma.EmployeeWhereInput = {
    ...(scopedEmployeeWhere(viewer, P.ASSET_VIEW) as Prisma.EmployeeWhereInput),
    ...(sp.dbu ? { businessUnitId: sp.dbu } : {}), ...(sp.ddept ? { departmentId: sp.ddept } : {}),
    ...(sp.dcc ? { costCenterId: sp.dcc } : {}), ...(sp.dle ? { legalEntityId: sp.dle } : {}),
  };
  const statusWhere: Prisma.AssetWhereInput = list === "assigned" ? { status: "ASSIGNED" } : list === "available" ? { status: "AVAILABLE" } : { status: { in: ["IN_REPAIR", "LOST", "UNAVAILABLE"] } };
  const where: Prisma.AssetWhereInput = {
    tenantId, ...statusWhere,
    ...(sp.dcat ? { assetType: { categoryId: sp.dcat } } : {}), ...(sp.dtype ? { assetTypeId: sp.dtype } : {}),
    ...(sp.dcond ? { condition: sp.dcond as AssetConditionKey } : {}), ...(sp.dloc ? { locationId: sp.dloc } : {}),
    ...(list === "assigned" ? { assignments: { some: { returnedOn: null, employee: holder } } } : {}),
    ...(sp.q ? { OR: [{ name: { contains: sp.q, mode: "insensitive" } }, { assetTag: { contains: sp.q, mode: "insensitive" } }, ...(list === "assigned" ? [{ assignments: { some: { returnedOn: null, employee: { displayName: { contains: sp.q, mode: "insensitive" as const } } } } }] : [])] } : {}),
  };
  const total = await prisma.asset.count({ where });
  const page = pageOf(sp.page, total);
  const rows = await prisma.asset.findMany({
    where, orderBy: { assetTag: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    include: {
      assetType: { include: { category: true } }, location: true,
      assignments: { where: { returnedOn: null }, take: 1, include: { employee: { select: { id: true, displayName: true, jobTitleName: true, department: { select: { name: true } }, businessUnit: { select: { name: true } }, location: { select: { name: true } } } } } },
    },
  });
  const filters = { list, dcat: sp.dcat, dtype: sp.dtype, dcond: sp.dcond, dbu: sp.dbu, ddept: sp.ddept, dloc: sp.dloc, dcc: sp.dcc, dle: sp.dle, q: sp.q };
  const keep = { ...base, ...filters };
  const title = list === "assigned" ? "List of Assets Assigned" : list === "available" ? "List of Assets Available" : "List of Assets Not Available";
  const opt = (r: Array<{ id: string; name: string }>) => r.map((x) => ({ value: x.id, label: x.name }));
  return (
    <UrlSheet title={title} closeHref={`/assets${qs(base)}`}>
      <FilterForm>
        {Object.entries(base).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <input type="hidden" name="list" value={list} />
        <FSelect name="dcat" label="Asset Category" value={sp.dcat} options={opt(cats)} />
        <FSelect name="dtype" label="Asset Type" value={sp.dtype} options={opt(types)} />
        <FSelect name="dcond" label="Condition" value={sp.dcond} options={ASSET_CONDITIONS.map((c) => ({ value: c, label: ASSET_CONDITION_LABEL[c] }))} />
        {list === "assigned" ? <FSelect name="dbu" label="Business Unit" value={sp.dbu} options={opt(units)} /> : null}
        {list === "assigned" ? <FSelect name="ddept" label="Department" value={sp.ddept} options={opt(depts)} /> : null}
        <FSelect name="dloc" label="Location" value={sp.dloc} options={opt(locs)} />
        {list === "assigned" ? <FSelect name="dcc" label="Cost Center" value={sp.dcc} options={opt(centres)} /> : null}
        {list === "assigned" ? <FSelect name="dle" label="Legal Entity" value={sp.dle} options={opt(entities)} /> : null}
        <FSearch value={sp.q} clearHref={`/assets${qs(base, { list })}`} />
      </FilterForm>
      <div className={s.tableCard}>
        <Toolbar total={total} exportHref={`/assets/export${qs({ view: `summary-${list}`, ...filters })}`} />
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Asset Name</th><th>Category</th><th>Asset Type</th><th>Condition</th>
                {list === "assigned" ? <><th>Assigned To</th><th>Assigned On</th><th>Department</th><th>Business Unit</th><th>Location</th></>
                  : <><th>Status</th><th>Location</th>{list === "unavailable" ? <th>Reason</th> : null}</>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={9} className="muted" style={{ textAlign: "center", padding: 30 }}>No assets match these filters.</td></tr> : rows.map((a) => {
                const h = a.assignments[0];
                return (
                  <tr key={a.id}>
                    <td><Link className={s.link} href={`/assets/${a.id}`}>{a.name ?? a.assetType.name}</Link><span className="sub">{a.assetTag}</span></td>
                    <td><span className={s.clip} style={{ display: "block" }}>{a.assetType.category.name}</span></td>
                    <td>{a.assetType.name}</td>
                    <td>{ASSET_CONDITION_LABEL[a.condition as AssetConditionKey]}</td>
                    {list === "assigned" ? (
                      <>
                        <td>{h ? <><Link className={s.link} href={`/employees/${h.employee.id}?tab=assets`}>{h.employee.displayName}</Link><span className="sub">{h.employee.jobTitleName}</span></> : "—"}</td>
                        <td className="nowrap">{h ? fmt(h.assignedOn) : "—"}</td>
                        <td>{h?.employee.department?.name ?? "Not Available"}</td>
                        <td>{h?.employee.businessUnit?.name ?? "Not Available"}</td>
                        <td>{a.location?.name ?? h?.employee.location?.name ?? "—"}</td>
                      </>
                    ) : (
                      <>
                        <td>{ASSET_STATUS_LABEL[a.status as AssetStatusKey]}</td>
                        <td>{a.location?.name ?? "—"}</td>
                        {list === "unavailable" ? <td className="text-sm">{a.unavailableReason ?? "—"}</td> : null}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager total={total} page={page} href={(p) => `/assets${qs(keep, { page: String(p) })}`} />
      </div>
    </UrlSheet>
  );
}
