"use server";

import { prisma, Prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, notify, bgvEvent, escalateBgvCase, bgvCostFor, bgvSeverityFor, bgvRollup, joinSettings,
  BGV_CHECKS, BGV_ITEM_STATUSES, BGV_ITEM_OPEN, BGV_ADVERSE, BGV_REASON_CODES, BGV_PRIORITIES, BGV_SEVERITIES, BGV_CHECK_FIELDS,
} from "@keka/services";
import { requireAuth, requireViewer } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload } from "@/lib/storage";
import { jstr as str, jnum as num, jlist as list, scopedEmployee } from "@/lib/join-depth";

/**
 * Background verification depth: vendors (with their own stages and rates)
 * and packages, cases split into one record per check (identity, address,
 * employment, education, criminal, credit, reference) with their own data,
 * status, reason code, severity, SLA and cost; adverse findings reviewed
 * through the workflow engine; a closing result approved before it takes
 * effect and amendable afterwards; consent capture and expiry; rechecks,
 * evidence, reassignment, prioritisation and escalation.
 *
 * Vendor API integrations are out of scope — vendors are recorded and
 * their stages tracked by hand.
 */

const P = PERMISSIONS;
const PATHS = ["/onboarding/verification", "/onboarding/preboarding", "/me/onboarding", "/inbox"];
const NO = (message: string): ActionState => ({ ok: false, message });
const DAY = 86_400_000;
const CHECKS = BGV_CHECKS as readonly string[];

async function caseInScope(viewer: Awaited<ReturnType<typeof requireAuth>>, id: string) {
  const c = await prisma.bgvCheck.findFirst({ where: { id, tenantId: viewer.tenantId }, include: { items: true, employee: { select: { id: true, displayName: true, userId: true } } } });
  if (!c?.employeeId || !(await scopedEmployee(viewer, c.employeeId, P.BGV_MANAGE))) return null;
  return c;
}

// ---------------------------------------------------------------------------
//  Vendors and packages
// ---------------------------------------------------------------------------

export async function saveBgvVendorAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const name = str(f, "name");
  if (!name) return { ok: false, message: "Name the vendor.", errors: { name: "Required" } };
  const slaDays = num(f, "slaDays") ?? 7;
  if (Number.isNaN(slaDays) || slaDays < 1 || slaDays > 90) return NO("Turnaround must be 1 to 90 days.");
  const checkTypes = list(f, "checkTypes").filter((c) => CHECKS.includes(c));
  const costPerCheck: Record<string, number> = {};
  for (const c of CHECKS) {
    const v = num(f, `cost_${c}`);
    if (v === null) continue;
    if (Number.isNaN(v) || v < 0) return NO(`The rate for ${c.toLowerCase()} must be zero or more.`);
    costPerCheck[c] = v;
  }
  const stages = str(f, "stages").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const id = str(f, "id");
  const data = { name: name.slice(0, 120), contactEmail: str(f, "contactEmail") || null, slaDays: Math.round(slaDays), checkTypes, costPerCheck, stages, isActive: str(f, "isActive") !== "false" };
  let row;
  if (id) {
    const cur = await prisma.bgvVendor.findFirst({ where: { id, tenantId: viewer.tenantId } });
    if (!cur) return NO("Vendor not found.");
    row = await prisma.bgvVendor.update({ where: { id }, data });
  } else row = await prisma.bgvVendor.create({ data: { tenantId: viewer.tenantId, ...data } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "BgvVendor", entityId: row.id, summary: `${id ? "Updated" : "Added"} verification vendor ${row.name}`, newValue: data });
  return done(PATHS, id ? "Vendor updated." : "Vendor added.");
}

export async function saveBgvPackageAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const name = str(f, "name");
  if (!name) return { ok: false, message: "Name the package.", errors: { name: "Required" } };
  const checkTypes = list(f, "checkTypes").filter((c) => CHECKS.includes(c));
  if (!checkTypes.length) return NO("Pick at least one check.");
  const vendorId = str(f, "vendorId") || null;
  if (vendorId && !(await prisma.bgvVendor.count({ where: { id: vendorId, tenantId: viewer.tenantId } }))) return NO("Vendor not found.");
  const slaDays = num(f, "slaDays");
  if (slaDays !== null && (Number.isNaN(slaDays) || slaDays < 1)) return NO("Turnaround must be at least a day.");
  const id = str(f, "id");
  const data = { name: name.slice(0, 120), description: str(f, "description") || null, checkTypes, vendorId, slaDays: slaDays ?? null, isActive: str(f, "isActive") !== "false" };
  let row;
  if (id) {
    if (!(await prisma.bgvPackage.count({ where: { id, tenantId: viewer.tenantId } }))) return NO("Package not found.");
    row = await prisma.bgvPackage.update({ where: { id }, data });
  } else row = await prisma.bgvPackage.create({ data: { tenantId: viewer.tenantId, ...data } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: id ? "UPDATE" : "CREATE", entityType: "BgvPackage", entityId: row.id, summary: `${id ? "Updated" : "Created"} verification package ${row.name} (${checkTypes.join(", ")})` });
  return done(PATHS, id ? "Package updated." : "Package created.");
}

// ---------------------------------------------------------------------------
//  Cases
// ---------------------------------------------------------------------------

/** Open a case with one record per check, a vendor, a priority and an SLA; ask for consent. */
export async function startBgvCaseAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const emp = await scopedEmployee(viewer, str(f, "employeeId"), P.BGV_MANAGE);
  if (!emp) return { ok: false, message: "Pick an employee in your scope.", errors: { employeeId: "Required" } };
  if (await prisma.bgvCheck.count({ where: { tenantId: viewer.tenantId, employeeId: emp.id, status: { in: ["INITIATED", "IN_PROGRESS"] } } })) return NO(`${emp.displayName} already has an open verification case.`);
  const pkg = str(f, "packageId") ? await prisma.bgvPackage.findFirst({ where: { id: str(f, "packageId"), tenantId: viewer.tenantId, isActive: true } }) : null;
  if (str(f, "packageId") && !pkg) return NO("Package not found.");
  const checks = [...new Set([...(pkg?.checkTypes ?? []), ...list(f, "checks")])].filter((c) => CHECKS.includes(c));
  if (!checks.length) return NO("Pick a package or at least one check.");
  const vendorId = str(f, "vendorId") || pkg?.vendorId || null;
  const vendor = vendorId ? await prisma.bgvVendor.findFirst({ where: { id: vendorId, tenantId: viewer.tenantId } }) : null;
  if (vendorId && !vendor) return NO("Vendor not found.");
  const priority = str(f, "priority") || "NORMAL";
  if (!(BGV_PRIORITIES as readonly string[]).includes(priority)) return NO("Pick a priority.");
  const s = await joinSettings(viewer.tenantId);
  const slaDays = num(f, "slaDays") ?? pkg?.slaDays ?? vendor?.slaDays ?? s.bgvDefaultSlaDays;
  if (Number.isNaN(slaDays) || slaDays < 1) return NO("The SLA must be at least a day.");
  const now = new Date();
  const slaDueAt = new Date(now.getTime() + slaDays * DAY);
  const rates = vendor?.costPerCheck ?? null;
  const c = await prisma.bgvCheck.create({
    data: {
      tenantId: viewer.tenantId, employeeId: emp.id, vendor: vendor?.name ?? (str(f, "vendor") || null), vendorId: vendor?.id ?? null, packageId: pkg?.id ?? null,
      checkTypes: checks, priority, slaDueAt, assigneeUserId: viewer.user.id, consentRequestedAt: now,
      items: { create: checks.map((checkType) => ({ tenantId: viewer.tenantId, checkType, slaDueAt, vendorStage: vendor?.stages[0] ?? null, cost: bgvCostFor(rates, [checkType]) || null })) },
    },
  });
  await bgvEvent(viewer.tenantId, c.id, "OPENED", `${checks.length} check(s)${vendor ? ` with ${vendor.name}` : ""}, due ${slaDueAt.toISOString().slice(0, 10)}`, viewer.user.id);
  await notify({ tenantId: viewer.tenantId, userIds: [emp.userId], kind: "LIFECYCLE", title: "Please consent to your background verification", body: `Checks: ${checks.map((x) => x.toLowerCase()).join(", ")}.`, link: "/me/onboarding#verification", email: true });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "BgvCheck", entityId: c.id, summary: `Opened a verification case for ${emp.displayName}: ${checks.join(", ")}`, newValue: { checks, vendor: vendor?.name, priority, slaDays } });
  return done(PATHS, "Case opened and consent requested.");
}

/** Work one check: capture its data, move its stage/status, record a reason code. Adverse outcomes go to review. */
export async function updateBgvItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const item = await prisma.bgvCheckItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!item) return NO("Check not found.");
  const c = await caseInScope(viewer, item.bgvCheckId);
  if (!c) return NO("Check not found.");
  if (!["INITIATED", "IN_PROGRESS"].includes(c.status)) return NO("The case is closed. Amend the result instead.");
  if (item.status === "PENDING_REVIEW") return NO("This check is waiting for review.");
  const status = str(f, "status") || item.status;
  if (!(BGV_ITEM_STATUSES as readonly string[]).includes(status) || status === "PENDING_REVIEW") return NO("Pick a status.");
  const details: Record<string, string> = { ...((item.details ?? {}) as Record<string, string>) };
  for (const fl of BGV_CHECK_FIELDS[item.checkType] ?? []) { const v = str(f, `d_${fl.key}`); if (v) details[fl.key] = v.slice(0, 300); }
  const reasonCode = str(f, "reasonCode") || null;
  if (reasonCode && !BGV_REASON_CODES[reasonCode]) return NO("Pick a reason code.");
  const adverse = BGV_ADVERSE.includes(status);
  if (adverse && !reasonCode) return { ok: false, message: "An adverse outcome needs a reason code.", errors: { reasonCode: "Required" } };
  const sev = str(f, "severity") || bgvSeverityFor(reasonCode);
  if (sev && !(BGV_SEVERITIES as readonly string[]).includes(sev)) return NO("Pick a severity.");
  const vendorStage = str(f, "vendorStage") || item.vendorStage;
  const findings = str(f, "findings") || item.findings;
  const base = { details, reasonCode, severity: adverse ? sev : null, findings, vendorStage };
  if (adverse) {
    await prisma.bgvCheckItem.update({ where: { id: item.id }, data: { ...base, status: "PENDING_REVIEW", proposedStatus: status } });
    const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "BGV_CHECK_ITEM", entityId: item.id, title: `Confirm ${item.checkType.toLowerCase()} check: ${status.toLowerCase().replace(/_/g, " ")} — ${c.employee?.displayName ?? ""}`, details: `${BGV_REASON_CODES[reasonCode!]!.label} (${sev})${findings ? `: ${findings}` : ""}`, requesterUserId: viewer.user.id, subjectEmployeeId: c.employeeId });
    if (!wf.ok) { await prisma.bgvCheckItem.update({ where: { id: item.id }, data: { status: item.status, proposedStatus: null } }); return NO(wf.message); }
    await prisma.bgvCheckItem.update({ where: { id: item.id }, data: { workflowRequestId: wf.requestId } });
    await bgvEvent(viewer.tenantId, c.id, "CHECK_FLAGGED", `${item.checkType.toLowerCase()}: ${status.toLowerCase().replace(/_/g, " ")} (${reasonCode}, ${sev}) sent for review`, viewer.user.id);
    if (sev === "CRITICAL") await escalateBgvCase(viewer.tenantId, c.id, viewer.user.id, `Critical finding on the ${item.checkType.toLowerCase()} check: ${BGV_REASON_CODES[reasonCode!]!.label}`);
  } else {
    const closing = ["VERIFIED", "WAIVED"].includes(status);
    await prisma.bgvCheckItem.update({ where: { id: item.id }, data: { ...base, status, completedAt: closing ? new Date() : null } });
    if (status !== item.status) await bgvEvent(viewer.tenantId, c.id, "CHECK_UPDATED", `${item.checkType.toLowerCase()}: ${item.status.toLowerCase()} → ${status.toLowerCase().replace(/_/g, " ")}${vendorStage ? ` (${vendorStage})` : ""}`, viewer.user.id);
  }
  if (c.status === "INITIATED") await prisma.bgvCheck.update({ where: { id: c.id }, data: { status: "IN_PROGRESS" } });
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheckItem", entityId: item.id, summary: `${c.employee?.displayName}: ${item.checkType} check ${adverse ? `flagged ${status} for review` : `set to ${status}`}`, newValue: { status, reasonCode, severity: sev, vendorStage } });
  return done([...PATHS, `/onboarding/verification/${c.id}`], adverse ? "Sent for review." : "Check updated.");
}

/** Run a closed check again (a new record linked to the old one). */
export async function recheckBgvItemAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const item = await prisma.bgvCheckItem.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!item) return NO("Check not found.");
  const c = await caseInScope(viewer, item.bgvCheckId);
  if (!c) return NO("Check not found.");
  if (BGV_ITEM_OPEN.includes(item.status)) return NO("That check is still open.");
  const reason = str(f, "reason");
  if (!reason) return NO("Say why the check is being run again.");
  const s = await joinSettings(viewer.tenantId);
  const slaDueAt = new Date(Date.now() + s.bgvDefaultSlaDays * DAY);
  const n = await prisma.bgvCheckItem.create({ data: { tenantId: viewer.tenantId, bgvCheckId: c.id, checkType: item.checkType, details: item.details ?? Prisma.DbNull, recheckOfId: item.id, slaDueAt, cost: item.cost } });
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { status: "IN_PROGRESS", completedAt: null, proposedStatus: null, ...(c.slaDueAt && c.slaDueAt < slaDueAt ? { slaDueAt } : {}) } });
  await bgvEvent(viewer.tenantId, c.id, "RECHECK", `${item.checkType.toLowerCase()} rechecked: ${reason}`, viewer.user.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "BgvCheckItem", entityId: n.id, summary: `Recheck of the ${item.checkType} check for ${c.employee?.displayName}: ${reason}` });
  return done([...PATHS, `/onboarding/verification/${c.id}`], "Recheck opened; the case is back in progress.");
}

/** Add a document to the case's evidence repository. */
export async function uploadBgvEvidenceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const c = await caseInScope(viewer, str(f, "caseId"));
  if (!c) return NO("Case not found.");
  const file = f.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || file.size === 0) return { ok: false, message: "Attach a file.", errors: { file: "Required" } };
  const data = Buffer.from(await file.arrayBuffer());
  const sniff = sniffUpload(data, file.type);
  if (!sniff.ok) return NO(sniff.reason);
  const itemId = str(f, "itemId");
  if (itemId && !c.items.some((i) => i.id === itemId)) return NO("Check not found.");
  const stored = await saveFile({ tenantId: viewer.tenantId, filename: file.name || "evidence.pdf", mimeType: sniff.mimeType, data, relatedType: "BgvReport", relatedId: itemId || c.id, employeeId: c.employeeId, uploadedBy: viewer.user.id });
  const label = str(f, "label") || stored.filename;
  if (!c.reportUrl) await prisma.bgvCheck.update({ where: { id: c.id }, data: { reportUrl: `/files/${stored.id}` } });
  await bgvEvent(viewer.tenantId, c.id, "EVIDENCE", `${label} [file:${stored.id}]`, viewer.user.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "CREATE", entityType: "BgvCheck", entityId: c.id, summary: `Added evidence "${label}" to ${c.employee?.displayName}'s verification` });
  return done([`/onboarding/verification/${c.id}`], "Evidence added.");
}

/** Propose the closing result; it takes effect once a verification approver signs off. */
export async function proposeBgvResultAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const c = await caseInScope(viewer, str(f, "id"));
  if (!c) return NO("Case not found.");
  if (!["INITIATED", "IN_PROGRESS"].includes(c.status)) return NO("The case is already closed.");
  if (c.proposedStatus) return NO("A result is already waiting for approval.");
  const current = c.items.filter((i) => !c.items.some((n) => n.recheckOfId === i.id));
  if (c.items.length && current.some((i) => BGV_ITEM_OPEN.includes(i.status))) return NO("Finish every check first.");
  const status = str(f, "status") || (c.items.length ? bgvRollup(current) : "");
  if (!["CLEAR", "DISCREPANCY", "FAILED"].includes(status)) return NO("Pick the result.");
  const findings = str(f, "findings") || c.findings;
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { proposedStatus: status, findings } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "BGV_RESULT", entityId: c.id, title: `Verification result for ${c.employee?.displayName}: ${status.toLowerCase()}`, details: findings, requesterUserId: viewer.user.id, subjectEmployeeId: c.employeeId });
  if (!wf.ok) { await prisma.bgvCheck.update({ where: { id: c.id }, data: { proposedStatus: null } }); return NO(wf.message); }
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { resultWorkflowRequestId: wf.requestId } });
  await bgvEvent(viewer.tenantId, c.id, "RESULT_PROPOSED", `Proposed ${status.toLowerCase()}`, viewer.user.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheck", entityId: c.id, summary: `Proposed result ${status} for ${c.employee?.displayName}` });
  return done([...PATHS, `/onboarding/verification/${c.id}`], wf.message === "Approved automatically." ? "Result approved." : "Sent for approval.");
}

/** Amend a closed result (with a reason) — it is re-approved before it changes. */
export async function amendBgvResultAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const c = await caseInScope(viewer, str(f, "id"));
  if (!c) return NO("Case not found.");
  if (!["CLEAR", "DISCREPANCY", "FAILED"].includes(c.status)) return NO("Only a closed result can be amended.");
  if (c.proposedStatus) return NO("An amendment is already waiting for approval.");
  const status = str(f, "status"), reason = str(f, "reason");
  if (!["CLEAR", "DISCREPANCY", "FAILED"].includes(status)) return NO("Pick the amended result.");
  if (!reason) return { ok: false, message: "Give the reason for the amendment.", errors: { reason: "Required" } };
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { proposedStatus: status, amendedAt: new Date(), findings: `${c.findings ? `${c.findings}\n` : ""}Amendment: ${reason}` } });
  const wf = await startWorkflow({ tenantId: viewer.tenantId, entityType: "BGV_RESULT", entityId: c.id, title: `Amend verification result for ${c.employee?.displayName}: ${c.status.toLowerCase()} → ${status.toLowerCase()}`, details: reason, requesterUserId: viewer.user.id, subjectEmployeeId: c.employeeId });
  if (!wf.ok) { await prisma.bgvCheck.update({ where: { id: c.id }, data: { proposedStatus: null } }); return NO(wf.message); }
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { resultWorkflowRequestId: wf.requestId } });
  await bgvEvent(viewer.tenantId, c.id, "AMENDMENT", `${c.status.toLowerCase()} → ${status.toLowerCase()}: ${reason}`, viewer.user.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheck", entityId: c.id, summary: `Proposed amending ${c.employee?.displayName}'s result from ${c.status} to ${status}: ${reason}` });
  return done([...PATHS, `/onboarding/verification/${c.id}`], "Amendment sent for approval.");
}

/** Reassign, reprioritise, escalate, re-request consent or cancel. */
export async function bgvCaseOpAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.BGV_MANAGE);
  const c = await caseInScope(viewer, str(f, "id"));
  if (!c) return NO("Case not found.");
  const op = str(f, "op");
  const open = ["INITIATED", "IN_PROGRESS"].includes(c.status);
  let msg = "Updated.";
  if (op === "reassign") {
    const to = str(f, "assigneeUserId");
    const u = await prisma.user.findFirst({ where: { id: to, tenantId: viewer.tenantId } });
    if (!u) return NO("Pick a colleague.");
    await prisma.bgvCheck.update({ where: { id: c.id }, data: { assigneeUserId: u.id } });
    await notify({ tenantId: viewer.tenantId, userIds: [u.id], kind: "LIFECYCLE", title: `Verification case assigned to you: ${c.employee?.displayName}`, link: `/onboarding/verification/${c.id}` });
    await bgvEvent(viewer.tenantId, c.id, "REASSIGNED", `Assigned to ${u.email}`, viewer.user.id);
    msg = "Reassigned.";
  } else if (op === "priority") {
    const p = str(f, "priority");
    if (!(BGV_PRIORITIES as readonly string[]).includes(p)) return NO("Pick a priority.");
    await prisma.bgvCheck.update({ where: { id: c.id }, data: { priority: p } });
    await bgvEvent(viewer.tenantId, c.id, "PRIORITY", `Priority ${c.priority.toLowerCase()} → ${p.toLowerCase()}`, viewer.user.id);
  } else if (op === "escalate") {
    const r = await escalateBgvCase(viewer.tenantId, c.id, viewer.user.id, str(f, "reason") || "Escalated by verification HR");
    msg = r.message;
  } else if (op === "consent") {
    if (!open) return NO("The case is closed.");
    await prisma.bgvCheck.update({ where: { id: c.id }, data: { consentRequestedAt: new Date() } });
    await notify({ tenantId: viewer.tenantId, userIds: [c.employee?.userId], kind: "LIFECYCLE", title: "Please renew your background verification consent", link: "/me/onboarding#verification", email: true });
    await bgvEvent(viewer.tenantId, c.id, "CONSENT_REQUESTED", "Consent requested", viewer.user.id);
    msg = "Consent requested.";
  } else if (op === "cancel") {
    if (!open) return NO("The case is already closed.");
    await prisma.bgvCheck.update({ where: { id: c.id }, data: { status: "CANCELLED", completedAt: new Date() } });
    await bgvEvent(viewer.tenantId, c.id, "CANCELLED", str(f, "reason") || null, viewer.user.id);
    msg = "Case cancelled.";
  } else return NO("Unknown action.");
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheck", entityId: c.id, summary: `${c.employee?.displayName}'s verification: ${op}` });
  return done([...PATHS, `/onboarding/verification/${c.id}`], msg);
}

/** The hire gives (or renews) consent for their own verification. */
export async function giveBgvConsentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return NO("No employee record.");
  const c = await prisma.bgvCheck.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, employeeId: viewer.employee.id } });
  if (!c) return NO("Verification not found.");
  if (!["INITIATED", "IN_PROGRESS"].includes(c.status)) return NO("This verification is closed.");
  if (str(f, "agree") !== "on" && str(f, "agree") !== "true") return { ok: false, message: "Tick the box to give consent.", errors: { agree: "Required" } };
  const s = await joinSettings(viewer.tenantId);
  const now = new Date();
  await prisma.bgvCheck.update({ where: { id: c.id }, data: { consentGivenAt: now, consentExpiresAt: new Date(now.getTime() + s.bgvConsentValidDays * DAY) } });
  await bgvEvent(viewer.tenantId, c.id, "CONSENT_GIVEN", `Valid for ${s.bgvConsentValidDays} days`, viewer.user.id);
  await writeAudit(viewer, { module: "LIFECYCLE", action: "UPDATE", entityType: "BgvCheck", entityId: c.id, summary: "Gave consent for background verification" });
  return done(PATHS, "Thank you — consent recorded.");
}
