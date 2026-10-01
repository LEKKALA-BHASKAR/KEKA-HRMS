import { PdfDoc, type RGB } from "./pdf";

const MUTED: RGB = [0.42, 0.45, 0.52];

/** A one-page business letter: letterhead, addressee, subject, paragraphs, signature. */
export function renderLetter(d: {
  company: { name: string; address?: string | null };
  date: string; to: string[]; subject: string; paragraphs: string[];
  table?: Array<[string, string]>;
  signatory: { name: string; title: string };
  footer?: string;
}): Buffer {
  const doc = new PdfDoc({ title: d.subject, author: d.company.name });
  const pg = doc.page();
  const L = 56, W = pg.width - 112;
  pg.rect(0, 0, pg.width, 6, { fill: [0.11, 0.32, 0.72] });
  pg.text(L, 52, d.company.name, { size: 15, bold: true });
  if (d.company.address) pg.text(L, 68, d.company.address, { size: 8.5, color: MUTED });
  pg.text(pg.width - L, 52, d.date, { size: 9.5, align: "right", color: MUTED });
  let y = 108;
  for (const line of d.to) { pg.text(L, y, line, { size: 10 }); y += 14; }
  y += 14;
  pg.text(L, y, d.subject, { size: 11, bold: true });
  y += 24;
  for (const p of d.paragraphs) { y = pg.paragraph(L, y, p, W, { size: 10, leading: 14.5 }) + 8; }
  if (d.table?.length) {
    y += 4;
    for (const [k, v] of d.table) {
      pg.rect(L, y - 11, W, 18, { fill: [0.96, 0.97, 0.99] });
      pg.text(L + 8, y + 1, k, { size: 9.5, color: MUTED });
      pg.text(L + W - 8, y + 1, v, { size: 9.5, bold: true, align: "right" });
      y += 20;
    }
    y += 10;
  }
  y += 18;
  pg.text(L, y, "Yours sincerely,", { size: 10 });
  pg.text(L, y + 40, d.signatory.name, { size: 10, bold: true });
  pg.text(L, y + 54, d.signatory.title, { size: 9, color: MUTED });
  if (d.footer) pg.paragraph(L, pg.height - 60, d.footer, W, { size: 7.5, color: MUTED });
  return doc.toBuffer();
}
