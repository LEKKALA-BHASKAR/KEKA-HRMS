import { prisma, type OpsApprovalRequest } from "@keka/db";
import { resolveStructure } from "@keka/payroll";
import { usersWithPermission, specsOf } from "./lifecycle";
import { releasePayslipsForRun } from "./payroll-close";
import { coverageReport, ptLwfReport } from "./payroll-depth";
import { getOpsSettings, opsAudit, opsAlertOnce, opsRequestApproval, type OpsActor } from "./ops-core";
import {
  opsRoundNet, opsRecurringDue, opsComponentTree, opsTreeCycle, opsVarianceBreaches, opsValidatePayrollInputs, opsLwfReconcile,
  opsStructureStatutoryIssues, opsNextCutoff, opsCutoffAlertDue, opsYmd, OPS_CLOSE_CHECKLIST, type OpsValidationRow, type OpsVarianceRuleSpec,
} from "./ops-math";

/**
 * Ops depth — payroll core and India statutory controls: input validation,
 * input cut-off alerts, the component hierarchy, recurring rules, net-pay
 * rounding and negative-net controls, variance tolerances, the calculation
 * trace, the close checklist, payslip and statutory sign-off through
 * approval, the statutory exception queue, LWF reconciliation and structure
 * statutory validation.
 */

type Result = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const period = (y: number, m: number) => `${MONTHS[m]} ${y}`;
const SKIPPED = ["HOLD_SALARY_PROCESSING", "VOID_SALARY_PROCESSING"];

async function runOf(tenantId: string, runId: string) {
  return prisma.payrollRun.findFirst({ where: { id: runId, tenantId }, include: { payGroup: { select: { id: true, name: true } } } });
}

// ---------------------------------------------------------------------------
//  Input validation
// ---------------------------------------------------------------------------

export async function validatePayrollRun(tenantId: string, runId: string, userId: string) {
  const run = await runOf(tenantId, runId);
  if (!run) return null;
  const s = await getOpsSettings(tenantId);
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { runId },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, status: true, lastWorkingDay: true, location: { select: { stateCode: true } }, statutoryProfile: { select: { pfEnabled: true, uan: true, esiEnabled: true, esicNumber: true } }, bankAccounts: { select: { id: true }, take: 1 }, identityDocs: { where: { type: "PAN" }, select: { id: true }, take: 1 } } } },
  });
  const days = Math.round((run.periodEnd.getTime() - run.periodStart.getTime()) / 86_400_000) + 1;
  const rows: OpsValidationRow[] = lines.map((l) => ({
    employeeId: l.employeeId, employee: `${l.employee.displayName ?? ""} (${l.employee.employeeNumber})`, status: l.employee.status,
    hasBank: l.employee.bankAccounts.length > 0, hasPan: l.employee.identityDocs.length > 0, ctc: num(l.annualCtc), hasStructure: !!l.structureId || num(l.annualCtc) > 0,
    pfEnabled: l.employee.statutoryProfile?.pfEnabled ?? true, hasUan: !!l.employee.statutoryProfile?.uan,
    esiApplies: (l.employee.statutoryProfile?.esiEnabled ?? true) && num(l.esiEmployee) > 0, hasEsiIp: !!l.employee.statutoryProfile?.esicNumber,
    lopDays: num(l.lopDays), periodDays: days, net: l.calculatedAt ? num(l.netPay) : null, onHold: SKIPPED.includes(l.payAction) || l.payAction === "HOLD_PAYOUT",
    exitedBeforePeriod: !!l.employee.lastWorkingDay && l.employee.lastWorkingDay < run.periodStart && l.employee.status === "EXITED", stateCode: l.employee.location?.stateCode ?? null,
  }));
  const issues = opsValidatePayrollInputs(rows.filter((r) => !SKIPPED.includes(lines.find((l) => l.employeeId === r.employeeId)!.payAction)), { negativeNetAction: s.negativeNetPayAction });
  const errors = issues.filter((i) => i.severity === "ERROR").length, warnings = issues.length - errors;
  const v = await prisma.opsPayrollValidation.create({ data: { tenantId, runId, errors, warnings, issues: issues as never, ranBy: userId } });
  if (errors === 0) await tickCloseItem(tenantId, runId, "INPUTS_VALIDATED", userId, `Validated: ${warnings} warning(s)`);
  await opsAudit(tenantId, userId, { module: "PAYROLL", action: "CREATE", entityType: "PayrollRun", entityId: runId, summary: `Validated ${period(run.year, run.month)} inputs: ${errors} error(s), ${warnings} warning(s)` });
  return { id: v.id, errors, warnings, issues, employees: rows.length };
}

export async function latestValidation(tenantId: string, runId: string) {
  return prisma.opsPayrollValidation.findFirst({ where: { tenantId, runId }, orderBy: { ranAt: "desc" } });
}

// ---------------------------------------------------------------------------
//  Rounding, negative net and variance gates
// ---------------------------------------------------------------------------

/** After calculation: round each net pay to the tenant's step (1 = as calculated) with a round-off line. */
export async function opsApplyNetRounding(runId: string): Promise<{ totalGross: number; totalDeductions: number; totalNetPay: number } | null> {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { tenantId: true } });
  if (!run) return null;
  const s = await prisma.opsSetting.findUnique({ where: { tenantId: run.tenantId } });
  if (!s || s.netPayRoundTo <= 1) return null;
  const lines = await prisma.payrollRunEmployee.findMany({ where: { runId, calculatedAt: { not: null }, payAction: { notIn: SKIPPED as never[] } }, select: { id: true, netPay: true, grossEarnings: true, totalDeductions: true } });
  for (const l of lines) {
    await prisma.payslipLine.deleteMany({ where: { runEmployeeId: l.id, code: "NET_ROUNDOFF" } });
    const { rounded, adjustment } = opsRoundNet(num(l.netPay), s.netPayRoundTo, s.netPayRoundingMode);
    if (adjustment === 0) continue;
    const earn = adjustment > 0;
    await prisma.payslipLine.create({ data: { runEmployeeId: l.id, code: "NET_ROUNDOFF", name: "Net pay round-off", type: earn ? "EARNING" : "DEDUCTION", fullAmount: Math.abs(adjustment), amount: Math.abs(adjustment), sequence: 9999 } });
    await prisma.payrollRunEmployee.update({ where: { id: l.id }, data: { netPay: rounded, ...(earn ? { grossEarnings: r2(num(l.grossEarnings) + adjustment) } : { totalDeductions: r2(num(l.totalDeductions) - adjustment) }) } });
  }
  const all = await prisma.payrollRunEmployee.findMany({ where: { runId, calculatedAt: { not: null }, payAction: { notIn: SKIPPED as never[] } }, select: { netPay: true, grossEarnings: true, totalDeductions: true } });
  const t = { totalGross: r2(all.reduce((a, l) => a + num(l.grossEarnings), 0)), totalDeductions: r2(all.reduce((a, l) => a + num(l.totalDeductions), 0)), totalNetPay: r2(all.reduce((a, l) => a + num(l.netPay), 0)) };
  await prisma.payrollRun.update({ where: { id: runId }, data: t });
  return t;
}

export async function saveVarianceRule(input: { tenantId: string; id?: string | null; name: string; metric: string; componentCode?: string | null; thresholdPct?: number | null; thresholdAmount?: number | null; severity: string; isActive: boolean }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the rule." };
  if (!["NET", "GROSS", "DEDUCTIONS", "COMPONENT"].includes(input.metric)) return { ok: false, message: "Choose what the rule measures." };
  if (input.metric === "COMPONENT" && !input.componentCode) return { ok: false, message: "Choose the component." };
  if (input.thresholdPct == null && input.thresholdAmount == null) return { ok: false, message: "Set a percentage, an amount or both." };
  if ((input.thresholdPct ?? 0) < 0 || (input.thresholdAmount ?? 0) < 0) return { ok: false, message: "Tolerances cannot be negative." };
  if (!["WARN", "BLOCK"].includes(input.severity)) return { ok: false, message: "Choose warn or block." };
  const data = { name: input.name.trim(), metric: input.metric, componentCode: input.metric === "COMPONENT" ? input.componentCode! : null, thresholdPct: input.thresholdPct ?? null, thresholdAmount: input.thresholdAmount ?? null, severity: input.severity, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsVarianceRule.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Saved." } : { ok: false, message: "Rule not found." };
    }
    await prisma.opsVarianceRule.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: `Rule "${data.name}" added.` };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, message: "A rule with that name exists." };
    throw e;
  }
}

/** Every breach of the tolerance rules in a run against each employee's previous regular run. */
export async function varianceBreaches(tenantId: string, runId: string) {
  const run = await runOf(tenantId, runId);
  if (!run) return null;
  const rules = (await prisma.opsVarianceRule.findMany({ where: { tenantId, isActive: true } })).map<OpsVarianceRuleSpec>((r) => ({ ...r, thresholdPct: r.thresholdPct === null ? null : Number(r.thresholdPct), thresholdAmount: r.thresholdAmount === null ? null : Number(r.thresholdAmount) }));
  const prevRun = await prisma.payrollRun.findFirst({ where: { tenantId, payGroupId: run.payGroupId, type: "REGULAR", rolledBackAt: null, status: "FINALIZED", OR: [{ year: { lt: run.year } }, { year: run.year, month: { lt: run.month } }] }, orderBy: [{ year: "desc" }, { month: "desc" }] });
  const load = (id: string) => prisma.payrollRunEmployee.findMany({ where: { runId: id, payAction: { notIn: SKIPPED as never[] } }, include: { lines: { select: { code: true, amount: true } }, employee: { select: { displayName: true, employeeNumber: true } } } });
  const [cur, prev] = await Promise.all([load(runId), prevRun ? load(prevRun.id) : Promise.resolve([])]);
  const reviews = await prisma.opsVarianceReview.findMany({ where: { tenantId, runId } });
  const reviewed = new Map(reviews.map((r) => [`${r.employeeId}|${r.ruleId}`, r]));
  const shape = (l: (typeof cur)[number]) => ({ net: num(l.netPay), gross: num(l.grossEarnings), deductions: num(l.totalDeductions), components: Object.fromEntries(l.lines.map((x) => [x.code, num(x.amount)])) });
  const prevBy = new Map(prev.map((p) => [p.employeeId, p]));
  const rows = cur.flatMap((l) => {
    const p = prevBy.get(l.employeeId);
    return opsVarianceBreaches(rules, p ? shape(p) : null, shape(l)).map((b) => ({ ...b, employeeId: l.employeeId, employee: `${l.employee.displayName ?? ""} (${l.employee.employeeNumber})`, review: reviewed.get(`${l.employeeId}|${b.ruleId}`) ?? null }));
  });
  return { run, previous: prevRun ? period(prevRun.year, prevRun.month) : null, rules: rules.length, rows, unreviewedBlocks: rows.filter((r) => r.severity === "BLOCK" && !r.review).length };
}

export async function reviewVariance(input: { actor: OpsActor; runId: string; employeeId: string; ruleId: string; note: string }): Promise<Result> {
  if (!input.note.trim()) return { ok: false, message: "Explain the variance." };
  const [run, rule] = await Promise.all([runOf(input.actor.tenantId, input.runId), prisma.opsVarianceRule.findFirst({ where: { id: input.ruleId, tenantId: input.actor.tenantId } })]);
  if (!run || !rule) return { ok: false, message: "Run or rule not found." };
  if (!(await prisma.payrollRunEmployee.findFirst({ where: { runId: run.id, employeeId: input.employeeId } }))) return { ok: false, message: "That employee is not in this run." };
  await prisma.opsVarianceReview.upsert({ where: { runId_employeeId_ruleId: { runId: run.id, employeeId: input.employeeId, ruleId: rule.id } }, create: { tenantId: input.actor.tenantId, runId: run.id, employeeId: input.employeeId, ruleId: rule.id, note: input.note.trim(), reviewedBy: input.actor.userId }, update: { note: input.note.trim(), reviewedBy: input.actor.userId } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "PAYROLL", action: "UPDATE", entityType: "PayrollRun", entityId: run.id, summary: `Reviewed variance "${rule.name}" for employee ${input.employeeId}: ${input.note.trim()}` });
  const v = await varianceBreaches(input.actor.tenantId, run.id);
  if (v && v.rows.every((r) => r.review)) await tickCloseItem(input.actor.tenantId, run.id, "VARIANCES_REVIEWED", input.actor.userId, "All breaches reviewed");
  return { ok: true, message: "Reviewed." };
}

/** Why a run may not be locked yet: a blocking negative net or an unreviewed blocking variance. */
export async function opsLockGate(tenantId: string, runId: string): Promise<string | null> {
  const s = await getOpsSettings(tenantId);
  if (s.negativeNetPayAction === "BLOCK") {
    const neg = await prisma.payrollRunEmployee.count({ where: { runId, run: { tenantId }, netPay: { lt: 0 }, payAction: { notIn: SKIPPED as never[] } } });
    if (neg) return `${neg} employee(s) have a negative net pay. Correct the deductions or hold their salary before locking.`;
  }
  const v = await varianceBreaches(tenantId, runId);
  if (v && v.unreviewedBlocks) return `${v.unreviewedBlocks} blocking variance(s) are not reviewed. Review them under Payroll › Controls › Variances.`;
  return null;
}

/** Why a run may not be finalised yet: the close checklist, when the tenant requires it. */
export async function opsFinalizeGate(tenantId: string, runId: string): Promise<string | null> {
  const s = await getOpsSettings(tenantId);
  if (!s.requireCloseChecklist) return null;
  const items = await closeChecklist(tenantId, runId);
  const open = items.filter((i) => !i.done && i.key !== "PAYSLIPS_RELEASED");
  return open.length ? `Finish the close checklist first: ${open.map((i) => i.label).join("; ")}.` : null;
}

// ---------------------------------------------------------------------------
//  Close checklist
// ---------------------------------------------------------------------------

export async function closeChecklist(tenantId: string, runId: string) {
  const have = await prisma.opsPayrollCloseItem.findMany({ where: { tenantId, runId } });
  const by = new Map(have.map((h) => [h.key, h]));
  return OPS_CLOSE_CHECKLIST.map((c) => {
    const h = by.get(c.key);
    return { key: c.key, label: c.label, done: h?.done ?? false, doneBy: h?.doneBy ?? null, doneAt: h?.doneAt ?? null, note: h?.note ?? null };
  });
}

async function tickCloseItem(tenantId: string, runId: string, key: string, userId: string | null, note?: string | null) {
  const label = OPS_CLOSE_CHECKLIST.find((c) => c.key === key)?.label ?? key;
  await prisma.opsPayrollCloseItem.upsert({ where: { runId_key: { runId, key } }, create: { tenantId, runId, key, label, done: true, doneBy: userId, doneAt: new Date(), note: note ?? null }, update: { done: true, doneBy: userId, doneAt: new Date(), note: note ?? null } });
}

export async function setCloseItem(input: { actor: OpsActor; runId: string; key: string; done: boolean; note?: string | null }): Promise<Result> {
  if (!OPS_CLOSE_CHECKLIST.some((c) => c.key === input.key)) return { ok: false, message: "Unknown checklist item." };
  const run = await runOf(input.actor.tenantId, input.runId);
  if (!run) return { ok: false, message: "Run not found." };
  if (input.done && input.key === "INPUTS_VALIDATED") {
    const v = await latestValidation(input.actor.tenantId, run.id);
    if (!v || v.errors > 0) return { ok: false, message: "Run the input validation with no errors first." };
  }
  if (input.done && input.key === "VARIANCES_REVIEWED") {
    const v = await varianceBreaches(input.actor.tenantId, run.id);
    if (v && v.unreviewedBlocks) return { ok: false, message: "Review the blocking variances first." };
  }
  const label = OPS_CLOSE_CHECKLIST.find((c) => c.key === input.key)!.label;
  await prisma.opsPayrollCloseItem.upsert({ where: { runId_key: { runId: run.id, key: input.key } }, create: { tenantId: input.actor.tenantId, runId: run.id, key: input.key, label, done: input.done, doneBy: input.done ? input.actor.userId : null, doneAt: input.done ? new Date() : null, note: input.note ?? null }, update: { done: input.done, doneBy: input.done ? input.actor.userId : null, doneAt: input.done ? new Date() : null, note: input.note ?? null } });
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "PAYROLL", action: "UPDATE", entityType: "PayrollRun", entityId: run.id, summary: `Close checklist: ${label} ${input.done ? "done" : "reopened"}` });
  return { ok: true, message: input.done ? "Ticked." : "Reopened." };
}

// ---------------------------------------------------------------------------
//  Component hierarchy and recurring rules
// ---------------------------------------------------------------------------

export async function saveComponentGroup(input: { tenantId: string; id?: string | null; kind: string; name: string; parentId?: string | null; sortOrder: number; componentCodes: string[] }): Promise<Result> {
  if (!["EARNING", "DEDUCTION"].includes(input.kind)) return { ok: false, message: "Earnings or deductions?" };
  if (!input.name.trim()) return { ok: false, message: "Name the group." };
  const groups = await prisma.opsComponentGroup.findMany({ where: { tenantId: input.tenantId, kind: input.kind }, select: { id: true, parentId: true } });
  if (input.parentId && !groups.some((g) => g.id === input.parentId)) return { ok: false, message: "The parent group is not in this hierarchy." };
  if (input.id && opsTreeCycle(groups, input.id, input.parentId ?? null)) return { ok: false, message: "A group cannot sit under itself." };
  const comps = await prisma.salaryComponent.findMany({ where: { tenantId: input.tenantId, code: { in: input.componentCodes } }, select: { code: true, type: true } });
  const wrong = comps.filter((c) => (input.kind === "EARNING" ? c.type !== "EARNING" : c.type !== "DEDUCTION")).map((c) => c.code);
  if (comps.length !== new Set(input.componentCodes).size) return { ok: false, message: "A component code is not yours." };
  if (wrong.length) return { ok: false, message: `${wrong.join(", ")} ${wrong.length > 1 ? "are" : "is"} not ${input.kind === "EARNING" ? "an earning" : "a deduction"}.` };
  const elsewhere = await prisma.opsComponentGroup.findMany({ where: { tenantId: input.tenantId, kind: input.kind, componentCodes: { hasSome: input.componentCodes }, ...(input.id ? { id: { not: input.id } } : {}) }, select: { name: true, componentCodes: true } });
  if (elsewhere.length) return { ok: false, message: `A component sits in one group only: ${elsewhere.map((g) => `${g.componentCodes.filter((c) => input.componentCodes.includes(c)).join(", ")} is in ${g.name}`).join("; ")}.` };
  const data = { kind: input.kind, name: input.name.trim(), parentId: input.parentId || null, sortOrder: input.sortOrder, componentCodes: [...new Set(input.componentCodes)] };
  try {
    if (input.id) {
      const n = await prisma.opsComponentGroup.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Saved." } : { ok: false, message: "Group not found." };
    }
    await prisma.opsComponentGroup.create({ data: { ...data, tenantId: input.tenantId } });
    return { ok: true, message: `Group "${data.name}" added.` };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, message: "A group with that name exists." };
    throw e;
  }
}

export async function deleteComponentGroup(tenantId: string, id: string): Promise<Result> {
  const g = await prisma.opsComponentGroup.findFirst({ where: { id, tenantId } });
  if (!g) return { ok: false, message: "Group not found." };
  await prisma.$transaction([prisma.opsComponentGroup.updateMany({ where: { tenantId, parentId: id }, data: { parentId: g.parentId } }), prisma.opsComponentGroup.delete({ where: { id } })]);
  return { ok: true, message: "Removed; its sub-groups moved up a level." };
}

/** The hierarchy with each group's components and, for a run, the totals rolled up. */
export async function componentHierarchy(tenantId: string, kind: string, runId?: string | null) {
  const [groups, comps] = await Promise.all([
    prisma.opsComponentGroup.findMany({ where: { tenantId, kind } }),
    prisma.salaryComponent.findMany({ where: { tenantId, type: kind === "EARNING" ? "EARNING" : "DEDUCTION" }, select: { code: true, name: true } }),
  ]);
  const amounts = new Map<string, number>();
  if (runId) {
    const rows = await prisma.payslipLine.groupBy({ by: ["code"], where: { runEmployee: { runId, run: { tenantId } } }, _sum: { amount: true } });
    for (const r of rows) amounts.set(r.code, num(r._sum.amount));
  }
  const tree = opsComponentTree(groups);
  const own = new Map(tree.map((g) => [g.id, g.componentCodes.reduce((s, c) => s + (amounts.get(c) ?? 0), 0)]));
  const total = (id: string): number => (own.get(id) ?? 0) + groups.filter((g) => g.parentId === id).reduce((s, g) => s + total(g.id), 0);
  const placed = new Set(groups.flatMap((g) => g.componentCodes));
  return {
    groups: tree.map((g) => ({ ...g, components: g.componentCodes.map((c) => ({ code: c, name: comps.find((x) => x.code === c)?.name ?? c, amount: amounts.get(c) ?? 0 })), total: r2(total(g.id)) })),
    ungrouped: comps.filter((c) => !placed.has(c.code)),
  };
}

export async function saveRecurringRule(input: { tenantId: string; id?: string | null; name: string; type: string; amount: number; frequency: string; months: number[]; payGroupId?: string | null; departmentId?: string | null; locationId?: string | null; startDate: Date; endDate?: Date | null; isActive: boolean; userId: string }): Promise<Result> {
  if (!input.name.trim()) return { ok: false, message: "Name the rule." };
  if (!["PAYMENT", "DEDUCTION"].includes(input.type)) return { ok: false, message: "Payment or deduction?" };
  if (!(input.amount > 0)) return { ok: false, message: "The amount must be more than zero." };
  if (!["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"].includes(input.frequency)) return { ok: false, message: "Choose how often it recurs." };
  if (input.months.some((m) => m < 1 || m > 12)) return { ok: false, message: "Months are 1 to 12." };
  if (input.endDate && input.endDate < input.startDate) return { ok: false, message: "The rule ends before it starts." };
  if (input.payGroupId && !(await prisma.payGroup.findFirst({ where: { id: input.payGroupId, tenantId: input.tenantId } }))) return { ok: false, message: "Pay group not found." };
  const data = { name: input.name.trim(), type: input.type, amount: input.amount, frequency: input.frequency, months: input.frequency === "MONTHLY" ? [] : input.months, payGroupId: input.payGroupId || null, departmentId: input.departmentId || null, locationId: input.locationId || null, startDate: input.startDate, endDate: input.endDate ?? null, isActive: input.isActive };
  try {
    if (input.id) {
      const n = await prisma.opsRecurringComponentRule.updateMany({ where: { id: input.id, tenantId: input.tenantId }, data });
      return n.count ? { ok: true, message: "Saved." } : { ok: false, message: "Rule not found." };
    }
    await prisma.opsRecurringComponentRule.create({ data: { ...data, tenantId: input.tenantId, createdBy: input.userId } });
    return { ok: true, message: `Recurring rule "${data.name}" added.` };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, message: "A rule with that name exists." };
    throw e;
  }
}

/** Add each due recurring rule to the run's employees as an ad-hoc item, once per employee and month. */
export async function applyRecurringRules(input: { actor: OpsActor; runId: string }): Promise<Result & { added?: number }> {
  const run = await runOf(input.actor.tenantId, input.runId);
  if (!run) return { ok: false, message: "Run not found." };
  if (!["DRAFT", "IN_PROGRESS"].includes(run.status)) return { ok: false, message: "Recurring items are added before the run is locked." };
  const rules = (await prisma.opsRecurringComponentRule.findMany({ where: { tenantId: input.actor.tenantId, isActive: true } })).filter((r) => opsRecurringDue({ ...r }, run.year, run.month) && (!r.payGroupId || r.payGroupId === run.payGroupId));
  if (!rules.length) return { ok: true, message: "No recurring rule is due this month.", added: 0 };
  const lines = await prisma.payrollRunEmployee.findMany({ where: { runId: run.id, payAction: { notIn: SKIPPED as never[] } }, select: { employeeId: true, employee: { select: { departmentId: true, locationId: true } } } });
  let added = 0;
  for (const rule of rules) {
    for (const l of lines) {
      if (rule.departmentId && rule.departmentId !== l.employee.departmentId) continue;
      if (rule.locationId && rule.locationId !== l.employee.locationId) continue;
      const exists = await prisma.adhocTransaction.findFirst({ where: { employeeId: l.employeeId, year: run.year, month: run.month, sourceType: "OpsRecurringRule", sourceId: rule.id } });
      if (exists) continue;
      await prisma.adhocTransaction.create({ data: { employeeId: l.employeeId, type: rule.type as "PAYMENT" | "DEDUCTION", name: rule.name, amount: rule.amount, year: run.year, month: run.month, comment: `Recurring rule (${rule.frequency.toLowerCase().replace("_", "-")})`, sourceType: "OpsRecurringRule", sourceId: rule.id, createdBy: input.actor.userId } });
      added++;
    }
  }
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "PAYROLL", action: "CREATE", entityType: "PayrollRun", entityId: run.id, summary: `Added ${added} recurring item(s) to ${period(run.year, run.month)}` });
  return { ok: true, message: `Added ${added} recurring item(s). Recalculate the run to include them.`, added };
}

// ---------------------------------------------------------------------------
//  Calculation trace and input audit
// ---------------------------------------------------------------------------

/** Every input and step behind one employee's pay in a run. */
export async function payrollTrace(tenantId: string, runId: string, employeeId: string) {
  const line = await prisma.payrollRunEmployee.findFirst({
    where: { runId, employeeId, run: { tenantId } },
    include: { lines: { orderBy: { sequence: "asc" } }, employee: { select: { displayName: true, employeeNumber: true } }, run: { select: { year: true, month: true, periodStart: true, periodEnd: true, attendanceFrom: true, attendanceTo: true, status: true } } },
  });
  if (!line) return null;
  const { year, month } = line.run;
  const [adhoc, arrears, lop, overrides, loans] = await Promise.all([
    prisma.adhocTransaction.findMany({ where: { employeeId, year, month, isPaidOutside: false } }),
    prisma.arrear.findMany({ where: { employeeId, OR: [{ paidInRunId: runId }, { isProcessed: false }] } }),
    prisma.lopAdjustment.findMany({ where: { employeeId, year, month } }),
    prisma.employeeComponentOverride.findMany({ where: { employeeId, tenantId }, include: { component: { select: { code: true } } } }),
    prisma.loanInstallment.findMany({ where: { year, month, loan: { employeeId } } }),
  ]);
  const totalDays = line.totalDays;
  const payable = num(line.payableDays);
  const steps = [
    { step: "Period", detail: `${opsYmd(line.run.periodStart)} to ${opsYmd(line.run.periodEnd)}; attendance ${line.run.attendanceFrom ? `${opsYmd(line.run.attendanceFrom)} to ${opsYmd(line.run.attendanceTo!)}` : "window not set"}` },
    { step: "Days", detail: `${totalDays} days in the period; LOP ${num(line.lopDays)} (attendance ${num(line.attendanceLopDays)}, carried ${num(line.carriedLopDays)}, adjustment ${num(line.lopAdjustment)}, reversal ${num(line.lopReversalDays)}); payable ${payable}` },
    { step: "Proration", detail: `Each LOP-applicable component × ${payable}/${totalDays} = ${totalDays ? r2((payable / totalDays) * 100) : 0}%` },
    ...line.lines.map((l) => ({ step: `${l.type === "EARNING" ? "Earning" : l.type === "DEDUCTION" ? "Deduction" : l.type === "EMPLOYER_CONTRIBUTION" ? "Employer" : "Other"} · ${l.name}`, detail: `${l.code}: full ${num(l.fullAmount)} → paid ${num(l.amount)}${num(l.fullAmount) !== num(l.amount) ? ` (${r2(num(l.amount) - num(l.fullAmount))})` : ""}${l.isOverridden ? " · overridden" : ""}` })),
    { step: "Statutory", detail: `PF wage ${num(line.pfWage)} → PF ${num(line.pfEmployee)} (employer ${num(line.pfEmployer)}, EPS ${num(line.epsEmployer)}); ESI gross ${num(line.esiGross)} → ESI ${num(line.esiEmployee)}; PT ${num(line.professionalTax)}; LWF ${num(line.lwfEmployee)}; TDS ${num(line.tds)}` },
    ...(line.ptOverride !== null || line.esiOverride !== null || line.tdsOverride !== null || line.lwfOverride !== null ? [{ step: "Overrides", detail: `PT ${line.ptOverride ?? "—"}, ESI ${line.esiOverride ?? "—"}, TDS ${line.tdsOverride ?? "—"}, LWF ${line.lwfOverride ?? "—"}${line.overrideNote ? ` · ${line.overrideNote}` : ""}` }] : []),
    { step: "Result", detail: `Gross ${num(line.grossEarnings)} − deductions ${num(line.totalDeductions)} = net ${num(line.netPay)}; employer cost ${num(line.employerCost)}` },
  ];
  return {
    employee: `${line.employee.displayName ?? ""} (${line.employee.employeeNumber})`, period: period(year, month), status: line.run.status, payAction: line.payAction, steps,
    inputs: {
      adhoc: adhoc.map((a) => ({ name: a.name, type: a.type, amount: num(a.amount), source: a.sourceType ?? "Manual" })),
      arrears: arrears.map((a) => ({ id: a.id, amount: num(a.amount), processed: a.isProcessed })),
      lop: lop.map((l) => ({ days: num(l.days), note: l.note })),
      overrides: overrides.map((o) => ({ component: o.component.code, amount: num(o.monthlyAmount), from: o.effectiveFrom, to: o.effectiveTo })),
      loans: loans.map((l) => ({ amount: num(l.totalAmount), status: l.status })),
    },
    errors: Array.isArray(line.errors) ? (line.errors as string[]) : [],
  };
}

/** Audit entries for payroll inputs: ad-hoc items, arrears, LOP, overrides, salary and statutory changes. */
export async function payrollInputAudit(tenantId: string, opts: { from?: Date; to?: Date; q?: string } = {}) {
  const rows = await prisma.auditLog.findMany({
    where: {
      tenantId, module: "PAYROLL",
      ...(opts.from || opts.to ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
      ...(opts.q ? { OR: [{ summary: { contains: opts.q, mode: "insensitive" } }, { entityType: { contains: opts.q, mode: "insensitive" } }] } : {}),
    },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, createdAt: true, actorLabel: true, action: true, entityType: true, entityId: true, summary: true },
  });
  return rows;
}

// ---------------------------------------------------------------------------
//  Payslip release and statutory sign-off approvals
// ---------------------------------------------------------------------------

export async function requestPayslipRelease(input: { actor: OpsActor; runId: string; note?: string | null }): Promise<Result & { status?: string }> {
  const run = await runOf(input.actor.tenantId, input.runId);
  if (!run) return { ok: false, message: "Run not found." };
  if (run.status !== "FINALIZED") return { ok: false, message: "Finalise the run first." };
  const pending = await prisma.payslip.count({ where: { runId: run.id, status: { in: ["GENERATED", "NOT_GENERATED"] } } });
  if (!pending) return { ok: false, message: "Every payslip is already released." };
  return opsRequestApproval({
    tenantId: input.actor.tenantId, entityType: "OPS_PAYSLIP_RELEASE", targetId: run.id, targetLabel: `${run.payGroup.name} · ${period(run.year, run.month)} · ${pending} payslip(s)`,
    reason: input.note ?? null, requestedBy: input.actor.userId, amount: num(run.totalNetPay), title: `Release ${pending} payslip(s) for ${period(run.year, run.month)} (${run.payGroup.name})`, link: `/payroll/runs/${run.id}`,
  });
}

export async function applyPayslipReleaseDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.targetId) return;
  const run = await prisma.payrollRun.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!run) throw new Error("Run not found.");
  const r = await releasePayslipsForRun(run.id, a.requestedBy);
  if (!r.ok) throw new Error(r.message);
  await tickCloseItem(a.tenantId, run.id, "PAYSLIPS_RELEASED", actorUserId, r.message);
  await opsAudit(a.tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "PayrollRun", entityId: run.id, summary: `Payslip release approved: ${r.message}` });
}

export const OPS_SIGNOFF_TYPES: Record<string, string> = { PF_ECR: "EPF (ECR)", ESI_ECR: "ESIC contribution", PT_RETURN: "Professional tax return", LWF_RETURN: "LWF return", FORM_24Q: "TDS return (24Q)" };

/** Ask for sign-off on a statutory filing before it is marked filed. PT and LWF returns get a filing record here. */
export async function requestStatutorySignoff(input: { actor: OpsActor; filingId?: string | null; type?: string | null; year?: number | null; month?: number | null; note?: string | null }): Promise<Result & { status?: string; filingId?: string }> {
  const t = input.actor.tenantId;
  let filing = input.filingId ? await prisma.statutoryFiling.findFirst({ where: { id: input.filingId, tenantId: t } }) : null;
  if (!filing) {
    if (!input.type || !["PT_RETURN", "LWF_RETURN"].includes(input.type) || !input.year || !input.month) return { ok: false, message: "Choose a generated filing, or a PT or LWF return month." };
    const lines = await prisma.payrollRunEmployee.count({ where: { run: { tenantId: t, year: input.year, month: input.month, rolledBackAt: null, status: "FINALIZED" } } });
    if (!lines) return { ok: false, message: `No finalised payroll for ${period(input.year, input.month)}.` };
    const fy = input.month >= 4 ? input.year : input.year - 1;
    filing = await prisma.statutoryFiling.findFirst({ where: { tenantId: t, type: input.type as "PT_RETURN", fyStartYear: fy, month: input.month } })
      ?? await prisma.statutoryFiling.create({ data: { tenantId: t, type: input.type as "PT_RETURN", fyStartYear: fy, month: input.month, status: "GENERATED", generatedAt: new Date(), meta: { summary: `${OPS_SIGNOFF_TYPES[input.type]} for ${period(input.year, input.month)}`, year: input.year } } });
  }
  if (!(filing.type in OPS_SIGNOFF_TYPES)) return { ok: false, message: "This filing does not need a sign-off." };
  if (filing.status !== "GENERATED") return { ok: false, message: "Sign off a generated filing, before it is filed." };
  const label = `${OPS_SIGNOFF_TYPES[filing.type]} · ${filing.month ? `month ${filing.month}, ` : ""}${filing.quarter ? `Q${filing.quarter}, ` : ""}FY ${filing.fyStartYear}-${String((filing.fyStartYear + 1) % 100).padStart(2, "0")}`;
  const res = await opsRequestApproval({ tenantId: t, entityType: "OPS_STATUTORY_SIGNOFF", targetId: filing.id, targetLabel: label, reason: input.note ?? null, requestedBy: input.actor.userId, title: `Sign off ${label}`, link: "/payroll/controls?tab=signoff", changeKind: filing.type });
  return { ...res, filingId: filing.id };
}

export async function applyStatutorySignoffDecision(a: OpsApprovalRequest, outcome: string, actorUserId: string | null): Promise<void> {
  if (outcome !== "APPROVED" || !a.targetId) return;
  const f = await prisma.statutoryFiling.findFirst({ where: { id: a.targetId, tenantId: a.tenantId } });
  if (!f) throw new Error("Filing not found.");
  const meta = (f.meta && typeof f.meta === "object" ? f.meta : {}) as Record<string, unknown>;
  await prisma.statutoryFiling.update({ where: { id: f.id }, data: { meta: { ...meta, signedOffBy: actorUserId, signedOffAt: new Date().toISOString() } } });
  await opsAudit(a.tenantId, actorUserId, { module: "PAYROLL", action: "APPROVE", entityType: "StatutoryFiling", entityId: f.id, summary: `Signed off ${a.targetLabel}` });
}

/** Why a filing may not be marked filed: the tenant requires a sign-off it does not have. */
export async function opsFilingGate(tenantId: string, filingId: string): Promise<string | null> {
  const s = await getOpsSettings(tenantId);
  if (!s.requireFilingApproval) return null;
  const f = await prisma.statutoryFiling.findFirst({ where: { id: filingId, tenantId }, select: { type: true } });
  if (!f || !(f.type in OPS_SIGNOFF_TYPES)) return null;
  const ok = await prisma.opsApprovalRequest.findFirst({ where: { tenantId, kind: "OPS_STATUTORY_SIGNOFF", targetId: filingId, status: "APPLIED" } });
  return ok ? null : "This filing needs a sign-off before it is marked filed. Request one under Payroll › Controls › Sign-offs.";
}

export async function opsPayslipGate(tenantId: string): Promise<boolean> {
  return (await getOpsSettings(tenantId)).requirePayslipApproval;
}

export async function signoffBoard(tenantId: string) {
  const [filings, requests] = await Promise.all([
    prisma.statutoryFiling.findMany({ where: { tenantId, type: { in: Object.keys(OPS_SIGNOFF_TYPES) as never[] } }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: { in: ["OPS_STATUTORY_SIGNOFF", "OPS_PAYSLIP_RELEASE"] } }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return { filings, requests };
}

// ---------------------------------------------------------------------------
//  Statutory exception queue and LWF reconciliation
// ---------------------------------------------------------------------------

/** Rebuild the queue for a month from the coverage and PT/LWF checks; fixed ones close themselves. */
export async function refreshStatutoryExceptions(tenantId: string, year: number, month: number): Promise<{ open: number; added: number; closed: number }> {
  const [cov, ptl] = await Promise.all([coverageReport(tenantId, year, month), ptLwfReport(tenantId, year, month)]);
  const emps = await prisma.employee.findMany({ where: { tenantId }, select: { id: true, employeeNumber: true } });
  const idOf = new Map(emps.map((e) => [e.employeeNumber, e.id]));
  const prefix = `${year}-${String(month).padStart(2, "0")}:`;
  const found: Array<{ kind: string; employeeNumber: string; detail: string; severity: string }> = [];
  for (const r of cov.rows) found.push({ kind: String(r.issue).startsWith("ESI") || String(r.issue).includes("ESI") ? "ESI_COVERAGE" : "PF_COVERAGE", employeeNumber: String(r.employeeNumber), detail: String(r.issue), severity: "HIGH" });
  for (const r of ptl.rows) if (r._flag) for (const issue of String(r.issues).split("; ").filter(Boolean)) found.push({ kind: /lwf|welfare/i.test(issue) ? "LWF" : "PT", employeeNumber: String(r.employeeNumber), detail: issue, severity: "MEDIUM" });
  let added = 0;
  const keys = new Set<string>();
  for (const f of found) {
    const key = `${prefix}${f.kind}:${f.employeeNumber}:${f.detail}`.slice(0, 400);
    keys.add(key);
    const ex = await prisma.opsStatutoryException.findUnique({ where: { tenantId_dedupeKey: { tenantId, dedupeKey: key } } });
    if (!ex) { await prisma.opsStatutoryException.create({ data: { tenantId, kind: f.kind, employeeId: idOf.get(f.employeeNumber) ?? null, dedupeKey: key, detail: `${period(year, month)} · ${f.employeeNumber}: ${f.detail}`, severity: f.severity } }); added++; }
  }
  const stale = await prisma.opsStatutoryException.findMany({ where: { tenantId, status: "OPEN", dedupeKey: { startsWith: prefix } }, select: { id: true, dedupeKey: true } });
  const gone = stale.filter((s) => !keys.has(s.dedupeKey)).map((s) => s.id);
  if (gone.length) await prisma.opsStatutoryException.updateMany({ where: { id: { in: gone } }, data: { status: "RESOLVED", resolvedAt: new Date(), note: "No longer found on re-check" } });
  const open = await prisma.opsStatutoryException.count({ where: { tenantId, status: "OPEN" } });
  return { open, added, closed: gone.length };
}

export async function resolveStatutoryException(input: { actor: OpsActor; id: string; status: string; note: string }): Promise<Result> {
  if (!["RESOLVED", "IGNORED", "OPEN"].includes(input.status)) return { ok: false, message: "Resolve, ignore or reopen." };
  if (input.status !== "OPEN" && !input.note.trim()) return { ok: false, message: "Note what was done." };
  const n = await prisma.opsStatutoryException.updateMany({ where: { id: input.id, tenantId: input.actor.tenantId }, data: { status: input.status, note: input.note.trim() || null, resolvedBy: input.status === "OPEN" ? null : input.actor.userId, resolvedAt: input.status === "OPEN" ? null : new Date() } });
  if (!n.count) return { ok: false, message: "Not found." };
  await opsAudit(input.actor.tenantId, input.actor.userId, { module: "PAYROLL", action: "UPDATE", entityType: "OpsStatutoryException", entityId: input.id, summary: `Statutory exception ${input.status.toLowerCase()}: ${input.note}` });
  return { ok: true, message: `Marked ${input.status.toLowerCase()}.` };
}

/** LWF deducted in a month against each employee's state rule. */
export async function lwfReconciliation(tenantId: string, year: number, month: number) {
  const lines = await prisma.payrollRunEmployee.findMany({
    where: { run: { tenantId, year, month, type: "REGULAR", rolledBackAt: null }, payAction: { notIn: SKIPPED as never[] } },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, location: { select: { stateCode: true } }, statutoryProfile: { select: { lwfEnabled: true } } } }, run: { select: { payGroup: { select: { lwfEnabled: true } } } } },
  });
  const end = new Date(Date.UTC(year, month, 0));
  const states = [...new Set(lines.map((l) => l.employee.location?.stateCode).filter((s): s is string => !!s))];
  const rules = await prisma.lwfRule.findMany({ where: { stateCode: { in: states }, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: end } }] }, orderBy: { effectiveFrom: "desc" } });
  const ruleOf = (s: string | null | undefined) => rules.find((r) => r.stateCode === s) ?? null;
  const rows = opsLwfReconcile(lines.map((l) => {
    const rule = ruleOf(l.employee.location?.stateCode);
    const months = Array.isArray(rule?.deductionMonths) ? (rule!.deductionMonths as number[]) : [];
    const applies = !!rule && months.includes(month) && (l.employee.statutoryProfile?.lwfEnabled ?? true) && l.run.payGroup.lwfEnabled && (rule.wageLimit === null || num(l.grossEarnings) <= num(rule.wageLimit));
    return { employeeId: l.employeeId, employee: `${l.employee.displayName ?? ""} (${l.employee.employeeNumber})`, stateCode: l.employee.location?.stateCode ?? null, expectedEmployee: applies ? num(rule!.employeeAmount) : 0, expectedEmployer: applies ? num(rule!.employerAmount) : 0, deductedEmployee: num(l.lwfOverride ?? l.lwfEmployee), deductedEmployer: num(l.lwfEmployer) };
  }));
  return { rows, matched: rows.filter((r) => r.status === "MATCHED").length, mismatched: rows.filter((r) => r.status !== "MATCHED").length, totalDeducted: r2(rows.reduce((s, r) => s + r.deductedEmployee + r.deductedEmployer, 0)), totalExpected: r2(rows.reduce((s, r) => s + r.expectedEmployee + r.expectedEmployer, 0)) };
}

// ---------------------------------------------------------------------------
//  Structure statutory validation
// ---------------------------------------------------------------------------

export async function validateStructureStatutory(tenantId: string, structureId: string, annualCtc: number, stateCode?: string | null) {
  const s = await prisma.salaryStructure.findFirst({ where: { id: structureId, payGroup: { tenantId } }, include: { components: { include: { component: true } }, payGroup: { select: { pfEnabled: true, esiEnabled: true } } } });
  if (!s) return null;
  const resolved = resolveStructure({ annualCtc, components: specsOf({ structure: s } as unknown as Parameters<typeof specsOf>[0]), roundComponents: s.roundComponents });
  const earnings = resolved.components.filter((c) => c.type === "EARNING" && !c.isOutsideCtc);
  const basic = earnings.filter((c) => /BASIC/i.test(c.code)).reduce((a, c) => a + Number(c.monthly), 0);
  const gross = earnings.reduce((a, c) => a + Number(c.monthly), 0);
  const mw = stateCode ? await prisma.minimumWageRate.findFirst({ where: { tenantId, stateCode: stateCode.toUpperCase(), category: "UNSKILLED", effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: "desc" } }) : null;
  const issues = opsStructureStatutoryIssues({ annualCtc, monthlyBasic: r2(basic), monthlyGross: r2(gross), pfEnabled: s.pfEnabled && s.payGroup.pfEnabled, esiEnabled: s.esiEnabled && s.payGroup.esiEnabled, minimumWage: mw ? num(mw.monthlyAmount) : null });
  return { structure: s.name, annualCtc, monthlyBasic: r2(basic), monthlyGross: r2(gross), components: resolved.components.map((c) => ({ code: c.code, name: c.name, type: c.type, monthly: Number(c.monthly) })), issues };
}

// ---------------------------------------------------------------------------
//  Payroll input cut-off alerts
// ---------------------------------------------------------------------------

/** Ahead of the 25th: tell payroll admins (and the people holding them up) what is still pending. */
export async function runPayrollInputCutoffAlerts(tenantId: string, now = new Date()): Promise<{ due: boolean; sent: number }> {
  const s = await getOpsSettings(tenantId);
  if (!opsCutoffAlertDue(now, s.attendanceCutoffDay, s.cutoffAlertDaysBefore)) return { due: false, sent: 0 };
  const cutoff = opsNextCutoff(now, s.attendanceCutoffDay).date;
  const [leave, att, adhoc, revisions] = await Promise.all([
    prisma.leaveRequest.count({ where: { tenantId, status: "PENDING", fromDate: { lte: cutoff } } }),
    prisma.attendanceRequest.count({ where: { tenantId, status: "PENDING" } }),
    prisma.payrollApprovalRequest.count({ where: { run: { tenantId }, status: "PENDING" } }),
    prisma.salaryRevision.count({ where: { employee: { tenantId }, status: "PENDING_APPROVAL" } }),
  ]);
  const admins = await usersWithPermission(tenantId, "payroll.run.execute");
  const key = opsYmd(cutoff);
  const sent = await opsAlertOnce(tenantId, "PAYROLL_INPUT_CUTOFF", key, {
    userIds: admins, email: true, link: "/payroll/controls",
    title: `Payroll inputs close on ${key}: ${leave} leave, ${att} attendance request(s), ${adhoc} payroll approval(s) and ${revisions} salary revision(s) still pending`,
  });
  return { due: true, sent: sent ? admins.length : 0 };
}

