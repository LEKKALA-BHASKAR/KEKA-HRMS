"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { requireAuth } from "@/lib/context";
import {
  z, parseForm, toErrorState, writeAudit, actionDone,
  zName, zOptional, zNumber, zDate, zBool, zId, zOptionalId, zEmail, zPan, zIfsc,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * CRUD for the organisation structure.
 *
 * Deletes are guarded rather than cascading: an object still referenced by an
 * employee cannot be removed, because silently orphaning an employee record is
 * worse than refusing the delete.
 */

const done = actionDone;

// ---------------------------------------------------------------------------
//  LEGAL ENTITY
// ---------------------------------------------------------------------------

const legalEntitySchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  legalName: zName(200),
  countryCode: z.string().min(2).max(2).default("IN"),
  currency: z.string().min(3).max(3).default("INR"),
  cin: zOptional(40),
  dateOfIncorporation: zDate(),
  businessType: zOptional(80),
  sector: zOptional(80),
  natureOfBusiness: zOptional(200),
  addressLine1: zOptional(200),
  addressLine2: zOptional(200),
  city: zOptional(80),
  state: zOptional(80),
  postalCode: zOptional(12),
});

export async function saveLegalEntity(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(legalEntitySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;

  try {
    if (id) {
      const before = await prisma.legalEntity.findFirst({
        where: { id, tenantId: viewer.tenantId },
      });
      if (!before) return { ok: false, message: "Legal entity not found" };
      await prisma.legalEntity.update({ where: { id }, data });
      await writeAudit(viewer, {
        module: "EMPLOYEE", action: "UPDATE", entityType: "LegalEntity", entityId: id,
        summary: `Updated legal entity ${data.legalName}`,
        oldValue: { name: before.name, legalName: before.legalName },
        newValue: { name: data.name, legalName: data.legalName },
      });
      return done(["/org"], `Saved ${data.legalName}.`);
    }
    const created = await prisma.legalEntity.create({
      data: { ...data, tenantId: viewer.tenantId },
    });
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "LegalEntity", entityId: created.id,
      summary: `Created legal entity ${data.legalName}`,
    });
    return done(["/org"], `Created ${data.legalName}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteLegalEntity(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const id = String(formData.get("id"));

  const entity = await prisma.legalEntity.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { employees: true, businessUnits: true, payGroups: true } } },
  });
  if (!entity) return { ok: false, message: "Legal entity not found" };
  if (entity._count.employees > 0) {
    return { ok: false, message: `${entity._count.employees} employee(s) belong to this entity. Reassign them first.` };
  }
  if (entity._count.payGroups > 0) {
    return { ok: false, message: `${entity._count.payGroups} pay group(s) are attached. Remove them first.` };
  }
  if (entity._count.businessUnits > 0) {
    return { ok: false, message: `${entity._count.businessUnits} business unit(s) are attached. Remove them first.` };
  }

  await prisma.legalEntity.delete({ where: { id } });
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "DELETE", entityType: "LegalEntity", entityId: id,
    summary: `Deleted legal entity ${entity.legalName}`,
  });
  return done(["/org"], `Deleted ${entity.legalName}.`);
}

// --- Signatories and bank accounts, which hang off the entity --------------

const signatorySchema = z.object({
  legalEntityId: zId(),
  name: zName(120),
  designation: zName(80),
  email: zEmail(),
  fathersName: zOptional(120),
  address: zOptional(300),
  pan: zPan(),
});

export async function addSignatory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(signatorySchema, formData);
  if (parsed.state) return parsed.state;

  const entity = await prisma.legalEntity.findFirst({
    where: { id: parsed.data.legalEntityId, tenantId: viewer.tenantId },
  });
  if (!entity) return { ok: false, message: "Legal entity not found" };

  try {
    await prisma.authorisedSignatory.create({ data: parsed.data });
    return done(["/org"], `Added ${parsed.data.name} as a signatory.`);
  } catch (err) {
    return toErrorState(err);
  }
}

export async function deleteSignatory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const id = String(formData.get("id"));
  const sig = await prisma.authorisedSignatory.findUnique({
    where: { id }, include: { legalEntity: { select: { tenantId: true } } },
  });
  if (!sig || sig.legalEntity.tenantId !== viewer.tenantId) {
    return { ok: false, message: "Signatory not found" };
  }
  await prisma.authorisedSignatory.delete({ where: { id } });
  return done(["/org"], `Removed ${sig.name}.`);
}

const bankAccountSchema = z.object({
  legalEntityId: zId(),
  bankName: zName(120),
  accountNumber: zName(30),
  ifsc: zIfsc(),
  branch: zName(120),
  corporateId: zOptional(40),
  isPrimary: zBool(),
});

export async function addEntityBankAccount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(bankAccountSchema, formData);
  if (parsed.state) return parsed.state;
  if (!parsed.data.ifsc) {
    return { ok: false, message: "IFSC is required", errors: { ifsc: "Required" } };
  }

  const entity = await prisma.legalEntity.findFirst({
    where: { id: parsed.data.legalEntityId, tenantId: viewer.tenantId },
  });
  if (!entity) return { ok: false, message: "Legal entity not found" };

  try {
    await prisma.$transaction(async (tx) => {
      // Only one primary account per entity.
      if (parsed.data.isPrimary) {
        await tx.entityBankAccount.updateMany({
          where: { legalEntityId: parsed.data.legalEntityId },
          data: { isPrimary: false },
        });
      }
      await tx.entityBankAccount.create({
        data: { ...parsed.data, ifsc: parsed.data.ifsc as string },
      });
    });
    return done(["/org"], `Added ${parsed.data.bankName}.`);
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  BUSINESS UNIT
// ---------------------------------------------------------------------------

const businessUnitSchema = z.object({
  id: zOptionalId(),
  legalEntityId: zId(),
  name: zName(80),
  code: zOptional(20),
  description: zOptional(300),
  headId: zOptionalId(),
});

export async function saveBusinessUnit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(businessUnitSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;

  try {
    if (id) {
      const updated = await prisma.businessUnit.updateMany({
        where: { id, tenantId: viewer.tenantId }, data,
      });
      if (updated.count === 0) return { ok: false, message: "Business unit not found" };
      await writeAudit(viewer, {
        module: "EMPLOYEE", action: "UPDATE", entityType: "BusinessUnit", entityId: id,
        summary: `Updated business unit ${data.name}`,
      });
      return done(["/org"], `Saved ${data.name}.`);
    }
    const created = await prisma.businessUnit.create({
      data: { ...data, tenantId: viewer.tenantId },
    });
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "BusinessUnit", entityId: created.id,
      summary: `Created business unit ${data.name}`,
    });
    return done(["/org"], `Created ${data.name}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteBusinessUnit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const id = String(formData.get("id"));
  const bu = await prisma.businessUnit.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { employees: true, departments: true } } },
  });
  if (!bu) return { ok: false, message: "Business unit not found" };
  if (bu._count.employees > 0) {
    return { ok: false, message: `${bu._count.employees} employee(s) are in this business unit.` };
  }
  if (bu._count.departments > 0) {
    return { ok: false, message: `${bu._count.departments} department(s) belong to it. Move them first.` };
  }
  await prisma.businessUnit.delete({ where: { id } });
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "DELETE", entityType: "BusinessUnit", entityId: id,
    summary: `Deleted business unit ${bu.name}`,
  });
  return done(["/org"], `Deleted ${bu.name}.`);
}

// ---------------------------------------------------------------------------
//  DEPARTMENT
// ---------------------------------------------------------------------------

const departmentSchema = z.object({
  id: zOptionalId(),
  businessUnitId: zOptionalId(),
  name: zName(80),
  code: zOptional(20),
  description: zOptional(300),
  headId: zOptionalId(),
});

export async function saveDepartment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(departmentSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;

  try {
    if (id) {
      const updated = await prisma.department.updateMany({
        where: { id, tenantId: viewer.tenantId }, data,
      });
      if (updated.count === 0) return { ok: false, message: "Department not found" };
      await writeAudit(viewer, {
        module: "EMPLOYEE", action: "UPDATE", entityType: "Department", entityId: id,
        summary: `Updated department ${data.name}`,
      });
      return done(["/org", "/employees"], `Saved ${data.name}.`);
    }
    const created = await prisma.department.create({
      data: { ...data, tenantId: viewer.tenantId },
    });
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "Department", entityId: created.id,
      summary: `Created department ${data.name}`,
    });
    return done(["/org", "/employees"], `Created ${data.name}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteDepartment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const id = String(formData.get("id"));
  const dept = await prisma.department.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { employees: true } } },
  });
  if (!dept) return { ok: false, message: "Department not found" };
  if (dept._count.employees > 0) {
    return { ok: false, message: `${dept._count.employees} employee(s) are in this department. Reassign them first.` };
  }
  // A role scope may point at this department; clear those grants too.
  await prisma.$transaction([
    prisma.roleScope.deleteMany({ where: { departmentId: id } }),
    prisma.department.delete({ where: { id } }),
  ]);
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "DELETE", entityType: "Department", entityId: id,
    summary: `Deleted department ${dept.name} and cleared its role scopes`,
  });
  return done(["/org", "/admin/roles"], `Deleted ${dept.name}.`);
}

// ---------------------------------------------------------------------------
//  LOCATION
// ---------------------------------------------------------------------------

const locationSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  code: zOptional(20),
  addressLine1: zOptional(200),
  addressLine2: zOptional(200),
  city: zOptional(80),
  state: zOptional(80),
  stateCode: z.string().optional().transform((v) => (v && v.length > 0 ? v.toUpperCase() : null)),
  postalCode: zOptional(12),
  countryCode: z.string().min(2).max(2).default("IN"),
  timezone: z.string().default("Asia/Kolkata"),
});

export async function saveLocation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(locationSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;

  try {
    if (id) {
      const before = await prisma.location.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Location not found" };
      await prisma.location.update({ where: { id }, data });
      // Changing the state code changes which PT and LWF rules apply.
      const stateChanged = before.stateCode !== data.stateCode;
      await writeAudit(viewer, {
        module: "PAYROLL", action: "UPDATE", entityType: "Location", entityId: id,
        summary: stateChanged
          ? `Changed ${data.name} state from ${before.stateCode ?? "none"} to ${data.stateCode ?? "none"} — PT and LWF rules will follow the new state`
          : `Updated location ${data.name}`,
        oldValue: { stateCode: before.stateCode },
        newValue: { stateCode: data.stateCode },
      });
      return done(["/org", "/payroll/pay-groups"],
        stateChanged
          ? `Saved ${data.name}. Its state changed, so check the PT and LWF registration mapping.`
          : `Saved ${data.name}.`);
    }
    const created = await prisma.location.create({
      data: { ...data, tenantId: viewer.tenantId },
    });
    await writeAudit(viewer, {
      module: "EMPLOYEE", action: "CREATE", entityType: "Location", entityId: created.id,
      summary: `Created location ${data.name} (${data.stateCode ?? "no state"})`,
    });
    return done(["/org"],
      `Created ${data.name}. Map it to a PT and LWF registration before running payroll for anyone based there.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteLocation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const id = String(formData.get("id"));
  const loc = await prisma.location.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { _count: { select: { employees: true, ptLinks: true, lwfLinks: true } } },
  });
  if (!loc) return { ok: false, message: "Location not found" };
  if (loc._count.employees > 0) {
    return { ok: false, message: `${loc._count.employees} employee(s) are based here.` };
  }
  await prisma.$transaction([
    prisma.ptStateRegistrationLocation.deleteMany({ where: { locationId: id } }),
    prisma.lwfStateRegistrationLocation.deleteMany({ where: { locationId: id } }),
    prisma.roleScope.deleteMany({ where: { locationId: id } }),
    prisma.location.delete({ where: { id } }),
  ]);
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "DELETE", entityType: "Location", entityId: id,
    summary: `Deleted location ${loc.name} and its statutory mappings`,
  });
  return done(["/org"], `Deleted ${loc.name}.`);
}

// ---------------------------------------------------------------------------
//  SIMPLE LOOKUPS — cost centre, band, pay grade, worker type, job title
// ---------------------------------------------------------------------------

const costCentreSchema = z.object({
  id: zOptionalId(), name: zName(80), code: zOptional(20),
});

export async function saveCostCentre(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(costCentreSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;
  try {
    if (id) {
      const u = await prisma.costCenter.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Cost centre not found" };
      return done(["/org"], `Saved ${data.name}.`);
    }
    await prisma.costCenter.create({ data: { ...data, tenantId: viewer.tenantId } });
    return done(["/org"], `Created ${data.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const bandSchema = z.object({
  id: zOptionalId(), name: zName(60),
  rank: zNumber({ min: 0, max: 99 }), description: zOptional(200),
});

export async function saveBand(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(bandSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, rank, ...rest } = parsed.data;
  const data = { ...rest, rank: rank ?? 0 };
  try {
    if (id) {
      const u = await prisma.band.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Band not found" };
      return done(["/org"], `Saved ${data.name}.`);
    }
    await prisma.band.create({ data: { ...data, tenantId: viewer.tenantId } });
    return done(["/org"], `Created ${data.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const payGradeSchema = z.object({
  id: zOptionalId(), name: zName(60),
  minAnnual: zNumber({ min: 0 }),
  maxAnnual: zNumber({ min: 0 }),
}).refine(
  (v) => v.minAnnual === null || v.maxAnnual === null || v.maxAnnual >= v.minAnnual,
  { message: "Maximum must be at or above the minimum", path: ["maxAnnual"] },
);

export async function savePayGrade(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(payGradeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, name, minAnnual, maxAnnual } = parsed.data;
  const midAnnual = minAnnual !== null && maxAnnual !== null ? (minAnnual + maxAnnual) / 2 : null;
  const data = { name, minAnnual, maxAnnual, midAnnual };
  try {
    if (id) {
      const u = await prisma.payGrade.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Pay grade not found" };
      return done(["/org"], `Saved ${name}.`);
    }
    await prisma.payGrade.create({ data: { ...data, tenantId: viewer.tenantId } });
    return done(["/org"], `Created ${name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const workerTypeSchema = z.object({
  id: zOptionalId(), name: zName(60), isContingent: zBool(),
});

export async function saveWorkerType(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(workerTypeSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;
  try {
    if (id) {
      const u = await prisma.workerType.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Worker type not found" };
      return done(["/org"], `Saved ${data.name}.`);
    }
    await prisma.workerType.create({ data: { ...data, tenantId: viewer.tenantId } });
    return done(["/org"], `Created ${data.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

const jobTitleSchema = z.object({
  id: zOptionalId(), name: zName(120), bandId: zOptionalId(),
});

export async function saveJobTitle(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(jobTitleSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;
  try {
    if (id) {
      const u = await prisma.jobTitle.updateMany({ where: { id, tenantId: viewer.tenantId }, data });
      if (u.count === 0) return { ok: false, message: "Job title not found" };
      return done(["/org"], `Saved ${data.name}.`);
    }
    await prisma.jobTitle.create({ data: { ...data, tenantId: viewer.tenantId } });
    return done(["/org"], `Created ${data.name}.`);
  } catch (err) { return toErrorState(err, parsed.data as never); }
}

/** One generic delete for the simple lookups, guarded by employee references. */
export async function deleteLookup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const kind = String(formData.get("kind"));
  const id = String(formData.get("id"));

  const guards: Record<string, () => Promise<{ name: string; count: number } | null>> = {
    costCentre: async () => {
      const r = await prisma.costCenter.findFirst({
        where: { id, tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
      });
      return r ? { name: r.name, count: r._count.employees } : null;
    },
    band: async () => {
      const r = await prisma.band.findFirst({
        where: { id, tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
      });
      return r ? { name: r.name, count: r._count.employees } : null;
    },
    payGrade: async () => {
      const r = await prisma.payGrade.findFirst({
        where: { id, tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
      });
      return r ? { name: r.name, count: r._count.employees } : null;
    },
    workerType: async () => {
      const r = await prisma.workerType.findFirst({
        where: { id, tenantId: viewer.tenantId },
        include: { _count: { select: { employees: true } } },
      });
      return r ? { name: r.name, count: r._count.employees } : null;
    },
    jobTitle: async () => {
      const r = await prisma.jobTitle.findFirst({
        where: { id, tenantId: viewer.tenantId },
        include: { _count: { select: { employeeJobs: true } } },
      });
      return r ? { name: r.name, count: r._count.employeeJobs } : null;
    },
  };

  const guard = guards[kind];
  if (!guard) return { ok: false, message: "Unknown record type" };

  const found = await guard();
  if (!found) return { ok: false, message: "Record not found" };
  if (found.count > 0) {
    return { ok: false, message: `${found.count} record(s) still reference "${found.name}".` };
  }

  const deleters: Record<string, () => Promise<unknown>> = {
    costCentre: () => prisma.costCenter.delete({ where: { id } }),
    band: () => prisma.band.delete({ where: { id } }),
    payGrade: () => prisma.payGrade.delete({ where: { id } }),
    workerType: () => prisma.workerType.delete({ where: { id } }),
    jobTitle: () => prisma.jobTitle.delete({ where: { id } }),
  };
  await deleters[kind]();
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: "DELETE", entityType: kind, entityId: id,
    summary: `Deleted ${kind} ${found.name}`,
  });
  return done(["/org"], `Deleted ${found.name}.`);
}

// ---------------------------------------------------------------------------
//  EMPLOYEE NUMBER SERIES
// ---------------------------------------------------------------------------

const seriesSchema = z.object({
  id: zOptionalId(),
  name: zName(60),
  description: zOptional(200),
  prefix: z.string().max(12).default(""),
  digits: zNumber({ min: 1, max: 10 }),
  suffix: z.string().max(12).default(""),
  nextNumber: zNumber({ min: 1 }),
  isDefault: zBool(),
  isActive: zBool(),
});

export async function saveNumberSeries(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const parsed = parseForm(seriesSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, digits, nextNumber, isDefault, ...rest } = parsed.data;
  const data = { ...rest, digits: digits ?? 4, nextNumber: nextNumber ?? 1, isDefault };

  try {
    await prisma.$transaction(async (tx) => {
      // Exactly one default series.
      if (isDefault) {
        await tx.employeeNumberSeries.updateMany({
          where: { tenantId: viewer.tenantId }, data: { isDefault: false },
        });
      }
      if (id) {
        await tx.employeeNumberSeries.updateMany({
          where: { id, tenantId: viewer.tenantId }, data,
        });
      } else {
        await tx.employeeNumberSeries.create({
          data: { ...data, tenantId: viewer.tenantId },
        });
      }
    });
    return done(["/org"], `Saved ${data.name}.`);
  } catch (err) {
    return toErrorState(err, parsed.data as never);
  }
}

export async function deleteNumberSeries(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_SETTINGS_MANAGE);
  const id = String(formData.get("id"));
  const series = await prisma.employeeNumberSeries.findFirst({
    where: { id, tenantId: viewer.tenantId },
  });
  if (!series) return { ok: false, message: "Series not found" };
  if (series.isDefault) {
    return { ok: false, message: "The default series cannot be deleted. Make another one default first." };
  }
  await prisma.employeeNumberSeries.delete({ where: { id } });
  return done(["/org"], `Deleted ${series.name}.`);
}

// ---------------------------------------------------------------------------
//  ORG-WIDE VISIBILITY
// ---------------------------------------------------------------------------

const visibilitySchema = z.object({
  restrictByLegalEntity: zBool(),
  restrictByBusinessUnit: zBool(),
  managerReporteeOverride: zBool(),
});

export async function saveVisibilitySettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ROLE_MANAGE);
  const parsed = parseForm(visibilitySchema, formData);
  if (parsed.state) return parsed.state;

  await prisma.tenantVisibilitySetting.upsert({
    where: { tenantId: viewer.tenantId },
    create: { tenantId: viewer.tenantId, ...parsed.data },
    update: parsed.data,
  });
  await writeAudit(viewer, {
    module: "ROLE", action: "UPDATE", entityType: "TenantVisibilitySetting",
    entityId: viewer.tenantId,
    summary: `Updated org-wide visibility: entity=${parsed.data.restrictByLegalEntity}, unit=${parsed.data.restrictByBusinessUnit}`,
    newValue: parsed.data,
  });
  return done(["/admin/roles", "/employees"],
    "Saved. Remember that an unscoped role still reaches every entity — visibility narrows scoped grants only.");
}

// ---------------------------------------------------------------------------
//  ASSIGN A HEAD (derives the implicit Department / Business Head role)
// ---------------------------------------------------------------------------

export async function setOrgHead(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const kind = String(formData.get("kind"));
  const id = String(formData.get("id"));
  const headId = String(formData.get("headId") ?? "") || null;

  if (headId) {
    const emp = await prisma.employee.findFirst({
      where: { id: headId, tenantId: viewer.tenantId }, select: { id: true },
    });
    if (!emp) return { ok: false, message: "Employee not found" };
  }

  if (kind === "department") {
    const u = await prisma.department.updateMany({
      where: { id, tenantId: viewer.tenantId }, data: { headId },
    });
    if (u.count === 0) return { ok: false, message: "Department not found" };
  } else if (kind === "businessUnit") {
    const u = await prisma.businessUnit.updateMany({
      where: { id, tenantId: viewer.tenantId }, data: { headId },
    });
    if (u.count === 0) return { ok: false, message: "Business unit not found" };
  } else {
    return { ok: false, message: "Unknown record type" };
  }

  await writeAudit(viewer, {
    module: "ROLE", action: "UPDATE", entityType: kind, entityId: id,
    summary: headId
      ? `Assigned a head to ${kind} — they gain the implicit ${kind === "department" ? "Department Head" : "Business Head"} role`
      : `Cleared the head of ${kind} — the implicit role is withdrawn`,
  });
  return done(["/org", "/admin/roles"],
    headId
      ? "Saved. They now hold the matching implicit role over that part of the org."
      : "Cleared. The implicit role no longer applies.");
}
