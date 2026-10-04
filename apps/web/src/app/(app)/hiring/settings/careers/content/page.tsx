import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { pendingHireRequests } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { saveCareerContentAction } from "@/app/actions/hire-careers";
import { HireSettingsTabs } from "../../../_parts/settings-tabs";
import { day, pretty } from "../../../_parts/depth-tabs";

export const metadata = { title: "Careers content · Hire" };

const CONTENT_KINDS: Record<string, string> = {
  EVP: "Why join us (EVP)", STORY: "Employee story", CULTURE: "Culture", FAQ: "FAQ", DIVERSITY: "Diversity & inclusion", LOCATION: "Location page", RECRUITER: "Recruiter profile", LANDING: "Campaign landing page",
};

/**
 * Hire › Settings › Careers content: the employer-brand blocks on the
 * careers site. Each is drafted, approved, published and versioned.
 */
export default async function CareersContentPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CAREER_PORTAL_MANAGE);
  const { kind } = await searchParams;
  const [items, locations] = await Promise.all([
    prisma.careerContent.findMany({ where: { tenantId: viewer.tenantId, ...(kind && CONTENT_KINDS[kind] ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { updatedAt: "desc" }] }),
    prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, city: true } }),
  ]);
  const pending = await pendingHireRequests(viewer.tenantId, "CONTENT_PUBLISH", items.map((i) => i.id));
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Careers content" subtitle="Your story on the careers site. Publishing goes through an approval." actions={<Link className="btn" href="/careers" target="_blank">View the careers site</Link>} />
      <div className="row gap-2 wrap" style={{ marginBottom: 10 }}>
        <Link className={`btn sm${!kind ? " primary" : ""}`} href="?">All</Link>
        {Object.entries(CONTENT_KINDS).map(([k, l]) => <Link key={k} className={`btn sm${kind === k ? " primary" : ""}`} href={`?kind=${k}`}>{l}</Link>)}
      </div>
      <Reveal label="New content">
        <Card>
          <GrowthForm action={saveCareerContentAction} cols={3} submitLabel="Save draft" fields={[
            { name: "kind", label: "Kind", type: "select", required: true, options: Object.entries(CONTENT_KINDS).map(([value, label]) => ({ value, label })), defaultValue: kind ?? "EVP" },
            { name: "title", label: "Title (the question, for an FAQ)", required: true },
            { name: "locale", label: "Language", defaultValue: "en" },
            { name: "body", label: "Text", type: "textarea", rows: 6, required: true },
            { name: "slug", label: "Page address (stories, locations, landing pages)", placeholder: "campus-2026" },
            { name: "campaignCode", label: "Campaign code (landing pages)" },
            { name: "locationId", label: "Location", type: "select", options: locations.map((l) => ({ value: l.id, label: l.city ?? l.name })) },
            { name: "personName", label: "Person (story or recruiter)" }, { name: "personTitle", label: "Their title" }, { name: "contactEmail", label: "Contact email (recruiter)" },
            { name: "audience", label: "Audience", placeholder: "e.g. engineers, campus" },
            { name: "image", label: "Image (PNG/JPEG)", type: "file" }, { name: "imageAlt", label: "Image description (alt text)" },
            { name: "seoTitle", label: "SEO title" }, { name: "seoDescription", label: "SEO description" }, { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 },
          ]} />
        </Card>
      </Reveal>
      <Card tight>
        {items.length === 0 ? <Empty title="Nothing yet">Add your first block above.</Empty> : (
          <table className="data" data-testid="content-table"><thead><tr><th>Content</th><th>Kind</th><th>Language</th><th>Status</th><th>Updated</th></tr></thead><tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/hiring/settings/careers/content/${c.id}`}>{c.title}</Link>{c.slug ? <div className="text-xs muted">/careers/p/{c.slug}</div> : null}</td>
                <td>{CONTENT_KINDS[c.kind] ?? c.kind}</td>
                <td>{c.locale}</td>
                <td><Badge tone={c.status === "PUBLISHED" ? "success" : c.status === "PENDING_APPROVAL" ? "warning" : "neutral"}>{pending.has(c.id) ? "Awaiting approval" : pretty(c.status)}</Badge> <span className="text-xs subtle">v{c.version}</span></td>
                <td>{day(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>
    </>
  );
}
