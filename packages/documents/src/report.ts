import { PdfDoc, PdfPage, A4, textWidth, type RGB } from "./pdf";

const MUTED: RGB = [0.42, 0.45, 0.52];
const RULE: RGB = [0.85, 0.87, 0.9];
const BAND: RGB = [0.95, 0.96, 0.98];
const WARN: RGB = [0.6, 0.35, 0.0];

export type ReportCell = string | number;
export interface ReportSection {
  heading: string;
  meta?: Array<[string, string]>;
  columns: Array<{ label: string; numeric?: boolean }>;
  rows: ReportCell[][];
  totals?: ReportCell[];
}

const fmt = (v: ReportCell) => typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : v;

/**
 * A multi-page landscape table report: a title block, a banner line, then
 * each section's key facts and table, breaking pages and repeating the
 * column header as needed. Used for statutory returns that are copied into
 * a government portal, so legibility beats decoration.
 */
export function renderTableReport(d: {
  title: string; subtitle: string; company: string; banner?: string;
  sections: ReportSection[]; notes?: string[]; issues?: string[];
}): Buffer {
  const doc = new PdfDoc({ title: d.title, author: d.company });
  const W = A4.height, H = A4.width; // landscape
  const L = 32, R = W - 32, BOTTOM = H - 36;
  let pg!: PdfPage;
  let y = 0;
  let pageNo = 0;
  const newPage = () => {
    pg = new PdfPage(W, H);
    doc.pages.push(pg);
    pageNo++;
    pg.text(L, 26, d.company, { size: 8, color: MUTED });
    pg.text(R, 26, `${d.title} · page ${pageNo}`, { size: 8, color: MUTED, align: "right" });
    y = 44;
  };
  newPage();
  pg.text(L, y + 6, d.title, { size: 15, bold: true });
  pg.text(L, y + 22, d.subtitle, { size: 9.5, color: MUTED });
  y += 36;
  if (d.banner) {
    pg.rect(L, y, R - L, 18, { fill: [1, 0.97, 0.88] });
    pg.text(L + 8, y + 12, d.banner, { size: 8.5, color: WARN });
    y += 28;
  }

  for (const s of d.sections) {
    const size = s.columns.length > 10 ? 6.8 : 7.5;
    const rowH = size + 6;
    // Column widths in proportion to the widest text in each, within the page.
    const all = [s.columns.map((c) => c.label), ...s.rows.map((r) => r.map(fmt)), ...(s.totals ? [s.totals.map(fmt)] : [])];
    const natural = s.columns.map((_, i) => Math.max(28, ...all.map((r) => textWidth(String(r[i] ?? ""), size, true) + 8)));
    const scale = Math.min(1.6, (R - L) / natural.reduce((a, b) => a + b, 0));
    const widths = natural.map((w) => w * scale);
    const xs = widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? L) + w], [L]);
    const clip = (t: string, w: number, bold = false) => {
      if (textWidth(t, size, bold) <= w - 6) return t;
      let s2 = t;
      while (s2.length > 1 && textWidth(`${s2}…`, size, bold) > w - 6) s2 = s2.slice(0, -1);
      return `${s2}…`;
    };
    const header = () => {
      pg.rect(L, y, R - L, rowH + 2, { fill: BAND });
      s.columns.forEach((c, i) => {
        const t = clip(c.label, widths[i], true);
        pg.text(c.numeric ? xs[i + 1] - 4 : xs[i] + 4, y + rowH - 2, t, { size, bold: true, align: c.numeric ? "right" : "left" });
      });
      y += rowH + 4;
    };
    const metaH = (s.meta?.length ? 14 : 0) + 18;
    if (y + metaH + rowH * 3 > BOTTOM) newPage();
    pg.text(L, y + 10, s.heading, { size: 10.5, bold: true });
    y += 18;
    if (s.meta?.length) {
      let x = L;
      for (const [k, v] of s.meta) {
        const w1 = pg.text(x, y + 6, `${k}: `, { size: 8, color: MUTED });
        const w2 = pg.text(x + w1, y + 6, v, { size: 8, bold: true });
        x += w1 + w2 + 18;
      }
      y += 14;
    }
    header();
    const line = (r: ReportCell[], bold: boolean) => {
      if (y + rowH > BOTTOM) { newPage(); header(); }
      r.forEach((v, i) => {
        const c = s.columns[i];
        if (!c) return;
        const t = clip(String(fmt(v)), widths[i], bold);
        pg.text(c.numeric ? xs[i + 1] - 4 : xs[i] + 4, y + rowH - 4, t, { size, bold, align: c.numeric ? "right" : "left" });
      });
      y += rowH;
      pg.line(L, y - 1, R, y - 1, { color: RULE });
    };
    for (const r of s.rows) line(r, false);
    if (s.totals) line(s.totals, true);
    y += 14;
  }

  const tail = [...(d.issues ?? []).map((t) => ({ t: `Issue: ${t}`, c: WARN })), ...(d.notes ?? []).map((t) => ({ t, c: MUTED }))];
  for (const { t, c } of tail) {
    if (y + 12 > BOTTOM) newPage();
    y = pg.paragraph(L, y + 4, t, R - L, { size: 8, color: c });
  }
  return doc.toBuffer();
}
