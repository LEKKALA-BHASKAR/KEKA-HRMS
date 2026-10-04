import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { EEO_OPTIONS } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { publicJobWhere } from "../data";
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
  return job ? { tenant, job } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await load((await params).id);
  return { title: got ? `${got.job.title} — ${got.tenant.name}` : "Careers" };
}

const inr = (n: unknown) => `₹${(Number(n) / 100000).toFixed(1)}L`;

/** One open role: what it is, and the form to apply. */
export default async function PublicJobPage({ params }: { params: Promise<{ id: string }> }) {
  const got = await load((await params).id);
  if (!got) notFound();
  const { job } = got;
  const collectEeo = !!(await prisma.careerSiteSetting.findUnique({ where: { tenantId: got.tenant.id }, select: { collectEeo: true } }))?.collectEeo;
  const [dept, loc] = await Promise.all([
    job.departmentId ? prisma.department.findUnique({ where: { id: job.departmentId }, select: { name: true } }) : null,
    job.locationId ? prisma.location.findUnique({ where: { id: job.locationId }, select: { name: true, city: true } }) : null,
  ]);
  const section = (title: string, body: string | null) => body ? (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>{title}</h2>
      <div className="text-sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{body}</div>
    </section>
  ) : null;
  return (
    <>
      <Link href="/careers" className="text-sm subtle">‹ All roles</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 4px" }}>{job.title}</h1>
      <div className="text-sm muted">
        {[dept?.name, loc ? (loc.city ?? loc.name) : null, job.minExperienceYears ? `${Number(job.minExperienceYears)}+ years` : null,
          !job.hideSalary && job.minAnnualCtc && job.maxAnnualCtc ? `${inr(job.minAnnualCtc)}–${inr(job.maxAnnualCtc)} a year` : null].filter(Boolean).join(" · ")}
      </div>
      <div className="grid grid-2" style={{ alignItems: "start", gap: 24, marginTop: 8 }}>
        <div>
          {section("About the role", job.description)}
          {section("What you will do", job.responsibilities)}
          {section("What we are looking for", job.requirements)}
        </div>
        <div className="card" style={{ padding: 20, marginTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Apply</h2>
          <ApplyForm jobId={job.id} eeo={collectEeo ? EEO_QUESTIONS : undefined} />
        </div>
      </div>
    </>
  );
}
