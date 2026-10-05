import { prisma, type Prisma } from "@keka/db";
import { notify } from "./lifecycle";
import { getTimesheetPolicy, saveTimesheetPolicy } from "./timesheet-policy";
import {
  OPS_CONFIG_KINDS, opsParseField, opsConfigDiff, opsDescribeDiff, opsDay, opsYmd,
  type OpsConfigKindKey, type OpsWorkflowType,
} from "./ops-math";

/**
 * Ops depth — the shared core: per-tenant settings, requests that go through
 * the generic workflow engine (OpsApprovalRequest), alerts sent once, policy
 * versions, and configuration changes made through approval.
 */

type Result = { ok: boolean; message: string };
export type OpsActor = { tenantId: string; userId: string; label?: string };

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

export async function getOpsSettings(tenantId: string) {
  return prisma.opsSetting.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
}

export type OpsSettingsInput = Partial<Omit<Prisma.OpsSettingUncheckedCreateInput, "id" | "tenantId" | "updatedAt">>;

const SETTING_RULES: Array<[keyof OpsSettingsInput, number, number]> = [
  ["attendanceCutoffDay", 1, 31], ["cutoffAlertDaysBefore", 0, 15], ["deviceStaleMinutes", 5, 10_080], ["deviceOfflineMinutes", 10, 43_200],
  ["sourceMismatchMinutes", 1, 240], ["entryCommentMinLength", 0, 500], ["taskBudgetTolerancePct", 0, 200], ["projectVarianceAlertPct", 0, 500],
  ["netPayRoundTo", 1, 1000],
];

export async function saveOpsSettings(tenantId: string, input: OpsSettingsInput): Promise<Result> {
  for (const [k, min, max] of SETTING_RULES) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return { ok: false, message: `${String(k)} must be between ${min} and ${max}.` };
  }
  if (input.deviceStaleMinutes !== undefined && input.deviceOfflineMinutes !== undefined && Number(input.deviceStaleMinutes) >= Number(input.deviceOfflineMinutes)) return { ok: false, message: "A device goes stale before it goes offline." };
  if (input.taskBudgetMode !== undefined && !["OFF", "WARN", "BLOCK"].includes(String(input.taskBudgetMode))) return { ok: false, message: "Choose how task budgets are enforced." };
  if (input.netPayRoundingMode !== undefined && !["NEAREST", "UP", "DOWN"].includes(String(input.netPayRoundingMode))) return { ok: false, message: "Choose a rounding direction." };
  if (input.negativeNetPayAction !== undefined && !["WARN", "BLOCK"].includes(String(input.negativeNetPayAction))) return { ok: false, message: "Choose what a negative net pay does." };
  if (input.leaveCalendarVisibility !== undefined && !["TEAM", "DEPARTMENT", "ORGANISATION", "MANAGERS"].includes(String(input.leaveCalendarVisibility))) return { ok: false, message: "Choose who sees leave on the calendar." };
  if (input.approvalKinds !== undefined && (input.approvalKinds as string[]).some((k) => !(k in OPS_CONFIG_KINDS))) return { ok: false, message: "Unknown configuration kind." };
  if (input.contractAlertDays !== undefined && (input.contractAlertDays as number[]).some((d) => !Number.isInteger(d) || d < 0 || d > 365)) return { ok: false, message: "Contract alerts are whole days from 0 to 365." };
  await prisma.opsSetting.upsert({ where: { tenantId }, create: { tenantId, ...input } as Prisma.OpsSettingUncheckedCreateInput, update: input as Prisma.OpsSettingUncheckedUpdateInput });
  return { ok: true, message: "Settings saved." };
}

// ---------------------------------------------------------------------------
//  Audit and alerts
// ---------------------------------------------------------------------------

export async function opsAudit(tenantId: string, actorUserId: string | null, e: { module: "ATTENDANCE" | "LEAVE" | "PAYROLL" | "PROJECTS" | "EMPLOYEE" | "LIFECYCLE"; action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" | "LOCK" | "UNLOCK" | "EXPORT"; entityType: string; entityId?: string | null; summary: string; oldValue?: unknown; newValue?: unknown }): Promise<void> {
  const actor = actorUserId ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { email: true } }) : null;
  await prisma.auditLog.create({
    data: {
      tenantId, module: e.module, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null, summary: e.summary.slice(0, 1000),
      oldValue: e.oldValue === undefined ? undefined : (e.oldValue as Prisma.InputJsonValue), newValue: e.newValue === undefined ? undefined : (e.newValue as Prisma.InputJsonValue),
      actorId: actor ? actorUserId : null, actorLabel: actor?.email ?? (actorUserId ? null : "system"),
    },
  });
}

/** Send an alert once per dedupe key; returns whether it went out. */
export async function opsAlertOnce(tenantId: string, kind: string, dedupeKey: string, alert: { userIds: string[]; title: string; body?: string; link?: string; email?: boolean }): Promise<boolean> {
  const users = [...new Set(alert.userIds.filter(Boolean))];
  if (!users.length) return false;
  try {
    await prisma.opsAlertLog.create({ data: { tenantId, kind, dedupeKey, userIds: users, title: alert.title.slice(0, 300) } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false;
    throw err;
  }
  await notify({ tenantId, userIds: users, kind: "OPS", title: alert.title, body: alert.body, link: alert.link, email: alert.email });
  return true;
}

// ---------------------------------------------------------------------------
//  Requests through the generic workflow engine
// ---------------------------------------------------------------------------

export interface OpsRequestInput {
  tenantId: string;
  entityType: OpsWorkflowType;
  targetId?: string | null;
  targetLabel: string;
  employeeId?: string | null;
  payload?: Record<string, unknown> | null;
  previous?: Record<string, unknown> | null;
  effectiveFrom?: Date | null;
  reason?: string | null;
  requestedBy: string;
  title: string;
  details?: string | null;
  link: string;
  amount?: number | null;
  changeKind?: string | null;
  reviewerUserId?: string | null;
}

/** Raise a request and start its workflow. A request the route approves outright is applied at once. */
export async function opsRequestApproval(input: OpsRequestInput): Promise<Result & { id?: string; status?: string }> {
  const open = input.targetId ? await prisma.opsApprovalRequest.findFirst({ where: { tenantId: input.tenantId, kind: input.entityType, targetId: input.targetId, status: "PENDING" } }) : null;
  if (open) return { ok: false, message: "A request for this is already waiting for approval." };
  const a = await prisma.opsApprovalRequest.create({
    data: {
      tenantId: input.tenantId, kind: input.entityType, targetId: input.targetId ?? null, targetLabel: input.targetLabel.slice(0, 300), employeeId: input.employeeId ?? null,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined, previous: (input.previous ?? undefined) as Prisma.InputJsonValue | undefined,
      effectiveFrom: input.effectiveFrom ?? null, reason: input.reason ?? null, requestedBy: input.requestedBy,
    },
  });
  const { startWorkflow } = await import("./workflow-engine");
  const res = await startWorkflow({
    tenantId: input.tenantId, entityType: input.entityType as never, entityId: a.id, title: input.title, details: input.details ?? input.reason ?? null,
    amount: input.amount ?? null, category: input.changeKind ?? null, data: { link: input.link, kind: input.entityType },
    requesterUserId: input.requestedBy, subjectEmployeeId: input.employeeId ?? null, changeKind: input.changeKind ?? null, reviewerUserId: input.reviewerUserId ?? null,
  });
  if (!res.ok) {
    await prisma.opsApprovalRequest.delete({ where: { id: a.id } });
    return { ok: false, message: res.message };
  }
  const after = await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { workflowRequestId: res.requestId ?? null } });
  return { ok: true, id: a.id, status: after.status, message: after.status === "PENDING" ? "Sent for approval." : after.status === "APPLIED" ? "Approved and applied." : res.message };
}

/** Requests a person can see the state of: their own, or a target's history. */
export function opsRequestsFor(tenantId: string, where: Prisma.OpsApprovalRequestWhereInput = {}, take = 100) {
  return prisma.opsApprovalRequest.findMany({ where: { ...where, tenantId }, orderBy: { createdAt: "desc" }, take });
}

// ---------------------------------------------------------------------------
//  Policy versions
// ---------------------------------------------------------------------------

export async function recordOpsPolicyVersion(input: { tenantId: string; kind: string; targetId: string; snapshot: Record<string, unknown>; effectiveFrom?: Date | null; summary: string; approvalId?: string | null; createdBy?: string | null }): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await prisma.opsPolicyVersion.findFirst({ where: { kind: input.kind, targetId: input.targetId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    try {
      await prisma.opsPolicyVersion.create({
        data: {
          tenantId: input.tenantId, kind: input.kind, targetId: input.targetId, version, snapshot: input.snapshot as Prisma.InputJsonValue,
          effectiveFrom: opsDay(input.effectiveFrom ?? new Date()), summary: input.summary.slice(0, 1000), approvalId: input.approvalId ?? null, createdBy: input.createdBy ?? null,
        },
      });
      return version;
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  throw new Error("Could not number the policy version.");
}

// ---------------------------------------------------------------------------
//  Configuration targets and their current values
// ---------------------------------------------------------------------------

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => {
  const v = row[k];
  return [k, v === null || v === undefined ? null : typeof v === "object" && !(v instanceof Date) ? Number(String(v)) : v];
}));

/** Everything of a kind the tenant has, as options. */
export async function opsConfigTargets(tenantId: string, kind: OpsConfigKindKey): Promise<Array<{ value: string; label: string }>> {
  switch (kind) {
    case "ATTENDANCE_POLICY": return (await prisma.attendancePolicy.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } })).map((x) => ({ value: x.id, label: x.name }));
    case "WORK_HOUR_POLICY": return [{ value: tenantId, label: "Company timesheet policy" }];
    case "LEAVE_TYPE": return (await prisma.leaveType.findMany({ where: { tenantId }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } })).map((x) => ({ value: x.id, label: `${x.name} (${x.code})` }));
    case "LEAVE_POLICY": return (await prisma.leavePlan.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } })).map((x) => ({ value: x.id, label: x.name }));
    case "SALARY_STRUCTURE": return (await prisma.salaryStructure.findMany({ where: { payGroup: { tenantId } }, select: { id: true, name: true, payGroup: { select: { name: true } } }, orderBy: { name: "asc" } })).map((x) => ({ value: x.id, label: `${x.name} · ${x.payGroup.name}` }));
    case "PAY_CYCLE": return (await prisma.payGroup.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } })).map((x) => ({ value: x.id, label: x.name }));
    case "PAY_COMPONENT": return (await prisma.salaryComponent.findMany({ where: { tenantId }, select: { id: true, name: true, code: true }, orderBy: { displayOrder: "asc" } })).map((x) => ({ value: x.id, label: `${x.name} (${x.code})` }));
  }
}

/** The current values of a target's governed fields, or null when it is not the tenant's. */
export async function opsConfigCurrent(tenantId: string, kind: OpsConfigKindKey, targetId: string): Promise<{ label: string; values: Record<string, unknown> } | null> {
  const keys = OPS_CONFIG_KINDS[kind].fields.map((f) => f.key);
  switch (kind) {
    case "ATTENDANCE_POLICY": { const r = await prisma.attendancePolicy.findFirst({ where: { id: targetId, tenantId } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
    case "WORK_HOUR_POLICY": {
      if (targetId !== tenantId) return null;
      const p = await getTimesheetPolicy(tenantId);
      return { label: "Company timesheet policy", values: { ...pick(p as unknown as Record<string, unknown>, keys), minHoursPerDay: p.minHoursPerDay ?? 0, minHoursPerWeek: p.minHoursPerWeek ?? 0, maxHoursPerWeek: p.maxHoursPerWeek ?? 0 } };
    }
    case "LEAVE_TYPE": { const r = await prisma.leaveType.findFirst({ where: { id: targetId, tenantId } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
    case "LEAVE_POLICY": { const r = await prisma.leavePlan.findFirst({ where: { id: targetId, tenantId } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
    case "SALARY_STRUCTURE": { const r = await prisma.salaryStructure.findFirst({ where: { id: targetId, payGroup: { tenantId } } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
    case "PAY_CYCLE": { const r = await prisma.payGroup.findFirst({ where: { id: targetId, tenantId } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
    case "PAY_COMPONENT": { const r = await prisma.salaryComponent.findFirst({ where: { id: targetId, tenantId } }); return r ? { label: r.name, values: pick(r, keys) } : null; }
  }
}

async function writeConfig(tenantId: string, kind: OpsConfigKindKey, targetId: string, values: Record<string, unknown>): Promise<void> {
  const data = values as never;
  let n = 1;
  switch (kind) {
    case "ATTENDANCE_POLICY": n = (await prisma.attendancePolicy.updateMany({ where: { id: targetId, tenantId }, data })).count; break;
    case "WORK_HOUR_POLICY": {
      const cur = await getTimesheetPolicy(tenantId);
      const v = values as Record<string, number | boolean | null>;
      const zeroNull = (k: string, fallback: number | null) => (k in v ? (Number(v[k]) > 0 ? Number(v[k]) : null) : fallback);
      const res = await saveTimesheetPolicy(tenantId, {
        ...cur, ...(v as object),
        minHoursPerDay: zeroNull("minHoursPerDay", cur.minHoursPerDay), minHoursPerWeek: zeroNull("minHoursPerWeek", cur.minHoursPerWeek), maxHoursPerWeek: zeroNull("maxHoursPerWeek", cur.maxHoursPerWeek),
      });
      if (!res.ok) throw new Error(res.message);
      break;
    }
    case "LEAVE_TYPE": n = (await prisma.leaveType.updateMany({ where: { id: targetId, tenantId }, data })).count; break;
    case "LEAVE_POLICY": n = (await prisma.leavePlan.updateMany({ where: { id: targetId, tenantId }, data })).count; break;
    case "SALARY_STRUCTURE": n = (await prisma.salaryStructure.updateMany({ where: { id: targetId, payGroup: { tenantId } }, data })).count; break;
    case "PAY_CYCLE": n = (await prisma.payGroup.updateMany({ where: { id: targetId, tenantId }, data })).count; break;
    case "PAY_COMPONENT": n = (await prisma.salaryComponent.updateMany({ where: { id: targetId, tenantId }, data })).count; break;
  }
  if (n === 0) throw new Error("The record no longer exists.");
}

/** Does this kind of change need approval here? The message to show when a direct save is refused. */
export async function opsChangeGate(tenantId: string, kind: OpsConfigKindKey): Promise<string | null> {
  const s = await prisma.opsSetting.findUnique({ where: { tenantId }, select: { approvalKinds: true } });
  return s?.approvalKinds.includes(kind) ? `Changes to ${OPS_CONFIG_KINDS[kind].label.toLowerCase()} need approval here. Propose the change under Time Attend › Controls › Change approvals.` : null;
}

/** Snapshot a target's governed fields as a new policy version (used by direct saves too). */
export async function snapshotOpsPolicy(tenantId: string, kind: OpsConfigKindKey, targetId: string, summary: string, createdBy: string | null, approvalId: string | null = null, effectiveFrom: Date | null = null): Promise<number | null> {
  const cur = await opsConfigCurrent(tenantId, kind, targetId);
  if (!cur) return null;
  return recordOpsPolicyVersion({ tenantId, kind, targetId, snapshot: cur.values, summary, effectiveFrom, approvalId, createdBy });
}

/**
 * Propose a change to a policy or setting. Where the tenant governs the kind,
 * it goes to a second administrator; otherwise it is applied (or scheduled
 * for its effective date) straight away. Either way it is versioned.
 */
export async function proposeConfigChange(input: { tenantId: string; kind: OpsConfigKindKey; targetId: string; values: Record<string, string>; effectiveFrom?: Date | null; reason?: string | null; userId: string }): Promise<Result & { id?: string; status?: string }> {
  const spec = OPS_CONFIG_KINDS[input.kind];
  const cur = await opsConfigCurrent(input.tenantId, input.kind, input.targetId);
  if (!cur) return { ok: false, message: `${spec.label} not found.` };
  const proposed: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (!(f.key in input.values)) continue;
    const p = opsParseField(f, input.values[f.key]);
    if ("error" in p) return { ok: false, message: p.error };
    proposed[f.key] = p.value;
  }
  const diff = opsConfigDiff(spec.fields, cur.values, proposed);
  if (!diff.length) return { ok: false, message: "Nothing changes." };
  const changes = Object.fromEntries(diff.map((d) => [d.key, d.to]));
  const previous = Object.fromEntries(diff.map((d) => [d.key, d.from]));
  if (input.kind === "ATTENDANCE_POLICY") {
    const full = Number(changes.fullDayThresholdPct ?? cur.values.fullDayThresholdPct), half = Number(changes.halfDayThresholdPct ?? cur.values.halfDayThresholdPct);
    if (half >= full) return { ok: false, message: "The half-day threshold must be below the full-day threshold." };
  }
  const summary = opsDescribeDiff(diff);
  const effectiveFrom = input.effectiveFrom ? opsDay(input.effectiveFrom) : null;
  const gated = await opsChangeGate(input.tenantId, input.kind);
  if (gated) {
    return opsRequestApproval({
      tenantId: input.tenantId, entityType: "OPS_CONFIG_CHANGE", targetId: input.targetId, targetLabel: `${spec.label}: ${cur.label}`,
      payload: { configKind: input.kind, changes, summary }, previous, effectiveFrom, reason: input.reason, requestedBy: input.userId,
      title: `Change ${spec.label.toLowerCase()} "${cur.label}"`, details: `${summary}${input.reason ? ` — ${input.reason}` : ""}`, link: "/time/controls?tab=changes", changeKind: input.kind,
    });
  }
  const a = await prisma.opsApprovalRequest.create({
    data: {
      tenantId: input.tenantId, kind: "OPS_CONFIG_CHANGE", targetId: input.targetId, targetLabel: `${spec.label}: ${cur.label}`,
      payload: { configKind: input.kind, changes, summary } as Prisma.InputJsonValue, previous: previous as Prisma.InputJsonValue,
      effectiveFrom, reason: input.reason ?? null, requestedBy: input.userId, status: "PENDING",
    },
  });
  const res = await applyConfigChange(a.id, input.userId);
  return { ok: true, id: a.id, status: res, message: res === "SCHEDULED" ? `Scheduled for ${opsYmd(effectiveFrom)}.` : "Changed." };
}

/** Apply an approved (or ungoverned) change, or leave it scheduled until its date. */
export async function applyConfigChange(approvalId: string, actorUserId: string | null, now = new Date()): Promise<"APPLIED" | "SCHEDULED"> {
  const a = await prisma.opsApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  const p = (a.payload ?? {}) as { configKind?: string; changes?: Record<string, unknown>; summary?: string };
  const kind = p.configKind as OpsConfigKindKey;
  if (!kind || !(kind in OPS_CONFIG_KINDS) || !a.targetId) throw new Error("The change is incomplete.");
  if (a.effectiveFrom && a.effectiveFrom.getTime() > opsDay(now).getTime()) {
    await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { status: "SCHEDULED", decidedAt: a.decidedAt ?? new Date() } });
    return "SCHEDULED";
  }
  await writeConfig(a.tenantId, kind, a.targetId, p.changes ?? {});
  const version = await snapshotOpsPolicy(a.tenantId, kind, a.targetId, p.summary ?? "Changed", a.requestedBy, a.id, a.effectiveFrom);
  await prisma.opsApprovalRequest.update({ where: { id: a.id }, data: { status: "APPLIED", appliedAt: new Date(), decidedAt: a.decidedAt ?? new Date(), error: null } });
  await opsAudit(a.tenantId, actorUserId, {
    module: OPS_CONFIG_KINDS[kind].area === "PAYROLL" ? "PAYROLL" : OPS_CONFIG_KINDS[kind].area === "LEAVE" ? "LEAVE" : OPS_CONFIG_KINDS[kind].area === "TIME" ? "PROJECTS" : "ATTENDANCE",
    action: "UPDATE", entityType: kind, entityId: a.targetId, summary: `${a.targetLabel} changed (v${version ?? "?"}): ${p.summary ?? ""}`, oldValue: a.previous, newValue: p.changes,
  });
  return "APPLIED";
}

/** Nightly: apply approved changes whose effective date has come. */
export async function applyDueConfigChanges(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.opsApprovalRequest.findMany({ where: { tenantId, kind: "OPS_CONFIG_CHANGE", status: "SCHEDULED", effectiveFrom: { lte: now } }, select: { id: true } });
  let n = 0;
  for (const d of due) {
    try { if ((await applyConfigChange(d.id, null, now)) === "APPLIED") n++; } catch (err) {
      await prisma.opsApprovalRequest.update({ where: { id: d.id }, data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : String(err) } });
    }
  }
  return n;
}

/** Policy report rows: each target's governed values, version count and last change. */
export async function opsPolicyReport(tenantId: string, kind: OpsConfigKindKey) {
  const targets = await opsConfigTargets(tenantId, kind);
  const versions = await prisma.opsPolicyVersion.groupBy({ by: ["targetId"], where: { tenantId, kind }, _count: true, _max: { createdAt: true } });
  const vmap = new Map(versions.map((v) => [v.targetId, v]));
  const rows = [];
  for (const t of targets) {
    const cur = await opsConfigCurrent(tenantId, kind, t.value);
    if (!cur) continue;
    rows.push({ id: t.value, label: t.label, values: cur.values, versions: vmap.get(t.value)?._count ?? 0, lastChanged: vmap.get(t.value)?._max.createdAt ?? null });
  }
  return { fields: OPS_CONFIG_KINDS[kind].fields, rows };
}
