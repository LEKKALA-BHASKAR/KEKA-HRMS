import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ASSET_IMPORT_FIELDS } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import { startAssetImportAction } from "@/app/actions/assets";
import { FullScreen, UrlSheet, UploadForm } from "./_ui";
import { qs } from "./_parts";
import { AssetForm } from "./_asset-form";
import { assetFormOptions } from "./_queries";
import s from "./assets.module.css";

/**
 * Overlays for the inventory: Add Asset / Edit asset details as a full-screen
 * form, and the first step of the bulk import (download the template, upload
 * it). Both are opened by a query parameter, like the drawers.
 */

const P = PERMISSIONS;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

export async function AssetFormOverlay({ viewer, assetId, typeId, closeHref }: { viewer: Viewer; assetId?: string; typeId?: string; closeHref: string }) {
  if (!can(viewer, P.ASSET_MANAGE)) return null;
  const [opts, asset] = await Promise.all([
    assetFormOptions(viewer.tenantId),
    assetId ? prisma.asset.findFirst({ where: { id: assetId, tenantId: viewer.tenantId } }) : Promise.resolve(null),
  ]);
  if (assetId && !asset) return null;
  const initial = asset ? {
    id: asset.id, assetTypeId: asset.assetTypeId, assetTag: asset.assetTag, name: asset.name ?? "", description: asset.description, locationId: asset.locationId,
    purchaseDate: iso(asset.purchaseDate), warrantyExpiry: iso(asset.warrantyExpiry), condition: asset.condition, serialNumber: asset.serialNumber,
    purchaseCost: asset.purchaseCost === null ? "" : String(Number(asset.purchaseCost)), vendor: asset.vendor, invoiceNumber: asset.invoiceNumber,
    imageUrl: asset.imageFileId ? `/files/${asset.imageFileId}` : null,
  } : { assetTypeId: opts.categories.some((c) => c.types.some((t) => t.id === typeId)) ? typeId : undefined };
  return (
    <FullScreen title={asset ? `Edit ${asset.assetTag}` : "Add Asset"} closeHref={closeHref}>
      {opts.categories.length === 0 ? (
        <div className={s.yellow} role="note">Add an asset category and an asset type first, under Asset Categories &amp; Asset Types.</div>
      ) : (
        <AssetForm categories={opts.categories} locations={opts.locations} series={opts.series} initial={initial} closeHref={closeHref} />
      )}
    </FullScreen>
  );
}

export async function ImportSheet({ viewer, mode, typeId, closeHref }: { viewer: Viewer; mode: "ADD" | "UPDATE"; typeId?: string; closeHref: string }) {
  if (!can(viewer, P.ASSET_MANAGE)) return null;
  const type = typeId ? await prisma.assetType.findFirst({ where: { id: typeId, category: { tenantId: viewer.tenantId } }, include: { category: true } }) : null;
  const scope = type ? `${type.category.name} › ${type.name}` : "any category and type";
  return (
    <UrlSheet title={mode === "ADD" ? "Bulk add assets" : "Bulk update assets"} subtitle={scope} closeHref={closeHref}>
      <ol className="stack gap-3 text-sm" style={{ paddingLeft: 18, margin: "0 0 18px" }}>
        <li>
          <a className={s.link} href={`/assets/export${qs({ view: "template", mode, type: type?.id })}`}>Download the template</a>
          {mode === "UPDATE" ? " — it already lists the assets as they are now; change what you need." : " and fill in one row per asset."}
        </li>
        <li>Keep the Asset ID column{mode === "UPDATE" ? " — it is how each row finds its asset" : " unique — IDs already in use are refused"}. Locations, categories and types must match what is set up; conditions are New, Good, Fair, Poor, Damaged or Unusable.</li>
        <li>Save it as CSV and upload it. You map the columns and review every row before anything changes.</li>
      </ol>
      <p className="text-xs muted" style={{ marginBottom: 12 }}>Columns: {ASSET_IMPORT_FIELDS.map((f) => `${f.label}${f.required ? "*" : ""}`).join(", ")}.</p>
      <UploadForm action={startAssetImportAction} hidden={{ mode, ...(type ? { assetTypeId: type.id } : {}) }} next="/assets/import/{id}" accept=".csv,text/csv" label="Upload" />
    </UrlSheet>
  );
}
