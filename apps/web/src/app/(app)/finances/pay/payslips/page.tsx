import Link from "next/link";
import { prisma } from "@keka/db";
import { MONTH_NAMES } from "@keka/shared";
import { requireViewer } from "@/lib/context";
import { EmptyState } from "@/components/keka";
import { IconReceipt } from "@/components/icons";
import { GhostFigure, IconDown, IconInfo } from "../../_components/icons";
import { NavSelect } from "../../_components/nav-select";
import { PayslipSheet } from "../../_components/payslip-sheet";
import s from "../../finances.module.css";

export const metadata = { title: "Pay Slips" };

const n = (v: unknown) => Number(v ?? 0);
const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/**
 * Pay Slips, as Keka lays them out: a year picker, the year's months on the
 * left — a yellow mark on any the payroll team has not released — and the
 * selected payslip on the right. Only released payslips can be opened or
 * downloaded; a generated or held one shows that it is waiting on the admin.
 */
export default async function PayslipsPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string }> }) {
  const viewer = await requireViewer();
  if (!viewer.employee) {
    return <EmptyState icon={<IconReceipt />} title="No employee record">This login is not linked to an employee record.</EmptyState>;
  }
  const employeeId = viewer.employee.id;
  const sp = await searchParams;

  const [emp, slips] = await Promise.all([
    prisma.employee.findFirst({ where: { id: employeeId, tenantId: viewer.tenantId }, select: { dateOfJoining: true } }),
    // A payslip row exists once its run is finalised; whether the employee may open it depends on release.
    prisma.payslip.findMany({
      where: { employeeId, isSegregated: false, status: { in: ["GENERATED", "HELD", "RELEASED"] }, run: { tenantId: viewer.tenantId, status: "FINALIZED" } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      select: { id: true, year: true, month: true, runId: true, status: true },
    }),
  ]);

  const thisYear = new Date().getUTCFullYear();
  const firstYear = Math.min(emp?.dateOfJoining.getUTCFullYear() ?? thisYear, ...slips.map((p) => p.year));
  const years = Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i);
  const fromMonth = /^(\d{4})-(\d{2})$/.exec(sp.month ?? "");
  const wanted = fromMonth ? Number(fromMonth[1]) : Number(sp.year);
  const latestYear = slips[0]?.year ?? thisYear;
  const year = years.includes(wanted) ? wanted : latestYear;
  const inYear = slips.filter((p) => p.year === year);
  const selected = (fromMonth && inYear.find((p) => key(p.year, p.month) === sp.month)) || inYear[0] || null;
  const released = selected?.status === "RELEASED";
  const label = selected ? `${MONTH_NAMES[selected.month - 1]} ${selected.year}` : null;
  const pdf = (id: string) => `/payroll/payslips/${id}/pdf`;
  const anyReleased = slips.some((p) => p.status === "RELEASED");

  const [slip, line] = selected && released ? await Promise.all([
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
  ]) : [null, null];

  const e = slip?.employee;
  const pan = e?.identityDocs.find((d) => d.type === "PAN") ?? null;
  const aadhaar = e?.identityDocs.find((d) => d.type === "AADHAAR") ?? null;
  const entity = slip?.run.payGroup.legalEntity ?? null;

  return (
    <>
      <div className={s.pageHead}>
        <h1 className={s.pageTitle}>Pay Slips</h1>
        {anyReleased ? (
          <details className={s.downloads}>
            <summary aria-label="Download payslips" title="Download payslips"><IconDown width={20} height={20} /></summary>
            <div className={s.downloadMenu} role="menu" aria-label="Download payslips">
              {[3, 6, 12].map((k) => (
                <a key={k} role="menuitem" href={`/finances/pay/payslips/download?last=${k}`} download>Pay Slips - Last {k} months</a>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <p className={s.pageSub}>Here you can manage all generated payslips for applicable years.</p>

      <div className={s.slipBar}>
        <NavSelect
          label="Select Year"
          className={s.yearSelect}
          value={String(year)}
          options={years.map((y) => ({ value: String(y), label: `Year ${y}`, href: `/finances/pay/payslips?year=${y}` }))}
        />
        {label ? (
          <div className={s.slipAction}>
            {released && selected ? (
              <a className={`btn ${s.outlineBtn}`} href={pdf(selected.id)} download>{label} Pay Slip <IconDown width={17} height={17} /></a>
            ) : (
              <button type="button" className={`btn ${s.outlineBtn}`} disabled>{label} Pay Slip <IconDown width={17} height={17} /></button>
            )}
            {released ? <div className={s.slipHint}>{pan ? "The PDF opens with your PAN in capitals." : "No PAN on record, so the PDF is not password protected."}</div> : null}
          </div>
        ) : null}
      </div>

      <div className={s.slipLayout}>
        <nav className={s.monthList} aria-label={`Payslips for ${year}`}>
          <div className={s.monthListHead}>Payslips</div>
          {inYear.length === 0 ? <div className={s.monthEmpty}>No payslips for {year}</div> : inYear.map((p) => {
            const active = p.id === selected?.id;
            return (
              <Link
                key={p.id}
                href={`/finances/pay/payslips?month=${key(p.year, p.month)}`}
                className={`${s.monthItem}${active ? ` ${s.monthItemActive}` : ""}`}
                aria-current={active ? "page" : undefined}
                scroll={false}
              >
                <span>{MONTH_NAMES[p.month - 1]} {p.year}</span>
                {p.status !== "RELEASED" ? <span className={s.pendingMark} title="Not released yet" aria-label="not released yet"><IconInfo width={15} height={15} /></span> : null}
              </Link>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          {!selected ? (
            <div className={`${s.boxed} ${s.ghostPane}`}>
              <GhostFigure />
              <div className={s.ghostTitle}>{slips.length === 0 ? "No payslips yet" : `No payslips for ${year}`}</div>
              <div className={s.ghostText}>{slips.length === 0 ? "Your payslips will appear here once payroll is processed for you." : "Pick another year to see its payslips."}</div>
            </div>
          ) : !released ? (
            <div className={`${s.boxed} ${s.ghostPane}`}>
              <GhostFigure />
              <div className={s.ghostTitle}>Payslip has not been released yet by the admin</div>
              <div className={s.ghostText}>Reach out to your admin for your payslip</div>
            </div>
          ) : (
            <section className={s.frameDark} aria-label={`Payslip ${label}`}>
              <div className={s.frameDarkHead}>{label}</div>
              {slip && line && e ? (
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
                    name: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" "),
                    number: e.employeeNumber,
                    joined: e.dateOfJoining,
                    department: e.department?.name ?? null,
                    designation: e.jobTitleName,
                    paymentMode: e.bankAccounts.length ? "Bank Transfer" : "Cheque",
                    uan: e.statutoryProfile?.uan ?? null,
                    pfNumber: e.statutoryProfile?.pfAccountNumber ?? null,
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
                <div className={s.ghostPane}>
                  <div className={s.ghostTitle}>Payslip details unavailable</div>
                  <div className={s.ghostText}>The details for this payslip could not be loaded. You can still download the PDF.</div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
