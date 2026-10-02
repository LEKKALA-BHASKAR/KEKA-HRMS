import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, mapRows, normaliseDate, normaliseYesNo, normaliseAmount, headerKey } from "../src/import-math";

describe("CSV parsing", () => {
  test("quoted fields keep commas, doubled quotes and line breaks", () => {
    const rows = parseCsv('name,note\r\n"Iyer, Ramesh","said ""hi""\nthen left"\r\n');
    assert.deepEqual(rows, [["name", "note"], ["Iyer, Ramesh", 'said "hi"\nthen left']]);
  });
  test("a byte-order mark and blank trailing lines are dropped", () => {
    assert.deepEqual(parseCsv("﻿a,b\n1,2\n\n,\n"), [["a", "b"], ["1", "2"]]);
  });
  test("a last line without a newline is still a row", () => {
    assert.deepEqual(parseCsv("a\n1"), [["a"], ["1"]]);
  });
});

describe("Header mapping", () => {
  const columns = [
    { key: "first_name", label: "First name", required: true, example: "Asha" },
    { key: "date_of_joining", label: "Date of joining", required: true, example: "2026-10-01" },
    { key: "mobile", label: "Mobile", example: "" },
  ];
  test("headers match by key or label, ignoring case and punctuation", () => {
    assert.equal(headerKey("Date of Joining"), headerKey("date_of_joining"));
    const m = mapRows([["First Name", "DATE-OF-JOINING", "Shoe size"], ["Asha", "01/10/2026", "7"]], columns);
    assert.deepEqual(m.rows, [{ line: 2, values: { first_name: "Asha", date_of_joining: "01/10/2026" } }]);
    assert.deepEqual(m.unknown, ["Shoe size"]);
    assert.deepEqual(m.missing, []);
  });
  test("missing required columns are reported by label", () => {
    assert.deepEqual(mapRows([["mobile"]], columns).missing, ["First name", "Date of joining"]);
  });
});

describe("Value normalising", () => {
  test("dates in ISO and day-first forms; impossible dates rejected", () => {
    assert.equal(normaliseDate("2026-10-01"), "2026-10-01");
    assert.equal(normaliseDate("1/10/2026"), "2026-10-01");
    assert.equal(normaliseDate("01-10-2026"), "2026-10-01");
    assert.equal(normaliseDate("01.10.2026"), "2026-10-01");
    assert.equal(normaliseDate("31/02/2026"), null);
    assert.equal(normaliseDate("Oct 1"), null);
  });
  test("yes/no reads common spellings and refuses typos", () => {
    assert.equal(normaliseYesNo("Yes", false), true);
    assert.equal(normaliseYesNo("n", true), false);
    assert.equal(normaliseYesNo("", true), true);
    assert.equal(normaliseYesNo("yse", false), null);
  });
  test("amounts drop Indian grouping and the rupee sign", () => {
    assert.equal(normaliseAmount("12,00,000"), "1200000");
    assert.equal(normaliseAmount("₹ 9,50,000.50"), "950000.5");
    assert.equal(normaliseAmount("twelve"), null);
    assert.equal(normaliseAmount(""), null);
  });
});
