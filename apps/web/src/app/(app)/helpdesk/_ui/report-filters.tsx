"use client";

import { DateRange, MultiSelect, useQueryPatch, type MultiOption } from "./controls";

/** Date range and category filters above the helpdesk reports; both write the URL. */
export function ReportFilters({ rangeKey, from, to, categories, cat }: { rangeKey: string; from: string; to: string; categories: MultiOption[]; cat: string[] }) {
  const patch = useQueryPatch();
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      <div style={{ minWidth: 260 }}>
        <DateRange boxed label="Date range" rangeKey={rangeKey} from={from} to={to}
          onApply={(v) => patch({ range: v.range, from: v.range === "custom" ? v.from : null, to: v.range === "custom" ? v.to : null })} />
      </div>
      <div style={{ minWidth: 220 }}>
        <MultiSelect boxed label="Category" options={categories} value={cat} onApply={(v) => patch({ cat: v })} />
      </div>
    </div>
  );
}
