import { prisma } from "@keka/db";
import { renderLetter } from "@keka/documents";
import { weekStart, checkTimesheet, gst, projectHealth } from "./projects-math";
import { notify } from "./lifecycle";
import { postInvoice, postInvoicePayment } from "./accounting";
import { getTimesheetPolicy } from "./timesheet-policy";
import { roundHours, firstApprover, nextApprover, autoApproves, type TimesheetApprover } from "./timesheet-policy-math";

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
  // The tenant's policy: time rounded to its increment (if it rounds), then checked against its limits.
  const policy = await getTimesheetPolicy(emp.tenantId);
  input = { ...input, entries: input.entries.map((e) => ({ ...e, hours: roundHours(e.hours, policy) })) };
  const issues = checkTimesheet(input.entries, week, new Date(), policy, { submit: input.submit });
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
  const projectIds = [...new Set(input.entries.map((e) => e.projectId))];
  const needApproval = (await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { requireTimesheetApproval: true } })).map((p) => p.requireTimesheetApproval);
  const auto = input.submit && autoApproves(policy, total, needApproval);
  const now = new Date();
  const awaiting = firstApprover(policy.approvalChain);
  const flow = !input.submit
    ? { status: "DRAFT" as const, submittedAt: null }
    : auto
      ? { status: "APPROVED" as const, submittedAt: now, approvedAt: now, approvedBy: null, autoApproved: true, awaiting: "EITHER" as const, approvalStep: 0, firstApprovedBy: null }
      : { status: "SUBMITTED" as const, submittedAt: now, autoApproved: false, awaiting, approvalStep: 0, firstApprovedBy: null };

  const sheet = await prisma.$transaction(async (tx) => {
    const s = existing
      ? await tx.timesheet.update({ where: { id: existing.id }, data: { ...flow, totalHours: total, billableHours: billable, rejectReason: null } })
      : await tx.timesheet.create({ data: { tenantId: emp.tenantId, employeeId: input.employeeId, periodStart: week, periodEnd: new Date(week.getTime() + 6 * DAY), ...flow, totalHours: total, billableHours: billable } });
    await tx.timeEntry.deleteMany({ where: { timesheetId: s.id } });
    for (const e of input.entries) {
      const a = rateOf(e);
      await tx.timeEntry.create({ data: { tenantId: emp.tenantId, timesheetId: s.id, employeeId: input.employeeId, projectId: e.projectId, taskId: e.taskId ?? null, date: e.date, hours: e.hours, description: e.description ?? null, isBillable: a.isBillable, billRate: a.billRate, costRate: a.costRate } });
    }
    return s;
  });
  await recomputeTaskHours(input.entries.map((e) => e.taskId).filter((t): t is string => !!t));
  if (input.submit && !auto) {
    // Whoever the chain says can approve it first: the line manager, each project's manager, or both.
    await notify({ tenantId: emp.tenantId, userIds: await approverUserIds(sheet.id, awaiting), kind: "TIMESHEET", title: `${emp.displayName} submitted ${total} h for the week of ${week.toISOString().slice(0, 10)}`, link: "/projects?tab=approvals" });
  }
  return { ok: true, message: `${total} h ${auto ? "submitted and approved automatically" : input.submit ? "submitted for approval" : "saved"} (${billable} billable).`, timesheetId: sheet.id };
}

/** Who can act on a sheet waiting at `awaiting`: the line manager, each project's manager, or both. */
async function approverUserIds(timesheetId: string, awaiting: TimesheetApprover): Promise<string[]> {
  const s = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: { employee: { select: { reportingManager: { select: { userId: true } } } }, entries: { select: { project: { select: { projectManager: { select: { userId: true } } } } } } } });
  const line = awaiting === "PROJECT_MANAGER" ? [] : [s.employee.reportingManager?.userId];
  const pms = awaiting === "LINE_MANAGER" ? [] : s.entries.map((e) => e.project.projectManager?.userId);
  return [...new Set([...line, ...pms].filter((u): u is string => !!u))];
}

async function recomputeTaskHours(taskIds: string[]) {
  for (const id of new Set(taskIds)) {
    const agg = await prisma.timeEntry.aggregate({ where: { taskId: id }, _sum: { hours: true } });
    await prisma.task.update({ where: { id }, data: { loggedHours: agg._sum.hours ?? 0 } });
  }
}

/**
 * Approve or send back a submitted sheet. Under a two-level chain the first
 * approval passes it to the project manager(s), and whoever approved the
 * first level cannot approve the second.
 */
export async function decideTimesheet(opts: { timesheetId: string; approve: boolean; byUserId: string; reason?: string | null }): Promise<Result> {
  const s = await prisma.timesheet.findUnique({ where: { id: opts.timesheetId }, include: { employee: { select: { userId: true, displayName: true } } } });
  if (!s) return { ok: false, message: "Timesheet not found." };
  if (s.status !== "SUBMITTED") return { ok: false, message: `This timesheet is ${s.status.toLowerCase()}.` };
  if (!opts.approve && !opts.reason) return { ok: false, message: "Say what needs fixing." };
  if (opts.approve && s.firstApprovedBy && s.firstApprovedBy === opts.byUserId) return { ok: false, message: "You approved the first level; the project manager approves the second." };
  if (opts.approve) {
    const policy = await getTimesheetPolicy(s.tenantId);
    const next = nextApprover(policy.approvalChain, s.awaiting, s.approvalStep);
    if (next) {
      // Guarded on the step so two approvers clicking at once cannot both advance it.
      const moved = await prisma.timesheet.updateMany({ where: { id: s.id, status: "SUBMITTED", approvalStep: s.approvalStep }, data: { awaiting: next, approvalStep: s.approvalStep + 1, firstApprovedBy: opts.byUserId } });
      if (!moved.count) return { ok: false, message: "Someone else just decided this timesheet." };
      await notify({ tenantId: s.tenantId, userIds: (await approverUserIds(s.id, next)).filter((u) => u !== opts.byUserId), kind: "TIMESHEET", title: `${s.employee.displayName}'s week of ${s.periodStart.toISOString().slice(0, 10)} is ready for your approval`, link: "/projects?tab=approvals" });
      return { ok: true, message: "Approved at the first level; now with the project manager." };
    }
  }
  await prisma.timesheet.update({
    where: { id: s.id },
    data: opts.approve
      ? { status: "APPROVED", approvedBy: opts.byUserId, approvedAt: new Date(), approvalStep: s.approvalStep + 1 }
      : { status: "REJECTED", rejectReason: opts.reason, rejectedBy: opts.byUserId, rejectedAt: new Date(), approvalStep: 0, firstApprovedBy: null },
  });
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
  const entity = await prisma.legalEntity.findFirst({ where: { tenantId: p.tenantId }, orderBy: { createdAt: "asc" } });
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
    // Each billed line is also a charge, invoiced, so Finances › Charges shows it.
    const taken = (await tx.projectCharge.findMany({ where: { tenantId: p.tenantId }, select: { number: true } })).reduce((m, c) => Math.max(m, Number(c.number.replace(/\D/g, "")) || 0), 0);
    const created = await tx.invoiceLine.findMany({ where: { invoiceId: inv.id }, orderBy: { sequence: "asc" } });
    await tx.projectCharge.createMany({
      data: created.map((l, i) => ({
        tenantId: p.tenantId, projectId: p.id, number: `CHR${taken + i + 1}`, name: l.description,
        kind: (l.lineType === "MILESTONE" ? "MILESTONE" : l.lineType === "RETAINER" ? "RETAINER" : "TIME") as "TIME",
        template: (l.lineType === "HOURS" ? "EMPLOYEE" : "NONE") as "NONE", periodStart: opts.periodStart, periodEnd: opts.periodEnd,
        quantity: l.quantity, amount: l.amount, currency: inv.currency, status: "INVOICED" as const, invoiceId: inv.id, sourceRefs: { key: `LINE:${l.id}` },
      })),
    });
    return inv;
  });
  return { ok: true, message: `${invoice.invoiceNumber} drafted: ₹${subtotal.toLocaleString("en-IN")} + GST ₹${tax.total.toLocaleString("en-IN")}.`, invoiceId: invoice.id };
}

/** Send: render the invoice, file it, email the client. */
export async function sendInvoice(invoiceId: string, save: (pdf: Buffer, filename: string) => Promise<string>): Promise<Result> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { client: true, lines: { orderBy: { sequence: "asc" } }, project: true } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (inv.status !== "DRAFT") return { ok: false, message: "Only a draft invoice can be sent." };
  const proforma = inv.kind === "PROFORMA";
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: inv.tenantId } });
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const money = (n: unknown) => `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  const pdf = renderLetter({
    company: { name: tenant.name }, date: fmt(inv.issueDate),
    to: [inv.client.name, ...(inv.client.addressLine1 ? [inv.client.addressLine1] : []), ...(inv.client.gstin ? [`GSTIN ${inv.client.gstin}`] : [])],
    subject: `${inv.documentTitle || "Tax invoice"} ${inv.invoiceNumber}${inv.project ? ` — ${inv.project.name}` : ""}`,
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
  // A proforma is a quote and never reaches the books.
  if (!proforma) {
    const entity = inv.billingEntityId
      ? await prisma.legalEntity.findFirst({ where: { tenantId: inv.tenantId, id: inv.billingEntityId } })
      : await prisma.legalEntity.findFirst({ where: { tenantId: inv.tenantId }, orderBy: { createdAt: "asc" } });
    const split = gst(Number(inv.subtotal), stateCode(entity?.state), inv.client.countryCode === "IN" ? stateCode(inv.client.state) : null);
    await postInvoice(inv.id, split);
  }
  if (inv.client.contactEmail) {
    await prisma.emailOutbox.create({ data: { tenantId: inv.tenantId, toAddress: inv.client.contactEmail, subject: `Invoice ${inv.invoiceNumber} from ${tenant.name}`, textBody: `Please find invoice ${inv.invoiceNumber} for ${money(inv.total)}, due ${fmt(inv.dueDate)}.`, relatedType: "Invoice", relatedId: inv.id } });
  }
  return { ok: true, message: `Sent${inv.client.contactEmail ? ` to ${inv.client.contactEmail}` : ""}.` };
}

export async function recordInvoicePayment(opts: { invoiceId: string; amount: number; paidOn: Date; reference?: string | null }): Promise<Result> {
  const inv = await prisma.invoice.findUnique({ where: { id: opts.invoiceId } });
  if (!inv) return { ok: false, message: "Invoice not found." };
  if (inv.kind === "PROFORMA") return { ok: false, message: "A proforma invoice is not paid; convert it to a tax invoice first." };
  if (!["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status)) return { ok: false, message: "Payments are recorded against sent invoices." };
  const due = Number(inv.amountDue);
  if (!(opts.amount > 0) || opts.amount > due + 0.005) return { ok: false, message: `Enter an amount up to the ₹${due.toLocaleString("en-IN")} due.` };
  // What is left comes off what was due, so an applied credit note stays counted.
  const paid = r2(Number(inv.amountPaid) + opts.amount), left = r2(due - opts.amount);
  const [payment] = await prisma.$transaction([
    prisma.invoicePayment.create({ data: { invoiceId: inv.id, amount: opts.amount, paidOn: opts.paidOn, reference: opts.reference ?? null } }),
    prisma.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, amountDue: left, status: left <= 0 ? "PAID" : "PARTIALLY_PAID" } }),
  ]);
  await postInvoicePayment(payment.id);
  return { ok: true, message: left <= 0 ? "Paid in full." : `₹${left.toLocaleString("en-IN")} still due.` };
}

export async function markOverdueInvoices(tenantId?: string): Promise<number> {
  // A proforma is a quote: nothing on it falls due.
  const r = await prisma.invoice.updateMany({ where: { ...(tenantId ? { tenantId } : {}), kind: "TAX", status: { in: ["SENT", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() } }, data: { status: "OVERDUE" } });
  return r.count;
}

