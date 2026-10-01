import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@keka/db";
import { PERMISSIONS, canAccessEmployee } from "@keka/rbac";
import { formatPeriod, formatDate, formatINR } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { PageHead, Card, Money, Badge, AccessDenied, Callout, KeyValue } from "@/components/ui";

const P = PERMISSIONS;
const n = (v: unknown) => Number(v ?? 0);

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;

  const payslip = await prisma.payslip.findFirst({
    where: { id },
    include: {
      employee: {
        include: {
          department: { select: { name: true } },
          location: { select: { name: true, stateCode: true } },
          legalEntity: { select: { legalName: true, addressLine1: true, city: true, state: true } },
          identityDocs: { where: { type: "PAN" }, select: { number: true } },
          bankAccounts: { where: { isPrimary: true }, select: { bankName: true, accountNumber: true } },
          statutoryProfile: { select: { uan: true, esicNumber: true, taxRegime: true } },
        },
      },
      run: {
        include: {
          payGroup: { include: { payslipSetting: true } },
          lines: false,
        },
      },
    },
  });

  if (!payslip || payslip.employee.tenantId !== viewer.tenantId) notFound();

  const emp = payslip.employee;
  const isSelf = viewer.employee?.id === emp.id;

  const target = {
    id: emp.id,
    departmentId: emp.departmentId,
    locationId: emp.locationId,
    legalEntityId: emp.legalEntityId,
    businessUnitId: emp.businessUnitId,
    reportingManagerId: emp.reportingManagerId,
  };
  if (!isSelf && !canAccessEmployee(viewer, target, P.PAYSLIP_VIEW_ALL)) {
    return <AccessDenied permission={P.PAYSLIP_VIEW_ALL} what="this payslip" />;
  }

  // An unreleased payslip is not visible to the employee themselves.
  if (isSelf && payslip.status !== "RELEASED") {
    return (
      <Callout tone="info" title="This payslip has not been released yet">
        Payroll for {formatPeriod(payslip.year, payslip.month)} is finalised but the payslip
        has not been released. It will appear here once your payroll team releases it.
      </Callout>
    );
  }

  const runEmployee = await prisma.payrollRunEmployee.findUnique({
    where: { runId_employeeId: { runId: payslip.runId, employeeId: emp.id } },
    include: { lines: { orderBy: { sequence: "asc" } } },
  });
  if (!runEmployee) notFound();

  const settings = payslip.run.payGroup.payslipSetting;
  const earnings = runEmployee.lines.filter((l) => l.type === "EARNING" && l.showOnPayslip);
  const reimbursements = runEmployee.lines.filter((l) => l.type === "REIMBURSEMENT" && l.showOnPayslip);
  const deductions = runEmployee.lines.filter((l) => l.type === "DEDUCTION" && l.showOnPayslip);
  const contributions = runEmployee.lines.filter(
    (l) => l.type === "EMPLOYER_CONTRIBUTION" && l.showOnPayslip,
  );

  const sum = (rows: typeof earnings) => rows.reduce((s, l) => s + n(l.amount), 0);
  const pan = emp.identityDocs[0]?.number ?? null;
  const twoSection = settings?.layout === "TWO_SECTION";

  return (
    <>
      <PageHead
        title={`Payslip — ${formatPeriod(payslip.year, payslip.month)}`}
        subtitle={`${emp.displayName} · ${emp.employeeNumber}`}
        actions={
          <>
            <Badge tone={payslip.status === "RELEASED" ? "success" : "warning"}>
              {payslip.status.replace(/_/g, " ").toLowerCase()}
            </Badge>
            <a className="btn primary" href={`/payroll/payslips/${payslip.id}/pdf`}>Download PDF</a>
            <Link className="btn" href={`/employees/${emp.id}?tab=finances`}>Employee</Link>
          </>
        }
      />

      <div className="payslip">
        <div className="payslip-head">
          <div>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{emp.legalEntity?.legalName}</div>
            <div className="text-sm muted">
              {[emp.legalEntity?.addressLine1, emp.legalEntity?.city, emp.legalEntity?.state]
                .filter(Boolean).join(", ")}
            </div>
            <div className="text-sm strong" style={{ marginTop: 10 }}>
              Payslip for {formatPeriod(payslip.year, payslip.month)}
            </div>
          </div>
          <div style={{ minWidth: 240 }}>
            <KeyValue items={[
              ["Employee", emp.displayName],
              ["Number", <span className="mono" key="n">{emp.employeeNumber}</span>],
              ["Designation", emp.jobTitleName],
              ["Department", emp.department?.name],
              ["Location", emp.location ? `${emp.location.name} (${emp.location.stateCode})` : null],
              ["Date of joining", formatDate(emp.dateOfJoining)],
              ["PAN", pan ? <span className="mono" key="p">{pan}</span> : null],
              ["UAN", emp.statutoryProfile?.uan],
              ["Bank", emp.bankAccounts[0]
                ? `${emp.bankAccounts[0].bankName} ••••${emp.bankAccounts[0].accountNumber.slice(-4)}`
                : null],
              ["Payable days", `${n(runEmployee.payableDays).toFixed(2)} of ${runEmployee.totalDays}`],
              ...(n(runEmployee.lopDays) > 0
                ? [["Loss of pay", `${n(runEmployee.lopDays).toFixed(2)} days`] as [string, string]]
                : []),
            ]} />
          </div>
        </div>

        <div
          className="payslip-sections"
          style={twoSection ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } : undefined}
        >
          <div className="payslip-section">
            <div className="payslip-section-head">Earnings</div>
            {earnings.map((l) => (
              <div className="payslip-line" key={l.id}>
                <span>
                  {l.name}
                  {settings?.showYtdTotals && n(l.fullAmount) !== n(l.amount) ? (
                    <span className="text-xs subtle"> (full {formatINR(n(l.fullAmount), false)})</span>
                  ) : null}
                </span>
                <span className="amount">{formatINR(n(l.amount), false)}</span>
              </div>
            ))}
            <div className="payslip-total">
              <span>Gross earnings</span>
              <span>{formatINR(sum(earnings), false)}</span>
            </div>
          </div>

          {!twoSection ? (
            <div className="payslip-section">
              <div className="payslip-section-head">Employer contributions</div>
              {contributions.length === 0 ? (
                <div className="payslip-line"><span className="subtle">None</span><span /></div>
              ) : contributions.map((l) => (
                <div className="payslip-line" key={l.id}>
                  <span>{l.name}</span>
                  <span className="amount">{formatINR(n(l.amount), false)}</span>
                </div>
              ))}
              <div className="payslip-total">
                <span>Total employer cost</span>
                <span>{formatINR(sum(contributions), false)}</span>
              </div>
            </div>
          ) : null}

          <div className="payslip-section">
            <div className="payslip-section-head">Deductions</div>
            {deductions.map((l) => (
              <div className="payslip-line" key={l.id}>
                <span>{l.name}</span>
                <span className="amount">{formatINR(n(l.amount), false)}</span>
              </div>
            ))}
            {twoSection ? contributions.map((l) => (
              <div className="payslip-line" key={l.id}>
                <span className="muted">{l.name} (employer)</span>
                <span className="amount muted">{formatINR(n(l.amount), false)}</span>
              </div>
            )) : null}
            <div className="payslip-total">
              <span>Total deductions</span>
              <span>{formatINR(sum(deductions), false)}</span>
            </div>
          </div>
        </div>

        {reimbursements.length > 0 ? (
          <div style={{ borderTop: "1px solid var(--border)" }}>
            <div className="payslip-section-head">
              Tax-free reimbursements — not taxable income, not reported on Form 16
            </div>
            {reimbursements.map((l) => (
              <div className="payslip-line" key={l.id}>
                <span>{l.name}</span>
                <span className="amount">{formatINR(n(l.amount), false)}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="payslip-net">
          <div>
            <div className="stat-label">Net pay</div>
            <div className="stat-value"><Money value={runEmployee.netPay} /></div>
          </div>
          <div className="text-sm muted right" style={{ maxWidth: 380 }}>
            Gross {formatINR(sum(earnings) + sum(reimbursements), false)} less deductions{" "}
            {formatINR(sum(deductions), false)}.
            {settings?.passwordProtect && pan
              ? " The downloadable copy is password protected — the password is your PAN in uppercase."
              : ""}
          </div>
        </div>
      </div>

      {settings?.appendTaxSummary ? (
        <div style={{ marginTop: 16 }}>
          <Card title="Tax computation summary">
            <KeyValue items={[
              ["Tax regime", emp.statutoryProfile?.taxRegime === "OLD" ? "Old regime" : "New regime"],
              ["TDS this month", <Money key="t" value={runEmployee.tds} />],
              ["PF wage", <Money key="p" value={runEmployee.pfWage} />],
              ["ESI gross", <Money key="e" value={runEmployee.esiGross} />],
            ]} />
          </Card>
        </div>
      ) : null}
    </>
  );
}
