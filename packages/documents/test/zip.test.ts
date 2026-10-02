import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { crc32, zipFiles } from "../src/zip";

/** Read a ZIP back through its central directory. */
function unzip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(off + 26);
    const body = buf.subarray(off + 30 + localNameLen, off + 30 + localNameLen + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `${name} CRC`);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

describe("ZIP writer", () => {
  test("CRC-32 matches the standard check value", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });
  test("files round-trip, compressed or stored", () => {
    const big = Buffer.from("%PDF-1.4 ".repeat(500));
    const tiny = Buffer.from([1, 2, 3]);
    const files = unzip(zipFiles([{ name: "Payslip-E001.pdf", data: big }, { name: "tiny.bin", data: tiny }]));
    assert.deepEqual(files.map((f) => f.name), ["Payslip-E001.pdf", "tiny.bin"]);
    assert.ok(files[0].data.equals(big));
    assert.ok(files[1].data.equals(tiny));
  });
  test("duplicate names are kept apart", () => {
    const files = unzip(zipFiles([{ name: "a.pdf", data: Buffer.from("1") }, { name: "a.pdf", data: Buffer.from("2") }]));
    assert.deepEqual(files.map((f) => f.name), ["a.pdf", "a-2.pdf"]);
  });
  test("an empty archive is valid", () => {
    assert.deepEqual(unzip(zipFiles([])), []);
  });
});
