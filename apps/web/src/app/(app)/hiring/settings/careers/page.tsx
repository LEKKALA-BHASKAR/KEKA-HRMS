import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { companyUrl } from "@/lib/tenant-host-shared";
import { CareerSiteForm } from "../../_parts/talent-forms";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import s from "../../hire.module.css";

export const metadata = { title: "Career site · Hire" };

/**
 * Hire › Settings › Career site: the logo, colours, banner and About text on
 * the public /careers page, the embeddable jobs widget, and whether
 * applicants are invited to voluntary EEO self-identification.
 */
export default async function CareerSiteSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const [site, tenant] = await Promise.all([
    prisma.careerSiteSetting.findUnique({ where: { tenantId: viewer.tenantId } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: viewer.tenantId }, select: { subdomain: true } }),
  ]);
  const base = companyUrl(tenant.subdomain).replace(/\/+$/, "");
  const scriptSnippet = `<div id="boss-hr-jobs"></div>\n<script src="${base}/embed/careers.js" async></script>`;
  const iframeSnippet = `<iframe src="${base}/embed/careers" title="Open roles" style="width:100%;min-height:600px;border:0"></iframe>`;
  return (
    <>
      <HireSettingsTabs />
      <div className={s.head}>
        <div><h1 className={s.h1}>Career site</h1><p className={s.sub}>How your public careers page looks, and the jobs widget for your own website.</p></div>
        <Link className="btn" href="/careers" target="_blank">View the career site</Link>
      </div>
      <div className={s.settingsGrid}>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Branding</span></div>
          <div style={{ padding: 18 }}>
            <CareerSiteForm v={{
              headline: site?.headline ?? "", about: site?.about ?? "", primaryColor: site?.primaryColor ?? "#1266a8", accentColor: site?.accentColor ?? "#0f8a55",
              embedEnabled: site?.embedEnabled ?? true, collectEeo: site?.collectEeo ?? false, hasLogo: !!site?.logoFileId, hasBanner: !!site?.bannerFileId,
            }} />
          </div>
        </section>
        <section className={s.listCard}>
          <div className={s.listHead}><span className={s.listTitle}>Embed on your website</span><span className="text-xs subtle">{site?.embedEnabled === false ? "off" : "on"}</span></div>
          <div style={{ padding: 18 }} className="stack gap-3">
            <p className="text-sm muted" style={{ margin: 0 }}>Paste one of these where the job list should appear. It always shows your current open roles; candidates apply on the career site.</p>
            <div><div className="text-xs subtle" style={{ marginBottom: 4 }}>Script (resizes itself)</div><pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--surface-2)", padding: 10, borderRadius: 6, margin: 0 }}>{scriptSnippet}</pre></div>
            <div><div className="text-xs subtle" style={{ marginBottom: 4 }}>Plain iframe</div><pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--surface-2)", padding: 10, borderRadius: 6, margin: 0 }}>{iframeSnippet}</pre></div>
            {site?.embedEnabled === false ? <div className="text-xs neg">Embedding is switched off, so the widget shows nothing until you switch it on.</div> : null}
          </div>
        </section>
      </div>
    </>
  );
}
