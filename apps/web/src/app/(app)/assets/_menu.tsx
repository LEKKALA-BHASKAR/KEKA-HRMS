import { PERMISSIONS } from "@keka/rbac";
import { ASSET_CONDITIONS, ASSET_CONDITION_LABEL } from "@keka/services";
import { can, type Viewer } from "@/lib/context";
import {
  recoverAssetAction, markAssetNotAvailableAction, markAssetAvailableAction, updateAssetConditionAction,
} from "@/app/actions/assets";
import type { MenuItem } from "./_ui";

/**
 * What a viewer may do here, and the ⋮ menu for one asset — the same five
 * actions Keka offers on an asset card: audit history, recover, mark as not
 * available, update condition and edit details.
 */

const P = PERMISSIONS;

export function assetPerms(viewer: Viewer) {
  return {
    manage: can(viewer, P.ASSET_MANAGE),
    assign: can(viewer, P.ASSET_ASSIGN),
    reports: can(viewer, P.ASSET_MANAGE) || can(viewer, P.REPORT_VIEW),
  };
}
export type AssetPerms = ReturnType<typeof assetPerms>;

const todayIso = () => new Date().toISOString().slice(0, 10);

export function ConditionSelect({ name, defaultValue, label = "Asset condition" }: { name: string; defaultValue?: string; label?: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={`${name}-sel`}>{label}</label>
      <select id={`${name}-sel`} name={name} className="select" defaultValue={defaultValue ?? "GOOD"} required>
        {ASSET_CONDITIONS.map((c) => <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>)}
      </select>
    </div>
  );
}

export function RecoverFields({ condition }: { condition: string }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="returnedOn">Recovered on</label>
        <input id="returnedOn" name="returnedOn" type="date" className="input" defaultValue={todayIso()} max={todayIso()} required />
      </div>
      <ConditionSelect name="conditionIn" defaultValue={condition} label="Condition on return" />
      <div className="field">
        <label className="label" htmlFor="damageCharge">Damage charge (₹)</label>
        <input id="damageCharge" name="damageCharge" type="number" min="0" step="1" className="input num" placeholder="Leave blank if none" />
        <div className="hint">Recovered through payroll, or the final settlement for a leaver.</div>
      </div>
      <div className="field">
        <label className="label" htmlFor="damageNote">Note</label>
        <textarea id="damageNote" name="damageNote" className="textarea" rows={2} placeholder="Describe any damage" />
      </div>
    </>
  );
}

export function assetMenu(opts: {
  asset: { id: string; status: string; condition: string };
  assignmentId?: string | null;
  perms: AssetPerms;
  /** The current page with its filters, to which "View Audit History" adds ?audit=. */
  here: string;
}): MenuItem[] {
  const { asset, perms } = opts;
  const join = opts.here.includes("?") ? "&" : "?";
  const items: MenuItem[] = [{ kind: "link", label: "View Audit History", icon: "history", href: `${opts.here}${join}audit=${asset.id}` }];
  if (perms.assign) {
    if (opts.assignmentId) {
      items.push({
        kind: "modal", label: "Recover Asset", icon: "recover", title: "Recover asset", submitLabel: "Recover",
        action: recoverAssetAction, hidden: { assignmentId: opts.assignmentId }, body: <RecoverFields condition={asset.condition} />,
      });
    }
    if (asset.status === "AVAILABLE") {
      items.push({ kind: "link", label: "Assign Asset", icon: "assign", href: `${opts.here}${join}assign=asset:${asset.id}` });
    }
    if (["IN_REPAIR", "LOST", "UNAVAILABLE"].includes(asset.status) || (asset.status === "RETIRED" && perms.manage)) {
      items.push({ kind: "act", label: "Mark as available", icon: "available", action: markAssetAvailableAction, hidden: { assetId: asset.id } });
    } else {
      items.push({
        kind: "modal", label: "Mark as not available", icon: "unavailable", title: "Mark as not available", submitLabel: "Save",
        action: markAssetNotAvailableAction, hidden: { assetId: asset.id },
        body: (
          <>
            {opts.assignmentId ? <div className="callout warning">This also ends the current assignment.</div> : null}
            <div className="field">
              <label className="label" htmlFor="na-status">Status</label>
              <select id="na-status" name="status" className="select" defaultValue="IN_REPAIR" required>
                <option value="IN_REPAIR">In repair</option>
                <option value="LOST">Lost</option>
                <option value="UNAVAILABLE">Not available (held back)</option>
                {perms.manage ? <option value="RETIRED">Retired</option> : null}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="na-reason">Reason</label>
              <textarea id="na-reason" name="reason" className="textarea" rows={3} required minLength={3} placeholder="e.g. Battery swelling — sent to the service centre" />
            </div>
          </>
        ),
      });
    }
    items.push({ kind: "divider" });
    items.push({
      kind: "modal", label: "Update asset condition", icon: "condition", title: "Update asset condition", submitLabel: "Update",
      action: updateAssetConditionAction, hidden: { assetId: asset.id },
      body: (
        <>
          <ConditionSelect name="condition" defaultValue={asset.condition} />
          <div className="field">
            <label className="label" htmlFor="cond-note">Note</label>
            <input id="cond-note" name="note" className="input" placeholder="Optional" />
          </div>
        </>
      ),
    });
  }
  if (perms.manage) items.push({ kind: "link", label: "Edit asset details", icon: "edit", href: `/assets/${asset.id}?edit=1` });
  else items.push({ kind: "link", label: "View asset details", icon: "view", href: `/assets/${asset.id}` });
  return items;
}
