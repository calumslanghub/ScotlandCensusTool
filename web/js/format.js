const formatters = new Map();
const PERCENT = "%";

export function formatValue(value, metric) {
  if (value == null || !Number.isFinite(value)) return "–";
  const d = metric?.decimals ?? 0;
  if (!formatters.has(d)) {
    formatters.set(d, new Intl.NumberFormat("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  return formatters.get(d).format(value);
}

export const formatNumber = (value, decimals = 0) => formatValue(value, { decimals });

// "24.1%" for percentages, "42.3 years" otherwise.
export function withUnit(value, metric) {
  const text = formatValue(value, metric);
  if (text === "–" || !metric.unit) return text;
  return metric.unit === PERCENT ? `${text}%` : `${text} ${metric.unit}`;
}

// Difference from a reference value: "+2.1 pts", "−0.4 years".
export function signedDiff(diff, metric) {
  if (diff == null || !Number.isFinite(diff)) return "–";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
  const unit = metric.unit === PERCENT ? " pts" : metric.unit ? ` ${metric.unit}` : "";
  return `${sign}${formatValue(Math.abs(diff), metric)}${unit}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
