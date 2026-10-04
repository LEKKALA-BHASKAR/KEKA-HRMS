"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  submitWorkforceRequest, nextWorkerCode, parseTags, validGstin, validIfsc, timesheetAmount, rateCardOn, rateCardOverlaps,
  endAssignment, vendorCompliance, VENDOR_CHECKLIST,
} from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import {
  z, parseForm, formList, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zOptionalId, zId, zEmail, zPan, zBool, type ActionState,
} from "@/lib/forms";
import { createEmployee } from "./employee";

const P = PERMISSIONS;
const PATHS = ["/contingent", "/contingent/workers", "/contingent/vendors", "/contingent/approvals", "/contingent/rate-cards"];
const workerPaths = (id: string) => [...PATHS, `/contingent/workers/${id}`];
const audit = (viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string, summary: string, oldValue?: unknown, newValue?: unknown) =>
  writeAudit(viewer, { module: "EMPLOYEE", action, entityType, entityId, summary, oldValue, newValue });
const RATE_TYPES = ["HOURLY", "DAILY", "MONTHLY", "FIXED"] as const;

// ---------------------------------------------------------------------------
//  Vendors (agencies)
// ---------------------------------------------------------------------------

const vendorSchema = z.object({
  id: zOptionalId(),
  name: zName(120),
  code: zOptional(20),
  gstin: zOptional(15),
  pan: zPan(),
  contactName: zOptional(120),
  email: zEmail(),
  phone: zOptional(20),
  address: zOptional(500),
});

export async function saveVendorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(vendorSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.gstin && !validGstin(d.gstin)) return { ok: false, message: "That is not a valid GSTIN.", errors: { gstin: "15 characters, e.g. 29ABCDE1234F1Z5" } };
  const data = { ...d, gstin: d.gstin?.toUpperCase() ?? null };
  try {
    if (id) {
      const before = await prisma.contingentVendor.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Vendor not found." };
      await prisma.contingentVendor.update({ where: { id }, data });
      await audit(viewer, "UPDATE", "ContingentVendor", id, `Updated vendor ${d.name}`, { name: before.name, gstin: before.gstin, email: before.email }, { name: data.name, gstin: data.gstin, email: data.email });
      return done([...PATHS, `/contingent/vendors/${id}`], "Vendor saved.");
    }
    const v = await prisma.contingentVendor.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
    await audit(viewer, "CREATE", "ContingentVendor", v.id, `Added vendor ${d.name}`);
    return { ...done(PATHS, `Added ${d.name}. Complete its onboarding checklist and documents to activate it.`), values: { id: v.id } };
  } catch (err) {
    return toErrorState(err);
  }
}

/** Vendor onboarding checklist: the ticked items. */
export async function saveVendorChecklistAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const v = await prisma.contingentVendor.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!v) return { ok: false, message: "Vendor not found." };
  const keys = formList(formData, "items").filter((k) => VENDOR_CHECKLIST.some((c) => c.key === k));
  await prisma.contingentVendor.update({ where: { id: v.id }, data: { checklist: keys } });
  await audit(viewer, "UPDATE", "ContingentVendor", v.id, `Onboarding checklist for ${v.name}: ${keys.length}/${VENDOR_CHECKLIST.length}`, v.checklist, keys);
  return done([`/contingent/vendors/${v.id}`], "Checklist saved.");
}

/** Activate (only when onboarded and compliant), suspend or deactivate a vendor. */
export async function setVendorStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const v = await prisma.contingentVendor.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { documents: true } });
  if (!v) return { ok: false, message: "Vendor not found." };
  const status = String(formData.get("status") ?? "");
  if (!["ACTIVE", "SUSPENDED", "INACTIVE"].includes(status)) return { ok: false, message: "Unknown status." };
  if (status === "ACTIVE") {
    const missing = VENDOR_CHECKLIST.filter((c) => !v.checklist.includes(c.key));
    if (missing.length) return { ok: false, message: `Finish onboarding first: ${missing.map((m) => m.label).join("; ")}.` };
    const c = vendorCompliance(v.documents, new Date());
    if (!c.compliant) return { ok: false, message: `Compliance documents ${[...c.missing.map((m) => `${m} missing`), ...c.expired.map((m) => `${m} expired`)].join(", ")}.` };
  }
  await prisma.contingentVendor.update({ where: { id: v.id }, data: { status } });
  await audit(viewer, "UPDATE", "ContingentVendor", v.id, `${v.name}: ${v.status} → ${status}`);
  return done([...PATHS, `/contingent/vendors/${v.id}`], `${v.name} is now ${status.toLowerCase()}.`);
}

const docSchema = z.object({
  vendorId: zId(),
  docType: z.enum(["MSA", "GST_CERT", "PAN", "INSURANCE", "LABOUR_LICENCE", "PF_REG", "ESI_REG", "OTHER"]),
  number: zOptional(60),
  validFrom: zDate(),
  validUntil: zDate(),
});

export async function addVendorDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(docSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const v = await prisma.contingentVendor.findFirst({ where: { id: d.vendorId, tenantId: viewer.tenantId } });
  if (!v) return { ok: false, message: "Vendor not found." };
  if (d.validFrom && d.validUntil && d.validUntil < d.validFrom) return { ok: false, message: "Valid-until is before valid-from." };
  const doc = await prisma.vendorDocument.create({ data: d });
  await audit(viewer, "CREATE", "ContingentVendor", v.id, `Added ${d.docType} document to ${v.name}${d.validUntil ? ` (valid until ${d.validUntil.toISOString().slice(0, 10)})` : ""}`, undefined, { documentId: doc.id });
  return done([`/contingent/vendors/${v.id}`, "/contingent"], "Document added.");
}

export async function deleteVendorDocumentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const doc = await prisma.vendorDocument.findFirst({ where: { id: String(formData.get("id") ?? ""), vendor: { tenantId: viewer.tenantId } }, include: { vendor: true } });
  if (!doc) return { ok: false, message: "Document not found." };
  await prisma.vendorDocument.delete({ where: { id: doc.id } });
  await audit(viewer, "DELETE", "ContingentVendor", doc.vendorId, `Removed ${doc.docType} document from ${doc.vendor.name}`);
  return done([`/contingent/vendors/${doc.vendorId}`], "Document removed.");
}

// ---------------------------------------------------------------------------
//  Rate cards (effective-dated)
// ---------------------------------------------------------------------------

const rateCardSchema = z.object({
  vendorId: zOptionalId(),
  role: zName(120),
  rateType: z.enum(RATE_TYPES),
  rate: zRequiredNumber({ min: 0.01 }),
  effectiveFrom: zRequiredDate(),
  effectiveTo: zDate(),
});

export async function saveRateCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(rateCardSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.vendorId && !(await prisma.contingentVendor.findFirst({ where: { id: d.vendorId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Vendor not found." };
  if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) return { ok: false, message: "Effective-to is before effective-from." };
  const same = await prisma.contractorRateCard.findMany({ where: { tenantId: viewer.tenantId, vendorId: d.vendorId, role: { equals: d.role, mode: "insensitive" } } });
  if (rateCardOverlaps(same, d.effectiveFrom, d.effectiveTo)) return { ok: false, message: "That overlaps an existing rate for this role. End the old rate first." };
  const c = await prisma.contractorRateCard.create({ data: { tenantId: viewer.tenantId, ...d } });
  await audit(viewer, "CREATE", "ContractorRateCard", c.id, `Rate card ${d.role}: ${d.rate} ${d.rateType.toLowerCase()} from ${d.effectiveFrom.toISOString().slice(0, 10)}`);
  return done(PATHS, "Rate saved.");
}

/** End a rate card on a date, so a new rate can start the day after. */
export async function endRateCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const c = await prisma.contractorRateCard.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!c) return { ok: false, message: "Rate card not found." };
  const raw = String(formData.get("effectiveTo") ?? "");
  const to = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  if (!to || to < c.effectiveFrom) return { ok: false, message: "Choose an end date on or after the start." };
  await prisma.contractorRateCard.update({ where: { id: c.id }, data: { effectiveTo: to } });
  await audit(viewer, "UPDATE", "ContractorRateCard", c.id, `Rate card ${c.role} ends ${raw}`);
  return done(PATHS, "Rate ended.");
}

// ---------------------------------------------------------------------------
//  Workers
// ---------------------------------------------------------------------------

const workerSchema = z.object({
  id: zOptionalId(),
  firstName: zName(60),
  lastName: zName(60),
  email: zEmail(),
  phone: zOptional(20),
  workerKind: z.enum(["CONTRACTOR", "VENDOR_WORKER"]),
  engagementType: z.enum(["FIXED_TERM", "TIME_AND_MATERIAL", "SOW", "RETAINER", "CONSULTANT"]),
  vendorId: zOptionalId(),
  pan: zPan(),
  skills: zOptional(1000),
  departmentId: zOptionalId(),
  managerEmployeeId: zOptionalId(),
  notes: zOptional(2000),
});

export async function saveWorkerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(workerSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, skills, ...d } = parsed.data;
  if (d.workerKind === "VENDOR_WORKER" && !d.vendorId) return { ok: false, message: "A vendor worker needs its agency.", errors: { vendorId: "Required" } };
  if (d.vendorId) {
    const v = await prisma.contingentVendor.findFirst({ where: { id: d.vendorId, tenantId: viewer.tenantId } });
    if (!v) return { ok: false, message: "Vendor not found." };
    if (!id && v.status !== "ACTIVE") return { ok: false, message: `${v.name} is not an active vendor yet.` };
  }
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, employee: d.managerEmployeeId });
  if (foreign) return { ok: false, message: foreign };
  const data = { ...d, vendorId: d.workerKind === "VENDOR_WORKER" ? d.vendorId : null, skills: parseTags(skills) };
  try {
    if (id) {
      const before = await prisma.contingentWorker.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Worker not found." };
      await prisma.contingentWorker.update({ where: { id }, data });
      await audit(viewer, "UPDATE", "ContingentWorker", id, `Updated ${before.code} ${d.firstName} ${d.lastName}`,
        { email: before.email, departmentId: before.departmentId, managerEmployeeId: before.managerEmployeeId, vendorId: before.vendorId },
        { email: data.email, departmentId: data.departmentId, managerEmployeeId: data.managerEmployeeId, vendorId: data.vendorId });
      return done(workerPaths(id), "Saved.");
    }
    const w = await prisma.$transaction(async (tx) => {
      const code = await nextWorkerCode(viewer.tenantId);
      const w = await tx.contingentWorker.create({ data: { tenantId: viewer.tenantId, code, ...data, createdBy: viewer.user.id } });
      const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "WORKER_ONBOARD", entityType: "ContingentWorker", entityId: w.id, label: `${code} ${d.firstName} ${d.lastName}`, reason: String(formData.get("justification") ?? "") || null, by: viewer.user.id }, tx);
      if (!res.ok) throw new Error(res.message);
      return w;
    });
    await audit(viewer, "CREATE", "ContingentWorker", w.id, `Added contingent worker ${w.code} ${d.firstName} ${d.lastName} (${d.workerKind.toLowerCase().replace("_", " ")})`);
    return { ...done(PATHS, `Added ${w.code}; engagement waits for approval.`), values: { id: w.id } };
  } catch (err) {
    return toErrorState(err);
  }
}

// ---------------------------------------------------------------------------
//  Contract assignments, extensions and ends
// ---------------------------------------------------------------------------

const assignmentSchema = z.object({
  workerId: zId(),
  assignmentId: zOptionalId(),
  role: zName(120),
  departmentId: zOptionalId(),
  projectId: zOptionalId(),
  managerEmployeeId: zOptionalId(),
  startDate: zRequiredDate(),
  endDate: zRequiredDate(),
  rateType: z.enum(RATE_TYPES),
  rate: zNumber({ min: 0 }),
  poNumber: zOptional(40),
  poAmount: zNumber({ min: 0 }),
  sowReference: zOptional(60),
  sowDescription: zOptional(2000),
});

export async function saveAssignmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(assignmentSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const w = await prisma.contingentWorker.findFirst({ where: { id: d.workerId, tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (["ENDED", "CONVERTED", "REJECTED"].includes(w.status)) return { ok: false, message: `${w.code} is ${w.status.toLowerCase()}.` };
  if (d.endDate < d.startDate) return { ok: false, message: "The contract must end after it starts.", errors: { endDate: "Before start" } };
  const foreign = await foreignReference(viewer.tenantId, { department: d.departmentId, project: d.projectId, employee: d.managerEmployeeId });
  if (foreign) return { ok: false, message: foreign };
  // No rate given: take the rate card in force on the start date.
  let rate = d.rate;
  let rateType: string = d.rateType;
  if (!rate) {
    const cards = (await prisma.contractorRateCard.findMany({ where: { tenantId: viewer.tenantId } })).map((c) => ({ ...c, rate: Number(c.rate) }));
    const card = rateCardOn(cards, d.role, w.vendorId, d.startDate);
    if (!card) return { ok: false, message: "Enter a rate — no rate card covers this role on the start date.", errors: { rate: "Required" } };
    rate = card.rate; rateType = card.rateType;
  }
  const data = {
    role: d.role, departmentId: d.departmentId ?? w.departmentId, projectId: d.projectId, managerEmployeeId: d.managerEmployeeId ?? w.managerEmployeeId,
    startDate: d.startDate, endDate: d.endDate, rateType, rate, poNumber: d.poNumber, poAmount: d.poAmount, sowReference: d.sowReference, sowDescription: d.sowDescription,
  };
  if (d.assignmentId) {
    const a = await prisma.contractAssignment.findFirst({ where: { id: d.assignmentId, workerId: w.id, tenantId: viewer.tenantId } });
    if (!a) return { ok: false, message: "Assignment not found." };
    if (a.status === "ENDED") return { ok: false, message: "An ended contract cannot be changed." };
    // A running contract keeps its dates and rate; those change through an extension.
    const editable = a.status === "ACTIVE"
      ? { role: data.role, departmentId: data.departmentId, projectId: data.projectId, managerEmployeeId: data.managerEmployeeId, poNumber: data.poNumber, poAmount: data.poAmount, sowReference: data.sowReference, sowDescription: data.sowDescription }
      : { ...data, status: "PENDING_APPROVAL" };
    await prisma.contractAssignment.update({ where: { id: a.id }, data: editable });
    if (a.status === "REJECTED") {
      await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "ASSIGNMENT", entityType: "ContractAssignment", entityId: a.id, label: `${w.code} — ${data.role}`, by: viewer.user.id });
    }
    await audit(viewer, "UPDATE", "ContractAssignment", a.id, `Updated contract ${w.code} — ${data.role}`, { poNumber: a.poNumber, managerEmployeeId: a.managerEmployeeId, departmentId: a.departmentId }, { poNumber: data.poNumber, managerEmployeeId: data.managerEmployeeId, departmentId: data.departmentId });
    return done(workerPaths(w.id), "Contract saved.");
  }
  const a = await prisma.$transaction(async (tx) => {
    const a = await tx.contractAssignment.create({ data: { tenantId: viewer.tenantId, workerId: w.id, ...data, createdBy: viewer.user.id } });
    const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "ASSIGNMENT", entityType: "ContractAssignment", entityId: a.id, label: `${w.code} ${w.firstName} ${w.lastName} — ${data.role}`, payload: { rate, rateType, poNumber: data.poNumber }, by: viewer.user.id }, tx);
    if (!res.ok) throw new Error(res.message);
    return a;
  });
  await audit(viewer, "CREATE", "ContractAssignment", a.id, `Contract for ${w.code}: ${data.role}, ${d.startDate.toISOString().slice(0, 10)} → ${d.endDate.toISOString().slice(0, 10)} at ${rate} ${rateType.toLowerCase()}${data.poNumber ? `, PO ${data.poNumber}` : ""}`);
  return { ...done(workerPaths(w.id), "Contract sent for approval."), values: { id: a.id } };
}

/** Ask to extend or end a running contract. */
export async function requestContractChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const a = await prisma.contractAssignment.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { worker: true } });
  if (!a) return { ok: false, message: "Contract not found." };
  if (a.status !== "ACTIVE") return { ok: false, message: "Only an active contract can be extended or ended." };
  const change = String(formData.get("change") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  const date = (k: string) => { const v = String(formData.get(k) ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
  if (!reason) return { ok: false, message: "Give a reason.", errors: { reason: "Required" } };
  const label = `${a.worker.code} ${a.worker.firstName} ${a.worker.lastName} — ${a.role}`;
  let res;
  if (change === "extend") {
    const newEndDate = date("newEndDate");
    if (!newEndDate || new Date(`${newEndDate}T00:00:00Z`) <= a.endDate) return { ok: false, message: "The new end date must be after the current one.", errors: { newEndDate: "After current end" } };
    const newRate = String(formData.get("newRate") ?? "") ? Number(formData.get("newRate")) : null;
    if (newRate !== null && (!Number.isFinite(newRate) || newRate <= 0)) return { ok: false, message: "Enter a valid rate.", errors: { newRate: "Invalid" } };
    res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "CONTRACT_EXTEND", entityType: "ContractAssignment", entityId: a.id, label, payload: { newEndDate: `${newEndDate}T00:00:00.000Z`, newRate, previousEndDate: a.endDate.toISOString() }, reason, by: viewer.user.id });
  } else if (change === "end") {
    const endDate = date("endDate");
    if (!endDate) return { ok: false, message: "Choose the last day.", errors: { endDate: "Required" } };
    if (new Date(`${endDate}T00:00:00Z`) < a.startDate) return { ok: false, message: "The end date is before the contract started." };
    res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "CONTRACT_END", entityType: "ContractAssignment", entityId: a.id, label, payload: { endDate: `${endDate}T00:00:00.000Z` }, reason, by: viewer.user.id });
  } else return { ok: false, message: "Unknown change." };
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "ContractAssignment", a.id, `Requested to ${change} the contract of ${a.worker.code}: ${reason}`);
  return done(workerPaths(a.workerId), "Sent for approval.");
}

/** Reschedule a pending contract end or extension (its requester or a contingent admin). */
export async function revisePendingContractChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const r = await prisma.workforceRequest.findFirst({ where: { id: String(formData.get("requestId") ?? ""), tenantId: viewer.tenantId, status: "PENDING", kind: { in: ["CONTRACT_END", "CONTRACT_EXTEND"] } } });
  if (!r) return { ok: false, message: "That request is no longer pending." };
  const raw = String(formData.get("date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, message: "Choose a date.", errors: { date: "Required" } };
  const a = await prisma.contractAssignment.findFirst({ where: { id: r.entityId, tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Contract not found." };
  const at = `${raw}T00:00:00.000Z`;
  if (r.kind === "CONTRACT_EXTEND" && new Date(at) <= a.endDate) return { ok: false, message: "The new end date must be after the current one." };
  const payload = { ...((r.payload ?? {}) as Record<string, unknown>), ...(r.kind === "CONTRACT_END" ? { endDate: at } : { newEndDate: at }) };
  const reason = String(formData.get("reason") ?? "").trim() || r.reason;
  await prisma.workforceRequest.update({ where: { id: r.id }, data: { payload: payload as never, reason } });
  await audit(viewer, "UPDATE", "ContractAssignment", a.id, `Rescheduled pending ${r.kind === "CONTRACT_END" ? "end" : "extension"} to ${raw}`, r.payload, payload);
  return done(workerPaths(a.workerId), "Request updated.");
}

const milestoneSchema = z.object({ assignmentId: zId(), name: zName(120), dueDate: zRequiredDate(), amount: zRequiredNumber({ min: 0 }) });

export async function addMilestoneAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(milestoneSchema, formData);
  if (parsed.state) return parsed.state;
  const a = await prisma.contractAssignment.findFirst({ where: { id: parsed.data.assignmentId, tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Contract not found." };
  const m = await prisma.sowMilestone.create({ data: parsed.data });
  await audit(viewer, "CREATE", "ContractAssignment", a.id, `Added SOW milestone ${m.name} (${parsed.data.amount}) due ${parsed.data.dueDate.toISOString().slice(0, 10)}`);
  return done(workerPaths(a.workerId), "Milestone added.");
}

export async function setMilestoneStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const m = await prisma.sowMilestone.findFirst({ where: { id: String(formData.get("id") ?? ""), assignment: { tenantId: viewer.tenantId } }, include: { assignment: true } });
  if (!m) return { ok: false, message: "Milestone not found." };
  const status = String(formData.get("status") ?? "");
  const order = ["PENDING", "COMPLETED", "PAID"];
  if (!order.includes(status) || order.indexOf(status) !== order.indexOf(m.status) + 1) return { ok: false, message: "Milestones move pending → completed → paid." };
  await prisma.sowMilestone.update({ where: { id: m.id }, data: { status, completedAt: status === "COMPLETED" ? new Date() : m.completedAt } });
  await audit(viewer, "UPDATE", "ContractAssignment", m.assignmentId, `Milestone ${m.name}: ${m.status} → ${status}`);
  return done(workerPaths(m.assignment.workerId), "Milestone updated.");
}

// ---------------------------------------------------------------------------
//  Payment profile
// ---------------------------------------------------------------------------

const paymentSchema = z.object({
  workerId: zId(),
  payee: z.enum(["WORKER", "VENDOR"]),
  rateType: z.enum(RATE_TYPES),
  gstRegistered: zBool(),
  gstin: zOptional(15),
  gstRatePct: zNumber({ min: 0, max: 28 }),
  tdsSection: z.enum(["194C", "194J"]),
  tdsRatePct: zNumber({ min: 0, max: 30 }),
  bankName: zOptional(80),
  accountNumber: zOptional(20),
  ifsc: zOptional(11),
  accountHolder: zOptional(120),
});

/** Create or change a payment profile. Any change needs verification again. */
export async function savePaymentProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(paymentSchema, formData);
  if (parsed.state) return parsed.state;
  const { workerId, ...d } = parsed.data;
  const w = await prisma.contingentWorker.findFirst({ where: { id: workerId, tenantId: viewer.tenantId }, include: { paymentProfile: true } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (d.gstRegistered && (!d.gstin || !validGstin(d.gstin))) return { ok: false, message: "A GST-registered payee needs a valid GSTIN.", errors: { gstin: "Invalid GSTIN" } };
  if (d.payee === "WORKER" && (!d.accountNumber || !d.ifsc)) return { ok: false, message: "Paying the worker directly needs their bank account and IFSC.", errors: { accountNumber: "Required" } };
  if (d.ifsc && !validIfsc(d.ifsc)) return { ok: false, message: "That IFSC is not valid.", errors: { ifsc: "4 letters, 0, 6 characters" } };
  if (d.accountNumber && !/^\d{6,18}$/.test(d.accountNumber)) return { ok: false, message: "Account number must be 6–18 digits.", errors: { accountNumber: "Digits only" } };
  const data = { ...d, gstin: d.gstin?.toUpperCase() ?? null, ifsc: d.ifsc?.toUpperCase() ?? null, gstRatePct: d.gstRatePct ?? 18, tdsRatePct: d.tdsRatePct ?? (d.tdsSection === "194C" ? 2 : 10), status: "PENDING_APPROVAL", verifiedBy: null, verifiedAt: null };
  const before = w.paymentProfile;
  await prisma.contractorPaymentProfile.upsert({ where: { workerId }, create: { workerId, ...data }, update: data });
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "PAYMENT_PROFILE", entityType: "ContingentWorker", entityId: w.id, label: `${w.code} ${w.firstName} ${w.lastName} payment profile`, by: viewer.user.id });
  const mask = (n: string | null | undefined) => (n ? `••••${n.slice(-4)}` : null);
  await audit(viewer, before ? "UPDATE" : "CREATE", "ContingentWorker", w.id, `${before ? "Changed" : "Set up"} payment profile of ${w.code}`,
    before ? { payee: before.payee, bank: before.bankName, account: mask(before.accountNumber), gstin: before.gstin, tdsSection: before.tdsSection } : undefined,
    { payee: data.payee, bank: data.bankName, account: mask(data.accountNumber), gstin: data.gstin, tdsSection: data.tdsSection });
  return done(workerPaths(w.id), res.ok ? "Saved; it waits for verification." : "Saved; the verification already pending covers it.");
}

// ---------------------------------------------------------------------------
//  Timesheets, attendance and expenses
// ---------------------------------------------------------------------------

const timesheetSchema = z.object({
  assignmentId: zId(),
  periodStart: zRequiredDate(),
  periodEnd: zRequiredDate(),
  hours: zRequiredNumber({ min: 0, max: 744 }),
  daysPresent: zNumber({ min: 0, max: 31 }),
  note: zOptional(500),
});

export async function submitContractorTimesheetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(timesheetSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const a = await prisma.contractAssignment.findFirst({ where: { id: d.assignmentId, tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Contract not found." };
  if (a.status !== "ACTIVE" && a.status !== "ENDED") return { ok: false, message: "Timesheets are logged against an approved contract." };
  if (d.periodEnd < d.periodStart) return { ok: false, message: "The period ends before it starts." };
  if (d.periodStart < a.startDate || d.periodEnd > a.endDate) return { ok: false, message: "The period is outside the contract dates." };
  const amount = timesheetAmount(a.rateType, Number(a.rate), d.hours, d.daysPresent ?? 0);
  try {
    const t = await prisma.contractorTimesheet.create({ data: { tenantId: viewer.tenantId, assignmentId: a.id, periodStart: d.periodStart, periodEnd: d.periodEnd, hours: d.hours, daysPresent: d.daysPresent ?? 0, amount, note: d.note, submittedBy: viewer.user.id } });
    await audit(viewer, "CREATE", "ContractorTimesheet", t.id, `Timesheet ${d.periodStart.toISOString().slice(0, 10)}–${d.periodEnd.toISOString().slice(0, 10)}: ${d.hours} h, ${d.daysPresent ?? 0} day(s), ${amount}`);
    return done(workerPaths(a.workerId), `Timesheet logged (${amount}); it waits for the manager's approval.`);
  } catch (err) {
    return toErrorState(err);
  }
}

/** The contract's manager, or a contingent approver, decides; never the person who logged it. */
async function canDecideFor(viewer: Viewer, managerEmployeeId: string | null): Promise<boolean> {
  return can(viewer, P.CONTINGENT_APPROVE) || (!!viewer.employee && viewer.employee.id === managerEmployeeId);
}

export async function decideContractorTimesheetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const t = await prisma.contractorTimesheet.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { assignment: true } });
  if (!t) return { ok: false, message: "Timesheet not found." };
  if (!(await canDecideFor(viewer, t.assignment.managerEmployeeId))) return { ok: false, message: "You cannot decide this timesheet." };
  if (t.status !== "SUBMITTED") return { ok: false, message: "Already decided." };
  if (t.submittedBy === viewer.user.id) return { ok: false, message: "You cannot approve a timesheet you logged." };
  const approve = formData.get("decision") === "approve";
  await prisma.contractorTimesheet.update({ where: { id: t.id }, data: { status: approve ? "APPROVED" : "REJECTED", decidedBy: viewer.user.id, decidedAt: new Date() } });
  await audit(viewer, approve ? "APPROVE" : "REJECT", "ContractorTimesheet", t.id, `${approve ? "Approved" : "Rejected"} contractor timesheet (${Number(t.amount)})`);
  return done(workerPaths(t.assignment.workerId), approve ? "Timesheet approved." : "Timesheet rejected.");
}

const expenseSchema = z.object({ assignmentId: zId(), date: zRequiredDate(), category: zName(60), amount: zRequiredNumber({ min: 0.01 }), description: zOptional(500) });

export async function submitContractorExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const parsed = parseForm(expenseSchema, formData);
  if (parsed.state) return parsed.state;
  const a = await prisma.contractAssignment.findFirst({ where: { id: parsed.data.assignmentId, tenantId: viewer.tenantId } });
  if (!a) return { ok: false, message: "Contract not found." };
  const e = await prisma.contractorExpense.create({ data: { tenantId: viewer.tenantId, ...parsed.data } });
  await audit(viewer, "CREATE", "ContractorExpense", e.id, `Contractor expense ${parsed.data.category}: ${parsed.data.amount}`);
  return done(workerPaths(a.workerId), "Expense logged; it waits for approval.");
}

export async function decideContractorExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const e = await prisma.contractorExpense.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { assignment: true } });
  if (!e) return { ok: false, message: "Expense not found." };
  if (!(await canDecideFor(viewer, e.assignment.managerEmployeeId))) return { ok: false, message: "You cannot decide this expense." };
  if (e.status !== "SUBMITTED") return { ok: false, message: "Already decided." };
  const approve = formData.get("decision") === "approve";
  await prisma.contractorExpense.update({ where: { id: e.id }, data: { status: approve ? "APPROVED" : "REJECTED", decidedBy: viewer.user.id, decidedAt: new Date() } });
  await audit(viewer, approve ? "APPROVE" : "REJECT", "ContractorExpense", e.id, `${approve ? "Approved" : "Rejected"} contractor expense ${e.category} (${Number(e.amount)})`);
  return done(workerPaths(e.assignment.workerId), approve ? "Expense approved." : "Expense rejected.");
}

// ---------------------------------------------------------------------------
//  Access, feedback, conversion
// ---------------------------------------------------------------------------

export async function requestContractorAccessAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const w = await prisma.contingentWorker.findFirst({ where: { id: String(formData.get("workerId") ?? ""), tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (w.status !== "ACTIVE") return { ok: false, message: "Access is for active workers." };
  const system = String(formData.get("system") ?? "").trim().slice(0, 80);
  const level = String(formData.get("level") ?? "STANDARD");
  if (!system) return { ok: false, message: "Name the system or site.", errors: { system: "Required" } };
  if (!["READ_ONLY", "STANDARD", "ADMIN"].includes(level)) return { ok: false, message: "Unknown access level." };
  const acc = await prisma.contractorAccess.create({ data: { tenantId: viewer.tenantId, workerId: w.id, system, level, createdBy: viewer.user.id } });
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "ACCESS", entityType: "ContractorAccess", entityId: acc.id, label: `${w.code}: ${system} (${level.toLowerCase()})`, by: viewer.user.id });
  if (!res.ok) return res;
  await audit(viewer, "CREATE", "ContingentWorker", w.id, `Requested ${level.toLowerCase()} access to ${system} for ${w.code}`);
  return done(workerPaths(w.id), "Access requested.");
}

export async function revokeContractorAccessAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const acc = await prisma.contractorAccess.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!acc || acc.status !== "GRANTED") return { ok: false, message: "That access is not granted." };
  await prisma.contractorAccess.update({ where: { id: acc.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  await audit(viewer, "UPDATE", "ContingentWorker", acc.workerId, `Revoked access to ${acc.system}`);
  return done(workerPaths(acc.workerId), "Access revoked.");
}

export async function addContractorFeedbackAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const w = await prisma.contingentWorker.findFirst({ where: { id: String(formData.get("workerId") ?? ""), tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (!can(viewer, P.CONTINGENT_MANAGE) && !(viewer.employee && viewer.employee.id === w.managerEmployeeId)) return { ok: false, message: "Only the worker's manager or a contingent admin can give feedback." };
  const rating = Math.trunc(Number(formData.get("rating")));
  if (!(rating >= 1 && rating <= 5)) return { ok: false, message: "Rate from 1 to 5.", errors: { rating: "1–5" } };
  const comment = String(formData.get("comment") ?? "").trim().slice(0, 2000) || null;
  await prisma.contractorFeedback.create({ data: { tenantId: viewer.tenantId, workerId: w.id, rating, comment, givenBy: viewer.user.id } });
  await audit(viewer, "CREATE", "ContingentWorker", w.id, `Performance feedback for ${w.code}: ${rating}/5`);
  return done(workerPaths(w.id), "Feedback recorded.");
}

export async function requestConversionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  const w = await prisma.contingentWorker.findFirst({ where: { id: String(formData.get("workerId") ?? ""), tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (w.status !== "ACTIVE") return { ok: false, message: "Only an active worker can be converted." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!reason) return { ok: false, message: "Give a reason.", errors: { reason: "Required" } };
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "CONVERSION", entityType: "ContingentWorker", entityId: w.id, label: `${w.code} ${w.firstName} ${w.lastName}`, reason, by: viewer.user.id });
  if (!res.ok) return res;
  await audit(viewer, "UPDATE", "ContingentWorker", w.id, `Requested conversion of ${w.code} to employee: ${reason}`);
  return done(workerPaths(w.id), "Conversion sent for approval.");
}

/**
 * After the conversion is approved, HR creates the employee record from the
 * worker (the regular Add Employee path, with its onboarding), and the
 * worker's contracts end.
 */
export async function convertContractorAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CONTINGENT_MANAGE);
  if (!can(viewer, P.EMPLOYEE_CREATE)) return { ok: false, message: "Creating the employee needs the employee create permission." };
  const w = await prisma.contingentWorker.findFirst({ where: { id: String(formData.get("workerId") ?? ""), tenantId: viewer.tenantId } });
  if (!w) return { ok: false, message: "Worker not found." };
  if (w.status !== "ACTIVE") return { ok: false, message: "Only an active worker can be converted." };
  const approved = await prisma.workforceRequest.findFirst({ where: { tenantId: viewer.tenantId, kind: "CONVERSION", entityId: w.id, status: "APPROVED" } });
  if (!approved) return { ok: false, message: "The conversion has not been approved." };
  const workEmail = String(formData.get("workEmail") ?? "").trim() || w.email || "";
  const f = new FormData();
  const set = (k: string, v: string | null | undefined) => { if (v) f.set(k, v); };
  set("firstName", w.firstName); set("lastName", w.lastName); set("workEmail", workEmail); set("mobile", w.phone);
  set("dateOfJoining", String(formData.get("dateOfJoining") ?? ""));
  set("legalEntityId", String(formData.get("legalEntityId") ?? ""));
  set("locationId", String(formData.get("locationId") ?? ""));
  set("departmentId", String(formData.get("departmentId") ?? "") || w.departmentId);
  set("jobTitleId", String(formData.get("jobTitleId") ?? ""));
  set("reportingManagerId", w.managerEmployeeId);
  f.set("status", "PROBATION");
  const res = await createEmployee(prev, f);
  if (!res.ok) return res;
  const emp = await prisma.employee.findFirst({ where: { tenantId: viewer.tenantId, workEmail: workEmail.toLowerCase() }, orderBy: { createdAt: "desc" } });
  await prisma.$transaction(async (tx) => {
    const running = await tx.contractAssignment.findMany({ where: { workerId: w.id, status: "ACTIVE" }, select: { id: true } });
    for (const a of running) await endAssignment(tx, a.id, "Converted to employee");
    await tx.contingentWorker.update({ where: { id: w.id }, data: { status: "CONVERTED", convertedEmployeeId: emp?.id ?? null, endedAt: new Date() } });
  });
  await audit(viewer, "UPDATE", "ContingentWorker", w.id, `Converted ${w.code} to employee ${emp?.employeeNumber ?? ""}`, undefined, { employeeId: emp?.id });
  return done(workerPaths(w.id), res.message ?? "Converted.");
}
