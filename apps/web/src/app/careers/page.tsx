import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { tenantFromHost } from "@/lib/tenant-host";
import { publicJobWhere } from "./data";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await tenantFromHost();
  return { title: tenant ? `Careers at ${tenant.name}` : "Careers" };
}

const TYPE: Record<string, string> = { FULL_TIME: "Full time", PART_TIME: "Part time", CONTRACT: "Contract", INTERN: "Internship" };
const MODE: Record<string, string> = { ONSITE: "On site", HYBRID: "Hybrid", REMOTE: "Remote" };

/** Open, published jobs anyone can browse and apply to. */
export default async function CareersPage({ searchParams }: { searchParams: Promise<{ q?: string; dept?: string }> }) {
  const tenant = (await tenantFromHost())!;
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const jobs = await prisma.job.findMany({
    where: { ...publicJobWhere(tenant.id), ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}), ...(sp.dept ? { departmentId: sp.dept } : {}) },
    select: { id: true, title: true, departmentId: true, locationId: true, employmentType: true, workMode: true, publishedAt: true, minExperienceYears: true },
    orderBy: { publishedAt: "desc" },
  });
  const [depts, locs] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.locationId).filter((x): x is string => !!x) } }, select: { id: true, name: true, city: true } }),
  ]);
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { headline: true, about: true, bannerFileId: true, accentColor: true } });
  const dept = new Map(depts.map((d) => [d.id, d.name]));
  const loc = new Map(locs.map((l) => [l.id, l.city ?? l.name]));

  return (
    <>
      {site?.bannerFileId ? <img src={`/careers/asset/${site.bannerFileId}`} alt="" style={{ width: "100%", maxHeight: 240, objectFit: "cover", borderRadius: 8, marginBottom: 18, display: "block" }} /> : null}
      <h1 style={{ fontSize: 28, margin: "0 0 4px" }}>{site?.headline || "Work with us"}</h1>
      {site?.about ? <div style={{ margin: "8px 0 16px", padding: "12px 16px", borderLeft: `3px solid ${site.accentColor}`, background: "#fff", borderRadius: 4, whiteSpace: "pre-wrap", lineHeight: 1.6 }} data-testid="careers-about">{site.about}</div> : null}
      <p className="muted" style={{ marginTop: 0 }}>{jobs.length} open role{jobs.length === 1 ? "" : "s"} at {tenant.name}.</p>
      <form className="row gap-2" style={{ margin: "16px 0", flexWrap: "wrap" }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search roles" aria-label="Search roles" style={{ flex: 1, minWidth: 180 }} />
        {depts.length > 1 ? (
          <select className="input" name="dept" defaultValue={sp.dept ?? ""} aria-label="Department">
            <option value="">All teams</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
        <button className="btn">Search</button>
      </form>
      {jobs.length === 0 ? <div className="card" style={{ padding: 24 }}>No open roles match right now. Check back soon.</div> : (
        <div className="stack gap-2">
          {jobs.map((j) => (
            <Link key={j.id} href={`/careers/${j.id}`} className="card" style={{ padding: 16, display: "block" }}>
              <div className="strong" style={{ fontSize: 16 }}>{j.title}</div>
              <div className="text-sm muted">
                {[j.departmentId ? dept.get(j.departmentId) : null, j.locationId ? loc.get(j.locationId) : null, TYPE[j.employmentType] ?? j.employmentType, MODE[j.workMode] ?? j.workMode, j.minExperienceYears ? `${Number(j.minExperienceYears)}+ yrs` : null].filter(Boolean).join(" · ")}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
