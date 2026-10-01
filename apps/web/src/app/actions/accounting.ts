"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { postEntry, reverseEntry, postPayrollRun, recordSalaryPayment, setPeriodClosed, ensureChart, normalSide } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { z, parseForm, toErrorState, writeAudit, actionDone as done, zName, zOptional, zId, zRequiredDate, zRequiredNumber, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;
const PATHS = ["/accounting"];

/** Rows arrive as account_<i>, debit_<i>, credit_<i>, note_<i>. */
export async function postJournalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEDGER_POST);
  const date = String(formData.get("date") ?? "");
  const narration = String(formData.get("narration") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: "Choose the entry date.", errors: { date: "Required" } };
  if (!narration) return { ok: false, message: "Say what the entry is for.", errors: { narration: "Required" } };
  const rows = [...new Set([...formData.keys()].map((k) => /^account_(\d+)$/.exec(k)?.[1]).filter((x): x is string => !!x))];
  const lines = rows
    .map((r) => ({ accountId: String(formData.get(`account_${r}`) ?? ""), debit: Number(formData.get(`debit_${r}`) || 0), credit: Number(formData.get(`credit_${r}`) || 0), narration: String(formData.get(`note_${r}`) ?? "") || null }))
    .filter((l) => l.accountId && (l.debit || l.credit));
  if (lines.some((l) => !Number.isFinite(l.debit) || !Number.isFinite(l.credit))) return { ok: false, message: "Amounts must be numbers." };
  try {
    // postEntry resolves every account inside the viewer's tenant.
    const r = await postEntry({ tenantId: viewer.tenantId, date: new Date(`${date}T00:00:00Z`), narration, source: "MANUAL", lines, postedBy: viewer.user.id });
    if (r.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "LedgerEntry", entityId: r.entryId, summary: `${r.message} ${narration}` });
    return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
  } catch (err) { return toErrorState(err); }
}

export async function reverseEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEDGER_REVERSE);
  const entryId = String(formData.get("entryId") ?? "");
  const r = await reverseEntry({ tenantId: viewer.tenantId, entryId, reason: String(formData.get("reason") ?? ""), byUserId: viewer.user.id });
  if (r.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "LedgerEntry", entityId: entryId, summary: r.message });
  return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
}

const accountSchema = z.object({
  parentId: zId(), code: z.string().trim().regex(/^\d{3,6}$/, "3–6 digits"), name: zName(120), description: zOptional(300),
  bankName: zOptional(80), accountNumber: zOptional(30), ifsc: zOptional(11),
});

export async function saveAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ACCOUNT_MANAGE);
  const parsed = parseForm(accountSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  // A new account lives under one of the tenant's own group headings and
  // takes its class — an expense group never holds a liability.
  const parent = await prisma.account.findFirst({ where: { id: d.parentId, tenantId: viewer.tenantId, isGroup: true } });
  if (!parent) return { ok: false, message: "Choose a group to put the account under.", errors: { parentId: "Required" } };
  if (!d.code.startsWith(parent.code[0])) return { ok: false, message: `${parent.name} accounts are numbered ${parent.code[0]}xxx.`, errors: { code: `Start with ${parent.code[0]}` } };
  try {
    const a = await prisma.account.create({
      data: {
        tenantId: viewer.tenantId, parentId: parent.id, code: d.code, name: d.name, description: d.description, accountClass: parent.accountClass,
        normalSide: normalSide(parent.accountClass), isBankAccount: !!d.accountNumber, bankName: d.bankName, accountNumber: d.accountNumber, ifsc: d.ifsc?.toUpperCase() ?? null,
      },
    });
    await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "Account", entityId: a.id, summary: `Account ${a.code} ${a.name}` });
    return done(PATHS, `Added ${a.code} ${a.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

export async function setAccountActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ACCOUNT_MANAGE);
  const id = String(formData.get("accountId") ?? "");
  const active = formData.get("active") === "true";
  const a = await prisma.account.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Account not found." };
  if (a.isSystem && !active) return { ok: false, message: "Payroll and invoices post to this account; it cannot be switched off." };
  if (!active && Number(a.currentBalance) !== 0) return { ok: false, message: `${a.name} still carries a balance. Clear it first.` };
  await prisma.account.update({ where: { id }, data: { isActive: active } });
  return done(PATHS, active ? "Reactivated." : "Deactivated.");
}

export async function periodAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PERIOD_CLOSE);
  const code = String(formData.get("code") ?? "");
  const close = formData.get("op") === "close";
  const r = await setPeriodClosed(viewer.tenantId, code, close, viewer.user.id);
  if (r.ok) await writeAudit(viewer, { module: "FINANCE", action: close ? "LOCK" : "UNLOCK", entityType: "AccountingPeriod", entityId: code, summary: r.message });
  return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
}

/** Runs that pre-date the ledger, or whose period was closed when they finalised. */
export async function postPayrollAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEDGER_POST);
  const runId = String(formData.get("runId") ?? "");
  if (!(await prisma.payrollRun.count({ where: { id: runId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Payroll run not found." };
  await ensureChart(viewer.tenantId);
  const r = await postPayrollRun(runId, viewer.user.id);
  return r.ok ? done([...PATHS, `/payroll/runs/${runId}`], r.message) : { ok: false, message: r.message };
}

const paySchema = z.object({ runId: zId(), date: zRequiredDate(), reference: zOptional(60) });

export async function salaryPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEDGER_POST);
  const parsed = parseForm(paySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await prisma.payrollRun.count({ where: { id: d.runId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Payroll run not found." };
  const r = await recordSalaryPayment(d.runId, { byUserId: viewer.user.id, date: d.date, reference: d.reference });
  if (r.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "LedgerEntry", entityId: r.entryId, summary: `Salary payment: ${r.message}` });
  return r.ok ? done([...PATHS, `/payroll/runs/${d.runId}`], r.message) : { ok: false, message: r.message };
}

const DUES = new Set(["2200", "2210", "2220", "2230", "2240", "2250", "2300", "2310", "2320"]);
const remitSchema = z.object({ accountCode: z.string(), amount: zRequiredNumber({ min: 0.01 }), date: zRequiredDate(), reference: zOptional(60) });

/** Paying a statutory due (a PF challan, TDS, GST) out of the bank. */
export async function remitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.LEDGER_POST);
  const parsed = parseForm(remitSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!DUES.has(d.accountCode)) return { ok: false, message: "Choose a statutory due." };
  const chart = await ensureChart(viewer.tenantId);
  const due = await prisma.account.findUniqueOrThrow({ where: { id: chart.get(d.accountCode)! } });
  const owed = Number(due.currentBalance);
  if (d.amount > owed + 0.005) return { ok: false, message: `Only ₹${owed.toLocaleString("en-IN")} is owed on ${due.name}.`, errors: { amount: "More than is due" } };
  const r = await postEntry({
    tenantId: viewer.tenantId, date: d.date, source: "PAYMENT", postedBy: viewer.user.id,
    narration: `${due.name} paid${d.reference ? ` — ${d.reference}` : ""}`,
    lines: [{ accountCode: d.accountCode, debit: d.amount, credit: 0 }, { accountCode: "1100", debit: 0, credit: d.amount }],
  });
  if (r.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "LedgerEntry", entityId: r.entryId, summary: `Remitted ${due.name}: ${r.message}` });
  return r.ok ? done(PATHS, r.message) : { ok: false, message: r.message };
}
