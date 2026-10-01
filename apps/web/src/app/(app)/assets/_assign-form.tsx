"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { assignAssetAction } from "@/app/actions/assets";
import { useAct, Banner } from "./_ui";

/** Assign one known asset: the employee picker modal opened from an asset's ⋮ menu. */
export function AssignForm({ assetId, closeHref, children }: { assetId: string; closeHref: string; children: ReactNode }) {
  const router = useRouter();
  const { state, submit, pending } = useAct(assignAssetAction, () => router.push(closeHref, { scroll: false }));
  return (
    <form onSubmit={submit}>
      <input type="hidden" name="assetId" value={assetId} />
      <Banner state={state.ok ? {} : state} />
      <div className="stack gap-3">{children}</div>
      <div className="row gap-2" style={{ justifyContent: "flex-end", marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <button type="button" className="btn" onClick={() => router.push(closeHref, { scroll: false })}>Cancel</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Assigning…" : "Assign"}</button>
      </div>
    </form>
  );
}
