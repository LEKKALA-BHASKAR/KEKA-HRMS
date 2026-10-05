/**
 * A small QR code encoder (ISO/IEC 18004): byte mode, error-correction
 * level M, versions 1 to 10 — up to 213 bytes, plenty for an ID card's
 * verification link. No external service and no dependency: the card's QR
 * is drawn as SVG (for the page) or as rectangles (for the PDF).
 */

const ECC_M: Array<{ total: number; ecc: number; blocks: number }> = [
  { total: 0, ecc: 0, blocks: 0 },
  { total: 26, ecc: 10, blocks: 1 }, { total: 44, ecc: 16, blocks: 1 }, { total: 70, ecc: 26, blocks: 1 },
  { total: 100, ecc: 18, blocks: 2 }, { total: 134, ecc: 24, blocks: 2 }, { total: 172, ecc: 16, blocks: 4 },
  { total: 196, ecc: 18, blocks: 4 }, { total: 242, ecc: 22, blocks: 4 }, { total: 292, ecc: 22, blocks: 5 },
  { total: 346, ecc: 26, blocks: 5 },
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i]! ^= gfMul(coef, factor); });
  }
  return result;
}

/** The data capacity of a version at level M, in bytes of payload. */
export function qrByteCapacity(version: number): number {
  const v = ECC_M[version]!;
  const dataCodewords = v.total - v.ecc * v.blocks;
  const headerBits = 4 + (version < 10 ? 8 : 16);
  return Math.floor((dataCodewords * 8 - headerBits) / 8);
}

function encodeCodewords(bytes: number[], version: number): number[] {
  const spec = ECC_M[version]!;
  const dataCapacity = spec.total - spec.ecc * spec.blocks;
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCapacity * 8;
  put(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCapacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction, interleave.
  const numShort = spec.blocks - (spec.total % spec.blocks);
  const shortLen = Math.floor(spec.total / spec.blocks);
  const divisor = rsDivisor(spec.ecc);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < spec.blocks; i++) {
    const dat = data.slice(k, k + shortLen - spec.ecc + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((blk, j) => { if (i !== shortLen - spec.ecc || j >= numShort) out.push(blk[i]!); });
  }
  return out;
}

class Matrix {
  readonly size: number;
  readonly mod: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.mod = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) { this.mod[y]![x] = dark; this.fn[y]![x] = true; }

  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
    const pos = ALIGN[this.version]!;
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.drawFormat(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0;
        const a = s - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, bit); this.set(b, a, bit);
      }
    }
  }

  drawFormat(mask: number) {
    const data = (0 << 3) | mask; // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }

  drawCodewords(data: number[]) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.fn[y]![x] && i < data.length * 8) {
            this.mod[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (this.fn[y]![x]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) this.mod[y]![x] = !this.mod[y]![x];
    }
  }

  penalty(): number {
    const s = this.size, m = this.mod;
    let p = 0;
    const runs = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < s; a++) {
        let run = 1;
        for (let b = 1; b <= s; b++) {
          if (b < s && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += 3 + (run - 5); run = 1; }
        }
      }
    };
    runs((y, x) => m[y]![x]!); runs((x, y) => m[y]![x]!);
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) p += 3;
    }
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    const matches = (get: (i: number) => boolean, start: number, pat: boolean[]) => pat.every((v, k) => get(start + k) === v);
    for (let a = 0; a < s; a++) for (let b = 0; b + 11 <= s; b++) {
      const row = (i: number) => m[a]![i]!, col = (i: number) => m[i]![a]!;
      if (matches(row, b, pat1) || matches(row, b, pat2)) p += 40;
      if (matches(col, b, pat1) || matches(col, b, pat2)) p += 40;
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    p += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
    return p;
  }
}

/**
 * Encode text as a QR code. Returns the module grid (true = dark), without
 * the quiet zone. `mask` forces a mask pattern; by default the one with the
 * lowest penalty is chosen, as the standard asks.
 */
export function encodeQr(text: string, opts: { minVersion?: number; mask?: number } = {}): { version: number; mask: number; size: number; modules: boolean[][] } {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = Math.max(1, opts.minVersion ?? 1);
  while (version <= 10 && qrByteCapacity(version) < bytes.length) version++;
  if (version > 10) throw new Error("Too much text for a QR code here (213 bytes at most).");
  const codewords = encodeCodewords(bytes, version);
  void REMAINDER_BITS; // remainder bits stay light: the placement loop leaves them unset
  const build = (mask: number) => {
    const q = new Matrix(version);
    q.drawFunctionPatterns();
    q.drawCodewords(codewords);
    q.applyMask(mask);
    q.drawFormat(mask);
    return q;
  };
  let best: Matrix | null = null, bestMask = 0, bestPenalty = Infinity;
  const masks = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const q = build(mask);
    const pen = opts.mask !== undefined ? 0 : q.penalty();
    if (pen < bestPenalty) { best = q; bestMask = mask; bestPenalty = pen; }
  }
  return { version, mask: bestMask, size: best!.size, modules: best!.mod };
}

/** An SVG drawing of a QR code, with the four-module quiet zone. */
export function qrSvg(text: string, opts: { moduleSize?: number; color?: string } = {}): string {
  const q = encodeQr(text);
  const m = opts.moduleSize ?? 4, quiet = 4, dim = (q.size + quiet * 2) * m;
  let path = "";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y]![x]) path += `M${(x + quiet) * m} ${(y + quiet) * m}h${m}v${m}h-${m}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="${opts.color ?? "#000"}"/></svg>`;
}
