import { PdfDoc, type PdfPage, type RGB } from "./pdf";

/** Everything a payslip shows. Amounts in rupees. */
export interface PayslipData {
  company: { name: string; address?: string | null };
  period: string;
  employee: {
    name: string; number: string; designation?: string | null; department?: string | null;
    joined?: string | null; pan?: string | null; uan?: string | null; bank?: string | null; location?: string | null;
  };
  days: { inMonth: number; paid: number; lop: number };
  earnings: Array<{ name: string; full: number; actual: number }>;
  deductions: Array<{ name: string; amount: number }>;
  employer?: Array<{ name: string; amount: number }>;
  netPay: number;
  netInWords?: string;
  ytd?: { gross: number; tds: number; pf: number };
  note?: string;
}

const inr = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BRAND: RGB = [0.11, 0.32, 0.72];
const MUTED: RGB = [0.42, 0.45, 0.52];
const SHADE: RGB = [0.95, 0.96, 0.98];

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words2(n: number): string { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function words3(n: number): string { return n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${words2(n % 100)}` : ""}` : words2(n); }

/** Rupees in Indian-system words: lakh and crore, not million. */
export function rupeesInWords(amount: number): string {
  const r = Math.floor(Math.abs(amount)), p = Math.round((Math.abs(amount) - r) * 100);
  if (r === 0 && p === 0) return "Zero Rupees Only";
  const parts: string[] = [];
  const crore = Math.floor(r / 1e7), lakh = Math.floor((r % 1e7) / 1e5), thousand = Math.floor((r % 1e5) / 1e3), rest = r % 1e3;
  if (crore) parts.push(`${words3(crore)} Crore`);
  if (lakh) parts.push(`${words2(lakh)} Lakh`);
  if (thousand) parts.push(`${words2(thousand)} Thousand`);
  if (rest) parts.push(words3(rest));
  return `${parts.join(" ")} Rupees${p ? ` and ${words2(p)} Paise` : ""} Only`;
}

function header(pg: PdfPage, company: { name: string; address?: string | null }, title: string, period: string) {
  pg.rect(0, 0, pg.width, 6, { fill: BRAND });
  pg.text(40, 46, company.name, { size: 16, bold: true });
  if (company.address) pg.text(40, 62, company.address, { size: 8.5, color: MUTED });
  pg.text(pg.width - 40, 46, title, { size: 12, bold: true, align: "right", color: BRAND });
  pg.text(pg.width - 40, 62, period, { size: 9.5, align: "right", color: MUTED });
  pg.line(40, 76, pg.width - 40, 76, { color: [0.85, 0.87, 0.9] });
}

export function renderPayslip(d: PayslipData, opts: { password?: string } = {}): Buffer {
  const doc = new PdfDoc({ title: `Payslip ${d.period} — ${d.employee.name}`, author: d.company.name });
  drawPayslip(doc.page(), d);
  return doc.toBuffer({ userPassword: opts.password });
}

/** Several payslips in one PDF, a page each — the "last 3/6/12 months" download. */
export function renderPayslips(list: PayslipData[], opts: { title?: string; password?: string } = {}): Buffer {
  if (list.length === 0) throw new Error("No payslips to render.");
  const doc = new PdfDoc({ title: opts.title ?? `Payslips — ${list[0].employee.name}`, author: list[0].company.name });
  for (const d of list) drawPayslip(doc.page(), d);
  return doc.toBuffer({ userPassword: opts.password });
}

function drawPayslip(pg: PdfPage, d: PayslipData): void {
  const L = 40, R = pg.width - 40, W = R - L;
  header(pg, d.company, "Payslip", d.period);

  // Employee details in two columns.
  const left: Array<[string, string | null | undefined]> = [["Employee", d.employee.name], ["Employee no.", d.employee.number], ["Designation", d.employee.designation], ["Department", d.employee.department], ["Location", d.employee.location]];
  const right: Array<[string, string | null | undefined]> = [["Date of joining", d.employee.joined], ["PAN", d.employee.pan], ["UAN", d.employee.uan], ["Bank account", d.employee.bank], ["Paid days", `${d.days.paid} of ${d.days.inMonth}${d.days.lop ? ` (LOP ${d.days.lop})` : ""}`]];
  let y = 98;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i]) { pg.text(L, y, left[i][0], { size: 8.5, color: MUTED }); pg.text(L + 90, y, left[i][1] || "—", { size: 9 }); }
    if (right[i]) { pg.text(L + W / 2, y, right[i][0], { size: 8.5, color: MUTED }); pg.text(L + W / 2 + 90, y, right[i][1] || "—", { size: 9 }); }
    y += 15;
  }

  // Earnings and deductions side by side.
  y += 12;
  const colW = W / 2 - 6;
  pg.rect(L, y, colW, 20, { fill: SHADE }); pg.rect(L + colW + 12, y, colW, 20, { fill: SHADE });
  pg.text(L + 8, y + 13.5, "Earnings", { size: 9, bold: true }); pg.text(L + colW - 80, y + 13.5, "Full month", { size: 8, color: MUTED, align: "right" }); pg.text(L + colW - 8, y + 13.5, "Paid", { size: 9, bold: true, align: "right" });
  pg.text(L + colW + 20, y + 13.5, "Deductions", { size: 9, bold: true }); pg.text(R - 8, y + 13.5, "Amount", { size: 9, bold: true, align: "right" });
  y += 20;
  const rows = Math.max(d.earnings.length, d.deductions.length);
  for (let i = 0; i < rows; i++) {
    const ry = y + 14 + i * 17;
    const e = d.earnings[i], x = d.deductions[i];
    if (e) { pg.text(L + 8, ry, e.name, { size: 9 }); pg.text(L + colW - 80, ry, inr(e.full), { size: 8.5, color: MUTED, align: "right" }); pg.text(L + colW - 8, ry, inr(e.actual), { size: 9, align: "right" }); }
    if (x) { pg.text(L + colW + 20, ry, x.name, { size: 9 }); pg.text(R - 8, ry, inr(x.amount), { size: 9, align: "right" }); }
  }
  y += 14 + rows * 17;
  const gross = d.earnings.reduce((s, e) => s + e.actual, 0), ded = d.deductions.reduce((s, e) => s + e.amount, 0);
  pg.line(L, y - 6, L + colW, y - 6); pg.line(L + colW + 12, y - 6, R, y - 6);
  pg.text(L + 8, y + 8, "Gross earnings", { size: 9, bold: true }); pg.text(L + colW - 8, y + 8, inr(gross), { size: 9, bold: true, align: "right" });
  pg.text(L + colW + 20, y + 8, "Total deductions", { size: 9, bold: true }); pg.text(R - 8, y + 8, inr(ded), { size: 9, bold: true, align: "right" });

  // Net pay band.
  y += 28;
  pg.rect(L, y, W, 44, { fill: [0.93, 0.96, 1] });
  pg.text(L + 12, y + 18, "Net pay", { size: 10, bold: true });
  pg.text(L + 12, y + 33, d.netInWords ?? rupeesInWords(d.netPay), { size: 8.5, color: MUTED });
  pg.text(R - 12, y + 27, `Rs. ${inr(d.netPay)}`, { size: 15, bold: true, align: "right", color: BRAND });
  y += 62;

  if (d.employer?.length) {
    pg.text(L, y, "Employer contributions (not deducted from your pay)", { size: 8.5, bold: true, color: MUTED });
    y += 14;
    for (const c of d.employer) { pg.text(L + 8, y, c.name, { size: 8.5, color: MUTED }); pg.text(L + colW - 8, y, inr(c.amount), { size: 8.5, color: MUTED, align: "right" }); y += 13; }
    y += 6;
  }
  if (d.ytd) {
    pg.text(L, y, `Year to date — gross Rs. ${inr(d.ytd.gross)} · TDS Rs. ${inr(d.ytd.tds)} · PF Rs. ${inr(d.ytd.pf)}`, { size: 8.5, color: MUTED });
    y += 16;
  }
  if (d.note) y = pg.paragraph(L, y, d.note, W, { size: 8.5, color: MUTED });
  pg.text(L, pg.height - 36, "This is a system-generated payslip and does not require a signature.", { size: 7.5, color: MUTED });
}

export interface Form16Data {
  company: { name: string; address?: string | null; tan?: string | null; pan?: string | null };
  employee: { name: string; pan?: string | null; designation?: string | null; number: string };
  fy: string; assessmentYear: string; regime: "OLD" | "NEW";
  rows: Array<{ label: string; amount: number; indent?: number; bold?: boolean }>;
  quarters: Array<{ quarter: string; amountPaid: number; tds: number }>;
  /** The year is not over: figures cover finalised months only. */
  provisional?: boolean;
}

/** Form 16 Part B — the salary and tax computation. Part A comes from TRACES. */
export function renderForm16(d: Form16Data, opts: { password?: string } = {}): Buffer {
  const doc = new PdfDoc({ title: `Form 16 Part B ${d.fy} — ${d.employee.name}`, author: d.company.name });
  const pg = doc.page();
  const L = 40, R = pg.width - 40, W = R - L;
  header(pg, d.company, "Form 16 — Part B", `FY ${d.fy} · AY ${d.assessmentYear}${d.provisional ? " · PROVISIONAL" : ""}`);
  if (d.provisional) pg.text(pg.width - 40, 88, "Covers finalised months only — reissued after the year closes", { size: 7.5, align: "right", color: [0.7, 0.35, 0] });
  let y = 98;
  const kv: Array<[string, string]> = [["Employer", d.company.name], ["Employer TAN", d.company.tan ?? "—"], ["Employee", `${d.employee.name} (${d.employee.number})`], ["Employee PAN", d.employee.pan ?? "—"], ["Tax regime", d.regime === "NEW" ? "New regime (s.115BAC)" : "Old regime"]];
  for (const [k, v] of kv) { pg.text(L, y, k, { size: 8.5, color: MUTED }); pg.text(L + 110, y, v, { size: 9 }); y += 15; }
  y += 10;
  pg.rect(L, y, W, 20, { fill: SHADE });
  pg.text(L + 8, y + 13.5, "Details of salary paid and tax deducted", { size: 9, bold: true });
  pg.text(R - 8, y + 13.5, "Rs.", { size: 9, bold: true, align: "right" });
  y += 20;
  for (const r of d.rows) {
    y += 16;
    pg.text(L + 8 + (r.indent ?? 0) * 14, y, r.label, { size: 9, bold: r.bold });
    pg.text(R - 8, y, inr(r.amount), { size: 9, bold: r.bold, align: "right" });
    if (r.bold) pg.line(L, y + 5, R, y + 5, { color: [0.9, 0.9, 0.92] });
  }
  y += 28;
  pg.text(L, y, "Quarterly summary of tax deducted", { size: 9, bold: true });
  y += 6;
  for (const q of d.quarters) {
    y += 15;
    pg.text(L + 8, y, q.quarter, { size: 9 }); pg.text(L + W / 2, y, `Paid ${inr(q.amountPaid)}`, { size: 9, align: "right" }); pg.text(R - 8, y, `TDS ${inr(q.tds)}`, { size: 9, align: "right" });
  }
  y += 30;
  y = pg.paragraph(L, y, "Part A of Form 16, with the TDS deposited against this PAN, is generated from the TRACES portal and must be issued together with this Part B. Verify the figures against Form 26AS before filing your return.", W, { size: 8.5, color: MUTED });
  pg.text(L, pg.height - 36, "Generated by the employer's payroll system.", { size: 7.5, color: MUTED });
  return doc.toBuffer({ userPassword: opts.password });
}

export interface Form12BBData {
  employee: { name: string; address?: string | null; pan?: string | null; designation?: string | null };
  /** "2026-27". */
  fy: string;
  hra: { rent: number; landlordName?: string | null; landlordAddress?: string | null; landlordPan?: string | null } | null;
  lta: number;
  homeLoanInterest: number;
  /** Section 80C, 80CCC and 80CCD claims, one line each. */
  eightyC: Array<{ section: string; label: string; amount: number }>;
  /** Every other Chapter VI-A claim. */
  otherSections: Array<{ section: string; label: string; amount: number }>;
  place?: string | null;
  date: string;
}

/**
 * Form No. 12BB (rule 26C): the employee's statement of the claims the
 * employer may allow when deducting tax — rent, travel, home-loan interest
 * and Chapter VI-A. Built from the year's investment declaration.
 */
export function renderForm12BB(d: Form12BBData, opts: { password?: string } = {}): Buffer {
  const doc = new PdfDoc({ title: `Form 12BB ${d.fy} — ${d.employee.name}`, author: d.employee.name });
  let pg = doc.page();
  const L = 40, R = pg.width - 40, W = R - L;
  const C1 = L + 34, C3 = L + W * 0.62, C4 = L + W * 0.66;
  pg.rect(0, 0, pg.width, 6, { fill: BRAND });
  pg.text(pg.width / 2, 40, "FORM NO. 12BB", { size: 14, bold: true, align: "center" });
  pg.text(pg.width / 2, 55, "(See rule 26C)", { size: 9, align: "center", color: MUTED });
  pg.text(pg.width / 2, 70, "Statement showing particulars of claims by an employee for deduction of tax", { size: 9.5, align: "center" });
  let y = 94;
  const kv: Array<[string, string]> = [
    ["1. Name and address of the employee", [d.employee.name, d.employee.address].filter(Boolean).join(", ")],
    ["2. Permanent Account Number of the employee", d.employee.pan ?? "Not on record"],
    ["3. Financial year", d.fy],
  ];
  for (const [k, v] of kv) {
    pg.text(L, y, k, { size: 9 });
    y = Math.max(y + 14, pg.paragraph(L + W * 0.5, y, v || "—", W * 0.5, { size: 9 }));
    y += 2;
  }
  y += 8;
  pg.rect(L, y, W, 20, { fill: SHADE });
  pg.text(L + 6, y + 13.5, "Sl.", { size: 8.5, bold: true });
  pg.text(C1, y + 13.5, "Nature of claim", { size: 8.5, bold: true });
  pg.text(C3, y + 13.5, "Amount (Rs.)", { size: 8.5, bold: true, align: "right" });
  pg.text(C4, y + 13.5, "Evidence / particulars", { size: 8.5, bold: true });
  y += 20;

  const ensure = (need: number) => {
    if (y + need < pg.height - 70) return;
    pg = doc.page();
    y = 50;
  };
  const row = (sl: string, label: string, amount: number | null, particulars: string, o: { bold?: boolean; indent?: number } = {}) => {
    ensure(30);
    y += 15;
    if (sl) pg.text(L + 6, y, sl, { size: 9, bold: o.bold });
    const after = pg.paragraph(C1 + (o.indent ?? 0) * 12, y, label, C3 - C1 - 70 - (o.indent ?? 0) * 12, { size: 9, bold: o.bold });
    if (amount !== null) pg.text(C3, y, inr(amount), { size: 9, bold: o.bold, align: "right" });
    const pAfter = particulars ? pg.paragraph(C4, y, particulars, R - C4, { size: 8.5, color: MUTED }) : y;
    y = Math.max(after, pAfter) - 11;
    pg.line(L, y + 6, R, y + 6, { color: [0.92, 0.93, 0.95] });
  };

  const h = d.hra;
  row("(1)", "House Rent Allowance", null, "", { bold: true });
  row("", "(i) Rent paid to the landlord", h?.rent ?? 0, h && h.rent > 0 ? "Rent receipts" : "", { indent: 1 });
  row("", "(ii) Name of the landlord", null, h?.landlordName ?? "—", { indent: 1 });
  row("", "(iii) Address of the landlord", null, h?.landlordAddress ?? "—", { indent: 1 });
  row("", "(iv) PAN of the landlord (where aggregate rent exceeds Rs. 1,00,000)", null, h?.landlordPan ?? (h && h.rent > 100000 ? "Required — not provided" : "Not required"), { indent: 1 });
  row("(2)", "Leave travel concessions or assistance", d.lta, d.lta > 0 ? "Travel tickets and bills" : "", { bold: true });
  row("(3)", "Deduction of interest on borrowing", null, "", { bold: true });
  row("", "(i) Interest payable / paid to the lender", d.homeLoanInterest, d.homeLoanInterest > 0 ? "Lender's interest certificate" : "", { indent: 1 });
  row("(4)", "Deduction under Chapter VI-A", null, "", { bold: true });
  row("", "(A) Sections 80C, 80CCC and 80CCD", null, "", { indent: 1 });
  if (d.eightyC.length === 0) row("", "No claims", 0, "", { indent: 2 });
  for (const c of d.eightyC) row("", `${c.section} — ${c.label}`, c.amount, "Proof of investment / payment", { indent: 2 });
  row("", "(B) Other sections (e.g. 80D, 80E, 80G, 80TTA) under Chapter VI-A", null, "", { indent: 1 });
  if (d.otherSections.length === 0) row("", "No claims", 0, "", { indent: 2 });
  for (const c of d.otherSections) row("", `${c.section} — ${c.label}`, c.amount, "Supporting documents", { indent: 2 });

  ensure(150);
  y += 34;
  pg.text(pg.width / 2, y, "Verification", { size: 10, bold: true, align: "center" });
  y += 18;
  y = pg.paragraph(L, y, `I, ${d.employee.name}, do hereby certify that the information given above is complete and correct.`, W, { size: 9 });
  y += 18;
  pg.text(L, y, `Place: ${d.place ?? ""}`, { size: 9 });
  pg.text(R, y, "(Signature of the employee)", { size: 9, align: "right", color: MUTED });
  y += 15;
  pg.text(L, y, `Date: ${d.date}`, { size: 9 });
  pg.text(R, y, `Designation: ${d.employee.designation ?? "—"}`, { size: 9, align: "right" });
  y += 15;
  pg.text(R, y, `Full name: ${d.employee.name}`, { size: 9, align: "right" });
  pg.text(L, pg.height - 36, "Prepared from the investment declaration on record. Attach the evidence listed against each claim.", { size: 7.5, color: MUTED });
  return doc.toBuffer({ userPassword: opts.password });
}
