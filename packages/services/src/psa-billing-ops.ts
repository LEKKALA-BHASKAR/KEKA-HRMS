import { prisma } from "@keka/db";
import { generateCharges } from "./psa-finance";

/**
 * The PSA screens' remaining plumbing: the default sales stages a tenant
 * starts with, retainer set-up and its schedule of periods, and charging an
 * approved expense claim to a client project so it can be invoiced.
 */

type Result = { ok: boolean; message: string; id?: string };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (d: Date) => d.toISOString().slice(0, 7);

// ---- Pipeline set-up --------------------------------------------------------------

export const DEFAULT_OPPORTUNITY_STAGES = [
  { name: "Prospecting", color: "#94a3b8", winProbability: 10, kind: "OPEN" as const },
  { name: "Qualification", color: "#3b82f6", winProbability: 25, kind: "OPEN" as const },
  { name: "Proposal", color: "#8b5cf6", winProbability: 50, kind: "OPEN" as const },
  { name: "Negotiation", color: "#f59e0b", winProbability: 75, kind: "OPEN" as const },
  { name: "Closed Won", color: "#22c55e", winProbability: 100, kind: "WON" as const },
  { name: "Closed Lost", color: "#ef4444", winProbability: 0, kind: "LOST" as const },
];
export const DEFAULT_OPPORTUNITY_SOURCES = ["Referral", "Website", "Existing client", "Partner", "Outbound"];

/** A tenant with no stages gets the standard ones (and sources), so the board is usable on day one. */
export async function ensurePipelineSetup(tenantId: string): Promise<void> {
  if (!(await prisma.opportunityStage.count({ where: { tenantId } }))) {
    await prisma.opportunityStage.createMany({ data: DEFAULT_OPPORTUNITY_STAGES.map((s, i) => ({ ...s, tenantId, sequence: i })), skipDuplicates: true });
  }
  if (!(await prisma.opportunitySource.count({ where: { tenantId } }))) {
    await prisma.opportunitySource.createMany({ data: DEFAULT_OPPORTUNITY_SOURCES.map((name) => ({ tenantId, name })), skipDuplicates: true });
  }
}

// ---- Retainers -----------------------------------------------------------------------

/**
 * Set a project up as a monthly retainer: the fee and the month billing
 * starts. Retainer charges are brought up to date straight away.
 */
export async function saveRetainer(tenantId: string, projectId: string, i: { fee: number; from: Date }): Promise<Result> {
  const p = await prisma.project.findFirst({ where: { tenantId, id: projectId } });
  if (!p) return { ok: false, message: "Project not found." };
  if (!p.clientId) return { ok: false, message: "A retainer is billed to a client; set the project's client first." };
  if (!(i.fee > 0)) return { ok: false, message: "Enter the monthly fee." };
  if (p.endDate && i.from > p.endDate) return { ok: false, message: "Billing starts after the project ends." };
  const invoiced = await prisma.projectCharge.count({ where: { tenantId, projectId: p.id, kind: "RETAINER", status: "INVOICED" } });
  if (invoiced && p.billingModel === "RETAINER" && p.retainerFrom && ym(i.from) > ym(p.retainerFrom)) {
    return { ok: false, message: "Periods are already invoiced; billing cannot start later than it did." };
  }
  const from = new Date(Date.UTC(i.from.getUTCFullYear(), i.from.getUTCMonth(), 1));
  await prisma.project.update({ where: { id: p.id }, data: { billingModel: "RETAINER", retainerFee: Math.round(i.fee * 100) / 100, retainerFrequency: "MONTHLY", retainerFrom: from } });
  const g = await generateCharges(tenantId, p.id);
  return { ok: true, message: `Retainer of ₹${i.fee.toLocaleString("en-IN")} a month from ${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}${g.created ? ` · ${g.created} period(s) ready to bill` : ""}.` };
}

export interface RetainerPeriod { month: string; label: string; amount: number; state: "INVOICED" | "UNBILLED" | "UPCOMING"; chargeNumber?: string; invoiceId?: string | null; invoiceNumber?: string | null }

/** Each month of a retainer from its start to the project's end (or `ahead` months on), and where it stands. */
export async function retainerSchedule(tenantId: string, projectId: string, today = new Date(), ahead = 3): Promise<RetainerPeriod[]> {
  const p = await prisma.project.findFirst({ where: { tenantId, id: projectId } });
  if (!p || p.billingModel !== "RETAINER" || !p.retainerFee) return [];
  const from = p.retainerFrom ?? p.startDate;
  if (!from) return [];
  const charges = await prisma.projectCharge.findMany({ where: { tenantId, projectId: p.id, kind: "RETAINER", status: { not: "CANCELLED" } }, include: { invoice: { select: { id: true, invoiceNumber: true, status: true } } } });
  const lines = await prisma.invoiceLine.findMany({ where: { lineType: "RETAINER", invoice: { projectId: p.id, kind: "TAX", status: { not: "CANCELLED" } } }, select: { description: true, invoice: { select: { id: true, invoiceNumber: true } } } });
  const stop = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + ahead, 1));
  const out: RetainerPeriod[] = [];
  for (let y = from.getUTCFullYear(), mo = from.getUTCMonth(); out.length < 120; mo++) {
    const start = new Date(Date.UTC(y, mo, 1));
    if (start > stop || (p.endDate && start > p.endDate)) break;
    const month = ym(start);
    const line = lines.find((l) => l.description.includes(month));
    const charge = charges.find((c) => c.periodStart && ym(c.periodStart) === month);
    const state = line || charge?.status === "INVOICED" ? "INVOICED" : start <= today ? "UNBILLED" : "UPCOMING";
    out.push({
      month, label: `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`, amount: charge ? Number(charge.amount) : Number(p.retainerFee), state,
      chargeNumber: charge?.number, invoiceId: line?.invoice.id ?? charge?.invoice?.id ?? null, invoiceNumber: line?.invoice.invoiceNumber ?? charge?.invoice?.invoiceNumber ?? null,
    });
  }
  return out;
}

// ---- Project expenses ---------------------------------------------------------------

const CHARGEABLE = ["APPROVED", "PAYMENT_PENDING", "PAID"] as const;

/** The expense claim's charge, if one was raised. */
async function chargeOf(tenantId: string, claimId: string) {
  const all = await prisma.projectCharge.findMany({ where: { tenantId, kind: "EXPENSE", status: { not: "CANCELLED" } } });
  return all.find((c) => (c.sourceRefs as { expenseClaimId?: string } | null)?.expenseClaimId === claimId) ?? null;
}

/**
 * Charge an approved expense claim to a client project: it becomes an
 * unbilled EXPENSE charge on that project, ready for the next invoice. A
 * claim already invoiced stays where it is.
 */
export async function chargeExpenseToProject(tenantId: string, claimId: string, projectId: string): Promise<Result> {
  const claim = await prisma.expenseClaim.findFirst({ where: { tenantId, id: claimId } });
  if (!claim) return { ok: false, message: "Expense claim not found." };
  if (!(CHARGEABLE as readonly string[]).includes(claim.stage)) return { ok: false, message: "Only an approved claim can be charged to a client." };
  if (!(Number(claim.approvedTotal) > 0)) return { ok: false, message: "Nothing was approved on this claim." };
  const p = await prisma.project.findFirst({ where: { tenantId, id: projectId } });
  if (!p) return { ok: false, message: "Project not found." };
  if (!p.clientId || p.billingModel === "NON_BILLABLE") return { ok: false, message: "Charge expenses to a billable client project." };
  const existing = await chargeOf(tenantId, claim.id);
  if (existing?.status === "INVOICED") return { ok: false, message: `${claim.claimNumber} is already invoiced (${existing.number}).` };
  if (claim.projectId === p.id && existing) return { ok: true, message: `${claim.claimNumber} is already charged to ${p.name}.`, id: existing.id };
  const previous = claim.projectId;
  await prisma.expenseClaim.update({ where: { id: claim.id }, data: { projectId: p.id } });
  if (previous && previous !== p.id) await generateCharges(tenantId, previous);
  await generateCharges(tenantId, p.id);
  const charge = await chargeOf(tenantId, claim.id);
  return { ok: true, message: `${claim.claimNumber} charged to ${p.name}${charge ? ` as ${charge.number}` : ""}.`, id: charge?.id };
}

/** Take a claim off its project. Refused once its charge is invoiced. */
export async function unchargeExpense(tenantId: string, claimId: string): Promise<Result> {
  const claim = await prisma.expenseClaim.findFirst({ where: { tenantId, id: claimId } });
  if (!claim || !claim.projectId) return { ok: false, message: "That claim is not charged to a project." };
  const existing = await chargeOf(tenantId, claim.id);
  if (existing?.status === "INVOICED") return { ok: false, message: `${claim.claimNumber} is on an invoice; cancel the invoice or raise a credit note instead.` };
  await prisma.expenseClaim.update({ where: { id: claim.id }, data: { projectId: null } });
  await generateCharges(tenantId, claim.projectId);
  return { ok: true, message: `${claim.claimNumber} is no longer charged to the project.` };
}
