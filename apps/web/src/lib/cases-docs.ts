import { safeRevalidate, type ActionState } from "@/lib/forms";
import { sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import type { Viewer } from "@/lib/context";

/**
 * Small helpers shared by the case-management, employee-relations,
 * document, e-sign, letter and asset-operation actions and pages.
 */

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const optStr = (fd: FormData, k: string) => str(fd, k) || null;
export const bool = (fd: FormData, k: string) => ["on", "true", "1", "yes"].includes(str(fd, k).toLowerCase());
export function int(fd: FormData, k: string): number | null {
  const s = str(fd, k);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}
export function money(fd: FormData, k: string): number | null {
  const s = str(fd, k).replace(/[,₹\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
export function day(fd: FormData, k: string): Date | null {
  const s = str(fd, k);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const who = (v: Viewer) => v.employee?.displayName ?? v.user.email;
export const actorOf = (v: Viewer) => ({ tenantId: v.tenantId, userId: v.user.id, label: who(v) });

export const DENIED: ActionState = { ok: false, message: "You do not have permission to do that." };
export const no = (message: string): ActionState => ({ ok: false, message });

/** Turn a service result into an action state, revalidating on success. */
export function result(r: { ok: boolean; message: string }, paths: string[]): ActionState {
  if (r.ok) safeRevalidate(...paths);
  return { ok: r.ok, message: r.message };
}

/** One uploaded file from a form field, checked by its bytes. */
export async function readUpload(fd: FormData, key = "file"): Promise<{ name: string; type: string; data: Buffer } | { error: string } | null> {
  const f = fd.get(key);
  if (!f || typeof f !== "object" || !("arrayBuffer" in f) || (f as File).size === 0) return null;
  const file = f as File;
  if (file.size > MAX_UPLOAD_BYTES) return { error: `${file.name} is larger than 10 MB.` };
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok) return { error: `${file.name}: ${sniff.reason}` };
  return { name: file.name, type: sniff.mimeType, data };
}

/** Every uploaded file under one field name. */
export async function readUploads(fd: FormData, key: string, max: number): Promise<{ files: Array<{ name: string; type: string; data: Buffer }> } | { error: string }> {
  const raw = fd.getAll(key).filter((f): f is File => typeof f === "object" && !!f && "arrayBuffer" in f && (f as File).size > 0);
  if (raw.length > max) return { error: `Upload up to ${max} files at a time.` };
  const files = [];
  for (const file of raw) {
    if (file.size > MAX_UPLOAD_BYTES) return { error: `${file.name} is larger than 10 MB.` };
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok) return { error: `${file.name}: ${sniff.reason}` };
    files.push({ name: file.name, type: sniff.mimeType, data });
  }
  return { files };
}

/** A CSV cell, quoted when needed and protected against formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
export function csvResponse(name: string, body: string): Response {
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
