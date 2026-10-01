import { prisma } from "@keka/db";
import { renderLetter } from "@keka/documents";
import { weekStart, checkTimesheet, gst, projectHealth } from "./projects-math";
import { notify } from "./lifecycle";
import { postInvoice, postInvoicePayment } from "./accounting";

/**
 * Projects, timesheets and billing. Time can be logged only against projects
 * the person is allocated to; approved billable time becomes invoice lines at
 * the rate in force when it was logged; invoices carry GST by place of supply.
 */

type Result = { ok: boolean; message: string };
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

const STATES: Record<string, string> = {
  karnataka: "KA", maharashtra: "MH", "tamil nadu": "TN", delhi: "DL", telangana: "TS", gujarat: "GJ", "west bengal": "WB",
  "uttar pradesh": "UP", kerala: "KL", haryana: "HR", rajasthan: "RJ", "andhra pradesh": "AP", punjab: "PB", goa: "GA",
};
/** A state as its two-letter code, whether given as a code or a name. */
export function stateCode(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 2 ? t.toUpperCase() : STATES[t.toLowerCase()] ?? t.toUpperCase();
}

export interface SheetEntry { projectId: string; taskId?: string | null; date: Date; hours: number; description?: string | null }

export async function saveTimesheet(input: { employeeId: string; week: Date; entries: SheetEntry[]; submit: boolean }): Promise<Result & { timesheetId?: string }> {
  const week = weekStart(input.week);
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: input.employeeId }, select: { tenantId: true, displayName: true, reportingManagerId: true } });
  const existing = await prisma.timesheet.findUnique({ where: { employeeId_periodStart: { employeeId: input.employeeId, periodStart: week } } });
  if (existing && !["DRAFT", "REJECTED"].includes(existing.status)) return { ok: false, message: `This week is ${existing.status.toLowerCase()} and can no longer be edited.` };
  const issues = checkTimesheet(input.entries, week);
  if (issues.length) return { ok: false, message: issues.join(" ") };

  // Only allocated projects, and the rate the allocation carried on that day.
  const allocations = await prisma.resourceAllocation.findMany({ where: { employeeId: input.employeeId, projectId: { in: [...new Set(input.entries.map((e) => e.projectId))] } }, include: { project: { select: { name: true, status: true } } } });
  for (const e of input.entries) {
    const a = allocations.find((x) => x.projectId === e.projectId && x.startDate <= e.date && (!x.endDate || x.endDate >= e.date));
    if (!a) return { ok: false, message: `You are not allocated to that project on ${e.date.toISOString().slice(0, 10)}.` };
    if (["COMPLETED", "CANCELLED"].includes(a.project.status)) return { ok: false, message: `${a.project.name} is closed to new time.` };
  }
  // A task must belong to the project its hours are logged against.
  const taskIds = [...new Set(input.entries.map((e) => e.taskId).filter((t): t is string => !!t))];
  const tasks = new Map((await prisma.task.findMany({ where: { id: { in: taskIds }, tenantId: emp.tenantId }, select: { id: true, projectId: true } })).map((t) => [t.id, t.projectId]));
  if (input.entries.some((e) => e.taskId && tasks.get(e.taskId) !== e.projectId)) return { ok: false, message: "A task does not belong to the project it is logged against." };
  const rateOf = (e: SheetEntry) => allocations.find((x) => x.projectId === e.projectId && x.startDate <= e.date && (!x.endDate || x.endDate >= e.date))!;
  const total = r2(input.entries.reduce((s, e) => s + e.hours, 0));
  const billable = r2(input.entries.filter((e) => rateOf(e).isBillable).reduce((s, e) => s + e.hours, 0));

  const sheet = await prisma.$transaction(async (tx) => {
    const s = existing
      ? await tx.timesheet.update({ where: { id: existing.id }, data: { status: input.submit ? "SUBMITTED" : "DRAFT", submittedAt: input.submit ? new Date() : null, totalHours: total, billableHours: billable, rejectReason: null } })
      : await tx.timesheet.create({ data: { tenantId: emp.tenantId, employeeId: input.employeeId, periodStart: week, periodEnd: new Date(week.getTime() + 6 * DAY), status: input.submit ? "SUBMITTED" : "DRAFT", submittedAt: input.submit ? new Date() : null, totalHours: total, billableHours: billable } });
    await tx.timeEntry.deleteMany({ where: { timesheetId: s.id } });
    for (const e of input.entries) {
      const a = rateOf(e);
      await tx.timeEntry.create({ data: { tenantId: emp.tenantId, timesheetId: s.id, employeeId: input.employeeId, projectId: e.projectId, taskId: e.taskId ?? null, date: e.date, hours: e.hours, description: e.description ?? null, isBillable: a.isBillable, billRate: a.billRate, costRate: a.costRate } });
    }
    return s;
  });
  await recomputeTaskHours(input.entries.map((e) => e.taskId).filter((t): t is string => !!t));
  if (input.submit) {
    // Whoever can approve it: the line manager and each project's manager.
    const mgr = emp.reportingManagerId ? await prisma.employee.findUnique({ where: { id: emp.reportingManagerId }, select: { userId: true } }) : null;
    const pms = await prisma.project.findMany({ where: { id: { in: [...new Set(input.entries.map((e) => e.projectId))] } }, select: { projectManager: { select: { userId: true } } } });
    await notify({ tenantId: emp.tenantId, userIds: [...new Set([mgr?.userId, ...pms.map((p) => p.projectManager?.userId)])], kind: "TIMESHEET", title: `${emp.displayName} submitted ${total} h for the week of ${week.toISOString().slice(0, 10)}`, link: "/projects?tab=approvals" });
  }
  return { ok: true, message: `${total} h ${input.submit ? "submitted for approval" : "saved"} (${billable} billable).`, timesheetId: sheet.id };
}

async function recomputeTaskHours(taskIds: string[]) {
  for (const id of new Set(taskIds)) {
    const agg = await prisma.timeEntry.aggregate({ where: { taskId: id }, _sum: { hours: true } });
    await prisma.task.update({ where: { id }, data: { loggedHours: agg._sum.hours ?? 0 } });
  }
}

export async function decideTimesheet(opts: { timesheetId: string; approve: boolean; byUserId: string; reason?: string | null }): Promise<Result> {
  const s = await prisma.timesheet.findUnique({ where: { id: opts.timesheetId }, include: { employee: { select: { userId: true } } } });
  if (!s) return { ok: false, message: "Timesheet not found." };
  if (s.status !== "SUBMITTED") return { ok: false, message: `This timesheet is ${s.status.toLowerCase()}.` };
  if (!opts.approve && !opts.reason) return { ok: false, message: "Say what needs fixing." };
  await prisma.timesheet.update({ where: { id: s.id }, data: opts.approve ? { status: "APPROVED", approvedBy: opts.byUserId, approvedAt: new Date() } : { status: "REJECTED", rejectReason: opts.reason, rejectedBy: opts.byUserId, rejectedAt: new Date() } });
  await notify({ tenantId: s.tenantId, userIds: [s.employee.userId], kind: "TIMESHEET", title: opts.approve ? "Your timesheet was approved" : "Your timesheet needs changes", body: opts.reason ?? undefined, link: "/projects" });
  return { ok: true, message: opts.approve ? "Approved." : "Sent back for changes." };
}

export async function refreshProjectHealth(projectId: string, today = new Date()): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, include: { milestones: true } });
  if (!p) return;
  const used = await prisma.timeEntry.aggregate({ where: { projectId }, _sum: { hours: true } });
  const overdue = p.milestones.filter((m) => !["COMPLETED", "INVOICED"].includes(m.status) && m.dueDate < today).length;
  const h = projectHealth({ start: p.startDate, end: p.endDate, budgetHours: p.estimatedHours === null ? null : Number(p.estimatedHours), hoursUsed: Number(used._sum.hours ?? 0), overdueMilestones: overdue }, today);
  await prisma.project.update({ where: { id: projectId }, data: { health: h.health } });
}

/**
 * Draft an invoice for a client project and period: approved, billable,
 * not-yet-invoiced time at the logged rates (time and material), or the
 * completed milestones (milestone billing).
 */
export async function draftInvoice(opts: { projectId: string; periodStart: Date; periodEnd: Date; dueInDays?: number }): Promise<Result & { invoiceId?: string }> {
  const p = await prisma.project.findUnique({ where: { id: opts.projectId }, include: { client: true, milestones: true } });
  if (!p?.client) return { ok: false, message: "Invoices need a client project." };
  if (p.billingModel === "NON_BILLABLE") return { ok: false, message: "This project is not billable." };
  const lines: Array<{ description: string; lineType: string; quantity: number; unitRate: number; amount: number; milestoneId?: string }> = [];
  let entryIds: string[] = [];
  if (p.billingModel === "MILESTONE") {
    for (const m of p.milestones.filter((x) => x.status === "COMPLETED" && x.amount)) lines.push({ description: `Milestone: ${m.name}`, lineType: "MILESTONE", quantity: 1, unitRate: Number(m.amount), amount: Number(m.amount), milestoneId: m.id });
  } else if (p.billingModel === "RETAINER") {
    if (p.retainerFee) lines.push({ description: `Retainer ${opts.periodStart.toISOString().slice(0, 7)}`, lineType: "RETAINER", quantity: 1, unitRate: Number(p.retainerFee), amount: Number(p.retainerFee) });
  } else {
    const entries = await prisma.timeEntry.findMany({
      where: { projectId: p.id, isBillable: true, isInvoiced: false, date: { gte: opts.periodStart, lte: opts.periodEnd }, timesheet: { status: { in: ["APPROVED", "LOCKED"] } } },
    });
    const emps = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.employeeId))] } }, select: { id: true, displayName: true } })).map((e) => [e.id, e.displayName]));
    const byPersonRate = new Map<string, { hours: number; rate: number; who: string }>();
    for (const e of entries) {
      const rate = Number(e.billRate ?? 0);
      const k = `${e.employeeId}:${rate}`;
      const cur = byPersonRate.get(k) ?? { hours: 0, rate, who: emps.get(e.employeeId) ?? "" };
      cur.hours = r2(cur.hours + Number(e.hours));
      byPersonRate.set(k, cur);
    }
    for (const v of byPersonRate.values()) lines.push({ description: `${v.who} — professional services`, lineType: "HOURS", quantity: v.hours, unitRate: v.rate, amount: r2(v.hours * v.rate) });
    entryIds = entries.map((e) => e.id);
  }
  if (lines.length === 0) return { ok: false, message: "Nothing to bill for that period — no approved billable time or completed milestones." };
  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  const entity = await prisma.legalEntity.findFirst({ where: { tenantId: p.tenantId } });
  const tax = gst(subtotal, stateCode(entity?.state), p.client.countryCode === "IN" ? stateCode(p.client.state) : null);
  const invoice = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${p.tenantId} FOR UPDATE`;
    const year = opts.periodEnd.getUTCFullYear();
    const count = await tx.invoice.count({ where: { tenantId: p.tenantId, invoiceNumber: { startsWith: `INV-${year}-` } } });
    const inv = await tx.invoice.create({
      data: {
        tenantId: p.tenantId, clientId: p.client!.id, projectId: p.id, invoiceNumber: `INV-${year}-${String(count + 1).padStart(4, "0")}`,
        issueDate: new Date(), dueDate: new Date(Date.now() + (opts.dueInDays ?? 30) * DAY), periodStart: opts.periodStart, periodEnd: opts.periodEnd,
        subtotal, taxTotal: tax.total, total: r2(subtotal + tax.total), amountDue: r2(subtotal + tax.total), currency: p.client!.currency,
        notes: tax.kind === "INTRA" ? `CGST 9% ₹${tax.cgst} + SGST 9% ₹${tax.sgst}` : tax.kind === "INTER" ? `IGST 18% ₹${tax.igst}` : "Export of services — zero-rated under LUT",
        lines: { create: lines.map((l, i) => ({ ...l, sequence: i, taxPercent: tax.kind === "EXPORT" ? 0 : 18, taxAmount: tax.kind === "EXPORT" ? 0 : r2((l.amount * 18) / 100) })) },
      },
    });
    if (entryIds.length) await tx.timeEntry.updateMany({ where: { id: { in: entryIds } }, data: { isInvoiced: true, invoiceId: inv.id } });
    const ms = lines.filter((l) => l.milestoneId).map((l) => l.milestoneId!);
    if (ms.length) await tx.milestone.updateMany({ where: { id: { in: ms } }, data: { status: "INVOICED" } });
    return inv;
  });
  return { ok: true, message: `${invoice.invoiceNumber} drafted: ₹${subtotal.toLocaleString("en-IN")} + GST ₹${tax.total.toLocaleString("en-IN")}.`, invoiceId: invoice.id };
}

/** Send: render the invoice, file it, email the client. */
export async function sendInvoice(invoiceId: string, save: (pdf: Buffer, filename: string) => Promise<string>): Promise<Result> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { client: true, lines: { orderBy: { sequence: "asc" } }, project: true } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (inv.status !== "DRAFT") return { ok: false, message: "Only a draft invoice can be sent." };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: inv.tenantId } });
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const money = (n: unknown) => `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  const pdf = renderLetter({
    company: { name: tenant.name }, date: fmt(inv.issueDate),
    to: [inv.client.name, ...(inv.client.addressLine1 ? [inv.client.addressLine1] : []), ...(inv.client.gstin ? [`GSTIN ${inv.client.gstin}`] : [])],
    subject: `Tax invoice ${inv.invoiceNumber}${inv.project ? ` — ${inv.project.name}` : ""}`,
    paragraphs: [`For services from ${inv.periodStart ? fmt(inv.periodStart) : "—"} to ${inv.periodEnd ? fmt(inv.periodEnd) : "—"}. Payment is due by ${fmt(inv.dueDate)}.`],
    table: [
      ...inv.lines.map((l) => [l.lineType === "HOURS" ? `${l.description} (${Number(l.quantity)} h @ ${money(l.unitRate)})` : l.description, money(l.amount)] as [string, string]),
      ["Subtotal", money(inv.subtotal)], [inv.notes ?? "Tax", money(inv.taxTotal)], ["Total due", money(inv.total)],
    ],
    signatory: { name: "Accounts receivable", title: tenant.name },
    footer: "Please quote the invoice number with your payment.",
  });
  const url = await save(pdf, `${inv.invoiceNumber}.pdf`);
  await prisma.invoice.update({ where: { id: inv.id }, data: { status: "SENT", sentAt: new Date(), fileUrl: url } });
  // Sending is when the revenue is earned in the books: the same GST split
  // the draft priced it with.
  const entity = await prisma.legalEntity.findFirst({ where: { tenantId: inv.tenantId } });
  const split = gst(Number(inv.subtotal), stateCode(entity?.state), inv.client.countryCode === "IN" ? stateCode(inv.client.state) : null);
  await postInvoice(inv.id, split);
  if (inv.client.contactEmail) {
    await prisma.emailOutbox.create({ data: { tenantId: inv.tenantId, toAddress: inv.client.contactEmail, subject: `Invoice ${inv.invoiceNumber} from ${tenant.name}`, textBody: `Please find invoice ${inv.invoiceNumber} for ${money(inv.total)}, due ${fmt(inv.dueDate)}.`, relatedType: "Invoice", relatedId: inv.id } });
  }
  return { ok: true, message: `Sent${inv.client.contactEmail ? ` to ${inv.client.contactEmail}` : ""}.` };
}

export async function recordInvoicePayment(opts: { invoiceId: string; amount: number; paidOn: Date; reference?: string | null }): Promise<Result> {
  const inv = await prisma.invoice.findUnique({ where: { id: opts.invoiceId } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (!["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status)) return { ok: false, message: "Payments are recorded against sent invoices." };
  const due = Number(inv.amountDue);
  if (!(opts.amount > 0) || opts.amount > due + 0.005) return { ok: false, message: `Enter an amount up to the ₹${due.toLocaleString("en-IN")} due.` };
  const paid = r2(Number(inv.amountPaid) + opts.amount), left = r2(Number(inv.total) - paid);
  const [payment] = await prisma.$transaction([
    prisma.invoicePayment.create({ data: { invoiceId: inv.id, amount: opts.amount, paidOn: opts.paidOn, reference: opts.reference ?? null } }),
    prisma.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, amountDue: left, status: left <= 0 ? "PAID" : "PARTIALLY_PAID" } }),
  ]);
  await postInvoicePayment(payment.id);
  return { ok: true, message: left <= 0 ? "Paid in full." : `₹${left.toLocaleString("en-IN")} still due.` };
}

export async function markOverdueInvoices(tenantId?: string): Promise<number> {
  const r = await prisma.invoice.updateMany({ where: { ...(tenantId ? { tenantId } : {}), status: { in: ["SENT", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() } }, data: { status: "OVERDUE" } });
  return r.count;
}

