import { prisma, Prisma } from "@keka/db";
import { renderOfferLetter } from "@keka/documents";
import { resolveStructure, selectStructureForCtc } from "@keka/payroll";
import { notify, usersWithPermission, specsOf } from "./lifecycle";
import { hashBody } from "./letters";
import {
  DEFAULT_OFFER_TEMPLATE, renderOfferHtml, offerPdfBlocks, newOfferToken, hashOfferToken, offerTokenSigned, linkExpiry,
  offerLinkState, sameName, inr, type BreakupRow, type LinkState,
} from "./offers-math";

/**
 * Offers end to end: the letter from the company's offer template with the
 * salary breakup, the candidate's link to the offer portal, and the
 * candidate accepting with an e-signature or declining with a reason.
 *
 * Everything the portal does starts from the token. `openOfferLink` checks
 * its signature, finds it by hash, and returns only what that one
 * candidate's offer needs, so the portal cannot be walked to anyone else.
 */

type R = { ok: boolean; message: string };

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

export function appBaseUrl(): string {
  return (process.env.APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3100").replace(/\/+$/, "");
}

const fmtLong = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const fmtShort = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "");

const OFFER_INCLUDE = {
  offer: true,
  candidate: true,
  job: true,
} satisfies Prisma.ApplicationInclude;
type AppWithOffer = Prisma.ApplicationGetPayload<{ include: typeof OFFER_INCLUDE }>;

/** The template an offer uses: the one picked, else the company's first offer template, else the built-in letter. */
export async function offerTemplate(tenantId: string, templateId: string | null | undefined): Promise<{ id: string | null; name: string; body: string }> {
  const t = await prisma.documentTemplate.findFirst({
    where: { tenantId, category: "OFFER", isArchived: false, ...(templateId ? { id: templateId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  return t ? { id: t.id, name: t.name, body: t.body } : { id: null, name: "Offer letter", body: DEFAULT_OFFER_TEMPLATE };
}

/**
 * The template with the offer's frozen clauses (conditional clauses, offer
 * components, tax disclaimers — chosen when the offer is drafted) appended.
 */
export async function withOfferClauses<T extends { body: string }>(template: T, applicationId: string): Promise<T> {
  const extra = await prisma.offerExtra.findUnique({ where: { applicationId }, select: { clausesHtml: true } });
  return extra?.clausesHtml ? { ...template, body: `${template.body}${extra.clausesHtml}` } : template;
}

/** The breakup of a CTC through a salary structure: everything inside CTC except employee deductions. */
export async function structureBreakup(tenantId: string, annualCtc: number, structureId?: string | null): Promise<{ rows: BreakupRow[]; structureName: string | null }> {
  const structures = await prisma.salaryStructure.findMany({
    where: { payGroup: { tenantId }, isActive: true, ...(structureId ? { id: structureId } : {}) },
    include: { components: { include: { component: true } } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  const s = structureId ? structures[0] : selectStructureForCtc(structures, annualCtc);
  if (!s) return { rows: [], structureName: null };
  const resolved = resolveStructure({ annualCtc, components: specsOf({ structure: s } as Parameters<typeof specsOf>[0]), roundComponents: s.roundComponents });
  const rows = resolved.components
    .filter((c) => !c.isOutsideCtc && c.type !== "DEDUCTION" && Number(c.annual) > 0)
    .sort((a, b) => a.sequence - b.sequence)
    .map((c) => ({ name: c.name, monthly: Number(c.monthly), annual: Number(c.annual) }));
  return { rows, structureName: s.name };
}

/** The breakup an offer shows: frozen on the offer if entered or already extended, else from the structure. */
async function breakupOf(tenantId: string, offer: NonNullable<AppWithOffer["offer"]>): Promise<BreakupRow[]> {
  if (Array.isArray(offer.salaryBreakup)) return offer.salaryBreakup as unknown as BreakupRow[];
  return (await structureBreakup(tenantId, Number(offer.annualCtc), offer.salaryStructureId)).rows;
}

/** Placeholder values for an offer: the HR letter set, filled from the candidate, job and offer. */
export async function offerValues(app: AppWithOffer, today = new Date()): Promise<Record<string, string>> {
  const offer = app.offer!;
  const [entity, location, department, manager, title] = await Promise.all([
    prisma.legalEntity.findFirst({
      where: app.job.legalEntityId ? { id: app.job.legalEntityId, tenantId: app.tenantId } : { tenantId: app.tenantId },
      select: { legalName: true, signatories: { take: 1 } }, orderBy: { createdAt: "asc" },
    }),
    app.job.locationId ? prisma.location.findFirst({ where: { id: app.job.locationId, tenantId: app.tenantId }, select: { name: true } }) : null,
    app.job.departmentId ? prisma.department.findFirst({ where: { id: app.job.departmentId, tenantId: app.tenantId }, select: { name: true } }) : null,
    offer.reportingManagerId ? prisma.employee.findFirst({ where: { id: offer.reportingManagerId, tenantId: app.tenantId }, select: { displayName: true } }) : null,
    offer.jobTitleId ? prisma.jobTitle.findFirst({ where: { id: offer.jobTitleId, tenantId: app.tenantId }, select: { name: true } }) : null,
  ]);
  const name = `${app.candidate.firstName} ${app.candidate.lastName}`;
  const ctc = Number(offer.annualCtc);
  const sig = entity?.signatories[0];
  const joining = fmtShort(offer.proposedJoiningDate);
  return {
    candidate_name: name, employee_name: name, candidate_first_name: app.candidate.firstName, employee_first_name: app.candidate.firstName,
    job_title: title?.name ?? app.job.title, department: department?.name ?? "", legal_entity_name: entity?.legalName ?? "",
    location: location?.name ?? "", reporting_manager: manager?.displayName ?? "",
    annual_ctc: inr(ctc), monthly_ctc: inr(Math.round(ctc / 12)), joining_bonus: offer.joiningBonus ? inr(Number(offer.joiningBonus)) : "",
    joining_date: joining, date_of_joining: joining, offer_expiry: fmtShort(offer.expiresOn),
    signatory_name: sig?.name ?? "", signatory_designation: sig?.designation ?? "", today: fmtShort(today),
  };
}

/** The letter as it would go out now: for the recruiter's preview, and what extending freezes. */
export async function previewOfferLetter(tenantId: string, applicationId: string): Promise<(R & { html?: string; missing?: string[]; breakup?: BreakupRow[]; templateName?: string }) > {
  const app = await prisma.application.findFirst({ where: { id: applicationId, tenantId }, include: OFFER_INCLUDE });
  if (!app?.offer) return { ok: false, message: "Draft an offer first." };
  if (app.offer.renderedBody) return { ok: true, message: "As extended.", html: app.offer.renderedBody, missing: [], breakup: await breakupOf(tenantId, app.offer), templateName: "Extended letter" };
  const [template, values, breakup] = await Promise.all([offerTemplate(tenantId, app.offer.templateId).then((t) => withOfferClauses(t, app.id)), offerValues(app), breakupOf(tenantId, app.offer)]);
  const { html, missing } = renderOfferHtml(template.body, values, breakup);
  return { ok: true, message: "Preview.", html, missing, breakup, templateName: template.name };
}

/** Revoke any link still working for an offer. */
async function revokeLinks(offerId: string, reason: string, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const r = await tx.offerLink.updateMany({ where: { offerId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  return r.count;
}

/** A new link for the candidate (any older one stops working), emailed to them. */
export async function issueOfferLink(input: { tenantId: string; applicationId: string; byUserId: string | null; baseUrl?: string }): Promise<R & { url?: string; expiresAt?: Date }> {
  const app = await prisma.application.findFirst({ where: { id: input.applicationId, tenantId: input.tenantId }, include: OFFER_INCLUDE });
  if (!app?.offer) return { ok: false, message: "Draft an offer first." };
  if (app.offer.status !== "EXTENDED") return { ok: false, message: "Only an extended offer has a candidate link." };
  const now = new Date();
  const expiresAt = linkExpiry(app.offer.expiresOn, now);
  if (expiresAt <= now) return { ok: false, message: "This offer has expired. Draft a fresh one." };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: app.tenantId }, select: { name: true } });
  const { token, hash } = newOfferToken(secret());
  const url = `${(input.baseUrl ?? appBaseUrl()).replace(/\/+$/, "")}/offer/${token}`;
  await prisma.$transaction(async (tx) => {
    const replaced = await revokeLinks(app.offer!.id, "Replaced by a new link", tx);
    await tx.offerLink.create({ data: { offerId: app.offer!.id, tokenHash: hash, expiresAt, createdBy: input.byUserId } });
    await tx.emailOutbox.create({
      data: {
        tenantId: app.tenantId, toAddress: app.candidate.email, subject: `${replaced ? "Your updated offer link" : "Your offer"} from ${tenant.name}`,
        textBody: `Dear ${app.candidate.firstName},\n\nCongratulations! Your offer for the ${app.job.title} role is ready. Open it here to read the letter, then accept it with your e-signature or let us know if you are declining:\n\n${url}\n\nThe link is personal to you and works until ${fmtLong(expiresAt)}.${replaced ? " Any earlier link we sent no longer works." : ""}\n\nTalent Acquisition, ${tenant.name}`,
        relatedType: "Offer", relatedId: app.offer!.id,
      },
    });
  });
  return { ok: true, message: `Sent ${app.candidate.firstName} a link to the offer, valid until ${fmtLong(expiresAt)}.`, url, expiresAt };
}

export async function revokeOfferLink(input: { tenantId: string; applicationId: string }): Promise<R> {
  const offer = await prisma.offer.findFirst({ where: { applicationId: input.applicationId, application: { tenantId: input.tenantId } } });
  if (!offer) return { ok: false, message: "No offer here." };
  const n = await revokeLinks(offer.id, "Revoked by the hiring team");
  return n ? { ok: true, message: "The candidate's link no longer works. Send a new one when ready." } : { ok: false, message: "There is no working link to revoke." };
}

/**
 * Send the offer: the letter from the template, frozen with its fingerprint
 * and saved as a PDF, then the candidate's link by email.
 */
export async function extendOfferFromTemplate(
  applicationId: string, saveLetter: (pdf: Buffer, filename: string) => Promise<string>, opts: { byUserId?: string | null; baseUrl?: string } = {},
): Promise<R & { url?: string; missing?: string[] }> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: OFFER_INCLUDE });
  if (!app?.offer) return { ok: false, message: "Draft an offer first." };
  if (app.offer.status !== "APPROVED") return { ok: false, message: app.offer.status === "PENDING_APPROVAL" ? "The offer is waiting for approval." : "This offer cannot be extended." };
  if (app.offer.expiresOn && linkExpiry(app.offer.expiresOn) <= new Date()) return { ok: false, message: "The offer's expiry date has passed. Draft it again with a new date." };
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: app.tenantId } });
  const [template, values, breakup] = await Promise.all([offerTemplate(app.tenantId, app.offer.templateId).then((t) => withOfferClauses(t, app.id)), offerValues(app), breakupOf(app.tenantId, app.offer)]);
  const { html, missing } = renderOfferHtml(template.body, values, breakup);
  const pdf = renderOfferLetter({
    company: { name: values.legal_entity_name || tenant.name, address: values.location || null },
    date: fmtLong(new Date()), to: [values.candidate_name!, app.candidate.email],
    subject: `Offer of employment — ${values.job_title}`, blocks: offerPdfBlocks(template.body, values, breakup),
    footer: "This offer is subject to satisfactory background verification and the documents listed in your onboarding checklist.",
  });
  const url = await saveLetter(pdf, `Offer-${app.candidate.lastName}-${app.job.code ?? app.jobId}.pdf`);
  await prisma.$transaction([
    prisma.offer.update({
      where: { id: app.offer.id },
      data: {
        status: "EXTENDED", extendedAt: new Date(), letterUrl: url, templateId: template.id, renderedBody: html, contentHash: hashBody(html),
        salaryBreakup: breakup as unknown as Prisma.InputJsonValue, breakupSource: app.offer.breakupSource ?? (breakup.length ? "STRUCTURE" : null),
        signerName: null, signatureFileId: null, signedAt: null, signedIp: null, signedUserAgent: null, signedLetterUrl: null,
      },
    }),
    prisma.application.update({ where: { id: app.id }, data: { status: "OFFER_EXTENDED" } }),
  ]);
  const link = await issueOfferLink({ tenantId: app.tenantId, applicationId, byUserId: opts.byUserId ?? null, baseUrl: opts.baseUrl });
  if (!link.ok) return link;
  const gap = missing.length ? ` ${missing.length === 1 ? "1 placeholder was not available and is" : `${missing.length} placeholders were not available and are`} marked in the letter: ${missing.join(", ")}.` : "";
  return { ok: true, url: link.url, missing, message: `Offer extended from “${template.name}”; ${app.candidate.firstName} has been emailed a link to accept or decline.${gap}` };
}

// --- The candidate portal ----------------------------------------------------------------

/** What the portal may show: this candidate's offer and nothing else. */
export interface PublicOffer {
  linkId: string;
  state: LinkState;
  tenantId: string;
  applicationId: string;
  offerId: string;
  company: string;
  candidateName: string;
  firstName: string;
  jobTitle: string;
  annualCtc: number;
  joiningBonus: number | null;
  joiningDate: Date | null;
  offerExpiresOn: Date | null;
  linkExpiresAt: Date;
  html: string;
  breakup: BreakupRow[];
  letterUrl: string | null;
  signedLetterUrl: string | null;
  signedAt: Date | null;
  signerName: string | null;
  declineReason: string | null;
}

/**
 * Resolve a token to its offer. Null for anything that is not a token we
 * issued, so a forged, mistyped or deleted link looks the same as no link.
 */
export async function openOfferLink(token: string, opts: { recordView?: boolean; now?: Date } = {}): Promise<PublicOffer | null> {
  if (!offerTokenSigned(token, secret())) return null;
  const link = await prisma.offerLink.findUnique({
    where: { tokenHash: hashOfferToken(token) },
    include: { offer: { include: { application: { include: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } }, tenant: { select: { id: true, name: true } } } } } } },
  });
  if (!link) return null;
  const now = opts.now ?? new Date();
  const o = link.offer, app = o.application;
  const state = offerLinkState(link, o.status, now);
  if (opts.recordView && state === "OPEN") {
    await prisma.offerLink.update({ where: { id: link.id }, data: { viewCount: { increment: 1 }, lastViewedAt: now, firstViewedAt: link.firstViewedAt ?? now } });
  }
  return {
    linkId: link.id, state, tenantId: app.tenant.id, applicationId: app.id, offerId: o.id, company: app.tenant.name,
    candidateName: `${app.candidate.firstName} ${app.candidate.lastName}`, firstName: app.candidate.firstName, jobTitle: app.job.title,
    annualCtc: Number(o.annualCtc), joiningBonus: o.joiningBonus === null ? null : Number(o.joiningBonus), joiningDate: o.proposedJoiningDate,
    offerExpiresOn: o.expiresOn, linkExpiresAt: link.expiresAt, html: o.renderedBody ?? "", breakup: Array.isArray(o.salaryBreakup) ? (o.salaryBreakup as unknown as BreakupRow[]) : [],
    letterUrl: o.letterUrl, signedLetterUrl: o.signedLetterUrl, signedAt: o.signedAt, signerName: o.signerName, declineReason: o.declineReason,
  };
}

/** Recruiter, hiring manager, application owner and whoever sent the link; failing those, anyone who manages offers. */
async function hiringTeam(applicationId: string): Promise<string[]> {
  const app = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: { select: { recruiterId: true, hiringManagerId: true } }, offer: { include: { links: { select: { createdBy: true } } } } } });
  const people = await prisma.employee.findMany({ where: { tenantId: app.tenantId, id: { in: [app.job.recruiterId, app.job.hiringManagerId, app.ownerId].filter((x): x is string => !!x) } }, select: { userId: true } });
  const ids = [...people.map((p) => p.userId), ...(app.offer?.links.map((l) => l.createdBy) ?? [])].filter((x): x is string => !!x);
  return ids.length ? [...new Set(ids)] : usersWithPermission(app.tenantId, "hire.offer.manage");
}

/** The stage an accepted candidate moves into: preboarding if the flow has one, else hired. */
async function acceptedStage(applicationId: string) {
  const app = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { currentStageId: true, job: { select: { flow: { select: { stages: true } } } } } });
  const stages = app.job.flow?.stages ?? [];
  const stage = stages.find((s) => s.stageKind === "PREBOARDING") ?? stages.find((s) => s.stageKind === "HIRED");
  return stage && stage.id !== app.currentStageId ? stage : null;
}

/**
 * Record the candidate's response — from the portal, or by the recruiter on
 * their behalf. Guarded on the offer still being extended, so two clicks or
 * two tabs cannot both win.
 */
async function respond(input: {
  applicationId: string; accepted: boolean; reason: string | null; byUserId: string | null;
  signature?: { name: string; fileId: string | null; ip: string | null; userAgent: string | null };
}): Promise<boolean> {
  const stage = input.accepted ? await acceptedStage(input.applicationId) : null;
  return prisma.$transaction(async (tx) => {
    const offer = await tx.offer.findUniqueOrThrow({ where: { applicationId: input.applicationId } });
    const done = await tx.offer.updateMany({
      where: { id: offer.id, status: "EXTENDED" },
      data: {
        status: input.accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date(), declineReason: input.accepted ? null : input.reason,
        ...(input.signature ? { signerName: input.signature.name, signatureFileId: input.signature.fileId, signedAt: new Date(), signedIp: input.signature.ip, signedUserAgent: input.signature.userAgent?.slice(0, 300) ?? null } : {}),
      },
    });
    if (done.count === 0) return false;
    await tx.application.update({ where: { id: input.applicationId }, data: { status: input.accepted ? "OFFER_ACCEPTED" : "OFFER_DECLINED", ...(stage ? { currentStageId: stage.id } : {}) } });
    if (stage) {
      await tx.applicationStageHistory.updateMany({ where: { applicationId: input.applicationId, exitedAt: null }, data: { exitedAt: new Date() } });
      await tx.applicationStageHistory.create({ data: { applicationId: input.applicationId, stageId: stage.id, movedBy: input.byUserId, note: input.signature ? "Offer accepted and signed by the candidate" : "Offer accepted" } });
    }
    return true;
  });
}

/** The recruiter records a response the candidate gave some other way. */
export async function recordResponseOnBehalf(applicationId: string, accepted: boolean, reason: string | null, byUserId: string | null): Promise<R> {
  const ok = await respond({ applicationId, accepted, reason, byUserId });
  if (!ok) return { ok: false, message: "No extended offer to respond to." };
  // Answered by other means: the candidate's link stops offering a choice.
  const offer = await prisma.offer.findUniqueOrThrow({ where: { applicationId } });
  await revokeLinks(offer.id, "Response recorded by the hiring team");
  return { ok: true, message: accepted ? "Accepted. Convert the candidate to an employee when the paperwork is in." : "Declined." };
}

export async function acceptOfferByLink(input: {
  token: string; typedName: string; consent: boolean; signatureFileId: string | null; ip: string | null; userAgent: string | null;
  saveSignedLetter: (pdf: Buffer, filename: string, tenantId: string, applicationId: string) => Promise<string>;
}): Promise<R> {
  const view = await openOfferLink(input.token);
  if (!view) return { ok: false, message: "This link is not valid." };
  if (view.state !== "OPEN") return { ok: false, message: closedMessage(view.state) };
  if (!input.consent) return { ok: false, message: "Confirm that you agree to sign electronically." };
  if (!input.signatureFileId) return { ok: false, message: "Draw your signature in the box." };
  if (!sameName(input.typedName, view.candidateName)) return { ok: false, message: `Type your full name exactly as it appears on the offer: ${view.candidateName}.` };
  const offer = await prisma.offer.findUniqueOrThrow({ where: { id: view.offerId } });
  if (!offer.renderedBody || !offer.contentHash || offer.contentHash !== hashBody(offer.renderedBody)) return { ok: false, message: "This offer's text has changed since it was sent. Please ask the hiring team to send it again." };
  if (offer.expiresOn && linkExpiry(offer.expiresOn) <= new Date()) return { ok: false, message: closedMessage("EXPIRED") };
  const ok = await respond({ applicationId: view.applicationId, accepted: true, reason: null, byUserId: null, signature: { name: input.typedName.trim(), fileId: input.signatureFileId, ip: input.ip, userAgent: input.userAgent } });
  if (!ok) return { ok: false, message: "This offer has already been answered." };

  // The signed copy: the letter as sent, with the signing record.
  const app = await prisma.application.findUniqueOrThrow({ where: { id: view.applicationId }, include: OFFER_INCLUDE });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: app.tenantId } });
  const template = await withOfferClauses(await offerTemplate(app.tenantId, app.offer!.templateId), app.id);
  const values = await offerValues(app, app.offer!.extendedAt ?? new Date());
  const breakup = await breakupOf(app.tenantId, app.offer!);
  const at = new Date();
  const pdf = renderOfferLetter({
    company: { name: values.legal_entity_name || tenant.name, address: values.location || null },
    date: fmtLong(app.offer!.extendedAt ?? at), to: [values.candidate_name!, app.candidate.email],
    subject: `Offer of employment — ${values.job_title}`, blocks: offerPdfBlocks(template.body, values, breakup),
    signed: { name: input.typedName.trim(), at: `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`, ip: input.ip, fingerprint: offer.contentHash },
  });
  const signedUrl = await input.saveSignedLetter(pdf, `Offer-${app.candidate.lastName}-signed.pdf`, app.tenantId, app.id);
  await prisma.offer.update({ where: { id: offer.id }, data: { signedLetterUrl: signedUrl } });
  await notify({
    tenantId: app.tenantId, userIds: await hiringTeam(app.id), kind: "HIRING", email: true,
    title: `${view.candidateName} accepted the offer for ${app.job.title}`,
    body: `Signed electronically on ${at.toISOString().slice(0, 10)}. Joining ${fmtShort(app.offer!.proposedJoiningDate) || "date to be confirmed"}. Create their employee record to start preboarding.`,
    link: `/hiring/applications/${app.id}`, relatedType: "Offer", relatedId: offer.id,
  });
  await prisma.emailOutbox.create({
    data: {
      tenantId: app.tenantId, toAddress: app.candidate.email, subject: `Welcome to ${tenant.name}`,
      textBody: `Dear ${app.candidate.firstName},\n\nThank you for accepting our offer for the ${app.job.title} role. We have your signed letter, and the hiring team will be in touch about your first day and preboarding.\n\nTalent Acquisition, ${tenant.name}`,
      relatedType: "Offer", relatedId: offer.id,
    },
  });
  return { ok: true, message: `Thank you, ${view.firstName}. Your acceptance is signed and recorded; the hiring team has been told.` };
}

export async function declineOfferByLink(input: { token: string; reason: string }): Promise<R> {
  const view = await openOfferLink(input.token);
  if (!view) return { ok: false, message: "This link is not valid." };
  if (view.state !== "OPEN") return { ok: false, message: closedMessage(view.state) };
  const reason = input.reason.trim().slice(0, 1000);
  if (!reason) return { ok: false, message: "Please tell us briefly why you are declining." };
  const ok = await respond({ applicationId: view.applicationId, accepted: false, reason, byUserId: null });
  if (!ok) return { ok: false, message: "This offer has already been answered." };
  await notify({
    tenantId: view.tenantId, userIds: await hiringTeam(view.applicationId), kind: "HIRING", email: true,
    title: `${view.candidateName} declined the offer for ${view.jobTitle}`, body: `Reason: ${reason}`,
    link: `/hiring/applications/${view.applicationId}`, relatedType: "Offer", relatedId: view.offerId,
  });
  return { ok: true, message: "Thank you for letting us know. Your answer has been passed to the hiring team." };
}

export function closedMessage(state: LinkState): string {
  return {
    OPEN: "", EXPIRED: "This link has expired. Please contact the hiring team for a new one.",
    REVOKED: "This link is no longer active. If you were expecting an offer, please check for a newer email from the hiring team.",
    ACCEPTED: "You have already accepted this offer.", DECLINED: "You have already declined this offer.",
    CLOSED: "This offer is no longer open.",
  }[state];
}
