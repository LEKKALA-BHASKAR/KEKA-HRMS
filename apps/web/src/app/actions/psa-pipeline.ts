"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveOpportunity, moveOpportunityStage, requestOpportunityConversion, archiveOpportunity, deleteOpportunity, addOpportunityComment,
  saveProspect, convertProspect, createEstimate, updateEstimateHeader, saveEstimateLine, deleteEstimateLine, publishEstimate, duplicateEstimate,
  deleteEstimate, raiseProjectRequest, approveProjectRequest, rejectProjectRequest, type ProjectForm,
} from "@keka/services";
import { requireAuth, type Viewer } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import {
  z, parseForm, formList, toErrorState, writeAudit, actionDone as done, zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate,
  zOptionalId, zId, zEmail, type ActionState,
} from "@/lib/forms";

/**
 * Opportunities, prospects, estimates and project requests. Each action
 * re-checks the permission, hands the tenant to the service (which checks
 * every id against it) and audits the change.
 */

const P = PERMISSIONS;
const BILLING = z.enum(["TIME_AND_MATERIAL", "MILESTONE", "RETAINER", "NON_BILLABLE"]);
const OPP_PATHS = ["/projects/opportunities", "/projects/dashboard", "/projects/finances"];

async function audit(viewer: Viewer, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT", entityType: string, entityId: string | null | undefined, summary: string) {
  await writeAudit(viewer, { module: "PROJECTS", action, entityType, entityId: entityId ?? null, summary });
}

// ---- Opportunities -------------------------------------------------------------------

const oppSchema = z.object({
  id: zOptionalId(), name: zName(160), description: zOptional(2000), party: zId(), sourceId: zOptionalId(), stageId: zId(), ownerId: zId(),
  billingModel: BILLING, estimatedRevenue: zRequiredNumber({ min: 0 }), fxRate: zNumber({ min: 0 }),
  startDate: zRequiredDate(), closeDate: zRequiredDate(), expectedProjectStart: zRequiredDate(), expectedProjectEnd: zDate(),
  orgUnit: zOptional(80),
});

/** "client:<id>" or "prospect:<id>", from the one combined picker. */
const partyOf = (v: string) => (v.startsWith("prospect:") ? { prospectId: v.slice(9), clientId: null } : { clientId: v.replace(/^client:/, ""), prospectId: null });
/** "bu:<id>", "dept:<id>" or "loc:<id>". */
const orgOf = (v: string | null) => ({
  businessUnitId: v?.startsWith("bu:") ? v.slice(3) : null, departmentId: v?.startsWith("dept:") ? v.slice(5) : null, locationId: v?.startsWith("loc:") ? v.slice(4) : null,
});

export async function saveOpportunityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const parsed = parseForm(oppSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, party, orgUnit, ...d } = parsed.data;
  try {
    const managers = formList(formData, "managerIds").filter((m) => m !== d.ownerId);
    const res = await saveOpportunity(viewer.tenantId, { ...d, ...partyOf(party), ...orgOf(orgUnit), managerIds: managers }, viewer.user.id, id);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, id ? "UPDATE" : "CREATE", "Opportunity", res.id, `${id ? "Updated" : "Added"} opportunity ${d.name}`);
    return done([...OPP_PATHS, `/projects/opportunities/${res.id}`], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function moveStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("opportunityId") ?? ""), stageId = String(formData.get("stageId") ?? "");
  const res = await moveOpportunityStage(viewer.tenantId, id, stageId, viewer.user.id, String(formData.get("lostReason") ?? "") || null);
  if (!res.ok) return { ok: false, message: res.message };
  await audit(viewer, "UPDATE", "Opportunity", id, `updated opportunity stage: ${res.message}`);
  // Closed Won asks whether to hand the deal to delivery.
  return { ...done([...OPP_PATHS, `/projects/opportunities/${id}`], res.message), ...(res.won ? { values: { won: "1" } } : {}) };
}

export async function requestConversionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("opportunityId") ?? "");
  const res = await requestOpportunityConversion(viewer.tenantId, id, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await audit(viewer, "CREATE", "ProjectRequest", res.id, "submitted a request to convert the opportunity into a project");
  return done([...OPP_PATHS, `/projects/opportunities/${id}`, "/projects/list", "/projects/approvals"], res.message);
}

export async function opportunityOpsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("opportunityId") ?? ""), op = String(formData.get("op") ?? "");
  const res = op === "archive" || op === "restore" ? await archiveOpportunity(viewer.tenantId, id, op === "archive", viewer.user.id)
    : op === "delete" ? await deleteOpportunity(viewer.tenantId, id)
    : { ok: false, message: "Unknown action." };
  if (res.ok) await audit(viewer, op === "delete" ? "DELETE" : "UPDATE", "Opportunity", id, `${op} opportunity`);
  return res.ok ? done(OPP_PATHS, res.message) : { ok: false, message: res.message };
}

export async function commentOpportunityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_VIEW);
  const id = String(formData.get("opportunityId") ?? "");
  const o = await prisma.opportunity.findFirst({ where: { tenantId: viewer.tenantId, id }, select: { id: true } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  try {
    let fileId: string | null = null;
    const file = formData.get("file");
    if (file instanceof File && file.size > 0) {
      fileId = (await saveFile({ tenantId: viewer.tenantId, filename: file.name, mimeType: file.type || "application/octet-stream", data: Buffer.from(await file.arrayBuffer()), relatedType: "Opportunity", relatedId: o.id, uploadedBy: viewer.user.id })).id;
    }
    const res = await addOpportunityComment(viewer.tenantId, o.id, viewer.user.id, String(formData.get("body") ?? ""), fileId);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, "CREATE", "Opportunity", o.id, "added a comment");
    return done([`/projects/opportunities/${o.id}`], res.message);
  } catch (err) { return toErrorState(err); }
}

/** A document on the opportunity (Documents › Add). */
export async function uploadOpportunityDocAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("opportunityId") ?? "");
  const o = await prisma.opportunity.findFirst({ where: { tenantId: viewer.tenantId, id }, select: { id: true } });
  if (!o) return { ok: false, message: "Opportunity not found." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a file." };
  try {
    const f = await saveFile({ tenantId: viewer.tenantId, filename: file.name, mimeType: file.type || "application/octet-stream", data: Buffer.from(await file.arrayBuffer()), relatedType: "Opportunity", relatedId: o.id, uploadedBy: viewer.user.id });
    await audit(viewer, "CREATE", "Opportunity", o.id, `attached ${f.filename}`);
    return done([`/projects/opportunities/${o.id}`], `${f.filename} added.`);
  } catch (err) { return toErrorState(err); }
}

// ---- Prospects ------------------------------------------------------------------------

const prospectSchema = z.object({
  id: zOptionalId(), name: zName(160), contactName: zOptional(80), contactEmail: zEmail(), contactPhone: zOptional(30), city: zOptional(60), state: zOptional(60),
  countryCode: z.string().length(2).default("IN"), currency: z.string().regex(/^[A-Z]{3}$/).default("INR"), ownerId: zOptionalId(),
});

export async function saveProspectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const parsed = parseForm(prospectSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    const res = await saveProspect(viewer.tenantId, d, id);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, id ? "UPDATE" : "CREATE", "Prospect", res.id, `${id ? "Updated" : "Added"} prospect ${d.name}`);
    return done(["/projects/opportunities/prospects", "/projects/opportunities"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function convertProspectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CLIENT_MANAGE);
  const id = String(formData.get("prospectId") ?? "");
  const res = await convertProspect(viewer.tenantId, id);
  if (!res.ok) return { ok: false, message: res.message };
  await audit(viewer, "CREATE", "Client", res.clientId, `Converted prospect to client`);
  return done(["/projects/opportunities/prospects", "/projects/clients", "/projects/opportunities"], res.message);
}

// ---- Estimates ------------------------------------------------------------------------

export async function createEstimateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const oppId = String(formData.get("opportunityId") ?? ""), type = String(formData.get("type") ?? "");
  if (type !== "TASK" && type !== "RESOURCE") return { ok: false, message: "Select estimate template." };
  const res = await createEstimate(viewer.tenantId, oppId, String(formData.get("name") ?? ""), type, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  await audit(viewer, "CREATE", "Opportunity", oppId, `created ${type === "TASK" ? "task" : "resource"} estimation`);
  return { ...done([`/projects/opportunities/${oppId}`], res.message), values: { estimateId: res.id! } };
}

export async function estimateHeaderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("estimateId") ?? "");
  const patch: { name?: string; rateCardId?: string | null } = {};
  if (formData.has("name")) patch.name = String(formData.get("name"));
  if (formData.has("rateCardId")) patch.rateCardId = String(formData.get("rateCardId")) || null;
  const res = await updateEstimateHeader(viewer.tenantId, id, patch, viewer.user.id);
  if (!res.ok) return { ok: false, message: res.message };
  return done(["/projects/opportunities"], res.message);
}

const lineSchema = z.object({
  estimateId: zId(), id: zOptionalId(), kind: z.enum(["PHASE", "TASK", "MILESTONE", "ROLE"]), parentId: zOptionalId(), name: z.string().max(160).default(""),
  billingRoleId: zOptionalId(), employeeId: zOptionalId(), headcount: zNumber({ min: 1, max: 50 }), startDate: zDate(), endDate: zDate(),
  allocationPercent: zNumber({ min: 1, max: 100 }), hours: zNumber({ min: 0, max: 100000 }), billRate: zNumber({ min: 0 }), costRate: zNumber({ min: 0 }), amount: zNumber({ min: 0 }),
});

export async function saveEstimateLineAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const parsed = parseForm(lineSchema, formData);
  if (parsed.state) return parsed.state;
  const { estimateId, ...l } = parsed.data;
  try {
    const res = await saveEstimateLine(viewer.tenantId, estimateId, {
      ...l, headcount: l.headcount ?? 1, allocationPercent: l.allocationPercent ?? 100, hours: l.hours ?? 0, billRate: l.billRate ?? undefined, costRate: l.costRate ?? undefined, amount: l.amount ?? 0,
    }, viewer.user.id);
    return res.ok ? done(["/projects/opportunities"], res.message) : { ok: false, message: res.message };
  } catch (err) { return toErrorState(err); }
}

export async function estimateOpsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("estimateId") ?? ""), op = String(formData.get("op") ?? "");
  const res = op === "publish" ? await publishEstimate(viewer.tenantId, id, viewer.user.id)
    : op === "duplicate" ? await duplicateEstimate(viewer.tenantId, id, viewer.user.id)
    : op === "delete" ? await deleteEstimate(viewer.tenantId, id)
    : op === "deleteLine" ? await deleteEstimateLine(viewer.tenantId, id, String(formData.get("lineId") ?? ""))
    : { ok: false, message: "Unknown action." };
  if (res.ok && op !== "deleteLine") await audit(viewer, op === "delete" ? "DELETE" : "UPDATE", "OpportunityEstimate", id, `${op} estimation`);
  return res.ok ? done(["/projects/opportunities"], res.message) : { ok: false, message: res.message };
}

// ---- Project requests -----------------------------------------------------------------

const projectFormSchema = z.object({
  requestId: zOptionalId(), name: zName(120), code: zOptional(20), description: zOptional(1000), clientId: zOptionalId(), billingModel: BILLING,
  startDate: zDate(), endDate: zDate(), projectManagerId: zOptionalId(), estimatedHours: zNumber({ min: 0 }), budget: zNumber({ min: 0 }), retainerFee: zNumber({ min: 0 }),
  revenueRecognition: z.enum(["INCOME_TO_DATE", "INVOICED_AMOUNT", "COST_TO_COST", "TIME_EXPENDED"]).default("INCOME_TO_DATE"),
  orgUnit: zOptional(80), priority: zOptional(30), csat: zOptional(30), tags: zOptional(200), rateCardId: zOptionalId(),
});

function projectFormFrom(d: z.infer<typeof projectFormSchema>): ProjectForm {
  const { requestId: _r, orgUnit, tags, ...rest } = d;
  return { ...rest, ...orgOf(orgUnit), tags: (tags ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8), retainerFrequency: d.retainerFee ? "MONTHLY" : null };
}

/** "Raise request" from the Create project drawer opened by "Convert as project". */
export async function raiseProjectRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const parsed = parseForm(projectFormSchema, formData);
  if (parsed.state) return parsed.state;
  try {
    const res = await raiseProjectRequest(viewer.tenantId, projectFormFrom(parsed.data), viewer.user.id, parsed.data.requestId);
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, "UPDATE", "ProjectRequest", res.id, `Raised project request ${parsed.data.name}`);
    return done(["/projects/list", "/projects/approvals", "/projects/dashboard"], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function decideProjectRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const id = String(formData.get("requestId") ?? ""), decision = String(formData.get("decision") ?? "");
  try {
    const res = decision === "approve" ? await approveProjectRequest(viewer.tenantId, id, viewer.user.id)
      : decision === "reject" ? await rejectProjectRequest(viewer.tenantId, id, viewer.user.id, String(formData.get("reason") ?? ""))
      : { ok: false, message: "Choose approve or reject." };
    if (!res.ok) return { ok: false, message: res.message };
    await audit(viewer, decision === "approve" ? "APPROVE" : "REJECT", "ProjectRequest", id, res.message);
    return done(["/projects/list", "/projects/approvals", "/projects/dashboard", "/inbox", "/projects/resources"], res.message);
  } catch (err) { return toErrorState(err); }
}
