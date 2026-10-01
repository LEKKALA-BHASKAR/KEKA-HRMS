/**
 * Statutory upload files, byte for byte as the portals expect them.
 * Every amount is a whole rupee: the portals reject paise.
 */

const whole = (v: number) => String(Math.round(v));

export interface EcrMember {
  uan: string; name: string;
  grossWages: number; epfWages: number; epsWages: number; edliWages: number;
  epfContribution: number; epsContribution: number; epfEpsDiff: number;
  ncpDays: number; refundOfAdvances?: number;
}

/**
 * EPFO ECR 2.0 text file: one member per line, fields joined by "#~#", no
 * header. Names are upper-cased and stripped to letters, spaces and dots.
 */
export function pfEcr(members: EcrMember[]): { content: string; issues: string[] } {
  const issues: string[] = [];
  const lines: string[] = [];
  for (const m of members) {
    if (!/^\d{12}$/.test(m.uan)) { issues.push(`${m.name}: UAN "${m.uan}" is not 12 digits — left out`); continue; }
    const name = m.name.toUpperCase().replace(/[^A-Z .]/g, "").replace(/\s+/g, " ").trim();
    lines.push([m.uan, name, whole(m.grossWages), whole(m.epfWages), whole(m.epsWages), whole(m.edliWages), whole(m.epfContribution), whole(m.epsContribution), whole(m.epfEpsDiff), whole(m.ncpDays), whole(m.refundOfAdvances ?? 0)].join("#~#"));
  }
  return { content: lines.join("\n") + (lines.length ? "\n" : ""), issues };
}

export interface EsiMember {
  ipNumber: string; name: string; days: number; wages: number;
  /** 0 when days > 0; otherwise the ESIC reason code (1 on leave, 2 left service, …). */
  reasonCode?: number; lastWorkingDay?: string | null;
}

const csvCell = (v: string) => {
  const safe = /^[=+\-@]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** ESIC monthly contribution upload. */
export function esiContribution(members: EsiMember[]): { content: string; issues: string[] } {
  const issues: string[] = [];
  const rows: string[][] = [["IP Number", "IP Name", "No of Days for which wages paid/payable during the month", "Total Monthly Wages", "Reason Code for Zero workings days", "Last Working Day"]];
  for (const m of members) {
    if (!/^\d{10}$/.test(m.ipNumber)) { issues.push(`${m.name}: IP number "${m.ipNumber}" is not 10 digits — left out`); continue; }
    rows.push([m.ipNumber, m.name, whole(m.days), whole(m.wages), String(m.days > 0 ? 0 : m.reasonCode ?? 1), m.lastWorkingDay ?? ""]);
  }
  return { content: csv(rows), issues };
}

export interface BankPayment { name: string; accountNumber: string; ifsc: string; amount: number; narration: string; email?: string | null }

/** Salary transfer advice in the common bulk-upload layout. */
export function bankAdvice(payments: BankPayment[]): { content: string; issues: string[]; total: number } {
  const issues: string[] = [];
  const rows: string[][] = [["Beneficiary Name", "Account Number", "IFSC", "Amount", "Narration", "Email"]];
  let total = 0;
  for (const p of payments) {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(p.ifsc)) { issues.push(`${p.name}: IFSC "${p.ifsc}" is invalid — left out`); continue; }
    if (!/^\d{6,18}$/.test(p.accountNumber)) { issues.push(`${p.name}: account number is not 6–18 digits — left out`); continue; }
    if (p.amount <= 0) { issues.push(`${p.name}: nothing to pay`); continue; }
    rows.push([p.name, p.accountNumber, p.ifsc, p.amount.toFixed(2), p.narration.slice(0, 30), p.email ?? ""]);
    total += p.amount;
  }
  return { content: csv(rows), issues, total: Math.round(total * 100) / 100 };
}

export interface Deductee { pan: string | null; name: string; paymentDate: string; amountPaid: number; tds: number }

/**
 * Form 24Q, Annexure I (deductee details) for one quarter, as the CSV most
 * return-preparation utilities import. A missing PAN is reported as
 * PANNOTAVBL, which attracts the 20% rate under s.206AA.
 */
export function form24qAnnexure(deductees: Deductee[], quarter: string): { content: string; issues: string[]; totals: { paid: number; tds: number } } {
  const issues: string[] = [];
  const rows: string[][] = [["Quarter", "Section", "PAN of Employee", "Name of Employee", "Date of Payment/Credit", "Amount Paid/Credited", "TDS Deducted", "TDS Deposited"]];
  let paid = 0, tds = 0;
  for (const d of deductees) {
    const pan = d.pan && /^[A-Z]{5}\d{4}[A-Z]$/.test(d.pan.toUpperCase()) ? d.pan.toUpperCase() : "PANNOTAVBL";
    if (pan === "PANNOTAVBL") issues.push(`${d.name}: no valid PAN — filed as PANNOTAVBL`);
    rows.push([quarter, "192", pan, d.name, d.paymentDate, whole(d.amountPaid), whole(d.tds), whole(d.tds)]);
    paid += d.amountPaid; tds += d.tds;
  }
  return { content: csv(rows), issues, totals: { paid: Math.round(paid), tds: Math.round(tds) } };
}
