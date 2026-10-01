import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person } from "@/components/ui";
import { PerkForm, DeletePerk, AssignPerkForm, EndPerkForm } from "../_forms/perks";
import { Disclosure } from "../../org/forms";

const P = PERMISSIONS;
const TABS = { given: "Given to employees", setup: "Perks" } as const;
type Tab = keyof typeof TABS;
const METHOD: Record<string, string> = { FIXED_FOR_ALL: "Same for everyone", PER_EMPLOYEE: "Per employee", FORMULA: "Formula" };

export default async function PerksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "given") as Tab;
  const scope = scopedEmployeeWhere(viewer, P.PAYROLL_RUN);
  const today = new Date().toISOString().slice(0, 10);
  const [perks, assignments, employees] = await Promise.all([
    prisma.perk.findMany({ where: { component: { tenantId: viewer.tenantId } }, include: { component: true, _count: { select: { assignments: true } } }, orderBy: { component: { name: "asc" } } }),
    tab === "given" ? prisma.employeePerk.findMany({
      where: { employee: scope },
      include: { employee: { select: { displayName: true, employeeNumber: true } }, perk: { include: { component: { select: { name: true, isActive: true } } } } },
      orderBy: [{ endDate: { sort: "asc", nulls: "first" } }, { startDate: "desc" }],
      take: 500,
    }) : Promise.resolve([]),
    prisma.employee.findMany({ where: { ...scope, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } }),
  ]);
  const value = (a: (typeof assignments)[number]) =>
    a.perk.valuationMethod === "PER_EMPLOYEE" ? formatINR(Number(a.monthlyValue ?? 0))
      : a.perk.valuationMethod === "FIXED_FOR_ALL" ? formatINR(Number(a.perk.fixedAmount ?? 0)) : <span className="mono text-xs">{a.perk.formula}</span>;
  const active = perks.filter((p) => p.component.isActive);

  return (
    <>
      <PageHead title="Perks" subtitle="Non-cash benefits. A perk's monthly value is shown on the payslip and taxed as salary from the date it is given, unless the employer bears the tax." />
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => <Link key={t} href={`/payroll/perks?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{TABS[t]}</Link>)}
      </div>
      {tab === "setup" ? (
        <Card title="Perks">
          {can(viewer, P.PAYROLL_SETTINGS) ? <Disclosure label="Add a perk"><PerkForm /></Disclosure> : null}
          {perks.length === 0 ? <Empty title="No perks yet" /> : (
            <div className="stack gap-2" style={{ marginTop: 12 }}>
              {perks.map((p) => (
                <div key={p.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{p.component.name}</strong> <span className="mono text-xs subtle">{p.component.code}</span>
                    <Badge tone="neutral">{p.category}</Badge>
                    <Badge tone="info">{METHOD[p.valuationMethod]}{p.valuationMethod === "FIXED_FOR_ALL" ? ` · ${formatINR(Number(p.fixedAmount ?? 0))}/mo` : ""}</Badge>
                    {p.isTaxable ? (p.taxBorneByEmployer ? <Badge tone="warning">Tax borne by employer</Badge> : <Badge tone="warning">Taxable</Badge>) : <Badge tone="success">Exempt</Badge>}
                    {!p.component.isActive ? <Badge tone="danger">Off</Badge> : null}
                    <span className="text-xs subtle">{p._count.assignments} given</span>
                    <span style={{ marginLeft: "auto" }}>{can(viewer, P.PAYROLL_SETTINGS) ? <DeletePerk id={p.id} name={p.component.name} /> : null}</span>
                  </div>
                  {p.formula ? <div className="mono text-xs muted">{p.formula}</div> : null}
                  {can(viewer, P.PAYROLL_SETTINGS) ? (
                    <Disclosure label="Edit" variant="default">
                      <PerkForm perk={{ id: p.id, name: p.component.name, code: p.component.code, category: p.category, valuationMethod: p.valuationMethod, fixedAmount: p.fixedAmount === null ? null : Number(p.fixedAmount), formula: p.formula, isTaxable: p.isTaxable, taxBorneByEmployer: p.taxBorneByEmployer }} />
                    </Disclosure>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <>
          <Card title="Give a perk">
            {active.length === 0 ? <Empty title="Set up a perk first"><Link href="/payroll/perks?tab=setup">Add perks</Link></Empty> : (
              <AssignPerkForm today={today}
                employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName ?? ""}` }))}
                perks={active.map((p) => ({ value: p.id, label: p.component.name, perEmployee: p.valuationMethod === "PER_EMPLOYEE" }))} />
            )}
          </Card>
          <Card tight>
            {assignments.length === 0 ? <Empty title="No perks given yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Perk</th><th className="num">Value a month</th><th>From</th><th>Until</th><th /></tr></thead>
                  <tbody>
                    {assignments.map((a) => {
                      const ended = !!a.endDate && a.endDate < new Date();
                      return (
                        <tr key={a.id}>
                          <td><Person name={a.employee.displayName ?? ""} meta={a.employee.employeeNumber} /></td>
                          <td>{a.perk.component.name}{a.note ? <div className="text-xs muted">{a.note}</div> : null}</td>
                          <td className="num">{value(a)}</td>
                          <td className="nowrap text-sm">{formatDate(a.startDate)}</td>
                          <td className="nowrap text-sm">{a.endDate ? formatDate(a.endDate) : "—"}</td>
                          <td className="right">{!a.endDate ? <Disclosure label="End" variant="default"><EndPerkForm id={a.id} today={today} /></Disclosure> : ended ? <Badge tone="neutral">Ended</Badge> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
