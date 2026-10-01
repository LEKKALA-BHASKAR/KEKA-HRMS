"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS as P } from "@keka/rbac";
import { setMeritMatrix, buildProposals, updateProposal, setProposalSkipped, applyProposals, type MeritRow } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { actionDone as done, writeAudit, type ActionState } from "@/lib/forms";

/** Review-to-pay: merit matrix, proposals from calibrated reviews, and applying them. */

const path = (cycleId: string) => [`/performance/cycles/${cycleId}/pay`, "/payroll/approvals"];

async function cycleOf(tenantId: string, id: string) {
  return prisma.reviewCycle.findFirst({ where: { id, tenantId }, select: { id: true, name: true } });
}

/** A proposal the viewer may act on: in their tenant and salary scope. */
async function proposalInScope(viewer: Awaited<ReturnType<typeof requireAuth>>, id: string) {
  return prisma.compensationProposal.findFirst({ where: { id, tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.SALARY_REVISE) }, select: { id: true, cycleId: true } });
}

export async function saveMeritMatrixAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const cycle = await cycleOf(viewer.tenantId, String(formData.get("cycleId") ?? ""));
  if (!cycle) return { ok: false, message: "Cycle not found." };
  const rows: MeritRow[] = formData.getAll("bandId").map(String).map((bandId) => ({
    bandId, incrementPercent: Number(formData.get(`inc:${bandId}`) || 0), bonusPercent: Number(formData.get(`bonus:${bandId}`) || 0),
  }));
  const r = await setMeritMatrix(viewer.tenantId, cycle.id, rows);
  if (!r.ok) return r;
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "ReviewCycle", entityId: cycle.id, summary: `Set the merit matrix for ${cycle.name}` });
  return done(path(cycle.id), r.message);
}

export async function buildProposalsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const cycle = await cycleOf(viewer.tenantId, String(formData.get("cycleId") ?? ""));
  if (!cycle) return { ok: false, message: "Cycle not found." };
  const r = await buildProposals(viewer.tenantId, cycle.id, viewer.user.id, scopedEmployeeWhere(viewer, P.SALARY_REVISE));
  if (!r.ok) return r;
  await writeAudit(viewer, { module: "PAYROLL", action: "CREATE", entityType: "CompensationProposal", entityId: cycle.id, summary: `${cycle.name}: ${r.message}` });
  return done(path(cycle.id), r.message);
}

export async function updateProposalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const p = await proposalInScope(viewer, String(formData.get("id") ?? ""));
  if (!p) return { ok: false, message: "Proposal not found." };
  const op = String(formData.get("op") ?? "save");
  const r = op === "skip" || op === "restore"
    ? await setProposalSkipped(viewer.tenantId, p.id, op === "skip")
    : await updateProposal({ tenantId: viewer.tenantId, id: p.id, proposedPercent: Number(formData.get("proposedPercent")), bonusAmount: Number(formData.get("bonusAmount") || 0), note: String(formData.get("note") ?? "") || null, byUserId: viewer.user.id });
  if (!r.ok) return r;
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompensationProposal", entityId: p.id, summary: r.message });
  return done(path(p.cycleId), r.message);
}

export async function applyProposalsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.SALARY_REVISE);
  const cycle = await cycleOf(viewer.tenantId, String(formData.get("cycleId") ?? ""));
  if (!cycle) return { ok: false, message: "Cycle not found." };
  const effective = new Date(`${String(formData.get("effectiveFrom") ?? "")}T00:00:00Z`);
  if (Number.isNaN(effective.getTime())) return { ok: false, message: "Pick the date the increases take effect." };
  const payout = /^(\d{4})-(\d{2})$/.exec(String(formData.get("payoutMonth") ?? ""));
  const requested = formData.getAll("ids").map(String);
  const allowed = (await prisma.compensationProposal.findMany({ where: { id: { in: requested }, cycleId: cycle.id, tenantId: viewer.tenantId, employee: scopedEmployeeWhere(viewer, P.SALARY_REVISE) }, select: { id: true } })).map((p) => p.id);
  const r = await applyProposals({
    tenantId: viewer.tenantId, cycleId: cycle.id, ids: allowed, effectiveFrom: effective, byUserId: viewer.user.id,
    bonusTypeId: String(formData.get("bonusTypeId") ?? "") || null,
    payoutYear: payout ? Number(payout[1]) : effective.getUTCFullYear(), payoutMonth: payout ? Number(payout[2]) : effective.getUTCMonth() + 1,
  });
  if (!r.ok) return { ok: false, message: r.message };
  await writeAudit(viewer, { module: "PAYROLL", action: "UPDATE", entityType: "CompensationProposal", entityId: cycle.id, summary: `${cycle.name}: ${r.message}` });
  return done([...path(cycle.id), "/employees", "/payroll/runs"], r.message);
}
