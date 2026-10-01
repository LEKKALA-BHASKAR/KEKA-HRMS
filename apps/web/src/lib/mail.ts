import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutboxTransport } from "@keka/services";
import { repoRoot } from "./paths";

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
    const eml = [
      `To: ${m.to}`, `From: Keka <no-reply@keka.local>`, `Subject: ${m.subject}`,
      `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", m.text,
    ].join("\r\n");
    await writeFile(path.join(MAIL_DIR, `${id}.eml`), eml, "utf8");
  },
};
