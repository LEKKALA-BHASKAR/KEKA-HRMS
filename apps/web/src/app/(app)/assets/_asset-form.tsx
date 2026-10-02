"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { saveAssetAction } from "@/app/actions/assets";
import { useAct, Banner } from "./_ui";
import s from "./assets.module.css";

/**
 * Add Asset / Edit asset details (Keka 21): the image on the left, the form
 * on the right. A new asset takes its ID from a series or is typed by hand,
 * and may start out not available, with a reason.
 */

export interface AssetFormValues {
  id?: string; assetTypeId?: string; assetTag?: string; name?: string; description?: string | null; locationId?: string | null;
  purchaseDate?: string; warrantyExpiry?: string; condition?: string; serialNumber?: string | null; purchaseCost?: string;
  vendor?: string | null; invoiceNumber?: string | null; imageUrl?: string | null;
}

const CONDITIONS: Array<[string, string]> = [["NEW", "New"], ["GOOD", "Good"], ["FAIR", "Fair"], ["POOR", "Poor"], ["DAMAGED", "Damaged"], ["UNUSABLE", "Unusable"]];
const STATUSES: Array<[string, string]> = [["AVAILABLE", "Available"], ["IN_REPAIR", "In repair"], ["LOST", "Lost"], ["UNAVAILABLE", "Not available (held back)"], ["RETIRED", "Retired"]];

export function AssetForm({ categories, locations, series, initial, closeHref }: {
  categories: Array<{ id: string; name: string; types: Array<{ id: string; name: string }> }>;
  locations: Array<{ id: string; name: string }>;
  series: Array<{ id: string; name: string; preview: string; isDefault: boolean }>;
  initial: AssetFormValues;
  closeHref: string;
}) {
  const router = useRouter();
  const editing = !!initial.id;
  const { state, submit, pending } = useAct(saveAssetAction, (st) => router.push(`/assets/${st.values?.id ?? initial.id ?? ""}`));
  const [seriesId, setSeriesId] = useState(series.find((x) => x.isDefault)?.id ?? series[0]?.id ?? "MANUAL");
  const [status, setStatus] = useState("AVAILABLE");
  const [preview, setPreview] = useState<string | null>(initial.imageUrl ?? null);
  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  const err = (k: string) => (state.errors?.[k] ? <div className="text-xs" role="alert" style={{ color: "var(--danger)", marginTop: 4 }}>{state.errors[k]}</div> : null);
  const v = (k: keyof AssetFormValues) => (state.values?.[k] ?? (initial[k] as string | undefined) ?? "");

  return (
    <form onSubmit={submit} encType="multipart/form-data">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className={s.addLayout}>
        <div className={s.attachPane}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {preview ? <img src={preview} alt="Asset" /> : <span>No image attached</span>}
        </div>
        <div className={s.formPane}>
          <Banner state={state.ok ? {} : state} />
          <h2 className={s.formSection}>Asset details</h2>
          <div className={s.formGrid}>
            <div className="field">
              <label className="label" htmlFor="af-type">Asset type</label>
              <select id="af-type" name="assetTypeId" className="select" required defaultValue={v("assetTypeId")}>
                <option value="" disabled>Select a type…</option>
                {categories.map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    {c.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                ))}
              </select>
              {err("assetTypeId")}
            </div>
            {editing ? (
              <div className="field">
                <label className="label" htmlFor="af-tag">Asset ID</label>
                <input id="af-tag" name="assetTag" className="input" required maxLength={40} defaultValue={v("assetTag")} />
                {err("assetTag")}
              </div>
            ) : (
              <div className="field">
                <label className="label" htmlFor="af-series">Asset ID series</label>
                <select id="af-series" name="seriesId" className="select" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                  {series.map((x) => <option key={x.id} value={x.id}>{x.name} — next {x.preview}</option>)}
                  <option value="MANUAL">Enter the ID manually</option>
                </select>
              </div>
            )}
            {!editing && seriesId === "MANUAL" ? (
              <div className="field">
                <label className="label" htmlFor="af-tag">Asset ID</label>
                <input id="af-tag" name="assetTag" className="input" required maxLength={40} defaultValue={v("assetTag")} />
                {err("assetTag")}
              </div>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="af-name">Asset name</label>
              <input id="af-name" name="name" className="input" required maxLength={120} defaultValue={v("name")} placeholder="e.g. MacBook Pro 14 (M3)" />
              {err("name")}
            </div>
            <div className="field">
              <label className="label" htmlFor="af-loc">Location</label>
              <select id="af-loc" name="locationId" className="select" required defaultValue={v("locationId")}>
                <option value="" disabled>Select a location…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {err("locationId")}
            </div>
            <div className="field">
              <label className="label" htmlFor="af-cond">Condition</label>
              <select id="af-cond" name="condition" className="select" required defaultValue={v("condition") || "NEW"}>
                {CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {!editing ? (
              <div className="field">
                <label className="label" htmlFor="af-status">Status</label>
                <select id="af-status" name="status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            ) : null}
            {!editing && status !== "AVAILABLE" ? (
              <div className="field wide">
                <label className="label" htmlFor="af-reason">Why is it not available?</label>
                <input id="af-reason" name="unavailableReason" className="input" required maxLength={300} defaultValue={state.values?.unavailableReason ?? ""} />
                {err("unavailableReason")}
              </div>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="af-serial">Serial number</label>
              <input id="af-serial" name="serialNumber" className="input" maxLength={80} defaultValue={v("serialNumber")} />
            </div>
            <div className="field wide">
              <label className="label" htmlFor="af-desc">Description</label>
              <textarea id="af-desc" name="description" className="textarea" rows={2} maxLength={1000} defaultValue={v("description")} />
            </div>
          </div>

          <h2 className={s.formSection} style={{ marginTop: 18 }}>Purchase and warranty</h2>
          <div className={s.formGrid}>
            <div className="field">
              <label className="label" htmlFor="af-pd">Purchased on</label>
              <input id="af-pd" name="purchaseDate" type="date" className="input" defaultValue={v("purchaseDate")} />
              {err("purchaseDate")}
            </div>
            <div className="field">
              <label className="label" htmlFor="af-we">Warranty expires on</label>
              <input id="af-we" name="warrantyExpiry" type="date" className="input" defaultValue={v("warrantyExpiry")} />
              {err("warrantyExpiry")}
            </div>
            <div className="field">
              <label className="label" htmlFor="af-cost">Purchase cost (₹)</label>
              <input id="af-cost" name="purchaseCost" className="input num" inputMode="decimal" defaultValue={v("purchaseCost")} />
              {err("purchaseCost")}
            </div>
            <div className="field">
              <label className="label" htmlFor="af-vendor">Vendor</label>
              <input id="af-vendor" name="vendor" className="input" maxLength={120} defaultValue={v("vendor")} />
            </div>
            <div className="field">
              <label className="label" htmlFor="af-inv">Invoice number</label>
              <input id="af-inv" name="invoiceNumber" className="input" maxLength={60} defaultValue={v("invoiceNumber")} />
            </div>
          </div>

          <h2 className={s.formSection} style={{ marginTop: 18 }}>Attachments</h2>
          <div className={s.formGrid}>
            <div className="field">
              <label className="label" htmlFor="af-img">Asset image (PNG or JPEG)</label>
              <input id="af-img" name="image" type="file" accept="image/png,image/jpeg" className="input"
                onChange={(e) => { const f = e.currentTarget.files?.[0]; setPreview(f ? URL.createObjectURL(f) : initial.imageUrl ?? null); }} />
            </div>
            <div className="field">
              <label className="label" htmlFor="af-docs">Documents (invoice, warranty card — up to 5)</label>
              <input id="af-docs" name="documents" type="file" multiple accept="application/pdf,image/png,image/jpeg" className="input" />
            </div>
          </div>

          <div className="row gap-2" style={{ justifyContent: "flex-end", marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <button type="button" className="btn" onClick={() => router.push(closeHref, { scroll: false })}>Cancel</button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : editing ? "Save" : "Add Asset"}</button>
          </div>
        </div>
      </div>
    </form>
  );
}
