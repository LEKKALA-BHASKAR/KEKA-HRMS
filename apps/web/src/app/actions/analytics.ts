"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  redactQuestion, namesSomeone, loadRiskInputs, scoreAll, snapshotRisk, utcDay, RISK_FACTORS, monthStartUtc,
} from "@keka/services";
import { aiForViewer, aiJson, aiText, aiEnabled, AI_UNAVAILABLE } from "@/lib/ai";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone, type ActionState } from "@/lib/forms";
import { scopedEmployeeWhere, scopedEmployeeIds } from "@/lib/scope";
import { computedSummary, type Digest } from "@/lib/analytics/data";
import {
  digestFor, payloadHash, SYSTEM, summaryPrompt, askPrompt, validateSummary, summaryText, grounded, CHIPS, BOARDS,
  type Board, type SummaryAnswer,
} from "@/lib/analytics/storyboard";

const P = PERMISSIONS;
const DAY = 86_400_000;
const isBoard = (b: unknown): b is Board => b === "attrition" || b === "headcount";
const WIDGETS = ["department", "tenure", "exit-reason", "location", "performance", "since-raise", "worker", "gender"] as const;
const DIM_NAME: Record<string, string> = { department: "department", tenure: "tenure band", "exit-reason": "exit reason", location: "location", performance: "performance band", "since-raise": "raise gap", worker: "worker type", gender: "gender" };

export interface InsightView {
  id: string;
  kind: "SUMMARY" | "PROMPT" | "RISK_EXPLAIN";
  prompt: string | null;
  answer: SummaryAnswer | { text: string };
  payload: unknown;
  rating: number | null;
  createdAt: string;
  cached?: boolean;
}
export type AiOutcome = { ok: true; insight: InsightView } | { ok: false; reason: string; computed?: string[] };

const toView = (r: { id: string; kind: string; prompt: string | null; answer: unknown; payload: unknown; rating: number | null; createdAt: Date }, cached = false): InsightView => ({
  id: r.id, kind: r.kind as InsightView["kind"], prompt: r.prompt, answer: r.answer as InsightView["answer"], payload: r.payload,
  rating: r.rating, createdAt: r.createdAt.toISOString(), cached,
});

async function cachedInsight(viewer: Viewer, hash: string) {
  return prisma.analyticsInsight.findFirst({
    where: { tenantId: viewer.tenantId, userId: viewer.user.id, payloadHash: hash, createdAt: { gte: new Date(Date.now() - DAY) } },
    orderBy: { createdAt: "desc" },
  });
}

async function storeInsight(viewer: Viewer, data: { board: string; widget?: string | null; kind: "SUMMARY" | "PROMPT" | "RISK_EXPLAIN"; filters: string; prompt?: string | null; payload: unknown; hash: string; answer: unknown }) {
  const row = await prisma.analyticsInsight.create({
    data: {
      tenantId: viewer.tenantId, userId: viewer.user.id, board: data.board, widget: data.widget ?? null, kind: data.kind,
      filters: { qs: data.filters }, prompt: data.prompt ?? null, payload: data.payload as never, payloadHash: data.hash,
      answer: data.answer as never, model: process.env.AI_MODEL ?? "claude-opus-5-5",
    },
  });
  await writeAudit(viewer, {
    module: "ANALYTICS", action: "CREATE", entityType: "AnalyticsInsight", entityId: row.id,
    summary: `AI ${data.kind === "SUMMARY" ? "summary" : data.kind === "RISK_EXPLAIN" ? "risk explanation" : "answer"} on the ${data.board} storyboard${data.widget ? ` (${data.widget})` : ""}`,
  });
  return row;
}

/** "Summarise using AI" on a storyboard. */
export async function generateSummaryAction(input: { board: string; qs: string; regenerate?: boolean }): Promise<AiOutcome> {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  if (!isBoard(input.board) || typeof input.qs !== "string" || input.qs.length > 2000) return { ok: false, reason: "That storyboard does not exist." };
  const { digest, f } = await digestFor(viewer, input.board, input.qs);
  const computed = computedSummary(digest);
  const hash = payloadHash({ board: input.board, kind: "SUMMARY", payload: digest });
  if (!input.regenerate) {
    const hit = await cachedInsight(viewer, hash);
    if (hit) return { ok: true, insight: toView(hit, true) };
  }
  if (!aiEnabled()) return { ok: false, reason: AI_UNAVAILABLE, computed };
  const prompt = summaryPrompt(digest);
  const call = (extra = "") => aiForViewer(viewer, { feature: "ANALYTICS_SUMMARY", subjectId: input.board, inputChars: prompt.length + extra.length },
    () => aiJson({ system: SYSTEM, prompt: prompt + extra, maxTokens: 900, validate: validateSummary }));
  let r = await call();
  if (r.ok && !grounded(summaryText(r.value), digest)) {
    r = await call("\n\nYour previous answer cited figures that are not in the data. Use only figures that appear in the JSON.");
    if (r.ok && !grounded(summaryText(r.value), digest)) return { ok: false, reason: "The answer cited figures not in the data, so it was not shown. Try again.", computed };
  }
  if (!r.ok) return { ok: false, reason: r.reason, computed };
  const row = await storeInsight(viewer, { board: input.board, kind: "SUMMARY", filters: new URLSearchParams(input.qs).toString(), payload: digest, hash, answer: r.value });
  void f;
  return { ok: true, insight: toView(row) };
}

/** A suggestion chip or a typed question in the Ask AI panel. */
export async function askAnalyticsAction(input: { board: string; widget: string; qs: string; chip?: string; question?: string; regenerate?: boolean }): Promise<AiOutcome> {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  if (!isBoard(input.board) || !(WIDGETS as readonly string[]).includes(input.widget) || typeof input.qs !== "string" || input.qs.length > 2000) {
    return { ok: false, reason: "That chart does not exist." };
  }
  const dim = DIM_NAME[input.widget];
  let question = input.chip && CHIPS[input.chip] ? CHIPS[input.chip](dim) : (input.question ?? "").trim();
  if (!question) return { ok: false, reason: "Ask a question first." };
  if (question.length > 500) return { ok: false, reason: "Keep the question under 500 characters." };
  if (!input.chip) {
    const names = (await prisma.employee.findMany({ where: scopedEmployeeWhere(viewer, P.ANALYTICS_VIEW), select: { displayName: true, firstName: true, lastName: true } }))
      .map((e) => e.displayName ?? `${e.firstName} ${e.lastName}`);
    if (namesSomeone(question, names)) return { ok: false, reason: "Ask about groups, not individuals — questions naming a person are not sent to the AI." };
    question = redactQuestion(question);
  }
  const { digest } = await digestFor(viewer, input.board, input.qs, input.widget);
  const hash = payloadHash({ board: input.board, widget: input.widget, kind: "PROMPT", prompt: question, payload: digest });
  if (!input.regenerate) {
    const hit = await cachedInsight(viewer, hash);
    if (hit) return { ok: true, insight: toView(hit, true) };
  }
  if (!aiEnabled()) {
    return { ok: false, reason: AI_UNAVAILABLE, computed: input.chip === "summary" ? computedSummary(digest) : undefined };
  }
  const recent = await prisma.analyticsInsight.findMany({
    where: { tenantId: viewer.tenantId, userId: viewer.user.id, board: input.board, widget: input.widget, kind: "PROMPT", createdAt: { gte: new Date(Date.now() - DAY) } },
    orderBy: { createdAt: "desc" }, take: 4,
  });
  const history = recent.reverse().map((x) => ({ q: x.prompt ?? "", a: (x.answer as { text?: string }).text ?? "" }));
  const prompt = askPrompt(digest, question, history);
  const call = (extra = "") => aiForViewer(viewer, { feature: "ANALYTICS_ASK", subjectId: `${input.board}:${input.widget}`, inputChars: prompt.length + extra.length },
    () => aiText({ system: SYSTEM, prompt: prompt + extra, maxTokens: 700 }));
  let r = await call();
  if (r.ok && !grounded(r.value, digest)) {
    r = await call("\n\nYour previous answer cited figures that are not in the data. Use only figures that appear in the JSON.");
    if (r.ok && !grounded(r.value, digest)) return { ok: false, reason: "The answer cited figures not in the data, so it was not shown. Try again." };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  const row = await storeInsight(viewer, { board: input.board, widget: input.widget, kind: "PROMPT", filters: input.qs, prompt: question, payload: digest, hash, answer: { text: r.value.slice(0, 4000) } });
  return { ok: true, insight: toView(row) };
}

/** 👍 / 👎 on an answer — only on your own. */
export async function rateInsightAction(input: { id: string; rating: number }): Promise<{ ok: boolean }> {
  const viewer = await requireViewer();
  if (input.rating !== 1 && input.rating !== -1) return { ok: false };
  const res = await prisma.analyticsInsight.updateMany({ where: { id: String(input.id), tenantId: viewer.tenantId, userId: viewer.user.id }, data: { rating: input.rating } });
  return { ok: res.count === 1 };
}

// ---------------------------------------------------------------------------
//  Flight risk
// ---------------------------------------------------------------------------

/** "Explain this cohort": the risk distribution and drivers only — never a person. */
export async function explainRiskAction(): Promise<AiOutcome> {
  const viewer = await requireAuth(P.ATTRITION_RISK_VIEW);
  const today = utcDay(new Date());
  const ids = await scopedEmployeeIds(viewer, P.ATTRITION_RISK_VIEW);
  const inputs = await loadRiskInputs(viewer.tenantId);
  const scored = scoreAll(inputs, today, ids ? new Set(ids) : undefined);
  const depts = await prisma.employee.findMany({ where: { id: { in: scored.map((s) => s.employeeId) } }, select: { id: true, department: { select: { name: true } } } });
  const deptOf = new Map(depts.map((d) => [d.id, d.department?.name ?? "Unassigned"]));
  const flagged = scored.filter((s) => s.band !== "LOW");
  const byDept = new Map<string, { n: number; high: number; medium: number }>();
  for (const s of scored) {
    const k = deptOf.get(s.employeeId) ?? "Unassigned";
    const c = byDept.get(k) ?? { n: 0, high: 0, medium: 0 };
    c.n++; if (s.band === "HIGH") c.high++; if (s.band === "MEDIUM") c.medium++;
    byDept.set(k, c);
  }
  const rows = [...byDept.entries()].filter(([, c]) => c.n >= 3).map(([label, c]) => ({ label, high: c.high, medium: c.medium }));
  const other = [...byDept.entries()].filter(([, c]) => c.n < 3).reduce((a, [, c]) => ({ high: a.high + c.high, medium: a.medium + c.medium }), { high: 0, medium: 0 });
  if (other.high || other.medium) rows.push({ label: "Other", ...other });
  const digest: Partial<Digest> & { board: "risk" } = {
    board: "risk",
    risk: {
      high: scored.filter((s) => s.band === "HIGH").length, medium: scored.filter((s) => s.band === "MEDIUM").length, low: scored.filter((s) => s.band === "LOW").length,
      byDepartment: rows,
      topDrivers: RISK_FACTORS.map((f) => ({ factor: f.label, sharePct: flagged.length ? Math.round((flagged.filter((s) => (s.factors.find((x) => x.key === f.key)?.points ?? 0) > 0).length / flagged.length) * 1000) / 10 : 0 }))
        .filter((x) => x.sharePct > 0).sort((a, b) => b.sharePct - a.sharePct).slice(0, 8),
    },
    note: "Counts of employees by risk band from a deterministic, explainable model (risk-v1). Groups under 3 people are merged into 'Other'. No individual records are included.",
  };
  const hash = payloadHash({ board: "risk", kind: "RISK_EXPLAIN", payload: digest });
  const hit = await cachedInsight(viewer, hash);
  if (hit) return { ok: true, insight: toView(hit, true) };
  if (!aiEnabled()) return { ok: false, reason: AI_UNAVAILABLE };
  const prompt = `Explain what is driving attrition risk in this organisation and suggest 3 practical, group-level actions for HR, in at most 8 bullet points starting with "- ".\n\nData:\n${JSON.stringify(digest)}`;
  const r = await aiForViewer(viewer, { feature: "ANALYTICS_RISK", subjectId: "risk", inputChars: prompt.length }, () => aiText({ system: SYSTEM, prompt, maxTokens: 700 }));
  if (!r.ok) return { ok: false, reason: r.reason };
  if (!grounded(r.value, digest)) return { ok: false, reason: "The answer cited figures not in the data, so it was not shown. Try again." };
  const row = await storeInsight(viewer, { board: "risk", kind: "RISK_EXPLAIN", filters: "", payload: digest, hash, answer: { text: r.value.slice(0, 4000) } });
  return { ok: true, insight: toView(row) };
}

/** Recompute this month's risk snapshot now. */
export async function recomputeRiskAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ATTRITION_RISK_VIEW);
  const today = utcDay(new Date());
  const asOf = monthStartUtc(today.getUTCFullYear(), today.getUTCMonth() + 1);
  const n = await snapshotRisk(viewer.tenantId, asOf);
  await writeAudit(viewer, { module: "ANALYTICS", action: "UPDATE", entityType: "AttritionRiskScore", summary: `Recomputed the ${asOf.toISOString().slice(0, 7)} attrition-risk snapshot (${n} employees)` });
  return actionDone(["/storyboards/risk"], `Scores recomputed for ${n} people.`);
}

// ---------------------------------------------------------------------------
//  Comments and sharing
// ---------------------------------------------------------------------------

/** Who may comment on or see a board: analytics viewers, and anyone it was shared with. */
async function mayUseBoard(viewer: Viewer, board: Board): Promise<boolean> {
  if (can(viewer, P.ANALYTICS_VIEW)) return true;
  return (await prisma.storyboardShare.count({ where: { tenantId: viewer.tenantId, userId: viewer.user.id, board } })) > 0;
}

const commentSchema = z.object({
  board: z.enum(["attrition", "headcount"]),
  widget: z.enum(WIDGETS),
  body: z.string().trim().min(1, "Write something first").max(1000, "Keep it under 1,000 characters"),
});

export async function addAnalyticsCommentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(commentSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await mayUseBoard(viewer, d.board))) return { ok: false, message: "You don't have access to this storyboard." };
  const c = await prisma.analyticsComment.create({ data: { tenantId: viewer.tenantId, board: d.board, widget: d.widget, authorId: viewer.user.id, body: d.body } });
  await writeAudit(viewer, { module: "ANALYTICS", action: "CREATE", entityType: "AnalyticsComment", entityId: c.id, summary: `Commented on ${d.board} › ${d.widget}` });
  return actionDone([`/storyboards/${d.board}`, `/storyboards/${d.board}/${d.widget}`], "Comment added.");
}

export async function deleteAnalyticsCommentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("commentId") ?? "");
  const c = await prisma.analyticsComment.findFirst({ where: { id, tenantId: viewer.tenantId, deletedAt: null } });
  if (!c || c.authorId !== viewer.user.id) return { ok: false, message: "You can only delete your own comments." };
  await prisma.analyticsComment.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
  await writeAudit(viewer, { module: "ANALYTICS", action: "DELETE", entityType: "AnalyticsComment", entityId: c.id, summary: `Deleted a comment on ${c.board} › ${c.widget}` });
  return actionDone([`/storyboards/${c.board}`, `/storyboards/${c.board}/${c.widget}`], "Comment deleted.");
}

const shareSchema = z.object({
  board: z.enum(["attrition", "headcount"]),
  employeeId: z.string().min(1, "Choose someone to share with"),
  qs: z.string().max(2000).optional(),
  insightId: z.string().max(40).optional(),
});

export async function shareStoryboardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ANALYTICS_VIEW);
  const parsed = parseForm(shareSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const to = await prisma.employee.findFirst({
    where: { id: d.employeeId, tenantId: viewer.tenantId, status: { notIn: ["EXITED", "PREBOARDING"] } },
    select: { id: true, userId: true, displayName: true, firstName: true, lastName: true },
  });
  if (!to || !to.userId) return { ok: false, message: "That person can't sign in, so the storyboard can't be shared with them.", errors: { employeeId: "No login" } };
  if (to.userId === viewer.user.id) return { ok: false, message: "You already own this storyboard.", errors: { employeeId: "That's you" } };
  // Only the period-independent filters are shared; ids are re-checked by the recipient's page against the owner's scope.
  const qs = new URLSearchParams(d.qs ?? "");
  const keep = new URLSearchParams();
  for (const k of ["le", "bu"]) { const v = qs.get(k); if (v && /^[\w,-]{1,400}$/.test(v)) keep.set(k, v); }
  let insightId: string | null = null;
  if (d.insightId) {
    const ins = await prisma.analyticsInsight.findFirst({ where: { id: d.insightId, tenantId: viewer.tenantId, userId: viewer.user.id, board: d.board } });
    insightId = ins?.id ?? null;
  }
  const share = await prisma.storyboardShare.upsert({
    where: { tenantId_board_ownerId_userId: { tenantId: viewer.tenantId, board: d.board, ownerId: viewer.user.id, userId: to.userId } },
    create: { tenantId: viewer.tenantId, board: d.board, ownerId: viewer.user.id, userId: to.userId, filters: { qs: keep.toString() }, insightId },
    update: { filters: { qs: keep.toString() }, ...(insightId ? { insightId } : {}) },
  });
  const who = viewer.employee?.displayName ?? viewer.user.email;
  await prisma.notification.create({
    data: {
      tenantId: viewer.tenantId, userId: to.userId, kind: "ANALYTICS",
      title: `${who} shared the ${BOARDS[d.board].toLowerCase()} with you`,
      body: insightId ? "Includes an AI summary." : null,
      link: `/storyboards/${d.board}?share=${share.id}`,
    },
  });
  const name = to.displayName ?? `${to.firstName} ${to.lastName}`;
  await writeAudit(viewer, { module: "ANALYTICS", action: "CREATE", entityType: "StoryboardShare", entityId: share.id, summary: `Shared the ${d.board} storyboard with ${name}` });
  return actionDone([`/storyboards/${d.board}`], `Shared with ${name}.`);
}

export async function removeShareAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("shareId") ?? "");
  const share = await prisma.storyboardShare.findFirst({ where: { id, tenantId: viewer.tenantId, ownerId: viewer.user.id } });
  if (!share) return { ok: false, message: "Only the owner can remove someone from a storyboard." };
  await prisma.storyboardShare.delete({ where: { id: share.id } });
  await writeAudit(viewer, { module: "ANALYTICS", action: "DELETE", entityType: "StoryboardShare", entityId: share.id, summary: `Stopped sharing the ${share.board} storyboard` });
  return actionDone([`/storyboards/${share.board}`, "/storyboards/shared"], "Removed.");
}

// ---------------------------------------------------------------------------
//  Exit reasons (the master behind "why people leave")
// ---------------------------------------------------------------------------

const reasonSchema = z.object({
  id: z.string().max(40).optional(),
  name: z.string().trim().min(2, "Name the reason").max(60, "Keep it under 60 characters"),
  kind: z.enum(["VOLUNTARY", "INVOLUNTARY", "OTHER"]),
});

export async function saveExitReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const parsed = parseForm(reasonSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const clash = await prisma.exitReason.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: d.name, mode: "insensitive" }, ...(d.id ? { NOT: { id: d.id } } : {}) } });
  if (clash) return { ok: false, message: "A reason with that name already exists.", errors: { name: "Already exists" } };
  if (d.id) {
    const r = await prisma.exitReason.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
    if (!r) return { ok: false, message: "That reason no longer exists." };
    await prisma.exitReason.update({ where: { id: r.id }, data: { name: d.name, kind: d.kind } });
    await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "ExitReason", entityId: r.id, summary: `Renamed exit reason to ${d.name}`, oldValue: { name: r.name, kind: r.kind }, newValue: d });
    return actionDone(["/exits"], "Reason saved.");
  }
  const order = await prisma.exitReason.count({ where: { tenantId: viewer.tenantId } });
  const r = await prisma.exitReason.create({ data: { tenantId: viewer.tenantId, name: d.name, kind: d.kind, displayOrder: order } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "ExitReason", entityId: r.id, summary: `Added exit reason ${d.name}` });
  return actionDone(["/exits"], "Reason added.");
}

export async function toggleExitReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EXIT_MANAGE);
  const r = await prisma.exitReason.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "That reason no longer exists." };
  await prisma.exitReason.update({ where: { id: r.id }, data: { isActive: !r.isActive } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "ExitReason", entityId: r.id, summary: `${r.isActive ? "Retired" : "Restored"} exit reason ${r.name}` });
  return actionDone(["/exits"], r.isActive ? "Reason retired; past exits keep it." : "Reason restored.");
}
