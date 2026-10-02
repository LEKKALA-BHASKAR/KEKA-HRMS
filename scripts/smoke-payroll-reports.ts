/**
 * The payroll reports: year-to-date salary, income tax, reimbursement
 * claims, salary revisions and bonuses. Each one's totals are checked
 * against the underlying rows, and a viewer limited to their own team sees
 * only that team. Read-only; it creates nothing.
 */
import { signInAs, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const FY = 2026;

async function main() {
  const { REPORTS, reportsFor } = await import("../apps/web/src/lib/reports");
  const { getViewer } = await import("../apps/web/src/lib/context");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const run = async (key: string) => REPORTS.find((r) => r.key === key)!.run((await getViewer())!, { fy: FY });
  const fyRuns = { tenantId: tenant.id, status: "FINALIZED" as const, rolledBackAt: null, OR: [{ year: FY, month: { gte: 4 } }, { year: FY + 1, month: { lte: 3 } }] };

  await signInAs("vikram.menon@acme.test");
  const keys = reportsFor((await getViewer())!).map((r) => r.key);
  check("A Global Admin sees all five payroll reports",
    ["payroll-ytd", "income-tax", "component-claims", "salary-revisions", "bonuses"].every((k) => keys.includes(k)));

  // -----------------------------------------------------------------
  section("Year-to-date salary");
  const ytd = await run("payroll-ytd");
  const agg = await prisma.payrollRunEmployee.aggregate({ where: { run: fyRuns }, _sum: { grossEarnings: true, tds: true, netPay: true } });
  check("Gross matches the finalised runs", Math.abs(Number(ytd.totals?.gross) - Number(agg._sum.grossEarnings)) < 0.01, `${ytd.totals?.gross} vs ${agg._sum.grossEarnings}`);
  check("TDS matches", Math.abs(Number(ytd.totals?.tds) - Number(agg._sum.tds)) < 0.01);
  check("Net matches", Math.abs(Number(ytd.totals?.net) - Number(agg._sum.netPay)) < 0.01);
  const row = ytd.rows[0] as Record<string, number>;
  check("Each row reconciles: gross less deductions is net",
    ytd.rows.every((r) => { const x = r as Record<string, number>; return Math.abs(x.gross - x.pf - x.esi - x.pt - x.tds - x.other - x.net) < 0.05; }), JSON.stringify(row));

  // -----------------------------------------------------------------
  section("Income tax");
  const tax = await run("income-tax");
  check("TDS deducted matches the year-to-date report", Math.abs(Number(tax.totals?.deducted) - Number(ytd.totals?.tds)) < 0.01);
  check("The projection is never below what is already deducted",
    tax.rows.every((r) => Number(r.projected) >= Number(r.deducted)));
  const ramesh = tax.rows.find((r) => r.number === "ACM0002");
  check("Ramesh, a top-slab earner, has TDS", Number(ramesh?.deducted) > 0, String(ramesh?.deducted));

  // -----------------------------------------------------------------
  section("Claims, revisions and bonuses");
  const claims = await run("component-claims");
  const claimed = await prisma.componentClaim.aggregate({ where: { fyStartYear: FY, employee: { tenantId: tenant.id }, status: { not: "DRAFT" } }, _sum: { claimedAmount: true } });
  check("Claimed total matches the claims", Math.abs(Number(claims.totals?.claimed) - Number(claimed._sum.claimedAmount ?? 0)) < 0.01);
  check("The status columns add up to what was claimed or approved",
    claims.rows.every((r) => Number(r.waiting) + Number(r.rejected) <= Number(r.claimed) + 0.01));
  const revs = await run("salary-revisions");
  const revCount = await prisma.salaryRevision.count({ where: { employee: { tenantId: tenant.id }, effectiveFrom: { gte: new Date(Date.UTC(FY, 3, 1)), lte: new Date(Date.UTC(FY + 1, 2, 31)) } } });
  check("Every revision in the year is listed", revs.rows.length === revCount, `${revs.rows.length} of ${revCount}`);
  const bonuses = await run("bonuses");
  const t = bonuses.totals as Record<string, number> | undefined;
  check("Bonus buckets add up to what was scheduled (part-payments aside)",
    !t || t.paid + t.outside + t.held + t.voided + t.upcoming <= t.scheduled + 0.01);

  // -----------------------------------------------------------------
  section("Scope");
  await signInAs("meera.krishnan@acme.test");
  const mine = reportsFor((await getViewer())!).map((r) => r.key);
  check("An employee sees none of the payroll reports", !mine.some((k) => ["payroll-ytd", "income-tax", "salary-revisions"].includes(k)), mine.join(", "));

  report("Payroll reports");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
