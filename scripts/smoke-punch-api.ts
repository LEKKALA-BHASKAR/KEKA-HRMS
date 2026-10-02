/**
 * The punch API end to end, through the route handler: create an API key and
 * register a device from Settings > Integrations, push punches (matched by
 * attendance or employee number, with and without direction), re-send them
 * (duplicates), reject bad rows by index, refuse a switched-off device, a
 * revoked key and a key without the scope, and see the day's attendance
 * processed from the pushed punches.
 *
 * Uses a past weekday for Meera and Priya, a key named "Smoke bridge" and a
 * device "SMOKE-GATE"; all removed at the end, and the day reprocessed.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const act = await import("../apps/web/src/app/actions/integrations");
  const route = await import("../apps/web/src/app/api/v1/attendance/punches/route");
  const { processAttendance } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } } });
  const priya = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "priya.sharma@acme.test" } } });
  const since = new Date();
  // A Wednesday two to three weeks back, safely inside the window.
  const day = new Date(Date.now() - 14 * 86_400_000);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 4) % 7));
  const ymd = day.toISOString().slice(0, 10);
  const dayDate = new Date(`${ymd}T00:00:00Z`);
  const at = (hhmm: string) => `${ymd}T${hhmm}:00+05:30`;
  const origAtt = meera.attendanceNumber;
  const post = (key: string | null, body: unknown) => route.POST(new Request("http://acme.localhost/api/v1/attendance/punches", {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body),
  }));
  const cleanupPunches = () => prisma.attendanceLog.deleteMany({ where: { employeeId: { in: [meera.id, priya.id] }, createdAt: { gte: since } } });

  try {
    await prisma.employee.update({ where: { id: meera.id }, data: { attendanceNumber: "BIO-9009" } });

    // -----------------------------------------------------------------
    section("Keys and devices");
    await signInAs("meera.krishnan@acme.test");
    let denied = false;
    try { await act.createApiKeyAction({}, fd({ name: "Nope", scopes: "attendance:write" })); } catch (e) { denied = /403/.test((e as { digest?: string }).digest ?? ""); }
    check("An employee cannot create API keys", denied);

    await signInAs("vikram.menon@acme.test");
    const none = await act.createApiKeyAction({}, fd({ name: "Smoke bridge" }));
    check("A key needs at least one permission", none.ok !== true, none.message);
    const made = await act.createApiKeyAction({}, fd({ name: "Smoke bridge", scopes: "attendance:write", expiresInDays: "30" })) as { ok?: boolean; key?: string; message?: string };
    const key = made.key ?? "";
    check("Created a key, shown once", made.ok === true && /^kk_[0-9a-f]{8}_/.test(key), made.message);
    const row = await prisma.apiKey.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Smoke bridge" } });
    check("Only a hash is stored", !row.keyHash.includes(key.split("_")[2]) && row.keyHash.length === 64);
    const readOnly = (await act.createApiKeyAction({}, fd({ name: "Smoke bridge", scopes: "employees:read" })) as { key?: string }).key ?? "";

    const dev = await act.saveDeviceAction({}, fd({ name: "Smoke gate", serialNumber: "SMOKE-GATE" }));
    check("Registered a device", dev.ok === true, dev.message);
    const dupDev = await act.saveDeviceAction({}, fd({ name: "Again", serialNumber: "SMOKE-GATE" }));
    check("A serial can only be registered once", dupDev.ok !== true, dupDev.message);

    // -----------------------------------------------------------------
    section("Authentication");
    check("No key: 401", (await post(null, { punches: [] })).status === 401);
    check("A made-up key: 401", (await post("kk_00000000_abcdefghijklmnopqrstuvwx", { punches: [{}] })).status === 401);
    check("A key without the attendance scope: 403", (await post(readOnly, { punches: [{}] })).status === 403);
    const ping = await route.GET(new Request("http://x/api", { headers: { authorization: `Bearer ${key}` } }));
    check("GET checks the connection", ping.status === 200);
    check("An empty body is a 400", (await post(key, { punches: [] })).status === 400);

    // -----------------------------------------------------------------
    section("Pushing punches");
    const res = await post(key, { punches: [
      { employeeCode: "BIO-9009", timestamp: at("09:02"), deviceSerial: "SMOKE-GATE" },
      { employeeCode: "BIO-9009", timestamp: at("18:31"), deviceSerial: "SMOKE-GATE" },
      { employeeCode: priya.employeeNumber, timestamp: at("09:40"), direction: "IN" },
      { employeeCode: priya.employeeNumber, timestamp: at("18:05"), direction: "OUT" },
      { employeeCode: "NOPE-1", timestamp: at("09:00") },
      { employeeCode: "BIO-9009", timestamp: "2026-10-01T09:00:00" },
      { employeeCode: "BIO-9009", timestamp: at("10:00"), direction: "SIDEWAYS" },
      { employeeCode: "BIO-9009", timestamp: at("11:00"), deviceSerial: "UNKNOWN-1" },
      { employeeCode: "BIO-9009", timestamp: "2099-01-01T09:00:00Z" },
    ] });
    const body = await res.json() as { accepted: number; duplicates: number; rejected: { index: number; error: string }[]; employees: number };
    check("Four punches accepted for two employees", res.status === 200 && body.accepted === 4 && body.employees === 2, JSON.stringify({ accepted: body.accepted, employees: body.employees }));
    check("Five rejected, each by index with a reason", body.rejected.map((r) => r.index).join(",") === "4,5,6,7,8", body.rejected.map((r) => `${r.index}: ${r.error}`).join(" | "));
    const logs = await prisma.attendanceLog.findMany({ where: { employeeId: meera.id, createdAt: { gte: since } }, orderBy: { timestamp: "asc" } });
    // The seeded day may already hold punches; each new one takes the next turn.
    const dayLogs = await prisma.attendanceLog.findMany({ where: { employeeId: meera.id, timestamp: { gte: new Date(`${ymd}T00:00:00+05:30`), lt: new Date(dayDate.getTime() + 86_400_000 - 330 * 60_000) } }, orderBy: { timestamp: "asc" } });
    const expected = logs.map((l) => { const prior = dayLogs.filter((d) => d.timestamp < l.timestamp).pop(); return prior ? 1 - prior.direction : 0; }).join("");
    check("Without a direction, each punch flips the day's previous one", logs.map((l) => l.direction).join("") === expected, `${logs.map((l) => l.direction).join("")} vs ${expected}`);
    check("Device punches are tagged biometric with the device", logs.every((l) => l.source === "BIOMETRIC" && !!l.deviceId));
    const pl = await prisma.attendanceLog.findFirst({ where: { employeeId: priya.id, createdAt: { gte: since } } });
    check("Punches without a device are tagged API", pl?.source === "API");
    const rec = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: meera.id, date: dayDate } } });
    check("The day was reprocessed with the pushed punches", !!rec?.firstIn && rec.firstIn.getTime() <= new Date(at("09:02")).getTime() && !!rec.lastOut && rec.lastOut.getTime() >= new Date(at("18:31")).getTime() - 60_000,
      `${rec?.status} ${rec?.firstIn?.toISOString()} – ${rec?.lastOut?.toISOString()}`);
    check("The device's last-seen time was updated", !!(await prisma.attendanceDevice.findFirst({ where: { tenantId: tenant.id, serialNumber: "SMOKE-GATE" } }))?.lastSeenAt);

    const again = await (await post(key, { punches: [{ employeeCode: "BIO-9009", timestamp: at("09:02"), deviceSerial: "SMOKE-GATE" }] })).json() as { accepted: number; duplicates: number };
    check("Re-sending is a duplicate, not a second punch", again.accepted === 0 && again.duplicates === 1);

    // -----------------------------------------------------------------
    section("Switching things off");
    const device = await prisma.attendanceDevice.findFirstOrThrow({ where: { tenantId: tenant.id, serialNumber: "SMOKE-GATE" } });
    await act.toggleDeviceAction({}, fd({ id: device.id }));
    const off = await (await post(key, { punches: [{ employeeCode: "BIO-9009", timestamp: at("13:00"), deviceSerial: "SMOKE-GATE" }] })).json() as { rejected: { error: string }[] };
    check("A switched-off device's punches are refused", /switched off/.test(off.rejected[0]?.error ?? ""), off.rejected[0]?.error);
    const rv = await act.revokeApiKeyAction({}, fd({ id: row.id }));
    check("Revoked the key", rv.ok === true);
    check("A revoked key is refused", (await post(key, { punches: [{ employeeCode: "BIO-9009", timestamp: at("14:00") }] })).status === 401);
  } finally {
    await cleanupPunches();
    await prisma.employee.update({ where: { id: meera.id }, data: { attendanceNumber: origAtt } });
    await prisma.attendanceDevice.deleteMany({ where: { tenantId: tenant.id, serialNumber: "SMOKE-GATE" } });
    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id, name: { in: ["Smoke bridge", "Nope"] } } });
    await processAttendance({ employeeIds: [meera.id, priya.id], from: dayDate, to: dayDate });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: { in: ["ApiKey", "AttendanceDevice"] } } });
  }
  report("Punch API");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
