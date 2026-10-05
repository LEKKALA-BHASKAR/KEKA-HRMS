"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { validateFormula, resolveStructure, topologicalOrder } from "@keka/payroll";
import { approvalRequired, raiseChangeRequest } from "@keka/services";
import { requireAuth } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done, formList,
  zName, zOptional, zNumber, zRequiredNumber, zDate, zBool, zId, zOptionalId, zPan,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

const isoOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/**
 * Establishment registrations and registration profiles can be made to need
 * a second person's approval (Settings › Changes that need approval), or
 * the person saving can ask for it. Returns the result when a change
 * request was raised instead of saving; null to save directly.
 */
async function proposeStatutoryChange(viewer: Awaited<ReturnType<typeof requireAuth>>, formData: FormData, targetType: "ESTABLISHMENT" | "REGISTRATION_PROFILE", targetId: string, title: string, changes: Record<string, unknown>, previous: Record<string, unknown> | null): Promise<ActionState | null> {
  if (formData.get("propose") !== "on" && !(await approvalRequired(viewer.tenantId, targetType))) return null;
  const plainOf = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Date ? isoOf(v) : v !== null && typeof v === "object" && !Array.isArray(v) ? String(v) : v]));
  const res = await raiseChangeRequest({
    tenantId: viewer.tenantId, targetType, targetId, operation: "UPDATE", title, changes: plainOf(changes), previous: previous ? plainOf(previous) : null,
    reason: String(formData.get("reason") ?? "").trim() || null, requestedBy: viewer.user.id, requestedByEmployeeId: viewer.employee?.id ?? null,
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "ChangeRequest", entityId: res.id, summary: `Asked for approval: ${title}` });
  return done(["/payroll/pay-groups", "/admin/change-requests"], `${res.message} It is saved once another administrator approves it.`);
}

/**
 * Payroll configuration CRUD: pay groups, their statutory filing details and
 * state registrations, the component repository, and salary structures.
 *
 * Every structure write is validated by actually resolving it against a
 * sample CTC with the real engine. A formula that parses but cycles, or a
 * structure whose components exceed the CTC, is caught here rather than in
 * the middle of someone's payroll run.
 */

// ---------------------------------------------------------------------------
//  PAY GROUP
// ---------------------------------------------------------------------------

const payGroupSchema = z.object({
  id: zOptionalId(),
  legalEntityId: zId(),
  name: zName(80),
  description: zOptional(300),
  frequency: z.enum(["MONTHLY", "SEMI_MONTHLY", "WEEKLY", "BI_WEEKLY"]).default("MONTHLY"),
  payPeriodStartDay: zNumber({ min: 1, max: 28 }),
  payPeriodEndDay: zNumber({ min: 0, max: 31 }),
  attendanceCutoffDay: zNumber({ min: 1, max: 31 }),
  payDay: zNumber({ min: 1, max: 31 }),
  pfEnabled: zBool(), esiEnabled: zBool(), ptEnabled: zBool(),
  lwfEnabled: zBool(), tdsEnabled: zBool(),
  declarationOpenDay: zNumber({ min: 1, max: 31 }),
  declarationCloseDay: zNumber({ min: 1, max: 31 }),
  declarationFyCutoff: zDate(),
  newJoinerWindowDays: zNumber({ min: 0, max: 365 }),
  proofSubmissionDue: zDate(),
  proofMandatory: zBool(),
  allowLateDeclaration: zBool(),
  allowRegimeChoice: zBool(),
  regimeChangeCutoff: zDate(),
  approvalWorkflowEnabled: zBool(),
}).refine(
  (v) => v.declarationOpenDay === null || v.declarationCloseDay === null || v.declarationCloseDay >= v.declarationOpenDay,
  { message: "The window must close on or after the day it opens", path: ["declarationCloseDay"] },
);

export async function savePayGroup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYGROUP_MANAGE);
  const parsed = parseForm(payGroupSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...raw } = parsed.data;

  const entity = await prisma.legalEntity.findFirst({
    where: { id: raw.legalEntityId, tenantId: viewer.tenantId }, select: { id: true },
  });
  if (!entity) return { ok: false, message: "Legal entity not found" };

  const data = {
    ...raw,
    payPeriodStartDay: raw.payPeriodStartDay ?? 1,
    payPeriodEndDay: raw.payPeriodEndDay ?? 0,
    payDay: raw.payDay ?? 1,
    declarationOpenDay: raw.declarationOpenDay ?? 1,
    declarationCloseDay: raw.declarationCloseDay ?? 22,
    newJoinerWindowDays: raw.newJoinerWindowDays ?? 30,
  };

  try {
    if (id) {
      const before = await prisma.payGroup.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Pay group not found" };

      // Changing the legal entity moves everyone in the group with it.
      const entityChanged = before.legalEntityId !== data.legalEntityId;
      await prisma.$transaction(async (tx) => {
        await tx.payGroup.update({ where: { id }, data });
        if (entityChanged) {
          await tx.employee.updateMany({
            where: { payGroupId: id }, data: { legalEntityId: data.legalEntityId },
          });
        }
      });

      await writeAudit(viewer, {
        module: "PAYROLL", action: "UPDATE", entityType: "PayGroup", entityId: id,
        summary: `Updated pay group ${data.name}${entityChanged ? " — legal entity changed, members synchronised" : ""}`,
        oldValue: { pfEnabled: before.pfEnabled, esiEnabled: before.esiEnabled, attendanceCutoffDay: before.attendanceCutoffDay },
        newValue: { pfEnabled: data.pfEnabled, esiEnabled: data.esiEnabled, attendanceCutoffDay: data.attendanceCutoffDay },
      });
      return done(["/payroll/pay-groups"], entityChanged
        ? `Saved. Every employee in ${data.name} moved to the new legal entity.`
        : `Saved ${data.name}.`);
    }

    const created = await prisma.payGroup.create({
      data: {
        ...data,
        tenantId: viewer.tenantId,
        // Sensible defaults so the group is usable immediately.
        filingDetail: { create: {} },
        payslipSetting: { create: {} },
        payRegisterConfig: { create: { columns: [] } },
      },
    });

    // New groups inherit every active component, so a structure can be built
    // straight away rather than after a separate assignment step.
    const components = await prisma.salaryComponent.findMany({
      where: { tenantId: viewer.tenantId, isActive: true }, select: { id: true },
    });
    if (components.length > 0) {
      await prisma.payGroupComponent.createMany({
        data: components.map((c) => ({ payGroupId: created.id, componentId: c.id })),
        skipDuplicates: true,
      });
    }

    await writeAudit(viewer, {
      module: "PAYROLL", action: "CREATE", entityType: "PayGroup", entityId: created.id,
      summary: `Created pay group ${data.name} with ${components.length} components`,
    });
    return done(["/payroll/pay-groups"],
      `Created ${data.name}. Add its PF/ESI registration numbers and state PT/LWF registrations next.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deletePayGroup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYGROUP_MANAGE);
  const id = String(formData.get("id"));
  const group = await prisma.payGroup.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { employees: true, payrollRuns: true } } },
  });
  if (!group) return { ok: false, message: "Pay group not found" };
  if (group._count.employees > 0) {
    return { ok: false, message: `${group._count.employees} employee(s) are in this pay group. Move them first.` };
  }
  if (group._count.payrollRuns > 0) {
    // Runs are a legal record; deleting the group would destroy payslip history.
    return { ok: false, message: `${group._count.payrollRuns} payroll run(s) exist for this group. It can be deactivated but not deleted.` };
  }
  await prisma.payGroup.delete({ where: { id } });
  await writeAudit(viewer, {
    module: "PAYROLL", action: "DELETE", entityType: "PayGroup", entityId: id,
    summary: `Deleted pay group ${group.name}`,
  });
  return done(["/payroll/pay-groups"], `Deleted ${group.name}.`);
}

// ---------------------------------------------------------------------------
//  FILING DETAILS — income tax, PF, ESI
// ---------------------------------------------------------------------------

const filingSchema = z.object({
  payGroupId: zId(),
  pan: zPan(),
  tan: z.string().optional().transform((v, ctx) => {
    if (!v) return null;
    const up = v.toUpperCase();
    if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(up)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TAN is 4 letters, 5 digits, 1 letter" });
    }
    return up;
  }),
  tanCircle: zOptional(120),
  citTds: zOptional(120),
  form16SignatoryName: zOptional(120),
  form16SignatoryDesignation: zOptional(120),
  form16SignatoryPan: zPan(),
  responsiblePersonName: zOptional(120),
  responsiblePersonDesignation: zOptional(120),
  responsiblePersonPan: zPan(),
  pfRegistrationNumber: zOptional(40),
  pfRegistrationDate: zDate(),
  pfSignatoryName: zOptional(120),
  pfWageCeiling: zRequiredNumber({ min: 0 }),
  pfCapAtCeiling: zBool(),
  pfEmployeeRate: zRequiredNumber({ min: 0, max: 100 }),
  pfEmployerRate: zRequiredNumber({ min: 0, max: 100 }),
  epsRate: zRequiredNumber({ min: 0, max: 100 }),
  epsWageCeiling: zRequiredNumber({ min: 0 }),
  edliRate: zRequiredNumber({ min: 0, max: 10 }),
  pfAdminRate: zRequiredNumber({ min: 0, max: 10 }),
  esiRegistrationNumber: zOptional(40),
  esiRegistrationDate: zDate(),
  esiSignatoryName: zOptional(120),
  esiWageLimit: zRequiredNumber({ min: 0 }),
  esiEmployeeRate: zRequiredNumber({ min: 0, max: 100 }),
  esiEmployerRate: zRequiredNumber({ min: 0, max: 100 }),
  esiEmployerInsideCtc: zBool(),
  esiHideEmployerOnPayslip: zBool(),
  esiIncludeArrears: zBool(),
}).refine((v) => v.epsRate <= v.pfEmployerRate, {
  message: "EPS is carved out of the employer's PF share, so it cannot exceed it",
  path: ["epsRate"],
});

export async function saveFilingDetails(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const parsed = parseForm(filingSchema, formData);
  if (parsed.state) return parsed.state;
  const { payGroupId, ...data } = parsed.data;

  const group = await prisma.payGroup.findFirst({
    where: { id: payGroupId, tenantId: viewer.tenantId }, include: { filingDetail: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };
  const proposed = await proposeStatutoryChange(viewer, formData, "REGISTRATION_PROFILE", group.id, `Update the registration profile of ${group.name}`, { payGroupId, ...data }, group.filingDetail ? { ...group.filingDetail } : null);
  if (proposed) return proposed;

  try {
    await prisma.payGroupFilingDetail.upsert({
      where: { payGroupId },
      create: { payGroupId, ...data },
      update: data,
    });
    const before = group.filingDetail;
    const ratesChanged = before && (
      Number(before.pfWageCeiling) !== data.pfWageCeiling ||
      Number(before.esiWageLimit) !== data.esiWageLimit ||
      Number(before.pfEmployeeRate) !== data.pfEmployeeRate
    );
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "PayGroupFilingDetail", entityId: payGroupId,
      summary: `Updated statutory filing details for ${group.name}${ratesChanged ? " — statutory rates or ceilings changed" : ""}`,
      oldValue: before ? {
        pfWageCeiling: Number(before.pfWageCeiling), esiWageLimit: Number(before.esiWageLimit),
        pfEmployeeRate: Number(before.pfEmployeeRate),
      } : undefined,
      newValue: { pfWageCeiling: data.pfWageCeiling, esiWageLimit: data.esiWageLimit, pfEmployeeRate: data.pfEmployeeRate },
    });
    return done(["/payroll/pay-groups", "/payroll/statutory"],
      ratesChanged
        ? "Saved. Statutory rates changed — open payroll runs pick this up on their next recalculation."
        : "Saved.");
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

// ---------------------------------------------------------------------------
//  STATE REGISTRATIONS — Professional Tax and LWF
// ---------------------------------------------------------------------------

const ptRegSchema = z.object({
  payGroupId: zId(),
  stateCode: z.string().min(2).max(2).transform((v) => v.toUpperCase()),
  stateName: zName(60),
  localBodyType: z.string().optional().transform((v) => v ?? ""),
  establishmentId: zOptional(40),
  registrationDate: zDate(),
  signatoryName: zOptional(120),
  frequency: z.enum(["MONTHLY", "HALF_YEARLY", "ANNUAL"]),
});

export async function savePtRegistration(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const parsed = parseForm(ptRegSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const locationIds = formList(formData, "locationIds");

  const group = await prisma.payGroup.findFirst({
    where: { id: d.payGroupId, tenantId: viewer.tenantId }, select: { id: true, name: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };

  // A registration with no slabs would silently deduct nothing.
  const slabCount = await prisma.ptSlab.count({
    where: {
      stateCode: d.stateCode,
      ...(d.localBodyType ? { OR: [{ localBodyType: d.localBodyType }, { localBodyType: null }] } : {}),
    },
  });

  // Every linked location must actually be in this state.
  if (locationIds.length > 0) {
    const locs = await prisma.location.findMany({
      where: { id: { in: locationIds }, tenantId: viewer.tenantId },
      select: { id: true, name: true, stateCode: true },
    });
    if (locs.length !== new Set(locationIds).size) return { ok: false, message: "A selected location was not found." };
    const wrong = locs.filter((l) => l.stateCode !== d.stateCode);
    if (wrong.length > 0) {
      return {
        ok: false,
        message: `${wrong.map((l) => `${l.name} (${l.stateCode})`).join(", ")} ${wrong.length === 1 ? "is" : "are"} not in ${d.stateCode}. A location can only follow its own state's PT rules.`,
      };
    }
  }

  const ptProposed = await proposeStatutoryChange(viewer, formData, "ESTABLISHMENT", `PT:${d.payGroupId}:${d.stateCode}:${d.localBodyType}`, `${d.stateCode} PT registration on ${group.name}`, { kind: "PT", ...d, locationIds }, null);
  if (ptProposed) return ptProposed;

  try {
    await prisma.$transaction(async (tx) => {
      const reg = await tx.ptStateRegistration.upsert({
        where: {
          payGroupId_stateCode_localBodyType: {
            payGroupId: d.payGroupId, stateCode: d.stateCode, localBodyType: d.localBodyType,
          },
        },
        create: {
          payGroupId: d.payGroupId, stateCode: d.stateCode, stateName: d.stateName,
          localBodyType: d.localBodyType, establishmentId: d.establishmentId,
          registrationDate: d.registrationDate, signatoryName: d.signatoryName,
          frequency: d.frequency,
        },
        update: {
          stateName: d.stateName, establishmentId: d.establishmentId,
          registrationDate: d.registrationDate, signatoryName: d.signatoryName,
          frequency: d.frequency,
        },
      });

      // A location follows exactly one PT registration per pay group.
      await tx.ptStateRegistrationLocation.deleteMany({
        where: {
          locationId: { in: locationIds },
          registration: { payGroupId: d.payGroupId },
        },
      });
      await tx.ptStateRegistrationLocation.deleteMany({ where: { registrationId: reg.id } });
      if (locationIds.length > 0) {
        await tx.ptStateRegistrationLocation.createMany({
          data: locationIds.map((locationId) => ({ registrationId: reg.id, locationId })),
        });
      }
    });

    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "PtStateRegistration", entityId: d.payGroupId,
      summary: `Saved ${d.stateCode} PT registration on ${group.name}, linking ${locationIds.length} location(s)`,
    });
    return done(["/payroll/pay-groups", "/org"],
      slabCount === 0
        ? `Saved, but there are no PT slabs for ${d.stateCode}. Nothing will be deducted until slabs are loaded — check whether the state levies PT at all.`
        : `Saved the ${d.stateCode} registration with ${locationIds.length} linked location(s).`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

const lwfRegSchema = z.object({
  payGroupId: zId(),
  stateCode: z.string().min(2).max(2).transform((v) => v.toUpperCase()),
  stateName: zName(60),
  establishmentId: zOptional(40),
  registrationDate: zDate(),
  signatoryName: zOptional(120),
  employerInsideCtc: zBool(),
  hideEmployerOnPayslip: zBool(),
  prorateNewJoiners: zBool(),
});

export async function saveLwfRegistration(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const parsed = parseForm(lwfRegSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const locationIds = formList(formData, "locationIds");

  const group = await prisma.payGroup.findFirst({
    where: { id: d.payGroupId, tenantId: viewer.tenantId }, select: { id: true, name: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };

  if (locationIds.length > 0) {
    const locs = await prisma.location.findMany({
      where: { id: { in: locationIds }, tenantId: viewer.tenantId },
      select: { name: true, stateCode: true },
    });
    if (locs.length !== new Set(locationIds).size) return { ok: false, message: "A selected location was not found." };
    const wrong = locs.filter((l) => l.stateCode !== d.stateCode);
    if (wrong.length > 0) {
      return {
        ok: false,
        message: `${wrong.map((l) => `${l.name} (${l.stateCode})`).join(", ")} ${wrong.length === 1 ? "is" : "are"} not in ${d.stateCode}.`,
      };
    }
  }

  const hasRule = await prisma.lwfRule.count({ where: { stateCode: d.stateCode } });
  const lwfProposed = await proposeStatutoryChange(viewer, formData, "ESTABLISHMENT", `LWF:${d.payGroupId}:${d.stateCode}`, `${d.stateCode} LWF registration on ${group.name}`, { kind: "LWF", ...d, locationIds }, null);
  if (lwfProposed) return lwfProposed;

  try {
    await prisma.$transaction(async (tx) => {
      const reg = await tx.lwfStateRegistration.upsert({
        where: { payGroupId_stateCode: { payGroupId: d.payGroupId, stateCode: d.stateCode } },
        create: {
          payGroupId: d.payGroupId, stateCode: d.stateCode, stateName: d.stateName,
          establishmentId: d.establishmentId, registrationDate: d.registrationDate,
          signatoryName: d.signatoryName, employerInsideCtc: d.employerInsideCtc,
          hideEmployerOnPayslip: d.hideEmployerOnPayslip, prorateNewJoiners: d.prorateNewJoiners,
        },
        update: {
          stateName: d.stateName, establishmentId: d.establishmentId,
          registrationDate: d.registrationDate, signatoryName: d.signatoryName,
          employerInsideCtc: d.employerInsideCtc,
          hideEmployerOnPayslip: d.hideEmployerOnPayslip, prorateNewJoiners: d.prorateNewJoiners,
        },
      });
      await tx.lwfStateRegistrationLocation.deleteMany({
        where: { locationId: { in: locationIds }, registration: { payGroupId: d.payGroupId } },
      });
      await tx.lwfStateRegistrationLocation.deleteMany({ where: { registrationId: reg.id } });
      if (locationIds.length > 0) {
        await tx.lwfStateRegistrationLocation.createMany({
          data: locationIds.map((locationId) => ({ registrationId: reg.id, locationId })),
        });
      }
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "LwfStateRegistration", entityId: d.payGroupId,
      summary: `Saved ${d.stateCode} LWF registration on ${group.name}, linking ${locationIds.length} location(s)`,
    });
    return done(["/payroll/pay-groups", "/org"],
      hasRule === 0
        ? `Saved, but ${d.stateCode} has no LWF contribution rule — many states have no LWF scheme at all, in which case nothing will be deducted.`
        : `Saved the ${d.stateCode} LWF registration.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteStateRegistration(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.STATUTORY_MANAGE);
  const kind = String(formData.get("kind"));
  const id = String(formData.get("id"));

  if (kind === "pt") {
    const reg = await prisma.ptStateRegistration.findUnique({
      where: { id }, include: { payGroup: { select: { tenantId: true } } },
    });
    if (!reg || reg.payGroup.tenantId !== viewer.tenantId) return { ok: false, message: "Not found" };
    await prisma.ptStateRegistration.delete({ where: { id } });
    return done(["/payroll/pay-groups", "/org"], `Removed the ${reg.stateCode} PT registration.`);
  }
  if (kind === "lwf") {
    const reg = await prisma.lwfStateRegistration.findUnique({
      where: { id }, include: { payGroup: { select: { tenantId: true } } },
    });
    if (!reg || reg.payGroup.tenantId !== viewer.tenantId) return { ok: false, message: "Not found" };
    await prisma.lwfStateRegistration.delete({ where: { id } });
    return done(["/payroll/pay-groups", "/org"], `Removed the ${reg.stateCode} LWF registration.`);
  }
  return { ok: false, message: "Unknown registration type" };
}

// ---------------------------------------------------------------------------
//  SALARY COMPONENTS
// ---------------------------------------------------------------------------

const componentSchema = z.object({
  id: zOptionalId(),
  code: z.string().min(1, "Required").max(30)
    .regex(/^[A-Z][A-Z0-9_]*$/i, "Letters, digits and underscores; must start with a letter")
    .transform((v) => v.toUpperCase()),
  name: zName(80),
  displayName: zOptional(80),
  type: z.enum(["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "PERK"]),
  calculationType: z.enum(["FIXED", "PERCENTAGE", "FORMULA", "BALANCE"]).default("FORMULA"),
  taxTreatment: z.enum(["FULLY_TAXABLE", "PARTIALLY_EXEMPT", "FULLY_EXEMPT"]).default("FULLY_TAXABLE"),
  isRecurring: zBool(),
  isPartOfFbp: zBool(),
  isOutsideCtc: zBool(),
  isLopApplicable: zBool(),
  isArrearApplicable: zBool(),
  affectsPfWage: zBool(),
  affectsEsiGross: zBool(),
  showOnPayslip: zBool(),
  annualExemptLimit: zNumber({ min: 0 }),
  taxSection: zOptional(20),
  displayOrder: zNumber({ min: 0, max: 9999 }),
});

/** Codes the engine itself emits. A user component with one of these would collide. */
const RESERVED_CODES = new Set([
  "CTC", "CTC_ANNUAL", "CTC_MONTHLY", "GROSS",
  "ARREARS", "BONUS", "OVERTIME", "SHIFT_ALLOWANCE", "UNIT_PAY",
  "EPS", "EDLI", "PF_ADMIN",
]);

export async function saveComponent(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const parsed = parseForm(componentSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, displayOrder, ...data } = parsed.data;

  if (RESERVED_CODES.has(data.code)) {
    return {
      ok: false,
      message: `${data.code} is reserved — the payroll engine emits a line with that code itself.`,
      errors: { code: "Reserved code" },
    };
  }
  // A reimbursement is not taxable income by definition.
  if (data.type === "REIMBURSEMENT" && data.taxTreatment === "FULLY_TAXABLE") {
    return {
      ok: false,
      message: "A reimbursement is tax-exempt by definition. Use an EARNING if it should be taxed.",
      errors: { taxTreatment: "Conflicts with type" },
    };
  }

  try {
    if (id) {
      const before = await prisma.salaryComponent.findFirst({
        where: { id, tenantId: viewer.tenantId },
      });
      if (!before) return { ok: false, message: "Component not found" };
      if (before.isSystem && before.code !== data.code) {
        return { ok: false, message: "A system component's code cannot be changed." };
      }
      await prisma.salaryComponent.update({
        where: { id }, data: { ...data, displayOrder: displayOrder ?? before.displayOrder },
      });
      await writeAudit(viewer, {
        module: "PAYROLL", action: "UPDATE", entityType: "SalaryComponent", entityId: id,
        summary: `Updated component ${data.code}`,
      });
      return done(["/payroll/structures"], `Saved ${data.name}.`);
    }

    const created = await prisma.salaryComponent.create({
      data: { ...data, displayOrder: displayOrder ?? 100, tenantId: viewer.tenantId },
    });
    // Make it available to every pay group straight away.
    const groups = await prisma.payGroup.findMany({
      where: { tenantId: viewer.tenantId }, select: { id: true },
    });
    await prisma.payGroupComponent.createMany({
      data: groups.map((g) => ({ payGroupId: g.id, componentId: created.id })),
      skipDuplicates: true,
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "CREATE", entityType: "SalaryComponent", entityId: created.id,
      summary: `Created component ${data.code} (${data.type.toLowerCase()})`,
    });
    return done(["/payroll/structures"], `Created ${data.name}. Add it to a structure to put it into use.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteComponent(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const id = String(formData.get("id"));
  const comp = await prisma.salaryComponent.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { structureLines: true, payslipLines: true } } },
  });
  if (!comp) return { ok: false, message: "Component not found" };
  if (comp.isSystem) return { ok: false, message: "System components cannot be deleted." };
  if (comp._count.structureLines > 0) {
    return { ok: false, message: `${comp._count.structureLines} structure(s) use ${comp.code}. Remove it from them first.` };
  }
  if (comp._count.payslipLines > 0) {
    // Payslip history references it; deactivate rather than destroy.
    await prisma.salaryComponent.update({ where: { id }, data: { isActive: false } });
    return done(["/payroll/structures"],
      `${comp.code} appears on past payslips, so it was deactivated rather than deleted.`);
  }
  await prisma.salaryComponent.delete({ where: { id } });
  return done(["/payroll/structures"], `Deleted ${comp.code}.`);
}

// ---------------------------------------------------------------------------
//  SALARY STRUCTURES
// ---------------------------------------------------------------------------

const structureSchema = z.object({
  id: zOptionalId(),
  payGroupId: zId(),
  name: zName(80),
  description: zOptional(300),
  type: z.enum(["RANGE_BASED", "CUSTOM", "DAILY_WAGE"]).default("CUSTOM"),
  minAnnualCtc: zNumber({ min: 0 }),
  maxAnnualCtc: zNumber({ min: 0 }),
  pfEnabled: zBool(),
  esiEnabled: zBool(),
  tdsMethod: z.enum(["AVERAGE", "FLAT", "NONE"]).default("AVERAGE"),
  isPartOfFbp: zBool(),
  roundComponents: zBool(),
  isDefault: zBool(),
  isActive: zBool(),
}).refine(
  (v) => v.minAnnualCtc === null || v.maxAnnualCtc === null || v.maxAnnualCtc >= v.minAnnualCtc,
  { message: "The upper bound must be at or above the lower bound", path: ["maxAnnualCtc"] },
);

export async function saveStructure(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const parsed = parseForm(structureSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;

  const group = await prisma.payGroup.findFirst({
    where: { id: data.payGroupId, tenantId: viewer.tenantId }, select: { id: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };

  // Range-based structures must not overlap each other, or the CTC matcher
  // becomes order-dependent.
  if (data.type === "RANGE_BASED" && data.minAnnualCtc !== null) {
    const siblings = await prisma.salaryStructure.findMany({
      where: {
        payGroupId: data.payGroupId, type: "RANGE_BASED", isActive: true,
        ...(id ? { id: { not: id } } : {}),
      },
      select: { name: true, minAnnualCtc: true, maxAnnualCtc: true },
    });
    const lo = data.minAnnualCtc;
    const hi = data.maxAnnualCtc ?? Number.POSITIVE_INFINITY;
    const overlap = siblings.find((s) => {
      const sLo = Number(s.minAnnualCtc ?? 0);
      const sHi = s.maxAnnualCtc === null ? Number.POSITIVE_INFINITY : Number(s.maxAnnualCtc);
      return lo <= sHi && sLo <= hi;
    });
    if (overlap) {
      return {
        ok: false,
        message: `This range overlaps "${overlap.name}". Range-based structures must not overlap, or which one a CTC matches becomes arbitrary.`,
        errors: { minAnnualCtc: "Overlaps another structure" },
      };
    }
  }

  try {
    const saved = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.salaryStructure.updateMany({
          where: { payGroupId: data.payGroupId }, data: { isDefault: false },
        });
      }
      if (id) {
        const u = await tx.salaryStructure.updateMany({
          where: { id, payGroup: { tenantId: viewer.tenantId } }, data,
        });
        if (u.count === 0) throw new Error("Structure not found");
        return id;
      }
      const c = await tx.salaryStructure.create({ data });
      return c.id;
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: id ? "UPDATE" : "CREATE", entityType: "SalaryStructure",
      entityId: saved, summary: `${id ? "Updated" : "Created"} structure ${data.name}`,
    });
    return done(["/payroll/structures"],
      id ? `Saved ${data.name}.` : `Created ${data.name}. Add its components next.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function cloneStructure(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const id = String(formData.get("id"));
  const newName = String(formData.get("name") ?? "").trim();

  const src = await prisma.salaryStructure.findFirst({
    where: { id, payGroup: { tenantId: viewer.tenantId } },
    include: { components: true },
  });
  if (!src) return { ok: false, message: "Structure not found" };
  const name = newName || `${src.name} (copy)`;

  try {
    await prisma.salaryStructure.create({
      data: {
        payGroupId: src.payGroupId, name, description: src.description,
        // A clone starts as CUSTOM so it cannot collide with the source's range.
        type: "CUSTOM",
        pfEnabled: src.pfEnabled, esiEnabled: src.esiEnabled, tdsMethod: src.tdsMethod,
        isPartOfFbp: src.isPartOfFbp, roundComponents: src.roundComponents,
        isDefault: false, isActive: true,
        components: {
          create: src.components.map((c) => ({
            componentId: c.componentId, calculationType: c.calculationType,
            formula: c.formula, fixedAmount: c.fixedAmount, percentage: c.percentage,
            percentageOf: c.percentageOf, sequence: c.sequence,
            minAmount: c.minAmount, maxAmount: c.maxAmount, isActive: c.isActive,
          })),
        },
      },
    });
    return done(["/payroll/structures"], `Cloned into ${name}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function deleteStructure(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const id = String(formData.get("id"));
  const st = await prisma.salaryStructure.findFirst({
    where: { id, payGroup: { tenantId: viewer.tenantId } },
    include: { _count: { select: { revisions: true } } },
  });
  if (!st) return { ok: false, message: "Structure not found" };
  if (st._count.revisions > 0) {
    await prisma.salaryStructure.update({ where: { id }, data: { isActive: false } });
    return done(["/payroll/structures"],
      `${st._count.revisions} salary revision(s) reference ${st.name}, so it was deactivated rather than deleted.`);
  }
  await prisma.salaryStructure.delete({ where: { id } });
  return done(["/payroll/structures"], `Deleted ${st.name}.`);
}

// ---------------------------------------------------------------------------
//  STRUCTURE LINES — validated by resolving against the real engine
// ---------------------------------------------------------------------------

const lineSchema = z.object({
  structureId: zId(),
  componentId: zId(),
  calculationType: z.enum(["FIXED", "PERCENTAGE", "FORMULA", "BALANCE"]),
  formula: zOptional(500),
  fixedAmount: zNumber({ min: 0 }),
  percentage: zNumber({ min: 0, max: 1000 }),
  percentageOf: zOptional(30),
  sequence: zNumber({ min: 0, max: 9999 }),
  minAmount: zNumber({ min: 0 }),
  maxAmount: zNumber({ min: 0 }),
});

/**
 * Resolve the structure as it would stand after this change, against a CTC
 * inside its own range. Returns the engine's warnings, or a thrown formula
 * error, so a broken structure is refused before it can reach a payroll run.
 */
async function dryRunStructure(
  structureId: string,
  change: { componentId: string; line: Record<string, unknown> } | { removeComponentId: string },
): Promise<{ ok: true; warnings: string[] } | { ok: false; message: string }> {
  const structure = await prisma.salaryStructure.findUniqueOrThrow({
    where: { id: structureId },
    include: { components: { include: { component: true } } },
  });

  const rows = structure.components.map((sc) => ({
    componentId: sc.componentId,
    code: sc.component.code, name: sc.component.name, type: sc.component.type,
    calculationType: sc.calculationType, formula: sc.formula,
    fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
    percentage: sc.percentage === null ? null : Number(sc.percentage),
    percentageOf: sc.percentageOf, sequence: sc.sequence,
    minAmount: sc.minAmount === null ? null : Number(sc.minAmount),
    maxAmount: sc.maxAmount === null ? null : Number(sc.maxAmount),
    isOutsideCtc: sc.component.isOutsideCtc, isLopApplicable: sc.component.isLopApplicable,
    affectsPfWage: sc.component.affectsPfWage, affectsEsiGross: sc.component.affectsEsiGross,
    showOnPayslip: sc.component.showOnPayslip, isPartOfFbp: sc.component.isPartOfFbp,
  }));

  let next = rows;
  if ("removeComponentId" in change) {
    next = rows.filter((r) => r.componentId !== change.removeComponentId);
  } else {
    const comp = await prisma.salaryComponent.findUniqueOrThrow({ where: { id: change.componentId } });
    const merged = {
      componentId: comp.id, code: comp.code, name: comp.name, type: comp.type,
      isOutsideCtc: comp.isOutsideCtc, isLopApplicable: comp.isLopApplicable,
      affectsPfWage: comp.affectsPfWage, affectsEsiGross: comp.affectsEsiGross,
      showOnPayslip: comp.showOnPayslip, isPartOfFbp: comp.isPartOfFbp,
      ...(change.line as object),
    } as (typeof rows)[number];
    next = [...rows.filter((r) => r.componentId !== comp.id), merged];
  }

  const balanceCount = next.filter((r) => r.calculationType === "BALANCE").length;
  if (balanceCount > 1) {
    return { ok: false, message: "Only one component per structure can be set to BALANCE." };
  }

  const { cycles } = topologicalOrder(next.map((r) => ({ code: r.code, formula: r.formula })));
  if (cycles.length > 0) {
    return { ok: false, message: `That creates a circular reference between ${cycles.join(", ")}.` };
  }

  // Resolve at the midpoint of the structure's own range.
  const lo = Number(structure.minAnnualCtc ?? 600000);
  const hi = structure.maxAnnualCtc === null ? lo * 2 : Number(structure.maxAnnualCtc);
  const sampleCtc = Math.max(1, Math.round((lo + hi) / 2));

  try {
    const r = resolveStructure({
      annualCtc: sampleCtc, components: next, roundComponents: structure.roundComponents,
    });
    return { ok: true, warnings: r.warnings };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveStructureLine(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const parsed = parseForm(lineSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;

  const structure = await prisma.salaryStructure.findFirst({
    where: { id: d.structureId, payGroup: { tenantId: viewer.tenantId } },
    select: { id: true, name: true },
  });
  if (!structure) return { ok: false, message: "Structure not found" };
  if (!(await prisma.salaryComponent.count({ where: { id: d.componentId, tenantId: viewer.tenantId } }))) {
    return { ok: false, message: "Component not found", errors: { componentId: "Not found" } };
  }

  // Per-type field requirements.
  if (d.calculationType === "FORMULA") {
    if (!d.formula) return { ok: false, message: "A formula is required", errors: { formula: "Required" } };
    const check = validateFormula(d.formula);
    if (!check.valid) {
      return { ok: false, message: check.error ?? "Invalid formula", errors: { formula: check.error ?? "Invalid" } };
    }
  }
  if (d.calculationType === "FIXED" && d.fixedAmount === null) {
    return { ok: false, message: "A fixed amount is required", errors: { fixedAmount: "Required" } };
  }
  if (d.calculationType === "PERCENTAGE" && (d.percentage === null || !d.percentageOf)) {
    return {
      ok: false, message: "A percentage and the component it is taken of are both required",
      errors: { percentage: d.percentage === null ? "Required" : "", percentageOf: !d.percentageOf ? "Required" : "" },
    };
  }

  const line = {
    calculationType: d.calculationType,
    formula: d.calculationType === "FORMULA" ? d.formula : null,
    fixedAmount: d.calculationType === "FIXED" ? d.fixedAmount : null,
    percentage: d.calculationType === "PERCENTAGE" ? d.percentage : null,
    percentageOf: d.calculationType === "PERCENTAGE" ? d.percentageOf?.toUpperCase() ?? null : null,
    sequence: d.sequence ?? 50,
    minAmount: d.minAmount,
    maxAmount: d.maxAmount,
  };

  const dry = await dryRunStructure(d.structureId, { componentId: d.componentId, line });
  if (!dry.ok) return { ok: false, message: dry.message };

  try {
    await prisma.salaryStructureComponent.upsert({
      where: { structureId_componentId: { structureId: d.structureId, componentId: d.componentId } },
      create: { structureId: d.structureId, componentId: d.componentId, ...line },
      update: line,
    });
    await writeAudit(viewer, {
      module: "PAYROLL", action: "UPDATE", entityType: "SalaryStructureComponent",
      entityId: d.structureId, summary: `Updated a component line on ${structure.name}`,
      newValue: line,
    });
    const warn = dry.warnings.length > 0 ? ` Note: ${dry.warnings[0]}` : "";
    return done(["/payroll/structures"], `Saved.${warn}`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function removeStructureLine(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_STRUCTURE_MANAGE);
  const structureId = String(formData.get("structureId"));
  const componentId = String(formData.get("componentId"));

  const structure = await prisma.salaryStructure.findFirst({
    where: { id: structureId, payGroup: { tenantId: viewer.tenantId } },
    select: { id: true },
  });
  if (!structure) return { ok: false, message: "Structure not found" };

  // Another line's formula may reference the one being removed.
  const dependents = await prisma.salaryStructureComponent.findMany({
    where: { structureId, componentId: { not: componentId }, formula: { not: null } },
    include: { component: { select: { code: true } } },
  });
  const removing = await prisma.salaryComponent.findFirst({
    where: { id: componentId, tenantId: viewer.tenantId }, select: { code: true },
  });
  if (!removing) return { ok: false, message: "Component not found" };
  const referencing = dependents.filter((d) =>
    new RegExp(`\\[\\s*${removing.code}(_ANNUAL)?\\s*\\]`, "i").test(d.formula ?? ""));
  if (referencing.length > 0) {
    return {
      ok: false,
      message: `${referencing.map((r) => r.component.code).join(", ")} reference${referencing.length === 1 ? "s" : ""} ${removing.code} in a formula. Change ${referencing.length === 1 ? "it" : "them"} first — otherwise ${removing.code} would silently resolve to zero.`,
    };
  }

  await prisma.salaryStructureComponent.deleteMany({ where: { structureId, componentId } });
  return done(["/payroll/structures"], `Removed ${removing.code} from the structure.`);
}

// ---------------------------------------------------------------------------
//  APPROVAL RULES (maker-checker) and PAYSLIP SETTINGS
// ---------------------------------------------------------------------------

const ruleSchema = z.object({
  payGroupId: zId(),
  name: zName(120),
  action: z.enum(["LOCK_PAYROLL", "COMPENSATION_CHANGE", "JOB_CHANGE"]),
});

export async function saveApprovalRule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const parsed = parseForm(ruleSchema, formData);
  if (parsed.state) return parsed.state;
  const approverRoleIds = formList(formData, "approverRoleIds");
  if (approverRoleIds.length === 0) {
    return { ok: false, message: "Pick at least one approver role", errors: { approverRoleIds: "Required" } };
  }

  // Only explicit user roles may appear in approval chains.
  const roles = await prisma.role.findMany({
    where: { id: { in: approverRoleIds }, tenantId: viewer.tenantId }, select: { id: true },
  });
  if (roles.length !== approverRoleIds.length) {
    return { ok: false, message: "One of the selected roles no longer exists." };
  }

  const group = await prisma.payGroup.findFirst({
    where: { id: parsed.data.payGroupId, tenantId: viewer.tenantId }, select: { id: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };

  await prisma.$transaction([
    prisma.payrollApprovalRule.create({
      data: { ...parsed.data, approverRoleIds, isActive: true },
    }),
    prisma.payGroup.update({
      where: { id: parsed.data.payGroupId }, data: { approvalWorkflowEnabled: true },
    }),
  ]);
  await writeAudit(viewer, {
    module: "PAYROLL", action: "CREATE", entityType: "PayrollApprovalRule",
    entityId: parsed.data.payGroupId,
    summary: `Added a ${parsed.data.action.toLowerCase().replace("_", " ")} approval rule with ${approverRoleIds.length} level(s)`,
  });
  return done(["/payroll/pay-groups"],
    parsed.data.action === "LOCK_PAYROLL"
      ? "Saved. The Lock Payroll button now reads Lock & Send for Approval."
      : "Saved.");
}

export async function deleteApprovalRule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const id = String(formData.get("id"));
  const rule = await prisma.payrollApprovalRule.findUnique({
    where: { id }, include: { payGroup: { select: { tenantId: true, id: true } } },
  });
  if (!rule || rule.payGroup.tenantId !== viewer.tenantId) return { ok: false, message: "Not found" };

  // A pending request must be resolved before its rule disappears.
  const pending = await prisma.payrollApprovalRequest.count({
    where: { status: "PENDING", action: rule.action, run: { payGroupId: rule.payGroup.id } },
  });
  if (pending > 0) {
    return { ok: false, message: `${pending} request(s) are pending under this rule. Resolve them first.` };
  }

  await prisma.payrollApprovalRule.delete({ where: { id } });
  const remaining = await prisma.payrollApprovalRule.count({ where: { payGroupId: rule.payGroup.id } });
  if (remaining === 0) {
    await prisma.payGroup.update({
      where: { id: rule.payGroup.id }, data: { approvalWorkflowEnabled: false },
    });
  }
  return done(["/payroll/pay-groups"],
    remaining === 0 ? "Removed. No rules remain, so maker-checker is now off." : "Removed.");
}

const payslipSchema = z.object({
  payGroupId: zId(),
  layout: z.enum(["THREE_SECTION", "TWO_SECTION"]),
  showCompanyLogo: zBool(), appendTaxSummary: zBool(), showYtdTotals: zBool(),
  showActualGross: zBool(), excludeNaFields: zBool(), showLoanDetails: zBool(),
  showLeaveSummary: zBool(), showArrearBreakup: zBool(),
  showEmployerContributions: zBool(), showOvertimeHours: zBool(),
  showOutsideCtcComponents: zBool(), passwordProtect: zBool(),
});

export async function savePayslipSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PAYROLL_SETTINGS);
  const parsed = parseForm(payslipSchema, formData);
  if (parsed.state) return parsed.state;
  const { payGroupId, ...data } = parsed.data;

  const group = await prisma.payGroup.findFirst({
    where: { id: payGroupId, tenantId: viewer.tenantId }, select: { id: true },
  });
  if (!group) return { ok: false, message: "Pay group not found" };

  await prisma.payslipSetting.upsert({
    where: { payGroupId }, create: { payGroupId, ...data }, update: data,
  });
  return done(["/payroll/pay-groups"], "Saved payslip settings.");
}
