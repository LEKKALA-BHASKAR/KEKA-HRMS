import "server-only";

/**
 * The one door to a language model. AI features are off unless the operator
 * sets ANTHROPIC_API_KEY — employee data only leaves the server by that
 * deliberate choice — and every caller degrades to an honest "AI is not set
 * up for this workspace" rather than inventing output.
 *
 * Callers send the least data the task needs (a meeting's notes, a goal's
 * text, a role's requirements) — never whole employee records.
 */

const API = "https://api.anthropic.com/v1/messages";

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const AI_UNAVAILABLE = "AI is not set up for this workspace. An administrator can enable it by configuring an Anthropic API key on the server.";

export type AiResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Plain text from a prompt. */
export async function aiText(opts: { system: string; prompt: string; maxTokens?: number }): Promise<AiResult<string>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: AI_UNAVAILABLE };
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "claude-opus-5-5",
        max_tokens: opts.maxTokens ?? 1200,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { ok: false, reason: `The AI service answered ${res.status}. Try again in a moment.` };
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    return text ? { ok: true, value: text } : { ok: false, reason: "The AI service returned nothing." };
  } catch {
    return { ok: false, reason: "The AI service could not be reached. Try again in a moment." };
  }
}

/**
 * Structured output: the model is asked for JSON only, and the reply is
 * parsed and checked by `validate` — a malformed answer is a failure, not
 * something to display.
 */
export async function aiJson<T>(opts: { system: string; prompt: string; maxTokens?: number; validate: (v: unknown) => T | null }): Promise<AiResult<T>> {
  const r = await aiText({ ...opts, system: `${opts.system}\n\nRespond with a single JSON value only — no prose, no code fences.` });
  if (!r.ok) return r;
  const raw = r.value.replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const v = opts.validate(JSON.parse(raw));
    return v === null ? { ok: false, reason: "The AI answer was not in the expected shape." } : { ok: true, value: v };
  } catch {
    return { ok: false, reason: "The AI answer was not valid JSON." };
  }
}

/**
 * Every AI feature goes through here: it caps how often one person can ask
 * (per feature, per hour) and records each call in the shared AiGeneration
 * log — the feature, the size of what was sent and whether it worked, never
 * the content itself.
 */
export const AI_HOURLY_LIMIT = 30;

export async function aiForViewer<T>(
  viewer: { tenantId: string; user: { id: string } },
  opts: { feature: string; subjectId?: string | null; inputChars: number },
  run: () => Promise<AiResult<T>>,
): Promise<AiResult<T>> {
  if (!aiEnabled()) return { ok: false, reason: AI_UNAVAILABLE };
  const { prisma } = await import("@keka/db");
  const recent = await prisma.aiGeneration.count({
    where: { tenantId: viewer.tenantId, userId: viewer.user.id, feature: opts.feature, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
  });
  if (recent >= AI_HOURLY_LIMIT) return { ok: false, reason: "You've used this AI assistant a lot in the last hour. Try again a little later." };
  const result = await run();
  await prisma.aiGeneration.create({
    data: { tenantId: viewer.tenantId, userId: viewer.user.id, feature: opts.feature, subjectId: opts.subjectId ?? null, inputChars: opts.inputChars, ok: result.ok },
  });
  return result;
}
