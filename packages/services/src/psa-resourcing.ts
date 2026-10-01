import { prisma } from "@keka/db";
import { capacityOf, hourlyCost, peakLoad } from "./psa-math";
import { notify } from "./lifecycle";


/**
 * Resourcing: the billing roles master, soft and hard allocations from the
 * planner, resource requests (raised, allocated, rejected or sent to hiring)
 * and each person's cost and capacity.
 */

type Result = { ok: boolean; message: string; id?: string };

// ---- Billing roles ----------------------------------------------------------------

export async function saveBillingRole(tenantId: string, i: { name: string; description?: string | null; isActive?: boolean }, id?: string | null): Promise<Result> {
  const name = i.name.trim();
  if (!name) return { ok: false, message: "Name the role." };
  const clash = await prisma.billingRole.findFirst({ where: { tenantId, name, ...(id ? { NOT: { id } } : {}) } });
  if (clash) return { ok: false, message: `${name} already exists.` };
  if (id) {
    const r = await prisma.billingRole.findFirst({ where: { tenantId, id } });
    if (!r) return { ok: false, message: "Role not found." };
    await prisma.$transaction([
      prisma.billingRole.update({ where: { id: r.id }, data: { name, description: i.description ?? null, isActive: i.isActive ?? r.isActive } }),
      // Rate cards and allocations refer to the role by name.
      prisma.billingRate.updateMany({ where: { rateCard: { tenantId }, billingRole: r.name }, data: { billingRole: name } }),
    ]);
    return { ok: true, message: "Role updated.", id: r.id };
  }
  const r = await prisma.billingRole.create({ data: { tenantId, name, description: i.description ?? null } });
  return { ok: true, message: `${name} added.`, id: r.id };
}

/** A role still used by a request or an estimate cannot go (the FK would refuse at commit). */
export async function deleteBillingRole(tenantId: string, id: string): Promise<Result> {
  const r = await prisma.billingRole.findFirst({ where: { tenantId, id }, include: { _count: { select: { resourceRequests: true, estimateLines: true } } } });
  if (!r) return { ok: false, message: "Role not found." };
  const rates = await prisma.billingRate.count({ where: { rateCard: { tenantId }, billingRole: r.name } });
  if (r._count.resourceRequests || r._count.estimateLines || rates) return { ok: false, message: `${r.name} is used by rate cards, estimates or resource requests; mark it inactive instead.` };
  await prisma.billingRole.delete({ where: { id: r.id } });
  return { ok: true, message: `${r.name} deleted.` };
}

// ---- Allocations ------------------------------------------------------------------

export interface AllocateInput {
  projectId: string; employeeId: string; startDate: Date; endDate: Date | null; billingRole: string;
  billRate: number | null; costRate?: number | null; allocationPercent: number; kind: "SOFT" | "HARD"; requestId?: string | null;
}

/**
 * Soft or hard allocation from the planner. A hard plan past 100% on any day
 * is refused; a soft one is a pencil mark and may overlap.
 */
export async function allocateResource(tenantId: string, i: AllocateInput, byUserId: string): Promise<Result> {
  const [project, person, role] = await Promise.all([
    prisma.project.findFirst({ where: { tenantId, id: i.projectId }, select: { id: true, name: true, billingModel: true, status: true, endDate: true } }),
    prisma.employee.findFirst({ where: { tenantId, id: i.employeeId, status: { notIn: ["EXITED"] } }, select: { id: true, displayName: true, userId: true, resourceProfile: { select: { hourlyCost: true } } } }),
    prisma.billingRole.findFirst({ where: { tenantId, name: i.billingRole } }),
  ]);
  if (!project) return { ok: false, message: "Project not found." };
  if (!person) return { ok: false, message: "Resource not found." };
  if (["COMPLETED", "CANCELLED"].includes(project.status)) return { ok: false, message: `${project.name} is closed.` };
  if (!role) return { ok: false, message: "Choose a billing role." };
  if (!(i.allocationPercent >= 1 && i.allocationPercent <= 100)) return { ok: false, message: "Allocation must be between 1% and 100%." };
  if (i.endDate && i.endDate < i.startDate) return { ok: false, message: "The end is before the start." };
  const billable = project.billingModel !== "NON_BILLABLE";
  if (billable && !(i.billRate && i.billRate > 0)) return { ok: false, message: "A billable allocation needs a bill rate." };
  const request = i.requestId ? await prisma.resourceRequest.findFirst({ where: { tenantId, id: i.requestId } }) : null;
  if (i.requestId && !request) return { ok: false, message: "Resource request not found." };
  if (request && !["OPEN", "HIRING"].includes(request.status)) return { ok: false, message: "That request is already closed." };
  if (request && request.projectId && request.projectId !== project.id) return { ok: false, message: "That request is for another project." };

  if (i.kind === "HARD") {
    const others = await prisma.resourceAllocation.findMany({
      where: { employeeId: person.id, kind: "HARD", NOT: { projectId: project.id }, ...(i.endDate ? { startDate: { lte: i.endDate } } : {}), OR: [{ endDate: null }, { endDate: { gte: i.startDate } }] },
      select: { startDate: true, endDate: true, allocationPercent: true },
    });
    const winEnd = i.endDate ?? new Date(i.startDate.getTime() + 365 * 86_400_000);
    const peak = peakLoad([...others.map((o) => ({ ...o, allocationPercent: Number(o.allocationPercent) })), { startDate: i.startDate, endDate: i.endDate, allocationPercent: i.allocationPercent }], i.startDate, winEnd);
    if (peak > 100) return { ok: false, message: `That puts ${person.displayName} at ${peak}% across projects. Soft allocate, or lower the share.` };
  }
  const costRate = i.costRate && i.costRate > 0 ? i.costRate : person.resourceProfile?.hourlyCost ? Number(person.resourceProfile.hourlyCost) : null;
  const data = {
    billingRole: role.name, allocationPercent: i.allocationPercent, billRate: billable ? i.billRate : null, costRate, isBillable: billable,
    endDate: i.endDate, kind: i.kind, requestId: request?.id ?? null,
  };
  await prisma.resourceAllocation.upsert({
    where: { projectId_employeeId_startDate: { projectId: project.id, employeeId: person.id, startDate: i.startDate } },
    create: { ...data, projectId: project.id, employeeId: person.id, startDate: i.startDate },
    update: data,
  });
  if (request) {
    const filled = await prisma.resourceAllocation.count({ where: { requestId: request.id } });
    if (filled >= request.count) {
      await prisma.resourceRequest.update({ where: { id: request.id }, data: { status: "ALLOCATED", closedAt: new Date(), closedById: byUserId, closeReason: "Allocated" } });
    }
    await notify({ tenantId, userIds: [request.requestedById], kind: "PROJECT", title: `${person.displayName} was allocated to ${project.name}`, link: `/projects/${project.id}` });
  }
  if (person.userId) await notify({ tenantId, userIds: [person.userId], kind: "PROJECT", title: `You are ${i.kind === "SOFT" ? "pencilled in" : "allocated"} to ${project.name} at ${i.allocationPercent}%`, link: "/projects/time" });
  return { ok: true, message: `${person.displayName} ${i.kind === "SOFT" ? "soft" : "hard"} allocated to ${project.name}.` };
}

/** Turn a soft allocation into a hard one, subject to the same 100% rule. */
export async function confirmAllocation(tenantId: string, allocationId: string, byUserId: string): Promise<Result> {
  const a = await prisma.resourceAllocation.findFirst({ where: { id: allocationId, project: { tenantId } } });
  if (!a) return { ok: false, message: "Allocation not found." };
  if (a.kind === "HARD") return { ok: true, message: "Already a hard allocation." };
  return allocateResource(tenantId, {
    projectId: a.projectId, employeeId: a.employeeId, startDate: a.startDate, endDate: a.endDate, billingRole: a.billingRole ?? "",
    billRate: a.billRate === null ? null : Number(a.billRate), costRate: a.costRate === null ? null : Number(a.costRate),
    allocationPercent: Number(a.allocationPercent), kind: "HARD", requestId: null,
  }, byUserId);
}

export async function removeAllocation(tenantId: string, allocationId: string): Promise<Result> {
  const a = await prisma.resourceAllocation.findFirst({ where: { id: allocationId, project: { tenantId } }, include: { project: { select: { name: true } } } });
  if (!a) return { ok: false, message: "Allocation not found." };
  const logged = await prisma.timeEntry.count({ where: { projectId: a.projectId, employeeId: a.employeeId, date: { gte: a.startDate, ...(a.endDate ? { lte: a.endDate } : {}) } } });
  if (logged) return { ok: false, message: "Time is already logged against this allocation; end it on a date instead." };
  await prisma.resourceAllocation.delete({ where: { id: a.id } });
  return { ok: true, message: `Removed from ${a.project.name}.` };
}

// ---- Requests --------------------------------------------------------------------

export interface ResourceRequestInput {
  projectId?: string | null; opportunityId?: string | null; type: "ROLE" | "RESOURCE"; billingRoleId: string; employeeId?: string | null;
  count: number; allocationPercent: number; startDate: Date; endDate?: Date | null; skills?: string[]; businessUnitIds?: string[]; departmentIds?: string[];
  minExperienceYears?: number; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; notes?: string | null; estimateLineId?: string | null;
}

export async function raiseResourceRequest(tenantId: string, i: ResourceRequestInput, byUserId: string): Promise<Result> {
  if (!!i.projectId === !!i.opportunityId) return { ok: false, message: "A request is for a project or an opportunity." };
  const [project, opp, role, person, bus, depts] = await Promise.all([
    i.projectId ? prisma.project.findFirst({ where: { tenantId, id: i.projectId }, select: { id: true, name: true, status: true } }) : null,
    i.opportunityId ? prisma.opportunity.findFirst({ where: { tenantId, id: i.opportunityId }, select: { id: true, name: true } }) : null,
    prisma.billingRole.findFirst({ where: { tenantId, id: i.billingRoleId, isActive: true } }),
    i.employeeId ? prisma.employee.findFirst({ where: { tenantId, id: i.employeeId }, select: { id: true } }) : null,
    i.businessUnitIds?.length ? prisma.businessUnit.count({ where: { tenantId, id: { in: i.businessUnitIds } } }) : 0,
    i.departmentIds?.length ? prisma.department.count({ where: { tenantId, id: { in: i.departmentIds } } }) : 0,
  ]);
  if (i.projectId && !project) return { ok: false, message: "Project not found." };
  if (i.opportunityId && !opp) return { ok: false, message: "Opportunity not found." };
  if (project && ["COMPLETED", "CANCELLED"].includes(project.status)) return { ok: false, message: `${project.name} is closed.` };
  if (!role) return { ok: false, message: "Choose a billing role." };
  if (i.type === "RESOURCE" && !person) return { ok: false, message: "Choose the resource you need." };
  if (i.employeeId && !person) return { ok: false, message: "Resource not found." };
  if (bus !== (i.businessUnitIds?.length ?? 0) || depts !== (i.departmentIds?.length ?? 0)) return { ok: false, message: "A selected business unit or department was not found." };
  if (!(i.count >= 1 && i.count <= 50)) return { ok: false, message: "Ask for between 1 and 50 people." };
  if (!(i.allocationPercent >= 1 && i.allocationPercent <= 100)) return { ok: false, message: "Allocation must be between 1% and 100%." };
  if (i.endDate && i.endDate < i.startDate) return { ok: false, message: "The end is before the start." };
  const r = await prisma.resourceRequest.create({
    data: {
      tenantId, projectId: project?.id ?? null, opportunityId: opp?.id ?? null, estimateLineId: i.estimateLineId ?? null, type: i.type, billingRoleId: role.id,
      employeeId: person?.id ?? null, count: i.count, allocationPercent: i.allocationPercent, startDate: i.startDate, endDate: i.endDate ?? null,
      skills: (i.skills ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12), businessUnitIds: i.businessUnitIds ?? [], departmentIds: i.departmentIds ?? [],
      minExperienceYears: Math.max(0, Math.round(i.minExperienceYears ?? 0)), priority: i.priority ?? "MEDIUM", notes: i.notes ?? null, requestedById: byUserId,
    },
  });
  return { ok: true, message: `Requested ${i.count} × ${role.name} for ${project?.name ?? opp!.name}.`, id: r.id };
}

export async function closeResourceRequest(tenantId: string, id: string, action: "REJECT" | "CANCEL", byUserId: string, reason: string): Promise<Result> {
  const r = await prisma.resourceRequest.findFirst({ where: { tenantId, id } });
  if (!r) return { ok: false, message: "Request not found." };
  if (!["OPEN", "HIRING"].includes(r.status)) return { ok: false, message: "That request is already closed." };
  if (!reason.trim()) return { ok: false, message: "Give a reason." };
  await prisma.resourceRequest.update({ where: { id: r.id }, data: { status: action === "REJECT" ? "REJECTED" : "CANCELLED", closedAt: new Date(), closedById: byUserId, closeReason: reason.trim() } });
  if (action === "REJECT") await notify({ tenantId, userIds: [r.requestedById], kind: "PROJECT", title: "A resource request was rejected", body: reason.trim(), link: "/projects/resources/requests?view=closed" });
  return { ok: true, message: action === "REJECT" ? "Request rejected." : "Request cancelled." };
}

/** Nobody suitable on the bench: the request goes to hiring as a draft requisition. */
export async function sendRequestToHiring(tenantId: string, id: string, byUserId: string): Promise<Result> {
  const r = await prisma.resourceRequest.findFirst({ where: { tenantId, id }, include: { billingRole: true, project: { select: { name: true, departmentId: true } }, opportunity: { select: { name: true, departmentId: true } } } });
  if (!r) return { ok: false, message: "Request not found." };
  if (r.status !== "OPEN") return { ok: false, message: r.status === "HIRING" ? "Already with hiring." : "That request is closed." };
  const req = await prisma.requisition.create({
    data: {
      tenantId, title: r.billingRole.name, status: "DRAFT", positions: r.count, departmentId: r.departmentIds[0] ?? r.project?.departmentId ?? r.opportunity?.departmentId ?? null,
      businessUnitId: r.businessUnitIds[0] ?? null, raisedBy: byUserId,
      justification: `Resource request for ${r.project?.name ?? r.opportunity?.name ?? "a project"}: ${r.count} × ${r.billingRole.name} from ${r.startDate.toISOString().slice(0, 10)}${r.skills.length ? `; skills ${r.skills.join(", ")}` : ""}.`,
    },
  });
  await prisma.resourceRequest.update({ where: { id: r.id }, data: { status: "HIRING", requisitionId: req.id } });
  return { ok: true, message: `Draft requisition raised for ${r.count} × ${r.billingRole.name}.`, id: req.id };
}

// ---- Cost & capacity -------------------------------------------------------------

export interface ProfileInput { capacity?: number[]; costType?: "HOURLY" | "MONTHLY" | "ANNUAL" | null; costAmount?: number | null; currency?: string; targetUtilization?: number | null }

export async function saveResourceProfile(tenantId: string, employeeId: string, i: ProfileInput): Promise<Result> {
  const e = await prisma.employee.findFirst({ where: { tenantId, id: employeeId }, select: { id: true, displayName: true, resourceProfile: true } });
  if (!e) return { ok: false, message: "Employee not found." };
  const capacity = i.capacity ?? capacityOf(e.resourceProfile?.capacity);
  if (capacity.length !== 7 || capacity.some((h) => !(h >= 0 && h <= 24))) return { ok: false, message: "Capacity is hours per day, 0 to 24." };
  if (i.targetUtilization !== undefined && i.targetUtilization !== null && !(i.targetUtilization >= 0 && i.targetUtilization <= 100)) return { ok: false, message: "Target utilization is a percentage." };
  if (i.costAmount !== undefined && i.costAmount !== null && i.costAmount < 0) return { ok: false, message: "Cost cannot be negative." };
  const costType = i.costType === undefined ? e.resourceProfile?.costType ?? null : i.costType;
  const costAmount = i.costAmount === undefined ? (e.resourceProfile?.costAmount === null || e.resourceProfile?.costAmount === undefined ? null : Number(e.resourceProfile.costAmount)) : i.costAmount;
  const data = {
    capacity, costType, costAmount, currency: i.currency ?? e.resourceProfile?.currency ?? "INR",
    hourlyCost: hourlyCost(costType, costAmount, capacity),
    targetUtilization: i.targetUtilization === undefined ? e.resourceProfile?.targetUtilization ?? null : i.targetUtilization,
  };
  await prisma.resourceProfile.upsert({ where: { employeeId: e.id }, create: { ...data, tenantId, employeeId: e.id }, update: data });
  return { ok: true, message: `${e.displayName}'s cost and capacity saved.` };
}

/** Cost, capacity or target utilisation from CSV rows keyed by employee number. */
export async function importResourceProfiles(tenantId: string, kind: "COST" | "CAPACITY" | "TARGET", rows: string[][]): Promise<{ ok: boolean; message: string; saved: number; errors: string[] }> {
  if (rows.length < 2) return { ok: false, message: "The file has no rows under its header.", saved: 0, errors: [] };
  const [head, ...body] = rows;
  const col = (name: string) => head.findIndex((h) => h.toLowerCase().replace(/[^a-z]/g, "") === name);
  const num = col("employeenumber");
  if (num < 0) return { ok: false, message: "The header needs an Employee Number column.", saved: 0, errors: [] };
  const errors: string[] = [];
  let saved = 0;
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (const [i, r] of body.entries()) {
    const line = i + 2;
    const e = await prisma.employee.findFirst({ where: { tenantId, employeeNumber: r[num] }, select: { id: true } });
    if (!e) { errors.push(`Row ${line}: no employee ${r[num] || "(blank)"}.`); continue; }
    let res: Result;
    if (kind === "COST") {
      const type = (r[col("costtype")] ?? "").toUpperCase();
      const amount = Number(r[col("costamount")] ?? r[col("cost")]);
      if (!["HOURLY", "MONTHLY", "ANNUAL"].includes(type) || !(amount >= 0)) { errors.push(`Row ${line}: cost type must be Hourly, Monthly or Annual with an amount.`); continue; }
      res = await saveResourceProfile(tenantId, e.id, { costType: type as "HOURLY", costAmount: amount, currency: (r[col("currency")] || "INR").toUpperCase() });
    } else if (kind === "CAPACITY") {
      const cap = days.map((d) => Number(r[col(d)] ?? 0));
      if (cap.some((h) => !(h >= 0 && h <= 24))) { errors.push(`Row ${line}: capacity is hours per day, 0 to 24.`); continue; }
      res = await saveResourceProfile(tenantId, e.id, { capacity: cap });
    } else {
      const t = Number(r[col("targetutilization")]);
      if (!(t >= 0 && t <= 100)) { errors.push(`Row ${line}: target utilization must be 0 to 100.`); continue; }
      res = await saveResourceProfile(tenantId, e.id, { targetUtilization: t });
    }
    if (res.ok) saved++; else errors.push(`Row ${line}: ${res.message}`);
  }
  return { ok: saved > 0 || errors.length === 0, message: `${saved} saved${errors.length ? `, ${errors.length} skipped` : ""}.`, saved, errors };
}

// ---- Read models for the planner --------------------------------------------------

export interface PlannerAlloc { id: string; projectId: string; projectName: string; startDate: Date; endDate: Date | null; allocationPercent: number; kind: "SOFT" | "HARD"; billingRole: string | null }

/** People with their allocations overlapping a window, plus their peak load. */
export async function plannerResources(tenantId: string, from: Date, to: Date, search?: string) {
  const people = await prisma.employee.findMany({
    where: {
      tenantId, status: { notIn: ["EXITED", "PREBOARDING"] },
      ...(search ? { OR: [{ displayName: { contains: search, mode: "insensitive" } }, { employeeNumber: { contains: search, mode: "insensitive" } }, { jobTitleName: { contains: search, mode: "insensitive" } }] } : {}),
    },
    select: {
      id: true, displayName: true, firstName: true, lastName: true, employeeNumber: true, jobTitleName: true, photoUrl: true, dateOfJoining: true,
      resourceProfile: { select: { capacity: true, costType: true, costAmount: true, currency: true, hourlyCost: true, targetUtilization: true } },
      projectAllocations: {
        where: { startDate: { lte: to }, OR: [{ endDate: null }, { endDate: { gte: from } }], project: { status: { notIn: ["COMPLETED", "CANCELLED"] } } },
        select: { id: true, projectId: true, startDate: true, endDate: true, allocationPercent: true, kind: true, billingRole: true, project: { select: { name: true } } },
        orderBy: { startDate: "asc" },
      },
    },
    orderBy: { displayName: "asc" },
  });
  return people.map((p) => {
    const allocs: PlannerAlloc[] = p.projectAllocations.map((a) => ({ id: a.id, projectId: a.projectId, projectName: a.project.name, startDate: a.startDate, endDate: a.endDate, allocationPercent: Number(a.allocationPercent), kind: a.kind, billingRole: a.billingRole }));
    const cap = capacityOf(p.resourceProfile?.capacity);
    return {
      id: p.id, name: p.displayName ?? `${p.firstName} ${p.lastName}`, number: p.employeeNumber, title: p.jobTitleName, photoUrl: p.photoUrl, dateOfJoining: p.dateOfJoining,
      profile: p.resourceProfile, capacity: cap, allocations: allocs, projects: new Set(allocs.filter((a) => a.kind === "HARD").map((a) => a.projectId)).size,
      peak: peakLoad(allocs, from, to, cap),
    };
  });
}

/** A short "₹1,800/hr" style cost label for the planner and bench. */
export function costLabel(p: { costType: string | null; costAmount: unknown; currency: string } | null | undefined): string | null {
  if (!p || p.costAmount === null || p.costAmount === undefined) return null;
  const n = Number(p.costAmount);
  const unit = p.costType === "HOURLY" ? "/hr" : p.costType === "MONTHLY" ? "/month" : p.costType === "ANNUAL" ? "/year" : "";
  return `${p.currency === "INR" ? "₹" : `${p.currency} `}${n.toLocaleString("en-IN")}${unit}`;
}

export const CAPACITY_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
