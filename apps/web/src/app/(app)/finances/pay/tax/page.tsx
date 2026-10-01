import type { ReactNode } from "react";
import { formatINR, fyLabel, MONTH_SHORT } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { Panel, Chip, EmptyState, Notice } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { IconBulb, IconDown } from "../../_components/icons";
import { NavSelect } from "../../_components/nav-select";
import { SwitchRegimeButton } from "../../_components/tax-forms";
import { financialYears, loadTaxPicture, pickFy } from "../../_lib/data";
import { fySpan, inr, sectionName } from "../../_lib/rules";
import Link from "next/link";
import s from "../../finances.module.css";

export const metadata = { title: "Income Tax" };

const money = (v: number) => formatINR(v, false);
const whole = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v));

function Row({ label, value, indent, strong, sign }: { label: ReactNode; value: number; indent?: boolean; strong?: boolean; sign?: "-" | "+" }) {
  return (
    <div className={`${s.calcRow}${indent ? ` ${s.calcIndent}` : ""}${strong ? ` ${s.calcStrong}` : ""}`}>
      <span>{label}</span>
      <span>{sign && value !== 0 ? `${sign} ` : ""}{money(Math.abs(value))}</span>
    </div>
  );
}

function Lettered({ letter, title, children }: { letter: string; title: string; children: ReactNode }) {
  return (
    <section className={s.lettered} aria-label={title}>
      <h2 className={s.letteredHead}><span className={s.letter} aria-hidden="true">{letter}</span>{title}</h2>
      {children}
    </section>
  );
}

/**
 * Income Tax Computation: the year's tax worked out in the open — gross
 * earnings month by month (paid where processed, projected where not), the
 * exemptions and deductions that come off, the tax on what is left, and the
 * TDS each month. The sheet downloads as CSV.
 */
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
    <>
      <div className={s.titleRow}>
        <div className={s.titleLeft}>
          <h1 className={s.bigTitle}>Income Tax Computation</h1>
          {r ? (
            <a className={s.iconLink} href={`/finances/pay/tax/sheet?fy=${fy}`} download title="Download Income Tax Computation Sheet" aria-label="Download Income Tax Computation Sheet">
              <IconDown width={22} height={22} />
            </a>
          ) : null}
        </div>
        <NavSelect label="Financial year" className={s.fySelect} value={String(fy)}
          options={years.map((y) => ({ value: String(y), label: fySpan(y, fyStartMonth), href: `/finances/pay/tax?fy=${y}` }))} />
      </div>
      <p className={s.pageSub}>View complete breakup of payments, deductions and declarations. You can analyze how income tax is being calculated and what is the TDS every month.</p>
    </>
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
  const grossIncomeTax = r.taxBeforeRebate.toNumber() - r.rebate87A.toNumber();
  const surchargeCess = r.surcharge.toNumber() + r.cess.toNumber();
  const kpis: Array<[string, number]> = [
    ["Net Taxable Income", r.taxableIncome.toNumber()],
    ["Gross Income Tax", grossIncomeTax],
    ["Total Surcharge & Cess", surchargeCess],
    ["Net Income Tax Payable", p.totalTax],
    ["Tax Paid Till Now", p.taxPaid],
    ["Remaining Tax To Be Paid", p.remaining],
  ];
  const hasPrevious = p.previousIncome > 0;
  const gross = p.actualGross + p.projectedGross;

  return (
    <>
      {header}

      <section className={`${s.boxed} ${s.important}`} aria-label="Important">
        <div className={s.importantHead}><IconBulb width={22} height={22} /> Important!</div>
        <ul className={s.importantList}>
          <li>Current income tax calculation is considering <strong>DECLARED</strong> amounts of your investment declaration until a reviewer rules on the proof, and the <strong>ACCEPTED</strong> amount after that.</li>
          <li>
            Your Income and tax liability is being computed as per <strong>{p.regime === "NEW" ? "New Tax Regime" : "Old Tax Regime"}</strong>.{" "}
            {p.regimeSwitch.allowed ? <>To learn more and switch to <strong>{other === "NEW" ? "New Tax Regime" : "Old Tax Regime"}</strong>, </> : <>To compare it with the {other === "NEW" ? "New" : "Old"} Tax Regime, </>}
            <a className={s.link} href="#regime">Click here.</a>
          </li>
        </ul>
      </section>

      <section className={`${s.boxed} ${s.taxSheet}`} aria-label="Income tax computation">
        <div className={s.kpis}>
          {kpis.map(([k, v]) => (
            <div key={k} className="k-field"><div className="k-field-label">{k}</div><div className="k-field-value">INR {whole(v)}</div></div>
          ))}
        </div>

        <Lettered letter="A" title="Gross Earnings from Employment">
          <div className={s.gridBox}>
            <div className={s.gridLegend}>
              {hasPrevious ? <span><span className={`${s.dot} ${s.dotPrevious}`} aria-hidden="true" />Income from Previous Employer</span> : null}
              <span><span className={`${s.dot} ${s.dotProcessed}`} aria-hidden="true" />Paid Salary</span>
              <span><span className={`${s.dot} ${s.dotProjected}`} aria-hidden="true" />Projected Salary</span>
            </div>
            <div className={s.gridScroll}>
              <table className={`${s.table} ${s.monthTable} ${s.earnGrid}`}>
                <thead>
                  <tr>
                    <th scope="col">Salary Breakup</th>
                    <th scope="col">Total</th>
                    {hasPrevious ? <th scope="col"><span className={s.monthCell}><span>Previous<br />employer</span><span className={`${s.dot} ${s.dotPrevious}`} aria-hidden="true" /></span></th> : null}
                    {p.months.map((m) => (
                      <th scope="col" key={`${m.year}-${m.month}`}>
                        <span className={s.monthCell}>
                          <span>{MONTH_SHORT[m.month - 1].toUpperCase()} {String(m.year % 100).padStart(2, "0")}</span>
                          {m.kind === "projected" ? <span className={`${s.dot} ${s.dotProjected}`} title="Projected" aria-label="projected" /> : null}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.grid.map((g) => (
                    <tr key={g.code}>
                      <th scope="row">{g.name}</th>
                      <td className={s.num}>{whole(g.total)}</td>
                      {hasPrevious ? <td className={s.num}>—</td> : null}
                      {g.cells.map((c, i) => <td key={i} className={s.num}>{p.months[i].kind === "none" ? <span className={s.muted}>—</span> : whole(c)}</td>)}
                    </tr>
                  ))}
                  {hasPrevious ? (
                    <tr>
                      <th scope="row">Income from previous employer</th>
                      <td className={s.num}>{whole(p.previousIncome)}</td>
                      <td className={s.num}>{whole(p.previousIncome)}</td>
                      {p.months.map((m, i) => <td key={i} className={s.num}><span className={s.muted}>—</span></td>)}
                    </tr>
                  ) : null}
                  <tr className={s.totalRow}>
                    <th scope="row">Gross Earnings</th>
                    <td className={s.num}>{whole(gross + p.previousIncome)}</td>
                    {hasPrevious ? <td className={s.num}>{whole(p.previousIncome)}</td> : null}
                    {p.months.map((m, i) => <td key={i} className={s.num}>{m.kind === "none" ? "—" : whole(m.gross)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Lettered>

        <Lettered letter="B" title="Exemptions under Section 10">
          {p.regime === "NEW" && p.reimbursements === 0 ? <p className={s.muted}>Not applicable under the New Tax Regime.</p> : (
            <div className={s.calcBox}>
              {p.regime === "OLD" ? <Row label="House rent allowance — s.10(13A)" value={p.hraExemption} /> : null}
              <Row label="Tax-free reimbursements" value={p.reimbursements} />
              <Row strong label="Total exemptions" value={r.exemptions.toNumber()} />
            </div>
          )}
        </Lettered>

        <Lettered letter="C" title="Deductions under Section 16">
          <div className={s.calcBox}>
            <Row label="Standard deduction — s.16(ia)" value={r.standardDeduction.toNumber()} />
            {p.regime === "OLD" ? <Row label="Professional tax — s.16(iii)" value={r.professionalTaxDeduction.toNumber()} /> : null}
          </div>
        </Lettered>

        <Lettered letter="D" title="Other Income">
          <div className={s.calcBox}>
            <Row label="Income from previous employer" value={p.previousIncome} />
            {p.regime === "OLD" ? <Row label="Income from house property (home-loan interest)" value={p.deductions.houseProperty} /> : null}
            <Row label="Income from other sources" value={p.deductions.otherIncome} />
            <Row strong label="Gross total income" value={r.grossTotalIncome.toNumber()} />
          </div>
        </Lettered>

        <Lettered letter="E" title="Deductions under Chapter VI-A">
          {deductionRows.length === 0 ? (
            <p className={s.muted}>{p.regime === "NEW" ? "Only the employer's NPS contribution (80CCD(2)) reduces tax under the New Tax Regime, and none is declared." : <>Nothing declared yet. <Link className={s.link} href={`/finances/tax?fy=${fy}`}>Declare investments</Link></>}</p>
          ) : (
            <div className={s.calcBox}>
              {deductionRows.map((d) => (
                <Row key={d.section} label={<>{sectionName(d.section)} — {d.label}{d.allowed < d.counted ? <span className={s.muted}> (capped from {inr(d.counted)})</span> : null}</>} value={d.allowed} />
              ))}
              <Row strong label="Total Chapter VI-A deductions" value={r.chapterViaDeductions.toNumber()} />
            </div>
          )}
        </Lettered>

        <Lettered letter="F" title="Tax Computation">
          <div className={s.calc2}>
            <div className={s.calcBox}>
              <Row strong label="Net taxable income" value={r.taxableIncome.toNumber()} />
              <Row label="Tax on taxable income" value={r.taxBeforeRebate.toNumber()} />
              <Row label={r.rebateMarginalRelief.toNumber() > 0 ? "Rebate under s.87A (marginal relief)" : "Rebate under s.87A"} value={r.rebate87A.toNumber()} sign="-" />
              <Row label={r.surcharge.toNumber() > 0 ? `Surcharge at ${r.surchargeRate.toNumber()}%` : "Surcharge"} value={r.surcharge.toNumber()} sign="+" />
              <Row label="Health and education cess" value={r.cess.toNumber()} sign="+" />
              <Row strong label="Net income tax payable" value={p.totalTax} />
              <Row label={`TDS deducted from salary — ${p.processedMonths} month(s)`} value={p.tdsDeducted} />
              {p.previousTds > 0 ? <Row label="Tax deducted by previous employer" value={p.previousTds} /> : null}
              {p.otherTds > 0 ? <Row label="TDS / TCS on other income" value={p.otherTds} /> : null}
              <Row strong label="Remaining tax to be paid" value={p.remaining} />
              {p.projectedMonths > 0 ? <Row indent label={`Spread over ${p.projectedMonths} remaining month(s)`} value={p.perProjectedMonth} /> : null}
            </div>
            <div className={s.tableWrap}>
              {r.slabBreakdown.length === 0 ? <div className={s.pad}><Notice>No slab applies — your taxable income is nil.</Notice></div> : (
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
              )}
            </div>
          </div>
          {r.notes.length ? <div className={s.capHint} style={{ marginTop: 14 }}>{r.notes.map((t, i) => <div key={i}>· {t}</div>)}</div> : null}
        </Lettered>

        <Lettered letter="G" title="Monthly TDS">
          <div className={s.gridBox}>
            <div className={s.gridScroll}>
              <table className={`${s.table} ${s.monthTable}`}>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    {p.previousTds > 0 ? <th scope="col"><span className={s.monthCell}><span>Previous<br />employer</span><span className={`${s.dot} ${s.dotPrevious}`} aria-hidden="true" /></span></th> : null}
                    {p.months.map((m) => (
                      <th scope="col" key={`${m.year}-${m.month}`}>
                        <span className={s.monthCell}>
                          <span>{MONTH_SHORT[m.month - 1].toUpperCase()} {String(m.year % 100).padStart(2, "0")}</span>
                          {m.kind === "projected" ? <span className={`${s.dot} ${s.dotProjected}`} title="Projected" aria-label="projected" /> : null}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">TDS</th>
                    {p.previousTds > 0 ? <td className={s.num}>{whole(p.previousTds)}</td> : null}
                    {p.months.map((m) => <td key={`${m.year}-${m.month}`} className={s.num}>{m.kind === "none" ? <span className={s.muted}>—</span> : whole(m.tds)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Lettered>
      </section>

      <section id="regime" style={{ scrollMarginTop: 120 }} className={s.mt}>
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
    </>
  );
}
