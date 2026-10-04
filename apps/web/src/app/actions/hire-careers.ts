"use server";

import { prisma, Prisma } from "@keka/db";
import { startHireRequest, snapshotCareerSite, slugify, isHexColor } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { writeAudit, actionDone as done, type ActionState } from "@/lib/forms";
import { saveFile, sniffUpload } from "@/lib/storage";
import { HP, str, fail, numField } from "@/lib/hire-depth";

/**
 * Hire depth — careers site and employer brand: content blocks (EVP,
 * stories, culture, FAQs, diversity, locations, recruiter profiles, campaign
 * landing pages) with versions and an approval before publishing; site SEO,
 * accessibility, languages and analytics, each change snapshotted so it can
 * be rolled back.
 */

const KINDS = ["EVP", "STORY", "CULTURE", "FAQ", "DIVERSITY", "LOCATION", "RECRUITER", "LANDING"];
const PATHS = ["/hiring/settings/careers/content", "/careers"];
const LOCALE = /^[a-z]{2}$/;

function snapshotOf(c: { title: string; body: string; kind: string; slug: string | null; locale: string; imageAlt: string | null; seoTitle: string | null; seoDescription: string | null; personName: string | null; personTitle: string | null; contactEmail: string | null; campaignCode: string | null; locationId: string | null; audience: string | null; imageFileId: string | null }) {
  const { title, body, kind, slug, locale, imageAlt, seoTitle, seoDescription, personName, personTitle, contactEmail, campaignCode, locationId, audience, imageFileId } = c;
  return { title, body, kind, slug, locale, imageAlt, seoTitle, seoDescription, personName, personTitle, contactEmail, campaignCode, locationId, audience, imageFileId };
}

export async function saveCareerContentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const id = str(f, "id");
  const existing = id ? await prisma.careerContent.findFirst({ where: { id, tenantId: viewer.tenantId } }) : null;
  if (id && !existing) return fail("Content not found.");
  if (existing?.status === "PENDING_APPROVAL") return fail("This is waiting for approval; it cannot change now.");
  const kind = KINDS.includes(str(f, "kind")) ? str(f, "kind") : existing?.kind ?? null;
  if (!kind) return fail("Choose the kind of content.", f, { kind: "Required" });
  const title = str(f, "title", 160), body = str(f, "body", 20000);
  if (title.length < 2) return fail("Give it a title.", f, { title: "Required" });
  if (body.length < 10) return fail("Write the content.", f, { body: "Required" });
  const locale = (str(f, "locale", 5) || "en").toLowerCase();
  if (!LOCALE.test(locale)) return fail("Use a two-letter language code, e.g. en or hi.", f, { locale: "Invalid" });
  const wantsPage = kind === "LANDING" || kind === "STORY" || kind === "LOCATION";
  const slug = wantsPage ? slugify(str(f, "slug", 80) || title) : null;
  if (slug && (await prisma.careerContent.count({ where: { tenantId: viewer.tenantId, slug, NOT: { id: existing?.id ?? "-" } } }))) return fail("Another page uses that web address.", f, { slug: "Taken" });
  const contactEmail = str(f, "contactEmail", 200);
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) return fail("Enter a valid contact email.", f, { contactEmail: "Invalid" });
  const locationId = str(f, "locationId") || null;
  if (locationId && !(await prisma.location.count({ where: { id: locationId, tenantId: viewer.tenantId } }))) return fail("Location not found.");
  let imageFileId = existing?.imageFileId ?? null;
  const file = f.get("image");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    if (file.size > 3 * 1024 * 1024) return fail("Images are limited to 3 MB.", f, { image: "Too large" });
    const data = Buffer.from(await file.arrayBuffer());
    const sniff = sniffUpload(data, file.type);
    if (!sniff.ok || !sniff.mimeType.startsWith("image/")) return fail("Upload a PNG or JPEG image.", f, { image: "Image only" });
    imageFileId = (await saveFile({ tenantId: viewer.tenantId, filename: `career-${slugify(title)}.${sniff.mimeType === "image/png" ? "png" : "jpg"}`, mimeType: sniff.mimeType, data, relatedType: "CareerSiteAsset", uploadedBy: viewer.user.id })).id;
  }
  const imageAlt = str(f, "imageAlt", 200) || null;
  const config = await prisma.careerSiteConfig.findUnique({ where: { tenantId: viewer.tenantId }, select: { requireAltText: true } });
  if (imageFileId && !imageAlt && (config?.requireAltText ?? true)) return fail("Describe the image for screen readers (alt text).", f, { imageAlt: "Required" });
  const data = {
    kind, title, body, slug, locale, locationId, audience: str(f, "audience", 80) || null, personName: str(f, "personName", 120) || null, personTitle: str(f, "personTitle", 120) || null,
    contactEmail: contactEmail || null, imageFileId, imageAlt, campaignCode: str(f, "campaignCode", 40).toUpperCase() || null, seoTitle: str(f, "seoTitle", 70) || null, seoDescription: str(f, "seoDescription", 170) || null,
    sortOrder: numField(f, "sortOrder") ?? existing?.sortOrder ?? 0,
  };
  let c;
  if (existing) {
    // The current text is kept as a version; the edited block is a draft until approved again.
    await prisma.careerContentVersion.create({ data: { contentId: existing.id, version: existing.version, snapshot: snapshotOf(existing), note: str(f, "note", 300) || null, createdBy: viewer.user.id } });
    c = await prisma.careerContent.update({ where: { id: existing.id }, data: { ...data, version: existing.version + 1, status: "DRAFT" } });
  } else {
    c = await prisma.careerContent.create({ data: { tenantId: viewer.tenantId, ...data, createdBy: viewer.user.id } });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: existing ? "UPDATE" : "CREATE", entityType: "CareerContent", entityId: c.id, summary: `${existing ? `Edited (v${c.version})` : "Drafted"} ${kind.toLowerCase()} “${title}”`, oldValue: existing ? { title: existing.title, status: existing.status, version: existing.version } : undefined, newValue: { title, kind, locale } });
  return done([...PATHS, `/hiring/settings/careers/content/${c.id}`], existing?.status === "PUBLISHED" ? "Saved as a new draft version; submit it to publish." : "Saved as a draft.");
}

export async function submitCareerContentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const c = await prisma.careerContent.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!c) return fail("Content not found.");
  if (!["DRAFT", "ARCHIVED"].includes(c.status)) return fail(`It is ${c.status.toLowerCase().replace("_", " ")}.`);
  await prisma.careerContent.update({ where: { id: c.id }, data: { status: "PENDING_APPROVAL" } });
  const r = await startHireRequest({ tenantId: viewer.tenantId, kind: "CONTENT_PUBLISH", entityId: c.id, title: `Publish ${c.kind.toLowerCase()} “${c.title}” (v${c.version}) on the careers site`, details: c.body.slice(0, 500), requesterUserId: viewer.user.id, subjectEmployeeId: viewer.employee?.id ?? null });
  if (!r.ok) { await prisma.careerContent.update({ where: { id: c.id }, data: { status: c.status } }); return fail(r.message); }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerContent", entityId: c.id, summary: `Submitted “${c.title}” v${c.version} for publishing` });
  return done([...PATHS, `/hiring/settings/careers/content/${c.id}`], r.status === "PENDING" ? "Sent for approval." : "Published.");
}

export async function archiveCareerContentAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const c = await prisma.careerContent.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!c) return fail("Content not found.");
  if (c.status === "ARCHIVED" || c.status === "PENDING_APPROVAL") return fail(`It is ${c.status.toLowerCase().replace("_", " ")}.`);
  await prisma.careerContent.update({ where: { id: c.id }, data: { status: "ARCHIVED" } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerContent", entityId: c.id, summary: `Took “${c.title}” off the careers site` });
  return done([...PATHS, `/hiring/settings/careers/content/${c.id}`], "Archived.");
}

/** Bring back an earlier version as the new draft (the current one is kept as a version too). */
export async function restoreCareerContentVersionAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const v = await prisma.careerContentVersion.findFirst({ where: { id: str(f, "versionId"), content: { tenantId: viewer.tenantId } }, include: { content: true } });
  if (!v) return fail("Version not found.");
  const c = v.content;
  if (c.status === "PENDING_APPROVAL") return fail("This is waiting for approval; it cannot change now.");
  const snap = v.snapshot as Record<string, string | null>;
  if (snap.slug && (await prisma.careerContent.count({ where: { tenantId: viewer.tenantId, slug: snap.slug, NOT: { id: c.id } } }))) return fail("Another page now uses that version's web address.");
  await prisma.careerContentVersion.create({ data: { contentId: c.id, version: c.version, snapshot: snapshotOf(c), note: `Before restoring v${v.version}`, createdBy: viewer.user.id } });
  await prisma.careerContent.update({ where: { id: c.id }, data: {
    title: snap.title ?? c.title, body: snap.body ?? c.body, slug: snap.slug ?? null, locale: snap.locale ?? c.locale, imageAlt: snap.imageAlt ?? null, imageFileId: snap.imageFileId ?? null,
    seoTitle: snap.seoTitle ?? null, seoDescription: snap.seoDescription ?? null, personName: snap.personName ?? null, personTitle: snap.personTitle ?? null, contactEmail: snap.contactEmail ?? null,
    campaignCode: snap.campaignCode ?? null, locationId: snap.locationId ?? null, audience: snap.audience ?? null, version: c.version + 1, status: "DRAFT",
  } });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerContent", entityId: c.id, summary: `Restored “${c.title}” to v${v.version} as a draft` });
  return done([...PATHS, `/hiring/settings/careers/content/${c.id}`], `Restored v${v.version} as a draft; submit it to publish.`);
}

// ---------------------------------------------------------------------------
//  Site configuration and versions
// ---------------------------------------------------------------------------

export async function saveCareerSiteConfigAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const tag = str(f, "analyticsTagId", 40);
  if (tag && !/^(G|GTM|UA)-[A-Z0-9-]{4,30}$/i.test(tag)) return fail("Enter a measurement ID like G-XXXXXXX or GTM-XXXXXX.", f, { analyticsTagId: "Invalid" });
  const locales = [...new Set(["en", ...str(f, "locales", 100).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)])];
  const bad = locales.find((l) => !LOCALE.test(l));
  if (bad) return fail(`“${bad}” is not a two-letter language code.`, f, { locales: "Invalid" });
  await snapshotCareerSite(viewer.tenantId, viewer.user.id, "Before a settings change");
  const before = await prisma.careerSiteConfig.findUnique({ where: { tenantId: viewer.tenantId } });
  const data = {
    seoTitle: str(f, "seoTitle", 70) || null, seoDescription: str(f, "seoDescription", 170) || null, analyticsTagId: tag ? tag.toUpperCase() : null, locales,
    highContrast: f.get("highContrast") === "on", largeText: f.get("largeText") === "on", reduceMotion: f.get("reduceMotion") === "on", requireAltText: f.get("requireAltText") === "on",
    groupByLocation: f.get("groupByLocation") === "on", showRecruiterContacts: f.get("showRecruiterContacts") === "on",
  };
  await prisma.careerSiteConfig.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...data }, update: data });
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerSiteConfig", summary: "Updated careers site SEO, accessibility and languages", oldValue: before ? { seoTitle: before.seoTitle, analyticsTagId: before.analyticsTagId, locales: before.locales } : undefined, newValue: data });
  return done(["/hiring/settings/careers/site", "/careers"], "Careers site settings saved; the previous settings are kept as a version.");
}

export async function restoreCareerSiteSnapshotAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const snap = await prisma.careerSiteSnapshot.findFirst({ where: { id: str(f, "id"), tenantId: viewer.tenantId } });
  if (!snap) return fail("Version not found.");
  const d = snap.data as { site: Record<string, unknown> | null; config: Record<string, unknown> | null };
  await snapshotCareerSite(viewer.tenantId, viewer.user.id, `Before restoring v${snap.version}`);
  if (d.site) {
    const s = d.site;
    const site = {
      headline: (s.headline as string | null) ?? null, about: (s.about as string | null) ?? null,
      primaryColor: isHexColor(String(s.primaryColor ?? "")) ? String(s.primaryColor) : "#1266a8", accentColor: isHexColor(String(s.accentColor ?? "")) ? String(s.accentColor) : "#0f8a55",
      logoFileId: (s.logoFileId as string | null) ?? null, bannerFileId: (s.bannerFileId as string | null) ?? null, embedEnabled: s.embedEnabled !== false, collectEeo: s.collectEeo === true,
    };
    await prisma.careerSiteSetting.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...site }, update: site });
  }
  if (d.config) {
    const c = d.config;
    const config = {
      seoTitle: (c.seoTitle as string | null) ?? null, seoDescription: (c.seoDescription as string | null) ?? null, analyticsTagId: (c.analyticsTagId as string | null) ?? null,
      locales: (Array.isArray(c.locales) ? c.locales : ["en"]) as Prisma.InputJsonValue, highContrast: c.highContrast === true, largeText: c.largeText === true, reduceMotion: c.reduceMotion === true,
      requireAltText: c.requireAltText !== false, groupByLocation: c.groupByLocation === true, showRecruiterContacts: c.showRecruiterContacts !== false,
    };
    await prisma.careerSiteConfig.upsert({ where: { tenantId: viewer.tenantId }, create: { tenantId: viewer.tenantId, ...config }, update: config });
  } else {
    // That version predates any SEO/accessibility settings: back to the defaults.
    await prisma.careerSiteConfig.deleteMany({ where: { tenantId: viewer.tenantId } });
  }
  await writeAudit(viewer, { module: "EMPLOYEE", action: "UPDATE", entityType: "CareerSiteConfig", entityId: snap.id, summary: `Rolled the careers site back to v${snap.version}` });
  return done(["/hiring/settings/careers/site", "/hiring/settings", "/careers"], `Restored v${snap.version}.`);
}

export async function snapshotCareerSiteAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const viewer = await requireAuth(HP.CAREER_PORTAL_MANAGE);
  const v = await snapshotCareerSite(viewer.tenantId, viewer.user.id, str(f, "note", 200) || "Saved by hand");
  await writeAudit(viewer, { module: "EMPLOYEE", action: "CREATE", entityType: "CareerSiteSnapshot", summary: `Saved careers site version v${v}` });
  return done(["/hiring/settings/careers/site"], `Saved as v${v}.`);
}
