import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { tenantFromHost } from "@/lib/tenant-host";
import { careerConfig, visitorLocale } from "../site";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await tenantFromHost();
  return { title: tenant ? `Hiring FAQ — ${tenant.name}` : "Careers FAQ" };
}

/** Answers to the questions candidates ask most, published from Hire › Settings › Careers content. */
export default async function CareersFaqPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const tenant = (await tenantFromHost())!;
  const config = await careerConfig(tenant.id);
  const locale = await visitorLocale((await searchParams).lang, config.locales);
  const all = await prisma.careerContent.findMany({ where: { tenantId: tenant.id, kind: "FAQ", status: "PUBLISHED", locale: { in: [...new Set([locale, "en"])] } }, orderBy: [{ sortOrder: "asc" }, { title: "asc" }] });
  const faqs = all.some((f) => f.locale === locale) ? all.filter((f) => f.locale === locale) : all;
  const ld = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.title, acceptedAnswer: { "@type": "Answer", text: f.body } })) };
  return (
    <>
      {faqs.length ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} /> : null}
      <Link href="/careers" className="text-sm subtle">‹ Careers</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 16px" }}>Frequently asked questions</h1>
      {faqs.length === 0 ? <div className="card" style={{ padding: 20 }}>No questions published yet. <Link href="/careers/community">Get in touch through our talent community.</Link></div> : (
        <div className="stack gap-2" data-testid="faq-list" lang={locale}>
          {faqs.map((f) => (
            <details key={f.id} className="card" style={{ padding: 14 }}>
              <summary className="strong" style={{ cursor: "pointer" }}>{f.title}</summary>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, marginTop: 8 }}>{f.body}</div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}
