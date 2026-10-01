import { z } from "zod";

/**
 * Configuration the app cannot run without, checked once at start-up so a
 * missing secret fails the deploy rather than the first sign-in.
 */
const schema = z.object({
  DATABASE_URL: z.string().url().refine((v) => v.startsWith("postgres"), "must be a PostgreSQL URL"),
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters — generate one with `openssl rand -base64 48`"),
  APP_URL: z.string().url().optional(),
  STORAGE_DIR: z.string().optional(),
  MAIL_DIR: z.string().optional(),
});

export function checkEnv(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; problems: string[] } {
  const r = schema.safeParse(env);
  if (r.success) {
    if (env.NODE_ENV === "production" && /change.?me|dev|secret/i.test(env.AUTH_SECRET ?? "")) {
      return { ok: false, problems: ["AUTH_SECRET looks like a development placeholder"] };
    }
    return { ok: true };
  }
  return { ok: false, problems: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
