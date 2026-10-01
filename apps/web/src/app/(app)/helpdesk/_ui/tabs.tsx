import Link from "next/link";
import { SubTabs } from "@/components/subtabs";
import s from "./hd.module.css";

/** Org › Helpdesk sub-tabs: Summary · Tickets · Reports · Settings. */
export function HelpdeskTabs({ canSettings, active }: { canSettings: boolean; active?: string }) {
  return (
    <SubTabs active={active} items={[
      { label: "Summary", href: "/helpdesk" },
      { label: "Tickets", href: "/helpdesk/tickets" },
      { label: "Reports", href: "/helpdesk/reports" },
      ...(canSettings ? [{ label: "Settings", href: "/helpdesk/settings/categories" }] : []),
    ]} />
  );
}

/** A segmented bar of in-page tabs ("Open Tickets | Closed Tickets", the settings tabs). */
export function Segments({ items, active }: { items: Array<{ key: string; label: string; href: string }>; active: string }) {
  return (
    <nav className={s.seg} aria-label="Sections">
      {items.map((it) => (
        <Link key={it.key} href={it.href} className={`${s.segItem}${it.key === active ? ` ${s.segActive}` : ""}`} aria-current={it.key === active ? "page" : undefined}>
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export function SettingsTabs({ active }: { active: "categories" | "business-hours" | "canned-responses" | "closing-reasons" }) {
  return (
    <Segments active={active} items={[
      { key: "categories", label: "Ticket Categories", href: "/helpdesk/settings/categories" },
      { key: "business-hours", label: "Business Hours", href: "/helpdesk/settings/business-hours" },
      { key: "canned-responses", label: "Canned Responses", href: "/helpdesk/settings/canned-responses" },
      { key: "closing-reasons", label: "Closing reasons", href: "/helpdesk/settings/closing-reasons" },
    ]} />
  );
}
