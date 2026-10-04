import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { payrollPreferences } from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { PageHead, Card, Empty, Money, Callout } from "@/components/ui";
import { DepthForm } from "../_forms/depth";
import {
  setHideMyPayAction, saveGratuitySettingsAction, saveBonusSettingsAction, saveMinimumWageAction, deleteMinimumWageAction,
} from "@/app/actions/payroll-depth";

const P = PERMISSIONS;
const CATEGORIES = [["UNSKILLED", "Unskilled"], ["SEMI_SKILLED", "Semi-skilled"], ["SKILLED", "Skilled"], ["HIGHLY_SKILLED", "Highly skilled"]] as const;

function Num({ id, name, label, value, step = "1", min, max, hint }: { id: string; name: string; label: string; value: number | null; step?: string; min?: number; max?: number; hint?: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input num" name={name} type="number" step={step} min={min} max={max} defaultValue={value ?? ""} />
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Payroll settings that are not per pay group: the Hide My Pay toggle, the
 * gratuity rules F&F uses, the Payment of Bonus Act parameters, and the
 * state minimum wages the compliance check compares against.
 */
export default async function PayrollSettingsPage() {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const prefs = await payrollPreferences(viewer.tenantId);
  const statutory = can(viewer, P.STATUTORY_MANAGE);
  const rates = statutory ? await prisma.minimumWageRate.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ stateCode: "asc" }, { category: "asc" }, { effectiveFrom: "desc" }] }) : [];
  const g = prefs.gratuity, b = prefs.bonus;

  return (
    <>
      <PageHead title="Payroll settings" subtitle="Employee self-service, gratuity, statutory bonus and minimum wages"
        actions={<><Link className="btn" href="/payroll/statutory-bonus">Statutory bonus report</Link><Link className="btn" href="/payroll/compliance">Compliance reports</Link></>} />
      <div className="stack gap-4">
        <Card title="My Pay page" description="Hide the My Pay page (salary, payslips, salary structure) from every employee's self-service. Payroll keeps running; payslips stay with the payroll team.">
          <DepthForm action={setHideMyPayAction} submitLabel="Save">
            <label className="checkbox-row"><input type="checkbox" name="hideMyPayPage" defaultChecked={prefs.hideMyPayPage} /><span className="text-sm">Hide the My Pay page from employees</span></label>
          </DepthForm>
        </Card>

        {statutory ? (
          <>
            <Card title="Gratuity" description="Used by full and final settlements. The Payment of Gratuity Act pays 15 days' wages per completed year on a 26-day month, after 5 years, up to ₹20,00,000.">
              <DepthForm action={saveGratuitySettingsAction} submitLabel="Save gratuity settings">
                <div className="grid grid-3">
                  <Num id="g-years" name="eligibilityYears" label="Eligible after (years)" value={g.eligibilityYears} step="0.01" min={0} max={10} hint="4.8 = 4 years 240 days" />
                  <Num id="g-days" name="daysPerYear" label="Days' wages per year" value={g.daysPerYear} min={15} max={30} />
                  <div className="field"><label className="label" htmlFor="g-div">Monthly divisor</label>
                    <select id="g-div" className="select" name="divisor" defaultValue={String(g.divisor)}><option value="26">26 (covered by the Act)</option><option value="30">30</option></select>
                  </div>
                  <Num id="g-cap" name="cap" label="Maximum gratuity (₹)" value={g.cap} min={1} />
                  <div className="field"><label className="label" htmlFor="g-codes">Wage components</label><input id="g-codes" className="input mono" name="wageCodes" defaultValue={g.wageCodes.join(", ")} /><div className="hint">Component codes, e.g. BASIC, DA</div></div>
                </div>
                <div className="text-xs subtle">Formula: {g.daysPerYear} × last drawn wage × completed years ÷ {g.divisor}, capped at ₹{g.cap.toLocaleString("en-IN")}.</div>
              </DepthForm>
            </Card>

            <Card title="Statutory bonus (Payment of Bonus Act)" description="Employees whose monthly wage is at or under the eligibility ceiling earn 8.33%–20% of their wage, counted at no more than the calculation ceiling or the minimum wage, whichever is higher.">
              <DepthForm action={saveBonusSettingsAction} submitLabel="Save bonus settings">
                <label className="checkbox-row"><input type="checkbox" name="enabled" defaultChecked={b.enabled} /><span className="text-sm">The Act applies to this company</span></label>
                <div className="grid grid-3">
                  <Num id="b-elig" name="eligibilityCeiling" label="Eligibility wage ceiling (₹/month)" value={b.eligibilityCeiling} min={1} />
                  <Num id="b-calc" name="calculationCeiling" label="Calculation ceiling (₹/month)" value={b.calculationCeiling} min={1} />
                  <Num id="b-mw" name="minimumWage" label="Minimum wage (₹/month)" value={b.minimumWage} min={0} hint="Used instead of the ceiling when higher" />
                  <Num id="b-pct" name="percent" label="Bonus rate (%)" value={b.percent} step="0.01" min={8.33} max={20} />
                  <Num id="b-days" name="minWorkingDays" label="Minimum days worked in the year" value={b.minWorkingDays} min={0} max={366} />
                  <div className="field"><label className="label" htmlFor="b-codes">Wage components</label><input id="b-codes" className="input mono" name="wageCodes" defaultValue={b.wageCodes.join(", ")} /><div className="hint">Basic + DA under the Act</div></div>
                </div>
              </DepthForm>
            </Card>

            <Card tight title="State minimum wages" description="Notified monthly minimum wage by state and skill category. The minimum wage compliance report compares each employee's full-month gross with their state's rate.">
              {rates.length === 0 ? <Empty title="No rates yet">Add the rates for the states you employ in.</Empty> : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>State</th><th>Category</th><th className="num">Monthly minimum</th><th>Effective from</th><th /></tr></thead>
                    <tbody>
                      {rates.map((r) => (
                        <tr key={r.id}>
                          <td className="mono">{r.stateCode}</td>
                          <td>{CATEGORIES.find(([k]) => k === r.category)?.[1] ?? r.category}</td>
                          <td className="num"><Money value={r.monthlyAmount} /></td>
                          <td>{formatDate(r.effectiveFrom)}</td>
                          <td><DepthForm action={deleteMinimumWageAction} inline variant="ghost" submitLabel="Remove" hidden={{ id: r.id }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
                <DepthForm action={saveMinimumWageAction} inline submitLabel="Add rate">
                  <input className="input mono" name="stateCode" placeholder="State (KA)" maxLength={2} required style={{ width: 100 }} aria-label="State code" />
                  <select className="select" name="category" aria-label="Skill category" style={{ width: 150 }}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <input className="input num" name="monthlyAmount" type="number" min={1} placeholder="₹ per month" required style={{ width: 130 }} aria-label="Monthly amount" />
                  <input className="input" name="effectiveFrom" type="date" required style={{ width: 160 }} aria-label="Effective from" />
                </DepthForm>
              </div>
            </Card>
          </>
        ) : (
          <Callout tone="info" title="Statutory settings">Gratuity, statutory bonus and minimum wage settings need the statutory settings permission.</Callout>
        )}
      </div>
    </>
  );
}
