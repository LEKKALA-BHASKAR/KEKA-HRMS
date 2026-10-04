import type { Metadata } from "next";
import { cookies } from "next/headers";
import { prisma } from "@keka/db";
import { kioskByToken, kioskDeviceKey } from "@keka/services";
import { throttled, clientIp } from "@/lib/throttle";
import { KioskPad, UnlockKiosk } from "./kiosk";

/** The token is in the address: keep it out of search engines and referrer logs. */
export const metadata: Metadata = { title: "Attendance kiosk", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f7f7f8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 440 }}>
        <div className="card-body">
          <div style={{ marginBottom: 14 }}>
            <div className="strong" style={{ fontSize: 20 }}>{title}</div>
            {subtitle ? <div className="muted text-sm">{subtitle}</div> : null}
          </div>
          {children}
          <div className="text-xs subtle" style={{ marginTop: 18, textAlign: "center" }}>BooS-HR attendance kiosk</div>
        </div>
      </div>
    </div>
  );
}

/**
 * A web kiosk: a shared device where employees clock in and out with their
 * employee number and personal PIN. The device is unlocked once with the
 * kiosk PIN; until then it only asks for that PIN.
 */
export default async function KioskPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`kiosk-view|${ip}`, 120, 10 * 60_000)) {
    return <Shell title="Attendance kiosk"><div className="callout warning">Too many requests just now. Try again in a few minutes.</div></Shell>;
  }
  const kiosk = await kioskByToken(token);
  if (!kiosk) {
    return <Shell title="This kiosk link is not valid"><p className="muted">The kiosk may be switched off or its link replaced. Ask HR for the current link.</p></Shell>;
  }
  const location = kiosk.locationId ? await prisma.location.findFirst({ where: { id: kiosk.locationId, tenantId: kiosk.tenantId }, select: { name: true } }) : null;
  const subtitle = [kiosk.tenant.name, location?.name].filter(Boolean).join(" · ");
  const unlocked = (await cookies()).get(`kiosk_${kiosk.id}`)?.value === kioskDeviceKey(kiosk);
  return (
    <Shell title={kiosk.name} subtitle={subtitle}>
      {unlocked ? <KioskPad token={token} /> : <UnlockKiosk token={token} />}
    </Shell>
  );
}
