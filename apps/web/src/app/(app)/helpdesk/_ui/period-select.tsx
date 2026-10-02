"use client";

import { useQueryPatch } from "./controls";
import s from "./hd.module.css";

/** A period picker that writes ?period= (the Summary's analysis window). */
export function PeriodSelect({ value, options, param = "period" }: { value: string; options: Array<{ value: string; label: string }>; param?: string }) {
  const patch = useQueryPatch();
  return (
    <select className={`select ${s.selectBox}`} value={value} onChange={(e) => patch({ [param]: e.target.value })} aria-label="Period">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
