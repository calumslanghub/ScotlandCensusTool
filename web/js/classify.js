// Class breaks (simple-statistics) and sequential colours (d3-scale-chromatic).
import { quantile, jenks, chromatic } from "./vendor.js";

function thresholdsFor(values, method, k) {
  if (method === "jenks") {
    // jenks returns k + 1 breaks [min, ..., max]; inner breaks are the thresholds.
    return jenks(values, k).slice(1, -1);
  }
  return Array.from({ length: k - 1 }, (_, i) => quantile(values, (i + 1) / k));
}

export function palette(schemeName, k) {
  const scheme = chromatic[`scheme${schemeName}`];
  if (!scheme) throw new Error(`Unknown colour scheme ${schemeName}`);
  if (k >= 3) return scheme[Math.min(k, 9)];
  const three = scheme[3];
  return k === 2 ? [three[0], three[2]] : [three[2]];
}

// values: numbers (non-finite entries are ignored). Returns null when nothing to classify.
// Classes: [min, t1), [t1, t2), ... [t(k-1), max]. noData: colour for non-finite values.
export function classify(values, { method, classes, scheme, noData }) {
  const data = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!data.length) return null;
  const distinct = new Set(data).size;
  let k = Math.max(1, Math.min(classes, distinct));
  let thresholds = k > 1 ? thresholdsFor(data, method, k) : [];
  thresholds = [...new Set(thresholds)].filter((t) => t > data[0] && t <= data.at(-1));
  k = thresholds.length + 1;
  const colors = palette(scheme, k);
  const min = data[0], max = data.at(-1);

  const classIndex = (v) => {
    const i = thresholds.findIndex((t) => v < t);
    return i === -1 ? k - 1 : i;
  };
  return {
    method, min, max, thresholds, colors,
    colorFor: (v) => (Number.isFinite(v) ? colors[classIndex(v)] : noData),
    bins: colors.map((color, i) => ({
      color,
      from: i === 0 ? min : thresholds[i - 1],
      to: i === k - 1 ? max : thresholds[i],
    })),
  };
}
