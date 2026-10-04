import Link from "next/link";
import { prisma } from "@keka/db";
import { PERMISSIONS } from "@keka/rbac";
import { formatDate, formatINR } from "@keka/shared";
import { requireAuth } from "@/lib/context";
import { PageHead, Card, Badge, Empty, Stat } from "@/components/ui";
import { GrowthForm, ActButton, Reveal } from "@/components/growth-forms";
import { drawAuditSampleAction, reviewAuditItemAction, closeAuditSampleAction } from "@/app/actions/expense-depth";

/** Post-approval audit: a random (reproducible) sample of approved claims, reviewed line by line. */
export default async function ExpenseAuditPage({ searchParams }: { searchParams: Promise<{ sample?: string }> }) {
  const viewer = await requireAuth(PERMISSIONS.EXPENSE_MANAGE);
  const sp = await searchParams;
  const samples = await prisma.expenseAuditSample.findMany({ where: { tenantId: viewer.tenantId }, include: { items: true }, orderBy: { createdAt: "desc" }, take: 30 });
  const current = samples.find((s) => s.id === sp.sample) ?? samples[0] ?? null;
  const claims = current ? await prisma.expenseClaim.findMany({ where: { id: { in: current.items.map((i) => i.claimId) }, tenantId: viewer.tenantId }, include: { employee: { select: { displayName: true, employeeNumber: true } }, lines: { select: { receiptUrl: true, receiptCheck: true, duplicateOfLineId: true } } } }) : [];
  const byId = new Map(claims.map((c) => [c.id, c]));
  const ninety = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  return (
    <>
      <PageHead title="Expense audit sampling" subtitle="Pick approved claims at random for a second look; recoveries go to payroll." actions={<Link className="btn" href="/expenses/reports">Reports</Link>} />
      <Card title="Draw a sample">
        <Reveal label="New sample" open={samples.length === 0}>
          <GrowthForm action={drawAuditSampleAction} submitLabel="Draw sample" fields={[
            { name: "name", label: "Name", required: true, defaultValue: `Audit ${new Date().toISOString().slice(0, 7)}` },
            { name: "from", label: "Approved from", type: "date", required: true, defaultValue: ninety },
            { name: "to", label: "Approved to", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
            { name: "ratePct", label: "Sample rate (%)", type: "number", required: true, defaultValue: 10 },
            { name: "alwaysAbove", label: "Always include claims above (₹)", type: "number" },
            { name: "seed", label: "Seed (to repeat a draw)", type: "number" },
          ]} />
        </Reveal>
      </Card>
      {samples.length ? (
        <div className="tabs" style={{ marginTop: 12 }}>
          {samples.map((s) => <Link key={s.id} className={`tab${current?.id === s.id ? " active" : ""}`} href={`/expenses/audit?sample=${s.id}`}>{s.name}{s.status === "CLOSED" ? " (closed)" : ""}</Link>)}
        </div>
      ) : null}
      {current ? (
        <div className="stack gap-4">
          <div className="grid grid-4">
            <Stat label="Population" value={current.population} meta={`${formatDate(current.periodFrom)} – ${formatDate(current.periodTo)}`} />
            <Stat label="Sampled" value={current.items.length} meta={`${Number(current.ratePct)}% · seed ${current.seed}`} />
            <Stat label="Reviewed" value={current.items.filter((i) => i.outcome !== "PENDING").length} />
            <Stat label="Issues" value={current.items.filter((i) => i.outcome === "ISSUE").length} meta={formatINR(current.items.reduce((s, i) => s + Number(i.recoverAmount ?? 0), 0)) + " to recover"} tone={current.items.some((i) => i.outcome === "ISSUE") ? "neg" : undefined} />
          </div>
          <Card tight title="Sampled claims" action={current.status === "OPEN" ? <ActButton action={closeAuditSampleAction} hidden={{ id: current.id }} label="Close sample" /> : <Badge>closed</Badge>}>
            {current.items.length === 0 ? <Empty title="Nothing sampled" /> : (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Claim</th><th>Employee</th><th className="num">Approved</th><th>Flags</th><th>Outcome</th><th /></tr></thead>
                <tbody>{current.items.map((i) => {
                  const c = byId.get(i.claimId);
                  const flags = c ? [c.lines.some((l) => !l.receiptUrl) ? "missing receipt" : null, c.lines.some((l) => l.receiptCheck && l.receiptCheck !== "OK") ? "receipt quality" : null, c.lines.some((l) => l.duplicateOfLineId) ? "possible duplicate" : null].filter(Boolean) : [];
                  return (
                    <tr key={i.id}>
                      <td>{c ? <Link className="strong text-sm" href={`/expenses/${c.id}`}>{c.claimNumber}</Link> : "—"}<div className="text-xs subtle">{c?.title}</div></td>
                      <td className="text-sm">{c?.employee.displayName}</td>
                      <td className="num">{c ? formatINR(Number(c.approvedTotal)) : "—"}</td>
                      <td className="text-xs">{flags.join(", ") || "—"}</td>
                      <td><Badge tone={i.outcome === "OK" ? "success" : i.outcome === "ISSUE" ? "danger" : "warning"}>{i.outcome.toLowerCase()}</Badge>{i.finding ? <div className="text-xs">{i.finding}</div> : null}{i.recoverAmount ? <div className="text-xs neg">recover {formatINR(Number(i.recoverAmount))}</div> : null}</td>
                      <td className="right">{current.status === "OPEN" ? (
                        <div className="row gap-1" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                          <ActButton action={reviewAuditItemAction} hidden={{ itemId: i.id, outcome: "OK" }} label="No issue" />
                          <Reveal label="Issue">
                            <GrowthForm action={reviewAuditItemAction} hidden={{ itemId: i.id, outcome: "ISSUE" }} cols={1} compact submitLabel="Record issue" fields={[{ name: "finding", label: "What was wrong", required: true }, { name: "recoverAmount", label: "Recover from salary (₹)", type: "number" }]} />
                          </Reveal>
                        </div>
                      ) : null}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );
}
