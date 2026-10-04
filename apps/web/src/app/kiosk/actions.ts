"use server";

import { cookies } from "next/headers";
import { prisma } from "@keka/db";
import { kioskByToken, unlockKiosk, kioskPunch, kioskDeviceKey } from "@keka/services";
import { throttled, clientIp } from "@/lib/throttle";
import type { ActionState } from "@/lib/forms";

/**
 * The web kiosk. No sign-in: the token in the address identifies the kiosk,
 * a cookie set by the kiosk PIN marks the device as unlocked, and each punch
 * carries the employee's number and personal PIN. Every call is rate-limited
 * per address and per kiosk.
 */

const WINDOW_MS = 10 * 60_000;
const BUSY = "Too many attempts just now. Please wait a few minutes.";
const cookieName = (kioskId: string) => `kiosk_${kioskId}`;

export async function unlockKioskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`kiosk-unlock|${ip}`, 10, WINDOW_MS) || throttled(`kiosk-unlock-t|${token.slice(0, 16)}`, 10, WINDOW_MS)) return { ok: false, message: BUSY };
  const res = await unlockKiosk(token, String(formData.get("pin") ?? ""));
  if (!res.ok) return res;
  const kiosk = (await kioskByToken(token))!;
  (await cookies()).set(cookieName(kiosk.id), kioskDeviceKey(kiosk), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/kiosk", maxAge: 60 * 60 * 24 * 365,
  });
  await prisma.auditLog.create({
    data: { tenantId: kiosk.tenantId, module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceKiosk", entityId: kiosk.id, summary: `Kiosk ${kiosk.name} unlocked on a device`, actorLabel: "Kiosk", ipAddress: ip },
  }).catch(() => undefined);
  return res;
}

export async function kioskPunchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`kiosk-punch|${ip}`, 120, WINDOW_MS) || throttled(`kiosk-punch-t|${token.slice(0, 16)}`, 300, WINDOW_MS)) return { ok: false, message: BUSY };
  const kiosk = await kioskByToken(token);
  if (!kiosk) return { ok: false, message: "This kiosk is switched off or its link has changed." };
  const unlocked = (await cookies()).get(cookieName(kiosk.id))?.value === kioskDeviceKey(kiosk);
  if (!unlocked) return { ok: false, message: "This device is locked. Ask an administrator to unlock it with the kiosk PIN." };
  const dir = String(formData.get("direction") ?? "");
  const res = await kioskPunch({
    token, employeeNumber: String(formData.get("employeeNumber") ?? ""), pin: String(formData.get("pin") ?? ""),
    direction: dir === "in" ? 0 : dir === "out" ? 1 : null, ipAddress: ip,
  });
  return { ok: res.ok, message: res.message };
}
