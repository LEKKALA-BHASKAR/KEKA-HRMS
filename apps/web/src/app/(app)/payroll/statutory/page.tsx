import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { fyLabel, fyStartYear, formatINR } from "@keka/shared";
import { NO_PT_STATES, NO_LWF_STATES } from "@keka/payroll";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout, Money } from "@/components/ui";

const P = PERMISSIONS;

const TABS = ["pt", "lwf", "tax", "forms"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  pt: "Professional Tax",
  lwf: "Labour Welfare Fund",
  tax: "Income tax slabs",
  forms: "Statutory forms",
};

export default async function StatutoryPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; state?: string }> }) {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const sp = await searchParams;
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : "pt") as Tab;
  const fyStart = fyStartYear(new Date(), viewer.tenant.fyStartMonth);

  const [ptSlabs, lwfRules, taxSlabs, taxConfigs, ptRegs, lwfRegs, filings] = await Promise.all([
    prisma.ptSlab.findMany({ orderBy: [{ stateCode: "asc" }, { fromAmount: "asc" }] }),
    prisma.lwfRule.findMany({ orderBy: { stateCode: "asc" } }),
    prisma.incomeTaxSlab.findMany({
      where: { fyStartYear: fyStart },
      orderBy: [{ regime: "asc" }, { minAge: "asc" }, { fromAmount: "asc" }],
    }),
    prisma.incomeTaxConfig.findMany({ where: { fyStartYear: fyStart } }),
    prisma.ptStateRegistration.findMany({
      where: { payGroup: { tenantId: viewer.tenantId } },
      select: { stateCode: true, localBodyType: true },
    }),
    prisma.lwfStateRegistration.findMany({
      where: { payGroup: { tenantId: viewer.tenantId } },
      select: { stateCode: true },
    }),
    prisma.statutoryFiling.findMany({
      where: { tenantId: viewer.tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const registeredPt = new Set(ptRegs.map((r) => r.stateCode));
  const registeredLwf = new Set(lwfRegs.map((r) => r.stateCode));

  const ptStates = [...new Set(ptSlabs.map((s) => s.stateCode))];
  const stateFilter = sp.state && ptStates.includes(sp.state) ? sp.state : null;
  const shownPt = stateFilter ? ptSlabs.filter((s) => s.stateCode === stateFilter) : ptSlabs;

  const byRegimeAge = new Map<string, typeof taxSlabs>();
  for (const s of taxSlabs) {
    const key = `${s.regime}|${s.minAge}-${s.maxAge}`;
    byRegimeAge.set(key, [...(byRegimeAge.get(key) ?? []), s]);
  }

  return (
    <>
      <PageHead
        title="Statutory"
        subtitle={`Reference tables the payroll engine reads from · ${fyLabel(fyStart)}`}
      />

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={`/payroll/statutory?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>
            {TAB_LABEL[t]}
          </Link>
        ))}
      </div>

      {tab === "pt" ? (
        <div className="stack gap-4">
          <Callout tone="warning" title="Verify slabs against current state notifications">
            Professional Tax is a state levy with no national table — each state publishes
            and revises its own schedule. These rows are effective-dated so a historical run
            reproduces exactly, but they are a starting set, not a legal authority.
            Article 276 caps the annual liability at ₹2,500 per person, which the engine enforces.
          </Callout>

          <Card
            title={`Slab tables — ${ptStates.length} states`}
            description={`${NO_PT_STATES.length} states and union territories levy no professional tax at all: ${NO_PT_STATES.join(", ")}`}
            action={
              <form className="row gap-2">
                <input type="hidden" name="tab" value="pt" />
                <select className="select" name="state" defaultValue={stateFilter ?? ""} style={{ maxWidth: 160 }}>
                  <option value="">All states</option>
                  {ptStates.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn sm" type="submit">Filter</button>
              </form>
            }
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>State</th><th>Local body</th><th>Gender</th><th>Frequency</th>
                    <th className="num">From</th><th className="num">To</th>
                    <th className="num">Amount</th><th>Special month</th><th>Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPt.map((s) => (
                    <tr key={s.id}>
                      <td className="strong">{s.stateCode}</td>
                      <td className="text-sm">{s.localBodyType || <span className="subtle">—</span>}</td>
                      <td className="text-sm">{s.gender?.toLowerCase() ?? <span className="subtle">any</span>}</td>
                      <td className="text-sm">{s.frequency.toLowerCase().replace("_", "-")}</td>
                      <td className="num">{formatINR(s.fromAmount, false)}</td>
                      <td className="num">
                        {s.toAmount === null ? <span className="subtle">no limit</span> : formatINR(s.toAmount, false)}
                      </td>
                      <td className="num strong">{formatINR(s.amount, false)}</td>
                      <td className="text-sm">
                        {s.specialMonth
                          ? `month ${s.specialMonth} → ${formatINR(s.specialAmount ?? 0, false)}`
                          : <span className="subtle">—</span>}
                      </td>
                      <td>
                        {registeredPt.has(s.stateCode)
                          ? <Badge tone="success">Yes</Badge>
                          : <span className="subtle text-xs">not used</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "lwf" ? (
        <div className="stack gap-4">
          <Callout tone="info" title="LWF shapes vary wildly by state">
            Flat amounts rather than percentages, collected monthly in some states,
            half-yearly in June and December in others, and once a year in December
            elsewhere. {NO_LWF_STATES.length} states have no scheme at all.
          </Callout>

          <Card title={`Contribution rules — ${lwfRules.length} states`} tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>State</th><th>Frequency</th><th>Deduction months</th>
                    <th className="num">Employee</th><th className="num">Employer</th>
                    <th className="num">Total per cycle</th><th className="num">Wage limit</th><th>Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {lwfRules.map((r) => {
                    const months = r.deductionMonths as number[];
                    return (
                      <tr key={r.id}>
                        <td className="strong">{r.stateCode}</td>
                        <td className="text-sm">{r.frequency.toLowerCase().replace("_", "-")}</td>
                        <td className="text-sm">
                          {months.length === 12 ? "every month" : months.join(", ")}
                        </td>
                        <td className="num">{formatINR(r.employeeAmount, false)}</td>
                        <td className="num">{formatINR(r.employerAmount, false)}</td>
                        <td className="num strong">
                          {formatINR(Number(r.employeeAmount) + Number(r.employerAmount), false)}
                        </td>
                        <td className="num">
                          {r.wageLimit ? formatINR(r.wageLimit, false) : <span className="subtle">none</span>}
                        </td>
                        <td>
                          {registeredLwf.has(r.stateCode)
                            ? <Badge tone="success">Yes</Badge>
                            : <span className="subtle text-xs">not used</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "tax" ? (
        <div className="stack gap-4">
          <Callout tone="warning" title="The old regime has three separate age bands">
            Under-60, 60–79 and 80+ each have their own complete table. They must never be
            merged into one list — doing so repeats the upper slabs and silently over-deducts
            tax. The engine selects one band based on the employee's age at 31 March.
          </Callout>

          {[...byRegimeAge.entries()].map(([key, rows]) => {
            const [regime, ageRange] = key.split("|");
            const [minAge, maxAge] = ageRange.split("-").map(Number);
            const label = regime === "NEW" ? "New regime (s.115BAC)"
              : minAge === 0 ? "Old regime — under 60"
              : minAge === 60 ? "Old regime — senior citizen (60–79)"
              : "Old regime — super senior citizen (80+)";
            return (
              <Card key={key} title={label} description={`Age ${minAge} to ${maxAge === 200 ? "any" : maxAge}`} tight>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th className="num">From</th><th className="num">To</th><th className="num">Rate</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr key={s.id}>
                          <td className="num">{formatINR(s.fromAmount, false)}</td>
                          <td className="num">
                            {s.toAmount === null ? <span className="subtle">and above</span> : formatINR(s.toAmount, false)}
                          </td>
                          <td className="num strong">{Number(s.ratePercent)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}

          <Card title="Regime parameters" tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Regime</th><th className="num">Standard deduction</th>
                    <th className="num">87A rebate limit</th><th className="num">Max rebate</th>
                    <th className="num">Cess</th><th>Surcharge bands</th><th>Marginal relief</th>
                  </tr>
                </thead>
                <tbody>
                  {taxConfigs.map((c) => (
                    <tr key={c.id}>
                      <td className="strong">{c.regime === "NEW" ? "New" : "Old"}</td>
                      <td className="num"><Money value={c.standardDeduction} /></td>
                      <td className="num"><Money value={c.rebateLimit} /></td>
                      <td className="num"><Money value={c.rebateMaxAmount} /></td>
                      <td className="num">{Number(c.cessPercent)}%</td>
                      <td className="text-sm">
                        {(c.surchargeBands as Array<{ from: number; to: number | null; percent: number }>)
                          .map((b) => `${b.percent}% above ${(b.from / 10000000).toFixed(1)}Cr`)
                          .join(" · ")}
                      </td>
                      <td>{c.marginalReliefEnabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "forms" ? (
        <div className="stack gap-4">
          <Card
            title="Statutory forms and returns"
            description="What this platform produces, and where each is filed."
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Form</th><th>Covers</th><th>Frequency</th><th>Filed with</th><th>Status</th></tr></thead>
                <tbody>
                  {[
                    ["Form 16 Part A & B", "Salary TDS certificate per employee", "Annual", "Issued to employees, generated from TRACES"],
                    ["Form 12BB", "Employee declaration of claims for exemption", "Annual", "Held by employer"],
                    ["Form 24Q", "Quarterly TDS return on salary", "Quarterly", "Income Tax Dept (TRACES)"],
                    ["Form 26Q", "TDS on contractor and professional payments", "Quarterly", "Income Tax Dept (TRACES)"],
                    ["Form 27Q", "TDS on payments to non-residents", "Quarterly", "Income Tax Dept (TRACES)"],
                    ["PF ECR", "Monthly electronic challan-cum-return", "Monthly", "EPFO"],
                    ["PF Forms 3A, 5, 6A, 10, 12A", "Member and establishment returns", "Monthly / annual", "EPFO"],
                    ["ESI ECR", "Monthly contribution return", "Monthly", "ESIC"],
                    ["ESI Form 5", "Return of contributions", "Half-yearly", "ESIC"],
                    ["PT return", "State professional tax statement", "Monthly / half-yearly / annual", "State authority"],
                    ["LWF return", "Labour welfare fund contribution", "Monthly / half-yearly / annual", "State welfare board"],
                  ].map(([form, covers, freq, filedWith]) => (
                    <tr key={form as string}>
                      <td className="strong">{form}</td>
                      <td className="text-sm">{covers}</td>
                      <td className="text-sm">{freq}</td>
                      <td className="text-sm muted">{filedWith}</td>
                      <td><Badge tone="neutral">Schema ready</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={`Filing history (${filings.length})`} tight>
            {filings.length === 0 ? (
              <Empty title="No filings recorded yet">
                Generated returns are recorded here with their token and receipt numbers.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Type</th><th>Period</th><th>Status</th><th>Token</th><th>Receipt</th></tr></thead>
                  <tbody>
                    {filings.map((f) => (
                      <tr key={f.id}>
                        <td className="strong">{f.type.replace(/_/g, " ")}</td>
                        <td>{fyLabel(f.fyStartYear)}{f.quarter ? ` Q${f.quarter}` : ""}{f.month ? ` M${f.month}` : ""}</td>
                        <td><Badge tone={f.status === "FILED" ? "success" : "neutral"}>{f.status.toLowerCase()}</Badge></td>
                        <td className="mono text-xs">{f.tokenNumber ?? "—"}</td>
                        <td className="mono text-xs">{f.receiptNumber ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );
}
