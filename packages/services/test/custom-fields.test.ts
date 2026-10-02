import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fieldKeyFor, parseOptions, checkCustomValue, displayCustomValue } from "../src/custom-fields-math";

describe("Custom fields", () => {
  test("keys come from labels", () => {
    assert.equal(fieldKeyFor("Blood group"), "blood_group");
    assert.equal(fieldKeyFor("  T-shirt size (S/M/L) "), "t_shirt_size_s_m_l");
    assert.equal(fieldKeyFor("!!!"), "field");
  });
  test("options split on lines or commas, de-duplicated", () => {
    assert.deepEqual(parseOptions("A+, B+\nA+\n  O- "), ["A+", "B+", "O-"]);
  });
  test("mandatory fields refuse blanks; optional ones clear", () => {
    assert.deepEqual(checkCustomValue({ label: "Blood group", type: "TEXT", isMandatory: true }, " "), { error: "Blood group is required" });
    assert.deepEqual(checkCustomValue({ label: "Nickname", type: "TEXT", isMandatory: false }, ""), { value: null });
  });
  test("each type checks its own shape", () => {
    assert.deepEqual(checkCustomValue({ label: "N", type: "NUMBER", isMandatory: false }, "12.50"), { value: "12.5" });
    assert.ok("error" in checkCustomValue({ label: "N", type: "NUMBER", isMandatory: false }, "12a"));
    assert.deepEqual(checkCustomValue({ label: "D", type: "DATE", isMandatory: false }, "2026-02-28"), { value: "2026-02-28" });
    assert.ok("error" in checkCustomValue({ label: "D", type: "DATE", isMandatory: false }, "2026-02-30"));
    assert.deepEqual(checkCustomValue({ label: "S", type: "DROPDOWN", options: ["Small", "Large"], isMandatory: false }, "large"), { value: "Large" });
    assert.ok("error" in checkCustomValue({ label: "S", type: "DROPDOWN", options: ["Small"], isMandatory: false }, "Huge"));
    assert.deepEqual(checkCustomValue({ label: "E", type: "EMAIL", isMandatory: false }, "A@B.co"), { value: "a@b.co" });
    assert.ok("error" in checkCustomValue({ label: "P", type: "PHONE", isMandatory: false }, "call me"));
  });
  test("a checkbox is always true or false, never blank", () => {
    assert.deepEqual(checkCustomValue({ label: "C", type: "CHECKBOX", isMandatory: true }, undefined), { value: "false" });
    assert.deepEqual(checkCustomValue({ label: "C", type: "CHECKBOX", isMandatory: false }, "on"), { value: "true" });
    assert.equal(displayCustomValue("CHECKBOX", "true"), "Yes");
    assert.equal(displayCustomValue("DATE", "2026-10-01"), "1 Oct 2026");
  });
});
