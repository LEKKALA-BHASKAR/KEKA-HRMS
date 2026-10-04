import { prisma } from "@keka/db";
import { openWindowsFor, benefitEligibility, benefitPremium, monthlyBasicOf, BENEFIT_TYPES, LIFE_EVENT_KINDS, DEPENDENT_RELATIONS } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { enrollBenefitAction, dependentRequestAction, lifeEventAction, benefitExceptionAction } from "@/app/actions/benefits";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { PENDING_APPROVAL: "warning", ACTIVE: "success", REJECTED: "danger", WAIVED: "info", ENDED: "neutral", CANCELLED: "neutral", PENDING: "warning", APPROVED: "success", WITHDRAWN: "neutral" };
const TIER_LABEL: Record<string, string> = { EMPLOYEE: "Just me", EMPLOYEE_SPOUSE: "Me + spouse", FAMILY: "Family" };

/** My benefits: open windows to enrol or waive, my cover, my dependents and life events. */
export default async function MyBenefitsPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) return <><PageHead title="Benefits" /><Empty title="No employee record is linked to this login." /></>;
  const me = viewer.employee.id;
  const t = viewer.tenantId;
  const [windows, mine, dependents, depRequests, lifeEvents, exceptions, basic] = await Promise.all([
    openWindowsFor(me),
    prisma.benefitEnrollment.findMany({ where: { employeeId: me, tenantId: t }, include: { plan: { select: { name: true, type: true, provider: true, coverageAmount: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.dependent.findMany({ where: { employeeId: me }, orderBy: { name: "asc" } }),
    prisma.dependentRequest.findMany({ where: { employeeId: me, tenantId: t }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.benefitLifeEvent.findMany({ where: { employeeId: me, tenantId: t }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.benefitEligibilityException.findMany({ where: { employeeId: me, tenantId: t }, orderBy: { createdAt: "desc" }, take: 10 }),
    monthlyBasicOf(me),
  ]);
  const planIds = [...new Set(windows.flatMap((w) => w.planIds))];
  const plans = await prisma.benefitPlan.findMany({ where: { tenantId: t, id: { in: planIds }, status: "ACTIVE" }, orderBy: { name: "asc" } });
  const elig = new Map(await Promise.all(plans.map(async (p) => [p.id, await benefitEligibility(p.id, me)] as const)));
  const current = new Map(mine.filter((e) => ["ACTIVE", "PENDING_APPROVAL", "WAIVED"].includes(e.status)).map((e) => [e.planId, e]));
  const depOptions = dependents.map((d) => ({ value: d.id, label: `${d.name} (${d.relationship.toLowerCase()})${d.verifiedAt ? "" : " — not yet verified"}` }));
  const pendingExc = new Set(exceptions.filter((x) => x.status === "PENDING").map((x) => x.planId));
  return (
    <>
      <PageHead title="Benefits" subtitle="Your insurance and retirement cover in BooS-HR" />
      {windows.length === 0 ? <Callout title="Enrolment is closed">You can enrol during open enrolment, in your first 30 days, or within 30 days of a life event such as marriage or a birth.</Callout> : (
        windows.map((w) => (
          <Card key={w.id} title={w.name} description={`Open until ${formatDate(w.closesOn)}. Choose cover for each plan or waive it.`}>
            <div className="stack gap-3">
              {plans.filter((p) => w.planIds.includes(p.id)).map((p) => {
                const e = elig.get(p.id)!;
                const cur = current.get(p.id);
                const retirement = p.type === "RETIREMENT" || p.employerRule === "MATCH_PERCENT_OF_BASIC";
                const pp = { monthlyPremium: Number(p.monthlyPremium), tierFactors: p.tierFactors as Record<string, number> | null, employerRule: p.employerRule, employerValue: Number(p.employerValue), employerCap: p.employerCap === null ? null : Number(p.employerCap), type: p.type };
                return (
                  <div key={p.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10 }}>
                    <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                      <div><span className="strong">{p.name}</span> <span className="text-xs subtle">{BENEFIT_TYPES[p.type as keyof typeof BENEFIT_TYPES] ?? p.type}{p.provider ? ` · ${p.provider}` : ""}{p.coverageAmount ? ` · cover ${formatINR(Number(p.coverageAmount))}` : ""}</span></div>
                      {cur ? <Badge tone={TONE[cur.status] ?? "neutral"}>{cur.status === "WAIVED" ? "waived" : `${TIER_LABEL[cur.tier] ?? cur.tier} · ${cur.status.toLowerCase().replace("_", " ")}`}</Badge> : null}
                    </div>
                    {p.description ? <div className="text-sm subtle">{p.description}</div> : null}
                    {retirement ? (
                      <div className="text-sm">The company matches your contribution up to {Number(p.employerValue)}% of basic{basic ? ` (basic ${formatINR(basic)} a month)` : ""}.</div>
                    ) : (
                      <div className="row gap-3 wrap text-sm" style={{ margin: "4px 0" }}>
                        {(["EMPLOYEE", "EMPLOYEE_SPOUSE", "FAMILY"] as const).map((tier) => { const c = benefitPremium(pp, tier); return <span key={tier}>{TIER_LABEL[tier]}: you pay <strong>{formatINR(c.employee)}</strong>/mo (company {formatINR(c.employer)})</span>; })}
                      </div>
                    )}
                    {!e.eligible ? (
                      <div className="text-sm">
                        <span className="neg">Not eligible: {e.gaps.join(" ")}</span>
                        {pendingExc.has(p.id) ? <div className="text-xs subtle">Exception requested — awaiting a decision.</div> : (
                          <Reveal label="Ask for an exception"><GrowthForm action={benefitExceptionAction} hidden={{ planId: p.id }} cols={1} compact submitLabel="Send request" fields={[{ name: "reason", label: "Why you should be covered", type: "textarea", required: true }]} /></Reveal>
                        )}
                      </div>
                    ) : !cur || cur.status === "WAIVED" ? (
                      <div className="row gap-2 wrap" style={{ alignItems: "flex-start", marginTop: 6 }}>
                        <Reveal label="Enrol">
                          <GrowthForm action={enrollBenefitAction} hidden={{ planId: p.id, intent: "enrol" }} cols={2} compact submitLabel="Request enrolment" fields={retirement
                            ? [{ name: "contributionPct", label: "My contribution (% of basic)", type: "number", required: true, defaultValue: Number(p.employerValue) }]
                            : [
                              { name: "tier", label: "Cover", type: "select", required: true, options: Object.entries(TIER_LABEL).map(([value, label]) => ({ value, label })), defaultValue: "EMPLOYEE" },
                              { name: "dependentIds", label: "Dependents to cover", type: "checklist", options: depOptions },
                            ]} />
                        </Reveal>
                        {!cur ? <GrowthForm action={enrollBenefitAction} hidden={{ planId: p.id, intent: "waive" }} cols={1} compact submitLabel="Waive this plan" fields={[]} /> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        ))
      )}

      <Card tight title="My cover">
        {mine.length === 0 ? <Empty title="No benefit enrolments" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Plan</th><th>Cover</th><th className="num">You pay / mo</th><th className="num">Company pays / mo</th><th>From</th><th>Status</th></tr></thead>
            <tbody>{mine.map((e) => <tr key={e.id}><td className="text-sm">{e.plan.name}</td><td className="text-xs">{TIER_LABEL[e.tier] ?? e.tier}{e.dependentIds.length ? ` · ${e.dependentIds.length} dependent(s)` : ""}{e.contributionPct ? ` · ${Number(e.contributionPct)}% of basic` : ""}</td><td className="num">{formatINR(Number(e.employeeMonthly))}</td><td className="num">{formatINR(Number(e.employerMonthly))}</td><td className="text-xs">{e.coverageStart ? formatDate(e.coverageStart) : "—"}{e.coverageEnd ? ` – ${formatDate(e.coverageEnd)}` : ""}</td><td><Badge tone={TONE[e.status] ?? "neutral"}>{e.status.toLowerCase().replace("_", " ")}</Badge></td></tr>)}</tbody></table></div>
        )}
      </Card>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="My dependents" description="Adding someone needs proof of relationship; HR approves it before they can be covered.">
          {dependents.length === 0 ? <div className="text-sm subtle">None recorded.</div> : (
            <div className="stack gap-1">{dependents.map((d) => <div key={d.id} className="row gap-2" style={{ justifyContent: "space-between" }}><span className="text-sm">{d.name} · {d.relationship.toLowerCase()}{d.dateOfBirth ? ` · ${formatDate(d.dateOfBirth)}` : ""}</span><Badge tone={d.verifiedAt ? "success" : "warning"}>{d.verifiedAt ? "verified" : "unverified"}</Badge></div>)}</div>
          )}
          {depRequests.length ? <div className="text-xs subtle" style={{ marginTop: 8 }}>{depRequests.map((r) => `${r.action.toLowerCase()} ${r.name}: ${r.status.toLowerCase()}`).join(" · ")}</div> : null}
          <div style={{ marginTop: 10 }}>
            <Reveal label="Add, change or remove a dependent">
              <GrowthForm action={dependentRequestAction} cols={2} submitLabel="Send request" fields={[
                { name: "action", label: "Request", type: "select", required: true, options: [{ value: "ADD", label: "Add a dependent" }, { value: "UPDATE", label: "Correct details" }, { value: "REMOVE", label: "Remove" }], defaultValue: "ADD" },
                { name: "dependentId", label: "Existing dependent (change / remove)", type: "select", options: dependents.map((d) => ({ value: d.id, label: d.name })) },
                { name: "name", label: "Name" },
                { name: "relationship", label: "Relationship", type: "select", options: DEPENDENT_RELATIONS.map((r) => ({ value: r, label: r.toLowerCase().replace(/_/g, " ") })) },
                { name: "dateOfBirth", label: "Date of birth", type: "date" },
                { name: "proof", label: "Proof (certificate)", type: "file" },
              ]} />
            </Reveal>
          </div>
        </Card>
        <Card title="Life events" description="Report a marriage, birth or similar to open a 30-day window to change your cover.">
          {lifeEvents.length === 0 ? <div className="text-sm subtle">None reported.</div> : (
            <div className="stack gap-1">{lifeEvents.map((l) => <div key={l.id} className="row gap-2" style={{ justifyContent: "space-between" }}><span className="text-sm">{LIFE_EVENT_KINDS[l.kind as keyof typeof LIFE_EVENT_KINDS] ?? l.kind} · {formatDate(l.eventDate)}</span><Badge tone={TONE[l.status] ?? "neutral"}>{l.status.toLowerCase()}</Badge></div>)}</div>
          )}
          <div style={{ marginTop: 10 }}>
            <Reveal label="Report a life event">
              <GrowthForm action={lifeEventAction} cols={2} submitLabel="Report" fields={[
                { name: "kind", label: "Event", type: "select", required: true, options: Object.entries(LIFE_EVENT_KINDS).map(([value, label]) => ({ value, label })) },
                { name: "eventDate", label: "Date", type: "date", required: true },
                { name: "notes", label: "Notes", wide: true },
                { name: "proof", label: "Proof", type: "file" },
              ]} />
            </Reveal>
          </div>
          {exceptions.length ? <div className="text-xs subtle" style={{ marginTop: 8 }}>Exception requests: {exceptions.map((x) => `${plans.find((p) => p.id === x.planId)?.name ?? "plan"} ${x.status.toLowerCase()}`).join(" · ")}</div> : null}
        </Card>
      </div>
    </>
  );
}
