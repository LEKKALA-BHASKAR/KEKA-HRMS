import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@keka/db";
import { resolveTimePolicy, localDateKey } from "@keka/services";
import { requireViewer } from "@/lib/context";
import { ClockPanel } from "../attendance/_parts/live";

/**
 * The phone clock-in page: the start page when the app is added to a home
 * screen. One big button, the day's punches, and whatever the attendance
 * policy asks for (location inside the office geo-fence, a selfie).
 */
export default async function MobileClockPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) redirect("/");
  const employeeId = viewer.employee.id;
  const now = new Date();
  const policy = await resolveTimePolicy(employeeId, now);
  const tz = policy.tzOffset;
  const dayKey = localDateKey(now, tz);
  const dayStart = new Date(new Date(`${dayKey}T00:00:00Z`).getTime() - tz * 60_000);
  const punches = await prisma.attendanceLog.findMany({
    where: { employeeId, status: { not: "REJECTED" }, timestamp: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } },
    orderBy: { timestamp: "asc" }, select: { id: true, timestamp: true, direction: true, source: true, status: true },
  });
  // Pair the day's punches: each IN opens, the next OUT closes.
  let openSince: Date | null = null, closed = 0;
  for (const p of punches) {
    if (p.direction === 0) openSince ??= p.timestamp;
    else if (openSince) { closed += (p.timestamp.getTime() - openSince.getTime()) / 60_000; openSince = null; }
  }
  const time = (d: Date) => new Date(d.getTime() + tz * 60_000).toISOString().slice(11, 16);

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "16px 0" }}>
      <div className="card" style={{ padding: 20 }}>
        <ClockPanel
          tzOffset={tz} clockedInSince={openSince?.toISOString() ?? null} closedMinutes={Math.round(closed)}
          allowed={policy.allowMobileClockIn} requireComment={policy.requireClockInComment}
          requireLocation={policy.requireGeofence} requireSelfie={policy.requireSelfie} mode="mobile"
        />
      </div>
      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <div className="text-sm strong" style={{ marginBottom: 8 }}>Today</div>
        {punches.length === 0 ? <div className="text-sm subtle">No punches yet.</div> : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
            {punches.map((p) => (
              <li key={p.id} className="row text-sm" style={{ justifyContent: "space-between" }}>
                <span>{p.direction === 0 ? "In" : "Out"} · {time(p.timestamp)}</span>
                <span className="text-xs subtle">{p.source.toLowerCase()}{p.status === "PENDING" ? " · awaiting approval" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs subtle" style={{ textAlign: "center", marginTop: 12 }}>
        <Link href="/me/attendance">Full attendance</Link> · Add this page to your home screen to open it like an app.
      </p>
    </div>
  );
}
