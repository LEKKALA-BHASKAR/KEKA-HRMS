import { PdfDoc, PdfPage, type RGB } from "./pdf";

const BRAND: RGB = [0.11, 0.32, 0.72];
const MUTED: RGB = [0.42, 0.45, 0.52];

/** A one-page landscape certificate of completion. */
export function renderCertificate(d: {
  company: string;
  learner: string;
  course: string;
  number: string;
  issuedOn: string;
  expiresOn?: string | null;
  score?: number | null;
  credits?: number | null;
  signatory?: string | null;
}): Buffer {
  const doc = new PdfDoc({ title: `Certificate ${d.number}`, author: d.company, subject: d.course });
  // A4 landscape.
  const pg = new PdfPage(841.89, 595.28);
  doc.pages.push(pg);
  const W = pg.width, H = pg.height, cx = W / 2;
  pg.rect(18, 18, W - 36, H - 36, { stroke: BRAND, width: 2 });
  pg.rect(26, 26, W - 52, H - 52, { stroke: [0.75, 0.8, 0.9], width: 0.6 });
  pg.text(cx, 92, d.company, { size: 14, bold: true, align: "center", color: BRAND });
  pg.text(cx, 150, "Certificate of Completion", { size: 30, bold: true, align: "center" });
  pg.text(cx, 196, "This certifies that", { size: 12, align: "center", color: MUTED });
  pg.text(cx, 240, d.learner, { size: 26, bold: true, align: "center" });
  pg.line(cx - 200, 252, cx + 200, 252, { width: 0.6, color: MUTED });
  pg.text(cx, 290, "has successfully completed the course", { size: 12, align: "center", color: MUTED });
  pg.text(cx, 326, d.course, { size: 18, bold: true, align: "center", color: BRAND });
  const facts = [
    `Issued ${d.issuedOn}`,
    d.expiresOn ? `Valid until ${d.expiresOn}` : "Does not expire",
    d.score !== null && d.score !== undefined ? `Score ${d.score}%` : null,
    d.credits ? `${d.credits} learning credit${d.credits === 1 ? "" : "s"}` : null,
  ].filter((x): x is string => !!x);
  pg.text(cx, 370, facts.join("   ·   "), { size: 10.5, align: "center", color: MUTED });
  pg.line(90, 470, 290, 470, { width: 0.6, color: MUTED });
  pg.text(190, 486, d.signatory ?? "Learning & Development", { size: 10, align: "center" });
  pg.text(W - 190, 470, d.number, { size: 11, bold: true, align: "center" });
  pg.text(W - 190, 486, "Certificate number", { size: 9, align: "center", color: MUTED });
  return doc.toBuffer();
}
