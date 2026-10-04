"use server";

import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  saveErSettings, saveErTemplate, createErCase, addAnonymousInfo, erCaseFor, updateErAccess, addErNote, moveErCase, startInvestigation,
  addInvestigationTask, toggleInvestigationTask, addWitness, recordWitnessStatement, addEvidence, submitFindings, scheduleHearing, recordHearing,
  proposeAction, respondToAction, acknowledgeAction, revokeAction, fileAppeal, takeUpAppeal, decideAppeal, proposeResolution, closeErCase, erRef,
  type ErViewer,
} from "@keka/services";
import { requireViewer, can, canAny, type Viewer } from "@/lib/context";
import { writeAudit, formList, type ActionState } from "@/lib/forms";
import { saveFile } from "@/lib/storage";
import { str, optStr, bool, int, day, who, actorOf, DENIED, no, result, readUpload } from "@/lib/cases-docs";

/**
 * Employee relations: grievances, complaints and disciplinary cases.
 * HR with lifecycle.er_case.manage works non-confidential cases;
 * confidential ones need lifecycle.er_case.approve or a place on the case's
 * access list (investigators and panel members are added automatically).
 * The employee a case is about never sees it. Employees raise grievances
 * (optionally anonymously) and respond to, acknowledge and appeal actions
 * taken against them. Every write is audited.
 */

const P = PERMISSIONS;
const PATHS = ["/relations", "/me/cases", "/inbox"];

const erv = (v: Viewer): ErViewer => ({ tenantId: v.tenantId, userId: v.user.id, employeeId: v.employee?.id ?? null, canManage: can(v, P.ER_CASE_MANAGE), canApprove: can(v, P.ER_CASE_APPROVE) });
const isHr = (v: Viewer) => canAny(v, [P.ER_CASE_MANAGE, P.ER_CASE_APPROVE]);

/** The case, when the viewer may work it (HR rights or the access list). */
/**
 * The case if the viewer may work it (not just read it): approvers, the
 * owner, people listed as investigator or panel, and case managers on a
 * non-confidential case. A VIEWER on the access list only reads.
 */
async function workable(v: Viewer, caseId: string) {
  const e = erv(v);
  const c = await erCaseFor(e, caseId);
  if (!c) return null;
  if (e.canApprove || c.ownerUserId === v.user.id) return c;
  const mine = c.access.find((a) => a.userId === v.user.id);
  if (mine && mine.role !== "VIEWER") return c;
  return e.canManage && !c.isConfidential ? c : null;
}
async function audit(v: Viewer, caseId: string, number: number | null, summary: string, action: "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "REJECT" = "UPDATE") {
  await writeAudit(v, { module: "LIFECYCLE", action, entityType: "ErCase", entityId: caseId, summary: `${number ? `${erRef(number)}: ` : ""}${summary}` });
}
const paths = (id: string) => [...PATHS, `/relations/${id}`];

// ---------------------------------------------------------------------------
//  Setup
// ---------------------------------------------------------------------------

export async function saveErSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_APPROVE)) return DENIED;
  const r = await saveErSettings({
    tenantId: v.tenantId, allowAnonymous: bool(fd, "allowAnonymous"), appealWindowDays: int(fd, "appealWindowDays") ?? 15, showCauseDays: int(fd, "showCauseDays") ?? 7,
    warningValidityMonths: int(fd, "warningValidityMonths") ?? 12, retentionMonths: int(fd, "retentionMonths") ?? 84,
  });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "UPDATE", entityType: "ErSettings", summary: "Employee relations settings changed" });
  return result(r, PATHS);
}

export async function saveErTemplateAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_MANAGE)) return DENIED;
  const r = await saveErTemplate({
    tenantId: v.tenantId, id: optStr(fd, "id"), name: str(fd, "name"), kind: str(fd, "kind"), category: str(fd, "category"), severity: str(fd, "severity") || "MEDIUM",
    description: optStr(fd, "description"), checklist: str(fd, "checklist").split("\n"), letterTemplateId: optStr(fd, "letterTemplateId"), isActive: fd.has("isActive") ? bool(fd, "isActive") : true,
  });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "UPDATE", entityType: "ErCaseTemplate", entityId: r.id, summary: `Case template "${str(fd, "name")}" saved` });
  return result(r, PATHS);
}

// ---------------------------------------------------------------------------
//  Intake
// ---------------------------------------------------------------------------

/** HR logs a case (any kind, including disciplinary). */
export async function createErCaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_MANAGE)) return DENIED;
  const templateId = optStr(fd, "templateId");
  const tpl = templateId ? await prisma.erCaseTemplate.findFirst({ where: { id: templateId, tenantId: v.tenantId } }) : null;
  const r = await createErCase({
    tenantId: v.tenantId, kind: str(fd, "kind") || tpl?.kind || "", category: str(fd, "category") || tpl?.category || "", severity: optStr(fd, "severity") ?? tpl?.severity,
    title: str(fd, "title"), description: str(fd, "description") || tpl?.description || "", incidentDate: day(fd, "incidentDate"), incidentLocation: optStr(fd, "incidentLocation"),
    subjectEmployeeId: optStr(fd, "subjectEmployeeId"), reporterEmployeeId: optStr(fd, "reporterEmployeeId"), createdByUserId: v.user.id,
    ownerUserId: optStr(fd, "ownerUserId") ?? v.user.id, templateId, policyDocumentId: optStr(fd, "policyDocumentId"), source: "INTAKE", confidential: fd.has("confidential") ? bool(fd, "confidential") : true,
  });
  if (r.ok && r.id) await audit(v, r.id, r.number ?? null, `${str(fd, "kind") || tpl?.kind} case logged by HR`, "CREATE");
  return { ...result(r, PATHS), ...(r.ok && r.id ? { values: { id: r.id } } : {}) };
}

/** An employee raises a grievance or complaint, optionally anonymously. */
export async function raiseErCaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return no("Only employees can raise a grievance.");
  const kind = str(fd, "kind");
  if (kind !== "GRIEVANCE" && kind !== "COMPLAINT") return no("Pick grievance or complaint.");
  const anonymous = bool(fd, "anonymous");
  const r = await createErCase({
    tenantId: v.tenantId, kind, category: str(fd, "category"), severity: optStr(fd, "severity"), title: str(fd, "title"), description: str(fd, "description"),
    incidentDate: day(fd, "incidentDate"), incidentLocation: optStr(fd, "incidentLocation"), subjectEmployeeId: optStr(fd, "subjectEmployeeId"),
    reporterEmployeeId: v.employee.id, anonymous, createdByUserId: v.user.id, policyDocumentId: optStr(fd, "policyDocumentId"), source: "WEB",
  });
  // An anonymous report is deliberately not attributed in the audit log.
  if (r.ok && r.id) await writeAudit(v, { module: "LIFECYCLE", action: "CREATE", entityType: "ErCase", entityId: anonymous ? null : r.id, summary: anonymous ? "An anonymous report was submitted" : `${erRef(r.number!)} raised by the employee` });
  if (r.ok && r.trackingCode) return { ...result({ ok: true, message: `${r.message} Your tracking code is ${r.trackingCode}.` }, PATHS), values: { trackingCode: r.trackingCode } };
  return result(r, PATHS);
}

export async function anonymousInfoAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const r = await addAnonymousInfo(v.tenantId, str(fd, "code"), str(fd, "body"));
  return result(r, PATHS);
}

// ---------------------------------------------------------------------------
//  Working a case
// ---------------------------------------------------------------------------

export async function erAccessAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const remove = str(fd, "remove") === "1";
  const r = await updateErAccess({ ...actorOf(v), caseId: c.id, userId2: str(fd, "userId"), role: str(fd, "role") || "VIEWER", remove });
  if (r.ok) await audit(v, c.id, c.number, `${remove ? "Removed from" : "Added to"} the access list`);
  return result(r, paths(c.id));
}

export async function erNoteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c) return DENIED;
  const r = await addErNote({ ...actorOf(v), caseId: c.id, body: str(fd, "body"), toReporter: bool(fd, "toReporter") });
  if (r.ok) await audit(v, c.id, c.number, bool(fd, "toReporter") ? "Reply sent to the reporter" : "Note added");
  return result(r, paths(c.id));
}

export async function erMoveAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const r = await moveErCase({ ...actorOf(v), caseId: c.id, to: str(fd, "to"), note: optStr(fd, "note") });
  if (r.ok) await audit(v, c.id, c.number, `Status moved to ${str(fd, "to")}`);
  return result(r, paths(c.id));
}

export async function startInvestigationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const r = await startInvestigation({ ...actorOf(v), caseId: c.id, investigatorUserId: str(fd, "investigatorUserId"), scope: optStr(fd, "scope"), dueOn: day(fd, "dueOn") });
  if (r.ok) await audit(v, c.id, c.number, "Investigation opened");
  return result(r, paths(c.id));
}

export async function investigationTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (str(fd, "taskId")) {
    const task = await prisma.erInvestigationTask.findFirst({ where: { id: str(fd, "taskId"), tenantId: v.tenantId }, include: { investigation: true } });
    if (!task) return no("Task not found.");
    const c = await workable(v, task.investigation.caseId);
    if (!c) return DENIED;
    const r = await toggleInvestigationTask({ ...actorOf(v), taskId: task.id });
    if (r.ok) await audit(v, c.id, c.number, `Investigation step "${task.title}" ${task.doneAt ? "reopened" : "done"}`);
    return result(r, paths(c.id));
  }
  const c = await workable(v, str(fd, "caseId"));
  if (!c) return DENIED;
  const r = await addInvestigationTask({ ...actorOf(v), caseId: c.id, title: str(fd, "title"), dueOn: day(fd, "dueOn") });
  if (r.ok) await audit(v, c.id, c.number, `Investigation step added: ${str(fd, "title")}`);
  return result(r, paths(c.id));
}

export async function witnessAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (str(fd, "witnessId")) {
    const w = await prisma.erWitness.findFirst({ where: { id: str(fd, "witnessId"), tenantId: v.tenantId } });
    if (!w) return no("Witness not found.");
    const c = await workable(v, w.caseId);
    if (!c) return DENIED;
    const r = await recordWitnessStatement({ ...actorOf(v), witnessId: w.id, statement: str(fd, "statement"), interviewedOn: day(fd, "interviewedOn") });
    if (r.ok) await audit(v, c.id, c.number, `Witness statement recorded (${w.name})`);
    return result(r, paths(c.id));
  }
  const c = await workable(v, str(fd, "caseId"));
  if (!c) return DENIED;
  const r = await addWitness({ ...actorOf(v), caseId: c.id, employeeId: optStr(fd, "employeeId"), name: optStr(fd, "name"), contact: optStr(fd, "contact"), statement: optStr(fd, "statement"), interviewedOn: day(fd, "interviewedOn") });
  if (r.ok) await audit(v, c.id, c.number, "Witness added");
  return result(r, paths(c.id));
}

export async function evidenceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c) return DENIED;
  const up = await readUpload(fd, "file");
  if (up && "error" in up) return no(up.error);
  // Evidence files are tied to the case (relatedId = case id) so access and retention follow the case.
  const stored = up ? await saveFile({ tenantId: v.tenantId, filename: up.name, mimeType: up.type, data: up.data, relatedType: "ErEvidence", relatedId: c.id, uploadedBy: v.user.id }) : null;
  const r = await addEvidence({ ...actorOf(v), caseId: c.id, title: str(fd, "title"), description: optStr(fd, "description"), fileId: stored?.id ?? null, sha256: stored?.sha256 ?? null, collectedOn: day(fd, "collectedOn") });
  if (!r.ok && stored) await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined);
  if (r.ok) await audit(v, c.id, c.number, `Evidence added: ${str(fd, "title")}${stored ? ` (SHA-256 ${stored.sha256.slice(0, 12)})` : ""}`);
  return result(r, paths(c.id));
}

export async function submitFindingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c) return DENIED;
  const r = await submitFindings({ ...actorOf(v), caseId: c.id, employeeId: c.subjectEmployeeId, findings: str(fd, "findings"), conclusion: str(fd, "conclusion"), recommendation: optStr(fd, "recommendation") });
  if (r.ok) await audit(v, c.id, c.number, `Findings submitted (${str(fd, "conclusion")})`);
  return result(r, paths(c.id));
}

export async function scheduleHearingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const at = str(fd, "scheduledAt");
  const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? new Date(`${at}:00+05:30`) : null;
  if (!when) return no("Pick the hearing's date and time.");
  const r = await scheduleHearing({ ...actorOf(v), caseId: c.id, scheduledAt: when, location: optStr(fd, "location"), panelUserIds: formList(fd, "panelUserIds") });
  if (r.ok) await audit(v, c.id, c.number, `Hearing scheduled for ${at.replace("T", " ")}`);
  return result(r, paths(c.id));
}

export async function recordHearingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const h = await prisma.erHearing.findFirst({ where: { id: str(fd, "hearingId"), tenantId: v.tenantId } });
  if (!h) return no("Hearing not found.");
  const c = await workable(v, h.caseId);
  if (!c) return DENIED;
  const r = await recordHearing({ ...actorOf(v), hearingId: h.id, status: str(fd, "status"), minutes: optStr(fd, "minutes"), employeeStatement: optStr(fd, "employeeStatement"), attendees: optStr(fd, "attendees") });
  if (r.ok) await audit(v, c.id, c.number, `Hearing marked ${str(fd, "status").toLowerCase()}`);
  return result(r, paths(c.id));
}

export async function proposeActionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !can(v, P.ER_CASE_MANAGE)) return DENIED;
  const r = await proposeAction({
    ...actorOf(v), caseId: c.id, requesterEmployeeId: v.employee?.id ?? null, actionType: str(fd, "actionType"), summary: str(fd, "summary"), effectiveOn: day(fd, "effectiveOn") ?? new Date(),
    suspensionFrom: day(fd, "suspensionFrom"), suspensionTo: day(fd, "suspensionTo"), suspensionPaid: bool(fd, "suspensionPaid"), responseDueOn: day(fd, "responseDueOn"),
    letterTemplateId: optStr(fd, "letterTemplateId"), ladderOverride: optStr(fd, "ladderOverride"),
  });
  if (r.ok) await audit(v, c.id, c.number, `${str(fd, "actionType")} proposed for approval${optStr(fd, "ladderOverride") ? " (step skipped with a recorded reason)" : ""}`);
  return result(r, paths(c.id));
}

export async function revokeActionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_APPROVE)) return DENIED;
  const a = await prisma.erAction.findFirst({ where: { id: str(fd, "actionId"), tenantId: v.tenantId } });
  if (!a) return no("Action not found.");
  const c = await workable(v, a.caseId);
  if (!c) return DENIED;
  const r = await revokeAction({ ...actorOf(v), actionId: a.id, reason: str(fd, "reason") });
  if (r.ok) await audit(v, c.id, c.number, `${a.actionType} revoked: ${str(fd, "reason")}`);
  return result(r, paths(c.id));
}

export async function takeUpAppealAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_APPROVE)) return DENIED;
  const ap = await prisma.erAppeal.findFirst({ where: { id: str(fd, "appealId"), tenantId: v.tenantId } });
  if (!ap) return no("Appeal not found.");
  const c = await workable(v, ap.caseId);
  if (!c) return DENIED;
  const r = await takeUpAppeal({ ...actorOf(v), appealId: ap.id });
  if (r.ok) await audit(v, c.id, c.number, "Appeal taken up for review");
  return result(r, paths(c.id));
}

export async function decideAppealAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!can(v, P.ER_CASE_APPROVE)) return DENIED;
  const ap = await prisma.erAppeal.findFirst({ where: { id: str(fd, "appealId"), tenantId: v.tenantId } });
  if (!ap) return no("Appeal not found.");
  const c = await workable(v, ap.caseId);
  if (!c) return DENIED;
  const r = await decideAppeal({ ...actorOf(v), appealId: ap.id, decision: str(fd, "decision"), note: str(fd, "note") });
  if (r.ok) await audit(v, c.id, c.number, `Appeal decided: ${str(fd, "decision")}`, str(fd, "decision") === "UPHELD" ? "REJECT" : "APPROVE");
  return result(r, paths(c.id));
}

export async function proposeResolutionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const r = await proposeResolution({ ...actorOf(v), caseId: c.id, employeeId: c.subjectEmployeeId, outcome: str(fd, "outcome"), resolution: str(fd, "resolution") });
  if (r.ok) await audit(v, c.id, c.number, `Resolution proposed: ${str(fd, "outcome")}`);
  return result(r, paths(c.id));
}

export async function closeErCaseAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  const c = await workable(v, str(fd, "caseId"));
  if (!c || !isHr(v)) return DENIED;
  const r = await closeErCase({ ...actorOf(v), caseId: c.id });
  if (r.ok) await audit(v, c.id, c.number, "Case closed");
  return result(r, paths(c.id));
}

// ---------------------------------------------------------------------------
//  The employee an action is against
// ---------------------------------------------------------------------------

export async function respondToActionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return DENIED;
  const r = await respondToAction({ tenantId: v.tenantId, actionId: str(fd, "actionId"), employeeId: v.employee.id, userId: v.user.id, label: who(v), response: str(fd, "response") });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "UPDATE", entityType: "ErAction", entityId: str(fd, "actionId"), summary: "Employee responded to a show-cause notice" });
  return result(r, PATHS);
}

export async function acknowledgeActionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return DENIED;
  const r = await acknowledgeAction({ tenantId: v.tenantId, actionId: str(fd, "actionId"), employeeId: v.employee.id });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "UPDATE", entityType: "ErAction", entityId: str(fd, "actionId"), summary: "Employee acknowledged a disciplinary action" });
  return result(r, PATHS);
}

export async function fileAppealAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (!v.employee) return DENIED;
  const r = await fileAppeal({ tenantId: v.tenantId, actionId: str(fd, "actionId"), employeeId: v.employee.id, userId: v.user.id, label: who(v), grounds: str(fd, "grounds") });
  if (r.ok) await writeAudit(v, { module: "LIFECYCLE", action: "CREATE", entityType: "ErAppeal", entityId: str(fd, "actionId"), summary: "Employee appealed a disciplinary action" });
  return result(r, PATHS);
}
