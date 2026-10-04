"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  submitWorkforceRequest, nextJobCode, nextPositionCode, parseTags, withinRange, locationAllowed, beyondPlanWarning,
  raiseRequisition, VACANCY_REASONS, CRITICALITY, WORK_MODES,
} from "@keka/services";
import { requireAuth, can } from "@/lib/context";
import { foreignReference } from "@/lib/ownership";
import {
  z, parseForm, formList, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredDate, zDate, zOptionalId, zId, zBool, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const POS_PATHS = ["/positions", "/positions/approvals", "/positions/reports"];
const ARCH_PATHS = ["/positions/architecture", "/positions/approvals", "/positions/jobs"];
const JOB_PATHS = ["/positions/jobs", "/positions/approvals"];

// ---------------------------------------------------------------------------
//  Job families and levels
// ---------------------------------------------------------------------------

const familySchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  code: zOptional(20),
  description: zOptional(1000),
  parentId: zOptionalId(),
});

export async function saveJobFamilyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const parsed = parseForm(familySchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...data } = parsed.data;
  if (data.parentId) {
    if (data.parentId === id) return { ok: false, message: "A family cannot sit under itself." };
    const parent = await prisma.jobFamily.findFirst({ where: { id: data.parentId, tenantId: viewer.tenantId } });
    if (!parent) return { ok: false, message: "Parent family not found." };
    // No cycles: walk up from the parent.
    let cursor: string | null = parent.parentId;
    for (let i = 0; cursor && i < 20; i++) {
      if (cursor === id) return { ok: false, message: "That would make the family its own ancestor." };
      cursor = (await prisma.jobFamily.findFirst({ where: { id: cursor, tenantId: viewer.tenantId }, select: { parentId: true } }))?.parentId ?? null;
    }
  }
  try {
    if (id) {
      const before = await prisma.jobFamily.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Job family not found." };
      await prisma.jobFamily.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobFamily", entityId: id, summary: `Updated job family ${data.name}`, oldValue: { name: before.name, code: before.code, parentId: before.parentId }, newValue: data });
      return done(ARCH_PATHS, `Saved ${data.name}.`);
    }
    const f = await prisma.jobFamily.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "JobFamily", entityId: f.id, summary: `Created job family ${data.name}` });
    return done(ARCH_PATHS, `Created ${data.name} as a draft. Submit it for approval to use it.`);
  } catch (err) {
    return toErrorState(err);
  }
}

const levelSchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  code: zOptional(20),
  rank: zNumber({ min: 0, max: 100 }),
  track: z.enum(["IC", "MANAGER", "EXECUTIVE"]).default("IC"),
  careerDefinition: zOptional(2000),
  bandId: zOptionalId(),
  payGradeId: zOptionalId(),
});

export async function saveJobLevelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const parsed = parseForm(levelSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, rank, ...rest } = parsed.data;
  const data = { ...rest, rank: rank ?? 0 };
  const foreign = await foreignReference(viewer.tenantId, { band: data.bandId, payGrade: data.payGradeId });
  if (foreign) return { ok: false, message: foreign };
  try {
    if (id) {
      const before = await prisma.jobLevel.findFirst({ where: { id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Job level not found." };
      await prisma.jobLevel.update({ where: { id }, data });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobLevel", entityId: id, summary: `Updated job level ${data.name}`, oldValue: { name: before.name, rank: before.rank, track: before.track }, newValue: { name: data.name, rank: data.rank, track: data.track } });
      return done(ARCH_PATHS, `Saved ${data.name}.`);
    }
    const l = await prisma.jobLevel.create({ data: { ...data, tenantId: viewer.tenantId, createdBy: viewer.user.id } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "JobLevel", entityId: l.id, summary: `Created job level ${data.name}` });
    return done(ARCH_PATHS, `Created ${data.name} as a draft. Submit it for approval to use it.`);
  } catch (err) {
    return toErrorState(err);
  }
}

/** Send a draft family or level for approval (kind = family | level). */
export async function submitArchitectureAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  const row = kind === "family"
    ? await prisma.jobFamily.findFirst({ where: { id, tenantId: viewer.tenantId } })
    : kind === "level" ? await prisma.jobLevel.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
  if (!row) return { ok: false, message: "Not found." };
  if (row.status !== "DRAFT" && row.status !== "REJECTED") return { ok: false, message: "Only a draft or rejected record can be submitted." };
  const entityType = kind === "family" ? "JobFamily" : "JobLevel";
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: kind === "family" ? "JOB_FAMILY" : "JOB_LEVEL", entityType, entityId: id, label: row.name, by: viewer.user.id });
  if (!res.ok) return res;
  if (kind === "family") await prisma.jobFamily.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  else await prisma.jobLevel.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType, entityId: id, summary: `Submitted ${row.name} for approval` });
  return done(ARCH_PATHS, `${row.name} sent for approval.`);
}

/** Retire an active family or level; it stays on existing jobs but cannot be chosen again. */
export async function retireArchitectureAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  const where = { id, tenantId: viewer.tenantId };
  const row = kind === "family" ? await prisma.jobFamily.findFirst({ where }) : kind === "level" ? await prisma.jobLevel.findFirst({ where }) : null;
  if (!row) return { ok: false, message: "Not found." };
  if (kind === "family") await prisma.jobFamily.update({ where: { id }, data: { status: "RETIRED" } });
  else await prisma.jobLevel.update({ where: { id }, data: { status: "RETIRED" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: kind === "family" ? "JobFamily" : "JobLevel", entityId: id, summary: `Retired ${row.name}` });
  return done(ARCH_PATHS, `Retired ${row.name}.`);
}

// ---------------------------------------------------------------------------
//  Jobs (catalogue) and versioned job descriptions
// ---------------------------------------------------------------------------

const jobSchema = z.object({
  id: zOptionalId(),
  title: zName(120),
  familyId: zOptionalId(),
  levelId: zOptionalId(),
  jobTitleId: zOptionalId(),
  summary: zOptional(4000),
  responsibilities: zOptional(8000),
  qualifications: zOptional(4000),
  competencies: zOptional(1000),
  skills: zOptional(1000),
});

async function archRefsProblem(tenantId: string, familyId: string | null, levelId: string | null): Promise<string | null> {
  if (familyId && !(await prisma.jobFamily.findFirst({ where: { id: familyId, tenantId, status: { not: "RETIRED" } } }))) return "Job family not found.";
  if (levelId && !(await prisma.jobLevel.findFirst({ where: { id: levelId, tenantId, status: { not: "RETIRED" } } }))) return "Job level not found.";
  return null;
}

export async function saveJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const parsed = parseForm(jobSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const bad = (await archRefsProblem(viewer.tenantId, d.familyId, d.levelId)) ?? (await foreignReference(viewer.tenantId, { jobTitle: d.jobTitleId }));
  if (bad) return { ok: false, message: bad };
  const desc = { summary: d.summary, responsibilities: d.responsibilities, qualifications: d.qualifications, competencies: parseTags(d.competencies), skills: parseTags(d.skills) };
  const header = { title: d.title, familyId: d.familyId, levelId: d.levelId, jobTitleId: d.jobTitleId };
  try {
    if (!d.id) {
      const code = await nextJobCode(viewer.tenantId);
      const job = await prisma.jobProfile.create({
        data: { tenantId: viewer.tenantId, code, ...header, ...desc, createdBy: viewer.user.id, versions: { create: { version: 1, ...desc, createdBy: viewer.user.id } } },
      });
      await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "JobProfile", entityId: job.id, summary: `Created job ${code} ${d.title}` });
      return { ...done(JOB_PATHS, `Created ${code} as a draft. Submit its description for approval.`), values: { id: job.id } };
    }
    const job = await prisma.jobProfile.findFirst({ where: { id: d.id, tenantId: viewer.tenantId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!job) return { ok: false, message: "Job not found." };
    const latest = job.versions[0];
    const changedDesc = !latest || JSON.stringify([latest.summary, latest.responsibilities, latest.qualifications, latest.competencies, latest.skills]) !== JSON.stringify([desc.summary, desc.responsibilities, desc.qualifications, desc.competencies, desc.skills]);
    let note = "";
    await prisma.$transaction(async (tx) => {
      await tx.jobProfile.update({ where: { id: job.id }, data: header });
      if (!changedDesc) return;
      if (latest && (latest.status === "DRAFT" || latest.status === "REJECTED")) {
        await tx.jobDescriptionVersion.update({ where: { id: latest.id }, data: { ...desc, status: "DRAFT" } });
        note = ` Draft v${latest.version} updated.`;
      } else if (latest?.status === "PENDING_APPROVAL") {
        throw new Error("The description is waiting for approval. Withdraw the request to change it.");
      } else {
        const version = (latest?.version ?? 0) + 1;
        await tx.jobDescriptionVersion.create({ data: { jobId: job.id, version, ...desc, createdBy: viewer.user.id } });
        note = ` Saved as draft v${version}; the approved v${job.version} stays current until it is approved.`;
      }
      // Until a job is approved its catalogue entry shows the working draft.
      if (job.status !== "ACTIVE") await tx.jobProfile.update({ where: { id: job.id }, data: desc });
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobProfile", entityId: job.id, summary: `Updated job ${job.code} ${d.title}.${note}`, oldValue: { title: job.title, familyId: job.familyId, levelId: job.levelId }, newValue: header });
    return { ...done(JOB_PATHS, `Saved ${job.code}.${note}`), values: { id: job.id } };
  } catch (err) {
    return toErrorState(err);
  }
}

/** Send the latest draft description of a job for approval. */
export async function submitJobDescriptionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const job = await prisma.jobProfile.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!job) return { ok: false, message: "Job not found." };
  const v = job.versions[0];
  if (!v || (v.status !== "DRAFT" && v.status !== "REJECTED")) return { ok: false, message: "There is no draft description to submit." };
  if (!v.summary && !v.responsibilities) return { ok: false, message: "Write a summary or responsibilities first." };
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "JOB_DESCRIPTION", entityType: "JobProfile", entityId: job.id, label: `${job.code} ${job.title} v${v.version}`, payload: { version: v.version }, by: viewer.user.id });
  if (!res.ok) return res;
  await prisma.jobDescriptionVersion.update({ where: { id: v.id }, data: { status: "PENDING_APPROVAL" } });
  if (job.status !== "ACTIVE") await prisma.jobProfile.update({ where: { id: job.id }, data: { status: "PENDING_APPROVAL" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobProfile", entityId: job.id, summary: `Submitted ${job.code} description v${v.version} for approval` });
  return done(JOB_PATHS, `v${v.version} sent for approval.`);
}

export async function retireJobAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const job = await prisma.jobProfile.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { positions: { where: { status: { in: ["VACANT", "FILLED", "PROPOSED"] } } } } } } });
  if (!job) return { ok: false, message: "Job not found." };
  if (job._count.positions > 0) return { ok: false, message: `${job._count.positions} open position(s) use this job. Close or move them first.` };
  await prisma.jobProfile.update({ where: { id: job.id }, data: { status: "RETIRED" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobProfile", entityId: job.id, summary: `Retired job ${job.code}` });
  return done(JOB_PATHS, `Retired ${job.code}.`);
}

// ---------------------------------------------------------------------------
//  Positions
// ---------------------------------------------------------------------------

const positionSchema = z.object({
  id: zOptionalId(),
  title: zName(120),
  jobId: zOptionalId(),
  departmentId: zId(),
  locationId: zOptionalId(),
  costCenterId: zOptionalId(),
  payGradeId: zOptionalId(),
  reportsToId: zOptionalId(),
  budgetedAnnualSalary: zNumber({ min: 0 }),
  budgetStatus: z.enum(["BUDGETED", "UNBUDGETED"]).default("BUDGETED"),
  fte: zNumber({ min: 0.1, max: 1 }),
  isHeadcount: zBool(),
  criticality: z.enum(CRITICALITY).default("MEDIUM"),
  workMode: z.enum(WORK_MODES).default("ONSITE"),
  vacancyReason: z.enum(VACANCY_REASONS).default("NEW"),
  skills: zOptional(1000),
  competencies: zOptional(1000),
  effectiveFrom: zRequiredDate(),
  effectiveTo: zDate(),
});

async function positionProblem(tenantId: string, d: z.infer<typeof positionSchema>, allowed: string[]): Promise<string | null> {
  const foreign = await foreignReference(tenantId, { department: d.departmentId, location: [d.locationId, ...allowed], costCenter: d.costCenterId, payGrade: d.payGradeId });
  if (foreign) return foreign;
  if (d.jobId && !(await prisma.jobProfile.findFirst({ where: { id: d.jobId, tenantId, status: { not: "RETIRED" } } }))) return "Job not found.";
  if (d.reportsToId) {
    if (d.reportsToId === d.id) return "A position cannot report to itself.";
    if (!(await prisma.position.findFirst({ where: { id: d.reportsToId, tenantId } }))) return "The position it reports to was not found.";
  }
  if (d.effectiveTo && d.effectiveTo < d.effectiveFrom) return "Effective-to must be after effective-from.";
  if (d.payGradeId && d.budgetedAnnualSalary !== null) {
    const g = await prisma.payGrade.findFirst({ where: { id: d.payGradeId, tenantId } });
    if (g && !withinRange(d.budgetedAnnualSalary, g.minAnnual === null ? null : Number(g.minAnnual), g.maxAnnual === null ? null : Number(g.maxAnnual))) {
      return `The budgeted salary is outside ${g.name}'s range (${g.minAnnual ?? "—"} – ${g.maxAnnual ?? "—"}).`;
    }
  }
  return null;
}

function positionData(d: z.infer<typeof positionSchema>, allowed: string[]) {
  return {
    title: d.title, jobId: d.jobId, departmentId: d.departmentId, locationId: d.locationId, costCenterId: d.costCenterId,
    payGradeId: d.payGradeId, reportsToId: d.reportsToId, budgetedAnnualSalary: d.budgetedAnnualSalary,
    budgetStatus: d.budgetStatus, fte: d.fte ?? 1, isHeadcount: d.isHeadcount, criticality: d.criticality, workMode: d.workMode,
    allowedLocationIds: allowed, skills: parseTags(d.skills), competencies: parseTags(d.competencies),
    effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo,
  };
}

/** Create (as a request to open the seat) or edit a position. */
export async function savePositionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const parsed = parseForm(positionSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const allowed = formList(formData, "allowedLocationIds");
  const bad = await positionProblem(viewer.tenantId, d, allowed);
  if (bad) return { ok: false, message: bad, values: Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)])) };
  const data = positionData(d, allowed);
  try {
    if (d.id) {
      const before = await prisma.position.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
      if (!before) return { ok: false, message: "Position not found." };
      if (before.status === "CLOSED" || before.status === "REJECTED") return { ok: false, message: "A closed or rejected position cannot be edited." };
      await prisma.position.update({ where: { id: d.id }, data });
      const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.join(",") : v === null || v === undefined ? "" : String(v));
      const changed = (Object.keys(data) as Array<keyof typeof data>).filter((k) => norm(before[k]) !== norm(data[k]));
      await writeAudit(viewer, {
        module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: d.id, summary: `Updated ${before.code}: ${changed.join(", ") || "no changes"}`,
        oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])), newValue: Object.fromEntries(changed.map((k) => [k, data[k]])),
      });
      return done(POS_PATHS.concat(`/positions/${d.id}`), `Saved ${before.code}.`);
    }
    const created = await prisma.$transaction(async (tx) => {
      const code = await nextPositionCode(viewer.tenantId, tx);
      const p = await tx.position.create({ data: { tenantId: viewer.tenantId, code, ...data, vacancyReason: d.vacancyReason, status: "PROPOSED", createdBy: viewer.user.id } });
      const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "POSITION_CREATE", entityType: "Position", entityId: p.id, label: `${code} ${d.title}`, by: viewer.user.id, reason: String(formData.get("justification") ?? "") || null }, tx);
      if (!res.ok) throw new Error(res.message);
      return p;
    });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Position", entityId: created.id, summary: `Requested position ${created.code} ${d.title}`, newValue: { ...data, effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10) } });
    const warn = await beyondPlanWarning(viewer.tenantId, d.departmentId, 1);
    return { ...done(POS_PATHS, `Requested ${created.code}; it opens once approved.${warn}`), values: { id: created.id } };
  } catch (err) {
    return toErrorState(err);
  }
}

/** Position cloning wizard: copy a position N times, each as its own open request. */
export async function clonePositionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const src = await prisma.position.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!src) return { ok: false, message: "Position not found." };
  const count = Math.trunc(Number(formData.get("count") ?? 1));
  if (!Number.isFinite(count) || count < 1 || count > 20) return { ok: false, message: "Clone between 1 and 20 copies.", errors: { count: "1–20" } };
  const title = String(formData.get("title") ?? "").trim() || src.title;
  const codes: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      const code = await nextPositionCode(viewer.tenantId, tx);
      const { id: _id, code: _c, status: _s, incumbentEmployeeId: _i, filledAt: _f, vacantSince: _v, frozenAt: _fa, frozenReason: _fr, requisitionId: _r, createdAt: _ca, updatedAt: _ua, ...rest } = src;
      const p = await tx.position.create({ data: { ...rest, code, title, status: "PROPOSED", vacancyReason: "NEW", createdBy: viewer.user.id } });
      const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind: "POSITION_CREATE", entityType: "Position", entityId: p.id, label: `${code} ${title}`, reason: `Cloned from ${src.code}`, by: viewer.user.id }, tx);
      if (!res.ok) throw new Error(res.message);
      codes.push(code);
    }
  }, { timeout: 30_000 });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Position", entityId: src.id, summary: `Cloned ${src.code} into ${codes.join(", ")}` });
  return done(POS_PATHS, `Created ${codes.length} position request(s): ${codes.join(", ")}.`);
}

/** Bulk update the selected positions: department, cost centre, grade, criticality, work mode or a budget change in %. */
export async function bulkUpdatePositionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const ids = formList(formData, "ids");
  if (ids.length === 0) return { ok: false, message: "Select at least one position." };
  const v = (k: string) => String(formData.get(k) ?? "").trim();
  const data: Record<string, unknown> = {};
  if (v("departmentId")) data.departmentId = v("departmentId");
  if (v("costCenterId")) data.costCenterId = v("costCenterId");
  if (v("payGradeId")) data.payGradeId = v("payGradeId");
  if (v("criticality")) { if (!(CRITICALITY as readonly string[]).includes(v("criticality"))) return { ok: false, message: "Unknown criticality." }; data.criticality = v("criticality"); }
  if (v("workMode")) { if (!(WORK_MODES as readonly string[]).includes(v("workMode"))) return { ok: false, message: "Unknown work mode." }; data.workMode = v("workMode"); }
  const pct = v("budgetChangePct") ? Number(v("budgetChangePct")) : null;
  if (pct !== null && (!Number.isFinite(pct) || pct < -50 || pct > 100)) return { ok: false, message: "Budget change must be between -50% and 100%." };
  if (Object.keys(data).length === 0 && pct === null) return { ok: false, message: "Choose something to change." };
  const foreign = await foreignReference(viewer.tenantId, { department: data.departmentId as string, costCenter: data.costCenterId as string, payGrade: data.payGradeId as string });
  if (foreign) return { ok: false, message: foreign };
  const rows = await prisma.position.findMany({ where: { id: { in: ids }, tenantId: viewer.tenantId, status: { notIn: ["CLOSED", "REJECTED"] } } });
  if (rows.length !== ids.length) return { ok: false, message: "Some selected positions were not found or are closed." };
  await prisma.$transaction(rows.map((p) => prisma.position.update({
    where: { id: p.id },
    data: { ...data, ...(pct !== null && p.budgetedAnnualSalary !== null ? { budgetedAnnualSalary: Math.round(Number(p.budgetedAnnualSalary) * (1 + pct / 100)) } : {}) },
  })));
  for (const p of rows) {
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: p.id, summary: `Bulk update of ${p.code}: ${[...Object.keys(data), pct !== null ? `budget ${pct > 0 ? "+" : ""}${pct}%` : ""].filter(Boolean).join(", ")}`, newValue: { ...data, budgetChangePct: pct } });
  }
  return done(POS_PATHS, `Updated ${rows.length} position(s).`);
}

/** Ask to freeze, unfreeze or close a position. */
export async function requestPositionChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const p = await prisma.position.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!p) return { ok: false, message: "Position not found." };
  const change = String(formData.get("change") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!reason) return { ok: false, message: "Give a reason.", errors: { reason: "Required" } };
  const kind = change === "freeze" ? "POSITION_FREEZE" : change === "unfreeze" ? "POSITION_UNFREEZE" : change === "close" ? "POSITION_CLOSE" : null;
  if (!kind) return { ok: false, message: "Unknown change." };
  if (kind === "POSITION_FREEZE" && p.status !== "VACANT") return { ok: false, message: "Only a vacant position can be frozen." };
  if (kind === "POSITION_UNFREEZE" && p.status !== "FROZEN") return { ok: false, message: "That position is not frozen." };
  if (kind === "POSITION_CLOSE" && !["VACANT", "FROZEN"].includes(p.status)) return { ok: false, message: "Only a vacant or frozen position can be closed." };
  const res = await submitWorkforceRequest({ tenantId: viewer.tenantId, kind, entityType: "Position", entityId: p.id, label: `${p.code} ${p.title}`, reason, by: viewer.user.id });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: p.id, summary: `Requested to ${change} ${p.code}: ${reason}` });
  return done(POS_PATHS.concat(`/positions/${p.id}`), "Sent for approval.");
}

/** Put an employee into a vacant seat. */
export async function fillPositionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const p = await prisma.position.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!p) return { ok: false, message: "Position not found." };
  if (p.status !== "VACANT") return { ok: false, message: "Only a vacant position can be filled." };
  const emp = await prisma.employee.findFirst({ where: { id: String(formData.get("employeeId") ?? ""), tenantId: viewer.tenantId, status: { not: "EXITED" } } });
  if (!emp) return { ok: false, message: "Choose a current employee.", errors: { employeeId: "Required" } };
  const elsewhere = await prisma.position.findFirst({ where: { tenantId: viewer.tenantId, incumbentEmployeeId: emp.id, status: "FILLED" } });
  if (elsewhere) return { ok: false, message: `${emp.displayName} already holds ${elsewhere.code}. Vacate it first.` };
  if (!locationAllowed(p.locationId, p.allowedLocationIds, emp.locationId, p.workMode)) return { ok: false, message: `${emp.displayName}'s location is not one this position may be filled from.` };
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(formData.get("startDate") ?? "")) ? new Date(`${formData.get("startDate")}T00:00:00Z`) : new Date();
  await prisma.$transaction([
    prisma.position.update({ where: { id: p.id }, data: { status: "FILLED", incumbentEmployeeId: emp.id, filledAt: start, vacantSince: null, vacancyReason: null } }),
    prisma.positionIncumbency.create({ data: { positionId: p.id, employeeId: emp.id, startDate: start } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: p.id, summary: `${emp.displayName} (${emp.employeeNumber}) now holds ${p.code}` });
  return done(POS_PATHS.concat(`/positions/${p.id}`), `${p.code} filled by ${emp.displayName}.`);
}

export async function vacatePositionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  const p = await prisma.position.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!p || p.status !== "FILLED") return { ok: false, message: "That position is not filled." };
  const reason = String(formData.get("vacancyReason") ?? "");
  if (!(VACANCY_REASONS as readonly string[]).includes(reason) || reason === "NEW") return { ok: false, message: "Choose why it is vacant.", errors: { vacancyReason: "Required" } };
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  await prisma.$transaction([
    prisma.position.update({ where: { id: p.id }, data: { status: "VACANT", incumbentEmployeeId: null, vacantSince: today, vacancyReason: reason } }),
    prisma.positionIncumbency.updateMany({ where: { positionId: p.id, endDate: null }, data: { endDate: today, endReason: reason } }),
  ]);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: p.id, summary: `${p.code} vacated (${reason.toLowerCase()})` });
  return done(POS_PATHS.concat(`/positions/${p.id}`), `${p.code} is vacant.`);
}

/** Raise a hiring requisition for a vacant position, prefilled from the seat. */
export async function raiseRequisitionForPositionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.POSITION_MANAGE);
  if (!can(viewer, P.REQUISITION_MANAGE)) return { ok: false, message: "Raising a requisition needs the requisition manage permission." };
  const p = await prisma.position.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { job: true } });
  if (!p) return { ok: false, message: "Position not found." };
  if (p.status !== "VACANT") return { ok: false, message: "Only a vacant position can be recruited for." };
  if (p.requisitionId && (await prisma.requisition.findFirst({ where: { id: p.requisitionId, tenantId: viewer.tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED", "ON_HOLD", "DRAFT"] } } }))) {
    return { ok: false, message: "This position already has an open requisition." };
  }
  if (!p.departmentId) return { ok: false, message: "Set the position's department first." };
  const salary = p.budgetedAnnualSalary === null ? null : Number(p.budgetedAnnualSalary);
  const res = await raiseRequisition(viewer.tenantId, {
    title: p.title, jobTitleId: p.job?.jobTitleId ?? null, isPriority: p.criticality === "CRITICAL", departmentId: p.departmentId,
    minExperienceYears: null, newHire: true, newPositions: 1, backfills: [], locationId: p.locationId,
    targetStartDate: null, currency: "INR", salaryMin: salary ? Math.round(salary * 0.9) : null, salaryMax: salary, salaryFrequency: salary ? "ANNUAL" : null,
    jobType: "FULL_TIME", employmentType: "PERMANENT",
    description: [p.job?.summary, p.job?.responsibilities].filter(Boolean).join("\n\n").slice(0, 20000),
    justification: `Position ${p.code}${p.vacancyReason ? ` (${p.vacancyReason.toLowerCase()})` : ""}`, hiringManagerId: null, recruiterId: null,
  }, viewer.user.id);
  if (!res.ok || !res.id) return { ok: false, message: res.message };
  await prisma.position.update({ where: { id: p.id }, data: { requisitionId: res.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "Requisition", entityId: res.id, summary: `Raised ${res.code} for position ${p.code}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Position", entityId: p.id, summary: `Requisition ${res.code} raised for ${p.code}` });
  const warn = await beyondPlanWarning(viewer.tenantId, p.departmentId);
  return done(POS_PATHS.concat(`/positions/${p.id}`, "/hiring/requisitions"), `Raised ${res.code}; it waits for requisition approval.${warn}`);
}
