import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { hireDepthConfig } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveHireOpsSettingsAction, saveDispositionReasonAction, toggleDispositionReasonAction } from "@/app/actions/hire-ops";
import { HireSettingsTabs } from "../../_parts/settings-tabs";

export const metadata = { title: "Hiring operations · Hire" };

/**
 * Hire › Settings › Operations: the SLAs the alert job checks, requisition
 * intake questions and ageing, whether careers postings need approval, the
 * pre-extend offer checklist, extra bias terms for feedback, the no-show
 * limit, consent validity, and the reject/withdraw reason library.
 */
export default async function HireOpsSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.JOB_MANAGE);
  const [cfg, reasons] = await Promise.all([hireDepthConfig(viewer.tenantId), prisma.dispositionReason.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] })]);
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Hiring operations" subtitle="SLAs, intake, approvals and the reason library." />
      <Card title="SLAs and controls">
        <GrowthForm action={saveHireOpsSettingsAction} cols={4} fields={[
          { name: "screenSlaHours", label: "Screen new applicants within (h)", type: "number", defaultValue: cfg.screenSlaHours },
          { name: "feedbackSlaHours", label: "Feedback within (h of interview)", type: "number", defaultValue: cfg.feedbackSlaHours },
          { name: "offerResponseSlaHours", label: "Offer answer within (h)", type: "number", defaultValue: cfg.offerResponseSlaHours },
          { name: "requisitionApprovalSlaHours", label: "Requisition approval within (h)", type: "number", defaultValue: cfg.requisitionApprovalSlaHours },
          { name: "requisitionMaxAgeDays", label: "Flag requisitions open longer than (days)", type: "number", defaultValue: cfg.requisitionMaxAgeDays },
          { name: "noShowLimit", label: "Close application after no-shows", type: "number", defaultValue: cfg.noShowLimit },
          { name: "consentValidityDays", label: "Contact consent lasts (days)", type: "number", defaultValue: cfg.consentValidityDays },
          { name: "reactivationAfterDays", label: "Re-engage past candidates after (days)", type: "number", defaultValue: cfg.reactivationAfterDays },
          { name: "intakeQuestions", label: "Requisition intake questions (one per line)", type: "textarea", defaultValue: cfg.intakeQuestions.join("\n"), rows: 4 },
          { name: "offerChecklist", label: "Checklist before an offer is extended (one per line)", type: "textarea", defaultValue: cfg.offerChecklist.join("\n"), rows: 4 },
          { name: "biasTerms", label: "Extra terms to flag in interview feedback (comma separated)", type: "textarea", defaultValue: cfg.biasTerms.join(", "), rows: 2 },
          { name: "requirePostingApproval", label: "Careers postings need approval before they go live", type: "checkbox", defaultChecked: cfg.requirePostingApproval },
        ]} />
      </Card>
      <Card title="Reject and withdraw reasons" tight>
        {reasons.length === 0 ? <Empty title="No reasons yet">Add the reasons recruiters choose from when rejecting, and candidates when withdrawing.</Empty> : (
          <table className="data"><tbody>
            {reasons.map((r) => <tr key={r.id}><td>{r.label}</td><td><Badge tone={r.kind === "REJECT" ? "danger" : "info"}>{r.kind === "REJECT" ? "Reject" : "Withdraw"}</Badge></td><td><Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "In use" : "Retired"}</Badge></td><td className="right"><ActButton action={toggleDispositionReasonAction} hidden={{ id: r.id }} label={r.isActive ? "Retire" : "Restore"} /></td></tr>)}
          </tbody></table>
        )}
        <div style={{ padding: 12 }}>
          <GrowthForm action={saveDispositionReasonAction} cols={3} submitLabel="Add reason" fields={[
            { name: "label", label: "Reason", required: true },
            { name: "kind", label: "Used when", type: "select", options: [{ value: "REJECT", label: "Rejecting" }, { value: "WITHDRAW", label: "The candidate withdraws" }], defaultValue: "REJECT" },
          ]} />
        </div>
      </Card>
    </>
  );
}
