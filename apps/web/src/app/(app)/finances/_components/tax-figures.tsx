import Link from "next/link";
import type { TaxPicture } from "../_lib/data";
import { inr } from "../_lib/rules";
import { IconInfo } from "./icons";
import s from "../finances.module.css";

/** Net Taxable Income · Total Tax Payable · Tax Already Paid. */
export function TaxFigures({ p, computationHref }: { p: TaxPicture; computationHref?: string }) {
  const r = p.result;
  return (
    <div className={s.figures}>
      <section className={`${s.boxed} ${s.figure}`} aria-label="Net taxable income">
        <div className={s.figureLabel}>Net Taxable Income</div>
        <div className={s.figureRow}>
          <span className={s.figureValue}>{inr(r?.taxableIncome.toNumber() ?? 0)}</span>
          {computationHref ? <Link className={s.link} href={computationHref}>Income Tax computation</Link> : null}
        </div>
      </section>
      <section className={`${s.boxed} ${s.figure}`} aria-label="Total tax payable">
        <div className={s.figureLabel}>
          <span>Total Tax Payable</span>
          <span title="Projected for the full year: tax on slabs, less rebate, plus surcharge and 4% cess." style={{ color: "var(--text-subtle)", display: "inline-grid" }}>
            <IconInfo width={18} height={18} />
          </span>
        </div>
        <div className={s.figureRow}><span className={s.figureValue}>{inr(p.totalTax)}</span></div>
      </section>
      <section className={`${s.boxed} ${s.figure}`} aria-label="Tax already paid">
        <div className={s.figureLabel}>Tax Already Paid</div>
        <div className={s.figureRow}><span className={s.figureValue}>{inr(p.taxPaid)}</span></div>
      </section>
    </div>
  );
}
