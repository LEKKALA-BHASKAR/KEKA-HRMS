import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutboxTransport } from "@keka/services";
import { prisma } from "@keka/db";
import { repoRoot } from "./paths";
import { loadFile } from "./storage";

/**
 * Mail transport. Development writes each message as an .eml file under
 * MAIL_DIR (default .mail/ at the repository root) so it can be opened in any
 * mail client; production should replace this with a provider transport.
 */
export const MAIL_DIR = process.env.MAIL_DIR ?? path.join(repoRoot(), ".mail");

export const fileTransport: OutboxTransport = {
  async send(m) {
    await mkdir(MAIL_DIR, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const head = [`To: ${m.to}`, `From: Keka <no-reply@keka.local>`, `Subject: ${m.subject}`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0"];
    const files = m.attachmentFileIds?.length ? await prisma.storedFile.findMany({ where: { id: { in: m.attachmentFileIds } } }) : [];
    let eml: string;
    if (files.length === 0) {
      eml = [...head, "Content-Type: text/plain; charset=utf-8", "", m.text].join("\r\n");
    } else {
      // multipart/mixed: the text, then each stored file base64-encoded.
      const boundary = `keka-${id}`;
      const parts = [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", m.text];
      for (const f of files) {
        const data = await loadFile(f.storageKey, f.sha256);
        parts.push(`--${boundary}`, `Content-Type: ${f.mimeType}; name="${f.filename}"`, "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${f.filename}"`, "", data.toString("base64").replace(/.{76}/g, "$&\r\n"));
      }
      parts.push(`--${boundary}--`, "");
      eml = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
    }
    await writeFile(path.join(MAIL_DIR, `${id}.eml`), eml, "utf8");
  },
};
