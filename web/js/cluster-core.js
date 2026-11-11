// k-means maths for "Cluster areas", with no imports so it runs in the worker
// (cluster-worker.js) and under node --test / the browser test page (web/tests/cluster.test.mjs).
//
// Data is a row-major Float64Array X of n areas x d variables, already standardised and
// weighted (buildMatrix). Every random choice comes from a seeded generator, so the same
// inputs always give the same clusters.

export const ZSCORE = "z";
export const RANK = "rank";

// Seeded uniform [0, 1) generator (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mean and population standard deviation of finite values.
export function meanSd(values) {
  let n = 0, sum = 0;
  for (const v of values) if (Number.isFinite(v)) { n++; sum += v; }
  if (!n) return { mean: NaN, sd: NaN };
  const mean = sum / n;
  let ss = 0;
  for (const v of values) if (Number.isFinite(v)) ss += (v - mean) ** 2;
  return { mean, sd: Math.sqrt(ss / n) };
}

// Fractional ranks 0..1 of values (ties share their average rank; one value ranks 0.5).
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  const n = values.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    const r = n === 1 ? 0.5 : ((i + j) / 2) / (n - 1);
    for (let t = i; t <= j; t++) out[order[t][1]] = r;
    i = j + 1;
  }
  return out;
}

/**
 * The matrix k-means runs on.
 * codes: area codes; columns[j]: Map(code -> value) for variable j; vars[j]: {transform, weight};
 * keep(code): optional filter (e.g. a minimum population).
 * Areas missing any variable, or failing keep, are left out (`excluded`). Each variable is
 * transformed over the kept areas (ZSCORE: (x - mean) / sd; RANK: z-score of its ranks, which
 * tames skewed shares) and multiplied by its weight. A variable with no spread becomes 0.
 * Returns {codes, X, n, d, raw (Float64Array n x d of the original values), stats: [{mean, sd}],
 * excluded}.
 */
export function buildMatrix(codes, columns, vars, keep = () => true) {
  const d = columns.length;
  const kept = [];
  const excluded = [];
  for (const code of codes) {
    const ok = keep(code) && columns.every((col) => Number.isFinite(col.get(code)));
    (ok ? kept : excluded).push(code);
  }
  const n = kept.length;
  const X = new Float64Array(n * d);
  const raw = new Float64Array(n * d);
  const stats = [];
  for (let j = 0; j < d; j++) {
    const values = kept.map((c) => columns[j].get(c));
    values.forEach((v, i) => { raw[i * d + j] = v; });
    stats.push(meanSd(values));
    const t = vars[j]?.transform === RANK ? ranks(values) : values;
    const { mean, sd } = meanSd(t);
    const w = vars[j]?.weight ?? 1;
    t.forEach((v, i) => { X[i * d + j] = sd > 0 ? ((v - mean) / sd) * w : 0; });
  }
  return { codes: kept, X, n, d, raw, stats, excluded };
}

const dist2 = (X, i, C, c, d) => {
  let s = 0;
  for (let j = 0; j < d; j++) { const t = X[i * d + j] - C[c * d + j]; s += t * t; }
  return s;
};

// k-means++ seeding: each new centre is drawn with probability proportional to its squared
// distance from the nearest centre so far.
export function seedCentres(X, n, d, k, random) {
  const C = new Float64Array(k * d);
  const D = new Float64Array(n).fill(Infinity);
  let pick = Math.floor(random() * n);
  for (let c = 0; c < k; c++) {
    for (let j = 0; j < d; j++) C[c * d + j] = X[pick * d + j];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const v = dist2(X, i, C, c, d);
      if (v < D[i]) D[i] = v;
      total += D[i];
    }
    if (c + 1 === k) break;
    if (total === 0) { pick = Math.floor(random() * n); continue; }  // all points on centres
    let r = random() * total;
    pick = n - 1;
    for (let i = 0; i < n; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
  }
  return C;
}

// Lloyd iterations from centres C (updated in place) until no area changes cluster. An empty
// cluster takes the area furthest from its centre. Returns {labels, centres, wcss, iterations}.
export function lloyd(X, n, d, k, C, maxIter = 100) {
  const labels = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * d);
  const counts = new Int32Array(k);
  const best = new Float64Array(n);
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bc = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const v = dist2(X, i, C, c, d); if (v < bd) { bd = v; bc = c; } }
      best[i] = bd;
      if (labels[i] !== bc) { labels[i] = bc; changed++; }
    }
    if (!changed && iterations > 0) break;
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      for (let j = 0; j < d; j++) sums[c * d + j] += X[i * d + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]) {
        for (let j = 0; j < d; j++) C[c * d + j] = sums[c * d + j] / counts[c];
      } else {
        let far = 0;
        for (let i = 1; i < n; i++) if (best[i] > best[far]) far = i;
        for (let j = 0; j < d; j++) C[c * d + j] = X[far * d + j];
        best[far] = 0;
      }
    }
  }
  let wcss = 0;
  for (let i = 0; i < n; i++) wcss += dist2(X, i, C, labels[i], d);
  return { labels, centres: C, wcss, iterations };
}

// The lowest-WCSS of `restarts` seeded k-means runs.
export function kmeans(X, n, d, k, { seed = 1, restarts = 4, maxIter = 100 } = {}) {
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const random = rng(seed + 7919 * k + 104729 * r);
    const run = lloyd(X, n, d, k, seedCentres(X, n, d, k, random), maxIter);
    if (!best || run.wcss < best.wcss) best = run;
  }
  return best;
}

// Mean silhouette over a seeded sample of up to `sample` areas, using distances between
// sampled areas only (the full score is O(n^2)). 1 = tight, well separated; ~0 = overlapping.
export function silhouette(X, n, d, labels, k, { sample = 2000, seed = 1 } = {}) {
  if (k < 2 || n < 3) return null;
  const idx = Array.from({ length: n }, (_, i) => i);
  const m = Math.min(sample, n);
  const random = rng(seed);
  for (let i = 0; i < m; i++) {  // partial Fisher-Yates: the first m are a random sample
    const j = i + Math.floor(random() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const S = idx.slice(0, m);
  const sizes = new Int32Array(k);
  for (const i of S) sizes[labels[i]]++;
  const sums = new Float64Array(k);
  let total = 0;
  for (const i of S) {
    sums.fill(0);
    for (const j of S) {
      if (i === j) continue;
      let s = 0;
      for (let t = 0; t < d; t++) { const v = X[i * d + t] - X[j * d + t]; s += v * v; }
      sums[labels[j]] += Math.sqrt(s);
    }
    const own = labels[i];
    if (sizes[own] < 2) continue;  // a singleton scores 0
    const a = sums[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && sizes[c]) b = Math.min(b, sums[c] / sizes[c]);
    if (Number.isFinite(b)) total += (b - a) / Math.max(a, b) || 0;
  }
  return total / m;
}

// The elbow: k where the WCSS curve bends most, i.e. the point furthest from the straight
// line between its first and last points, both axes scaled 0..1. At least 2.
export function knee(series) {
  if (series.length < 3) return series.at(-1)?.k ?? 1;
  const [first, last] = [series[0], series.at(-1)];
  const spanK = last.k - first.k || 1;
  const spanW = first.wcss - last.wcss || 1;
  let best = series[1].k, bestDist = -Infinity;
  for (const p of series) {
    const x = (p.k - first.k) / spanK;
    const y = (first.wcss - p.wcss) / spanW;   // 0 at k = first, 1 at k = last
    const dist = y - x;                        // above the diagonal = bending
    if (p.k >= 2 && dist > bestDist) { bestDist = dist; best = p.k; }
  }
  return best;
}

// Renumber clusters largest first, so colours stay stable between runs.
export function relabelBySize(labels, centres, k, d) {
  const sizes = new Array(k).fill(0);
  for (const l of labels) sizes[l]++;
  const order = sizes.map((s, c) => [s, c]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, c]) => c);
  const map = new Int32Array(k);
  order.forEach((old, i) => { map[old] = i; });
  const out = Int32Array.from(labels, (l) => map[l]);
  const C = new Float64Array(k * d);
  order.forEach((old, i) => { for (let j = 0; j < d; j++) C[i * d + j] = centres[old * d + j]; });
  return { labels: out, centres: C, sizes: order.map((c) => sizes[c]) };
}

/**
 * WCSS (and sampled silhouette) for k = 1..kMax: the elbow chart.
 * onProgress(done, total) is called after each k. Returns {series: [{k, wcss, silhouette}], knee}.
 */
export function elbow(X, n, d, kMax, opts = {}, onProgress = () => {}) {
  const top = Math.max(1, Math.min(kMax, n));
  const series = [];
  for (let k = 1; k <= top; k++) {
    const run = kmeans(X, n, d, k, opts);
    const sil = k >= 2 ? silhouette(X, n, d, run.labels, k, { sample: opts.sample, seed: opts.seed }) : null;
    series.push({ k, wcss: run.wcss, silhouette: sil });
    onProgress(k, top);
  }
  return { series, knee: knee(series) };
}

// A final clustering with k clusters, numbered largest first.
export function cluster(X, n, d, k, opts = {}) {
  const kk = Math.max(1, Math.min(k, n));
  const run = kmeans(X, n, d, kk, opts);
  const { labels, centres, sizes } = relabelBySize(run.labels, run.centres, kk, d);
  const sil = silhouette(X, n, d, labels, kk, { sample: opts.sample, seed: opts.seed });
  return { k: kk, labels, centres, sizes, wcss: run.wcss, silhouette: sil };
}

/**
 * Cluster profiles: per cluster, the mean of each variable's original values and that mean as
 * standard deviations from the mean of all clustered areas (for the heatmap).
 * raw: Float64Array n x d; stats: [{mean, sd}] per variable. Returns [{size, means, z}].
 */
export function profiles(raw, n, d, labels, k, stats) {
  const sums = new Float64Array(k * d);
  const sizes = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    sizes[labels[i]]++;
    for (let j = 0; j < d; j++) sums[labels[i] * d + j] += raw[i * d + j];
  }
  return Array.from({ length: k }, (_, c) => {
    const means = Array.from({ length: d }, (_, j) => (sizes[c] ? sums[c * d + j] / sizes[c] : NaN));
    const z = means.map((m, j) => (stats[j].sd > 0 ? (m - stats[j].mean) / stats[j].sd : 0));
    return { size: sizes[c], means, z };
  });
}

// Work estimate for the elbow sweep (distance terms computed), checked against a budget.
export const workEstimate = (n, d, kMax, restarts, maxIter) => n * d * ((kMax * (kMax + 1)) / 2) * restarts * maxIter;
