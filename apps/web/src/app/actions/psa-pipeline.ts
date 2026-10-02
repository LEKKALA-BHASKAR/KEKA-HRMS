"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import {
  saveOpportunity, moveOpportunityStage, requestOpportunityConversion, archiveOpportunity, deleteOpportunity, addOpportunityComment,
  saveProspect, createEstimate, updateEstimateHeader, saveEstimateLine, deleteEstimateLine, publishEstimate, duplicateEstimate, deleteEstimate,
  raiseProjectRequest, approveProjectRequest, rejectProjectRequest,
} from "@keka/services/src/psa";
import { requireAuth, requireViewer, can, canAny } from "@/lib/context";
import { forbidden } from "next/navigation";
import {
  z, parseForm, writeAudit, toErrorState, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zId, zOptionalId, zEmail, type ActionState,
} from "@/lib/forms";

/** The sales pipeline: opportunities and their stages, prospects, estimates, and turning a won deal into a project. */

const PIPE = ["/projects/pipeline", "/projects/pipeline/requests"];
type Res = { ok: boolean; message: string; id?: string };
const fail = (r: Res): ActionState => ({ ok: false, message: r.message });
const BILLING_MODELS = ["TIME_AND_MATERIAL", "MILESTONE", "RETAINER", "NON_BILLABLE"] as const;

const oppSchema = z.object({
  id: zOptionalId(), name: zName(160), description: zOptional(2000), clientId: zOptionalId(), prospectId: zOptionalId(), sourceId: zOptionalId(),
  stageId: zId(), ownerId: zId(), billingModel: z.enum(BILLING_MODELS).default("TIME_AND_MATERIAL"),
  estimatedRevenue: zRequiredNumber({ min: 0 }), fxRate: zNumber({ min: 0 }),
  startDate: zRequiredDate(), closeDate: zRequiredDate(), expectedProjectStart: zRequiredDate(), expectedProjectEnd: zDate(),
});

export async function saveOpportunityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const parsed = parseForm(oppSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    const res = await saveOpportunity(viewer.tenantId, { ...d, managerIds: formData.getAll("managerIds").map(String).filter(Boolean) }, viewer.user.id, id);
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: id ? "UPDATE" : "CREATE", entityType: "Opportunity", entityId: res.id, summary: res.message });
    return done([...PIPE, ...(res.id ? [`/projects/pipeline/${res.id}`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}

export async function moveStageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const id = String(formData.get("id") ?? "");
  const res = await moveOpportunityStage(viewer.tenantId, id, String(formData.get("stageId") ?? ""), viewer.user.id, String(formData.get("lostReason") ?? "") || null);
  if (!res.ok) return fail(res);
  await writeAudit(viewer, { module: "PROJECTS", action: "UPDATE", entityType: "Opportunity", entityId: id, summary: res.message });
  return done([...PIPE, `/projects/pipeline/${id}`], res.won ? `${res.message} Convert it to a project from the opportunity.` : res.message);
}

export async function opportunityOpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  // Commenting is open to anyone who can see the pipeline; the rest changes it.
  if (op === "comment" ? !canAny(viewer, [P.OPPORTUNITY_VIEW, P.OPPORTUNITY_MANAGE]) : !can(viewer, P.OPPORTUNITY_MANAGE)) forbidden();
  const res: Res = op === "archive" || op === "restore" ? await archiveOpportunity(viewer.tenantId, id, op === "archive", viewer.user.id)
    : op === "delete" ? await deleteOpportunity(viewer.tenantId, id)
      : op === "convert" ? await requestOpportunityConversion(viewer.tenantId, id, viewer.user.id)
        : op === "comment" ? await addOpportunityComment(viewer.tenantId, id, viewer.user.id, String(formData.get("body") ?? ""))
          : { ok: false, message: "Unknown action." };
  if (!res.ok) return fail(res);
  if (op !== "comment") await writeAudit(viewer, { module: "PROJECTS", action: op === "delete" ? "DELETE" : op === "convert" ? "CREATE" : "UPDATE", entityType: op === "convert" ? "ProjectRequest" : "Opportunity", entityId: res.id ?? id, summary: res.message });
  return done([...PIPE, `/projects/pipeline/${id}`], res.message);
}

const prospectSchema = z.object({
  id: zOptionalId(), name: zName(120), contactName: zOptional(80), contactEmail: zEmail(), contactPhone: zOptional(30), city: zOptional(60), state: zOptional(60),
  countryCode: z.string().length(2).default("IN"), currency: z.string().regex(/^[A-Z]{3}$/).default("INR"), ownerId: zOptionalId(),
});

export async function saveProspectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const parsed = parseForm(prospectSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  try {
    const res = await saveProspect(viewer.tenantId, d, id);
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: id ? "UPDATE" : "CREATE", entityType: "Prospect", entityId: res.id, summary: res.message });
    return done(PIPE, res.message);
  } catch (err) { return toErrorState(err); }
}

const lineSchema = z.object({
  estimateId: zId(), lineId: zOptionalId(), kind: z.enum(["PHASE", "TASK", "MILESTONE", "ROLE"]), parentId: zOptionalId(), name: zOptional(200),
  billingRoleId: zOptionalId(), employeeId: zOptionalId(), headcount: zNumber({ min: 1, max: 100 }), startDate: zDate(), endDate: zDate(),
  allocationPercent: zNumber({ min: 1, max: 100 }), hours: zNumber({ min: 0 }), billRate: zNumber({ min: 0 }), costRate: zNumber({ min: 0 }), amount: zNumber({ min: 0 }),
});

/** The estimate's opportunity, for revalidating its page. */
async function estimateOpp(tenantId: string, estimateId: string) {
  return (await prisma.opportunityEstimate.findFirst({ where: { id: estimateId, opportunity: { tenantId } }, select: { opportunityId: true } }))?.opportunityId ?? null;
}

export async function estimateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.OPPORTUNITY_MANAGE);
  const op = String(formData.get("op") ?? "");
  const estimateId = String(formData.get("estimateId") ?? "");
  try {
    let res: Res;
    const oppId = op === "create" ? String(formData.get("opportunityId") ?? "") : await estimateOpp(viewer.tenantId, estimateId);
    if (op === "create") {
      const type = formData.get("type") === "RESOURCE" ? "RESOURCE" : "TASK";
      res = await createEstimate(viewer.tenantId, oppId ?? "", String(formData.get("name") ?? ""), type, viewer.user.id);
    } else if (op === "header") {
      res = await updateEstimateHeader(viewer.tenantId, estimateId, { name: formData.has("name") ? String(formData.get("name")) : undefined, rateCardId: formData.has("rateCardId") ? String(formData.get("rateCardId")) || null : undefined }, viewer.user.id);
    } else if (op === "line") {
      const parsed = parseForm(lineSchema, formData);
      if (parsed.state) return parsed.state;
      const { lineId, estimateId: eid, ...l } = parsed.data;
      res = await saveEstimateLine(viewer.tenantId, eid, {
        ...l, id: lineId, name: l.name ?? "", headcount: l.headcount ?? undefined, allocationPercent: l.allocationPercent ?? undefined,
        hours: l.hours ?? undefined, billRate: l.billRate ?? undefined, costRate: l.costRate ?? undefined, amount: l.amount ?? undefined,
      }, viewer.user.id);
    } else if (op === "deleteLine") {
      res = await deleteEstimateLine(viewer.tenantId, estimateId, String(formData.get("lineId") ?? ""));
    } else if (op === "publish") {
      res = await publishEstimate(viewer.tenantId, estimateId, viewer.user.id);
    } else if (op === "duplicate") {
      res = await duplicateEstimate(viewer.tenantId, estimateId, viewer.user.id);
    } else if (op === "delete") {
      res = await deleteEstimate(viewer.tenantId, estimateId);
    } else return { ok: false, message: "Unknown action." };
    if (!res.ok) return fail(res);
    if (["create", "publish", "duplicate", "delete"].includes(op)) await writeAudit(viewer, { module: "PROJECTS", action: op === "delete" ? "DELETE" : op === "publish" ? "UPDATE" : "CREATE", entityType: "OpportunityEstimate", entityId: res.id ?? estimateId, summary: res.message });
    return done([...PIPE, ...(oppId ? [`/projects/pipeline/${oppId}`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}

const requestSchema = z.object({
  requestId: zOptionalId(), name: zName(120), code: zOptional(20), description: zOptional(1000), clientId: zOptionalId(),
  billingModel: z.enum(BILLING_MODELS).default("TIME_AND_MATERIAL"), startDate: zDate(), endDate: zDate(), projectManagerId: zOptionalId(),
  estimatedHours: zNumber({ min: 0 }), budget: zNumber({ min: 0 }), retainerFee: zNumber({ min: 0 }), rateCardId: zOptionalId(),
});

/**
 * Project requests. Raising one (from a won opportunity, or afresh) is open to
 * the sales side and project admins; deciding it is for project admins. A
 * project admin can raise and approve in one step unless the PSA settings
 * insist on a separate approval.
 */
export async function projectRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const op = String(formData.get("op") ?? "raise");
  // Checked before the try: forbidden() throws, and must not become an error message.
  if (op === "raise" ? !canAny(viewer, [P.OPPORTUNITY_MANAGE, P.PROJECT_MANAGE]) : !can(viewer, P.PROJECT_MANAGE)) forbidden();
  try {
    if (op === "raise") {
      const parsed = parseForm(requestSchema, formData);
      if (parsed.state) return parsed.state;
      const { requestId, ...f } = parsed.data;
      const form = { ...f, retainerFrequency: f.retainerFee ? "MONTHLY" : null };
      const res = await raiseProjectRequest(viewer.tenantId, form, viewer.user.id, requestId);
      if (!res.ok) return fail(res);
      await writeAudit(viewer, { module: "PROJECTS", action: "CREATE", entityType: "ProjectRequest", entityId: res.id, summary: res.message });
      const settings = await prisma.psaSetting.findUnique({ where: { tenantId: viewer.tenantId }, select: { projectCreationNeedsApproval: true } });
      if (formData.get("approveNow") === "on" && can(viewer, P.PROJECT_MANAGE) && !settings?.projectCreationNeedsApproval && res.id) {
        const approved = await approveProjectRequest(viewer.tenantId, res.id, viewer.user.id);
        if (!approved.ok) return { ok: false, message: `Request raised, but not approved: ${approved.message}` };
        await writeAudit(viewer, { module: "PROJECTS", action: "APPROVE", entityType: "ProjectRequest", entityId: res.id, summary: approved.message });
        return done([...PIPE, "/projects", ...(approved.id ? [`/projects/${approved.id}`] : [])], approved.message);
      }
      return done(PIPE, res.message);
    }
    const id = String(formData.get("id") ?? "");
    const res: Res = op === "approve" ? await approveProjectRequest(viewer.tenantId, id, viewer.user.id)
      : op === "reject" ? await rejectProjectRequest(viewer.tenantId, id, viewer.user.id, String(formData.get("reason") ?? ""))
        : { ok: false, message: "Unknown action." };
    if (!res.ok) return fail(res);
    await writeAudit(viewer, { module: "PROJECTS", action: op === "approve" ? "APPROVE" : "REJECT", entityType: "ProjectRequest", entityId: id, summary: res.message });
    return done([...PIPE, "/projects", ...(op === "approve" && res.id ? [`/projects/${res.id}`] : [])], res.message);
  } catch (err) { return toErrorState(err); }
}
