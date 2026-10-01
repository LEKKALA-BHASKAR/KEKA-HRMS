import Link from "next/link";
import { prisma } from "@keka/db";
import { MONTH_NAMES } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { EmptyState, InfoBanner } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { IconDown } from "../../_components/icons";
import { NavSelect } from "../../_components/nav-select";
import { PayslipSheet } from "../../_components/payslip-sheet";
import s from "../../finances.module.css";

export const metadata = { title: "Payslips" };

const n = (v: unknown) => Number(v ?? 0);
const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export default async function PayslipsPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const sp = await searchParams;

  // Only payslips released to the employee are theirs to see.
  const slips = await prisma.payslip.findMany({
    where: { employeeId, status: "RELEASED", isSegregated: false, run: { tenantId: viewer.tenantId } },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { id: true, year: true, month: true, runId: true },
  });

  const head = (
    <>
      <div className={s.pageHead}><h1 className={s.pageTitle}>Payslips</h1></div>
      <p className={s.pageSub}>Here you can view and download the payslips released to you, year by year.</p>
    </>
  );
  if (slips.length === 0) {
    return (
      <>
        {head}
        <div className={`${s.boxed} ${s.mt}`}>
          <EmptyState icon={<IconReceipt />} title="No payslips yet">Your payslips will appear here once payroll is processed and your payroll team releases them.</EmptyState>
        </div>
      </>
    );
  }

  const years = [...new Set(slips.map((p) => p.year))];
  const fromMonth = /^(\d{4})-(\d{2})$/.exec(sp.month ?? "");
  const wantedYear = fromMonth ? Number(fromMonth[1]) : Number(sp.year);
  const year = years.includes(wantedYear) ? wantedYear : years[0];
  const inYear = slips.filter((p) => p.year === year);
  const selected = (fromMonth && inYear.find((p) => key(p.year, p.month) === sp.month)) || inYear[0];

  const [slip, line] = await Promise.all([
    prisma.payslip.findFirst({
      where: { id: selected.id, employeeId, status: "RELEASED" },
      include: {
        run: { select: { payGroup: { select: { payslipSetting: { select: { showEmployerContributions: true } }, legalEntity: true } } } },
        employee: {
          select: {
            firstName: true, middleName: true, lastName: true, employeeNumber: true, dateOfJoining: true, jobTitleName: true,
            department: { select: { name: true } },
            identityDocs: { where: { type: { in: ["PAN", "AADHAAR"] } }, select: { type: true, number: true, nameOnDoc: true } },
            statutoryProfile: { select: { uan: true, pfAccountNumber: true } },
            bankAccounts: { where: { isPrimary: true }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    prisma.payrollRunEmployee.findUnique({
      where: { runId_employeeId: { runId: selected.runId, employeeId } },
      include: { lines: { orderBy: { sequence: "asc" }, select: { id: true, code: true, name: true, type: true, amount: true, showOnPayslip: true } } },
    }),
  ]);

  const emp = slip?.employee;
  const pan = emp?.identityDocs.find((d) => d.type === "PAN") ?? null;
  const aadhaar = emp?.identityDocs.find((d) => d.type === "AADHAAR") ?? null;
  const entity = slip?.run.payGroup.legalEntity ?? null;
  const label = `${MONTH_NAMES[selected.month - 1]} ${selected.year}`;
  const pdf = (id: string) => `/payroll/payslips/${id}/pdf`;

  return (
    <>
      <div className={s.pageHead}>
        <h1 className={s.pageTitle}>Payslips</h1>
        <details className={s.downloads}>
          <summary><IconDown width={16} height={16} /> Download payslips</summary>
          <div className={s.downloadMenu} role="menu" aria-label={`Download payslips for ${year}`}>
            {inYear.map((p) => (
              <a key={p.id} role="menuitem" href={pdf(p.id)} download>
                <span>{MONTH_NAMES[p.month - 1]} {p.year}</span><span className={s.muted}>PDF</span>
              </a>
            ))}
          </div>
        </details>
      </div>
      <p className={s.pageSub}>Here you can view and download the payslips released to you, year by year.</p>

      <NavSelect
        label="Year"
        className={s.yearSelect}
        value={String(year)}
        options={years.map((y) => ({ value: String(y), label: `Year ${y}`, href: `/finances/pay/payslips?year=${y}` }))}
      />

      <div className={s.slipLayout}>
        <nav className={s.monthList} aria-label={`Payslips for ${year}`}>
          <div className={s.monthListHead}>Payslips</div>
          {inYear.map((p) => {
            const active = p.id === selected.id;
            return (
              <Link
                key={p.id}
                href={`/finances/pay/payslips?month=${key(p.year, p.month)}`}
                className={`${s.monthItem}${active ? ` ${s.monthItemActive}` : ""}`}
                aria-current={active ? "page" : undefined}
                scroll={false}
              >
                {MONTH_NAMES[p.month - 1]} {p.year}
              </Link>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          <InfoBanner>
            {pan
              ? "Your payslip is password protected. To view the downloaded file, enter your PAN in all uppercase."
              : "No PAN is on record, so your downloaded payslip is not password protected. Ask HR to add your PAN."}
          </InfoBanner>
          <section className={s.frame} aria-label={`Payslip ${label}`}>
            <div className={s.frameHead}>
              <span>{label}</span>
              <a className="btn" href={pdf(selected.id)} download>
                <IconDown width={16} height={16} /> Download Payslip
              </a>
            </div>
            {slip && line && emp ? (
              <PayslipSheet d={{
                year: selected.year,
                month: selected.month,
                company: {
                  legalName: entity?.legalName ?? entity?.name ?? viewer.tenant.name,
                  address: entity
                    ? [entity.addressLine1, entity.addressLine2, [entity.city, entity.state].filter(Boolean).join(", ") + (entity.postalCode ? `, ${entity.postalCode}.` : "")]
                        .filter((x): x is string => !!x && x.trim().length > 0)
                    : [],
                  logoUrl: entity?.logoUrl ?? null,
                },
                employee: {
                  name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" "),
                  number: emp.employeeNumber,
                  joined: emp.dateOfJoining,
                  department: emp.department?.name ?? null,
                  designation: emp.jobTitleName,
                  paymentMode: emp.bankAccounts.length ? "Bank Transfer" : "Cheque",
                  uan: emp.statutoryProfile?.uan ?? null,
                  pfNumber: emp.statutoryProfile?.pfAccountNumber ?? null,
                  pan: pan?.number.toUpperCase() ?? null,
                  aadhaar: aadhaar?.number.replace(/\D/g, "") ?? null,
                  aadhaarName: aadhaar?.nameOnDoc ?? null,
                },
                days: { total: line.totalDays, lop: n(line.lopDays), payable: n(line.payableDays) },
                lines: line.lines,
                netPay: n(line.netPay),
                showEmployerContributions: slip.run.payGroup.payslipSetting?.showEmployerContributions ?? true,
              }} />
            ) : (
              <EmptyState title="Payslip unavailable">The details for this payslip could not be loaded. You can still download the PDF.</EmptyState>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
