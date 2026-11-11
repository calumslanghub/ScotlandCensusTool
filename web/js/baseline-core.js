// Baseline maths, with no imports so node --test can load it (web/tests/baseline.test.mjs).
// Level-agnostic: rows can come from metrics.json (council areas, localities) or from the
// feature properties already loaded for the view (output areas).

export const RELATIVE = "relative";      // value / baseline - 1, as a percentage
export const DIFFERENCE = "difference";  // value - baseline (points for percentages)

// Class kinds besides 0..4 (below 2, below 1, within, above 1, above 2).
export const BASE = "base";          // the baseline area itself
export const NO_DATA = "nodata";     // no comparison: missing value, or baseline value is zero
export const EXCLUDED = "excluded";  // denominator below min_denominator

const SD_INNER = 0.25;
const SD_OUTER = 1;

export function difference(value, base, mode) {
  if (!Number.isFinite(value) || !Number.isFinite(base)) return NaN;
  if (mode === RELATIVE) return base === 0 ? NaN : (value / base - 1) * 100;
  if (mode === DIFFERENCE) return value - base;
  throw new Error(`Unknown baseline mode ${mode}`);
}

// Population standard deviation.
export function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

// Thresholds at -1, -0.25, +0.25, +1 standard deviations of the differences.
export function thresholds(sd) {
  return [-SD_OUTER * sd, -SD_INNER * sd, SD_INNER * sd, SD_OUTER * sd];
}

// Class 0..4 for a difference: below -1sd, below -0.25sd, within ±0.25sd, above, far above.
export function classOf(diff, t) {
  if (diff < t[0]) return 0;
  if (diff < t[1]) return 1;
  if (diff <= t[2]) return 2;
  if (diff <= t[3]) return 3;
  return 4;
}

/**
 * Compare every row with the baseline row.
 * rows: [{code, value, denominator}]; denominator null/undefined means "not checked".
 * Returns {baseValue, sd, thresholds, byCode: Map(code -> {kind, diff})}, where kind is
 * BASE, NO_DATA, EXCLUDED or a class 0..4. The baseline itself is never excluded.
 * A zero (or missing) baseline value compares nothing: every other row is NO_DATA.
 */
export function compareWithBaseline(rows, { baseCode, mode, minDenominator = 0 }) {
  const base = rows.find((r) => r.code === baseCode);
  const baseValue = base && Number.isFinite(base.value) ? base.value : null;
  const usable = baseValue !== null && baseValue !== 0;
  const byCode = new Map();
  const diffs = [];
  for (const r of rows) {
    if (r.code === baseCode) {
      byCode.set(r.code, { kind: BASE, diff: 0 });
    } else if (r.denominator != null && r.denominator < minDenominator) {
      byCode.set(r.code, { kind: EXCLUDED, diff: NaN });
    } else {
      const diff = usable ? difference(r.value, baseValue, mode) : NaN;
      byCode.set(r.code, { kind: NO_DATA, diff });
      if (Number.isFinite(diff)) diffs.push(diff);
    }
  }
  const sd = standardDeviation(diffs);
  const t = thresholds(sd);
  for (const entry of byCode.values()) {
    if (entry.kind === NO_DATA && Number.isFinite(entry.diff)) entry.kind = classOf(entry.diff, t);
  }
  return { baseValue, sd, thresholds: t, byCode };
}

/**
 * Rows for a level that metrics.json does not cover, from loaded feature properties.
 * metric: metrics.json entry; census metrics carry {numerator, denominator, scale}.
 * Synthetic metrics have no formula, so their values are null (grey on the map).
 */
export function rowsFromFeatures(features, metric, denominatorField) {
  return features.map(({ properties: p }) => {
    let value = null;
    if (metric.numerator) {
      const num = p[metric.numerator];
      const den = metric.denominator ? p[metric.denominator] : 1;
      value = num != null && den ? (num / den) * (metric.scale ?? 1) : null;
    }
    return { code: p.code, value, denominator: denominatorField ? p[denominatorField] ?? null : null };
  });
}
