import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { ensureReadinessLevels, isReadyNow, successionCoverage, planRisk } from "@keka/services";
import { requireAuth } from "@/lib/context";
import { successionReport, SUCCESSION_REPORTS, type SuccessionReportKind } from "@/lib/growth-reports";
import { PageHead, Badge, Stat } from "@/components/ui";
import { Panel, EmptyState, SectionTitle } from "@/components/keka";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { STATUS_TONE, ReportView } from "@/components/growth-report";
import { saveSuccessionPlanAction, saveReadinessLevelAction, deleteReadinessLevelAction } from "@/app/actions/succession";

const P = PERMISSIONS;
const LMH = [{ value: "HIGH", label: "High" }, { value: "MEDIUM", label: "Medium" }, { value: "LOW", label: "Low" }];
const RISK_TONE: Record<string, "success" | "warning" | "danger"> = { COVERED: "success", WATCH: "warning", AT_RISK: "danger" };

export default async function SuccessionPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; report?: string }> }) {
  const viewer = await requireAuth(P.SUCCESSION_MANAGE);
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const status = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "ARCHIVED"].includes(sp.status ?? "") ? (sp.status as "DRAFT") : undefined;
  const kind = (sp.report && sp.report in SUCCESSION_REPORTS ? sp.report : "plans") as SuccessionReportKind;
  const [plans, levels, people, departments, report] = await Promise.all([
    prisma.successionPlan.findMany({
      where: { tenantId: viewer.tenantId, ...(status ? { status } : {}), ...(q ? { OR: [{ positionTitle: { contains: q, mode: "insensitive" } }, { incumbent: { displayName: { contains: q, mode: "insensitive" } } }] } : {}) },
      include: { incumbent: { select: { displayName: true } }, successors: { include: { readiness: true } } },
      orderBy: [{ criticality: "asc" }, { positionTitle: "asc" }],
    }),
    ensureReadinessLevels(viewer.tenantId),
    prisma.employee.findMany({ where: { tenantId: viewer.tenantId, status: { notIn: ["EXITED", "INACTIVE"] } }, select: { id: true, displayName: true, jobTitleName: true }, orderBy: { firstName: "asc" }, take: 2000 }),
    prisma.department.findMany({ where: { tenantId: viewer.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    successionReport(viewer, kind),
  ]);
  const shaped = plans.map((p) => ({ ...p, successors: p.successors.map((s) => ({ status: s.status, readyNow: isReadyNow(s.readiness), isEmergency: s.isEmergency })) }));
  const live = shaped.filter((p) => p.status !== "ARCHIVED");
  const cov = successionCoverage(live);

  return (
    <>
      <PageHead title="Succession" subtitle="Critical positions, their successors and how ready they are" actions={<Link className="btn" href="/performance/talent-reviews">Talent reviews</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Critical positions" value={cov.positions} />
        <Stat label="Covered (ready-now successor)" value={cov.covered} meta={`${cov.coverage}% coverage`} />
        <Stat label="Bench strength" value={cov.benchStrength} meta="Approved successors per position" />
        <Stat label="At risk" value={live.filter((p) => planRisk(p) === "AT_RISK").length} tone={live.some((p) => planRisk(p) === "AT_RISK") ? "neg" : undefined} meta="No ready-now cover, high stakes" />
      </div>
      <form className="row gap-2 wrap" style={{ marginBottom: 14 }}>
        <input className="input" name="q" defaultValue={q} placeholder="Search position or incumbent" style={{ maxWidth: 300 }} />
        <select className="select" name="status" defaultValue={status ?? ""} style={{ maxWidth: 180 }}>
          <option value="">Any status</option>{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
        <button className="btn">Search</button>
      </form>
      <Reveal label="+ New succession plan">
        <Panel title="New succession plan">
          <GrowthForm action={saveSuccessionPlanAction} submitLabel="Create plan" fields={[
            { name: "positionTitle", label: "Critical position", required: true, placeholder: "Head of Engineering" },
            { name: "incumbentId", label: "Current holder", type: "select", options: people.map((p) => ({ value: p.id, label: `${p.displayName}${p.jobTitleName ? ` · ${p.jobTitleName}` : ""}` })) },
            { name: "departmentId", label: "Department", type: "select", options: departments.map((d) => ({ value: d.id, label: d.name })) },
            { name: "criticality", label: "Criticality", type: "select", required: true, options: LMH, defaultValue: "HIGH" },
            { name: "riskOfLoss", label: "Risk of losing the holder", type: "select", required: true, options: LMH, defaultValue: "MEDIUM" },
            { name: "vacancyImpact", label: "Impact if vacant", type: "textarea" },
          ]} />
        </Panel>
      </Reveal>
      <Panel pad={false}>
        {plans.length === 0 ? <EmptyState title="No succession plans yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Position</th><th>Holder</th><th>Criticality</th><th>Risk of loss</th><th className="num">Successors</th><th>Cover</th><th>Status</th></tr></thead>
              <tbody>
                {shaped.map((p) => (
                  <tr key={p.id}>
                    <td><Link className="strong" href={`/performance/succession/${p.id}`}>{p.positionTitle}</Link></td>
                    <td className="text-sm">{p.incumbent?.displayName ?? <span className="neg">Vacant</span>}</td>
                    <td className="text-sm">{p.criticality.toLowerCase()}</td>
                    <td className="text-sm">{p.riskOfLoss.toLowerCase()}</td>
                    <td className="num">{p.successors.filter((s) => s.status === "APPROVED").length}{p.successors.some((s) => s.status === "NOMINATED") ? <div className="text-xs subtle">+{p.successors.filter((s) => s.status === "NOMINATED").length} nominated</div> : null}</td>
                    <td><Badge tone={RISK_TONE[planRisk(p)]} dot>{planRisk(p).replace("_", " ").toLowerCase()}</Badge></td>
                    <td><Badge tone={STATUS_TONE[p.status]} dot>{p.status.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <SectionTitle sub="Download any of these as CSV">Reports</SectionTitle>
      <ReportView report={report} base="/performance/succession" kinds={SUCCESSION_REPORTS} kind={kind} exportHref={`/performance/succession/export?kind=${kind}`} />

      <SectionTitle sub="How soon a successor could step in">Readiness levels</SectionTitle>
      <Panel pad={false}>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Level</th><th>Code</th><th className="num">Months</th><th>Active</th><th /></tr></thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.id}>
                  <td><span className="strong">{l.name}</span>{l.description ? <div className="text-xs subtle">{l.description}</div> : null}</td>
                  <td className="text-sm">{l.code}</td>
                  <td className="num">{l.minMonths}{l.maxMonths === null ? "+" : l.maxMonths !== l.minMonths ? `–${l.maxMonths}` : ""}</td>
                  <td className="text-sm">{l.isActive ? "Yes" : "No"}</td>
                  <td className="right" style={{ minWidth: 200 }}>
                    <Reveal label="Edit">
                      <GrowthForm action={saveReadinessLevelAction} hidden={{ id: l.id }} cols={2} compact fields={[
                        { name: "name", label: "Name", required: true, defaultValue: l.name },
                        { name: "code", label: "Code", defaultValue: l.code },
                        { name: "minMonths", label: "From (months)", type: "number", min: 0, max: 240, defaultValue: l.minMonths },
                        { name: "maxMonths", label: "To (months)", type: "number", min: 0, max: 240, defaultValue: l.maxMonths },
                        { name: "displayOrder", label: "Order", type: "number", min: 0, max: 100, defaultValue: l.displayOrder },
                        { name: "isActive", label: "Active", type: "select", required: true, options: [{ value: "on", label: "Yes" }, { value: "off", label: "No" }], defaultValue: l.isActive ? "on" : "off" },
                        { name: "description", label: "Description", defaultValue: l.description },
                      ]} />
                    </Reveal>
                    <ActButton action={deleteReadinessLevelAction} hidden={{ id: l.id }} label="Delete" variant="ghost" confirmText="Delete this readiness level?" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
          <GrowthForm action={saveReadinessLevelAction} cols={4} compact submitLabel="Add level" fields={[
            { name: "name", label: "New level", required: true },
            { name: "minMonths", label: "From (months)", type: "number", min: 0, max: 240 },
            { name: "maxMonths", label: "To (months)", type: "number", min: 0, max: 240 },
            { name: "displayOrder", label: "Order", type: "number", min: 0, max: 100 },
          ]} />
        </div>
      </Panel>
    </>
  );
}
