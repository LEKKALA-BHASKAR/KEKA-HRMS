import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ASSET_ICON_KEYS } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { saveAssetCategoryAction, deleteAssetCategoryAction, saveAssetTypeAction, deleteAssetTypeAction } from "@/app/actions/assets";
import { ModalButton, ActButton, Kebab } from "../_ui";
import { AssetIcon, Yellow } from "../_parts";
import s from "../assets.module.css";

/**
 * Asset Categories & Asset Types (Keka 23–25): categories down the left; the
 * chosen category's details and its types on the right. A category or type
 * that still holds assets cannot be deleted.
 */

const P = PERMISSIONS;
const ICON_LABEL: Record<string, string> = {
  laptop: "Laptop", desktop: "Desktop", monitor: "Monitor", phone: "Phone", tablet: "Tablet", chair: "Furniture", card: "ID / access card", network: "Network", headset: "Headset", other: "Other",
};

function CategoryFields({ c }: { c?: { name: string; description: string | null; usefulLifeMonths: number | null } }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="cat-name">Category name</label>
        <input id="cat-name" name="name" className="input" required maxLength={80} defaultValue={c?.name ?? ""} placeholder="e.g. IT Equipment" />
      </div>
      <div className="field">
        <label className="label" htmlFor="cat-desc">Description</label>
        <textarea id="cat-desc" name="description" className="textarea" rows={2} maxLength={500} defaultValue={c?.description ?? ""} />
      </div>
      <div className="field">
        <label className="label" htmlFor="cat-life">Useful life (months)</label>
        <input id="cat-life" name="usefulLifeMonths" type="number" min={1} max={600} className="input num" defaultValue={c?.usefulLifeMonths ?? ""} placeholder="Leave blank for no depreciation" />
        <div className="hint">Book values depreciate in a straight line over this period.</div>
      </div>
    </>
  );
}

function TypeFields({ t }: { t?: { name: string; description: string | null; icon: string; make: string | null; model: string | null; requireAck: boolean } }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="type-name">Asset type name</label>
        <input id="type-name" name="name" className="input" required maxLength={80} defaultValue={t?.name ?? ""} placeholder="e.g. Laptop" />
      </div>
      <div className="field">
        <label className="label" htmlFor="type-icon">Icon</label>
        <select id="type-icon" name="icon" className="select" defaultValue={t?.icon ?? "other"}>
          {ASSET_ICON_KEYS.map((k) => <option key={k} value={k}>{ICON_LABEL[k] ?? k}</option>)}
        </select>
      </div>
      <div className="row gap-3">
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="type-make">Make</label>
          <input id="type-make" name="make" className="input" maxLength={80} defaultValue={t?.make ?? ""} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="type-model">Model</label>
          <input id="type-model" name="model" className="input" maxLength={80} defaultValue={t?.model ?? ""} />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="type-desc">Description</label>
        <textarea id="type-desc" name="description" className="textarea" rows={2} maxLength={500} defaultValue={t?.description ?? ""} />
      </div>
      <label className="row gap-2 text-sm" style={{ alignItems: "center" }}>
        <input type="checkbox" name="requireAck" defaultChecked={t?.requireAck ?? true} />
        Employees must acknowledge receiving an asset of this type
      </label>
    </>
  );
}

export default async function AssetCategoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) redirect("/assets");
  const cats = await prisma.assetCategory.findMany({
    where: { tenantId: viewer.tenantId }, orderBy: { name: "asc" },
    include: { types: { orderBy: { name: "asc" }, include: { _count: { select: { assets: true } } } } },
  });
  const cur = cats.find((c) => c.id === sp.cat) ?? cats[0];
  const held = cur ? cur.types.reduce((n, t) => n + t._count.assets, 0) : 0;

  return (
    <div className={s.split}>
      <nav className={s.rail} aria-label="Asset categories">
        <div className={s.railSearch} style={{ justifyContent: "space-between" }}>
          <span className="strong text-sm">Asset categories</span>
          <ModalButton label="+ Add" className={s.linkish} title="Add asset category" action={saveAssetCategoryAction} submitLabel="Add" navigateTo="/assets/categories?cat={id}">
            <CategoryFields />
          </ModalButton>
        </div>
        {cats.length === 0 ? <div className={s.railItem}><span className="muted text-sm">No categories yet.</span></div> : cats.map((c) => (
          <Link key={c.id} href={`/assets/categories?cat=${c.id}`} className={`${s.railItem}${c.id === cur?.id ? ` ${s.on}` : ""}`} style={c === cats[0] ? { borderTop: 0 } : undefined}>
            <span>{c.name}{c.isActive ? null : " (inactive)"}<span className={s.count}>{c.types.length} type{c.types.length === 1 ? "" : "s"}</span></span>
          </Link>
        ))}
      </nav>

      <div style={{ minWidth: 0 }}>
        {!cur ? (
          <div className={s.panel} style={{ padding: 18 }}><Yellow>Start by adding an asset category, such as IT Equipment or Furniture, then the types within it.</Yellow></div>
        ) : (
          <>
            <div className={s.detailHead}>
              <div className={s.detailHeadTop}>
                <div>
                  <h1 className={s.detailTitle}>{cur.name}</h1>
                  <p className={s.detailSub}>
                    {cur.description ?? "No description."}
                    {cur.usefulLifeMonths ? ` · Useful life ${cur.usefulLifeMonths} months` : " · No depreciation"}
                    {` · ${held} asset${held === 1 ? "" : "s"}`}
                  </p>
                </div>
                <div className="row gap-2">
                  <ModalButton label="Edit" className={s.btnOutline} title="Edit asset category" action={saveAssetCategoryAction} hidden={{ id: cur.id }} submitLabel="Save">
                    <CategoryFields c={cur} />
                  </ModalButton>
                  <ActButton action={deleteAssetCategoryAction} hidden={{ id: cur.id }} className="btn" confirm={`Delete ${cur.name} and its types?`} next="/assets/categories">Delete</ActButton>
                </div>
              </div>
              <div className={s.detailTabs}><span>Asset types</span></div>
            </div>

            <div className={`${s.tableCard} ${s.alone}`}>
              <div className={s.toolbar} style={{ justifyContent: "space-between" }}>
                <span className={s.total}>Total: {cur.types.length}</span>
                <ModalButton label="Add Asset Type" className="btn primary" title={`Add asset type to ${cur.name}`} action={saveAssetTypeAction} hidden={{ categoryId: cur.id }} submitLabel="Add">
                  <TypeFields />
                </ModalButton>
              </div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>Asset Type</th><th>Make &amp; Model</th><th>Acknowledgement</th><th>Assets</th><th>Actions</th></tr></thead>
                  <tbody>
                    {cur.types.length === 0 ? <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 30 }}>No asset types in {cur.name} yet.</td></tr> : cur.types.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <span className="row gap-2" style={{ alignItems: "center" }}>
                            <span className={s.cardIcon}><AssetIcon icon={t.icon} size={20} /></span>
                            <span>{t.name}{t.description ? <span className={s.sub}>{t.description}</span> : null}</span>
                          </span>
                        </td>
                        <td>{[t.make, t.model].filter(Boolean).join(" ") || "—"}</td>
                        <td>{t.requireAck ? "Required" : "Not required"}</td>
                        <td><Link className={s.link} href={`/assets/list?type=${t.id}`}>{t._count.assets}</Link></td>
                        <td>
                          <span className={s.decide}>
                            <ModalButton label="Edit" className={s.linkish} title={`Edit ${t.name}`} action={saveAssetTypeAction} hidden={{ id: t.id, categoryId: cur.id }} submitLabel="Save">
                              <TypeFields t={t} />
                            </ModalButton>
                            <Kebab horizontal label={`More for ${t.name}`} items={[
                              { kind: "link", label: "View assets", icon: "view", href: `/assets/list?type=${t.id}` },
                              { kind: "link", label: "Bulk add assets", icon: "edit", href: `/assets/list?type=${t.id}&import=ADD` },
                              { kind: "divider" },
                              { kind: "act", label: "Delete asset type", icon: "trash", action: deleteAssetTypeAction, hidden: { id: t.id }, confirm: `Delete ${t.name}?` },
                            ]} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
