import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@keka/db";
import { GrowthForm } from "@/components/growth-forms";
import { tenantFromHost } from "@/lib/tenant-host";
import { subscribeJobAlertAction } from "../portal-actions";
import { publicJobWhere } from "../data";

export const metadata: Metadata = { title: "Job alerts" };

/** Sign up for an email when a matching role opens (confirmed by email first). */
export default async function JobAlertsPage() {
  const tenant = (await tenantFromHost())!;
  const jobs = await prisma.job.findMany({ where: publicJobWhere(tenant.id), select: { departmentId: true, locationId: true } });
  // Teams that are hiring now first, then every other team (an alert is for future roles too).
  const hiring = new Set(jobs.map((j) => j.departmentId).filter((x): x is string => !!x));
  const [allDepts, locs] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    prisma.location.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, city: true }, orderBy: { name: "asc" }, take: 100 }),
  ]);
  const depts = [...allDepts.filter((d) => hiring.has(d.id)), ...allDepts.filter((d) => !hiring.has(d.id))];
  return (
    <>
      <Link href="/careers" className="text-sm subtle">‹ Careers</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 4px" }}>Job alerts</h1>
      <p className="muted">Tell us what you are looking for and we will email you when a matching role at {tenant.name} opens. You can unsubscribe from any alert email.</p>
      <div className="card" style={{ padding: 20 }}>
        <GrowthForm action={subscribeJobAlertAction} cols={2} submitLabel="Create alert" hidden={{ website: "" }} fields={[
          { name: "email", label: "Email", required: true },
          { name: "keywords", label: "Keywords", placeholder: "e.g. engineer, design" },
          { name: "departmentId", label: "Team", type: "select", options: depts.map((d) => ({ value: d.id, label: d.name })), placeholder: "Any team" },
          { name: "locationId", label: "Location", type: "select", options: locs.map((l) => ({ value: l.id, label: l.city ?? l.name })), placeholder: "Anywhere" },
          { name: "consent", label: `I agree to receive job alert emails from ${tenant.name}.`, type: "checkbox" },
        ]} />
      </div>
    </>
  );
}
