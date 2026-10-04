import Link from "next/link";
import { prisma } from "@keka/db";
import { inAudience, type Audience } from "@keka/services";
import type { Viewer } from "@/lib/context";

/** A red banner on every page while an emergency broadcast that reaches the viewer is live. */
export async function EmergencyBanner({ viewer }: { viewer: Viewer }) {
  const live = await prisma.announcement.findMany({
    where: { tenantId: viewer.tenantId, isEmergency: true, status: "PUBLISHED" },
    orderBy: { publishAt: "desc" }, take: 3, select: { id: true, title: true, audience: true },
  });
  if (live.length === 0) return null;
  const me = viewer.employee ? await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { departmentId: true, locationId: true, businessUnitId: true, status: true } }) : null;
  const mine = live.filter((a) => !me || inAudience(a.audience as Audience | null, me));
  if (mine.length === 0) return null;
  return (
    <div role="alert" className="callout danger" style={{ marginBottom: 12 }}>
      <div>
        <strong>Emergency: </strong>
        {mine.map((a, i) => <span key={a.id}>{i ? " · " : ""}{a.title}</span>)}
        {" "}<Link href="/announcements" style={{ textDecoration: "underline" }}>Read now</Link>
      </div>
    </div>
  );
}
