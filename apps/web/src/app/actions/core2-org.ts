"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  hierarchyCycle, ancestorsOf, applyJobChange, normaliseReorgMoves, applyReorgScenario, applyEntityTransition, orgAsOf, startWorkflow, withdrawWorkflow,
  ENTITY_TAX_TYPES, taxRegistrationIssue, proposePayrollCalendar, nextDeadline, ACQUISITION_STEPS, type ReorgMove,
} from "@keka/services";
import { requireAuth } from "@/lib/context";
import { saveFile, sniffUpload } from "@/lib/storage";
import {
  z, parseForm, writeAudit, actionDone as done, formList, zName, zOptional, zOptionalId, zId, zBool, zNumber, zRequiredNumber, zDate, zRequiredDate,
  type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Organisation structure and legal entities, second pass: unit hierarchies
 * (departments, cost centres, locations, business units), business
 * functions, unit metadata, policy packs, org snapshots and reorganisation
 * scenarios (routed for approval), department split and merge; per-entity
 * tax registrations, calendars, documents and compliance deadlines,
 * intercompany assignments, transfer rules and mergers / spin-offs /
 * acquisitions.
 */

const ORG = "/org/structure";
const ENT = "/org/entities";
const id = (fd: FormData, k = "id") => String(fd.get(k) ?? "");

// ---------------------------------------------------------------------------
//  Hierarchies
// ---------------------------------------------------------------------------

const UNIT_TYPES = ["DEPARTMENT", "COST_CENTRE", "LOCATION", "BUSINESS_UNIT"] as const;
type HierUnit = (typeof UNIT_TYPES)[number];

async function unitRows(tenantId: string, type: HierUnit) {
  const sel = { select: { id: true, name: true, parentId: true }, where: { tenantId } };
  switch (type) {
    case "DEPARTMENT": return prisma.department.findMany(sel);
    case "COST_CENTRE": return prisma.costCenter.findMany(sel);
    case "LOCATION": return prisma.location.findMany(sel);
    case "BUSINESS_UNIT": return prisma.businessUnit.findMany(sel);
  }
}

/** Place a unit under a parent of the same kind (never under itself or its own children). */
export async function setUnitParentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ unitType: z.enum(UNIT_TYPES), id: zId(), parentId: zOptionalId(), plCode: zOptional(30), legalEntityId: zOptionalId() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const rows = await unitRows(viewer.tenantId, d.unitType);
  const unit = rows.find((r) => r.id === d.id);
  if (!unit) return { ok: false, message: "Unit not found." };
  if (d.parentId && !rows.some((r) => r.id === d.parentId)) return { ok: false, message: "The parent was not found." };
  if (hierarchyCycle(d.id, d.parentId, new Map(rows.map((r) => [r.id, r.parentId])))) return { ok: false, message: `${unit.name} cannot sit under one of its own sub-units.`, errors: { parentId: "That makes a loop" } };
  const parent = rows.find((r) => r.id === d.parentId);
  switch (d.unitType) {
    case "DEPARTMENT": await prisma.department.update({ where: { id: d.id }, data: { parentId: d.parentId } }); break;
    case "LOCATION": await prisma.location.update({ where: { id: d.id }, data: { parentId: d.parentId } }); break;
    case "COST_CENTRE": {
      if (d.legalEntityId && !(await prisma.legalEntity.findFirst({ where: { id: d.legalEntityId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Legal entity not found." };
      await prisma.costCenter.update({ where: { id: d.id }, data: { parentId: d.parentId, legalEntityId: d.legalEntityId } });
      break;
    }
    case "BUSINESS_UNIT": await prisma.businessUnit.update({ where: { id: d.id }, data: { parentId: d.parentId, plCode: d.plCode } }); break;
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: d.unitType, entityId: d.id, summary: `${unit.name} now sits ${parent ? `under ${parent.name}` : "at the top level"}${d.plCode ? ` (P&L ${d.plCode})` : ""}`, oldValue: { parentId: unit.parentId }, newValue: { parentId: d.parentId } });
  return done([ORG, "/org"], `Saved ${unit.name}.`);
}

// ---------------------------------------------------------------------------
//  Business functions
// ---------------------------------------------------------------------------

export async function saveBusinessFunctionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ id: zOptionalId(), name: zName(80), code: zOptional(20), parentId: zOptionalId(), description: zOptional(300), isActive: zBool() }), formData);
  if (parsed.state) return parsed.state;
  const { id: fid, ...d } = parsed.data;
  const t = viewer.tenantId;
  const all = await prisma.businessFunction.findMany({ where: { tenantId: t }, select: { id: true, name: true, parentId: true } });
  if (fid && !all.some((f) => f.id === fid)) return { ok: false, message: "Function not found." };
  if (all.some((f) => f.name.toLowerCase() === d.name.toLowerCase() && f.id !== fid)) return { ok: false, message: "Another function has that name.", errors: { name: "Already used" } };
  if (d.parentId && (!all.some((f) => f.id === d.parentId) || (fid && hierarchyCycle(fid, d.parentId, new Map(all.map((f) => [f.id, f.parentId])))))) return { ok: false, message: "That parent would make a loop.", errors: { parentId: "Invalid" } };
  const deptIds = formList(formData, "departmentIds");
  const valid = deptIds.length ? (await prisma.department.findMany({ where: { tenantId: t, id: { in: deptIds } }, select: { id: true } })).map((x) => x.id) : [];
  const data = { ...d, departmentIds: valid };
  const row = fid ? await prisma.businessFunction.update({ where: { id: fid }, data }) : await prisma.businessFunction.create({ data: { tenantId: t, ...data } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: fid ? "UPDATE" : "CREATE", entityType: "BusinessFunction", entityId: row.id, summary: `${fid ? "Updated" : "Added"} business function ${d.name} (${valid.length} department(s))` });
  return done([`${ORG}?tab=functions`], `Saved ${d.name}.`);
}

export async function deleteBusinessFunctionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const row = await prisma.businessFunction.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Function not found." };
  await prisma.$transaction([
    prisma.businessFunction.updateMany({ where: { tenantId: viewer.tenantId, parentId: row.id }, data: { parentId: row.parentId } }),
    prisma.businessFunction.delete({ where: { id: row.id } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "BusinessFunction", entityId: row.id, summary: `Deleted business function ${row.name}` });
  return done([`${ORG}?tab=functions`], "Deleted.");
}

// ---------------------------------------------------------------------------
//  Unit metadata
// ---------------------------------------------------------------------------

const META_UNITS = ["LEGAL_ENTITY", "BUSINESS_UNIT", "DIVISION", "DEPARTMENT"] as const;

export async function saveMetadataFieldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({
    unitType: z.enum(META_UNITS), key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Lower-case letters, digits and _"), label: zName(60),
    fieldType: z.enum(["TEXT", "NUMBER", "SELECT"]).default("TEXT"), options: zOptional(500), required: zBool(), inheritable: zBool(),
  }), formData);
  if (parsed.state) return parsed.state;
  const { options, ...d } = parsed.data;
  const opts = (options ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (d.fieldType === "SELECT" && opts.length < 2) return { ok: false, message: "A choice field needs at least two options.", errors: { options: "Comma-separated" } };
  const row = await prisma.orgUnitMetadataField.upsert({
    where: { tenantId_unitType_key: { tenantId: viewer.tenantId, unitType: d.unitType, key: d.key } },
    create: { tenantId: viewer.tenantId, ...d, options: opts }, update: { label: d.label, fieldType: d.fieldType, options: opts, required: d.required, inheritable: d.inheritable },
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgUnitMetadataField", entityId: row.id, summary: `${d.unitType.toLowerCase().replace("_", " ")} field "${d.label}"${d.inheritable ? " (inherited by sub-units)" : ""}` });
  return done([`${ORG}?tab=metadata`], `Saved ${d.label}.`);
}

export async function deleteMetadataFieldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const row = await prisma.orgUnitMetadataField.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Field not found." };
  await prisma.$transaction([
    prisma.orgUnitMetadataValue.deleteMany({ where: { tenantId: viewer.tenantId, unitType: row.unitType, key: row.key } }),
    prisma.orgUnitMetadataField.delete({ where: { id: row.id } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "OrgUnitMetadataField", entityId: row.id, summary: `Removed unit field "${row.label}" and its values` });
  return done([`${ORG}?tab=metadata`], "Removed.");
}

async function unitExists(tenantId: string, unitType: string, unitId: string): Promise<string | null> {
  const w = { where: { id: unitId, tenantId }, select: { name: true } };
  const r = unitType === "LEGAL_ENTITY" ? await prisma.legalEntity.findFirst(w)
    : unitType === "BUSINESS_UNIT" ? await prisma.businessUnit.findFirst(w)
    : unitType === "DIVISION" ? await prisma.division.findFirst(w)
    : unitType === "DEPARTMENT" ? await prisma.department.findFirst(w)
    : unitType === "LOCATION" ? await prisma.location.findFirst(w) : null;
  return r?.name ?? null;
}

/** Set (or clear) one unit's value for a metadata field. Blank inherits from the parent. */
export async function setMetadataValueAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const unitType = String(formData.get("unitType") ?? ""), unitId = id(formData, "unitId"), key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "").trim().slice(0, 500);
  const field = await prisma.orgUnitMetadataField.findFirst({ where: { tenantId: viewer.tenantId, unitType, key } });
  if (!field) return { ok: false, message: "That field is not defined for this kind of unit." };
  const name = await unitExists(viewer.tenantId, unitType, unitId);
  if (!name) return { ok: false, message: "Unit not found." };
  if (value && field.fieldType === "NUMBER" && !Number.isFinite(Number(value))) return { ok: false, message: `${field.label} is a number.` };
  if (value && field.fieldType === "SELECT" && !field.options.includes(value)) return { ok: false, message: `${field.label} must be one of ${field.options.join(", ")}.` };
  const where = { tenantId_unitType_unitId_key: { tenantId: viewer.tenantId, unitType, unitId, key } };
  if (!value) await prisma.orgUnitMetadataValue.deleteMany({ where: { tenantId: viewer.tenantId, unitType, unitId, key } });
  else await prisma.orgUnitMetadataValue.upsert({ where, create: { tenantId: viewer.tenantId, unitType, unitId, key, value, updatedBy: viewer.user.id }, update: { value, updatedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OrgUnitMetadataValue", entityId: unitId, summary: `${name}: ${field.label} ${value ? `= ${value}` : "cleared (inherits)"}` });
  return done([`${ORG}?tab=metadata`], "Saved.");
}

// ---------------------------------------------------------------------------
//  Policy packs
// ---------------------------------------------------------------------------

export async function savePolicyPackAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ id: zOptionalId(), name: zName(80), description: zOptional(400), items: zOptional(2000), isActive: zBool() }), formData);
  if (parsed.state) return parsed.state;
  const { id: pid, items, ...d } = parsed.data;
  // One policy per line: "Leave: Standard leave policy".
  const list = (items ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [kind, ...rest] = l.split(":");
    return rest.length ? { kind: kind!.trim(), name: rest.join(":").trim() } : { kind: "Policy", name: l };
  });
  if (!list.length) return { ok: false, message: "List at least one policy, one per line (for example \"Leave: Standard\").", errors: { items: "Required" } };
  if (pid && !(await prisma.policyPack.findFirst({ where: { id: pid, tenantId: viewer.tenantId } }))) return { ok: false, message: "Pack not found." };
  if (await prisma.policyPack.findFirst({ where: { tenantId: viewer.tenantId, name: d.name, NOT: pid ? { id: pid } : undefined } })) return { ok: false, message: "Another pack has that name.", errors: { name: "Already used" } };
  const row = pid ? await prisma.policyPack.update({ where: { id: pid }, data: { ...d, items: list } }) : await prisma.policyPack.create({ data: { tenantId: viewer.tenantId, ...d, items: list } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: pid ? "UPDATE" : "CREATE", entityType: "PolicyPack", entityId: row.id, summary: `${pid ? "Updated" : "Created"} policy pack ${d.name} (${list.length} policies)`, newValue: list });
  return done([`${ORG}?tab=policies`], `Saved ${d.name}.`);
}

export async function assignPolicyPackAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const pack = await prisma.policyPack.findFirst({ where: { id: id(formData, "packId"), tenantId: viewer.tenantId } });
  if (!pack) return { ok: false, message: "Pack not found." };
  const unitType = String(formData.get("unitType") ?? ""), unitId = id(formData, "unitId");
  const name = await unitExists(viewer.tenantId, unitType, unitId);
  if (!name) return { ok: false, message: "Pick the unit." };
  const remove = formData.get("remove") === "1";
  if (remove) await prisma.policyPackAssignment.deleteMany({ where: { packId: pack.id, unitType, unitId } });
  else await prisma.policyPackAssignment.upsert({ where: { packId_unitType_unitId: { packId: pack.id, unitType, unitId } }, create: { packId: pack.id, unitType, unitId }, update: {} });
  await writeAudit(viewer, { module: "EMPLOYEE", action: remove ? "DELETE" : "CREATE", entityType: "PolicyPackAssignment", entityId: pack.id, summary: `${remove ? "Removed" : "Assigned"} policy pack ${pack.name} ${remove ? "from" : "to"} ${name} (sub-units inherit it)` });
  return done([`${ORG}?tab=policies`], remove ? "Removed." : `Assigned to ${name}.`);
}

// ---------------------------------------------------------------------------
//  Org snapshots
// ---------------------------------------------------------------------------

export async function takeOrgSnapshotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ name: zName(120), asOf: zDate() }), formData);
  if (parsed.state) return parsed.state;
  const asOf = parsed.data.asOf ?? new Date();
  if (asOf > new Date()) return { ok: false, message: "A snapshot is of today or a past date.", errors: { asOf: "In the future" } };
  const payload = await orgAsOf(viewer.tenantId, asOf);
  const row = await prisma.orgSnapshot.create({ data: { tenantId: viewer.tenantId, name: parsed.data.name, asOf, payload: payload as never, headcount: payload.people.length, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "OrgSnapshot", entityId: row.id, summary: `Saved org snapshot "${row.name}" as of ${payload.asOf} (${row.headcount} people)` });
  return done([`${ORG}?tab=history`], `Saved "${row.name}" — ${row.headcount} people.`);
}

export async function deleteOrgSnapshotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const row = await prisma.orgSnapshot.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Snapshot not found." };
  await prisma.orgSnapshot.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "OrgSnapshot", entityId: row.id, summary: `Deleted org snapshot "${row.name}"` });
  return done([`${ORG}?tab=history`], "Deleted.");
}

// ---------------------------------------------------------------------------
//  Reorganisation scenarios
// ---------------------------------------------------------------------------

export async function createReorgScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ name: zName(120), description: zOptional(1000) }), formData);
  if (parsed.state) return parsed.state;
  const row = await prisma.reorgScenario.create({ data: { tenantId: viewer.tenantId, ...parsed.data, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "ReorgScenario", entityId: row.id, summary: `Started reorganisation scenario "${row.name}"` });
  return done([`${ORG}?tab=reorg`], `Created "${row.name}". Add moves to it.`);
}

async function draftScenario(tenantId: string, scenarioId: string) {
  const s = await prisma.reorgScenario.findFirst({ where: { id: scenarioId, tenantId } });
  if (!s) return { error: "Scenario not found." } as const;
  if (!["DRAFT", "REJECTED"].includes(s.status)) return { error: "Only a draft scenario can be changed. Withdraw it first." } as const;
  return { s } as const;
}

/** Add (or replace) one person's move in a scenario: a new department, a new manager, or both. */
export async function addReorgMoveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const got = await draftScenario(viewer.tenantId, id(formData, "scenarioId"));
  if ("error" in got) return { ok: false, message: got.error };
  const employeeId = id(formData, "employeeId");
  const departmentId = id(formData, "departmentId") || undefined;
  const reportingManagerId = id(formData, "reportingManagerId") || undefined;
  if (!departmentId && !reportingManagerId) return { ok: false, message: "Pick a new department, a new manager, or both." };
  const t = viewer.tenantId;
  const [emp, dept, mgr] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId: t, status: { not: "EXITED" } }, select: { displayName: true } }),
    departmentId ? prisma.department.findFirst({ where: { id: departmentId, tenantId: t, isActive: true } }) : Promise.resolve(true),
    reportingManagerId ? prisma.employee.findFirst({ where: { id: reportingManagerId, tenantId: t, status: { not: "EXITED" } } }) : Promise.resolve(true),
  ]);
  if (!emp) return { ok: false, message: "Pick the person to move." };
  if (!dept) return { ok: false, message: "That department was not found." };
  if (!mgr || reportingManagerId === employeeId) return { ok: false, message: "That manager is not valid." };
  const moves = ((got.s.moves ?? []) as unknown as ReorgMove[]).filter((m) => m.employeeId !== employeeId);
  moves.push({ employeeId, ...(departmentId ? { departmentId } : {}), ...(reportingManagerId ? { reportingManagerId } : {}) });
  await prisma.reorgScenario.update({ where: { id: got.s.id }, data: { moves: normaliseReorgMoves(moves) as never } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReorgScenario", entityId: got.s.id, summary: `"${got.s.name}": planned a move for ${emp.displayName}` });
  return done([`${ORG}?tab=reorg`], `Planned a move for ${emp.displayName}.`);
}

export async function removeReorgMoveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const got = await draftScenario(viewer.tenantId, id(formData, "scenarioId"));
  if ("error" in got) return { ok: false, message: got.error };
  const moves = ((got.s.moves ?? []) as unknown as ReorgMove[]).filter((m) => m.employeeId !== id(formData, "employeeId"));
  await prisma.reorgScenario.update({ where: { id: got.s.id }, data: { moves: moves as never } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReorgScenario", entityId: got.s.id, summary: `"${got.s.name}": removed a planned move` });
  return done([`${ORG}?tab=reorg`], "Removed.");
}

/** Send a scenario for approval (Workflows → Reorganisation scenarios). */
export async function submitReorgScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const got = await draftScenario(viewer.tenantId, id(formData, "id"));
  if ("error" in got) return { ok: false, message: got.error };
  const moves = (got.s.moves ?? []) as unknown as ReorgMove[];
  if (!moves.length) return { ok: false, message: "Plan at least one move first." };
  const res = await startWorkflow({ tenantId: viewer.tenantId, entityType: "REORG_PLAN", entityId: got.s.id, title: `Reorganisation: ${got.s.name}`, details: `${moves.length} move(s). ${got.s.description ?? ""}`.trim(), requesterUserId: viewer.user.id, data: { moves: moves.length } });
  if (!res.ok) return { ok: false, message: res.message };
  await prisma.reorgScenario.update({ where: { id: got.s.id }, data: { status: "PENDING_APPROVAL", workflowRequestId: res.requestId ?? null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReorgScenario", entityId: got.s.id, summary: `Sent "${got.s.name}" for approval (${moves.length} moves)` });
  return done([`${ORG}?tab=reorg`, "/inbox"], "Sent for approval.");
}

export async function withdrawReorgScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const s = await prisma.reorgScenario.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!s || s.status !== "PENDING_APPROVAL" || !s.workflowRequestId) return { ok: false, message: "Only a scenario awaiting approval can be withdrawn." };
  const res = await withdrawWorkflow({ tenantId: viewer.tenantId, requestId: s.workflowRequestId, userId: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "ReorgScenario", entityId: s.id, summary: `Withdrew "${s.name}" from approval` });
  return done([`${ORG}?tab=reorg`], "Withdrawn; it is a draft again.");
}

/** Apply an approved scenario: each move becomes a job change in the people's history. */
export async function applyReorgScenarioAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const s = await prisma.reorgScenario.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!s) return { ok: false, message: "Scenario not found." };
  if (s.status !== "APPROVED") return { ok: false, message: "The scenario must be approved first." };
  const res = await applyReorgScenario(viewer.tenantId, s.id, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  return done([`${ORG}?tab=reorg`, "/org", "/employees"], res.message);
}

// ---------------------------------------------------------------------------
//  Department split and merge
// ---------------------------------------------------------------------------

async function moveToDepartment(tenantId: string, actorUserId: string, employeeIds: string[], departmentId: string, note: string) {
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  for (const employeeId of employeeIds) {
    const c = await prisma.jobChange.create({ data: { tenantId, employeeId, effectiveFrom: today, reason: "DEPARTMENT_CHANGE", status: "SCHEDULED", note, requestedBy: actorUserId, source: "MANUAL", departmentId } });
    await applyJobChange(c.id);
  }
}

/** Split a department: create a new one beside it and move the chosen people into it. */
export async function splitDepartmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ sourceId: zId(), name: zName(120), code: zOptional(20), headId: zOptionalId() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data, t = viewer.tenantId;
  const src = await prisma.department.findFirst({ where: { id: d.sourceId, tenantId: t } });
  if (!src) return { ok: false, message: "Department not found." };
  if (await prisma.department.findFirst({ where: { tenantId: t, name: d.name } })) return { ok: false, message: "A department has that name.", errors: { name: "Already used" } };
  const ids = formList(formData, "employeeIds");
  const people = await prisma.employee.findMany({ where: { tenantId: t, id: { in: ids }, departmentId: src.id }, select: { id: true } });
  if (!people.length) return { ok: false, message: `Pick the people in ${src.name} who move to the new department.` };
  if (d.headId && !people.some((p) => p.id === d.headId) && !(await prisma.employee.findFirst({ where: { id: d.headId, tenantId: t } }))) return { ok: false, message: "Head not found." };
  const dept = await prisma.department.create({ data: { tenantId: t, name: d.name, code: d.code, headId: d.headId, parentId: src.parentId, businessUnitId: src.businessUnitId, divisionId: src.divisionId } });
  await moveToDepartment(t, viewer.user.id, people.map((p) => p.id), dept.id, `Split from ${src.name}`);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Department", entityId: dept.id, summary: `Split ${src.name}: created ${dept.name} and moved ${people.length} people`, newValue: { from: src.id, people: people.map((p) => p.id) } });
  return done([ORG, "/org", "/employees"], `Created ${dept.name} with ${people.length} people.`);
}

/** Merge one department into another: everyone moves, its sub-departments re-parent, and it is deactivated. */
export async function mergeDepartmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_MANAGE);
  const parsed = parseForm(z.object({ sourceId: zId(), targetId: zId() }), formData);
  if (parsed.state) return parsed.state;
  const { sourceId, targetId } = parsed.data, t = viewer.tenantId;
  if (sourceId === targetId) return { ok: false, message: "Pick two different departments." };
  const [src, dst] = await Promise.all([prisma.department.findFirst({ where: { id: sourceId, tenantId: t } }), prisma.department.findFirst({ where: { id: targetId, tenantId: t, isActive: true } })]);
  if (!src || !dst) return { ok: false, message: "Department not found." };
  const all = await prisma.department.findMany({ where: { tenantId: t }, select: { id: true, parentId: true } });
  const above = ancestorsOf(targetId, new Map(all.map((x) => [x.id, x.parentId])));
  if (above.indexOf(sourceId) > 1) return { ok: false, message: `${dst.name} sits deep inside ${src.name}; merge into a direct sub-department or move it out first.` };
  const people = await prisma.employee.findMany({ where: { tenantId: t, departmentId: src.id, status: { not: "EXITED" } }, select: { id: true } });
  await moveToDepartment(t, viewer.user.id, people.map((p) => p.id), dst.id, `Merged ${src.name} into ${dst.name}`);
  await prisma.$transaction([
    prisma.department.updateMany({ where: { tenantId: t, parentId: src.id, NOT: { id: dst.id } }, data: { parentId: dst.id } }),
    prisma.department.update({ where: { id: dst.id }, data: { parentId: dst.parentId === src.id ? src.parentId : dst.parentId } }),
    prisma.department.update({ where: { id: src.id }, data: { isActive: false, headId: null } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Department", entityId: src.id, summary: `Merged ${src.name} into ${dst.name}: ${people.length} people moved, ${src.name} deactivated` });
  return done([ORG, "/org", "/employees"], `Merged into ${dst.name}: ${people.length} people moved.`);
}

// ---------------------------------------------------------------------------
//  Legal entities: registrations, calendars, jurisdictions, documents, deadlines
// ---------------------------------------------------------------------------

async function entityOf(tenantId: string, legalEntityId: string) {
  return prisma.legalEntity.findFirst({ where: { id: legalEntityId, tenantId }, select: { id: true, name: true } });
}

export async function saveEntityTaxRegistrationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ legalEntityId: zId(), type: z.enum(ENTITY_TAX_TYPES), number: z.string().trim().min(1, "Required").max(40).transform((v) => v.toUpperCase()), stateCode: zOptional(2), validFrom: zDate(), validTo: zDate(), note: zOptional(300) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const le = await entityOf(viewer.tenantId, d.legalEntityId);
  if (!le) return { ok: false, message: "Legal entity not found." };
  const issue = taxRegistrationIssue(d.type, d.number);
  if (issue) return { ok: false, message: issue, errors: { number: issue } };
  if (d.validFrom && d.validTo && d.validTo < d.validFrom) return { ok: false, message: "Valid-to is before valid-from." };
  const clash = await prisma.entityTaxRegistration.findFirst({ where: { tenantId: viewer.tenantId, type: d.type, number: d.number } });
  if (clash && clash.legalEntityId !== le.id) return { ok: false, message: "That number is registered to another entity." };
  const data = { ...d, stateCode: d.stateCode?.toUpperCase() ?? null };
  const row = clash ? await prisma.entityTaxRegistration.update({ where: { id: clash.id }, data }) : await prisma.entityTaxRegistration.create({ data: { tenantId: viewer.tenantId, ...data } });
  await writeAudit(viewer, { module: "SYSTEM", action: clash ? "UPDATE" : "CREATE", entityType: "EntityTaxRegistration", entityId: row.id, summary: `${le.name}: ${d.type} ${d.number}` });
  return done([`${ENT}?id=${le.id}`], `Saved ${d.type}.`);
}

/** Remove one of the entity's records (registration, calendar link, payroll month, jurisdiction, document, deadline, rule). */
export async function deleteEntityRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const kind = String(formData.get("kind") ?? ""), rid = id(formData), t = viewer.tenantId;
  const w = { where: { id: rid, tenantId: t } };
  const deleters: Record<string, () => Promise<{ count: number }>> = {
    tax: () => prisma.entityTaxRegistration.deleteMany(w), calendar: () => prisma.entityHolidayCalendar.deleteMany(w),
    payroll: () => prisma.entityPayrollCalendar.deleteMany(w), jurisdiction: () => prisma.businessUnitJurisdiction.deleteMany(w),
    document: () => prisma.entityDocument.deleteMany(w), deadline: () => prisma.entityComplianceDeadline.deleteMany(w),
    rule: () => prisma.entityTransferRule.deleteMany(w),
  };
  if (!deleters[kind]) return { ok: false, message: "Unknown record." };
  const r = await deleters[kind]!();
  if (!r.count) return { ok: false, message: "Not found." };
  await writeAudit(viewer, { module: "SYSTEM", action: "DELETE", entityType: `Entity:${kind}`, entityId: rid, summary: `Removed an entity ${kind} record` });
  return done([ENT], "Removed.");
}

export async function linkEntityHolidayCalendarAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const le = await entityOf(viewer.tenantId, id(formData, "legalEntityId"));
  const cal = await prisma.holidayCalendar.findFirst({ where: { id: id(formData, "holidayCalendarId"), tenantId: viewer.tenantId } });
  if (!le || !cal) return { ok: false, message: "Pick the entity and the calendar." };
  await prisma.entityHolidayCalendar.upsert({ where: { legalEntityId_holidayCalendarId: { legalEntityId: le.id, holidayCalendarId: cal.id } }, create: { tenantId: viewer.tenantId, legalEntityId: le.id, holidayCalendarId: cal.id }, update: {} });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "EntityHolidayCalendar", entityId: le.id, summary: `${le.name} follows holiday calendar ${cal.name} (${cal.year})` });
  return done([`${ENT}?id=${le.id}`], `Linked ${cal.name}.`);
}

/** Lay out the entity's payroll calendar for a year: input cut-off and pay date each month. */
export async function generatePayrollCalendarAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ legalEntityId: zId(), year: zRequiredNumber({ min: 2000, max: 2100 }), cutoffDay: zRequiredNumber({ min: 1, max: 28 }), payDay: zRequiredNumber({ min: 1, max: 31 }) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const le = await entityOf(viewer.tenantId, d.legalEntityId);
  if (!le) return { ok: false, message: "Legal entity not found." };
  const plan = proposePayrollCalendar(d.year, { cutoffDay: d.cutoffDay, payDay: d.payDay });
  let kept = 0;
  for (const m of plan) {
    const existing = await prisma.entityPayrollCalendar.findUnique({ where: { legalEntityId_year_month: { legalEntityId: le.id, year: d.year, month: m.month } } });
    if (existing && existing.status !== "PLANNED") { kept++; continue; }
    await prisma.entityPayrollCalendar.upsert({ where: { legalEntityId_year_month: { legalEntityId: le.id, year: d.year, month: m.month } }, create: { tenantId: viewer.tenantId, legalEntityId: le.id, year: d.year, ...m }, update: { inputCutoff: m.inputCutoff, payDate: m.payDate } });
  }
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "EntityPayrollCalendar", entityId: le.id, summary: `${le.name}: payroll calendar ${d.year} (cut-off day ${d.cutoffDay}, pay day ${d.payDay})` });
  return done([`${ENT}?id=${le.id}`], `Planned ${plan.length - kept} month(s)${kept ? `; ${kept} already closed were left alone` : ""}.`);
}

export async function setPayrollCalendarStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const status = String(formData.get("status") ?? "");
  if (!["PLANNED", "LOCKED", "PAID"].includes(status)) return { ok: false, message: "Unknown status." };
  const row = await prisma.entityPayrollCalendar.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Not found." };
  await prisma.entityPayrollCalendar.update({ where: { id: row.id }, data: { status } });
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "EntityPayrollCalendar", entityId: row.id, summary: `Payroll ${row.month}/${row.year} marked ${status.toLowerCase()}` });
  return done([ENT], "Saved.");
}

export async function saveBuJurisdictionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ businessUnitId: zId(), stateCode: z.string().regex(/^[A-Za-z]{2}$/, "Two letters").transform((v) => v.toUpperCase()), taxType: z.enum(["PT", "LWF", "GST", "SHOPS", "OTHER"]), registrationNo: zOptional(40) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const bu = await prisma.businessUnit.findFirst({ where: { id: d.businessUnitId, tenantId: viewer.tenantId } });
  if (!bu) return { ok: false, message: "Business unit not found." };
  await prisma.businessUnitJurisdiction.upsert({ where: { businessUnitId_stateCode_taxType: { businessUnitId: bu.id, stateCode: d.stateCode, taxType: d.taxType } }, create: { tenantId: viewer.tenantId, ...d }, update: { registrationNo: d.registrationNo } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "BusinessUnitJurisdiction", entityId: bu.id, summary: `${bu.name}: ${d.taxType} in ${d.stateCode}${d.registrationNo ? ` (${d.registrationNo})` : ""}` });
  return done([`${ENT}?id=${bu.legalEntityId}`], "Saved.");
}

export async function uploadEntityDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ legalEntityId: zId(), title: zName(160), category: z.enum(["INCORPORATION", "REGISTRATION", "LICENCE", "AGREEMENT", "POLICY", "OTHER"]).default("OTHER"), reference: zOptional(80), validUntil: zDate() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const le = await entityOf(viewer.tenantId, d.legalEntityId);
  if (!le) return { ok: false, message: "Legal entity not found." };
  const file = formData.get("file");
  let fileId: string | null = null;
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type || "application/octet-stream");
    if (!sniff.ok) return { ok: false, message: sniff.reason };
    try {
      fileId = (await saveFile({ tenantId: viewer.tenantId, filename: file.name || "entity-document", mimeType: sniff.mimeType, data, relatedType: "EntityDocument", relatedId: le.id, uploadedBy: viewer.user.id })).id;
    } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Upload failed." }; }
  } else if (!d.reference) return { ok: false, message: "Attach the file or give its reference number." };
  const row = await prisma.entityDocument.create({ data: { tenantId: viewer.tenantId, ...d, fileId, uploadedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "EntityDocument", entityId: row.id, summary: `${le.name}: added document "${d.title}"${d.validUntil ? ` valid until ${d.validUntil.toISOString().slice(0, 10)}` : ""}` });
  return done([`${ENT}?id=${le.id}`], "Saved the document.");
}

export async function saveComplianceDeadlineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ legalEntityId: zId(), title: zName(160), category: z.enum(["STATUTORY", "TAX", "PAYROLL", "CORPORATE", "OTHER"]).default("STATUTORY"), dueDate: zRequiredDate(), recurrence: z.enum(["NONE", "MONTHLY", "QUARTERLY", "ANNUAL"]).default("NONE") }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const le = await entityOf(viewer.tenantId, d.legalEntityId);
  if (!le) return { ok: false, message: "Legal entity not found." };
  const row = await prisma.entityComplianceDeadline.create({ data: { tenantId: viewer.tenantId, ...d, ownerUserId: viewer.user.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "EntityComplianceDeadline", entityId: row.id, summary: `${le.name}: "${d.title}" due ${d.dueDate.toISOString().slice(0, 10)}${d.recurrence !== "NONE" ? ` (${d.recurrence.toLowerCase()})` : ""}` });
  return done([`${ENT}?id=${le.id}`, "/hr-ops/desk"], "Added the deadline.");
}

/** Mark a deadline done; a recurring one rolls forward to its next due date. */
export async function completeComplianceDeadlineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const row = await prisma.entityComplianceDeadline.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId, status: "OPEN" } });
  if (!row) return { ok: false, message: "Open deadline not found." };
  const next = nextDeadline(row.dueDate, row.recurrence);
  await prisma.$transaction(async (tx) => {
    await tx.entityComplianceDeadline.update({ where: { id: row.id }, data: { status: "DONE", completedAt: new Date(), completedBy: viewer.user.id } });
    if (next) await tx.entityComplianceDeadline.create({ data: { tenantId: row.tenantId, legalEntityId: row.legalEntityId, title: row.title, category: row.category, dueDate: next, recurrence: row.recurrence, ownerUserId: row.ownerUserId } });
  });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EntityComplianceDeadline", entityId: row.id, summary: `Completed "${row.title}"${next ? `; next due ${next.toISOString().slice(0, 10)}` : ""}` });
  return done([ENT, "/hr-ops/desk"], next ? `Done. Next due ${next.toISOString().slice(0, 10)}.` : "Done.");
}

// ---------------------------------------------------------------------------
//  Intercompany assignments and transfer rules
// ---------------------------------------------------------------------------

export async function requestIntercompanyAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ employeeId: zId(), hostEntityId: zId(), startDate: zRequiredDate(), endDate: zDate(), allocationPct: zRequiredNumber({ min: 1, max: 100 }), purpose: zOptional(500) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data, t = viewer.tenantId;
  const emp = await prisma.employee.findFirst({ where: { id: d.employeeId, tenantId: t, status: { not: "EXITED" } }, select: { id: true, displayName: true, legalEntityId: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  const host = await entityOf(t, d.hostEntityId);
  if (!host) return { ok: false, message: "Host entity not found." };
  if (!emp.legalEntityId) return { ok: false, message: `${emp.displayName} has no home legal entity yet.` };
  if (host.id === emp.legalEntityId) return { ok: false, message: `${emp.displayName} already belongs to ${host.name}.` };
  if (d.endDate && d.endDate < d.startDate) return { ok: false, message: "The end date is before the start." };
  const overlapping = await prisma.intercompanyAssignment.findMany({ where: { tenantId: t, employeeId: emp.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } } });
  const total = overlapping.filter((a) => (!a.endDate || a.endDate >= d.startDate) && (!d.endDate || a.startDate <= d.endDate)).reduce((s, a) => s + a.allocationPct, 0);
  if (total + d.allocationPct > 100) return { ok: false, message: `That would allocate ${total + d.allocationPct}% of ${emp.displayName}'s time to other entities.` };
  const row = await prisma.intercompanyAssignment.create({ data: { tenantId: t, employeeId: emp.id, homeEntityId: emp.legalEntityId, hostEntityId: host.id, startDate: d.startDate, endDate: d.endDate, allocationPct: d.allocationPct, purpose: d.purpose, createdBy: viewer.user.id } });
  const res = await startWorkflow({ tenantId: t, entityType: "INTERCOMPANY_ASSIGNMENT", entityId: row.id, title: `${emp.displayName}: ${d.allocationPct}% to ${host.name}`, details: d.purpose, requesterUserId: viewer.user.id, subjectEmployeeId: emp.id });
  if (!res.ok) { await prisma.intercompanyAssignment.delete({ where: { id: row.id } }); return { ok: false, message: res.message }; }
  await prisma.intercompanyAssignment.update({ where: { id: row.id }, data: { workflowRequestId: res.requestId ?? null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "IntercompanyAssignment", entityId: row.id, summary: `Requested ${emp.displayName}'s assignment to ${host.name} (${d.allocationPct}%)` });
  return done([`${ENT}?tab=intercompany`, "/inbox"], "Sent for approval.");
}

export async function endIntercompanyAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const row = await prisma.intercompanyAssignment.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId, status: "ACTIVE" } });
  if (!row) return { ok: false, message: "Active assignment not found." };
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  await prisma.intercompanyAssignment.update({ where: { id: row.id }, data: { status: "ENDED", endDate: row.endDate && row.endDate < today ? row.endDate : today } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "IntercompanyAssignment", entityId: row.id, summary: "Ended an intercompany assignment" });
  return done([`${ENT}?tab=intercompany`], "Ended.");
}

export async function saveTransferRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ fromEntityId: zOptionalId(), toEntityId: zOptionalId(), requiresApproval: zBool(), minNoticeDays: zNumber({ min: 0, max: 180 }).transform((v) => v ?? 0), carryForwardLeave: zBool(), restartProbation: zBool(), newEmployeeNumber: zBool(), note: zOptional(300) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data, t = viewer.tenantId;
  for (const e of [d.fromEntityId, d.toEntityId]) if (e && !(await entityOf(t, e))) return { ok: false, message: "Legal entity not found." };
  if (d.fromEntityId && d.fromEntityId === d.toEntityId) return { ok: false, message: "Pick two different entities (or leave one as \"any\")." };
  const existing = await prisma.entityTransferRule.findFirst({ where: { tenantId: t, fromEntityId: d.fromEntityId, toEntityId: d.toEntityId } });
  const row = existing ? await prisma.entityTransferRule.update({ where: { id: existing.id }, data: d }) : await prisma.entityTransferRule.create({ data: { tenantId: t, ...d } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "EntityTransferRule", entityId: row.id, summary: `Transfer rule saved: ${d.minNoticeDays} days' notice, ${d.carryForwardLeave ? "leave carries over" : "leave resets"}, ${d.restartProbation ? "probation restarts" : "no new probation"}`, newValue: d });
  return done([`${ENT}?tab=rules`], "Saved the rule.");
}

// ---------------------------------------------------------------------------
//  Mergers, spin-offs and acquisitions
// ---------------------------------------------------------------------------

export async function createEntityTransitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const parsed = parseForm(z.object({ kind: z.enum(["MERGER", "SPINOFF", "ACQUISITION"]), name: zName(120), sourceEntityId: zOptionalId(), targetEntityId: zId(), effectiveDate: zRequiredDate(), deactivateSource: zBool() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data, t = viewer.tenantId;
  if (d.kind !== "ACQUISITION" && !d.sourceEntityId) return { ok: false, message: "A merger or spin-off needs the entity people move from.", errors: { sourceEntityId: "Required" } };
  if (d.sourceEntityId && d.sourceEntityId === d.targetEntityId) return { ok: false, message: "Source and target must differ." };
  for (const e of [d.sourceEntityId, d.targetEntityId]) if (e && !(await entityOf(t, e))) return { ok: false, message: "Legal entity not found." };
  // Mergers take everyone from the source; spin-offs start empty (pick who goes); acquisitions map the acquired people.
  const mapping = d.kind === "MERGER" && d.sourceEntityId
    ? (await prisma.employee.findMany({ where: { tenantId: t, legalEntityId: d.sourceEntityId, status: { not: "EXITED" } }, select: { id: true, departmentId: true } })).map((p) => ({ employeeId: p.id, departmentId: p.departmentId, businessUnitId: null }))
    : [];
  const row = await prisma.entityTransition.create({ data: { tenantId: t, ...d, deactivateSource: d.kind === "MERGER" && d.deactivateSource, mapping, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "EntityTransition", entityId: row.id, summary: `Planned ${d.kind.toLowerCase()} "${d.name}" effective ${d.effectiveDate.toISOString().slice(0, 10)} (${mapping.length} people mapped)` });
  return done([`${ENT}?tab=transitions`], `Planned "${d.name}".`);
}

/** Map people into the transition (and the business unit they land in at the target). */
export async function mapTransitionPeopleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const tr = await prisma.entityTransition.findFirst({ where: { id: id(formData, "transitionId"), tenantId: viewer.tenantId } });
  if (!tr || !["DRAFT", "REJECTED"].includes(tr.status)) return { ok: false, message: "Only a draft transition can be changed." };
  const ids = formList(formData, "employeeIds");
  const businessUnitId = id(formData, "businessUnitId") || null;
  if (businessUnitId && !(await prisma.businessUnit.findFirst({ where: { id: businessUnitId, tenantId: viewer.tenantId, legalEntityId: tr.targetEntityId } }))) return { ok: false, message: "That business unit is not in the target entity." };
  const people = await prisma.employee.findMany({ where: { tenantId: viewer.tenantId, id: { in: ids }, status: { not: "EXITED" }, ...(tr.sourceEntityId ? { legalEntityId: tr.sourceEntityId } : {}) }, select: { id: true, departmentId: true } });
  const remove = formData.get("remove") === "1";
  const cur = (tr.mapping ?? []) as Array<{ employeeId: string; businessUnitId?: string | null; departmentId?: string | null }>;
  const chosen = new Set(people.map((p) => p.id));
  const next = remove ? cur.filter((m) => !chosen.has(m.employeeId)) : [...cur.filter((m) => !chosen.has(m.employeeId)), ...people.map((p) => ({ employeeId: p.id, departmentId: p.departmentId, businessUnitId }))];
  if (!remove && !people.length) return { ok: false, message: tr.sourceEntityId ? "Pick people from the source entity." : "Pick the people." };
  await prisma.entityTransition.update({ where: { id: tr.id }, data: { mapping: next } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EntityTransition", entityId: tr.id, summary: `"${tr.name}": ${remove ? "unmapped" : "mapped"} ${people.length || ids.length} people (${next.length} in total)` });
  return done([`${ENT}?tab=transitions`], `${next.length} people mapped.`);
}

export async function toggleAcquisitionStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const tr = await prisma.entityTransition.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  const step = String(formData.get("step") ?? "");
  if (!tr) return { ok: false, message: "Transition not found." };
  if (!ACQUISITION_STEPS.some((s) => s.key === step)) return { ok: false, message: "Unknown step." };
  const steps = tr.stepsDone.includes(step) ? tr.stepsDone.filter((s) => s !== step) : [...tr.stepsDone, step];
  await prisma.entityTransition.update({ where: { id: tr.id }, data: { stepsDone: steps } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EntityTransition", entityId: tr.id, summary: `"${tr.name}": ${ACQUISITION_STEPS.find((s) => s.key === step)!.label} ${steps.includes(step) ? "done" : "reopened"}` });
  return done([`${ENT}?tab=transitions`], "Saved.");
}

export async function submitEntityTransitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const tr = await prisma.entityTransition.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!tr || !["DRAFT", "REJECTED"].includes(tr.status)) return { ok: false, message: "Only a draft transition can be sent." };
  const n = ((tr.mapping ?? []) as unknown[]).length;
  if (!n) return { ok: false, message: "Map at least one person first." };
  const res = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ENTITY_TRANSITION", entityId: tr.id, title: `${tr.kind.charAt(0)}${tr.kind.slice(1).toLowerCase()}: ${tr.name}`, details: `${n} people, effective ${tr.effectiveDate.toISOString().slice(0, 10)}`, requesterUserId: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await prisma.entityTransition.update({ where: { id: tr.id }, data: { status: "PENDING_APPROVAL", workflowRequestId: res.requestId ?? null } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EntityTransition", entityId: tr.id, summary: `Sent "${tr.name}" for approval` });
  return done([`${ENT}?tab=transitions`, "/inbox"], "Sent for approval.");
}

/** Apply an approved transition whose date has come (approval applies it automatically when already due). */
export async function applyEntityTransitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const tr = await prisma.entityTransition.findFirst({ where: { id: id(formData), tenantId: viewer.tenantId } });
  if (!tr) return { ok: false, message: "Transition not found." };
  if (tr.status !== "APPROVED") return { ok: false, message: "The transition must be approved first." };
  if (tr.effectiveDate > new Date()) return { ok: false, message: `It takes effect on ${tr.effectiveDate.toISOString().slice(0, 10)}.` };
  const res = await applyEntityTransition(viewer.tenantId, tr.id, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  return done([`${ENT}?tab=transitions`, "/org", "/employees"], res.message);
}

/** Give a legal entity its own employee number series (new hires there draw from it). */
export async function setNumberSeriesEntityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.ORG_ENTITY_MANAGE);
  const series = await prisma.employeeNumberSeries.findFirst({ where: { id: id(formData, "seriesId"), tenantId: viewer.tenantId } });
  if (!series) return { ok: false, message: "Pick the series." };
  const legalEntityId = id(formData, "legalEntityId") || null;
  const le = legalEntityId ? await entityOf(viewer.tenantId, legalEntityId) : null;
  if (legalEntityId && !le) return { ok: false, message: "Legal entity not found." };
  await prisma.employeeNumberSeries.update({ where: { id: series.id }, data: { legalEntityId } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "EmployeeNumberSeries", entityId: series.id, summary: le ? `Series ${series.name} now numbers new hires in ${le.name}` : `Series ${series.name} is no longer tied to an entity` });
  return done([ENT, "/org?tab=numbering"], "Saved.");
}
