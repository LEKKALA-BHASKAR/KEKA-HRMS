"use server";

import { PERMISSIONS } from "@keka/rbac";
import {
  validatePayrollRun, saveVarianceRule, reviewVariance, setCloseItem, saveComponentGroup, deleteComponentGroup, saveRecurringRule, applyRecurringRules,
  requestPayslipRelease, requestStatutorySignoff, refreshStatutoryExceptions, resolveStatutoryException,
} from "@keka/services";
import { requireViewer, can, canAny } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { str, optStr, bool, int, money, day, actorOf, DENIED, no, result } from "@/lib/cases-docs";

/**
 * Payroll controls: input validation, variance rules and reviews, the close
 * checklist, the component hierarchy, recurring rules, payslip and statutory
 * sign-off requests and the statutory exception queue.
 */

const P = PERMISSIONS;
const PATHS = ["/payroll/controls", "/payroll/runs", "/payroll/filings", "/inbox"];

export async function validateRunAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK])) return DENIED;
  const r = await validatePayrollRun(v.tenantId, str(fd, "runId"), v.user.id);
  if (!r) return no("Run not found.");
  return result({ ok: true, message: `${r.employees} employee(s) checked: ${r.errors} error(s), ${r.warnings} warning(s).` }, PATHS);
}

export async function saveVarianceRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PAYROLL_SETTINGS)) return DENIED;
  const pct = money(fd, "thresholdPct"), amt = money(fd, "thresholdAmount");
  if (Number.isNaN(pct) || Number.isNaN(amt)) return no("Tolerances are numbers.");
  const r = await saveVarianceRule({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), metric: str(fd, "metric"), componentCode: optStr(fd, "componentCode"), thresholdPct: pct, thresholdAmount: amt, severity: str(fd, "severity") || "WARN", isActive: fd.has("isActive") ? bool(fd, "isActive") : true });
  if (r.ok) await writeAudit(v, { module: "PAYROLL", action: optStr(fd, "id") ? "UPDATE" : "CREATE", entityType: "OpsVarianceRule", entityId: optStr(fd, "id"), summary: `Saved variance rule "${str(fd, "name")}"` });
  return result(r, PATHS);
}

export async function reviewVarianceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK])) return DENIED;
  return result(await reviewVariance({ actor: actorOf(v), runId: str(fd, "runId"), employeeId: str(fd, "employeeId"), ruleId: str(fd, "ruleId"), note: str(fd, "note") }), PATHS);
}

export async function setCloseItemAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.PAYROLL_RUN, P.PAYROLL_LOCK])) return DENIED;
  return result(await setCloseItem({ actor: actorOf(v), runId: str(fd, "runId"), key: str(fd, "key"), done: str(fd, "done") !== "false", note: optStr(fd, "note") }), PATHS);
}

export async function saveComponentGroupAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.SALARY_STRUCTURE_MANAGE)) return DENIED;
  const r = await saveComponentGroup({ tenantId: v.tenantId, id: optStr(fd, "id"), kind: str(fd, "kind"), name: str(fd, "name"), parentId: optStr(fd, "parentId"), sortOrder: int(fd, "sortOrder") ?? 0, componentCodes: formList(fd, "componentCodes") });
  if (r.ok) await writeAudit(v, { module: "PAYROLL", action: optStr(fd, "id") ? "UPDATE" : "CREATE", entityType: "OpsComponentGroup", entityId: optStr(fd, "id"), summary: `Saved ${str(fd, "kind").toLowerCase()} group "${str(fd, "name")}"` });
  return result(r, PATHS);
}

export async function deleteComponentGroupAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.SALARY_STRUCTURE_MANAGE)) return DENIED;
  const r = await deleteComponentGroup(v.tenantId, str(fd, "id"));
  if (r.ok) await writeAudit(v, { module: "PAYROLL", action: "DELETE", entityType: "OpsComponentGroup", entityId: str(fd, "id"), summary: "Removed a component group" });
  return result(r, PATHS);
}

export async function saveRecurringRuleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PAYROLL_SETTINGS)) return DENIED;
  const start = day(fd, "startDate");
  if (!start) return no("Pick the start date.");
  const amount = money(fd, "amount");
  if (amount === null || Number.isNaN(amount)) return no("Enter the amount.");
  const r = await saveRecurringRule({ tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), type: str(fd, "type"), amount, frequency: str(fd, "frequency"), months: formList(fd, "months").map(Number), payGroupId: optStr(fd, "payGroupId"), departmentId: optStr(fd, "departmentId"), locationId: optStr(fd, "locationId"), startDate: start, endDate: day(fd, "endDate"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true, userId: v.user.id });
  if (r.ok) await writeAudit(v, { module: "PAYROLL", action: optStr(fd, "id") ? "UPDATE" : "CREATE", entityType: "OpsRecurringComponentRule", entityId: optStr(fd, "id"), summary: `Saved recurring rule "${str(fd, "name")}" (${str(fd, "type").toLowerCase()} ${amount}, ${str(fd, "frequency").toLowerCase()})` });
  return result(r, PATHS);
}

export async function applyRecurringRulesAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PAYROLL_RUN)) return DENIED;
  return result(await applyRecurringRules({ actor: actorOf(v), runId: str(fd, "runId") }), PATHS);
}

export async function requestPayslipReleaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.PAYSLIP_RELEASE)) return DENIED;
  return result(await requestPayslipRelease({ actor: actorOf(v), runId: str(fd, "runId"), note: optStr(fd, "note") }), PATHS);
}

export async function requestStatutorySignoffAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!canAny(v, [P.STATUTORY_MANAGE, P.STATUTORY_FILE])) return DENIED;
  return result(await requestStatutorySignoff({ actor: actorOf(v), filingId: optStr(fd, "filingId"), type: optStr(fd, "type"), year: int(fd, "year"), month: int(fd, "month"), note: optStr(fd, "note") }), PATHS);
}

export async function refreshStatutoryExceptionsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.STATUTORY_MANAGE)) return DENIED;
  const year = int(fd, "year"), month = int(fd, "month");
  if (!year || !month || month < 1 || month > 12) return no("Pick the month.");
  const r = await refreshStatutoryExceptions(v.tenantId, year, month);
  await writeAudit(v, { module: "PAYROLL", action: "UPDATE", entityType: "OpsStatutoryException", entityId: null, summary: `Re-checked statutory exceptions for ${month}/${year}: ${r.added} new, ${r.closed} closed` });
  return result({ ok: true, message: `${r.added} new, ${r.closed} closed; ${r.open} open in all.` }, PATHS);
}

export async function resolveStatutoryExceptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.STATUTORY_MANAGE)) return DENIED;
  return result(await resolveStatutoryException({ actor: actorOf(v), id: str(fd, "id"), status: str(fd, "status") || "RESOLVED", note: str(fd, "note") }), PATHS);
}
