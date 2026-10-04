"use server";

import { prisma } from "@keka/db";
import { startHireRequest, recordOfferVersion, revokeOfferLink, notify } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { HP, str, fail, numField, dateOf, resolveOfferClauses } from "@/lib/hire-depth";

/**
 * Hire depth — offers: the clause library and the clauses frozen into an
 * offer, the pre-extend checklist, negotiations (counter-offers, joining
 * date changes), compensation confirmation, revisions (approved on the
 * workflow engine, each a new version) and withdrawals.
 */

const offerPaths = (applicationId: string) => [`/hiring/offers/${applicationId}`, "/hiring/offers", `/hiring/applications/${applicationId}`];

async function offerOf(tenantId: string, applicationId: string) {
  return prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: { offer: true, candidate: true, job: true } });
}

// ---------------------------------------------------------------------------
//  Clause library
// ---------------------------------------------------------------------------

const CLAUSE_KINDS = ["GENERAL", "CONDITIONAL", "COMPONENT", "TAX_DISCLAIMER", "CONFIDENTIALITY"];

export async function saveOfferClauseAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const title = str(f, "title", 120), body = str(f, "body", 8000);
  const locale = (str(f, "locale", 5) || "en").toLowerCase();
  if (title.length < 3) return fail("Name the clause.", f, { title: "Required" });
  if (body.length < 10) return fail("Write the clause.", f, { body: "Required" });
  if (await prisma.offerClause.count({ where: { tenantId: viewer.tenantId, title, locale } })) return fail("A clause with that title exists in that language.", f, { title: "Taken" });
  const minCtc = numField(f, "minCtc"), amount = numField(f, "amount");
  if (minCtc !== null && (!Number.isFinite(minCtc) || minCtc < 0)) return fail("Enter a valid CTC threshold.", f, { minCtc: "Invalid" });
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return fail("Enter a valid amount.", f, { amount: "Invalid" });
  const departmentId = str(f, "departmentId") || null;
  if (departmentId && !(await prisma.department.count({ where: { id: departmentId, tenantId: viewer.tenantId } }))) return fail("Department not found.");
  const c = await prisma.offerClause.create({ data: {
    tenantId: viewer.tenantId, title, body, locale, kind: CLAUSE_KINDS.includes(str(f, "kind")) ? str(f, "kind") : "GENERAL", minCtc, amount, departmentId,
    employmentType: str(f, "employmentType", 40) || null, sortOrder: numField(f, "sortOrder") ?? 0,
  } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "OfferClause", entityId: c.id, summary: `Added offer clause ${title} (${locale})` });
  return done(["/hiring/settings/offers"], "Clause added.");
}

export async function toggleOfferClauseAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const c = await prisma.offerClause.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!c) return fail("Clause not found.");
  await prisma.offerClause.update({ where: { id: c.id }, data: { isActive: !c.isActive } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OfferClause", entityId: c.id, summary: `${c.isActive ? "Retired" : "Restored"} clause ${c.title}` });
  return done(["/hiring/settings/offers"], c.isActive ? "Retired." : "Restored.");
}

/** Pick the letter's language and its clauses (or let the rules choose). Only before the offer is extended. */
export async function applyOfferClausesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  if (!["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(app.offer.status)) return fail("The clauses are fixed once the offer is extended; revise the offer to change them.");
  const ids = f.getAll("clauseIds").map(String).filter(Boolean);
  const manual = f.get("mode") === "manual";
  if (manual && ids.length && (await prisma.offerClause.count({ where: { id: { in: ids }, tenantId: viewer.tenantId } })) !== ids.length) return fail("Some clauses were not found.");
  const r = await resolveOfferClauses(viewer.tenantId, app.id, { locale: (str(f, "locale", 5) || "en").toLowerCase(), clauseIds: manual ? ids : undefined });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: app.id, summary: `Offer clauses set: ${r.titles.join(", ") || "none"}` });
  return done(offerPaths(app.id), r.count ? `${r.count} clause(s) will be in the letter.` : "No clauses apply.");
}

// ---------------------------------------------------------------------------
//  Checklist
// ---------------------------------------------------------------------------

export async function tickOfferChecklistAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  const item = str(f, "item", 300);
  if (!item) return fail("Choose the checklist item.");
  const existing = await prisma.offerChecklistCheck.findUnique({ where: { applicationId_item: { applicationId: app.id, item } } });
  if (existing) await prisma.offerChecklistCheck.delete({ where: { id: existing.id } });
  else await prisma.offerChecklistCheck.create({ data: { tenantId: viewer.tenantId, applicationId: app.id, item, checkedBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: app.id, summary: `${existing ? "Unticked" : "Ticked"} offer checklist: ${item}` });
  return done(offerPaths(app.id), existing ? "Unticked." : "Ticked.");
}

// ---------------------------------------------------------------------------
//  Negotiation and compensation confirmation
// ---------------------------------------------------------------------------

export async function logNegotiationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  const kind = ["COUNTER_OFFER", "JOINING_DATE", "OTHER"].includes(str(f, "kind")) ? str(f, "kind") : null;
  if (!kind) return fail("What is the candidate asking for?", f, { kind: "Required" });
  const requestedCtc = numField(f, "requestedCtc"), competitorCtc = numField(f, "competitorCtc");
  const requestedJoiningDate = dateOf(f, "requestedJoiningDate");
  if (kind === "COUNTER_OFFER" && (requestedCtc === null || !Number.isFinite(requestedCtc) || requestedCtc <= 0)) return fail("Enter the CTC they are asking for.", f, { requestedCtc: "Required" });
  if (kind === "JOINING_DATE" && !requestedJoiningDate) return fail("Enter the joining date they are asking for.", f, { requestedJoiningDate: "Required" });
  if (competitorCtc !== null && (!Number.isFinite(competitorCtc) || competitorCtc < 0)) return fail("Enter a valid competing CTC.", f, { competitorCtc: "Invalid" });
  const n = await prisma.offerNegotiation.create({ data: { tenantId: viewer.tenantId, applicationId: app.id, kind, requestedCtc, requestedJoiningDate, competitorName: str(f, "competitorName", 120) || null, competitorCtc, note: str(f, "note", 2000) || null, createdBy: viewer.user.id } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "OfferNegotiation", entityId: n.id, summary: `${app.candidate.firstName} ${app.candidate.lastName} asked for ${kind === "COUNTER_OFFER" ? `₹${requestedCtc?.toLocaleString("en-IN")}` : kind === "JOINING_DATE" ? `a joining date of ${requestedJoiningDate!.toISOString().slice(0, 10)}` : "a change"}` });
  return done(offerPaths(app.id), "Logged.");
}

export async function resolveNegotiationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const n = await prisma.offerNegotiation.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId, status: "OPEN" } });
  if (!n) return fail("Open negotiation not found.");
  const status = ["AGREED", "DECLINED"].includes(str(f, "status")) ? str(f, "status") : null;
  if (!status) return fail("Agreed or declined?");
  const resolution = str(f, "resolution", 1000);
  if (!resolution) return fail("Record the outcome.", f, { resolution: "Required" });
  await prisma.offerNegotiation.update({ where: { id: n.id }, data: { status, resolution, resolvedBy: viewer.user.id, resolvedAt: new Date() } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "OfferNegotiation", entityId: n.id, summary: `Negotiation ${status.toLowerCase()}: ${resolution}` });
  return done(offerPaths(n.applicationId), status === "AGREED" ? "Agreed — request a revision to change the letter." : "Declined.");
}

export async function confirmCompensationAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  const note = str(f, "note", 500);
  if (!note) return fail("Record what was confirmed (e.g. reviewed with payroll).", f, { note: "Required" });
  await prisma.offerExtra.upsert({ where: { applicationId: app.id }, create: { tenantId: viewer.tenantId, applicationId: app.id, compConfirmedAt: new Date(), compConfirmedNote: note }, update: { compConfirmedAt: new Date(), compConfirmedNote: note } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "APPROVE", entityType: "Offer", entityId: app.id, summary: `Compensation confirmed at ₹${Number(app.offer.annualCtc).toLocaleString("en-IN")}: ${note}` });
  return done(offerPaths(app.id), "Compensation confirmed.");
}

// ---------------------------------------------------------------------------
//  Revision (approved on the engine) and withdrawal
// ---------------------------------------------------------------------------

export async function requestOfferRevisionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  if (!["APPROVED", "EXTENDED", "DECLINED"].includes(app.offer.status)) return fail(`An offer that is ${app.offer.status.toLowerCase().replace("_", " ")} cannot be revised; edit the draft instead.`);
  const annualCtc = numField(f, "annualCtc"), joiningBonus = numField(f, "joiningBonus");
  if (annualCtc === null || !Number.isFinite(annualCtc) || annualCtc <= 0) return fail("Enter the revised CTC.", f, { annualCtc: "Required" });
  if (joiningBonus !== null && (!Number.isFinite(joiningBonus) || joiningBonus < 0)) return fail("Enter a valid joining bonus.", f, { joiningBonus: "Invalid" });
  const reason = str(f, "reason", 1000);
  if (!reason) return fail("Say why the offer is being revised.", f, { reason: "Required" });
  const proposedJoiningDate = dateOf(f, "proposedJoiningDate"), expiresOn = dateOf(f, "expiresOn");
  const was = Number(app.offer.annualCtc);
  const r = await startHireRequest({
    tenantId: viewer.tenantId, kind: "OFFER_REVISION", entityId: app.id, title: `Revise the offer to ${app.candidate.firstName} ${app.candidate.lastName}: ₹${was.toLocaleString("en-IN")} → ₹${annualCtc.toLocaleString("en-IN")}`,
    details: reason, amount: annualCtc, data: { annualCtc, joiningBonus, proposedJoiningDate: proposedJoiningDate?.toISOString() ?? null, expiresOn: expiresOn?.toISOString() ?? null, reason, was }, requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null,
  });
  if (!r.ok) return fail(r.message);
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: app.id, summary: `Requested an offer revision to ₹${annualCtc}: ${reason}` });
  return done(offerPaths(app.id), r.status === "PENDING" ? "Revision sent for approval." : "Revision approved.");
}

export async function withdrawOfferAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.OFFER_MANAGE);
  const app = await offerOf(viewer.tenantId, str(f, "applicationId"));
  if (!app?.offer) return fail("Offer not found.");
  if (!["DRAFT", "PENDING_APPROVAL", "APPROVED", "EXTENDED"].includes(app.offer.status)) return fail(`An offer that is ${app.offer.status.toLowerCase()} cannot be withdrawn.`);
  const reason = str(f, "reason", 1000);
  if (!reason) return fail("Record why the offer is withdrawn.", f, { reason: "Required" });
  const wasExtended = app.offer.status === "EXTENDED";
  await prisma.offer.update({ where: { id: app.offer.id }, data: { status: "WITHDRAWN" } });
  await prisma.offerExtra.upsert({ where: { applicationId: app.id }, create: { tenantId: viewer.tenantId, applicationId: app.id, withdrawReason: reason }, update: { withdrawReason: reason } });
  await revokeOfferLink({ tenantId: viewer.tenantId, applicationId: app.id });
  if (app.status === "OFFER_EXTENDED") await prisma.application.update({ where: { id: app.id }, data: { status: "ACTIVE" } });
  await recordOfferVersion(viewer.tenantId, app.id, "WITHDRAWN", reason, viewer.user.id);
  if (wasExtended && f.get("notifyCandidate") !== "off") await prisma.emailOutbox.create({ data: { tenantId: viewer.tenantId, toAddress: app.candidate.email, subject: `Your offer for ${app.job.title}`, textBody: `Dear ${app.candidate.firstName},\n\nWe are sorry to let you know that the offer for ${app.job.title} has been withdrawn. The hiring team will be in touch.\n\nTalent Acquisition`, relatedType: "Offer", relatedId: app.id } });
  if (app.ownerId && app.ownerId !== viewer.user.id) await notify({ tenantId: viewer.tenantId, userIds: [app.ownerId], kind: "HIRING", title: `Offer to ${app.candidate.firstName} ${app.candidate.lastName} withdrawn`, body: reason, link: `/hiring/offers/${app.id}` });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "Offer", entityId: app.id, summary: `Offer withdrawn: ${reason}`, oldValue: { status: app.offer.status }, newValue: { status: "WITHDRAWN" } });
  return done(offerPaths(app.id), "Offer withdrawn.");
}
