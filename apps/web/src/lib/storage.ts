import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@keka/db";
import { repoRoot } from "./paths";

/**
 * File storage. Bytes go to STORAGE_DIR on disk (default .storage/ at the
 * repository root) under a random key; the StoredFile row is the index, the
 * integrity hash and the access-control anchor. Nothing is ever served by
 * path — only by row id, through /files/[id], after a permission check.
 */
export const STORAGE_DIR = process.env.STORAGE_DIR ?? path.join(repoRoot(), ".storage");
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED = new Map([
  ["application/pdf", ".pdf"], ["image/png", ".png"], ["image/jpeg", ".jpg"], ["text/csv", ".csv"], ["text/plain", ".txt"],
]);

export async function saveFile(opts: {
  tenantId: string; filename: string; mimeType: string; data: Buffer;
  relatedType?: string; relatedId?: string; employeeId?: string | null; uploadedBy?: string | null;
}) {
  if (opts.data.length > MAX_UPLOAD_BYTES) throw new Error("Files are limited to 10 MB.");
  const sha256 = createHash("sha256").update(opts.data).digest("hex");
  const key = `${opts.tenantId}/${new Date().toISOString().slice(0, 7)}/${randomBytes(12).toString("hex")}`;
  await mkdir(path.join(STORAGE_DIR, path.dirname(key)), { recursive: true });
  await writeFile(path.join(STORAGE_DIR, key), opts.data);
  return prisma.storedFile.create({
    data: {
      tenantId: opts.tenantId, filename: opts.filename.replace(/[^\w.\- ]/g, "_").slice(0, 160), mimeType: opts.mimeType,
      sizeBytes: opts.data.length, sha256, storageKey: key,
      relatedType: opts.relatedType ?? null, relatedId: opts.relatedId ?? null, employeeId: opts.employeeId ?? null, uploadedBy: opts.uploadedBy ?? null,
    },
  });
}

export async function loadFile(storageKey: string, expectedSha: string): Promise<Buffer> {
  // Keys are generated, never user input, but refuse traversal regardless.
  if (storageKey.includes("..")) throw new Error("Invalid storage key");
  const data = await readFile(path.join(STORAGE_DIR, storageKey));
  if (createHash("sha256").update(data).digest("hex") !== expectedSha) throw new Error("Stored file failed its integrity check");
  return data;
}

/**
 * Validate an upload by its content, not its name: the first bytes must match
 * the claimed type. Returns the type to store, or a reason to refuse.
 */
export function sniffUpload(data: Buffer, claimed: string): { ok: true; mimeType: string } | { ok: false; reason: string } {
  const head = data.subarray(0, 8);
  const isPdf = head.subarray(0, 5).toString("latin1") === "%PDF-";
  const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const type = isPdf ? "application/pdf" : isPng ? "image/png" : isJpeg ? "image/jpeg" : null;
  if (!type) return { ok: false, reason: "Upload a PDF, PNG or JPEG." };
  if (claimed && ALLOWED.has(claimed) && claimed !== type) return { ok: false, reason: "The file's contents do not match its type." };
  return { ok: true, mimeType: type };
}
