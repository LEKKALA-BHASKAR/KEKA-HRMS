import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatINR, formatPeriod } from "@keka/shared";
import { requireAuth, can } from "@/lib/context";
import { scopedEmployeeWhere } from "@/lib/scope";
import { PageHead, Card, Badge, Empty, Person, Stat } from "@/components/ui";
import { BonusTypeForm, DeleteBonusType, ScheduleBonusForm, RemoveBonus } from "../_forms/bonuses";
import { Disclosure } from "../../org/forms";

const P = PERMISSIONS;
const TABS = { scheduled: "Scheduled", paid: "Paid", void: "Void", types: "Bonus types" } as const;
type Tab = keyof typeof TABS;
const ACTION: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  PAY: { label: "To pay", tone: "info" }, PARTIALLY_PAY: { label: "Part pay", tone: "info" }, ON_HOLD: { label: "On hold", tone: "warning" },
  PAY_OUTSIDE_PAYROLL: { label: "Paid outside payroll", tone: "neutral" }, VOID: { label: "Void", tone: "danger" },
};

export default async function BonusesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const viewer = await requireAuth(P.PAYROLL_RUN);
  const sp = await searchParams;
  const tab: Tab = (sp.tab && sp.tab in TABS ? sp.tab : "scheduled") as Tab;
  const scope = scopedEmployeeWhere(viewer, P.PAYROLL_RUN);
  const where = tab === "scheduled" ? { isProcessed: false, payAction: { not: "VOID" as const } }
    : tab === "paid" ? { isProcessed: true } : { payAction: "VOID" as const };

  const [bonuses, types, employees, scheduled] = await Promise.all([
    tab === "types" ? Promise.resolve([]) : prisma.employeeBonus.findMany({
      where: { ...where, employee: scope },
      include: { bonusType: { select: { name: true, isTaxable: true } }, employee: { select: { displayName: true, employeeNumber: true } } },
      orderBy: [{ payoutYear: tab === "scheduled" ? "asc" : "desc" }, { payoutMonth: tab === "scheduled" ? "asc" : "desc" }],
      take: 500,
    }),
    prisma.bonusType.findMany({ where: { tenantId: viewer.tenantId }, include: { _count: { select: { bonuses: true } } }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { ...scope, status: { not: "EXITED" } }, select: { id: true, displayName: true, employeeNumber: true }, orderBy: { displayName: "asc" } }),
    prisma.employeeBonus.findMany({ where: { isProcessed: false, payAction: { not: "VOID" }, employee: scope }, select: { amount: true, payAction: true } }),
  ]);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const held = scheduled.filter((b) => b.payAction === "ON_HOLD");

  return (
    <>
      <PageHead
        title="Bonuses"
        subtitle="Schedule bonuses for a payout month. Each month's payroll run picks them up, where you can pay, part-pay, hold or void them."
        actions={can(viewer, P.PAYROLL_RUN) ? <Link className="btn" href="/admin/import?kind=bonuses">Import from CSV</Link> : null}
      />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Scheduled" value={String(scheduled.length)} meta={formatINR(scheduled.reduce((s, b) => s + Number(b.amount), 0))} />
        <Stat label="On hold" value={String(held.length)} meta={formatINR(held.reduce((s, b) => s + Number(b.amount), 0))} />
        <Stat label="Bonus types" value={String(types.filter((t) => t.isActive).length)} meta="active" />
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => <Link key={t} href={`/payroll/bonuses?tab=${t}`} className={`tab${tab === t ? " active" : ""}`}>{TABS[t]}</Link>)}
      </div>

      {tab === "types" ? (
        <Card title="Bonus types" description="Whether a bonus is taxed, counted in CTC and in ESI wages is set on its type.">
          {can(viewer, P.PAYROLL_SETTINGS) ? <Disclosure label="Add a bonus type"><BonusTypeForm /></Disclosure> : null}
          {types.length === 0 ? <Empty title="No bonus types yet" /> : (
            <div className="stack gap-2" style={{ marginTop: 12 }}>
              {types.map((t) => (
                <div key={t.id} className="card-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <strong>{t.name}</strong>
                    {t.isTaxable ? <Badge tone="warning">Taxable</Badge> : <Badge tone="success">Exempt</Badge>}
                    {t.isPartOfCtc ? <Badge tone="neutral">In CTC</Badge> : null}
                    {t.affectsEsi ? <Badge tone="neutral">ESI wages</Badge> : null}
                    {!t.isActive ? <Badge tone="danger">Off</Badge> : null}
                    <span className="text-xs subtle">{t._count.bonuses} bonus(es)</span>
                    <span style={{ marginLeft: "auto" }}>{can(viewer, P.PAYROLL_SETTINGS) ? <DeleteBonusType id={t.id} name={t.name} /> : null}</span>
                  </div>
                  {t.description ? <div className="text-sm muted">{t.description}</div> : null}
                  {can(viewer, P.PAYROLL_SETTINGS) ? <Disclosure label="Edit"><BonusTypeForm type={t} /></Disclosure> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <>
          {tab === "scheduled" ? (
            <Card title="Schedule a bonus">
              {types.some((t) => t.isActive)
                ? <ScheduleBonusForm month={month} employees={employees.map((e) => ({ value: e.id, label: `${e.employeeNumber} — ${e.displayName ?? ""}` }))} types={types.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))} />
                : <Empty title="Add a bonus type first"><Link href="/payroll/bonuses?tab=types">Set up bonus types</Link></Empty>}
            </Card>
          ) : null}
          <Card tight>
            {bonuses.length === 0 ? <Empty title={`No ${TABS[tab].toLowerCase()} bonuses`} /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Employee</th><th>Type</th><th>Pay in</th><th className="num">Amount</th><th className="num">Paying</th><th>Status</th><th>Note</th><th /></tr></thead>
                  <tbody>
                    {bonuses.map((b) => (
                      <tr key={b.id}>
                        <td><Person name={b.employee.displayName ?? ""} meta={b.employee.employeeNumber} /></td>
                        <td>{b.bonusType.name}{b.bonusType.isTaxable ? null : <div className="text-xs subtle">Exempt</div>}</td>
                        <td className="nowrap">{formatPeriod(b.payoutYear, b.payoutMonth)}</td>
                        <td className="num">{formatINR(Number(b.amount))}</td>
                        <td className="num">{b.payAction === "VOID" ? "—" : formatINR(Number(b.paidAmount ?? b.amount))}</td>
                        <td><Badge tone={b.isProcessed && b.runId ? "success" : ACTION[b.payAction].tone}>{b.isProcessed && b.runId ? "Paid in payroll" : ACTION[b.payAction].label}</Badge></td>
                        <td className="text-sm muted" style={{ maxWidth: 220 }}>{b.note ?? ""}</td>
                        <td className="right">{tab === "scheduled" ? <RemoveBonus id={b.id} /> : null}</td>
                      </tr>
                    ))}
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
