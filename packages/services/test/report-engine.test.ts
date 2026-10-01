import { test } from "node:test";
import assert from "node:assert/strict";
import { runSpec, validateSpec, parseSpec, type FieldDef, type ReportSpec } from "../src/report-engine";

const FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "dept", label: "Department", type: "text" },
  { key: "joined", label: "Joined", type: "date", format: "date" },
  { key: "pay", label: "Pay", type: "number", format: "inr" },
  { key: "remote", label: "Remote", type: "bool" },
];
const ROWS = [
  { name: "Asha", dept: "Sales", joined: "2024-01-10", pay: 100, remote: true },
  { name: "Bala", dept: "Sales", joined: "2025-06-01", pay: 300, remote: false },
  { name: "Chitra", dept: "Eng", joined: "2023-03-15", pay: 500, remote: true },
  { name: "Dev", dept: null, joined: "2026-02-01", pay: null, remote: false },
];
const base: ReportSpec = { dataset: "x", columns: ["name", "pay"], filters: [], aggregates: [], groupBy: null, sort: null };

test("filters by text, number, date, bool and emptiness", () => {
  const names = (spec: Partial<ReportSpec>) => runSpec(ROWS, { ...base, ...spec }, FIELDS).rows.map((r) => r.name);
  assert.deepEqual(names({ filters: [{ field: "dept", op: "eq", value: "sales" }] }), ["Asha", "Bala"]);
  assert.deepEqual(names({ filters: [{ field: "pay", op: "gte", value: "300" }] }), ["Bala", "Chitra"]);
  assert.deepEqual(names({ filters: [{ field: "joined", op: "lt", value: "2024-06-01" }] }), ["Asha", "Chitra"]);
  assert.deepEqual(names({ filters: [{ field: "remote", op: "eq", value: "yes" }] }), ["Asha", "Chitra"]);
  assert.deepEqual(names({ filters: [{ field: "dept", op: "empty" }] }), ["Dev"]);
  assert.deepEqual(names({ filters: [{ field: "dept", op: "in", value: "Eng, Ops" }] }), ["Chitra"]);
  assert.deepEqual(names({ filters: [{ field: "name", op: "contains", value: "HA" }] }), ["Asha"]);
});

test("groups with counts, sums and averages, and sorts by a value", () => {
  const r = runSpec(ROWS, { ...base, groupBy: "dept", aggregates: [{ field: "pay", fn: "sum" }, { field: "pay", fn: "avg" }, { field: "name", fn: "count" }], sort: { field: "sum_pay", dir: "desc" } }, FIELDS);
  assert.deepEqual(r.columns.map((c) => c.key), ["dept", "sum_pay", "avg_pay", "count_name"]);
  assert.deepEqual(r.rows, [
    { dept: "Eng", sum_pay: 500, avg_pay: 500, count_name: 1 },
    { dept: "Sales", sum_pay: 400, avg_pay: 200, count_name: 2 },
    { dept: "(none)", sum_pay: 0, avg_pay: null, count_name: 1 },
  ]);
});

test("grouping without values counts rows; totals cover listed columns", () => {
  const g = runSpec(ROWS, { ...base, groupBy: "remote" }, FIELDS);
  assert.deepEqual(g.rows, [{ remote: "Yes", count_remote: 2 }, { remote: "No", count_remote: 2 }]);
  const t = runSpec(ROWS, { ...base, aggregates: [{ field: "pay", fn: "sum" }], sort: { field: "pay", dir: "asc" } }, FIELDS);
  assert.deepEqual(t.totals, { pay: 900 });
  const m = runSpec(ROWS, { ...base, groupBy: "dept", aggregates: [{ field: "joined", fn: "min" }, { field: "pay", fn: "max" }] }, FIELDS);
  assert.deepEqual(m.rows[0], { dept: "Sales", min_joined: "2024-01-10", max_pay: 300 });
  assert.deepEqual(t.rows.map((r) => r.name), ["Asha", "Bala", "Chitra", "Dev"]);
});

test("validation refuses unknown fields and sums of text", () => {
  assert.deepEqual(validateSpec(base, FIELDS), []);
  assert.ok(validateSpec({ ...base, columns: ["salary"] }, FIELDS).some((e) => e.includes("Unknown column")));
  assert.ok(validateSpec({ ...base, aggregates: [{ field: "name", fn: "sum" }] }, FIELDS).some((e) => e.includes("needs a number")));
  assert.ok(validateSpec({ ...base, filters: [{ field: "pay", op: "gt", value: "lots" }] }, FIELDS).some((e) => e.includes("needs a number")));
  assert.ok(validateSpec({ ...base, columns: [] }, FIELDS).length > 0);
});

test("parseSpec drops malformed input", () => {
  const s = parseSpec({ dataset: "x", columns: ["a", 3, null], filters: "nope", sort: { field: "a", dir: "sideways" }, from: 5 });
  assert.deepEqual(s, { dataset: "x", columns: ["a"], filters: [], groupBy: null, aggregates: [], sort: { field: "a", dir: "asc" }, from: null, to: null });
});
