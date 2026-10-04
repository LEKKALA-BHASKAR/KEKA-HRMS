import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { benefitPremium, windowCompletion, BENEFIT_TYPES, DEPENDENT_RELATIONS } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Progress, Stat } from "@/components/ui";
import { GrowthForm, ActButton, Reveal, type FieldSpec } from "@/components/growth-forms";
import { saveBenefitPlanAction, benefitPlanOpAction, createEnrollmentWindowAction, windowOpAction } from "@/app/actions/benefits";

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", PENDING_APPROVAL: "warning", ACTIVE: "success", RETIRED: "neutral", PENDING: "warning", APPROVED: "success", REJECTED: "danger" };
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const TIERS = [["EMPLOYEE", "Employee"], ["EMPLOYEE_SPOUSE", "+ Spouse"], ["FAMILY", "Family"]] as const;

/** Benefits administration: the plan catalogue, approvals, renewals, enrolment windows and eligibility exceptions. */
export default async function BenefitsAdminPage({ searchParams }: { searchParams: Promise<{ edit?: string; new?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.BENEFIT_MANAGE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const [plans, windows, exceptions, bands, locations, workerTypes, employees] = await Promise.all([
    prisma.benefitPlan.findMany({ where: { tenantId: t }, include: { _count: { select: { enrollments: { where: { status: "ACTIVE" } } } } }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    prisma.benefitEnrollmentWindow.findMany({ where: { tenantId: t }, orderBy: { opensOn: "desc" }, take: 12 }),
    prisma.benefitEligibilityException.findMany({ where: { tenantId: t }, include: { employee: { select: { displayName: true, employeeNumber: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.band.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.workerType.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } }),
  ]);
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  const editing = sp.edit ? plans.find((p) => p.id === sp.edit && p.status === "DRAFT") : undefined;
  const active = plans.filter((p) => p.status === "ACTIVE");
  const openWindows = windows.filter((w) => !w.closedAt && w.closesOn.getTime() + 86_400_000 > Date.now() && !w.employeeId);
  const completion = await Promise.all(openWindows.slice(0, 3).map((w) => windowCompletion(t, w.id)));
  const elig = (editing?.eligibility ?? {}) as { minTenureDays?: number | null; excludeProbation?: boolean; bandIds?: string[]; locationIds?: string[]; workerTypeIds?: string[] };
  const factors = (editing?.tierFactors ?? {}) as Record<string, number>;
  const planFields: FieldSpec[] = [
    { name: "code", label: "Code", required: true, defaultValue: editing?.code },
    { name: "name", label: "Plan name", required: true, defaultValue: editing?.name },
    { name: "type", label: "Type", type: "select", required: true, options: Object.entries(BENEFIT_TYPES).map(([value, label]) => ({ value, label })), defaultValue: editing?.type ?? "HEALTH" },
    { name: "provider", label: "Insurer / provider", defaultValue: editing?.provider },
    { name: "coverageAmount", label: "Sum insured (₹)", type: "number", defaultValue: editing?.coverageAmount ? Number(editing.coverageAmount) : null },
    { name: "monthlyPremium", label: "Monthly premium, employee only (₹)", type: "number", required: true, defaultValue: editing ? Number(editing.monthlyPremium) : 0 },
    { name: "factorSpouse", label: "Employee + spouse premium ×", type: "number", defaultValue: factors.EMPLOYEE_SPOUSE ?? 1.8 },
    { name: "factorFamily", label: "Family premium ×", type: "number", defaultValue: factors.FAMILY ?? 2.6 },
    { name: "employerRule", label: "Employer pays", type: "select", required: true, options: [{ value: "PERCENT_OF_PREMIUM", label: "% of the premium" }, { value: "FLAT", label: "A flat amount" }, { value: "MATCH_PERCENT_OF_BASIC", label: "Match up to % of basic (retirement)" }], defaultValue: editing?.employerRule ?? "PERCENT_OF_PREMIUM" },
    { name: "employerValue", label: "Employer value (% or ₹)", type: "number", required: true, defaultValue: editing ? Number(editing.employerValue) : 100 },
    { name: "employerCap", label: "Employer cap per month (₹)", type: "number", defaultValue: editing?.employerCap ? Number(editing.employerCap) : null },
    { name: "deductionName", label: "Payslip deduction name", defaultValue: editing?.deductionName },
    { name: "waitingPeriodDays", label: "Waiting period (days)", type: "number", required: true, defaultValue: editing?.waitingPeriodDays ?? 0 },
    { name: "minTenureDays", label: "Minimum tenure (days)", type: "number", defaultValue: elig.minTenureDays ?? null },
    { name: "maxDependents", label: "Max dependents", type: "number", required: true, defaultValue: editing?.maxDependents ?? 4 },
    { name: "childMaxAge", label: "Children covered up to age", type: "number", defaultValue: editing?.childMaxAge ?? 25 },
    { name: "planYearStart", label: "Plan year from", type: "date", defaultValue: ymd(editing?.planYearStart) },
    { name: "planYearEnd", label: "Plan year to", type: "date", defaultValue: ymd(editing?.planYearEnd) },
    { name: "renewalDate", label: "Renewal due", type: "date", defaultValue: ymd(editing?.renewalDate) },
    { name: "allowedRelations", label: "Dependents covered", type: "checklist", options: DEPENDENT_RELATIONS.map((r) => ({ value: r, label: r.toLowerCase().replace(/_/g, " ") })), checked: editing?.allowedRelations ?? ["SPOUSE", "CHILD"] },
    { name: "bandIds", label: "Only these bands (none = all)", type: "checklist", options: bands.map((b) => ({ value: b.id, label: b.name })), checked: elig.bandIds ?? [] },
    { name: "locationIds", label: "Only these locations (none = all)", type: "checklist", options: locations.map((l) => ({ value: l.id, label: l.name })), checked: elig.locationIds ?? [] },
    { name: "workerTypeIds", label: "Only these worker types (none = all)", type: "checklist", options: workerTypes.map((w) => ({ value: w.id, label: w.name })), checked: elig.workerTypeIds ?? [] },
    { name: "description", label: "Description", type: "textarea", defaultValue: editing?.description },
    { name: "excludeProbation", label: "Not while on probation", type: "checkbox", defaultChecked: elig.excludeProbation ?? false },
    { name: "requiresDependentProof", label: "Dependents need verified proof", type: "checkbox", defaultChecked: editing?.requiresDependentProof ?? true },
  ];
  return (
    <>
      <PageHead title="Benefits" subtitle="Plans, enrolment windows and eligibility for BooS-HR benefits"
        actions={<><Link className="btn" href="/payroll/benefits/enrolment">Enrolments &amp; payroll</Link><Link className="btn" href="/payroll/benefits/reports">Reports</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <Stat label="Active plans" value={active.length} meta={`${plans.filter((p) => p.status === "PENDING_APPROVAL").length} awaiting approval`} />
        <Stat label="Members" value={active.reduce((s, p) => s + p._count.enrollments, 0)} />
        <Stat label="Open windows" value={openWindows.length} />
        <Stat label="Exceptions pending" value={exceptions.filter((e) => e.status === "PENDING").length} />
      </div>

      <Card tight title="Plan catalogue" description="Monthly cost per tier — employee share / employer share. New plans and changes go through approval before employees can enrol."
        action={<Link className="btn sm primary" href="/payroll/benefits?new=1">New plan</Link>}>
        {plans.length === 0 ? <Empty title="No plans yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Plan</th><th>Status</th>{TIERS.map(([, l]) => <th key={l} className="num">{l}</th>)}<th className="num">Members</th><th>Plan year</th><th /></tr></thead>
            <tbody>{plans.map((p) => {
              const pp = { monthlyPremium: Number(p.monthlyPremium), tierFactors: p.tierFactors as Record<string, number> | null, employerRule: p.employerRule, employerValue: Number(p.employerValue), employerCap: p.employerCap === null ? null : Number(p.employerCap), type: p.type };
              const retirement = p.type === "RETIREMENT" || p.employerRule === "MATCH_PERCENT_OF_BASIC";
              return (
                <tr key={p.id}>
                  <td><div className="strong text-sm">{p.name}</div><div className="text-xs subtle">{p.code} · {BENEFIT_TYPES[p.type as keyof typeof BENEFIT_TYPES] ?? p.type}{p.provider ? ` · ${p.provider}` : ""}{p.coverageAmount ? ` · cover ${formatINR(Number(p.coverageAmount))}` : ""}</div></td>
                  <td><Badge tone={TONE[p.status] ?? "neutral"}>{p.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                  {retirement ? <td colSpan={3} className="text-xs">Employer matches up to {Number(p.employerValue)}% of basic{p.employerCap ? `, max ${formatINR(Number(p.employerCap))}` : ""}</td>
                    : TIERS.map(([tier]) => { const c = benefitPremium(pp, tier); return <td key={tier} className="num text-sm">{formatINR(c.employee)} / {formatINR(c.employer)}</td>; })}
                  <td className="num">{p._count.enrollments}</td>
                  <td className="text-xs">{p.planYearStart ? `${formatDate(p.planYearStart)} – ${p.planYearEnd ? formatDate(p.planYearEnd) : ""}` : "—"}{p.renewalDate ? <div className="subtle">renews {formatDate(p.renewalDate)}</div> : null}</td>
                  <td>
                    <div className="row gap-1 wrap">
                      {p.status === "DRAFT" ? <Link className="btn sm" href={`/payroll/benefits?edit=${p.id}`}>Edit</Link> : null}
                      {p.status === "DRAFT" ? <ActButton action={benefitPlanOpAction} hidden={{ id: p.id, op: "submit" }} label="Submit for approval" variant="primary" /> : null}
                      {p.status === "ACTIVE" ? (
                        <Reveal label="Renew / retire">
                          <GrowthForm action={benefitPlanOpAction} hidden={{ id: p.id, op: "renew" }} cols={1} compact submitLabel="Create renewal" fields={[
                            { name: "planYearStart", label: "New plan year from", type: "date", required: true, defaultValue: ymd(p.planYearEnd ? new Date(p.planYearEnd.getTime() + 86_400_000) : null) },
                            { name: "planYearEnd", label: "to", type: "date", required: true },
                            { name: "premiumChangePct", label: "Premium change %", type: "number", defaultValue: 0 },
                          ]} />
                          <GrowthForm action={benefitPlanOpAction} hidden={{ id: p.id, op: "retire" }} cols={1} compact submitLabel="Retire plan" fields={[{ name: "endOn", label: "Cover ends on", type: "date", required: true, defaultValue: ymd(new Date()) }]} />
                        </Reveal>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>

      {sp.new || editing ? (
        <Card title={editing ? `Edit ${editing.name}` : "New benefit plan"} description="Saved as a draft; submit it for approval to open it to employees. To change an active plan, renew it.">
          <GrowthForm action={saveBenefitPlanAction} hidden={editing ? { id: editing.id } : {}} submitLabel="Save plan" fields={planFields} />
        </Card>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Enrolment windows" description="Open enrolment for everyone; new joiners and life events get personal 30-day windows automatically.">
          <div className="stack gap-3">
            {windows.length === 0 ? <Empty title="No windows yet" /> : windows.map((w) => {
              const c = completion.find((x) => x?.window.id === w.id);
              const open = !w.closedAt && w.closesOn.getTime() + 86_400_000 > Date.now();
              return (
                <div key={w.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                  <div className="row gap-2" style={{ justifyContent: "space-between" }}>
                    <span className="strong text-sm">{w.name}</span>
                    <Badge tone={open ? "success" : "neutral"}>{w.kind.toLowerCase().replace("_", " ")} · {open ? "open" : "closed"}</Badge>
                  </div>
                  <div className="text-xs subtle">{formatDate(w.opensOn)} – {formatDate(w.closesOn)} · {w.planIds.map((id) => planName.get(id) ?? "?").join(", ")}{w.announcedAt ? ` · announced ${formatDate(w.announcedAt)}` : ""}{w.lastReminderAt ? ` · reminded ${formatDate(w.lastReminderAt)}` : ""}</div>
                  {c ? (
                    <div style={{ marginTop: 6 }}>
                      <div className="text-xs">{c.enrolled} enrolled · {c.waived} waived · {c.pending} not decided of {c.eligible} eligible ({c.pct}%)</div>
                      <Progress value={c.pct} tone={c.pct >= 90 ? "success" : undefined} />
                      {c.pendingPeople.length ? <div className="text-xs subtle" style={{ marginTop: 4 }}>Waiting on: {c.pendingPeople.slice(0, 8).map((p) => p.name).join(", ")}{c.pendingPeople.length > 8 ? ` and ${c.pendingPeople.length - 8} more` : ""}</div> : null}
                    </div>
                  ) : null}
                  {open && !w.employeeId ? (
                    <div className="row gap-1 wrap" style={{ marginTop: 6 }}>
                      <ActButton action={windowOpAction} hidden={{ id: w.id, op: "announce" }} label={w.announcedAt ? "Announce again" : "Announce"} />
                      <ActButton action={windowOpAction} hidden={{ id: w.id, op: "remind" }} label="Remind undecided" />
                      <ActButton action={windowOpAction} hidden={{ id: w.id, op: "close" }} label="Close now" variant="ghost" confirmText="Close this window? Employees can no longer enrol." />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12 }}>
            <Reveal label="Open a window">
              <GrowthForm action={createEnrollmentWindowAction} cols={2} submitLabel="Create window" fields={[
                { name: "name", label: "Name", required: true, placeholder: "Open enrolment 2027" },
                { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "OPEN", label: "Open enrolment" }, { value: "NEW_HIRE", label: "New joiner" }, { value: "LIFE_EVENT", label: "Life event" }], defaultValue: "OPEN" },
                { name: "opensOn", label: "Opens", type: "date", required: true },
                { name: "closesOn", label: "Closes", type: "date", required: true },
                { name: "employeeId", label: "Only for (personal window)", type: "select", options: employees.map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` })) },
                { name: "planIds", label: "Plans", type: "checklist", options: active.map((p) => ({ value: p.id, label: p.name })), checked: active.map((p) => p.id) },
              ]} />
            </Reveal>
          </div>
        </Card>
        <Card tight title="Eligibility exceptions" description="Employees outside a plan's rules asking to be let in. Decide them in the inbox.">
          {exceptions.length === 0 ? <Empty title="None" /> : (
            <div className="table-wrap"><table className="data"><tbody>{exceptions.map((x) => (
              <tr key={x.id}>
                <td><div className="text-sm strong">{x.employee.displayName}</div><div className="text-xs subtle">{planName.get(x.planId) ?? "—"} · {formatDate(x.createdAt)}</div></td>
                <td className="text-xs">{x.reason}{x.ruleGaps ? <div className="subtle">Rules: {x.ruleGaps}</div> : null}</td>
                <td>{x.status === "PENDING" && x.workflowRequestId ? <Link className="btn sm" href="/inbox">Decide</Link> : <Badge tone={TONE[x.status] ?? "neutral"}>{x.status.toLowerCase()}</Badge>}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </Card>
      </div>
    </>
  );
}
