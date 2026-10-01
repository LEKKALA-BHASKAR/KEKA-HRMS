import { headers } from "next/headers";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { API_SCOPES } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { CreateKey, RevokeKey, DeviceForm, ToggleDevice } from "./forms";

const P = PERMISSIONS;
const when = (d: Date | null) => (d ? `${formatDate(d)} ${d.toISOString().slice(11, 16)} UTC` : "never");

/**
 * Integrations: API keys for machine clients and the attendance devices that
 * push punches with them.
 */
export default async function IntegrationsPage() {
  const viewer = await requireViewer();
  const keysOk = can(viewer, P.API_KEY_MANAGE), devicesOk = can(viewer, P.ATTENDANCE_MANAGE);
  if (!keysOk && !devicesOk) forbidden();
  const host = (await headers()).get("host") ?? "your-company.example.com";
  const [keys, devices, locations] = await Promise.all([
    keysOk ? prisma.apiKey.findMany({ where: { tenantId: viewer.tenantId }, orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }] }) : [],
    devicesOk ? prisma.attendanceDevice.findMany({ where: { tenantId: viewer.tenantId }, include: { location: { select: { name: true } } }, orderBy: { name: "asc" } }) : [],
    devicesOk ? prisma.location.findMany({ where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
  ]);
  const punchCounts = devices.length ? await prisma.attendanceLog.groupBy({ by: ["deviceId"], where: { deviceId: { in: devices.map((d) => d.id) }, timestamp: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: true }) : [];
  const weekPunches = new Map(punchCounts.map((p) => [p.deviceId, p._count]));

  return (
    <>
      <PageHead title="Integrations" subtitle="Connect biometric devices and other systems through the API." />
      {keysOk ? (
        <div className="grid grid-2">
          <Card tight title="API keys">
            {keys.length === 0 ? <Empty title="No API keys yet" /> : (
              <table className="data">
                <thead><tr><th>Name</th><th>Allowed to</th><th>Last used</th><th /></tr></thead>
                <tbody>
                  {keys.map((k) => {
                    const expired = !!k.expiresAt && k.expiresAt < new Date();
                    return (
                      <tr key={k.id}>
                        <td><strong>{k.name}</strong><div className="text-xs subtle mono">{k.prefix}_…</div></td>
                        <td className="text-xs">{k.scopes.map((s) => API_SCOPES[s as keyof typeof API_SCOPES] ?? s).join(", ")}</td>
                        <td className="text-xs">{when(k.lastUsedAt)}{k.expiresAt ? <div className="subtle">expires {formatDate(k.expiresAt)}</div> : null}</td>
                        <td className="right">{k.revokedAt ? <Badge tone="neutral">revoked</Badge> : expired ? <Badge tone="warning">expired</Badge> : <RevokeKey id={k.id} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="New API key">
            <CreateKey scopes={Object.entries(API_SCOPES).map(([value, label]) => ({ value, label }))} />
          </Card>
        </div>
      ) : null}

      {devicesOk ? (
        <>
          <Card tight title="Attendance devices">
            {devices.length === 0 ? <Empty title="No devices registered">Register each biometric device by its serial number so its punches are accepted.</Empty> : (
              <table className="data">
                <thead><tr><th>Device</th><th>Location</th><th>Last seen</th><th className="num">Punches, 7 days</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td><strong>{d.name}</strong><div className="text-xs subtle mono">{d.serialNumber}</div></td>
                      <td className="text-sm">{d.location?.name ?? "Any"}</td>
                      <td className="text-xs">{when(d.lastSeenAt)}</td>
                      <td className="num">{weekPunches.get(d.id) ?? 0}</td>
                      <td><Badge tone={d.isActive ? "success" : "neutral"}>{d.isActive ? "on" : "off"}</Badge></td>
                      <td className="right"><ToggleDevice id={d.id} active={d.isActive} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Register a device"><DeviceForm locations={locations.map((l) => ({ value: l.id, label: l.name }))} /></Card>
          <Card title="Pushing punches">
            <p className="text-sm">The device bridge posts punches with a key allowed to push attendance. Employees are matched by their attendance number, or their employee number when that is blank. Direction is optional; without it a day&apos;s punches alternate in and out.</p>
            <pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", padding: 12, background: "var(--surface-2, #f4f4f5)", borderRadius: 6 }}>{`curl -X POST https://${host}/api/v1/attendance/punches \\
  -H "Authorization: Bearer <api key>" -H "Content-Type: application/json" \\
  -d '{"punches":[{"employeeCode":"ACM0009","timestamp":"2026-10-01T09:04:00+05:30","direction":"IN","deviceSerial":"${devices[0]?.serialNumber ?? "BLR-GATE-1"}"}]}'`}</pre>
            <p className="text-xs subtle">Up to 500 punches per request. A punch within a minute of one already recorded is counted as a duplicate, so a device can safely re-send its buffer.</p>
          </Card>
        </>
      ) : null}
    </>
  );
}
