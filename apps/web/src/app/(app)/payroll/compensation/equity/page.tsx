import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { payEquityAnalysis } from "@keka/services";
import { formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { payEquityCohortAction } from "@/app/actions/compensation";

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const inr = (v: number | null) => (v === null ? "—" : formatINR(v));

/** Pay equity: gender pay gaps inside cohorts of comparable roles, flagged over each cohort's threshold. */
export default async function PayEquityPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.SALARY_REVISE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const [analysis, departments, bands, grades, titles, locations] = await Promise.all([
    payEquityAnalysis(t),
    prisma.department.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.band.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.payGrade.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.jobTitle.findMany({ where: { tenantId: t, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const editing = sp.edit ? analysis.find((a) => a.cohort.id === sp.edit)?.cohort : undefined;
  const opt = (xs: Array<{ id: string; name: string }>) => xs.map((x) => ({ value: x.id, label: x.name }));
  const label = (c: (typeof analysis)[number]["cohort"]) => [departments.find((d) => d.id === c.departmentId)?.name, bands.find((b) => b.id === c.bandId)?.name, grades.find((g) => g.id === c.payGradeId)?.name, titles.find((j) => j.id === c.designationId)?.name, locations.find((l) => l.id === c.locationId)?.name].filter(Boolean).join(" · ");
  const flagged = analysis.filter((a) => a.flagged);
  return (
    <>
      <PageHead title="Pay equity" subtitle="Gender pay gaps within comparable roles" actions={<Link className="btn" href="/payroll/compensation">Compensation</Link>} />
      {flagged.length ? <Callout tone="warning" title={`${flagged.length} cohort(s) over their threshold`}>{flagged.map((f) => f.cohort.name).join(", ")}. Review these before the next compensation round.</Callout> : null}
      <Card tight title="Cohorts" description="Gap = how much lower women's pay is than men's (mean and median annual CTC).">
        {analysis.length === 0 ? <Empty title="No cohorts yet">Define a cohort of comparable roles below.</Empty> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Cohort</th><th className="num">People</th><th className="num">Men / women</th><th className="num">Mean men</th><th className="num">Mean women</th><th className="num">Mean gap</th><th className="num">Median gap</th><th>Threshold</th><th /></tr></thead>
            <tbody>{analysis.map((a) => (
              <tr key={a.cohort.id}>
                <td><div className="text-sm strong">{a.cohort.name}</div><div className="text-xs subtle">{label(a.cohort)}</div></td>
                <td className="num">{a.size}</td>
                <td className="num">{a.counts.MALE ?? 0} / {a.counts.FEMALE ?? 0}</td>
                <td className="num">{inr(a.meanMale)}</td><td className="num">{inr(a.meanFemale)}</td>
                <td className="num">{pct(a.meanGapPct)}</td><td className="num">{pct(a.medianGapPct)}</td>
                <td>{a.flagged ? <Badge tone="danger">over {Number(a.cohort.thresholdPct)}%</Badge> : <Badge tone="success">within {Number(a.cohort.thresholdPct)}%</Badge>}</td>
                <td><Link className="btn sm" href={`/payroll/compensation/equity?edit=${a.cohort.id}`}>Edit</Link></td>
              </tr>
            ))}</tbody></table></div>
        )}
        <div style={{ padding: 12 }}>
          <Reveal label={editing ? `Edit ${editing.name}` : "New cohort"} open={!!editing}>
            <GrowthForm action={payEquityCohortAction} hidden={editing ? { id: editing.id } : {}} submitLabel="Save cohort" fields={[
              { name: "name", label: "Name", required: true, defaultValue: editing?.name },
              { name: "thresholdPct", label: "Flag gaps above %", type: "number", required: true, defaultValue: editing ? Number(editing.thresholdPct) : 5 },
              { name: "departmentId", label: "Department", type: "select", options: opt(departments), defaultValue: editing?.departmentId },
              { name: "bandId", label: "Band", type: "select", options: opt(bands), defaultValue: editing?.bandId },
              { name: "payGradeId", label: "Pay grade", type: "select", options: opt(grades), defaultValue: editing?.payGradeId },
              { name: "designationId", label: "Job title", type: "select", options: opt(titles), defaultValue: editing?.designationId },
              { name: "locationId", label: "Location", type: "select", options: opt(locations), defaultValue: editing?.locationId },
            ]} />
          </Reveal>
        </div>
      </Card>
    </>
  );
}
