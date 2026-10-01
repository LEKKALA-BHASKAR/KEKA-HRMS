import { prisma } from "@keka/db";
import { localDateKey, reprocessRange, resolveTimePolicy } from "./time";

/**
 * Bulk punch ingest for biometric devices and other machine clients. Each
 * punch names the employee by attendance number (falling back to employee
 * number), a timestamp, and optionally a direction and the device's serial.
 * Punches are written in one pass and each employee's attendance is then
 * reprocessed once over the days touched, so a device can upload its whole
 * buffer. A punch without a direction is taken as the opposite of the
 * day's previous punch (an IN when it is the first). Re-sending a punch is harmless: one within a minute of an existing
 * punch for the same person is reported as a duplicate.
 */

export interface RawPunch { employeeCode?: unknown; timestamp?: unknown; direction?: unknown; deviceSerial?: unknown }
export interface IngestResult { accepted: number; duplicates: number; rejected: { index: number; error: string }[]; employees: number }

export const MAX_PUNCHES = 500;
const MAX_AGE_DAYS = 90;
const DAY = 86_400_000;

function parseDirection(v: unknown): 0 | 1 | null | "bad" {
  if (v === undefined || v === null || v === "") return null;
  if (v === 0 || v === "0" || v === "IN" || v === "in") return 0;
  if (v === 1 || v === "1" || v === "OUT" || v === "out") return 1;
  return "bad";
}

export async function ingestPunches(tenantId: string, punches: RawPunch[], now = new Date()): Promise<IngestResult> {
  const rejected: IngestResult["rejected"] = [];
  const codes = [...new Set(punches.map((p) => String(p.employeeCode ?? "").trim()).filter(Boolean))];
  const serials = [...new Set(punches.map((p) => String(p.deviceSerial ?? "").trim()).filter(Boolean))];
  const [emps, devices] = await Promise.all([
    prisma.employee.findMany({
      where: { tenantId, OR: [{ attendanceNumber: { in: codes } }, { employeeNumber: { in: codes } }] },
      select: { id: true, attendanceNumber: true, employeeNumber: true, status: true },
    }),
    prisma.attendanceDevice.findMany({ where: { tenantId, serialNumber: { in: serials } } }),
  ]);
  // Attendance number wins over employee number when both could match.
  const byCode = new Map<string, (typeof emps)[number]>();
  for (const e of emps) if (e.employeeNumber) byCode.set(e.employeeNumber, e);
  for (const e of emps) if (e.attendanceNumber) byCode.set(e.attendanceNumber, e);
  const bySerial = new Map(devices.map((d) => [d.serialNumber, d]));

  type Ok = { index: number; employeeId: string; at: Date; direction: 0 | 1 | null; deviceId: string | null };
  const good: Ok[] = [];
  punches.forEach((p, index) => {
    const code = String(p.employeeCode ?? "").trim();
    const emp = byCode.get(code);
    const at = typeof p.timestamp === "string" || typeof p.timestamp === "number" ? new Date(p.timestamp) : new Date(NaN);
    const direction = parseDirection(p.direction);
    const serial = String(p.deviceSerial ?? "").trim();
    const device = serial ? bySerial.get(serial) : null;
    const err = !code ? "employeeCode is required"
      : !emp ? `No employee with attendance or employee number ${code}`
      : emp.status === "EXITED" ? `${code} has exited`
      : Number.isNaN(at.getTime()) ? "timestamp must be an ISO 8601 date-time"
      : typeof p.timestamp === "string" && !/(Z|[+-]\d{2}:?\d{2})$/.test(p.timestamp) ? "timestamp needs a timezone offset, e.g. 2026-10-01T09:05:00+05:30"
      : at.getTime() > now.getTime() + 5 * 60_000 ? "timestamp is in the future"
      : at.getTime() < now.getTime() - MAX_AGE_DAYS * DAY ? `timestamp is more than ${MAX_AGE_DAYS} days old`
      : direction === "bad" ? "direction must be IN or OUT (or 0 or 1)"
      : serial && !device ? `Device ${serial} is not registered`
      : device && !device.isActive ? `Device ${serial} is switched off`
      : null;
    if (err) rejected.push({ index, error: err });
    else good.push({ index, employeeId: emp!.id, at, direction: direction as 0 | 1 | null, deviceId: device?.id ?? null });
  });

  let accepted = 0, duplicates = 0;
  const touched = new Map<string, { from: Date; to: Date }>();
  const byEmp = new Map<string, Ok[]>();
  for (const g of good) byEmp.set(g.employeeId, [...(byEmp.get(g.employeeId) ?? []), g]);

  for (const [employeeId, list] of byEmp) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    const policy = await resolveTimePolicy(employeeId, list[0].at);
    const min = list[0].at, max = list[list.length - 1].at;
    const existing = await prisma.attendanceLog.findMany({
      where: { employeeId, timestamp: { gte: new Date(min.getTime() - DAY), lte: new Date(max.getTime() + DAY) } },
      select: { timestamp: true, direction: true },
    });
    const known = existing.map((e) => ({ t: e.timestamp.getTime(), day: localDateKey(e.timestamp, policy.tzOffset), direction: e.direction }));
    const rows: { timestamp: Date; direction: number; deviceId: string | null }[] = [];
    for (const p of list) {
      const t = p.at.getTime();
      if (known.some((k) => Math.abs(k.t - t) < 60_000 && (p.direction === null || k.direction === p.direction))) { duplicates++; continue; }
      const day = localDateKey(p.at, policy.tzOffset);
      // No direction from the device: the opposite of the day's previous
      // punch, so the first of the day is an IN.
      const prior = known.filter((k) => k.day === day && k.t < t).sort((a, b) => b.t - a.t)[0];
      const direction = p.direction ?? (prior ? (prior.direction === 0 ? 1 : 0) : 0);
      known.push({ t, day, direction });
      rows.push({ timestamp: p.at, direction, deviceId: p.deviceId });
    }
    if (rows.length === 0) continue;
    await prisma.attendanceLog.createMany({
      data: rows.map((r) => ({ tenantId, employeeId, timestamp: r.timestamp, direction: r.direction, deviceId: r.deviceId, source: r.deviceId ? "BIOMETRIC" as const : "API" as const, status: "VALID" as const })),
    });
    accepted += rows.length;
    const from = new Date(`${localDateKey(rows[0].timestamp, policy.tzOffset)}T00:00:00Z`);
    const to = new Date(`${localDateKey(rows[rows.length - 1].timestamp, policy.tzOffset)}T00:00:00Z`);
    touched.set(employeeId, { from, to });
  }

  for (const [employeeId, r] of touched) await reprocessRange(employeeId, r.from, r.to);
  const usedDevices = [...new Set(good.map((g) => g.deviceId).filter((x): x is string => !!x))];
  if (usedDevices.length) await prisma.attendanceDevice.updateMany({ where: { id: { in: usedDevices } }, data: { lastSeenAt: now } });
  return { accepted, duplicates, rejected, employees: touched.size };
}
