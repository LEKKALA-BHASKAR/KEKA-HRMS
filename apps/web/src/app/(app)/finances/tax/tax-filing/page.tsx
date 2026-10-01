import { itrCalendar } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { InfoBanner } from "@/components/keka";
import { ProviderCard } from "../../_components/provider-card";
import { ITR_PROVIDERS } from "../../_lib/providers";
import s from "../../finances.module.css";

export const metadata = { title: "Tax Filing" };

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Tax Filing: the ITR due date for the last financial year, and where to e-file. */
export default async function TaxFilingPage() {
  const viewer = await requireViewer();
  const c = itrCalendar(new Date(), viewer.tenant.fyStartMonth);
  return (
    <>
      <h1 className={s.pageTitle}>Tax Filing</h1>
      <p className={s.pageSub}>E-file your income tax return using your Form 16.</p>
      <div className={s.mt}>
        <InfoBanner>
          {c.passed
            ? <>The due date to file your ITR for {c.label} was <strong>{fmt(c.due)}</strong>. A belated return can still be filed until <strong>{fmt(c.belatedTill)}</strong>.</>
            : <>Due date to file your ITR for {c.label} is <strong>{fmt(c.due)}</strong></>}
        </InfoBanner>
      </div>
      <div className={s.providerGrid}>
        {ITR_PROVIDERS.map((p) => <ProviderCard key={p.key} p={p} />)}
      </div>
      <p className={s.capHint} style={{ marginTop: 18 }}>Third-party services are independent of your employer and of this platform. Your Form 16 is under Manage Tax › Forms.</p>
    </>
  );
}
