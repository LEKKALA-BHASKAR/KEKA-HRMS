"use server";

import { PERMISSIONS as P } from "@keka/rbac";
import {
  allocateResource, confirmAllocation, removeAllocation, raiseResourceRequest, closeResourceRequest, sendRequestToHiring,
  saveBillingRole, saveResourceProfile,
} from "@keka/services/src/psa";
import { requireAuth } from "@/lib/context";
import { z, parseForm, writeAudit, actionDone as done, zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zId, zOptionalId, type ActionState } from "@/lib/forms";

/** The resource planner: allocations, requests, billing roles, and each person's cost and capacity. */

const PATHS = ["/projects/resources", "/projects/resources/requests", "/projects/resources/settings", "/projects/resources/utilisation"];

const allocSchema = z.object({
  projectId: zId(), employeeId: zId(), billingRole: zName(60), allocationPercent: zRequiredNumber({ min: 1, max: 100 }),
  billRate: zNumber({ min: 0 }), costRate: zNumber({ min: 0 }), startDate: zRequiredDate(), endDate: zDate(),
  kind: z.enum(["SOFT", "HARD"]).default("HARD"), requestId: zOptionalId(),
});

export async function planAllocationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const parsed = parseForm(allocSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const res = await allocateResource(viewer.tenantId, { ...d, endDate: d.endDate, billRate: d.billRate, costRate: d.costRate, requestId: d.requestId }, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ResourceAllocation", entityId: d.employeeId, summary: res.message });
  return done([...PATHS, `/projects/${d.projectId}`], res.message);
}

export async function allocationOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const res = op === "confirm" ? await confirmAllocation(viewer.tenantId, id, viewer.user.id) : op === "remove" ? await removeAllocation(viewer.tenantId, id) : { ok: false, message: "Unknown action." };
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: op === "remove" ? "DELETE" : "UPDATE", entityType: "ResourceAllocation", entityId: id, summary: res.message });
  return done(PATHS, res.message);
}

const requestSchema = z.object({
  projectId: zId(), type: z.enum(["ROLE", "RESOURCE"]).default("ROLE"), billingRoleId: zId(), employeeId: zOptionalId(),
  count: zRequiredNumber({ min: 1, max: 50 }), allocationPercent: zRequiredNumber({ min: 1, max: 100 }), startDate: zRequiredDate(), endDate: zDate(),
  skills: zOptional(300), minExperienceYears: zNumber({ min: 0, max: 50 }), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"), notes: zOptional(1000),
});

export async function raiseRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_REQUEST);
  const parsed = parseForm(requestSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const res = await raiseResourceRequest(viewer.tenantId, {
    ...d, employeeId: d.type === "RESOURCE" ? d.employeeId : null, skills: (d.skills ?? "").split(","), minExperienceYears: d.minExperienceYears ?? 0,
  }, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ResourceRequest", entityId: res.id, summary: res.message });
  return done(PATHS, res.message);
}

export async function requestOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const res = op === "hire" ? await sendRequestToHiring(viewer.tenantId, id, viewer.user.id)
    : op === "reject" || op === "cancel" ? await closeResourceRequest(viewer.tenantId, id, op === "reject" ? "REJECT" : "CANCEL", viewer.user.id, reason)
      : { ok: false, message: "Unknown action." };
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: op === "reject" ? "REJECT" : "UPDATE", entityType: "ResourceRequest", entityId: id, summary: res.message });
  return done([...PATHS, "/hiring/requisitions"], res.message);
}

export async function saveBillingRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const id = String(formData.get("id") ?? "") || null;
  const res = await saveBillingRole(viewer.tenantId, { name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? "") || null, ...(formData.has("isActive") ? { isActive: formData.get("isActive") === "on" } : {}) }, id);
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: id ? "UPDATE" : "CREATE", entityType: "BillingRole", entityId: res.id, summary: res.message });
  return done(PATHS, res.message);
}

const profileSchema = z.object({
  employeeId: zId(), costType: z.enum(["", "HOURLY", "MONTHLY", "ANNUAL"]).default(""), costAmount: zNumber({ min: 0 }), targetUtilization: zNumber({ min: 0, max: 100 }),
  cap0: zNumber({ min: 0, max: 24 }), cap1: zNumber({ min: 0, max: 24 }), cap2: zNumber({ min: 0, max: 24 }), cap3: zNumber({ min: 0, max: 24 }),
  cap4: zNumber({ min: 0, max: 24 }), cap5: zNumber({ min: 0, max: 24 }), cap6: zNumber({ min: 0, max: 24 }),
});

export async function saveResourceProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.RESOURCE_MANAGE);
  const parsed = parseForm(profileSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const capacity = [d.cap0, d.cap1, d.cap2, d.cap3, d.cap4, d.cap5, d.cap6];
  const res = await saveResourceProfile(viewer.tenantId, d.employeeId, {
    costType: d.costType || null, costAmount: d.costType ? d.costAmount : null, targetUtilization: d.targetUtilization,
    ...(capacity.every((c) => c !== null) ? { capacity: capacity as number[] } : {}),
  });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "ResourceProfile", entityId: d.employeeId, summary: res.message });
  return done(PATHS, res.message);
}
