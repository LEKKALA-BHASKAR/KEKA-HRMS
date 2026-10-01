import Link from "next/link";
import { fyLabel, fyStartYear } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { Chip, EmptyState, InfoBanner } from "@/components/keka";
import { IconBriefcase } from "@/components/icons";
import { PreviousIncomeForm } from "../../_components/tax-forms";
import { loadTaxPicture } from "../../_lib/data";
import { inr } from "../../_lib/rules";
import s from "../../finances.module.css";

export const metadata = { title: "Previous Income" };

export default async function PreviousIncomePage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconBriefcase />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const fy = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const p = await loadTaxPicture(viewer, fy);
  const prof = p.profile;
  const open = p.windows.declaration.open;
  const values = {
    previousEmployerIncome: prof?.previousEmployerIncome ?? null,
    previousEmployerTds: prof?.previousEmployerTds ?? null,
    previousEmployerPf: prof?.previousEmployerPf ?? null,
    previousEmployerPt: prof?.previousEmployerPt ?? null,
  };
  const any = Object.values(values).some((v) => v !== null && v > 0);

  return (
    <>
      <div className={s.titleRow}>
        <div className={s.titleLeft}><h1 className={s.bigTitle}>Previous Income</h1></div>
        <span className={s.status}>
          <span className={s.muted}>Declaration window</span>
          <Chip kind={open ? "open" : "closed"}>{open ? "Open" : "Closed"}</Chip>
        </span>
      </div>
      <p className={s.pageSub}>
        If you worked elsewhere earlier in {fyLabel(fy)}, declare what that employer paid you and deducted.
        Your tax is computed on the whole year&apos;s income, and their TDS counts towards tax already paid.
      </p>

      <div className={s.mt}>
        <InfoBanner>{p.windows.declaration.note}</InfoBanner>
      </div>

      <div className={s.mt}>
        {open ? <PreviousIncomeForm defaults={values} /> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th scope="col">Previous employment — {fyLabel(fy)}</th><th scope="col" className={s.right}>Amount</th></tr></thead>
              <tbody>
                <tr><td>Income after exemptions</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerIncome)}</td></tr>
                <tr><td>Income tax deducted (TDS)</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerTds)}</td></tr>
                <tr><td>Provident Fund</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerPf)}</td></tr>
                <tr><td>Professional tax</td><td className={`${s.right} ${s.num}`}>{inr(values.previousEmployerPt)}</td></tr>
              </tbody>
            </table>
            {!any ? <div className={s.pad}><span className={s.muted}>No previous employment has been declared for this year.</span></div> : null}
          </div>
        )}
      </div>

      {any && p.result ? (
        <p className={s.capHint} style={{ fontSize: 14 }}>
          With this income your projected tax for the year is {inr(p.totalTax)}, of which {inr(p.taxPaid)} is already paid.{" "}
          <Link className={s.link} href="/finances/pay/tax">See the computation</Link>
        </p>
      ) : null}
    </>
  );
}
