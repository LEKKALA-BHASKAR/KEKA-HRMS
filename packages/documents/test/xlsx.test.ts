import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { renderXlsx, xlsxColumn } from "../src/xlsx";

function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const body = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(body) : Buffer.from(body)).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("Excel workbook writer", () => {
  test("column letters", () => {
    assert.equal(xlsxColumn(0), "A");
    assert.equal(xlsxColumn(25), "Z");
    assert.equal(xlsxColumn(26), "AA");
    assert.equal(xlsxColumn(701), "ZZ");
  });

  test("a workbook holds the parts Excel needs, numbers stay numeric and text is escaped", () => {
    const buf = renderXlsx([
      { name: "Head/count: 2026", columns: ["Name", "CTC"], rows: [["A & B <x>", 1200000.5], ["=SUM(A1)", null]] },
      { name: "Head/count: 2026", columns: ["X"], rows: [] },
    ]);
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    const files = unzip(buf);
    for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) assert.ok(files.has(f), f);
    const wb = files.get("xl/workbook.xml")!;
    assert.match(wb, /name="Head count  2026"/);
    assert.match(wb, /name="Head count  2026 \(2\)"/);
    const s1 = files.get("xl/worksheets/sheet1.xml")!;
    assert.match(s1, /<c r="B2"><v>1200000.5<\/v><\/c>/);
    assert.match(s1, /A &amp; B &lt;x&gt;/);
    assert.match(s1, /<c r="A3" t="inlineStr"><is><t xml:space="preserve">=SUM\(A1\)<\/t>/);
    assert.ok(!s1.includes('r="B3"'));
    assert.match(s1, /state="frozen"/);
  });

  test("an empty workbook is refused", () => {
    assert.throws(() => renderXlsx([]));
  });
});
