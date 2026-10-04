import "server-only";
import { headers } from "next/headers";
import { prisma } from "@keka/db";
import { hireStringList, pickLocale } from "@keka/services";

/** The careers site's SEO, accessibility and language settings, with defaults. */
export async function careerConfig(tenantId: string) {
  const c = await prisma.careerSiteConfig.findUnique({ where: { tenantId } });
  return {
    seoTitle: c?.seoTitle ?? null, seoDescription: c?.seoDescription ?? null, analyticsTagId: c?.analyticsTagId ?? null,
    locales: c ? hireStringList(c.locales).filter((l) => /^[a-z]{2}$/.test(l)) : ["en"],
    highContrast: c?.highContrast ?? false, largeText: c?.largeText ?? false, reduceMotion: c?.reduceMotion ?? false,
    groupByLocation: c?.groupByLocation ?? false, showRecruiterContacts: c?.showRecruiterContacts ?? true,
  };
}

/** The visitor's language: ?lang, else their browser's, among the site's languages. */
export async function visitorLocale(requested: string | undefined, offered: string[]): Promise<string> {
  const h = await headers();
  return pickLocale(requested ?? null, h.get("accept-language"), offered);
}

type SP = { utm_source?: string; utm_medium?: string; utm_campaign?: string; campaign?: string };
const clip = (v: string | undefined, n = 80) => (v ? v.trim().slice(0, n) || null : null);

/** Count a visit (for source analytics and the campaign funnel). Never fails the page. */
export async function recordCareerVisit(tenantId: string, path: string, sp: SP, jobId: string | null = null): Promise<void> {
  try {
    const h = await headers();
    let referrerHost: string | null = null;
    try { referrerHost = h.get("referer") ? new URL(h.get("referer")!).host.slice(0, 120) : null; } catch { referrerHost = null; }
    await prisma.careerSiteVisit.create({ data: { tenantId, path: path.slice(0, 200), jobId, utmSource: clip(sp.utm_source), utmMedium: clip(sp.utm_medium), utmCampaign: clip(sp.utm_campaign), campaignCode: clip(sp.campaign, 40)?.toUpperCase() ?? null, referrerHost } });
  } catch {
    // Analytics must never break the careers site.
  }
}

export const tracking = (sp: SP) => ({ utmSource: clip(sp.utm_source) ?? undefined, utmCampaign: clip(sp.utm_campaign) ?? undefined, campaign: clip(sp.campaign, 40) ?? undefined });
