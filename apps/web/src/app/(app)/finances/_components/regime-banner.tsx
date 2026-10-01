import Link from "next/link";
import { InfoBanner } from "@/components/keka";

/** "Your Income and tax liability is being computed as per New Tax Regime…" */
export function RegimeBanner({ regime, canSwitch, tone = "info", fy }: {
  regime: "OLD" | "NEW"; canSwitch: boolean; tone?: "info" | "warning"; fy?: number;
}) {
  const name = regime === "NEW" ? "New Tax Regime" : "Old Tax Regime";
  const other = regime === "NEW" ? "Old Tax Regime" : "New Tax Regime";
  const href = `/finances/pay/tax${fy ? `?fy=${fy}` : ""}#regime`;
  return (
    <InfoBanner tone={tone}>
      Your Income and tax liability is being computed as per <strong>{name}</strong>.{" "}
      {canSwitch ? <>To learn more and switch to {other},</> : <>To compare it with the {other},</>}{" "}
      <Link href={href} style={{ color: "var(--text)", fontWeight: 600, textDecoration: "underline" }}>Click Here.</Link>
    </InfoBanner>
  );
}
