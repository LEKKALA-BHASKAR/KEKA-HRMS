import { prisma, Prisma } from "@keka/db";
import { gst } from "./projects-math";
import { stateCode } from "./projects";
import { postEntry, postInvoice, reverseEntry } from "./accounting";
import { markupPct } from "./psa-math";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Project finance: charges (what is ready to bill), invoices and proforma
 * invoices raised from them, write-offs, cancellations, credit notes, rate
 * cards and billing entities.
 *
 * The books stay in step with the documents: a sent tax invoice is a
 * receivable; a write-off moves what is left to bad debts; a cancellation
 * reverses the invoice; an applied credit note reduces revenue, output tax
 * and the receivable together. A proforma is a quote and never reaches the
 * ledger — nothing is due on it.
 */

type Result = { ok: boolean; message: string; id?: string };
type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const ym = (d: Date) => d.toISOString().slice(0, 7);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

interface ChargeRefs { key: string; timeEntryIds?: string[]; milestoneId?: string; expenseClaimId?: string; period?: string }
const refsOf = (j: unknown): ChargeRefs | null => (j && typeof j === "object" && typeof (j as ChargeRefs).key === "string" ? (j as ChargeRefs) : null);

async function lockTenant(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
}

/** The next charge number (CHR-12), under the tenant lock. */
async function nextChargeNumber(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.projectCharge.findMany({ where: { tenantId }, select: { number: true } });
  const n = rows.reduce((m, r) => Math.max(m, Number(r.number.replace(/\D/g, "")) || 0), 0);
  return `CHR${n + 1}`;
}

/**
 * The next document number. A billing entity with project billing set up
 * numbers its own documents; otherwise invoices are INV-YYYY-NNNN (as the
 * period drafts always were), proformas PINV-n and credit notes CRN-n.
 */
export async function nextDocumentNumber(tx: Tx, tenantId: string, kind: "TAX" | "PROFORMA" | "CREDIT", billingEntityId?: string | null, year = new Date().getUTCFullYear()): Promise<string> {
  const setting = billingEntityId ? await tx.billingEntitySetting.findFirst({ where: { tenantId, legalEntityId: billingEntityId } }) : null;
  if (setting) {
    const field = kind === "TAX" ? "nextInvoiceNumber" : kind === "PROFORMA" ? "nextProformaNumber" : "nextCreditNoteNumber";
    const prefix = kind === "TAX" ? setting.invoicePrefix : kind === "PROFORMA" ? setting.proformaPrefix : setting.creditNotePrefix;
    let n = setting[field];
    // Skip any number already taken (a manual document, an older scheme).
    for (;;) {
      const candidate = `${prefix}${n}${kind === "TAX" && setting.invoiceSuffix ? setting.invoiceSuffix : ""}`;
      const taken = kind === "CREDIT" ? await tx.creditNote.count({ where: { tenantId, number: candidate } }) : await tx.invoice.count({ where: { tenantId, invoiceNumber: candidate } });
      if (!taken) {
        await tx.billingEntitySetting.update({ where: { id: setting.id }, data: { [field]: n + 1 } });
        return candidate;
      }
      n++;
    }
  }
  if (kind === "CREDIT") {
    const rows = await tx.creditNote.findMany({ where: { tenantId, number: { startsWith: "CRN-" } }, select: { number: true } });
    return `CRN-${rows.reduce((m, r) => Math.max(m, Number(r.number.slice(4)) || 0), 0) + 1}`;
  }
  if (kind === "PROFORMA") {
    const rows = await tx.invoice.findMany({ where: { tenantId, invoiceNumber: { startsWith: "PINV-" } }, select: { invoiceNumber: true } });
    return `PINV-${rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber.slice(5)) || 0), 0) + 1}`;
  }
  const rows = await tx.invoice.findMany({ where: { tenantId, invoiceNumber: { startsWith: `INV-${year}-` } }, select: { invoiceNumber: true } });
  return `INV-${year}-${String(rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber.slice(9)) || 0), 0) + 1).padStart(4, "0")}`;
}

// ---- Charges ---------------------------------------------------------------------

interface WantedCharge { key: string; kind: "TIME" | "MILESTONE" | "RETAINER" | "EXPENSE"; name: string; template: "NONE" | "TASK" | "ROLE" | "EMPLOYEE"; periodStart: Date | null; periodEnd: Date | null; quantity: number; amount: number; refs: ChargeRefs }

/**
 * Bring a project's unbilled charges up to date: approved billable time
 * (one charge per month), completed milestones, retainer periods that have
 * begun and approved project expenses. Charges already invoiced are left
 * alone; an unbilled charge whose source has gone is removed.
 */
export async function generateCharges(tenantId: string, projectId: string, upTo = new Date()): Promise<{ created: number; updated: number; removed: number }> {
  const p = await prisma.project.findFirst({ where: { tenantId, id: projectId }, include: { client: { select: { currency: true } }, milestones: true } });
  const out = { created: 0, updated: 0, removed: 0 };
  if (!p || !p.clientId || p.billingModel === "NON_BILLABLE") return out;
  const end = startOfDay(upTo);
  const wanted: WantedCharge[] = [];

  if (p.billingModel === "TIME_AND_MATERIAL") {
    const entries = await prisma.timeEntry.findMany({
      where: { projectId: p.id, isBillable: true, isInvoiced: false, date: { lte: end }, timesheet: { status: { in: ["APPROVED", "LOCKED"] } } },
      select: { id: true, date: true, hours: true, billRate: true }, orderBy: { date: "asc" },
    });
    const byMonth = new Map<string, typeof entries>();
    for (const e of entries) byMonth.set(ym(e.date), [...(byMonth.get(ym(e.date)) ?? []), e]);
    for (const [month, list] of byMonth) {
      const first = list[0].date, last = list[list.length - 1].date;
      wanted.push({
        key: `TIME:${month}`, kind: "TIME", name: `Charge for ${monthName(first)}`, template: "EMPLOYEE", periodStart: first, periodEnd: last,
        quantity: r2(list.reduce((s, e) => s + Number(e.hours), 0)), amount: r2(list.reduce((s, e) => s + Number(e.hours) * Number(e.billRate ?? 0), 0)),
        refs: { key: `TIME:${month}`, timeEntryIds: list.map((e) => e.id) },
      });
    }
  }
  if (p.billingModel === "MILESTONE") {
    for (const m of p.milestones.filter((x) => x.status === "COMPLETED" && x.amount && Number(x.amount) > 0)) {
      wanted.push({ key: `MS:${m.id}`, kind: "MILESTONE", name: `Charge for milestone: ${m.name}`, template: "NONE", periodStart: m.completedOn ?? m.dueDate, periodEnd: m.completedOn ?? m.dueDate, quantity: 1, amount: r2(Number(m.amount)), refs: { key: `MS:${m.id}`, milestoneId: m.id } });
    }
  }
  if (p.billingModel === "RETAINER" && p.retainerFee && Number(p.retainerFee) > 0) {
    const from = p.retainerFrom ?? p.startDate;
    if (from) {
      const invoicedPeriods = new Set((await prisma.invoiceLine.findMany({ where: { lineType: "RETAINER", invoice: { projectId: p.id, kind: "TAX", status: { not: "CANCELLED" } } }, select: { description: true } }))
        .map((l) => /(\d{4}-\d{2})/.exec(l.description)?.[1]).filter((x): x is string => !!x));
      for (let y = from.getUTCFullYear(), mo = from.getUTCMonth(); ; mo++) {
        const start = new Date(Date.UTC(y, mo, 1));
        if (start > end || (p.endDate && start > p.endDate)) break;
        const month = ym(start);
        if (invoicedPeriods.has(month)) continue;
        wanted.push({ key: `RET:${month}`, kind: "RETAINER", name: `Retainer for ${monthName(start)}`, template: "NONE", periodStart: start, periodEnd: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)), quantity: 1, amount: r2(Number(p.retainerFee)), refs: { key: `RET:${month}`, period: month } });
      }
    }
  }
  const claims = await prisma.expenseClaim.findMany({ where: { tenantId, projectId: p.id, stage: { in: ["APPROVED", "PAYMENT_PENDING", "PAID"] } }, select: { id: true, claimNumber: true, title: true, approvedTotal: true, submittedAt: true, createdAt: true } });
  for (const c of claims.filter((x) => Number(x.approvedTotal) > 0)) {
    const at = c.submittedAt ?? c.createdAt;
    wanted.push({ key: `EXP:${c.id}`, kind: "EXPENSE", name: `${c.title} (${c.claimNumber})`, template: "NONE", periodStart: at, periodEnd: at, quantity: 1, amount: r2(Number(c.approvedTotal)), refs: { key: `EXP:${c.id}`, expenseClaimId: c.id } });
  }

  const existing = await prisma.projectCharge.findMany({ where: { tenantId, projectId: p.id } });
  const byKey = new Map(existing.flatMap((c) => { const k = refsOf(c.sourceRefs)?.key; return k ? [[k, c] as const] : []; }));
  const keep = new Set(wanted.map((w) => w.key));
  await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    for (const w of wanted) {
      const c = byKey.get(w.key);
      if (c && c.status !== "UNBILLED") continue;
      const data = { name: w.name, kind: w.kind, template: w.template, periodStart: w.periodStart, periodEnd: w.periodEnd, quantity: w.quantity, amount: w.amount, currency: p.client?.currency ?? "INR", sourceRefs: w.refs as unknown as Prisma.InputJsonValue };
      if (c) {
        if (Number(c.amount) !== w.amount || Number(c.quantity) !== w.quantity) { await tx.projectCharge.update({ where: { id: c.id }, data }); out.updated++; }
      } else {
        await tx.projectCharge.create({ data: { ...data, tenantId, projectId: p.id, number: await nextChargeNumber(tx, tenantId) } });
        out.created++;
      }
    }
    for (const c of existing) {
      const k = refsOf(c.sourceRefs)?.key;
      if (c.status === "UNBILLED" && k && !k.startsWith("ADHOC") && !k.startsWith("LINE") && !keep.has(k) && !c.invoiceId) {
        await tx.projectCharge.delete({ where: { id: c.id } });
        out.removed++;
      }
    }
  });
  return out;
}

/** Charges for every billable project of a tenant. */
export async function generateAllCharges(tenantId: string, upTo = new Date()) {
  const projects = await prisma.project.findMany({ where: { tenantId, billingModel: { not: "NON_BILLABLE" }, clientId: { not: null }, archivedAt: null }, select: { id: true } });
  let created = 0;
  for (const p of projects) created += (await generateCharges(tenantId, p.id, upTo)).created;
  return created;
}

export async function addAdhocCharge(tenantId: string, projectId: string, i: { name: string; amount: number; date: Date }): Promise<Result> {
  const p = await prisma.project.findFirst({ where: { tenantId, id: projectId }, include: { client: true } });
  if (!p || !p.client) return { ok: false, message: "A charge needs a client project." };
  if (!i.name.trim() || !(i.amount > 0)) return { ok: false, message: "Name the charge and give its amount." };
  const c = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const number = await nextChargeNumber(tx, tenantId);
    return tx.projectCharge.create({ data: { tenantId, projectId: p.id, number, name: i.name.trim(), kind: "ADHOC", amount: r2(i.amount), currency: p.client!.currency, periodStart: i.date, periodEnd: i.date, sourceRefs: { key: `ADHOC:${number}` } } });
  });
  return { ok: true, message: `${c.number} added.`, id: c.id };
}

// ---- Invoices from charges -------------------------------------------------------

export interface InvoiceHeader {
  documentTitle?: string; invoiceDate: Date; paymentTermDays: number; dueDate?: Date | null; poNumber?: string | null;
  attentionName?: string | null; attentionEmail?: string | null; billingEntityId?: string | null; notes?: string | null;
}

type Line = { description: string; lineType: string; quantity: number; unitRate: number; amount: number; milestoneId?: string };

/**
 * A draft invoice (or proforma) from selected charges of one client. Time is
 * itemised by the charge's template; a tax invoice marks the hours,
 * milestones and charges invoiced, a proforma only remembers the charges.
 */
export async function draftInvoiceFromCharges(tenantId: string, chargeIds: string[], header: InvoiceHeader, opts: { proforma?: boolean; convertedFromId?: string | null } = {}): Promise<Result> {
  const ids = [...new Set(chargeIds)];
  if (ids.length === 0) return { ok: false, message: "Select the charges to bill." };
  const charges = await prisma.projectCharge.findMany({ where: { tenantId, id: { in: ids } }, include: { project: { include: { client: true } } }, orderBy: [{ periodStart: "asc" }, { number: "asc" }] });
  if (charges.length !== ids.length) return { ok: false, message: "A selected charge was not found." };
  if (charges.some((c) => c.status !== "UNBILLED")) return { ok: false, message: "Only unbilled charges can be invoiced." };
  if (!opts.convertedFromId && charges.some((c) => c.invoiceId)) return { ok: false, message: "A selected charge is already on a proforma invoice; convert that proforma instead." };
  const clients = new Set(charges.map((c) => c.project.clientId));
  if (clients.size !== 1 || !charges[0].project.client) return { ok: false, message: "Select charges of one client." };
  const client = charges[0].project.client;
  if (header.billingEntityId && !(await prisma.legalEntity.count({ where: { tenantId, id: header.billingEntityId } }))) return { ok: false, message: "Billing entity not found." };
  if (!(header.paymentTermDays >= 0 && header.paymentTermDays <= 365)) return { ok: false, message: "Payment term is 0 to 365 days." };

  const lines: Line[] = [];
  const entryIds: string[] = [];
  const milestoneIds: string[] = [];
  for (const c of charges) {
    const refs = refsOf(c.sourceRefs);
    if (c.kind === "TIME") {
      const entries = await prisma.timeEntry.findMany({
        where: { id: { in: refs?.timeEntryIds ?? [] }, projectId: c.projectId, isBillable: true, isInvoiced: false, timesheet: { status: { in: ["APPROVED", "LOCKED"] } } },
        include: { task: { select: { title: true } } },
      });
      if (entries.length === 0) continue;
      const people = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.employeeId))] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName ?? ""]));
      const roles = new Map((await prisma.resourceAllocation.findMany({ where: { projectId: c.projectId, employeeId: { in: [...people.keys()] } }, select: { employeeId: true, billingRole: true } })).map((a) => [a.employeeId, a.billingRole ?? "Consultant"]));
      const groups = new Map<string, { label: string; hours: number; rate: number }>();
      for (const e of entries) {
        const rate = Number(e.billRate ?? 0);
        const label = c.template === "EMPLOYEE" ? `${people.get(e.employeeId)} — professional services`
          : c.template === "ROLE" ? `${roles.get(e.employeeId) ?? "Consultant"} — professional services`
          : c.template === "TASK" ? (e.task?.title ?? "General")
          : `Professional services — ${c.project.name}`;
        const g = groups.get(`${label}:${rate}`) ?? { label, hours: 0, rate };
        g.hours = r2(g.hours + Number(e.hours));
        groups.set(`${label}:${rate}`, g);
      }
      for (const g of groups.values()) lines.push({ description: g.label, lineType: "HOURS", quantity: g.hours, unitRate: g.rate, amount: r2(g.hours * g.rate) });
      entryIds.push(...entries.map((e) => e.id));
    } else if (c.kind === "MILESTONE") {
      lines.push({ description: c.name.replace(/^Charge for milestone: /, "Milestone: "), lineType: "MILESTONE", quantity: 1, unitRate: Number(c.amount), amount: Number(c.amount), milestoneId: refs?.milestoneId });
      if (refs?.milestoneId) milestoneIds.push(refs.milestoneId);
    } else if (c.kind === "RETAINER") {
      lines.push({ description: `Retainer ${refs?.period ?? (c.periodStart ? ym(c.periodStart) : "")}`, lineType: "RETAINER", quantity: 1, unitRate: Number(c.amount), amount: Number(c.amount) });
    } else {
      lines.push({ description: c.name, lineType: c.kind === "EXPENSE" ? "EXPENSE" : "PRODUCT", quantity: Number(c.quantity), unitRate: r2(Number(c.amount) / Math.max(1, Number(c.quantity))), amount: Number(c.amount) });
    }
  }
  if (lines.length === 0) return { ok: false, message: "Nothing left to bill on those charges — the hours may already be invoiced." };
  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  const entity = header.billingEntityId ? await prisma.legalEntity.findFirst({ where: { tenantId, id: header.billingEntityId } }) : await prisma.legalEntity.findFirst({ where: { tenantId } });
  const tax = gst(subtotal, stateCode(entity?.state), client.countryCode === "IN" ? stateCode(client.state) : null);
  const projectIds = [...new Set(charges.map((c) => c.projectId))];
  const starts = charges.map((c) => c.periodStart).filter((d): d is Date => !!d), ends = charges.map((c) => c.periodEnd).filter((d): d is Date => !!d);
  const due = header.dueDate ?? new Date(startOfDay(header.invoiceDate).getTime() + header.paymentTermDays * DAY);
  const total = r2(subtotal + tax.total);
  const inv = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const number = await nextDocumentNumber(tx, tenantId, opts.proforma ? "PROFORMA" : "TAX", entity?.id ?? null, header.invoiceDate.getUTCFullYear());
    const created = await tx.invoice.create({
      data: {
        tenantId, clientId: client.id, projectId: projectIds.length === 1 ? projectIds[0] : null, invoiceNumber: number, status: "DRAFT", currency: client.currency,
        kind: opts.proforma ? "PROFORMA" : "TAX", documentTitle: header.documentTitle?.trim() || (opts.proforma ? "Proforma Invoice" : "Tax Invoice"),
        issueDate: header.invoiceDate, dueDate: due, paymentTermDays: header.paymentTermDays,
        periodStart: starts.length ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null, periodEnd: ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
        subtotal, taxTotal: tax.total, total, amountDue: opts.proforma ? 0 : total,
        poNumber: header.poNumber ?? null, attentionName: header.attentionName ?? null, attentionEmail: header.attentionEmail ?? null, billingEntityId: entity?.id ?? null,
        convertedFromId: opts.convertedFromId ?? null,
        notes: tax.kind === "INTRA" ? `CGST 9% ₹${tax.cgst} + SGST 9% ₹${tax.sgst}` : tax.kind === "INTER" ? `IGST 18% ₹${tax.igst}` : "Export of services — zero-rated under LUT",
        terms: header.notes ?? null,
        lines: { create: lines.map((l, i) => ({ ...l, sequence: i, taxPercent: tax.kind === "EXPORT" ? 0 : 18, taxAmount: tax.kind === "EXPORT" ? 0 : r2((l.amount * 18) / 100) })) },
      },
    });
    if (opts.proforma) {
      await tx.projectCharge.updateMany({ where: { id: { in: ids } }, data: { invoiceId: created.id } });
    } else {
      if (entryIds.length) await tx.timeEntry.updateMany({ where: { id: { in: entryIds } }, data: { isInvoiced: true, invoiceId: created.id } });
      if (milestoneIds.length) await tx.milestone.updateMany({ where: { id: { in: milestoneIds } }, data: { status: "INVOICED" } });
      await tx.projectCharge.updateMany({ where: { id: { in: ids } }, data: { status: "INVOICED", invoiceId: created.id } });
    }
    return created;
  });
  return { ok: true, message: `${inv.invoiceNumber} drafted: ₹${subtotal.toLocaleString("en-IN")} + GST ₹${tax.total.toLocaleString("en-IN")}.`, id: inv.id };
}

/** A proforma becomes the tax invoice for the same charges. */
export async function convertProforma(tenantId: string, proformaId: string): Promise<Result> {
  const pf = await prisma.invoice.findFirst({ where: { tenantId, id: proformaId, kind: "PROFORMA" } });
  if (!pf) return { ok: false, message: "Proforma invoice not found." };
  if (pf.status === "CANCELLED") return { ok: false, message: "This proforma is cancelled." };
  if (await prisma.invoice.count({ where: { tenantId, convertedFromId: pf.id, status: { not: "CANCELLED" } } })) return { ok: false, message: "This proforma has already been converted." };
  const charges = await prisma.projectCharge.findMany({ where: { tenantId, invoiceId: pf.id, status: "UNBILLED" }, select: { id: true } });
  if (charges.length === 0) return { ok: false, message: "The proforma's charges were billed elsewhere." };
  return draftInvoiceFromCharges(tenantId, charges.map((c) => c.id), {
    documentTitle: "Tax Invoice", invoiceDate: new Date(), paymentTermDays: pf.paymentTermDays, poNumber: pf.poNumber, attentionName: pf.attentionName, attentionEmail: pf.attentionEmail, billingEntityId: pf.billingEntityId,
  }, { convertedFromId: pf.id });
}

/** "Mark as sent" without emailing: a tax invoice reaches the books. */
export async function markInvoiceSent(tenantId: string, id: string, byUserId?: string | null): Promise<Result> {
  const inv = await prisma.invoice.findFirst({ where: { tenantId, id }, include: { client: true } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (inv.status !== "DRAFT") return { ok: false, message: "Only a draft can be marked as sent." };
  await prisma.invoice.update({ where: { id: inv.id }, data: { status: "SENT", sentAt: new Date() } });
  if (inv.kind === "TAX") {
    const entity = inv.billingEntityId ? await prisma.legalEntity.findFirst({ where: { tenantId, id: inv.billingEntityId } }) : await prisma.legalEntity.findFirst({ where: { tenantId } });
    const split = gst(Number(inv.subtotal), stateCode(entity?.state), inv.client.countryCode === "IN" ? stateCode(inv.client.state) : null);
    const posted = await postInvoice(inv.id, split, byUserId);
    if (!posted.ok) {
      await prisma.invoice.update({ where: { id: inv.id }, data: { status: "DRAFT", sentAt: null } });
      return posted;
    }
  }
  return { ok: true, message: `${inv.invoiceNumber} marked as sent.` };
}

/** An expense account for bad debts, created on first use (it is not in the default chart). */
async function badDebtAccount(tenantId: string): Promise<string> {
  const found = await prisma.account.findFirst({ where: { tenantId, code: "5910" } });
  if (found) return found.id;
  const parent = await prisma.account.findFirst({ where: { tenantId, code: "5000" } });
  const a = await prisma.account.create({ data: { tenantId, code: "5910", name: "Bad debts written off", accountClass: "EXPENSE", normalSide: "DEBIT", isSystem: false, parentId: parent?.id ?? null } });
  return a.id;
}

/** Write off what is left on an invoice: receivable to bad debts. Cannot be undone. */
export async function writeOffInvoice(tenantId: string, id: string, i: { date: Date; reason: string }, byUserId?: string | null): Promise<Result> {
  const inv = await prisma.invoice.findFirst({ where: { tenantId, id }, include: { client: { select: { name: true } } } });
  if (!inv || inv.kind !== "TAX") return { ok: false, message: "Invoice not found." };
  if (!["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status)) return { ok: false, message: "Only a sent, unpaid invoice can be written off." };
  if (!i.reason.trim()) return { ok: false, message: "Give the reason for the write off." };
  const amount = r2(Number(inv.amountDue));
  if (!(amount > 0)) return { ok: false, message: "Nothing is due on this invoice." };
  const posted = await postEntry({
    tenantId, date: i.date, source: "INVOICE", ref: { type: "InvoiceWriteOff", id: inv.id }, postedBy: byUserId,
    narration: `Write off ${inv.invoiceNumber} — ${inv.client.name}: ${i.reason.trim()}`,
    lines: [{ accountId: await badDebtAccount(tenantId), debit: amount, credit: 0, narration: "Bad debt", projectId: inv.projectId }, { accountCode: "1200", debit: 0, credit: amount, narration: inv.invoiceNumber, projectId: inv.projectId }],
  });
  if (!posted.ok) return posted;
  await prisma.invoice.update({ where: { id: inv.id }, data: { status: "WRITTEN_OFF", writtenOffAt: i.date, writeOffAmount: amount, writeOffReason: i.reason.trim(), amountDue: 0 } });
  return { ok: true, message: `${inv.invoiceNumber} written off (₹${amount.toLocaleString("en-IN")}).` };
}

/** Cancel an invoice nobody has paid: its posting is reversed and its charges are billable again. */
export async function cancelInvoice(tenantId: string, id: string, reason: string, byUserId?: string | null): Promise<Result> {
  const inv = await prisma.invoice.findFirst({ where: { tenantId, id } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (["CANCELLED", "PAID", "WRITTEN_OFF"].includes(inv.status)) return { ok: false, message: `This invoice is ${inv.status.toLowerCase().replace("_", " ")}.` };
  if (Number(inv.amountPaid) > 0) return { ok: false, message: "A payment is recorded against this invoice; raise a credit note instead." };
  if (await prisma.creditNote.count({ where: { tenantId, invoiceId: inv.id, status: "APPLIED" } })) return { ok: false, message: "A credit note is applied to this invoice." };
  if (!reason.trim()) return { ok: false, message: "Give the reason for cancelling." };
  if (inv.kind === "TAX") {
    const posting = await prisma.ledgerEntry.findFirst({ where: { tenantId, sourceRefType: "Invoice", sourceRefId: inv.id, status: "POSTED" } });
    if (posting) {
      const rev = await reverseEntry({ tenantId, entryId: posting.id, reason: `Invoice ${inv.invoiceNumber} cancelled: ${reason.trim()}`, byUserId });
      if (!rev.ok) return rev;
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({ where: { id: inv.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim(), amountDue: 0 } });
    if (inv.kind === "TAX") {
      await tx.timeEntry.updateMany({ where: { invoiceId: inv.id }, data: { isInvoiced: false, invoiceId: null } });
      const ms = (await tx.invoiceLine.findMany({ where: { invoiceId: inv.id, milestoneId: { not: null } }, select: { milestoneId: true } })).map((l) => l.milestoneId!);
      if (ms.length) await tx.milestone.updateMany({ where: { id: { in: ms }, status: "INVOICED" }, data: { status: "COMPLETED" } });
    }
    await tx.projectCharge.updateMany({ where: { tenantId, invoiceId: inv.id }, data: { status: "UNBILLED", invoiceId: null } });
  });
  return { ok: true, message: `${inv.invoiceNumber} cancelled.` };
}

// ---- Credit notes ------------------------------------------------------------------

export async function raiseCreditNote(tenantId: string, i: { clientId: string; invoiceId?: string | null; amount: number; taxAmount?: number; reason: string; issueDate: Date }, byUserId: string): Promise<Result> {
  const client = await prisma.client.findFirst({ where: { tenantId, id: i.clientId } });
  if (!client) return { ok: false, message: "Client not found." };
  const inv = i.invoiceId ? await prisma.invoice.findFirst({ where: { tenantId, id: i.invoiceId, kind: "TAX" } }) : null;
  if (i.invoiceId && (!inv || inv.clientId !== client.id)) return { ok: false, message: "That invoice is not this client's." };
  if (!(i.amount > 0)) return { ok: false, message: "Enter the credit amount." };
  if (!i.reason.trim()) return { ok: false, message: "Say what the credit is for." };
  const taxAmount = r2(i.taxAmount ?? 0);
  if (taxAmount < 0) return { ok: false, message: "Tax cannot be negative." };
  if (client.countryCode !== "IN" && taxAmount > 0) return { ok: false, message: "Exports carry no GST to credit." };
  const cn = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const number = await nextDocumentNumber(tx, tenantId, "CREDIT", inv?.billingEntityId ?? null);
    return tx.creditNote.create({ data: { tenantId, number, clientId: client.id, invoiceId: inv?.id ?? null, issueDate: i.issueDate, amount: r2(i.amount), taxAmount, currency: client.currency, reason: i.reason.trim(), createdById: byUserId } });
  });
  return { ok: true, message: `${cn.number} raised for ₹${r2(i.amount + taxAmount).toLocaleString("en-IN")}.`, id: cn.id };
}

/** Apply an open credit note to one of the client's open invoices. */
export async function applyCreditNote(tenantId: string, creditNoteId: string, invoiceId: string, byUserId?: string | null): Promise<Result> {
  const cn = await prisma.creditNote.findFirst({ where: { tenantId, id: creditNoteId }, include: { client: true } });
  if (!cn) return { ok: false, message: "Credit note not found." };
  if (cn.status !== "OPEN") return { ok: false, message: `${cn.number} is ${cn.status.toLowerCase()}.` };
  const inv = await prisma.invoice.findFirst({ where: { tenantId, id: invoiceId, kind: "TAX", clientId: cn.clientId } });
  if (!inv) return { ok: false, message: "Choose one of this client's invoices." };
  if (!["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status)) return { ok: false, message: "Credit applies to a sent invoice with something due." };
  const total = r2(Number(cn.amount) + Number(cn.taxAmount));
  if (total > Number(inv.amountDue) + 0.005) return { ok: false, message: `The credit (₹${total.toLocaleString("en-IN")}) is more than the ₹${Number(inv.amountDue).toLocaleString("en-IN")} due.` };
  const entity = inv.billingEntityId ? await prisma.legalEntity.findFirst({ where: { tenantId, id: inv.billingEntityId } }) : await prisma.legalEntity.findFirst({ where: { tenantId } });
  const kind = gst(100, stateCode(entity?.state), cn.client.countryCode === "IN" ? stateCode(cn.client.state) : null).kind;
  const tax = Number(cn.taxAmount);
  const legs = [
    { accountCode: "4100", debit: Number(cn.amount), credit: 0, narration: "Revenue reversed" },
    ...(tax > 0 && kind === "INTRA" ? [{ accountCode: "2300", debit: r2(tax / 2), credit: 0, narration: "CGST" }, { accountCode: "2310", debit: r2(tax - r2(tax / 2)), credit: 0, narration: "SGST" }] : []),
    ...(tax > 0 && kind !== "INTRA" ? [{ accountCode: "2320", debit: tax, credit: 0, narration: "IGST" }] : []),
    { accountCode: "1200", debit: 0, credit: total, narration: inv.invoiceNumber },
  ].map((l) => ({ ...l, projectId: inv.projectId }));
  const posted = await postEntry({ tenantId, date: new Date(), source: "INVOICE", ref: { type: "CreditNote", id: cn.id }, postedBy: byUserId, narration: `${cn.number} against ${inv.invoiceNumber} — ${cn.client.name}`, lines: legs });
  if (!posted.ok) return posted;
  const left = r2(Number(inv.amountDue) - total);
  await prisma.$transaction([
    prisma.creditNote.update({ where: { id: cn.id }, data: { status: "APPLIED", appliedAt: new Date(), invoiceId: inv.id } }),
    prisma.invoice.update({ where: { id: inv.id }, data: { amountDue: left, status: left <= 0 ? "PAID" : "PARTIALLY_PAID" } }),
  ]);
  return { ok: true, message: `${cn.number} applied to ${inv.invoiceNumber}.` };
}

export async function voidCreditNote(tenantId: string, creditNoteId: string): Promise<Result> {
  const cn = await prisma.creditNote.findFirst({ where: { tenantId, id: creditNoteId } });
  if (!cn) return { ok: false, message: "Credit note not found." };
  if (cn.status !== "OPEN") return { ok: false, message: "Only an open credit note can be voided." };
  await prisma.creditNote.update({ where: { id: cn.id }, data: { status: "VOID" } });
  return { ok: true, message: `${cn.number} voided.` };
}

// ---- Rate cards ----------------------------------------------------------------------

export async function saveRateCard(tenantId: string, i: { name: string; currency: string; rateUnit: string; clientId?: string | null }, id?: string | null): Promise<Result> {
  const name = i.name.trim();
  if (!name) return { ok: false, message: "Name the rate card." };
  if (!["HOURLY", "DAILY"].includes(i.rateUnit)) return { ok: false, message: "Rate unit is hourly or daily." };
  if (!/^[A-Z]{3}$/.test(i.currency)) return { ok: false, message: "Use a currency code like INR." };
  if (i.clientId && !(await prisma.client.count({ where: { tenantId, id: i.clientId } }))) return { ok: false, message: "Client not found." };
  if (await prisma.rateCard.count({ where: { tenantId, name, ...(id ? { NOT: { id } } : {}) } })) return { ok: false, message: `${name} already exists.` };
  if (id) {
    const c = await prisma.rateCard.findFirst({ where: { tenantId, id } });
    if (!c) return { ok: false, message: "Rate card not found." };
    await prisma.rateCard.update({ where: { id: c.id }, data: { name, currency: i.currency, rateUnit: i.rateUnit, clientId: i.clientId ?? null } });
    return { ok: true, message: "Rate card saved.", id: c.id };
  }
  const c = await prisma.rateCard.create({ data: { tenantId, name, currency: i.currency, rateUnit: i.rateUnit, clientId: i.clientId ?? null } });
  return { ok: true, message: `${name} created.`, id: c.id };
}

export async function saveRoleRate(tenantId: string, rateCardId: string, i: { billingRole: string; billRate: number; rateCategory?: string | null; suggestedCost?: number | null }, rateId?: string | null): Promise<Result> {
  const card = await prisma.rateCard.findFirst({ where: { tenantId, id: rateCardId } });
  if (!card) return { ok: false, message: "Rate card not found." };
  const role = await prisma.billingRole.findFirst({ where: { tenantId, name: i.billingRole } });
  if (!role) return { ok: false, message: "Choose a billing role." };
  if (!(i.billRate > 0)) return { ok: false, message: "Enter the bill rate." };
  if (i.suggestedCost !== null && i.suggestedCost !== undefined && i.suggestedCost < 0) return { ok: false, message: "Cost cannot be negative." };
  const category = i.rateCategory?.trim() || "STANDARD";
  const clash = await prisma.billingRate.findFirst({ where: { rateCardId: card.id, billingRole: role.name, rateCategory: category, ...(rateId ? { NOT: { id: rateId } } : {}) } });
  if (clash) return { ok: false, message: `${role.name} (${category === "STANDARD" ? "no category" : category}) already has a rate on this card.` };
  const data = { billingRole: role.name, rateCategory: category, billRate: r2(i.billRate), suggestedCost: i.suggestedCost ?? null };
  if (rateId) {
    const r = await prisma.billingRate.findFirst({ where: { id: rateId, rateCardId: card.id } });
    if (!r) return { ok: false, message: "Rate not found." };
    await prisma.billingRate.update({ where: { id: r.id }, data });
  } else await prisma.billingRate.create({ data: { ...data, rateCardId: card.id } });
  const m = markupPct(i.billRate, i.suggestedCost);
  return { ok: true, message: `${role.name} at ₹${i.billRate.toLocaleString("en-IN")}/hr${m === null ? "" : ` (markup ${m}%)`}.` };
}

export async function deleteRoleRate(tenantId: string, rateId: string): Promise<Result> {
  const r = await prisma.billingRate.findFirst({ where: { id: rateId, rateCard: { tenantId } } });
  if (!r) return { ok: false, message: "Rate not found." };
  await prisma.billingRate.delete({ where: { id: r.id } });
  return { ok: true, message: `${r.billingRole} removed.` };
}

export async function saveBillingEntitySetting(tenantId: string, legalEntityId: string, i: { invoicePrefix: string; invoiceSuffix?: string | null; nextInvoiceNumber: number; proformaPrefix: string; nextProformaNumber: number; creditNotePrefix: string; nextCreditNoteNumber: number; defaultPaymentTermDays: number; bankDetails?: string | null; footer?: string | null }): Promise<Result> {
  const le = await prisma.legalEntity.findFirst({ where: { tenantId, id: legalEntityId } });
  if (!le) return { ok: false, message: "Billing entity not found." };
  if (!i.invoicePrefix.trim() || !i.proformaPrefix.trim() || !i.creditNotePrefix.trim()) return { ok: false, message: "Give each document a prefix." };
  if ([i.nextInvoiceNumber, i.nextProformaNumber, i.nextCreditNoteNumber].some((n) => !(Number.isInteger(n) && n >= 1))) return { ok: false, message: "Next numbers start at 1." };
  if (!(i.defaultPaymentTermDays >= 0 && i.defaultPaymentTermDays <= 365)) return { ok: false, message: "Payment term is 0 to 365 days." };
  const data = { invoicePrefix: i.invoicePrefix.trim(), invoiceSuffix: i.invoiceSuffix?.trim() || null, nextInvoiceNumber: i.nextInvoiceNumber, proformaPrefix: i.proformaPrefix.trim(), nextProformaNumber: i.nextProformaNumber, creditNotePrefix: i.creditNotePrefix.trim(), nextCreditNoteNumber: i.nextCreditNoteNumber, defaultPaymentTermDays: i.defaultPaymentTermDays, bankDetails: i.bankDetails ?? null, footer: i.footer ?? null };
  await prisma.billingEntitySetting.upsert({ where: { legalEntityId: le.id }, create: { ...data, tenantId, legalEntityId: le.id }, update: data });
  return { ok: true, message: `${le.name} is ready for project billing.` };
}
