import "server-only";
import { revalidatePath } from "next/cache";
import { z, type ZodTypeAny } from "zod";
import { prisma, type AuditModule, type AuditAction } from "@keka/db";
import type { Viewer } from "./context";

/**
 * Server-action plumbing shared by every CRUD form.
 *
 * The shape is deliberately uniform: parse with zod, return field-level errors
 * rather than throwing, and audit every write. A form that throws gives the
 * user an error boundary; a form that returns errors lets them fix the field.
 */

export interface ActionState {
  ok?: boolean;
  message?: string;
  /** Keyed by field name, so inputs can render their own error. */
  errors?: Record<string, string>;
  /** Echoed back so the form can repopulate after a failed submit. */
  values?: Record<string, string>;
}

export const EMPTY_STATE: ActionState = {};

/** Collect a FormData into a plain object, trimming strings. */
export function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value.trim();
  }
  return out;
}

/** Multi-value fields (checkbox groups, multi-selects). */
export function formList(formData: FormData, key: string): string[] {
  return formData.getAll(key).map(String).filter((v) => v.length > 0);
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Parse a FormData against a schema. On failure returns an ActionState the
 * form can render directly.
 */
export function parseForm<T extends ZodTypeAny>(
  schema: T,
  formData: FormData,
): { data: z.infer<T>; state?: never } | { data?: never; state: ActionState } {
  const values = formValues(formData);
  const result = schema.safeParse(values);
  if (!result.success) {
    return {
      state: {
        ok: false,
        message: "Please correct the highlighted fields.",
        errors: fieldErrors(result.error),
        values,
      },
    };
  }
  return { data: result.data };
}

/** Turn a thrown error into an ActionState instead of an error boundary. */
export function toErrorState(err: unknown, values?: Record<string, string>): ActionState {
  const message = err instanceof Error ? err.message : String(err);
  // Prisma unique-constraint violations are a user error, not a crash.
  if (message.includes("Unique constraint failed")) {
    const field = /\(`?(\w+)`?\)/.exec(message)?.[1];
    return {
      ok: false,
      message: field
        ? `That ${field.replace(/_/g, " ")} is already in use.`
        : "That value is already in use.",
      values,
    };
  }
  if (message.includes("Foreign key constraint")) {
    return { ok: false, message: "A referenced record no longer exists. Reload and try again.", values };
  }
  return { ok: false, message, values };
}

/**
 * revalidatePath throws outside a request context. Actions are also invoked
 * from scripts and tests, where there is nothing to revalidate — so swallow
 * that specific case rather than making every action untestable.
 */
export function safeRevalidate(...paths: string[]): void {
  for (const p of paths) {
    try {
      revalidatePath(p);
    } catch {
      // No request store: running outside Next. Nothing to invalidate.
    }
  }
}

/** Standard success result for a write action. */
export function actionDone(paths: string[], message: string): ActionState {
  safeRevalidate(...paths);
  return { ok: true, message };
}

export async function writeAudit(
  viewer: Viewer,
  opts: {
    module: AuditModule;
    action: AuditAction;
    entityType: string;
    entityId?: string | null;
    summary: string;
    oldValue?: unknown;
    newValue?: unknown;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      tenantId: viewer.tenantId,
      module: opts.module,
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId ?? null,
      summary: opts.summary,
      oldValue: opts.oldValue === undefined ? undefined : (opts.oldValue as never),
      newValue: opts.newValue === undefined ? undefined : (opts.newValue as never),
      actorId: viewer.user.id,
      actorLabel: viewer.user.email,
    },
  });
}

// --- Reusable zod pieces ----------------------------------------------------

/** A required, trimmed, length-bounded name. */
export const zName = (max = 120) =>
  z.string().min(1, "Required").max(max, `Keep it under ${max} characters`);

export const zOptional = (max = 500) =>
  z.string().max(max).optional().transform((v) => (v && v.length > 0 ? v : null));

/** HTML number inputs arrive as strings; empty means "not provided". */
export const zNumber = (opts: { min?: number; max?: number; required?: boolean } = {}) =>
  z.string().optional().transform((v, ctx) => {
    if (!v || v.length === 0) {
      if (opts.required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required" });
        return 0;
      }
      return null;
    }
    const n = Number(v);
    if (Number.isNaN(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a number" });
      return 0;
    }
    if (opts.min !== undefined && n < opts.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must be at least ${opts.min}` });
    }
    if (opts.max !== undefined && n > opts.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must be at most ${opts.max}` });
    }
    return n;
  });

export const zRequiredNumber = (opts: { min?: number; max?: number } = {}) =>
  zNumber({ ...opts, required: true }).transform((v) => v as number);

/** Dates arrive as yyyy-mm-dd; store them as UTC midnight so no timezone drift. */
export const zDate = (opts: { required?: boolean } = {}) =>
  z.string().optional().transform((v, ctx) => {
    if (!v || v.length === 0) {
      if (opts.required) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required" });
        return new Date(0);
      }
      return null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use a valid date" });
      return new Date(0);
    }
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  });

export const zRequiredDate = () => zDate({ required: true }).transform((v) => v as Date);

/** An unchecked checkbox is absent from FormData entirely. */
export const zBool = () =>
  z.string().optional().transform((v) => v === "on" || v === "true");

export const zId = () => z.string().min(1, "Required");
export const zOptionalId = () =>
  z.string().optional().transform((v) => (v && v.length > 0 ? v : null));

export const zEmail = (opts: { required?: boolean } = {}) =>
  z.string().optional().transform((v, ctx) => {
    if (!v || v.length === 0) {
      if (opts.required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required" });
      return opts.required ? "" : null;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid email address" });
    }
    return v.toLowerCase();
  });

/** Indian PAN: five letters, four digits, one letter. */
/** A required email, typed as a plain string rather than string | null. */
export const zRequiredEmail = () =>
  zEmail({ required: true }).transform((v) => v as string);

export const zPan = () =>
  z.string().optional().transform((v, ctx) => {
    if (!v || v.length === 0) return null;
    const up = v.toUpperCase();
    if (up === "PANNOTAVBL") return up;
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(up)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PAN must be 5 letters, 4 digits, 1 letter" });
    }
    return up;
  });

export const zIfsc = () =>
  z.string().optional().transform((v, ctx) => {
    if (!v || v.length === 0) return null;
    const up = v.toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(up)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "IFSC must be 4 letters, 0, then 6 characters" });
    }
    return up;
  });

export { z };
