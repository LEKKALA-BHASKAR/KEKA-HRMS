import { prisma } from "@keka/db";
import {
  calculateAnnualTax, compareRegimes, DEDUCTION_SECTIONS,
  type TaxSlab, type TaxConfig,
} from "@keka/payroll";
import { fyStartYear, fyLabel, fyRange, formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Money, Badge, Empty, Stat, KeyValue, Callout, Progress } from "@/components/ui";

const n = (v: unknown) => Number(v ?? 0);

export default async function MyTaxPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <Callout tone="info" title="No employee record">This login is not linked to an employee record.</Callout>;
  }

  const employeeId = viewer.employee.id;
  const fyStart = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const { start, end } = fyRange(fyStart, viewer.tenant.fyStartMonth);

  const [profile, declaration, paidRuns, slabRows, configRows, payGroup] = await Promise.all([
    prisma.employeeStatutoryProfile.findUnique({ where: { employeeId } }),
    prisma.investmentDeclaration.findUnique({
      where: { employeeId_fyStartYear: { employeeId, fyStartYear: fyStart } },
      include: { items: { orderBy: { section: "asc" } }, hraDetail: true },
    }),
    prisma.payrollRunEmployee.findMany({
      where: { employeeId, run: { status: "FINALIZED", periodEnd: { gte: start, lte: end } } },
      select: { grossEarnings: true, tds: true, professionalTax: true },
    }),
    prisma.incomeTaxSlab.findMany({ where: { fyStartYear: fyStart } }),
    prisma.incomeTaxConfig.findMany({ where: { fyStartYear: fyStart } }),
    prisma.payGroup.findFirst({
      where: { employees: { some: { id: employeeId } } },
      select: {
        declarationOpenDay: true, declarationCloseDay: true, declarationFyCutoff: true,
        proofSubmissionDue: true, proofMandatory: true, allowRegimeChoice: true,
        regimeChangeCutoff: true,
      },
    }),
  ]);

  const regime = profile?.taxRegime ?? "NEW";
  const ytdGross = paidRuns.reduce((s, r) => s + n(r.grossEarnings), 0);
  const ytdTds = paidRuns.reduce((s, r) => s + n(r.tds), 0);
  const ytdPt = paidRuns.reduce((s, r) => s + n(r.professionalTax), 0);
  const monthsPaid = paidRuns.length;
  const projectedAnnualGross = monthsPaid > 0 ? (ytdGross / monthsPaid) * 12 : 0;

  const slabsFor = (r: "OLD" | "NEW"): TaxSlab[] =>
    slabRows
      .filter((s) => s.regime === r && s.minAge === 0 && (r === "NEW" || s.maxAge === 59))
      .sort((a, b) => Number(a.fromAmount) - Number(b.fromAmount))
      .map((s) => ({
        fromAmount: Number(s.fromAmount),
        toAmount: s.toAmount === null ? null : Number(s.toAmount),
        ratePercent: Number(s.ratePercent),
      }));

  const configFor = (r: "OLD" | "NEW"): TaxConfig => {
    const c = configRows.find((x) => x.regime === r)!;
    return {
      standardDeduction: Number(c.standardDeduction),
      rebateLimit: Number(c.rebateLimit),
      rebateMaxAmount: Number(c.rebateMaxAmount),
      cessPercent: Number(c.cessPercent),
      surchargeBands: (c.surchargeBands ?? []) as Array<{ from: number; to: number | null; percent: number }>,
      marginalReliefEnabled: c.marginalReliefEnabled,
    };
  };

  const approvedDeductions = declaration?.items.reduce((s, i) => s + n(i.approvedAmount), 0) ?? 0;
  const declaredDeductions = declaration?.items.reduce((s, i) => s + n(i.declaredAmount), 0) ?? 0;

  const comparison = projectedAnnualGross > 0 && configRows.length === 2
    ? compareRegimes(
        {
          grossSalary: projectedAnnualGross,
          chapterViaDeductions: approvedDeductions,
          professionalTax: ytdPt > 0 ? (ytdPt / monthsPaid) * 12 : 0,
        },
        slabsFor("OLD"), configFor("OLD"),
        slabsFor("NEW"), configFor("NEW"),
      )
    : null;

  const current = comparison ? (regime === "OLD" ? comparison.old : comparison.new) : null;

  return (
    <>
      <PageHead
        title="My tax"
        subtitle={`${fyLabel(fyStart)} · ${regime === "OLD" ? "Old regime" : "New regime (s.115BAC)"}`}
        actions={<Badge tone="brand">{regime === "OLD" ? "Old regime" : "New regime"}</Badge>}
      />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Projected annual gross" value={<Money value={projectedAnnualGross} compact />} meta={`From ${monthsPaid} month(s) paid`} />
        <Stat label="Projected tax" value={<Money value={current?.totalTaxLiability.toNumber() ?? 0} compact />} meta="Including cess" />
        <Stat label="TDS deducted so far" value={<Money value={ytdTds} compact />} meta={`${monthsPaid} month(s)`} />
        <Stat
          label="Still to deduct"
          value={<Money value={Math.max(0, (current?.totalTaxLiability.toNumber() ?? 0) - ytdTds)} compact />}
          meta="Spread across remaining months"
        />
      </div>

      {comparison ? (
        <div style={{ marginBottom: 18 }}>
          <Callout
            tone={comparison.better === regime ? "success" : "warning"}
            title={
              comparison.better === regime
                ? `You are on the cheaper regime for your current declarations`
                : `The ${comparison.better === "NEW" ? "new" : "old"} regime would save you ${formatINR(comparison.saving.toNumber())}`
            }
          >
            Old regime: {formatINR(comparison.old.totalTaxLiability.toNumber())} ·{" "}
            New regime: {formatINR(comparison.new.totalTaxLiability.toNumber())}.
            {payGroup?.allowRegimeChoice
              ? ` You can switch until ${formatDate(payGroup.regimeChangeCutoff)}.`
              : " Regime changes are locked by your payroll team."}
            {comparison.better !== regime && regime === "NEW"
              ? " The old regime only wins once declarations and rent are substantial."
              : ""}
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {current ? (
          <Card title="Tax computation" description={`As projected for ${fyLabel(fyStart)}`}>
            <KeyValue items={[
              ["Gross salary", <Money key="a" value={projectedAnnualGross} />],
              ["Exempt allowances", <Money key="b" value={current.exemptions.toNumber()} />],
              ["Standard deduction", <Money key="c" value={current.standardDeduction.toNumber()} />],
              ["Professional tax", <Money key="d" value={current.professionalTaxDeduction.toNumber()} />],
              ["Chapter VI-A", <Money key="e" value={current.chapterViaDeductions.toNumber()} />],
              ["Taxable income", <strong key="f"><Money value={current.taxableIncome.toNumber()} /></strong>],
            ]} />
            <div className="divider" />
            <KeyValue items={[
              ["Tax on slabs", <Money key="g" value={current.taxBeforeRebate.toNumber()} />],
              ["Section 87A rebate", <Money key="h" value={current.rebate87A.toNumber()} />],
              ...(current.rebateMarginalRelief.toNumber() > 0
                ? [["Marginal relief", <Money key="mr" value={current.rebateMarginalRelief.toNumber()} />] as [string, React.ReactNode]]
                : []),
              ["Surcharge", current.surcharge.toNumber() > 0
                ? <span key="i"><Money value={current.surcharge.toNumber()} /> <span className="text-xs subtle">at {current.surchargeRate.toNumber()}%</span></span>
                : <Money key="i" value={0} />],
              ["Health & education cess", <Money key="j" value={current.cess.toNumber()} />],
              ["Total liability", <strong key="k"><Money value={current.totalTaxLiability.toNumber()} /></strong>],
            ]} />

            {current.notes.length > 0 ? (
              <>
                <div className="divider" />
                <div className="stack gap-1">
                  {current.notes.map((note, i) => (
                    <div key={i} className="text-sm muted">· {note}</div>
                  ))}
                </div>
              </>
            ) : null}
          </Card>
        ) : null}

        {current && current.slabBreakdown.length > 0 ? (
          <Card title="Slab-by-slab breakdown" tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th className="num">From</th><th className="num">To</th><th className="num">Rate</th><th className="num">Taxable</th><th className="num">Tax</th></tr>
                </thead>
                <tbody>
                  {current.slabBreakdown.map((b, i) => (
                    <tr key={i}>
                      <td className="num">{formatINR(b.from.toNumber(), false)}</td>
                      <td className="num">{b.to === null ? <span className="subtle">above</span> : formatINR(b.to.toNumber(), false)}</td>
                      <td className="num">{b.rate.toNumber()}%</td>
                      <td className="num">{formatINR(b.taxableInBand.toNumber(), false)}</td>
                      <td className="num strong">{formatINR(b.tax.toNumber(), false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card
          title="Investment declarations"
          description={
            payGroup
              ? `Declaration window: day ${payGroup.declarationOpenDay}–${payGroup.declarationCloseDay} each month${payGroup.declarationFyCutoff ? `, FY cut-off ${formatDate(payGroup.declarationFyCutoff)}` : ""}`
              : undefined
          }
          tight
        >
          {!declaration || declaration.items.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No declarations submitted">
                {regime === "NEW"
                  ? "The new regime allows almost no deductions, so declarations have little effect. Switch to the old regime first if you want to claim 80C, HRA or home-loan interest."
                  : "Declare your investments to reduce the tax deducted each month."}
              </Empty>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Section</th><th>Category</th><th className="num">Declared</th><th className="num">Approved</th><th>Proof</th></tr>
                  </thead>
                  <tbody>
                    {declaration.items.map((i) => (
                      <tr key={i.id}>
                        <td className="mono text-xs strong">{i.section}</td>
                        <td>{i.category}</td>
                        <td className="num"><Money value={i.declaredAmount} /></td>
                        <td className="num strong"><Money value={i.approvedAmount} /></td>
                        <td>
                          <Badge tone={
                            i.proofStatus === "APPROVED" ? "success"
                            : i.proofStatus === "REJECTED" ? "danger"
                            : i.proofStatus === "SUBMITTED" ? "info" : "warning"
                          }>
                            {i.proofStatus.replace(/_/g, " ").toLowerCase()}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    <tr className="total-row">
                      <td colSpan={2}>Total</td>
                      <td className="num"><Money value={declaredDeductions} /></td>
                      <td className="num"><Money value={approvedDeductions} /></td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 5 }}>
                  <span className="text-sm muted">Approved as a share of declared</span>
                  <span className="text-sm num">
                    {declaredDeductions > 0 ? ((approvedDeductions / declaredDeductions) * 100).toFixed(0) : 0}%
                  </span>
                </div>
                <Progress value={approvedDeductions} max={Math.max(1, declaredDeductions)} tone="success" />
              </div>
            </>
          )}
        </Card>

        <Card title="Deduction sections available" description={regime === "NEW" ? "The new regime allows only 80CCD(2)" : "Old regime ceilings"} tight>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Section</th><th>What it covers</th><th className="num">Ceiling</th><th>New regime</th></tr></thead>
              <tbody>
                {DEDUCTION_SECTIONS.map((d) => (
                  <tr key={d.section}>
                    <td className="mono text-xs strong">{d.section}</td>
                    <td className="text-sm">{d.label}</td>
                    <td className="num">
                      {d.maxAmount === null
                        ? <span className="subtle">no limit</span>
                        : formatINR(d.maxAmount, false)}
                      {d.sharedGroup ? <div className="text-xs subtle">shared 80C group</div> : null}
                    </td>
                    <td>
                      {d.allowedInNewRegime
                        ? <Badge tone="success">Allowed</Badge>
                        : <Badge tone="neutral">Old only</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Statutory identifiers">
          <KeyValue items={[
            ["Tax regime", regime === "OLD" ? "Old regime" : "New regime (s.115BAC)"],
            ["UAN", profile?.uan],
            ["PF account", profile?.pfAccountNumber],
            ["ESIC number", profile?.esicNumber ?? "Not covered — gross above the ESI limit"],
            ["Proof submission", payGroup?.proofMandatory
              ? `Mandatory, due ${formatDate(payGroup.proofSubmissionDue)}`
              : "Optional"],
            ["Previous employer income", profile?.previousEmployerIncome
              ? <Money key="p" value={profile.previousEmployerIncome} /> : "None declared"],
          ]} />
        </Card>
      </div>
    </>
  );
}
