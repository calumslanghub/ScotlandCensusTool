// "Find areas" maths, with no imports so node --test can load it (web/tests/query.test.mjs).
// Level-agnostic: a column is a Map(code -> value) over the areas in the query's scope.
//
// A criterion is {metricId, mode, min, max}: mode PERCENTILE keeps areas whose percentile
// rank among the areas in scope lies in [min, max] (0 lowest .. 100 highest); mode VALUE
// keeps areas whose value lies in [min, max]. Both bounds are inclusive.

export const PERCENTILE = "percentile";
export const VALUE = "value";
export const HIGH = "high";
export const LOW = "low";
export const CUSTOM = "custom";

const EPS = 1e-9;

// Finite values of a column, ascending.
export function sortedValues(column) {
  return [...column.values()].filter(Number.isFinite).sort((a, b) => a - b);
}

// code -> percentile rank 0..100 of the column's finite values. Ties share their average
// rank; a column with one value ranks it 50. Missing values get no rank.
export function percentileRanks(column) {
  const entries = [...column].filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const out = new Map();
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && entries[j + 1][1] === entries[i][1]) j++;
    const pct = n === 1 ? 50 : (((i + j) / 2) / (n - 1)) * 100;
    for (let t = i; t <= j; t++) out.set(entries[t][0], pct);
    i = j + 1;
  }
  return out;
}

// Value at percentile p of ascending values (linear between neighbours), or null.
export function valueAtPercentile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Percentile of value v among ascending values (inverse of valueAtPercentile), or null.
export function percentileOfValue(sorted, v) {
  const n = sorted.length;
  if (!n || !Number.isFinite(v)) return null;
  if (n === 1) return 50;
  if (v <= sorted[0]) return 0;
  if (v >= sorted[n - 1]) return 100;
  let i = 0;
  while (sorted[i + 1] <= v) i++;
  const gap = sorted[i + 1] - sorted[i];
  return ((i + (gap ? (v - sorted[i]) / gap : 0)) / (n - 1)) * 100;
}

// [min, max] percentiles of a preset: the top or bottom `band` percent.
export function presetRange(preset, band) {
  if (preset === HIGH) return [100 - band, 100];
  if (preset === LOW) return [0, band];
  throw new Error(`Unknown preset ${preset}`);
}

const within = (x, min, max) => Number.isFinite(x) && x >= min - EPS && x <= max + EPS;

// Whether an area with this value and percentile meets the criterion.
export function matches(criterion, value, pct) {
  const x = criterion.mode === PERCENTILE ? pct : value;
  return within(x, criterion.min, criterion.max);
}

/**
 * Bounds of a criterion in the other mode, so it keeps the same areas: the smallest value
 * among the areas at or above the lower percentile, the largest among those at or below the
 * upper one (and the reverse for value -> percentile). Falls back to interpolation when no
 * area lies in the range. Returns {min, max}.
 */
export function convertBounds(column, criterion, toMode) {
  if (criterion.mode === toMode) return { min: criterion.min, max: criterion.max };
  const ranks = percentileRanks(column);
  const pairs = [...ranks].map(([code, pct]) => ({ pct, value: column.get(code) }));
  const from = criterion.mode === PERCENTILE ? "pct" : "value";
  const to = from === "pct" ? "value" : "pct";
  const inside = pairs.filter((p) => within(p[from], criterion.min, criterion.max));
  if (inside.length) {
    return { min: Math.min(...inside.map((p) => p[to])), max: Math.max(...inside.map((p) => p[to])) };
  }
  const sorted = sortedValues(column);
  const convert = from === "pct" ? (x) => valueAtPercentile(sorted, x) : (x) => percentileOfValue(sorted, x);
  return { min: convert(criterion.min), max: convert(criterion.max) };
}

// Number of areas in a column that meet one criterion.
export function countMatches(column, criterion) {
  const ranks = criterion.mode === PERCENTILE ? percentileRanks(column) : null;
  let n = 0;
  for (const [code, value] of column) if (matches(criterion, value, ranks?.get(code))) n++;
  return n;
}

/**
 * Evaluate criteria over the areas in scope.
 * codes: the areas' codes; columns[i]: Map(code -> value) for criteria[i].
 * Returns {n, byCode: Map(code -> {k, hits, values, pcts, fit, nodata}), counts, nodata}:
 *   k       criteria met (a missing value never counts)
 *   fit     mean distance (percentile points) from the middle of each criterion's range
 *           in percentile terms; smaller is a closer fit, used to order equal k
 *   nodata  true when the area has no value for any criterion
 *   counts  counts[k] = areas meeting exactly k criteria (areas with no data left out)
 */
export function evaluate(codes, columns, criteria) {
  const n = criteria.length;
  const ranks = columns.map(percentileRanks);
  const sorted = columns.map(sortedValues);
  const centres = criteria.map((c, i) => {
    const [lo, hi] = c.mode === PERCENTILE ? [c.min, c.max]
      : [percentileOfValue(sorted[i], c.min) ?? 0, percentileOfValue(sorted[i], c.max) ?? 100];
    return (lo + hi) / 2;
  });
  const byCode = new Map();
  const counts = new Array(n + 1).fill(0);
  let nodata = 0;
  for (const code of codes) {
    const values = columns.map((col) => col.get(code) ?? null);
    const pcts = ranks.map((r) => r.get(code) ?? null);
    const hits = criteria.map((c, i) => matches(c, values[i], pcts[i]));
    const k = hits.filter(Boolean).length;
    const known = pcts.filter((p) => p != null);
    const fit = known.length
      ? pcts.reduce((sum, p, i) => sum + (p == null ? 0 : Math.abs(p - centres[i])), 0) / known.length : Infinity;
    const none = n > 0 && !known.length;
    byCode.set(code, { k, hits, values, pcts, fit, nodata: none });
    if (none) nodata++;
    else counts[k]++;
  }
  return { n, byCode, counts, nodata };
}

// Codes of a level's areas holding any output area of a ward. oaProps: OA feature
// properties; groupField: the OA field naming the level's area (null: the OA itself).
export function wardMembers(oaProps, groupField, wardField, ward) {
  const out = new Set();
  for (const p of oaProps) {
    if (p[wardField] !== ward) continue;
    const code = groupField ? p[groupField] : p.code;
    if (code != null) out.add(code);
  }
  return out;
}

/**
 * Metric groups (one per Census table, plus the base metrics) sorted into the explorer's
 * topics. categories: [{id, label, indicators: [{dataset?, metric?}]}] (the top tabs, in
 * order); groups: [{label, dataset, metrics: [{id}]}] (dataset null for the base metrics).
 * A table goes in the category of the first indicator showing it; the base group in the
 * category of the first indicator whose `metric` is one of its metrics. Anything no
 * indicator refers to goes in a last topic, `other`. Returns [{id, label, groups}], without
 * empty topics.
 */
export function groupByTopic(categories, groups, other = "Other") {
  const topicOf = (g) => {
    const ids = new Set(g.metrics.map((m) => m.id));
    const cat = categories.find((c) => c.indicators.some((i) =>
      (g.dataset ? i.dataset === g.dataset : !i.dataset && ids.has(i.metric))));
    return cat?.id ?? null;
  };
  const byTopic = new Map();
  for (const g of groups) {
    const id = topicOf(g);
    if (!byTopic.has(id)) byTopic.set(id, []);
    byTopic.get(id).push(g);
  }
  const topics = categories.filter((c) => byTopic.has(c.id))
    .map((c) => ({ id: c.id, label: c.label, groups: byTopic.get(c.id) }));
  if (byTopic.has(null)) topics.push({ id: "other", label: other, groups: byTopic.get(null) });
  return topics;
}

// Median of ascending values, or null.
export const median = (sorted) => valueAtPercentile(sorted, 50);
