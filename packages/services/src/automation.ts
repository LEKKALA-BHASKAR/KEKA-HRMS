import { prisma, type Prisma } from "@keka/db";
import { notify, usersWithPermission } from "./lifecycle";
import { emitEvent } from "./webhooks";
import { generateLetter } from "./letters";
import {
  DATE_TRIGGERS, dateTriggerOccurrence, isoDay, parseActions, renderTemplate,
  type AutomationAction,
} from "./governance-math";

/**
 * Automation rules: when something happens (an employee is added or
 * changed, a workflow request is decided) or a date comes round (N days
 * before probation ends, a birthday, a work anniversary, a contract or
 * document expiry), run the rule's actions — email through the outbox, an
 * in-app notification, a task, a signed webhook, a generated letter.
 *
 * Every firing is recorded once per (rule, subject, occasion) in
 * automation_runs, so the scan can run as often as it likes.
 */

export interface AutomationSubject {
  type: string;
  id: string;
  employeeId: string | null;
  /** For workflow triggers. */
  entityType?: string | null;
  title?: string | null;
  link?: string | null;
  date?: Date | null;
}

type EmployeeCtx = {
  id: string; userId: string | null; firstName: string; lastName: string; displayName: string | null; employeeNumber: string;
  workEmail: string | null; departmentId: string | null; locationId: string | null; department: { name: string } | null;
  reportingManager: { userId: string | null; displayName: string | null } | null;
};

const employeeSelect = {
  id: true, userId: true, firstName: true, lastName: true, displayName: true, employeeNumber: true, workEmail: true, departmentId: true, locationId: true,
  department: { select: { name: true } }, reportingManager: { select: { userId: true, displayName: true } },
} satisfies Prisma.EmployeeSelect;

async function recipients(tenantId: string, to: string | undefined, emp: EmployeeCtx | null, requesterUserId?: string | null): Promise<{ userIds: string[]; emails: string[] }> {
  const target = (to ?? "EMPLOYEE").trim();
  if (target === "EMPLOYEE") return { userIds: [emp?.userId ?? requesterUserId ?? null].filter((u): u is string => !!u), emails: [] };
  if (target === "MANAGER") return { userIds: [emp?.reportingManager?.userId ?? null].filter((u): u is string => !!u), emails: [] };
  if (target === "HR") return { userIds: await usersWithPermission(tenantId, "employee.record.update"), emails: [] };
  if (target.startsWith("USER:")) {
    const u = await prisma.user.findFirst({ where: { id: target.slice(5), tenantId }, select: { id: true } });
    return { userIds: u ? [u.id] : [], emails: [] };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return { userIds: [], emails: [target.toLowerCase()] };
  return { userIds: [], emails: [] };
}

/** Run one rule's actions for a subject. Returns the count run and any errors. */
async function executeActions(rule: { id: string; tenantId: string; name: string; createdBy: string | null }, actions: AutomationAction[], subject: AutomationSubject, emp: EmployeeCtx | null, requesterUserId?: string | null) {
  const tenantId = rule.tenantId;
  const name = emp ? emp.displayName ?? `${emp.firstName} ${emp.lastName}` : "";
  const values = {
    name, first_name: emp?.firstName ?? "", employee_number: emp?.employeeNumber ?? "", department: emp?.department?.name ?? "",
    manager: emp?.reportingManager?.displayName ?? "", date: subject.date ? isoDay(subject.date) : "", rule: rule.name, title: subject.title ?? "",
  };
  let ran = 0;
  const errors: string[] = [];
  const done: string[] = [];
  for (const a of actions) {
    try {
      const subjectLine = renderTemplate(a.subject || rule.name, values);
      const body = renderTemplate(a.body || subjectLine, values);
      if (a.type === "EMAIL") {
        const r = await recipients(tenantId, a.to, emp, requesterUserId);
        const users = r.userIds.length ? await prisma.user.findMany({ where: { id: { in: r.userIds }, tenantId }, select: { email: true } }) : [];
        const to = [...new Set([...users.map((u) => u.email.toLowerCase()), ...r.emails])];
        if (to.length === 0) throw new Error(`No email recipient for "${a.to ?? "EMPLOYEE"}".`);
        await prisma.emailOutbox.createMany({ data: to.map((toAddress) => ({ tenantId, toAddress, subject: subjectLine, textBody: body, relatedType: "AutomationRule", relatedId: rule.id })) });
        done.push(`email ×${to.length}`);
      } else if (a.type === "NOTIFY") {
        const r = await recipients(tenantId, a.to, emp, requesterUserId);
        if (r.userIds.length === 0) throw new Error(`No one to notify for "${a.to ?? "EMPLOYEE"}".`);
        await notify({ tenantId, userIds: r.userIds, kind: "AUTOMATION", title: subjectLine, body, link: subject.link ?? (emp ? `/employees/${emp.id}` : null) });
        done.push(`notify ×${r.userIds.length}`);
      } else if (a.type === "TASK") {
        const r = await recipients(tenantId, a.to ?? "HR", emp, requesterUserId);
        if (r.userIds.length === 0) throw new Error(`No assignee for "${a.to ?? "HR"}".`);
        const dueOn = a.dueInDays !== undefined && a.dueInDays !== null ? new Date(Date.now() + Number(a.dueInDays) * 86_400_000) : null;
        await prisma.workTask.createMany({ data: r.userIds.map((assigneeUserId) => ({ tenantId, title: subjectLine, description: body, assigneeUserId, dueOn, sourceType: "AutomationRule", sourceId: rule.id, subjectEmployeeId: emp?.id ?? null })) });
        await notify({ tenantId, userIds: r.userIds, kind: "TASK", title: `New task: ${subjectLine}`, link: "/inbox?cat=work-tasks" });
        done.push(`task ×${r.userIds.length}`);
      } else if (a.type === "WEBHOOK") {
        if (!a.endpointId) throw new Error("No webhook endpoint chosen.");
        const ep = await prisma.webhookEndpoint.findFirst({ where: { id: a.endpointId, tenantId, isActive: true, approvalStatus: "APPROVED" }, select: { id: true } });
        if (!ep) throw new Error("The webhook endpoint is not active and approved.");
        const n = await emitEvent(tenantId, "automation.triggered", { rule: rule.name, ruleId: rule.id, subjectType: subject.type, subjectId: subject.id, employeeNumber: emp?.employeeNumber ?? null, date: values.date || null }, ep.id);
        if (!n) throw new Error("The webhook delivery could not be queued.");
        done.push("webhook");
      } else if (a.type === "LETTER") {
        if (!emp) throw new Error("A letter needs an employee.");
        if (!a.templateId) throw new Error("No letter template chosen.");
        const issuer = rule.createdBy ?? (await usersWithPermission(tenantId, "document.letter.generate"))[0];
        if (!issuer) throw new Error("No one can issue letters.");
        const res = await generateLetter({ tenantId, templateId: a.templateId, employeeId: emp.id, issuedByEmployeeId: null, issuedByUserId: issuer, approverUserIds: await usersWithPermission(tenantId, "document.letter.generate") });
        if (!res.ok) throw new Error(res.message);
        done.push("letter");
      }
      ran++;
    } catch (err) {
      errors.push(`${a.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ran, errors, done };
}

async function fireOnce(rule: { id: string; tenantId: string; name: string; createdBy: string | null; actions: Prisma.JsonValue }, subject: AutomationSubject, dedupeKey: string, emp: EmployeeCtx | null, requesterUserId?: string | null): Promise<"ran" | "skipped" | "failed"> {
  const claimed = await prisma.automationRun.createMany({ data: [{ tenantId: rule.tenantId, ruleId: rule.id, dedupeKey, subjectType: subject.type, subjectId: subject.id, status: "RUNNING" }], skipDuplicates: true });
  if (claimed.count === 0) return "skipped"; // Already fired for this occasion.
  const res = await executeActions(rule, parseActions(rule.actions), subject, emp, requesterUserId);
  const status = res.errors.length === 0 ? "SUCCESS" : res.ran > 0 ? "PARTIAL" : "FAILED";
  await prisma.automationRun.update({
    where: { ruleId_dedupeKey: { ruleId: rule.id, dedupeKey } },
    data: { status, actionsRun: res.ran, detail: { done: res.done }, error: res.errors.join("; ") || null },
  });
  await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
  return status === "FAILED" ? "failed" : "ran";
}

function matchesFilters(rule: { departmentId: string | null; locationId: string | null }, emp: EmployeeCtx | null): boolean {
  if (rule.departmentId && emp?.departmentId !== rule.departmentId) return false;
  if (rule.locationId && emp?.locationId !== rule.locationId) return false;
  return true;
}

/** Workflow outcomes fire REQUEST_APPROVED / REQUEST_REJECTED rules straight away. */
export async function fireRequestAutomations(tenantId: string, outcome: "APPROVED" | "REJECTED", request: { id: string; entityType: string; title: string; subjectEmployeeId: string | null; requesterUserId: string }): Promise<number> {
  const trigger = outcome === "APPROVED" ? "REQUEST_APPROVED" : "REQUEST_REJECTED";
  const rules = await prisma.automationRule.findMany({ where: { tenantId, trigger, status: "ACTIVE" } });
  if (rules.length === 0) return 0;
  const emp = request.subjectEmployeeId ? await prisma.employee.findFirst({ where: { id: request.subjectEmployeeId, tenantId }, select: employeeSelect }) : null;
  let n = 0;
  for (const rule of rules) {
    if (rule.entityType && rule.entityType !== request.entityType) continue;
    if (!matchesFilters(rule, emp)) continue;
    const r = await fireOnce(rule, { type: "WorkflowRequest", id: request.id, employeeId: emp?.id ?? null, entityType: request.entityType, title: request.title, link: `/me/requests` }, request.id, emp, request.requesterUserId);
    if (r !== "skipped") n++;
  }
  return n;
}

/** Event triggers: employees added or changed since each rule last looked. */
export async function runEventAutomations(tenantId: string, now = new Date()): Promise<{ fired: number; failed: number }> {
  const rules = await prisma.automationRule.findMany({ where: { tenantId, status: "ACTIVE", trigger: { in: ["EMPLOYEE_CREATED", "EMPLOYEE_UPDATED"] } } });
  let fired = 0, failed = 0;
  for (const rule of rules) {
    const created = rule.trigger === "EMPLOYEE_CREATED";
    const emps = await prisma.employee.findMany({
      where: { tenantId, ...(created ? { createdAt: { gt: rule.watermark, lte: now } } : { updatedAt: { gt: rule.watermark, lte: now } }) },
      select: { ...employeeSelect, updatedAt: true }, take: 500, orderBy: created ? { createdAt: "asc" } : { updatedAt: "asc" },
    });
    for (const e of emps) {
      if (!matchesFilters(rule, e)) continue;
      const key = created ? `${e.id}` : `${e.id}:${e.updatedAt.toISOString()}`;
      const r = await fireOnce(rule, { type: "Employee", id: e.id, employeeId: e.id }, key, e);
      if (r === "ran") fired++; else if (r === "failed") failed++;
    }
    await prisma.automationRule.update({ where: { id: rule.id }, data: { watermark: now } });
  }
  return { fired, failed };
}

/** Date triggers due today (with each rule's offset). */
export async function runDateAutomations(tenantId: string, today = new Date()): Promise<{ fired: number; failed: number }> {
  const rules = await prisma.automationRule.findMany({ where: { tenantId, status: "ACTIVE", trigger: { in: [...DATE_TRIGGERS] } } });
  let fired = 0, failed = 0;
  for (const rule of rules) {
    const subjects: Array<{ type: string; id: string; employeeId: string; date: Date | null }> = [];
    if (rule.trigger === "BIRTHDAY" || rule.trigger === "WORK_ANNIVERSARY") {
      const emps = await prisma.employee.findMany({ where: { tenantId, status: { not: "EXITED" } }, select: { id: true, dateOfBirth: true, dateOfJoining: true } });
      for (const e of emps) subjects.push({ type: "Employee", id: e.id, employeeId: e.id, date: rule.trigger === "BIRTHDAY" ? e.dateOfBirth : e.dateOfJoining });
    } else if (rule.trigger === "PROBATION_END") {
      const rows = await prisma.employeeProbation.findMany({ where: { tenantId, status: { in: ["ACTIVE", "IN_REVIEW"] } }, select: { id: true, employeeId: true, endDate: true } });
      for (const r of rows) subjects.push({ type: "EmployeeProbation", id: r.id, employeeId: r.employeeId, date: r.endDate });
    } else if (rule.trigger === "CONTRACT_END") {
      const rows = await prisma.employeeContract.findMany({ where: { employee: { tenantId }, status: { in: ["ACTIVE", "EXPIRING"] }, endDate: { not: null } }, select: { id: true, employeeId: true, endDate: true } });
      for (const r of rows) subjects.push({ type: "EmployeeContract", id: r.id, employeeId: r.employeeId, date: r.endDate });
    } else if (rule.trigger === "DOCUMENT_EXPIRY") {
      const rows = await prisma.employeeDocument.findMany({ where: { tenantId, expiresOn: { not: null } }, select: { id: true, employeeId: true, expiresOn: true } });
      for (const r of rows) subjects.push({ type: "EmployeeDocument", id: r.id, employeeId: r.employeeId, date: r.expiresOn });
    }
    const due = subjects.map((s) => ({ ...s, occ: dateTriggerOccurrence(rule.trigger, s.date, today, rule.offsetDays) })).filter((s) => s.occ);
    if (due.length === 0) continue;
    const emps = new Map((await prisma.employee.findMany({ where: { tenantId, id: { in: due.map((d) => d.employeeId) } }, select: employeeSelect })).map((e) => [e.id, e]));
    for (const s of due) {
      const emp = emps.get(s.employeeId) ?? null;
      if (!emp || !matchesFilters(rule, emp)) continue;
      const r = await fireOnce(rule, { type: s.type, id: s.id, employeeId: emp.id, date: s.occ }, `${s.id}:${isoDay(s.occ!)}`, emp);
      if (r === "ran") fired++; else if (r === "failed") failed++;
    }
  }
  return { fired, failed };
}

/** "Test on an employee": run a rule's actions once now, whatever its trigger. */
export async function testAutomationRule(tenantId: string, ruleId: string, employeeId: string): Promise<{ ok: boolean; message: string }> {
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, tenantId } });
  if (!rule) return { ok: false, message: "Rule not found." };
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId }, select: employeeSelect });
  if (!emp) return { ok: false, message: "Employee not found." };
  const key = `test:${Date.now()}`;
  const r = await fireOnce(rule, { type: "Employee", id: emp.id, employeeId: emp.id, date: new Date() }, key, emp);
  const run = await prisma.automationRun.findUnique({ where: { ruleId_dedupeKey: { ruleId: rule.id, dedupeKey: key } } });
  return r === "failed" ? { ok: false, message: `The rule ran but failed: ${run?.error ?? "unknown error"}` } : { ok: true, message: `Ran ${run?.actionsRun ?? 0} action(s)${run?.error ? ` (some failed: ${run.error})` : ""}.` };
}

/** Re-run a failed firing (error recovery). */
export async function retryAutomationRun(tenantId: string, runId: string): Promise<{ ok: boolean; message: string }> {
  const run = await prisma.automationRun.findFirst({ where: { id: runId, tenantId }, include: { rule: true } });
  if (!run) return { ok: false, message: "Run not found." };
  if (run.status === "SUCCESS") return { ok: false, message: "That run succeeded; nothing to retry." };
  const emp = run.subjectType === "WorkflowRequest" ? null : await prisma.employee.findFirst({
    where: { tenantId, id: run.subjectType === "Employee" ? run.subjectId : undefined, ...(run.subjectType === "Employee" ? {} : { OR: [{ probation: { id: run.subjectId } }, { contracts: { some: { id: run.subjectId } } }, { documents: { some: { id: run.subjectId } } }] }) },
    select: employeeSelect,
  }).catch(() => null);
  await prisma.automationRun.delete({ where: { id: run.id } });
  const r = await fireOnce(run.rule, { type: run.subjectType, id: run.subjectId, employeeId: emp?.id ?? null }, run.dedupeKey, emp);
  return r === "failed" ? { ok: false, message: "Retried; it failed again. See the run log." } : { ok: true, message: "Retried successfully." };
}
