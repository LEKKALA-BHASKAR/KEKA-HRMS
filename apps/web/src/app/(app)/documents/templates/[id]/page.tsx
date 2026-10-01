import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { LETTER_CATEGORIES, LETTER_PLACEHOLDERS, LETTER_WORKFLOWS, letterValues } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card } from "@/components/ui";
import { TemplateEditor } from "../../letters/forms";

/** Create (id "new") or edit a letter template, with a live preview filled from your own record. */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAuth(P.DOCUMENT_TEMPLATE_MANAGE);
  const { id } = await params;
  const template = id === "new" ? null : await prisma.documentTemplate.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (id !== "new" && !template) notFound();
  const sample = viewer.employee ? await letterValues(viewer.tenantId, viewer.employee.id) : null;
  return (
    <>
      <PageHead
        title={template ? template.name : "New letter template"}
        subtitle="Placeholders are filled from the employee's record when a letter is generated. Editing a template never changes letters already generated."
        actions={<Link className="btn ghost" href="/documents?tab=templates">Back to templates</Link>}
      />
      <Card>
        <TemplateEditor
          template={template ? { id: template.id, name: template.name, category: template.category, body: template.body, workflow: template.workflow ?? "", isArchived: template.isArchived } : null}
          categories={[...LETTER_CATEGORIES]} workflows={{ ...LETTER_WORKFLOWS }} placeholders={LETTER_PLACEHOLDERS} sample={sample}
        />
      </Card>
    </>
  );
}
