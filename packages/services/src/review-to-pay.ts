import { prisma, type Prisma } from "@keka/db";
import { selectStructureForCtc } from "@keka/payroll";
import { openApproval } from "./payroll-approvals";
import { applySalaryRevision } from "./salary-revisions";
import { scheduleBonus } from "./bonuses";

/**
 * Review-to-pay. A cycle's merit matrix gives each rating band an increment
 * and a bonus as a share of CTC. Proposals are built from calibrated reviews,
 * adjusted where someone has a reason, then applied: each becomes a salary
 * revision (through the pay group's compensation approval chain, exactly as
 * a revision from the profile would) and, when there is one, a bonus.
 */

export interface MeritRow { bandId: string; incrementPercent: number; bonusPercent: number }
type R = { ok: boolean; message: string };
const r2 = (n: number) => Math.round(n * 100) / 100;
const CALIBRATED = ["CALIBRATED", "SHARED", "ACKNOWLEDGED"] as const;

export function meritOf(json: unknown): MeritRow[] {
  return Array.isArray(json) ? (json as MeritRow[]).filter((r) => r && typeof r.bandId === "string") : [];
}

export async function setMeritMatrix(tenantId: string, cycleId: string, rows: MeritRow[]): Promise<R> {
  const c = await prisma.reviewCycle.findFirst({ where: { id: cycleId, tenantId }, include: { bands: true } });
  if (!c) return { ok: false, message: "Cycle not found." };
  const known = new Set(c.bands.map((b) => b.id));
  for (const r of rows) {
    if (!known.has(r.bandId)) return { ok: false, message: "A band in the matrix is not part of this cycle." };
    if (!(r.incrementPercent >= 0 && r.incrementPercent <= 100)) return { ok: false, message: "Increments run from 0% to 100%." };
    if (!(r.bonusPercent >= 0 && r.bonusPercent <= 100)) return { ok: false, message: "Bonuses run from 0% to 100% of CTC." };
  }
  await prisma.reviewCycle.update({ where: { id: c.id }, data: { meritMatrix: rows.map((r) => ({ bandId: r.bandId, incrementPercent: r2(r.incrementPercent), bonusPercent: r2(r.bonusPercent) })) as unknown as Prisma.InputJsonValue } });
  return { ok: true, message: "Merit matrix saved. Rebuild proposals to apply it to drafts." };
}

/**
 * Draft a proposal for every calibrated review with a band and a current
 * salary. Drafts are refreshed from the matrix unless someone adjusted them;
 * applied or skipped proposals are left alone.
 */
export async function buildProposals(tenantId: string, cycleId: string, byUserId: string, employeeWhere?: Prisma.EmployeeWhereInput): Promise<R & { made?: number; skipped?: number }> {
  const c = await prisma.reviewCycle.findFirst({ where: { id: cycleId, tenantId }, include: { bands: true } });
  if (!c) return { ok: false, message: "Cycle not found." };
  const matrix = meritOf(c.meritMatrix);
  if (matrix.length === 0) return { ok: false, message: "Set the merit matrix first." };
  const reviews = await prisma.employeeReview.findMany({
    where: { cycleId, status: { in: [...CALIBRATED] }, bandId: { not: null }, employee: { status: { not: "EXITED" }, ...(employeeWhere ?? {}) } },
    select: { id: true, employeeId: true, bandId: true, employee: { select: { salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1, select: { annualCtc: true } } } } },
  });
  const existing = new Map((await prisma.compensationProposal.findMany({ where: { cycleId } })).map((p) => [p.reviewId, p]));
  let made = 0, skipped = 0;
  for (const r of reviews) {
    const ctc = Number(r.employee.salaryRevisions[0]?.annualCtc ?? 0);
    const row = matrix.find((m) => m.bandId === r.bandId);
    if (!(ctc > 0) || !row) { skipped++; continue; }
    const band = c.bands.find((b) => b.id === r.bandId)?.name ?? null;
    const prev = existing.get(r.id);
    if (prev && prev.status !== "DRAFT") continue;
    const adjusted = prev && (Number(prev.proposedPercent) !== Number(prev.recommendedPercent) || prev.note);
    const pct = adjusted ? Number(prev!.proposedPercent) : row.incrementPercent;
    const bonus = adjusted ? Number(prev!.bonusAmount) : r2((ctc * row.bonusPercent) / 100);
    const data = { bandName: band, currentCtc: ctc, recommendedPercent: row.incrementPercent, proposedPercent: pct, proposedCtc: Math.round(ctc * (1 + pct / 100)), bonusAmount: bonus };
    if (prev) await prisma.compensationProposal.update({ where: { id: prev.id }, data });
    else await prisma.compensationProposal.create({ data: { tenantId, cycleId, reviewId: r.id, employeeId: r.employeeId, proposedBy: byUserId, ...data } });
    made++;
  }
  return { ok: true, made, skipped, message: `${made} proposal${made === 1 ? "" : "s"} ready${skipped ? `; ${skipped} skipped for having no current salary or band in the matrix` : ""}.` };
}

export async function updateProposal(input: { tenantId: string; id: string; proposedPercent: number; bonusAmount: number; note: string | null; byUserId: string }): Promise<R> {
  const p = await prisma.compensationProposal.findFirst({ where: { id: input.id, tenantId: input.tenantId }, include: { employee: { select: { displayName: true } } } });
  if (!p) return { ok: false, message: "Proposal not found." };
  if (p.status !== "DRAFT") return { ok: false, message: "Only draft proposals can be changed." };
  if (!(input.proposedPercent >= 0 && input.proposedPercent <= 100)) return { ok: false, message: "The increment must be from 0% to 100%." };
  if (!(input.bonusAmount >= 0)) return { ok: false, message: "The bonus cannot be negative." };
  const ctc = Number(p.currentCtc);
  const offMatrix = Math.abs(input.proposedPercent - Number(p.recommendedPercent)) > 0.001;
  if (offMatrix && !input.note?.trim()) return { ok: false, message: "Departing from the merit matrix needs a reason." };
  await prisma.compensationProposal.update({
    where: { id: p.id },
    data: { proposedPercent: r2(input.proposedPercent), proposedCtc: Math.round(ctc * (1 + input.proposedPercent / 100)), bonusAmount: r2(input.bonusAmount), note: input.note?.trim() || null, proposedBy: input.byUserId },
  });
  return { ok: true, message: `Updated ${p.employee.displayName}: ${r2(input.proposedPercent)}%.` };
}

export async function setProposalSkipped(tenantId: string, id: string, skip: boolean): Promise<R> {
  const p = await prisma.compensationProposal.findFirst({ where: { id, tenantId } });
  if (!p) return { ok: false, message: "Proposal not found." };
  if (p.status === "APPLIED") return { ok: false, message: "This proposal is already applied." };
  await prisma.compensationProposal.update({ where: { id }, data: { status: skip ? "SKIPPED" : "DRAFT" } });
  return { ok: true, message: skip ? "Skipped." : "Back in the draft list." };
}

/**
 * Apply draft proposals: a revision per employee from the effective date,
 * through the approval chain when the pay group has one, and the bonus for
 * the payout month. One employee's problem does not stop the others; it is
 * reported back.
 */
export async function applyProposals(input: {
  tenantId: string; cycleId: string; ids: string[]; effectiveFrom: Date; byUserId: string;
  bonusTypeId: string | null; payoutYear: number; payoutMonth: number;
}): Promise<R & { applied?: number; pending?: number; problems?: string[] }> {
  const props = await prisma.compensationProposal.findMany({
    where: { tenantId: input.tenantId, cycleId: input.cycleId, id: { in: input.ids }, status: "DRAFT" },
    include: { employee: { select: { id: true, displayName: true, employeeNumber: true, payGroupId: true, salaryRevisions: { where: { status: "APPLIED" }, orderBy: { effectiveFrom: "desc" }, take: 1 } } } },
  });
  if (props.length === 0) return { ok: false, message: "Choose at least one draft proposal." };
  if (props.some((p) => Number(p.bonusAmount) > 0) && !input.bonusTypeId) return { ok: false, message: "Choose the bonus type for the bonuses being paid." };
  let applied = 0, pending = 0;
  const problems: string[] = [];
  for (const p of props) {
    const e = p.employee;
    const who = `${e.displayName} (${e.employeeNumber})`;
    if (!e.payGroupId) { problems.push(`${who}: no pay group`); continue; }
    if (await prisma.salaryRevision.count({ where: { employeeId: e.id, status: "PENDING_APPROVAL" } })) { problems.push(`${who}: a salary change is already waiting for approval`); continue; }
    const prev = e.salaryRevisions[0];
    const newCtc = Number(p.proposedCtc);
    let revisionId: string | null = null;
    if (newCtc !== Number(p.currentCtc)) {
      const structures = await prisma.salaryStructure.findMany({ where: { payGroupId: e.payGroupId, isActive: true }, select: { id: true, minAnnualCtc: true, maxAnnualCtc: true, isDefault: true } });
      const chosen = selectStructureForCtc(structures.map((s) => ({ ...s, minAnnualCtc: s.minAnnualCtc === null ? null : Number(s.minAnnualCtc), maxAnnualCtc: s.maxAnnualCtc === null ? null : Number(s.maxAnnualCtc) })), newCtc);
      const structureId = chosen?.id ?? prev?.structureId ?? null;
      if (!structureId) { problems.push(`${who}: no salary structure covers ${newCtc}`); continue; }
      const rev = await prisma.salaryRevision.create({
        data: {
          employeeId: e.id, structureId, effectiveFrom: input.effectiveFrom, annualCtc: newCtc, previousCtc: Number(p.currentCtc),
          remunerationType: prev?.remunerationType ?? "MONTHLY", status: "PENDING_APPROVAL", reason: `Annual review: ${p.bandName ?? "rated"}, ${Number(p.proposedPercent)}%`, createdBy: input.byUserId,
        },
      });
      revisionId = rev.id;
      const approval = await openApproval({
        tenantId: input.tenantId, payGroupId: e.payGroupId, action: "COMPENSATION_CHANGE", requestedBy: input.byUserId, revisionId: rev.id, employeeId: e.id,
        summary: `Salary change for ${e.employeeNumber}: ${newCtc.toLocaleString("en-IN")} (${Number(p.proposedPercent)}%) from ${input.effectiveFrom.toISOString().slice(0, 10)}`, link: "/payroll/approvals",
      });
      if (approval.required && approval.status === "PENDING") pending++;
      else {
        await prisma.$transaction((tx) => applySalaryRevision(rev.id, tx));
        const { fireLetterTriggers } = await import("./letter-ops");
        await fireLetterTriggers(input.tenantId, "SALARY_REVISION_APPLIED", e.id, input.byUserId).catch(() => undefined);
      }
    }
    let bonusId: string | null = null;
    if (Number(p.bonusAmount) > 0 && input.bonusTypeId) {
      const b = await scheduleBonus({ tenantId: input.tenantId, employeeId: e.id, bonusTypeId: input.bonusTypeId, amount: Number(p.bonusAmount), payoutYear: input.payoutYear, payoutMonth: input.payoutMonth, note: `Annual review: ${p.bandName ?? ""}`.trim() });
      if (!b.ok) problems.push(`${who}: bonus not scheduled, ${b.message}`);
      bonusId = b.id ?? null;
    }
    await prisma.compensationProposal.update({ where: { id: p.id }, data: { status: "APPLIED", appliedAt: new Date(), appliedBy: input.byUserId, salaryRevisionId: revisionId, bonusId } });
    applied++;
  }
  const parts = [`Applied ${applied} proposal${applied === 1 ? "" : "s"}`];
  if (pending) parts.push(`${pending} salary change${pending === 1 ? " is" : "s are"} waiting in the approval chain`);
  return { ok: applied > 0, applied, pending, problems, message: `${parts.join("; ")}.${problems.length ? ` Not applied: ${problems.join("; ")}.` : ""}` };
}
