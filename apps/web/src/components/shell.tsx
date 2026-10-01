"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NavSection } from "@/lib/nav";
import { signOut, signOutEverywhere } from "@/app/actions/auth";
import { SearchPalette, type QuickAction } from "./search-palette";
import { Avatar } from "./avatar";
import {
  IconHome, IconUser, IconInbox, IconTeam, IconDollarCircle, IconOrg, IconEngage, IconUsers, IconUserPlus,
<<<<<<< HEAD
  IconTarget, IconTimer, IconWallet, IconLedger, IconSettings, IconBell, IconMenu, IconBook, IconChart,
=======
  IconTarget, IconTimer, IconWallet, IconLedger, IconSettings, IconBell, IconMenu, IconAlarm, IconGraduationCap,
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
} from "./icons";

const ICONS: Record<string, (p: { className?: string }) => ReactNode> = {
  home: IconHome, user: IconUser, inbox: IconInbox, team: IconTeam, finance: IconDollarCircle, org: IconOrg,
  engage: IconEngage, people: IconUsers, hire: IconUserPlus, performance: IconTarget, projects: IconTimer,
<<<<<<< HEAD
  payroll: IconWallet, ledger: IconLedger, settings: IconSettings, learn: IconBook, analytics: IconChart,
=======
  payroll: IconWallet, ledger: IconLedger, settings: IconSettings, time: IconAlarm, learn: IconGraduationCap,
>>>>>>> 87aca56 (Add comprehensive test suites for various service modules)
};

const pathOf = (href: string) => href.split("?")[0];

/** How well a tab's path claims the URL: the longest matching prefix wins. */
function claim(pathname: string, p: string): number {
  if (p === "/") return pathname === "/" ? 1 : -1;
  return pathname === p || pathname.startsWith(`${p}/`) ? p.length : -1;
}

export function activeLocation(sections: NavSection[], pathname: string) {
  let best = { score: -1, section: -1, tab: -1 };
  sections.forEach((s, si) => s.tabs.forEach((t, ti) => {
    for (const p of t.paths ?? [pathOf(t.href)]) {
      const score = claim(pathname, p);
      if (score > best.score) best = { score, section: si, tab: ti };
    }
  }));
  return best.score < 0 ? null : { section: sections[best.section], tab: sections[best.section].tabs[best.tab] };
}

export interface ShellUser { name: string; email: string; roles: string[]; title: string | null; employeeId: string | null; photoUrl: string | null }

export function AppShell({ sections, user, company, notifications, actions, settingsHref, children }: {
  sections: NavSection[]; user: ShellUser; company: string; notifications: number; actions: QuickAction[];
  /** The organisation settings, behind the gear in the top bar, for those who manage them. */
  settingsHref: string | null; children: ReactNode;
}) {
  const pathname = usePathname();
  const here = activeLocation(sections, pathname);
  const [railOpen, setRailOpen] = useState(false);
  const rail = useRef<HTMLElement>(null);
  useEffect(() => { setRailOpen(false); }, [pathname]);
  // Keep the active section in view on a long rail (admins have many).
  useEffect(() => { rail.current?.querySelector(".k-rail-item.active")?.scrollIntoView({ block: "nearest" }); }, [pathname]);

  const railItem = (s: NavSection) => {
    const Icon = ICONS[s.icon] ?? IconHome;
    const active = here?.section.key === s.key;
    return (
      <Link key={s.key} href={s.href} className={`k-rail-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
        <span className="k-rail-icon"><Icon />{s.count ? <span className="k-rail-dot" aria-label={`${s.count} pending`}>{s.count > 99 ? "99+" : s.count}</span> : null}</span>
        <span className="k-rail-label">{s.label}</span>
      </Link>
    );
  };

  return (
    <div className="k-shell">
      <header className="k-topbar">
        <Link href="/" className="k-brand" aria-label="Home">
          <span className="k-wordmark">keka</span>
          <svg className="k-spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" fill="currentColor" /></svg>
        </Link>
        <button type="button" className="k-topbar-btn k-rail-toggle" aria-label="Open navigation" aria-expanded={railOpen} onClick={() => setRailOpen((v) => !v)}><IconMenu /></button>
        <div className="k-company">{company}</div>
        <SearchPalette actions={actions} />
        <div className="k-topbar-spacer" />
        {settingsHref ? (
          <Link href={settingsHref} className={`k-topbar-btn${pathname.startsWith("/admin/") && !pathname.startsWith("/admin/audit") ? " active" : ""}`} aria-label="Settings" title="Settings">
            <IconSettings width={21} height={21} />
          </Link>
        ) : null}
        <Link href="/inbox/notifications" className="k-topbar-btn" aria-label={`Notifications${notifications ? `, ${notifications} unread` : ""}`}>
          <IconBell width={22} height={22} />
          {notifications > 0 ? <span className="k-bell-count">{notifications > 99 ? "99+" : notifications}</span> : null}
        </Link>
        <AvatarMenu user={user} />
      </header>

      <div className="k-body">
        <nav ref={rail} className={`k-rail${railOpen ? " open" : ""}`} aria-label="Main">
          {sections.map(railItem)}
        </nav>
        {railOpen ? <div className="k-rail-scrim" onClick={() => setRailOpen(false)} aria-hidden="true" /> : null}

        <div className="k-main">
          {here ? (
            <div className="k-tabbar" role="navigation" aria-label={here.section.label}>
              {here.section.tabs.map((t) => {
                const active = t === here.tab;
                return (
                  <Link key={t.href} href={t.href} className={`k-tab${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                    {t.label}
                    {t.count ? <span className="k-tab-count">{t.count > 99 ? "99+" : t.count}</span> : null}
                    {t.dot && !t.count ? <span className="k-tab-dot" aria-label="Needs attention" /> : null}
                  </Link>
                );
              })}
            </div>
          ) : null}
          <main className="content">{children}</main>
        </div>
      </div>
    </div>
  );
}

function AvatarMenu({ user }: { user: ShellUser }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="k-avatar-menu">
      <button type="button" className="k-avatar-btn" aria-label="Account menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Avatar name={user.name} photoUrl={user.photoUrl} size={38} ring />
      </button>
      {open ? (
        <div className="k-menu" role="menu">
          <div className="k-menu-head">
            <Avatar name={user.name} photoUrl={user.photoUrl} size={44} />
            <div style={{ minWidth: 0 }}>
              <div className="strong" style={{ fontSize: 14 }}>{user.name}</div>
              {user.title ? <div className="text-xs muted">{user.title}</div> : null}
              <div className="text-xs subtle" style={{ wordBreak: "break-all" }}>{user.email}</div>
            </div>
          </div>
          {user.roles.length ? <div className="row gap-1 wrap" style={{ padding: "0 14px 10px" }}>{user.roles.map((r) => <span key={r} className="badge neutral" style={{ fontSize: 10.5 }}>{r}</span>)}</div> : null}
          <div className="k-menu-items">
            {user.employeeId ? <Link role="menuitem" href={`/directory/${user.employeeId}`} onClick={() => setOpen(false)}>View profile</Link> : null}
            <Link role="menuitem" href="/account/password" onClick={() => setOpen(false)}>Change password</Link>
            <form action={signOutEverywhere}><button role="menuitem" type="submit">Sign out of all devices</button></form>
            <form action={signOut}><button role="menuitem" type="submit" className="danger">Log out</button></form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
