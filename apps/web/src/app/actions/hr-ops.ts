"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  planMassUpdate, requestJobChange, parseChecklistItems, checklistProgress, cleanDirectoryQuery, notify,
  MASS_UPDATE_KINDS, MASS_STATUSES, type MassUpdateKind,
} from "@keka/services";
import { requireAuth, requireViewer, type Viewer } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { isHrFor, isManagerOf, massUpdateCandidates, massValueLabel, massCurrentOf as currentOf } from "@/lib/core-hr";
import { z, parseForm, formList, writeAudit, actionDone as done, zName, zOptional, zId, zDate, zBool, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;

/**
 * HR operations: mass updates (with a preview, a per-person trail and
 * rollback), HR checklists signed off by a second person, and the
 * directory's saved searches.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

// ---------------------------------------------------------------------------
//  Mass update
// ---------------------------------------------------------------------------

const massSchema = z.object({
  kind: z.enum(Object.keys(MASS_UPDATE_KINDS) as [MassUpdateKind, ...MassUpdateKind[]]), value: zId(), effectiveFrom: zDate(), note: zOptional(300),
  departmentId: z.string().optional(), locationId: z.string().optional(), status: z.string().optional(), numbers: z.string().optional(),
});

/**
 * Apply a mass update. Status changes are written directly (and can be
 * rolled back); job changes — manager, location, department, employment
 * type — go through the same job-change path as a single edit, so they keep
 * their approval chain and job history.
 */
export async function applyMassUpdateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(massSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const label = await massValueLabel(viewer.tenantId, d.kind, d.value);
  if (!label) return { ok: false, message: "Choose a value from this company.", errors: { value: "Not found" } };
  const people = await massUpdateCandidates(viewer, { employeeIds: formList(formData, "employeeId"), departmentId: d.departmentId, locationId: d.locationId, status: d.status, numbers: d.numbers });
  if (people.length === 0) return { ok: false, message: "No one in your scope matches the selection." };
  if (formData.get("confirm") !== "on") return { ok: false, message: "Tick the confirmation to apply it." };
  const plan = planMassUpdate(d.kind, d.value, people.map((p) => ({ id: p.id, label: `${p.displayName ?? p.firstName} (${p.employeeNumber})`, status: p.status, current: currentOf(d.kind, p) })));
  const batch = await prisma.massUpdateBatch.create({
    data: { tenantId: viewer.tenantId, kind: d.kind, value: d.value, valueLabel: label, effectiveFrom: d.effectiveFrom, note: d.note, total: plan.length, createdBy: viewer.user.id },
  });
  const effectiveFrom = d.effectiveFrom ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  let applied = 0, pending = 0, skipped = 0;
  for (const row of plan) {
    if (row.action === "SKIP") {
      skipped++;
      await prisma.massUpdateItem.create({ data: { batchId: batch.id, employeeId: row.employeeId, before: row.current, after: d.value, status: "SKIPPED", message: row.reason } });
      continue;
    }
    if (d.kind === "STATUS") {
      await prisma.employee.update({ where: { id: row.employeeId }, data: { status: d.value as never, ...(d.value === "CONFIRMED" ? { confirmationDate: effectiveFrom } : {}) } });
      await prisma.massUpdateItem.create({ data: { batchId: batch.id, employeeId: row.employeeId, before: row.current, after: d.value, status: "APPLIED" } });
      applied++;
      continue;
    }
    const field = { MANAGER: "reportingManagerId", LOCATION: "locationId", DEPARTMENT: "departmentId", WORKER_TYPE: "workerTypeId" }[d.kind];
    const reason = { MANAGER: "MANAGER_CHANGE", LOCATION: "LOCATION_CHANGE", DEPARTMENT: "DEPARTMENT_CHANGE", WORKER_TYPE: "WORKER_TYPE_CHANGE" }[d.kind] as "MANAGER_CHANGE";
    try {
      const res = await requestJobChange({
        tenantId: viewer.tenantId, employeeId: row.employeeId, requestedBy: viewer.user.id, source: "IMPORT", holdUntilEffective: true,
        fields: { effectiveFrom, reason, [field]: d.value, note: d.note ?? `Mass update: ${MASS_UPDATE_KINDS[d.kind]} → ${label}` },
        summary: `${MASS_UPDATE_KINDS[d.kind]} → ${label} for ${row.label} (mass update)`,
      });
      const status = res.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "APPLIED";
      await prisma.massUpdateItem.create({ data: { batchId: batch.id, employeeId: row.employeeId, before: row.current, after: d.value, status, jobChangeId: res.jobChangeId, message: res.status === "SCHEDULED" ? `Scheduled for ${iso(effectiveFrom)}` : null } });
      status === "APPLIED" ? applied++ : pending++;
    } catch (err) {
      skipped++;
      await prisma.massUpdateItem.create({ data: { batchId: batch.id, employeeId: row.employeeId, before: row.current, after: d.value, status: "SKIPPED", message: (err instanceof Error ? err.message : String(err)).slice(0, 200) } });
    }
  }
  await prisma.massUpdateBatch.update({ where: { id: batch.id }, data: { applied, pending, skipped } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "MassUpdateBatch", entityId: batch.id, summary: `Mass update: ${MASS_UPDATE_KINDS[d.kind]} → ${label} for ${applied} applied, ${pending} awaiting approval, ${skipped} skipped` });
  return done(["/hr-ops", "/employees", "/directory"], `${MASS_UPDATE_KINDS[d.kind]} → ${label}: ${applied} applied${pending ? `, ${pending} awaiting approval` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
}

/**
 * Roll a status mass update back: everyone it changed goes back to what they
 * were, unless their status has been changed again since.
 */
export async function rollbackMassUpdateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const batch = await prisma.massUpdateBatch.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { items: true } });
  if (!batch) return { ok: false, message: "Mass update not found." };
  if (batch.status === "ROLLED_BACK") return { ok: false, message: "Already rolled back." };
  let restored = 0, kept = 0;
  for (const item of batch.items.filter((i) => i.status === "APPLIED")) {
    const emp = await prisma.employee.findFirst({ where: { id: item.employeeId, tenantId: viewer.tenantId } });
    if (!emp) continue;
    if (batch.kind === "STATUS") {
      if (emp.status !== item.after || !item.before) { kept++; continue; }
      await prisma.employee.update({ where: { id: emp.id }, data: { status: item.before as never } });
    } else {
      const field = { MANAGER: "reportingManagerId", LOCATION: "locationId", DEPARTMENT: "departmentId", WORKER_TYPE: "workerTypeId" }[batch.kind as Exclude<MassUpdateKind, "STATUS">];
      if ((emp as Record<string, unknown>)[field] !== item.after || !item.before) { kept++; continue; }
      await requestJobChange({
        tenantId: viewer.tenantId, employeeId: emp.id, requestedBy: viewer.user.id, source: "IMPORT",
        fields: { effectiveFrom: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())), reason: ({ MANAGER: "MANAGER_CHANGE", LOCATION: "LOCATION_CHANGE", DEPARTMENT: "DEPARTMENT_CHANGE", WORKER_TYPE: "WORKER_TYPE_CHANGE" } as const)[batch.kind as "MANAGER"], [field]: item.before, note: "Mass update rolled back" },
        summary: `Roll back mass update for ${emp.displayName}`,
      });
    }
    await prisma.massUpdateItem.update({ where: { id: item.id }, data: { status: "ROLLED_BACK" } });
    restored++;
  }
  await prisma.massUpdateBatch.update({ where: { id: batch.id }, data: { status: "ROLLED_BACK", rolledBackAt: new Date(), rolledBackBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "MassUpdateBatch", entityId: batch.id, summary: `Rolled back a mass update: ${restored} restored, ${kept} changed since and kept` });
  return done(["/hr-ops", "/employees"], `Rolled back: ${restored} restored${kept ? `, ${kept} left as they are (changed since)` : ""}.`);
}

// ---------------------------------------------------------------------------
//  HR checklists
// ---------------------------------------------------------------------------

const templateSchema = z.object({ id: z.string().optional(), name: zName(120), category: z.enum(["GENERAL", "JOINING", "COMPLIANCE", "TRANSFER", "RETURN_FROM_LEAVE", "EXIT"]).default("GENERAL"), description: zOptional(400), items: z.string().min(1, "Add at least one item"), requiresSignOff: zBool() });

export async function saveChecklistTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(templateSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, items: raw, ...d } = parsed.data;
  const items = parseChecklistItems(raw);
  if (items.length === 0) return { ok: false, message: "Add at least one item, one per line.", errors: { items: "Required" } };
  const clash = await prisma.hrChecklistTemplate.findFirst({ where: { tenantId: viewer.tenantId, name: d.name, ...(id ? { NOT: { id } } : {}) } });
  if (clash) return { ok: false, message: "Another checklist has that name.", errors: { name: "Already used" } };
  if (id) {
    const u = await prisma.hrChecklistTemplate.updateMany({ where: { id, tenantId: viewer.tenantId }, data: { ...d, items } });
    if (!u.count) return { ok: false, message: "Checklist not found." };
  }
  const row = id ? { id } : await prisma.hrChecklistTemplate.create({ data: { tenantId: viewer.tenantId, ...d, items } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "HrChecklistTemplate", entityId: row.id, summary: `${id ? "Updated" : "Created"} HR checklist ${d.name} (${items.length} items)` });
  return done(["/hr-ops"], `${id ? "Saved" : "Created"} ${d.name}.`);
}

export async function assignChecklistAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const tpl = await prisma.hrChecklistTemplate.findFirst({ where: { id: String(formData.get("templateId") ?? ""), tenantId: viewer.tenantId, isActive: true } });
  if (!tpl) return { ok: false, message: "Choose a checklist.", errors: { templateId: "Required" } };
  const ids = [...new Set(formList(formData, "employeeId"))];
  if (ids.length === 0) return { ok: false, message: "Choose who it is for.", errors: { employeeId: "Required" } };
  const emps = await prisma.employee.findMany({ where: { AND: [scopedEmployeeWhere(viewer, P.EMPLOYEE_UPDATE), { id: { in: ids } }] }, select: { id: true, displayName: true, userId: true } });
  if (emps.length !== ids.length) return { ok: false, message: "Someone chosen is outside the people you look after." };
  const due = String(formData.get("dueDate") ?? "");
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T00:00:00Z`) : null;
  const items = (tpl.items as Array<{ title: string; owner: string }>) ?? [];
  for (const e of emps) {
    await prisma.hrChecklist.create({
      data: {
        tenantId: viewer.tenantId, templateId: tpl.id, employeeId: e.id, title: `${tpl.name} — ${e.displayName}`, dueDate, assignedBy: viewer.user.id,
        status: "OPEN", items: { create: items.map((it, i) => ({ position: i, title: it.title, owner: it.owner })) },
      },
    });
  }
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "HrChecklist", entityId: tpl.id, summary: `Assigned ${tpl.name} to ${emps.length} employee(s)` });
  return done(["/hr-ops"], `Assigned ${tpl.name} to ${emps.length} employee(s).`);
}

/** Tick or untick one item. HR items: HR; manager items: the manager or HR; employee items: the employee or HR. */
export async function toggleChecklistItemAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const item = await prisma.hrChecklistItem.findFirst({ where: { id: String(formData.get("id") ?? ""), checklist: { tenantId: viewer.tenantId } }, include: { checklist: true } });
  if (!item) return { ok: false, message: "Item not found." };
  if (item.checklist.status === "SIGNED_OFF") return { ok: false, message: "This checklist is signed off." };
  const empId = item.checklist.employeeId;
  const hr = await isHrFor(viewer, empId);
  const allowed = hr || (item.owner === "MANAGER" && await isManagerOf(viewer, empId)) || (item.owner === "EMPLOYEE" && viewer.employee?.id === empId);
  if (!allowed) return { ok: false, message: `This item is for ${item.owner === "HR" ? "HR" : item.owner === "MANAGER" ? "the manager" : "the employee"}.` };
  const done_ = !item.done;
  await prisma.hrChecklistItem.update({ where: { id: item.id }, data: { done: done_, doneBy: done_ ? viewer.user.id : null, doneAt: done_ ? new Date() : null, note: String(formData.get("note") ?? "").trim().slice(0, 200) || item.note } });
  const items = await prisma.hrChecklistItem.findMany({ where: { checklistId: item.checklistId } });
  const prog = checklistProgress(items);
  const tpl = await prisma.hrChecklistTemplate.findUnique({ where: { id: item.checklist.templateId }, select: { requiresSignOff: true } });
  const next = prog.complete ? (tpl?.requiresSignOff ? "AWAITING_SIGN_OFF" : "SIGNED_OFF") : item.checklist.status === "AWAITING_SIGN_OFF" ? "OPEN" : item.checklist.status;
  if (next !== item.checklist.status) {
    await prisma.hrChecklist.update({ where: { id: item.checklistId }, data: { status: next, ...(next === "SIGNED_OFF" ? { signedOffAt: new Date() } : {}) } });
    if (next === "AWAITING_SIGN_OFF") await notify({ tenantId: viewer.tenantId, userIds: [item.checklist.assignedBy], kind: "APPROVAL", title: `Sign off: ${item.checklist.title}`, link: "/hr-ops?tab=checklists" });
  }
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "HrChecklistItem", entityId: item.id, summary: `${done_ ? "Completed" : "Reopened"} “${item.title}” on ${item.checklist.title} (${prog.done}/${prog.total})` });
  return done(["/hr-ops", "/me/requests"], prog.complete ? "All done — waiting for sign-off." : `${prog.done} of ${prog.total} done.`);
}

/** HR signs off (or sends back) a completed checklist — never the person who assigned it. */
export async function signOffChecklistAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const c = await prisma.hrChecklist.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!c) return { ok: false, message: "Checklist not found." };
  if (c.status !== "AWAITING_SIGN_OFF") return { ok: false, message: "It is not waiting for sign-off." };
  if (c.assignedBy === viewer.user.id) return { ok: false, message: "Someone other than whoever assigned it must sign it off." };
  if (!(await isHrFor(viewer, c.employeeId))) return { ok: false, message: "This employee is outside the people you look after." };
  const approve = String(formData.get("decision")) === "approve";
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!approve && !note) return { ok: false, message: "Say what still needs doing.", errors: { note: "Required" } };
  await prisma.hrChecklist.update({ where: { id: c.id }, data: approve ? { status: "SIGNED_OFF", signedOffBy: viewer.user.id, signedOffAt: new Date(), signOffNote: note } : { status: "REOPENED", signOffNote: note } });
  if (!approve) await prisma.hrChecklistItem.updateMany({ where: { checklistId: c.id, owner: "HR" }, data: { done: false } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: approve ? "APPROVE" : "REJECT", entityType: "HrChecklist", entityId: c.id, summary: `${approve ? "Signed off" : "Sent back"} ${c.title}${note ? ` — ${note}` : ""}` });
  return done(["/hr-ops"], approve ? "Signed off." : "Sent back.");
}

// ---------------------------------------------------------------------------
//  Directory saved searches
// ---------------------------------------------------------------------------

export async function saveDirectorySearchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const name = String(formData.get("name") ?? "").trim().slice(0, 60);
  const query = cleanDirectoryQuery(String(formData.get("query") ?? ""));
  if (name.length < 2) return { ok: false, message: "Name the search.", errors: { name: "Required" } };
  if (!query) return { ok: false, message: "Search or pick a filter first." };
  const count = await prisma.directorySavedSearch.count({ where: { tenantId: viewer.tenantId, userId: viewer.user.id } });
  if (count >= 20) return { ok: false, message: "You can keep up to 20 saved searches." };
  await prisma.directorySavedSearch.upsert({
    where: { userId_name: { userId: viewer.user.id, name } },
    create: { tenantId: viewer.tenantId, userId: viewer.user.id, name, query },
    update: { query },
  });
  return done(["/directory"], `Saved “${name}”.`);
}

export async function deleteDirectorySearchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const d = await prisma.directorySavedSearch.deleteMany({ where: { id: String(formData.get("id") ?? ""), userId: viewer.user.id, tenantId: viewer.tenantId } });
  return d.count ? done(["/directory"], "Removed.") : { ok: false, message: "Not found." };
}

export async function clearDirectoryHistoryAction(_prev: ActionState): Promise<ActionState> {
  const viewer = await requireViewer();
  const d = await prisma.directorySearchLog.deleteMany({ where: { userId: viewer.user.id, tenantId: viewer.tenantId } });
  return done(["/directory"], `Cleared ${d.count} search${d.count === 1 ? "" : "es"}.`);
}
