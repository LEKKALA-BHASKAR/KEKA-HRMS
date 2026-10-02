import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ungroundedNumbers, type PopEmployee, type Window } from "@keka/services";
import { can, viewerForUser, type Viewer } from "../context";
import { parseFilters, windowOf, employeeWhere, filterOptions, filterLabels, filterQuery, type AnalyticsFilters, type FilterOptions } from "./filters";
import { population, buildDigest, type Digest } from "./data";

/**
 * A storyboard's data context. For one's own board it is the viewer's scope;
 * for a board someone shared, it is the owner's scope narrowed to the filters
 * they shared — aggregates only, no people.
 */

export type Board = "attrition" | "headcount";
export const BOARDS: Record<Board, string> = { attrition: "Attrition storyboard", headcount: "Headcount storyboard" };

type SP = Record<string, string | string[] | undefined>;

export interface BoardContext {
  viewer: Viewer;
  /** Whose scope the numbers come from. */
  scope: Viewer;
  share: { id: string; ownerName: string; insightId: string | null } | null;
  f: AnalyticsFilters;
  w: Window;
  pop: PopEmployee[];
  opts: FilterOptions;
  /** May see people (drill-in tables, raw data) and use AI: only on one's own board. */
  own: boolean;
}

export async function boardContext(viewer: Viewer, sp: SP, board: Board): Promise<BoardContext | null> {
  const shareId = typeof sp.share === "string" ? sp.share : null;
  if (shareId) {
    const share = await prisma.storyboardShare.findFirst({ where: { id: shareId, tenantId: viewer.tenantId, userId: viewer.user.id, board } });
    if (!share) return null;
    const owner = await viewerForUser(share.ownerId, viewer.tenantId);
    if (!owner || !can(owner, PERMISSIONS.ANALYTICS_VIEW)) return null;
    // The owner's filters are fixed; the recipient may only change the period.
    const saved = new URLSearchParams(typeof share.filters === "object" && share.filters && "qs" in share.filters ? String((share.filters as { qs?: string }).qs ?? "") : "");
    const merged: SP = Object.fromEntries(saved.entries());
    if (typeof sp.range === "string") merged.range = sp.range;
    const f = parseFilters(merged, "3m");
    const [pop, opts] = await Promise.all([population(employeeWhere(owner, f)), filterOptions(viewer.tenantId)]);
    return {
      viewer, scope: owner, f, w: windowOf(f), pop, opts, own: false,
      share: { id: share.id, ownerName: owner.employee?.displayName ?? owner.user.email, insightId: share.insightId },
    };
  }
  if (!can(viewer, PERMISSIONS.ANALYTICS_VIEW)) return null;
  const f = parseFilters(sp, "3m");
  const [pop, opts] = await Promise.all([population(employeeWhere(viewer, { ...f, dims: { ...f.dims, dept: [], loc: [], wt: [] } })), filterOptions(viewer.tenantId)]);
  return { viewer, scope: viewer, f, w: windowOf(f), pop, opts, own: true, share: null };
}

/** The digest for a board or widget, from the viewer's own scope and the URL's filters. */
export async function digestFor(viewer: Viewer, board: Board, qs: string, widget?: string): Promise<{ digest: Digest; f: AnalyticsFilters }> {
  const sp = Object.fromEntries(new URLSearchParams(qs).entries());
  const f = parseFilters(sp, "3m");
  const w = windowOf(f);
  const [pop, opts] = await Promise.all([population(employeeWhere(viewer, f)), filterOptions(viewer.tenantId)]);
  return { digest: buildDigest(board, pop, w, filterLabels(f, opts), widget), f };
}

export const normalisedQs = (f: AnalyticsFilters) => filterQuery(f);

export function payloadHash(parts: { board: string; widget?: string | null; kind: string; prompt?: string | null; payload: unknown }): string {
  return createHash("sha256").update(JSON.stringify([parts.board, parts.widget ?? "", parts.kind, parts.prompt ?? "", parts.payload])).digest("hex");
}

// ---------------------------------------------------------------------------
//  Prompts
// ---------------------------------------------------------------------------

export const SYSTEM = [
  "You are an HR analytics assistant inside an HRMS, writing for an HR leader in India.",
  "You receive aggregated workforce statistics as JSON. Use only figures that appear in the JSON; never invent, estimate or derive new numbers.",
  "Never speculate about individuals. Describe any pattern by gender or age neutrally, and never recommend treating people differently because of gender, age or another protected characteristic.",
  "If there are fewer than 5 leavers in the period, say the data is too thin to draw conclusions.",
  "Plain, specific British/Indian English. No emojis, no markdown headings.",
].join(" ");

export const LINKS = { training: "/training", meetings: "/meetings", performance: "/performance", compensation: "/payroll/structures", risk: "/storyboards/risk", none: "" } as const;
export type LinkKey = keyof typeof LINKS;

export interface SummaryAnswer {
  headline: string;
  findings: Array<{ text: string; metric?: { label: string; value: string; direction: "up" | "down" | "flat" } }>;
  recommendations: Array<{ text: string; link: LinkKey }>;
}

export function validateSummary(v: unknown): SummaryAnswer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.headline !== "string" || o.headline.length > 240 || !Array.isArray(o.findings) || !Array.isArray(o.recommendations)) return null;
  if (o.findings.length < 1 || o.findings.length > 6 || o.recommendations.length < 1 || o.recommendations.length > 4) return null;
  const findings: SummaryAnswer["findings"] = [];
  for (const x of o.findings) {
    if (!x || typeof x !== "object" || typeof (x as { text?: unknown }).text !== "string") return null;
    const fx = x as { text: string; metric?: { label?: unknown; value?: unknown; direction?: unknown } };
    if (fx.text.length > 500) return null;
    const m = fx.metric;
    const metric = m && typeof m.label === "string" && (typeof m.value === "string" || typeof m.value === "number") && ["up", "down", "flat"].includes(String(m.direction))
      ? { label: m.label.slice(0, 80), value: String(m.value).slice(0, 24), direction: m.direction as "up" | "down" | "flat" } : undefined;
    findings.push({ text: fx.text, metric });
  }
  const recommendations: SummaryAnswer["recommendations"] = [];
  for (const x of o.recommendations) {
    if (!x || typeof x !== "object" || typeof (x as { text?: unknown }).text !== "string") return null;
    const link = String((x as { link?: unknown }).link ?? "none");
    recommendations.push({ text: (x as { text: string }).text.slice(0, 400), link: (link in LINKS ? link : "none") as LinkKey });
  }
  return { headline: o.headline, findings, recommendations };
}

export function summaryPrompt(d: Digest): string {
  return [
    `Summarise this ${d.board === "headcount" ? "headcount" : "attrition"} storyboard for the period ${d.period.from} to ${d.period.to} (compared with ${d.previous.from} to ${d.previous.to}).`,
    "Return JSON: {\"headline\": string (one sentence), \"findings\": [{\"text\": string, \"metric\": {\"label\": string, \"value\": string, \"direction\": \"up\"|\"down\"|\"flat\"}}] (3 to 5), \"recommendations\": [{\"text\": string, \"link\": \"training\"|\"meetings\"|\"performance\"|\"compensation\"|\"risk\"|\"none\"}] (2 to 3)}.",
    "Each finding names the department, tenure band, reason or other group it is about, with its figure from the data.",
    `Data:\n${JSON.stringify(d)}`,
  ].join("\n\n");
}

export const CHIPS: Record<string, (dim: string) => string> = {
  summary: () => "Generate summary",
  factors: (dim) => `Analyze how attrition varies by other factors within the ${dim}`,
  trends: (dim) => `Identify notable trends in attrition in the ${dim} over a specific time period`,
  strategies: (dim) => `Explore strategies to reduce attrition in a particular ${dim}`,
};

export function askPrompt(d: Digest, question: string, history: Array<{ q: string; a: string }>): string {
  return [
    `Answer the question about this ${d.board} data${d.widget ? ` (the "${d.widget}" chart)` : ""} in at most 8 short bullet points starting with "- ".`,
    history.length ? `Earlier in this conversation:\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n")}` : "",
    `Question: ${question}`,
    `Data:\n${JSON.stringify(d)}`,
  ].filter(Boolean).join("\n\n");
}

/** Every number the model wrote must be one it was given. */
export function summaryText(a: SummaryAnswer): string {
  return [a.headline, ...a.findings.map((f) => `${f.text} ${f.metric?.value ?? ""}`), ...a.recommendations.map((r) => r.text)].join("\n");
}
export const grounded = (text: string, payload: unknown) => ungroundedNumbers(text, payload).length === 0;
