import Link from "next/link";
import { prisma } from "@keka/db";
import { formatPeriod, fyStartYear, fyLabel, fyRange } from "@keka/shared";
import { resolveStructure } from "@keka/payroll";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Money, Badge, Empty, Stat, KeyValue, Callout } from "@/components/ui";

const n = (v: unknown) => Number(v ?? 0);

export default async function MyPayPage() {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <Callout tone="info" title="No employee record">This login is not linked to an employee record.</Callout>;
  }

  const employeeId = viewer.employee.id;
  const fyStart = fyStartYear(new Date(), viewer.tenant.fyStartMonth);
  const { start, end } = fyRange(fyStart, viewer.tenant.fyStartMonth);

  const [payslips, currentSalary, ytd, loans, claims, bankAccount] = await Promise.all([
    prisma.payslip.findMany({
      where: { employeeId, status: "RELEASED" },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 24,
    }),
    prisma.salaryRevision.findFirst({
      where: { employeeId, status: "APPLIED" },
      orderBy: { effectiveFrom: "desc" },
      include: { structure: { include: { components: { include: { component: true } } } } },
    }),
    prisma.payrollRunEmployee.findMany({
      where: {
        employeeId,
        run: { status: "FINALIZED", periodEnd: { gte: start, lte: end } },
      },
      select: {
        grossEarnings: true, totalDeductions: true, netPay: true,
        pfEmployee: true, tds: true, professionalTax: true, esiEmployee: true,
      },
    }),
    prisma.loan.findMany({
      where: { employeeId, status: { in: ["ACTIVE", "DISBURSED"] } },
      include: { category: true, schedule: { where: { status: "SCHEDULED" }, take: 1, orderBy: { sequence: "asc" } } },
    }),
    prisma.componentClaim.findMany({
      where: { employeeId, fyStartYear: fyStart },
      include: { component: { select: { name: true, annualExemptLimit: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.employeeBankAccount.findFirst({ where: { employeeId, isPrimary: true } }),
  ]);

  const sum = (f: (r: typeof ytd[number]) => number) => ytd.reduce((s, r) => s + f(r), 0);

  const resolved = currentSalary?.structure
    ? resolveStructure({
        annualCtc: n(currentSalary.annualCtc),
        components: currentSalary.structure.components.map((sc) => ({
          code: sc.component.code,
          name: sc.component.name,
          type: sc.component.type,
          calculationType: sc.calculationType,
          formula: sc.formula,
          fixedAmount: sc.fixedAmount === null ? null : Number(sc.fixedAmount),
          percentage: sc.percentage === null ? null : Number(sc.percentage),
          percentageOf: sc.percentageOf,
          sequence: sc.sequence,
          isOutsideCtc: sc.component.isOutsideCtc,
          isLopApplicable: sc.component.isLopApplicable,
          affectsPfWage: sc.component.affectsPfWage,
          affectsEsiGross: sc.component.affectsEsiGross,
          showOnPayslip: sc.component.showOnPayslip,
          isPartOfFbp: sc.component.isPartOfFbp,
        })),
        roundComponents: currentSalary.structure.roundComponents,
      })
    : null;

  return (
    <>
      <PageHead title="My pay" subtitle={`${viewer.employee.displayName} · ${viewer.employee.employeeNumber}`} />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Annual CTC" value={<Money value={currentSalary?.annualCtc ?? 0} compact />} meta="Cost to company" />
        <Stat label="Monthly gross" value={<Money value={resolved?.monthlyGross.toNumber() ?? 0} compact />} meta="Before deductions" />
        <Stat label={`${fyLabel(fyStart)} gross`} value={<Money value={sum((r) => n(r.grossEarnings))} compact />} meta={`${ytd.length} month(s) paid`} />
        <Stat label={`${fyLabel(fyStart)} TDS`} value={<Money value={sum((r) => n(r.tds))} compact />} meta="Income tax deducted" />
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Payslips" description="Password for the downloadable copy is your PAN in uppercase." tight>
          {payslips.length === 0 ? (
            <Empty title="No payslips released yet" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Period</th><th className="num">Net pay</th><th /></tr></thead>
                <tbody>
                  {payslips.map((p) => (
                    <tr key={p.id}>
                      <td className="strong">{formatPeriod(p.year, p.month)}</td>
                      <td className="num"><Money value={p.netPay} /></td>
                      <td className="right">
                        <Link className="btn sm" href={`/payroll/payslips/${p.id}`}>View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={`Year-to-date — ${fyLabel(fyStart)}`}>
          <KeyValue items={[
            ["Gross earnings", <Money key="g" value={sum((r) => n(r.grossEarnings))} />],
            ["Provident Fund", <Money key="p" value={sum((r) => n(r.pfEmployee))} />],
            ["ESI", <Money key="e" value={sum((r) => n(r.esiEmployee))} />],
            ["Professional Tax", <Money key="t" value={sum((r) => n(r.professionalTax))} />],
            ["Income tax (TDS)", <Money key="d" value={sum((r) => n(r.tds))} />],
            ["Total deductions", <Money key="td" value={sum((r) => n(r.totalDeductions))} />],
            ["Net received", <Money key="n" value={sum((r) => n(r.netPay))} />],
          ]} />
        </Card>

        {resolved ? (
          <Card
            title="My salary breakup"
            description={currentSalary?.structure?.name ?? undefined}
            tight
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Component</th><th className="num">Monthly</th><th className="num">Annual</th></tr>
                </thead>
                <tbody>
                  {resolved.components.filter((c) => c.type === "EARNING").map((c) => (
                    <tr key={c.code}>
                      <td>
                        {c.name}
                        {c.isPartOfFbp ? <Badge tone="info">FBP</Badge> : null}
                      </td>
                      <td className="num"><Money value={c.monthly.toNumber()} /></td>
                      <td className="num"><Money value={c.annual.toNumber()} /></td>
                    </tr>
                  ))}
                  <tr className="subtotal">
                    <td>Gross earnings</td>
                    <td className="num"><Money value={resolved.monthlyGross.toNumber()} /></td>
                    <td className="num"><Money value={resolved.monthlyGross.times(12).toNumber()} /></td>
                  </tr>
                  {resolved.components.filter((c) => c.type === "EMPLOYER_CONTRIBUTION").map((c) => (
                    <tr key={c.code}>
                      <td className="muted">{c.name} (employer)</td>
                      <td className="num muted"><Money value={c.monthly.toNumber()} /></td>
                      <td className="num muted"><Money value={c.annual.toNumber()} /></td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td>Cost to company</td>
                    <td className="num"><Money value={resolved.monthlyCtcValue.toNumber()} /></td>
                    <td className="num"><Money value={resolved.annualCtc.toNumber()} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {loans.length > 0 ? (
          <Card title="My loans" tight>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Category</th><th className="num">Principal</th><th className="num">EMI</th><th className="num">Outstanding</th><th>Next EMI</th></tr>
                </thead>
                <tbody>
                  {loans.map((l) => (
                    <tr key={l.id}>
                      <td>{l.category.name}</td>
                      <td className="num"><Money value={l.principal} /></td>
                      <td className="num"><Money value={l.emiAmount} /></td>
                      <td className="num strong"><Money value={l.outstanding} /></td>
                      <td className="text-sm">
                        {l.schedule[0]
                          ? formatPeriod(l.schedule[0].year, l.schedule[0].month)
                          : <span className="subtle">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card title="Payment details">
          <KeyValue items={[
            ["Bank", bankAccount?.bankName],
            ["Account", bankAccount ? `••••${bankAccount.accountNumber.slice(-4)}` : null],
            ["IFSC", bankAccount ? <span className="mono" key="i">{bankAccount.ifsc}</span> : null],
            ["Verified", bankAccount?.isVerified
              ? <Badge key="v" tone="success">Verified</Badge>
              : <Badge key="v" tone="warning">Unverified</Badge>],
          ]} />
        </Card>

        {claims.length > 0 ? (
          <Card title={`Reimbursement claims — ${fyLabel(fyStart)}`} tight>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Component</th><th className="num">Claimed</th><th className="num">Annual limit</th><th>Status</th></tr></thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.id}>
                      <td>{c.component.name}</td>
                      <td className="num"><Money value={c.claimedAmount} /></td>
                      <td className="num">
                        {c.component.annualExemptLimit
                          ? <Money value={c.component.annualExemptLimit} />
                          : <span className="subtle">—</span>}
                      </td>
                      <td>
                        <Badge tone={c.status === "PAID" ? "success" : c.status === "APPROVED" ? "info" : "neutral"}>
                          {c.status.toLowerCase()}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
