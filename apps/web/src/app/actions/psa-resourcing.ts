"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveBillingRole, deleteBillingRole, allocateResource, confirmAllocation, removeAllocation, raiseResourceRequest, closeResourceRequest,
  sendRequestToHiring, saveResourceProfile, importResourceProfiles, psaParseCsv,
} from "@keka/services";
import { requireAuth, requireViewer, can, canAny, type Viewer } from "@/lib/context";
import {
  z, parseForm, formList, toErrorState, writeAudit, actionDone as done, zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate,
  zOptionalId, zId, type ActionState,
} from "@/lib/forms";

/**
 * Resourcing: billing roles, planner allocations, resource requests and
 * cost & capacity. Resource managers run all of it; a project manager may
 * allocate to and request people for their own projects.
 */

const P = PERMISSIONS;
const PATHS = ["/projects/resources", "/projects/resources/planner", "/projects/resources/requests", "/projects/dashboard"];

async function managesProject(viewer: Viewer, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId || !viewer.employee) return false;
  return (await prisma.project.count({ where: { tenantId: viewer.tenantId, id: projectId, projectManagerId: viewer.employee.id } })) > 0;
}

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string | null | undefined, summary: string) {
  await writeAudit(viewer, { module: "PROJECTS", action, entityType, entityId: entityId ?? null, summary });
}

// ---- Billing roles ----------------------------------------------------------------------

const roleSchema = z.object({ id: zOptionalId(), name: zName(80), description: zOptional(300), isActive: z.string().optional() });

export async function saveRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const parsed = parseForm(roleSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, isActive, ...d } = parsed.data;
  try {
    const res = await saveBillingRole(viewer.tenantId, { ...d, ...(isActive !== undefined ? { isActive: isActive === "on" || isActive === "true" } : {}) }, id);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, id ? "UPDATE" : "CREATE", "BillingRole", res.id, `${id ? "Updated" : "Added"} billing role ${d.name}`);
    return done(["/projects/resources/roles", "/projects/finances/rate-cards"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function deleteRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const res = await deleteBillingRole(viewer.tenantId, id);
  if (res.ok) await audit(viewer, "DELETE", "BillingRole", id, res.message);
  return res.ok ? done(["/projects/resources/roles"], res.message) : { ok: false, message: res.message };
}

// ---- Allocations ------------------------------------------------------------------------

const allocSchema = z.object({
  projectId: zId(), employeeId: zId(), startDate: zRequiredDate(), endDate: zRequiredDate(), billingRole: zName(80), billRate: zNumber({ min: 0 }),
  allocationPercent: zRequiredNumber({ min: 1, max: 100 }), kind: z.enum(["SOFT", "HARD"]), requestId: zOptionalId(),
});

/** Allocate a project (planner drawer): Soft Allocate or Hard Allocate. */
export async function plannerAllocateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(allocSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!can(viewer, P.RESOURCE_MANAGE) && !(await managesProject(viewer, d.projectId))) return { ok: false, message: "Only a resource manager or the project's manager can allocate people to it." };
  if (d.requestId && !can(viewer, P.RESOURCE_MANAGE)) return { ok: false, message: "Only a resource manager fulfils resource requests." };
  try {
    const res = await allocateResource(viewer.tenantId, { ...d, endDate: d.endDate }, viewer.user.id);
    if (!res.ok) return { ok: false, message: res.message, errors: /%/.test(res.message) ? { allocationPercent: "Over 100%" } : undefined };
    await audit(viewer, "CREATE", "ResourceAllocation", d.projectId, res.message);
    return done([...PATHS, `/projects/${d.projectId}`], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function allocationOpsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("allocationId") ?? ""), op = String(formData.get("op") ?? "");
  const a = await prisma.resourceAllocation.findFirst({ where: { id, project: { tenantId: viewer.tenantId } }, select: { projectId: true } });
  if (!a) return { ok: false, message: "Allocation not found." };
  if (!can(viewer, P.RESOURCE_MANAGE) && !(await managesProject(viewer, a.projectId))) return { ok: false, message: "Only a resource manager or the project's manager can change this allocation." };
  const res = op === "confirm" ? await confirmAllocation(viewer.tenantId, id, viewer.user.id) : op === "remove" ? await removeAllocation(viewer.tenantId, id) : { ok: false, message: "Unknown action." };
  if (res.ok) await audit(viewer, op === "remove" ? "DELETE" : "UPDATE", "ResourceAllocation", a.projectId, res.message);
  return res.ok ? done([...PATHS, `/projects/${a.projectId}`], res.message) : { ok: false, message: res.message };
}

// ---- Requests ---------------------------------------------------------------------------

const requestSchema = z.object({
  projectId: zOptionalId(), opportunityId: zOptionalId(), type: z.enum(["ROLE", "RESOURCE"]), billingRoleId: zId(), employeeId: zOptionalId(),
  count: zRequiredNumber({ min: 1, max: 50 }), allocationPercent: zRequiredNumber({ min: 1, max: 100 }), startDate: zRequiredDate(), endDate: zDate(),
  skills: zOptional(300), minExperienceYears: zNumber({ min: 0, max: 40 }), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  notes: zOptional(500), estimateLineId: zOptionalId(),
});

export async function raiseResourceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(requestSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const allowed = canAny(viewer, [P.RESOURCE_MANAGE, P.RESOURCE_REQUEST])
    || (d.projectId ? await managesProject(viewer, d.projectId) : can(viewer, P.OPPORTUNITY_MANAGE));
  if (!allowed) return { ok: false, message: "Only the project's manager or a resource manager can request people for it." };
  if (d.estimateLineId) {
    const line = await prisma.estimateLine.findFirst({ where: { id: d.estimateLineId, estimate: { opportunity: { tenantId: viewer.tenantId, id: d.opportunityId ?? "__none__" } } } });
    if (!line) return { ok: false, message: "Estimate line not found." };
  }
  try {
    const res = await raiseResourceRequest(viewer.tenantId, {
      ...d, endDate: d.endDate, minExperienceYears: d.minExperienceYears ?? 0, skills: (d.skills ?? "").split(","),
      businessUnitIds: formList(formData, "businessUnitIds"), departmentIds: formList(formData, "departmentIds"),
    }, viewer.user.id);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, "CREATE", "ResourceRequest", res.id, res.message);
    return done([...PATHS, ...(d.projectId ? [`/projects/${d.projectId}`] : []), ...(d.opportunityId ? [`/projects/opportunities/${d.opportunityId}`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function resourceRequestOpsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const id = String(formData.get("requestId") ?? ""), op = String(formData.get("op") ?? "");
  try {
    const res = op === "reject" ? await closeResourceRequest(viewer.tenantId, id, "REJECT", viewer.user.id, String(formData.get("reason") ?? ""))
      : op === "cancel" ? await closeResourceRequest(viewer.tenantId, id, "CANCEL", viewer.user.id, String(formData.get("reason") ?? "") || "Cancelled")
      : op === "hire" ? await sendRequestToHiring(viewer.tenantId, id, viewer.user.id)
      : { ok: false, message: "Unknown action." };
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, op === "reject" ? "REJECT" : "UPDATE", "ResourceRequest", id, res.message);
    return done([...PATHS, "/hiring"], res.message);
  } catch (err) { return toErrorState(err); }
}

// ---- Cost & capacity ---------------------------------------------------------------------

const profileSchema = z.object({
  employeeId: zId(), costType: z.enum(["", "HOURLY", "MONTHLY", "ANNUAL"]).default(""), costAmount: zNumber({ min: 0 }), currency: z.string().regex(/^[A-Z]{3}$/).default("INR"),
  targetUtilization: zNumber({ min: 0, max: 100 }),
  sun: zNumber({ min: 0, max: 24 }), mon: zNumber({ min: 0, max: 24 }), tue: zNumber({ min: 0, max: 24 }), wed: zNumber({ min: 0, max: 24 }),
  thu: zNumber({ min: 0, max: 24 }), fri: zNumber({ min: 0, max: 24 }), sat: zNumber({ min: 0, max: 24 }),
});

export async function saveProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const parsed = parseForm(profileSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    const res = await saveResourceProfile(viewer.tenantId, d.employeeId, {
      capacity: [d.sun, d.mon, d.tue, d.wed, d.thu, d.fri, d.sat].map((h) => h ?? 0),
      costType: d.costType ? d.costType : null, costAmount: d.costType ? d.costAmount : null, currency: d.currency, targetUtilization: d.targetUtilization,
    });
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, "UPDATE", "ResourceProfile", d.employeeId, res.message);
    return done(["/projects/resources/capacity", "/projects/resources/planner"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function importCapacityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const kind = String(formData.get("kind") ?? "");
  if (!["COST", "CAPACITY", "TARGET"].includes(kind)) return { ok: false, message: "Choose what to import." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a CSV file." };
  if (file.size > 2 * 1024 * 1024) return { ok: false, message: "Keep the file under 2 MB." };
  try {
    const res = await importResourceProfiles(viewer.tenantId, kind as "COST", psaParseCsv(await file.text()));
    await audit(viewer, "UPDATE", "ResourceProfile", null, `Imported ${kind.toLowerCase()} from CSV: ${res.message}`);
    const msg = res.errors.length ? `${res.message} ${res.errors.slice(0, 5).join(" ")}` : res.message;
    return res.saved > 0 ? done(["/projects/resources/capacity"], msg) : { ok: false, message: msg };
  } catch (err) { return toErrorState(err); }
}
