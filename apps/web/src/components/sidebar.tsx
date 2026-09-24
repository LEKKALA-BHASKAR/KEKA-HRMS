"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  IconHome, IconUsers, IconBuilding, IconWallet, IconPlay, IconReceipt,
  IconChart, IconShield, IconCalendar, IconClock, IconFile, IconSettings,
  IconBriefcase, IconInbox, IconHeadset, IconBox,
} from "./icons";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  count?: number;
  /** Match child routes too. */
  prefix?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

const ICONS: Record<string, (p: { className?: string }) => ReactNode> = {
  home: IconHome, users: IconUsers, building: IconBuilding, wallet: IconWallet,
  play: IconPlay, receipt: IconReceipt, chart: IconChart, shield: IconShield,
  calendar: IconCalendar, clock: IconClock, file: IconFile, settings: IconSettings,
  briefcase: IconBriefcase, inbox: IconInbox, headset: IconHeadset, box: IconBox,
};

export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  const isActive = (item: NavItem) => {
    if (item.href === "/") return pathname === "/";
    return item.prefix === false ? pathname === item.href : pathname.startsWith(item.href);
  };

  return (
    <nav className="sidebar-nav">
      {sections.map((section, i) => (
        <div className="nav-section" key={i}>
          {section.label ? <div className="nav-section-label">{section.label}</div> : null}
          {section.items.map((item) => {
            const Icon = ICONS[item.icon] ?? IconHome;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${isActive(item) ? " active" : ""}`}
              >
                <Icon className="icon" />
                <span>{item.label}</span>
                {item.count !== undefined && item.count > 0 ? (
                  <span className="nav-count">{item.count}</span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
