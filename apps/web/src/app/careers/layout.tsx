import type { ReactNode, CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { isHexColor } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { careerConfig } from "./site";

/**
 * The public careers site: open to anyone, branded with the company's name,
 * and — when set in Hire › Settings › Career site — its logo and colours.
 * Accessibility settings (high contrast, larger text, reduced motion) apply
 * to every careers page, and there is always a skip link to the content.
 */
export default async function CareersLayout({ children }: { children: ReactNode }) {
  const tenant = await tenantFromHost();
  if (!tenant) notFound();
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { primaryColor: true, accentColor: true, logoFileId: true } });
  const config = await careerConfig(tenant.id);
  const primary = site && isHexColor(site.primaryColor) ? site.primaryColor : null;
  const accent = site && isHexColor(site.accentColor) ? site.accentColor : null;
  // Brand colours drive the primary buttons and links on every careers page.
  const brand = { ...(primary ? { "--brand-500": primary, "--brand-600": primary, "--brand-700": `color-mix(in srgb, ${primary} 85%, black)` } : {}), ...(accent ? { "--careers-accent": accent } : {}) } as CSSProperties;
  const a11y: CSSProperties = {
    ...(config.largeText ? { fontSize: "112.5%" } : {}),
    ...(config.highContrast ? { background: "#fff", color: "#000", ["--text-muted" as string]: "#222", ["--text-subtle" as string]: "#333", ["--border" as string]: "#000" } : {}),
  };
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)", ...brand, ...a11y }} data-careers-a11y={[config.highContrast && "contrast", config.largeText && "large", config.reduceMotion && "calm"].filter(Boolean).join(" ") || undefined}>
      {config.reduceMotion ? <style>{"[data-careers-a11y~='calm'] *{animation:none!important;transition:none!important;scroll-behavior:auto!important}"}</style> : null}
      {config.analyticsTagId ? <meta name="boos-analytics-tag" content={config.analyticsTagId} /> : null}
      <a href="#careers-main" className="sr-only" style={{ position: "absolute", left: -10000 }} data-testid="skip-link">Skip to content</a>
      <header style={{ background: "#fff", borderBottom: `3px solid ${primary ?? "var(--border, #e4e4e7)"}` }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Link href="/careers" className="strong" style={{ fontSize: 18, display: "inline-flex", alignItems: "center", gap: 10, color: primary ?? undefined }}>
            {site?.logoFileId ? <img src={`/careers/asset/${site.logoFileId}`} alt={`${tenant.name} logo`} style={{ height: 32, width: "auto" }} /> : null}
            {tenant.name} careers
          </Link>
          <nav aria-label="Careers" className="row gap-3 text-sm" style={{ flexWrap: "wrap" }}>
            <Link href="/careers">Open roles</Link>
            <Link href="/careers/faq">FAQ</Link>
            <Link href="/careers/alerts">Job alerts</Link>
            <Link href="/careers/community">Talent community</Link>
            <Link href="/signin" className="subtle">Employee sign-in</Link>
          </nav>
        </div>
      </header>
      <main id="careers-main" style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
    </div>
  );
}
