"use server";

import { prisma } from "@keka/db";
import type { Permission } from "@keka/rbac";
import { REQUEST_KINDS, decideWorkforceRequest, withdrawWorkforceRequest } from "@keka/services";
import { requireViewer, can } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";

/**
 * Decide or withdraw a workforce request (positions, job architecture,
 * workforce plans and budgets, contingent workforce). Who may decide comes
 * from the request's kind; the requester never decides their own.
 */

const PATHS = ["/positions", "/positions/approvals", "/positions/jobs", "/positions/architecture", "/workforce-planning", "/workforce-planning/approvals", "/workforce-planning/budgets", "/workforce-planning/capacity", "/contingent", "/contingent/approvals", "/contingent/workers"];

export async function decideWorkforceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { ok: false, message: "Unknown decision." };
  const r = await prisma.workforceRequest.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Request not found." };
  const def = REQUEST_KINDS[r.kind];
  if (!def || !can(viewer, def.permission as Permission)) return { ok: false, message: "You cannot decide this request." };
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000) || null;
  const res = await decideWorkforceRequest({ tenantId: viewer.tenantId, id, approve: decision === "approve", note, by: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, {
    module: "EMPLOYEE", action: decision === "approve" ? "APPROVE" : "REJECT", entityType: r.entityType, entityId: r.entityId,
    summary: `${decision === "approve" ? "Approved" : "Rejected"}: ${def.label} — ${r.label}${note ? ` (${note})` : ""}`,
    newValue: { requestId: r.id, kind: r.kind, payload: r.payload },
  });
  return done(PATHS, res.message);
}

export async function withdrawWorkforceRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("id") ?? "");
  const r = await prisma.workforceRequest.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!r) return { ok: false, message: "Request not found." };
  const res = await withdrawWorkforceRequest(viewer.tenantId, id, viewer.user.id);
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: r.entityType, entityId: r.entityId, summary: `Withdrew request: ${REQUEST_KINDS[r.kind]?.label ?? r.kind} — ${r.label}` });
  return done(PATHS, res.message);
}
