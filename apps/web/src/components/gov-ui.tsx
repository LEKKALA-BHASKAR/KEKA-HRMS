import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { STATUS_TONE, label } from "@/lib/governance";

/** Presentational bits shared by the governance pages. Server components. */

export function Pill({ s }: { s: string }) {
  return <Badge tone={STATUS_TONE[s] ?? "neutral"} dot>{label(s)}</Badge>;
}

export function Tabs({ base, tabs, active, extra }: { base: string; tabs: Record<string, string>; active: string; extra?: ReactNode }) {
  return (
    <div className="tabs">
      {Object.entries(tabs).map(([k, v]) => <Link key={k} href={`${base}?tab=${k}`} className={`tab${active === k ? " active" : ""}`}>{v}</Link>)}
      {extra}
    </div>
  );
}

/** A plain GET search/filter bar. */
export function SearchBar({ action, tab, q, children }: { action: string; tab: string; q?: string; children?: ReactNode }) {
  return (
    <form method="get" action={action} className="row gap-2 wrap" style={{ marginBottom: 12, alignItems: "center" }}>
      <input type="hidden" name="tab" value={tab} />
      <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search…" style={{ width: 240 }} />
      {children}
      <button className="btn sm" type="submit">Filter</button>
    </form>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  if (empty) return <div className="empty"><div className="empty-title">Nothing here yet</div></div>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
