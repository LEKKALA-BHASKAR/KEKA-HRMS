import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { renderLetter } from "./letters";

/**
 * Pure pieces of the offer flow: the placeholders an offer letter can use,
 * the salary breakup (entered by the recruiter or resolved from the pay
 * structure), turning the rendered letter into PDF blocks, and the tokens
 * behind the candidate's offer link.
 *
 * A link token is 32 random bytes plus an HMAC of them under the app secret.
 * The HMAC lets a forged or mistyped token be refused before any database
 * read; the random part makes it unguessable; and only its SHA-256 is
 * stored, so a database dump does not hand out working links.
 */

/** Placeholders only an offer letter can resolve, on top of the HR letter set. */
export const OFFER_PLACEHOLDERS: Record<string, string> = {
  candidate_first_name: "Candidate's first name (offer letters)",
  monthly_ctc: "Annual CTC divided by twelve (offer letters)",
  joining_bonus: "One-time joining bonus (offer letters)",
  offer_expiry: "Date the offer lapses (offer letters)",
  salary_breakup: "Table of salary components, monthly and annual (offer letters)",
};

/** The letter used when a company has no offer template of its own yet. */
export const DEFAULT_OFFER_TEMPLATE = `<p>Dear {{candidate_first_name}},</p>
<p>We are delighted to offer you the position of <strong>{{job_title}}</strong> at {{legal_entity_name}}, based at {{location}} and reporting to {{reporting_manager}}.</p>
<p>Your annual cost to company will be <strong>{{annual_ctc}}</strong>, made up as follows:</p>
{{salary_breakup}}
<p>Your expected date of joining is {{joining_date}}. This offer is valid until {{offer_expiry}}.</p>
<p>This offer is subject to satisfactory background verification and the documents listed in your onboarding checklist.</p>
<p>Yours sincerely,<br/>{{signatory_name}}<br/>{{signatory_designation}}</p>`;

export type BreakupRow = { name: string; monthly: number; annual: number };

const round2 = (v: number) => Math.round(v * 100) / 100;
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const inr = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * A breakup typed as one component per line, "Basic: 6,00,000", in annual
 * rupees. It must add up to the annual CTC (to the rupee per line, for
 * rounding), or the letter would contradict itself.
 */
export function parseManualBreakup(text: string, annualCtc: number): { rows?: BreakupRow[]; error?: string } {
  const rows: BreakupRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { error: "Enter at least one component, one per line, like “Basic: 600000”." };
  if (lines.length > 30) return { error: "Keep the breakup to 30 components or fewer." };
  for (const [i, line] of lines.entries()) {
    const m = /^(.{1,60}?)\s*[:=\-–]\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*$/i.exec(line);
    if (!m) return { error: `Line ${i + 1} (“${line.slice(0, 40)}”) should look like “Basic: 600000”.` };
    const annual = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(annual) || annual < 0) return { error: `Line ${i + 1} has an amount that is not a number.` };
    rows.push({ name: m[1]!.trim(), monthly: round2(annual / 12), annual: round2(annual) });
  }
  const total = rows.reduce((s, r) => s + r.annual, 0);
  if (Math.abs(total - annualCtc) > rows.length) return { error: `The components add up to ${inr(total)}, not the annual CTC of ${inr(annualCtc)}.` };
  return { rows };
}

/** The breakup as an HTML table. Names are escaped; this is the only raw HTML a placeholder produces. */
export function breakupTableHtml(rows: BreakupRow[]): string {
  if (rows.length === 0) return "";
  const total = rows.reduce((s, r) => ({ m: s.m + r.monthly, a: s.a + r.annual }), { m: 0, a: 0 });
  const cell = "border:1px solid #ccc;padding:4px 10px";
  const body = rows.map((r) => `<tr><td style="${cell}">${escapeHtml(r.name)}</td><td style="${cell};text-align:right">${inr(r.monthly)}</td><td style="${cell};text-align:right">${inr(r.annual)}</td></tr>`).join("");
  return `<table style="border-collapse:collapse;margin:0 0 12px"><thead><tr><th style="${cell};text-align:left">Component</th><th style="${cell};text-align:right">Monthly</th><th style="${cell};text-align:right">Annual</th></tr></thead><tbody>${body}<tr><td style="${cell}"><strong>Total</strong></td><td style="${cell};text-align:right"><strong>${inr(total.m)}</strong></td><td style="${cell};text-align:right"><strong>${inr(total.a)}</strong></td></tr></tbody></table>`;
}

const BREAKUP = /\{\{\s*salary_breakup\s*\}\}/g;
const SENTINEL = "\u0000SALARY_BREAKUP\u0000";

/**
 * Fill an offer template. Every value is escaped by the HR letter renderer;
 * the salary table is spliced in afterwards so it is the one piece of markup
 * a value contributes.
 */
export function renderOfferHtml(body: string, values: Record<string, string>, breakup: BreakupRow[]): { html: string; missing: string[] } {
  const r = renderLetter(body.replace(BREAKUP, SENTINEL), values);
  const missing = [...r.missing];
  if (/\{\{\s*salary_breakup\s*\}\}/.test(body) && breakup.length === 0) missing.push("salary_breakup");
  const table = breakup.length ? breakupTableHtml(breakup) : "<p>[SALARY_BREAKUP NOT AVAILABLE]</p>";
  return { html: r.html.split(SENTINEL).join(table), missing };
}

export type LetterBlock = { kind: "p"; text: string; bold?: boolean } | { kind: "table"; rows: BreakupRow[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Template HTML to plain paragraphs for the PDF: block tags break, inline tags vanish, entities decode. */
export function htmlToParagraphs(html: string): string[] {
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|table|ul|ol|blockquote)\s*>/gi, "\n\n")
    .replace(/<\/\s*t[dh]\s*>/gi, "   ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()]!;
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return m;
    });
  return text.split(/\n/).map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
}

/** The same letter as PDF blocks: paragraphs, with the salary table where the template put it. */
export function offerPdfBlocks(body: string, values: Record<string, string>, breakup: BreakupRow[]): LetterBlock[] {
  const blocks: LetterBlock[] = [];
  body.split(BREAKUP).forEach((part, i) => {
    if (i > 0) blocks.push(breakup.length ? { kind: "table", rows: breakup } : { kind: "p", text: "[SALARY_BREAKUP NOT AVAILABLE]" });
    for (const text of htmlToParagraphs(renderLetter(part, values).html)) blocks.push({ kind: "p", text });
  });
  return blocks;
}

// --- Link tokens ---------------------------------------------------------------------------

function linkKey(secret: string): Buffer {
  return createHash("sha256").update(`${secret}:offer-link`).digest();
}

const sign = (random: string, secret: string) => createHmac("sha256", linkKey(secret)).update(random).digest("base64url").slice(0, 22);

/** A fresh token and the hash to store. The token is shown once, in the candidate's email. */
export function newOfferToken(secret: string): { token: string; hash: string } {
  const random = randomBytes(32).toString("base64url");
  const token = `${random}.${sign(random, secret)}`;
  return { token, hash: hashOfferToken(token) };
}

export function hashOfferToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Shape and signature check, constant-time, before the token goes anywhere near the database. */
export function offerTokenSigned(token: string, secret: string): boolean {
  const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return false;
  const want = Buffer.from(sign(m[1]!, secret));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** When a new link stops working: at the end of the offer's expiry day, and never more than 30 days out. */
export function linkExpiry(offerExpiresOn: Date | null, now = new Date()): Date {
  const cap = new Date(now.getTime() + 30 * 86_400_000);
  if (!offerExpiresOn) return cap;
  const endOfDay = new Date(Date.UTC(offerExpiresOn.getUTCFullYear(), offerExpiresOn.getUTCMonth(), offerExpiresOn.getUTCDate(), 23, 59, 59));
  return endOfDay < cap ? endOfDay : cap;
}

export type LinkState = "OPEN" | "EXPIRED" | "REVOKED" | "ACCEPTED" | "DECLINED" | "CLOSED";

/**
 * What the portal shows for a link. A decided offer stays viewable through
 * its link (so the candidate can see what they signed) until it expires.
 */
export function offerLinkState(link: { expiresAt: Date; revokedAt: Date | null }, offerStatus: string, now = new Date()): LinkState {
  if (link.revokedAt) return "REVOKED";
  if (link.expiresAt <= now) return "EXPIRED";
  if (offerStatus === "ACCEPTED") return "ACCEPTED";
  if (offerStatus === "DECLINED") return "DECLINED";
  if (offerStatus !== "EXTENDED") return "CLOSED";
  return "OPEN";
}

/** Names compared ignoring case, punctuation and extra spaces. */
export function sameName(typed: string, ...names: Array<string | null | undefined>): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const t = norm(typed);
  return t !== "" && names.some((n) => !!n && norm(n) === t);
}
