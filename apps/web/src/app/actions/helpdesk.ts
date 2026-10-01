"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  raiseTicket, commentOnTicket, addInternalNote, updateTicket, reopenTicket, addFollower, removeFollower,
  helpdeskScope, inHelpdeskScope, helpdeskAssignableUsers, helpdeskAudienceAllows, helpdeskCategoryPath, isTicketClosed,
  HELPDESK_FOLLOWER_ROLES, PREDEFINED_CATEGORIES, TICKET_PRIORITIES, helpdeskTime,
  type HelpdeskFollowerRole, type HelpdeskScope,
} from "@keka/services";
import { foreignReference } from "@/lib/ownership";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { saveFile, sniffUpload, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { aiJson, aiForViewer } from "@/lib/ai";
import {
  z, parseForm, toErrorState, writeAudit, actionDone, formList,
  zName, zOptional, zRequiredNumber, zBool, zId, zOptionalId,
  type ActionState,
} from "@/lib/forms";

/**
 * Helpdesk actions. Two kinds of caller:
 *  - the employee who raised a ticket (and, read-only, its followers);
 *  - agents — everyone with HELPDESK_MANAGE, and the heads and agents of a
 *    category for that category's tickets (helpdeskScope).
 * Settings need HELPDESK_SETTINGS. Every id from a form is re-checked
 * against the viewer's tenant and scope; every write is audited.
 */

const P = PERMISSIONS;
const MAX_FILES = 5;
const PATHS = ["/helpdesk", "/helpdesk/tickets", "/me/helpdesk"];

const label = (v: Viewer) => v.employee?.displayName ?? v.user.email;
const scopeOf = (v: Viewer) => helpdeskScope(v.tenantId, v.user.id, can(v, P.HELPDESK_MANAGE));
const done = (paths: string[], message: string) => actionDone([...PATHS, ...paths], message);

async function access(viewer: Viewer, ticketId: string) {
  const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: ticketId, tenantId: viewer.tenantId } });
  if (!ticket) return null;
  const scope = await scopeOf(viewer);
  const own = ticket.employeeId === viewer.employee?.id;
  const agent = inHelpdeskScope(scope, ticket.categoryId) && !own;
  const follower = !own && !agent && (await prisma.helpdeskTicketFollower.count({ where: { ticketId, userId: viewer.user.id } })) > 0;
  return { ticket, own, agent, follower, scope };
}

/** Validate and store uploads after the record they belong to exists. */
async function readFiles(formData: FormData): Promise<{ files: Array<{ name: string; type: string; data: Buffer }> } | { error: string }> {
  const raw = formData.getAll("files").filter((f): f is File => typeof f === "object" && !!f && "arrayBuffer" in f && (f as File).size > 0);
  if (raw.length > MAX_FILES) return { error: `Attach up to ${MAX_FILES} files.` };
  const files = [];
  for (const f of raw) {
    if (f.size > MAX_UPLOAD_BYTES) return { error: `${f.name} is larger than 10 MB.` };
    const data = Buffer.from(await f.arrayBuffer());
    const sniff = sniffUpload(data, f.type);
    if (!sniff.ok) return { error: `${f.name}: ${sniff.reason}` };
    files.push({ name: f.name, type: sniff.mimeType, data });
  }
  return { files };
}

async function storeFiles(viewer: Viewer, files: Array<{ name: string; type: string; data: Buffer }>, relatedType: "HelpdeskTicket" | "HelpdeskComment", relatedId: string, employeeId: string) {
  for (const f of files) {
    await saveFile({ tenantId: viewer.tenantId, filename: f.name, mimeType: f.type, data: f.data, relatedType, relatedId, employeeId, uploadedBy: viewer.user.id });
  }
}

// ---------------------------------------------------------------------------
//  Employee: raise, reopen, rate
// ---------------------------------------------------------------------------

const ticketSchema = z.object({
  categoryId: zId(),
  subject: zName(160),
  description: zName(5000),
  priority: z.enum(["NA", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

export async function raiseTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record is linked to this login." };
  const parsed = parseForm(ticketSchema, formData);
  if (parsed.state) return parsed.state;
  const uploads = await readFiles(formData);
  if ("error" in uploads) return { ok: false, message: uploads.error, errors: { files: uploads.error } };
  const d = parsed.data;
  const res = await raiseTicket({ employeeId: viewer.employee.id, categoryId: d.categoryId, subject: d.subject, description: d.description, priority: d.priority ?? null });
  if (!res.ok || !res.ticketId) return { ok: false, message: res.message, errors: { categoryId: res.message } };
  await storeFiles(viewer, uploads.files, "HelpdeskTicket", res.ticketId, viewer.employee.id);
  await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskTicket", entityId: res.ticketId, summary: `Raised ticket #${res.number}: ${d.subject}` });
  const out = done([], res.message);
  return { ...out, values: { ticketId: res.ticketId } };
}

export async function reopenTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  if (!viewer.employee) return { ok: false, message: "Ticket not found." };
  const res = await reopenTicket({ ticketId, employeeId: viewer.employee.id, userId: viewer.user.id, label: label(viewer) });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: "Reopened their ticket" });
  return done([`/me/helpdesk/${ticketId}`], res.message);
}

export async function rateTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const rating = Number(formData.get("rating"));
  if (!(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { ok: false, message: "Rate from 1 to 5." };
  const u = await prisma.helpdeskTicket.updateMany({
    where: { id: ticketId, tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "__none__", status: { in: ["CLOSED", "RESOLVED"] } },
    data: { satisfaction: rating },
  });
  if (!u.count) return { ok: false, message: "You can rate your own closed tickets." };
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Rated the support ${rating}/5` });
  return done([`/me/helpdesk/${ticketId}`], "Thanks for the feedback.");
}

// ---------------------------------------------------------------------------
//  Replies and notes
// ---------------------------------------------------------------------------

const THEN = ["", "IN_PROGRESS", "ON_HOLD", "CLOSED"] as const;

export async function replyTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const then = String(formData.get("then") ?? "") as (typeof THEN)[number];
  if (!THEN.includes(then)) return { ok: false, message: "Pick what to do after sending." };
  const uploads = await readFiles(formData);
  if ("error" in uploads) return { ok: false, message: uploads.error, errors: { files: uploads.error } };
  if (!body && !uploads.files.length) return { ok: false, message: "Write a reply first.", errors: { body: "Required" } };
  if (body.length > 5000) return { ok: false, message: "Keep replies under 5,000 characters.", errors: { body: "Too long" } };
  const a = await access(viewer, ticketId);
  if (!a || (!a.own && !a.agent)) return { ok: false, message: "Ticket not found." };
  const internal = a.agent && formData.get("isInternal") === "on";
  if (then === "CLOSED" && a.agent && !formData.get("closingReasonId") && (await prisma.helpdeskClosingReason.count({ where: { tenantId: viewer.tenantId, isActive: true } }))) {
    return { ok: false, message: "Pick a closing reason.", errors: { closingReasonId: "Required" } };
  }
  const res = await commentOnTicket({
    ticketId, body: body || "(attachment)", asAgent: a.agent, isInternal: internal,
    authorUserId: viewer.user.id, authorLabel: label(viewer),
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (res.commentId) await storeFiles(viewer, uploads.files, "HelpdeskComment", res.commentId, a.ticket.employeeId);
  await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskComment", entityId: res.commentId ?? null, summary: `${internal ? "Internal note" : "Reply"} on ticket #${a.ticket.number}` });
  if (then && a.agent && !internal) {
    const up = await updateTicket({
      ticketId, status: then, byUserId: viewer.user.id, byLabel: label(viewer), requireReason: true,
      closingReasonId: String(formData.get("closingReasonId") ?? "") || null,
    });
    if (!up.ok) return { ok: false, message: `Reply sent, but: ${up.message}` };
    await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Ticket #${a.ticket.number} → ${then}` });
  }
  return done([`/helpdesk/tickets/${ticketId}`, `/me/helpdesk/${ticketId}`], res.message);
}

export async function addNoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { ok: false, message: "Write a note first.", errors: { body: "Required" } };
  if (body.length > 5000) return { ok: false, message: "Keep notes under 5,000 characters.", errors: { body: "Too long" } };
  const a = await access(viewer, ticketId);
  if (!a || !a.agent) return { ok: false, message: "Ticket not found." };
  const res = await addInternalNote({ ticketId, userId: viewer.user.id, label: label(viewer), body });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskComment", entityId: ticketId, summary: `Internal note on ticket #${a.ticket.number}` });
  return done([`/helpdesk/tickets/${ticketId}`], res.message);
}

// ---------------------------------------------------------------------------
//  Agents: update, assign, followers, bulk
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  ticketId: zId(),
  status: z.enum(["OPEN", "IN_PROGRESS", "ON_HOLD", "CLOSED"]).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  categoryId: zOptionalId(),
  assigneeUserId: z.string().optional(),
  closingReasonId: zOptionalId(),
});

export async function updateTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(updateSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const a = await access(viewer, d.ticketId);
  if (!a || !a.agent) return { ok: false, message: "Ticket not found." };
  const categoryId = d.categoryId ?? a.ticket.categoryId;
  let assignee: string | null | undefined;
  if (d.assigneeUserId !== undefined) {
    assignee = d.assigneeUserId || null;
    if (assignee && !(await helpdeskAssignableUsers(viewer.tenantId, categoryId)).includes(assignee)) {
      return { ok: false, message: "Assign the ticket to an agent of its category.", errors: { assigneeUserId: "Not an agent of this category" } };
    }
  }
  const res = await updateTicket({
    ticketId: d.ticketId, byUserId: viewer.user.id, byLabel: label(viewer), requireReason: true,
    status: d.status, priority: d.priority, categoryId: d.categoryId ?? undefined, assigneeUserId: assignee, closingReasonId: d.closingReasonId,
  });
  if (!res.ok) return res;
  await writeAudit(viewer, {
    module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: d.ticketId, summary: `Updated ticket #${a.ticket.number}`,
    oldValue: { status: a.ticket.status, priority: a.ticket.priority, categoryId: a.ticket.categoryId, assigneeUserId: a.ticket.assigneeUserId },
    newValue: { status: d.status, priority: d.priority, categoryId: d.categoryId, assigneeUserId: assignee },
  });
  return done([`/helpdesk/tickets/${d.ticketId}`, `/me/helpdesk/${d.ticketId}`], res.message);
}

export async function assignToMeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const a = await access(viewer, ticketId);
  if (!a || !a.agent) return { ok: false, message: "Ticket not found." };
  if (a.ticket.assigneeUserId === viewer.user.id) return { ok: true, message: "It is already yours." };
  const res = await updateTicket({ ticketId, byUserId: viewer.user.id, byLabel: label(viewer), assigneeUserId: viewer.user.id });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Took ticket #${a.ticket.number}` });
  return done([`/helpdesk/tickets/${ticketId}`], "Assigned to you.");
}

export async function addFollowerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const role = String(formData.get("role") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  const a = await access(viewer, ticketId);
  if (!a || !a.agent) return { ok: false, message: "Ticket not found." };
  let userId: string | null = null;
  if (employeeId) {
    const e = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { userId: true } });
    if (!e) return { ok: false, message: "That employee was not found." };
    if (!e.userId) return { ok: false, message: "That employee cannot sign in, so they cannot follow tickets." };
    userId = e.userId;
  } else if (!(role in HELPDESK_FOLLOWER_ROLES)) return { ok: false, message: "Pick a role or an employee." };
  const res = await addFollower({ ticketId, tenantId: viewer.tenantId, byUserId: viewer.user.id, byLabel: label(viewer), userId, role: employeeId ? null : (role as HelpdeskFollowerRole) });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Follower added to ticket #${a.ticket.number}: ${res.message}` });
  return done([`/helpdesk/tickets/${ticketId}`], res.message);
}

export async function removeFollowerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const ticketId = String(formData.get("ticketId") ?? "");
  const a = await access(viewer, ticketId);
  if (!a || !a.agent) return { ok: false, message: "Ticket not found." };
  const res = await removeFollower({ ticketId, tenantId: viewer.tenantId, followerId: String(formData.get("followerId") ?? ""), byUserId: viewer.user.id, byLabel: label(viewer) });
  if (!res.ok) return res;
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", entityId: ticketId, summary: `Follower removed from ticket #${a.ticket.number}` });
  return done([`/helpdesk/tickets/${ticketId}`], res.message);
}

export async function bulkTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const scope = await scopeOf(viewer);
  const ids = [...new Set(formList(formData, "ids"))];
  const op = String(formData.get("op") ?? "");
  if (!ids.length) return { ok: false, message: "Select tickets first." };
  if (ids.length > 200) return { ok: false, message: "Select at most 200 tickets at a time." };
  const tickets = await prisma.helpdeskTicket.findMany({ where: { id: { in: ids }, tenantId: viewer.tenantId }, select: { id: true, categoryId: true, employeeId: true, status: true, number: true } });
  const mine = tickets.filter((t) => inHelpdeskScope(scope, t.categoryId) && t.employeeId !== viewer.employee?.id);
  if (mine.length !== ids.length) return { ok: false, message: "Some of the selected tickets are not in your queue." };
  let changed = 0;
  const errors: string[] = [];
  if (op === "close") {
    const reasonId = String(formData.get("closingReasonId") ?? "") || null;
    for (const t of mine) {
      if (isTicketClosed(t.status)) continue;
      const r = await updateTicket({ ticketId: t.id, status: "CLOSED", closingReasonId: reasonId, requireReason: true, byUserId: viewer.user.id, byLabel: label(viewer) });
      if (r.ok) changed++; else errors.push(`#${t.number}: ${r.message}`);
      if (!r.ok && /reason/i.test(r.message)) return { ok: false, message: r.message, errors: { closingReasonId: "Required" } };
    }
  } else if (op === "category") {
    const categoryId = String(formData.get("categoryId") ?? "");
    for (const t of mine) {
      const r = await updateTicket({ ticketId: t.id, categoryId, byUserId: viewer.user.id, byLabel: label(viewer) });
      if (r.ok) changed++; else { errors.push(`#${t.number}: ${r.message}`); break; }
    }
  } else return { ok: false, message: "Pick an action." };
  if (changed) {
    await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskTicket", summary: `Bulk ${op === "close" ? "closed" : "re-categorised"} ${changed} ticket(s)`, newValue: { ids: mine.map((t) => t.id) } });
  }
  if (errors.length && !changed) return { ok: false, message: errors[0] };
  return done([], `${changed} ticket${changed === 1 ? "" : "s"} ${op === "close" ? "closed" : "moved"}.${errors.length ? ` ${errors.length} skipped.` : ""}`);
}

// ---------------------------------------------------------------------------
//  Settings: categories
// ---------------------------------------------------------------------------

const categorySchema = z.object({
  id: zOptionalId(),
  name: zName(80),
  description: zOptional(500),
  audienceType: z.enum(["ALL", "EMPLOYEES", "GROUPS"]).default("ALL"),
  defaultAssigneeUserId: zOptionalId(),
  businessHoursId: zOptionalId(),
  enableOnHold: zBool(),
  firstResponseHours: z.string().optional().transform((v) => (v ? Number(v) : 8)).pipe(z.number().int("Whole hours").min(1, "At least 1 hour").max(720, "At most 720 hours")),
  slaHours: zRequiredNumber({ min: 1, max: 720 }),
  assignMode: z.enum(["HEAD", "ROUND_ROBIN", "UNASSIGNED"]).default("HEAD"),
  defaultPriority: z.enum(["", ...TICKET_PRIORITIES]).optional(),
  split: z.string().optional(),
  isActive: z.string().optional(),
});

export async function saveCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const parsed = parseForm(categorySchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!Number.isInteger(d.slaHours)) return { ok: false, message: "Use whole hours.", errors: { slaHours: "Whole hours" } };
  if (d.firstResponseHours > d.slaHours) return { ok: false, message: "The first response target must be within the resolution target.", errors: { firstResponseHours: "Longer than the resolution target" } };

  const audienceEmployees = formList(formData, "audienceEmployeeIds");
  const departmentIds = formList(formData, "departmentIds"), locationIds = formList(formData, "locationIds"), businessUnitIds = formList(formData, "businessUnitIds");
  const agentUserIds = [...new Set(formList(formData, "agentUserIds"))];
  const foreign = await foreignReference(viewer.tenantId, {
    user: [d.defaultAssigneeUserId, ...agentUserIds], employee: audienceEmployees, department: departmentIds, location: locationIds, businessUnit: businessUnitIds,
  });
  if (foreign) return { ok: false, message: foreign };
  if (d.businessHoursId && !(await prisma.helpdeskBusinessHours.count({ where: { id: d.businessHoursId, tenantId: viewer.tenantId } }))) {
    return { ok: false, message: "Those business hours were not found.", errors: { businessHoursId: "Not found" } };
  }
  if (d.assignMode === "ROUND_ROBIN" && agentUserIds.length < 1) return { ok: false, message: "Round robin needs at least one agent.", errors: { agentUserIds: "Add agents" } };
  const audience = d.audienceType === "EMPLOYEES" ? (audienceEmployees.length ? { employeeIds: audienceEmployees } : null)
    : d.audienceType === "GROUPS" ? (departmentIds.length || locationIds.length || businessUnitIds.length ? { departmentIds, locationIds, businessUnitIds } : null) : null;
  if (d.audienceType !== "ALL" && !audience) return { ok: false, message: "Choose who can raise tickets in this category.", errors: { audienceType: "Pick at least one" } };

  // Subcategory rows: sub_<i>_name, sub_<i>_description, sub_<i>_id, sub_<i>_head.
  const subs: Array<{ id: string | null; name: string; description: string | null; head: string | null }> = [];
  if (d.split === "yes") {
    for (let i = 0; i < 40; i++) {
      const name = String(formData.get(`sub_${i}_name`) ?? "").trim();
      if (!name) continue;
      if (name.length > 80) return { ok: false, message: "Keep subcategory names under 80 characters.", errors: { [`sub_${i}_name`]: "Too long" } };
      subs.push({ id: String(formData.get(`sub_${i}_id`) ?? "") || null, name, description: String(formData.get(`sub_${i}_description`) ?? "").trim().slice(0, 500) || null, head: String(formData.get(`sub_${i}_head`) ?? "") || null });
    }
    if (!subs.length) return { ok: false, message: "Add at least one subcategory, or choose not to split the category.", errors: { split: "Add a subcategory" } };
  }
  const names = [d.name, ...subs.map((s) => s.name)].map((n) => n.toLowerCase());
  if (new Set(names).size !== names.length) return { ok: false, message: "Subcategory names must differ from each other and from the category." };
  const subForeign = await foreignReference(viewer.tenantId, { user: subs.map((s) => s.head) });
  if (subForeign) return { ok: false, message: subForeign };

  const existing = d.id ? await prisma.helpdeskCategory.findFirst({ where: { id: d.id, tenantId: viewer.tenantId, parentId: null }, include: { children: { select: { id: true } } } }) : null;
  if (d.id && !existing) return { ok: false, message: "Category not found." };
  if (subs.some((s) => s.id && !existing?.children.some((c) => c.id === s.id))) return { ok: false, message: "A subcategory does not belong to this category." };

  const shared = {
    firstResponseHours: d.firstResponseHours, slaHours: d.slaHours, businessHoursId: d.businessHoursId, enableOnHold: d.enableOnHold,
    assignMode: d.assignMode, defaultPriority: d.defaultPriority ? d.defaultPriority : null,
  };
  const audienceJson = audience ?? Prisma.DbNull;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const data = { ...shared, name: d.name, description: d.description, defaultAssigneeUserId: d.defaultAssigneeUserId, ...(d.isActive !== undefined ? { isActive: d.isActive === "on" || d.isActive === "true" } : {}) };
      const cat = existing
        ? await tx.helpdeskCategory.update({ where: { id: existing.id }, data: { ...data, audience: audienceJson } })
        : await tx.helpdeskCategory.create({ data: { ...data, audience: audience ?? undefined, tenantId: viewer.tenantId, isActive: true } });
      await tx.helpdeskCategoryAgent.deleteMany({ where: { categoryId: cat.id, userId: { notIn: agentUserIds } } });
      for (const userId of agentUserIds) await tx.helpdeskCategoryAgent.upsert({ where: { categoryId_userId: { categoryId: cat.id, userId } }, update: {}, create: { categoryId: cat.id, userId } });
      // Subcategories mirror the category's settings; removed ones go if unused, else turn inactive.
      if (existing) {
        const keep = new Set(subs.map((s) => s.id).filter(Boolean));
        for (const c of existing.children.filter((c) => !keep.has(c.id))) {
          const used = await tx.helpdeskTicket.count({ where: { categoryId: c.id } });
          if (used) await tx.helpdeskCategory.update({ where: { id: c.id }, data: { isActive: false } });
          else await tx.helpdeskCategory.delete({ where: { id: c.id } });
        }
      }
      for (const [i, s] of subs.entries()) {
        const subData = { ...shared, audience: audienceJson, name: s.name, description: s.description, defaultAssigneeUserId: s.head ?? d.defaultAssigneeUserId, sortOrder: i, isActive: true };
        if (s.id) await tx.helpdeskCategory.update({ where: { id: s.id }, data: subData });
        else await tx.helpdeskCategory.create({ data: { ...subData, audience: audience ?? undefined, tenantId: viewer.tenantId, parentId: cat.id } });
      }
      return cat.id;
    });
    await writeAudit(viewer, { module: "HELPDESK", action: existing ? "UPDATE" : "CREATE", entityType: "HelpdeskCategory", entityId: id, summary: `${existing ? "Updated" : "Created"} helpdesk category ${d.name}${subs.length ? ` with ${subs.length} subcategories` : ""}` });
    return { ...done(["/helpdesk/settings/categories"], `Saved ${d.name}.`), values: { id } };
  } catch (err) {
    const state = toErrorState(err);
    return state.message?.includes("already in use") ? { ok: false, message: "A category or subcategory with that name already exists.", errors: { name: "Already in use" } } : state;
  }
}

export async function setCategoryActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  const cat = await prisma.helpdeskCategory.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!cat) return { ok: false, message: "Category not found." };
  await prisma.helpdeskCategory.updateMany({ where: { tenantId: viewer.tenantId, OR: [{ id }, { parentId: id }] }, data: { isActive: active } });
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskCategory", entityId: id, summary: `${active ? "Activated" : "Deactivated"} ${cat.name}` });
  return done(["/helpdesk/settings/categories"], `${cat.name} ${active ? "activated" : "deactivated"}.`);
}

export async function deleteCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const cat = await prisma.helpdeskCategory.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { children: { select: { id: true } } } });
  if (!cat) return { ok: false, message: "Category not found." };
  const used = await prisma.helpdeskTicket.count({ where: { categoryId: { in: [cat.id, ...cat.children.map((c) => c.id)] } } });
  if (used) return { ok: false, message: `${cat.name} has ${used} ticket${used === 1 ? "" : "s"}; deactivate it instead.` };
  await prisma.helpdeskCategory.delete({ where: { id: cat.id } });
  await writeAudit(viewer, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskCategory", entityId: id, summary: `Deleted helpdesk category ${cat.name}` });
  return done(["/helpdesk/settings/categories"], `Deleted ${cat.name}.`);
}

export async function addPredefinedCategoriesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const picked = new Set(formList(formData, "names"));
  const templates = PREDEFINED_CATEGORIES.filter((c) => picked.has(c.name));
  if (!templates.length) return { ok: false, message: "Pick at least one category." };
  const taken = new Set((await prisma.helpdeskCategory.findMany({ where: { tenantId: viewer.tenantId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
  const defaults = await prisma.helpdeskBusinessHours.findFirst({ where: { tenantId: viewer.tenantId, isDefault: true }, select: { id: true } });
  let added = 0;
  for (const t of templates) {
    if (taken.has(t.name.toLowerCase())) continue;
    const parent = await prisma.helpdeskCategory.create({ data: { tenantId: viewer.tenantId, name: t.name, description: t.description, businessHoursId: defaults?.id ?? null, defaultPriority: "MEDIUM" } });
    for (const [i, s] of t.subcategories.entries()) {
      if (taken.has(s.name.toLowerCase())) continue;
      await prisma.helpdeskCategory.create({ data: { tenantId: viewer.tenantId, name: s.name, description: s.description, parentId: parent.id, businessHoursId: defaults?.id ?? null, defaultPriority: "MEDIUM", sortOrder: i } });
    }
    added++;
  }
  if (!added) return { ok: false, message: "Those categories already exist." };
  await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskCategory", summary: `Added ${added} predefined helpdesk categor${added === 1 ? "y" : "ies"}` });
  return done(["/helpdesk/settings/categories"], `Added ${added} categor${added === 1 ? "y" : "ies"}. Set a category head for each.`);
}

// ---------------------------------------------------------------------------
//  Settings: business hours
// ---------------------------------------------------------------------------

const TIMEZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Phoenix", "Australia/Sydney"];

const hoursSchema = z.object({
  id: zOptionalId(), name: zName(80), description: zOptional(500),
  timezone: z.string().refine((v) => TIMEZONES.includes(v), "Pick a time zone"),
  observeHolidays: zBool(),
});

export async function saveBusinessHoursAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const parsed = parseForm(hoursSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const schedule: Array<{ day: number; from: string; to: string }> = [];
  for (let day = 1; day <= 7; day++) {
    if (formData.get(`day_${day}`) !== "on") continue;
    const from = String(formData.get(`from_${day}`) ?? ""), to = String(formData.get(`to_${day}`) ?? "");
    const f = helpdeskTime.clockMinutes(from), t = helpdeskTime.clockMinutes(to);
    if (Number.isNaN(f) || Number.isNaN(t) || t <= f) return { ok: false, message: "Each working day needs a start time before its end time.", errors: { [`to_${day}`]: "End after start" } };
    schedule.push({ day, from, to });
  }
  if (!schedule.length) return { ok: false, message: "Select at least one working day.", errors: { days: "Select a day" } };
  const existing = d.id ? await prisma.helpdeskBusinessHours.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } }) : null;
  if (d.id && !existing) return { ok: false, message: "Business hours not found." };
  try {
    const row = existing
      ? await prisma.helpdeskBusinessHours.update({ where: { id: existing.id }, data: { name: d.name, description: d.description, timezone: d.timezone, observeHolidays: d.observeHolidays, schedule } })
      : await prisma.helpdeskBusinessHours.create({ data: { tenantId: viewer.tenantId, name: d.name, description: d.description, timezone: d.timezone, observeHolidays: d.observeHolidays, schedule } });
    await writeAudit(viewer, { module: "HELPDESK", action: existing ? "UPDATE" : "CREATE", entityType: "HelpdeskBusinessHours", entityId: row.id, summary: `${existing ? "Updated" : "Created"} business hours ${d.name}`, newValue: { schedule } });
    return { ...done(["/helpdesk/settings/business-hours"], `Saved ${d.name}.`), values: { id: row.id } };
  } catch (err) {
    const state = toErrorState(err);
    return state.message?.includes("already in use") ? { ok: false, message: "Business hours with that name already exist.", errors: { name: "Already in use" } } : state;
  }
}

export async function duplicateBusinessHoursAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const src = await prisma.helpdeskBusinessHours.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!src) return { ok: false, message: "Business hours not found." };
  let name = `Copy of ${src.name}`;
  for (let i = 2; await prisma.helpdeskBusinessHours.count({ where: { tenantId: viewer.tenantId, name } }); i++) name = `Copy of ${src.name} (${i})`;
  const row = await prisma.helpdeskBusinessHours.create({
    data: { tenantId: viewer.tenantId, name, description: src.description, timezone: src.timezone, observeHolidays: src.observeHolidays, schedule: src.schedule as Prisma.InputJsonValue },
  });
  await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "HelpdeskBusinessHours", entityId: row.id, summary: `Duplicated business hours ${src.name}` });
  return { ...done(["/helpdesk/settings/business-hours"], `Created ${name}.`), values: { id: row.id } };
}

export async function deleteBusinessHoursAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const row = await prisma.helpdeskBusinessHours.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId }, include: { _count: { select: { categories: true } } } });
  if (!row) return { ok: false, message: "Business hours not found." };
  if (row.isDefault) return { ok: false, message: "The default business hours cannot be deleted." };
  if (row._count.categories) return { ok: false, message: `Used in ${row._count.categories} ticket categor${row._count.categories === 1 ? "y" : "ies"}; move them first.` };
  await prisma.helpdeskBusinessHours.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskBusinessHours", entityId: row.id, summary: `Deleted business hours ${row.name}` });
  return done(["/helpdesk/settings/business-hours"], `Deleted ${row.name}.`);
}

// ---------------------------------------------------------------------------
//  Settings: canned responses and closing reasons
// ---------------------------------------------------------------------------

const cannedSchema = z.object({ id: zOptionalId(), title: zName(120), body: zName(5000) });

export async function saveCannedResponseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const parsed = parseForm(cannedSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    if (d.id) {
      const u = await prisma.helpdeskCannedResponse.updateMany({ where: { id: d.id, tenantId: viewer.tenantId }, data: { title: d.title, body: d.body, updatedByUserId: viewer.user.id } });
      if (!u.count) return { ok: false, message: "Response not found." };
    } else {
      await prisma.helpdeskCannedResponse.create({ data: { tenantId: viewer.tenantId, title: d.title, body: d.body, updatedByUserId: viewer.user.id } });
    }
    await writeAudit(viewer, { module: "HELPDESK", action: d.id ? "UPDATE" : "CREATE", entityType: "HelpdeskCannedResponse", entityId: d.id, summary: `${d.id ? "Updated" : "Created"} canned response ${d.title}` });
    return done(["/helpdesk/settings/canned-responses"], d.id ? "Response updated." : "Response created.");
  } catch (err) {
    const state = toErrorState(err);
    return state.message?.includes("already in use") ? { ok: false, message: "A response with that title already exists.", errors: { title: "Already in use" } } : state;
  }
}

export async function deleteCannedResponseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const row = await prisma.helpdeskCannedResponse.findFirst({ where: { id, tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Response not found." };
  await prisma.helpdeskCannedResponse.delete({ where: { id } });
  await writeAudit(viewer, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskCannedResponse", entityId: id, summary: `Deleted canned response ${row.title}` });
  return done(["/helpdesk/settings/canned-responses"], "Response deleted.");
}

const reasonSchema = z.object({ id: zOptionalId(), name: zName(80), description: zOptional(300) });

export async function saveClosingReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const parsed = parseForm(reasonSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  try {
    if (d.id) {
      const u = await prisma.helpdeskClosingReason.updateMany({ where: { id: d.id, tenantId: viewer.tenantId }, data: { name: d.name, description: d.description } });
      if (!u.count) return { ok: false, message: "Reason not found." };
    } else {
      await prisma.helpdeskClosingReason.create({ data: { tenantId: viewer.tenantId, name: d.name, description: d.description } });
    }
    await writeAudit(viewer, { module: "HELPDESK", action: d.id ? "UPDATE" : "CREATE", entityType: "HelpdeskClosingReason", entityId: d.id, summary: `${d.id ? "Updated" : "Added"} closing reason ${d.name}` });
    return done(["/helpdesk/settings/closing-reasons"], d.id ? "Reason updated." : "Reason added.");
  } catch (err) {
    const state = toErrorState(err);
    return state.message?.includes("already in use") ? { ok: false, message: "A reason with that name already exists.", errors: { name: "Already in use" } } : state;
  }
}

export async function setClosingReasonActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  const u = await prisma.helpdeskClosingReason.updateMany({ where: { id, tenantId: viewer.tenantId }, data: { isActive: active } });
  if (!u.count) return { ok: false, message: "Reason not found." };
  await writeAudit(viewer, { module: "HELPDESK", action: "UPDATE", entityType: "HelpdeskClosingReason", entityId: id, summary: `${active ? "Activated" : "Deactivated"} a closing reason` });
  return done(["/helpdesk/settings/closing-reasons"], active ? "Reason activated." : "Reason deactivated.");
}

export async function deleteClosingReasonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.HELPDESK_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const row = await prisma.helpdeskClosingReason.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { _count: { select: { tickets: true } } } });
  if (!row) return { ok: false, message: "Reason not found." };
  if (row._count.tickets) return { ok: false, message: `Used on ${row._count.tickets} ticket${row._count.tickets === 1 ? "" : "s"}; deactivate it instead.` };
  await prisma.helpdeskClosingReason.delete({ where: { id } });
  await writeAudit(viewer, { module: "HELPDESK", action: "DELETE", entityType: "HelpdeskClosingReason", entityId: id, summary: `Deleted closing reason ${row.name}` });
  return done(["/helpdesk/settings/closing-reasons"], "Reason deleted.");
}

// ---------------------------------------------------------------------------
//  AI assists (optional; honest when AI is not set up)
// ---------------------------------------------------------------------------

type AiOut<T> = { ok: true; value: T } | { ok: false; reason: string };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The least of a ticket an assistant needs: category, subject, description and recent public messages, labelled by side only. */
async function ticketForAi(viewer: Viewer, ticketId: string, scope: HelpdeskScope) {
  const t = await prisma.helpdeskTicket.findFirst({
    where: { id: ticketId, tenantId: viewer.tenantId },
    include: {
      category: { select: { name: true, parent: { select: { name: true } } } },
      employee: { select: { userId: true, id: true } },
      comments: { where: { isInternal: false, isSystem: false }, orderBy: { createdAt: "desc" }, take: 6, select: { authorUserId: true, body: true } },
    },
  });
  if (!t || !inHelpdeskScope(scope, t.categoryId) || t.employee.id === viewer.employee?.id) return null;
  const thread = t.comments.reverse().map((c) => `${c.authorUserId === t.employee.userId ? "Employee" : "Agent"}: ${clip(c.body, 800)}`);
  return { category: helpdeskCategoryPath(t.category), subject: t.subject, description: clip(t.description, 2000), thread };
}

export async function aiDraftReplyAction(ticketId: string): Promise<AiOut<{ reply: string }>> {
  const viewer = await requireViewer();
  const ctx = await ticketForAi(viewer, ticketId, await scopeOf(viewer));
  if (!ctx) return { ok: false, reason: "Ticket not found." };
  const canned = await prisma.helpdeskCannedResponse.findMany({ where: { tenantId: viewer.tenantId }, take: 10, orderBy: { updatedAt: "desc" }, select: { title: true, body: true } });
  const prompt = [
    `Category: ${ctx.category}`, `Subject: ${ctx.subject}`, `Description: ${ctx.description}`,
    ctx.thread.length ? `Conversation so far:\n${ctx.thread.join("\n")}` : "No replies yet.",
    canned.length ? `House style — the team's saved replies:\n${canned.map((c) => `- ${c.title}: ${clip(c.body, 400)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const res = await aiForViewer(viewer, { feature: "HELPDESK_DRAFT", subjectId: ticketId, inputChars: prompt.length }, () => aiJson({
    system: "You draft replies for an internal HR/IT helpdesk agent at an Indian company. Write the next reply to the employee: warm, specific, under 120 words, no promises the agent cannot keep, no invented policy numbers or dates. Address the employee as 'Hi,' — never use names. Return {\"reply\": string}.",
    prompt, maxTokens: 600,
    validate: (v) => (v && typeof (v as { reply?: unknown }).reply === "string" && (v as { reply: string }).reply.trim() ? { reply: (v as { reply: string }).reply.trim().slice(0, 4000) } : null),
  }));
  if (res.ok) await writeAudit(viewer, { module: "HELPDESK", action: "CREATE", entityType: "AiGeneration", entityId: ticketId, summary: "Drafted a helpdesk reply with AI" });
  return res;
}

export async function aiSummariseTicketAction(ticketId: string): Promise<AiOut<{ summary: string; nextStep: string }>> {
  const viewer = await requireViewer();
  const ctx = await ticketForAi(viewer, ticketId, await scopeOf(viewer));
  if (!ctx) return { ok: false, reason: "Ticket not found." };
  const prompt = `Category: ${ctx.category}\nSubject: ${ctx.subject}\nDescription: ${ctx.description}\n\nConversation:\n${ctx.thread.join("\n") || "(no replies yet)"}`;
  return aiForViewer(viewer, { feature: "HELPDESK_SUMMARY", subjectId: ticketId, inputChars: prompt.length }, () => aiJson({
    system: "Summarise an internal helpdesk ticket for the agent picking it up. Return {\"summary\": string (≤ 60 words, what the employee needs and where it stands), \"nextStep\": string (≤ 25 words)}. No names.",
    prompt, maxTokens: 400,
    validate: (v) => {
      const o = v as { summary?: unknown; nextStep?: unknown };
      return typeof o?.summary === "string" && typeof o.nextStep === "string" ? { summary: o.summary.slice(0, 800), nextStep: o.nextStep.slice(0, 300) } : null;
    },
  }));
}

export async function aiSuggestCategoryAction(input: { title: string; description: string }): Promise<AiOut<{ categoryId: string | null; documents: Array<{ id: string; title: string }> }>> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, reason: "No employee record is linked to this login." };
  const title = String(input?.title ?? "").slice(0, 160), description = String(input?.description ?? "").slice(0, 1000);
  if (title.length + description.length < 8) return { ok: false, reason: "Describe what you need first." };
  const me = await prisma.employee.findFirstOrThrow({ where: { id: viewer.employee.id }, select: { id: true, departmentId: true, locationId: true, businessUnitId: true } });
  const cats = await prisma.helpdeskCategory.findMany({
    where: { tenantId: viewer.tenantId, isActive: true, children: { none: { isActive: true } } },
    select: { id: true, name: true, description: true, audience: true, parent: { select: { name: true, audience: true, isActive: true } } },
  });
  const leaves = cats.filter((c) => (!c.parent || c.parent.isActive) && helpdeskAudienceAllows(c.audience ?? c.parent?.audience, me));
  const docs = await prisma.orgDocument.findMany({ where: { tenantId: viewer.tenantId, isPublished: true }, select: { id: true, title: true, description: true }, take: 40 });
  const prompt = [
    `Title: ${title}`, `Description: ${description}`,
    `Categories:\n${leaves.map((c) => `${c.id} | ${helpdeskCategoryPath(c)} | ${clip(c.description ?? "", 160)}`).join("\n")}`,
    `Policies:\n${docs.map((d) => `${d.id} | ${d.title} | ${clip(d.description ?? "", 160)}`).join("\n")}`,
  ].join("\n\n");
  const res = await aiForViewer(viewer, { feature: "HELPDESK_SUGGEST", subjectId: null, inputChars: prompt.length }, () => aiJson({
    system: "Route an employee's helpdesk request. Pick the single best category id from the list (or null if none fits) and up to two policy ids that may already answer it. Return {\"categoryId\": string|null, \"documentIds\": string[]}.",
    prompt, maxTokens: 300,
    validate: (v) => {
      const o = v as { categoryId?: unknown; documentIds?: unknown };
      if (!o || !Array.isArray(o.documentIds)) return null;
      const categoryId = typeof o.categoryId === "string" && leaves.some((c) => c.id === o.categoryId) ? o.categoryId : null;
      const ids = (o.documentIds as unknown[]).filter((x): x is string => typeof x === "string" && docs.some((d) => d.id === x)).slice(0, 2);
      return { categoryId, documentIds: ids };
    },
  }));
  if (!res.ok) return res;
  return { ok: true, value: { categoryId: res.value.categoryId, documents: docs.filter((d) => res.value.documentIds.includes(d.id)).map((d) => ({ id: d.id, title: d.title })) } };
}
