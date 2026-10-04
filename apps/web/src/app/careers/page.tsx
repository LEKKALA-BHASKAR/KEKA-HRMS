import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { LOCALE_NAMES } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { publicJobWhere } from "./data";
import { careerConfig, visitorLocale, recordCareerVisit } from "./site";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await tenantFromHost();
  if (!tenant) return { title: "Careers" };
  const c = await careerConfig(tenant.id);
  return { title: c.seoTitle || `Careers at ${tenant.name}`, description: c.seoDescription || undefined, openGraph: { title: c.seoTitle || `Careers at ${tenant.name}`, description: c.seoDescription || undefined } };
}

const TYPE: Record<string, string> = { FULL_TIME: "Full time", PART_TIME: "Part time", CONTRACT: "Contract", INTERN: "Internship" };
const MODE: Record<string, string> = { ONSITE: "On site", HYBRID: "Hybrid", REMOTE: "Remote" };

type SP = { q?: string; dept?: string; loc?: string; lang?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; campaign?: string };

/** Open, published jobs anyone can browse and apply to, with the company's story around them. */
export default async function CareersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const tenant = (await tenantFromHost())!;
  const sp = await searchParams;
  await recordCareerVisit(tenant.id, "/careers", sp);
  const config = await careerConfig(tenant.id);
  const locale = await visitorLocale(sp.lang, config.locales);
  const q = (sp.q ?? "").trim().slice(0, 80);
  const jobs = await prisma.job.findMany({
    where: { ...publicJobWhere(tenant.id), ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}), ...(sp.dept ? { departmentId: sp.dept } : {}), ...(sp.loc ? { locationId: sp.loc } : {}) },
    select: { id: true, title: true, departmentId: true, locationId: true, employmentType: true, workMode: true, publishedAt: true, minExperienceYears: true },
    orderBy: { publishedAt: "desc" },
  });
  const [depts, locs, content] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.locationId).filter((x): x is string => !!x) } }, select: { id: true, name: true, city: true } }),
    prisma.careerContent.findMany({ where: { tenantId: tenant.id, status: "PUBLISHED", locale: { in: [...new Set([locale, "en"])] } }, orderBy: [{ sortOrder: "asc" }, { publishedAt: "desc" }] }),
  ]);
  // A block in the visitor's language wins over its English one (same kind and slug or title).
  const blocks = content.filter((c) => c.locale === locale || !content.some((o) => o.locale === locale && o.kind === c.kind && (o.slug ?? o.title) === (c.slug ?? c.title)));
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { headline: true, about: true, bannerFileId: true, accentColor: true } });
  const dept = new Map(depts.map((d) => [d.id, d.name]));
  const loc = new Map(locs.map((l) => [l.id, l.city ?? l.name]));
  const of = (k: string) => blocks.filter((b) => b.kind === k);
  const card = (b: (typeof blocks)[number]) => (
    <div key={b.id} className="card" style={{ padding: 16 }} data-testid={`career-${b.kind.toLowerCase()}`}>
      {b.imageFileId ? <img src={`/careers/asset/${b.imageFileId}`} alt={b.imageAlt ?? ""} style={{ width: "100%", maxHeight: 180, objectFit: "cover", borderRadius: 6, marginBottom: 10 }} /> : null}
      <div className="strong">{b.slug ? <Link href={`/careers/p/${b.slug}`}>{b.title}</Link> : b.title}</div>
      <div className="text-sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, marginTop: 4 }}>{b.slug ? `${b.body.slice(0, 220)}${b.body.length > 220 ? "…" : ""}` : b.body}</div>
    </div>
  );
  const jobRow = (j: (typeof jobs)[number]) => (
    <Link key={j.id} href={`/careers/${j.id}`} className="card" style={{ padding: 16, display: "block" }}>
      <div className="strong" style={{ fontSize: 16 }}>{j.title}</div>
      <div className="text-sm muted">
        {[j.departmentId ? dept.get(j.departmentId) : null, j.locationId ? loc.get(j.locationId) : null, TYPE[j.employmentType] ?? j.employmentType, MODE[j.workMode] ?? j.workMode, j.minExperienceYears ? `${Number(j.minExperienceYears)}+ yrs` : null].filter(Boolean).join(" · ")}
      </div>
    </Link>
  );
  const byLocation = new Map<string, typeof jobs>();
  for (const j of jobs) { const k = j.locationId ? loc.get(j.locationId) ?? "Other" : "Anywhere"; byLocation.set(k, [...(byLocation.get(k) ?? []), j]); }
  const recruiters = config.showRecruiterContacts ? of("RECRUITER") : [];

  return (
    <>
      {config.locales.length > 1 ? (
        <nav aria-label="Language" className="row gap-2 text-sm" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
          {config.locales.map((l) => <Link key={l} href={`/careers?lang=${l}`} lang={l} aria-current={l === locale ? "true" : undefined} className={l === locale ? "strong" : "subtle"}>{LOCALE_NAMES[l] ?? l}</Link>)}
        </nav>
      ) : null}
      {site?.bannerFileId ? <img src={`/careers/asset/${site.bannerFileId}`} alt="" style={{ width: "100%", maxHeight: 240, objectFit: "cover", borderRadius: 8, marginBottom: 18, display: "block" }} /> : null}
      <h1 style={{ fontSize: 28, margin: "0 0 4px" }}>{site?.headline || "Work with us"}</h1>
      {site?.about ? <div style={{ margin: "8px 0 16px", padding: "12px 16px", borderLeft: `3px solid ${site.accentColor}`, background: "#fff", borderRadius: 4, whiteSpace: "pre-wrap", lineHeight: 1.6 }} data-testid="careers-about">{site.about}</div> : null}
      {of("EVP").length ? <section aria-label="Why join us" className="grid grid-2" style={{ gap: 12, margin: "12px 0" }}>{of("EVP").map(card)}</section> : null}
      <p className="muted" style={{ marginTop: 0 }}>{jobs.length} open role{jobs.length === 1 ? "" : "s"} at {tenant.name}.</p>
      <form className="row gap-2" style={{ margin: "16px 0", flexWrap: "wrap" }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search roles" aria-label="Search roles" style={{ flex: 1, minWidth: 180 }} />
        {depts.length > 1 ? (
          <select className="input" name="dept" defaultValue={sp.dept ?? ""} aria-label="Department">
            <option value="">All teams</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
        {locs.length > 1 ? (
          <select className="input" name="loc" defaultValue={sp.loc ?? ""} aria-label="Location">
            <option value="">All locations</option>
            {locs.map((l) => <option key={l.id} value={l.id}>{l.city ?? l.name}</option>)}
          </select>
        ) : null}
        {locale !== "en" ? <input type="hidden" name="lang" value={locale} /> : null}
        <button className="btn">Search</button>
      </form>
      {jobs.length === 0 ? <div className="card" style={{ padding: 24 }}>No open roles match right now. <Link href="/careers/alerts">Get an alert</Link> when one opens.</div> : config.groupByLocation ? (
        <div className="stack gap-3" data-testid="jobs-by-location">
          {[...byLocation.entries()].map(([city, list]) => (
            <section key={city} aria-label={city}>
              <h2 style={{ fontSize: 16, margin: "8px 0" }}>{city} <span className="text-sm subtle">({list.length})</span></h2>
              <div className="stack gap-2">{list.map(jobRow)}</div>
            </section>
          ))}
        </div>
      ) : <div className="stack gap-2">{jobs.map(jobRow)}</div>}
      {of("CULTURE").length || of("DIVERSITY").length ? (
        <section aria-label="Culture and inclusion" style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18 }}>Life at {tenant.name}</h2>
          <div className="grid grid-2" style={{ gap: 12 }}>{[...of("CULTURE"), ...of("DIVERSITY")].map(card)}</div>
        </section>
      ) : null}
      {of("STORY").length ? (
        <section aria-label="Employee stories" style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18 }}>Our people</h2>
          <div className="grid grid-2" style={{ gap: 12 }}>{of("STORY").map(card)}</div>
        </section>
      ) : null}
      {of("LOCATION").length ? (
        <section aria-label="Where we work" style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18 }}>Where we work</h2>
          <div className="grid grid-2" style={{ gap: 12 }}>{of("LOCATION").map(card)}</div>
        </section>
      ) : null}
      {recruiters.length ? (
        <section aria-label="Talk to a recruiter" style={{ marginTop: 28 }} data-testid="recruiter-widgets">
          <h2 style={{ fontSize: 18 }}>Talk to our recruiters</h2>
          <div className="grid grid-2" style={{ gap: 12 }}>
            {recruiters.map((r) => (
              <div key={r.id} className="card row gap-3" style={{ padding: 16, alignItems: "center" }}>
                {r.imageFileId ? <img src={`/careers/asset/${r.imageFileId}`} alt={r.imageAlt ?? ""} style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover" }} /> : null}
                <div>
                  <div className="strong">{r.personName ?? r.title}</div>
                  <div className="text-sm muted">{r.personTitle ?? r.audience ?? ""}</div>
                  <div className="text-sm">{r.body.slice(0, 160)}</div>
                  {r.contactEmail ? <a className="text-sm" href={`mailto:${r.contactEmail}`}>{r.contactEmail}</a> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <p className="text-sm muted" style={{ marginTop: 28 }}>
        Not the right role? <Link href="/careers/community">Join our talent community</Link> or <Link href="/careers/alerts">set up a job alert</Link>.
      </p>
    </>
  );
}
