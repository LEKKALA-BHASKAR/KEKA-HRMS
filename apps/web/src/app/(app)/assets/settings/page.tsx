import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { getAssetSettings, formatAssetTag } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { saveAssetSettingsAction, saveAssetIdSeriesAction, toggleAssetIdSeriesAction } from "@/app/actions/assets";
import { StepForm, ModalButton, ActButton } from "../_ui";
import { PageHead } from "../_parts";
import s from "../assets.module.css";

/**
 * Asset settings: who approves a request and in what order, whether
 * employees may raise requests at all, acknowledgement reminders and
 * warranty alerts — and the ID series new assets are numbered from.
 */

const P = PERMISSIONS;
const APPROVER_OPTIONS = [["", "No approval at this level"], ["REPORTING_MANAGER", "Reporting manager"], ["ASSET_MANAGER", "Asset manager"]] as const;

function SeriesFields({ x }: { x?: { name: string; prefix: string; digits: number; suffix: string; nextNumber: number; isDefault: boolean } }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="ser-name">Series name</label>
        <input id="ser-name" name="name" className="input" required maxLength={60} defaultValue={x?.name ?? ""} placeholder="e.g. Laptops" />
      </div>
      <div className="row gap-3">
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="ser-prefix">Prefix</label>
          <input id="ser-prefix" name="prefix" className="input" maxLength={16} defaultValue={x?.prefix ?? "AST-"} />
        </div>
        <div className="field" style={{ width: 110 }}>
          <label className="label" htmlFor="ser-digits">Digits</label>
          <input id="ser-digits" name="digits" type="number" min={1} max={8} className="input num" required defaultValue={x?.digits ?? 5} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="ser-suffix">Suffix</label>
          <input id="ser-suffix" name="suffix" className="input" maxLength={16} defaultValue={x?.suffix ?? ""} />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="ser-next">Next number</label>
        <input id="ser-next" name="nextNumber" type="number" min={1} className="input num" required defaultValue={x?.nextNumber ?? 1} />
      </div>
      <label className="row gap-2 text-sm" style={{ alignItems: "center" }}>
        <input type="checkbox" name="isDefault" defaultChecked={x?.isDefault ?? false} /> Use this series by default for new assets
      </label>
    </>
  );
}

export default async function AssetSettingsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, P.ASSET_MANAGE)) redirect("/assets");
  const [settings, series] = await Promise.all([
    getAssetSettings(viewer.tenantId),
    prisma.assetIdSeries.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
  ]);
  const levels = [0, 1, 2].map((i) => {
    const k = settings.chain[i];
    return k === "REPORTING_MANAGER" || k === "ASSET_MANAGER" ? k : "";
  });

  return (
    <>
      <PageHead title="Asset settings" sub="How requests are approved, reminders and alerts, and how new assets are numbered." />

      <section className={s.panel} style={{ padding: 22, marginBottom: 22 }} aria-labelledby="req-h">
        <StepForm action={saveAssetSettingsAction} hidden={{}} submitLabel="Save settings">
          <h2 id="req-h" className={s.formSection}>Asset requests</h2>
          <label className="row gap-2 text-sm" style={{ alignItems: "center", marginBottom: 14 }}>
            <input type="checkbox" name="allowEmployeeRequests" defaultChecked={settings.allowEmployeeRequests} /> Employees can request assets from Me › Apps › Assets
          </label>
          <div className={s.formGrid} style={{ maxWidth: 760 }}>
            {levels.map((v, i) => (
              <div key={i} className="field">
                <label className="label" htmlFor={`lvl-${i + 1}`}>Approval level {i + 1}</label>
                <select id={`lvl-${i + 1}`} name={`level${i + 1}`} className="select" defaultValue={v}>
                  {APPROVER_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>With no levels, a request goes straight to &ldquo;Approved. Assignment pending&rdquo; for whoever assigns assets. A level whose approver is the requester is skipped.</p>
          <label className="row gap-2 text-sm" style={{ alignItems: "center" }}>
            <input type="checkbox" name="skipDuplicateApprover" defaultChecked={settings.skipDuplicateApprover} /> Skip a later level when the same person has already approved
          </label>

          <h2 className={s.formSection} style={{ marginTop: 22 }}>Reminders and alerts</h2>
          <div className={s.formGrid} style={{ maxWidth: 760 }}>
            <div className="field">
              <label className="label" htmlFor="ack-days">Remind employees to acknowledge every (days)</label>
              <input id="ack-days" name="ackReminderDays" type="number" min={1} max={30} className="input num" defaultValue={settings.ackReminderDays ?? ""} placeholder="Blank = never" />
            </div>
            <div className="field">
              <label className="label" htmlFor="war-days">Warn about warranties ending within (days)</label>
              <input id="war-days" name="warrantyAlertDays" type="number" min={1} max={365} className="input num" required defaultValue={settings.warrantyAlertDays} />
            </div>
          </div>
        </StepForm>
      </section>

      <section className={`${s.tableCard} ${s.alone}`} aria-labelledby="series-h">
        <div className={s.toolbar} style={{ justifyContent: "space-between" }}>
          <div>
            <h2 id="series-h" className={s.formSection} style={{ margin: 0 }}>Asset ID series</h2>
            <p className="text-sm muted" style={{ marginTop: 2 }}>New assets take the next number from the series picked when they are added.</p>
          </div>
          <ModalButton label="Add Series" className="btn primary" title="Add asset ID series" action={saveAssetIdSeriesAction} submitLabel="Add">
            <SeriesFields />
          </ModalButton>
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th>Series</th><th>Format</th><th>Next ID</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {series.length === 0 ? <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 30 }}>No series yet — asset IDs are typed by hand until you add one.</td></tr> : series.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}{x.isDefault ? <span className={s.sub}>Default</span> : null}</td>
                  <td><code>{x.prefix}{"#".repeat(x.digits)}{x.suffix}</code></td>
                  <td>{formatAssetTag(x, x.nextNumber)}</td>
                  <td>{x.isActive ? "Active" : "Inactive"}</td>
                  <td>
                    <span className={s.decide}>
                      <ModalButton label="Edit" className={s.linkish} title={`Edit ${x.name}`} action={saveAssetIdSeriesAction} hidden={{ id: x.id }} submitLabel="Save">
                        <SeriesFields x={x} />
                      </ModalButton>
                      <ActButton action={toggleAssetIdSeriesAction} hidden={{ id: x.id }} className={s.linkish}>{x.isActive ? "Deactivate" : "Activate"}</ActButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
