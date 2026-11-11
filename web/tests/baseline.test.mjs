// Run from the project root: node --test "web/tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  difference, classOf, thresholds, standardDeviation, compareWithBaseline, rowsFromFeatures,
  RELATIVE, DIFFERENCE, BASE, NO_DATA, EXCLUDED,
} from "../js/baseline-core.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("relative difference is value / baseline - 1, as %", () => {
  close(difference(110, 100, RELATIVE), 10);
  close(difference(75, 100, RELATIVE), -25);
  close(difference(100, 100, RELATIVE), 0);
});

test("difference is value - baseline (points for percentages)", () => {
  close(difference(23.5, 20.0, DIFFERENCE), 3.5);
  close(difference(18, 20, DIFFERENCE), -2);
});

test("zero baseline: relative is not a number, missing values are not a number", () => {
  assert.ok(Number.isNaN(difference(5, 0, RELATIVE)));
  assert.ok(Number.isNaN(difference(null, 10, DIFFERENCE)));
  assert.ok(Number.isNaN(difference(5, undefined, RELATIVE)));
  assert.throws(() => difference(1, 2, "ratio"), /Unknown baseline mode/);
});

test("classes sit at +/-0.25 and +/-1 standard deviation", () => {
  const t = thresholds(4);
  assert.deepEqual(t, [-4, -1, 1, 4]);
  assert.equal(classOf(-5, t), 0);
  assert.equal(classOf(-4, t), 1);   // the -1sd edge belongs to the inner class
  assert.equal(classOf(-2, t), 1);
  assert.equal(classOf(-1, t), 2);
  assert.equal(classOf(0, t), 2);
  assert.equal(classOf(1, t), 2);
  assert.equal(classOf(2, t), 3);
  assert.equal(classOf(4, t), 3);
  assert.equal(classOf(4.01, t), 4);
});

test("standard deviation is the population SD", () => {
  close(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(standardDeviation([]), 0);
});

const rows = [
  { code: "B", value: 20, denominator: 1000 },   // baseline
  { code: "A1", value: 10, denominator: 900 },
  { code: "A2", value: 19, denominator: 800 },
  { code: "A3", value: 21, denominator: 700 },
  { code: "A4", value: 30, denominator: 600 },
  { code: "SMALL", value: 99, denominator: 12 }, // below min_denominator
  { code: "MISSING", value: null, denominator: 500 },
];

test("difference mode classifies others, marks baseline and excluded areas", () => {
  const out = compareWithBaseline(rows, { baseCode: "B", mode: DIFFERENCE, minDenominator: 50 });
  assert.equal(out.baseValue, 20);
  close(out.sd, standardDeviation([-10, -1, 1, 10]));
  assert.equal(out.byCode.get("B").kind, BASE);
  assert.equal(out.byCode.get("SMALL").kind, EXCLUDED);
  assert.equal(out.byCode.get("MISSING").kind, NO_DATA);
  assert.equal(out.byCode.get("A1").kind, 0);  // -10 < -sd (~7.1)
  assert.equal(out.byCode.get("A2").kind, 2);  // -1 within ±0.25sd (~1.78)
  assert.equal(out.byCode.get("A3").kind, 2);
  assert.equal(out.byCode.get("A4").kind, 4);
  close(out.byCode.get("A4").diff, 10);
});

test("excluded areas do not move the standard deviation", () => {
  const without = compareWithBaseline(rows.filter((r) => r.code !== "SMALL"),
    { baseCode: "B", mode: DIFFERENCE, minDenominator: 50 });
  const withSmall = compareWithBaseline(rows, { baseCode: "B", mode: DIFFERENCE, minDenominator: 50 });
  close(without.sd, withSmall.sd);
});

test("relative mode uses percentage differences", () => {
  const out = compareWithBaseline(rows, { baseCode: "B", mode: RELATIVE, minDenominator: 50 });
  close(out.byCode.get("A1").diff, -50);
  close(out.byCode.get("A4").diff, 50);
  assert.equal(out.byCode.get("A1").kind, 0);
  assert.equal(out.byCode.get("A4").kind, 4);
});

test("zero baseline value: every other area is grey (no data), the baseline stays white", () => {
  const zero = rows.map((r) => (r.code === "B" ? { ...r, value: 0 } : r));
  for (const mode of [RELATIVE, DIFFERENCE]) {
    const out = compareWithBaseline(zero, { baseCode: "B", mode, minDenominator: 50 });
    assert.equal(out.byCode.get("B").kind, BASE);
    for (const code of ["A1", "A2", "A3", "A4", "MISSING"]) {
      assert.equal(out.byCode.get(code).kind, NO_DATA, `${mode} ${code}`);
    }
    assert.equal(out.byCode.get("SMALL").kind, EXCLUDED);
    assert.equal(out.sd, 0);
  }
});

test("below-threshold baseline is still the baseline; threshold 0 excludes nothing", () => {
  const out = compareWithBaseline(rows, { baseCode: "SMALL", mode: DIFFERENCE, minDenominator: 50 });
  assert.equal(out.byCode.get("SMALL").kind, BASE);
  const none = compareWithBaseline(rows, { baseCode: "B", mode: DIFFERENCE });
  assert.notEqual(none.byCode.get("SMALL").kind, EXCLUDED);
});

test("output-area rows come from loaded feature properties", () => {
  const features = [
    { properties: { code: "OA1", pop: 120, area_km2: 0.5 } },
    { properties: { code: "OA2", pop: 30, area_km2: 0.1 } },
    { properties: { code: "OA3", pop: 200, area_km2: 0 } },
  ];
  const density = { numerator: "pop", denominator: "area_km2", scale: 1 };
  assert.deepEqual(rowsFromFeatures(features, density, "pop"), [
    { code: "OA1", value: 240, denominator: 120 },
    { code: "OA2", value: 300, denominator: 30 },
    { code: "OA3", value: null, denominator: 200 },
  ]);
  const synthetic = { source: "synthetic" };
  assert.equal(rowsFromFeatures(features, synthetic, "pop")[0].value, null);
  const out = compareWithBaseline(rowsFromFeatures(features, density, "pop"),
    { baseCode: "OA1", mode: RELATIVE, minDenominator: 50 });
  assert.equal(out.byCode.get("OA2").kind, EXCLUDED);
  assert.equal(out.byCode.get("OA3").kind, NO_DATA);
});
