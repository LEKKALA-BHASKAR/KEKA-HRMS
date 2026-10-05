"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export interface SubTab { label: string; href: string; count?: number }

/**
 * The second row of tabs under a section's tab bar ("My Salary · Payslips ·
 * Income Tax"). The active one is the item whose path and query best match
 * the URL, so links like `?tab=archive` work as well as nested paths.
 */
export function SubTabs({ items, active }: { items: SubTab[]; active?: string }) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const score = (href: string) => {
    const [p, qs] = href.split("?");
    if (!(pathname === p || pathname.startsWith(`${p}/`))) return -1;
    let s = p.length;
    for (const [k, v] of new URLSearchParams(qs ?? "")) {
      if (search?.get(k) !== v) return -1;
      s += 1000;
    }
    return s;
  };
  const chosen = active ?? items.reduce<{ href: string; s: number }>((best, it) => {
    const s = score(it.href);
    return s > best.s ? { href: it.href, s } : best;
  }, { href: items[0]?.href ?? "", s: -1 }).href;
  return (
    <div className="k-subtabs" role="tablist">
      {items.map((it) => (
        <Link key={it.href} href={it.href} role="tab" aria-selected={it.href === chosen} className={`k-subtab${it.href === chosen ? " active" : ""}`} scroll={false}>
          {it.label}{it.count ? <span className="k-tab-count">{it.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}
