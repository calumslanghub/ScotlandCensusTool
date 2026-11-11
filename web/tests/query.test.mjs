// Run from the project root: node --test "web/tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  percentileRanks, valueAtPercentile, percentileOfValue, sortedValues, presetRange, matches,
  convertBounds, countMatches, evaluate, wardMembers, median, groupByTopic, PERCENTILE, VALUE, HIGH, LOW,
} from "../js/query-core.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const col = (obj) => new Map(Object.entries(obj));

test("percentile ranks run 0..100, ties share their average rank, missing values get none", () => {
  const r = percentileRanks(col({ a: 10, b: 20, c: 20, d: 40, e: null, f: NaN }));
  close(r.get("a"), 0);
  close(r.get("b"), 50);   // ranks 1 and 2 of 0..3 -> 1.5 / 3
  close(r.get("c"), 50);
  close(r.get("d"), 100);
  assert.equal(r.has("e"), false);
  assert.equal(r.has("f"), false);
  assert.equal(percentileRanks(col({ only: 3 })).get("only"), 50);
});

test("value <-> percentile interpolation round-trips", () => {
  const sorted = [0, 10, 20, 30, 40];
  close(valueAtPercentile(sorted, 0), 0);
  close(valueAtPercentile(sorted, 62.5), 25);
  close(valueAtPercentile(sorted, 100), 40);
  for (const p of [0, 12.5, 50, 87.5, 100]) close(percentileOfValue(sorted, valueAtPercentile(sorted, p)), p);
  assert.equal(percentileOfValue(sorted, -5), 0);
  assert.equal(percentileOfValue(sorted, 99), 100);
  assert.equal(valueAtPercentile([], 50), null);
  close(median(sorted), 20);
});

test("bounds are inclusive in both modes", () => {
  const c = { mode: PERCENTILE, min: 75, max: 100 };
  assert.ok(matches(c, 1, 75));
  assert.ok(matches(c, 1, 100));
  assert.ok(!matches(c, 1, 74.9));
  assert.ok(!matches(c, 1, null));
  const v = { mode: VALUE, min: 0, max: 20 };
  assert.ok(matches(v, 0, null));
  assert.ok(matches(v, 20, null));
  assert.ok(!matches(v, 20.01, null));
  assert.ok(!matches(v, null, 50));
});

test("High and Low presets pick the top and bottom band", () => {
  assert.deepEqual(presetRange(HIGH, 25), [75, 100]);
  assert.deepEqual(presetRange(LOW, 25), [0, 25]);
  assert.throws(() => presetRange("middle", 25), /Unknown preset/);
  const column = new Map(Array.from({ length: 9 }, (_, i) => [`a${i}`, i * 10]));  // pct 0, 12.5, ... 100
  assert.equal(countMatches(column, { mode: PERCENTILE, min: 75, max: 100 }), 3);
  assert.equal(countMatches(column, { mode: PERCENTILE, min: 0, max: 25 }), 3);
});

test("switching mode keeps the same areas", () => {
  const column = col({ a: 5, b: 12, c: 12, d: 30, e: 41, f: 70, g: null });
  for (const crit of [{ mode: PERCENTILE, min: 75, max: 100 }, { mode: PERCENTILE, min: 0, max: 40 },
                      { mode: PERCENTILE, min: 30, max: 60 }]) {
    const asValue = { mode: VALUE, ...convertBounds(column, crit, VALUE) };
    assert.equal(countMatches(column, asValue), countMatches(column, crit));
    const back = { mode: PERCENTILE, ...convertBounds(column, asValue, PERCENTILE) };
    assert.equal(countMatches(column, back), countMatches(column, crit));
  }
  assert.deepEqual(convertBounds(column, { mode: VALUE, min: 1, max: 2 }, VALUE), { min: 1, max: 2 });
});

test("evaluate counts criteria met; a missing value never counts", () => {
  const codes = ["a", "b", "c", "d", "e"];
  const employment = col({ a: 70, b: 60, c: 50, d: 40, e: null });
  const noCar = col({ a: 50, b: 40, c: 10, d: 5, e: null });
  const criteria = [{ mode: PERCENTILE, min: 50, max: 100 }, { mode: VALUE, min: 30, max: 100 }];
  const r = evaluate(codes, [employment, noCar], criteria);
  assert.equal(r.n, 2);
  assert.equal(r.byCode.get("a").k, 2);
  assert.equal(r.byCode.get("b").k, 2);
  assert.equal(r.byCode.get("c").k, 0);  // 3rd of 4 by employment -> pct 33
  assert.equal(r.byCode.get("d").k, 0);
  assert.equal(r.byCode.get("e").nodata, true);
  assert.deepEqual(r.counts, [2, 0, 2]);
  assert.equal(r.nodata, 1);
  assert.deepEqual(r.byCode.get("a").hits, [true, true]);
  assert.ok(r.byCode.get("b").fit < r.byCode.get("d").fit);
});

test("ward members: the areas holding any output area of the ward", () => {
  const oas = [
    { code: "oa1", ward_code: "W1", dz_code: "D1" },
    { code: "oa2", ward_code: "W1", dz_code: "D2" },
    { code: "oa3", ward_code: "W2", dz_code: "D2" },
    { code: "oa4", ward_code: "W2", dz_code: "D3", locality_code: null },
  ];
  assert.deepEqual([...wardMembers(oas, "dz_code", "ward_code", "W1")].sort(), ["D1", "D2"]);
  assert.deepEqual([...wardMembers(oas, null, "ward_code", "W2")].sort(), ["oa3", "oa4"]);
  assert.deepEqual([...wardMembers(oas, "locality_code", "ward_code", "W2")], []);
});

test("metric groups sort into the explorer's topics, in tab order, unreferenced ones last", () => {
  const categories = [
    { id: "demo", label: "Demographics", indicators: [{ dataset: "age" }, { metric: "pop" }] },
    { id: "health", label: "Health", indicators: [] },
    { id: "transport", label: "Transport", indicators: [{ dataset: "cars" }, { dataset: "travel" }] },
  ];
  const groups = [
    { label: "Population and area", dataset: null, metrics: [{ id: "pop" }, { id: "households" }] },
    { label: "Travel", dataset: "travel", metrics: [{ id: "travel__car" }] },
    { label: "Age", dataset: "age", metrics: [{ id: "age__mean" }] },
    { label: "New table", dataset: "newtable", metrics: [{ id: "newtable__a" }] },
    { label: "Cars", dataset: "cars", metrics: [{ id: "cars__none" }] },
  ];
  const topics = groupByTopic(categories, groups, "Other");
  assert.deepEqual(topics.map((t) => t.id), ["demo", "transport", "other"]);  // empty Health dropped
  assert.deepEqual(topics[0].groups.map((g) => g.label), ["Population and area", "Age"]);
  assert.deepEqual(topics[1].groups.map((g) => g.label), ["Travel", "Cars"]);
  assert.equal(topics[2].label, "Other");
  assert.deepEqual(topics[2].groups.map((g) => g.label), ["New table"]);
  assert.deepEqual(groupByTopic(categories, [], "Other"), []);
});

test("sorted values drop missing entries", () => {
  assert.deepEqual(sortedValues(col({ a: 3, b: null, c: 1 })), [1, 3]);
});
