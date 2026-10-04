import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { pendingHireRequest } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Callout } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveCareerContentAction, submitCareerContentAction, archiveCareerContentAction, restoreCareerContentVersionAction } from "@/app/actions/hire-careers";
import { HireSettingsTabs } from "../../../../_parts/settings-tabs";
import { when, pretty } from "../../../../_parts/depth-tabs";

export const metadata = { title: "Careers content · Hire" };

/** One careers content block: edit (as a new draft version), submit for approval, archive, or roll back to an earlier version. */
export default async function CareerContentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.CAREER_PORTAL_MANAGE);
  const { id } = await params;
  const c = await prisma.careerContent.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!c) notFound();
  const [pending, locations] = await Promise.all([pendingHireRequest(viewer.tenantId, "CONTENT_PUBLISH", c.id), prisma.location.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true, city: true } })]);
  const locked = c.status === "PENDING_APPROVAL";
  return (
    <>
      <HireSettingsTabs />
      <PageHead title={c.title} subtitle={`${pretty(c.kind)} · ${c.locale} · v${c.version}`} actions={<>
        <Badge tone={c.status === "PUBLISHED" ? "success" : locked ? "warning" : "neutral"}>{pending ? "Awaiting approval" : pretty(c.status)}</Badge>
        {["DRAFT", "ARCHIVED"].includes(c.status) ? <ActButton action={submitCareerContentAction} hidden={{ id: c.id }} label="Submit to publish" variant="primary" /> : null}
        {["DRAFT", "PUBLISHED"].includes(c.status) ? <ActButton action={archiveCareerContentAction} hidden={{ id: c.id }} label="Archive" confirmText="Take this off the careers site?" /> : null}
        {c.status === "PUBLISHED" && c.slug ? <Link className="btn" href={`/careers/p/${c.slug}`} target="_blank">View</Link> : null}
      </>} />
      {locked ? <Callout tone="warning">Waiting for approval in the approver&apos;s Inbox; it cannot be edited until decided.</Callout> : null}
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title="Edit">
          {locked ? <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div> : (
            <GrowthForm action={saveCareerContentAction} hidden={{ id: c.id, kind: c.kind }} cols={2} submitLabel="Save as new draft version" fields={[
              { name: "title", label: "Title", required: true, defaultValue: c.title }, { name: "locale", label: "Language", defaultValue: c.locale },
              { name: "body", label: "Text", type: "textarea", rows: 10, required: true, defaultValue: c.body },
              { name: "slug", label: "Page address", defaultValue: c.slug }, { name: "campaignCode", label: "Campaign code", defaultValue: c.campaignCode },
              { name: "locationId", label: "Location", type: "select", options: locations.map((l) => ({ value: l.id, label: l.city ?? l.name })), defaultValue: c.locationId },
              { name: "audience", label: "Audience", defaultValue: c.audience },
              { name: "personName", label: "Person", defaultValue: c.personName }, { name: "personTitle", label: "Their title", defaultValue: c.personTitle },
              { name: "contactEmail", label: "Contact email", defaultValue: c.contactEmail },
              { name: "image", label: "Replace image", type: "file" }, { name: "imageAlt", label: "Image description (alt text)", defaultValue: c.imageAlt },
              { name: "seoTitle", label: "SEO title", defaultValue: c.seoTitle }, { name: "seoDescription", label: "SEO description", defaultValue: c.seoDescription },
              { name: "sortOrder", label: "Order", type: "number", defaultValue: c.sortOrder }, { name: "note", label: "What changed" },
            ]} />
          )}
        </Card>
        <Card title="Versions" tight>
          <table className="data" data-testid="content-versions"><tbody>
            <tr><td>v{c.version} (current)</td><td className="text-xs">{when(c.updatedAt)}</td><td /></tr>
            {c.versions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version}<div className="text-xs muted">{(v.snapshot as { title?: string }).title}{v.note ? ` · ${v.note}` : ""}</div></td>
                <td className="text-xs">{when(v.createdAt)}</td>
                <td className="right">{locked ? null : <ActButton action={restoreCareerContentVersionAction} hidden={{ versionId: v.id }} label="Restore" confirmText={`Restore v${v.version} as a new draft?`} />}</td>
              </tr>
            ))}
          </tbody></table>
        </Card>
      </div>
    </>
  );
}
