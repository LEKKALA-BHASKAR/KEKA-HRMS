import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { hashOfferToken } from "@keka/services";
import { ActButton } from "@/components/growth-forms";
import { tenantFromHost } from "@/lib/tenant-host";
import { jobAlertLinkAction } from "../../portal-actions";

export const metadata: Metadata = { title: "Your job alert", robots: { index: false } };

/** The link in a job alert email: confirm the alert, or unsubscribe. Nothing changes until a button is pressed. */
export default async function JobAlertLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = (await tenantFromHost())!;
  const { token } = await params;
  const sub = await prisma.jobAlertSubscription.findFirst({ where: { tokenHash: hashOfferToken(token), tenantId: tenant.id } });
  if (!sub) return <div className="card" style={{ padding: 20 }}>This link is not valid any more. <Link href="/careers/alerts">Create a new alert.</Link></div>;
  return (
    <div className="card" style={{ padding: 20 }}>
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Job alert for {sub.email}</h1>
      <p className="muted">{sub.unsubscribedAt ? "You are unsubscribed." : sub.confirmedAt ? "Your alert is on." : "Confirm to start getting alerts."}{sub.keywords ? ` Keywords: ${sub.keywords}.` : ""}</p>
      <div className="row gap-2">
        {!sub.confirmedAt || sub.unsubscribedAt ? <ActButton action={jobAlertLinkAction} hidden={{ token, op: "confirm" }} label="Confirm my alert" variant="primary" /> : null}
        {!sub.unsubscribedAt ? <ActButton action={jobAlertLinkAction} hidden={{ token, op: "unsubscribe" }} label="Unsubscribe" /> : null}
      </div>
    </div>
  );
}
