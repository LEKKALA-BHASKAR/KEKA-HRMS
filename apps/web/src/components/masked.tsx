"use client";

import { useState } from "react";
import { IconEye, IconEyeOff } from "./icons";

/**
 * A sensitive number shown masked ("XXXXXX537M") with an eye to reveal it.
 * The full value is only sent to someone allowed to see it — this hides it
 * from a shoulder, not from the viewer.
 */
export function Masked({ value, keep = 4, group }: { value: string; keep?: number; group?: number }) {
  const [shown, setShown] = useState(false);
  const masked = value.slice(0, -keep).replace(/[A-Za-z0-9]/g, "X") + value.slice(-keep);
  const fmt = (v: string) => (group ? v.replace(new RegExp(`(.{${group}})(?=.)`, "g"), "$1-") : v);
  return (
    <span className="row gap-2" style={{ display: "inline-flex", alignItems: "center" }}>
      <span className="mono">{fmt(shown ? value : masked)}</span>
      <button type="button" className="k-icon-btn" onClick={() => setShown((v) => !v)} aria-label={shown ? "Hide" : "Show"} aria-pressed={shown}>
        {shown ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
      </button>
    </span>
  );
}
