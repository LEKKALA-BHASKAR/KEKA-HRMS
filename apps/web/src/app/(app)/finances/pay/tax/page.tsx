import type { ReactNode } from "react";
import { formatINR, fyLabel } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { Panel, Chip, EmptyState, Notice } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { NavSelect } from "../../_components/nav-select";
import { RegimeBanner } from "../../_components/regime-banner";
import { TaxFigures } from "../../_components/tax-figures";
import { SwitchRegimeButton } from "../../_components/tax-forms";
import { financialYears, loadTaxPicture, pickFy } from "../../_lib/data";
import { fySpan, inr, sectionName } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Income Tax" };

const money = (v: number) => formatINR(v, false);

function Row({ label, value, indent, strong, sign }: { label: ReactNode; value: number; indent?: boolean; strong?: boolean; sign?: "-" | "+" }) {
  return (
    <div className={`${s.calcRow}${indent ? ` ${s.calcIndent}` : ""}${strong ? ` ${s.calcStrong}` : ""}`}>
      <span>{label}</span>
      <span>{sign && value !== 0 ? `${sign} ` : ""}{money(Math.abs(value))}</span>
    </div>
  );
}

export default async function IncomeTaxPage({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const years = await financialYears(viewer);
  const fy = pickFy((await searchParams).fy, years);
  const p = await loadTaxPicture(viewer, fy);
  const r = p.result;
  const fyStartMonth = viewer.tenant.fyStartMonth;

  const header = (
    <div className={s.titleRow}>
      <h1 className={s.bigTitle}>Income Tax</h1>
      <NavSelect label="Financial year" className={s.fySelect} value={String(fy)}
        options={years.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: `/finances/pay/tax?fy=${y}` }))} />
    </div>
  );

  if (!r) {
    return (
      <>
        {header}
        <div className={`${s.boxed} ${s.mt}`}>
          <EmptyState icon={<IconReceipt />} title="No tax computation available">
            {!p.payGroup ? "You are not in a pay group yet, so no income tax is being computed for you."
              : p.missingTables ? `Income-tax slabs for ${fyLabel(fy)} have not been set up yet.`
              : "Income tax is not deducted through payroll for your pay group."}
          </EmptyState>
        </div>
      </>
    );
  }

  const other = p.regime === "NEW" ? "OLD" : "NEW";
  const deductionRows = p.deductions.bySection.filter((d) => {
    const sec = d.section;
    if (sec === "OTHER_INCOME" || sec === "OTHER_TDS" || sec.startsWith("24B")) return false;
    return p.regime === "OLD" || sec === "80CCD(2)";
  });

  return (
    <>
      {header}
      <div className={s.mt}><RegimeBanner regime={p.regime} canSwitch={p.regimeSwitch.allowed} fy={fy} /></div>
      <TaxFigures p={p} />

      <div className={s.calc}>
        <Panel title="Income Tax Computation" subtitle={`${fyLabel(fy)} · ${p.regime === "NEW" ? "New regime (s.115BAC)" : "Old regime"} · projected for the full year`} className={s.ruled}>
          <div className={s.calcHead}>Income</div>
          <Row label="Gross salary" value={p.actualGross + p.projectedGross} />
          <Row indent label={`Paid — ${p.processedMonths} month(s) processed`} value={p.actualGross} />
          {p.projectedMonths > 0 ? <Row indent label={`Projected — ${p.projectedMonths} month(s) at ${inr(p.monthlyGross)} a month`} value={p.projectedGross} /> : null}
          {p.previousIncome > 0 ? <Row label="Income from previous employer" value={p.previousIncome} sign="+" /> : null}
          <Row label="Exemptions under section 10" value={r.exemptions.toNumber()} sign="-" />
          {p.hraExemption > 0 && p.regime === "OLD" ? <Row indent label="House rent allowance — s.10(13A)" value={p.hraExemption} /> : null}
          {p.reimbursements > 0 ? <Row indent label="Tax-free reimbursements" value={p.reimbursements} /> : null}
          <Row label="Standard deduction — s.16(ia)" value={r.standardDeduction.toNumber()} sign="-" />
          {p.regime === "OLD" ? <Row label="Professional tax — s.16(iii)" value={r.professionalTaxDeduction.toNumber()} sign="-" /> : null}
          {p.regime === "OLD" && p.deductions.houseProperty !== 0 ? <Row label="Income from house property (home-loan interest)" value={p.deductions.houseProperty} sign="-" /> : null}
          {p.deductions.otherIncome > 0 ? <Row label="Income from other sources" value={p.deductions.otherIncome} sign="+" /> : null}
          <Row strong label="Gross total income" value={r.grossTotalIncome.toNumber()} />
          <Row label="Deductions under Chapter VI-A" value={r.chapterViaDeductions.toNumber()} sign="-" />
          {deductionRows.map((d) => (
            <Row key={d.section} indent label={<>{sectionName(d.section)} — {d.label}{d.allowed < d.counted ? <span className={s.muted}> (capped from {inr(d.counted)})</span> : null}</>} value={d.allowed} />
          ))}
          <Row strong label="Net taxable income" value={r.taxableIncome.toNumber()} />

          <div className={s.calcHead}>Tax</div>
          <Row label="Tax on taxable income" value={r.taxBeforeRebate.toNumber()} />
          <Row label={r.rebateMarginalRelief.toNumber() > 0 ? "Rebate under s.87A (marginal relief)" : "Rebate under s.87A"} value={r.rebate87A.toNumber()} sign="-" />
          {r.surcharge.toNumber() > 0 ? <Row label={`Surcharge at ${r.surchargeRate.toNumber()}%`} value={r.surcharge.toNumber()} sign="+" /> : null}
          <Row label="Health and education cess" value={r.cess.toNumber()} sign="+" />
          <Row strong label="Total tax payable" value={p.totalTax} />

          <div className={s.calcHead}>Tax paid</div>
          <Row label={`TDS deducted from salary — ${p.processedMonths} month(s)`} value={p.tdsDeducted} />
          {p.previousTds > 0 ? <Row label="Tax deducted by previous employer" value={p.previousTds} /> : null}
          {p.otherTds > 0 ? <Row label="TDS / TCS on other income" value={p.otherTds} /> : null}
          <Row strong label="Remaining tax for the year" value={p.remaining} />
          {p.projectedMonths > 0 ? <Row indent label={`Spread over ${p.projectedMonths} remaining month(s)`} value={p.perProjectedMonth} /> : null}
          {r.notes.length ? <div className={s.capHint} style={{ marginTop: 14 }}>{r.notes.map((t, i) => <div key={i}>· {t}</div>)}</div> : null}
        </Panel>

        <div className={s.stack}>
          <Panel title="Tax by slab" className={s.ruled}>
            {r.slabBreakdown.length === 0 ? <Notice>No slab applies — your taxable income is nil.</Notice> : (
              <div className={s.tableWrap}>
                <table className={`${s.table} ${s.compact}`}>
                  <thead><tr><th scope="col">Income slab</th><th scope="col" className={s.right}>Rate</th><th scope="col" className={s.right}>Tax</th></tr></thead>
                  <tbody>
                    {r.slabBreakdown.map((b, i) => (
                      <tr key={i}>
                        <td>{inr(b.from.toNumber())} – {b.to === null ? "above" : inr(b.to.toNumber())}<div className={s.muted} style={{ fontSize: 12.5 }}>{inr(b.taxableInBand.toNumber())} taxed here</div></td>
                        <td className={`${s.right} ${s.num}`}>{b.rate.toNumber()}%</td>
                        <td className={`${s.right} ${s.num}`}>{money(b.tax.toNumber())}</td>
                      </tr>
                    ))}
                    <tr className={s.totalRow}><td colSpan={2}>Tax on taxable income</td><td className={`${s.right} ${s.num}`}>{money(r.taxBeforeRebate.toNumber())}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <section id="regime" style={{ scrollMarginTop: 120 }}>
            <Panel title="Old vs New Tax Regime" subtitle="The same income and declarations, computed both ways." className={s.ruled}>
              {p.comparison ? (
                <>
                  <div className={s.regimes}>
                    {(["NEW", "OLD"] as const).map((k) => {
                      const res = k === "NEW" ? p.comparison!.new : p.comparison!.old;
                      return (
                        <div key={k} className={`${s.regimeCard}${p.regime === k ? ` ${s.regimeCardActive}` : ""}`}>
                          <div className={s.regimeName}>
                            {k === "NEW" ? "New regime" : "Old regime"}
                            {p.regime === k ? <Chip kind="current">Current</Chip> : null}
                            {p.comparison!.better === k && p.comparison!.saving > 0 ? <Chip kind="open">Lower</Chip> : null}
                          </div>
                          <div className={s.regimeValue}>{inr(res.totalTaxLiability.toNumber())}</div>
                          <div className={s.muted} style={{ fontSize: 13 }}>Taxable income {inr(res.taxableIncome.toNumber())}</div>
                        </div>
                      );
                    })}
                  </div>
                  <p className={s.muted} style={{ marginTop: 14, fontSize: 14 }}>
                    {p.comparison.saving === 0
                      ? "Both regimes come to the same tax on your current figures."
                      : p.comparison.better === p.regime
                        ? `You are on the cheaper regime — it saves you ${inr(p.comparison.saving)} this year.`
                        : `The ${p.comparison.better === "NEW" ? "new" : "old"} regime would save you ${inr(p.comparison.saving)} on your current figures.`}
                    {" "}The new regime has lower rates but allows almost no exemptions or deductions; the old regime rewards HRA, 80C, 80D and home-loan interest.
                  </p>
                  <div style={{ marginTop: 14 }}>
                    {p.regimeSwitch.allowed ? <SwitchRegimeButton target={other} /> : null}
                    <div className={s.capHint}>{p.regimeSwitch.note}</div>
                  </div>
                </>
              ) : <Notice>Tax tables for one of the regimes are missing for {fyLabel(fy)}, so they cannot be compared.</Notice>}
            </Panel>
          </section>
        </div>
      </div>
    </>
  );
}
