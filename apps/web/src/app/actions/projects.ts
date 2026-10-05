"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { saveTimesheet, decideTimesheet, draftInvoice, sendInvoice, recordInvoicePayment, refreshProjectHealth, weekStart } from "@keka/services";
import { requireAuth, requireViewer, can, type Viewer } from "@/lib/context";
import { saveFile } from "@/lib/storage";
import { foreignReference } from "@/lib/ownership";
import {
  z, parseForm, toErrorState, writeAudit, actionDone as done,
  zName, zOptional, zNumber, zRequiredNumber, zRequiredDate, zDate, zBool, zOptionalId, zId, zEmail, type ActionState,
} from "@/lib/forms";

const P = PERMISSIONS;
const DAY = 86_400_000;

/** The project, only if it belongs to the viewer's tenant. */
async function ownProject(viewer: Viewer, projectId: string) {
  return prisma.project.findFirst({ where: { id: projectId, tenantId: viewer.tenantId }, select: { id: true, projectManagerId: true } });
}

async function isPm(viewer: Viewer, projectId: string) {
  const p = await prisma.project.findFirst({ where: { id: projectId, tenantId: viewer.tenantId }, select: { projectManagerId: true } });
  return !!p && p.projectManagerId === viewer.employee?.id;
}

/** Rows arrive as project_<r>, task_<r>, h_<r>_<0..6>, note_<r>. */
export async function saveTimesheetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "No employee record linked to this login." };
  const weekRaw = String(formData.get("week") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekRaw)) return { ok: false, message: "Choose a week." };
  const week = weekStart(new Date(`${weekRaw}T00:00:00Z`));
  const rows = [...new Set([...formData.keys()].map((k) => /^project_(\d+)$/.exec(k)?.[1]).filter((x): x is string => !!x))];
  const entries = [];
  for (const r of rows) {
    const projectId = String(formData.get(`project_${r}`) ?? "");
    if (!projectId) continue;
    for (let d = 0; d < 7; d++) {
      const h = Number(formData.get(`h_${r}_${d}`) ?? "");
      if (h > 0) entries.push({
        projectId, taskId: String(formData.get(`task_${r}`) ?? "") || null, date: new Date(week.getTime() + d * DAY), hours: h, description: String(formData.get(`note_${r}`) ?? "") || null,
        timeCode: String(formData.get(`code_${r}`) ?? "") || null, workPackageId: String(formData.get(`wp_${r}`) ?? "") || null, milestoneId: String(formData.get(`ms_${r}`) ?? "") || null,
      });
    }
  }
  if (entries.length === 0) return { ok: false, message: "Log some time first." };
  try {
    const res = await saveTimesheet({ employeeId: viewer.employee.id, week, entries, submit: formData.get("intent") === "submit", attested: formData.get("attest") === "on", actorUserId: viewer.user.id });
    if (res.ok) for (const p of new Set(entries.map((e) => e.projectId))) await refreshProjectHealth(p);
    return res.ok ? done(["/projects"], res.message) : { ok: false, message: res.message };
  } catch (err) {
    return toErrorState(err);
  }
}

export async function decideTimesheetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("timesheetId"));
  const sheet = await prisma.timesheet.findFirst({
    where: { id, tenantId: viewer.tenantId },
    include: { employee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } }, entries: { select: { projectId: true } } },
  });
  if (!sheet) return { ok: false, message: "Timesheet not found." };
  if (sheet.employeeId === viewer.employee?.id) return { ok: false, message: "You cannot approve your own time." };
  // The person's manager line, or the manager of every project on the sheet —
  // whichever the approval chain has it waiting on.
  const viaLine = sheet.awaiting !== "PROJECT_MANAGER" && can(viewer, P.TIMESHEET_APPROVE) && canAccessEmployee(viewer, sheet.employee, P.TIMESHEET_APPROVE);
  const projects = [...new Set(sheet.entries.map((e) => e.projectId))];
  const viaPm = sheet.awaiting !== "LINE_MANAGER" && projects.length > 0 && (await Promise.all(projects.map((p) => isPm(viewer, p)))).every(Boolean);
  if (!viaLine && !viaPm) return { ok: false, message: "This timesheet is not yours to approve." };
  const res = await decideTimesheet({ timesheetId: id, approve: formData.get("decision") === "approve", byUserId: viewer.user.id, reason: String(formData.get("reason") ?? "") || null });
  return res.ok ? done(["/projects", "/inbox"], res.message) : { ok: false, message: res.message };
}

const projectSchema = z.object({
  id: zOptionalId(), name: zName(120), code: zOptional(20), clientId: zOptionalId(), description: zOptional(1000),
  billingModel: z.enum(["TIME_AND_MATERIAL", "MILESTONE", "RETAINER", "NON_BILLABLE"]),
  status: z.enum(["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]).default("ACTIVE"),
  startDate: zDate(), endDate: zDate(), estimatedHours: zNumber({ min: 0 }), budget: zNumber({ min: 0 }), retainerFee: zNumber({ min: 0 }),
  projectManagerId: zOptionalId(),
});

export async function saveProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.PROJECT_MANAGE);
  const parsed = parseForm(projectSchema, formData);
  if (parsed.state) return parsed.state;
  const { id, ...d } = parsed.data;
  if (d.startDate && d.endDate && d.endDate < d.startDate) return { ok: false, message: "The end is before the start.", errors: { endDate: "Before start" } };
  if (d.billingModel === "RETAINER" && !d.retainerFee) return { ok: false, message: "A retainer needs its fee.", errors: { retainerFee: "Required" } };
  if (d.billingModel !== "NON_BILLABLE" && !d.clientId) return { ok: false, message: "A billable project needs a client.", errors: { clientId: "Required" } };
  try {
    const foreign = await foreignReference(viewer.tenantId, { client: d.clientId, employee: d.projectManagerId });
    if (foreign) return { ok: false, message: foreign };
    // Check ownership before writing, never after.
    if (id && !(await prisma.project.count({ where: { id, tenantId: viewer.tenantId } }))) return { ok: false, message: "Project not found." };
    const p = id ? await prisma.project.update({ where: { id }, data: d }) : await prisma.project.create({ data: { ...d, tenantId: viewer.tenantId } });
    await refreshProjectHealth(p.id);
    return done(["/projects", `/projects/${p.id}`], id ? "Saved." : `Created ${p.name}. Allocate people so they can log time.`);
  } catch (err) { return toErrorState(err); }
}

const allocSchema = z.object({
  projectId: zId(), employeeId: zId(), billingRole: zOptional(60), allocationPercent: zRequiredNumber({ min: 1, max: 100 }),
  billRate: zNumber({ min: 0 }), costRate: zNumber({ min: 0 }), isBillable: zBool(), startDate: zRequiredDate(), endDate: zDate(),
});

export async function allocateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(allocSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await ownProject(viewer, d.projectId))) return { ok: false, message: "Project not found." };
  if (!(await prisma.employee.count({ where: { id: d.employeeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Employee not found." };
  if (!(can(viewer, P.PROJECT_MANAGE) || (await isPm(viewer, d.projectId)))) return { ok: false, message: "Only the project manager or a project admin can allocate people." };
  if (d.isBillable && !d.billRate) return { ok: false, message: "A billable allocation needs a bill rate.", errors: { billRate: "Required" } };
  // More than 100% across concurrent allocations is a plan that cannot happen.
  const others = await prisma.resourceAllocation.findMany({ where: { employeeId: d.employeeId, ...(d.endDate ? { startDate: { lte: d.endDate } } : {}), OR: [{ endDate: null }, { endDate: { gte: d.startDate } }], NOT: { projectId: d.projectId } } });
  const load = others.reduce((s, a) => s + Number(a.allocationPercent), 0) + d.allocationPercent;
  if (load > 100) return { ok: false, message: `That puts them at ${load}% across projects.`, errors: { allocationPercent: `Over 100% (${load}%)` } };
  try {
    await prisma.resourceAllocation.upsert({ where: { projectId_employeeId_startDate: { projectId: d.projectId, employeeId: d.employeeId, startDate: d.startDate } }, create: d, update: d });
    return done([`/projects/${d.projectId}`], "Allocated.");
  } catch (err) { return toErrorState(err); }
}

const taskSchema = z.object({
  projectId: zId(), title: zName(200), assigneeId: zOptionalId(), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  estimatedHours: zNumber({ min: 0, max: 1000 }), dueDate: zDate(), isBillable: zBool(),
});

export async function createTaskAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(taskSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await ownProject(viewer, d.projectId))) return { ok: false, message: "Project not found." };
  if (d.assigneeId && !(await prisma.employee.count({ where: { id: d.assigneeId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Assignee not found." };
  // TASK_MANAGE is implicit for every line manager, so on its own it does not
  // open someone else's project; adding work needs the project, not a team.
  if (!(can(viewer, P.PROJECT_MANAGE) || (await isPm(viewer, d.projectId)))) return { ok: false, message: "Only the project manager can add tasks." };
  await prisma.task.create({ data: { ...d, tenantId: viewer.tenantId, reporterId: viewer.employee?.id ?? null } });
  return done([`/projects/${d.projectId}`, "/projects"], "Task added.");
}

export async function taskStatusAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const id = String(formData.get("taskId"));
  const status = String(formData.get("status")) as "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "BLOCKED" | "DONE";
  if (!["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"].includes(status)) return { ok: false, message: "Unknown status." };
  const t = await prisma.task.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { assignee: { select: { id: true, departmentId: true, locationId: true, legalEntityId: true, businessUnitId: true, reportingManagerId: true } } } });
  if (!t) return { ok: false, message: "Task not found." };
  const mine = t.assigneeId === viewer.employee?.id;
  const theirManager = !!t.assignee && can(viewer, P.TASK_MANAGE) && canAccessEmployee(viewer, t.assignee, P.TASK_MANAGE);
  if (!mine && !theirManager && !can(viewer, P.PROJECT_MANAGE) && !(await isPm(viewer, t.projectId))) return { ok: false, message: "This task is someone else's." };
  await prisma.task.update({ where: { id }, data: { status, completedAt: status === "DONE" ? new Date() : null, progressPercent: status === "DONE" ? 100 : t.progressPercent } });
  return done([`/projects/${t.projectId}`, "/projects"], "Updated.");
}

export async function milestoneAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const projectId = String(formData.get("projectId"));
  if (!(await ownProject(viewer, projectId))) return { ok: false, message: "Project not found." };
  if (!(can(viewer, P.PROJECT_MANAGE) || (await isPm(viewer, projectId)))) return { ok: false, message: "Only the project manager can change milestones." };
  const op = String(formData.get("op"));
  if (op === "complete") {
    await prisma.milestone.updateMany({ where: { id: String(formData.get("milestoneId")), projectId, status: { in: ["PENDING", "IN_PROGRESS", "DELAYED"] } }, data: { status: "COMPLETED", completedOn: new Date() } });
  } else {
    const name = String(formData.get("name") ?? "").trim(), due = String(formData.get("dueDate") ?? ""), amount = Number(formData.get("amount"));
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, message: "Name the milestone and give its due date." };
    await prisma.milestone.create({ data: { projectId, name, dueDate: new Date(`${due}T00:00:00Z`), amount: amount > 0 ? amount : null } });
  }
  await refreshProjectHealth(projectId);
  return done([`/projects/${projectId}`], op === "complete" ? "Milestone completed." : "Milestone added.");
}

const clientSchema = z.object({
  name: zName(120), code: zOptional(20), contactName: zOptional(80), contactEmail: zEmail(), city: zOptional(60), state: zOptional(60),
  countryCode: z.string().length(2).default("IN"), gstin: zOptional(15),
});

export async function saveClientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.CLIENT_MANAGE);
  const parsed = parseForm(clientSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(d.gstin.toUpperCase())) return { ok: false, message: "That GSTIN is not valid.", errors: { gstin: "15 characters, e.g. 29ABCDE1234F1Z5" } };
  try {
    await prisma.client.create({ data: { ...d, gstin: d.gstin?.toUpperCase() ?? null, tenantId: viewer.tenantId } });
    return done(["/projects"], `Added ${d.name}.`);
  } catch (err) { return toErrorState(err); }
}

export async function invoiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.INVOICE_MANAGE);
  const op = String(formData.get("op"));
  try {
    if (op === "draft") {
      const projectId = String(formData.get("projectId"));
      if (!(await prisma.project.count({ where: { id: projectId, tenantId: viewer.tenantId } }))) return { ok: false, message: "Project not found." };
      const from = String(formData.get("from")), to = String(formData.get("to"));
      const res = await draftInvoice({ projectId, periodStart: new Date(`${from}T00:00:00Z`), periodEnd: new Date(`${to}T00:00:00Z`) });
      if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "CREATE", entityType: "Invoice", entityId: res.invoiceId, summary: res.message });
      return res.ok ? done(["/projects", `/projects/${projectId}`], res.message) : { ok: false, message: res.message };
    }
    const invoiceId = String(formData.get("invoiceId"));
    const inv = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: viewer.tenantId } });
    if (!inv) return { ok: false, message: "Invoice not found." };
    const res = op === "send"
      ? await sendInvoice(invoiceId, async (pdf, filename) => `/files/${(await saveFile({ tenantId: viewer.tenantId, filename, mimeType: "application/pdf", data: pdf, relatedType: "Invoice", relatedId: invoiceId, uploadedBy: viewer.user.id })).id}`)
      : op === "payment"
        ? await recordInvoicePayment({ invoiceId, amount: Number(formData.get("amount")), paidOn: new Date(), reference: String(formData.get("reference") ?? "") || null })
        : { ok: false, message: "Unknown action." };
    if (res.ok) await writeAudit(viewer, { module: "FINANCE", action: "UPDATE", entityType: "Invoice", entityId: invoiceId, summary: `${inv.invoiceNumber} ${op}: ${res.message}` });
    return res.ok ? done(["/projects", `/projects/${inv.projectId}`, "/projects/billing", "/projects/billing/payments", `/projects/billing/${invoiceId}`], res.message) : { ok: false, message: res.message };
  } catch (err) {
    return toErrorState(err);
  }
}
