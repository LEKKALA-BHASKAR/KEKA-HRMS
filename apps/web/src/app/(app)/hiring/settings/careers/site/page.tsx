import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { accessibilityIssues, brokenCareerLinks, extractLinks, hireStringList, LOCALE_NAMES } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveCareerSiteConfigAction, restoreCareerSiteSnapshotAction, snapshotCareerSiteAction } from "@/app/actions/hire-careers";
import { HireSettingsTabs } from "../../../_parts/settings-tabs";
import { when } from "../../../_parts/depth-tabs";

export const metadata = { title: "Careers site SEO and accessibility · Hire" };

/**
 * Hire › Settings › Careers site: search-engine titles and descriptions,
 * languages, accessibility options and the analytics measurement ID, an
 * accessibility and broken-link check of the published content, and every
 * earlier version of the site settings to roll back to.
 */
export default async function CareerSiteConfigPage() {
  const viewer = await requireAuth(PERMISSIONS.CAREER_PORTAL_MANAGE);
  const t = viewer.tenantId;
  const [config, site, content, snapshots, openJobs] = await Promise.all([
    prisma.careerSiteConfig.findUnique({ where: { tenantId: t } }),
    prisma.careerSiteSetting.findUnique({ where: { tenantId: t } }),
    prisma.careerContent.findMany({ where: { tenantId: t, status: { in: ["PUBLISHED", "DRAFT"] } } }),
    prisma.careerSiteSnapshot.findMany({ where: { tenantId: t }, orderBy: { version: "desc" }, take: 20 }),
    prisma.job.findMany({ where: { tenantId: t, status: "OPEN", isPublished: true }, select: { id: true } }),
  ]);
  const issues = accessibilityIssues({ primaryColor: site?.primaryColor ?? "#1266a8", accentColor: site?.accentColor ?? "#0f8a55" }, content);
  const links = content.flatMap((c) => extractLinks(`${c.body} ${site?.about ?? ""}`).map((url) => ({ from: c.title, url })));
  const broken = brokenCareerLinks(links, { openJobIds: new Set(openJobs.map((j) => j.id)), publishedSlugs: new Set(content.filter((c) => c.status === "PUBLISHED" && c.slug).map((c) => c.slug!)) });
  const locales = config ? hireStringList(config.locales) : ["en"];
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Careers site: SEO, languages and accessibility" actions={<ActButton action={snapshotCareerSiteAction} hidden={{}} label="Save a version now" input={{ name: "note", placeholder: "Note" }} />} />
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title="Settings">
          <GrowthForm action={saveCareerSiteConfigAction} cols={2} fields={[
            { name: "seoTitle", label: "Search title (≤ 70)", defaultValue: config?.seoTitle },
            { name: "analyticsTagId", label: "Analytics measurement ID", defaultValue: config?.analyticsTagId, placeholder: "G-XXXXXXX", hint: "Recorded on every page; visits are also counted in Hire › Insights." },
            { name: "seoDescription", label: "Search description (≤ 170)", type: "textarea", defaultValue: config?.seoDescription },
            { name: "locales", label: "Languages (two-letter codes, comma separated)", defaultValue: locales.join(", "), hint: Object.entries(LOCALE_NAMES).map(([k, v]) => `${k} ${v}`).join(" · ") },
            { name: "highContrast", label: "High-contrast mode", type: "checkbox", defaultChecked: config?.highContrast ?? false },
            { name: "largeText", label: "Larger text", type: "checkbox", defaultChecked: config?.largeText ?? false },
            { name: "reduceMotion", label: "Reduce motion", type: "checkbox", defaultChecked: config?.reduceMotion ?? false },
            { name: "requireAltText", label: "Require image descriptions (alt text)", type: "checkbox", defaultChecked: config?.requireAltText ?? true },
            { name: "groupByLocation", label: "Group open roles by location", type: "checkbox", defaultChecked: config?.groupByLocation ?? false },
            { name: "showRecruiterContacts", label: "Show recruiter contact cards", type: "checkbox", defaultChecked: config?.showRecruiterContacts ?? true },
          ]} />
        </Card>
        <div className="stack gap-3">
          <Card title="Accessibility check" description="Colour contrast against WCAG AA, images without descriptions, headings and link text.">
            {issues.length === 0 ? <Callout tone="success">No accessibility issues found.</Callout> : (
              <ul className="text-sm" data-testid="a11y-issues">{issues.map((i, n) => <li key={n}><strong>{i.where}:</strong> {i.issue}</li>)}</ul>
            )}
          </Card>
          <Card title="Link check" description="Links on the careers site to roles or pages that are no longer live. External sites are not fetched.">
            {broken.length === 0 ? <Callout tone="success">{links.length} link(s) checked; none broken.</Callout> : (
              <ul className="text-sm" data-testid="broken-links">{broken.map((b, n) => <li key={n}><strong>{b.from}:</strong> {b.url} — {b.why}</li>)}</ul>
            )}
          </Card>
          <Card title="Versions" tight>
            {snapshots.length === 0 ? <Empty title="No versions yet">A version is saved before every settings change.</Empty> : (
              <table className="data"><tbody>
                {snapshots.map((s) => <tr key={s.id}><td>v{s.version}<div className="text-xs muted">{s.note ?? ""}</div></td><td className="text-xs">{when(s.createdAt)}</td><td className="right"><ActButton action={restoreCareerSiteSnapshotAction} hidden={{ id: s.id }} label="Restore" confirmText={`Roll the careers site back to v${s.version}?`} /></td></tr>)}
              </tbody></table>
            )}
            <div className="text-xs subtle" style={{ padding: 8 }}><Badge>Tip</Badge> Branding (logo, colours) is part of each version too.</div>
          </Card>
        </div>
      </div>
    </>
  );
}
