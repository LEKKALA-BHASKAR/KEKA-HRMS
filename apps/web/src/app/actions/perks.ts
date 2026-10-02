"use server";

import { prisma } from "@keka/db";
import { validateFormula } from "@keka/payroll";
import { PERMISSIONS as P, canAccessEmployee } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import {
  actionDone as done, parseForm, toErrorState, writeAudit, z, zBool, zId, zName, zNumber, zOptional, zOptionalId, type ActionState,
} from "@/lib/forms";

/**
 * Perquisites: company car, club membership, meal vouchers and the like.
 * Each perk is a salary component of type PERK with a valuation rule; giving
 * one to an employee makes its monthly value taxable salary from the start
 * date (shown on the payslip, never paid in cash), unless the employer bears
 * the tax on it.
 */

const PATHS = ["/payroll/perks"];
const TARGET = { id: true, displayName: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } as const;

const perkSchema = z.object({
  id: zOptionalId(),
  name: zName(60),
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Capitals, digits and underscores, starting with a letter"),
  category: zName(40),
  valuationMethod: z.enum(["FIXED_FOR_ALL", "FORMULA", "PER_EMPLOYEE"]),
  fixedAmount: zNumber({ min: 0, max: 10_000_000 }),
  formula: zOptional(300),
  isTaxable: zBool(),
  taxBorneByEmployer: zBool(),
});

export async function savePerkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const parsed = parseForm(perkSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, name, code, ...d } = parsed.data;
  if (d.valuationMethod === "FIXED_FOR_ALL" && !(d.fixedAmount && d.fixedAmount > 0)) return { ok: false, message: "Enter the monthly value.", errors: { fixedAmount: "Required" } };
  if (d.valuationMethod === "FORMULA") {
    if (!d.formula) return { ok: false, message: "Enter the formula.", errors: { formula: "Required" } };
    const v = validateFormula(d.formula);
    if (!v.valid) return { ok: false, message: v.error ?? "That formula cannot be read.", errors: { formula: v.error ?? "Invalid" } };
  }
  const perkData = {
    category: d.category, valuationMethod: d.valuationMethod, isTaxable: d.isTaxable, taxBorneByEmployer: d.isTaxable && d.taxBorneByEmployer,
    fixedAmount: d.valuationMethod === "FIXED_FOR_ALL" ? d.fixedAmount : null, formula: d.valuationMethod === "FORMULA" ? d.formula : null,
  };
  try {
    const clash = await prisma.salaryComponent.findFirst({ where: { tenantId: viewer.tenantId, code }, include: { perkDetail: { select: { id: true } } } });
    if (clash && (!id || clash.perkDetail?.id !== id)) {
      return { ok: false, message: `The code ${code} is already used by ${clash.name}.`, errors: { code: "Already in use" } };
    }
    if (id) {
      const perk = await prisma.perk.findFirst({ where: { id, component: { tenantId: viewer.tenantId } } });
      if (!perk) return { ok: false, message: "Perk not found." };
      await prisma.$transaction([
        prisma.salaryComponent.update({ where: { id: perk.componentId }, data: { name, code } }),
        prisma.perk.update({ where: { id }, data: perkData }),
      ]);
    } else {
      await prisma.salaryComponent.create({
        data: {
          tenantId: viewer.tenantId, code, name, type: "PERK", calculationType: "FIXED", isRecurring: true, isLopApplicable: false,
          affectsEsiGross: false, taxTreatment: d.isTaxable ? "FULLY_TAXABLE" : "FULLY_EXEMPT", perkDetail: { create: perkData },
        },
      });
    }
    await writeAudit(viewer, { module: "PAYROLL", action: id ? "UPDATE" : "CREATE", entityType: "Perk", entityId: id, summary: `Saved perk ${name} (${code})` });
    return done(PATHS, `Saved ${name}.`);
  } catch (err) { return toErrorState(err); }
}

export async function deletePerkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const perk = await prisma.perk.findFirst({ where: { id, component: { tenantId: viewer.tenantId } }, include: { component: true, _count: { select: { assignments: true } } } });
  if (!perk) return { ok: false, message: "Perk not found." };
  if (perk._count.assignments || await prisma.payslipLine.count({ where: { componentId: perk.componentId } })) {
    await prisma.salaryComponent.update({ where: { id: perk.componentId }, data: { isActive: false } });
    await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "Perk", entityId: id, summary: `Switched off perk ${perk.component.name}` });
    return done(PATHS, `${perk.component.name} has been given to people, so it was switched off instead of deleted. It no longer counts in payroll.`);
  }
  await prisma.salaryComponent.delete({ where: { id: perk.componentId } });
  await writeAudit(viewer, { module: "PAYROLL", action: "DELETE", entityType: "Perk", entityId: id, summary: `Deleted perk ${perk.component.name}` });
  return done(PATHS, `Deleted ${perk.component.name}.`);
}

const assignSchema = z.object({
  employeeId: zId(), perkId: zId(),
  monthlyValue: zNumber({ min: 0, max: 10_000_000 }),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  note: zOptional(200),
});

export async function assignPerkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(assignSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const [emp, perk] = await Promise.all([
    prisma.employee.findFirst({ where: { id: d.employeeId, tenantId: viewer.tenantId }, select: { ...TARGET, status: true } }),
    prisma.perk.findFirst({ where: { id: d.perkId, component: { tenantId: viewer.tenantId, isActive: true } }, include: { component: { select: { name: true } } } }),
  ]);
  if (!emp || !canAccessEmployee(viewer, emp, P.PAYROLL_RUN)) return { ok: false, message: "That employee was not found.", errors: { employeeId: "Not found" } };
  if (emp.status === "EXITED") return { ok: false, message: `${emp.displayName} has left.` };
  if (!perk) return { ok: false, message: "Choose an active perk.", errors: { perkId: "Required" } };
  if (perk.valuationMethod === "PER_EMPLOYEE" && !(d.monthlyValue && d.monthlyValue > 0)) {
    return { ok: false, message: `${perk.component.name} is valued per employee; enter its monthly value.`, errors: { monthlyValue: "Required" } };
  }
  const start = new Date(`${d.startDate}T00:00:00Z`);
  const open = await prisma.employeePerk.findFirst({ where: { employeeId: emp.id, perkId: perk.id, OR: [{ endDate: null }, { endDate: { gte: start } }] } });
  if (open) return { ok: false, message: `${emp.displayName} already has ${perk.component.name}. End it first to change its value.` };
  const a = await prisma.employeePerk.create({
    data: { employeeId: emp.id, perkId: perk.id, monthlyValue: perk.valuationMethod === "PER_EMPLOYEE" ? d.monthlyValue : null, startDate: start, note: d.note },
  });
  const message = `${perk.component.name} given to ${emp.displayName} from ${d.startDate}.`;
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "EmployeePerk", entityId: a.id, summary: message });
  return done(PATHS, message);
}

const endSchema = z.object({ id: zId(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date") });

export async function endPerkAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const parsed = parseForm(endSchema, formData);
  if (parsed.state) return parsed.state;
  const a = await prisma.employeePerk.findFirst({
    where: { id: parsed.data.id, employee: { tenantId: viewer.tenantId } },
    include: { employee: { select: TARGET }, perk: { include: { component: { select: { name: true } } } } },
  });
  if (!a || !canAccessEmployee(viewer, a.employee, P.PAYROLL_RUN)) return { ok: false, message: "Not found." };
  const end = new Date(`${parsed.data.endDate}T00:00:00Z`);
  if (end < a.startDate) return { ok: false, message: "The end date cannot be before the start date.", errors: { endDate: "Too early" } };
  await prisma.employeePerk.update({ where: { id: a.id }, data: { endDate: end } });
  const message = `${a.perk.component.name} for ${a.employee.displayName} ends on ${parsed.data.endDate}.`;
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "EmployeePerk", entityId: a.id, summary: message });
  return done(PATHS, message);
}
