import { headers } from "next/headers";
import { forbidden } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate } from "@keka/shared";
import { API_SCOPES, WEBHOOK_EVENTS } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { PageHead, Card, Badge, Empty } from "@/components/ui";
import { CreateKey, RevokeKey, DeviceForm, ToggleDevice, CreateWebhook, WebhookOps, RetryDelivery } from "./forms";

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
  const [hooks, deliveries] = keysOk ? await Promise.all([
    prisma.webhookEndpoint.findMany({ where: { tenantId: viewer.tenantId }, orderBy: { createdAt: "asc" } }),
    prisma.webhookDelivery.findMany({ where: { endpoint: { tenantId: viewer.tenantId } }, include: { endpoint: { select: { url: true } } }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]) : [[], []];
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
      {keysOk ? (
        <>
          <Card tight title="Webhooks" description="Signed POSTs to your systems when things happen. Verify X-Keka-Signature: sha256 HMAC of “<X-Keka-Timestamp>.<body>” with the endpoint's secret.">
            {hooks.length === 0 ? <Empty title="No webhooks yet" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th>Last success</th><th /></tr></thead>
                <tbody>
                  {hooks.map((h) => (
                    <tr key={h.id}>
                      <td><span className="mono text-xs" style={{ wordBreak: "break-all" }}>{h.url}</span>{h.description ? <div className="text-xs subtle">{h.description}</div> : null}</td>
                      <td className="text-xs mono">{h.events.join(", ")}</td>
                      <td>{h.isActive ? <Badge tone="success">active</Badge> : <Badge tone="warning">paused</Badge>}{h.failureCount ? <div className="text-xs neg">{h.failureCount} failed in a row</div> : null}</td>
                      <td className="text-xs">{when(h.lastSuccessAt)}</td>
                      <td className="right"><WebhookOps id={h.id} active={h.isActive} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
          {deliveries.length ? (
            <Card tight title="Recent deliveries">
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Event</th><th>Endpoint</th><th>Status</th><th className="num">Attempts</th><th>When</th><th /></tr></thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="mono text-xs">{d.event}</td>
                      <td className="mono text-xs" style={{ wordBreak: "break-all" }}>{d.endpoint.url}</td>
                      <td><Badge tone={d.status === "DELIVERED" ? "success" : d.status === "FAILED" ? "danger" : "info"}>{d.status.toLowerCase()}</Badge>{d.error ? <div className="text-xs subtle">{d.error}</div> : null}</td>
                      <td className="num text-sm">{d.attempts}</td>
                      <td className="text-xs">{when(d.deliveredAt ?? d.createdAt)}</td>
                      <td className="right">{d.status === "FAILED" ? <RetryDelivery id={d.id} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Card>
          ) : null}
          <Card title="Add a webhook"><CreateWebhook events={Object.entries(WEBHOOK_EVENTS).filter(([k]) => k !== "ping").map(([value, label]) => ({ value, label }))} /></Card>
          <Card title="Reading data">
            <p className="text-sm">Keys allowed to read can call these. Lists page with <span className="mono">nextCursor</span>; pass it back as <span className="mono">cursor</span> until it is null.</p>
            <pre className="mono text-xs" style={{ whiteSpace: "pre-wrap", padding: 12, background: "var(--surface-2, #f4f4f5)", borderRadius: 6 }}>{`GET https://${host}/api/v1/employees?status=ACTIVE&limit=100      (employees:read)
GET https://${host}/api/v1/employees/ACM0009                       (employees:read)
GET https://${host}/api/v1/leave/requests?from=2026-10-01&to=2026-10-31  (leave:read)
GET https://${host}/api/v1/payroll/runs?year=2026                  (payroll:read)`}</pre>
          </Card>
        </>
      ) : null}
    </>
  );
}
