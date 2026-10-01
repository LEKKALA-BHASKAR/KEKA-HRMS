import { createHash, randomBytes } from "node:crypto";

/**
 * A small, dependency-free PDF 1.4 writer: A4 pages, the two standard
 * Helvetica faces, text, lines and boxes — enough for payslips, Form 16 and
 * letters — plus the standard security handler (RC4, 128-bit, revision 3)
 * so a payslip can open only with the employee's password.
 *
 * Coordinates are in points from the TOP-left, which is how documents are
 * laid out; the writer flips them to PDF's bottom-left origin.
 */

export const A4 = { width: 595.28, height: 841.89 };
export type RGB = [number, number, number];

// Advance widths (1/1000 em) for ASCII 32–126 from the standard AFM files.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Text to WinAnsi bytes. The rupee sign has no WinAnsi glyph, so it becomes "Rs.". */
export function toWinAnsi(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s.replace(/₹\s?/g, "Rs. ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/•/g, "-")) {
    const c = ch.codePointAt(0)!;
    out.push(c >= 32 && c <= 255 ? c : 63);
  }
  return Buffer.from(out);
}

export function textWidth(s: string, size: number, bold = false): number {
  const w = bold ? HELV_BOLD : HELV;
  let total = 0;
  for (const b of toWinAnsi(s)) total += b >= 32 && b <= 126 ? w[b - 32] : 556;
  return (total * size) / 1000;
}

const esc = (b: Buffer) => b.toString("latin1").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: RGB) => c.map((x) => n(x)).join(" ");

export class PdfPage {
  readonly ops: string[] = [];
  constructor(readonly width = A4.width, readonly height = A4.height) {}

  text(x: number, y: number, s: string, o: { size?: number; bold?: boolean; align?: "left" | "right" | "center"; color?: RGB } = {}) {
    const size = o.size ?? 10;
    const w = textWidth(s, size, o.bold);
    const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    this.ops.push(`BT ${o.color ? `${rgb(o.color)} rg ` : ""}/${o.bold ? "F2" : "F1"} ${n(size)} Tf ${n(left)} ${n(this.height - y)} Td (${esc(toWinAnsi(s))}) Tj ET${o.color ? " 0 0 0 rg" : ""}`);
    return w;
  }

  /** Wrap a paragraph to a width; returns the y after the last line. */
  paragraph(x: number, y: number, s: string, width: number, o: { size?: number; bold?: boolean; leading?: number; color?: RGB } = {}) {
    const size = o.size ?? 10, leading = o.leading ?? size * 1.35;
    let line = "";
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, o.bold) > width && line) { this.text(x, y, line, o); y += leading; line = word; }
      else line = next;
    }
    if (line) { this.text(x, y, line, o); y += leading; }
    return y;
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: RGB } = {}) {
    this.ops.push(`q ${n(o.width ?? 0.5)} w ${rgb(o.color ?? [0.8, 0.8, 0.8])} RG ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S Q`);
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: RGB; stroke?: RGB; width?: number } = {}) {
    const paint = o.fill && o.stroke ? "B" : o.fill ? "f" : "S";
    this.ops.push(`q ${o.fill ? `${rgb(o.fill)} rg ` : ""}${o.stroke ? `${rgb(o.stroke)} RG ${n(o.width ?? 0.5)} w ` : ""}${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re ${paint} Q`);
  }
}

// --- Encryption ------------------------------------------------------------

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();

export function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const padPw = (pw: string) => Buffer.concat([toWinAnsi(pw).subarray(0, 32), PAD]).subarray(0, 32);

/** Allow printing and copying; not modifying or annotating. */
export const PERMISSIONS_P = -1324;

/** Standard security handler, revision 3, 128-bit. Algorithms 2, 3 and 5 of the spec. */
export function securityKeys(userPw: string, ownerPw: string, id0: Buffer, p = PERMISSIONS_P) {
  let h = md5(padPw(ownerPw));
  for (let i = 0; i < 50; i++) h = md5(h);
  let o = rc4(h, padPw(userPw));
  for (let i = 1; i <= 19; i++) o = rc4(Buffer.from(h.map((b) => b ^ i)), o);

  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(p);
  let key = md5(padPw(userPw), o, pBuf, id0);
  for (let i = 0; i < 50; i++) key = md5(key);

  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
  return { key, o, u: Buffer.concat([u, Buffer.alloc(16)]) };
}

/**
 * Would a reader accept this user password? Algorithm 6: derive the file key
 * from the candidate and the stored O, then compare the computed U.
 */
export function opensWith(pdf: Buffer, password: string): boolean {
  const s = pdf.toString("latin1");
  const id = /\/ID \[<([0-9a-f]+)>/.exec(s), o = /\/O <([0-9a-f]+)>/.exec(s), u = /\/U <([0-9a-f]+)>/.exec(s), pm = /\/P (-?\d+)/.exec(s);
  if (!id || !o || !u || !pm) return true; // not encrypted
  const id0 = Buffer.from(id[1], "hex"), O = Buffer.from(o[1], "hex");
  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(Number(pm[1]));
  let key = md5(padPw(password), O, pBuf, id0);
  for (let i = 0; i < 50; i++) key = md5(key);
  let x = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x);
  return x.toString("hex") === u[1].slice(0, 32);
}

export function objectKey(fileKey: Buffer, num: number, gen = 0): Buffer {
  const b = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  return md5(fileKey, b).subarray(0, Math.min(fileKey.length + 5, 16));
}

// --- Document ----------------------------------------------------------------

export class PdfDoc {
  readonly pages: PdfPage[] = [];
  constructor(readonly meta: { title: string; author?: string; subject?: string } = { title: "Document" }) {}

  page(): PdfPage {
    const p = new PdfPage();
    this.pages.push(p);
    return p;
  }

  toBuffer(opts: { userPassword?: string; ownerPassword?: string; created?: Date } = {}): Buffer {
    const id0 = randomBytes(16);
    const enc = opts.userPassword !== undefined
      ? securityKeys(opts.userPassword, opts.ownerPassword ?? randomBytes(16).toString("hex"), id0)
      : null;

    // Object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs, then info, then encrypt.
    const objects: Array<{ num: number; body: (key: Buffer | null) => Buffer }> = [];
    const pageNums = this.pages.map((_, i) => 5 + i * 2);
    const infoNum = 5 + this.pages.length * 2;
    const encNum = infoNum + 1;
    const str = (s: string, num: number) => (key: Buffer | null) => {
      const bytes = toWinAnsi(s);
      return key ? `<${rc4(objectKey(key, num), bytes).toString("hex")}>` : `(${esc(bytes)})`;
    };

    objects.push({ num: 1, body: () => Buffer.from("<< /Type /Catalog /Pages 2 0 R >>") });
    objects.push({ num: 2, body: () => Buffer.from(`<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(" ")}] /Count ${this.pages.length} >>`) });
    objects.push({ num: 3, body: () => Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>") });
    objects.push({ num: 4, body: () => Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>") });
    this.pages.forEach((p, i) => {
      const pageNum = pageNums[i], contentNum = pageNum + 1;
      objects.push({
        num: pageNum,
        body: () => Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.width)} ${n(p.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`),
      });
      objects.push({
        num: contentNum,
        body: (key) => {
          const raw = Buffer.from(p.ops.join("\n"), "latin1");
          const data = key ? rc4(objectKey(key, contentNum), raw) : raw;
          return Buffer.concat([Buffer.from(`<< /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
        },
      });
    });
    const d = opts.created ?? new Date();
    const pdfDate = `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
    objects.push({
      num: infoNum,
      body: (key) => Buffer.from(`<< /Title ${str(this.meta.title, infoNum)(key)} /Producer ${str("Keka HR", infoNum)(key)}${this.meta.author ? ` /Author ${str(this.meta.author, infoNum)(key)}` : ""} /CreationDate ${str(pdfDate, infoNum)(key)} >>`),
    });
    if (enc) {
      // The encryption dictionary itself is never encrypted.
      objects.push({ num: encNum, body: () => Buffer.from(`<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${PERMISSIONS_P} /O <${enc.o.toString("hex")}> /U <${enc.u.toString("hex")}> >>`) });
    }

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    for (const o of objects.sort((a, b) => a.num - b.num)) {
      offsets[o.num] = offset;
      const b = Buffer.concat([Buffer.from(`${o.num} 0 obj\n`), o.body(enc?.key ?? null), Buffer.from("\nendobj\n")]);
      chunks.push(b);
      offset += b.length;
    }
    const size = objects.length + 1;
    const xref = ["xref", `0 ${size}`, "0000000000 65535 f ", ...Array.from({ length: size - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, "0")} 00000 n `)].join("\n");
    const idHex = id0.toString("hex");
    const trailer = `\ntrailer\n<< /Size ${size} /Root 1 0 R /Info ${infoNum} 0 R /ID [<${idHex}> <${idHex}>]${enc ? ` /Encrypt ${encNum} 0 R` : ""} >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref + trailer));
    return Buffer.concat(chunks);
  }
}
