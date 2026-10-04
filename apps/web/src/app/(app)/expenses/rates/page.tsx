import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { MILEAGE_VEHICLES, PER_DIEM_TIERS } from "@keka/services";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Callout } from "@/components/ui";
import { GrowthForm, Reveal } from "@/components/growth-forms";
import { proposeExpenseRateAction } from "@/app/actions/expense-depth";

const TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = { ACTIVE: "success", PENDING_APPROVAL: "warning", REJECTED: "danger", RETIRED: "neutral" };

/** Mileage and per-diem rate tables: each new rate is approved before it takes effect. */
export default async function ExpenseRatesPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.EXPENSE_MANAGE);
  const sp = await searchParams;
  const kind = sp.kind === "PER_DIEM" ? "PER_DIEM" : sp.kind === "MILEAGE" ? "MILEAGE" : null;
  const rates = await prisma.expenseRate.findMany({ where: { tenantId: viewer.tenantId, ...(kind ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { key: "asc" }, { effectiveFrom: "desc" }] });
  const now = Date.now();
  const current = new Set<string>();
  for (const k of ["MILEAGE", "PER_DIEM"]) {
    const keys = new Set(rates.filter((r) => r.kind === k).map((r) => r.key));
    for (const key of keys) {
      const live = rates.find((r) => r.kind === k && r.key === key && r.status === "ACTIVE" && r.effectiveFrom.getTime() <= now);
      if (live) current.add(live.id);
    }
  }
  const keyLabel = (k: string, key: string) => (k === "MILEAGE" ? MILEAGE_VEHICLES[key as keyof typeof MILEAGE_VEHICLES] : PER_DIEM_TIERS[key as keyof typeof PER_DIEM_TIERS]) ?? key;
  return (
    <>
      <PageHead title="Mileage and per-diem rates" subtitle="Mileage claims are priced per km from this table; trip settlements pay per diem by city tier." actions={<Link className="btn" href="/expenses/policies">Policies</Link>} />
      <Callout>A proposed rate goes to Approvals (finance). Once approved it applies to expenses dated on or after its effective date; earlier expenses keep the rate in force on their date.</Callout>
      <div className="grid grid-2" style={{ marginTop: 12, alignItems: "start" }}>
        <Card title="Mileage rate">
          <Reveal label="Propose a mileage rate">
            <GrowthForm action={proposeExpenseRateAction} hidden={{ kind: "MILEAGE" }} cols={2} submitLabel="Submit for approval" fields={[
              { name: "key", label: "Vehicle", type: "select", required: true, options: Object.entries(MILEAGE_VEHICLES).map(([value, label]) => ({ value, label })) },
              { name: "amount", label: "Rate per km (₹)", type: "number", required: true },
              { name: "effectiveFrom", label: "Effective from", type: "date", required: true },
              { name: "note", label: "Basis (fuel price, circular…)", wide: true },
            ]} />
          </Reveal>
        </Card>
        <Card title="Per-diem rate">
          <Reveal label="Propose a per-diem rate">
            <GrowthForm action={proposeExpenseRateAction} hidden={{ kind: "PER_DIEM" }} cols={2} submitLabel="Submit for approval" fields={[
              { name: "key", label: "City tier", type: "select", required: true, options: Object.entries(PER_DIEM_TIERS).map(([value, label]) => ({ value, label })) },
              { name: "amount", label: "Per day (₹)", type: "number", required: true },
              { name: "effectiveFrom", label: "Effective from", type: "date", required: true },
              { name: "note", label: "Basis", wide: true },
            ]} />
          </Reveal>
        </Card>
      </div>
      <div className="tabs" style={{ marginTop: 12 }}>
        {[["", "All"], ["MILEAGE", "Mileage"], ["PER_DIEM", "Per diem"]].map(([k, l]) => <Link key={k} className={`tab${(kind ?? "") === k ? " active" : ""}`} href={`/expenses/rates${k ? `?kind=${k}` : ""}`}>{l}</Link>)}
      </div>
      <Card tight title="Rate table">
        {rates.length === 0 ? <Empty title="No rates yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Kind</th><th>For</th><th className="num">Rate</th><th>From</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>{rates.map((r) => (
              <tr key={r.id}>
                <td className="text-sm">{r.kind === "MILEAGE" ? "Mileage" : "Per diem"}</td>
                <td className="text-sm strong">{keyLabel(r.kind, r.key)}</td>
                <td className="num">{formatINR(Number(r.amount))}{r.kind === "MILEAGE" ? "/km" : "/day"}</td>
                <td className="text-sm">{formatDate(r.effectiveFrom)}</td>
                <td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge>{current.has(r.id) ? <Badge tone="info">in force</Badge> : null}</td>
                <td className="text-xs subtle">{r.note ?? ""}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
