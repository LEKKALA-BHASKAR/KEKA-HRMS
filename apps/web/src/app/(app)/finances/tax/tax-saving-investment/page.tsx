import Link from "next/link";
import { fyLabel, fyStartYear } from "@keka/shared";
import { roomLeft, sectionCap, marginalSaving, EIGHTY_C_CAP, SECTION_BY_KEY } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { EmptyState, Notice } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { ProviderCard } from "../../_components/provider-card";
import { TAX_SAVING_PROVIDERS } from "../../_lib/providers";
import { loadTaxPicture } from "../../_lib/data";
import { inr } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Tax Saving Investment" };

const n = (v: unknown) => Number(v ?? 0);

/**
 * Tax Saving Investment: how much room is left this year in the sections an
 * investment can fill, what filling it would save at the employee's marginal
 * rate, and services to invest through.
 */
export default async function TaxSavingInvestmentPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const p = await loadTaxPicture(viewer, fy);
  const items = (p.declaration?.items ?? []).map((i) => ({ section: i.section, declaredAmount: n(i.declaredAmount) }));
  const declared = (pred: (sec: string) => boolean) => items.filter((i) => pred(i.section)).reduce((a, i) => a + i.declaredAmount, 0);
  const old = p.comparison?.old ?? (p.regime === "OLD" ? p.result : null);
  const bands = old?.slabBreakdown ?? [];
  const marginal = [...bands].reverse().find((b) => b.taxableInBand.toNumber() > 0)?.rate.toNumber() ?? 0;
  const rows = [
    { key: "80c", section: "80C, 80CCC, 80CCD(1)", what: "ELSS, PPF, life insurance, EPF top-ups, tuition fees", limit: EIGHTY_C_CAP, declared: declared((x) => SECTION_BY_KEY.get(x)?.sharedGroup === "80C_GROUP"), room: roomLeft("80C", items, p.age) ?? 0, tab: "80c" },
    { key: "nps", section: "80CCD(1B)", what: "Additional NPS contribution", limit: sectionCap("80CCD(1B)", p.age) ?? 50000, declared: declared((x) => x === "80CCD(1B)"), room: roomLeft("80CCD(1B)", items, p.age) ?? 0, tab: "other" },
    { key: "80d", section: "80D", what: "Health insurance for you and your family", limit: sectionCap("80D", p.age) ?? 25000, declared: declared((x) => x === "80D"), room: roomLeft("80D", items, p.age) ?? 0, tab: "other" },
  ];
  const total = rows.reduce((a, r) => a + marginalSaving(r.room, marginal), 0);

  return (
    <>
      <h1 className={s.pageTitle}>Tax Saving Investment</h1>
      <p className={s.pageSub}>See the room left in each section this year, and invest to use it.</p>

      <section className={`${s.boxed} ${s.mt}`} aria-label="Room left this year">
        <div className={s.roomHead}>
          <div>
            <h2 className={s.formPanelTitle}>Room left this year — {fyLabel(fy)}</h2>
            <p className={s.muted} style={{ fontSize: 14, marginTop: 4 }}>
              {p.regime === "OLD"
                ? <>Estimated at your marginal rate of {marginal}% plus 4% cess. Declare what you invest so payroll deducts less tax.</>
                : <>You are on the New Tax Regime, where these deductions do not reduce your tax. The figures show what they would save under the Old Tax Regime.</>}
            </p>
          </div>
          {p.regime === "OLD" && total > 0 ? <div className={s.roomTotal}><span className={s.muted}>You could save up to</span><strong>{inr(total)}</strong></div> : null}
        </div>
        <div className={s.tableScroll}>
          <table className={`${s.table} ${s.flatTable}`}>
            <thead><tr><th scope="col">Section</th><th scope="col">Limit</th><th scope="col">Declared</th><th scope="col">Room Left</th><th scope="col">Tax You Could Save</th><th scope="col"><span className="sr-only">Declare</span></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.section}<div className={s.muted} style={{ fontSize: 12.5 }}>{r.what}</div></td>
                  <td className={s.num}>{inr(r.limit)}</td>
                  <td className={s.num}>{inr(r.declared)}</td>
                  <td className={s.num}>{inr(r.room)}</td>
                  <td className={s.num}>{inr(marginalSaving(r.room, marginal))}</td>
                  <td>{p.regime === "OLD" && r.room > 0 ? <Link className={s.link} href={`/finances/tax?tab=${r.tab}`}>Declare now</Link> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.regime === "NEW" ? <div className={s.pad}><Notice>Only the employer&apos;s NPS contribution (80CCD(2)) reduces tax under the New Tax Regime. <Link className={s.link} href="/finances/pay/tax#regime">Compare the two regimes</Link></Notice></div> : null}
      </section>

      <div className={s.providerGrid}>
        {TAX_SAVING_PROVIDERS.map((pr) => <ProviderCard key={pr.key} p={pr} />)}
      </div>
      <p className={s.capHint} style={{ marginTop: 18 }}>Third-party services are independent of your employer and of this platform. Investments carry market risk.</p>
    </>
  );
}
