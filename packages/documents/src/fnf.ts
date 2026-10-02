import { PdfDoc, type PdfPage, type RGB } from "./pdf";
import { rupeesInWords } from "./payslip";

/** Everything a full-and-final settlement statement shows. Amounts in rupees. */
export interface FnfStatementData {
  company: { name: string; address?: string | null };
  /** e.g. "FINALISED", "DRAFT — FOR REVIEW", "VOIDED". */
  status: string;
  settlementPeriod: string;
  generatedOn: string;
  employee: {
    name: string; number: string; designation?: string | null; department?: string | null;
    joined?: string | null; lastWorkingDay: string; exitType: string; pan?: string | null; service?: string | null;
  };
  payable: Array<{ group: string; label: string; amount: number; basis?: string }>;
  recovered: Array<{ group: string; label: string; amount: number; basis?: string }>;
  totalPayable: number;
  totalRecovery: number;
  net: number;
  adjustments?: Array<{ label: string; amount: number; direction: "PAY" | "RECOVER"; status: string }>;
  notes?: string[];
  voided?: { on: string; reason: string } | null;
}

const inr = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BRAND: RGB = [0.11, 0.32, 0.72];
const MUTED: RGB = [0.42, 0.45, 0.52];
const SHADE: RGB = [0.95, 0.96, 0.98];
const DANGER: RGB = [0.75, 0.15, 0.15];

/** The full-and-final settlement statement: one or more A4 pages. */
export function renderFnfStatement(d: FnfStatementData): Buffer {
  const doc = new PdfDoc({ title: `Full and final settlement — ${d.employee.name}`, author: d.company.name });
  let pg = doc.page();
  const L = 40, R = pg.width - 40, W = R - L, BOTTOM = pg.height - 70;
  const head = (p: PdfPage) => {
    p.rect(0, 0, p.width, 6, { fill: BRAND });
    p.text(L, 46, d.company.name, { size: 16, bold: true });
    if (d.company.address) p.text(L, 62, d.company.address, { size: 8.5, color: MUTED });
    p.text(R, 46, "Full and final settlement", { size: 12, bold: true, align: "right", color: BRAND });
    p.text(R, 62, d.settlementPeriod, { size: 9.5, align: "right", color: MUTED });
    p.line(L, 76, R, 76, { color: [0.85, 0.87, 0.9] });
  };
  head(pg);
  let y = 96;
  const ensure = (h: number) => { if (y + h > BOTTOM) { pg = doc.page(); head(pg); y = 96; } };

  pg.rect(L, y - 11, W, 18, { fill: d.voided ? [1, 0.93, 0.93] : SHADE });
  pg.text(L + 8, y + 1, `Status: ${d.status}`, { size: 9, bold: true, color: d.voided ? DANGER : undefined });
  pg.text(R - 8, y + 1, `Generated ${d.generatedOn}`, { size: 8.5, color: MUTED, align: "right" });
  y += 24;
  if (d.voided) {
    y = pg.paragraph(L, y, `Voided on ${d.voided.on}: ${d.voided.reason}. This statement no longer stands; a fresh settlement replaces it.`, W, { size: 9, color: DANGER }) + 4;
  }

  const e = d.employee;
  const left: Array<[string, string | null | undefined]> = [["Employee", e.name], ["Employee no.", e.number], ["Designation", e.designation], ["Department", e.department], ["PAN", e.pan]];
  const right: Array<[string, string | null | undefined]> = [["Date of joining", e.joined], ["Last working day", e.lastWorkingDay], ["Exit type", e.exitType], ["Service", e.service], ["Settlement month", d.settlementPeriod]];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i]) { pg.text(L, y, left[i][0], { size: 8.5, color: MUTED }); pg.text(L + 90, y, left[i][1] || "—", { size: 9 }); }
    if (right[i]) { pg.text(L + W / 2, y, right[i][0], { size: 8.5, color: MUTED }); pg.text(L + W / 2 + 95, y, right[i][1] || "—", { size: 9 }); }
    y += 15;
  }
  y += 10;

  const table = (title: string, rows: FnfStatementData["payable"], total: number) => {
    ensure(60);
    pg.rect(L, y, W, 20, { fill: SHADE });
    pg.text(L + 8, y + 13.5, title, { size: 9, bold: true });
    pg.text(R - 8, y + 13.5, "Amount (Rs.)", { size: 9, bold: true, align: "right" });
    y += 32;
    if (rows.length === 0) { pg.text(L + 8, y, "None", { size: 9, color: MUTED }); y += 16; }
    for (const r of rows) {
      ensure(r.basis ? 30 : 18);
      pg.text(L + 8, y, `${r.label}`, { size: 9 });
      pg.text(L + 220, y, r.group, { size: 8, color: MUTED });
      pg.text(R - 8, y, inr(r.amount), { size: 9, align: "right" });
      y += 12;
      if (r.basis) y = pg.paragraph(L + 16, y, r.basis, W - 120, { size: 7.5, color: MUTED, leading: 10 }) + 2;
      y += 4;
    }
    pg.line(L, y - 4, R, y - 4);
    pg.text(L + 8, y + 8, `Total ${title.toLowerCase()}`, { size: 9, bold: true });
    pg.text(R - 8, y + 8, inr(total), { size: 9, bold: true, align: "right" });
    y += 26;
  };
  table("Payable", d.payable, d.totalPayable);
  table("Recovered", d.recovered, d.totalRecovery);

  ensure(60);
  pg.rect(L, y, W, 44, { fill: [0.93, 0.96, 1] });
  pg.text(L + 12, y + 18, d.net >= 0 ? "Net payable to the employee" : "Net recoverable from the employee", { size: 10, bold: true });
  pg.text(L + 12, y + 33, rupeesInWords(Math.abs(d.net)), { size: 8.5, color: MUTED });
  pg.text(R - 12, y + 27, `Rs. ${inr(Math.abs(d.net))}`, { size: 15, bold: true, align: "right", color: BRAND });
  y += 60;

  if (d.adjustments?.length) {
    ensure(40);
    pg.text(L, y, "Adjustments after settlement", { size: 9.5, bold: true });
    y += 16;
    for (const a of d.adjustments) {
      ensure(16);
      pg.text(L + 8, y, a.label, { size: 9 });
      pg.text(L + 300, y, a.status, { size: 8, color: MUTED });
      pg.text(R - 8, y, `${a.direction === "PAY" ? "" : "- "}${inr(a.amount)}`, { size: 9, align: "right" });
      y += 15;
    }
    y += 8;
  }
  if (d.notes?.length) {
    ensure(30);
    pg.text(L, y, "Notes", { size: 9, bold: true, color: MUTED });
    y += 13;
    for (const n of d.notes) { ensure(14); y = pg.paragraph(L + 8, y, `- ${n}`, W - 8, { size: 8, color: MUTED, leading: 11 }); }
  }

  ensure(70);
  y = Math.max(y + 30, BOTTOM - 40);
  pg.line(L, y, L + 170, y, { color: [0.5, 0.5, 0.5] });
  pg.line(R - 170, y, R, y, { color: [0.5, 0.5, 0.5] });
  pg.text(L, y + 12, "For the employer", { size: 8.5, color: MUTED });
  pg.text(R - 170, y + 12, "Received and accepted by the employee", { size: 8.5, color: MUTED });
  pg.text(L, pg.height - 36, "System-generated statement. Figures follow the settlement record on the date shown.", { size: 7.5, color: MUTED });
  return doc.toBuffer();
}
