import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { isHexColor } from "@keka/services";
import { tenantFromHost } from "@/lib/tenant-host";
import { companyUrl } from "@/lib/tenant-host-shared";
import { publicJobWhere } from "../../careers/data";

export const metadata: Metadata = { title: "Open roles", robots: { index: false, follow: true } };
export const dynamic = "force-dynamic";

/** Tells the embedding page how tall the widget is, so careers.js can size the iframe. */
const RESIZE = `(function(){function s(){try{parent.postMessage({bossHrJobsHeight:document.documentElement.scrollHeight},"*")}catch(e){}}window.addEventListener("load",s);new ResizeObserver(s).observe(document.body);s();})();`;

/**
 * The embeddable jobs widget: the company's open, published roles for its own
 * website, framed via careers.js or a plain iframe. Each role opens on the
 * career site in the top window, where the candidate applies. Shows nothing
 * when the company has switched embedding off.
 */
export default async function EmbedCareersPage() {
  const tenant = await tenantFromHost();
  if (!tenant) return <p style={{ padding: 16, fontFamily: "system-ui" }}>No company at this address.</p>;
  const site = await prisma.careerSiteSetting.findUnique({ where: { tenantId: tenant.id }, select: { embedEnabled: true, primaryColor: true } });
  if (site && !site.embedEnabled) return <p style={{ padding: 16, fontFamily: "system-ui" }} data-testid="embed-off">This job list is not available.</p>;
  const jobs = await prisma.job.findMany({ where: publicJobWhere(tenant.id), select: { id: true, title: true, workMode: true, departmentId: true, locationId: true }, orderBy: { publishedAt: "desc" }, take: 100 });
  const [depts, locs] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { tenantId: tenant.id, id: { in: jobs.map((j) => j.locationId).filter((x): x is string => !!x) } }, select: { id: true, name: true, city: true } }),
  ]);
  const dept = new Map(depts.map((d) => [d.id, d.name]));
  const loc = new Map(locs.map((l) => [l.id, l.city ?? l.name]));
  const base = companyUrl(tenant.subdomain).replace(/\/+$/, "");
  const colour = site && isHexColor(site.primaryColor) ? site.primaryColor : "#1266a8";
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: 8, background: "transparent" }}>
      {jobs.length === 0 ? <p>No open roles right now. Check back soon.</p> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {jobs.map((j) => (
            <li key={j.id} style={{ padding: "12px 4px", borderBottom: "1px solid #e4e4e7" }}>
              <a href={`${base}/careers/${j.id}`} target="_top" style={{ color: colour, fontWeight: 600, fontSize: 16, textDecoration: "none" }}>{j.title}</a>
              <div style={{ color: "#6b7280", fontSize: 13, marginTop: 2 }}>{[j.departmentId ? dept.get(j.departmentId) : null, j.locationId ? loc.get(j.locationId) : null, j.workMode.toLowerCase()].filter(Boolean).join(" · ")}</div>
            </li>
          ))}
        </ul>
      )}
      <p style={{ fontSize: 12, marginTop: 10 }}><a href={`${base}/careers`} target="_top" style={{ color: colour }}>All roles at {tenant.name} →</a></p>
      <script dangerouslySetInnerHTML={{ __html: RESIZE }} />
    </div>
  );
}
