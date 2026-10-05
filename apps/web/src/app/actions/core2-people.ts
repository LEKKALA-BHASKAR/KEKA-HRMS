"use server";

import { createHash, randomInt } from "node:crypto";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import {
  startWorkflow, withdrawWorkflow, PRIVACY_REQUEST_KINDS, privacyDueDate, MUTABLE_NOTIFICATION_KINDS, NOMINEE_BENEFITS, nomineeShareIssues,
  pickQcSample, runHrOpsChecks, queueManagerDigest, MANAGER_DIGEST_SECTIONS, setRoster, editAttendanceDay, EDITABLE_STATUSES, type RosterValue,
} from "@keka/services";
import { requireAuth, requireViewer, can } from "@/lib/context";
import { isHrFor, managedTeam } from "@/lib/core-hr";
import { z, parseForm, writeAudit, actionDone as done, formList, zName, zOptional, zId, zBool, zNumber, zDate, zRequiredDate, type ActionState } from "@/lib/forms";

const P = PERMISSIONS;

/**
 * Employee master data and self-service, second pass: profile extras
 * (salutation, pronouns, languages, work address), identifiers and
 * nationality history, nominee shares, personal-email verification,
 * privacy settings and requests, ID card requests, personal preferences;
 * HR quality checks and exception alerts; manager rostering and
 * attendance correction for their own team; and editing a scheduled move.
 */

const DAY = 86_400_000;
const today = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };

/** HR for the employee, or the employee themself when `selfOk`. */
async function canEditPerson(viewer: Awaited<ReturnType<typeof requireViewer>>, employeeId: string, selfOk: boolean): Promise<boolean> {
  if (selfOk && viewer.employee?.id === employeeId) return true;
  return isHrFor(viewer, employeeId);
}

const paths = (employeeId: string) => [`/employees/${employeeId}/master`, `/employees/${employeeId}`, "/me/profile", "/me/privacy"];

// ---------------------------------------------------------------------------
//  Profile extras
// ---------------------------------------------------------------------------

const extraSchema = z.object({
  employeeId: zId(), salutation: z.enum(["", "Mr", "Ms", "Mrs", "Mx", "Dr", "Prof"]).optional().transform((v) => v || null),
  pronouns: zOptional(30), languages: zOptional(300),
  workAddressLine1: zOptional(160), workAddressLine2: zOptional(160), workCity: zOptional(80), workState: zOptional(80), workPostalCode: zOptional(12), workAddressNote: zOptional(200),
});

/**
 * Salutation, pronouns and languages are the employee's own to set; a work
 * address that differs from the office location is set by HR.
 */
export async function saveProfileExtraAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(extraSchema, formData);
  if (parsed.state) return parsed.state;
  const { employeeId, languages, ...d } = parsed.data;
  const self = viewer.employee?.id === employeeId;
  const hr = await isHrFor(viewer, employeeId);
  if (!self && !hr) return { ok: false, message: "You can change your own profile, or the profiles of people you look after." };
  const langs = [...new Set((languages ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 12);
  const personal = { salutation: d.salutation, pronouns: d.pronouns, languages: langs };
  const address = { workAddressLine1: d.workAddressLine1, workAddressLine2: d.workAddressLine2, workCity: d.workCity, workState: d.workState, workPostalCode: d.workPostalCode, workAddressNote: d.workAddressNote };
  const touchesAddress = Object.values(address).some((v) => v);
  if (touchesAddress && !hr) return { ok: false, message: "A work address override is set by HR." };
  const before = await prisma.employeeProfileExtra.findUnique({ where: { employeeId } });
  const data = hr ? { ...personal, ...address } : personal;
  await prisma.employeeProfileExtra.upsert({ where: { employeeId }, create: { tenantId: viewer.tenantId, employeeId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeProfileExtra", entityId: employeeId, summary: `${self ? "Updated own" : "Updated"} salutation, pronouns, languages${hr ? " and work address" : ""}`, oldValue: before ? { salutation: before.salutation, pronouns: before.pronouns, languages: before.languages, workCity: before.workCity } : null, newValue: data });
  return done(paths(employeeId), "Saved.");
}

// ---------------------------------------------------------------------------
//  Nationality history and identifiers
// ---------------------------------------------------------------------------

/** Change nationality from a date; the previous one is kept in the history. */
export async function changeNationalityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ employeeId: zId(), nationality: zName(60), validFrom: zRequiredDate(), note: zOptional(300) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await isHrFor(viewer, d.employeeId))) return { ok: false, message: "This employee is outside the people you look after." };
  const emp = await prisma.employee.findFirst({ where: { id: d.employeeId, tenantId: viewer.tenantId }, select: { nationality: true, dateOfBirth: true, dateOfJoining: true, displayName: true } });
  if (!emp) return { ok: false, message: "Employee not found." };
  if (emp.nationality && emp.nationality.toLowerCase() === d.nationality.toLowerCase()) return { ok: false, message: `${emp.displayName} is already ${emp.nationality}.` };
  if (d.validFrom > today()) return { ok: false, message: "Record a nationality change once it has happened." };
  const open = await prisma.nationalityHistory.findFirst({ where: { tenantId: viewer.tenantId, employeeId: d.employeeId, validTo: null }, orderBy: { validFrom: "desc" } });
  if (open && d.validFrom <= open.validFrom) return { ok: false, message: "The change must be after the current nationality's start." };
  await prisma.$transaction(async (tx) => {
    if (open) await tx.nationalityHistory.update({ where: { id: open.id }, data: { validTo: new Date(d.validFrom.getTime() - DAY) } });
    else if (emp.nationality) await tx.nationalityHistory.create({ data: { tenantId: viewer.tenantId, employeeId: d.employeeId, nationality: emp.nationality, validFrom: emp.dateOfBirth ?? emp.dateOfJoining, validTo: new Date(d.validFrom.getTime() - DAY), note: "Recorded before the change", changedBy: viewer.user.id } });
    await tx.nationalityHistory.create({ data: { tenantId: viewer.tenantId, employeeId: d.employeeId, nationality: d.nationality, validFrom: d.validFrom, note: d.note, changedBy: viewer.user.id } });
    await tx.employee.update({ where: { id: d.employeeId }, data: { nationality: d.nationality } });
  });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "NationalityHistory", entityId: d.employeeId, summary: `${emp.displayName}: nationality ${emp.nationality ?? "—"} → ${d.nationality} from ${d.validFrom.toISOString().slice(0, 10)}`, oldValue: { nationality: emp.nationality }, newValue: { nationality: d.nationality } });
  return done(paths(d.employeeId), "Saved; the previous nationality is kept in the history.");
}

export async function saveEmployeeIdentifierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ employeeId: zId(), kind: z.enum(["ALIAS", "EXTERNAL"]), system: zName(60), value: z.string().trim().min(1, "Required").max(80), validFrom: zDate(), validTo: zDate() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (!(await isHrFor(viewer, d.employeeId))) return { ok: false, message: "This employee is outside the people you look after." };
  const clash = await prisma.employeeIdentifier.findFirst({ where: { tenantId: viewer.tenantId, system: d.system, value: d.value } });
  if (clash && clash.employeeId !== d.employeeId) return { ok: false, message: `${d.system} ${d.value} already belongs to someone else.`, errors: { value: "Already used" } };
  if (d.validFrom && d.validTo && d.validTo < d.validFrom) return { ok: false, message: "Valid-to is before valid-from." };
  const row = clash ? await prisma.employeeIdentifier.update({ where: { id: clash.id }, data: { kind: d.kind, validFrom: d.validFrom, validTo: d.validTo } }) : await prisma.employeeIdentifier.create({ data: { tenantId: viewer.tenantId, ...d, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: clash ? "UPDATE" : "CREATE", entityType: "EmployeeIdentifier", entityId: row.id, summary: `${d.kind === "ALIAS" ? "Alias" : "External ID"} ${d.system}: ${d.value}` });
  return done(paths(d.employeeId), "Saved.");
}

export async function deleteEmployeeIdentifierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const row = await prisma.employeeIdentifier.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row || !(await isHrFor(viewer, row.employeeId))) return { ok: false, message: "Identifier not found." };
  await prisma.employeeIdentifier.delete({ where: { id: row.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "DELETE", entityType: "EmployeeIdentifier", entityId: row.id, summary: `Removed ${row.system} ${row.value}` });
  return done(paths(row.employeeId), "Removed.");
}

// ---------------------------------------------------------------------------
//  Nominee shares
// ---------------------------------------------------------------------------

/**
 * Set every nominee's share of one benefit at once (fields share:<dependentId>),
 * so the shares are checked together and always add up to 100%.
 */
export async function saveNomineeSharesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const employeeId = String(formData.get("employeeId") ?? "") || viewer.employee?.id || "";
  const benefit = String(formData.get("benefit") ?? "");
  if (!(benefit in NOMINEE_BENEFITS)) return { ok: false, message: "Pick the benefit." };
  if (!employeeId || !(await canEditPerson(viewer, employeeId, true))) return { ok: false, message: "You can set your own nominees, or those of people you look after." };
  const deps = await prisma.dependent.findMany({ where: { employeeId, employee: { tenantId: viewer.tenantId } }, select: { id: true, name: true } });
  const rows: Array<{ dependentId: string; benefit: string; sharePct: number }> = [];
  for (const dep of deps) {
    const raw = String(formData.get(`share:${dep.id}`) ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    rows.push({ dependentId: dep.id, benefit, sharePct: Number.isFinite(n) ? n : -1 });
  }
  const issues = nomineeShareIssues(rows.filter((r) => r.sharePct !== 0));
  if (issues.length) return { ok: false, message: issues.join(" ") };
  await prisma.$transaction(async (tx) => {
    await tx.nomineeAllocation.deleteMany({ where: { tenantId: viewer.tenantId, employeeId, benefit } });
    for (const r of rows.filter((x) => x.sharePct > 0)) await tx.nomineeAllocation.create({ data: { tenantId: viewer.tenantId, employeeId, ...r } });
    await tx.dependent.updateMany({ where: { employeeId, id: { in: rows.filter((x) => x.sharePct > 0).map((x) => x.dependentId) } }, data: { isNominee: true } });
  });
  const label = NOMINEE_BENEFITS[benefit as keyof typeof NOMINEE_BENEFITS];
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "NomineeAllocation", entityId: employeeId, summary: `${label} nominees: ${rows.filter((x) => x.sharePct > 0).map((r) => `${deps.find((d) => d.id === r.dependentId)?.name} ${r.sharePct}%`).join(", ") || "cleared"}` });
  return done(["/me/nominees", ...paths(employeeId)], `Saved ${label} nominees.`);
}

// ---------------------------------------------------------------------------
//  Personal email verification
// ---------------------------------------------------------------------------

const hashCode = (employeeId: string, code: string) => createHash("sha256").update(`${employeeId}:${code}`).digest("hex");

/** Email a six-digit code to the personal address on file. */
export async function sendPersonalEmailCodeAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees have a personal email on file." };
  const emp = await prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { personalEmail: true } });
  if (!emp?.personalEmail) return { ok: false, message: "Add a personal email to your profile first." };
  const extra = await prisma.employeeProfileExtra.findUnique({ where: { employeeId: viewer.employee.id } });
  if (extra?.emailCodeExpires && extra.emailCodeExpires.getTime() - 9 * 60_000 > Date.now()) return { ok: false, message: "A code was sent a moment ago. Wait a minute before asking again." };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const data = { emailCodeHash: hashCode(viewer.employee.id, code), emailCodeExpires: new Date(Date.now() + 10 * 60_000), emailCodeAttempts: 0 };
  await prisma.employeeProfileExtra.upsert({ where: { employeeId: viewer.employee.id }, create: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, ...data }, update: data });
  await prisma.emailOutbox.create({ data: { tenantId: viewer.tenantId, toAddress: emp.personalEmail, subject: "Your BooS-HR verification code", textBody: `Your code to verify this email address in BooS-HR is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`, relatedType: "PersonalEmailVerification", relatedId: viewer.employee.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeProfileExtra", entityId: viewer.employee.id, summary: "Sent a personal email verification code" });
  return done(["/me/privacy"], `We emailed a code to ${emp.personalEmail.replace(/^(.).*(@.*)$/, "$1…$2")}.`);
}

export async function verifyPersonalEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees have a personal email on file." };
  const code = String(formData.get("code") ?? "").trim();
  const [extra, emp] = await Promise.all([
    prisma.employeeProfileExtra.findUnique({ where: { employeeId: viewer.employee.id } }),
    prisma.employee.findUnique({ where: { id: viewer.employee.id }, select: { personalEmail: true } }),
  ]);
  if (!extra?.emailCodeHash || !extra.emailCodeExpires || extra.emailCodeExpires < new Date()) return { ok: false, message: "The code has expired. Ask for a new one." };
  if (extra.emailCodeAttempts >= 5) return { ok: false, message: "Too many wrong codes. Ask for a new one." };
  if (!/^\d{6}$/.test(code) || hashCode(viewer.employee.id, code) !== extra.emailCodeHash) {
    await prisma.employeeProfileExtra.update({ where: { id: extra.id }, data: { emailCodeAttempts: { increment: 1 } } });
    return { ok: false, message: "That code is not right.", errors: { code: "Wrong code" } };
  }
  await prisma.employeeProfileExtra.update({ where: { id: extra.id }, data: { personalEmailVerifiedAt: new Date(), verifiedEmail: emp?.personalEmail ?? null, emailCodeHash: null, emailCodeExpires: null, emailCodeAttempts: 0 } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeProfileExtra", entityId: viewer.employee.id, summary: "Verified personal email address" });
  return done(["/me/privacy", "/me/profile"], "Your personal email is verified.");
}

// ---------------------------------------------------------------------------
//  Privacy settings and requests
// ---------------------------------------------------------------------------

/** What colleagues see of me in the directory and on my profile. */
export async function savePrivacySettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees have a profile." };
  const d = { hideMobile: formData.get("hideMobile") === "on", hideBirthday: formData.get("hideBirthday") === "on", hidePersonalEmail: formData.get("hidePersonalEmail") === "on" };
  await prisma.employeeProfileExtra.upsert({ where: { employeeId: viewer.employee.id }, create: { tenantId: viewer.tenantId, employeeId: viewer.employee.id, ...d }, update: d });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "EmployeeProfileExtra", entityId: viewer.employee.id, summary: `Privacy: ${Object.entries(d).filter(([, v]) => v).map(([k]) => k.replace("hide", "hide ").toLowerCase()).join(", ") || "nothing hidden"}`, newValue: d });
  return done(["/me/privacy", "/directory"], "Saved your privacy settings.");
}

export async function raisePrivacyRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees can raise a privacy request." };
  const parsed = parseForm(z.object({ kind: z.enum(Object.keys(PRIVACY_REQUEST_KINDS) as [string, ...string[]]), details: z.string().trim().min(5, "Tell us a little more").max(2000) }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data, me = viewer.employee.id;
  if (await prisma.privacyRequest.findFirst({ where: { tenantId: viewer.tenantId, employeeId: me, kind: d.kind, status: "PENDING" } })) return { ok: false, message: "You already have one of these open." };
  const raised = new Date();
  const row = await prisma.privacyRequest.create({ data: { tenantId: viewer.tenantId, employeeId: me, requesterUserId: viewer.user.id, kind: d.kind, details: d.details, dueDate: privacyDueDate(d.kind, raised) } });
  const res = await startWorkflow({ tenantId: viewer.tenantId, entityType: d.kind === "DIRECTORY_HIDE" ? "DIRECTORY_LISTING" : "PRIVACY_REQUEST", entityId: row.id, title: `${PRIVACY_REQUEST_KINDS[d.kind as keyof typeof PRIVACY_REQUEST_KINDS]} — ${viewer.employee.displayName}`, details: d.details, requesterUserId: viewer.user.id, subjectEmployeeId: me });
  if (!res.ok) { await prisma.privacyRequest.delete({ where: { id: row.id } }); return { ok: false, message: res.message }; }
  await prisma.privacyRequest.update({ where: { id: row.id }, data: { workflowRequestId: res.requestId ?? null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "PrivacyRequest", entityId: row.id, summary: `Raised a privacy request (${d.kind.toLowerCase().replace("_", " ")})` });
  return done(["/me/privacy", "/inbox"], `Sent. You will hear back by ${row.dueDate.toISOString().slice(0, 10)}.`);
}

export async function withdrawPrivacyRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const row = await prisma.privacyRequest.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, requesterUserId: viewer.user.id, status: "PENDING" } });
  if (!row?.workflowRequestId) return { ok: false, message: "Open request not found." };
  const res = await withdrawWorkflow({ tenantId: viewer.tenantId, requestId: row.workflowRequestId, userId: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "PrivacyRequest", entityId: row.id, summary: "Withdrew a privacy request" });
  return done(["/me/privacy"], "Withdrawn.");
}

/** Compliance closes an approved access / rectification / erasure / restriction request with what was done. */
export async function completePrivacyRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.COMPLIANCE_MANAGE);
  const row = await prisma.privacyRequest.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, status: "APPROVED" } });
  if (!row) return { ok: false, message: "Approved request not found." };
  const response = String(formData.get("response") ?? "").trim();
  if (response.length < 5) return { ok: false, message: "Say what was done.", errors: { response: "Required" } };
  await prisma.privacyRequest.update({ where: { id: row.id }, data: { status: "COMPLETED", response: response.slice(0, 2000), closedAt: new Date() } });
  const emp = await prisma.employee.findUnique({ where: { id: row.employeeId }, select: { userId: true } });
  if (emp?.userId) await prisma.notification.create({ data: { tenantId: viewer.tenantId, userId: emp.userId, title: "Your privacy request is complete", body: response.slice(0, 300), link: "/me/privacy", kind: "WORKFLOW" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "PrivacyRequest", entityId: row.id, summary: `Completed a privacy request (${row.kind.toLowerCase()})` });
  return done(["/hr-ops/quality?tab=privacy", "/me/privacy"], "Completed; the employee was told.");
}

// ---------------------------------------------------------------------------
//  ID card requests
// ---------------------------------------------------------------------------

export async function requestIdCardAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees have an ID card." };
  const parsed = parseForm(z.object({ reason: z.enum(["NEW", "LOST", "DAMAGED", "DETAILS_CHANGED"]), note: zOptional(300) }), formData);
  if (parsed.state) return parsed.state;
  const me = viewer.employee.id;
  if (await prisma.idCardRequest.findFirst({ where: { tenantId: viewer.tenantId, employeeId: me, status: "PENDING" } })) return { ok: false, message: "You already have a card request waiting." };
  const row = await prisma.idCardRequest.create({ data: { tenantId: viewer.tenantId, employeeId: me, ...parsed.data } });
  const res = await startWorkflow({ tenantId: viewer.tenantId, entityType: "ID_CARD_REQUEST", entityId: row.id, title: `ID card (${parsed.data.reason.toLowerCase().replace("_", " ")}) — ${viewer.employee.displayName}`, details: parsed.data.note, requesterUserId: viewer.user.id, subjectEmployeeId: me });
  if (!res.ok) { await prisma.idCardRequest.delete({ where: { id: row.id } }); return { ok: false, message: res.message }; }
  await prisma.idCardRequest.update({ where: { id: row.id }, data: { workflowRequestId: res.requestId ?? null } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "IdCardRequest", entityId: row.id, summary: `Requested an ID card (${parsed.data.reason.toLowerCase()})` });
  return done(["/me/id-card", "/inbox"], "Requested. HR will issue the card once it is approved.");
}

export async function withdrawIdCardRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const row = await prisma.idCardRequest.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, employeeId: viewer.employee?.id ?? "-", status: "PENDING" } });
  if (!row?.workflowRequestId) return { ok: false, message: "Open request not found." };
  const res = await withdrawWorkflow({ tenantId: viewer.tenantId, requestId: row.workflowRequestId, userId: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "IdCardRequest", entityId: row.id, summary: "Withdrew an ID card request" });
  return done(["/me/id-card"], "Withdrawn.");
}

// ---------------------------------------------------------------------------
//  Personal preferences: notifications, digest, accessibility, dashboard
// ---------------------------------------------------------------------------

const DASHBOARD_WIDGETS = ["approvals", "team-today", "upcoming", "profiles", "team"] as const;

export async function savePreferencesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(z.object({
    preferredChannel: z.enum(["BOTH", "IN_APP", "EMAIL"]).default("BOTH"), digestFrequency: z.enum(["NONE", "DAILY", "WEEKLY"]).default("NONE"),
    fontScale: z.enum(["100", "115", "130"]).default("100").transform(Number), highContrast: zBool(), reducedMotion: zBool(), underlineLinks: zBool(),
    locale: z.enum(["", "en-IN", "en-US", "en-GB"]).optional().transform((v) => v || null),
  }), formData);
  if (parsed.state) return parsed.state;
  const kinds = Object.keys(MUTABLE_NOTIFICATION_KINDS);
  const data = {
    ...parsed.data,
    emailMuted: formList(formData, "emailMuted").filter((k) => kinds.includes(k)),
    inAppMuted: formList(formData, "inAppMuted").filter((k) => kinds.includes(k)),
    digestSections: formList(formData, "digestSections").filter((k) => ["approvals", "team-leave", "probation", "documents"].includes(k)),
  };
  await prisma.userPreference.upsert({ where: { userId: viewer.user.id }, create: { tenantId: viewer.tenantId, userId: viewer.user.id, ...data }, update: data });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "UserPreference", entityId: viewer.user.id, summary: `Preferences: ${data.preferredChannel.toLowerCase().replace("_", "-")}, ${data.emailMuted.length + data.inAppMuted.length} muted, digest ${data.digestFrequency.toLowerCase()}`, newValue: data });
  return done(["/me/preferences", "/"], "Saved your preferences.");
}

/** Which widgets a manager sees on the team dashboard. */
export async function saveDashboardLayoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const shown = new Set(formList(formData, "show"));
  const hidden = DASHBOARD_WIDGETS.filter((w) => !shown.has(w));
  await prisma.userPreference.upsert({ where: { userId: viewer.user.id }, create: { tenantId: viewer.tenantId, userId: viewer.user.id, dashboardHidden: hidden }, update: { dashboardHidden: hidden } });
  await writeAudit(viewer, { module: "SYSTEM", action: "UPDATE", entityType: "UserPreference", entityId: viewer.user.id, summary: `Team dashboard: hid ${hidden.length ? hidden.join(", ") : "nothing"}` });
  return done(["/team/dashboard"], "Saved your dashboard.");
}

/** Put together the manager digest now (what the scheduled one would hold) and email it. */
export async function sendManagerDigestAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  if (!viewer.employee) return { ok: false, message: "Only employees get a digest." };
  const pref = await prisma.userPreference.findUnique({ where: { userId: viewer.user.id } });
  const sections = pref?.digestSections.length ? pref.digestSections : MANAGER_DIGEST_SECTIONS;
  const team = [...(await managedTeam(viewer)).keys()];
  if (!team.length) return { ok: false, message: "You have no team to summarise." };
  const user = await prisma.user.findUnique({ where: { id: viewer.user.id }, select: { email: true } });
  if (!(await queueManagerDigest(viewer.tenantId, viewer.user.id, user!.email, team, sections))) return { ok: false, message: "Your digest already went out today." };
  await writeAudit(viewer, { module: "SYSTEM", action: "CREATE", entityType: "ManagerDigest", entityId: viewer.user.id, summary: `Sent a team digest (${sections.length} sections)` });
  return done(["/me/preferences"], `Sent your digest to ${user!.email}.`);
}

// ---------------------------------------------------------------------------
//  HR quality: QC sampling and exception alerts
// ---------------------------------------------------------------------------

/** Pull a random sample of recent employee-record changes for a second person to check. */
export async function drawQcSampleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ days: zNumber({ min: 1, max: 90 }).transform((v) => v ?? 7), pct: zNumber({ min: 1, max: 100 }).transform((v) => v ?? 10) }), formData);
  if (parsed.state) return parsed.state;
  const since = new Date(Date.now() - parsed.data.days * DAY);
  const already = new Set((await prisma.hrQcSample.findMany({ where: { tenantId: viewer.tenantId, sourceType: "AuditLog", createdAt: { gte: since } }, select: { sourceId: true } })).map((s) => s.sourceId));
  const logs = await prisma.auditLog.findMany({ where: { tenantId: viewer.tenantId, module: "EMPLOYEE", action: { in: ["CREATE", "UPDATE", "DELETE"] }, createdAt: { gte: since } }, select: { id: true, summary: true, actorId: true }, orderBy: { createdAt: "desc" }, take: 2000 });
  const pool = logs.filter((l) => !already.has(l.id));
  const pick = pickQcSample(pool, parsed.data.pct);
  if (!pick.length) return { ok: false, message: "No unchecked changes in that period." };
  await prisma.hrQcSample.createMany({ data: pick.map((l) => ({ tenantId: viewer.tenantId, sourceType: "AuditLog", sourceId: l.id, summary: (l.summary ?? "").slice(0, 300), actorId: l.actorId, sampledBy: viewer.user.id })), skipDuplicates: true });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "HrQcSample", entityId: null, summary: `Drew a QC sample: ${pick.length} of ${pool.length} changes from the last ${parsed.data.days} days` });
  return done(["/hr-ops/quality?tab=qc"], `Sampled ${pick.length} of ${pool.length} change(s).`);
}

export async function reviewQcSampleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const row = await prisma.hrQcSample.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId } });
  if (!row) return { ok: false, message: "Sample not found." };
  if (row.actorId === viewer.user.id) return { ok: false, message: "Someone else must check a change you made." };
  const result = String(formData.get("result") ?? "");
  if (!["PASS", "FAIL"].includes(result)) return { ok: false, message: "Pass or fail it." };
  const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
  if (result === "FAIL" && !note) return { ok: false, message: "Say what is wrong.", errors: { note: "Required for a fail" } };
  await prisma.hrQcSample.update({ where: { id: row.id }, data: { result, note, reviewedBy: viewer.user.id, reviewedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: result === "PASS" ? "APPROVE" : "REJECT", entityType: "HrQcSample", entityId: row.id, summary: `QC ${result.toLowerCase()}: ${row.summary.slice(0, 120)}` });
  return done(["/hr-ops/quality?tab=qc"], result === "PASS" ? "Passed." : "Failed; it shows in the QC results.");
}

export async function runHrOpsChecksAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const r = await runHrOpsChecks(viewer.tenantId, viewer.user.id);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HrOpsAlert", entityId: null, summary: `Ran HR exception checks: ${r.opened} new, ${r.resolved} cleared, ${r.open} open` });
  return done(["/hr-ops/desk"], `${r.opened} new alert(s), ${r.resolved} cleared; ${r.open} open.`);
}

export async function resolveHrOpsAlertAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const row = await prisma.hrOpsAlert.findFirst({ where: { id: String(formData.get("id") ?? ""), tenantId: viewer.tenantId, status: "OPEN" } });
  if (!row) return { ok: false, message: "Open alert not found." };
  await prisma.hrOpsAlert.update({ where: { id: row.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "HrOpsAlert", entityId: row.id, summary: `Resolved alert: ${row.message.slice(0, 140)}` });
  return done(["/hr-ops/desk"], "Resolved. It reopens if the next check still finds it.");
}

// ---------------------------------------------------------------------------
//  Manager self-service: roster and attendance for their own team
// ---------------------------------------------------------------------------

async function directTeam(viewer: Awaited<ReturnType<typeof requireViewer>>): Promise<Set<string>> {
  const team = await managedTeam(viewer);
  return new Set([...team].filter(([, link]) => link === "DIRECT" || link === "ACTING").map(([id]) => id));
}

/** A manager sets shifts and offs for their direct (or acting) team. */
export async function managerSaveRosterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const team = await directTeam(viewer);
  if (!team.size) return { ok: false, message: "You have no team to roster." };
  const writes: Array<{ employeeId: string; date: Date; value: RosterValue }> = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("cell:")) continue;
    const [, employeeId, day] = k.split(":");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
    if (!employeeId || !m) return { ok: false, message: "A roster cell was malformed. Reload and try again." };
    if (!team.has(employeeId)) return { ok: false, message: "You can roster only your own team." };
    const val = String(v);
    writes.push({ employeeId, date: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)), value: val === "" ? { kind: "DEFAULT" } : val === "OFF" ? { kind: "OFF" } : { kind: "SHIFT", shiftId: val } });
  }
  const res = await setRoster(viewer.tenantId, writes);
  if (!res.ok) return { ok: false, message: res.message };
  if (res.changed) await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "ShiftAssignment", entityId: null, summary: `Manager rostered their team: ${res.changed} day(s) changed` });
  return done(["/team/roster"], res.message);
}

const markSchema = z.object({ employeeId: zId(), date: zRequiredDate(), status: z.enum(["", "AUTO", ...EDITABLE_STATUSES]).optional().transform((v) => v || null), firstIn: zOptional(5), lastOut: zOptional(5), reason: zName(300) });

/** A manager corrects or marks a direct report's day; the reason is kept with it. */
export async function managerEditAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireViewer();
  const parsed = parseForm(markSchema, formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  if (d.employeeId === viewer.employee?.id) return { ok: false, message: "Ask your manager or HR to change your own attendance." };
  const team = await directTeam(viewer);
  if (!team.has(d.employeeId) && !can(viewer, P.ATTENDANCE_MANAGE)) return { ok: false, message: "You can mark attendance only for your own team." };
  const res = await editAttendanceDay({ employeeId: d.employeeId, date: d.date, status: d.status as never, firstIn: d.firstIn, lastOut: d.lastOut, reason: d.reason, actorUserId: viewer.user.id });
  if (!res.ok) return { ok: false, message: res.message };
  await writeAudit(viewer, { module: "ATTENDANCE", action: "UPDATE", entityType: "AttendanceRecord", entityId: d.employeeId, summary: `Manager edited attendance for ${d.date.toISOString().slice(0, 10)}: ${d.reason}`, oldValue: res.before ?? null, newValue: res.after ?? null });
  return done(["/team/roster", "/team/attendance"], "Saved the day.");
}

// ---------------------------------------------------------------------------
//  Employee movements: change a scheduled move before it takes effect
// ---------------------------------------------------------------------------

export async function editScheduledMoveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAuth(P.EMPLOYEE_UPDATE);
  const parsed = parseForm(z.object({ id: zId(), effectiveFrom: zRequiredDate(), note: zOptional(500), cancel: zBool() }), formData);
  if (parsed.state) return parsed.state;
  const d = parsed.data;
  const c = await prisma.jobChange.findFirst({ where: { id: d.id, tenantId: viewer.tenantId } });
  if (!c || !(await isHrFor(viewer, c.employeeId))) return { ok: false, message: "Move not found." };
  if (!["SCHEDULED", "PENDING_APPROVAL"].includes(c.status)) return { ok: false, message: "Only a move that has not taken effect can be changed." };
  if (d.cancel) {
    if (c.status === "PENDING_APPROVAL") return { ok: false, message: "This move is waiting on approval; withdraw it from the request instead." };
    await prisma.jobChange.update({ where: { id: c.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), note: d.note ?? c.note } });
    await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobChange", entityId: c.id, summary: `Cancelled a scheduled move (${c.reason.toLowerCase().replace(/_/g, " ")}) due ${c.effectiveFrom.toISOString().slice(0, 10)}` });
    return done(["/hr-ops/movements", `/employees/${c.employeeId}`], "Cancelled the move.");
  }
  if (d.effectiveFrom <= today()) return { ok: false, message: "Pick a future date, or let the move apply now." };
  await prisma.jobChange.update({ where: { id: c.id }, data: { effectiveFrom: d.effectiveFrom, note: d.note ?? c.note } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobChange", entityId: c.id, summary: `Moved a scheduled change from ${c.effectiveFrom.toISOString().slice(0, 10)} to ${d.effectiveFrom.toISOString().slice(0, 10)}`, oldValue: { effectiveFrom: c.effectiveFrom }, newValue: { effectiveFrom: d.effectiveFrom } });
  return done(["/hr-ops/movements", `/employees/${c.employeeId}`], "Saved the new date.");
}

