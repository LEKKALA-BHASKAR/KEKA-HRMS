import { PdfDoc, type PdfPage, type RGB } from "./pdf";

const MUTED: RGB = [0.42, 0.45, 0.52];
const ACCENT: RGB = [0.11, 0.32, 0.72];

export type OfferLetterBlock = { kind: "p"; text: string; bold?: boolean } | { kind: "table"; rows: Array<{ name: string; monthly: number; annual: number }> };

const rs = (v: number) => `Rs. ${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * An offer letter of any length: letterhead on the first page, the template's
 * paragraphs and salary table flowing onto further pages, and — once the
 * candidate has signed — the signing record at the end.
 */
export function renderOfferLetter(d: {
  company: { name: string; address?: string | null };
  date: string; to: string[]; subject: string; blocks: OfferLetterBlock[];
  footer?: string;
  signed?: { name: string; at: string; ip?: string | null; fingerprint: string };
}): Buffer {
  const doc = new PdfDoc({ title: d.subject, author: d.company.name });
  const L = 56;
  let pg: PdfPage = doc.page();
  const W = pg.width - 112, BOTTOM = pg.height - 80;
  let y = 0;
  const furniture = (p: PdfPage) => {
    p.rect(0, 0, p.width, 6, { fill: ACCENT });
    if (d.footer) p.paragraph(L, p.height - 54, d.footer, W, { size: 7.5, color: MUTED });
    p.text(p.width - L, p.height - 30, `Page ${doc.pages.length}`, { size: 7.5, color: MUTED, align: "right" });
  };
  const ensure = (h: number) => {
    if (y + h <= BOTTOM) return;
    pg = doc.page();
    furniture(pg);
    y = 48;
  };
  furniture(pg);
  pg.text(L, 52, d.company.name, { size: 15, bold: true });
  if (d.company.address) pg.text(L, 68, d.company.address, { size: 8.5, color: MUTED });
  pg.text(pg.width - L, 52, d.date, { size: 9.5, align: "right", color: MUTED });
  y = 108;
  for (const line of d.to) { pg.text(L, y, line, { size: 10 }); y += 14; }
  y += 14;
  pg.paragraph(L, y, d.subject, W, { size: 11, bold: true });
  y += 24;

  for (const b of d.blocks) {
    if (b.kind === "p") {
      // Estimate the lines so a paragraph is not split across a page break.
      const lines = Math.max(1, Math.ceil((b.text.length * 5) / W));
      ensure(Math.min(lines, 20) * 14.5 + 6);
      y = pg.paragraph(L, y, b.text, W, { size: 10, leading: 14.5, bold: b.bold }) + 6;
    } else {
      ensure(20 * Math.min(b.rows.length + 2, 8));
      const head = () => {
        pg.rect(L, y - 11, W, 18, { fill: [0.93, 0.95, 0.98] });
        pg.text(L + 8, y + 1, "Component", { size: 9, bold: true });
        pg.text(L + W - 128, y + 1, "Monthly", { size: 9, bold: true, align: "right" });
        pg.text(L + W - 8, y + 1, "Annual", { size: 9, bold: true, align: "right" });
        y += 20;
      };
      head();
      const total = { m: 0, a: 0 };
      for (const r of b.rows) {
        if (y + 20 > BOTTOM) { ensure(BOTTOM); head(); }
        pg.text(L + 8, y + 1, r.name, { size: 9.5 });
        pg.text(L + W - 128, y + 1, rs(r.monthly), { size: 9.5, align: "right" });
        pg.text(L + W - 8, y + 1, rs(r.annual), { size: 9.5, align: "right" });
        pg.line(L, y + 7, L + W, y + 7, { color: [0.9, 0.9, 0.92] });
        total.m += r.monthly; total.a += r.annual;
        y += 18;
      }
      pg.text(L + 8, y + 3, "Total", { size: 9.5, bold: true });
      pg.text(L + W - 128, y + 3, rs(total.m), { size: 9.5, bold: true, align: "right" });
      pg.text(L + W - 8, y + 3, rs(total.a), { size: 9.5, bold: true, align: "right" });
      y += 26;
    }
  }

  if (d.signed) {
    ensure(110);
    y += 12;
    pg.line(L, y, L + W, y, { color: [0.75, 0.75, 0.78] });
    y += 20;
    pg.text(L, y, "Accepted and signed electronically", { size: 10, bold: true, color: ACCENT });
    y += 18;
    pg.text(L, y, d.signed.name, { size: 13, bold: true });
    y += 18;
    y = pg.paragraph(L, y, `Signed on ${d.signed.at}${d.signed.ip ? ` from ${d.signed.ip}` : ""}. The drawn signature is kept with the offer record.`, W, { size: 8.5, color: MUTED });
    pg.paragraph(L, y, `Document fingerprint (SHA-256): ${d.signed.fingerprint}`, W, { size: 7.5, color: MUTED });
  }
  return doc.toBuffer();
}
