import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { feedbackRules, promotionPolicyOf } from "@/lib/talent";
import { PageHead, Card } from "@/components/ui";
import { FeedbackSettingsForm, PromotionPolicyForm } from "../_parts/talent-forms";

/** Performance › Settings: who can give feedback (and anonymously), and promotion eligibility. */
export default async function PerformanceSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.PERFORMANCE_MANAGE);
  const [rules, policy] = await Promise.all([feedbackRules(viewer.tenantId), promotionPolicyOf(viewer.tenantId)]);
  return (
    <>
      <PageHead title="Performance settings" subtitle="Continuous feedback rules and promotion eligibility" />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Feedback" description="Applies to feedback given from Me › Performance and to feedback requests.">
          <FeedbackSettingsForm v={rules} />
        </Card>
        <Card title="Promotion eligibility" description="Managers can recommend a promotion in review-to-pay only for people who meet every rule.">
          <PromotionPolicyForm v={policy} />
        </Card>
      </div>
    </>
  );
}
