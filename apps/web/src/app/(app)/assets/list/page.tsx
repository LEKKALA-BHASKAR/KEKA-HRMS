import Link from "next/link";
import { prisma } from "@keka/db";
import { ASSET_CONDITIONS, ASSET_CONDITION_LABEL, ASSET_STATUS_LABEL, assetWarrantyStatus, type AssetConditionKey } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { FilterForm, Kebab } from "../_ui";
import { AssetIcon, FSelect, FSearch, Pager, pageOf, PAGE_SIZE, Toolbar, StatusText, Yellow, fmt, qs } from "../_parts";
import { assetMenu, assetPerms } from "../_menu";
import { AuditDrawer, AssignOverlay } from "../_drawers";
import { AssetFormOverlay, ImportSheet } from "../_overlays";
import { assetListWhere, assetListInclude, LIST_STATUSES } from "../_queries";
import s from "../assets.module.css";

/**
 * Asset List (Keka 19–22): categories and their types down the left with a
 * count each; the chosen type's (or every) asset on the right with filters,
 * Add Asset, Bulk add / update and each asset's ⋮ actions.
 */

type SP = Record<string, string | undefined>;

export default async function AssetListPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const perms = assetPerms(viewer);
  const tenantId = viewer.tenantId;

  const cats = await prisma.assetCategory.findMany({
    where: { tenantId }, orderBy: { name: "asc" },
    include: { types: { orderBy: { name: "asc" }, include: { _count: { select: { assets: { where: { status: { not: "RETIRED" } } } } } } } },
  });
  const typeRow = cats.flatMap((c) => c.types.map((t) => ({ ...t, category: c }))).find((t) => t.id === sp.type);
  const type = typeRow?.id;
  const cat = !type && cats.some((c) => c.id === sp.cat) ? sp.cat : undefined;
  const filters = { type, cat, status: sp.status, cond: sp.cond, loc: sp.loc, warranty: sp.warranty, q: sp.q };
  const here = `/assets/list${qs({ ...filters, page: sp.page })}`;
  const join = here.includes("?") ? "&" : "?";
  const where = assetListWhere(tenantId, filters);

  const [locs, total, allCount] = await Promise.all([
    prisma.location.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.asset.count({ where }),
    prisma.asset.count({ where: { tenantId, status: { not: "RETIRED" } } }),
  ]);
  const page = pageOf(sp.page, total);
  const rows = await prisma.asset.findMany({ where, include: assetListInclude, orderBy: { assetTag: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE });
  const now = new Date();
  const title = typeRow ? typeRow.name : cat ? cats.find((c) => c.id === cat)!.name : "All assets";
  const sub = typeRow
    ? [`${typeRow.category.name} › ${typeRow.name}`, [typeRow.make, typeRow.model].filter(Boolean).join(" "), typeRow.requireAck ? "Acknowledgement required" : "No acknowledgement needed"].filter(Boolean).join(" · ")
    : "Every asset in the organisation, except retired ones unless you filter for them.";
  const scopeKeep = { type, cat };

  return (
    <>
      <div className={s.split}>
        <nav className={s.rail} aria-label="Asset categories and types">
          <Link href="/assets/list" className={`${s.railItem}${!type && !cat ? ` ${s.on}` : ""}`} style={{ borderTop: 0 }}>
            <span>All assets<span className={s.count}>{allCount} asset{allCount === 1 ? "" : "s"}</span></span>
          </Link>
          {cats.map((c) => (
            <div key={c.id}>
              <Link href={`/assets/list?cat=${c.id}`} className={s.railGroup} style={{ display: "block", ...(cat === c.id ? { color: "var(--text)" } : {}) }}>{c.name}</Link>
              {c.types.length === 0 ? <div className={s.railItem}><span className="muted text-sm">No types yet</span></div> : c.types.map((t) => (
                <Link key={t.id} href={`/assets/list?type=${t.id}`} className={`${s.railItem}${t.id === type ? ` ${s.on}` : ""}`}>
                  <span className={s.cardIcon}><AssetIcon icon={t.icon} size={20} /></span>
                  <span>{t.name}<span className={s.count}>{t._count.assets} asset{t._count.assets === 1 ? "" : "s"}</span></span>
                </Link>
              ))}
            </div>
          ))}
          {perms.manage ? <Link href="/assets/categories" className={s.railItem} style={{ color: "var(--brand-600)" }}>Manage categories &amp; types</Link> : null}
        </nav>

        <div style={{ minWidth: 0 }}>
          <div className={s.detailHead}>
            <div className={s.detailHeadTop}>
              <div>
                <h1 className={s.detailTitle}>{title}</h1>
                <p className={s.detailSub}>{sub}</p>
              </div>
              {perms.manage ? (
                <div className="row gap-2 wrap">
                  <Link className={s.btnOutline} href={`${here}${join}import=ADD`} scroll={false}>Bulk Add</Link>
                  <Link className={s.btnOutline} href={`${here}${join}import=UPDATE`} scroll={false}>Bulk Update</Link>
                  <Link className="btn primary" href={`${here}${join}new=1`} scroll={false}>Add Asset</Link>
                </div>
              ) : null}
            </div>
            <div className={s.detailTabs}><span>Assets</span></div>
          </div>

          {cats.length === 0 ? (
            <div className={s.panel} style={{ padding: 18 }}>
              <Yellow>No asset categories yet. {perms.manage ? <Link href="/assets/categories">Add a category and its types</Link> : "An asset manager needs to add them"} before adding assets.</Yellow>
            </div>
          ) : (
            <>
              <FilterForm>
                {Object.entries(scopeKeep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
                <FSelect name="status" label="Status" value={sp.status} options={LIST_STATUSES.map((v) => ({ value: v, label: ASSET_STATUS_LABEL[v] }))} />
                <FSelect name="cond" label="Condition" value={sp.cond} options={ASSET_CONDITIONS.map((c) => ({ value: c, label: ASSET_CONDITION_LABEL[c] }))} />
                <FSelect name="loc" label="Location" value={sp.loc} options={locs.map((l) => ({ value: l.id, label: l.name }))} />
                <FSelect name="warranty" label="Warranty" value={sp.warranty} options={[{ value: "expiring", label: "Expiring in 30 days" }, { value: "expired", label: "Expired" }]} />
                <FSearch value={sp.q} placeholder="Search name, ID, serial or holder" clearHref={[sp.status, sp.cond, sp.loc, sp.warranty, sp.q].some(Boolean) ? `/assets/list${qs(scopeKeep)}` : null} />
              </FilterForm>
              <div className={s.tableCard}>
                <Toolbar total={total} exportHref={`/assets/export${qs({ view: "list", ...filters })}`} />
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead><tr><th>Asset Name</th>{type ? null : <th>Category &amp; Type</th>}<th>Location</th><th>Condition</th><th>Status</th><th>Assigned To</th><th>Warranty</th><th>Actions</th></tr></thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={8} className="muted" style={{ textAlign: "center", padding: 30 }}>{allCount === 0 ? "No assets yet." : "No assets match these filters."}</td></tr>
                      ) : rows.map((a) => {
                        const h = a.assignments[0];
                        const w = assetWarrantyStatus(a.warrantyExpiry, now, 30);
                        return (
                          <tr key={a.id}>
                            <td><Link className={s.link} href={`/assets/${a.id}`}>{a.name ?? a.assetType.name}</Link><span className={s.sub}>{a.assetTag}{a.serialNumber ? ` · ${a.serialNumber}` : ""}</span></td>
                            {type ? null : <td><span className={s.clip} style={{ display: "block" }}>{a.assetType.category.name} › {a.assetType.name}</span></td>}
                            <td>{a.location?.name ?? "—"}</td>
                            <td>{ASSET_CONDITION_LABEL[a.condition as AssetConditionKey]}</td>
                            <td><StatusText status={a.status} />{a.unavailableReason && a.status !== "AVAILABLE" && a.status !== "ASSIGNED" ? <span className={s.sub} title={a.unavailableReason}>{a.unavailableReason.slice(0, 40)}</span> : null}</td>
                            <td>{h ? <><Link className={s.link} href={`/employees/${h.employee.id}?tab=assets`}>{h.employee.displayName}</Link><span className={s.sub}>{h.employee.employeeNumber}</span></> : "—"}</td>
                            <td className="nowrap">{a.warrantyExpiry ? <>{fmt(a.warrantyExpiry)}{w === "EXPIRED" ? <span className={s.sub} style={{ color: "var(--danger)" }}>Expired</span> : w === "EXPIRING" ? <span className={s.sub} style={{ color: "#c26a00" }}>Expiring soon</span> : null}</> : "—"}</td>
                            <td><Kebab horizontal items={assetMenu({ asset: a, assignmentId: h?.id, perms, here })} label={`Actions for ${a.assetTag}`} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager total={total} page={page} href={(p) => `/assets/list${qs(filters, { page: String(p) })}`} />
              </div>
            </>
          )}
        </div>
      </div>

      {sp.new ? <AssetFormOverlay viewer={viewer} typeId={type} closeHref={here} /> : null}
      {sp.import === "ADD" || sp.import === "UPDATE" ? <ImportSheet viewer={viewer} mode={sp.import} typeId={type} closeHref={here} /> : null}
      {sp.audit ? <AuditDrawer viewer={viewer} assetId={sp.audit} closeHref={here} /> : null}
      {sp.assign ? <AssignOverlay viewer={viewer} spec={sp.assign} sp={sp} base="/assets/list" closeHref={here} /> : null}
    </>
  );
}
