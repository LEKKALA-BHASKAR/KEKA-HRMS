import { PERMISSIONS as P } from "@keka/rbac";
import { can, type Viewer } from "@/lib/context";
import { SubTabs } from "@/components/subtabs";

/** Billing: Invoices · Charges · Credit notes · Payments. */
export function BillingTabs({ active }: { active: string }) {
  return (
    <SubTabs active={active} items={[
      { label: "Invoices", href: "/projects/billing" },
      { label: "Charges", href: "/projects/billing/charges" },
      { label: "Credit notes", href: "/projects/billing/credit-notes" },
      { label: "Payments", href: "/projects/billing/payments" },
    ]} />
  );
}

/** Projects › Settings: rate cards, billing entities and the timesheet policy, each behind its own permission. */
export function SettingsTabs({ viewer, active }: { viewer: Viewer; active: string }) {
  const items = [
    can(viewer, P.RATE_CARD_MANAGE) && { label: "Rate cards", href: "/projects/settings/rate-cards" },
    can(viewer, P.BILLING_MANAGE) && { label: "Billing entities", href: "/projects/settings/billing-entities" },
    can(viewer, P.PROJECT_MANAGE) && { label: "Timesheets", href: "/projects/settings/timesheets" },
  ].filter((x): x is { label: string; href: string } => !!x);
  return <SubTabs items={items} active={active} />;
}

/** The first PSA settings page the viewer can open, if any. */
export function firstSettingsHref(viewer: Viewer): string | null {
  if (can(viewer, P.RATE_CARD_MANAGE)) return "/projects/settings/rate-cards";
  if (can(viewer, P.BILLING_MANAGE)) return "/projects/settings/billing-entities";
  if (can(viewer, P.PROJECT_MANAGE)) return "/projects/settings/timesheets";
  return null;
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
export const money = (n: unknown, currency = "INR") => `${currency === "INR" ? "₹" : `${currency} `}${Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const INVOICE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { DRAFT: "neutral", SENT: "info", PARTIALLY_PAID: "warning", PAID: "success", OVERDUE: "danger", CANCELLED: "neutral", WRITTEN_OFF: "danger" };
export const CN_TONE: Record<string, "success" | "info" | "neutral"> = { OPEN: "info", APPLIED: "success", VOID: "neutral" };
