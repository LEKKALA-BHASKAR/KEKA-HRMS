import type { ReactNode, CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { isHexColor } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";

/**
 * The public careers site: open to anyone, branded with the company's name,
 * and — when set in Hire › Settings › Career site — its logo and colours.
 */
export default async function CareersLayout({ children }: { children: ReactNode }) {
  const tenant = await tenantFromHost();
  if (!tenant) notFound();
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { primaryColor: true, accentColor: true, logoFileId: true } });
  const primary = site && isHexColor(site.primaryColor) ? site.primaryColor : null;
  const accent = site && isHexColor(site.accentColor) ? site.accentColor : null;
  // Brand colours drive the primary buttons and links on every careers page.
  const brand = { ...(primary ? { "--brand-500": primary, "--brand-600": primary, "--brand-700": `color-mix(in srgb, ${primary} 85%, black)` } : {}), ...(accent ? { "--careers-accent": accent } : {}) } as CSSProperties;
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)", ...brand }}>
      <header style={{ background: "#fff", borderBottom: `3px solid ${primary ?? "var(--border, #e4e4e7)"}` }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/careers" className="strong" style={{ fontSize: 18, display: "inline-flex", alignItems: "center", gap: 10, color: primary ?? undefined }}>
            {site?.logoFileId ? <img src={`/careers/asset/${site.logoFileId}`} alt={`${tenant.name} logo`} style={{ height: 32, width: "auto" }} /> : null}
            {tenant.name} careers
          </Link>
          <Link href="/signin" className="text-sm subtle">Employee sign-in</Link>
        </div>
      </header>
      <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
    </div>
  );
}
