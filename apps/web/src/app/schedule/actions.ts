"use server";

import { bookSlot } from "@keka/services";
import { throttled, clientIp } from "@/lib/throttle";
import type { ActionState } from "@/lib/forms";

/**
 * A candidate picks an interview time from their self-scheduling link. No
 * sign-in: the token is the only credential, checked afresh on every call
 * and rate-limited per address and per link.
 */
export async function bookSlotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const ip = (await clientIp()) ?? "unknown";
  if (throttled(`slot-book|${ip}`, 10, 10 * 60_000) || throttled(`slot-book-link|${token.slice(0, 16)}`, 6, 10 * 60_000)) {
    return { ok: false, message: "Too many attempts just now. Please wait a few minutes and try again." };
  }
  const slot = String(formData.get("slot") ?? "");
  if (!slot) return { ok: false, message: "Pick one of the times." };
  const r = await bookSlot(token, slot);
  return { ok: r.ok, message: r.message };
}
