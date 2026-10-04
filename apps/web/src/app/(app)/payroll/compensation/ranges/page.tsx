import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { compaRatioRows } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { proposePayRangeAction, locationDifferentialAction, allowanceChangeAction } from "@/app/actions/compensation";

const TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { PENDING: "warning", APPLIED: "success", REJECTED: "danger", WITHDRAWN: "neutral", IN: "success", BELOW: "warning", ABOVE: "danger" };
const money = (v: number | null) => (v === null ? "—" : formatINR(v));

/** Pay ranges: compa-ratio and range penetration, location differentials, range changes and allowance changes. */
export default async function PayRangesPage({ searchParams }: { searchParams: Promise<{ position?: string; grade?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.SALARY_REVISE);
  const sp = await searchParams;
  const t = viewer.tenantId;
  const [rowsAll, grades, locations, diffs, changes, allowance, components, employees] = await Promise.all([
    compaRatioRows(t, scopedEmployeeWhere(viewer, PERMISSIONS.SALARY_REVISE)),
    prisma.payGrade.findMany({ where: { tenantId: t }, include: { _count: { select: { employees: true } } }, orderBy: { name: "asc" } }),
    prisma.location.findMany({ where: { tenantId: t }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.locationPayDifferential.findMany({ where: { tenantId: t } }),
    prisma.payRangeChange.findMany({ where: { tenantId: t }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.allowanceChangeRequest.findMany({ where: { tenantId: t }, include: { employee: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.salaryComponent.findMany({ where: { tenantId: t, type: "EARNING", isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { tenantId: t, status: { notIn: ["EXITED"] }, ...scopedEmployeeWhere(viewer, PERMISSIONS.SALARY_REVISE) }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } }),
  ]);
  const rows = rowsAll.filter((r) => (!sp.position || r.position === sp.position) && (!sp.grade || r.grade === sp.grade));
  const gradeName = new Map(grades.map((g) => [g.id, g.name]));
  const compName = new Map(components.map((c) => [c.id, c.name]));
  const diff = new Map(diffs.map((d) => [d.locationId, Number(d.pct)]));
  const withCompa = rowsAll.filter((r) => r.compa !== null);
  return (
    <>
      <PageHead title="Pay ranges" subtitle="Where pay sits against each grade's range" actions={<><a className="btn" href="/payroll/compensation/ranges/export">Download compa-ratio CSV</a><Link className="btn" href="/payroll/compensation">Compensation</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 12 }}>
        <Stat label="Average compa-ratio" value={withCompa.length ? (withCompa.reduce((s, r) => s + (r.compa ?? 0), 0) / withCompa.length).toFixed(2) : "—"} />
        <Stat label="Below range" value={rowsAll.filter((r) => r.position === "BELOW").length} />
        <Stat label="Above range" value={rowsAll.filter((r) => r.position === "ABOVE").length} />
        <Stat label="In range" value={rowsAll.filter((r) => r.position === "IN").length} />
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card tight title="Grades" description="Range changes go to approval before they apply.">
          {grades.length === 0 ? <Empty title="No pay grades" /> : (
            <div className="table-wrap"><table className="data"><thead><tr><th>Grade</th><th className="num">Min</th><th className="num">Mid</th><th className="num">Max</th><th className="num">People</th></tr></thead>
              <tbody>{grades.map((g) => <tr key={g.id}><td className="text-sm">{g.name}</td><td className="num">{money(g.minAnnual === null ? null : Number(g.minAnnual))}</td><td className="num">{money(g.midAnnual === null ? null : Number(g.midAnnual))}</td><td className="num">{money(g.maxAnnual === null ? null : Number(g.maxAnnual))}</td><td className="num">{g._count.employees}</td></tr>)}</tbody></table></div>
          )}
          <div style={{ padding: 12 }}>
            <Reveal label="Propose a new range">
              <GrowthForm action={proposePayRangeAction} cols={2} submitLabel="Send for approval" fields={[
                { name: "payGradeId", label: "Grade", type: "select", required: true, options: grades.map((g) => ({ value: g.id, label: g.name })) },
                { name: "minAnnual", label: "Minimum (₹/yr)", type: "number", required: true },
                { name: "midAnnual", label: "Midpoint (₹/yr)", type: "number", required: true },
                { name: "maxAnnual", label: "Maximum (₹/yr)", type: "number", required: true },
                { name: "reason", label: "Reason (survey, restructure…)", required: true, wide: true },
              ]} />
            </Reveal>
            {changes.length ? <div className="stack gap-1">{changes.map((c) => <div key={c.id} className="row gap-2 text-xs" style={{ justifyContent: "space-between" }}><span>{gradeName.get(c.payGradeId)}: {formatINR(Number(c.minAnnual))} – {formatINR(Number(c.midAnnual))} – {formatINR(Number(c.maxAnnual))} · {c.reason}</span><Badge tone={TONE[c.status] ?? "neutral"}>{c.status.toLowerCase()}</Badge></div>)}</div> : null}
          </div>
        </Card>
        <Card title="Location differentials" description="Ranges at a location run this much above or below the grade's range. 0 removes it.">
          <div className="stack gap-1">{locations.map((l) => <div key={l.id} className="row gap-2 text-sm" style={{ justifyContent: "space-between" }}><span>{l.name}</span><span>{diff.has(l.id) ? `${diff.get(l.id)! > 0 ? "+" : ""}${diff.get(l.id)}%` : "—"}</span></div>)}</div>
          <div style={{ marginTop: 10 }}><GrowthForm action={locationDifferentialAction} cols={2} compact submitLabel="Set" fields={[
            { name: "locationId", label: "Location", type: "select", required: true, options: locations.map((l) => ({ value: l.id, label: l.name })) },
            { name: "pct", label: "Differential %", type: "number", required: true, defaultValue: 0 },
          ]} /></div>
        </Card>
      </div>
      <Card tight title={`Compa-ratio (${rows.length})`} action={
        <form className="row gap-2" method="get">
          <select className="input" name="grade" defaultValue={sp.grade ?? ""}><option value="">All grades</option>{grades.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}</select>
          <select className="input" name="position" defaultValue={sp.position ?? ""}><option value="">Anywhere</option><option value="BELOW">Below range</option><option value="IN">In range</option><option value="ABOVE">Above range</option></select>
          <button className="btn sm">Filter</button>
        </form>}>
        {rows.length === 0 ? <Empty title="No graded employees" /> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Employee</th><th>Grade</th><th>Location</th><th className="num">CTC</th><th className="num">Range (adjusted)</th><th className="num">Compa</th><th className="num">Penetration</th><th /></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td><div className="text-sm">{r.name}</div><div className="text-xs subtle">{r.number} · {r.department}</div></td><td className="text-sm">{r.grade}</td><td className="text-xs">{r.location}</td><td className="num">{formatINR(r.ctc)}</td><td className="num text-xs">{money(r.min)} – {money(r.max)}</td><td className="num">{r.compa?.toFixed(2) ?? "—"}</td><td className="num">{r.penetration === null ? "—" : `${Math.round(r.penetration * 100)}%`}</td><td><Badge tone={TONE[r.position] ?? "neutral"}>{r.position.toLowerCase()}</Badge></td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Card tight title="Allowance changes" description="Change one employee's allowance from a month; it goes to approval and then applies as a salary override.">
        {allowance.length === 0 ? <Empty title="None yet" /> : (
          <div className="table-wrap"><table className="data"><tbody>{allowance.map((a) => <tr key={a.id}><td className="text-sm">{a.employee.displayName}</td><td className="text-sm">{compName.get(a.componentId) ?? "—"}</td><td className="num text-sm">{formatINR(Number(a.currentMonthly ?? 0))} → {formatINR(Number(a.newMonthly))}/mo</td><td className="text-xs">from {formatDate(a.effectiveFrom)} · {a.reason}</td><td><Badge tone={TONE[a.status] ?? "neutral"}>{a.status.toLowerCase()}</Badge></td></tr>)}</tbody></table></div>
        )}
        <div style={{ padding: 12 }}>
          <Reveal label="Change an allowance">
            <GrowthForm action={allowanceChangeAction} cols={2} submitLabel="Send for approval" fields={[
              { name: "employeeId", label: "Employee", type: "select", required: true, options: employees.filter((e) => e.id !== viewer.employee?.id).map((e) => ({ value: e.id, label: `${e.displayName} (${e.employeeNumber})` })) },
              { name: "componentId", label: "Allowance", type: "select", required: true, options: components.map((c) => ({ value: c.id, label: c.name })) },
              { name: "newMonthly", label: "New amount (₹/month)", type: "number", required: true },
              { name: "effectiveFrom", label: "From", type: "date", required: true },
              { name: "reason", label: "Reason", required: true, wide: true },
            ]} />
          </Reveal>
        </div>
      </Card>
    </>
  );
}
