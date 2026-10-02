"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  markInvoiceSent, writeOffInvoice, cancelInvoice, convertProforma, raiseCreditNote, applyCreditNote, voidCreditNote,
  generateCharges, generateAllCharges, addAdhocCharge, draftInvoiceFromCharges, saveRateCard, saveRoleRate, deleteRoleRate,
  saveBillingEntitySetting, saveRetainer, chargeExpenseToProject, unchargeExpense,
} from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import {
  z, parseForm, writeAudit, toErrorState, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zId, zOptionalId, zEmail, zBool, type ActionState,
} from "@/lib/forms";

/**
 * Project billing: invoice write-offs, cancellations and proforma conversion,
 * credit notes, charges and invoices drafted from them, rate cards, billing
 * entities, retainers and expenses charged to projects.
 */

const BILLING = ["/projects/billing", "/projects/billing/charges", "/projects/billing/credit-notes", "/projects/billing/payments", "/projects"];
type Res = { ok: boolean; message: string; id?: string };
const fail = (r: Res): ActionState => ({ ok: false, message: r.message });

export async function invoiceOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const id = String(formData.get("invoiceId") ?? "");
  const op = String(formData.get("op") ?? "");
  const inv = await prisma.invoice.findFirst({ where: { id, tenantId: viewer.tenantId }, select: { id: true, invoiceNumber: true, projectId: true } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  const reason = String(formData.get("reason") ?? "").trim();
  const dateRaw = String(formData.get("date") ?? "");
  try {
    const res: Res = op === "markSent" ? await markInvoiceSent(viewer.tenantId, id, viewer.user.id)
      : op === "writeOff" ? await writeOffInvoice(viewer.tenantId, id, { date: /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? new Date(`${dateRaw}T00:00:00Z`) : new Date(), reason }, viewer.user.id)
        : op === "cancel" ? await cancelInvoice(viewer.tenantId, id, reason, viewer.user.id)
          : op === "convert" ? await convertProforma(viewer.tenantId, id)
            : { ok: false, message: "Unknown action." };
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: op === "cancel" ? "DELETE" : op === "convert" ? "CREATE" : "UPDATE", entityType: "Invoice", entityId: res.id ?? id, summary: `${inv.invoiceNumber} ${op}: ${res.message}` });
    return done([...BILLING, `/projects/billing/${id}`, ...(res.id ? [`/projects/billing/${res.id}`] : []), ...(inv.projectId ? [`/projects/${inv.projectId}`, `/projects/${inv.projectId}/billing`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}

const raiseSchema = z.object({
  clientId: zId(), invoiceId: zOptionalId(), amount: zRequiredNumber({ min: 0.01 }), taxAmount: zNumber({ min: 0 }), reason: zName(500), issueDate: zRequiredDate(),
});

export async function creditNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const op = String(formData.get("op") ?? "raise");
  try {
    let res: Res;
    if (op === "raise") {
      const parsed = parseForm(raiseSchema, formData);
      if (parsed.state) return parsed.state;
      const d = parsed.data;
      res = await raiseCreditNote(viewer.tenantId, { ...d, taxAmount: d.taxAmount ?? 0 }, viewer.user.id);
      // Raised from an invoice and asked to: apply it there straight away.
      if (res.ok && res.id && d.invoiceId && formData.get("applyNow") === "on") {
        const applied = await applyCreditNote(viewer.tenantId, res.id, d.invoiceId, viewer.user.id);
        res = applied.ok ? { ...res, message: `${res.message} ${applied.message}` } : { ok: true, id: res.id, message: `${res.message} Not applied: ${applied.message}` };
      }
    } else {
      const cnId = String(formData.get("creditNoteId") ?? "");
      res = op === "apply" ? await applyCreditNote(viewer.tenantId, cnId, String(formData.get("invoiceId") ?? ""), viewer.user.id)
        : op === "void" ? await voidCreditNote(viewer.tenantId, cnId)
          : { ok: false, message: "Unknown action." };
    }
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: op === "raise" ? "CREATE" : "UPDATE", entityType: "CreditNote", entityId: res.id ?? String(formData.get("creditNoteId") ?? ""), summary: res.message });
    const invoiceId = String(formData.get("invoiceId") ?? "");
    return done([...BILLING, ...(invoiceId ? [`/projects/billing/${invoiceId}`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}

const adhocSchema = z.object({ projectId: zId(), name: zName(200), amount: zRequiredNumber({ min: 0.01 }), date: zRequiredDate() });
const draftSchema = z.object({
  invoiceDate: zRequiredDate(), paymentTermDays: zNumber({ min: 0, max: 365 }), dueDate: zDate(), poNumber: zOptional(60), attentionName: zOptional(120),
  attentionEmail: zEmail(), billingEntityId: zOptionalId(), notes: zOptional(1000), documentTitle: zOptional(60), proforma: zBool(),
});

export async function chargeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const op = String(formData.get("op") ?? "");
  try {
    if (op === "generate") {
      const projectId = String(formData.get("projectId") ?? "");
      if (projectId) {
        if (!(await prisma.project.count({ where: { id: projectId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Project not found." };
        const g = await generateCharges(viewer.tenantId, projectId);
        return done([...BILLING, `/projects/${projectId}/billing`], `Charges up to date: ${g.created} new, ${g.updated} changed, ${g.removed} removed.`);
      }
      const created = await generateAllCharges(viewer.tenantId);
      return done(BILLING, `Charges up to date: ${created} new.`);
    }
    if (op === "adhoc") {
      const parsed = parseForm(adhocSchema, formData);
      if (parsed.state) return parsed.state;
      const res = await addAdhocCharge(viewer.tenantId, parsed.data.projectId, parsed.data);
      if (!res.ok) return fail(res);
      await writeAudit(viewer, { module: "PROJECTS", action: "CREATE", entityType: "ProjectCharge", entityId: res.id, summary: res.message });
      return done([...BILLING, `/projects/${parsed.data.projectId}/billing`], res.message);
    }
    if (op === "draft") {
      const parsed = parseForm(draftSchema, formData);
      if (parsed.state) return parsed.state;
      const d = parsed.data;
      const chargeIds = formData.getAll("chargeId").map(String).filter(Boolean);
      // An unset term falls back to the billing entity's default, then 30 days.
      const setting = d.billingEntityId ? await prisma.billingEntitySetting.findFirst({ where: { tenantId: viewer.tenantId, legalEntityId: d.billingEntityId } }) : null;
      const res = await draftInvoiceFromCharges(viewer.tenantId, chargeIds, {
        documentTitle: d.documentTitle ?? undefined, invoiceDate: d.invoiceDate, paymentTermDays: d.paymentTermDays ?? setting?.defaultPaymentTermDays ?? 30, dueDate: d.dueDate,
        poNumber: d.poNumber, attentionName: d.attentionName, attentionEmail: d.attentionEmail, billingEntityId: d.billingEntityId, notes: d.notes,
      }, { proforma: d.proforma });
      if (!res.ok) return fail(res);
      await writeAudit(viewer, { module: "PROJECTS", action: "CREATE", entityType: "Invoice", entityId: res.id, summary: res.message });
      return done([...BILLING, ...(res.id ? [`/projects/billing/${res.id}`] : [])], res.message);
    }
    return { ok: false, message: "Unknown action." };
  } catch (err) { return toErrorState(err); }
}

const cardSchema = z.object({ id: zOptionalId(), name: zName(80), currency: z.string().regex(/^[A-Z]{3}$/, "Use a code like INR").default("INR"), rateUnit: z.enum(["HOURLY", "DAILY"]).default("HOURLY"), clientId: zOptionalId() });

export async function rateCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RATE_CARD_MANAGE);
  const parsed = parseForm(cardSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  const res = await saveRateCard(viewer.tenantId, d, id);
  if (!res.ok) return fail(res);
  await writeAudit(viewer, { module: "PROJECTS", action: id ? "UPDATE" : "CREATE", entityType: "RateCard", entityId: res.id, summary: res.message });
  return done(["/projects/settings/rate-cards"], res.message);
}

const rateSchema = z.object({ rateCardId: zId(), rateId: zOptionalId(), billingRole: zName(60), billRate: zRequiredNumber({ min: 0.01 }), rateCategory: zOptional(40), suggestedCost: zNumber({ min: 0 }) });

export async function roleRateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RATE_CARD_MANAGE);
  if (formData.get("op") === "delete") {
    const rateId = String(formData.get("rateId") ?? "");
    const res = await deleteRoleRate(viewer.tenantId, rateId);
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: "DELETE", entityType: "BillingRate", entityId: rateId, summary: res.message });
    return done(["/projects/settings/rate-cards"], res.message);
  }
  const parsed = parseForm(rateSchema, formData);
  if (parsed.state) return parsed.state;
  const { rateCardId, rateId, ...d } = parsed.data;
  const res = await saveRoleRate(viewer.tenantId, rateCardId, d, rateId);
  if (!res.ok) return fail(res);
  await writeAudit(viewer, { module: "PROJECTS", action: rateId ? "UPDATE" : "CREATE", entityType: "BillingRate", entityId: rateCardId, summary: res.message });
  return done(["/projects/settings/rate-cards"], res.message);
}

const entitySchema = z.object({
  legalEntityId: zId(), invoicePrefix: zName(20), invoiceSuffix: zOptional(20), nextInvoiceNumber: zRequiredNumber({ min: 1 }),
  proformaPrefix: zName(20), nextProformaNumber: zRequiredNumber({ min: 1 }), creditNotePrefix: zName(20), nextCreditNoteNumber: zRequiredNumber({ min: 1 }),
  defaultPaymentTermDays: zRequiredNumber({ min: 0, max: 365 }), bankDetails: zOptional(1000), footer: zOptional(1000),
});

export async function billingEntityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BILLING_MANAGE);
  const parsed = parseForm(entitySchema, formData);
  if (parsed.state) return parsed.state;
  const { legalEntityId, ...d } = parsed.data;
  const res = await saveBillingEntitySetting(viewer.tenantId, legalEntityId, d);
  if (!res.ok) return fail(res);
  await writeAudit(viewer, { module: "PROJECTS", action: "UPDATE", entityType: "BillingEntitySetting", entityId: legalEntityId, summary: res.message });
  return done(["/projects/settings/billing-entities", "/projects/billing/charges"], res.message);
}

const retainerSchema = z.object({ projectId: zId(), fee: zRequiredNumber({ min: 0.01 }), from: zRequiredDate() });

export async function retainerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const parsed = parseForm(retainerSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    const res = await saveRetainer(viewer.tenantId, d.projectId, d);
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: "UPDATE", entityType: "Project", entityId: d.projectId, summary: res.message });
    return done([`/projects/${d.projectId}`, `/projects/${d.projectId}/billing`, ...BILLING], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function expenseChargeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const claimId = String(formData.get("claimId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const before = await prisma.expenseClaim.findFirst({ where: { id: claimId, tenantId: viewer.tenantId }, select: { projectId: true } });
  try {
    const res = formData.get("op") === "uncharge" ? await unchargeExpense(viewer.tenantId, claimId)
      : projectId ? await chargeExpenseToProject(viewer.tenantId, claimId, projectId) : { ok: false, message: "Choose the project to charge." };
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: "UPDATE", entityType: "ExpenseClaim", entityId: claimId, summary: res.message });
    const touched = [...new Set([before?.projectId, projectId].filter((x): x is string => !!x))];
    return done([...BILLING, ...touched.map((p) => `/projects/${p}/billing`)], res.message);
  } catch (err) { return toErrorState(err); }
}
