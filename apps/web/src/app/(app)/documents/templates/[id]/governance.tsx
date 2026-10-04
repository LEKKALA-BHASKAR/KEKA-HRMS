import { prisma } from "@keka/db";
import { userOptions, departmentOptions, userNames, fmtDate } from "@/lib/governance";
import { Card, KeyValue, Callout } from "@/components/ui";
import { Pill, Table } from "@/components/gov-ui";
import { SpecForm, ActButton } from "@/components/gov-forms";
import { submitTemplateAction, reviewTemplateAction, templateGovernanceAction } from "@/app/actions/doc-ops";

/**
 * Template governance: owner, department scope, approval before use (when
 * the tenant requires it, through the workflow engine), owner reviews and
 * the revision history.
 */
export async function TemplateGovernance({ tenantId, templateId }: { tenantId: string; templateId: string }) {
  const [t, revisions, settings, users, departments] = await Promise.all([
    prisma.documentTemplate.findUniqueOrThrow({ where: { id: templateId } }),
    prisma.documentTemplateRevision.findMany({ where: { tenantId, templateId }, orderBy: { version: "desc" }, take: 30 }),
    prisma.letterSettings.findUnique({ where: { tenantId } }),
    userOptions(tenantId), departmentOptions(tenantId),
  ]);
  const names = await userNames(tenantId, [t.ownerUserId, t.approvedByUserId, ...revisions.map((r) => r.editedByUserId)]);
  const depts = Array.isArray(t.departmentIds) ? t.departmentIds.map(String) : [];
  const overdue = t.nextReviewOn && t.nextReviewOn < new Date();
  return (
    <div className="grid grid-2" style={{ alignItems: "start", marginTop: 16 }}>
      <Card title="Ownership and approval">
        <KeyValue items={[
          ["Version", `v${t.version}`], ["Approval", <Pill key="a" s={t.approvalStatus} />], ["Approved", t.approvedAt ? `${fmtDate(t.approvedAt)} by ${t.approvedByUserId ? names.get(t.approvedByUserId) : "—"}` : null],
          ["Owner", t.ownerUserId ? names.get(t.ownerUserId) : null], ["Next owner review", <span key="r" className={overdue ? "neg" : ""}>{fmtDate(t.nextReviewOn)}{overdue ? " (overdue)" : ""}</span>], ["Last reviewed", fmtDate(t.lastReviewedAt)],
          ["Used by", depts.length ? departments.filter((d) => depts.includes(d.value)).map((d) => d.label).join(", ") : "All departments"],
        ]} />
        {settings?.requireTemplateApproval && (t.approvalStatus === "DRAFT" || t.approvalStatus === "REJECTED") ? <div style={{ marginTop: 12 }}><Callout tone="warning">Letters cannot be generated from this version until it is approved.</Callout><div style={{ marginTop: 8 }}><ActButton action={submitTemplateAction} hidden={{ id: t.id }} label="Submit for approval" variant="primary" /></div></div> : null}
        {t.approvalStatus === "PENDING_APPROVAL" ? <div style={{ marginTop: 12 }}><Callout>Awaiting approval in Inbox › Approvals. A different person must approve it.</Callout></div> : null}
        <div style={{ marginTop: 12 }}><ActButton action={reviewTemplateAction} hidden={{ id: t.id }} label="Mark reviewed — still accurate" /></div>
        <div style={{ marginTop: 12 }}>
          <SpecForm action={templateGovernanceAction} hidden={{ id: t.id }} submitLabel="Save owner and scope" fields={[
            { name: "ownerUserId", label: "Owner", type: "select", options: users, defaultValue: t.ownerUserId },
            { name: "departmentIds", label: "Only for these departments", type: "multiselect", options: departments, defaultValue: depts, hint: "Leave empty for everyone." },
          ]} />
        </div>
      </Card>
      <Card title="Revisions" description="Every saved change to the text keeps the earlier version.">
        <Table head={["Version", "Saved", "By", "Name", "Size"]} empty={!revisions.length}>
          {revisions.map((r) => <tr key={r.id}><td className="num">v{r.version}</td><td>{fmtDate(r.createdAt)}</td><td>{r.editedByUserId ? names.get(r.editedByUserId) : "—"}</td><td>{r.name}</td><td className="num">{r.body.length.toLocaleString("en-IN")} chars</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
