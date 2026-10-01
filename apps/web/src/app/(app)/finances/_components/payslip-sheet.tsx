import type { ReactNode } from "react";
import { formatDate, formatINR, MONTH_NAMES } from "@keka/shared";
import { Masked } from "@/components/masked";
import { rupeesInWords } from "../_lib/rules";
import s from "../finances.module.css";

/**
 * One payslip, laid out as Keka renders it inline: company, employee
 * details, days, then earnings beside contributions and deductions, the net
 * in figures and words, and the employer's total cost.
 *
 * It shows the same finalised run lines as the payroll team's payslip page
 * (payroll/payslips/[id]); the grouping into contributions, taxes and other
 * components is presentation only.
 */

export interface PayslipLine { id: string; code: string; name: string; type: string; amount: unknown; showOnPayslip: boolean }

export interface PayslipSheetData {
  year: number;
  month: number;
  company: { legalName: string; address: string[]; logoUrl: string | null };
  employee: {
    name: string; number: string; joined: Date; department: string | null; designation: string | null;
    paymentMode: string; uan: string | null; pfNumber: string | null; pan: string | null; aadhaar: string | null; aadhaarName: string | null;
  };
  days: { total: number; lop: number; payable: number };
  lines: PayslipLine[];
  netPay: number;
  showEmployerContributions: boolean;
}

const n = (v: unknown) => Number(v ?? 0);
const money = (v: number) => formatINR(v, false);
const dayFmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
/** Employee-side statutory contributions; everything else deducted is a tax or a recovery. */
const CONTRIBUTION = /^(PF_EMPLOYEE|VPF|ESI_EMPLOYEE|LWF_EMPLOYEE|NPS_EMPLOYEE)$/;

function Lines({ rows, total, totalLabel }: { rows: PayslipLine[]; total: number; totalLabel: string }) {
  return (
    <>
      {rows.length === 0 ? <div className={`${s.line} ${s.muted}`}><span>None</span><span /></div> : rows.map((l) => (
        <div className={s.line} key={l.id}><span>{l.name}</span><span>{money(n(l.amount))}</span></div>
      ))}
      <div className={`${s.line} ${s.lineTotal}`}><span>{totalLabel}</span><span>{money(total)}</span></div>
    </>
  );
}

export function PayslipSheet({ d }: { d: PayslipSheetData }) {
  const shown = d.lines.filter((l) => l.showOnPayslip);
  const earnings = shown.filter((l) => l.type === "EARNING");
  const reimbursements = shown.filter((l) => l.type === "REIMBURSEMENT");
  const deductions = shown.filter((l) => l.type === "DEDUCTION" && n(l.amount) !== 0);
  const contributions = deductions.filter((l) => CONTRIBUTION.test(l.code));
  const taxes = deductions.filter((l) => !CONTRIBUTION.test(l.code));
  const other = shown.filter((l) => l.type === "EMPLOYER_CONTRIBUTION" && n(l.amount) !== 0);
  const sum = (rows: PayslipLine[]) => rows.reduce((a, l) => a + n(l.amount), 0);
  const A = sum(earnings), R = sum(reimbursements), B = sum(contributions), C = sum(taxes), D = sum(other);
  const hasR = reimbursements.length > 0;
  const showD = d.showEmployerContributions && other.length > 0;
  const monthName = MONTH_NAMES[d.month - 1];
  const initials = d.company.legalName.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const e = d.employee;

  const details: Array<[string, ReactNode]> = [
    ["Employee Number", e.number],
    ["Date Joined", formatDate(e.joined)],
    ["Department", e.department ?? "—"],
    ["Designation", e.designation ?? "—"],
    ["Payment Mode", e.paymentMode],
    ["UAN", e.uan ?? "—"],
    ["PF Number", e.pfNumber ?? "—"],
    ["PAN Number", e.pan ? <Masked value={e.pan} keep={4} /> : "—"],
    ["Aadhaar Number", e.aadhaar ? <Masked value={e.aadhaar} keep={4} group={4} /> : "—"],
    ["Full Name as per Aadhaar Card", e.aadhaar ? (e.aadhaarName ?? e.name).toUpperCase() : "—"],
  ];

  return (
    <article className={s.sheet} aria-label={`Payslip for ${monthName} ${d.year}`}>
      <div className={s.sheetTop}>
        <div>
          <h2 className={s.sheetTitle}><strong>Payslip</strong> {monthName} {d.year}</h2>
          <div className={s.company}>{d.company.legalName}</div>
          {d.company.address.length ? <div className={s.address}>{d.company.address.map((a, i) => <div key={i}>{a}</div>)}</div> : null}
        </div>
        <div className={s.logo} aria-hidden="true">
          {d.company.logoUrl?.startsWith("/") ? <img src={d.company.logoUrl} alt="" /> : initials}
        </div>
      </div>

      <div className={s.empName}>{e.name}</div>
      <div className={s.detailGrid}>
        {details.map(([k, v]) => (
          <div key={k}><div className={s.dLabel}>{k}</div><div className={s.dValue}>{v}</div></div>
        ))}
      </div>

      <h3 className={s.sheetSection}>Salary Details</h3>
      <div className={s.detailGrid}>
        <div><div className={s.dLabel}>Actual Payable Days</div><div className={s.dValue}>{dayFmt(d.days.total - d.days.lop)}</div></div>
        <div><div className={s.dLabel}>Total Working Days</div><div className={s.dValue}>{d.days.total}</div></div>
        <div><div className={s.dLabel}>Loss of Pay Days</div><div className={s.dValue}>{dayFmt(d.days.lop)}</div></div>
        <div><div className={s.dLabel}>Days Payable</div><div className={s.dValue}>{dayFmt(d.days.payable)}</div></div>
      </div>

      <div className={s.money}>
        <div>
          <div className={s.moneyHead}>Earnings</div>
          <Lines rows={earnings} total={A} totalLabel="Total Earnings (A)" />
          {hasR ? (
            <>
              <div className={s.moneyHead}>Reimbursements</div>
              <Lines rows={reimbursements} total={R} totalLabel="Total Reimbursements (R)" />
            </>
          ) : null}
        </div>
        <div>
          <div className={s.moneyHead}>Contributions</div>
          <Lines rows={contributions} total={B} totalLabel="Total Contributions (B)" />
          <div className={s.moneyHead}>Taxes &amp; Deductions</div>
          <Lines rows={taxes} total={C} totalLabel="Total Taxes & Deductions (C)" />
        </div>
      </div>

      <div className={s.netBox}>
        <div><span>Net Salary Payable ( A{hasR ? " + R" : ""} - B - C )</span><span>{money(d.netPay)}</span></div>
        <div><span>Net Salary in words</span><span>{rupeesInWords(Math.round(d.netPay))}</span></div>
      </div>

      {showD ? (
        <>
          <div className={s.moneyHead} style={{ marginTop: 26 }}>Other Components</div>
          <div style={{ maxWidth: "50%", minWidth: 260 }}>
            <Lines rows={other} total={D} totalLabel="Total Other Components (D)" />
          </div>
          <div className={s.netBox}>
            <div><span>Total Cost ( A{hasR ? " + R" : ""} + D )</span><span>{money(A + R + D)}</span></div>
            <div><span>Total Cost in words</span><span>{rupeesInWords(Math.round(A + R + D))}</span></div>
          </div>
        </>
      ) : null}

      <div className={s.notes}>
        <div><strong>**Note :</strong> All amounts displayed in this payslip are in <strong>INR</strong></div>
        <div style={{ marginTop: 12 }}>*This is computer generated statement, does not require signature.</div>
        <div>&nbsp;All transactions are made to the mentioned account number.</div>
      </div>
    </article>
  );
}
