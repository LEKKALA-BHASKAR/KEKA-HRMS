import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFormula, extractReferences, validateFormula, topologicalOrder } from "../src/formula";

const ctx = (values: Record<string, number>) => ({ values });

test("arithmetic follows BODMAS", () => {
  assert.equal(evaluateFormula("2 + 3 * 4", ctx({})).toNumber(), 14);
  assert.equal(evaluateFormula("(2 + 3) * 4", ctx({})).toNumber(), 20);
  assert.equal(evaluateFormula("10 - 2 - 3", ctx({})).toNumber(), 5);
  assert.equal(evaluateFormula("100 / 4 / 5", ctx({})).toNumber(), 5);
  assert.equal(evaluateFormula("2 ^ 3 ^ 2", ctx({})).toNumber(), 512); // right-assoc
});

test("component references resolve in bracket notation", () => {
  assert.equal(evaluateFormula("[BASIC] * 0.12", ctx({ BASIC: 15000 })).toNumber(), 1800);
  assert.equal(evaluateFormula("[CTC_ANNUAL] / 2920", ctx({ CTC_ANNUAL: 1460000 })).toNumber(), 500);
});

test("documented worked example: PF at 12% of annual basic", () => {
  // Monthly basic 15,000 -> 180,000 annual -> 12% = 21,600/year
  const annualBasic = evaluateFormula("[BASIC] * 12", ctx({ BASIC: 15000 }));
  assert.equal(annualBasic.toNumber(), 180000);
  assert.equal(evaluateFormula("[BASIC_ANNUAL] * 0.12", ctx({ BASIC_ANNUAL: 180000 })).toNumber(), 21600);
});

test("bare identifiers work as references too", () => {
  assert.equal(evaluateFormula("BASIC * 2", ctx({ BASIC: 1000 })).toNumber(), 2000);
});

test("unresolved references evaluate to zero, not an error", () => {
  assert.equal(evaluateFormula("[NOT_CONFIGURED] + 500", ctx({})).toNumber(), 500);
});

test("references are case-insensitive", () => {
  assert.equal(evaluateFormula("[basic] * 2", ctx({ BASIC: 50 })).toNumber(), 100);
  assert.equal(evaluateFormula("[BASIC] * 2", ctx({ basic: 50 })).toNumber(), 100);
});

test("IF with nesting", () => {
  const f = "IF([BASIC] > 15000, 1800, [BASIC] * 0.12)";
  assert.equal(evaluateFormula(f, ctx({ BASIC: 20000 })).toNumber(), 1800);
  assert.equal(evaluateFormula(f, ctx({ BASIC: 10000 })).toNumber(), 1200);

  const nested = "IF([G] > 50000, 200, IF([G] > 25000, 150, IF([G] > 10000, 100, 0)))";
  assert.equal(evaluateFormula(nested, ctx({ G: 60000 })).toNumber(), 200);
  assert.equal(evaluateFormula(nested, ctx({ G: 30000 })).toNumber(), 150);
  assert.equal(evaluateFormula(nested, ctx({ G: 15000 })).toNumber(), 100);
  assert.equal(evaluateFormula(nested, ctx({ G: 5000 })).toNumber(), 0);
});

test("IF short-circuits so the untaken branch cannot blow up", () => {
  // If both branches were evaluated, the division would still be safe here,
  // but the untaken branch must not contribute to the result.
  assert.equal(evaluateFormula("IF(1 > 0, 10, 999)", ctx({})).toNumber(), 10);
  assert.equal(evaluateFormula("IF(0 > 1, 999, 10)", ctx({})).toNumber(), 10);
});

test("comparison operators", () => {
  assert.equal(evaluateFormula("IF(5 >= 5, 1, 0)", ctx({})).toNumber(), 1);
  assert.equal(evaluateFormula("IF(5 <= 4, 1, 0)", ctx({})).toNumber(), 0);
  assert.equal(evaluateFormula("IF(5 = 5, 1, 0)", ctx({})).toNumber(), 1);
  assert.equal(evaluateFormula("IF(5 <> 4, 1, 0)", ctx({})).toNumber(), 1);
  assert.equal(evaluateFormula("IF(5 != 5, 1, 0)", ctx({})).toNumber(), 0);
});

test("AND / OR / NOT", () => {
  const f = "IF(AND([B] > 10000, [G] < 50000), 500, 0)";
  assert.equal(evaluateFormula(f, ctx({ B: 20000, G: 40000 })).toNumber(), 500);
  assert.equal(evaluateFormula(f, ctx({ B: 20000, G: 60000 })).toNumber(), 0);
  assert.equal(evaluateFormula("IF(OR(0, 1), 7, 8)", ctx({})).toNumber(), 7);
  assert.equal(evaluateFormula("IF(NOT(0), 7, 8)", ctx({})).toNumber(), 7);
});

test("MIN / MAX / ROUND family / ABS / SUM / PCT", () => {
  assert.equal(evaluateFormula("MIN([B] * 0.5, 100000)", ctx({ B: 300000 })).toNumber(), 100000);
  assert.equal(evaluateFormula("MAX(1, 2, 3)", ctx({})).toNumber(), 3);
  assert.equal(evaluateFormula("ROUND(1234.56)", ctx({})).toNumber(), 1235);
  assert.equal(evaluateFormula("ROUND(1234.567, 2)", ctx({})).toNumber(), 1234.57);
  assert.equal(evaluateFormula("ROUNDUP(1234.01)", ctx({})).toNumber(), 1235);
  assert.equal(evaluateFormula("ROUNDDOWN(1234.99)", ctx({})).toNumber(), 1234);
  assert.equal(evaluateFormula("ABS(0 - 50)", ctx({})).toNumber(), 50);
  assert.equal(evaluateFormula("SUM(1, 2, 3, 4)", ctx({})).toNumber(), 10);
  assert.equal(evaluateFormula("PCT(100000, 12)", ctx({})).toNumber(), 12000);
});

test("division by zero yields zero rather than aborting the run", () => {
  assert.equal(evaluateFormula("[A] / [B]", ctx({ A: 100, B: 0 })).toNumber(), 0);
});

test("decimal precision holds where float would drift", () => {
  // 0.1 + 0.2 === 0.30000000000000004 in binary floating point.
  assert.equal(evaluateFormula("0.1 + 0.2", ctx({})).toString(), "0.3");
  assert.equal(evaluateFormula("[B] * 0.0075", ctx({ B: 21000 })).toString(), "157.5");
});

test("unary minus and whitespace tolerance", () => {
  assert.equal(evaluateFormula("-5 + 10", ctx({})).toNumber(), 5);
  assert.equal(evaluateFormula("  [ BASIC ]   *   2  ", ctx({ BASIC: 10 })).toNumber(), 20);
});

test("extractReferences finds dependencies", () => {
  const refs = extractReferences("IF([BASIC] > 15000, [HRA], [SPECIAL] + [DA])");
  assert.deepEqual(refs.sort(), ["BASIC", "DA", "HRA", "SPECIAL"]);
  // Function names must not be mistaken for references.
  assert.deepEqual(extractReferences("MIN([A], 5)"), ["A"]);
});

test("validateFormula reports syntax errors", () => {
  assert.equal(validateFormula("[BASIC] * 0.12").valid, true);
  assert.equal(validateFormula("[BASIC] * ").valid, false);
  assert.equal(validateFormula("IF([A] > 1, 2)").valid, false); // IF needs 3 args
  assert.equal(validateFormula("NOSUCHFN(1)").valid, false);
  assert.equal(validateFormula("[UNCLOSED").valid, false);
});

test("topologicalOrder sequences components after their dependencies", () => {
  const { order, cycles } = topologicalOrder([
    { code: "SPECIAL", formula: "[CTC] - [BASIC] - [HRA] - [PF]" },
    { code: "PF", formula: "[BASIC] * 0.12" },
    { code: "HRA", formula: "[BASIC] * 0.4" },
    { code: "BASIC", formula: "[CTC] * 0.4" },
    { code: "CTC", formula: null },
  ]);
  assert.deepEqual(cycles, []);
  const at = (c: string) => order.indexOf(c);
  assert.ok(at("CTC") < at("BASIC"));
  assert.ok(at("BASIC") < at("HRA"));
  assert.ok(at("BASIC") < at("PF"));
  assert.ok(at("PF") < at("SPECIAL"));
  assert.ok(at("HRA") < at("SPECIAL"));
});

test("topologicalOrder reports cycles instead of hanging", () => {
  const { cycles } = topologicalOrder([
    { code: "A", formula: "[B] + 1" },
    { code: "B", formula: "[A] + 1" },
  ]);
  assert.ok(cycles.length > 0);
});
