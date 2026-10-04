"use server";

import { headers } from "next/headers";
import { prisma } from "@keka/db";
import {
  newOfferToken, hashOfferToken, offerTokenSigned, openApplicantLink, startHireRequest, usersWithPermission, govAudit, notify, hireDepthConfig, appBaseUrl,
} from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { formValues, safeRevalidate, type ActionState } from "@/lib/forms";
import { closeAsWithdrawn } from "@/lib/hire-depth";

/**
 * Public careers-site actions with no sign-in: job alerts (double opt-in),
 * the talent community, and the applicant portal behind a personal link —
 * update details, ask for a change the hiring team approves, consent to an
 * interview recording, or withdraw.
 */

const WINDOW_MS = 10 * 60_000;
const recent = new Map<string, number[]>();
async function throttled(scope: string, limit = 5): Promise<boolean> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || "unknown";
  const key = `${scope}|${ip}`, now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= limit) return true;
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return false;
}

const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max);
const fail = (message: string, f?: FormData, errors?: Record<string, string>): ActionState => ({ ok: false, message, errors, values: f ? formValues(f) : undefined });
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const secret = () => { const s = process.env.AUTH_SECRET; if (!s) throw new Error("AUTH_SECRET is not set"); return s; };

// ---------------------------------------------------------------------------
//  Job alerts
// ---------------------------------------------------------------------------

export async function subscribeJobAlertAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  if (str(f, "website")) return { ok: true, message: "Check your inbox to confirm the alert." };
  const tenant = await tenantFromHost();
  if (!tenant) return fail("This careers site is not available.");
  if (await throttled(`alert:${tenant.id}`)) return fail("Too many requests just now. Please try again in a few minutes.");
  const email = str(f, "email", 200).toLowerCase();
  if (!EMAIL.test(email)) return fail("Enter a valid email.", f, { email: "Invalid" });
  if (f.get("consent") !== "on") return fail("Please agree to receive job alerts.", f, { consent: "Required" });
  const departmentId = str(f, "departmentId") || null, locationId = str(f, "locationId") || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: tenant.id } }))) return fail("Choose a team from the list.");
  if (locationId && !(await prisma.location.count({ where: { id: locationId, tenantId: tenant.id } }))) return fail("Choose a location from the list.");
  const { token, hash } = newOfferToken(secret());
  const data = { keywords: str(f, "keywords", 120) || null, departmentId, locationId, tokenHash: hash, confirmedAt: null, unsubscribedAt: null };
  await prisma.jobAlertSubscription.upsert({ where: { tenantId_email: { tenantId: tenant.id, email } }, create: { tenantId: tenant.id, email, ...data }, update: data });
  const url = `${appBaseUrl().replace(/\/+$/, "")}/careers/alerts/${token}`;
  await prisma.emailOutbox.create({ data: { tenantId: tenant.id, toAddress: email, subject: `Confirm your job alert at ${tenant.name}`, textBody: `Confirm that you want emails about new roles at ${tenant.name}:\n\n${url}\n\nThe same link lets you unsubscribe at any time. If you did not ask for this, ignore this email.`, relatedType: "JobAlert" } });
  return { ok: true, message: "Check your inbox to confirm the alert." };
}

/** Confirm or stop an alert from the link in the email. */
export async function jobAlertLinkAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const token = str(f, "token", 200);
  if (!offerTokenSigned(token, secret())) return fail("This link is not valid.");
  const sub = await prisma.jobAlertSubscription.findUnique({ where: { tokenHash: hashOfferToken(token) } });
  if (!sub) return fail("This link is not valid any more.");
  const op = str(f, "op");
  if (op === "confirm") {
    await prisma.jobAlertSubscription.update({ where: { id: sub.id }, data: { confirmedAt: new Date(), unsubscribedAt: null } });
    await govAudit(sub.tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobAlertSubscription", entityId: sub.id, summary: "Job alert confirmed by the subscriber" });
    return { ok: true, message: "Your job alert is on. We will email you when a matching role opens." };
  }
  await prisma.jobAlertSubscription.update({ where: { id: sub.id }, data: { unsubscribedAt: new Date() } });
  await govAudit(sub.tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "JobAlertSubscription", entityId: sub.id, summary: "Unsubscribed from job alerts" });
  return { ok: true, message: "You are unsubscribed. You will not get any more job alerts." };
}

// ---------------------------------------------------------------------------
//  Talent community
// ---------------------------------------------------------------------------

export async function joinTalentCommunityAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const DONE = "Thanks — you are in our talent community. We will be in touch when a role fits.";
  if (str(f, "website")) return { ok: true, message: DONE };
  const tenant = await tenantFromHost();
  if (!tenant) return fail("This careers site is not available.");
  if (await throttled(`community:${tenant.id}`)) return fail("Too many requests just now. Please try again in a few minutes.");
  const email = str(f, "email", 200).toLowerCase(), firstName = str(f, "firstName", 60), lastName = str(f, "lastName", 60);
  if (!firstName) return fail("Enter your name.", f, { firstName: "Required" });
  if (!EMAIL.test(email)) return fail("Enter a valid email.", f, { email: "Invalid" });
  if (f.get("consent") !== "on") return fail("Please agree to be contacted about roles.", f, { consent: "Required" });
  const interests = str(f, "interests", 300);
  const existing = await prisma.candidate.findFirst({ where: { tenantId: tenant.id, email } });
  // An address already on file is not changed by a public form; only its consent is refreshed.
  const cand = existing ?? (await prisma.candidate.create({ data: { tenantId: tenant.id, email, firstName, lastName: lastName || "-", currentTitle: str(f, "currentTitle", 120) || null, city: str(f, "city", 80) || null, skills: interests ? interests.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20) : undefined, source: "CAREER_PORTAL" } }));
  const cfg = await hireDepthConfig(tenant.id);
  const now = new Date();
  const consent = { consentStatus: "GRANTED", consentSource: "Talent community sign-up", consentAt: now, consentExpiresAt: new Date(now.getTime() + cfg.consentValidityDays * 86_400_000), isPassive: true };
  await prisma.candidateSourcingProfile.upsert({ where: { candidateId: cand.id }, create: { tenantId: tenant.id, candidateId: cand.id, ...consent, tags: ["community"] }, update: consent });
  const pool = (await prisma.talentPool.findFirst({ where: { tenantId: tenant.id, kind: "COMMUNITY", archivedAt: null } }))
    ?? (await prisma.talentPool.create({ data: { tenantId: tenant.id, name: (await prisma.talentPool.count({ where: { tenantId: tenant.id, name: "Talent community" } })) ? "Talent community (careers site)" : "Talent community", kind: "COMMUNITY", description: "People who joined from the careers site." } }));
  await prisma.talentPoolMember.createMany({ data: [{ poolId: pool.id, candidateId: cand.id, note: interests ? `Interested in ${interests}` : "Joined from the careers site" }], skipDuplicates: true });
  await govAudit(tenant.id, null, { module: "EMPLOYEE", action: "CREATE", entityType: "TalentPool", entityId: pool.id, summary: `${existing ? "Existing candidate" : "New candidate"} joined the talent community with consent` });
  return { ok: true, message: DONE };
}

// ---------------------------------------------------------------------------
//  Applicant portal
// ---------------------------------------------------------------------------

async function portal(f: FormData) {
  const token = str(f, "token", 200);
  const p = await openApplicantLink(token);
  return p ? { ...p, token } : null;
}

const CLOSED = ["HIRED", "REJECTED", "WITHDRAWN"];

export async function applicantUpdateDetailsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const p = await portal(f);
  if (!p) return fail("This link is not valid any more.");
  if (CLOSED.includes(p.app.status)) return fail("This application is closed.");
  const phone = str(f, "phone", 20), city = str(f, "city", 80), tz = str(f, "timeZone", 60);
  if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) return fail("Enter a valid phone number.", f, { phone: "Invalid" });
  if (tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return fail("Choose a valid time zone.", f, { timeZone: "Invalid" }); } }
  await prisma.candidate.update({ where: { id: p.app.candidate.id }, data: { phone: phone || p.app.candidate.phone, city: city || p.app.candidate.city } });
  if (tz) await prisma.candidateSourcingProfile.upsert({ where: { candidateId: p.app.candidate.id }, create: { tenantId: p.link.tenantId, candidateId: p.app.candidate.id, timeZone: tz }, update: { timeZone: tz } });
  await govAudit(p.link.tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "Candidate", entityId: p.app.candidate.id, summary: "The applicant updated their contact details from the applicant portal", oldValue: { phone: p.app.candidate.phone, city: p.app.candidate.city }, newValue: { phone, city, timeZone: tz || null } });
  safeRevalidate(`/careers/status/${p.token}`);
  return { ok: true, message: "Your details are updated." };
}

/** Expected CTC and notice period change the recruiter's numbers, so the hiring team approves them. */
export async function applicantChangeRequestAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const p = await portal(f);
  if (!p) return fail("This link is not valid any more.");
  if (CLOSED.includes(p.app.status)) return fail("This application is closed.");
  const field = str(f, "field");
  if (!["EXPECTED_CTC", "NOTICE_PERIOD"].includes(field)) return fail("Choose what to change.", f, { field: "Required" });
  const value = Number(str(f, "value", 20).replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0 || (field === "NOTICE_PERIOD" && (value > 365 || !Number.isInteger(value))) || (field === "EXPECTED_CTC" && value > 1e9)) return fail("Enter a valid number.", f, { value: "Invalid" });
  if (await prisma.applicantChangeRequest.count({ where: { applicationId: p.app.id, status: "PENDING" } })) return fail("You already have a request waiting for the hiring team.");
  const old = field === "EXPECTED_CTC" ? p.app.candidate.expectedAnnualCtc?.toString() ?? null : p.app.candidate.noticePeriodDays?.toString() ?? null;
  const cr = await prisma.applicantChangeRequest.create({ data: { tenantId: p.link.tenantId, applicationId: p.app.id, field, oldValue: old, newValue: String(value), note: str(f, "note", 500) || null } });
  // The applicant has no login: the request is filed on behalf of the application's owner (or a recruiter).
  const requester = p.app.ownerId ?? (await usersWithPermission(p.link.tenantId, "hire.candidate.manage"))[0];
  if (!requester) { await prisma.applicantChangeRequest.delete({ where: { id: cr.id } }); return fail("The hiring team cannot take requests just now."); }
  const label = field === "EXPECTED_CTC" ? "expected CTC" : "notice period";
  const r = await startHireRequest({ tenantId: p.link.tenantId, kind: "APPLICANT_CHANGE", entityId: cr.id, title: `${p.app.candidate.firstName} ${p.app.candidate.lastName} asks to change their ${label} to ${value.toLocaleString("en-IN")}${field === "NOTICE_PERIOD" ? " days" : ""} (${p.app.job.title})`, details: cr.note, requesterUserId: requester });
  if (!r.ok) { await prisma.applicantChangeRequest.delete({ where: { id: cr.id } }); return fail(r.message); }
  await prisma.applicantChangeRequest.update({ where: { id: cr.id }, data: { workflowRequestId: r.requestId ?? null } });
  await govAudit(p.link.tenantId, null, { module: "EMPLOYEE", action: "CREATE", entityType: "ApplicantChangeRequest", entityId: cr.id, summary: `Applicant asked to change ${label}: ${old ?? "—"} → ${value}` });
  safeRevalidate(`/careers/status/${p.token}`);
  return { ok: true, message: "Sent to the hiring team. You will get an email when they decide." };
}

export async function applicantRecordingConsentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const p = await portal(f);
  if (!p) return fail("This link is not valid any more.");
  const iv = p.app.interviews.find((i) => i.id === str(f, "interviewId"));
  if (!iv) return fail("Interview not found.");
  const status = str(f, "status") === "DECLINED" ? "DECLINED" : "GRANTED";
  await prisma.interviewConsent.upsert({ where: { interviewId: iv.id }, create: { tenantId: p.link.tenantId, interviewId: iv.id, status, method: "Applicant portal" }, update: { status, method: "Applicant portal", recordedBy: null } });
  await govAudit(p.link.tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "InterviewConsent", entityId: iv.id, summary: `Applicant ${status === "GRANTED" ? "agreed to" : "declined"} recording of ${iv.title}` });
  safeRevalidate(`/careers/status/${p.token}`);
  return { ok: true, message: status === "GRANTED" ? "Thanks — you agreed to the recording." : "Noted: the interview will not be recorded." };
}

export async function applicantWithdrawAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const p = await portal(f);
  if (!p) return fail("This link is not valid any more.");
  if (CLOSED.includes(p.app.status)) return fail("This application is already closed.");
  if (f.get("confirm") !== "on") return fail("Tick the box to confirm you want to withdraw.", f, { confirm: "Required" });
  const reason = await prisma.dispositionReason.findFirst({ where: { id: str(f, "reasonId") || "-", tenantId: p.link.tenantId, kind: "WITHDRAW", isActive: true } });
  const label = reason?.label ?? (str(f, "reason", 300) || "Withdrew from the applicant portal");
  await closeAsWithdrawn(p.link.tenantId, p.app.id, label, reason?.id ?? null, "CANDIDATE", null, str(f, "note", 500) || null);
  await prisma.interview.updateMany({ where: { applicationId: p.app.id, status: { in: ["SCHEDULED", "RESCHEDULED"] } }, data: { status: "CANCELLED" } });
  await govAudit(p.link.tenantId, null, { module: "EMPLOYEE", action: "UPDATE", entityType: "Application", entityId: p.app.id, summary: `The applicant withdrew: ${label}` });
  if (p.app.ownerId) await notify({ tenantId: p.link.tenantId, userIds: [p.app.ownerId], kind: "HIRING", title: `${p.app.candidate.firstName} ${p.app.candidate.lastName} withdrew from ${p.app.job.title}`, body: label, link: `/hiring/applications/${p.app.id}` });
  safeRevalidate(`/careers/status/${p.token}`);
  return { ok: true, message: "Your application is withdrawn. Thank you for your interest." };
}
