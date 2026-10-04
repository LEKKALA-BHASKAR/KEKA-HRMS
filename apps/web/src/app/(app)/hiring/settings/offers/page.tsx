import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { GrowthForm, ActButton } from "@/components/growth-forms";
import { saveOfferClauseAction, toggleOfferClauseAction } from "@/app/actions/hire-offers";
import { HireSettingsTabs } from "../../_parts/settings-tabs";
import { inr, pretty } from "../../_parts/depth-tabs";

export const metadata = { title: "Offer clauses · Hire" };

/**
 * Hire › Settings › Offers: the clause library added to offer letters —
 * conditional clauses (by CTC, department or employment type), extra
 * components, tax disclaimers — in each language letters are sent in.
 */
export default async function OfferSettingsPage() {
  const viewer = await requireAuth(PERMISSIONS.OFFER_MANAGE);
  const [clauses, depts] = await Promise.all([
    prisma.offerClause.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ locale: "asc" }, { sortOrder: "asc" }, { title: "asc" }] }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const dept = new Map(depts.map((d) => [d.id, d.name]));
  return (
    <>
      <HireSettingsTabs />
      <PageHead title="Offer clauses" subtitle="Clauses that apply are added to the letter when an offer is drafted, and frozen once it is extended." />
      <Card tight>
        {clauses.length === 0 ? <Empty title="No clauses yet" /> : (
          <table className="data" data-testid="clause-table"><thead><tr><th>Clause</th><th>Applies when</th><th>Language</th><th /><th /></tr></thead><tbody>
            {clauses.map((c) => (
              <tr key={c.id}>
                <td><div className="strong">{c.title}</div><div className="text-xs muted">{pretty(c.kind)}{c.amount ? ` · ${inr(c.amount)}` : ""} · {c.body.slice(0, 120)}</div></td>
                <td className="text-xs">{[c.minCtc ? `CTC ≥ ${inr(c.minCtc)}` : null, c.departmentId ? dept.get(c.departmentId) : null, c.employmentType ? pretty(c.employmentType) : null].filter(Boolean).join(" · ") || "Always"}</td>
                <td>{c.locale}</td>
                <td><Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "In use" : "Retired"}</Badge></td>
                <td className="right"><ActButton action={toggleOfferClauseAction} hidden={{ id: c.id }} label={c.isActive ? "Retire" : "Restore"} /></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>
      <Card title="Add a clause">
        <GrowthForm action={saveOfferClauseAction} cols={4} submitLabel="Add" fields={[
          { name: "title", label: "Title", required: true },
          { name: "kind", label: "Kind", type: "select", options: ["GENERAL", "CONDITIONAL", "COMPONENT", "TAX_DISCLAIMER", "CONFIDENTIALITY"].map((k) => ({ value: k, label: pretty(k) })), defaultValue: "GENERAL" },
          { name: "locale", label: "Language", defaultValue: "en" },
          { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 },
          { name: "minCtc", label: "Only when CTC ≥ (₹)", type: "number" },
          { name: "departmentId", label: "Only for department", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })) },
          { name: "employmentType", label: "Only for employment type", type: "select", options: ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP"].map((k) => ({ value: k, label: pretty(k) })) },
          { name: "amount", label: "Component amount (₹)", type: "number" },
          { name: "body", label: "Clause text", type: "textarea", rows: 5, required: true },
        ]} />
      </Card>
    </>
  );
}
