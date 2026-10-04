import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { TAG_RULE_FIELDS } from "@keka/services";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveTagRuleAction, toggleTagRuleAction, applyTagRulesAction, saveAttributionRuleAction, toggleAttributionRuleAction } from "@/app/actions/hire-sourcing";
import { requireAnyOf } from "@/lib/hire-depth";
import { SourcingTabs, pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Sourcing rules · Hire" };

const SOURCES = ["CAREER_PORTAL", "REFERRAL", "INTERNAL", "JOB_BOARD", "AGENCY", "DIRECT_SOURCING", "WALK_IN"];
const MATCH = { UTM_SOURCE: "UTM source", EMAIL_DOMAIN: "Email domain", CAMPAIGN_CODE: "Campaign code" } as Record<string, string>;

/**
 * Rules that run on every candidate: tag rules (skills, title, employer,
 * city, experience → a tag) and source attribution rules (UTM source,
 * email domain or campaign code → a source and channel), applied when
 * someone applies on the careers site.
 */
export default async function SourcingRulesPage() {
  const viewer = await requireAnyOf([PERMISSIONS.CANDIDATE_MANAGE, PERMISSIONS.JOB_MANAGE]);
  const [tagRules, attrRules, channels] = await Promise.all([
    prisma.prospectTagRule.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ tag: "asc" }] }),
    prisma.sourceAttributionRule.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ priority: "asc" }] }),
    prisma.sourcingChannel.findMany({ where: { tenantId: viewer.tenantId, status: "ACTIVE" }, select: { id: true, name: true } }),
  ]);
  const channel = new Map(channels.map((c) => [c.id, c.name]));
  return (
    <>
      <SourcingTabs />
      <PageHead title="Sourcing rules" subtitle="Tag prospects automatically, and attribute applicants to the right source." />
      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <Card title="Tag rules" action={<ActButton action={applyTagRulesAction} hidden={{}} label="Apply to everyone now" />} tight>
          {tagRules.length === 0 ? <Empty title="No tag rules" /> : (
            <table className="data"><tbody>
              {tagRules.map((r) => <tr key={r.id}><td>#{r.tag}</td><td className="text-sm">{TAG_RULE_FIELDS[r.field as keyof typeof TAG_RULE_FIELDS] ?? r.field} “{r.value}”</td><td><Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "On" : "Paused"}</Badge></td><td className="right"><ActButton action={toggleTagRuleAction} hidden={{ id: r.id }} label={r.isActive ? "Pause" : "Resume"} /></td></tr>)}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <GrowthForm action={saveTagRuleAction} cols={3} submitLabel="Add rule" fields={[
              { name: "tag", label: "Tag", required: true }, { name: "field", label: "When", type: "select", required: true, options: Object.entries(TAG_RULE_FIELDS).map(([k, v]) => ({ value: k, label: v })) },
              { name: "value", label: "Value", required: true },
            ]} />
          </div>
        </Card>
        <Card title="Attribution rules" description="Checked in priority order; the first match wins. Use * as a wildcard." tight>
          {attrRules.length === 0 ? <Empty title="No attribution rules" /> : (
            <table className="data"><tbody>
              {attrRules.map((r) => <tr key={r.id}><td>{r.name}<div className="text-xs muted">{MATCH[r.matchField] ?? r.matchField} = {r.pattern} → {pretty(r.source)}{r.channelId ? ` (${channel.get(r.channelId) ?? "channel"})` : ""} · priority {r.priority}</div></td><td><Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "On" : "Paused"}</Badge></td><td className="right"><ActButton action={toggleAttributionRuleAction} hidden={{ id: r.id }} label={r.isActive ? "Pause" : "Resume"} /></td></tr>)}
            </tbody></table>
          )}
          <div style={{ padding: 12 }}>
            <GrowthForm action={saveAttributionRuleAction} cols={3} submitLabel="Add rule" fields={[
              { name: "name", label: "Name", required: true }, { name: "matchField", label: "Match on", type: "select", required: true, options: Object.entries(MATCH).map(([k, v]) => ({ value: k, label: v })) },
              { name: "pattern", label: "Pattern", required: true, placeholder: "e.g. naukri* or *.edu" },
              { name: "source", label: "Source", type: "select", required: true, options: SOURCES.map((s) => ({ value: s, label: pretty(s) })) },
              { name: "channelId", label: "Channel", type: "select", options: channels.map((c) => ({ value: c.id, label: c.name })) },
              { name: "priority", label: "Priority", type: "number", defaultValue: 100 },
            ]} />
          </div>
        </Card>
      </div>
    </>
  );
}
