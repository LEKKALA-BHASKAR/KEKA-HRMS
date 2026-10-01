import { prisma, Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { refreshProjectHealth } from "./projects";
import { checkOpportunityDates, estimateLine, estimateTotals, type EstimateLineInput } from "./psa-math";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The sales side of PSA: opportunities moving through stages, prospects,
 * task and resource estimates, and the hand-off from a won deal to a project
 * through a project request (NEW → raised → approved or rejected).
 *
 * Every function takes the tenant explicitly and checks that each id it is
 * handed belongs to that tenant; the actions above re-check permissions.
 */

type Result = { ok: boolean; message: string; id?: string };
type Tx = Prisma.TransactionClient;
const PM_PERMISSION = "psa.project.manage";

/** Users holding project admin rights in a tenant: who hears about project requests. */
export async function projectAdminUserIds(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { tenantId, roleAssignments: { some: { role: { tenantId, permissions: { some: { permission: PM_PERMISSION } } } } } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function lockTenant(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
}

/** The next OPP-0001 style number, under the tenant lock. */
async function nextOpportunityNumber(tx: Tx, tenantId: string): Promise<string> {
  const last = await tx.opportunity.findMany({ where: { tenantId, number: { startsWith: "OPP-" } }, select: { number: true } });
  const n = last.reduce((m, o) => Math.max(m, Number(o.number.slice(4)) || 0), 0);
  return `OPP-${String(n + 1).padStart(4, "0")}`;
}

// ---- Opportunities -------------------------------------------------------------

export interface OpportunityInput {
  name: string; description?: string | null;
  clientId?: string | null; prospectId?: string | null; sourceId?: string | null; stageId: string;
  ownerId: string; managerIds?: string[];
  billingModel: "TIME_AND_MATERIAL" | "MILESTONE" | "RETAINER" | "NON_BILLABLE";
  estimatedRevenue: number; fxRate?: number | null;
  startDate: Date; closeDate: Date; expectedProjectStart: Date; expectedProjectEnd?: Date | null;
  businessUnitId?: string | null; departmentId?: string | null; locationId?: string | null;
}

async function checkRefs(tenantId: string, i: OpportunityInput): Promise<string | null> {
  if (!!i.clientId === !!i.prospectId) return "Either client or prospect is required to add an opportunity, both cannot be linked to an opportunity.";
  const managers = [...new Set([i.ownerId, ...(i.managerIds ?? [])])];
  const [client, prospect, stage, source, people, bu, dept, loc] = await Promise.all([
    i.clientId ? prisma.client.count({ where: { tenantId, id: i.clientId } }) : 1,
    i.prospectId ? prisma.prospect.count({ where: { tenantId, id: i.prospectId } }) : 1,
    prisma.opportunityStage.count({ where: { tenantId, id: i.stageId, isActive: true } }),
    i.sourceId ? prisma.opportunitySource.count({ where: { tenantId, id: i.sourceId } }) : 1,
    prisma.employee.count({ where: { tenantId, id: { in: managers } } }),
    i.businessUnitId ? prisma.businessUnit.count({ where: { tenantId, id: i.businessUnitId } }) : 1,
    i.departmentId ? prisma.department.count({ where: { tenantId, id: i.departmentId } }) : 1,
    i.locationId ? prisma.location.count({ where: { tenantId, id: i.locationId } }) : 1,
  ]);
  if (!client) return "That client was not found.";
  if (!prospect) return "That prospect was not found.";
  if (!stage) return "Choose an opportunity stage.";
  if (!source) return "That source was not found.";
  if (people !== managers.length) return "An opportunity manager was not found.";
  if (!bu || !dept || !loc) return "A selected organisation unit was not found.";
  if (!(i.estimatedRevenue >= 0)) return "Enter the estimated revenue.";
  const dates = checkOpportunityDates({ startDate: i.startDate, closeDate: i.closeDate, expectedProjectStart: i.expectedProjectStart, expectedProjectEnd: i.expectedProjectEnd ?? null });
  return dates.length ? dates.join(" ") : null;
}

/** Create or update an opportunity. Created in a won stage, it asks for its project straight away. */
export async function saveOpportunity(tenantId: string, input: OpportunityInput, byUserId: string, id?: string | null): Promise<Result> {
  const problem = await checkRefs(tenantId, input);
  if (problem) return { ok: false, message: problem };
  const existing = id ? await prisma.opportunity.findFirst({ where: { tenantId, id } }) : null;
  if (id && !existing) return { ok: false, message: "Opportunity not found." };
  const stage = await prisma.opportunityStage.findFirstOrThrow({ where: { tenantId, id: input.stageId } });
  const party = input.clientId
    ? await prisma.client.findFirstOrThrow({ where: { tenantId, id: input.clientId }, select: { currency: true } })
    : await prisma.prospect.findFirstOrThrow({ where: { tenantId, id: input.prospectId! }, select: { currency: true } });
  const stageChanged = !existing || existing.stageId !== stage.id;
  const data = {
    name: input.name, description: input.description ?? null,
    clientId: input.clientId ?? null, prospectId: input.prospectId ?? null, sourceId: input.sourceId ?? null,
    stageId: stage.id, ownerId: input.ownerId, managerIds: [...new Set([input.ownerId, ...(input.managerIds ?? [])])],
    billingModel: input.billingModel, currency: party.currency, estimatedRevenue: r2(input.estimatedRevenue),
    fxRate: party.currency === "INR" ? 1 : (input.fxRate && input.fxRate > 0 ? input.fxRate : Number(existing?.fxRate ?? 1)),
    startDate: input.startDate, closeDate: input.closeDate, expectedProjectStart: input.expectedProjectStart, expectedProjectEnd: input.expectedProjectEnd ?? null,
    businessUnitId: input.businessUnitId ?? null, departmentId: input.departmentId ?? null, locationId: input.locationId ?? null,
    updatedById: byUserId,
    ...(stageChanged ? {
      winProbability: stage.winProbability,
      status: (existing?.archivedAt ? "ARCHIVED" : stage.kind === "OPEN" ? "OPEN" : stage.kind) as "OPEN" | "WON" | "LOST" | "ARCHIVED",
      closedAt: stage.kind === "OPEN" ? null : new Date(),
    } : {}),
  };
  if (existing) {
    await prisma.opportunity.update({ where: { id: existing.id }, data });
    return { ok: true, message: "Opportunity updated.", id: existing.id };
  }
  const created = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    return tx.opportunity.create({ data: { ...data, tenantId, number: await nextOpportunityNumber(tx, tenantId) } });
  });
  if (stage.kind === "WON") await requestOpportunityConversion(tenantId, created.id, byUserId);
  return { ok: true, message: `${created.name} added to the pipeline.`, id: created.id };
}

/** Move an opportunity to another stage. Closed Lost needs a reason. */
export async function moveOpportunityStage(tenantId: string, id: string, stageId: string, byUserId: string, lostReason?: string | null): Promise<Result & { won?: boolean }> {
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  if (o.archivedAt) return { ok: false, message: "Restore the opportunity before changing its stage." };
  const stage = await prisma.opportunityStage.findFirst({ where: { tenantId, id: stageId, isActive: true } });
  if (!stage) return { ok: false, message: "Choose a stage." };
  if (stage.kind === "LOST" && !lostReason?.trim()) return { ok: false, message: "Say why the opportunity was lost." };
  if (o.stageId === stage.id) return { ok: true, message: "No change.", won: stage.kind === "WON" };
  await prisma.opportunity.update({
    where: { id: o.id },
    data: {
      stageId: stage.id, winProbability: stage.winProbability, status: stage.kind === "OPEN" ? "OPEN" : stage.kind,
      closedAt: stage.kind === "OPEN" ? null : new Date(), lostReason: stage.kind === "LOST" ? lostReason!.trim() : null, updatedById: byUserId,
    },
  });
  return { ok: true, message: `Moved to ${stage.name} (${stage.winProbability}%).`, won: stage.kind === "WON" };
}

/** "Yes, confirm": a won opportunity becomes a project request for the project admins. */
export async function requestOpportunityConversion(tenantId: string, id: string, byUserId: string): Promise<Result> {
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id }, include: { stage: true, projectRequests: { where: { status: { in: ["NEW", "PENDING", "APPROVED"] } } } } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  if (o.stage.kind !== "WON") return { ok: false, message: "Only a Closed Won opportunity can become a project." };
  if (o.projectRequests.length) return { ok: false, message: "A project request for this opportunity already exists." };
  const req = await prisma.projectRequest.create({
    data: {
      tenantId, source: "OPPORTUNITY", opportunityId: o.id, name: o.name, clientId: o.clientId, prospectId: o.prospectId,
      billingModel: o.billingModel, currency: o.currency, estimatedRevenue: o.estimatedRevenue, status: "NEW", requestedById: byUserId,
    },
  });
  await notify({ tenantId, userIds: await projectAdminUserIds(tenantId), kind: "PROJECT", title: `${o.name} was won — convert it to a project`, link: "/projects/list?view=requests" });
  return { ok: true, message: "Project creation request sent to the project admin.", id: req.id };
}

export async function archiveOpportunity(tenantId: string, id: string, archive: boolean, byUserId: string): Promise<Result> {
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id }, include: { stage: true } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  await prisma.opportunity.update({
    where: { id: o.id },
    data: { archivedAt: archive ? new Date() : null, status: archive ? "ARCHIVED" : o.stage.kind === "OPEN" ? "OPEN" : o.stage.kind, updatedById: byUserId },
  });
  return { ok: true, message: archive ? "Archived." : "Restored." };
}

export async function deleteOpportunity(tenantId: string, id: string): Promise<Result> {
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id }, include: { project: { select: { id: true } }, projectRequests: { where: { status: "APPROVED" } } } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  if (o.project || o.projectRequests.length) return { ok: false, message: "This opportunity became a project; archive it instead." };
  await prisma.opportunity.delete({ where: { id: o.id } });
  return { ok: true, message: `${o.name} deleted.` };
}

export async function addOpportunityComment(tenantId: string, id: string, authorId: string, body: string, fileId?: string | null): Promise<Result> {
  if (!body.trim()) return { ok: false, message: "Write a comment first." };
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id }, select: { id: true } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  await prisma.opportunityComment.create({ data: { opportunityId: o.id, authorId, body: body.trim().slice(0, 2000), fileId: fileId ?? null } });
  return { ok: true, message: "Comment added." };
}

// ---- Prospects -------------------------------------------------------------------

export interface ProspectInput { name: string; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; city?: string | null; state?: string | null; countryCode?: string; currency?: string; ownerId?: string | null }

export async function saveProspect(tenantId: string, i: ProspectInput, id?: string | null): Promise<Result> {
  if (i.ownerId && !(await prisma.employee.count({ where: { tenantId, id: i.ownerId } }))) return { ok: false, message: "Owner not found." };
  if (await prisma.client.count({ where: { tenantId, name: i.name } })) return { ok: false, message: `${i.name} is already a client.` };
  const data = { name: i.name, contactName: i.contactName ?? null, contactEmail: i.contactEmail ?? null, contactPhone: i.contactPhone ?? null, city: i.city ?? null, state: i.state ?? null, countryCode: i.countryCode ?? "IN", currency: i.currency ?? "INR", ownerId: i.ownerId ?? null };
  if (id) {
    const p = await prisma.prospect.findFirst({ where: { tenantId, id } });
    if (!p) return { ok: false, message: "Prospect not found." };
    await prisma.prospect.update({ where: { id: p.id }, data });
    return { ok: true, message: "Prospect updated.", id: p.id };
  }
  const p = await prisma.prospect.create({ data: { ...data, tenantId } });
  return { ok: true, message: `${p.name} added as a prospect.`, id: p.id };
}

/** A prospect becomes a client (or is linked to the client of the same name). */
export async function convertProspect(tenantId: string, prospectId: string, tx: Tx | typeof prisma = prisma): Promise<Result & { clientId?: string }> {
  const p = await tx.prospect.findFirst({ where: { tenantId, id: prospectId } });
  if (!p) return { ok: false, message: "Prospect not found." };
  if (p.clientId) return { ok: true, message: "Already a client.", clientId: p.clientId };
  const client = (await tx.client.findFirst({ where: { tenantId, name: p.name } }))
    ?? await tx.client.create({ data: { tenantId, name: p.name, contactName: p.contactName, contactEmail: p.contactEmail, contactPhone: p.contactPhone, city: p.city, state: p.state, countryCode: p.countryCode, currency: p.currency, accountManagerId: p.ownerId } });
  await tx.prospect.update({ where: { id: p.id }, data: { clientId: client.id } });
  await tx.opportunity.updateMany({ where: { tenantId, prospectId: p.id }, data: { clientId: client.id, prospectId: null } });
  await tx.projectRequest.updateMany({ where: { tenantId, prospectId: p.id, status: { in: ["NEW", "PENDING"] } }, data: { clientId: client.id, prospectId: null } });
  return { ok: true, message: `${p.name} is now a client.`, clientId: client.id };
}

// ---- Estimates -------------------------------------------------------------------

async function ownEstimate(tenantId: string, estimateId: string) {
  return prisma.opportunityEstimate.findFirst({ where: { id: estimateId, opportunity: { tenantId } }, include: { opportunity: { select: { id: true, tenantId: true } } } });
}

export async function createEstimate(tenantId: string, opportunityId: string, name: string, type: "TASK" | "RESOURCE", byUserId: string): Promise<Result> {
  const o = await prisma.opportunity.findFirst({ where: { tenantId, id: opportunityId }, select: { id: true } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  if (!name.trim()) return { ok: false, message: "Name the estimate." };
  if (await prisma.opportunityEstimate.count({ where: { opportunityId: o.id, name: name.trim() } })) return { ok: false, message: "An estimate with that name already exists." };
  const e = await prisma.opportunityEstimate.create({ data: { opportunityId: o.id, name: name.trim(), type, updatedById: byUserId } });
  return { ok: true, message: "Estimation created successfully", id: e.id };
}

/** Recompute each line's hours, billing and cost, then the estimate's totals. */
export async function recomputeEstimate(estimateId: string): Promise<void> {
  const lines = await prisma.estimateLine.findMany({ where: { estimateId } });
  const inputs: EstimateLineInput[] = lines.map((l) => ({
    kind: l.kind, startDate: l.startDate, endDate: l.endDate, headcount: l.headcount, allocationPercent: Number(l.allocationPercent),
    hours: Number(l.hours), billRate: Number(l.billRate), costRate: Number(l.costRate), amount: Number(l.amount),
  }));
  for (const [i, l] of lines.entries()) {
    const v = estimateLine(inputs[i]);
    if (Math.abs(v.hours - Number(l.hours)) > 0.005 || Math.abs(v.amount - Number(l.amount)) > 0.005 || Math.abs(v.cost - Number(l.cost)) > 0.005) {
      await prisma.estimateLine.update({ where: { id: l.id }, data: { hours: v.hours, amount: v.amount, cost: v.cost } });
    }
  }
  const t = estimateTotals(inputs);
  await prisma.opportunityEstimate.update({ where: { id: estimateId }, data: { hours: t.hours, billingAmount: t.billing, cost: t.cost, startDate: t.start, endDate: t.end } });
}

export async function updateEstimateHeader(tenantId: string, estimateId: string, patch: { name?: string; rateCardId?: string | null }, byUserId: string): Promise<Result> {
  const e = await ownEstimate(tenantId, estimateId);
  if (!e) return { ok: false, message: "Estimate not found." };
  if (patch.rateCardId && !(await prisma.rateCard.count({ where: { tenantId, id: patch.rateCardId } }))) return { ok: false, message: "Rate card not found." };
  if (patch.name !== undefined && !patch.name.trim()) return { ok: false, message: "Name the estimate." };
  await prisma.opportunityEstimate.update({ where: { id: e.id }, data: { ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.rateCardId !== undefined ? { rateCardId: patch.rateCardId } : {}), updatedById: byUserId } });
  return { ok: true, message: "Saved." };
}

export interface EstimateLineSave {
  id?: string | null; kind: "PHASE" | "TASK" | "MILESTONE" | "ROLE"; parentId?: string | null; name: string; billingRoleId?: string | null; employeeId?: string | null;
  headcount?: number; startDate?: Date | null; endDate?: Date | null; allocationPercent?: number; hours?: number; billRate?: number; costRate?: number; amount?: number;
}

export async function saveEstimateLine(tenantId: string, estimateId: string, l: EstimateLineSave, byUserId: string): Promise<Result> {
  const e = await ownEstimate(tenantId, estimateId);
  if (!e) return { ok: false, message: "Estimate not found." };
  if (e.type === "RESOURCE" && l.kind !== "ROLE") return { ok: false, message: "A resource estimate holds roles and resources only." };
  if (e.type === "TASK" && l.kind === "ROLE") return { ok: false, message: "A task estimate holds phases, tasks and milestones." };
  if (e.type === "RESOURCE" && !e.rateCardId) return { ok: false, message: "Choose a rate card to start adding resources." };
  if (l.kind === "ROLE" && !l.billingRoleId && !l.employeeId) return { ok: false, message: "Choose a role or a resource." };
  if (!l.name.trim() && l.kind !== "ROLE") return { ok: false, message: "Name it." };
  if (l.startDate && l.endDate && l.endDate < l.startDate) return { ok: false, message: "The end is before the start." };
  if (l.kind === "ROLE" && (!l.startDate || !l.endDate)) return { ok: false, message: "A resource needs its start and end dates." };
  if (l.kind === "MILESTONE" && !l.endDate) return { ok: false, message: "A milestone needs its date." };
  const [role, person, parent] = await Promise.all([
    l.billingRoleId ? prisma.billingRole.findFirst({ where: { tenantId, id: l.billingRoleId } }) : null,
    l.employeeId ? prisma.employee.findFirst({ where: { tenantId, id: l.employeeId }, select: { id: true, displayName: true, firstName: true, lastName: true, jobTitleName: true } }) : null,
    l.parentId ? prisma.estimateLine.findFirst({ where: { estimateId: e.id, id: l.parentId, kind: "PHASE" } }) : null,
  ]);
  if (l.billingRoleId && !role) return { ok: false, message: "Billing role not found." };
  if (l.employeeId && !person) return { ok: false, message: "Resource not found." };
  if (l.parentId && !parent) return { ok: false, message: "Phase not found." };
  // Rates come from the estimate's rate card for the role, unless typed in.
  let billRate = l.billRate ?? 0, costRate = l.costRate ?? 0;
  if (e.rateCardId && role && !(l.billRate && l.billRate > 0)) {
    const rate = await prisma.billingRate.findFirst({ where: { rateCardId: e.rateCardId, billingRole: role.name }, orderBy: { rateCategory: "asc" } });
    if (rate) { billRate = Number(rate.billRate); costRate = costRate || Number(rate.suggestedCost ?? 0); }
  }
  if (person && !(costRate > 0)) {
    const prof = await prisma.resourceProfile.findFirst({ where: { tenantId, employeeId: person.id }, select: { hourlyCost: true } });
    if (prof?.hourlyCost) costRate = Number(prof.hourlyCost);
  }
  const name = l.name.trim() || role?.name || (person ? person.displayName ?? `${person.firstName} ${person.lastName}` : "Resource");
  const data = {
    kind: l.kind, parentId: parent?.id ?? null, name, billingRoleId: role?.id ?? null, employeeId: person?.id ?? null,
    headcount: Math.max(1, Math.round(l.headcount ?? 1)), startDate: l.startDate ?? null, endDate: l.endDate ?? null,
    allocationPercent: Math.min(100, Math.max(1, l.allocationPercent ?? 100)), hours: Math.max(0, l.hours ?? 0),
    billRate: Math.max(0, billRate), costRate: Math.max(0, costRate), amount: Math.max(0, l.amount ?? 0),
  };
  if (l.id) {
    const line = await prisma.estimateLine.findFirst({ where: { estimateId: e.id, id: l.id } });
    if (!line) return { ok: false, message: "Line not found." };
    await prisma.estimateLine.update({ where: { id: line.id }, data });
  } else {
    const seq = await prisma.estimateLine.count({ where: { estimateId: e.id } });
    await prisma.estimateLine.create({ data: { ...data, estimateId: e.id, sequence: seq } });
  }
  await recomputeEstimate(e.id);
  await prisma.opportunityEstimate.update({ where: { id: e.id }, data: { updatedById: byUserId } });
  return { ok: true, message: l.id ? "Updated." : `${name} added.` };
}

export async function deleteEstimateLine(tenantId: string, estimateId: string, lineId: string): Promise<Result> {
  const e = await ownEstimate(tenantId, estimateId);
  if (!e) return { ok: false, message: "Estimate not found." };
  const line = await prisma.estimateLine.findFirst({ where: { estimateId: e.id, id: lineId } });
  if (!line) return { ok: false, message: "Line not found." };
  await prisma.estimateLine.deleteMany({ where: { estimateId: e.id, OR: [{ id: line.id }, { parentId: line.id }] } });
  await recomputeEstimate(e.id);
  return { ok: true, message: "Removed." };
}

/** Publishing one estimate un-publishes the opportunity's previous one. */
export async function publishEstimate(tenantId: string, estimateId: string, byUserId: string): Promise<Result> {
  const e = await ownEstimate(tenantId, estimateId);
  if (!e) return { ok: false, message: "Estimate not found." };
  if (!(await prisma.estimateLine.count({ where: { estimateId: e.id, kind: { not: "PHASE" } } }))) return { ok: false, message: "Add tasks or resources before publishing." };
  await prisma.$transaction([
    prisma.opportunityEstimate.updateMany({ where: { opportunityId: e.opportunityId, status: "PUBLISHED", NOT: { id: e.id } }, data: { status: "DRAFT", publishedAt: null } }),
    prisma.opportunityEstimate.update({ where: { id: e.id }, data: { status: "PUBLISHED", publishedAt: new Date(), updatedById: byUserId } }),
  ]);
  return { ok: true, message: `${e.name} published.` };
}

export async function duplicateEstimate(tenantId: string, estimateId: string, byUserId: string): Promise<Result> {
  const e = await prisma.opportunityEstimate.findFirst({ where: { id: estimateId, opportunity: { tenantId } }, include: { lines: { orderBy: { sequence: "asc" } } } });
  if (!e) return { ok: false, message: "Estimate not found." };
  const names = new Set((await prisma.opportunityEstimate.findMany({ where: { opportunityId: e.opportunityId }, select: { name: true } })).map((x) => x.name));
  let name = `${e.name} (copy)`, n = 2;
  while (names.has(name)) name = `${e.name} (copy ${n++})`;
  const copy = await prisma.opportunityEstimate.create({
    data: { opportunityId: e.opportunityId, name, type: e.type, rateCardId: e.rateCardId, hours: e.hours, billingAmount: e.billingAmount, cost: e.cost, startDate: e.startDate, endDate: e.endDate, updatedById: byUserId },
  });
  const idMap = new Map<string, string>();
  for (const l of e.lines.filter((x) => x.kind === "PHASE")) {
    const { id, estimateId: _e, ...rest } = l;
    idMap.set(id, (await prisma.estimateLine.create({ data: { ...rest, estimateId: copy.id } })).id);
  }
  for (const l of e.lines.filter((x) => x.kind !== "PHASE")) {
    const { id: _i, estimateId: _e, ...rest } = l;
    await prisma.estimateLine.create({ data: { ...rest, estimateId: copy.id, parentId: rest.parentId ? idMap.get(rest.parentId) ?? null : null } });
  }
  return { ok: true, message: `${name} created.`, id: copy.id };
}

export async function deleteEstimate(tenantId: string, estimateId: string): Promise<Result> {
  const e = await ownEstimate(tenantId, estimateId);
  if (!e) return { ok: false, message: "Estimate not found." };
  await prisma.opportunityEstimate.delete({ where: { id: e.id } });
  return { ok: true, message: `${e.name} deleted.` };
}

// ---- Project requests ------------------------------------------------------------

export interface ProjectForm {
  name: string; code?: string | null; description?: string | null; clientId?: string | null;
  billingModel: "TIME_AND_MATERIAL" | "MILESTONE" | "RETAINER" | "NON_BILLABLE";
  startDate?: Date | null; endDate?: Date | null; projectManagerId?: string | null;
  estimatedHours?: number | null; budget?: number | null; retainerFee?: number | null; retainerFrequency?: string | null;
  revenueRecognition?: "INCOME_TO_DATE" | "INVOICED_AMOUNT" | "COST_TO_COST" | "TIME_EXPENDED";
  businessUnitId?: string | null; departmentId?: string | null; locationId?: string | null;
  priority?: string | null; csat?: string | null; tags?: string[]; rateCardId?: string | null;
}

/** Problems with a project form, in the order a person would fix them. */
export async function checkProjectForm(tenantId: string, f: ProjectForm, opts: { prospectOk?: boolean } = {}): Promise<string | null> {
  if (!f.name.trim()) return "Name the project.";
  if (f.startDate && f.endDate && f.endDate < f.startDate) return "The end is before the start.";
  if (f.billingModel === "RETAINER" && !f.retainerFee) return "A retainer needs its fee.";
  if (f.billingModel !== "NON_BILLABLE" && !f.clientId && !opts.prospectOk) return "A billable project needs a client.";
  const [client, pm, bu, dept, loc, card] = await Promise.all([
    f.clientId ? prisma.client.count({ where: { tenantId, id: f.clientId } }) : 1,
    f.projectManagerId ? prisma.employee.count({ where: { tenantId, id: f.projectManagerId } }) : 1,
    f.businessUnitId ? prisma.businessUnit.count({ where: { tenantId, id: f.businessUnitId } }) : 1,
    f.departmentId ? prisma.department.count({ where: { tenantId, id: f.departmentId } }) : 1,
    f.locationId ? prisma.location.count({ where: { tenantId, id: f.locationId } }) : 1,
    f.rateCardId ? prisma.rateCard.count({ where: { tenantId, id: f.rateCardId } }) : 1,
  ]);
  if (!client) return "That client was not found.";
  if (!pm) return "That project manager was not found.";
  if (!bu || !dept || !loc) return "A selected organisation unit was not found.";
  if (!card) return "That rate card was not found.";
  return null;
}

const toJson = (f: ProjectForm) => ({ ...f, startDate: f.startDate?.toISOString() ?? null, endDate: f.endDate?.toISOString() ?? null });
export function formFromJson(j: unknown): ProjectForm | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.billingModel !== "string") return null;
  return { ...(o as unknown as ProjectForm), startDate: o.startDate ? new Date(String(o.startDate)) : null, endDate: o.endDate ? new Date(String(o.endDate)) : null, tags: Array.isArray(o.tags) ? o.tags.map(String) : [] };
}

/**
 * "Raise request": the filled-in project form goes to the project admins. A
 * NEW request (from a won opportunity) carries it forward; without one, a
 * fresh request is opened.
 */
export async function raiseProjectRequest(tenantId: string, form: ProjectForm, byUserId: string, requestId?: string | null): Promise<Result> {
  const req = requestId ? await prisma.projectRequest.findFirst({ where: { tenantId, id: requestId } }) : null;
  if (requestId && !req) return { ok: false, message: "Request not found." };
  if (req && req.status !== "NEW") return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  const problem = await checkProjectForm(tenantId, form, { prospectOk: !!req?.prospectId });
  if (problem) return { ok: false, message: problem };
  if (await prisma.project.count({ where: { tenantId, name: form.name.trim() } })) return { ok: false, message: "A project with that name already exists." };
  const data = { name: form.name.trim(), billingModel: form.billingModel, estimatedRevenue: form.budget ?? req?.estimatedRevenue ?? null, payload: toJson(form) as Prisma.InputJsonValue, status: "PENDING" as const };
  const saved = req
    ? await prisma.projectRequest.update({ where: { id: req.id }, data: { ...data, clientId: form.clientId ?? req.clientId } })
    : await prisma.projectRequest.create({ data: { ...data, tenantId, source: "PROJECT", clientId: form.clientId ?? null, requestedById: byUserId } });
  await notify({ tenantId, userIds: (await projectAdminUserIds(tenantId)).filter((u) => u !== byUserId), kind: "PROJECT", title: `Project request: ${saved.name}`, link: "/projects/approvals?view=requests" });
  return { ok: true, message: "Project request raised for approval.", id: saved.id };
}

/** Approve: the project is created from the raised form, linked to its opportunity. */
export async function approveProjectRequest(tenantId: string, id: string, byUserId: string): Promise<Result> {
  const req = await prisma.projectRequest.findFirst({ where: { tenantId, id }, include: { opportunity: { include: { estimates: { where: { status: "PUBLISHED", type: "RESOURCE" }, include: { lines: true } } } } } });
  if (!req) return { ok: false, message: "Request not found." };
  if (req.status !== "PENDING") return { ok: false, message: req.status === "NEW" ? "Convert it to a project form first." : `This request is already ${req.status.toLowerCase()}.` };
  const form = formFromJson(req.payload);
  if (!form) return { ok: false, message: "The request has no project details." };
  const problem = await checkProjectForm(tenantId, { ...form, clientId: form.clientId ?? req.clientId }, { prospectOk: !!req.prospectId });
  if (problem) return { ok: false, message: problem };
  if (await prisma.project.count({ where: { tenantId, name: form.name.trim() } })) return { ok: false, message: "A project with that name already exists." };
  const project = await prisma.$transaction(async (tx) => {
    let clientId = form.clientId ?? req.clientId;
    if (!clientId && req.prospectId) clientId = (await convertProspect(tenantId, req.prospectId, tx)).clientId ?? null;
    const p = await tx.project.create({
      data: {
        tenantId, name: form.name.trim(), code: form.code ?? null, description: form.description ?? null, clientId: clientId ?? null,
        billingModel: form.billingModel, status: "ACTIVE", startDate: form.startDate ?? null, endDate: form.endDate ?? null,
        projectManagerId: form.projectManagerId ?? null, estimatedHours: form.estimatedHours ?? null, budget: form.budget ?? null,
        retainerFee: form.retainerFee ?? null, retainerFrequency: form.retainerFee ? form.retainerFrequency ?? "MONTHLY" : null,
        revenueRecognition: form.revenueRecognition ?? "INCOME_TO_DATE", businessUnitId: form.businessUnitId ?? null, departmentId: form.departmentId ?? null,
        locationId: form.locationId ?? null, priority: form.priority ?? null, csat: form.csat ?? null, tags: form.tags ?? [], rateCardId: form.rateCardId ?? null,
        opportunityId: req.opportunityId && !(await tx.project.count({ where: { opportunityId: req.opportunityId } })) ? req.opportunityId : null,
      },
    });
    await tx.projectRequest.update({ where: { id: req.id }, data: { status: "APPROVED", decidedById: byUserId, decidedAt: new Date(), projectId: p.id, clientId: clientId ?? null, prospectId: null } });
    // The published resource estimate's roles become resource requests for the new project.
    const roles = req.opportunity?.estimates[0]?.lines.filter((l) => l.kind === "ROLE" && l.billingRoleId && l.startDate) ?? [];
    for (const l of roles) {
      await tx.resourceRequest.create({
        data: {
          tenantId, projectId: p.id, estimateLineId: l.id, type: l.employeeId ? "RESOURCE" : "ROLE", billingRoleId: l.billingRoleId!, employeeId: l.employeeId,
          count: l.headcount, allocationPercent: l.allocationPercent, startDate: l.startDate!, endDate: l.endDate, requestedById: byUserId, notes: `From ${req.opportunity!.name}`,
        },
      });
    }
    return p;
  });
  await refreshProjectHealth(project.id);
  const asker = await prisma.user.findFirst({ where: { tenantId, id: req.requestedById }, select: { id: true } });
  await notify({ tenantId, userIds: [asker?.id], kind: "PROJECT", title: `${project.name} was approved and created`, link: `/projects/${project.id}` });
  return { ok: true, message: `${project.name} created.`, id: project.id };
}

export async function rejectProjectRequest(tenantId: string, id: string, byUserId: string, reason: string): Promise<Result> {
  if (!reason.trim()) return { ok: false, message: "Say why the request is rejected." };
  const req = await prisma.projectRequest.findFirst({ where: { tenantId, id } });
  if (!req) return { ok: false, message: "Request not found." };
  if (!["NEW", "PENDING"].includes(req.status)) return { ok: false, message: `This request is already ${req.status.toLowerCase()}.` };
  await prisma.projectRequest.update({ where: { id: req.id }, data: { status: "REJECTED", decidedById: byUserId, decidedAt: new Date(), rejectReason: reason.trim() } });
  await notify({ tenantId, userIds: [req.requestedById], kind: "PROJECT", title: `Project request ${req.name} was rejected`, body: reason.trim(), link: "/projects/list?view=past" });
  return { ok: true, message: "Request rejected." };
}
