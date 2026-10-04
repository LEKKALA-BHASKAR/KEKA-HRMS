import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { tenantFromHost } from "@/lib/tenant-host";
import { publicJobWhere } from "../../data";
import { recordCareerVisit } from "../../site";

async function load(slug: string) {
  const tenant = await tenantFromHost();
  if (!tenant) return null;
  const page = await prisma.careerContent.findFirst({ where: { tenantId: tenant.id, slug, status: "PUBLISHED" } });
  return page ? { tenant, page } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const got = await load((await params).slug);
  if (!got) return { title: "Careers" };
  return { title: got.page.seoTitle || `${got.page.title} — ${got.tenant.name}`, description: got.page.seoDescription || got.page.body.slice(0, 160) };
}

/**
 * A careers landing page (campaign, story or location page). A campaign
 * page carries its tracking code into the job links, so applications from
 * it are attributed to the campaign.
 */
export default async function CareerLandingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ utm_source?: string; utm_medium?: string; utm_campaign?: string; campaign?: string }> }) {
  const got = await load((await params).slug);
  if (!got) notFound();
  const { page, tenant } = got;
  const sp = await searchParams;
  const campaign = sp.campaign || page.campaignCode || undefined;
  await recordCareerVisit(tenant.id, `/careers/p/${page.slug}`, { ...sp, campaign });
  const jobs = page.kind === "LANDING" || page.kind === "LOCATION"
    ? await prisma.job.findMany({ where: { ...publicJobWhere(tenant.id), ...(page.locationId ? { locationId: page.locationId } : {}) }, select: { id: true, title: true }, orderBy: { publishedAt: "desc" }, take: 20 })
    : [];
  const qs = new URLSearchParams({ ...(campaign ? { campaign } : {}), ...(sp.utm_source ? { utm_source: sp.utm_source } : {}), ...(sp.utm_campaign ? { utm_campaign: sp.utm_campaign } : {}) }).toString();
  return (
    <article lang={page.locale}>
      <Link href="/careers" className="text-sm subtle">‹ Careers</Link>
      {page.imageFileId ? <img src={`/careers/asset/${page.imageFileId}`} alt={page.imageAlt ?? ""} style={{ width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 8, margin: "12px 0" }} /> : null}
      <h1 style={{ fontSize: 26, margin: "8px 0" }}>{page.title}</h1>
      {page.personName ? <div className="text-sm muted">{page.personName}{page.personTitle ? `, ${page.personTitle}` : ""}</div> : null}
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, marginTop: 12 }}>{page.body}</div>
      {jobs.length ? (
        <section style={{ marginTop: 24 }} aria-label="Open roles">
          <h2 style={{ fontSize: 18 }}>Open roles</h2>
          <div className="stack gap-2">
            {jobs.map((j) => <Link key={j.id} className="card" style={{ padding: 14, display: "block" }} href={`/careers/${j.id}${qs ? `?${qs}` : ""}`}>{j.title}</Link>)}
          </div>
        </section>
      ) : null}
    </article>
  );
}
