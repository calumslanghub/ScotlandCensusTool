// Run from the project root: node --test "web/tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rng, meanSd, ranks, buildMatrix, kmeans, elbow, cluster, knee, silhouette, relabelBySize, profiles,
  workEstimate, ZSCORE, RANK,
} from "../js/cluster-core.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Three well-separated 2-d blobs of 40 points each, from a seeded generator.
function blobs() {
  const random = rng(42);
  const centres = [[0, 0], [10, 10], [0, 10]];
  const codes = [];
  const a = new Map(), b = new Map(), truth = new Map();
  centres.forEach(([x, y], c) => {
    for (let i = 0; i < 40; i++) {
      const code = `b${c}_${i}`;
      codes.push(code);
      a.set(code, x + random() - 0.5);
      b.set(code, y + random() - 0.5);
      truth.set(code, c);
    }
  });
  return { codes, columns: [a, b], truth };
}

const vars = (n) => Array.from({ length: n }, () => ({ transform: ZSCORE, weight: 1 }));

test("the seeded generator repeats and stays in [0, 1)", () => {
  const a = rng(7), b = rng(7);
  const xs = Array.from({ length: 100 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 100 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notEqual(rng(8)(), rng(7)());
});

test("z-scores have mean 0 and SD 1; weights scale them; missing values leave the area out", () => {
  const col = new Map([["a", 1], ["b", 2], ["c", 3], ["d", null], ["e", 6]]);
  const flat = new Map([["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5]]);
  const m = buildMatrix(["a", "b", "c", "d", "e"], [col, flat], [{ transform: ZSCORE, weight: 2 }, { transform: ZSCORE, weight: 1 }]);
  assert.deepEqual(m.codes, ["a", "b", "c", "e"]);
  assert.deepEqual(m.excluded, ["d"]);
  const first = [0, 1, 2, 3].map((i) => m.X[i * 2] / 2);
  const { mean, sd } = meanSd(first);
  close(mean, 0);
  close(sd, 1);
  assert.ok([0, 1, 2, 3].every((i) => m.X[i * 2 + 1] === 0));  // no spread -> 0
  close(m.raw[3 * 2], 6);
  close(m.stats[0].mean, 3);
});

test("rank transform tames skew; keep() filters areas", () => {
  assert.deepEqual(ranks([10, 1000, 20, 20]), [0, 1, 0.5, 0.5]);
  const col = new Map([["a", 0], ["b", 0.1], ["c", 0.2], ["d", 99]]);
  const m = buildMatrix(["a", "b", "c", "d"], [col], [{ transform: RANK, weight: 1 }], (c) => c !== "a");
  assert.deepEqual(m.codes, ["b", "c", "d"]);
  close(m.X[2] - m.X[1], m.X[1] - m.X[0]);  // evenly spaced despite the outlier
});

test("WCSS never rises with k and the knee of three blobs is 3", () => {
  const { codes, columns } = blobs();
  const m = buildMatrix(codes, columns, vars(2));
  const { series, knee: k } = elbow(m.X, m.n, m.d, 8, { seed: 1, restarts: 3 });
  for (let i = 1; i < series.length; i++) assert.ok(series[i].wcss <= series[i - 1].wcss + 1e-9);
  assert.equal(k, 3);
  assert.equal(series[0].silhouette, null);
  assert.ok(series[2].silhouette > 0.8, `silhouette ${series[2].silhouette}`);
});

test("k = 3 recovers the blobs exactly, and a seeded run is deterministic", () => {
  const { codes, columns, truth } = blobs();
  const m = buildMatrix(codes, columns, vars(2));
  const r1 = cluster(m.X, m.n, m.d, 3, { seed: 5 });
  const r2 = cluster(m.X, m.n, m.d, 3, { seed: 5 });
  assert.deepEqual([...r1.labels], [...r2.labels]);
  const pairs = new Set(m.codes.map((c, i) => `${truth.get(c)}-${r1.labels[i]}`));
  assert.equal(pairs.size, 3);  // each blob maps to exactly one cluster
  assert.deepEqual(r1.sizes, [40, 40, 40]);
});

test("clusters are numbered largest first", () => {
  const labels = Int32Array.from([1, 1, 1, 0, 2, 2]);
  const centres = Float64Array.from([0, 10, 20]);
  const r = relabelBySize(labels, centres, 3, 1);
  assert.deepEqual([...r.labels], [0, 0, 0, 2, 1, 1]);
  assert.deepEqual([...r.centres], [10, 20, 0]);
  assert.deepEqual(r.sizes, [3, 2, 1]);
});

test("profiles give cluster means in original units and as SDs from the mean", () => {
  const raw = Float64Array.from([1, 3, 10, 12]);
  const p = profiles(raw, 4, 1, Int32Array.from([0, 0, 1, 1]), 2, [{ mean: 6.5, sd: 4.5 }]);
  close(p[0].means[0], 2);
  close(p[1].means[0], 11);
  close(p[0].z[0], -1);
  close(p[1].z[0], 1);
  assert.equal(p[0].size, 2);
});

test("small inputs: k is capped at n, the knee needs three points, silhouette needs k >= 2", () => {
  const X = Float64Array.from([0, 1]);
  const r = cluster(X, 2, 1, 5, { seed: 1 });
  assert.equal(r.k, 2);
  assert.equal(knee([{ k: 1, wcss: 4 }, { k: 2, wcss: 1 }]), 2);
  assert.equal(silhouette(X, 2, 1, Int32Array.from([0, 1]), 1), null);
  assert.equal(kmeans(X, 2, 1, 1, { seed: 1 }).wcss, 0.5);
  assert.equal(workEstimate(10, 2, 3, 1, 1), 120);
});
