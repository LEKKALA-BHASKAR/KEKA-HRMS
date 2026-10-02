"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P, canAccessEmployee } from "@keka/rbac";
import { calculateRun, decideBonus, decideComponentClaim, notify, removeBonus, scheduleBonus } from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import {
  actionDone as done, parseForm, toErrorState, writeAudit, z, zBool, zId, zName, zNumber, zOptional, zOptionalId, zRequiredNumber, type ActionState,
} from "@/lib/forms";

/**
 * Bonus types, scheduled bonuses, and the run-time decisions on bonuses
 * (step 3) and reimbursement claims (step 4). Every decision inside a run
 * recalculates it, so the outcome panel always matches what was decided.
 */

const PATHS = ["/payroll/bonuses", "/finances/pay"];
const TARGET = { id: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } as const;

async function target(viewer: Viewer, employeeId: string) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: TARGET });
  return e && canAccessEmployee(viewer, e, P.PAYROLL_RUN) ? e : null;
}

const typeSchema = z.object({
  id: zOptionalId(), name: zName(60), description: zOptional(200),
  isPartOfCtc: zBool(), isTaxable: zBool(), affectsEsi: zBool(), isActive: zBool(),
});

export async function saveBonusTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const parsed = parseForm(typeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    if (await prisma.bonusType.findFirst({ where: { tenantId: viewer.tenantId, name: { equals: d.name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) } })) {
      return { ok: false, message: `There is already a bonus type called ${d.name}.`, errors: { name: "Already in use" } };
    }
    let savedId = id;
    if (id) {
      const u = await prisma.bonusType.updateMany({ where: { id, tenantId: viewer.tenantId }, data: d });
      if (!u.count) return { ok: false, message: "Bonus type not found." };
    } else savedId = (await prisma.bonusType.create({ data: { ...d, isActive: true, tenantId: viewer.tenantId } })).id;
    await writeAudit(viewer, { module: "PAYROLL", action: id ? "UPDATE" : "CREATE", entityType: "BonusType", entityId: savedId, summary: `Saved bonus type ${d.name}` });
    return done(PATHS, `Saved ${d.name}.`);
  } catch (err) { return toErrorState(err); }
}

export async function deleteBonusTypeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const t = await prisma.bonusType.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { _count: { select: { bonuses: true } } } });
  if (!t) return { ok: false, message: "Bonus type not found." };
  if (t._count.bonuses) {
    await prisma.bonusType.update({ where: { id }, data: { isActive: false } });
    await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "BonusType", entityId: id, summary: `Switched off bonus type ${t.name}` });
    return done(PATHS, `${t.name} has bonuses against it, so it was switched off instead of deleted.`);
  }
  await prisma.bonusType.delete({ where: { id } });
  await writeAudit(viewer, { module: "PAYROLL", action: "DELETE", entityType: "BonusType", entityId: id, summary: `Deleted bonus type ${t.name}` });
  return done(PATHS, `Deleted ${t.name}.`);
}

const bonusSchema = z.object({
  employeeId: zId(), bonusTypeId: zId(),
  amount: zRequiredNumber({ min: 1, max: 100_000_000 }),
  payout: z.string().regex(/^\d{4}-\d{2}$/, "Choose a month"),
  note: zOptional(200),
});

export async function scheduleBonusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(bonusSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const emp = await target(viewer, d.employeeId);
  if (!emp) return { ok: false, message: "That employee was not found.", errors: { employeeId: "Not found" } };
  const [y, m] = d.payout.split("-").map(Number);
  const res = await scheduleBonus({ tenantId: viewer.tenantId, employeeId: emp.id, bonusTypeId: d.bonusTypeId, amount: d.amount, payoutYear: y, payoutMonth: m, note: d.note });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "EmployeeBonus", entityId: res.id, summary: res.message });
  return done(PATHS, res.message);
}

export async function removeBonusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const id = String(formData.get("id") ?? "");
  const b = await prisma.employeeBonus.findFirst({ where: { id, employee: { tenantId: viewer.tenantId } }, select: { employeeId: true } });
  if (!b || !(await target(viewer, b.employeeId))) return { ok: false, message: "That bonus was not found." };
  const res = await removeBonus(viewer.tenantId, id);
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "PAYROLL", action: "DELETE", entityType: "EmployeeBonus", entityId: id, summary: "Removed a scheduled bonus" });
  return done(PATHS, res.message);
}

const decideSchema = z.object({
  runId: zId(), bonusId: zId(),
  action: z.enum(["PAY", "PARTIALLY_PAY", "ON_HOLD", "PAY_OUTSIDE_PAYROLL", "VOID"]),
  paidAmount: zNumber({ min: 0 }), note: zOptional(200),
});

export async function decideBonusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(decideSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const res = await decideBonus({ runId: d.runId, tenantId: viewer.tenantId, bonusId: d.bonusId, action: d.action, paidAmount: d.paidAmount, note: d.note });
  if (!res.ok) return res;
  await calculateRun(d.runId);
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "EmployeeBonus", entityId: d.bonusId, summary: res.message });
  return done([`/payroll/runs/${d.runId}`, ...PATHS], res.message);
}

const claimSchema = z.object({
  runId: zId(), claimId: zId(), decision: z.enum(["approve", "reject"]),
  payableAmount: zNumber({ min: 0 }), note: zOptional(300),
});

export async function decideClaimAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(claimSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const c = await prisma.componentClaim.findFirst({ where: { id: d.claimId, employee: { tenantId: viewer.tenantId } }, select: { employeeId: true } });
  if (!c || !(await target(viewer, c.employeeId))) return { ok: false, message: "That claim was not found." };
  if (c.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot decide your own claim." };
  const res = await decideComponentClaim({
    runId: d.runId, tenantId: viewer.tenantId, claimId: d.claimId, approve: d.decision === "approve",
    payableAmount: d.payableAmount, note: d.note, reviewerUserId: viewer.userId,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await calculateRun(d.runId);
  if (res.employeeUserId) {
    await notify({ tenantId: viewer.tenantId, userIds: [res.employeeUserId], kind: "PAYROLL", title: res.message, body: d.note, link: "/finances/pay/component-claims" });
  }
  await writeAudit(viewer, { module: "PAYROLL", action: d.decision === "approve" ? "APPROVE" : "REJECT", entityType: "ComponentClaim", entityId: d.claimId, summary: res.message });
  return done([`/payroll/runs/${d.runId}`, "/finances/pay/component-claims", "/inbox"], res.message);
}
