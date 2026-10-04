import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { EEO_OPTIONS, jobPostingJsonLd, appBaseUrl, LOCALE_NAMES } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { publicJobWhere } from "../data";
import { careerConfig, visitorLocale, recordCareerVisit, tracking } from "../site";
import { ApplyForm, type EeoQuestion } from "./apply-form";

const EEO_QUESTIONS: EeoQuestion[] = [
  { name: "gender", label: "Gender", options: EEO_OPTIONS.gender },
  { name: "ethnicity", label: "Ethnicity", options: EEO_OPTIONS.ethnicity },
  { name: "veteranStatus", label: "Veteran status", options: EEO_OPTIONS.veteranStatus },
  { name: "disabilityStatus", label: "Disability", options: EEO_OPTIONS.disabilityStatus },
];

async function load(id: string) {
  const tenant = await tenantFromHost();
  if (!tenant) return null;
  const job = await prisma.job.findFirst({ where: { id, ...publicJobWhere(tenant.id) } });
  if (!job) return null;
  const meta = await prisma.jobPostingMeta.findUnique({ where: { jobId: job.id } });
  return { tenant, job, meta };
}

type Translations = Record<string, { title: string; description: string }>;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await load((await params).id);
  if (!got) return { title: "Careers" };
  return {
    title: got.meta?.seoTitle || `${got.job.title} — ${got.tenant.name}`,
    description: got.meta?.seoDescription || (got.job.description ?? "").slice(0, 160) || undefined,
    openGraph: { title: got.meta?.seoTitle || got.job.title, description: got.meta?.seoDescription || undefined, type: "website" },
  };
}

const inr = (n: unknown) => `₹${(Number(n) / 100000).toFixed(1)}L`;

/** One open role: what it is (in the visitor's language when translated), and the form to apply. */
export default async function PublicJobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; campaign?: string }> }) {
  const got = await load((await params).id);
  if (!got) notFound();
  const sp = await searchParams;
  const { job, tenant } = got;
  await recordCareerVisit(tenant.id, `/careers/${job.id}`, sp, job.id);
  const config = await careerConfig(tenant.id);
  const translations = (got.meta?.translations ?? {}) as Translations;
  const offered = config.locales.filter((l) => l === "en" || translations[l]);
  const locale = await visitorLocale(sp.lang, offered);
  const t = locale !== "en" ? translations[locale] : undefined;
  const collectEeo = !!(await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { collectEeo: true } }))?.collectEeo;
  const [dept, loc] = await Promise.all([
    job.departmentId ? prisma.department.findFirst({ where: { id: job.departmentId, tenantId: tenant.id }, select: { name: true } }) : null,
    job.locationId ? prisma.location.findFirst({ where: { id: job.locationId, tenantId: tenant.id }, select: { name: true, city: true } }) : null,
  ]);
  const ld = jobPostingJsonLd({
    title: job.title, description: job.description, employmentType: job.employmentType, workMode: job.workMode, publishedAt: job.publishedAt, closesAt: job.closesAt,
    minAnnualCtc: job.minAnnualCtc === null ? null : Number(job.minAnnualCtc), maxAnnualCtc: job.maxAnnualCtc === null ? null : Number(job.maxAnnualCtc), hideSalary: job.hideSalary,
    url: `${appBaseUrl().replace(/\/+$/, "")}/careers/${job.id}`,
  }, { name: tenant.name, city: loc?.city ?? loc?.name ?? null });
  const section = (title: string, body: string | null) => body ? (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>{title}</h2>
      <div className="text-sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{body}</div>
    </section>
  ) : null;
  return (
    <>
      <script type="application/ld+json" data-testid="job-jsonld" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} />
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <Link href="/careers" className="text-sm subtle">‹ All roles</Link>
        {offered.length > 1 ? (
          <nav aria-label="Language" className="row gap-2 text-sm">
            {offered.map((l) => <Link key={l} href={`/careers/${job.id}?lang=${l}`} lang={l} aria-current={l === locale ? "true" : undefined} className={l === locale ? "strong" : "subtle"}>{LOCALE_NAMES[l] ?? l}</Link>)}
          </nav>
        ) : null}
      </div>
      <h1 style={{ fontSize: 26, margin: "8px 0 4px" }} lang={locale}>{t?.title || job.title}</h1>
      <div className="text-sm muted">
        {[dept?.name, loc ? (loc.city ?? loc.name) : null, job.minExperienceYears ? `${Number(job.minExperienceYears)}+ years` : null,
          !job.hideSalary && job.minAnnualCtc && job.maxAnnualCtc ? `${inr(job.minAnnualCtc)}–${inr(job.maxAnnualCtc)} a year` : null].filter(Boolean).join(" · ")}
      </div>
      <div className="grid grid-2" style={{ alignItems: "start", gap: 24, marginTop: 8 }}>
        <div lang={locale}>
          {t ? section("About the role", t.description) : (
            <>
              {section("About the role", job.description)}
              {section("What you will do", job.responsibilities)}
              {section("What we are looking for", job.requirements)}
            </>
          )}
        </div>
        <div className="card" style={{ padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Apply</h2>
          <ApplyForm jobId={job.id} eeo={collectEeo ? EEO_QUESTIONS : undefined} tracking={tracking(sp)} />
        </div>
      </div>
    </>
  );
}
